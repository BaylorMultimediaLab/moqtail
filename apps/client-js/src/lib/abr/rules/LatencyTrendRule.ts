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
 * LatencyTrendRule — downswitch when end-to-end latency rises faster than
 * the link can sustain (per Kuo §3.4.3.1 Algorithm 1 lines 14-16).
 *
 * Per-frame latency is read from the PRFT (Producer Reference Time) box
 * at the head of each CMAF chunk. {@link LatencyTracker} keeps the last
 * 100 samples and exposes a trend ratio = mean(recent half) /
 * mean(older half). The thesis trigger is a 20 % rise (ratio > 1.20)
 * sustained over 100 frames (~4 s at 25 fps).
 *
 * Why this complements the probe: probe-driven upswitches require the
 * link to *demonstrate* headroom. Probe data, by design, says nothing
 * about *downward* pressure — a saturated link still delivers probe
 * bytes, just slowly. Latency trend reflects queueing buildup, the
 * earliest signal a link is past its sustainable rate. That's why the
 * thesis pairs them: probe upswitches, latency-trend downswitches.
 *
 * Returns STRONG priority so the request can preempt other rules' DEFAULT
 * upswitches in {@link AbrRulesCollection.getMinSwitchRequest}.
 */

import type { AbrRule, RulesContext, SwitchRequest } from '../types';
import { SwitchRequestPriority } from '../types';

export class LatencyTrendRule implements AbrRule {
  readonly name = 'LatencyTrendRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, activeTrackIndex, latencyTrendRatio, abrSettings } = context;

    const config = abrSettings.rules['LatencyTrendRule'];
    if (!config?.active) return null;
    const threshold = config.parameters?.trendThreshold ?? 1.2;

    if (tracks.length <= 1) return null;
    if (activeTrackIndex <= 0) return null; // already at lowest

    if (latencyTrendRatio < threshold) return null;

    // Sort tracks ascending so we know which index is "one step lower".
    const sorted = [...tracks]
      .map((t, origIdx) => ({ t, origIdx }))
      .sort((a, b) => (a.t.bitrate ?? 0) - (b.t.bitrate ?? 0));

    const sortedActiveIndex = sorted.findIndex(({ origIdx }) => origIdx === activeTrackIndex);
    const currentIdx = sortedActiveIndex >= 0 ? sortedActiveIndex : 0;
    if (currentIdx <= 0) return null;

    return {
      representationIndex: sorted[currentIdx - 1]!.origIdx,
      priority: SwitchRequestPriority.STRONG,
      reason: `latency trend ${(latencyTrendRatio * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}%`,
    };
  }

  reset(): void {
    /* no internal state */
  }
}
