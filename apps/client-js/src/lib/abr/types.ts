export type Track = {
  name: string;
  bitrate?: number;
  role?: string;
  codec?: string;
  width?: number;
  height?: number;
  framerate?: number;
};

export type SwitchReason = 'auto-upgrade' | 'auto-downgrade' | 'auto-emergency' | 'manual';

export interface SwitchEvent {
  ts: number;
  fromTrack: string;
  toTrack: string;
  reason: SwitchReason;
  bufferAtSwitch: number;
  emaBwAtSwitch: number;
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
 * Controller stabilisation parameters. Every one of them is off in the
 * defaults (the baseline controller); the experiment runner turns them on per
 * ablation arm and records them in RUN_META. They are deliberately separate
 * knobs: the probe fix addresses noisy link estimates on small rung gaps, the
 * post-switch up-guard addresses control-loop frequency.
 */
export interface ControllerSettings {
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
  probeMinBytes: 0,
  probeMinDurationMs: 0,
  upGuardSamples: 0,
  upGuardRelease: 'landed',
  latencyResetOnLanding: false,
  switchHistoryMode: 'evict',
  bufferSignal: 'instant',
  bufferEnvelopeMs: 1250,
  switchHistoryWindowS: 0,
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
    ThroughputRule: { active: true, priority: SwitchRequestPriority.DEFAULT, parameters: {} },
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
      parameters: { trendThreshold: 1.2 },
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
  },
};

export interface RulesContext {
  tracks: Track[];
  activeTrackIndex: number;
  /** Buffer level the rules reason about (instantaneous, or the group envelope; ControllerSettings.bufferSignal). */
  bufferSeconds: number;
  /** Instantaneous buffered-ahead at this tick, for the empty-buffer emergency. Defaults to bufferSeconds. */
  bufferInstantSeconds?: number;
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
   */
  latencyTrendRatio: number;
}

export interface AbrRule {
  readonly name: string;
  getMaxIndex(context: RulesContext): SwitchRequest | null;
  reset(): void;
}
