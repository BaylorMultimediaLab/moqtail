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
 * Bandwidth tracker — Sliding Window Moving Average (SWMA) over per-group
 * throughput, as proposed for MoQ at IETF 119 (slides-119-moq-bandwidth-
 * measurement-for-quic) and validated by Kuo, KTH MSc 2025
 * "Evaluating Media over QUIC for Low-Latency Adaptive Streaming".
 *
 * Why SWMA on a single group rather than a continuous EWMA over a
 * `bytesReceived` poll window:
 *
 *   The publisher (`apps/publisher/src/sender.rs::send_group`) bursts all
 *   N objects of a GOP onto the QUIC stream back-to-back, then idles
 *   between groups while the next GOP is encoded. A continuous EWMA
 *   averages those idle gaps into the throughput estimate, so its reading
 *   converges on the *source bitrate* — useless for detecting headroom
 *   when the link is fatter than the active track. SWMA on a single
 *   group's burst (objects 2..N divided by t_N − t_1) reads the link's
 *   actual delivery rate during that burst — the closest analog to
 *   dash.js's segment-download-rate that MoQ allows without QUIC-packet
 *   visibility.
 *
 *   The IETF slides describe SWMA on intra-frame fragments; in this
 *   codebase one frame = one MoQ object so the same idea applies one
 *   level up at the GOP/group boundary.
 *
 * The first object in a group only sets t_1 — its bytes are excluded from
 * the numerator so a small init-segment-style first object can't bias the
 * estimate.
 *
 * Timing and grouping (M11):
 * - t_1 and t_N are the library's receive stamps (`MoqtObject.recvAt`, taken
 *   where the object is parsed off the wire), not the time the player gets
 *   round to recording the object after its MSE append. A group that arrives
 *   in one burst is timed by the link, not by the append path.
 * - One accumulator per (track, group). Objects of two groups can interleave
 *   (a catch-up beside live delivery, the old track's last group beside the
 *   new track's first), and a single "current group" finalised by the next
 *   group id mis-times both. A group is finalised by its last object
 *   (`lastInGroup`), by a later group of its track once it has gone quiet, or
 *   after two group times without an object. Callers that cannot tell the
 *   last object get the old behaviour: a later group of the track finalises it.
 * - Objects the player drops still crossed the link: they count in the sample
 *   and are reported as `discardedBytes` as well.
 * - One sample per (track, group) (F5). A group can be delivered twice (a
 *   catch-up redelivery on a second stream) or resume after the quiet rule
 *   closed it (a catch-up stream stalled while live objects of the track
 *   arrived). The keys of recently sampled groups are kept (bounded); a late
 *   object of such a group is folded into that group's accounting (cumulative
 *   bytes, `getLateObjects`) without opening a new accumulator, so it neither
 *   produces a second sample nor a second `samplesByTrack` count (which would
 *   pass the dwell early and over-weight the catch-up in the SWMA).
 */

/** One finalised per-group throughput sample. */
export interface GroupSample {
  /** Track the group belonged to. */
  track: string;
  group: bigint;
  /** Bytes of objects 2..N (the timed span). */
  bytes: number;
  /** recvAt(last) − recvAt(first), ms. */
  durationMs: number;
  bps: number;
  /**
   * Bytes of this group dropped by the player (objects that were received,
   * hence also in `bytes`/`objects` when timed), plus bytes of this (track,
   * group) the library discarded (unrouted streams) while this group's
   * accumulator was open.
   */
  discardedBytes: number;
  /**
   * Library-discarded (unrouted) bytes that no open group could take: the
   * group had already produced its sample, never reached the player, or the
   * library no longer knew its track; and those that an open group took but
   * that group then closed without a sample (one object, or no time span). Accumulated over the whole stream
   * (any track, any group) since the previous sample and reported once, with
   * the next sample of this stream (F6). They never enter the timed span.
   */
  unroutedBytes: number;
  objects: number;
}

export interface RecordObjectOptions {
  /** Receive stamp (performance.now() clock); defaults to now. */
  recvAt?: number;
  /** Track of the object; groups are kept apart per track. */
  track?: string;
  /** Whether this is the last object of its group; undefined when unknown. */
  lastInGroup?: boolean;
  /** The player dropped this object (it still crossed the link). */
  discarded?: boolean;
}

interface OpenGroup {
  track: string;
  group: bigint;
  bytes: number;
  firstObjBytes: number;
  firstTs: number;
  lastTs: number;
  objects: number;
  discardedBytes: number;
  /**
   * The library-discarded part of `discardedBytes` (recordDiscardedBytes).
   * If the group closes without a sample they move to the stream's pending
   * unrouted bytes, so they still reach a sample (R4-D4).
   */
  libraryDiscardedBytes: number;
  /** The caller tells this group's last object (lastInGroup is defined). */
  hinted: boolean;
}

/** Sampled (track, group) keys remembered so late objects do not sample a group twice (F5). */
const CLOSED_KEYS_MAX = 256;

/** A later group of the track finalises a hinted group once it has been quiet this long (ms) ... */
const QUIET_MIN_MS = 50;
/** ... or this many of its own mean inter-arrival times, whichever is longer. */
const QUIET_SPACINGS = 4;

export class GoodputTracker {
  // SWMA window of per-group throughput samples (bps). Default size 5 ≈ 5s.
  #swma: number[] = [];
  readonly #swmaWindowSize = 5;

  // Open groups keyed by `${track}\u0000${group}`.
  #open = new Map<string, OpenGroup>();
  // Groups that have produced their sample, oldest first (bounded): late
  // objects and bytes folded into them (F5).
  #closed = new Map<string, { objects: number; bytes: number }>();
  #lateObjects = 0;
  // Unrouted bytes with no open group to take them, until the next sample (F6).
  #unroutedPending = 0;
  // Highest group id received per track (F10).
  #maxGroup = new Map<string, bigint>();
  /** A group with no object for this long is finalised whatever else happens (ms). */
  #abandonMs: number;

  // Diagnostics
  #lastObjectBytes = 0;
  #lastGroupDurationMs = 0;
  #lastGroupBps = 0;
  #lastGroupBytes = 0;
  #sampleCount = 0;
  // Closed samples per track (the sample's own track).
  #samplesByTrack: Record<string, number> = {};
  // Monotonic counter of all bytes ever recorded (dropped objects included:
  // they shared the link). Used by the active probe (Kuo Algorithm 1) to
  // compute v = video-track bytes received during the probe window.
  #cumulativeBytes = 0;

  // Time-weighted EMAs over per-group throughput samples. dash.js half-life
  // defaults are 3s/8s; with one sample per group (~1s) those still smooth
  // the signal but with the same asymmetry (Math.min picks the slower of
  // the two, so spikes can't trigger an upswitch on their own).
  #emaFast = 0;
  #emaSlow = 0;
  #halfLifeFastSec: number;
  #halfLifeSlowSec: number;
  #hasEmaData = false;

  constructor(halfLifeFastSec = 3, halfLifeSlowSec = 8, groupDurationMs = 1000) {
    this.#halfLifeFastSec = halfLifeFastSec;
    this.#halfLifeSlowSec = halfLifeSlowSec;
    this.#abandonMs = 2 * groupDurationMs;
  }

  /**
   * Record one MoQ object. Returns the group samples this call finalised
   * (usually none or one), oldest first.
   */
  recordObject(bytes: number, groupId: bigint, opts: RecordObjectOptions = {}): GroupSample[] {
    const now = opts.recvAt ?? performance.now();
    const track = opts.track ?? '';
    this.#lastObjectBytes = bytes;
    this.#cumulativeBytes += bytes;
    const seen = this.#maxGroup.get(track);
    if (seen === undefined || groupId > seen) this.#maxGroup.set(track, groupId);
    const out: GroupSample[] = [];

    // Groups of this track that a later group has overtaken, and groups
    // nobody has added to for a long time.
    for (const [key, g] of this.#open) {
      const idle = now - g.lastTs;
      let close = idle >= this.#abandonMs;
      if (!close && g.track === track && g.group < groupId) {
        if (!g.hinted) close = true;
        else {
          const spacing = g.objects > 1 ? (g.lastTs - g.firstTs) / (g.objects - 1) : 0;
          close = idle >= Math.max(QUIET_MIN_MS, QUIET_SPACINGS * spacing);
        }
      }
      if (close) {
        this.#open.delete(key);
        const sample = this.#finalize(g);
        if (sample) out.push(sample);
      }
    }

    const key = `${track}\u0000${groupId}`;
    const closed = this.#closed.get(key);
    if (closed !== undefined) {
      // A late object of a group that already produced its sample (F5).
      closed.objects += 1;
      closed.bytes += bytes;
      this.#lateObjects += 1;
      return out;
    }
    let g = this.#open.get(key);
    if (g === undefined) {
      g = {
        track,
        group: groupId,
        bytes: 0,
        firstObjBytes: bytes,
        firstTs: now,
        lastTs: now,
        objects: 0,
        discardedBytes: 0,
        libraryDiscardedBytes: 0,
        hinted: false,
      };
      this.#open.set(key, g);
    }
    g.bytes += bytes;
    g.objects += 1;
    g.lastTs = Math.max(g.lastTs, now);
    if (opts.discarded) g.discardedBytes += bytes;
    if (opts.lastInGroup !== undefined) g.hinted = true;
    if (opts.lastInGroup) {
      this.#open.delete(key);
      const sample = this.#finalize(g);
      if (sample) out.push(sample);
    }
    return out;
  }

  /**
   * Bytes of `groupId` on `track` that the library discarded without
   * delivering them as objects (it cancelled a stream whose alias had no
   * route; `track` null when it no longer knew the alias). Never timed. If
   * that (track, group) is open they become its `discardedBytes`; otherwise
   * (already sampled, never routed, or unknown track) they are reported as
   * `unroutedBytes` with the next sample of this stream, whatever its track,
   * so every byte reaches exactly one THROUGHPUT_SAMPLE (F6). If the open
   * group later closes without a sample, they move to that pending counter.
   */
  recordDiscardedBytes(bytes: number, groupId: bigint, track: string | null): void {
    const g = track !== null ? this.#open.get(`${track}\u0000${groupId}`) : undefined;
    if (g !== undefined) {
      g.discardedBytes += bytes;
      g.libraryDiscardedBytes += bytes;
    } else this.#unroutedPending += bytes;
  }

  /** Conservative bandwidth: average of the SWMA window. 0 until first group completes. */
  getBandwidthBps(): number {
    if (this.#swma.length === 0) return 0;
    const sum = this.#swma.reduce((a, b) => a + b, 0);
    return sum / this.#swma.length;
  }

  getFastEmaBps(): number {
    return this.#emaFast;
  }

  getSlowEmaBps(): number {
    return this.#emaSlow;
  }

  getLastObjectBytes(): number {
    return this.#lastObjectBytes;
  }

  getLastDeliveryTimeMs(): number {
    return this.#lastGroupDurationMs;
  }

  getSampleCount(): number {
    return this.#sampleCount;
  }

  /** Closed group samples per track, keyed by the group's own track. */
  getSamplesByTrack(): Record<string, number> {
    return { ...this.#samplesByTrack };
  }

  /**
   * Highest group id of any object recorded for `track` (appended or
   * dropped), undefined before the first. Groups of one track arrive out of
   * order (a catch-up beside live delivery, a refetch), so the last recorded
   * group is not how far the client has received (F10).
   */
  getMaxGroup(track: string): bigint | undefined {
    return this.#maxGroup.get(track);
  }

  /** Objects that arrived for a group after its sample closed (folded in, not sampled again). */
  getLateObjects(): number {
    return this.#lateObjects;
  }

  /** Throughput (bps) of the most recently finalised group sample. */
  getLastSampleBps(): number {
    return this.#lastGroupBps;
  }

  /** Bytes counted in the most recently finalised group sample. */
  getLastSampleBytes(): number {
    return this.#lastGroupBytes;
  }

  /** Monotonic byte counter over all recorded objects. */
  getCumulativeBytes(): number {
    return this.#cumulativeBytes;
  }

  setHalfLives(halfLifeFastSec: number, halfLifeSlowSec: number): void {
    this.#halfLifeFastSec = halfLifeFastSec;
    this.#halfLifeSlowSec = halfLifeSlowSec;
  }

  /**
   * Seed both EMAs with a conservative startup estimate (bps) so the *first*
   * real per-group sample blends into this anchor (via the half-life weight)
   * rather than replacing it outright. Without a seed, #updateEma sets both
   * EMAs to the first sample — and that sample is the startup burst, which
   * over-reads the sustainable rate (the first GOP often arrives as a backlog
   * burst, and the link may not yet be at its steady rate). Anchoring to the
   * startup track's own bitrate gives a slow-start ramp: the ABR only believes
   * it has more headroom as sustained evidence accumulates.
   *
   * No-op once any EMA data exists (real samples take precedence).
   */
  seedEma(bps: number): void {
    if (this.#hasEmaData || bps <= 0) return;
    this.#emaFast = bps;
    this.#emaSlow = bps;
    this.#hasEmaData = true;
  }

  reset(): void {
    this.#swma = [];
    this.#open.clear();
    this.#closed.clear();
    this.#lateObjects = 0;
    this.#unroutedPending = 0;
    this.#maxGroup.clear();
    this.#lastObjectBytes = 0;
    this.#lastGroupDurationMs = 0;
    this.#lastGroupBps = 0;
    this.#lastGroupBytes = 0;
    this.#sampleCount = 0;
    this.#samplesByTrack = {};
    this.#emaFast = 0;
    this.#emaSlow = 0;
    this.#hasEmaData = false;
    this.#cumulativeBytes = 0;
  }

  #finalize(g: OpenGroup): GroupSample | null {
    // Exclude the first object's bytes from the numerator: it sets t_1 and
    // contributes no inter-arrival information. Matches the IETF slides.
    const dtMs = g.lastTs - g.firstTs;
    const bytes = g.bytes - g.firstObjBytes;
    if (g.objects < 2 || dtMs <= 0 || bytes <= 0) {
      // No sample (one object, or no time span): the library-discarded bytes
      // attached to this group go out with the next sample of the stream as
      // unrouted bytes instead of being lost with it (R4-D4).
      this.#unroutedPending += g.libraryDiscardedBytes;
      return null;
    }

    const dtSec = dtMs / 1000;
    const groupBps = (bytes * 8) / dtSec;

    this.#swma.push(groupBps);
    if (this.#swma.length > this.#swmaWindowSize) this.#swma.shift();

    this.#lastGroupDurationMs = dtMs;
    this.#lastGroupBps = groupBps;
    this.#lastGroupBytes = bytes;
    this.#sampleCount++;
    this.#samplesByTrack[g.track] = (this.#samplesByTrack[g.track] ?? 0) + 1;
    // Only a group that produced its sample is closed for good: one that
    // closed with no sample (a single object) may still produce one later.
    this.#closed.set(`${g.track}\u0000${g.group}`, { objects: 0, bytes: 0 });
    if (this.#closed.size > CLOSED_KEYS_MAX) {
      this.#closed.delete(this.#closed.keys().next().value!);
    }

    this.#updateEma(groupBps, dtMs);
    const unroutedBytes = this.#unroutedPending;
    this.#unroutedPending = 0;
    return {
      track: g.track,
      group: g.group,
      bytes,
      durationMs: dtMs,
      bps: groupBps,
      discardedBytes: g.discardedBytes,
      unroutedBytes,
      objects: g.objects,
    };
  }

  #updateEma(instantBps: number, weightMs: number): void {
    if (!this.#hasEmaData) {
      this.#emaFast = instantBps;
      this.#emaSlow = instantBps;
      this.#hasEmaData = true;
      return;
    }
    const weightSec = weightMs / 1000;
    const alphaFast = Math.pow(0.5, weightSec / this.#halfLifeFastSec);
    const alphaSlow = Math.pow(0.5, weightSec / this.#halfLifeSlowSec);
    this.#emaFast = (1 - alphaFast) * instantBps + alphaFast * this.#emaFast;
    this.#emaSlow = (1 - alphaSlow) * instantBps + alphaSlow * this.#emaSlow;
  }
}
