import { describe, it, expect } from 'vitest';
import { parseMoofBaseMediaDecodeTime } from './MoofParser';

/**
 * Builds a minimal moof box containing one traf with one tfdt (version=1).
 * Layout:
 *   moof (size, 'moof')
 *     traf (size, 'traf')
 *       tfdt (size, 'tfdt', version+flags, baseMediaDecodeTime u64)
 */
function makeMoof(baseMediaDecodeTime: bigint): Uint8Array {
  // tfdt: 4(size) + 4('tfdt') + 4(version+flags) + 8(decode_time) = 20 bytes
  const tfdt = new Uint8Array(20);
  const tfdtView = new DataView(tfdt.buffer);
  tfdtView.setUint32(0, 20, false);
  tfdt.set([0x74, 0x66, 0x64, 0x74], 4); // 'tfdt'
  tfdtView.setUint32(8, 0x01000000, false); // version=1, flags=0
  tfdtView.setBigUint64(12, baseMediaDecodeTime, false);

  // traf wraps tfdt: 8 header + 20 tfdt = 28
  const traf = new Uint8Array(28);
  const trafView = new DataView(traf.buffer);
  trafView.setUint32(0, 28, false);
  traf.set([0x74, 0x72, 0x61, 0x66], 4); // 'traf'
  traf.set(tfdt, 8);

  // moof wraps traf: 8 header + 28 traf = 36
  const moof = new Uint8Array(36);
  const moofView = new DataView(moof.buffer);
  moofView.setUint32(0, 36, false);
  moof.set([0x6d, 0x6f, 0x6f, 0x66], 4); // 'moof'
  moof.set(traf, 8);
  return moof;
}

/** Build a moof with a version=0 (32-bit) baseMediaDecodeTime. */
function makeMoofV0(baseMediaDecodeTime: number): Uint8Array {
  // tfdt: 4 + 4 + 4 + 4 = 16 bytes (4-byte time)
  const tfdt = new Uint8Array(16);
  const tfdtView = new DataView(tfdt.buffer);
  tfdtView.setUint32(0, 16, false);
  tfdt.set([0x74, 0x66, 0x64, 0x74], 4);
  tfdtView.setUint32(8, 0x00000000, false); // version=0, flags=0
  tfdtView.setUint32(12, baseMediaDecodeTime, false);

  const traf = new Uint8Array(24);
  const trafView = new DataView(traf.buffer);
  trafView.setUint32(0, 24, false);
  traf.set([0x74, 0x72, 0x61, 0x66], 4);
  traf.set(tfdt, 8);

  const moof = new Uint8Array(32);
  const moofView = new DataView(moof.buffer);
  moofView.setUint32(0, 32, false);
  moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
  moof.set(traf, 8);
  return moof;
}

describe('parseMoofBaseMediaDecodeTime', () => {
  it('extracts u64 baseMediaDecodeTime from version=1 tfdt at timescale=90000', () => {
    // 90000 ticks = 1 second = 1000 ms
    const moof = makeMoof(90000n);
    expect(parseMoofBaseMediaDecodeTime(moof, 90000)).toBeCloseTo(1000);
  });

  it('extracts u32 baseMediaDecodeTime from version=0 tfdt at timescale=1000', () => {
    // 5000 ticks at timescale=1000 = 5000 ms
    const moof = makeMoofV0(5000);
    expect(parseMoofBaseMediaDecodeTime(moof, 1000)).toBeCloseTo(5000);
  });

  it('returns undefined when moof box is absent', () => {
    const noMoof = new Uint8Array(20);
    expect(parseMoofBaseMediaDecodeTime(noMoof, 90000)).toBeUndefined();
  });

  it('returns undefined when traf box is absent inside moof', () => {
    // moof with only its 8-byte header — no children
    const moof = new Uint8Array(8);
    const view = new DataView(moof.buffer);
    view.setUint32(0, 8, false);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
    expect(parseMoofBaseMediaDecodeTime(moof, 90000)).toBeUndefined();
  });

  it('returns undefined when tfdt box is absent inside traf', () => {
    // moof -> traf with only its header — no tfdt child
    const traf = new Uint8Array(8);
    const trafView = new DataView(traf.buffer);
    trafView.setUint32(0, 8, false);
    traf.set([0x74, 0x72, 0x61, 0x66], 4);

    const moof = new Uint8Array(16);
    const moofView = new DataView(moof.buffer);
    moofView.setUint32(0, 16, false);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
    moof.set(traf, 8);
    expect(parseMoofBaseMediaDecodeTime(moof, 90000)).toBeUndefined();
  });

  it('skips sibling boxes before reaching traf', () => {
    // Construct moof with a sibling 'mfhd' box before 'traf':
    //   moof(size=44) { mfhd(size=8 + 4_payload=12) traf(size=24) }
    // mfhd: 4(size) + 4('mfhd') + 4(version+flags) = 12
    const mfhd = new Uint8Array(12);
    const mfhdView = new DataView(mfhd.buffer);
    mfhdView.setUint32(0, 12, false);
    mfhd.set([0x6d, 0x66, 0x68, 0x64], 4);

    // traf with tfdt v0 baseMediaDecodeTime=1000
    const tfdt = new Uint8Array(16);
    const tfdtView = new DataView(tfdt.buffer);
    tfdtView.setUint32(0, 16, false);
    tfdt.set([0x74, 0x66, 0x64, 0x74], 4);
    tfdtView.setUint32(8, 0x00000000, false);
    tfdtView.setUint32(12, 1000, false);

    const traf = new Uint8Array(24);
    const trafView = new DataView(traf.buffer);
    trafView.setUint32(0, 24, false);
    traf.set([0x74, 0x72, 0x61, 0x66], 4);
    traf.set(tfdt, 8);

    // moof: 8 header + 12 mfhd + 24 traf = 44
    const moof = new Uint8Array(44);
    const moofView = new DataView(moof.buffer);
    moofView.setUint32(0, 44, false);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
    moof.set(mfhd, 8);
    moof.set(traf, 8 + 12);

    expect(parseMoofBaseMediaDecodeTime(moof, 1000)).toBeCloseTo(1000);
  });

  it('handles moof not at offset 0 (Uint8Array byteOffset != 0)', () => {
    const moof = makeMoof(90000n);
    const padded = new Uint8Array(50);
    padded.set(moof, 14);
    const slice = padded.subarray(14, 14 + 36);
    expect(parseMoofBaseMediaDecodeTime(slice, 90000)).toBeCloseTo(1000);
  });

  it('returns undefined on a malformed box with size=0', () => {
    // box header advertising size=0 would loop forever in a naive walker;
    // confirm we treat as malformed and return undefined.
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0, false); // bogus size
    buf.set([0x6d, 0x6f, 0x6f, 0x66], 4);
    expect(parseMoofBaseMediaDecodeTime(buf, 90000)).toBeUndefined();
  });
});
