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
