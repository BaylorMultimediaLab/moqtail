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
 */
export class GoodputTracker {
  // SWMA window of per-group throughput samples (bps). Default size 5 ≈ 5s.
  #swma: number[] = [];
  readonly #swmaWindowSize = 5;

  // Current-group accumulator. groupId is bigint to match MoqtObject.location.group.
  #currentGroupId: bigint | null = null;
  #currentGroupBytes = 0;
  #currentGroupFirstObjBytes = 0;
  #currentGroupFirstTs = 0;
  #currentGroupLastTs = 0;
  #currentGroupObjectCount = 0;

  // Diagnostics
  #lastObjectBytes = 0;
  #lastGroupDurationMs = 0;
  #sampleCount = 0;
  // Monotonic counter of all bytes ever recorded. Used by the active
  // probe (Kuo Algorithm 1) to compute v = video-track bytes received
  // during the probe window — snapshot at probe start, snapshot at probe
  // end, subtract.
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

  constructor(halfLifeFastSec = 3, halfLifeSlowSec = 8) {
    this.#halfLifeFastSec = halfLifeFastSec;
    this.#halfLifeSlowSec = halfLifeSlowSec;
  }

  /**
   * Record one MoQ object delivery. When `groupId` rolls over from the
   * previous call, the previous group's accumulator is finalized into a
   * single SWMA sample.
   */
  recordObject(bytes: number, groupId: bigint): void {
    const now = Date.now();
    this.#lastObjectBytes = bytes;
    this.#cumulativeBytes += bytes;

    if (this.#currentGroupId === null || groupId !== this.#currentGroupId) {
      this.#finalizeCurrentGroup();
      this.#currentGroupId = groupId;
      this.#currentGroupBytes = bytes;
      this.#currentGroupFirstObjBytes = bytes;
      this.#currentGroupFirstTs = now;
      this.#currentGroupLastTs = now;
      this.#currentGroupObjectCount = 1;
      return;
    }

    this.#currentGroupBytes += bytes;
    this.#currentGroupLastTs = now;
    this.#currentGroupObjectCount++;
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

  /** Monotonic byte counter over all recorded objects. */
  getCumulativeBytes(): number {
    return this.#cumulativeBytes;
  }

  setHalfLives(halfLifeFastSec: number, halfLifeSlowSec: number): void {
    this.#halfLifeFastSec = halfLifeFastSec;
    this.#halfLifeSlowSec = halfLifeSlowSec;
  }

  reset(): void {
    this.#swma = [];
    this.#currentGroupId = null;
    this.#currentGroupBytes = 0;
    this.#currentGroupFirstObjBytes = 0;
    this.#currentGroupFirstTs = 0;
    this.#currentGroupLastTs = 0;
    this.#currentGroupObjectCount = 0;
    this.#lastObjectBytes = 0;
    this.#lastGroupDurationMs = 0;
    this.#sampleCount = 0;
    this.#emaFast = 0;
    this.#emaSlow = 0;
    this.#hasEmaData = false;
    this.#cumulativeBytes = 0;
  }

  #finalizeCurrentGroup(): void {
    if (this.#currentGroupObjectCount < 2) return;
    const dtMs = this.#currentGroupLastTs - this.#currentGroupFirstTs;
    if (dtMs <= 0) return;

    // Exclude the first object's bytes from the numerator: it sets t_1 and
    // contributes no inter-arrival information. Matches the IETF slides.
    const bytes = this.#currentGroupBytes - this.#currentGroupFirstObjBytes;
    if (bytes <= 0) return;

    const dtSec = dtMs / 1000;
    const groupBps = (bytes * 8) / dtSec;

    this.#swma.push(groupBps);
    if (this.#swma.length > this.#swmaWindowSize) this.#swma.shift();

    this.#lastGroupDurationMs = dtMs;
    this.#sampleCount++;

    this.#updateEma(groupBps, dtMs);
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
