import { describe, it, expect } from 'vitest';
import { SeamTracker, seamBehindPlayhead, switchAppliedFields } from './seam';

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

describe('SeamTracker: the seam is the first appended target object (M9)', () => {
  // Native SWITCH lands on object 1 of a group: the landing object and the rest
  // of its group are discarded by the keyframe gate, and the first frame that
  // reaches the buffer is object 0 of the next group, one GOP later.
  const nativeLanding = () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    t.landed(a, { group: 5, object: 1, landedOnKeyframe: false, sourceEndMs: 12_000, now: 1100 });
    for (let i = 0; i < 24; i++) t.discarded();
    return { t, a };
  };

  it('counts target objects dropped between the landing and the first append', () => {
    const { t, a } = nativeLanding();
    expect(t.seam).toBeNull();
    expect(t.appended({ ptsMs: 13_000, endPtsMs: 13_040, group: 6, object: 0, now: 1600 })).toBe(a);
    expect(a.discardedBeforeKeyframe).toBe(24);
    expect(a.landingObject).toBe(1);
    expect(a.firstAppendedGroup).toBe(6);
    expect(a.firstAppendedObject).toBe(0);
    expect(a.seamPtsMs).toBe(13_000);
    // Once applied, later drops are not part of this landing.
    t.discarded();
    expect(a.discardedBeforeKeyframe).toBe(24);
  });

  it('builds SWITCH_APPLIED from the first appended object, keeping the landing fields', () => {
    const { t, a } = nativeLanding();
    t.appended({ ptsMs: 13_000, endPtsMs: 13_040, group: 6, object: 0, now: 1600 });
    expect(switchAppliedFields(a, { now: 1600, playheadMs: 10_500 })).toEqual({
      switch_seq: 1,
      from: 'low',
      to: 'mid',
      group: 5,
      object: 1,
      landing_object: 1,
      first_appended_group: 6,
      first_appended_object: 0,
      discarded_before_keyframe: 24,
      landed_on_group_start: false,
      landed_on_keyframe: false,
      new_start_pts_ms: 13_000,
      old_end_pts_ms: 12_000,
      old_end_pts_at_send_ms: 12_000,
      // The real hole: one GOP, not the ~0 the landing object's PTS would give.
      media_seam_gap_ms: 1000,
      playhead_ms: 10_000,
      playhead_at_apply_ms: 10_500,
      seam_ahead_of_playhead_ms: 3000,
      since_sent_ms: 600,
      since_landed_ms: 500,
    });
  });
});

describe('SeamTracker: first frame only for a presented target frame (M10)', () => {
  const landAt = (t: SeamTracker, playheadMs: number) => {
    const a = t.sent('low', 'mid', { playheadMs, appendFrontMs: 12_000, sentAt: 1000 });
    t.landed(a, { group: 9, object: 0, landedOnKeyframe: true, sourceEndMs: 12_000, now: 1100 });
    return a;
  };

  it('ignores source frames when the target lands behind the playhead', () => {
    // A playhead-floor switch re-fetches from the group the viewer is in: the
    // seam (9.0 s) is behind the playhead (10.0 s) and the next presented frame
    // is still a source frame until the target's append front passes it.
    const t = new SeamTracker();
    const a = landAt(t, 10_000);
    t.appended({ ptsMs: 9_000, endPtsMs: 9_040, group: 9, object: 0, now: 1200 });
    t.appended({ ptsMs: 9_960, endPtsMs: 10_000, group: 9, object: 24, now: 1300 });
    expect(t.presented({ mediaMs: 10_000, frameMs: 40, now: 1310 })).toBeNull();
    expect(t.presented({ mediaMs: 10_040, frameMs: 40, now: 1350 })).toBeNull();
    t.appended({ ptsMs: 10_000, endPtsMs: 10_120, group: 10, object: 0, now: 1360 });
    expect(t.presented({ mediaMs: 10_080, frameMs: 40, now: 1390 })).toBe(a);
    expect(seamBehindPlayhead(a)).toBe(true);
  });

  it('ignores a frame presented before the target media at its time was appended', () => {
    const t = new SeamTracker();
    const a = landAt(t, 10_000);
    t.appended({ ptsMs: 12_000, endPtsMs: 12_040, group: 9, object: 0, now: 2000 });
    t.appended({ ptsMs: 12_040, endPtsMs: 12_080, group: 9, object: 1, now: 2100 });
    // Presented at 2050: only [12000, 12040) was in the buffer then.
    expect(t.presented({ mediaMs: 12_040, frameMs: 40, now: 2050 })).toBeNull();
    expect(t.presented({ mediaMs: 12_040, frameMs: 40, now: 2110 })).toBe(a);
    expect(seamBehindPlayhead(a)).toBe(false);
  });

  it('accepts the seam frame itself within half a frame', () => {
    const t = new SeamTracker();
    const a = landAt(t, 10_000);
    t.appended({ ptsMs: 12_000, endPtsMs: 12_040, group: 9, object: 0, now: 2000 });
    expect(t.presented({ mediaMs: 11_970, frameMs: 40, now: 2010 })).toBeNull();
    expect(t.presented({ mediaMs: 11_985, frameMs: 40, now: 2010 })).toBe(a);
  });
});

describe('SeamTracker: presented track from (seam, track) transitions (M13)', () => {
  const apply = (t: SeamTracker, from: string, to: string, seamMs: number) => {
    const r = t.sent(from, to, { playheadMs: 0, appendFrontMs: 0, sentAt: 0 });
    t.landed(r, { group: 0, object: 0, landedOnKeyframe: true, sourceEndMs: 0, now: 0 });
    t.appended({ ptsMs: seamMs, endPtsMs: seamMs + 40, group: 0, object: 0, now: 0 });
    return r;
  };

  it('is the startup track until the playhead reaches the first seam', () => {
    const t = new SeamTracker();
    expect(t.presentedTrack(5_000)).toBeNull();
    t.setInitialTrack('low');
    apply(t, 'low', 'mid', 20_000);
    expect(t.presentedTrack(5_000)).toBe('low');
    expect(t.presentedTrack(19_990)).toBe('low');
    expect(t.presentedTrack(20_000)).toBe('mid');
  });

  it('keeps a superseded seam that is still in the buffer ahead of a later one', () => {
    const t = new SeamTracker();
    t.setInitialTrack('low');
    apply(t, 'low', 'mid', 20_000);
    apply(t, 'mid', 'high', 21_000); // supersedes the first, whose media 20-21 s stays
    expect(t.presentedTrack(20_500)).toBe('mid');
    expect(t.presentedTrack(21_500)).toBe('high');
  });

  it('drops transitions the new target overwrote (a seam behind an earlier one)', () => {
    const t = new SeamTracker();
    t.setInitialTrack('low');
    apply(t, 'low', 'mid', 20_000);
    apply(t, 'mid', 'high', 18_000); // re-fetched from earlier: replaces 18 s onward
    expect(t.presentedTrack(17_000)).toBe('low');
    expect(t.presentedTrack(20_500)).toBe('high');
  });
});

describe('SeamTracker: a switch replaced before it landed (C1, W1 preflight)', () => {
  it('supersedes an armed switch that a later SWITCH_OK replaces before it landed', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    expect(t.armed(a).superseded).toEqual([]);
    const b = send(t, 'low', 'high', 1500);
    expect(t.armed(b).superseded).toEqual([a]);
    expect(a.supersededBy).toBe(b.seq);
    // b lands: nothing else to supersede, a is not superseded twice.
    expect(land(t, b, 6, 1600).superseded).toEqual([]);
  });

  it('does not supersede an armed switch once it has landed', () => {
    const t = new SeamTracker();
    const a = send(t, 'low', 'mid');
    t.armed(a);
    land(t, a, 5, 1100);
    const b = send(t, 'mid', 'high', 1500);
    expect(t.armed(b).superseded).toEqual([]);
    // a's seam is overwritten when b lands, not when b is armed.
    expect(land(t, b, 6, 1600).superseded).toEqual([a]);
  });
});

describe('SeamTracker: the seam region the playhead is in (F2)', () => {
  it('starts at the hole in front of the seam and names the latest seam the playhead has reached', () => {
    const t = new SeamTracker();
    t.setInitialTrack('low');
    expect(t.seamRegionAt(5_000, 33)).toBeNull(); // no switch yet
    const a = send(t, 'low', 'mid');
    // Source append front at landing 12 000; the target begins at 12 500: a 500 ms hole.
    land(t, a, 5, 1100);
    t.appended({ ptsMs: 12_500, endPtsMs: 12_533, group: 5, object: 0, now: 1101 });
    expect(t.seamRegionAt(11_000, 33)).toBeNull(); // still on the source, before the hole
    expect(t.seamRegionAt(11_980, 33)).toBe(12_500); // a frame before the hole
    expect(t.seamRegionAt(12_200, 33)).toBe(12_500); // in the hole
    expect(t.seamRegionAt(30_000, 33)).toBe(12_500); // long past: the caller judges the distance
  });

  it('an overlapping seam (target restarts inside source media) starts its region at the seam', () => {
    const t = new SeamTracker();
    t.setInitialTrack('low');
    const a = send(t, 'low', 'mid');
    land(t, a, 5, 1100); // source front 12 000
    t.appended({ ptsMs: 11_000, endPtsMs: 11_033, group: 5, object: 0, now: 1101 });
    expect(t.seamRegionAt(10_900, 33)).toBeNull();
    expect(t.seamRegionAt(11_000, 33)).toBe(11_000);
  });

  it('with two seams ahead (time-shifted client) the playhead is anchored to the one it reaches', () => {
    const t = new SeamTracker();
    t.setInitialTrack('low');
    const a = send(t, 'low', 'mid');
    land(t, a, 5, 1100);
    t.appended({ ptsMs: 12_000, endPtsMs: 12_033, group: 5, object: 0, now: 1101 });
    t.presented({ mediaMs: 12_000, frameMs: 33, now: 1200 });
    const b = t.sent('mid', 'high', { playheadMs: 3_000, appendFrontMs: 16_000, sentAt: 1300 });
    t.landed(b, { group: 9, object: 0, landedOnKeyframe: true, sourceEndMs: 16_000, now: 1400 });
    t.appended({ ptsMs: 16_000, endPtsMs: 16_033, group: 9, object: 0, now: 1401 });
    expect(t.seamRegionAt(12_010, 33)).toBe(12_000);
    expect(t.seamRegionAt(16_010, 33)).toBe(16_000);
  });
});
