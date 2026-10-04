export type Track = {
  name: string;
  bitrate?: number;
  role?: string;
  codec?: string;
  width?: number;
  height?: number;
  framerate?: number;
};

/**
 * How a switch in the history came about. `auto-emergency` = a down-switch
 * chosen from EmergencyBufferRule's request (the min arm; never produced by
 * grid or baseline, which do not run that rule); `auto-downgrade` = any other
 * automatic down-switch. SwitchHistoryRule counts both as drops.
 */
export type SwitchReason = 'auto-upgrade' | 'auto-downgrade' | 'auto-emergency' | 'manual';

export interface SwitchEvent {
  ts: number;
  fromTrack: string;
  toTrack: string;
  reason: SwitchReason;
  bufferAtSwitch: number;
  emaBwAtSwitch: number;
  /**
   * Completed groups (throughput samples) between the last confirmed landing
   * and this decision. Absent before the first landing. SwitchHistoryRule uses
   * it to leave drops that happen within
   * `controller.historyIgnoreGroupsAfterLanding` groups of a landing out of a
   * rung's record: those are the seam, not the rung.
   */
  groupsSinceLanding?: number;
}

export enum SwitchRequestPriority {
  WEAK = 0,
  DEFAULT = 0.5,
  STRONG = 1,
}

export interface SwitchRequest {
  representationIndex: number;
  priority: SwitchRequestPriority;
  reason: string;
}

export interface RuleConfig {
  active: boolean;
  priority: SwitchRequestPriority;
  parameters: Record<string, number>;
}

/**
 * Which rule set the controller runs (`AbrSettings.controller.arm`;
 * `?controllerArm=` in the player URL, `--controller` in the runner).
 *
 * - `baseline`: the controller as shipped; every stabilisation knob below at
 *   its default.
 * - `grid`: the frozen ablation controller (docs/abr-controller.md 9.7, 9.9).
 *   The arm itself changes nothing: its knobs (`latencyResetOnLanding`,
 *   `bufferSignal`, `switchHistoryMode`, `switchHistoryWindowS`,
 *   `probeMaxBytes`) are passed explicitly, so the earlier ablation arms stay
 *   reproducible. Kept for the ablation record only.
 * - `min`: the paper controller (docs/rebuild-2026-10-04.md, "Controller
 *   min"). `resolveControllerSettings` derives the whole configuration from
 *   the arm: ThroughputRule (down to rung 0 when nothing fits), EmergencyBufferRule
 *   and SwitchHistoryRule (veto, 60 s window) on, every other rule and the
 *   probe off, the envelope of the contiguous buffer as the buffer signal, and
 *   an up-switch dwell of `upDwellGroups` completed groups of the landed track
 *   since the last landing (AbrController). Its own constants
 *   (`upDwellGroups`, `historyIgnoreGroupsAfterLanding`,
 *   `switchHistoryWindowS`, `bufferEnvelopeMs`, `bandwidthSafetyFactor`, the
 *   EmergencyBufferRule parameters) stay tunable; the pinned knobs are
 *   overridden whatever the caller passes.
 *
 * Only `min` reads the contiguous buffer (`bufferContigSeconds`); `grid` and
 * `baseline` keep the total buffered-ahead they were run with.
 */
export type ControllerArm = 'min' | 'grid' | 'baseline';

/**
 * Controller stabilisation parameters. Every one of them is off in the
 * defaults (the baseline controller); the experiment runner turns them on per
 * ablation arm and records them in RUN_META. They are deliberately separate
 * knobs: the probe fix addresses noisy link estimates on small rung gaps, the
 * post-switch up-guard addresses control-loop frequency.
 */
export interface ControllerSettings {
  /** The rule set (see ControllerArm). The controller selects everything else from it when `min`. */
  arm: ControllerArm;
  /**
   * `min` arm: no up-switch until this many completed groups (throughput
   * samples) of the landed track have arrived since the last confirmed
   * landing (`ABR_GATED why = up-dwell`). Down-switches are never held. The
   * count uses the player's per-track sample counts
   * (`AbrPlayerMetrics.samplesByTrack`) when present; otherwise the total
   * sample count minus one, because the landing object itself finalises the
   * source's last group (AbrController.groupsSinceLanding). Before the first
   * landing the count is the startup track's samples. Inert on the other
   * arms, which keep their explicit `upGuardSamples`.
   */
  upDwellGroups: number;
  /**
   * SwitchHistoryRule leaves a drop out of a rung's record when it was decided
   * this many or fewer completed groups after a landing: that drop is the
   * seam (a one-group hole on native, the catch-up burst elsewhere), not the
   * rung, and must not become a 60 s ladder cap through the veto (M17). Every
   * history entry is stamped with `groupsSinceLanding` at decision time. 0 =
   * count every drop. Applies on every arm (part of the M17 fix).
   */
  historyIgnoreGroupsAfterLanding: number;
  /**
   * Group (GOP) duration in seconds, from the catalog: app.tsx passes
   * `catalog.getGopDurationMs(videoTrack) / 1000`. The rules see it as
   * `RulesContext.segmentDurationS` (InsufficientBuffer, Abandon and BOLA
   * read it; none of the `min` rules does). Default 1 (the harness GOP); a
   * non-positive value reads as 1.
   */
  segmentDurationS: number;
  /**
   * Floor on the active probe payload in bytes (0 = the Algorithm 1 size
   * alone). A probe sized only from a small rung gap is a few tens of KB and
   * completes inside one burst, which reads as hundreds of Mbps.
   */
  probeMinBytes: number;
  /**
   * Discard a probe reading whose on-wire duration was shorter than this
   * (ms, 0 = keep every reading). A reading over a few milliseconds measures
   * burst scheduling, not link capacity.
   */
  probeMinDurationMs: number;
  /**
   * Post-switch up-guard: after any switch, no further up-switch until the
   * switch has been released (see upGuardRelease) and this many fresh
   * completed-group throughput samples have arrived since. Down-switches are
   * never held. 0 = off.
   */
  upGuardSamples: number;
  /**
   * When the up-guard starts counting fresh samples: 'landed' = the target's
   * first object was applied (t4; about one group on every mechanism and
   * client type), 'visible' = the target's first frame was presented (t5;
   * about one group at the live edge but the whole shift on a time-shifted
   * client, so this choice makes the guard's duration client-type dependent).
   */
  upGuardRelease: 'landed' | 'visible';
  /**
   * Reset the per-frame latency window when a switch lands, so LatencyTrendRule
   * compares post-switch frames with post-switch frames. Without it the first
   * group after a seam (delivered as a burst on every mechanism) raises the
   * recent/older ratio past 1.2 and triggers a STRONG down-switch about one
   * second after every up-switch.
   */
  latencyResetOnLanding: boolean;
  /**
   * 'evict' (the shipped rule): once a rung has more drops than
   * switchPercentageThreshold allows, SwitchHistoryRule evicts the client from
   * it on the first tick after landing. Under a loop the rule's drops are the
   * loop's own down-switches, so it perpetuates it. 'veto': the rule caps the
   * ladder just below the first unsafe rung above the active one, so the
   * client is never sent to a rung that keeps dropping, and it never evicts
   * (a real drop comes from the buffer rules). 'off' disables the rule.
   */
  switchHistoryMode: 'evict' | 'veto' | 'off';
  /**
   * SwitchHistoryRule only counts switches younger than this (seconds; 0 =
   * the whole 60-entry history). Without a window a rung that dropped stays
   * banned for the rest of the run once the client switches rarely, because
   * the up-visits that would clear it are the ones the ban prevents. With a
   * window a failed climb costs one retry per window.
   */
  switchHistoryWindowS: number;
  /**
   * Which buffer level the rules see. 'instant' (shipped) is the element's
   * buffered-ahead at the tick. 'envelope' is its maximum over the last
   * `bufferEnvelopeMs`: the publisher sends each group as a burst and idles,
   * so at the live edge the instantaneous buffer is a sawtooth (about 1.0 s
   * to 0.2 s once a second) and every buffer-based rule reads the falling
   * edge as a drain of ~1 s/s. The envelope is the buffer level after each
   * group lands, which is the quantity the rules were written for. The
   * empty-buffer emergency still uses the instantaneous value.
   */
  bufferSignal: 'instant' | 'envelope';
  /** Envelope window, ms (one group plus one tick by default). */
  bufferEnvelopeMs: number;
  /**
   * 'on' (shipped): the Algorithm 1 active probe runs whenever the client is
   * below the top rung. 'off': no probe subscriptions at all and ProbeRule is
   * inactive; up-switches come from the group-burst SWMA (ThroughputRule),
   * which on this relay reads the link rate because groups are delivered as
   * bursts. The probe is "lowest priority" only inside the relay's QUIC
   * scheduler; a FIFO bottleneck queue does not know that, so a probe sized
   * from the rung gap (up to 1.4 MB on the Linux ladder) fills the queue and
   * puts 0.7-0.9 s of standing delay in front of every media packet.
   */
  probeMode: 'on' | 'off';
  /** Cap on the probe payload in bytes (0 = uncapped). */
  probeMaxBytes: number;
}

/** Maximum buffer level over the samples inside the trailing window (see ControllerSettings.bufferSignal). */
export function bufferEnvelope(
  samples: ReadonlyArray<{ ts: number; bufferSeconds: number }>,
  nowMs: number,
  windowMs: number,
): number {
  let max = 0;
  for (const s of samples) {
    if (nowMs - s.ts <= windowMs && s.bufferSeconds > max) max = s.bufferSeconds;
  }
  return max;
}

export const DEFAULT_CONTROLLER_SETTINGS: ControllerSettings = {
  arm: 'baseline',
  upDwellGroups: 3,
  historyIgnoreGroupsAfterLanding: 2,
  segmentDurationS: 1,
  probeMinBytes: 0,
  probeMinDurationMs: 0,
  upGuardSamples: 0,
  upGuardRelease: 'landed',
  latencyResetOnLanding: false,
  switchHistoryMode: 'evict',
  bufferSignal: 'instant',
  bufferEnvelopeMs: 1250,
  switchHistoryWindowS: 0,
  probeMode: 'on',
  probeMaxBytes: 0,
};

export interface AbrSettings {
  fastSwitching: boolean;
  videoAutoSwitch: boolean;
  bufferTimeDefault: number;
  stableBufferTime: number;
  bandwidthSafetyFactor: number;
  ewma: {
    throughputFastHalfLifeSeconds: number;
    throughputSlowHalfLifeSeconds: number;
  };
  initialBitrate: number;
  minBitrate: number;
  maxBitrate: number;
  rules: Record<string, RuleConfig>;
  controller: ControllerSettings;
}

export const DEFAULT_ABR_SETTINGS: AbrSettings = {
  fastSwitching: false,
  videoAutoSwitch: true,
  bufferTimeDefault: 18,
  stableBufferTime: 18,
  bandwidthSafetyFactor: 0.9,
  ewma: {
    throughputFastHalfLifeSeconds: 3,
    throughputSlowHalfLifeSeconds: 8,
  },
  initialBitrate: -1,
  minBitrate: -1,
  maxBitrate: -1,
  controller: DEFAULT_CONTROLLER_SETTINGS,
  rules: {
    // downToLowest: 1 = when no rung fits bandwidth x safety factor, ask for
    // the lowest rung instead of abstaining (set by the min arm; 0 keeps the
    // shipped behaviour for grid and baseline).
    ThroughputRule: {
      active: true,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: { downToLowest: 0 },
    },
    BolaRule: { active: true, priority: SwitchRequestPriority.DEFAULT, parameters: {} },
    ProbeRule: {
      active: true,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: { safetyFactor: 0.8 },
    },
    InsufficientBufferRule: {
      active: true,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: { throughputSafetyFactor: 0.7, segmentIgnoreCount: 2 },
    },
    BufferDrainRateRule: {
      active: true,
      priority: SwitchRequestPriority.STRONG,
      parameters: {
        windowMs: 1000,
        minSamples: 3,
        drainThreshold: 0.3,
        safetyFactor: 0.7,
        bufferTriggerThreshold: 2,
      },
    },
    SwitchHistoryRule: {
      active: true,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: { sampleSize: 8, switchPercentageThreshold: 0.075 },
    },
    LatencyTrendRule: {
      active: true,
      priority: SwitchRequestPriority.STRONG,
      // trendThreshold: ratio of the shift-corrected half-window means that
      // fires the rule. trendDeltaMs: absolute rise (ms) used instead when the
      // player does not expose targetShiftMs or the corrected base is <= 0.
      parameters: { trendThreshold: 1.2, trendDeltaMs: 100 },
    },
    DroppedFramesRule: {
      active: false,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: { minimumSampleSize: 375, droppedFramesPercentageThreshold: 0.15 },
    },
    AbandonRequestsRule: {
      active: true,
      priority: SwitchRequestPriority.DEFAULT,
      parameters: {
        abandonDurationMultiplier: 1.8,
        minThroughputSamplesThreshold: 6,
        minSegmentDownloadTimeThresholdInMs: 500,
      },
    },
    L2ARule: { active: false, priority: SwitchRequestPriority.DEFAULT, parameters: {} },
    LoLPRule: { active: false, priority: SwitchRequestPriority.DEFAULT, parameters: {} },
    // The min arm's emergency (rules/EmergencyBufferRule.ts): instantaneous
    // contiguous buffer == 0 -> rung 0; < lowBufferS -> highest rung under
    // throughputSafetyFactor x SWMA. Off in baseline and grid.
    EmergencyBufferRule: {
      active: false,
      priority: SwitchRequestPriority.STRONG,
      parameters: { lowBufferS: 0.5, throughputSafetyFactor: 0.7 },
    },
  },
};

/**
 * The controller's fixed numbers (not settings). AbrController and its
 * ProbeManager read them from here so describeController reports what runs.
 */
export const CONTROLLER_CONSTANTS = {
  /** Controller tick (AbrController.start). */
  tickMs: 250,
  /** Switching guard released after this long without a landing (ABR_GUARD_TIMEOUT). */
  switchTimeoutMs: 3000,
  /** No decisions for this long after a guard timeout. */
  switchCooldownMs: 5000,
  /** Completed-group samples before the first up-switch (slow start), every arm. */
  minStartupSamples: 3,
  /** Switch-history length (entries) the rules see. */
  maxHistory: 60,
  /** Probe sizing horizon t in probe = t * (b[i+1] - b[i] + tracksize), seconds. */
  probeHorizonS: 2,
  /** ProbeManager: minimum gap between probes, nominal duration, freshness of a reading. */
  probeIntervalMs: 2000,
  probeDurationMs: 500,
  probeFreshnessMs: 5000,
  /**
   * The player's throughput SWMA window in groups (GoodputTracker, owned by
   * the player). Not set here: recorded as the input the controller is
   * specified against.
   */
  swmaWindowGroups: 5,
} as const;

/** The rules the `min` arm runs; every other rule is inactive in it. */
export const MIN_ARM_RULES = [
  'ThroughputRule',
  'EmergencyBufferRule',
  'SwitchHistoryRule',
] as const;

/**
 * The settings the controller and the rules collection actually run. Fills in
 * controller defaults for every arm; for `min` it derives the rule set and the
 * pinned knobs from the arm (see ControllerArm), so app.tsx only has to set
 * `controller.arm`. Idempotent.
 */
export function resolveControllerSettings(settings: AbrSettings): AbrSettings {
  const controller: ControllerSettings = { ...DEFAULT_CONTROLLER_SETTINGS, ...settings.controller };
  if (controller.arm !== 'min') {
    // switchHistoryMode 'off' and probeMode 'off' mean the rule does not run
    // (app.tsx also deactivates them; doing it here keeps the controller and
    // describeController consistent whoever builds the settings).
    let rules = settings.rules;
    const off = (name: string) => {
      const cfg = rules[name];
      if (cfg?.active) rules = { ...rules, [name]: { ...cfg, active: false } };
    };
    if (controller.switchHistoryMode === 'off') off('SwitchHistoryRule');
    if (controller.probeMode === 'off') off('ProbeRule');
    return { ...settings, rules, controller };
  }

  const minRules = new Set<string>(MIN_ARM_RULES);
  const rules: Record<string, RuleConfig> = {};
  for (const [name, cfg] of Object.entries({ ...DEFAULT_ABR_SETTINGS.rules, ...settings.rules })) {
    rules[name] = { ...cfg, active: minRules.has(name) };
  }
  rules['ThroughputRule'] = {
    ...rules['ThroughputRule']!,
    priority: SwitchRequestPriority.DEFAULT,
    // "down to the highest rung with bitrate <= 0.9 x SWMA": rung 0 when none fits.
    parameters: { ...rules['ThroughputRule']!.parameters, downToLowest: 1 },
  };
  rules['EmergencyBufferRule'] = {
    ...rules['EmergencyBufferRule']!,
    priority: SwitchRequestPriority.STRONG,
  };
  rules['SwitchHistoryRule'] = {
    ...rules['SwitchHistoryRule']!,
    priority: SwitchRequestPriority.DEFAULT,
  };

  return {
    ...settings,
    rules,
    controller: {
      ...controller,
      // Pinned by the arm.
      probeMode: 'off',
      probeMinBytes: 0,
      probeMinDurationMs: 0,
      probeMaxBytes: 0,
      bufferSignal: 'envelope',
      switchHistoryMode: 'veto',
      // The arm is defined with a bounded memory; 0 (unbounded) is not accepted.
      switchHistoryWindowS:
        controller.switchHistoryWindowS > 0 ? controller.switchHistoryWindowS : 60,
      upDwellGroups: Math.max(0, controller.upDwellGroups),
      // The dwell (upDwellGroups) is the min arm's only up-switch hold; the
      // ablation up-guard is off.
      upGuardSamples: 0,
      upGuardRelease: 'landed',
      latencyResetOnLanding: false,
    },
  };
}

/** Group duration the rules see (ControllerSettings.segmentDurationS; 1 when not positive). */
export function effectiveSegmentDurationS(controller: ControllerSettings): number {
  const s = controller.segmentDurationS;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

/**
 * RUN_META.controller: the arm and every effective constant, after the arm is
 * resolved, as plain JSON. A run is reproducible from this record alone (the
 * hard-coded numbers used to be pinned only by the git sha).
 */
export interface ControllerDescription {
  arm: ControllerArm;
  tickMs: number;
  /** Group duration the rules see, s (from the catalog GOP). */
  segmentDurationS: number;
  /** Player SWMA window the controller is specified against, groups. */
  swmaWindowGroups: number;
  /** Which buffer level the rules see: 'contiguous' (min) or 'total' (grid, baseline). */
  bufferSource: 'contiguous' | 'total';
  bufferSignal: ControllerSettings['bufferSignal'];
  bufferEnvelopeMs: number;
  /** Up-switch dwell in groups of the landed track since the last landing; 0 = off (every arm but min). */
  upDwellGroups: number;
  minStartupSamples: number;
  upGuardSamples: number;
  upGuardRelease: ControllerSettings['upGuardRelease'];
  switchTimeoutMs: number;
  switchCooldownMs: number;
  maxHistory: number;
  switchHistoryMode: ControllerSettings['switchHistoryMode'];
  switchHistoryWindowS: number;
  switchHistorySampleSize: number;
  switchHistoryDropRatio: number;
  historyIgnoreGroupsAfterLanding: number;
  /** ThroughputRule: bandwidth × this must cover a rung. */
  bandwidthSafetyFactor: number;
  /** ThroughputRule asks for the lowest rung when none fits (min) instead of abstaining. */
  throughputDownToLowest: boolean;
  minBitrate: number;
  maxBitrate: number;
  emergencyLowBufferS: number;
  emergencyThroughputSafetyFactor: number;
  probeMode: ControllerSettings['probeMode'];
  probeMinBytes: number;
  probeMinDurationMs: number;
  probeMaxBytes: number;
  probeSafetyFactor: number;
  probeIntervalMs: number;
  probeDurationMs: number;
  probeFreshnessMs: number;
  probeHorizonS: number;
  latencyResetOnLanding: boolean;
  latencyTrendThreshold: number;
  latencyTrendDeltaMs: number;
  bufferTimeDefault: number;
  stableBufferTime: number;
  /** Rules that run, in registration (tie-break) order. */
  activeRules: string[];
  /** Priority and parameters of every active rule. */
  rules: Record<string, { priority: number; parameters: Record<string, number> }>;
}

/** Registration order of AbrRulesCollection (also the arbiter's tie-break order). */
export const RULE_ORDER = [
  'ThroughputRule',
  'BolaRule',
  'ProbeRule',
  'InsufficientBufferRule',
  'BufferDrainRateRule',
  'LatencyTrendRule',
  'SwitchHistoryRule',
  'DroppedFramesRule',
  'AbandonRequestsRule',
  'L2ARule',
  'LoLPRule',
  'EmergencyBufferRule',
] as const;

/** What the controller built from `settings` runs (see ControllerDescription). */
export function describeController(settings: AbrSettings): ControllerDescription {
  const r = resolveControllerSettings(settings);
  const c = r.controller;
  const rule = (name: string): RuleConfig =>
    r.rules[name] ??
    DEFAULT_ABR_SETTINGS.rules[name] ?? { active: false, priority: 0, parameters: {} };
  const param = (name: string, key: string): number => {
    const v = rule(name).parameters?.[key] ?? DEFAULT_ABR_SETTINGS.rules[name]?.parameters?.[key];
    return typeof v === 'number' ? v : 0;
  };
  const activeRules = RULE_ORDER.filter(name => r.rules[name]?.active === true);
  const rules: ControllerDescription['rules'] = {};
  for (const name of activeRules) {
    rules[name] = {
      priority: rule(name).priority,
      parameters: { ...DEFAULT_ABR_SETTINGS.rules[name]?.parameters, ...rule(name).parameters },
    };
  }
  const isMin = c.arm === 'min';
  return {
    arm: c.arm,
    tickMs: CONTROLLER_CONSTANTS.tickMs,
    segmentDurationS: effectiveSegmentDurationS(c),
    swmaWindowGroups: CONTROLLER_CONSTANTS.swmaWindowGroups,
    bufferSource: isMin ? 'contiguous' : 'total',
    bufferSignal: c.bufferSignal,
    bufferEnvelopeMs: c.bufferEnvelopeMs,
    upDwellGroups: isMin ? c.upDwellGroups : 0,
    minStartupSamples: CONTROLLER_CONSTANTS.minStartupSamples,
    upGuardSamples: c.upGuardSamples,
    upGuardRelease: c.upGuardRelease,
    switchTimeoutMs: CONTROLLER_CONSTANTS.switchTimeoutMs,
    switchCooldownMs: CONTROLLER_CONSTANTS.switchCooldownMs,
    maxHistory: CONTROLLER_CONSTANTS.maxHistory,
    switchHistoryMode: rule('SwitchHistoryRule').active ? c.switchHistoryMode : 'off',
    switchHistoryWindowS: c.switchHistoryWindowS,
    switchHistorySampleSize: param('SwitchHistoryRule', 'sampleSize'),
    switchHistoryDropRatio: param('SwitchHistoryRule', 'switchPercentageThreshold'),
    historyIgnoreGroupsAfterLanding: c.historyIgnoreGroupsAfterLanding,
    bandwidthSafetyFactor: r.bandwidthSafetyFactor,
    throughputDownToLowest: param('ThroughputRule', 'downToLowest') > 0,
    minBitrate: r.minBitrate,
    maxBitrate: r.maxBitrate,
    emergencyLowBufferS: param('EmergencyBufferRule', 'lowBufferS'),
    emergencyThroughputSafetyFactor: param('EmergencyBufferRule', 'throughputSafetyFactor'),
    probeMode: c.probeMode,
    probeMinBytes: c.probeMinBytes,
    probeMinDurationMs: c.probeMinDurationMs,
    probeMaxBytes: c.probeMaxBytes,
    probeSafetyFactor: param('ProbeRule', 'safetyFactor'),
    probeIntervalMs: CONTROLLER_CONSTANTS.probeIntervalMs,
    probeDurationMs: CONTROLLER_CONSTANTS.probeDurationMs,
    probeFreshnessMs: CONTROLLER_CONSTANTS.probeFreshnessMs,
    probeHorizonS: CONTROLLER_CONSTANTS.probeHorizonS,
    latencyResetOnLanding: c.latencyResetOnLanding,
    latencyTrendThreshold: param('LatencyTrendRule', 'trendThreshold'),
    latencyTrendDeltaMs: param('LatencyTrendRule', 'trendDeltaMs'),
    bufferTimeDefault: r.bufferTimeDefault,
    stableBufferTime: r.stableBufferTime,
    activeRules,
    rules,
  };
}

export interface RulesContext {
  tracks: Track[];
  activeTrackIndex: number;
  /**
   * Buffer level the rules reason about: the *contiguous* buffer ahead of the
   * playhead (`player.getMetrics().bufferContigSeconds`, falling back to the
   * total `bufferSeconds` on players that do not expose it), either
   * instantaneous or its envelope over the last group
   * (ControllerSettings.bufferSignal). A hole ahead of the playhead is not
   * playable buffer (M12).
   */
  bufferSeconds: number;
  /** Instantaneous contiguous buffer at this tick, for the emergency rules. Defaults to bufferSeconds. */
  bufferInstantSeconds?: number;
  /** Total buffered-ahead across holes (last range end minus playhead), for the record only. */
  bufferTotalSeconds?: number;
  /** Completed groups since the last confirmed landing; null before the first landing. */
  groupsSinceLanding?: number | null;
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  droppedFrames: number;
  totalFrames: number;
  segmentDurationS: number;
  isLowLatency: boolean;
  /**
   * Current HTMLMediaElement playbackRate. Used by BufferDrainRateRule
   * to derive link rate from buffer drain via
   * `linkRate = sourceRate · (playbackRate - drainRate)`. Typically
   * 0.95–1.05 (the codebase nudges playback to track latency). 1.0 is a
   * safe default if a caller doesn't have it.
   */
  playbackRate: number;
  switchHistory: SwitchEvent[];
  abrSettings: AbrSettings;
  /**
   * Most recent active-probe bandwidth, bps. 0 if no fresh probe is
   * available. SWMA passive reads the publisher's push rate, so it never
   * exceeds the active source bitrate; this signal lets BOLA-O distinguish
   * "link saturated" from "publisher application-limited."
   */
  probeBandwidthBps: number;
  /**
   * Per-frame end-to-end latency trend, computed from PRFT (Producer
   * Reference Time) box at the head of each CMAF chunk. Defined as
   * mean(recent 50 samples) / mean(older 50 samples) over the last 100
   * frames (≈ 4 s at 25 fps). 1.0 = no change; > 1.20 is the thesis
   * downswitch trigger (Algorithm 1 lines 14-16).
   *
   * This is the raw capture-to-receipt ratio and is client-type dependent
   * (C6): a 10 s shift makes a 20 % rise a 2 s rise. LatencyTrendRule uses
   * it only when the half-window means below are absent.
   */
  latencyTrendRatio: number;
  /**
   * Mean capture-to-receipt latency (ms) over the recent half and the older
   * half of the latency window, as the player's LatencyTracker computes them.
   * With `targetShiftMs` LatencyTrendRule forms its ratio on
   * `mean − targetShiftMs`, the queueing component the two client types
   * share. Absent on players that only expose the ratio.
   */
  latencyRecentMeanMs?: number;
  latencyOlderMeanMs?: number;
  /**
   * The client's target shift behind the live edge (ms): 0 for a live-edge
   * client, delayGroups × GOP for a time-shifted one (`events/liveEdge.ts`
   * targetShiftMs). Absent → LatencyTrendRule falls back to an absolute rise
   * threshold (`trendDeltaMs`).
   */
  targetShiftMs?: number;
}

export interface AbrRule {
  readonly name: string;
  getMaxIndex(context: RulesContext): SwitchRequest | null;
  reset(): void;
}
