import { describe, it, expect } from 'vitest';
import { ProbeRule } from '../ProbeRule';
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
    activeTrackIndex: 0,
    bufferSeconds: 10,
    bandwidthBps: 0,
    fastEmaBps: 0,
    slowEmaBps: 0,
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

describe('ProbeRule', () => {
  it('returns null when probeBandwidthBps is 0', () => {
    const rule = new ProbeRule();
    expect(rule.getMaxIndex(makeContext())).toBeNull();
  });

  it('upswitches when probe BWE × 0.8 ≥ next bitrate', () => {
    const rule = new ProbeRule();
    // Next bitrate = 720p = 2 Mbps. BWE × 0.8 ≥ 2e6 means BWE ≥ 2.5e6.
    const ctx = makeContext({ activeTrackIndex: 0, probeBandwidthBps: 3_000_000 });
    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(1); // 720p
    expect(result!.priority).toBe(SwitchRequestPriority.DEFAULT);
  });

  it('does not upswitch when probe BWE × 0.8 < next bitrate', () => {
    const rule = new ProbeRule();
    // Next = 2 Mbps. BWE × 0.8 = 1.6 Mbps < 2 Mbps.
    const ctx = makeContext({ activeTrackIndex: 0, probeBandwidthBps: 2_000_000 });
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });

  it('returns null when already at top track', () => {
    const rule = new ProbeRule();
    const ctx = makeContext({ activeTrackIndex: 2, probeBandwidthBps: 100_000_000 });
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });

  it('returns null when rule is inactive in settings', () => {
    const rule = new ProbeRule();
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        ProbeRule: { ...DEFAULT_ABR_SETTINGS.rules['ProbeRule']!, active: false },
      },
    };
    const ctx = makeContext({
      activeTrackIndex: 0,
      probeBandwidthBps: 10_000_000,
      abrSettings: settings,
    });
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });

  it('respects custom safetyFactor', () => {
    const rule = new ProbeRule();
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        ProbeRule: {
          ...DEFAULT_ABR_SETTINGS.rules['ProbeRule']!,
          parameters: { safetyFactor: 1.0 },
        },
      },
    };
    // BWE × 1.0 = 2e6 = next bitrate exactly → upswitch fires.
    const ctx = makeContext({
      activeTrackIndex: 0,
      probeBandwidthBps: 2_000_000,
      abrSettings: settings,
    });
    expect(rule.getMaxIndex(ctx)?.representationIndex).toBe(1);
  });

  it('proposes only one step up at a time', () => {
    const rule = new ProbeRule();
    // BWE huge enough for 1080p, but rule should still propose 720p (one step).
    const ctx = makeContext({ activeTrackIndex: 0, probeBandwidthBps: 50_000_000 });
    expect(rule.getMaxIndex(ctx)?.representationIndex).toBe(1);
  });
});
