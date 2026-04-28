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
 * ProbeRule — upswitch decisions driven by the active bandwidth probe.
 *
 * Implements Kuo §3.4.3.1 Algorithm 1 lines 11-13: if the probe-derived
 * bandwidth estimate, after the configured safety factor, exceeds the
 * next-higher track's bitrate, propose an upswitch to that track.
 *
 * Downswitches are not handled here — the probe by nature only measures
 * "upward" headroom (more data than the active source bitrate). Downward
 * pressure comes from {@link InsufficientBufferRule} (buffer drain) and,
 * once available, {@link LatencyTrendRule} (queueing latency rise).
 *
 * BolaRule remains the buffer-driven decision-maker. ProbeRule and
 * BolaRule both submit independent SwitchRequests to
 * {@link AbrRulesCollection}; the lower-bitrate-wins arbiter ensures any
 * rule can veto an upswitch.
 */

import type { AbrRule, RulesContext, SwitchRequest } from '../types';
import { SwitchRequestPriority } from '../types';

export class ProbeRule implements AbrRule {
  readonly name = 'ProbeRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, activeTrackIndex, probeBandwidthBps, abrSettings } = context;

    if (tracks.length <= 1) return null;
    if (probeBandwidthBps <= 0) return null;

    const config = abrSettings.rules['ProbeRule'];
    if (!config?.active) return null;
    const safetyFactor = config.parameters?.safetyFactor ?? 0.8;

    // Sort tracks ascending so the next-higher index is currentIdx + 1.
    const sorted = [...tracks]
      .map((t, origIdx) => ({ t, origIdx }))
      .sort((a, b) => (a.t.bitrate ?? 0) - (b.t.bitrate ?? 0));

    const sortedActiveIndex = sorted.findIndex(({ origIdx }) => origIdx === activeTrackIndex);
    const currentIdx = sortedActiveIndex >= 0 ? sortedActiveIndex : 0;

    // Already on top — nothing to upswitch to.
    if (currentIdx >= sorted.length - 1) return null;

    const nextBitrate = sorted[currentIdx + 1]?.t.bitrate ?? 0;
    if (nextBitrate <= 0) return null;

    // Algorithm 1 line 11: BWE · 0.8 ≥ b[i+1]
    if (probeBandwidthBps * safetyFactor < nextBitrate) return null;

    return {
      representationIndex: sorted[currentIdx + 1]!.origIdx,
      priority: SwitchRequestPriority.DEFAULT,
      reason: `probe BWE ${(probeBandwidthBps / 1e6).toFixed(2)}Mbps ≥ next ${(nextBitrate / 1e6).toFixed(2)}Mbps`,
    };
  }

  reset(): void {
    /* no internal state */
  }
}
