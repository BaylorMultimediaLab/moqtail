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

export class EventLog {
  #runId: string | null = null;
  #pending: string[] = [];
  #ring: EventRecord[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #endpoint = '/__events';
  #seq = 0;
  #dropped = 0;

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

  /** Stop recording; flushes what is pending. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.flush();
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

  /** Send pending records. Fire-and-forget; failures are retried on the next flush. */
  flush(): void {
    if (this.#runId === null || this.#pending.length === 0) return;
    if (typeof fetch !== 'function') return;
    const rows = this.#pending.splice(0);
    const body = rows.join('\n') + '\n';
    const url = `${this.#endpoint}?run=${encodeURIComponent(this.#runId)}`;
    fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {
      // Dev server unavailable: keep the rows for the next attempt (bounded).
      if (this.#pending.length + rows.length <= MAX_PENDING) {
        this.#pending.unshift(...rows);
      } else {
        this.#dropped += rows.length;
      }
    });
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
