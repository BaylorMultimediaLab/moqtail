/**
 * Decode-order append scheduling for one SourceBuffer (preflight 2026-10-05).
 *
 * MSE's coded frame processing treats a frame whose decode timestamp is below the
 * last one appended, or more than two frame durations above it, as a
 * discontinuity: it then drops every frame until the next random access point
 * (keyframe), silently. Objects reach the player in arrival order, and arrival is
 * not decode order: a lost packet delays the tail of group g on its own QUIC stream
 * while group g+1's stream keeps delivering, and a catch-up or replay delivers
 * older groups while live groups arrive. Appending in arrival order then cost the
 * rest of a group whenever the order broke (about 1 % of groups in the preflight,
 * most of them around capacity steps and switch seams, on every arm).
 *
 * The scheduler appends a frame when it continues the last appended frame, holds a
 * frame that lies ahead of a gap until the gap fills (given up after `maxWaitMs`
 * without progress; optionally when little media is left ahead of the playhead), and drops a frame behind the append front
 * that cannot be appended without discarding what follows it. It decides only; the
 * player appends and drops.
 */

export interface OrderFrame<T> {
  /** The caller's handle for the frame (the object). */
  item: T;
  /** Decode time and duration of the frame (ms), from its moof. */
  dtsMs: number;
  durMs: number;
  /** A random access point (keyframe). */
  isSync: boolean;
  /** When the frame arrived (performance.now()). */
  arrivedAt: number;
}

export type OrderReason =
  /** A non-keyframe below the append front: MSE would drop it and what follows. */
  | 'behind-append-front'
  /** Held for a gap that did not fill in time; dropped up to the next keyframe. */
  | 'abandoned-gap'
  /** Held when the stream changed track (a switch landed): nothing to continue. */
  | 'track-changed';

export type OrderAction<T> =
  | { kind: 'append'; frame: OrderFrame<T>; held: boolean }
  | { kind: 'drop'; frame: OrderFrame<T>; reason: OrderReason; held: boolean };

export interface OrderContext {
  /**
   * Media ahead of the playhead that it can play without a gap, from the buffer
   * itself (ms); undefined when unknown.
   */
  aheadOfPlayheadMs?: number;
  /**
   * Whether a keyframe below the append front at `dtsMs` would fill a gap the
   * playhead has yet to reach (a late catch-up or refetch). Such a keyframe is
   * appended; anywhere else it is dropped like any frame behind the front.
   */
  fillsGapAhead?: (dtsMs: number) => boolean;
}

export interface AppendOrderOptions {
  /** Longest the held frames wait while the gap before them makes no progress (ms). */
  maxWaitMs: number;
  /**
   * Stop waiting once less than this much media is ahead of the playhead (ms); 0
   * never. Off by default (preflight 3, 2026-10-05): with the buffer already low,
   * giving a gap up jumps the front past media that is about to arrive in order (a
   * replay 0.6 s behind live lost two whole groups), and skipping a gap is the
   * buffer's gap-crossing policy's call, not the append order's. The wait stays
   * bounded by `maxWaitMs` without progress.
   */
  minAheadMs: number;
}

export const DEFAULT_APPEND_ORDER: AppendOrderOptions = { maxWaitMs: 1000, minAheadMs: 0 };

export class AppendOrder<T> {
  readonly #opts: AppendOrderOptions;
  /** End decode time of the last appended frame (ms); undefined before any. */
  #frontMs: number | undefined;
  /** Frames waiting for a gap, by decode time. */
  #held: OrderFrame<T>[] = [];
  /** When the front last advanced (performance.now() ms). */
  #progressAt = -Infinity;

  constructor(opts: Partial<AppendOrderOptions> = {}) {
    this.#opts = { ...DEFAULT_APPEND_ORDER, ...opts };
  }

  get heldCount(): number {
    return this.#held.length;
  }

  /** The end decode time of the last appended frame (ms). */
  get frontMs(): number | undefined {
    return this.#frontMs;
  }

  /**
   * When the held frames stop waiting (performance.now() ms); undefined if none.
   * The wait runs from the later of the oldest held frame's arrival and the front's
   * last advance: a gap that is being filled (a catch-up still delivering) keeps
   * the frames after it waiting, one that makes no progress for `maxWaitMs` is
   * given up (review 2026-10-05: a fixed wait gave up slow catch-ups).
   */
  get nextDeadline(): number | undefined {
    if (this.#held.length === 0) return undefined;
    const oldest = Math.min(...this.#held.map(f => f.arrivedAt));
    return Math.max(oldest, this.#progressAt) + this.#opts.maxWaitMs;
  }

  /** A frame arrived: what to do now, in order (it and any held frames it releases). */
  offer(frame: OrderFrame<T>, now: number, ctx: OrderContext = {}): OrderAction<T>[] {
    const out: OrderAction<T>[] = [];
    const front = this.#frontMs;
    if (front !== undefined && frame.dtsMs < front - frame.durMs / 2) {
      if (frame.isSync && ctx.fillsGapAhead?.(frame.dtsMs)) {
        this.#append(frame, false, now, out);
        this.#drain(now, out);
      } else {
        out.push({ kind: 'drop', frame, reason: 'behind-append-front', held: false });
      }
      return out;
    }
    if (front === undefined || this.#continues(frame)) {
      this.#append(frame, false, now, out);
      this.#drain(now, out);
      return out;
    }
    // Ahead of a gap: hold it, unless waiting is already over.
    this.#insert(frame);
    this.#release(now, ctx, out);
    return out;
  }

  /** Time passed: release held frames whose wait is over. */
  tick(now: number, ctx: OrderContext = {}): OrderAction<T>[] {
    const out: OrderAction<T>[] = [];
    this.#release(now, ctx, out);
    return out;
  }

  /**
   * The stream is about to continue on another track (a switch lands): the gap is
   * given up now, as at its deadline, so the held frames of the current track that
   * can still be appended (from the earliest held keyframe on) go into the buffer
   * before the new track's init segment; only those before that keyframe are
   * dropped. Then the order starts afresh (`reset`). Review 2026-10-05: dropping
   * every held frame at the landing left a hole below the seam (a group held behind
   * a retransmission when the target's first object arrived).
   */
  flush(now: number): OrderAction<T>[] {
    const out: OrderAction<T>[] = [];
    if (this.#held.length > 0) {
      const k = this.#held.findIndex(f => f.isSync);
      if (k >= 0) {
        for (const frame of this.#held.splice(0, k)) {
          out.push({ kind: 'drop', frame, reason: 'abandoned-gap', held: true });
        }
        const key = this.#held.shift()!;
        this.#append(key, true, now, out);
        this.#drain(now, out);
      }
    }
    return [...out, ...this.reset()];
  }

  /**
   * The stream continues on another track (a switch landed, a new init segment):
   * the held frames cannot be continued and the next frame starts afresh.
   */
  reset(): OrderAction<T>[] {
    const out: OrderAction<T>[] = this.#held.map(frame => ({
      kind: 'drop' as const,
      frame,
      reason: 'track-changed' as const,
      held: true,
    }));
    this.#held = [];
    this.#frontMs = undefined;
    this.#progressAt = -Infinity;
    return out;
  }

  #continues(frame: OrderFrame<T>): boolean {
    return this.#frontMs !== undefined && Math.abs(frame.dtsMs - this.#frontMs) <= frame.durMs / 2;
  }

  #append(frame: OrderFrame<T>, held: boolean, now: number, out: OrderAction<T>[]): void {
    out.push({ kind: 'append', frame, held });
    this.#frontMs = frame.dtsMs + frame.durMs;
    this.#progressAt = now;
  }

  #insert(frame: OrderFrame<T>): void {
    let i = this.#held.length;
    while (i > 0 && this.#held[i - 1]!.dtsMs > frame.dtsMs) i--;
    this.#held.splice(i, 0, frame);
  }

  /** Appends held frames that now continue the front; drops those left behind it. */
  #drain(now: number, out: OrderAction<T>[]): void {
    while (this.#held.length > 0) {
      const next = this.#held[0]!;
      if (this.#frontMs !== undefined && next.dtsMs < this.#frontMs - next.durMs / 2) {
        this.#held.shift();
        out.push({ kind: 'drop', frame: next, reason: 'behind-append-front', held: true });
      } else if (this.#continues(next)) {
        this.#held.shift();
        this.#append(next, true, now, out);
      } else {
        return;
      }
    }
  }

  /**
   * Waiting is over when the gap has made no progress for `maxWaitMs` (see
   * `nextDeadline`) or the playhead is about to run out of media: the gap is given up. Frames before the
   * earliest held keyframe cannot be appended without one and are dropped; that
   * keyframe and what continues it are appended. Without a held keyframe nothing is
   * appendable yet and the frames keep waiting for one.
   */
  #release(now: number, ctx: OrderContext, out: OrderAction<T>[]): void {
    if (this.#held.length === 0) return;
    const deadline = this.nextDeadline!;
    const starving =
      ctx.aheadOfPlayheadMs !== undefined && ctx.aheadOfPlayheadMs < this.#opts.minAheadMs;
    if (now < deadline && !starving) return;
    const k = this.#held.findIndex(f => f.isSync);
    if (k < 0) return;
    for (const frame of this.#held.splice(0, k)) {
      out.push({ kind: 'drop', frame, reason: 'abandoned-gap', held: true });
    }
    const key = this.#held.shift()!;
    this.#append(key, true, now, out);
    this.#drain(now, out);
  }
}
