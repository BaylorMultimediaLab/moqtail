import { describe, it, expect } from 'vitest';
import { computeLiveEdgeDelay, DEFAULT_LIVE_EDGE_DELAY } from './buffer';

describe('computeLiveEdgeDelay', () => {
  it('returns DEFAULT_LIVE_EDGE_DELAY for live-edge mode', () => {
    expect(computeLiveEdgeDelay('live-edge', 0)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    expect(computeLiveEdgeDelay('live-edge', 5)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    // timeShiftSeconds is ignored when live-edge
  });

  it('returns timeShiftSeconds for time-shifted mode', () => {
    expect(computeLiveEdgeDelay('time-shifted', 2)).toBeCloseTo(2);
    expect(computeLiveEdgeDelay('time-shifted', 20)).toBeCloseTo(20);
  });

  it('falls back to DEFAULT for time-shifted mode with non-positive delay', () => {
    // Defensive: if a UI bug allows time-shifted+0, don't park playback at the live
    // edge with no buffer runway. Use the default so MSE doesn't immediately stall.
    expect(computeLiveEdgeDelay('time-shifted', 0)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
    expect(computeLiveEdgeDelay('time-shifted', -1)).toBeCloseTo(DEFAULT_LIVE_EDGE_DELAY);
  });
});
