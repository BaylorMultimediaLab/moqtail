import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

export class ThroughputRule implements AbrRule {
  readonly name = 'ThroughputRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { tracks, bandwidthBps, abrSettings } = context;

    // Cold start: no bandwidth estimate yet
    if (bandwidthBps === 0) {
      return null;
    }

    const { bandwidthSafetyFactor, minBitrate, maxBitrate } = abrSettings;
    const effectiveBandwidth = bandwidthBps * bandwidthSafetyFactor;

    // Find the highest track index whose bitrate fits within effective bandwidth
    // and respects minBitrate/maxBitrate clamps (-1 means unconstrained)
    let bestIndex = -1;

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const bitrate = track.bitrate ?? 0;

      // Must fit within effective bandwidth
      if (bitrate > effectiveBandwidth) {
        continue;
      }

      // Respect minBitrate (-1 = no minimum)
      if (minBitrate !== -1 && bitrate < minBitrate) {
        continue;
      }

      // Respect maxBitrate (-1 = no maximum)
      if (maxBitrate !== -1 && bitrate > maxBitrate) {
        continue;
      }

      bestIndex = i;
    }

    const rulePriority =
      abrSettings.rules['ThroughputRule']?.priority ??
      DEFAULT_ABR_SETTINGS.rules['ThroughputRule'].priority;

    if (bestIndex === -1) {
      // Nothing fits. The shipped rule abstains (grid, baseline); with
      // parameters.downToLowest (the min arm) it asks for the lowest rung the
      // clamps allow, so a collapse below the ladder is a down-switch and does
      // not wait for the buffer to drain into the emergency.
      if (!abrSettings.rules['ThroughputRule']?.parameters?.['downToLowest']) {
        return null;
      }
      let lowest = 0;
      for (let i = 0; i < tracks.length; i++) {
        const bitrate = tracks[i]?.bitrate ?? 0;
        if (minBitrate !== -1 && bitrate < minBitrate) continue;
        if (maxBitrate !== -1 && bitrate > maxBitrate) continue;
        lowest = i;
        break;
      }
      return {
        representationIndex: lowest,
        priority: rulePriority ?? SwitchRequestPriority.DEFAULT,
        reason: 'throughput below the lowest rung',
      };
    }

    return {
      representationIndex: bestIndex,
      priority: rulePriority ?? SwitchRequestPriority.DEFAULT,
      reason: 'throughput',
    };
  }

  reset(): void {
    // Stateless rule — nothing to reset
  }
}
