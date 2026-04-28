import { describe, it, expect } from 'vitest';
import { DEFAULT_ABR_SETTINGS, SwitchRequestPriority } from '../types';

describe('DEFAULT_ABR_SETTINGS', () => {
  it('has all 11 rules defined', () => {
    const ruleNames = Object.keys(DEFAULT_ABR_SETTINGS.rules);
    expect(ruleNames).toHaveLength(11);
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

  it('DroppedFramesRule, L2ARule, LoLPRule are inactive by default', () => {
    expect(DEFAULT_ABR_SETTINGS.rules.DroppedFramesRule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.L2ARule!.active).toBe(false);
    expect(DEFAULT_ABR_SETTINGS.rules.LoLPRule!.active).toBe(false);
  });

  it('STRONG-priority rules preempt DEFAULT-tier upswitches', () => {
    // LatencyTrendRule (Kuo Algorithm 1 lines 14-16) and BufferDrainRateRule
    // are both downswitch safety nets that must beat DEFAULT-tier upswitches.
    const strongRules = new Set(['LatencyTrendRule', 'BufferDrainRateRule']);
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
});
