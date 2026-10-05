import { describe, it, expect } from 'vitest';
import { StallTracker } from '@/lib/stall';

type Ev = [string, Record<string, unknown>, number];

/** Episodes as the analyzer reads them: [end - duration, end] in the tracker's clock. */
function episodes(log: Ev[]): Array<[number, number]> {
  return log
    .filter(([e]) => e === 'STALL_END')
    .map(([, f, at]) => [at - (f.duration_ms as number), at] as [number, number]);
}

function tracker() {
  const log: Ev[] = [];
  let now = 0;
  const t = new StallTracker(
    (e, f) => log.push([e, f, now]),
    () => ({ ready: true, playheadMs: 10_000, track: 'A' }),
  );
  const at = (ms: number) => {
    now = ms;
    return ms;
  };
  return { t, log, at };
}

describe('StallTracker (F15)', () => {
  it('a freeze with a `playing` event but no progress is one episode covering the freeze', () => {
    const { t, log, at } = tracker();
    // Frozen from t = 0: ticks every 500 ms.
    for (let ms = 500; ms <= 2_500; ms += 500) t.watchdogTick(at(ms), false, true);
    t.playing(at(3_000)); // the element says playing; the playhead has not moved
    for (let ms = 3_500; ms <= 6_500; ms += 500) t.watchdogTick(at(ms), false, true);
    t.watchdogTick(at(7_000), true, true); // progress
    expect(log.map(([e]) => e)).toEqual(['STALL_START', 'STALL_END']);
    expect(log[1]![1].cause).toBe('frozen');
    // Credited from the first frozen tick (500) to the progress (7 000): no hole.
    expect(episodes(log)).toEqual([[500, 7_000]]);
  });

  it('a frozen episode ends only on playhead progress', () => {
    const { t, log, at } = tracker();
    for (let ms = 500; ms <= 1_000; ms += 500) t.watchdogTick(at(ms), false, true);
    t.playing(at(1_200));
    t.playing(at(1_300));
    t.watchdogTick(at(1_500), false, false); // paused: still open
    expect(log.map(([e]) => e)).toEqual(['STALL_START']);
    expect(t.isOpen).toBe(true);
    t.watchdogTick(at(2_000), true, true);
    expect(episodes(log)).toEqual([[500, 2_000]]);
  });

  it('a new frozen episode needs a new freeze detected after the previous STALL_END', () => {
    const { t, log, at } = tracker();
    t.waiting(at(0));
    // The playhead does not move while waiting: the watchdog counts, but the
    // waiting episode is the open one.
    for (let ms = 500; ms <= 1_000; ms += 500) t.watchdogTick(at(ms), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START']);
    t.playing(at(1_200)); // closes the waiting episode and the frozen count
    t.watchdogTick(at(1_500), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START', 'STALL_END']);
    t.watchdogTick(at(2_000), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START', 'STALL_END', 'STALL_START']);
    t.watchdogTick(at(2_500), true, true);
    const eps = episodes(log);
    expect(eps).toEqual([
      [0, 1_200],
      [1_500, 2_500],
    ]);
  });

  it('a `waiting` episode is closed by progress and does not start before the previous end', () => {
    const { t, log, at } = tracker();
    t.waiting(at(100));
    t.playing(at(400));
    t.waiting(at(400));
    t.watchdogTick(at(900), true, true);
    const eps = episodes(log);
    expect(eps).toEqual([
      [100, 400],
      [400, 900],
    ]);
  });

  it('nothing before the first frame', () => {
    const log: Ev[] = [];
    const t = new StallTracker(
      (e, f) => log.push([e, f, 0]),
      () => ({ ready: false, playheadMs: 0, track: null }),
    );
    t.waiting(0);
    for (let ms = 500; ms <= 2_000; ms += 500) t.watchdogTick(ms, false, true);
    expect(log).toEqual([]);
  });
});
