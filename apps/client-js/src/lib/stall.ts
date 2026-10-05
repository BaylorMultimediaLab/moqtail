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

export type StallCause = 'waiting' | 'frozen';

/** What the tracker needs to know about the player when an episode opens. */
export interface StallContext {
  /** False before the first frame (pre-startup waiting is startup delay, not a stall). */
  ready: boolean;
  playheadMs: number;
  /** The presented track (M13). */
  track: string | null;
}

/**
 * Stall episodes (STALL_START / STALL_END) from two sources: the element's
 * `waiting` / `playing` events and the frozen-playhead watchdog (a playhead
 * that does not advance while playing is a stall whether or not the element
 * fired `waiting`). One episode is open at a time.
 *
 * Episodes never overlap (F15). A `waiting` episode ends on `playing` or on
 * playhead progress; a `frozen` episode ends only on playhead progress (a
 * `playing` event while the playhead stands still does not end a freeze), so
 * one freeze is one episode, credited from the first frozen tick the watchdog
 * confirmed. Closing an episode resets the watchdog's frozen count, so a new
 * frozen episode starts only after a new freeze has been confirmed from that
 * point, and no episode is credited from before the previous STALL_END.
 *
 * History: originally a `playing` event without progress closed the episode
 * while the watchdog kept counting, and its next tick reopened one backdated
 * to the original freeze start (one 7.0 s freeze reported as 6475 + 7011 ms,
 * overlapping). The first fix reset the count on that close, which split one
 * freeze into two episodes with a ~500 ms hole between them (a 0-7000 ms
 * freeze became [500, 3000] + [3500, 7000]).
 */
export class StallTracker {
  #open: { startPerf: number; cause: StallCause; playheadMs: number } | null = null;
  #frozenTicks = 0;
  #lastEndPerf = -Infinity;

  constructor(
    private readonly emit: (event: string, fields: Record<string, unknown>) => void,
    private readonly context: () => StallContext,
    /** Watchdog period (ms). */
    private readonly tickMs = 500,
  ) {}

  /** Consecutive watchdog ticks without playhead progress while playing. */
  get frozenTicks(): number {
    return this.#frozenTicks;
  }

  get isOpen(): boolean {
    return this.#open !== null;
  }

  /** The element fired `waiting`. */
  waiting(now: number): void {
    this.#start('waiting', now);
  }

  /**
   * The element fired `playing`. Ends a `waiting` episode only: a frozen
   * episode ends when the playhead moves (watchdogTick), not on the event.
   */
  playing(now: number): void {
    if (this.#open?.cause !== 'waiting') return;
    this.#end(now);
  }

  /**
   * One watchdog tick. `advanced`: the playhead moved since the last tick.
   * `playing`: the element is neither paused nor ended. Returns the frozen
   * tick count after this tick.
   */
  watchdogTick(now: number, advanced: boolean, playing: boolean): number {
    if (advanced) {
      this.#frozenTicks = 0;
      this.#end(now);
      return 0;
    }
    if (!playing) return this.#frozenTicks;
    this.#frozenTicks += 1;
    // Wait for ~1 s of confirmed freeze; the episode is credited from the
    // first frozen tick.
    if (this.#frozenTicks >= 2) {
      this.#start('frozen', now - this.tickMs * (this.#frozenTicks - 1));
    }
    return this.#frozenTicks;
  }

  #start(cause: StallCause, startPerf: number): void {
    if (this.#open !== null) return;
    const ctx = this.context();
    if (!ctx.ready) return;
    this.#open = {
      startPerf: Math.max(startPerf, this.#lastEndPerf),
      cause,
      playheadMs: ctx.playheadMs,
    };
    this.emit('STALL_START', { cause, playhead_ms: ctx.playheadMs, track: ctx.track });
  }

  #end(now: number): void {
    if (this.#open === null) return;
    const s = this.#open;
    this.#open = null;
    this.#frozenTicks = 0;
    this.#lastEndPerf = now;
    this.emit('STALL_END', {
      cause: s.cause,
      playhead_ms: s.playheadMs,
      duration_ms: now - s.startPerf,
    });
  }
}
