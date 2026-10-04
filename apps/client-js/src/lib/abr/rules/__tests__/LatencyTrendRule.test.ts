import { describe, it, expect } from 'vitest';
import { LatencyTrendRule } from '../LatencyTrendRule';
import { DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../../types';
import type { RulesContext } from '../../types';

const tracks = [
  { name: '360p', bitrate: 500_000 },
  { name: '720p', bitrate: 2_000_000 },
  { name: '1080p', bitrate: 5_000_000 },
];

function makeContext(overrides: Partial<RulesContext> = {}): RulesContext {
  return {
    tracks,
    activeTrackIndex: 1,
    bufferSeconds: 10,
    bandwidthBps: 5_000_000,
    fastEmaBps: 5_000_000,
    slowEmaBps: 5_000_000,
    droppedFrames: 0,
    totalFrames: 0,
    segmentDurationS: 1,
    isLowLatency: false,
    switchHistory: [],
    abrSettings: DEFAULT_ABR_SETTINGS,
    probeBandwidthBps: 0,
    latencyTrendRatio: 1,
    playbackRate: 1,
    ...overrides,
  };
}

describe('LatencyTrendRule', () => {
  it('returns null when latency is stable (ratio = 1)', () => {
    const rule = new LatencyTrendRule();
    expect(rule.getMaxIndex(makeContext({ latencyTrendRatio: 1 }))).toBeNull();
  });

  it('returns null when ratio is below the 1.20 threshold', () => {
    const rule = new LatencyTrendRule();
    expect(rule.getMaxIndex(makeContext({ latencyTrendRatio: 1.15 }))).toBeNull();
  });

  it('downswitches with STRONG priority when ratio ≥ 1.20', () => {
    const rule = new LatencyTrendRule();
    const result = rule.getMaxIndex(makeContext({ activeTrackIndex: 1, latencyTrendRatio: 1.25 }));
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(0); // one step down
    expect(result!.priority).toBe(SwitchRequestPriority.STRONG);
  });

  it('returns null when already on lowest track', () => {
    const rule = new LatencyTrendRule();
    expect(
      rule.getMaxIndex(makeContext({ activeTrackIndex: 0, latencyTrendRatio: 2.0 })),
    ).toBeNull();
  });

  it('returns null when rule is inactive', () => {
    const rule = new LatencyTrendRule();
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        LatencyTrendRule: {
          ...DEFAULT_ABR_SETTINGS.rules['LatencyTrendRule']!,
          active: false,
        },
      },
    };
    expect(
      rule.getMaxIndex(makeContext({ latencyTrendRatio: 2.0, abrSettings: settings })),
    ).toBeNull();
  });

  it('respects custom trendThreshold', () => {
    const rule = new LatencyTrendRule();
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        LatencyTrendRule: {
          ...DEFAULT_ABR_SETTINGS.rules['LatencyTrendRule']!,
          parameters: { trendThreshold: 1.5 },
        },
      },
    };
    // Ratio 1.3 below custom threshold of 1.5 — no fire.
    expect(
      rule.getMaxIndex(makeContext({ latencyTrendRatio: 1.3, abrSettings: settings })),
    ).toBeNull();
    // Ratio 1.6 above 1.5 — fires.
    const ctx = makeContext({ activeTrackIndex: 2, latencyTrendRatio: 1.6, abrSettings: settings });
    expect(rule.getMaxIndex(ctx)?.representationIndex).toBe(1);
  });
});

// C6: the trend must be the same signal on both client types. The raw
// capture-to-receipt ratio is not: a 10 s time-shifted client needs a ~2 s rise
// to pass 1.2 and a live-edge client trips it on a 20-80 ms wobble. The rule
// therefore forms its ratio on (mean - targetShiftMs), the queueing part.
describe('LatencyTrendRule on latency − targetShiftMs (C6)', () => {
  const rise80 = (shiftMs: number) =>
    makeContext({
      activeTrackIndex: 1,
      latencyTrendRatio: (shiftMs + 180) / (shiftMs + 100), // the raw ratio the player used to send
      latencyOlderMeanMs: shiftMs + 100,
      latencyRecentMeanMs: shiftMs + 180,
      targetShiftMs: shiftMs,
    });

  it('a 10 s shift client and a live-edge client take the same decision on the same 80 ms rise', () => {
    const rule = new LatencyTrendRule();
    const shifted = rule.getMaxIndex(rise80(10_000));
    const live = rule.getMaxIndex(rise80(0));
    expect(shifted).not.toBeNull();
    expect(live).not.toBeNull();
    expect(shifted!.representationIndex).toBe(0);
    expect(live!.representationIndex).toBe(0);
    expect(shifted!.priority).toBe(SwitchRequestPriority.STRONG);
    // The raw ratio of the shifted client (1.008) would never have fired.
    expect(rise80(10_000).latencyTrendRatio).toBeLessThan(1.2);
  });

  it('a 10 % rise fires on neither client', () => {
    const rule = new LatencyTrendRule();
    const ctx = (shiftMs: number) =>
      makeContext({
        activeTrackIndex: 1,
        latencyTrendRatio: (shiftMs + 110) / (shiftMs + 100),
        latencyOlderMeanMs: shiftMs + 100,
        latencyRecentMeanMs: shiftMs + 110,
        targetShiftMs: shiftMs,
      });
    expect(rule.getMaxIndex(ctx(10_000))).toBeNull();
    expect(rule.getMaxIndex(ctx(0))).toBeNull();
  });

  it('without targetShiftMs it uses the absolute rise (trendDeltaMs, default 100 ms)', () => {
    const rule = new LatencyTrendRule();
    const ctx = (recent: number) =>
      makeContext({
        activeTrackIndex: 1,
        latencyTrendRatio: recent / 10_100,
        latencyOlderMeanMs: 10_100,
        latencyRecentMeanMs: recent,
      });
    expect(rule.getMaxIndex(ctx(10_180))).toBeNull(); // +80 ms
    expect(rule.getMaxIndex(ctx(10_250))?.representationIndex).toBe(0); // +150 ms
  });

  it('falls back to the absolute rise when the shift-corrected base is not positive', () => {
    const rule = new LatencyTrendRule();
    // Player ahead of its target (older mean below the shift): no ratio exists.
    const ctx = (recent: number) =>
      makeContext({
        activeTrackIndex: 1,
        latencyTrendRatio: 1,
        latencyOlderMeanMs: 9_950,
        latencyRecentMeanMs: recent,
        targetShiftMs: 10_000,
      });
    expect(rule.getMaxIndex(ctx(10_000))).toBeNull(); // +50 ms
    expect(rule.getMaxIndex(ctx(10_100))?.representationIndex).toBe(0); // +150 ms
  });

  it('keeps the raw ratio path when the player exposes only the ratio', () => {
    const rule = new LatencyTrendRule();
    expect(
      rule.getMaxIndex(makeContext({ activeTrackIndex: 1, latencyTrendRatio: 1.25 })),
    ).not.toBeNull();
    expect(
      rule.getMaxIndex(makeContext({ activeTrackIndex: 1, latencyTrendRatio: 1.15 })),
    ).toBeNull();
  });
});
