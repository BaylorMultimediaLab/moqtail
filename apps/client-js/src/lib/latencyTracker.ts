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
 * Per-frame end-to-end latency tracker.
 *
 * Each MoQ object carries a publisher-attached `CaptureTimestamp`
 * extension header (LOC ID 2). Receiver computes
 * `latency_ms = now − captureTs` for every video object and pushes it
 * into a circular buffer of the last 100 samples (≈ 4 s at 25 fps —
 * the window the thesis Algorithm 1 specifies for latency-trend
 * downswitching).
 *
 * `getTrendRatio()` compares the recent half of the window to the older
 * half. Ratio > 1 means latency is rising; > 1.2 is the thesis trigger.
 *
 * Why split-mean vs. linear regression: the thesis prose says "latency
 * increases by more than 20% over 4 seconds." A halves-comparison is the
 * simplest reading of that and is robust to the single-frame jitter
 * inherent in QUIC delivery.
 */
export class LatencyTracker {
  readonly #windowSize: number;
  #samples: number[] = [];

  constructor(windowSize = 100) {
    this.#windowSize = windowSize;
  }

  record(latencyMs: number): void {
    // Sanity: discard wildly out-of-range values (clock skew, etc.).
    if (!Number.isFinite(latencyMs)) return;
    if (latencyMs < 0 || latencyMs > 60_000) return;
    this.#samples.push(latencyMs);
    if (this.#samples.length > this.#windowSize) {
      this.#samples.shift();
    }
  }

  /**
   * Ratio of mean(recent half) to mean(older half) of the buffer.
   * Returns 1.0 until the buffer is full so the ABR rule has no signal
   * to act on during startup.
   */
  getTrendRatio(): number {
    if (this.#samples.length < this.#windowSize) return 1.0;
    const halfIdx = Math.floor(this.#samples.length / 2);
    const older = this.#samples.slice(0, halfIdx);
    const recent = this.#samples.slice(halfIdx);
    const meanOlder = older.reduce((a, b) => a + b, 0) / older.length;
    const meanRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (meanOlder <= 0) return 1.0;
    return meanRecent / meanOlder;
  }

  /** Most recent sample (ms). 0 if none. */
  getLastLatencyMs(): number {
    return this.#samples[this.#samples.length - 1] ?? 0;
  }

  getSampleCount(): number {
    return this.#samples.length;
  }

  reset(): void {
    this.#samples = [];
  }
}
