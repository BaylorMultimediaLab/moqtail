import { describe, it, expect } from 'vitest';
import { SeamTracker } from './seam';

const send = (t: SeamTracker, from: string, to: string, sentAt = 1000) =>
  t.sent(from, to, { playheadMs: 10_000, appendFrontMs: 12_000, sentAt });

const land = (t: SeamTracker, rec: ReturnType<typeof send>, group: number, now: number) =>
  t.landed(rec, { group, object: 0, landedOnKeyframe: true, sourceEndMs: 12_000, now });

describe('SeamTracker: switch identity (C1)', () => {
  it('numbers switches from 1, monotonically, per tracker', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    const b = send(t, 'mid', 'high');
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.from).toBe('low');
    expect(a.to).toBe('mid');
    expect(a.playheadAtSendMs).toBe(10_000);
    expect(a.appendFrontAtSendMs).toBe(12_000);
    expect(a.firstFrameSeen).toBe(false);
    // A skipped attempt takes a number too, so every record of a session is unique.
    expect(t.allocateSeq()).toBe(3);
  });

  it('draws numbers from a shared allocator when given one (one sequence per page session)', () => {
    let n = 0;
    const next = () => ++n;
    const t1 = new SeamTracker(next);
    const t2 = new SeamTracker(next);
    expect(send(t1, 'a', 'b').seq).toBe(1);
    expect(send(t2, 'a', 'b').seq).toBe(2);
  });

  it('reports the unpresented seam as superseded when a newer switch lands', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    land(t, a, 5, 1100);
    t.appended({ ptsMs: 12_000, endPtsMs: 12_040, group: 5, object: 0, now: 1101 });
    expect(t.seam).toBe(a);

    const b = send(t, 'mid', 'high', 1500);
    const { superseded } = land(t, b, 6, 1600);
    expect(superseded).toEqual([a]);
    expect(a.supersededBy).toBe(b.seq);
    // One terminal record per switch: the superseded seam is gone, only b is pending.
    expect(t.seam).toBeNull();
    expect(t.pending).toBe(b);
  });

  it('also supersedes a landing that never reached an append', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    t.landed(a, { group: 5, object: 1, landedOnKeyframe: false, sourceEndMs: 12_000, now: 1100 });
    const b = send(t, 'mid', 'high', 1500);
    const { superseded } = land(t, b, 6, 1600);
    expect(superseded).toEqual([a]);
    expect(a.supersededBy).toBe(2);
  });

  it('supersedes nothing once the seam has been presented', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    land(t, a, 5, 1100);
    t.appended({ ptsMs: 12_000, endPtsMs: 12_040, group: 5, object: 0, now: 1101 });
    expect(t.presented({ mediaMs: 12_000, frameMs: 40, now: 3000 })).toBe(a);
    expect(a.firstFrameSeen).toBe(true);
    expect(t.pending).toBeNull();

    const b = send(t, 'mid', 'high', 3500);
    const { superseded } = land(t, b, 7, 3600);
    expect(superseded).toEqual([]);
  });

  it('keeps landing, seam pts, target append front and first-frame state on the record', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    land(t, a, 5, 1100);
    expect(a.landingGroup).toBe(5);
    expect(a.landingObject).toBe(0);
    expect(a.landedOnKeyframe).toBe(true);
    expect(a.sourceEndAtLandingMs).toBe(12_000);
    expect(t.appended({ ptsMs: 12_000, endPtsMs: 12_040, group: 5, object: 0, now: 1101 })).toBe(a);
    // Only the first append applies the switch; later ones move the front.
    expect(t.appended({ ptsMs: 12_040, endPtsMs: 12_080, group: 5, object: 1, now: 1102 })).toBe(
      null,
    );
    expect(a.seamPtsMs).toBe(12_000);
    expect(a.targetAppendFrontMs).toBe(12_080);
    expect(a.firstFrameSeen).toBe(false);
  });
});
