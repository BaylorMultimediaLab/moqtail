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
 * ProbeRule — the active probe as a veto on up-switches (M18).
 *
 * Kuo §3.4.3.1 Algorithm 1 line 11 asks the probe one question: does the
 * link carry `b[i+1]` with a 0.8 safety margin? The shipped rule answered it
 * by *proposing* `i+1` when the answer was yes and abstaining when it was no.
 * Under the collection's min-index arbiter that inverts the intent: a strong
 * probe limited ThroughputRule's multi-rung climb to one rung per switch, and
 * a weak probe let the climb through unvetoed.
 *
 * Now the rule is a pure veto. With a fresh reading and no headroom for the
 * next rung it returns the *active* index (DEFAULT), which the arbiter turns
 * into "stay" against any DEFAULT up-vote. With headroom it abstains and
 * leaves the choice of rung to ThroughputRule. It never votes down (STRONG
 * down-votes from the buffer rules are unaffected either way).
 *
 * The reading is `RulesContext.probeBandwidthBps`, the burst-rate measurement
 * described in {@link ProbeManager} (payload bytes over the first-to-last
 * object span). Inactive in the `min` arm, where the probe is off.
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

    // Already on top — nothing to certify or veto.
    if (currentIdx >= sorted.length - 1) return null;

    const nextBitrate = sorted[currentIdx + 1]?.t.bitrate ?? 0;
    if (nextBitrate <= 0) return null;

    // Algorithm 1 line 11: BWE · 0.8 ≥ b[i+1] certifies the next rung; the
    // throughput rule then decides how far to climb.
    if (probeBandwidthBps * safetyFactor >= nextBitrate) return null;

    return {
      representationIndex: sorted[currentIdx]!.origIdx,
      priority: config.priority ?? SwitchRequestPriority.DEFAULT,
      reason: `probe veto: BWE ${(probeBandwidthBps / 1e6).toFixed(2)}Mbps × ${safetyFactor} < next ${(nextBitrate / 1e6).toFixed(2)}Mbps`,
    };
  }

  reset(): void {
    /* no internal state */
  }
}
