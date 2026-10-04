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

// M18: the probe is a veto, not a climber. It certifies the next rung up or
// caps the ladder at the active rung; the climb itself is ThroughputRule's.
describe('ProbeRule', () => {
  it('abstains when there is no fresh probe reading', () => {
    const rule = new ProbeRule();
    expect(rule.getMaxIndex(makeContext())).toBeNull();
  });

  it('vetoes (returns the active index) when probe BWE × 0.8 < next bitrate', () => {
    const rule = new ProbeRule();
    // Next = 2 Mbps. BWE × 0.8 = 1.6 Mbps < 2 Mbps.
    const ctx = makeContext({ activeTrackIndex: 0, probeBandwidthBps: 2_000_000 });
    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(0);
    expect(result!.priority).toBe(SwitchRequestPriority.DEFAULT);
    expect(result!.reason).toContain('probe veto');
  });

  it('abstains when probe BWE × 0.8 ≥ next bitrate (headroom certified, the throughput rule decides how far)', () => {
    const rule = new ProbeRule();
    // Next bitrate = 720p = 2 Mbps. BWE × 0.8 ≥ 2e6 means BWE ≥ 2.5e6.
    expect(
      rule.getMaxIndex(makeContext({ activeTrackIndex: 0, probeBandwidthBps: 3_000_000 })),
    ).toBeNull();
    // A very strong probe must not limit a multi-rung climb to one rung.
    expect(
      rule.getMaxIndex(makeContext({ activeTrackIndex: 0, probeBandwidthBps: 50_000_000 })),
    ).toBeNull();
  });

  it('vetoes from a middle rung too', () => {
    const rule = new ProbeRule();
    // Active 720p, next 1080p = 5 Mbps; BWE 4 Mbps × 0.8 = 3.2 Mbps < 5 Mbps.
    const result = rule.getMaxIndex(
      makeContext({ activeTrackIndex: 1, probeBandwidthBps: 4_000_000 }),
    );
    expect(result?.representationIndex).toBe(1);
  });

  it('returns null when already at top track', () => {
    const rule = new ProbeRule();
    const ctx = makeContext({ activeTrackIndex: 2, probeBandwidthBps: 100 });
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
      probeBandwidthBps: 1_000,
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
    // BWE × 1.0 = 2e6 = next bitrate exactly → certified, no veto.
    expect(
      rule.getMaxIndex(
        makeContext({ activeTrackIndex: 0, probeBandwidthBps: 2_000_000, abrSettings: settings }),
      ),
    ).toBeNull();
    // Just under → veto.
    expect(
      rule.getMaxIndex(
        makeContext({ activeTrackIndex: 0, probeBandwidthBps: 1_999_999, abrSettings: settings }),
      )?.representationIndex,
    ).toBe(0);
  });
});
