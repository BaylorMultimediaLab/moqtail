import type { AbrRule, AbrSettings, RulesContext, SwitchRequest } from './types';
import { SwitchRequestPriority, resolveControllerSettings } from './types';
import { ThroughputRule } from './rules/ThroughputRule';
import { BolaRule } from './rules/BolaRule';
import { ProbeRule } from './rules/ProbeRule';
import { InsufficientBufferRule } from './rules/InsufficientBufferRule';
import { BufferDrainRateRule } from './rules/BufferDrainRateRule';
import { LatencyTrendRule } from './rules/LatencyTrendRule';
import { SwitchHistoryRule } from './rules/SwitchHistoryRule';
import { DroppedFramesRule } from './rules/DroppedFramesRule';
import { AbandonRequestsRule } from './rules/AbandonRequestsRule';
import { L2ARule } from './rules/L2ARule';
import { LoLpRule } from './rules/LoLpRule';
import { EmergencyBufferRule } from './rules/EmergencyBufferRule';

interface RuleEntry {
  rule: AbrRule;
  active: boolean;
}

export class AbrRulesCollection {
  readonly #rules: Map<string, RuleEntry>;
  #shouldUseBolaRule: boolean;

  constructor(rawSettings: AbrSettings) {
    // The arm decides the active set (types.ts resolveControllerSettings); the
    // caller passes the same raw settings it gives AbrController.
    const settings = resolveControllerSettings(rawSettings);
    // Registration order is also the tie-break order of the arbiter (see
    // arbitrate): at equal priority and equal index the earlier rule is
    // `chosenBy` and the others are listed in `tied`. The order is part of the
    // record of the earlier arms, so new rules go last.
    const allRules: AbrRule[] = [
      new ThroughputRule(),
      new BolaRule(),
      new ProbeRule(),
      new InsufficientBufferRule(),
      new BufferDrainRateRule(),
      new LatencyTrendRule(),
      new SwitchHistoryRule(),
      new DroppedFramesRule(),
      new AbandonRequestsRule(),
      new L2ARule(),
      new LoLpRule(),
      new EmergencyBufferRule(),
    ];

    this.#rules = new Map();
    for (const rule of allRules) {
      const config = settings.rules[rule.name];
      this.#rules.set(rule.name, {
        rule,
        active: config?.active ?? false,
      });
    }

    this.#shouldUseBolaRule = false;
  }

  setRuleActive(ruleName: string, active: boolean): void {
    const entry = this.#rules.get(ruleName);
    if (!entry) return;

    if (active && !entry.active) {
      entry.rule.reset();
    }
    entry.active = active;
  }

  setShouldUseBolaRule(value: boolean): void {
    this.#shouldUseBolaRule = value;
  }

  isRuleActive(ruleName: string): boolean {
    return this.#rules.get(ruleName)?.active ?? false;
  }

  getBestPossibleSwitchRequest(context: RulesContext): SwitchRequest | null {
    return this.evaluate(context).chosen;
  }

  /**
   * Run every active rule and return each rule's request alongside the
   * collection's choice. Used by the experiment log so a switch decision can
   * be attributed to the rule (and signal) that produced it.
   */
  evaluate(context: RulesContext): RulesEvaluation {
    const isLowLatencyMode = this.isRuleActive('L2ARule') || this.isRuleActive('LoLPRule');

    const requests: NamedRequest[] = [];
    const byRule: Record<string, SwitchRequest | null> = {};
    const skipped: string[] = [];

    for (const [name, entry] of this.#rules) {
      if (!entry.active) continue;

      // Apply dynamic mutual exclusivity for BolaRule and ThroughputRule
      if (name === 'BolaRule') {
        // Skip BOLA in low-latency mode, or when !shouldUseBolaRule in normal mode
        if (isLowLatencyMode || !this.#shouldUseBolaRule) {
          skipped.push(name);
          continue;
        }
      } else if (name === 'ThroughputRule') {
        // Skip Throughput in low-latency mode, or when shouldUseBolaRule in normal mode
        if (isLowLatencyMode || this.#shouldUseBolaRule) {
          skipped.push(name);
          continue;
        }
      }

      const req = entry.rule.getMaxIndex(context);
      byRule[name] = req;
      if (req !== null) {
        requests.push({ rule: name, req });
      }
    }

    return { byRule, skipped, ...arbitrate(requests) };
  }
}

export interface RulesEvaluation {
  /** Every rule that ran, with its request (null = no opinion). */
  byRule: Record<string, SwitchRequest | null>;
  /** Active rules skipped by the BOLA/throughput exclusivity. */
  skipped: string[];
  chosen: SwitchRequest | null;
  /** The rule whose request is `chosen` (null when no rule asked for anything). */
  chosenBy: string | null;
  /**
   * The other rules that asked for the same index at the same priority as
   * `chosen` (registration order). Empty when the choice was unique.
   */
  tied: string[];
}

interface NamedRequest {
  rule: string;
  req: SwitchRequest;
}

/**
 * The dash.js arbiter: from the highest priority tier that has any request
 * (STRONG > DEFAULT > WEAK), the lowest representation index.
 *
 * Tie-break: requests for the same index at the same priority are equivalent
 * for the decision (the index is all the controller acts on); the first one in
 * rule registration order (ThroughputRule, BolaRule, ProbeRule,
 * InsufficientBufferRule, BufferDrainRateRule, LatencyTrendRule,
 * SwitchHistoryRule, DroppedFramesRule, AbandonRequestsRule, L2ARule,
 * LoLPRule, EmergencyBufferRule) supplies `chosen.reason` and `chosenBy`, and
 * the rest are named in `tied`, so attribution statistics can count a tie as
 * a tie rather than crediting the earlier rule. In the min arm a tie can only
 * occur in the DEFAULT tier between ThroughputRule and SwitchHistoryRule's
 * veto, and then the index equals the throughput rung, i.e. the veto did not
 * bind.
 */
function arbitrate(requests: NamedRequest[]): Omit<RulesEvaluation, 'byRule' | 'skipped'> {
  if (requests.length === 0) return { chosen: null, chosenBy: null, tied: [] };

  // Group by priority tier
  const tiers = new Map<SwitchRequestPriority, NamedRequest[]>();

  for (const r of requests) {
    const bucket = tiers.get(r.req.priority);
    if (bucket) {
      bucket.push(r);
    } else {
      tiers.set(r.req.priority, [r]);
    }
  }

  // Evaluate from highest to lowest priority tier
  const priorityOrder: SwitchRequestPriority[] = [
    SwitchRequestPriority.STRONG,
    SwitchRequestPriority.DEFAULT,
    SwitchRequestPriority.WEAK,
  ];

  for (const priority of priorityOrder) {
    const bucket = tiers.get(priority);
    if (!bucket || bucket.length === 0) continue;

    // Pick the request with the lowest representationIndex within this tier;
    // the first in registration order among equals.
    let best = bucket[0]!;
    for (let i = 1; i < bucket.length; i++) {
      if (bucket[i]!.req.representationIndex < best.req.representationIndex) {
        best = bucket[i]!;
      }
    }
    const tied = bucket
      .filter(r => r !== best && r.req.representationIndex === best.req.representationIndex)
      .map(r => r.rule);
    return { chosen: best.req, chosenBy: best.rule, tied };
  }

  return { chosen: null, chosenBy: null, tied: [] };
}
