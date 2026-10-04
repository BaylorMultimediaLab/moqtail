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
 * 100 samples; the thesis trigger is a 20 % rise of the recent half of the
 * window over the older half.
 *
 * The signal that is compared (C6). The tracker's samples are
 * capture-to-receipt latency, which is `targetShift + queueing`: about
 * 10.1 s on a 10 s time-shifted client and 0.1–0.4 s on a live-edge one. A
 * ratio of the raw means therefore needs a ~2 s rise on the shifted client
 * (never) and a 20–80 ms rise on the live-edge client (every queue wobble):
 * a STRONG rule that is on for one client type and off for the other. The
 * rule now forms its ratio on `mean − targetShiftMs`, the queueing part the
 * two client types share, when the player exposes the half-window means and
 * the shift (`RulesContext.latencyRecentMeanMs`, `latencyOlderMeanMs`,
 * `targetShiftMs`). Without the shift, or when the corrected base is not
 * positive (a client ahead of its target), it uses an absolute rise,
 * `trendDeltaMs` (default 100 ms), which is client-type neutral by
 * construction. Without the means it falls back to the raw ratio the player
 * sends (legacy players).
 *
 * Returns STRONG priority so the request can preempt other rules' DEFAULT
 * upswitches in {@link AbrRulesCollection.getMinSwitchRequest}. Inactive in
 * the `min` arm.
 */

import type { AbrRule, RulesContext, SwitchRequest } from '../types';
import { SwitchRequestPriority } from '../types';

export class LatencyTrendRule implements AbrRule {
  readonly name = 'LatencyTrendRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, activeTrackIndex, abrSettings } = context;

    const config = abrSettings.rules['LatencyTrendRule'];
    if (!config?.active) return null;
    const threshold = config.parameters?.trendThreshold ?? 1.2;
    const deltaMs = config.parameters?.trendDeltaMs ?? 100;

    if (tracks.length <= 1) return null;
    if (activeTrackIndex <= 0) return null; // already at lowest

    const trend = latencyTrend(context, threshold, deltaMs);
    if (!trend.fire) return null;

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
      reason: trend.reason,
    };
  }

  reset(): void {
    /* no internal state */
  }
}

/** Which form of the trend applies to this context, whether it fires, and why. */
function latencyTrend(
  context: RulesContext,
  threshold: number,
  deltaMs: number,
): { fire: boolean; reason: string } {
  const { latencyRecentMeanMs: recent, latencyOlderMeanMs: older, targetShiftMs: shift } = context;
  const haveMeans = isFinite(recent) && isFinite(older);
  if (!haveMeans) {
    const ratio = context.latencyTrendRatio;
    return {
      fire: ratio >= threshold,
      reason: `latency trend ${(ratio * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}% (raw)`,
    };
  }
  if (isFinite(shift)) {
    const base = older - shift;
    const rec = recent - shift;
    if (base > 0) {
      const ratio = rec / base;
      return {
        fire: ratio >= threshold,
        reason: `latency trend ${(ratio * 100).toFixed(0)}% > ${(threshold * 100).toFixed(0)}% above shift ${shift.toFixed(0)}ms (${older.toFixed(0)}→${recent.toFixed(0)}ms)`,
      };
    }
  }
  const delta = recent - older;
  return {
    fire: delta > deltaMs,
    reason: `latency rise ${delta.toFixed(0)}ms > ${deltaMs}ms (${older.toFixed(0)}→${recent.toFixed(0)}ms)`,
  };
}

function isFinite(x: number | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
