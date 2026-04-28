import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

export class InsufficientBufferRule implements AbrRule {
  readonly name = 'InsufficientBufferRule';

  #callCount = 0;

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, bufferSeconds, bandwidthBps, segmentDurationS, abrSettings } = context;

    const params =
      abrSettings.rules['InsufficientBufferRule']?.parameters ??
      DEFAULT_ABR_SETTINGS.rules['InsufficientBufferRule'].parameters;

    const throughputSafetyFactor: number = (params['throughputSafetyFactor'] as number) ?? 0.7;
    const segmentIgnoreCount: number = (params['segmentIgnoreCount'] as number) ?? 2;
    const { stableBufferTime } = abrSettings;

    this.#callCount += 1;

    // Ignore first segmentIgnoreCount calls (warm-up period)
    if (this.#callCount <= segmentIgnoreCount) {
      return null;
    }

    // Buffer is healthy — do not intervene
    if (bufferSeconds >= stableBufferTime) {
      return null;
    }

    // Buffer is completely empty — force lowest quality with STRONG priority
    if (bufferSeconds === 0) {
      return {
        representationIndex: 0,
        priority: SwitchRequestPriority.STRONG,
        reason: 'insufficient-buffer-empty',
      };
    }

    // dash.js formula (`InsufficientBufferRule.js`):
    //   cap = bandwidth × safetyFactor × bufferLevel / fragmentDuration
    //
    // At healthy buffers (e.g. buffer=15, segment=1) the multiplier is 15 →
    // cap is far above any track → the rule effectively yields control to
    // ProbeRule/ThroughputRule. At critical buffers (buffer=0.2, segment=1)
    // the multiplier is 0.2 → cap collapses → forces an emergency
    // downswitch.
    //
    // We previously used `min(1, buffer/stableBufferTime)` to *cap* the
    // multiplier at 1, because our passive `bandwidthBps` was push-rate-
    // pinned and a 15× multiplier on push rate produced phantom upswitch
    // permissions. Now that ProbeRule reads true link rate via the
    // `.probe:` track and SWMA reads link burst rate (also above push
    // rate), the dash.js multiplier is safe again — and the previous cap
    // was wrongly suppressing 1080p upswitches throughout
    // test_bandwidth_recovery's 6–16 s buffer window.
    void stableBufferTime;
    const cappedBps = (bandwidthBps * throughputSafetyFactor * bufferSeconds) / segmentDurationS;

    // Find the highest track index whose bitrate fits within the capped bandwidth
    let bestIndex = 0;
    for (let i = 0; i < tracks.length; i++) {
      const bitrate = tracks[i]!.bitrate ?? 0;
      if (bitrate <= cappedBps) {
        bestIndex = i;
      }
    }

    const priority =
      bufferSeconds < 0.5 ? SwitchRequestPriority.STRONG : SwitchRequestPriority.DEFAULT;

    return {
      representationIndex: bestIndex,
      priority,
      reason: 'insufficient-buffer-low',
    };
  }

  reset(): void {
    this.#callCount = 0;
  }
}
