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
  /** Bytes of this group dropped by the player or the library (any object). */
  discardedBytes: number;
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
  /** The caller tells this group's last object (lastInGroup is defined). */
  hinted: boolean;
}

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
  /** A group with no object for this long is finalised whatever else happens (ms). */
  #abandonMs: number;

  // Diagnostics
  #lastObjectBytes = 0;
  #lastGroupDurationMs = 0;
  #lastGroupBps = 0;
  #lastGroupBytes = 0;
  #sampleCount = 0;
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
   * Bytes of `groupId` on `track` that were discarded without being delivered
   * as objects (the library cancelled an unrouted stream). Added to the
   * group's `discardedBytes` if that group is still open; not timed.
   */
  recordDiscardedBytes(bytes: number, groupId: bigint, track: string): void {
    const g = this.#open.get(`${track}\u0000${groupId}`);
    if (g !== undefined) g.discardedBytes += bytes;
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
    this.#lastObjectBytes = 0;
    this.#lastGroupDurationMs = 0;
    this.#lastGroupBps = 0;
    this.#lastGroupBytes = 0;
    this.#sampleCount = 0;
    this.#emaFast = 0;
    this.#emaSlow = 0;
    this.#hasEmaData = false;
    this.#cumulativeBytes = 0;
  }

  #finalize(g: OpenGroup): GroupSample | null {
    if (g.objects < 2) return null;
    const dtMs = g.lastTs - g.firstTs;
    if (dtMs <= 0) return null;

    // Exclude the first object's bytes from the numerator: it sets t_1 and
    // contributes no inter-arrival information. Matches the IETF slides.
    const bytes = g.bytes - g.firstObjBytes;
    if (bytes <= 0) return null;

    const dtSec = dtMs / 1000;
    const groupBps = (bytes * 8) / dtSec;

    this.#swma.push(groupBps);
    if (this.#swma.length > this.#swmaWindowSize) this.#swma.shift();

    this.#lastGroupDurationMs = dtMs;
    this.#lastGroupBps = groupBps;
    this.#lastGroupBytes = bytes;
    this.#sampleCount++;

    this.#updateEma(groupBps, dtMs);
    return {
      track: g.track,
      group: g.group,
      bytes,
      durationMs: dtMs,
      bps: groupBps,
      discardedBytes: g.discardedBytes,
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
