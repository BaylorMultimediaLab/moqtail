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
 * EmergencyBufferRule — the one buffer rule of the `min` arm.
 *
 * It reads the *instantaneous contiguous* buffer (`RulesContext.
 * bufferInstantSeconds`: the end of the buffered range that contains the
 * playhead minus the playhead; 0 if the playhead is in no range), never the
 * envelope the other rules see and never the total across holes:
 *
 *   buffer == 0        → rung 0                                  (STRONG)
 *   buffer < lowBufferS → highest rung with bitrate ≤ sf × SWMA,  (STRONG)
 *                         capped at the active rung
 *
 * with `lowBufferS = 0.5 s` and `sf = 0.7` by default. The cap means the
 * low-buffer branch never proposes an up-switch; when the cap is the active
 * rung the request reads as "stay", which vetoes DEFAULT up-votes while the
 * buffer is low.
 *
 * Why only this: InsufficientBufferRule's admission `0.7 × SWMA × buffer`
 * binds on a live-edge client (buffer ≈ 1 s) and is no constraint on a 10 s
 * client (M18), and BufferDrainRateRule differences the buffer, which reads
 * the group-burst sawtooth as a drain (M17). An emergency on the level alone
 * is the same test on both client types: a stall is imminent or has begun.
 *
 * Startup: the rule abstains until a frame has been presented
 * (`totalFrames > 0`). Before that the buffer is empty by construction and no
 * stall is possible, and the duration of that phase depends on the client
 * type (a time-shifted client waits for its backlog).
 *
 * Reasons contain "emergency", so AbrController labels the switch
 * `auto-emergency` and SwitchHistoryRule counts it as a drop (unless it falls
 * inside the post-landing window, see controller.historyIgnoreGroupsAfterLanding).
 */

import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

export class EmergencyBufferRule implements AbrRule {
  readonly name = 'EmergencyBufferRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, activeTrackIndex, bandwidthBps, totalFrames, abrSettings } = context;

    const config = abrSettings.rules['EmergencyBufferRule'];
    if (!config?.active) return null;
    const defaults = DEFAULT_ABR_SETTINGS.rules['EmergencyBufferRule']!.parameters;
    const lowBufferS: number = config.parameters?.['lowBufferS'] ?? defaults['lowBufferS']!;
    const safetyFactor: number =
      config.parameters?.['throughputSafetyFactor'] ?? defaults['throughputSafetyFactor']!;
    const priority = config.priority ?? SwitchRequestPriority.STRONG;

    if (tracks.length === 0) return null;
    if (totalFrames <= 0) return null; // startup: nothing presented, nothing to stall

    const buffer = context.bufferInstantSeconds ?? context.bufferSeconds;

    if (buffer <= 0) {
      return { representationIndex: 0, priority, reason: 'emergency-buffer-empty' };
    }
    if (buffer >= lowBufferS) return null;

    const cap = bandwidthBps * safetyFactor;
    let best = 0;
    for (let i = 0; i < tracks.length; i++) {
      if ((tracks[i]!.bitrate ?? 0) <= cap) best = i;
    }
    const active = Math.max(0, activeTrackIndex);
    const index = Math.min(best, active);
    return {
      representationIndex: index,
      priority,
      reason: `emergency-buffer-low ${buffer.toFixed(2)}s < ${lowBufferS}s, cap ${(cap / 1e6).toFixed(2)}Mbps`,
    };
  }

  reset(): void {
    /* stateless */
  }
}
