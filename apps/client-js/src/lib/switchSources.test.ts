import { describe, it, expect } from 'vitest';
import type { MoqtObject } from 'moqtail';
import { DRAIN_TIMEOUT_MS, SourcePump, type PumpSource, type ReleaseReason } from './switchSources';

/** An object as the write handler sees it: only the track and the location matter here. */
function obj(track: string, group: number, object = 0): MoqtObject {
  return {
    track,
    location: { group: BigInt(group), object: BigInt(object) },
  } as unknown as MoqtObject;
}

/** A source the test feeds by hand, as the library's receiver does. */
function feed() {
  let c!: ReadableStreamDefaultController<MoqtObject>;
  const stream = new ReadableStream<MoqtObject>({ start: ctl => void (c = ctl) });
  return { stream, push: (o: MoqtObject) => c.enqueue(o), close: () => c.close() };
}

/** A write handler that applies the pump's verdict, as player.ts does. */
function sink(pump: () => SourcePump) {
  const written: string[] = [];
  const dropped: string[] = [];
  const writable = new WritableStream<MoqtObject>({
    write: o => {
      const t = (o as unknown as { track: string }).track;
      const label = `${t}:${o.location.group}`;
      if (pump().admit(o.location.group) === 'post-seam') dropped.push(label);
      else written.push(label);
    },
  });
  return { writable, written, dropped };
}

const settle = () => new Promise(r => setTimeout(r, 0));

function setup() {
  let t = 0;
  const released: Array<[bigint, ReleaseReason]> = [];
  const finished: bigint[] = [];
  const a = feed();
  /** The library's receivers by request id: finishReceiver closes one. */
  const receivers = new Map<bigint, ReturnType<typeof feed>>([[1n, a]]);
  const pump = new SourcePump(
    { stream: a.stream, requestId: 1n, trackName: 'A' },
    {
      now: () => t,
      onRelease: (s: PumpSource, r) => released.push([s.requestId, r]),
      onFinish: async (s: PumpSource) => {
        finished.push(s.requestId);
        const receiver = receivers.get(s.requestId);
        receiver?.close();
        return receiver !== undefined;
      },
    },
  );
  const out = sink(() => pump);
  const ac = new AbortController();
  void pump.run(out.writable, ac.signal);
  return {
    pump,
    a,
    out,
    released,
    finished,
    receivers,
    ac,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SourcePump (P1, audit M5): the replaced subscription is read until it is done', () => {
  it('keeps writing the old route after SWITCH_OK, before any target object', async () => {
    const { pump, a, out, ac } = setup();
    a.push(obj('A', 3));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    // below the seam, still in flight at SWITCH_OK
    a.push(obj('A', 4, 0));
    a.push(obj('A', 4, 1));
    a.push(obj('A', 4, 2));
    await settle();
    a.close();
    await settle();
    expect(out.written).toEqual(['A:3', 'A:4', 'A:4', 'A:4', 'B:5']);
    ac.abort();
  });

  it('releases the old route at the cap when no PUBLISH_DONE arrives', async () => {
    const { pump, out, released, advance, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    await settle();
    advance(5000);
    pump.tick();
    await settle();
    expect(released).toEqual([]);
    advance(2000);
    pump.tick();
    await settle();
    expect(released).toEqual([[1n, 'cap']]);
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route that closes is released as closed and the next one starts at once', async () => {
    const { pump, a, out, released, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    a.close();
    await settle();
    expect(released).toEqual([[1n, 'closed']]);
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route queued after the previous one already closed is still picked up', async () => {
    const { pump, a, out, ac } = setup();
    a.close();
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    await settle();
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route that is not replaced is never released by tick', async () => {
    const { pump, released, advance, ac } = setup();
    pump.publishDone(1n);
    advance(60_000);
    pump.tick();
    await settle();
    expect(released).toEqual([]);
    expect(pump.current?.requestId).toBe(1n);
    ac.abort();
  });
});

describe('SourcePump (P2, audit M6): old-track objects at or above G_switch are dropped once it is known', () => {
  it('appends the replaced route below the seam and drops it at and above the seam', async () => {
    const { pump, a, out, ac } = setup();
    a.push(obj('A', 4)); // before SWITCH_OK: G_switch unknown, appended
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    a.push(obj('A', 4, 1));
    a.push(obj('A', 5));
    a.push(obj('A', 6));
    a.close();
    b.push(obj('B', 5));
    await settle();
    expect(out.written).toEqual(['A:4', 'A:4', 'B:5']);
    expect(out.dropped).toEqual(['A:5', 'A:6']);
    expect(pump.routes()[0]?.trackName).toBe('B');
    ac.abort();
  });

  it('the target route is never cut by the seam of the route it replaced', async () => {
    const { pump, a, out, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    a.close();
    b.push(obj('B', 5));
    b.push(obj('B', 9));
    await settle();
    expect(out.written).toEqual(['B:5', 'B:9']);
    expect(out.dropped).toEqual([]);
    ac.abort();
  });
});

/** A stream-end report as the library's onDataStreamEnded gives it. */
function ended(requestId: bigint, group: number, streamType: 'subgroup' | 'fetch' = 'subgroup') {
  return { requestId, streamType, groupId: BigInt(group), end: 'fin' as const };
}

describe('SourcePump (R6 D2): a replaced route is released when its below-seam streams have all ended', () => {
  it('(i) no backlog: B = 0 releases it as drained at PUBLISH_DONE, with no idle wait', async () => {
    const { pump, a, out, released, ac } = setup();
    a.push(obj('A', 4));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 0n);
    b.push(obj('B', 5));
    await settle();
    expect(released).toEqual([]);
    pump.publishDone(1n);
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    expect(out.written).toEqual(['A:4', 'B:5']);
    ac.abort();
  });

  it('(ii) backlog: released exactly when the G-1 stream ends, though streams at/above G were reset unseen', async () => {
    const { pump, a, out, released, advance, ac } = setup();
    a.push(obj('A', 3));
    pump.streamEnded(ended(1n, 3));
    a.push(obj('A', 4, 0));
    await settle();
    const b = feed();
    // B = 2: the relay opened streams for groups 3 and 4 below G = 5 (and 5, 6
    // above it, which it reset before their headers reached the client).
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 2n);
    b.push(obj('B', 5));
    pump.publishDone(1n);
    advance(1000);
    pump.tick();
    await settle();
    expect(released).toEqual([]); // the 4 stream is still open: no idle release
    a.push(obj('A', 4, 1));
    a.push(obj('A', 4, 2));
    pump.streamEnded(ended(1n, 4));
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    expect(out.written).toEqual(['A:3', 'A:4', 'A:4', 'A:4', 'B:5']);
    ac.abort();
  });

  it('(iii) a below-seam tail held up longer than 300 ms by loss is not cut', async () => {
    const { pump, a, out, released, advance, ac } = setup();
    a.push(obj('A', 4, 0));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 1n);
    pump.publishDone(1n);
    b.push(obj('B', 5));
    for (let i = 0; i < 15; i++) {
      advance(100);
      pump.tick();
    }
    await settle();
    expect(released).toEqual([]);
    a.push(obj('A', 4, 1)); // the retransmitted tail, 1.5 s later
    pump.streamEnded(ended(1n, 4));
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    expect(out.written).toEqual(['A:4', 'A:4', 'B:5']);
    expect(out.dropped).toEqual([]);
    ac.abort();
  });

  it('(iv) without B (a relay that sends the two-field SWITCH_TRANSITION) it falls back to drain-timeout', async () => {
    const { pump, a, out, released, advance, ac } = setup();
    a.push(obj('A', 4));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    pump.publishDone(1n);
    pump.streamEnded(ended(1n, 4));
    b.push(obj('B', 5));
    advance(DRAIN_TIMEOUT_MS - 100);
    pump.tick();
    await settle();
    expect(released).toEqual([]);
    advance(100);
    pump.tick();
    await settle();
    expect(released).toEqual([[1n, 'drain-timeout']]);
    expect(out.written).toEqual(['A:4', 'B:5']);
    ac.abort();
  });

  it('a below-seam stream that never arrives (reset upstream before its header) ends in drain-timeout', async () => {
    const { pump, a, released, advance, ac } = setup();
    a.push(obj('A', 4));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 2n);
    pump.publishDone(1n);
    pump.streamEnded(ended(1n, 4));
    advance(DRAIN_TIMEOUT_MS);
    pump.tick();
    await settle();
    expect(released).toEqual([[1n, 'drain-timeout']]);
    ac.abort();
  });

  it('a PUBLISH_DONE before SWITCH_OK is held until SWITCH_OK names G and B', async () => {
    const { pump, a, out, released, ac } = setup();
    a.push(obj('A', 4));
    pump.publishDone(1n);
    pump.streamEnded(ended(1n, 4));
    await settle();
    expect(released).toEqual([]);
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 1n);
    b.push(obj('B', 5));
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    expect(out.written).toEqual(['A:4', 'B:5']);
    ac.abort();
  });

  it('B counts streams: two subgroups of one group both have to end', async () => {
    const { pump, a, released, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' }, 2n);
    pump.publishDone(1n);
    a.push(obj('A', 4));
    pump.streamEnded(ended(1n, 4));
    pump.streamEnded(ended(1n, 5)); // at the seam: not counted
    await settle();
    expect(released).toEqual([]);
    pump.streamEnded(ended(1n, 4));
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    ac.abort();
  });

  it("a route that was itself a switch target waits for its catch-up stream's end", async () => {
    const { pump, a, out, released, receivers, ac } = setup();
    a.push(obj('A', 4));
    const b = feed();
    receivers.set(2n, b);
    pump.replace(
      1n,
      5n,
      { stream: b.stream, requestId: 2n, trackName: 'B', expectsCatchUp: true },
      0n,
    );
    pump.publishDone(1n);
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    b.push(obj('B', 5)); // catch-up [5, 9)
    const c = feed();
    pump.replace(2n, 7n, { stream: c.stream, requestId: 3n, trackName: 'C' }, 0n);
    pump.publishDone(2n);
    c.push(obj('C', 7));
    await settle();
    expect(released).toEqual([[1n, 'drained']]);
    b.push(obj('B', 6));
    pump.streamEnded(ended(2n, 5, 'fetch'));
    await settle();
    expect(released).toEqual([
      [1n, 'drained'],
      [2n, 'drained'],
    ]);
    expect(out.written).toEqual(['A:4', 'B:5', 'B:6', 'C:7']);
    ac.abort();
  });
});
