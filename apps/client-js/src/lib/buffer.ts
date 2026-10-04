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
import { events, type EventFields } from '@/lib/events/EventLog';

// MSE Buffer Configuration
export const MSE_IMMEDIATE_SEEK_THRESHOLD = 0.1; // seconds
export const DEFAULT_LIVE_EDGE_DELAY = 0.6; // seconds
export const DEFAULT_LIVE_EDGE_TOLERANCE = 0.1; // seconds
export const DEFAULT_BUFFER_CHECK_INTERVAL = 250; // milliseconds
export const DEFAULT_STALL_THRESHOLD = 0.5; // seconds
export const DEFAULT_CATCHUP_PLAYBACK_RATE = 1.05; // 5% faster

/**
 * Computes the target latency (seconds behind live edge) for the MSEBuffer's
 * catch-up loop. Time-shifted clients should hold the playhead at
 * `timeShiftSeconds` behind live (matching the wire-level DELAY_GROUPS);
 * live-edge clients use the default 1.25s for buffer runway.
 *
 * Defensive: time-shifted + non-positive delay falls back to DEFAULT to avoid
 * parking the playhead at zero buffer (which immediately stalls MSE).
 */
export function computeLiveEdgeDelay(
  clientMode: 'time-shifted' | 'live-edge',
  timeShiftSeconds: number,
): number {
  if (clientMode === 'time-shifted' && timeShiftSeconds > 0) {
    return timeShiftSeconds;
  }
  return DEFAULT_LIVE_EDGE_DELAY;
}

/**
 * Buffer the playhead can play without crossing a hole (M12): end of the
 * buffered range containing `currentTimeS` minus `currentTimeS`, 0 when the
 * playhead is in no range. A playhead up to 1 ms before a range start counts
 * as inside it (seeks land on rounded times). `buffer_s` (last range end minus
 * playhead) counts across holes and stays the total.
 */
export function contiguousBufferAheadS(
  buffered: { length: number; start(i: number): number; end(i: number): number },
  currentTimeS: number,
): number {
  for (let i = 0; i < buffered.length; i++) {
    if (currentTimeS >= buffered.start(i) - 0.001 && currentTimeS <= buffered.end(i)) {
      return Math.max(0, buffered.end(i) - currentTimeS);
    }
  }
  return 0;
}

/** Where new media is landing in the buffer right now (from the player's append path). */
export interface GapFillState {
  /** End PTS (s) of the most recently appended frame; undefined before the first append. */
  appendFrontS?: number;
}

/**
 * Whether a range-jump across a real gap should wait instead of seeking.
 *
 * The gap is being filled when the append front (where the newest frame
 * landed) lies inside it: a catch-up or a switch that re-fetches from the
 * playhead group appends there, and MSE's coded-frame removal has opened a
 * hole between that front and the older data ahead. Jumping then lands the
 * playhead past everything the fill will deliver: a time-shifted client
 * loses its shift in one seek (16.2 s -> 24.0 s in the PR #1378 playhead-floor
 * runs). The wait is bounded by `noProgressMs` since the front last moved, so
 * a fill that has died is jumped over like any other hole.
 */
export function shouldDeferRangeJump(args: {
  gapS: number;
  currentRangeEndS: number;
  nextRangeStartS: number;
  fill: GapFillState | undefined;
  frontStalledMs: number;
  noProgressMs: number;
}): boolean {
  if (args.gapS < MSE_IMMEDIATE_SEEK_THRESHOLD) return false;
  if (args.frontStalledMs >= args.noProgressMs) return false;
  const front = args.fill?.appendFrontS;
  if (front === undefined) return false;
  return front >= args.currentRangeEndS - 0.25 && front < args.nextRangeStartS;
}

interface MSEBufferConfig {
  /** Delay from live edge in seconds (default: 0.6) */
  liveEdgeDelay: number;
  /** Tolerance for live edge in seconds (default: 0.1) */
  liveEdgeTolerance: number;
  /** Interval for checking buffered regions in milliseconds (default: 250) */
  bufferCheckInterval: number;
  /** Threshold for detecting stalls in seconds (default: 0.5) */
  stallThreshold: number;
  /** Playback rate for catching up to live edge (default: 1.05 = 5% faster) */
  catchupPlaybackRate: number;
  /** Reports where new media is being appended, so a range-jump does not cross a gap being filled. */
  gapFillProbe?: () => GapFillState;
  /** Give up deferring a range-jump once the append front has not moved for this long (ms). */
  rangeJumpNoProgressMs: number;
  /**
   * Do not jump into a last range shorter than this (s): a 40 ms range at the
   * far end of the buffer is the first object of a group still arriving, and
   * jumping there stalls at its end immediately while throwing away every
   * second of shift in between (a 5 s time-shifted client went 78.0 -> 82.0 s
   * in one seek and sat at readyState 2).
   */
  minJumpTargetS: number;
  /** GOP duration (ms): a wedge recovery seeks to the next group boundary. */
  gopDurationMs: number;
  /** A playhead frozen this long inside a range with data ahead is a decoder wedge (ms). */
  wedgeFrozenMs: number;
  /** ... when at least this much is buffered ahead of it (s). */
  wedgeMinAheadS: number;
}

/**
 * What the one gap-crossing policy (M14) does at a playhead position.
 * - `gap`: the playhead is at the end of its range (or in a hole) and a later
 *   range exists; cross to its start, subject to the fill deferral.
 * - `short-target`: the only later range is a sliver still being filled; wait.
 * - `wedge`: frozen inside a range for `wedgeFrozenMs` with data ahead and no
 *   gap to cross; seek to the next group boundary.
 * - `none`: playing normally, or nothing later to go to (starving).
 */
export type GapPlan =
  | { kind: 'none' }
  | { kind: 'short-target'; rangeEndS: number; nextStartS: number; nextEndS: number }
  | { kind: 'gap'; toS: number; gapS: number; rangeEndS: number }
  | { kind: 'wedge'; toS: number };

/**
 * The geometry of the gap-crossing policy (M14); the deferral is applied by
 * MSEBuffer on top of a `gap` plan. Ranges are [start, end] seconds in order.
 */
export function planGapCrossing(args: {
  ranges: Array<[number, number]>;
  currentTimeS: number;
  frozenMs: number;
  stallThresholdS: number;
  minJumpTargetS: number;
  gopS: number;
  wedgeFrozenMs: number;
  wedgeMinAheadS: number;
}): GapPlan {
  const { ranges, currentTimeS: t } = args;
  if (ranges.length === 0) return { kind: 'none' };
  const i = ranges.findIndex(([start, end]) => t >= start - 0.001 && t <= end);
  let rangeEndS: number;
  if (i >= 0) {
    const end = ranges[i]![1];
    const ahead = end - t;
    if (ahead > args.stallThresholdS) {
      if (args.frozenMs >= args.wedgeFrozenMs && ahead > args.wedgeMinAheadS) {
        const nextBoundary = (Math.floor(t / args.gopS) + 1) * args.gopS + 0.001;
        return { kind: 'wedge', toS: Math.min(end - 0.5, nextBoundary) };
      }
      return { kind: 'none' };
    }
    rangeEndS = end;
  } else {
    // In a hole: the hole starts at the playhead.
    rangeEndS = t;
  }
  const j = ranges.findIndex(([start]) => start > rangeEndS);
  if (j < 0) return { kind: 'none' };
  const [nextStartS, nextEndS] = ranges[j]!;
  // The last range is still being filled; a sliver there is a group's first
  // object, not a place to play from.
  if (j === ranges.length - 1 && nextEndS - nextStartS < args.minJumpTargetS) {
    return { kind: 'short-target', rangeEndS, nextStartS, nextEndS };
  }
  return { kind: 'gap', toS: nextStartS, gapS: nextStartS - rangeEndS, rangeEndS };
}

class MSEBuffer {
  private config: MSEBufferConfig;
  private bufferCheckInterval: number | null = null;
  private isDisposed: boolean = false;
  private isCatchingUp: boolean = false;
  private isCatchingDown: boolean = false;
  private originalPlaybackRate: number = 1.0;
  // Range-jump deferral state: the gap being waited on (its next-range start),
  // when the wait began, and the append front's last position/movement time.
  private deferGapKey: number | null = null;
  private shortTargetKey: number | null = null;
  private deferSince = 0;
  private deferFrontS: number | undefined;
  private deferFrontMovedAt = 0;
  // Playhead progress, for the wedge path: last position and when it moved.
  private progressTimeS: number | undefined;
  private progressAt = 0;

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
      rangeJumpNoProgressMs: 3000,
      minJumpTargetS: 0.5,
      gopDurationMs: 1000,
      wedgeFrozenMs: 3000,
      wedgeMinAheadS: 1.5,
      ...config,
    };

    this.init();
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
          'visibility',
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

  /**
   * The one gap-crossing policy (M14). Both ways the playhead can get stuck
   * are handled here, with one deferral and one SEEK vocabulary:
   * - `gap`: at the end of its range (or in a hole) with a later range, cross
   *   to it; wait while a fill is landing inside the gap (bounded by
   *   `rangeJumpNoProgressMs` without append-front progress).
   * - `wedge`: frozen for `wedgeFrozenMs` inside a range with data ahead and
   *   no gap to cross; seek to the next group boundary.
   * Nothing is crossed before playback has started (paused element): the
   * player's startup seek places the playhead.
   */
  private checkBufferedRegions(logDetails: boolean = true) {
    const buffered = this.video.buffered;
    const currentTime = this.video.currentTime;
    const now = performance.now();
    if (this.progressTimeS === undefined || Math.abs(currentTime - this.progressTimeS) > 0.01) {
      this.progressTimeS = currentTime;
      this.progressAt = now;
    }

    if (buffered.length === 0) {
      logger.info('buffer', '[mseBuffer] No buffered data available');
      return;
    }
    if (this.video.paused || this.video.ended) return;

    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
    if (logDetails) {
      logger.info(
        'buffer',
        `[mseBuffer] buffered ${ranges.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(',')}`,
      );
    }

    const frozenMs = now - this.progressAt;
    const plan = planGapCrossing({
      ranges,
      currentTimeS: currentTime,
      frozenMs,
      stallThresholdS: this.config.stallThreshold,
      minJumpTargetS: this.config.minJumpTargetS,
      gopS: this.config.gopDurationMs / 1000,
      wedgeFrozenMs: this.config.wedgeFrozenMs,
      wedgeMinAheadS: this.config.wedgeMinAheadS,
    });

    switch (plan.kind) {
      case 'gap': {
        const deferredMs = this.maybeDeferRangeJump(plan, currentTime);
        if (deferredMs === null) return;
        logger.info(
          'buffer',
          `[mseBuffer] crossing a ${plan.gapS.toFixed(3)}s gap to ${plan.toS.toFixed(2)}s`,
        );
        this.seek(plan.toS, 'gap', { gap_ms: plan.gapS * 1000, deferred_ms: deferredMs });
        return;
      }
      case 'wedge': {
        // The playhead cannot be moved while a fill is deferring a jump (the
        // one deferral); in practice the two never coincide, since a wedge
        // has data ahead inside its range.
        if (this.deferGapKey !== null) return;
        logger.warn(
          'buffer',
          `[mseBuffer] decoder wedge at ${currentTime.toFixed(2)}s (readyState ${this.video.readyState}), seeking to ${plan.toS.toFixed(2)}s`,
        );
        this.seek(plan.toS, 'wedge', {
          gap_ms: 0,
          deferred_ms: 0,
          frozen_ms: frozenMs,
          ready_state: this.video.readyState,
        });
        return;
      }
      case 'short-target':
        if (this.shortTargetKey !== plan.nextStartS) {
          this.shortTargetKey = plan.nextStartS;
          events.emit('RANGE_JUMP_DEFERRED', {
            reason: 'short-target',
            playhead_ms: currentTime * 1000,
            range_end_ms: plan.rangeEndS * 1000,
            next_start_ms: plan.nextStartS * 1000,
            next_end_ms: plan.nextEndS * 1000,
          });
        }
        return;
      case 'none':
        this.deferGapKey = null;
        // For live streams, hold the target distance from the buffered end.
        if (!isFinite(this.video.duration)) this.maintainLiveEdgeDelay();
        return;
    }
  }

  /**
   * Returns null while the jump should wait (the gap is being filled), else
   * how long it was deferred (0 = not at all).
   */
  private maybeDeferRangeJump(
    plan: { toS: number; gapS: number; rangeEndS: number },
    currentTime: number,
  ): number | null {
    const now = performance.now();
    if (this.deferGapKey !== plan.toS) {
      this.deferGapKey = plan.toS;
      this.deferSince = now;
      this.deferFrontS = undefined;
      this.deferFrontMovedAt = now;
    }
    const fill = this.config.gapFillProbe?.();
    const front = fill?.appendFrontS;
    if (front !== undefined && front !== this.deferFrontS) {
      this.deferFrontS = front;
      this.deferFrontMovedAt = now;
    }
    const defer = shouldDeferRangeJump({
      gapS: plan.gapS,
      currentRangeEndS: plan.rangeEndS,
      nextRangeStartS: plan.toS,
      fill,
      frontStalledMs: now - this.deferFrontMovedAt,
      noProgressMs: this.config.rangeJumpNoProgressMs,
    });
    if (defer) {
      if (now === this.deferSince || now - this.deferSince < this.config.bufferCheckInterval) {
        events.emit('RANGE_JUMP_DEFERRED', {
          playhead_ms: currentTime * 1000,
          range_end_ms: plan.rangeEndS * 1000,
          next_start_ms: plan.toS * 1000,
          append_front_ms: front !== undefined ? front * 1000 : null,
        });
      }
      return null;
    }
    const deferredMs = now - this.deferSince;
    this.deferGapKey = null;
    return deferredMs;
  }

  private maintainLiveEdgeDelay() {
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;

    // Get the end of the last buffered range (live edge)
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
        events.emit('PLAYBACK_RATE', {
          rate: this.config.catchupPlaybackRate,
          reason: 'catchup',
          latency_s: currentLatency,
          target_s: targetDistance,
        });
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
        events.emit('PLAYBACK_RATE', {
          rate: slowdownRate,
          reason: 'catchdown',
          latency_s: currentLatency,
          target_s: targetDistance,
        });
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
      events.emit('PLAYBACK_RATE', { rate: this.originalPlaybackRate, reason: 'reset' });
    }
  }

  private seek(time: number, reason: 'gap' | 'wedge' | 'visibility', extra: EventFields = {}) {
    events.emit('SEEK', {
      reason,
      from_ms: this.video.currentTime * 1000,
      to_ms: time * 1000,
      ...extra,
    });
    this.video.currentTime = time;
    // A seek is progress: the wedge clock restarts from the new position.
    this.progressTimeS = time;
    this.progressAt = performance.now();
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
