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
 * link, ahead of the target's, and nobody read them. A replaced route is
 * released when its stream closes (the library completes a subscription once
 * PUBLISH_DONE has named its stream count and every stream has ended), or once
 * its PUBLISH_DONE has arrived and no object has come from it for
 * `RETIRE_IDLE_MS` (streams the relay reset above the seam may never be seen,
 * so the count is not always met), or at `RETIRE_MAX_MS` after SWITCH_OK
 * without a PUBLISH_DONE. The target's objects wait in their own stream
 * meanwhile, so the write handler sees the old track's tail, then the target.
 */
import type { MoqtObject } from 'moqtail';

/** Quiet time after the replaced subscription's PUBLISH_DONE before it is released. */
export const RETIRE_IDLE_MS = 300;
/**
 * Release a replaced subscription this long after SWITCH_OK even without its
 * PUBLISH_DONE (the library's own SWITCH response deadline).
 */
export const RETIRE_MAX_MS = 6000;

export type ReleaseReason = 'closed' | 'publish-done-idle' | 'cap' | 'error';

export interface PumpSource {
  readonly stream: ReadableStream<MoqtObject>;
  /** The request id the subscription is addressed by (SUBSCRIBE or relay PUBLISH). */
  readonly requestId: bigint;
  readonly trackName: string;
  /** G_switch of the switch that replaced this subscription (SWITCH_OK). */
  seamGroup?: bigint;
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
  /** A pipe failed for a reason other than a release or the shutdown. */
  onError?: (source: PumpSource, error: unknown) => void;
}

type NewSource = Pick<PumpSource, 'stream' | 'requestId' | 'trackName' | 'switchSeq'>;

function makeSource(s: NewSource): PumpSource {
  return { ...s, objectsAfterReplace: 0, postSeamDropped: 0 };
}

export class SourcePump {
  readonly #queue: PumpSource[] = [];
  #wake: (() => void) | undefined;
  readonly #now: () => number;
  readonly #onRelease: (source: PumpSource, reason: ReleaseReason) => void;
  readonly #onError: (source: PumpSource, error: unknown) => void;

  constructor(first: NewSource, options: SourcePumpOptions = {}) {
    this.#queue.push(makeSource(first));
    this.#now = options.now ?? (() => performance.now());
    this.#onRelease = options.onRelease ?? (() => {});
    this.#onError = options.onError ?? (() => {});
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
   * and `next` (the PUBLISH's stream) is queued behind it.
   */
  replace(replacedRequestId: bigint, switchingGroup: bigint, next: NewSource): void {
    const replaced = this.find(replacedRequestId);
    if (replaced) {
      replaced.seamGroup = switchingGroup;
      replaced.replacedAt = this.#now();
      replaced.replacedBySeq = next.switchSeq;
    }
    this.#queue.push(makeSource(next));
    this.#wake?.();
  }

  /** PUBLISH_DONE for `requestId`; true when it names a queued source. */
  publishDone(requestId: bigint): boolean {
    const source = this.find(requestId);
    if (!source) return false;
    source.publishDoneAt ??= this.#now();
    return true;
  }

  /** The write handler's verdict on an object of the current source. */
  admit(_group: bigint): 'append' | 'post-seam' {
    const head = this.#queue[0];
    if (!head) return 'append';
    head.lastObjectAt = this.#now();
    if (head.replacedAt !== undefined) head.objectsAfterReplace += 1;
    return 'append';
  }

  /**
   * Releases the current source when it has been replaced and is done with:
   * quiet for RETIRE_IDLE_MS after its PUBLISH_DONE, or RETIRE_MAX_MS after the
   * SWITCH_OK. Called periodically; a source that closes is released by `run`.
   */
  tick(): void {
    const head = this.#queue[0];
    if (!head || head.replacedAt === undefined || head.releaseReason !== undefined) return;
    const now = this.#now();
    let reason: ReleaseReason | undefined;
    if (
      head.publishDoneAt !== undefined &&
      now - Math.max(head.publishDoneAt, head.lastObjectAt ?? -Infinity) >= RETIRE_IDLE_MS
    ) {
      reason = 'publish-done-idle';
    } else if (now - head.replacedAt >= RETIRE_MAX_MS) {
      reason = 'cap';
    }
    if (reason === undefined) return;
    head.releaseReason = reason;
    head.pipeAc?.abort();
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
      const pipeAc = new AbortController();
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
      this.#onRelease(head, head.releaseReason ?? reason);
    }
  }
}
