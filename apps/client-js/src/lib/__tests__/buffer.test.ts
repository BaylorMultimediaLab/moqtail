import { describe, it, expect } from 'vitest';
import { contiguousBufferAheadS, shouldDeferRangeJump } from '@/lib/buffer';

const base = {
  gapS: 7.8,
  currentRangeEndS: 16.2,
  nextRangeStartS: 24.0,
  frontStalledMs: 0,
  noProgressMs: 3000,
};

describe('shouldDeferRangeJump', () => {
  it('defers while an in-gap append front lies inside the gap (a fill in progress)', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: 16.2 } })).toBe(true);
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: 20.5 } })).toBe(true);
  });

  it('jumps when new data lands beyond the gap (an old hole nobody is filling)', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: 24.04 } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: 30 } })).toBe(false);
  });

  it('jumps when the front is far behind the gap', () => {
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: 10 } })).toBe(false);
  });

  it('never defers a tiny gap or an unknown front', () => {
    expect(shouldDeferRangeJump({ ...base, gapS: 0.05, fill: { fillFrontS: 16.2 } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: { fillFrontS: undefined } })).toBe(false);
    expect(shouldDeferRangeJump({ ...base, fill: undefined })).toBe(false);
  });

  it('gives up once the front has not moved for noProgressMs', () => {
    expect(
      shouldDeferRangeJump({ ...base, fill: { fillFrontS: 16.2 }, frontStalledMs: 3000 }),
    ).toBe(false);
    expect(
      shouldDeferRangeJump({ ...base, fill: { fillFrontS: 16.2 }, frontStalledMs: 2999 }),
    ).toBe(true);
  });
});

// M12: buffer_s counts across holes; the contiguous value stops at the end of
// the range containing the playhead.
describe('contiguousBufferAheadS', () => {
  const ranges = (pairs: Array<[number, number]>) => ({
    length: pairs.length,
    start: (i: number) => pairs[i]![0],
    end: (i: number) => pairs[i]![1],
  });

  it('is the end of the range containing the playhead minus the playhead', () => {
    expect(
      contiguousBufferAheadS(
        ranges([
          [0, 10],
          [11, 20],
        ]),
        8,
      ),
    ).toBeCloseTo(2);
  });

  it('is 0 when the playhead is in a hole or nothing is buffered', () => {
    expect(
      contiguousBufferAheadS(
        ranges([
          [0, 10],
          [11, 20],
        ]),
        10.5,
      ),
    ).toBe(0);
    expect(contiguousBufferAheadS(ranges([]), 3)).toBe(0);
  });

  it('counts a playhead a hair before the range start (seek rounding) as inside it', () => {
    expect(contiguousBufferAheadS(ranges([[11, 20]]), 10.9995)).toBeCloseTo(9.0005);
  });
});
