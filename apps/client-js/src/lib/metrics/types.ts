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
  liveEdgeTime: number | null;
  playbackTime: number | null;
  liveOffsetSeconds: number | null;
  currentVideoGroup: string | null;
  pendingSwitchTrack: string | null;
  metadataReady: boolean;
  metadataDelayMs: number;
  switchOutcome: 'idle' | 'pending' | 'success' | 'rejected' | 'error';
  switchFromTrack: string | null;
  switchToTrack: string | null;
  switchRequestedAtMs: number | null;
  switchSettledAtMs: number | null;
  switchDurationMs: number | null;
  switchFromPlaybackTime: number | null;
  switchToPlaybackTime: number | null;
  switchPlaybackDeltaSeconds: number | null;
  switchFromLiveOffsetSeconds: number | null;
  switchToLiveOffsetSeconds: number | null;
  switchLiveOffsetDeltaSeconds: number | null;
  switchFromGroup: string | null;
  switchToGroup: string | null;
  switchGroupDelta: number | null;
  switchAlignmentErrorSeconds: number | null;
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
