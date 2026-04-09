import type { Player } from '@/lib/player';
import type { MetricsSample, MetricsSnapshot } from './types';

const MAX_SAMPLES = 240;
const INTERVAL_MS = 250;
/** Flush accumulated CSV rows to the server every N samples. */
const LOG_FLUSH_INTERVAL = 4; // every 1 second (4 * 250ms)

const CSV_HEADER =
  'timestamp,elapsed_s,buffer_s,bitrate_kbps,bandwidth_kbps,fast_ema_kbps,slow_ema_kbps,dropped_frames,total_frames,playback_rate,delivery_time_ms,live_edge_s,playback_time_s,live_offset_s,current_video_group,pending_switch_track,metadata_ready,metadata_delay_ms,switch_outcome,switch_from_track,switch_to_track,switch_requested_at_ms,switch_settled_at_ms,switch_duration_ms,switch_from_playback_s,switch_to_playback_s,switch_playback_delta_s,switch_from_live_offset_s,switch_to_live_offset_s,switch_live_offset_delta_s,switch_from_group,switch_to_group,switch_group_delta,switch_alignment_error_s';

export class MetricsCollector {
  readonly #player: Player;
  readonly #bitrateMap: Record<string, number>;
  readonly #onSnapshot: (snapshot: MetricsSnapshot) => void;
  readonly #samples: MetricsSample[] = [];
  readonly #allSamples: MetricsSample[] = [];
  /** Pending CSV rows not yet flushed to the log file. */
  readonly #pendingLogRows: string[] = [];
  #intervalId: ReturnType<typeof setInterval> | null = null;
  #sessionStartTs: number = 0;
  #sampleCount: number = 0;
  #headerSent: boolean = false;

  constructor(
    player: Player,
    bitrateMap: Record<string, number>,
    onSnapshot: (snapshot: MetricsSnapshot) => void,
  ) {
    this.#player = player;
    this.#bitrateMap = bitrateMap;
    this.#onSnapshot = onSnapshot;
  }

  start(): void {
    if (this.#intervalId !== null) return;
    this.#sessionStartTs = Date.now();
    this.#intervalId = setInterval(() => this.#sample(), INTERVAL_MS);
  }

  stop(): void {
    if (this.#intervalId === null) return;
    clearInterval(this.#intervalId);
    this.#intervalId = null;
  }

  getSnapshot(): MetricsSnapshot {
    const samples = [...this.#samples];
    return {
      samples,
      latest: samples.length > 0 ? (samples[samples.length - 1] ?? null) : null,
    };
  }

  #sample(): void {
    const m = this.#player.getMetrics();
    const sample: MetricsSample = {
      ts: Date.now(),
      bufferSeconds: m.bufferSeconds,
      bitrateKbps: m.activeTrack !== null ? (this.#bitrateMap[m.activeTrack] ?? 0) : 0,
      bandwidthBps: m.bandwidthBps,
      fastEmaBps: m.fastEmaBps,
      slowEmaBps: m.slowEmaBps,
      droppedFrames: m.droppedFrames,
      totalFrames: m.totalFrames,
      playbackRate: m.playbackRate,
      deliveryTimeMs: m.deliveryTimeMs,
      liveEdgeTime: m.liveEdgeTime,
      playbackTime: m.playbackTime,
      liveOffsetSeconds: m.liveOffsetSeconds,
      currentVideoGroup: m.currentVideoGroup,
      pendingSwitchTrack: m.pendingSwitchTrack,
      metadataReady: m.metadataReady,
      metadataDelayMs: m.metadataDelayMs,
      switchOutcome: m.switchOutcome,
      switchFromTrack: m.switchFromTrack,
      switchToTrack: m.switchToTrack,
      switchRequestedAtMs: m.switchRequestedAtMs,
      switchSettledAtMs: m.switchSettledAtMs,
      switchDurationMs: m.switchDurationMs,
      switchFromPlaybackTime: m.switchFromPlaybackTime,
      switchToPlaybackTime: m.switchToPlaybackTime,
      switchPlaybackDeltaSeconds: m.switchPlaybackDeltaSeconds,
      switchFromLiveOffsetSeconds: m.switchFromLiveOffsetSeconds,
      switchToLiveOffsetSeconds: m.switchToLiveOffsetSeconds,
      switchLiveOffsetDeltaSeconds: m.switchLiveOffsetDeltaSeconds,
      switchFromGroup: m.switchFromGroup,
      switchToGroup: m.switchToGroup,
      switchGroupDelta: m.switchGroupDelta,
      switchAlignmentErrorSeconds: m.switchAlignmentErrorSeconds,
    };

    this.#samples.push(sample);
    if (this.#samples.length > MAX_SAMPLES) {
      this.#samples.shift();
    }

    this.#allSamples.push(sample);
    this.#pendingLogRows.push(this.#sampleToCsvRow(sample));
    this.#sampleCount++;

    if (this.#sampleCount % LOG_FLUSH_INTERVAL === 0) {
      this.#flushToServer();
    }

    this.#onSnapshot(this.getSnapshot());
  }

  #sampleToCsvRow(s: MetricsSample): string {
    const elapsed = ((s.ts - this.#sessionStartTs) / 1000).toFixed(3);
    return [
      new Date(s.ts).toISOString(),
      elapsed,
      s.bufferSeconds.toFixed(3),
      s.bitrateKbps.toFixed(0),
      (s.bandwidthBps / 1000).toFixed(1),
      (s.fastEmaBps / 1000).toFixed(1),
      (s.slowEmaBps / 1000).toFixed(1),
      s.droppedFrames,
      s.totalFrames,
      s.playbackRate.toFixed(4),
      s.deliveryTimeMs.toFixed(1),
      this.#formatOptionalNumber(s.liveEdgeTime, 3),
      this.#formatOptionalNumber(s.playbackTime, 3),
      this.#formatOptionalNumber(s.liveOffsetSeconds, 3),
      s.currentVideoGroup ?? '',
      s.pendingSwitchTrack ?? '',
      s.metadataReady ? '1' : '0',
      s.metadataDelayMs.toFixed(1),
      s.switchOutcome,
      s.switchFromTrack ?? '',
      s.switchToTrack ?? '',
      this.#formatOptionalNumber(s.switchRequestedAtMs, 0),
      this.#formatOptionalNumber(s.switchSettledAtMs, 0),
      this.#formatOptionalNumber(s.switchDurationMs, 1),
      this.#formatOptionalNumber(s.switchFromPlaybackTime, 3),
      this.#formatOptionalNumber(s.switchToPlaybackTime, 3),
      this.#formatOptionalNumber(s.switchPlaybackDeltaSeconds, 3),
      this.#formatOptionalNumber(s.switchFromLiveOffsetSeconds, 3),
      this.#formatOptionalNumber(s.switchToLiveOffsetSeconds, 3),
      this.#formatOptionalNumber(s.switchLiveOffsetDeltaSeconds, 3),
      s.switchFromGroup ?? '',
      s.switchToGroup ?? '',
      this.#formatOptionalNumber(s.switchGroupDelta, 0),
      this.#formatOptionalNumber(s.switchAlignmentErrorSeconds, 3),
    ].join(',');
  }

  #formatOptionalNumber(value: number | null, fractionDigits: number): string {
    return value === null ? '' : value.toFixed(fractionDigits);
  }

  #flushToServer(): void {
    if (this.#pendingLogRows.length === 0) return;

    const rows = this.#pendingLogRows.splice(0);
    const body = this.#headerSent ? rows.join('\n') : [CSV_HEADER, ...rows].join('\n');
    this.#headerSent = true;

    // Fire-and-forget — don't block the sampling loop
    fetch('/__metrics', { method: 'POST', body }).catch(() => {
      // Dev server not available (e.g. production build) — silently ignore
    });
  }

  exportCsv(): string {
    const rows = this.#allSamples.map(s => this.#sampleToCsvRow(s));
    return [CSV_HEADER, ...rows].join('\n');
  }
}
