/**
 * The data routes the player's write handler is fed from (pr1378).
 *
 * Under SWITCH (moq-transport PR #1378) every switch ends the current
 * subscription and opens a new one: the relay answers with a PUBLISH for the
 * target whose catch-up and live objects arrive on a new ReadableStream. This
 * queue pipes those streams into the one WritableStream that owns the
 * SourceBuffer, in subscription order.
 *
 * The replaced subscription is read until it is done (audit M5): the relay
 * delivers every object below G_switch before its PUBLISH_DONE
 * (Close-After-Switch finishes those streams), and those objects play before
 * the seam. They used to be abandoned at SWITCH_OK: the bytes still crossed the
 * link, ahead of the target's, and nobody read them.
 *
 * A replaced route S is done (R6 D2) when, structurally,
 *
 *   PUBLISH_DONE(S) received, G_switch known (SWITCH_OK), and the B data
 *   streams the relay opened on S for groups below G_switch have all been seen
 *   and have ended (FIN or reset), and S's own catch-up stream (if S was itself
 *   a switch target with a catch-up) has ended,
 *
 * where B is the project-local third field of the target PUBLISH's
 * SWITCH_TRANSITION. Since ended streams are a subset of the seen ones, which
 * are a subset of the B the relay opened, "B below-seam streams ended" is the
 * whole condition. Then the player finishes S in the library (its streams at or
 * above G_switch are stopped, its object stream closed after the objects already
 * queued) and S leaves the queue as `drained`. No idle timer: the old 300 ms
 * quiet period after PUBLISH_DONE delayed landings and could cut a tail held up
 * by loss. Fallback (`drain-timeout`): B is absent (an older relay) or the
 * condition is never met (a stream reset upstream before its header), and
 * nothing below the seam has come from S for `DRAIN_TIMEOUT_MS`. `cap`: no
 * PUBLISH_DONE within `RETIRE_MAX_MS` of SWITCH_OK. `closed`: S's stream ended on
 * its own (the library completed it) before the condition could be evaluated.
 * The target's objects wait in their own stream meanwhile, so the write handler
 * sees the old track's tail, then the target.
 */
import type { MoqtObject } from 'moqtail';

/**
 * Fallback: release a replaced route whose done condition cannot be evaluated
 * (no B) or is not met, once nothing below the seam has come from it for this
 * long after its PUBLISH_DONE and SWITCH_OK.
 */
export const DRAIN_TIMEOUT_MS = 2000;
/**
 * Release a replaced subscription this long after SWITCH_OK even without its
 * PUBLISH_DONE (the library's own SWITCH response deadline).
 */
export const RETIRE_MAX_MS = 6000;

export type ReleaseReason = 'closed' | 'drained' | 'drain-timeout' | 'cap' | 'error';

/** The end of one data stream of a route, as the library reports it (onDataStreamEnded). */
export interface RouteStreamEnd {
  requestId: bigint;
  streamType: 'subgroup' | 'fetch';
  groupId: bigint;
  end: 'fin' | 'reset' | 'stopped';
}

export interface PumpSource {
  readonly stream: ReadableStream<MoqtObject>;
  /** The request id the subscription is addressed by (SUBSCRIBE or relay PUBLISH). */
  readonly requestId: bigint;
  readonly trackName: string;
  /** G_switch of the switch that replaced this subscription (SWITCH_OK). */
  seamGroup?: bigint;
  /**
   * B: data streams the relay opened on this subscription for groups below
   * seamGroup (SWITCH_TRANSITION's project-local third field; undefined when the
   * relay did not send it).
   */
  belowSeamStreams?: bigint;
  /** Groups of this route's SUBGROUP streams that have ended (one entry per stream). */
  endedStreamGroups: bigint[];
  /** This route is a switch target whose catch-up stream has not ended yet. */
  catchUpPending: boolean;
  /** Last time something of a group (object or stream end) arrived, per group. */
  activityByGroup: Map<bigint, number>;
  /** When the done condition (or a fallback) decided the release. */
  releaseDecidedAt?: number;
  /** switch_seq of that switch. */
  replacedBySeq?: number;
  /** switch_seq of the switch whose PUBLISH opened this route (undefined for the startup one). */
  readonly switchSeq?: number;
  /** When the switch that replaced it was acknowledged (a successor is queued). */
  replacedAt?: number;
  /** When its PUBLISH_DONE arrived. */
  publishDoneAt?: number;
  /** When its last object reached the write handler. */
  lastObjectAt?: number;
  /** Objects it delivered after it was replaced. */
  objectsAfterReplace: number;
  /** Of those, objects at or above the seam (dropped, 'post-seam'). */
  postSeamDropped: number;
  releaseReason?: ReleaseReason;
  pipeAc?: AbortController;
}

export interface SourcePumpOptions {
  now?: () => number;
  /** A source left the queue (after its last object was written). */
  onRelease?: (source: PumpSource, reason: ReleaseReason) => void;
  /**
   * A replaced route is done (or its fallback fired): end it in the library
   * (finishReceiver: stop its open streams, close its object stream after what is
   * queued). Resolves false when nothing could be finished; the pump then cuts
   * the pipe itself. Without it the pump cuts the pipe at once.
   */
  onFinish?: (source: PumpSource) => Promise<boolean>;
  /** A pipe failed for a reason other than a release or the shutdown. */
  onError?: (source: PumpSource, error: unknown) => void;
}

type NewSource = Pick<PumpSource, 'stream' | 'requestId' | 'trackName' | 'switchSeq'> & {
  /** The relay opens a catch-up stream for this route (G_switch < live edge). */
  expectsCatchUp?: boolean;
};

function makeSource({ expectsCatchUp, ...s }: NewSource): PumpSource {
  return {
    ...s,
    objectsAfterReplace: 0,
    postSeamDropped: 0,
    endedStreamGroups: [],
    catchUpPending: expectsCatchUp === true,
    activityByGroup: new Map(),
  };
}

export class SourcePump {
  readonly #queue: PumpSource[] = [];
  #wake: (() => void) | undefined;
  readonly #now: () => number;
  readonly #onRelease: (source: PumpSource, reason: ReleaseReason) => void;
  readonly #onError: (source: PumpSource, error: unknown) => void;
  readonly #onFinish: ((source: PumpSource) => Promise<boolean>) | undefined;

  constructor(first: NewSource, options: SourcePumpOptions = {}) {
    this.#queue.push(makeSource(first));
    this.#now = options.now ?? (() => performance.now());
    this.#onRelease = options.onRelease ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#onFinish = options.onFinish;
  }

  /** The source being piped now (undefined once the queue ran dry). */
  get current(): PumpSource | undefined {
    return this.#queue[0];
  }

  /** The newest source: the subscription the next SWITCH replaces. */
  get latest(): PumpSource | undefined {
    return this.#queue[this.#queue.length - 1];
  }

  get size(): number {
    return this.#queue.length;
  }

  /** The queued routes, the one being piped first. */
  routes(): readonly PumpSource[] {
    return this.#queue;
  }

  find(requestId: bigint): PumpSource | undefined {
    return this.#queue.find(s => s.requestId === requestId);
  }

  /**
   * SWITCH_OK: the subscription `replacedRequestId` ends at `switchingGroup`
   * (the relay opened `belowSeamStreams` data streams on it below that group,
   * when it says) and `next` (the PUBLISH's stream) is queued behind it.
   */
  replace(
    replacedRequestId: bigint,
    switchingGroup: bigint,
    next: NewSource,
    belowSeamStreams?: bigint,
  ): void {
    const replaced = this.find(replacedRequestId);
    if (replaced) {
      replaced.seamGroup = switchingGroup;
      replaced.belowSeamStreams = belowSeamStreams;
      replaced.replacedAt = this.#now();
      replaced.replacedBySeq = next.switchSeq;
    }
    this.#queue.push(makeSource(next));
    this.#wake?.();
    if (replaced) this.#evaluate(replaced);
  }

  /** PUBLISH_DONE for `requestId`; true when it names a queued source. */
  publishDone(requestId: bigint): boolean {
    const source = this.find(requestId);
    if (!source) return false;
    source.publishDoneAt ??= this.#now();
    this.#evaluate(source);
    return true;
  }

  /**
   * The library reports that one of a route's data streams ended (after its last
   * object was queued on the route's stream). True when it names a queued source.
   */
  streamEnded(info: RouteStreamEnd): boolean {
    const source = this.find(info.requestId);
    if (!source) return false;
    const now = this.#now();
    if (info.streamType === 'fetch') {
      source.catchUpPending = false;
    } else {
      source.endedStreamGroups.push(info.groupId);
      source.activityByGroup.set(info.groupId, now);
    }
    this.#evaluate(source);
    return true;
  }

  /**
   * Whether replaced route `source` is done: PUBLISH_DONE came, G_switch and B are
   * known, B of its streams below G_switch have ended and its catch-up (if any)
   * has ended.
   */
  isDrained(source: PumpSource): boolean {
    const seam = source.seamGroup;
    if (source.publishDoneAt === undefined || seam === undefined) return false;
    if (source.belowSeamStreams === undefined || source.catchUpPending) return false;
    const ended = source.endedStreamGroups.filter(g => g < seam).length;
    return BigInt(ended) >= source.belowSeamStreams;
  }

  #evaluate(source: PumpSource): void {
    if (source.replacedAt === undefined || source.releaseReason !== undefined) return;
    if (this.isDrained(source)) this.#finish(source, 'drained');
  }

  /**
   * Ends a replaced route: it leaves the queue as `reason` once the objects it has
   * already queued are written (the library closes its stream), or at once when
   * the library cannot finish it.
   */
  #finish(source: PumpSource, reason: ReleaseReason): void {
    source.releaseReason = reason;
    source.releaseDecidedAt = this.#now();
    if (!this.#onFinish) {
      this.#cut(source);
      return;
    }
    void this.#onFinish(source).then(
      finished => {
        if (!finished) this.#cut(source);
      },
      () => this.#cut(source),
    );
  }

  /** Stops piping `source` now (or, if it is not piped yet, as soon as it would be). */
  #cut(source: PumpSource): void {
    (source.pipeAc ??= new AbortController()).abort();
  }

  /** The last time anything below `source`'s seam arrived from it. */
  #lastBelowSeamAt(source: PumpSource): number {
    let last = -Infinity;
    for (const [group, at] of source.activityByGroup) {
      if (source.seamGroup === undefined || group < source.seamGroup) last = Math.max(last, at);
    }
    return last;
  }

  /**
   * The write handler's verdict on an object of the current source: once a
   * SWITCH_OK has named this subscription's G_switch, its objects at or above
   * it are `post-seam` (audit M6: the target's catch-up delivers that span on
   * the new track; appending both put two representations in one span of the
   * SourceBuffer). Objects that arrived before SWITCH_OK are appended: the seam
   * was not known yet.
   */
  admit(group: bigint): 'append' | 'post-seam' {
    const head = this.#queue[0];
    if (!head) return 'append';
    head.lastObjectAt = this.#now();
    head.activityByGroup.set(group, head.lastObjectAt);
    if (head.replacedAt !== undefined) head.objectsAfterReplace += 1;
    if (head.seamGroup !== undefined && group >= head.seamGroup) {
      head.postSeamDropped += 1;
      return 'post-seam';
    }
    return 'append';
  }

  /**
   * The fallbacks, for every replaced route whose done condition has not
   * released it: `drain-timeout` once its PUBLISH_DONE came and nothing below the
   * seam has arrived from it for DRAIN_TIMEOUT_MS (B absent, or a below-seam
   * stream that never shows up), `cap` RETIRE_MAX_MS after SWITCH_OK without a
   * PUBLISH_DONE. Called periodically; a source that closes is released by `run`.
   */
  tick(): void {
    const now = this.#now();
    for (const source of this.#queue) {
      if (source.replacedAt === undefined || source.releaseReason !== undefined) continue;
      if (source.publishDoneAt !== undefined) {
        const since = Math.max(
          source.publishDoneAt,
          source.replacedAt,
          this.#lastBelowSeamAt(source),
        );
        if (now - since >= DRAIN_TIMEOUT_MS) this.#finish(source, 'drain-timeout');
      } else if (now - source.replacedAt >= RETIRE_MAX_MS) {
        source.releaseReason = 'cap';
        source.releaseDecidedAt = now;
        this.#cut(source);
      }
    }
  }

  /** Pipes the queue into `writable` until `signal` aborts. */
  async run(writable: WritableStream<MoqtObject>, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const head = this.#queue[0];
      if (!head) {
        await new Promise<void>(resolve => {
          this.#wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        this.#wake = undefined;
        continue;
      }
      const pipeAc = head.pipeAc ?? new AbortController();
      head.pipeAc = pipeAc;
      let reason: ReleaseReason = 'closed';
      try {
        await head.stream.pipeTo(writable, {
          signal: AbortSignal.any([signal, pipeAc.signal]),
          preventClose: true,
          preventAbort: true,
          preventCancel: true,
        });
      } catch (error) {
        if (signal.aborted) break;
        if (pipeAc.signal.aborted) reason = head.releaseReason ?? 'cap';
        else {
          reason = 'error';
          this.#onError(head, error);
        }
      }
      if (signal.aborted) break;
      this.#queue.shift();
      // A route whose stream ended on its own is `drained` when the done
      // condition holds by then (the library completed it on the same evidence).
      if (
        head.releaseReason === undefined &&
        reason === 'closed' &&
        head.replacedAt !== undefined
      ) {
        if (this.isDrained(head)) reason = 'drained';
      }
      this.#onRelease(head, head.releaseReason ?? reason);
    }
  }
}
