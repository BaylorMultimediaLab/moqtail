import { describe, it, expect, beforeEach } from 'vitest';
import { L2ARule } from '../L2ARule';
import { DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../../types';
import type { RulesContext } from '../../types';

function makeContext(overrides: Partial<RulesContext> = {}): RulesContext {
  return {
    tracks: [
      { name: '360p', bitrate: 500_000 },
      { name: '720p', bitrate: 1_500_000 },
      { name: '1080p', bitrate: 4_000_000 },
    ],
    activeTrackIndex: 0,
    bufferSeconds: 3,
    bandwidthBps: 2_000_000,
    fastEmaBps: 2_000_000,
    slowEmaBps: 2_000_000,
    droppedFrames: 0,
    totalFrames: 0,
    segmentDurationS: 4,
    isLowLatency: true,
    switchHistory: [],
    abrSettings: { ...DEFAULT_ABR_SETTINGS },
    probeBandwidthBps: 0,
    latencyTrendRatio: 1,
    playbackRate: 1,
    ...overrides,
  };
}

describe('L2ARule', () => {
  let rule: L2ARule;

  beforeEach(() => {
    rule = new L2ARule();
  });

  it('has the correct name', () => {
    expect(rule.name).toBe('L2ARule');
  });

  it('returns null when only one track', () => {
    const ctx = makeContext({
      tracks: [{ name: '360p', bitrate: 500_000 }],
    });
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });

  it('returns null when bandwidthBps is 0 (cold start)', () => {
    const ctx = makeContext({ bandwidthBps: 0 });
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });

  it('uses throughput-based selection during STARTUP', () => {
    // safeThroughput = 2_000_000 * 0.9 = 1_800_000
    // tracks: 500k fits, 1.5M fits, 4M does not → bestIndex = 1
    const ctx = makeContext({ bandwidthBps: 2_000_000 });
    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(1);
    expect(result!.reason).toBe('l2a-startup');
  });

  it('stays in STARTUP for first HORIZON-1 ticks', () => {
    const ctx = makeContext({ bandwidthBps: 2_000_000 });
    // HORIZON = 4, so first 3 calls should still be startup
    for (let i = 0; i < 3; i++) {
      const result = rule.getMaxIndex(ctx);
      expect(result!.reason).toBe('l2a-startup');
    }
  });

  it('transitions to STEADY after HORIZON ticks and makes optimization-based decisions', () => {
    const ctx = makeContext({ bandwidthBps: 2_000_000, bufferSeconds: 3 });

    // Drive through STARTUP (HORIZON = 4 ticks)
    for (let i = 0; i < 4; i++) {
      rule.getMaxIndex(ctx);
    }

    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('l2a-steady');
  });

  it('steady state returns a valid track index', () => {
    const ctx = makeContext({ bandwidthBps: 5_000_000, bufferSeconds: 3 });
    const n = ctx.tracks.length;

    for (let i = 0; i < 4; i++) {
      rule.getMaxIndex(ctx);
    }

    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBeGreaterThanOrEqual(0);
    expect(result!.representationIndex).toBeLessThan(n);
    expect(result!.priority).toBe(SwitchRequestPriority.DEFAULT);
  });

  it('REACT recalibration resets weights to [1,0,0,...] when current bitrate exceeds REACT*safeThroughput', () => {
    // safeThroughput = 500_000 * 0.9 = 450_000
    // REACT = 2, so threshold = 900_000
    // activeTrackIndex = 2 → bitrate = 4_000_000 > 900_000 → should recalibrate to index 0
    const ctx = makeContext({
      bandwidthBps: 500_000,
      activeTrackIndex: 2,
      bufferSeconds: 3,
    });

    // Drive past STARTUP
    for (let i = 0; i < 4; i++) {
      rule.getMaxIndex({ ...ctx, bandwidthBps: 5_000_000 }); // high bw for startup
    }

    // Now trigger REACT condition with low bandwidth
    const result = rule.getMaxIndex(ctx);
    expect(result).not.toBeNull();
    expect(result!.representationIndex).toBe(0);
    expect(result!.reason).toBe('l2a-steady');
  });

  it('reset() returns to STARTUP state', () => {
    const ctx = makeContext({ bandwidthBps: 2_000_000 });

    for (let i = 0; i < 4; i++) {
      rule.getMaxIndex(ctx);
    }

    const steadyResult = rule.getMaxIndex(ctx);
    expect(steadyResult!.reason).toBe('l2a-steady');

    rule.reset();
    const afterResetResult = rule.getMaxIndex(ctx);
    expect(afterResetResult!.reason).toBe('l2a-startup');
  });

  it('reset() clears the weight vector (re-initializes on next call)', () => {
    const ctx = makeContext({ bandwidthBps: 2_000_000 });

    for (let i = 0; i < 10; i++) {
      rule.getMaxIndex(ctx);
    }

    rule.reset();

    const result = rule.getMaxIndex(ctx);
    expect(result!.reason).toBe('l2a-startup');
  });

  it('returns correct priority from abrSettings', () => {
    const ctx = makeContext({ bandwidthBps: 2_000_000 });
    const result = rule.getMaxIndex(ctx);
    expect(result!.priority).toBe(SwitchRequestPriority.DEFAULT);
  });

  it('handles tracks with no bitrate (treated as 0) during STARTUP', () => {
    const ctx = makeContext({
      bandwidthBps: 500_000,
      tracks: [{ name: 'no-bitrate' }, { name: '360p', bitrate: 400_000 }],
    });
    // safeThroughput = 500_000 * 0.9 = 450_000
    // track 0: bitrate=0 fits, track 1: 400k fits → bestIndex = 1
    const result = rule.getMaxIndex(ctx);
    expect(result!.representationIndex).toBe(1);
    expect(result!.reason).toBe('l2a-startup');
  });

  it('returns null during STARTUP when no track fits within safe throughput', () => {
    const ctx = makeContext({
      bandwidthBps: 400_000,
      tracks: [
        { name: '720p', bitrate: 1_500_000 },
        { name: '1080p', bitrate: 4_000_000 },
      ],
    });
    // safeThroughput = 400_000 * 0.9 = 360_000; neither track fits
    expect(rule.getMaxIndex(ctx)).toBeNull();
  });
});
