import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoodputTracker } from '../goodput';

describe('GoodputTracker (SWMA on per-group object timing)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 before any sample', () => {
    const t = new GoodputTracker();
    expect(t.getBandwidthBps()).toBe(0);
    expect(t.getFastEmaBps()).toBe(0);
    expect(t.getSlowEmaBps()).toBe(0);
  });

  it('returns 0 while a single group is still in progress', () => {
    const t = new GoodputTracker();
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    // Group 0 not finalized yet (still receiving its objects).
    expect(t.getBandwidthBps()).toBe(0);
  });

  it('finalizes the previous group when a new groupId arrives', () => {
    const t = new GoodputTracker();
    // Group 0: first object sets t_1, two more objects of 10_000 bytes spaced
    // 100ms apart → 20_000 bytes / 200ms = 800_000 bps.
    t.recordObject(5_000, 0n); // first object — bytes excluded from numerator
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);

    // Group 1 starts → group 0 is finalized.
    vi.advanceTimersByTime(900);
    t.recordObject(5_000, 1n);

    // (10_000 + 10_000) bytes * 8 bits / 0.2 s = 800_000 bps.
    expect(t.getBandwidthBps()).toBe(800_000);
  });

  it('excludes the first object from the SWMA numerator', () => {
    const t = new GoodputTracker();
    // Group 0: huge first object (would inflate the average if counted) +
    // small back-to-back objects.
    t.recordObject(1_000_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);

    t.recordObject(0, 1n); // trigger finalization

    // (10_000 + 10_000) bytes * 8 / 0.2 s = 800_000 bps.
    // If first-object bytes were counted, this would be much higher.
    expect(t.getBandwidthBps()).toBe(800_000);
  });

  it('averages over a SWMA window of 5 group samples', () => {
    const t = new GoodputTracker();
    let groupId = 0n;
    const throughputs = [1, 2, 3, 4, 5, 6].map(n => n * 1_000_000);
    for (const tput of throughputs) {
      // Each group: first object (1_000 B excluded from numerator), then a
      // payload object 100ms later. payload * 8 / 0.1 = tput.
      const payloadBytes = (tput * 0.1) / 8;
      t.recordObject(1_000, groupId);
      vi.advanceTimersByTime(100);
      t.recordObject(payloadBytes, groupId);
      groupId++;
      vi.advanceTimersByTime(900);
    }
    // Finalize the last group by emitting a stub object on the next groupId.
    t.recordObject(0, groupId);
    // 6 samples produced; window keeps last 5: 2,3,4,5,6 Mbps → mean = 4 Mbps.
    expect(t.getBandwidthBps()).toBeCloseTo(4_000_000, -3);
  });

  it('feeds per-group throughputs into fast/slow EMAs', () => {
    const t = new GoodputTracker(3, 8);
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(125_000, 0n); // 125_000 B * 8 / 0.1 s = 10_000_000 bps
    t.recordObject(0, 1n); // finalize group 0

    expect(t.getFastEmaBps()).toBe(10_000_000);
    expect(t.getSlowEmaBps()).toBe(10_000_000);
  });

  it('reset() clears SWMA, EMAs, and current-group accumulator', () => {
    const t = new GoodputTracker();
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    t.recordObject(0, 1n); // finalize group 0
    expect(t.getBandwidthBps()).toBeGreaterThan(0);

    t.reset();
    expect(t.getBandwidthBps()).toBe(0);
    expect(t.getFastEmaBps()).toBe(0);
    expect(t.getSlowEmaBps()).toBe(0);
    expect(t.getSampleCount()).toBe(0);
  });

  it('getLastObjectBytes returns the most recent object size', () => {
    const t = new GoodputTracker();
    t.recordObject(5_000, 0n);
    expect(t.getLastObjectBytes()).toBe(5_000);
    t.recordObject(12_000, 0n);
    expect(t.getLastObjectBytes()).toBe(12_000);
  });

  it('getSampleCount tracks the number of finalized groups, not raw objects', () => {
    const t = new GoodputTracker();
    expect(t.getSampleCount()).toBe(0);

    // Group 0 with two objects → no finalization yet.
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(50);
    t.recordObject(2_000, 0n);
    expect(t.getSampleCount()).toBe(0);

    // Switching to group 1 finalizes group 0 → count = 1.
    t.recordObject(1_000, 1n);
    expect(t.getSampleCount()).toBe(1);
  });

  it('skips groups with only one object (no inter-arrival information)', () => {
    const t = new GoodputTracker();
    t.recordObject(10_000, 0n); // single object in group 0
    t.recordObject(10_000, 1n); // moves to group 1; group 0 should NOT be finalized
    expect(t.getSampleCount()).toBe(0);
    expect(t.getBandwidthBps()).toBe(0);
  });
});
