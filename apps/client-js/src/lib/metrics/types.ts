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
}

export interface MetricsSnapshot {
  samples: MetricsSample[];
  latest: MetricsSample | null;
}
