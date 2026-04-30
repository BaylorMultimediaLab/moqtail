import { describe, it, expect } from 'vitest';
import { buildSubscribeParameters } from './player';

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
