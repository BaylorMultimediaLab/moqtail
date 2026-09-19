import { describe, it, expect } from 'vitest';
import { TimeMap } from './TimeMap';

describe('TimeMap', () => {
  it('returns the recorded group when PTS falls inside it', () => {
    const t = new TimeMap(1000);
    t.recordGroupBoundary(10, 10000);
    expect(t.groupContainingPTS(10500)).toBe(10);
  });

  it('returns the next group at the boundary PTS', () => {
    // Boundary PTS belongs to the NEXT group (group K starts at PTS, group K-1 ends just before).
    const t = new TimeMap(1000);
    t.recordGroupBoundary(10, 10000);
    t.recordGroupBoundary(11, 11000);
    expect(t.groupContainingPTS(11000)).toBe(11);
  });

  it('extrapolates forward from the anchor when PTS is past every recorded boundary', () => {
    const t = new TimeMap(1000);
    t.recordGroupBoundary(10, 10000);
    expect(t.groupContainingPTS(20500)).toBe(20);
  });

  it('extrapolates backward from the anchor when PTS is before every recorded boundary', () => {
    const t = new TimeMap(1000);
    t.recordGroupBoundary(10, 10000);
    expect(t.groupContainingPTS(7500)).toBe(7);
  });

  it('returns undefined when no anchor is recorded', () => {
    const t = new TimeMap(1000);
    expect(t.groupContainingPTS(5000)).toBeUndefined();
  });

  it('handles 500ms GOP duration', () => {
    const t = new TimeMap(500);
    t.recordGroupBoundary(20, 10000);
    expect(t.groupContainingPTS(10250)).toBe(20); // mid-GOP
    expect(t.groupContainingPTS(10500)).toBe(21); // boundary
    expect(t.groupContainingPTS(10750)).toBe(21); // mid next GOP
  });

  it('is idempotent on duplicate recordGroupBoundary calls', () => {
    const t = new TimeMap(1000);
    t.recordGroupBoundary(10, 10000);
    t.recordGroupBoundary(10, 10000);
    t.recordGroupBoundary(10, 10000);
    expect(t.groupContainingPTS(10500)).toBe(10);
  });

  it('uses the anchor (first recorded) for extrapolation regardless of insertion order', () => {
    // Insert 12 first, then 10. Anchor is whichever arrived first chronologically;
    // extrapolation result should be deterministic either way for in-range PTS.
    const t = new TimeMap(1000);
    t.recordGroupBoundary(12, 12000);
    t.recordGroupBoundary(10, 10000);
    expect(t.groupContainingPTS(11500)).toBe(11); // mid between 10 and 12
    expect(t.groupContainingPTS(15500)).toBe(15); // forward extrapolation
  });
});
