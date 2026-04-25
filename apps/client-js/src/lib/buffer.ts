/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { logger } from '@/lib/logger';

// MSE Buffer Configuration
export const MSE_IMMEDIATE_SEEK_THRESHOLD = 0.1; // seconds
export const DEFAULT_LIVE_EDGE_DELAY = 1.25; // seconds
export const DEFAULT_LIVE_EDGE_TOLERANCE = 0.1; // seconds
export const DEFAULT_BUFFER_CHECK_INTERVAL = 250; // milliseconds
export const DEFAULT_STALL_THRESHOLD = 0.5; // seconds
export const DEFAULT_CATCHUP_PLAYBACK_RATE = 1.05; // 5% faster
export const DEFAULT_CATCHUP_RATE_DELTA = DEFAULT_CATCHUP_PLAYBACK_RATE - 1;

export type CatchupControllerMode = 'none' | 'sigmoid' | 'exponential' | 'linear' | 'step' | 'pid';

export interface CatchupControllerSettings {
  /** Catchup algorithm for translating latency drift to playback-rate changes. */
  mode: CatchupControllerMode;
  /** Max positive delta from 1.0x (0..1). */
  maxRateUp: number;
  /** Max negative delta from 1.0x (0..0.5). */
  maxRateDown: number;
  /** If drift exceeds this, seek to target live distance instead of changing playback rate. */
  maxDriftSeconds: number;
  /** If absolute drift exceeds this threshold, reset playback rate to 1.0x. */
  liveThresholdSeconds: number;
  /** If stalled recently and current latency is below liveDelay/2, force 1.0x. */
  stallLookbackSeconds: number;
  /** Optional fixed minimum-change threshold; NaN enables adaptive behavior. */
  minChangeThreshold: number;
  /** Linear controller gain. */
  linearGain: number;
  /** Exponential decay factor. */
  expK: number;
  /** Step controller dead-zone in seconds. */
  stepDeltaSeconds: number;
  /** PID parameters. */
  pidKp: number;
  pidKi: number;
  pidKd: number;
}

export const DEFAULT_CATCHUP_CONTROLLER_SETTINGS: CatchupControllerSettings = {
  mode: 'sigmoid',
  maxRateUp: DEFAULT_CATCHUP_RATE_DELTA,
  maxRateDown: DEFAULT_CATCHUP_RATE_DELTA,
  maxDriftSeconds: 3,
  liveThresholdSeconds: 6,
  stallLookbackSeconds: 1.5,
  minChangeThreshold: Number.NaN,
  linearGain: 0.2,
  expK: 1.6,
  stepDeltaSeconds: 0.25,
  pidKp: 0.2,
  pidKi: 0.05,
  pidKd: 0.1,
};

/** Per-tick snapshot exposed to MetricsCollector for CSV logging. */
export interface CatchupTelemetry {
  /** Active controller algorithm name. */
  catchupMode: string;
  /** Configured target live-edge delay in seconds. */
  targetDelayS: number;
  /** Actual measured live offset (buffer-edge minus currentTime) in seconds. */
  liveOffsetS: number;
  /** Playback rate computed by the algorithm this tick (before min-change guard). */
  computedRate: number;
  /** Whether a hard override fired this tick. */
  hardOverrideFired: boolean;
  /** Which override fired: 'seek' | 'liveThreshold' | 'stall' | 'tolerance' | '' */
  overrideType: string;
  /** Cumulative count of times playback rate was reset to 1.0x. */
  rateResetCount: number;
  /** Cumulative count of seeks triggered by maxDrift. */
  seekForRecoveryCount: number;
}

export interface MSEBufferInitConfig extends Omit<Partial<MSEBufferConfig>, 'catchup'> {
  catchup?: Partial<CatchupControllerSettings>;
}

interface MSEBufferConfig {
  /** Delay from live edge in seconds (default: 1.25) */
  liveEdgeDelay: number;
  /** Tolerance for live edge in seconds (default: 0.1) */
  liveEdgeTolerance: number;
  /** Interval for checking buffered regions in milliseconds (default: 250) */
  bufferCheckInterval: number;
  /** Threshold for detecting stalls in seconds (default: 0.5) */
  stallThreshold: number;
  /** Playback rate for catching up to live edge (default: 1.05 = 5% faster) */
  catchupPlaybackRate: number;
  /** Catchup controller configuration inspired by dash.js CatchupController behavior. */
  catchup: CatchupControllerSettings;
}

class MSEBuffer {
  private config: MSEBufferConfig;
  private bufferCheckInterval: number | null = null;
  private isDisposed: boolean = false;
  private isCatchingUp: boolean = false;
  private isCatchingDown: boolean = false;
  private originalPlaybackRate: number = 1.0;
  private lastStallAtMs: number = 0;
  private pidIntegralError: number = 0;
  private pidLastDelta: number = 0;
  private readonly isSafari: boolean;
  private rateResetCount: number = 0;
  private seekForRecoveryCount: number = 0;
  private lastTelemetry: CatchupTelemetry = {
    catchupMode: 'sigmoid',
    targetDelayS: DEFAULT_LIVE_EDGE_DELAY,
    liveOffsetS: 0,
    computedRate: 1,
    hardOverrideFired: false,
    overrideType: '',
    rateResetCount: 0,
    seekForRecoveryCount: 0,
  };

  constructor(
    public video: HTMLVideoElement,
    config: MSEBufferInitConfig = {},
  ) {
    const mergedCatchup = {
      ...DEFAULT_CATCHUP_CONTROLLER_SETTINGS,
      ...config.catchup,
    };

    this.config = {
      liveEdgeDelay: DEFAULT_LIVE_EDGE_DELAY,
      liveEdgeTolerance: DEFAULT_LIVE_EDGE_TOLERANCE,
      bufferCheckInterval: DEFAULT_BUFFER_CHECK_INTERVAL,
      stallThreshold: DEFAULT_STALL_THRESHOLD,
      catchupPlaybackRate: DEFAULT_CATCHUP_PLAYBACK_RATE,
      ...config,
      catchup: mergedCatchup,
    };

    // Preserve backward compatibility: if old catchupPlaybackRate is set,
    // keep the controller caps aligned unless explicitly overridden.
    if (config.catchup?.maxRateUp === undefined || config.catchup?.maxRateDown === undefined) {
      const legacyDelta = Math.max(0, this.config.catchupPlaybackRate - 1);
      this.config.catchup.maxRateUp = config.catchup?.maxRateUp ?? legacyDelta;
      this.config.catchup.maxRateDown = config.catchup?.maxRateDown ?? legacyDelta;
    }

    const ua = navigator.userAgent;
    this.isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua);

    this.init();
  }

  /** Returns a snapshot of the last catchup-controller tick for metrics logging. */
  getCatchupTelemetry(): CatchupTelemetry {
    return { ...this.lastTelemetry };
  }

  updateConfig(config: MSEBufferInitConfig): void {
    const prevInterval = this.config.bufferCheckInterval;

    this.config = {
      ...this.config,
      ...config,
      catchup: {
        ...this.config.catchup,
        ...config.catchup,
      },
    };

    if (config.catchupPlaybackRate !== undefined) {
      const legacyDelta = Math.max(0, config.catchupPlaybackRate - 1);
      if (config.catchup?.maxRateUp === undefined) this.config.catchup.maxRateUp = legacyDelta;
      if (config.catchup?.maxRateDown === undefined) {
        this.config.catchup.maxRateDown = legacyDelta;
      }
    }

    if (this.config.bufferCheckInterval !== prevInterval && !document.hidden) {
      this.startBufferMonitoring();
    }

    if (config.catchup?.mode !== undefined) {
      this.pidIntegralError = 0;
      this.pidLastDelta = 0;
    }
  }

  private init() {
    // Attach event listeners
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('waiting', this.handleWaiting);
    this.video.addEventListener('stalled', this.handleStalled);

    // Listen tab visibility changes
    document.addEventListener('visibilitychange', this.handleTabChange);

    // Start periodic buffer checking
    this.startBufferMonitoring();
  }

  private handleTabChange = () => {
    if (document.hidden) {
      // Tab is hidden, pause monitoring
      if (this.bufferCheckInterval) {
        clearInterval(this.bufferCheckInterval);
        this.bufferCheckInterval = null;
      }
    } else {
      // Calculate the live edge
      const buffered = this.video.buffered;
      if (buffered.length > 0) {
        logger.info('buffer', '[mseBuffer] Tab became visible, seeking to live edge');
        const liveEdge = buffered.end(buffered.length - 1);
        this.seek(
          Math.max(liveEdge - this.config.liveEdgeDelay, buffered.start(buffered.length - 1)),
        );
        this.video.playbackRate = this.originalPlaybackRate;
        this.isCatchingUp = false;
        this.video.play();
      }

      // Tab is visible, resume monitoring
      this.startBufferMonitoring();
    }
  };

  private handlePause = () => {
    logger.info('buffer', '[mseBuffer] Video is paused');
    this.resetPlaybackRate();
  };

  private handlePlay = () => {
    logger.info('buffer', '[mseBuffer] Video is playing');
    this.originalPlaybackRate = this.video.playbackRate;
  };

  private handleWaiting = () => {
    logger.info('buffer', '[mseBuffer] Video is waiting for data');
    this.lastStallAtMs = Date.now();
    this.checkBufferedRegions();
  };

  private handleStalled = () => {
    logger.info('buffer', '[mseBuffer] Video stalled event fired');
    this.lastStallAtMs = Date.now();
    this.checkBufferedRegions();
  };

  private startBufferMonitoring() {
    if (this.bufferCheckInterval) {
      clearInterval(this.bufferCheckInterval);
    }

    this.bufferCheckInterval = window.setInterval(() => {
      if (this.isDisposed) return;
      this.periodicBufferCheck();
    }, this.config.bufferCheckInterval);
  }

  private periodicBufferCheck() {
    // Check for live streams: either Infinity duration or MediaSource-backed (no finite duration set)
    if (this.video.duration && isFinite(this.video.duration) && this.video.duration > 0) {
      return; // VOD stream with known duration — skip live edge management
    }

    this.checkBufferedRegions(false);
  }

  private checkBufferedRegions(logDetails: boolean = true) {
    const buffered = this.video.buffered;
    const currentTime = this.video.currentTime;

    if (buffered.length === 0) {
      logger.info('buffer', '[mseBuffer] No buffered data available');
      return;
    }

    if (logDetails) {
      logger.info('buffer', '[mseBuffer] Checking buffered regions:');
      for (let i = 0; i < buffered.length; i++) {
        const start = buffered.start(i);
        const end = buffered.end(i);
        logger.info(
          'buffer',
          `[mseBuffer]   Range ${i}: ${start.toFixed(2)}s - ${end.toFixed(2)}s`,
        );
      }
    }

    // Check if we're at the end of a buffer range and need to jump to the next one
    const shouldSeek = this.shouldSeekToNextRange(currentTime, buffered);

    if (shouldSeek.seek) {
      logger.info(
        'buffer',
        `[mseBuffer] At end of range, seeking to next buffered range: ${shouldSeek.targetTime!.toFixed(2)}s`,
      );

      // Perform the seek, only if targetTime is ahead of currentTime
      if (shouldSeek.targetTime <= currentTime) return;
      this.seek(shouldSeek.targetTime);

      // Resume the video if it was paused
      if (this.video.paused) {
        this.video
          .play()
          .then(() => {
            logger.info('buffer', '[mseBuffer] Video was paused and now playing...');
          })
          .catch(e => {
            logger.warn('buffer', '[mseBuffer] Video was paused and could not play it...', e);
          });
      }
    } else {
      // For live streams, check if we need to catch up to live edge
      if (!isFinite(this.video.duration)) this.maintainLiveEdgeDelay();
    }
  }

  private shouldSeekToNextRange(
    currentTime: number,
    buffered: TimeRanges,
  ): { seek: true; targetTime: number } | { seek: false } {
    // If no buffered ranges, cannot seek
    if (buffered.length === 0) return { seek: false };

    // Find which buffered range we're currently in (if any)
    let currentRangeIndex = -1;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      if (currentTime >= start && currentTime <= end) {
        currentRangeIndex = i;
        break;
      }
    }

    // If we're not in any buffered range, find the nearest one to seek to
    if (currentRangeIndex === -1) {
      logger.warn('buffer', '[mseBuffer] Current time is not in any buffered range');
      return this.findNearestBufferedRange(currentTime, buffered);
    }

    // Check if we're close to the end of the current range
    const currentRangeEnd = buffered.end(currentRangeIndex);
    const distanceToEnd = currentRangeEnd - currentTime;

    // Only consider seeking if we're very close to the end (within threshold)
    if (distanceToEnd > this.config.stallThreshold) return { seek: false };

    // Check if there's a next buffered range
    if (currentRangeIndex + 1 < buffered.length) {
      for (let nextRange = currentRangeIndex + 1; nextRange < buffered.length; nextRange++) {
        const nextRangeStart = buffered.start(currentRangeIndex + 1);
        const gap = nextRangeStart - currentRangeEnd;

        // If gap is too small, seek to next range immediately
        if (gap < MSE_IMMEDIATE_SEEK_THRESHOLD) {
          logger.info(
            'buffer',
            `[mseBuffer] Small gap of ${gap.toFixed(3)}s to next range, seeking immediately`,
          );
          return { seek: true, targetTime: nextRangeStart };
        }

        // Next range must have enough buffer to jump to
        const nextRangeEnd = buffered.end(currentRangeIndex + 1);
        const nextRangeDuration = nextRangeEnd - nextRangeStart;

        if (nextRangeDuration < this.config.stallThreshold) {
          logger.warn(
            'buffer',
            `[mseBuffer] Next range too short (${nextRangeDuration.toFixed(3)}s), not seeking`,
          );
          continue;
        }

        if (nextRangeDuration < this.config.liveEdgeDelay) {
          logger.warn(
            'buffer',
            `[mseBuffer] Next range shorter than live edge delay (${nextRangeDuration.toFixed(
              3,
            )}s < ${this.config.liveEdgeDelay}s), not seeking`,
          );
          continue;
        }

        if (gap > 0) {
          logger.warn(
            'buffer',
            `[mseBuffer] At buffer end with gap of ${gap.toFixed(3)}s, must jump to next range`,
          );
          return { seek: true, targetTime: nextRangeStart };
        }
      }
    }

    return { seek: false };
  }

  private findNearestBufferedRange(
    currentTime: number,
    buffered: TimeRanges,
  ): { seek: true; targetTime: number } | { seek: false } {
    if (buffered.length === 0) {
      return { seek: false };
    }

    // For live streams, prefer the most recent buffered range
    if (!isFinite(this.video.duration)) {
      const lastRangeIndex = buffered.length - 1;
      const targetTime = Math.max(
        buffered.start(lastRangeIndex),
        buffered.end(lastRangeIndex) - this.config.liveEdgeDelay,
      );
      return { seek: true, targetTime };
    }

    // For VOD, find the closest buffered range
    let bestTarget = buffered.start(0);
    let minDistance = Math.abs(currentTime - bestTarget);

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);

      // Check distance to start of range
      const distanceToStart = Math.abs(currentTime - start);
      if (distanceToStart < minDistance) {
        minDistance = distanceToStart;
        bestTarget = start;
      }

      // Check distance to end of range
      const distanceToEnd = Math.abs(currentTime - end);
      if (distanceToEnd < minDistance) {
        minDistance = distanceToEnd;
        bestTarget = end;
      }
    }

    return { seek: true, targetTime: bestTarget };
  }

  private maintainLiveEdgeDelay() {
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;

    // Get the end of the last buffered range (live edge)
    const bufferEdge = buffered.end(buffered.length - 1);
    const currentLatency = bufferEdge - this.video.currentTime;
    const targetDistance = this.config.liveEdgeDelay;
    const deltaLatency = currentLatency - targetDistance;
    const absDelta = Math.abs(deltaLatency);

    // Reset per-tick telemetry fields (counters stay cumulative).
    this.lastTelemetry.catchupMode = this.config.catchup.mode;
    this.lastTelemetry.targetDelayS = targetDistance;
    this.lastTelemetry.liveOffsetS = currentLatency;
    this.lastTelemetry.hardOverrideFired = false;
    this.lastTelemetry.overrideType = '';

    // Hard override: if too far behind, abandon rate-adjustment and seek.
    if (deltaLatency > this.config.catchup.maxDriftSeconds) {
      const targetSeekTime = Math.max(
        buffered.start(buffered.length - 1),
        bufferEdge - targetDistance,
      );
      logger.info(
        'buffer',
        `[mseBuffer] Drift ${deltaLatency.toFixed(2)}s exceeds maxDrift ${this.config.catchup.maxDriftSeconds.toFixed(2)}s, seeking to ${targetSeekTime.toFixed(2)}s`,
      );
      this.seekForRecoveryCount++;
      this.lastTelemetry.seekForRecoveryCount = this.seekForRecoveryCount;
      this.lastTelemetry.hardOverrideFired = true;
      this.lastTelemetry.overrideType = 'seek';
      this.lastTelemetry.computedRate = 1;
      this.seek(targetSeekTime);
      this.resetPlaybackRate();
      return;
    }

    // Hard override: if drift too large in either direction, avoid aggressive changes.
    if (absDelta > this.config.catchup.liveThresholdSeconds) {
      this.lastTelemetry.hardOverrideFired = true;
      this.lastTelemetry.overrideType = 'liveThreshold';
      this.lastTelemetry.computedRate = 1;
      this.resetPlaybackRate();
      return;
    }

    // Hard override: avoid speeding up after a fresh stall while buffer is shallow.
    const recentlyStalled =
      this.lastStallAtMs > 0 &&
      Date.now() - this.lastStallAtMs <= this.config.catchup.stallLookbackSeconds * 1000;
    if (recentlyStalled && currentLatency < targetDistance / 2) {
      this.lastTelemetry.hardOverrideFired = true;
      this.lastTelemetry.overrideType = 'stall';
      this.lastTelemetry.computedRate = 1;
      this.resetPlaybackRate();
      return;
    }

    // Within tolerance, converge to 1.0x.
    if ((this.isCatchingUp || this.isCatchingDown) && absDelta < this.config.liveEdgeTolerance) {
      this.lastTelemetry.hardOverrideFired = true;
      this.lastTelemetry.overrideType = 'tolerance';
      this.lastTelemetry.computedRate = 1;
      this.resetPlaybackRate();
      return;
    }

    const desiredRate = this.computeCatchupRate(deltaLatency);
    this.lastTelemetry.computedRate = desiredRate;

    const maxDelta = Math.max(this.config.catchup.maxRateUp, this.config.catchup.maxRateDown, 0.01);
    const adaptiveMinChange = this.isSafari ? 0.25 : 0.02 / (0.5 / maxDelta);
    const minChange = Number.isFinite(this.config.catchup.minChangeThreshold)
      ? this.config.catchup.minChangeThreshold
      : adaptiveMinChange;

    if (Math.abs(desiredRate - this.video.playbackRate) < minChange) {
      return;
    }

    if (Math.abs(desiredRate - 1) <= 0.0001) {
      this.resetPlaybackRate();
      return;
    }

    this.video.playbackRate = desiredRate;
    this.isCatchingUp = desiredRate > 1;
    this.isCatchingDown = desiredRate < 1;

    logger.info(
      'buffer',
      `[mseBuffer] Catchup (${this.config.catchup.mode}) drift=${deltaLatency.toFixed(3)}s latency=${currentLatency.toFixed(3)}s target=${targetDistance.toFixed(3)}s rate=${desiredRate.toFixed(3)}x`,
    );
  }

  private clampRate(rate: number): number {
    const minRate = 1 - this.config.catchup.maxRateDown;
    const maxRate = 1 + this.config.catchup.maxRateUp;
    return Math.max(minRate, Math.min(maxRate, rate));
  }

  private computeCatchupRate(deltaLatency: number): number {
    const absDelta = Math.abs(deltaLatency);
    if (absDelta <= this.config.liveEdgeTolerance) return 1;

    const direction = deltaLatency >= 0 ? 1 : -1;
    const cap = direction > 0 ? this.config.catchup.maxRateUp : this.config.catchup.maxRateDown;

    switch (this.config.catchup.mode) {
      case 'none':
        return 1;
      case 'sigmoid': {
        // dash.js-inspired bounded sigmoid curve.
        const d = deltaLatency * 5;
        const newRate = 1 - cap + (cap * 2) / (1 + Math.exp(-d));
        return this.clampRate(newRate);
      }
      case 'exponential': {
        const gain = cap * (1 - Math.exp(-this.config.catchup.expK * absDelta));
        return this.clampRate(1 + direction * gain);
      }
      case 'linear': {
        const gain = Math.min(cap, this.config.catchup.linearGain * absDelta);
        return this.clampRate(1 + direction * gain);
      }
      case 'step': {
        if (absDelta < this.config.catchup.stepDeltaSeconds) return 1;
        return this.clampRate(1 + direction * cap);
      }
      case 'pid': {
        const dt = Math.max(this.config.bufferCheckInterval / 1000, 0.001);
        this.pidIntegralError = Math.max(
          -10,
          Math.min(10, this.pidIntegralError + deltaLatency * dt),
        );
        const derivative = (deltaLatency - this.pidLastDelta) / dt;
        this.pidLastDelta = deltaLatency;

        const control =
          this.config.catchup.pidKp * deltaLatency +
          this.config.catchup.pidKi * this.pidIntegralError +
          this.config.catchup.pidKd * derivative;

        const clipped = direction > 0 ? Math.min(cap, control) : Math.max(-cap, control);
        return this.clampRate(1 + clipped);
      }
      default:
        return 1;
    }
  }

  private resetPlaybackRate() {
    if (
      this.isCatchingUp ||
      this.isCatchingDown ||
      this.video.playbackRate !== this.originalPlaybackRate
    ) {
      this.video.playbackRate = this.originalPlaybackRate;
      this.isCatchingUp = false;
      this.isCatchingDown = false;
      this.rateResetCount++;
      this.lastTelemetry.rateResetCount = this.rateResetCount;
      logger.info('buffer', `[mseBuffer] Playback rate reset to ${this.originalPlaybackRate}x`);
    }
  }

  private seek(time: number) {
    this.video.currentTime = time;
  }

  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;

    // Reset playback rate before disposing
    this.resetPlaybackRate();

    // Remove event listeners
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('stalled', this.handleStalled);

    // Remove tab visibility listener
    document.removeEventListener('visibilitychange', this.handleTabChange);

    // Clear interval
    if (this.bufferCheckInterval) {
      clearInterval(this.bufferCheckInterval);
      this.bufferCheckInterval = null;
    }
  }
}

export default MSEBuffer;
export type { MSEBufferConfig };
