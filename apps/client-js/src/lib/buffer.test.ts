import { describe, it, expect } from 'vitest';
import { computeLiveEdgeDelay, DEFAULT_LIVE_EDGE_DELAY } from './buffer';

describe('computeLiveEdgeDelay', () => {
  it('returns DEFAULT_LIVE_EDGE_DELAY for unfiltered mode', () => {
    expect(computeLiveEdgeDelay('unfiltered', 0)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    expect(computeLiveEdgeDelay('unfiltered', 5)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    // filterDelaySeconds is ignored when unfiltered
  });

  it('returns filterDelaySeconds for filtered mode', () => {
    expect(computeLiveEdgeDelay('filtered', 2)).toBeCloseTo(2);
    expect(computeLiveEdgeDelay('filtered', 20)).toBeCloseTo(20);
  });

  it('falls back to DEFAULT for filtered mode with non-positive delay', () => {
    // Defensive: if a UI bug allows filtered+0, don't park playback at the live
    // edge with no buffer runway. Use the default so MSE doesn't immediately stall.
    expect(computeLiveEdgeDelay('filtered', 0)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    expect(computeLiveEdgeDelay('filtered', -1)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
  });
});
