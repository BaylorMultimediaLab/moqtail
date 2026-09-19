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
 * BufferDrainRateRule — receiver-paced downswitch trigger.
 *
 * The signal is the first derivative of `bufferSeconds` over a 1-second
 * sliding window. Conservation of buffer time gives:
 *
 *   d(bufferSeconds)/dt = (linkRate / sourceRate) - playbackRate
 *
 * Rearranged:
 *
 *   linkRate = sourceRate · (playbackRate - drainRate)
 *
 * where `drainRate = -d(bufferSeconds)/dt` and `sourceRate` is the active
 * track's bitrate. Pure receiver-side — no `bytes / (t_N − t_1)` ratio,
 * so it survives sender-side stalls (when the publisher's QUIC stream is
 * blocked by congestion control and SWMA stops getting samples).
 *
 * Why this rule exists alongside InsufficientBufferRule and
 * LatencyTrendRule: those two are the dash.js / Kuo Algorithm 1 safety
 * nets, but neither fires fast enough on a sudden link drop to prevent
 * ThroughputRule (or BolaRule) from making a first-switch decision based
 * on stale `bandwidthBps`. By the time `bufferSeconds < 0.5` (when
 * InsufficientBufferRule wakes up) or the latency window has shifted
 * enough to trigger LatencyTrendRule (~2 s of post-drop frames),
 * ThroughputRule has already wedged the switching guard with an
 * infeasible target. Drain rate fires within one window (≈ 1 s) of the
 * regime change.
 *
 * Priority is STRONG so the request preempts any DEFAULT-tier upswitch
 * ProbeRule or BolaRule may emit on the same tick.
 */

import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

interface BufferSample {
  ts: number;
  bufferSeconds: number;
}

export class BufferDrainRateRule implements AbrRule {
  readonly name = 'BufferDrainRateRule';

  #samples: BufferSample[] = [];

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, activeTrackIndex, bufferSeconds, playbackRate, abrSettings } = context;

    const config = abrSettings.rules['BufferDrainRateRule'];
    if (!config?.active) return null;

    const params =
      config.parameters ?? DEFAULT_ABR_SETTINGS.rules['BufferDrainRateRule']!.parameters;
    const windowMs: number = (params['windowMs'] as number) ?? 1000;
    const minSamples: number = (params['minSamples'] as number) ?? 3;
    const drainThreshold: number = (params['drainThreshold'] as number) ?? 0.3;
    const safetyFactor: number = (params['safetyFactor'] as number) ?? 0.7;

    const now = Date.now();
    this.#samples.push({ ts: now, bufferSeconds });
    while (this.#samples.length > 0 && now - this.#samples[0]!.ts > windowMs) {
      this.#samples.shift();
    }

    if (this.#samples.length < minSamples) return null;
    if (tracks.length <= 1) return null;
    if (activeTrackIndex < 0) return null;

    const oldest = this.#samples[0]!;
    const newest = this.#samples[this.#samples.length - 1]!;
    const dtSec = (newest.ts - oldest.ts) / 1000;
    if (dtSec <= 0) return null;

    const drainRate = (oldest.bufferSeconds - newest.bufferSeconds) / dtSec;

    // Safety-net semantic: only fire when buffer is already in danger AND
    // draining. A healthy buffer with a transient drain spike (e.g., a
    // packet-loss burst) shouldn't trigger a downswitch — that's
    // BolaRule/ThroughputRule's job in steady state.
    const bufferTriggerThreshold: number = (params['bufferTriggerThreshold'] as number) ?? 2;
    if (bufferSeconds >= bufferTriggerThreshold) return null;

    // Buffer is keeping up — let other rules handle this tick.
    if (drainRate < drainThreshold) return null;

    // Already at floor — nothing lower to switch to.
    if (activeTrackIndex <= 0) return null;

    const currentBitrate = tracks[activeTrackIndex]?.bitrate ?? 0;
    if (currentBitrate <= 0) return null;

    // linkRate = sourceRate · (playbackRate - drainRate). Clamp to 0 if
    // drainRate ≥ playbackRate (link delivering nothing or reverse — the
    // latter is unphysical but possible from sample noise).
    const fraction = Math.max(0, playbackRate - drainRate);
    const linkBps = currentBitrate * fraction;
    const cappedBps = linkBps * safetyFactor;

    // Find the highest track index whose bitrate fits within the cap.
    // Tracks are sorted ascending in AbrController, so we can stop at the
    // first one that exceeds the cap.
    let bestIndex = 0;
    for (let i = 0; i < tracks.length; i++) {
      const bitrate = tracks[i]?.bitrate ?? 0;
      if (bitrate <= cappedBps) bestIndex = i;
    }

    // Only fire if this would actually move us downward.
    if (bestIndex >= activeTrackIndex) return null;

    return {
      representationIndex: bestIndex,
      priority: SwitchRequestPriority.STRONG,
      reason: `buffer-drain ${drainRate.toFixed(2)}s/s, link≈${(linkBps / 1e6).toFixed(2)}Mbps`,
    };
  }

  reset(): void {
    this.#samples = [];
  }
}
