import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

export class ThroughputRule implements AbrRule {
  readonly name = 'ThroughputRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, bandwidthBps, abrSettings } = context;

    if (bandwidthBps === 0) {
      return null;
    }

    const { bandwidthSafetyFactor, minBitrate, maxBitrate } = abrSettings;
    const effectiveBandwidth = bandwidthBps * bandwidthSafetyFactor;

    // Highest track whose bitrate fits within effective bandwidth and the
    // minBitrate/maxBitrate clamps. -1 on either clamp means unconstrained.
    let bestIndex = -1;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const bitrate = track.bitrate ?? 0;

      if (bitrate > effectiveBandwidth) {
        continue;
      }

      if (minBitrate !== -1 && bitrate < minBitrate) {
        continue;
      }

      if (maxBitrate !== -1 && bitrate > maxBitrate) {
        continue;
      }

      bestIndex = i;
    }

    if (bestIndex === -1) {
      return null;
    }

    const rulePriority =
      abrSettings.rules['ThroughputRule']?.priority ??
      DEFAULT_ABR_SETTINGS.rules['ThroughputRule'].priority;

    return {
      representationIndex: bestIndex,
      priority: rulePriority ?? SwitchRequestPriority.DEFAULT,
      reason: 'throughput',
    };
  }

  reset(): void {
    /* stateless */
  }
}
