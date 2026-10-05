import type { Player } from '@/lib/player';
import { events } from '@/lib/events/EventLog';
import type { MetricsSample, MetricsSnapshot } from './types';

const MAX_SAMPLES = 240;
const INTERVAL_MS = 250;

/**
 * Samples the player every 250 ms: one SAMPLE event per tick (the experiment
 * record) and a bounded ring for the UI charts.
 */

export class MetricsCollector {
  readonly #player: Player;
  readonly #bitrateMap: Record<string, number>;
  readonly #onSnapshot: (snapshot: MetricsSnapshot) => void;
  readonly #samples: MetricsSample[] = [];
  #intervalId: ReturnType<typeof setInterval> | null = null;

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
      bufferContigSeconds: m.bufferContigSeconds,
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
      presentedTrack: m.presentedTrack,
      activeGroup: m.activeGroup,
    };

    events.emit('SAMPLE', {
      buffer_s: sample.bufferSeconds,
      buffer_contig_s: sample.bufferContigSeconds,
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
      presented_track: sample.presentedTrack,
      group: sample.activeGroup,
      ready_state: m.readyState,
      paused: m.paused,
      ended: m.ended,
      buffered_ranges: m.bufferedRanges,
      watchdog_ticks: m.watchdogTicks,
      frozen_ticks: m.frozenTicks,
    });

    this.#samples.push(sample);
    if (this.#samples.length > MAX_SAMPLES) {
      this.#samples.shift();
    }

    this.#onSnapshot(this.getSnapshot());
  }
}
