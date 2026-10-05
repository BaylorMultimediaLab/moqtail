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
 * It reads the *contiguous* buffer (the end of the buffered range that
 * contains the playhead minus the playhead; 0 if the playhead is in no range),
 * never the total across holes, in two forms:
 *
 *   instantaneous == 0          → rung 0                            (STRONG)
 *   envelope < lowBufferS       → highest rung with bitrate ≤ sf × SWMA
 *                                 when that rung is below the active one (STRONG)
 *
 * with `lowBufferS = 0.5 s` and `sf = 0.7` by default. The envelope
 * (`RulesContext.bufferEnvelopeSeconds`) is the maximum of the contiguous
 * buffer over the last `bufferEnvelopeMs` (1250 ms: one group plus one tick),
 * so the low branch fires only when the buffer stayed below 0.5 s for that
 * whole window, i.e. it is draining, not merely at the trough of a group.
 *
 * Why the envelope (F1): the publisher sends each group as a burst, so at the
 * live edge the instantaneous contiguous buffer is a per-group sawtooth
 * (≈1.1 s after a burst, ≈0.2-0.35 s just before the next) whose trough is
 * below 0.5 s once per group, while a time-shifted client sees the same
 * sawtooth 10 s higher. Reading the instantaneous value armed the low branch
 * once per group on the live-edge client only: with a SWMA in
 * [bitrate/0.9, bitrate/0.7) it alternated between ThroughputRule's rung and
 * the 0.7 × SWMA rung (45 switches in 120 s against 0 for the time-shifted
 * client on identical throughput). The envelope is the level after each burst,
 * the same quantity on both client types. The empty branch keeps the
 * instantaneous value: a playhead at a hole or at the end of its data is a
 * stall now, whatever the last second looked like.
 *
 * The rule only ever lowers: when the low-buffer rung is at or above the
 * active rung it abstains and ThroughputRule (with the dwell) decides, exactly
 * as on a full buffer. It deliberately does not vote "stay": a STRONG stay
 * would be an up-switch gate on the buffer level, i.e. an admission policy that
 * binds on a live-edge client only (the M18 objection to
 * InsufficientBufferRule).
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
 * type (a time-shifted client waits for its backlog). The low branch stays
 * silent for a further `bufferEnvelopeMs` (`RulesContext.bufferEnvelopeReady`):
 * the controller discards buffer samples from before the first frame, and a
 * shorter window can sit entirely on a trough of the live-edge sawtooth
 * (R4-D3: one live-edge-only emergency on the first tick in 20-24 of 288
 * simulated pairs). The empty branch is unaffected.
 *
 * Reasons contain "emergency", so AbrController labels the switch
 * `auto-emergency` and SwitchHistoryRule counts it as a drop (unless it is
 * decided while the playhead is at a seam, see
 * controller.historyIgnoreGroupsAfterLanding).
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

    const instant = context.bufferInstantSeconds ?? context.bufferSeconds;
    if (instant <= 0) {
      return { representationIndex: 0, priority, reason: 'emergency-buffer-empty' };
    }
    // The low branch reads the envelope (F1); a caller that has none (unit
    // contexts) gets the instantaneous value. It is silent until the envelope
    // covers a whole window after the first frame (R4-D3).
    if (context.bufferEnvelopeReady === false) return null;
    const buffer = context.bufferEnvelopeSeconds ?? instant;
    if (buffer >= lowBufferS) return null;

    const cap = bandwidthBps * safetyFactor;
    let best = 0;
    for (let i = 0; i < tracks.length; i++) {
      if ((tracks[i]!.bitrate ?? 0) <= cap) best = i;
    }
    if (best >= Math.max(0, activeTrackIndex)) return null;
    return {
      representationIndex: best,
      priority,
      reason: `emergency-buffer-low envelope ${buffer.toFixed(2)}s < ${lowBufferS}s, cap ${(cap / 1e6).toFixed(2)}Mbps`,
    };
  }

  reset(): void {
    /* stateless */
  }
}
