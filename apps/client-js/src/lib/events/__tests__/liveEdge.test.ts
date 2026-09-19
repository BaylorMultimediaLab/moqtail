import { describe, it, expect } from 'vitest';
import { estimateLiveEdge, readPrft, targetShiftMs } from '../liveEdge';

describe('estimateLiveEdge', () => {
  it('extrapolates the live edge from the PRFT anchor', () => {
    const e = estimateLiveEdge({
      anchor: { captureMs: 1_000_000, mediaMs: 50_000 },
      nowMs: 1_000_400,
      playheadMs: 40_000,
      targetShiftMs: 10_000,
    });
    expect(e.anchorAgeMs).toBe(400);
    expect(e.liveEdgePtsMs).toBe(50_400);
    expect(e.liveEdgeDistanceMs).toBe(10_400);
    expect(e.timeShiftErrorMs).toBe(400);
  });

  it('reports a negative error when the client is ahead of its target', () => {
    const e = estimateLiveEdge({
      anchor: { captureMs: 0, mediaMs: 20_000 },
      nowMs: 0,
      playheadMs: 11_000,
      targetShiftMs: 10_000,
    });
    expect(e.timeShiftErrorMs).toBe(-1_000);
  });
});

describe('targetShiftMs', () => {
  it('quantises a filtered client to whole groups', () => {
    const t = targetShiftMs({
      clientMode: 'filtered',
      filterDelaySeconds: 10.4,
      gopDurationMs: 1000,
      liveEdgeDelaySeconds: 0.6,
    });
    expect(t).toEqual({ targetShiftMs: 10_000, delayGroups: 10 });
  });

  it('uses the player live-edge delay for an unfiltered client', () => {
    const t = targetShiftMs({
      clientMode: 'unfiltered',
      filterDelaySeconds: 10,
      gopDurationMs: 1000,
      liveEdgeDelaySeconds: 0.6,
    });
    expect(t).toEqual({ targetShiftMs: 600, delayGroups: 0 });
  });
});

describe('readPrft', () => {
  function prft(ntpSeconds: number, ntpFraction: number, mediaTime: bigint): Uint8Array {
    const buf = new Uint8Array(40);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 32);
    buf.set([0x70, 0x72, 0x66, 0x74], 4);
    buf[8] = 1;
    v.setUint32(12, 1);
    v.setUint32(16, ntpSeconds);
    v.setUint32(20, ntpFraction);
    v.setBigUint64(24, mediaTime);
    return buf;
  }

  it('decodes NTP seconds and media_time', () => {
    const ntpSeconds = 2_208_988_800 + 1_700_000_000; // UNIX 1.7e9 s
    const r = readPrft(prft(ntpSeconds, 0x8000_0000, 123_456n));
    expect(r).not.toBeNull();
    expect(r!.captureMs).toBeCloseTo(1_700_000_000_500, 3);
    expect(r!.mediaTime).toBe(123_456);
  });

  it('returns null for a non-prft chunk', () => {
    const buf = new Uint8Array(40);
    expect(readPrft(buf)).toBeNull();
    expect(readPrft(new Uint8Array(8))).toBeNull();
  });

  it('honours the byteOffset of a view', () => {
    const inner = prft(2_208_988_800 + 1, 0, 7n);
    const outer = new Uint8Array(inner.length + 5);
    outer.set(inner, 5);
    const view = new Uint8Array(outer.buffer, 5, inner.length);
    expect(readPrft(view)!.mediaTime).toBe(7);
  });
});
