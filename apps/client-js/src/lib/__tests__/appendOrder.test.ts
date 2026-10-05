import { describe, it, expect } from 'vitest';
import { AppendOrder, type OrderAction, type OrderFrame } from '@/lib/appendOrder';

/** 24 frames per 1 s group, as the ToS cache. */
const DUR = 1000 / 24;
const f = (group: number, object: number, arrivedAt = 0): OrderFrame<string> => ({
  item: `${group}.${object}`,
  dtsMs: group * 1000 + object * DUR,
  durMs: DUR,
  isSync: object === 0,
  arrivedAt,
});
/** Offers `x` arriving at `now`. */
const at = (o: AppendOrder<string>, x: OrderFrame<string>, now: number, ctx = {}) =>
  o.offer({ ...x, arrivedAt: now }, now, ctx);
const appended = (acts: OrderAction<string>[]) =>
  acts.filter(a => a.kind === 'append').map(a => a.frame.item);
const dropped = (acts: OrderAction<string>[]) =>
  acts
    .filter(a => a.kind === 'drop')
    .map(a => `${a.frame.item}:${a.kind === 'drop' ? a.reason : ''}`);

describe('AppendOrder', () => {
  it('appends frames that arrive in decode order at once', () => {
    const o = new AppendOrder<string>();
    const frames = [...Array.from({ length: 24 }, (_, i) => f(1, i)), f(2, 0)];
    const acts = frames.flatMap(x => o.offer(x, 0));
    expect(appended(acts)).toEqual(frames.map(x => x.item));
    expect(o.heldCount).toBe(0);
  });

  // Preflight 2026-10-05 (pr1378 live-edge r1): group 69's last two objects were
  // delayed by a retransmission behind group 70's first ones. In arrival order MSE
  // kept 70.00-70.42 and dropped the rest of group 70.
  it('holds the next group while the previous one has a gap, then appends both in order', () => {
    const o = new AppendOrder<string>();
    const acts: OrderAction<string>[] = [];
    for (let i = 0; i < 22; i++) acts.push(...o.offer(f(69, i), 0));
    for (let i = 0; i < 10; i++) acts.push(...o.offer(f(70, i), 10));
    expect(appended(acts)).toHaveLength(22);
    expect(o.heldCount).toBe(10);
    acts.push(...o.offer(f(69, 22), 200), ...o.offer(f(69, 23), 200));
    for (let i = 10; i < 24; i++) acts.push(...o.offer(f(70, i), 210));
    expect(appended(acts)).toEqual([
      ...Array.from({ length: 24 }, (_, i) => `69.${i}`),
      ...Array.from({ length: 24 }, (_, i) => `70.${i}`),
    ]);
    expect(dropped(acts)).toEqual([]);
  });

  it('gives up a gap after maxWaitMs: resumes at the held keyframe, drops the frames behind', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 1000 });
    at(o, f(5, 0), 0);
    at(o, f(5, 1), 0); // 5.2 .. 5.23 never come (stream reset)
    expect(at(o, f(6, 0), 100)).toEqual([]);
    expect(at(o, f(6, 1), 110)).toEqual([]);
    expect(o.tick(1099)).toEqual([]);
    const acts = o.tick(1100);
    expect(appended(acts)).toEqual(['6.0', '6.1']);
    // A straggler of group 5 after the front moved on: appending it would make
    // MSE drop group 6's next frames, so it is dropped.
    expect(dropped(at(o, f(5, 2), 1200))).toEqual(['5.2:behind-append-front']);
    expect(appended(at(o, f(6, 2), 1200))).toEqual(['6.2']);
  });

  it('gives up a gap early when the playhead is about to run out of media', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 1000, minAheadMs: 300 });
    at(o, f(5, 0), 0);
    at(o, f(6, 0), 10);
    expect(o.tick(50, { aheadOfPlayheadMs: 400 })).toEqual([]);
    expect(appended(o.tick(60, { aheadOfPlayheadMs: 250 }))).toEqual(['6.0']);
  });

  it('a held frame without a keyframe before it keeps waiting, then goes with the gap', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 100 });
    at(o, f(5, 0), 0);
    at(o, f(5, 3), 0); // 5.1, 5.2 missing
    expect(o.tick(500)).toEqual([]); // no keyframe held: nothing appendable
    const acts = at(o, f(6, 0), 600);
    expect(dropped(acts)).toEqual(['5.3:abandoned-gap']);
    expect(appended(acts)).toEqual(['6.0']);
  });

  // pr1378: a catch-up FETCH delivers [G_switch, live) while the live subscription
  // delivers from live on; they interleave on arrival.
  it('interleaved catch-up and live groups are appended in decode order', () => {
    const o = new AppendOrder<string>();
    const order = [f(10, 0), f(12, 0), f(10, 1), f(12, 1), f(11, 0), f(12, 2), f(11, 1)];
    const acts = order.flatMap(x => o.offer(x, 0));
    // 10.1 ends at 10.083 s; 11.0 is not contiguous until group 10 completes.
    expect(appended(acts)).toEqual(['10.0', '10.1']);
    const rest: OrderAction<string>[] = [];
    for (let i = 2; i < 24; i++) rest.push(...o.offer(f(10, i), 1));
    for (let i = 2; i < 24; i++) rest.push(...o.offer(f(11, i), 1));
    expect(appended(rest)).toEqual([
      ...Array.from({ length: 22 }, (_, i) => `10.${i + 2}`),
      '11.0',
      '11.1',
      ...Array.from({ length: 22 }, (_, i) => `11.${i + 2}`),
      '12.0',
      '12.1',
      '12.2',
    ]);
    expect(dropped([...acts, ...rest])).toEqual([]);
  });

  it('a keyframe behind the front that fills a gap ahead of the playhead is appended', () => {
    const o = new AppendOrder<string>();
    o.offer(f(20, 0), 0);
    o.offer(f(20, 1), 0);
    expect(
      appended(o.offer(f(15, 0), 0, { fillsGapAhead: dts => dts >= 15_000 && dts < 20_000 })),
    ).toEqual(['15.0']);
    expect(dropped(o.offer(f(14, 0), 0, { fillsGapAhead: () => false }))).toEqual([
      '14.0:behind-append-front',
    ]);
  });

  it('reset (a switch landed) drops the held frames and starts afresh', () => {
    const o = new AppendOrder<string>();
    o.offer(f(5, 0), 0);
    o.offer(f(6, 0), 0);
    expect(dropped(o.reset())).toEqual(['6.0:track-changed']);
    expect(appended(o.offer(f(3, 0), 0))).toEqual(['3.0']);
  });

  it('reports the next deadline of the held frames', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 1000 });
    expect(o.nextDeadline).toBeUndefined();
    at(o, f(5, 0), 0);
    at(o, f(6, 0), 40);
    expect(o.nextDeadline).toBe(1040);
  });
});

/**
 * The MSE coded frame processing rule this scheduler exists for (Media Source
 * Extensions, "Coded Frame Processing", steps 6-7): a decode timestamp below the
 * last one, or more than two frame durations above it, is a discontinuity; frames
 * are then dropped until the next random access point. Returns the frames kept.
 */
function mseKeeps(frames: OrderFrame<string>[]): string[] {
  let lastDts: number | undefined;
  let lastDur: number | undefined;
  let needRap = true;
  const kept: string[] = [];
  for (const fr of frames) {
    if (
      lastDts !== undefined &&
      lastDur !== undefined &&
      (fr.dtsMs < lastDts || fr.dtsMs - lastDts > 2 * lastDur)
    ) {
      lastDts = undefined;
      lastDur = undefined;
      needRap = true;
    }
    if (needRap && !fr.isSync) continue;
    needRap = false;
    lastDts = fr.dtsMs;
    lastDur = fr.durMs;
    kept.push(fr.item);
  }
  return kept;
}

describe('AppendOrder: a gap that is being filled keeps the frames after it waiting', () => {
  // Review 2026-10-05: a pr1378 catch-up of [50, 53) taking 2.4 s while live group 53
  // arrives in real time. A fixed 1 s wait gave the catch-up up at the first live
  // keyframe and lost the rest of it; the wait now runs from the last progress.
  it('a slow catch-up next to live frames loses nothing', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 1000, minAheadMs: 300 });
    const arrivals: Array<[number, OrderFrame<string>]> = [];
    for (let g = 50; g < 53; g++)
      for (let i = 0; i < 24; i++) arrivals.push([((g - 50) * 24 + i) * (2400 / 72), f(g, i)]);
    for (let g = 53; g < 56; g++)
      for (let i = 0; i < 24; i++) arrivals.push([((g - 53) * 24 + i) * DUR, f(g, i)]);
    arrivals.sort((a, b) => a[0] - b[0]);
    const acts: OrderAction<string>[] = [];
    let t = 0;
    for (const [now, fr] of arrivals) {
      for (; t + 100 <= now; t += 100) acts.push(...o.tick(t + 100, { aheadOfPlayheadMs: 10_000 }));
      acts.push(...at(o, fr, now, { aheadOfPlayheadMs: 10_000 }));
    }
    expect(dropped(acts)).toEqual([]);
    expect(appended(acts)).toEqual(
      arrivals
        .map(([, fr]) => fr.item)
        .sort((a, b) => {
          const [ga, oa] = a.split('.').map(Number);
          const [gb, ob] = b.split('.').map(Number);
          return ga! - gb! || oa! - ob!;
        }),
    );
  });

  it('a later gap gets its own wait after an earlier one was given up', () => {
    const o = new AppendOrder<string>({ maxWaitMs: 1000 });
    at(o, f(5, 0), 0);
    at(o, f(6, 0), 0);
    at(o, f(6, 1), 0);
    expect(appended(o.tick(1000))).toEqual(['6.0', '6.1']);
    // 6.2 never comes; 7.0 must wait its own second, not be released at once.
    expect(at(o, f(7, 0), 1100)).toEqual([]);
    expect(o.tick(1999)).toEqual([]);
    expect(appended(o.tick(2100))).toEqual(['7.0']);
  });
});

describe('AppendOrder against the MSE discontinuity rule', () => {
  // Preflight 2026-10-05, pr1378 live-edge r1: group 69's objects 22 and 23 arrive
  // after group 70's first ten (a retransmission on group 69's stream).
  const arrival = [
    ...Array.from({ length: 22 }, (_, i) => f(69, i)),
    ...Array.from({ length: 10 }, (_, i) => f(70, i)),
    f(69, 22),
    f(69, 23),
    ...Array.from({ length: 14 }, (_, i) => f(70, i + 10)),
  ];

  it('in arrival order MSE keeps 70.0-70.9 and drops the rest of group 70', () => {
    const kept = mseKeeps(arrival);
    expect(kept.filter(k => k.startsWith('70.'))).toHaveLength(10);
    expect(kept).not.toContain('69.22');
  });

  it('through the scheduler MSE keeps every frame', () => {
    const o = new AppendOrder<string>();
    const sequence = arrival
      .flatMap(x => at(o, x, 0))
      .filter(a => a.kind === 'append')
      .map(a => a.frame);
    expect(mseKeeps(sequence)).toHaveLength(48);
  });
});
