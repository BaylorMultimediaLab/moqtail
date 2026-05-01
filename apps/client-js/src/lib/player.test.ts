import { describe, it, expect } from 'vitest';
import { buildSubscribeParameters, buildSwitchParameters, computeStartupTarget } from './player';

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

describe('buildSwitchParameters', () => {
  it('returns undefined params for naive mode', () => {
    const r = buildSwitchParameters({ switchMode: 'naive', targetGroup: 42 });
    expect(r.params).toBeUndefined();
    expect(r.timeMapMiss).toBe(false);
  });

  it('encodes START_LOCATION_GROUP for aligned mode with a target', () => {
    const r = buildSwitchParameters({ switchMode: 'aligned', targetGroup: 42 });
    expect(r.params).toBeDefined();
    const kvps = r.params!.build();
    expect(kvps).toHaveLength(1);
    expect(kvps[0]!.typeValue).toBe(0x72n);
    expect(kvps[0]!.value).toBe(42n);
    expect(r.timeMapMiss).toBe(false);
  });

  it('flags timeMapMiss when aligned but no target', () => {
    const r = buildSwitchParameters({ switchMode: 'aligned', targetGroup: undefined });
    expect(r.params).toBeUndefined();
    expect(r.timeMapMiss).toBe(true);
  });

  it("does NOT flag miss when naive + no target (naive doesn't need TimeMap)", () => {
    const r = buildSwitchParameters({ switchMode: 'naive', targetGroup: undefined });
    expect(r.params).toBeUndefined();
    expect(r.timeMapMiss).toBe(false);
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
