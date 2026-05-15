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
export const DEFAULT_LIVE_EDGE_DELAY = 1.25; // seconds
export const DEFAULT_LIVE_EDGE_TOLERANCE = 0.1; // seconds
export const DEFAULT_BUFFER_CHECK_INTERVAL = 250; // milliseconds
export const DEFAULT_STALL_THRESHOLD = 0.5; // seconds
export const DEFAULT_CATCHUP_PLAYBACK_RATE = 1.05; // 5% faster

/**
 * Computes the target latency (seconds behind live edge) for the MSEBuffer's
 * catch-up loop. Filtered clients should hold the playhead at
 * `filterDelaySeconds` behind live (matching the wire-level DELAY_GROUPS);
 * unfiltered clients use the default 1.25s for buffer runway.
 *
 * Defensive: filtered + non-positive delay falls back to DEFAULT to avoid
 * parking the playhead at zero buffer (which immediately stalls MSE).
 */
export function computeLiveEdgeDelay(
  clientMode: 'filtered' | 'unfiltered',
  filterDelaySeconds: number,
): number {
  if (clientMode === 'filtered' && filterDelaySeconds > 0) {
    return filterDelaySeconds;
  }
  return DEFAULT_LIVE_EDGE_DELAY;
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
}

class MSEBuffer {
  private config: MSEBufferConfig;
  private bufferCheckInterval: number | null = null;
  private isDisposed: boolean = false;
  private isCatchingUp: boolean = false;
  private isCatchingDown: boolean = false;
  private originalPlaybackRate: number = 1.0;

  constructor(
    public video: HTMLVideoElement,
    config: Partial<MSEBufferConfig> = {},
  ) {
    this.config = {
      liveEdgeDelay: DEFAULT_LIVE_EDGE_DELAY,
      liveEdgeTolerance: DEFAULT_LIVE_EDGE_TOLERANCE,
      bufferCheckInterval: DEFAULT_BUFFER_CHECK_INTERVAL,
      stallThreshold: DEFAULT_STALL_THRESHOLD,
      catchupPlaybackRate: DEFAULT_CATCHUP_PLAYBACK_RATE,
      ...config,
    };

    this.init();
  }

  private init() {
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('waiting', this.handleWaiting);
    this.video.addEventListener('stalled', this.handleStalled);

    document.addEventListener('visibilitychange', this.handleTabChange);

    this.startBufferMonitoring();
  }

  private handleTabChange = () => {
    if (document.hidden) {
      if (this.bufferCheckInterval) {
        clearInterval(this.bufferCheckInterval);
        this.bufferCheckInterval = null;
      }
    } else {
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
    this.checkBufferedRegions();
  };

  private handleStalled = () => {
    logger.info('buffer', '[mseBuffer] Video stalled event fired');
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

    const shouldSeek = this.shouldSeekToNextRange(currentTime, buffered);

    if (shouldSeek.seek) {
      logger.info(
        'buffer',
        `[mseBuffer] At end of range, seeking to next buffered range: ${shouldSeek.targetTime!.toFixed(2)}s`,
      );

      if (shouldSeek.targetTime <= currentTime) return;
      this.seek(shouldSeek.targetTime);

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
    if (buffered.length === 0) return { seek: false };

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

    const currentRangeEnd = buffered.end(currentRangeIndex);
    const distanceToEnd = currentRangeEnd - currentTime;

    // Only consider seeking if we're very close to the end (within threshold)
    if (distanceToEnd > this.config.stallThreshold) return { seek: false };

    // Recovery: walk every range past the current one and seek to the first
    // playable one. Stays minimal — live-edge alignment is the catch-up loop's
    // job, not this function's.
    for (let i = currentRangeIndex + 1; i < buffered.length; i++) {
      const nextStart = buffered.start(i);
      const nextEnd = buffered.end(i);
      if (nextEnd - nextStart <= 0) continue;
      const gap = nextStart - currentRangeEnd;
      logger.info(
        'buffer',
        `[mseBuffer] Seeking across ${gap.toFixed(3)}s gap to range ${nextStart.toFixed(
          3,
        )}-${nextEnd.toFixed(3)}s`,
      );
      return { seek: true, targetTime: nextStart + 0.001 };
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

      const distanceToStart = Math.abs(currentTime - start);
      if (distanceToStart < minDistance) {
        minDistance = distanceToStart;
        bestTarget = start;
      }

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

    const bufferEdge = buffered.end(buffered.length - 1);
    const currentLatency = bufferEdge - this.video.currentTime;
    const targetDistance = this.config.liveEdgeDelay;

    // Use playback rate adjustment to catch up instead of seeking
    if (currentLatency > targetDistance + this.config.liveEdgeTolerance) {
      // We're behind but close, use catchup speed
      if (!this.isCatchingUp) {
        logger.info(
          'buffer',
          `[mseBuffer] Too far from live edge (${currentLatency.toFixed(2)}s), catching up at ${this.config.catchupPlaybackRate}x speed`,
        );
        this.isCatchingUp = true;
        this.isCatchingDown = false;
        this.video.playbackRate = this.config.catchupPlaybackRate;
      }
    } else if (currentLatency < targetDistance - this.config.liveEdgeTolerance) {
      // We're too close to the live edge, slow down slightly
      if (!this.isCatchingDown) {
        const slowdownRate = 1 - (this.config.catchupPlaybackRate - 1);
        logger.info(
          'buffer',
          `[mseBuffer] Close to live edge (${currentLatency.toFixed(2)}s), slowing down to ${slowdownRate.toFixed(2)}x speed`,
        );
        this.isCatchingUp = false;
        this.isCatchingDown = true;
        this.video.playbackRate = slowdownRate;
      }
    } else if (
      (this.isCatchingUp || this.isCatchingDown) &&
      Math.abs(currentLatency - targetDistance) < this.config.liveEdgeTolerance
    ) {
      // We've reached the target distance, return to normal speed
      logger.info(
        'buffer',
        `[mseBuffer] Reached target distance from live edge (${currentLatency.toFixed(2)}s), returning to normal speed`,
      );
      this.resetPlaybackRate();
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
      logger.info('buffer', `[mseBuffer] Playback rate reset to ${this.originalPlaybackRate}x`);
    }
  }

  private seek(time: number) {
    this.video.currentTime = time;
  }

  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;

    this.resetPlaybackRate();

    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('stalled', this.handleStalled);

    document.removeEventListener('visibilitychange', this.handleTabChange);

    if (this.bufferCheckInterval) {
      clearInterval(this.bufferCheckInterval);
      this.bufferCheckInterval = null;
    }
  }
}

export default MSEBuffer;
export type { MSEBufferConfig };
