import { describe, it, expect } from 'vitest';
import { shouldDeferRangeJump } from '@/lib/buffer';

const base = {
  gapS: 7.8,
  currentRangeEndS: 16.2,
  nextRangeStartS: 24.0,
  frontStalledMs: 0,
  noProgressMs: 3000,
};

describe('shouldDeferRangeJump', () => {
  it('defers while the append front lies inside the gap (a fill in progress)', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: 16.2 } })).toBe(true);
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: 20.5 } })).toBe(true);
  });

  it('jumps when new data lands beyond the gap (an old hole nobody is filling)', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: 24.04 } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: 30 } })).toBe(false);
  });

  it('jumps when the front is far behind the gap', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: 10 } })).toBe(false);
  });

  it('never defers a tiny gap or an unknown front', () => {
    expect(shouldDeferRangeJump({ ...base, gapS: 0.05, fill: { appendFrontS: 16.2 } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: { appendFrontS: undefined } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: undefined })).toBe(false);
  });

  it('gives up once the front has not moved for noProgressMs', () => {
    expect(
      shouldDeferRangeJump({ ...base, fill: { appendFrontS: 16.2 }, frontStalledMs: 3000 }),
    ).toBe(false);
    expect(
      shouldDeferRangeJump({ ...base, fill: { appendFrontS: 16.2 }, frontStalledMs: 2999 }),
    ).toBe(true);
  });
});
