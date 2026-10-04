export interface MetricsSample {
  ts: number;
  /** Last buffered range end minus playhead (across holes), s. */
  bufferSeconds: number;
  /** End of the range containing the playhead minus playhead, 0 if none (M12), s. */
  bufferContigSeconds: number;
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
  /** Subscribed track (switches at the landing). */
  activeTrack: string | null;
  /** Track whose media is at the playhead (switches at the seam, M13). */
  presentedTrack: string | null;
  /** Group the playhead is currently inside, from the TimeMap. */
  activeGroup: number | null;
}

export interface MetricsSnapshot {
  samples: MetricsSample[];
  latest: MetricsSample | null;
}
