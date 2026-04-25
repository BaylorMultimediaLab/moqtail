export interface MetricsSample {
  ts: number;
  bufferSeconds: number;
  bitrateKbps: number;
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  droppedFrames: number;
  totalFrames: number;
  playbackRate: number;
  deliveryTimeMs: number;
  // Catchup-controller telemetry (populated only when an MSEBuffer is attached)
  catchupMode: string;
  targetDelayS: number;
  liveOffsetS: number;
  computedRate: number;
  hardOverrideFired: boolean;
  overrideType: string;
  rateResetCount: number;
  seekForRecoveryCount: number;
  /** Researcher-supplied label for the current experiment condition. */
  experimentLabel: string;
  /** Cumulative count of ABR track switches since playback started. */
  trackSwitchCount: number;
}

export interface MetricsSnapshot {
  samples: MetricsSample[];
  latest: MetricsSample | null;
}
