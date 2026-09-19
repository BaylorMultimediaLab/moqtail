import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BufferDrainRateRule } from '../BufferDrainRateRule';
import { DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../../types';
import type { RulesContext } from '../../types';

const tracks = [
  { name: '360p', bitrate: 500_000 },
  { name: '480p', bitrate: 800_000 },
  { name: '720p', bitrate: 1_500_000 },
  { name: '1080p', bitrate: 3_000_000 },
];

function makeContext(overrides: Partial<RulesContext> = {}): RulesContext {
  return {
    tracks,
    activeTrackIndex: 3,
    bufferSeconds: 1.5,
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

describe('BufferDrainRateRule', () => {
  let rule: BufferDrainRateRule;

  beforeEach(() => {
    rule = new BufferDrainRateRule();
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null until minSamples have accumulated', () => {
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }))).toBeNull();
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 1.0 }))).toBeNull();
    vi.advanceTimersByTime(250);
    // 3rd sample — minSamples reached, may now fire if drain ≥ threshold
    const result = rule.getMaxIndex(makeContext({ bufferSeconds: 0.5 }));
    expect(result).not.toBeNull();
  });

  it('returns null when buffer is healthy (above bufferTriggerThreshold)', () => {
    // bufferSeconds=5 is above default trigger threshold of 2 — rule yields
    // even if drain is rapid; BolaRule/ThroughputRule handle steady-state.
    rule.getMaxIndex(makeContext({ bufferSeconds: 5 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 4 }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 3 }))).toBeNull();
  });

  it('returns null when buffer is keeping up (drainRate < threshold)', () => {
    // Buffer below trigger threshold but stable across the window.
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }))).toBeNull();
  });

  it('returns null when buffer is growing', () => {
    rule.getMaxIndex(makeContext({ bufferSeconds: 0.5 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.0 }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }))).toBeNull();
  });

  it('fires STRONG and picks a feasible target when buffer drains fast', () => {
    // Drop 1 s of buffer over 0.5 s wall time → drainRate = 2.0 s/s. That
    // means link is delivering nothing (clamped fraction = 0). Cap = 0.
    // bestIndex = 0 (lowest track, since all bitrates exceed 0).
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, activeTrackIndex: 3 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.0, activeTrackIndex: 3 }));
    vi.advanceTimersByTime(250);
    const result = rule.getMaxIndex(makeContext({ bufferSeconds: 0.5, activeTrackIndex: 3 }));

    expect(result).not.toBeNull();
    expect(result!.priority).toBe(SwitchRequestPriority.STRONG);
    expect(result!.representationIndex).toBe(0);
    expect(result!.reason).toMatch(/buffer-drain/);
  });

  it('targets the highest track that fits the derived link rate', () => {
    // Active = 1080p (3 Mbps source). Drain rate = 0.5 s/s over 1 s window.
    // fraction = 1.0 - 0.5 = 0.5 → linkBps = 3M × 0.5 = 1.5 Mbps.
    // cappedBps = 1.5M × 0.7 = 1.05 Mbps.
    // Tracks fitting cap: 360p (500K), 480p (800K). 720p (1.5M) excluded.
    // bestIndex = 1 (480p).
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.75, activeTrackIndex: 3 }));
    vi.advanceTimersByTime(500);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, activeTrackIndex: 3 }));
    vi.advanceTimersByTime(500);
    const result = rule.getMaxIndex(makeContext({ bufferSeconds: 1.25, activeTrackIndex: 3 }));

    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(1); // 480p
    expect(result!.priority).toBe(SwitchRequestPriority.STRONG);
  });

  it('returns null when already at the floor', () => {
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, activeTrackIndex: 0 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.0, activeTrackIndex: 0 }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 0.1, activeTrackIndex: 0 }))).toBeNull();
  });

  it('respects custom bufferTriggerThreshold', () => {
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        BufferDrainRateRule: {
          ...DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!,
          parameters: {
            ...DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!.parameters,
            bufferTriggerThreshold: 5, // fire even when buffer is fairly healthy
          },
        },
      },
    };
    rule.getMaxIndex(makeContext({ bufferSeconds: 4, abrSettings: settings }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 3, abrSettings: settings }));
    vi.advanceTimersByTime(250);
    const result = rule.getMaxIndex(makeContext({ bufferSeconds: 2, abrSettings: settings }));
    expect(result).not.toBeNull();
  });

  it('respects custom drainThreshold', () => {
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        BufferDrainRateRule: {
          ...DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!,
          parameters: {
            ...DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!.parameters,
            drainThreshold: 0.8, // very tolerant
          },
        },
      },
    };
    // drain rate ≈ 0.5 s/s, below custom threshold of 0.8
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.75, abrSettings: settings }));
    vi.advanceTimersByTime(500);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, abrSettings: settings }));
    vi.advanceTimersByTime(500);
    expect(
      rule.getMaxIndex(makeContext({ bufferSeconds: 1.25, abrSettings: settings })),
    ).toBeNull();
  });

  it('returns null when rule is disabled in settings', () => {
    const settings = {
      ...DEFAULT_ABR_SETTINGS,
      rules: {
        ...DEFAULT_ABR_SETTINGS.rules,
        BufferDrainRateRule: {
          ...DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!,
          active: false,
        },
      },
    };
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, abrSettings: settings }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.0, abrSettings: settings }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 0.1, abrSettings: settings }))).toBeNull();
  });

  it('reset() clears samples so window restarts', () => {
    // Build a clear drain signal
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5 }));
    vi.advanceTimersByTime(250);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.0 }));
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 0.5 }))).not.toBeNull();

    rule.reset();
    // First two samples after reset should not fire (below minSamples)
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 0.5 }))).toBeNull();
    vi.advanceTimersByTime(250);
    expect(rule.getMaxIndex(makeContext({ bufferSeconds: 0.3 }))).toBeNull();
  });

  it('accounts for playbackRate in the linkRate derivation', () => {
    // Active = 1080p (3 Mbps). drainRate = 0.5 s/s, but playbackRate = 1.5
    // (catch-up). fraction = 1.5 - 0.5 = 1.0 → linkBps = 3M, cap = 2.1M.
    // 720p (1.5M) and below fit; 1080p (3M) doesn't. bestIndex = 2 (720p).
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.75, activeTrackIndex: 3, playbackRate: 1.5 }));
    vi.advanceTimersByTime(500);
    rule.getMaxIndex(makeContext({ bufferSeconds: 1.5, activeTrackIndex: 3, playbackRate: 1.5 }));
    vi.advanceTimersByTime(500);
    const result = rule.getMaxIndex(
      makeContext({ bufferSeconds: 1.25, activeTrackIndex: 3, playbackRate: 1.5 }),
    );

    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(2); // 720p
  });
});
