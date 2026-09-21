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

/**
 * Experiment event log (project-local, protocol-neutral).
 *
 * Every record is `{ ts, perf, src: 'client', event, ...fields }` where `ts`
 * is `Date.now()` (UNIX ms, comparable with the relay and publisher logs on
 * the same host) and `perf` is `performance.now()` (monotonic, for intervals).
 *
 * Records are buffered and POSTed as JSON lines to `/__events?run=<runId>`;
 * the Vite dev server writes them to `logs/<runId>/client-events.jsonl`.
 * A ring of the most recent records is also kept on
 * `window.__moqtailEvents` so a browser driver can read them directly.
 *
 * The log is inert (no network, no buffering) until `start()` is called.
 */

export type EventFields = Record<string, unknown>;

export interface EventRecord extends EventFields {
  ts: number;
  perf: number;
  src: 'client';
  event: string;
}

const FLUSH_INTERVAL_MS = 500;
const RING_SIZE = 5000;
const MAX_PENDING = 20000;
/** Bytes per POST. Chrome rejects `keepalive` bodies above 64 KB and a burst of
 *  per-frame records (a 10-group joining replay) can exceed that in one flush
 *  window, so every flush is split into bounded batches. */
const MAX_BATCH_BYTES = 48 * 1024;

export class EventLog {
  #runId: string | null = null;
  #pending: string[] = [];
  #ring: EventRecord[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #endpoint = '/__events';
  #seq = 0;
  #dropped = 0;
  #inFlight = 0;
  #failures = 0;

  /** Whether `start()` has been called and events are being recorded. */
  get active(): boolean {
    return this.#runId !== null;
  }

  get runId(): string | null {
    return this.#runId;
  }

  /**
   * Begin recording under `runId`. Emits a CLOCK_MAP record first so offline
   * analysis can convert `perf` (monotonic) to `ts` (UNIX ms).
   */
  start(runId: string, endpoint = '/__events'): void {
    if (this.#runId !== null) return;
    this.#runId = runId;
    this.#endpoint = endpoint;
    this.#seq = 0;
    this.emit('CLOCK_MAP', {
      performance_time_origin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
      date_now: Date.now(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    });
    this.#timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Stop recording; flushes what is pending (best effort, keepalive so it
   *  survives page unload). */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.flush(true);
    this.#runId = null;
  }

  /** Append one record. No-op when inactive. */
  emit(event: string, fields: EventFields = {}): void {
    if (this.#runId === null) return;
    const record: EventRecord = {
      ts: Date.now(),
      perf: typeof performance !== 'undefined' ? performance.now() : 0,
      src: 'client',
      event,
      seq: this.#seq++,
      // Page-load identity: a reload (for example Vite re-optimising on first
      // load) starts a new session whose request ids restart, so records must
      // never be joined across sessions.
      session: typeof performance !== 'undefined' ? Math.round(performance.timeOrigin) : 0,
      ...fields,
    };
    this.#ring.push(record);
    if (this.#ring.length > RING_SIZE) this.#ring.shift();
    if (this.#pending.length >= MAX_PENDING) {
      this.#dropped++;
      return;
    }
    this.#pending.push(JSON.stringify(record, bigintReplacer));
  }

  /** Most recent records (oldest first). */
  recent(): EventRecord[] {
    return [...this.#ring];
  }

  /** Records dropped because the pending buffer was full (server unreachable). */
  get dropped(): number {
    return this.#dropped;
  }

  /** Records whose POST failed and were re-queued or dropped. */
  get failures(): number {
    return this.#failures;
  }

  /**
   * Send pending records in bounded batches. Fire-and-forget; a failed batch
   * is re-queued (bounded) for the next flush and reported on the console so
   * the dev server's console forwarding makes it visible.
   */
  flush(unloading = false): void {
    if (this.#runId === null || this.#pending.length === 0) return;
    if (typeof fetch !== 'function') return;
    // One in-flight batch at a time keeps ordering and avoids piling requests
    // up when the server is slow; the timer retries 500 ms later.
    if (this.#inFlight > 0 && !unloading) return;
    const url = `${this.#endpoint}?run=${encodeURIComponent(this.#runId)}`;
    while (this.#pending.length > 0) {
      const rows: string[] = [];
      let bytes = 0;
      while (this.#pending.length > 0 && bytes + this.#pending[0]!.length + 1 <= MAX_BATCH_BYTES) {
        const row = this.#pending.shift()!;
        rows.push(row);
        bytes += row.length + 1;
      }
      if (rows.length === 0) {
        // A single record larger than the batch limit: send it alone.
        rows.push(this.#pending.shift()!);
      }
      const body = rows.join('\n') + '\n';
      this.#inFlight++;
      fetch(url, { method: 'POST', body, keepalive: unloading })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        })
        .catch((err: unknown) => {
          this.#failures += rows.length;
          if (this.#failures === rows.length) {
            console.error('[events] flush failed; rows re-queued', err);
          }
          if (this.#pending.length + rows.length <= MAX_PENDING) {
            this.#pending.unshift(...rows);
          } else {
            this.#dropped += rows.length;
          }
        })
        .finally(() => {
          this.#inFlight--;
        });
      if (!unloading) break; // one batch per tick; the rest goes on the next tick
    }
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Process-wide event log. `start()` it once per run (see app.tsx). */
export const events = new EventLog();

if (typeof window !== 'undefined') {
  (window as Window & { __moqtailEvents?: EventLog }).__moqtailEvents = events;
}
