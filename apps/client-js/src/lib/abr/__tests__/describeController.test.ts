import { describe, it, expect } from 'vitest';
import { CONTROLLER_CONSTANTS, DEFAULT_ABR_SETTINGS, describeController } from '../types';
import type { AbrSettings } from '../types';
import { AbrController } from '../AbrController';

// (h) RUN_META.controller content: the arm and every effective constant, so a
// run is reproducible from its log alone (the hard-coded numbers were pinned
// only by the git sha before).
describe('describeController', () => {
  const min: AbrSettings = {
    ...DEFAULT_ABR_SETTINGS,
    controller: { ...DEFAULT_ABR_SETTINGS.controller, arm: 'min' },
  };

  it('reports the min arm with every effective constant', () => {
    expect(describeController(min)).toEqual({
      arm: 'min',
      tickMs: 250,
      segmentDurationS: 1,
      swmaWindowGroups: 5,
      bufferSource: 'contiguous',
      bufferSignal: 'envelope',
      bufferEnvelopeMs: 1250,
      upDwellGroups: 3,
      minStartupSamples: 3,
      upGuardSamples: 0,
      upGuardRelease: 'landed',
      switchTimeoutMs: 3000,
      switchCooldownMs: 5000,
      maxHistory: 60,
      switchHistoryMode: 'veto',
      switchHistoryWindowS: 60,
      switchHistorySampleSize: 8,
      switchHistoryDropRatio: 0.075,
      historyIgnoreGroupsAfterLanding: 2,
      bandwidthSafetyFactor: 0.9,
      throughputDownToLowest: true,
      minBitrate: -1,
      maxBitrate: -1,
      emergencyLowBufferS: 0.5,
      emergencyThroughputSafetyFactor: 0.7,
      probeMode: 'off',
      probeMinBytes: 0,
      probeMinDurationMs: 0,
      probeMaxBytes: 0,
      probeSafetyFactor: 0.8,
      probeIntervalMs: 2000,
      probeDurationMs: 500,
      probeFreshnessMs: 5000,
      probeHorizonS: 2,
      latencyResetOnLanding: false,
      latencyTrendThreshold: 1.2,
      latencyTrendDeltaMs: 100,
      bufferTimeDefault: 18,
      stableBufferTime: 18,
      activeRules: ['ThroughputRule', 'SwitchHistoryRule', 'EmergencyBufferRule'],
      rules: {
        ThroughputRule: { priority: 0.5, parameters: { downToLowest: 1 } },
        SwitchHistoryRule: {
          priority: 0.5,
          parameters: { sampleSize: 8, switchPercentageThreshold: 0.075 },
        },
        EmergencyBufferRule: {
          priority: 1,
          parameters: { lowBufferS: 0.5, throughputSafetyFactor: 0.7 },
        },
      },
    });
  });

  it('reports tuned min constants and the catalog GOP', () => {
    const d = describeController({
      ...min,
      bandwidthSafetyFactor: 0.8,
      controller: {
        ...min.controller,
        segmentDurationS: 2,
        upDwellGroups: 4,
        historyIgnoreGroupsAfterLanding: 1,
        switchHistoryWindowS: 30,
        bufferEnvelopeMs: 2250,
      },
    });
    expect(d.segmentDurationS).toBe(2);
    expect(d.upDwellGroups).toBe(4);
    expect(d.historyIgnoreGroupsAfterLanding).toBe(1);
    expect(d.switchHistoryWindowS).toBe(30);
    expect(d.bufferEnvelopeMs).toBe(2250);
    expect(d.bandwidthSafetyFactor).toBe(0.8);
  });

  it('defaults the envelope window to one GOP plus one tick (R4-D5)', () => {
    const at = (segmentDurationS: number, bufferEnvelopeMs?: number) =>
      describeController({
        ...min,
        controller: {
          ...min.controller,
          segmentDurationS,
          ...(bufferEnvelopeMs !== undefined ? { bufferEnvelopeMs } : {}),
        },
      }).bufferEnvelopeMs;
    expect(at(1)).toBe(1250);
    expect(at(2)).toBe(2250);
    expect(at(0.5)).toBe(750);
    // An explicit window wins.
    expect(at(2, 1250)).toBe(1250);
  });

  it('describes grid with its own knobs, the probe and the rules it runs', () => {
    const d = describeController({
      ...DEFAULT_ABR_SETTINGS,
      controller: {
        ...DEFAULT_ABR_SETTINGS.controller,
        arm: 'grid',
        latencyResetOnLanding: true,
        bufferSignal: 'envelope',
        switchHistoryMode: 'veto',
        switchHistoryWindowS: 60,
        probeMaxBytes: 65_536,
      },
    });
    expect(d.arm).toBe('grid');
    expect(d.bufferSource).toBe('total');
    expect(d.upDwellGroups).toBe(0);
    expect(d.throughputDownToLowest).toBe(false);
    expect(d.probeMode).toBe('on');
    expect(d.probeMaxBytes).toBe(65_536);
    expect(d.latencyResetOnLanding).toBe(true);
    expect(d.switchHistoryMode).toBe('veto');
    expect(d.activeRules).toEqual([
      'ThroughputRule',
      'BolaRule',
      'ProbeRule',
      'InsufficientBufferRule',
      'BufferDrainRateRule',
      'LatencyTrendRule',
      'SwitchHistoryRule',
      'AbandonRequestsRule',
    ]);
    expect(d.rules.InsufficientBufferRule!.parameters).toEqual({
      throughputSafetyFactor: 0.7,
      segmentIgnoreCount: 2,
    });
  });

  it('baseline is the shipped controller; switchHistoryMode/probeMode off take the rule out', () => {
    const d = describeController(DEFAULT_ABR_SETTINGS);
    expect(d.arm).toBe('baseline');
    expect(d.bufferSignal).toBe('instant');
    expect(d.switchHistoryMode).toBe('evict');
    expect(d.switchHistoryWindowS).toBe(0);
    expect(d.probeMode).toBe('on');
    const off = describeController({
      ...DEFAULT_ABR_SETTINGS,
      controller: {
        ...DEFAULT_ABR_SETTINGS.controller,
        switchHistoryMode: 'off',
        probeMode: 'off',
      },
    });
    expect(off.switchHistoryMode).toBe('off');
    expect(off.activeRules).not.toContain('SwitchHistoryRule');
    expect(off.activeRules).not.toContain('ProbeRule');
  });

  it('matches what the controller runs (constants are shared, not copied)', () => {
    expect(AbrController.SWITCH_TIMEOUT_MS).toBe(CONTROLLER_CONSTANTS.switchTimeoutMs);
    expect(AbrController.SWITCH_COOLDOWN_MS).toBe(CONTROLLER_CONSTANTS.switchCooldownMs);
    expect(AbrController.MIN_STARTUP_SAMPLES).toBe(CONTROLLER_CONSTANTS.minStartupSamples);
  });

  it('is plain JSON (no functions, no undefined) so it can be logged as RUN_META.controller', () => {
    const d = describeController(min);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    for (const v of Object.values(d)) expect(v).not.toBeUndefined();
  });
});
