/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * One record per track switch, from SWITCH_SENT to its terminal record (C1).
 *
 * The player used to keep one set of loose "post-switch" fields per stream and
 * overwrite them on every landing, so a first-frame record could not say which
 * switch it belonged to and the analyzer gave it to every earlier switch with
 * the same target. Every event of a switch now carries the record's `seq`
 * (`switch_seq`), and a seam that is overwritten before it was presented is
 * reported as superseded instead of silently lost.
 *
 * Mechanism-neutral: it sees only what the player sees (send, landing, appends,
 * presented frames).
 */
export interface SwitchRecord {
  /** Per-session switch number, from 1 (`switch_seq`). */
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  /** performance.now() at SWITCH_SENT. */
  readonly sentAt: number;
  /** Playhead (ms) when the switch was decided and sent. */
  readonly playheadAtSendMs: number | undefined;
  /** End PTS (ms) of the last appended frame when the switch was sent. */
  readonly appendFrontAtSendMs: number | undefined;

  // Landing: the first object of the target routed to the player.
  landedAt?: number;
  landingGroup?: number;
  landingObject?: number;
  /** Sync flag of the landing object's moof; null when the moof carries no flags. */
  landedOnKeyframe?: boolean | null;
  /** Source append front at landing (the old track's last appended frame end). */
  sourceEndAtLandingMs?: number;

  // Applied: the first target object actually appended.
  appliedAt?: number;
  /** PTS (ms) of the first appended target frame: where the new representation begins. */
  seamPtsMs?: number;
  firstAppendedGroup?: number;
  firstAppendedObject?: number;
  /** Target objects dropped (pre-keyframe, init pending) between the landing and the first append. */
  discardedBeforeKeyframe: number;
  /** End PTS (ms) of the last appended target frame. */
  targetAppendFrontMs?: number;

  firstFrameSeen: boolean;
  /** `seq` of the switch whose landing overwrote this one's pending seam. */
  supersededBy?: number;
}

/** Monotonic switch numbers for the whole page (one EventLog session). */
let pageSwitchSeq = 0;
export const nextPageSwitchSeq = (): number => ++pageSwitchSeq;

export class SeamTracker {
  readonly #allocate: () => number;
  /** The switch accepted by the relay (SWITCH_OK) that has not landed yet. */
  #armed: SwitchRecord | null = null;
  /** The landed switch whose first frame has not been presented yet. */
  #pending: SwitchRecord | null = null;
  /**
   * The pending switch's target append front over time: (performance.now() of
   * the append, end PTS after it). Lets a presented frame be checked against
   * what was in the buffer when it was presented, not when the callback ran.
   */
  #fronts: Array<{ at: number; frontMs: number }> = [];
  /**
   * Which track's media begins where in the buffer (M13): the startup track
   * from -infinity, then one entry per applied switch at its seam. Appending a
   * target from its seam onward replaces everything buffered after it, so a
   * new seam drops every transition at or after it.
   */
  #transitions: Array<{
    seamMs: number;
    track: string;
    regionFromMs: number;
    /** The switch that applied this seam (absent for the startup track). */
    rec?: SwitchRecord;
  }> = [];

  /**
   * @param allocateSeq - Source of switch numbers. The player passes the
   *   page-wide allocator so a reconnect within one page never reuses a number;
   *   the default numbers per tracker (tests).
   */
  constructor(allocateSeq?: () => number) {
    let n = 0;
    this.#allocate = allocateSeq ?? (() => ++n);
  }

  /** The track playback starts on (before any switch). Only the first call counts. */
  setInitialTrack(track: string): void {
    if (this.#transitions.length === 0) {
      this.#transitions.push({ seamMs: -Infinity, track, regionFromMs: -Infinity });
    }
  }

  /**
   * The track whose media sits at `playheadMs` in the buffer, i.e. the track
   * being presented (M13); null before the initial track is known.
   *
   * A switch whose first frame has not been seen yet covers only
   * [seam, target append front]: the target has delivered nothing beyond its
   * front, so media after it (e.g. at the playhead, when the seam landed
   * behind it) is still the previous track's (F8). Once its first frame is
   * seen it covers everything up to the next seam.
   */
  presentedTrack(playheadMs: number): string | null {
    let track: string | null = null;
    for (const t of this.#transitions) {
      if (t.seamMs > playheadMs) break;
      if (t.rec !== undefined && !t.rec.firstFrameSeen) {
        if (playheadMs > (t.rec.targetAppendFrontMs ?? t.seamMs)) continue;
      }
      track = t.track;
    }
    return track;
  }

  /**
   * PTS (ms) of the latest applied seam whose region the playhead has entered,
   * or null when it has entered none (F2). A seam's region begins at the hole
   * in front of it: the source's append front at landing when that lies before
   * the seam (a hole), else the seam itself (the target restarts inside source
   * media). `toleranceMs` (one frame) admits a playhead that stopped a frame
   * short of the hole. The caller judges how far past the seam the playhead
   * is; this only says which seam it is anchored to, so the same hole anchors
   * the same way whether it reaches the playhead one group after the landing
   * (live edge) or one shift later (time-shifted).
   */
  seamRegionAt(playheadMs: number, toleranceMs: number): number | null {
    let seam: number | null = null;
    for (const t of this.#transitions) {
      if (t.seamMs === -Infinity) continue;
      if (t.regionFromMs - toleranceMs <= playheadMs) seam = t.seamMs;
    }
    return seam;
  }

  /** A number for a switch attempt that is not sent (SWITCH_SKIPPED). */
  allocateSeq(): number {
    return this.#allocate();
  }

  sent(
    from: string,
    to: string,
    at: { playheadMs: number | undefined; appendFrontMs: number | undefined; sentAt: number },
  ): SwitchRecord {
    return {
      seq: this.#allocate(),
      from,
      to,
      sentAt: at.sentAt,
      playheadAtSendMs: at.playheadMs,
      appendFrontAtSendMs: at.appendFrontMs,
      discardedBeforeKeyframe: 0,
      firstFrameSeen: false,
    };
  }

  /**
   * The relay accepted `rec` (SWITCH_OK) and the player now waits for it to
   * land. A previously accepted switch that has not landed is replaced and
   * therefore superseded: it can never land any more.
   */
  armed(rec: SwitchRecord): { superseded: SwitchRecord[] } {
    const superseded: SwitchRecord[] = [];
    const prev = this.#armed;
    if (prev !== null && prev !== rec && prev.landedAt === undefined) {
      prev.supersededBy = rec.seq;
      superseded.push(prev);
    }
    this.#armed = rec;
    return { superseded };
  }

  /**
   * The target's first object reached the player. A previous landing whose
   * seam was not presented yet is superseded: its pending seam is overwritten.
   */
  landed(
    rec: SwitchRecord,
    at: {
      group: number;
      object: number;
      landedOnKeyframe: boolean | null;
      sourceEndMs: number | undefined;
      now: number;
    },
  ): { superseded: SwitchRecord[] } {
    const superseded: SwitchRecord[] = [];
    const prev = this.#pending;
    if (prev !== null && prev !== rec && !prev.firstFrameSeen) {
      prev.supersededBy = rec.seq;
      superseded.push(prev);
    }
    rec.landedAt = at.now;
    rec.landingGroup = at.group;
    rec.landingObject = at.object;
    rec.landedOnKeyframe = at.landedOnKeyframe;
    rec.sourceEndAtLandingMs = at.sourceEndMs;
    if (this.#armed === rec) this.#armed = null;
    this.#pending = rec;
    this.#fronts = [];
    return { superseded };
  }

  /** The landed switch awaiting its first presented frame, if any. */
  get pending(): SwitchRecord | null {
    return this.#pending;
  }

  /** The pending switch once its seam is known (a target frame was appended). */
  get seam(): SwitchRecord | null {
    return this.#pending !== null && this.#pending.seamPtsMs !== undefined ? this.#pending : null;
  }

  /** A target object of the pending switch was dropped before anything was appended. */
  discarded(): void {
    const rec = this.#pending;
    if (rec !== null && rec.seamPtsMs === undefined) rec.discardedBeforeKeyframe += 1;
  }

  /**
   * A target frame [ptsMs, endPtsMs) was appended. The first one applies the
   * pending switch (returned); later ones only move its target append front.
   *
   * `now` is when the append completed (updateend's continuation);
   * `appendStartedAt` when appendBuffer was called. The front history is dated
   * at the call (F9): the element can present the frame between the call and
   * the continuation, and the rVFC callback that reports it runs after the
   * continuation with an earlier presentationTime, which must not be read as
   * "before the frame was in the buffer" (that credited the first frame one
   * frame late).
   */
  appended(at: {
    ptsMs: number;
    endPtsMs: number;
    group: number;
    object: number;
    now: number;
    appendStartedAt?: number;
  }): SwitchRecord | null {
    const rec = this.#pending;
    if (rec === null) return null;
    rec.targetAppendFrontMs = Math.max(rec.targetAppendFrontMs ?? -Infinity, at.endPtsMs);
    // Keep the history ordered by time even if call times interleave.
    const dated = Math.max(
      at.appendStartedAt ?? at.now,
      this.#fronts.length > 0 ? this.#fronts[this.#fronts.length - 1]!.at : -Infinity,
    );
    this.#fronts.push({ at: dated, frontMs: rec.targetAppendFrontMs });
    // Presentation times are recent; a seam that stays pending for long only
    // needs the newest part of the history (the oldest kept entry is the base).
    if (this.#fronts.length > 1024) this.#fronts.splice(0, 512);
    if (rec.seamPtsMs !== undefined) return null;
    rec.appliedAt = at.now;
    rec.seamPtsMs = at.ptsMs;
    rec.firstAppendedGroup = at.group;
    rec.firstAppendedObject = at.object;
    this.#transitions = this.#transitions.filter(t => t.seamMs < at.ptsMs);
    this.#transitions.push({
      seamMs: at.ptsMs,
      track: rec.to,
      regionFromMs: Math.min(at.ptsMs, rec.sourceEndAtLandingMs ?? at.ptsMs),
      rec,
    });
    return rec;
  }

  /**
   * A frame with media time `mediaMs` was presented at `now` (performance
   * clock). Returns the pending switch when this is its first frame, which
   * completes the switch (M10).
   *
   * The frame counts only if it is target media: `mediaMs` lies in
   * [seam, target append front] as the front stood at `now`, with half a frame
   * of tolerance for the element's rounding. A seam that lands at or behind the
   * playhead therefore does not make the next presented source frame the
   * "first frame"; the switch waits until the playhead reaches media the
   * target actually delivered.
   */
  presented(at: { mediaMs: number; frameMs: number; now: number }): SwitchRecord | null {
    const rec = this.seam;
    if (rec === null || rec.seamPtsMs === undefined) return null;
    const half = at.frameMs / 2;
    if (at.mediaMs < rec.seamPtsMs - half) return null;
    const front = this.#frontAt(at.now);
    if (front === undefined || at.mediaMs > front - half) return null;
    rec.firstFrameSeen = true;
    this.#pending = null;
    this.#fronts = [];
    return rec;
  }

  /** The pending switch's target append front as it stood at `t`. */
  #frontAt(t: number): number | undefined {
    let front: number | undefined;
    for (const f of this.#fronts) {
      if (f.at > t) break;
      front = f.frontMs;
    }
    return front;
  }
}

/**
 * SWITCH_APPLIED for a record that has just been applied (M9): the switch's
 * first appended target object, which is where the new representation really
 * begins in the buffer. The landing object (SWITCH_FIRST_OBJECT) can be
 * dropped by the keyframe gate, in which case the seam is up to one GOP later
 * than the landing object's PTS. `group`/`object` stay the landing object's,
 * as before.
 */
export function switchAppliedFields(
  rec: SwitchRecord,
  at: { now: number; playheadMs: number | undefined },
): Record<string, unknown> {
  const seam = rec.seamPtsMs;
  return {
    switch_seq: rec.seq,
    from: rec.from,
    to: rec.to,
    group: rec.landingGroup ?? null,
    object: rec.landingObject ?? null,
    landing_object: rec.landingObject ?? null,
    first_appended_group: rec.firstAppendedGroup ?? null,
    first_appended_object: rec.firstAppendedObject ?? null,
    discarded_before_keyframe: rec.discardedBeforeKeyframe,
    // Object 0 of a group is where a keyframe is expected ...
    landed_on_group_start: rec.landingObject === 0,
    // ... and this is whether the landing object actually is one (trun
    // sync-sample flag of its moof; null when the moof carries no flags).
    landed_on_keyframe: rec.landedOnKeyframe ?? null,
    new_start_pts_ms: seam ?? null,
    // Source append front at landing, and at send (the latter predates the
    // source frames that arrived while the SWITCH was in flight).
    old_end_pts_ms: rec.sourceEndAtLandingMs ?? null,
    old_end_pts_at_send_ms: rec.appendFrontAtSendMs ?? null,
    // Seam continuity of the appended media: first appended target frame PTS
    // minus the source's append front at landing (0 = contiguous, >0 = hole,
    // <0 = overlap: the target restarts inside media the source covered).
    media_seam_gap_ms:
      seam !== undefined && rec.sourceEndAtLandingMs !== undefined
        ? seam - rec.sourceEndAtLandingMs
        : null,
    playhead_ms: rec.playheadAtSendMs ?? null,
    playhead_at_apply_ms: at.playheadMs ?? null,
    // How far ahead of the viewer (playhead at send) the new representation
    // begins: the media still played before it. Negative = seam behind the
    // playhead.
    seam_ahead_of_playhead_ms:
      seam !== undefined && rec.playheadAtSendMs !== undefined ? seam - rec.playheadAtSendMs : null,
    since_sent_ms: at.now - rec.sentAt,
    since_landed_ms: rec.landedAt !== undefined ? at.now - rec.landedAt : null,
  };
}

/** True when the switch's seam lies behind the playhead it was sent at (M10). */
export function seamBehindPlayhead(rec: SwitchRecord): boolean | null {
  if (rec.seamPtsMs === undefined || rec.playheadAtSendMs === undefined) return null;
  return rec.seamPtsMs - rec.playheadAtSendMs < 0;
}
