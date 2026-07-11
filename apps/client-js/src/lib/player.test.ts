import { describe, it, expect } from 'vitest';
import { buildSubscribeParameters, computeSwitchMinimumGroup, computeStartupTarget } from './player';

describe('buildSubscribeParameters', () => {
  it('returns undefined for unfiltered mode', () => {
    const params = buildSubscribeParameters({
      clientMode: 'unfiltered',
      filterDelaySeconds: 2,
      gopDurationMs: 1000,
    });
    expect(params).toBeUndefined();
  });

  it('returns undefined for filtered with zero delay', () => {
    const params = buildSubscribeParameters({
      clientMode: 'filtered',
      filterDelaySeconds: 0,
      gopDurationMs: 1000,
    });
    expect(params).toBeUndefined();
  });

  it('builds VersionSpecificParameters with DELAY_GROUPS for filtered + 2s delay + 1000ms GOP', () => {
    const params = buildSubscribeParameters({
      clientMode: 'filtered',
      filterDelaySeconds: 2,
      gopDurationMs: 1000,
    });
    expect(params).toBeDefined();
    const kvps = params!.build();
    expect(kvps).toHaveLength(1);
    expect(kvps[0]!.typeValue).toBe(0x70n);
    expect(kvps[0]!.value).toBe(2n);
  });

  it('rounds 1.7s delay with 1000ms GOP to 2 groups', () => {
    const params = buildSubscribeParameters({
      clientMode: 'filtered',
      filterDelaySeconds: 1.7,
      gopDurationMs: 1000,
    });
    expect(params!.build()[0]!.value).toBe(2n);
  });

  it('handles 500ms GOP correctly: 2s delay → 4 groups', () => {
    const params = buildSubscribeParameters({
      clientMode: 'filtered',
      filterDelaySeconds: 2,
      gopDurationMs: 500,
    });
    expect(params!.build()[0]!.value).toBe(4n);
  });
});

describe('computeSwitchMinimumGroup', () => {
  it('naive mode floors at the next boundary after the latest received group', () => {
    // latestGroup + 1: the relay identifies G_switch within T_switch, waiting
    // for a not-yet-started group, so naming the NEXT boundary is safe and
    // lands the switch with no redelivery and no catch-up.
    const r = computeSwitchMinimumGroup({ switchMode: 'naive', targetGroup: 42, latestGroup: 17n });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(false);
  });

  it('naive mode before any object arrives sends the spec floor 0', () => {
    const r = computeSwitchMinimumGroup({ switchMode: 'naive', targetGroup: undefined, latestGroup: -1n });
    expect(r.minimumSwitchingGroupId).toBe(0);
    expect(r.timeMapMiss).toBe(false);
  });

  it('uses the target group as the floor for aligned mode with a target', () => {
    const r = computeSwitchMinimumGroup({ switchMode: 'aligned', targetGroup: 42, latestGroup: 17n });
    expect(r.minimumSwitchingGroupId).toBe(42);
    expect(r.timeMapMiss).toBe(false);
  });

  it('flags timeMapMiss when aligned but no target, falling through to the naive floor', () => {
    const r = computeSwitchMinimumGroup({ switchMode: 'aligned', targetGroup: undefined, latestGroup: 17n });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(true);
  });

  it("does NOT flag miss when naive + no target (naive doesn't need TimeMap)", () => {
    const r = computeSwitchMinimumGroup({ switchMode: 'naive', targetGroup: undefined, latestGroup: 17n });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(false);
  });

  it('aligned miss before any object arrives falls all the way to 0', () => {
    const r = computeSwitchMinimumGroup({ switchMode: 'aligned', targetGroup: undefined, latestGroup: -1n });
    expect(r.minimumSwitchingGroupId).toBe(0);
    expect(r.timeMapMiss).toBe(true);
  });
});

describe('computeStartupTarget', () => {
  it('subtracts 1.0s from end for unfiltered mode', () => {
    const t = computeStartupTarget({ end: 10, baseTarget: 0, clientMode: 'unfiltered' });
    expect(t).toBeCloseTo(9.0);
  });

  it('does not subtract anything for filtered mode (already behind live)', () => {
    const t = computeStartupTarget({ end: 10, baseTarget: 0, clientMode: 'filtered' });
    expect(t).toBeCloseTo(10.0);
  });

  it('preserves baseTarget when it exceeds the offset-adjusted end (unfiltered)', () => {
    // baseTarget 9.5 > end-1 (9.0) -> max wins
    const t = computeStartupTarget({ end: 10, baseTarget: 9.5, clientMode: 'unfiltered' });
    expect(t).toBeCloseTo(9.5);
  });

  it('preserves baseTarget when it exceeds end in filtered mode', () => {
    // shouldn't happen in practice, but max() semantic is preserved
    const t = computeStartupTarget({ end: 10, baseTarget: 11, clientMode: 'filtered' });
    expect(t).toBeCloseTo(11);
  });

  it('subtracts filterDelaySeconds for filtered mode when provided', () => {
    // bufferEdge=30, delay=30 → target=0 (player starts already 30s behind buffer end)
    expect(
      computeStartupTarget({
        end: 30,
        baseTarget: 0,
        clientMode: 'filtered',
        filterDelaySeconds: 30,
      }),
    ).toBeCloseTo(0);
  });

  it('subtracts smaller filterDelaySeconds correctly', () => {
    // bufferEdge=10, delay=2 → target=8 (player 2s behind buffer end)
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'filtered',
        filterDelaySeconds: 2,
      }),
    ).toBeCloseTo(8);
  });

  it('preserves baseTarget when it exceeds end - filterDelaySeconds', () => {
    // baseTarget 5 > end-delay (30-30=0) → max wins
    expect(
      computeStartupTarget({
        end: 30,
        baseTarget: 5,
        clientMode: 'filtered',
        filterDelaySeconds: 30,
      }),
    ).toBeCloseTo(5);
  });

  it('falls back to 0 offset when filtered + filterDelaySeconds undefined', () => {
    // Backward-compat: existing behavior when caller forgets to pass it.
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'filtered',
      }),
    ).toBeCloseTo(10);
  });

  it('ignores filterDelaySeconds in unfiltered mode', () => {
    // Even if caller passes filterDelaySeconds, unfiltered uses LIVE_EDGE_STARTUP_OFFSET_SECONDS.
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'unfiltered',
        filterDelaySeconds: 5,
      }),
    ).toBeCloseTo(9);
  });
});
