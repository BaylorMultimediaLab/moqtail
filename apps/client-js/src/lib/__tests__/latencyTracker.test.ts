import { describe, it, expect } from 'vitest';
import { LatencyTracker } from '../latencyTracker';

describe('LatencyTracker', () => {
  it('returns 1.0 ratio before window is full', () => {
    const t = new LatencyTracker(100);
    for (let i = 0; i < 99; i++) t.record(50);
    expect(t.getTrendRatio()).toBe(1.0);
  });

  it('returns 1.0 ratio for stable latency', () => {
    const t = new LatencyTracker(100);
    for (let i = 0; i < 100; i++) t.record(50);
    expect(t.getTrendRatio()).toBe(1.0);
  });

  it('returns >1 when recent half is higher than older half', () => {
    const t = new LatencyTracker(100);
    for (let i = 0; i < 50; i++) t.record(50);
    for (let i = 0; i < 50; i++) t.record(75); // 50% higher
    expect(t.getTrendRatio()).toBeCloseTo(1.5, 5);
  });

  it('returns <1 when recent half is lower than older half', () => {
    const t = new LatencyTracker(100);
    for (let i = 0; i < 50; i++) t.record(100);
    for (let i = 0; i < 50; i++) t.record(50);
    expect(t.getTrendRatio()).toBeCloseTo(0.5, 5);
  });

  it('discards out-of-range latencies (negative, >60 s)', () => {
    const t = new LatencyTracker(4);
    t.record(50);
    t.record(-10); // dropped
    t.record(70_000); // dropped
    t.record(NaN); // dropped
    t.record(60);
    expect(t.getSampleCount()).toBe(2);
  });

  it('windowSize bounds the buffer', () => {
    const t = new LatencyTracker(10);
    for (let i = 0; i < 20; i++) t.record(i);
    expect(t.getSampleCount()).toBe(10);
    // Last 10 values were 10..19; the recent half (15..19) mean is 17,
    // older half (10..14) mean is 12 → 17/12 ≈ 1.4167
    expect(t.getTrendRatio()).toBeCloseTo(17 / 12, 4);
  });

  it('reset() clears all state', () => {
    const t = new LatencyTracker(100);
    for (let i = 0; i < 100; i++) t.record(50);
    t.reset();
    expect(t.getSampleCount()).toBe(0);
    expect(t.getLastLatencyMs()).toBe(0);
    expect(t.getTrendRatio()).toBe(1.0);
  });

  it('getLastLatencyMs reports the most recent sample', () => {
    const t = new LatencyTracker();
    t.record(33);
    t.record(77);
    expect(t.getLastLatencyMs()).toBe(77);
  });
});
