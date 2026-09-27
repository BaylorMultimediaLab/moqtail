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
}

export const DEFAULT_CONTROLLER_SETTINGS: ControllerSettings = {
  probeMinBytes: 0,
  probeMinDurationMs: 0,
  upGuardSamples: 0,
  upGuardRelease: 'landed',
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
  bufferSeconds: number;
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
