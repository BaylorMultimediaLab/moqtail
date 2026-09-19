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
