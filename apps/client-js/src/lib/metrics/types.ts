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
  /** video.currentTime in ms. */
  playheadMs: number;
  /** End of the last buffered range in ms. */
  bufferedEndMs: number;
  /** PRFT-derived estimate of (live edge − playhead), ms. NaN until a PRFT anchor exists. */
  liveEdgeDistanceMs: number;
  /** liveEdgeDistanceMs − target shift, ms (signed). NaN until a PRFT anchor exists. */
  timeShiftErrorMs: number;
  /** Most recent per-frame end-to-end latency, ms. */
  lastLatencyMs: number;
  activeTrack: string | null;
  /** Group the playhead is currently inside, from the TimeMap. */
  activeGroup: number | null;
}

export interface MetricsSnapshot {
  samples: MetricsSample[];
  latest: MetricsSample | null;
}
