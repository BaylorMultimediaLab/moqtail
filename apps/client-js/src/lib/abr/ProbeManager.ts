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

import { events } from '@/lib/events/EventLog';

/**
 * ProbeManager — schedules and stores results of active bandwidth probes.
 *
 * Per Kuo (KTH MSc 2025 §3.4.3.1) and the IETF 119 MoQ bandwidth-
 * measurement slides, an active probe complements passive SWMA by
 * answering the question SWMA cannot: "is there headroom *above* the
 * active source bitrate?" Passive measurement reads the publisher's push
 * rate; a probe subscribes to a higher-bitrate track at lowest priority
 * for a short window, measures the link's actual delivery rate, and
 * unsubscribes.
 *
 * Decoupled from `Player`/`AbrController` for testability — the only
 * dependency is a `probeTrackBandwidth(name, durationMs)` callable.
 */

/** A probe measurement: link estimate plus how long the burst was on the wire. */
export interface ProbeResult {
  bps: number;
  dtMs: number;
}

export interface ProbeFn {
  probeTrackBandwidth(trackName: string, durationMs: number): Promise<number | ProbeResult>;
}

export interface ProbeManagerOptions {
  /** Minimum gap between probes, ms. Thesis uses ~2 s. */
  intervalMs?: number;
  /** Probe duration, ms. Shorter = less interference with main stream. */
  durationMs?: number;
  /** Result freshness window, ms. Older than this is treated as stale. */
  freshnessMs?: number;
  /**
   * Discard readings whose on-wire duration was shorter than this (ms). A
   * few-KB probe that completes inside one burst measures burst scheduling,
   * not link capacity (readings of hundreds of Mbps on a 6 Mbps link). 0 keeps
   * every reading.
   */
  minDurationMs?: number;
}

export class ProbeManager {
  #player: ProbeFn;
  #intervalMs: number;
  #durationMs: number;
  #freshnessMs: number;
  #minDurationMs: number;

  #lastProbeStartMs = 0;
  #probeInFlight = false;
  #probeBandwidthBps = 0;
  #probeTimestampMs = 0;

  constructor(player: ProbeFn, opts: ProbeManagerOptions = {}) {
    this.#player = player;
    this.#intervalMs = opts.intervalMs ?? 2000;
    this.#durationMs = opts.durationMs ?? 500;
    this.#freshnessMs = opts.freshnessMs ?? 5000;
    this.#minDurationMs = opts.minDurationMs ?? 0;
  }

  setMinDurationMs(ms: number): void {
    this.#minDurationMs = ms;
  }

  /**
   * Fire a probe against `trackName` if eligible: not already in flight,
   * `intervalMs` elapsed since last probe, and `trackName` non-null.
   * Async — returns immediately; the result lands on a later tick.
   */
  maybeProbe(trackName: string | null): void {
    if (this.#probeInFlight) return;
    if (!trackName) return;
    const now = Date.now();
    if (now - this.#lastProbeStartMs < this.#intervalMs) return;

    this.#lastProbeStartMs = now;
    this.#probeInFlight = true;
    this.#player
      .probeTrackBandwidth(trackName, this.#durationMs)
      .then(result => {
        const bps = typeof result === 'number' ? result : result.bps;
        const dtMs = typeof result === 'number' ? undefined : result.dtMs;
        if (bps <= 0) return;
        if (this.#minDurationMs > 0 && dtMs !== undefined && dtMs < this.#minDurationMs) {
          events.emit('PROBE_DISCARDED', {
            track: trackName,
            bps,
            dt_ms: dtMs,
            min_duration_ms: this.#minDurationMs,
          });
          return;
        }
        this.#probeBandwidthBps = bps;
        this.#probeTimestampMs = Date.now();
      })
      .catch(() => {
        /* swallow: a failed probe is information too — it just doesn't update the cache */
      })
      .finally(() => {
        this.#probeInFlight = false;
      });
  }

  /** Last probe BWE if fresh, else 0. */
  getFreshBandwidthBps(): number {
    if (this.#probeTimestampMs === 0) return 0;
    if (Date.now() - this.#probeTimestampMs > this.#freshnessMs) return 0;
    return this.#probeBandwidthBps;
  }

  /** Raw timestamp of the last successful probe (ms). 0 if never. */
  getTimestampMs(): number {
    return this.#probeTimestampMs;
  }

  reset(): void {
    this.#lastProbeStartMs = 0;
    this.#probeInFlight = false;
    this.#probeBandwidthBps = 0;
    this.#probeTimestampMs = 0;
  }
}
