import { SwitchRequestPriority, DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrRule, RulesContext, SwitchRequest } from '../types';

export class DroppedFramesRule implements AbrRule {
  readonly name = 'DroppedFramesRule';

  getMaxIndex(context: RulesContext): SwitchRequest | null {
    const { activeTrackIndex, droppedFrames, totalFrames, abrSettings } = context;

    const ruleConfig =
      abrSettings.rules['DroppedFramesRule'] ?? DEFAULT_ABR_SETTINGS.rules['DroppedFramesRule'];

    const minimumSampleSize: number =
      ruleConfig.parameters['minimumSampleSize'] ??
      DEFAULT_ABR_SETTINGS.rules['DroppedFramesRule'].parameters['minimumSampleSize'];

    const droppedFramesPercentageThreshold: number =
      ruleConfig.parameters['droppedFramesPercentageThreshold'] ??
      DEFAULT_ABR_SETTINGS.rules['DroppedFramesRule'].parameters[
        'droppedFramesPercentageThreshold'
      ];

    if (totalFrames < minimumSampleSize) {
      return null;
    }

    const dropRatio = droppedFrames / totalFrames;

    if (dropRatio <= droppedFramesPercentageThreshold) {
      return null;
    }

    const targetIndex = Math.max(0, activeTrackIndex - 1);

    const rulePriority = ruleConfig.priority ?? SwitchRequestPriority.DEFAULT;

    return {
      representationIndex: targetIndex,
      priority: rulePriority,
      reason: 'dropped-frames',
    };
  }

  reset(): void {
    // Stateless: dropped frame counts come from the browser API via RulesContext.
  }
}
