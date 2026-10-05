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
  it('a freeze closed by `playing` without progress, then progress: non-overlapping episodes', () => {
    const { t, log, at } = tracker();
    // Frozen from t = 0: ticks every 500 ms.
    for (let ms = 500; ms <= 2_500; ms += 500) t.watchdogTick(at(ms), false, true);
    t.playing(at(3_000)); // the element says playing; the playhead has not moved
    for (let ms = 3_500; ms <= 6_500; ms += 500) t.watchdogTick(at(ms), false, true);
    t.watchdogTick(at(7_000), true, true); // progress
    const eps = episodes(log);
    expect(eps.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < eps.length; i++) expect(eps[i]![0]).toBeGreaterThanOrEqual(eps[i - 1]![1]);
    // Starts and ends alternate.
    expect(log.map(([e]) => e)).toEqual(
      log.map((_, i) => (i % 2 === 0 ? 'STALL_START' : 'STALL_END')),
    );
    // The whole freeze is covered once: 500 (first frozen tick) to 7 000.
    const total = eps.reduce((a, [s, e]) => a + (e - s), 0);
    expect(total).toBeLessThanOrEqual(6_500);
  });

  it('a new episode needs a new freeze detected after the previous STALL_END', () => {
    const { t, log, at } = tracker();
    for (let ms = 500; ms <= 1_000; ms += 500) t.watchdogTick(at(ms), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START']);
    t.playing(at(1_200));
    t.watchdogTick(at(1_500), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START', 'STALL_END']);
    t.watchdogTick(at(2_000), false, true);
    expect(log.map(([e]) => e)).toEqual(['STALL_START', 'STALL_END', 'STALL_START']);
    t.watchdogTick(at(2_500), true, true);
    const eps = episodes(log);
    expect(eps[1]![0]).toBeGreaterThanOrEqual(1_200);
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
