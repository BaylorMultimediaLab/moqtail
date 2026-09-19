import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from '../MetricsCollector';

function makeMockPlayer() {
  return {
    getMetrics: vi.fn(() => ({
      bandwidthBps: 3_000_000,
      fastEmaBps: 3_000_000,
      slowEmaBps: 3_000_000,
      bufferSeconds: 10,
      activeTrack: '720p',
      droppedFrames: 0,
      totalFrames: 100,
      playbackRate: 1,
      deliveryTimeMs: 50,
      lastObjectBytes: 10000,
      playheadMs: 12_000,
      bufferedEndMs: 22_000,
      liveEdgeDistanceMs: 10_400,
      timeShiftErrorMs: 400,
      lastLatencyMs: 120,
      activeGroup: 12,
      readyState: 4,
      paused: false,
    })),
  };
}

describe('MetricsCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty', () => {
    const player = makeMockPlayer();
    const onSnapshot = vi.fn();
    const collector = new MetricsCollector(player as any, { '720p': 2000 }, onSnapshot);
    expect(collector.getSnapshot().samples).toHaveLength(0);
    expect(collector.getSnapshot().latest).toBeNull();
  });

  it('accumulates samples on tick', () => {
    const player = makeMockPlayer();
    const onSnapshot = vi.fn();
    const collector = new MetricsCollector(player as any, { '720p': 2000 }, onSnapshot);
    collector.start();
    vi.advanceTimersByTime(750);
    collector.stop();
    expect(collector.getSnapshot().samples.length).toBe(3);
  });

  it('caps at 240 samples', () => {
    const player = makeMockPlayer();
    const onSnapshot = vi.fn();
    const collector = new MetricsCollector(player as any, { '720p': 2000 }, onSnapshot);
    collector.start();
    vi.advanceTimersByTime(250 * 300);
    collector.stop();
    expect(collector.getSnapshot().samples.length).toBe(240);
  });

  it('emits onSnapshot each tick', () => {
    const player = makeMockPlayer();
    const onSnapshot = vi.fn();
    const collector = new MetricsCollector(player as any, { '720p': 2000 }, onSnapshot);
    collector.start();
    vi.advanceTimersByTime(500);
    collector.stop();
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('exports the live-edge and time-shift columns', () => {
    const player = makeMockPlayer();
    const collector = new MetricsCollector(player as any, { '720p': 2000 }, vi.fn());
    collector.start();
    vi.advanceTimersByTime(250);
    collector.stop();
    const [header, row] = collector.exportCsv().split('\n');
    expect(header).toContain('live_edge_distance_ms,time_shift_error_ms');
    expect(row).toContain('12000.0,22000.0,10400.0,400.0,120.0,720p,12');
  });
});
