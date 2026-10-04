import { describe, it, expect } from 'vitest';
import { bufferEnvelope, DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../types';

describe('DEFAULT_ABR_SETTINGS', () => {
  it('has all 12 rules defined', () => {
    const ruleNames = Object.keys(DEFAULT_ABR_SETTINGS.rules);
    expect(ruleNames).toHaveLength(12);
    expect(ruleNames).toContain('EmergencyBufferRule');
    expect(ruleNames).toContain('ThroughputRule');
    expect(ruleNames).toContain('BolaRule');
    expect(ruleNames).toContain('ProbeRule');
    expect(ruleNames).toContain('InsufficientBufferRule');
    expect(ruleNames).toContain('BufferDrainRateRule');
    expect(ruleNames).toContain('LatencyTrendRule');
    expect(ruleNames).toContain('SwitchHistoryRule');
    expect(ruleNames).toContain('DroppedFramesRule');
    expect(ruleNames).toContain('AbandonRequestsRule');
    expect(ruleNames).toContain('L2ARule');
    expect(ruleNames).toContain('LoLPRule');
  });

  it('DroppedFramesRule, L2ARule, LoLPRule, EmergencyBufferRule are inactive by default', () => {
    expect(DEFAULT_ABR_SETTINGS.rules.DroppedFramesRule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.EmergencyBufferRule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.L2ARule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.LoLPRule!.active).toBe(false);
  });

  it('STRONG-priority rules preempt DEFAULT-tier upswitches', () => {
    // LatencyTrendRule (Kuo Algorithm 1 lines 14-16) and BufferDrainRateRule
    // are both downswitch safety nets that must beat DEFAULT-tier upswitches.
    const strongRules = new Set(['LatencyTrendRule', 'BufferDrainRateRule', 'EmergencyBufferRule']);
    for (const [name, rule] of Object.entries(DEFAULT_ABR_SETTINGS.rules)) {
      if (strongRules.has(name)) {
        expect(rule.priority).toBe(SwitchRequestPriority.STRONG);
      } else {
        expect(rule.priority).toBe(SwitchRequestPriority.DEFAULT);
      }
    }
  });

  it('bufferTimeDefault is 18', () => {
    expect(DEFAULT_ABR_SETTINGS.bufferTimeDefault).toBe(18);
  });

  it("the shipped controller is the baseline arm; the min arm's constants are 3 groups dwell and 2 groups seam window", () => {
    expect(DEFAULT_ABR_SETTINGS.controller.arm).toBe('baseline');
    expect(DEFAULT_ABR_SETTINGS.controller.upDwellGroups).toBe(3);
    expect(DEFAULT_ABR_SETTINGS.controller.historyIgnoreGroupsAfterLanding).toBe(2);
  });
});

describe('bufferEnvelope', () => {
  const saw = [
    { ts: 0, bufferSeconds: 1.0 },
    { ts: 250, bufferSeconds: 0.72 },
    { ts: 500, bufferSeconds: 0.47 },
    { ts: 750, bufferSeconds: 0.23 },
    { ts: 1000, bufferSeconds: 0.98 },
    { ts: 1250, bufferSeconds: 0.71 },
    { ts: 1500, bufferSeconds: 0.42 },
    { ts: 1750, bufferSeconds: 0.22 },
  ];

  it('reads the level after the last group landed, not the falling edge', () => {
    expect(bufferEnvelope(saw, 1750, 1250)).toBeCloseTo(0.98);
    expect(bufferEnvelope(saw, 750, 1250)).toBeCloseTo(1.0);
  });

  it('only looks inside the window', () => {
    expect(bufferEnvelope(saw, 1750, 500)).toBeCloseTo(0.71);
    expect(bufferEnvelope([], 0, 1250)).toBe(0);
  });

  it('follows a real drain once the peaks fall', () => {
    const draining = saw.map(s => ({ ts: s.ts + 2000, bufferSeconds: s.bufferSeconds * 0.2 }));
    expect(bufferEnvelope(draining, 3750, 1250)).toBeCloseTo(0.196);
  });
});
