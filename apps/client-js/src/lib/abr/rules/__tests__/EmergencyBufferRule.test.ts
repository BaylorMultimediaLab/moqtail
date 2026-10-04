import { describe, it, expect } from 'vitest';
import { EmergencyBufferRule } from '../EmergencyBufferRule';
import { DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../../types';
import type { AbrSettings, RulesContext } from '../../types';

const tracks = [
  { name: '360p', bitrate: 500_000 },
  { name: '720p', bitrate: 1_500_000 },
  { name: '1080p', bitrate: 4_000_000 },
];

const active: AbrSettings = {
  ...DEFAULT_ABR_SETTINGS,
  rules: {
    ...DEFAULT_ABR_SETTINGS.rules,
    EmergencyBufferRule: { ...DEFAULT_ABR_SETTINGS.rules.EmergencyBufferRule!, active: true },
  },
};

function makeContext(overrides: Partial<RulesContext> = {}): RulesContext {
  return {
    tracks,
    activeTrackIndex: 2,
    bufferSeconds: 5,
    bufferInstantSeconds: 5,
    bandwidthBps: 10_000_000,
    fastEmaBps: 10_000_000,
    slowEmaBps: 10_000_000,
    droppedFrames: 0,
    totalFrames: 1000,
    segmentDurationS: 1,
    isLowLatency: false,
    switchHistory: [],
    abrSettings: active,
    probeBandwidthBps: 0,
    latencyTrendRatio: 1,
    playbackRate: 1,
    ...overrides,
  };
}

describe('EmergencyBufferRule', () => {
  it('is inactive in the shipped defaults (baseline / grid)', () => {
    expect(DEFAULT_ABR_SETTINGS.rules.EmergencyBufferRule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.EmergencyBufferRule!.priority).toBe(
      SwitchRequestPriority.STRONG,
    );
    const rule = new EmergencyBufferRule();
    expect(
      rule.getMaxIndex(makeContext({ bufferInstantSeconds: 0, abrSettings: DEFAULT_ABR_SETTINGS })),
    ).toBeNull();
  });

  it('abstains while the buffer is at or above the low threshold', () => {
    const rule = new EmergencyBufferRule();
    expect(rule.getMaxIndex(makeContext({ bufferInstantSeconds: 0.5 }))).toBeNull();
    expect(rule.getMaxIndex(makeContext({ bufferInstantSeconds: 5 }))).toBeNull();
  });

  it('empty buffer -> rung 0, STRONG, reason names the emergency', () => {
    const rule = new EmergencyBufferRule();
    const r = rule.getMaxIndex(makeContext({ bufferInstantSeconds: 0 }));
    expect(r).toEqual({
      representationIndex: 0,
      priority: SwitchRequestPriority.STRONG,
      reason: 'emergency-buffer-empty',
    });
  });

  it('low buffer -> highest rung with bitrate <= 0.7 x SWMA', () => {
    const rule = new EmergencyBufferRule();
    // 0.7 x 2.5 Mbps = 1.75 Mbps: 720p fits, 1080p does not.
    const r = rule.getMaxIndex(
      makeContext({ bufferInstantSeconds: 0.3, bandwidthBps: 2_500_000, activeTrackIndex: 2 }),
    );
    expect(r?.representationIndex).toBe(1);
    expect(r?.priority).toBe(SwitchRequestPriority.STRONG);
    expect(r?.reason).toContain('emergency-buffer-low');
  });

  it('low buffer with no rung under the cap -> rung 0', () => {
    const rule = new EmergencyBufferRule();
    const r = rule.getMaxIndex(
      makeContext({ bufferInstantSeconds: 0.3, bandwidthBps: 600_000, activeTrackIndex: 2 }),
    );
    expect(r?.representationIndex).toBe(0);
  });

  it('low buffer only ever lowers: it abstains when the 0.7 x SWMA rung is at or above the active one', () => {
    const rule = new EmergencyBufferRule();
    // 0.7 x 10 Mbps fits 1080p, above the active 720p: no "stay" vote, no climb.
    expect(
      rule.getMaxIndex(
        makeContext({ bufferInstantSeconds: 0.3, bandwidthBps: 10_000_000, activeTrackIndex: 1 }),
      ),
    ).toBeNull();
    // 0.7 x 2.5 Mbps fits exactly the active 720p: nothing to do either.
    expect(
      rule.getMaxIndex(
        makeContext({ bufferInstantSeconds: 0.3, bandwidthBps: 2_500_000, activeTrackIndex: 1 }),
      ),
    ).toBeNull();
  });

  it('judges the instantaneous contiguous buffer, not the envelope the other rules see', () => {
    const rule = new EmergencyBufferRule();
    const r = rule.getMaxIndex(makeContext({ bufferSeconds: 1.0, bufferInstantSeconds: 0 }));
    expect(r?.representationIndex).toBe(0);
    expect(
      rule.getMaxIndex(makeContext({ bufferSeconds: 0, bufferInstantSeconds: 1.0 })),
    ).toBeNull();
  });

  it('falls back to bufferSeconds when no instantaneous value is given', () => {
    const rule = new EmergencyBufferRule();
    const r = rule.getMaxIndex(makeContext({ bufferSeconds: 0, bufferInstantSeconds: undefined }));
    expect(r?.representationIndex).toBe(0);
  });

  it('abstains before the first frame is presented', () => {
    const rule = new EmergencyBufferRule();
    expect(rule.getMaxIndex(makeContext({ bufferInstantSeconds: 0, totalFrames: 0 }))).toBeNull();
  });

  it('honours lowBufferS and throughputSafetyFactor parameters', () => {
    const settings: AbrSettings = {
      ...active,
      rules: {
        ...active.rules,
        EmergencyBufferRule: {
          ...active.rules.EmergencyBufferRule!,
          parameters: { lowBufferS: 1.0, throughputSafetyFactor: 0.5 },
        },
      },
    };
    const rule = new EmergencyBufferRule();
    // 0.8 s is now "low"; 0.5 x 4 Mbps = 2 Mbps: 720p.
    const r = rule.getMaxIndex(
      makeContext({ bufferInstantSeconds: 0.8, bandwidthBps: 4_000_000, abrSettings: settings }),
    );
    expect(r?.representationIndex).toBe(1);
  });
});
