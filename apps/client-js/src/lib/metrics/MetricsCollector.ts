import type { Player } from '@/lib/player';
import { events } from '@/lib/events/EventLog';
import type { MetricsSample, MetricsSnapshot } from './types';

const MAX_SAMPLES = 240;
const INTERVAL_MS = 250;
/** Flush accumulated CSV rows to the server every N samples. */
const LOG_FLUSH_INTERVAL = 4; // every 1 second (4 * 250ms)

const CSV_HEADER =
  'timestamp,elapsed_s,buffer_s,bitrate_kbps,bandwidth_kbps,fast_ema_kbps,slow_ema_kbps,dropped_frames,total_frames,playback_rate,delivery_time_ms,' +
  'playhead_ms,buffered_end_ms,live_edge_distance_ms,time_shift_error_ms,last_latency_ms,active_track,active_group';

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
      playheadMs: m.playheadMs,
      bufferedEndMs: m.bufferedEndMs,
      liveEdgeDistanceMs: m.liveEdgeDistanceMs,
      timeShiftErrorMs: m.timeShiftErrorMs,
      lastLatencyMs: m.lastLatencyMs,
      activeTrack: m.activeTrack,
      activeGroup: m.activeGroup,
    };

    events.emit('SAMPLE', {
      buffer_s: sample.bufferSeconds,
      bitrate_kbps: sample.bitrateKbps,
      bandwidth_bps: sample.bandwidthBps,
      fast_ema_bps: sample.fastEmaBps,
      slow_ema_bps: sample.slowEmaBps,
      dropped_frames: sample.droppedFrames,
      total_frames: sample.totalFrames,
      playback_rate: sample.playbackRate,
      delivery_time_ms: sample.deliveryTimeMs,
      playhead_ms: sample.playheadMs,
      buffered_end_ms: sample.bufferedEndMs,
      live_edge_distance_ms: Number.isFinite(sample.liveEdgeDistanceMs)
        ? sample.liveEdgeDistanceMs
        : null,
      time_shift_error_ms: Number.isFinite(sample.timeShiftErrorMs)
        ? sample.timeShiftErrorMs
        : null,
      last_latency_ms: sample.lastLatencyMs,
      track: sample.activeTrack,
      group: sample.activeGroup,
      ready_state: m.readyState,
      paused: m.paused,
    });

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
      s.playheadMs.toFixed(1),
      s.bufferedEndMs.toFixed(1),
      Number.isFinite(s.liveEdgeDistanceMs) ? s.liveEdgeDistanceMs.toFixed(1) : '',
      Number.isFinite(s.timeShiftErrorMs) ? s.timeShiftErrorMs.toFixed(1) : '',
      s.lastLatencyMs.toFixed(1),
      s.activeTrack ?? '',
      s.activeGroup ?? '',
    ].join(',');
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
