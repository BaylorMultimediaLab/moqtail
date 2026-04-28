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

import {
  DRAFT_14,
  FetchError,
  FetchType,
  FilterType,
  FullTrackName,
  GroupOrder,
  Location,
  MoqtObject,
  SubscribeError,
  Tuple,
} from 'moqtail';
import { MOQtailClient } from 'moqtail/client';
import { CMSFCatalog } from 'moqtail/model';
import { logger } from '@/lib/logger';
import { GoodputTracker } from '@/lib/goodput';
import { LatencyTracker } from '@/lib/latencyTracker';

// NTP epoch (1900) is 2_208_988_800 seconds before the UNIX epoch (1970).
const NTP_UNIX_DELTA_SECONDS = 2_208_988_800;

/**
 * If the chunk starts with a PRFT (Producer Reference Time) box per
 * ISO/IEC 14496-12 §8.16.5, return the publisher's wall-clock at chunk
 * production as UNIX milliseconds. Returns null otherwise.
 *
 * PRFT layout (version 1, 32 bytes total):
 *   0..4   box size (32, big-endian)
 *   4..8   "prft"
 *   8      version (1)
 *   9..12  flags (0)
 *   12..16 reference_track_ID
 *   16..24 ntp_timestamp (NTP fixed point: seconds.fraction since 1900)
 *   24..32 media_time (u64, version=1)
 */
function readPrftCaptureMs(buf: Uint8Array): number | null {
  if (buf.byteLength < 32) return null;
  // 'p'=0x70, 'r'=0x72, 'f'=0x66, 't'=0x74
  if (buf[4] !== 0x70 || buf[5] !== 0x72 || buf[6] !== 0x66 || buf[7] !== 0x74) {
    return null;
  }
  // DataView must respect the Uint8Array's byteOffset; otherwise we'd
  // read from byte 0 of the underlying ArrayBuffer instead of the chunk's
  // actual start.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ntpSeconds = view.getUint32(16, false);
  const ntpFraction = view.getUint32(20, false);
  const unixSeconds = ntpSeconds - NTP_UNIX_DELTA_SECONDS;
  const fractionMs = (ntpFraction / 0x1_0000_0000) * 1000;
  return unixSeconds * 1000 + fractionMs;
}

interface PendingSwitch {
  trackName: string;
  initData: ArrayBuffer;
  mimeType: string;
}

interface MOQStreamStruct {
  trackName: string;
  source: ReadableStream<MoqtObject>;
  requestId: bigint;
  tracker: GoodputTracker;
  lastGroupId: bigint;
  pendingSwitch: PendingSwitch | null;
  buffer?: {
    sourceBuffer: SourceBuffer;
    ac: AbortController;
  };
}

interface SubscribeOptions {
  trackName: string;
  priority?: number;
}

export interface PlayerOptions {
  /** The URL of the relay to connect to. */
  relayUrl: string;
  /** The namespace to use for this session. */
  namespace: Tuple;
  /** Whether to receive the catalog via SUBSCRIBE message. */
  receiveCatalogViaSubscribe?: boolean;
  /** Catalog location (default: group 0, object 1) */
  catalogLocation?: [Location, Location];
  /** Called when a switchTrack() completes (success or failure). Releases the ABR switching guard. */
  onTrackSwitched?: (trackName: string) => void;
}

const DefaultOptions = {
  relayUrl: 'https://relay.moqtail.dev',
  namespace: Tuple.fromUtf8Path('/moqtail'),
  receiveCatalogViaSubscribe: false,
  catalogLocation: [new Location(0n, 0n), new Location(0n, 1n)],
  onTrackSwitched: undefined as ((trackName: string) => void) | undefined,
} satisfies Required<Omit<PlayerOptions, 'onTrackSwitched'>> &
  Pick<PlayerOptions, 'onTrackSwitched'>;

export class Player {
  catalog: CMSFCatalog | null = null;
  client: MOQtailClient | null = null;

  #element: HTMLVideoElement | null = null;
  #mse?: MediaSource;
  #streams: MOQStreamStruct[] = [];
  #options: Required<Omit<PlayerOptions, 'onTrackSwitched'>> &
    Pick<PlayerOptions, 'onTrackSwitched'>;
  #disposers: Array<() => void> = [];
  // Per-frame end-to-end latency window (last 100 samples ≈ 4 s at 25 fps).
  // Fed by PRFT timestamps extracted from the head of each CMAF chunk.
  // `LatencyTrendRule` reads `getTrendRatio()` for downswitch decisions.
  #latencyTracker = new LatencyTracker();

  constructor(options: Partial<PlayerOptions> = {}) {
    this.#options = { ...DefaultOptions, ...options };
  }

  async initialize() {
    // If we already received the catalog, skip initialization
    if (this.catalog) return this.catalog;

    try {
      // Initialize the client and fetch the catalog
      this.client = await MOQtailClient.new({
        url: this.#options.relayUrl,
        supportedVersions: [DRAFT_14],
      });
    } catch (error) {
      logger.error('media', 'Failed to connect to relay', (error as Error).message);
      throw error;
    }

    // Fetch the catalog
    try {
      this.catalog = await this.retrieveCatalog();
    } catch (error) {
      logger.error('media', 'Failed to retrieve catalog', (error as Error).message);
      throw error;
    }

    return this.catalog;
  }

  /**
   * Estimate initial bandwidth from WebTransport.getStats().
   *
   * By the time initialize() returns, the QUIC handshake + catalog fetch have
   * already transferred data. We take two getStats() snapshots 200ms apart
   * and derive throughput from the bytesReceived delta. Returns 0 if the
   * browser doesn't support getStats() or the measurement is too noisy.
   */
  async estimateInitialBandwidth(): Promise<number> {
    const transport = this.client?.webTransport;
    if (!transport || typeof (transport as { getStats?: unknown }).getStats !== 'function')
      return 0;

    type StatsResult = { bytesReceived?: number };
    const getStats = (
      transport as unknown as { getStats: () => Promise<StatsResult> }
    ).getStats.bind(transport);

    const s1 = await getStats();
    const t1 = Date.now();
    await new Promise(r => setTimeout(r, 200));
    const s2 = await getStats();
    const t2 = Date.now();

    const deltaBytes = (s2.bytesReceived ?? 0) - (s1.bytesReceived ?? 0);
    const deltaMs = t2 - t1;
    if (deltaMs < 50 || deltaBytes <= 0) return 0;

    return (deltaBytes * 8 * 1000) / deltaMs;
  }

  async dispose() {
    for (const d of this.#disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    this.#disposers = [];

    // Unsubscribe from all active streams
    await Promise.all(this.#streams.map(s => this.unsubscribe(s.requestId)));

    // Close the client connection
    await this.client?.disconnect();

    // Reset state
    this.catalog = null;
    this.client = null;
    this.#element = null;
    this.#mse = undefined;
    this.#streams = [];
  }

  async attachMedia(element: HTMLVideoElement) {
    // Create a MediaSource and set it as the video element's source
    const mediaSource = new MediaSource();
    element.src = URL.createObjectURL(mediaSource);
    this.#element = element;
    this.#mse = mediaSource;
  }

  async addMediaTrack(trackName: string) {
    if (!this.#mse) throw new Error('MediaSource not initialized');
    if (!this.catalog) throw new Error('Catalog not loaded');
    if (!this.client) throw new Error('MOQProcessor not initialized');

    // We require a catalog entry to be present
    if (!this.catalog?.getByTrackName(trackName))
      throw new Error(`Track not found in catalog: ${trackName}`);

    // Verify packaging is playable by this player ('loc', 'cmaf', or 'chunk-per-object').
    if (!this.catalog.isCMAF(trackName))
      throw new Error(
        `Unsupported packaging type for track ${trackName}, only 'loc', 'cmaf', and 'chunk-per-object' are supported`,
      );

    // Get the stream struct
    const struct = await this.subscribe({ trackName });

    // Create new Source Buffer
    await this.#newSourceBufferMSE(struct, trackName);

    // Return the request ID
    return struct.requestId;
  }

  async startMedia() {
    if (!this.client) throw new Error('MOQProcessor not initialized');
    if (!this.#element) throw new Error('Media element not attached');
    if (this.#streams.length === 0) throw new Error('No active media streams to start');

    // Wedge watchdog. Each ABR switch leaves a ~1-frame gap in the MSE
    // timeline (the relay activates the new track at the next group boundary,
    // so a few frames at the boundary are dropped). When currentTime walks
    // into one of those gaps, MSE goes ready_state=2 and stops advancing
    // forever even though data is buffered on the far side. Detect that
    // exact pattern (frames frozen, currentTime sitting at the end of a
    // buffered range, with another range immediately after) and seek across
    // the gap.
    const el = this.#element;
    let lastFrames = 0;
    let frozenSince = 0;
    const wedgeIntervalId = setInterval(() => {
      const q = el.getVideoPlaybackQuality?.();
      const frames = q?.totalVideoFrames ?? 0;
      if (frames > lastFrames) {
        lastFrames = frames;
        frozenSince = 0;
        return;
      }
      if (el.paused || el.ended) return;
      frozenSince += 1;
      if (frozenSince < 2) return; // wait ~1s of confirmed freeze
      const buf = el.buffered;
      for (let i = 0; i < buf.length - 1; i++) {
        const end = buf.end(i);
        const nextStart = buf.start(i + 1);
        if (el.currentTime >= end - 0.05 && nextStart > end && nextStart - end < 1.5) {
          logger.info(
            'media',
            `Wedge detected at ${el.currentTime.toFixed(2)}s, seeking across ${end.toFixed(2)}-${nextStart.toFixed(2)} gap`,
          );
          el.currentTime = nextStart + 0.001;
          frozenSince = 0;
          return;
        }
      }
    }, 500);
    this.#disposers.push(() => clearInterval(wedgeIntervalId));

    // Convenience function to wait for buffer updates
    const waitForBufferUpdate = (sourceBuffer: SourceBuffer) =>
      new Promise<void>(resolve =>
        sourceBuffer.addEventListener('updateend', () => resolve(), { once: true }),
      );

    // Seek behind the live edge so the player starts with buffer runway.
    // Without this offset the player lands on the live edge (0 s buffer),
    // immediately stalls, recovers for a moment, then stalls again —
    // creating the "video gets stuck" symptom.
    const LIVE_EDGE_STARTUP_OFFSET = 1.0; // seconds behind the live edge

    let gotNotification = 0;
    let target = 0;
    const bufferNotification = (end: number) => {
      if (gotNotification >= this.#streams.length) return false;

      // Start behind the live edge so there is buffer to consume while
      // new data continues arriving. The MSEBuffer module then fine-tunes
      // the distance via playback-rate adjustments (catchup / catchdown).
      target = Math.max(target, end - LIVE_EDGE_STARTUP_OFFSET);

      gotNotification++;
      if (gotNotification === this.#streams.length) {
        logger.info(
          'media',
          `All buffers ready, seeking to ${target.toFixed(2)}s (live edge ${end.toFixed(2)}s)`,
        );
        this.#element!.currentTime = target;
        this.#element!.play();
      }
      return true;
    };

    // Iterate over all added roles
    for (const struct of this.#streams) {
      // Get the init segment for the track
      const initSegment = this.catalog?.getInitData(struct.trackName);
      if (!initSegment) {
        await this.unsubscribe(struct.requestId);
        throw new Error(`Failed to get init segment for track: ${struct.trackName}`);
      }

      // Get the Buffer and AbortController for this track
      const { sourceBuffer, ac } = struct.buffer!;

      // Append the init segment
      try {
        sourceBuffer.appendBuffer(initSegment);
        await waitForBufferUpdate(sourceBuffer);
      } catch (error) {
        await this.unsubscribe(struct.requestId);
        throw new Error(
          `Failed to append init segment for track ${struct.trackName}: ${(error as Error).message}`,
        );
      }

      // MSE State
      let lastMSEErrorLogged = 0;
      let kickStarted = false;

      // Create the WritableStream to handle incoming objects
      const writable = new WritableStream<MoqtObject>({
        write: async (object, controller) => {
          try {
            // Skip end-of-group objects
            if (object.isEndOfGroup()) {
              logger.info(
                'media',
                `Received end-of-group object for track ${struct.trackName}, ignoring`,
              );
              return;
            }

            // Make TypeScript happy
            if (!(object.payload?.buffer instanceof ArrayBuffer)) {
              console.warn('Received non-ArrayBuffer payload, ignoring', object);
              return;
            }

            // Cancel if aborted
            if (ac.signal.aborted) {
              controller.error(new DOMException('Stream aborted', 'InternalError'));
              return;
            }

            // Resolve the incoming object's track name from its fullTrackName
            // (wire-side truth). Always compute it — not just during pending
            // switches — because the relay continues to flush in-flight
            // old-track streams AFTER a switch completes. Those trailing
            // packets have different HEVC SPS/PPS than the new init segment,
            // so appending them would feed the SourceBuffer data it can't
            // decode and stall MSE.
            const objectTrackName = new TextDecoder().decode(object.fullTrackName.name);

            // Drop anything that isn't the current track or the pending
            // switch target. Covers two cases:
            //   1. Rapid ABR switching (A→B→C) where intermediate-track data
            //      arrives after pendingSwitch was overwritten to C.
            //   2. Old-track trailing packets delivered after a switch has
            //      already activated and pendingSwitch was cleared.
            if (
              objectTrackName !== struct.trackName &&
              objectTrackName !== struct.pendingSwitch?.trackName
            ) {
              logger.info(
                'media',
                `Dropping stale track data (${objectTrackName}); current=${struct.trackName} pending=${struct.pendingSwitch?.trackName ?? 'none'}`,
              );
              return;
            }

            if (struct.pendingSwitch && objectTrackName === struct.pendingSwitch.trackName) {
              const { initData, mimeType, trackName: newTrackName } = struct.pendingSwitch;
              struct.trackName = newTrackName;
              struct.pendingSwitch = null;

              // changeType() must not be called while the SourceBuffer is updating
              if (sourceBuffer.updating) await waitForBufferUpdate(sourceBuffer);
              try {
                sourceBuffer.changeType(mimeType);
                sourceBuffer.appendBuffer(initData);
                await waitForBufferUpdate(sourceBuffer);
              } catch (switchError) {
                logger.error(
                  'media',
                  `switchTrack: failed to apply init segment for ${newTrackName}:`,
                  switchError,
                );
                // Release the guard and abort the write stream — the source buffer
                // may be in an inconsistent state after a partial changeType/append.
                this.#options.onTrackSwitched?.(newTrackName);
                controller.error(switchError);
                return;
              }

              // NOW release the ABR switching guard — the relay has completed the
              // transition and delivered data on the new track. Safe to switch again.
              this.#options.onTrackSwitched?.(newTrackName);
            }

            // Append the data
            let maxRetries = 5;
            while (maxRetries--) {
              try {
                // Append the data
                sourceBuffer.appendBuffer(object.payload.buffer);

                // Wait for the source buffer to be consumed
                await waitForBufferUpdate(sourceBuffer);
                break;
              } catch (error) {
                // Wait for the source buffer to be ready
                if (sourceBuffer.updating) await waitForBufferUpdate(sourceBuffer);
                else if (lastMSEErrorLogged + 5000 < performance.now()) {
                  lastMSEErrorLogged = performance.now();
                  const err = error as Error & { name?: string; code?: number };
                  const vErr = this.#element?.error;
                  logger.error(
                    'media',
                    `Error appending to SourceBuffer, retrying... (${maxRetries} attempts left). ` +
                      `err.name=${err?.name} err.message=${err?.message} ` +
                      `sb.updating=${sourceBuffer.updating} ` +
                      `mse.readyState=${this.#mse?.readyState} ` +
                      `video.error.code=${vErr?.code} video.error.message=${vErr?.message} ` +
                      `payload.byteLength=${object.payload.byteLength} ` +
                      `track=${objectTrackName}`,
                  );
                }
              }
            }

            // Check the buffered amount
            if (sourceBuffer.buffered.length > 0 && !kickStarted) {
              const minStart = sourceBuffer.buffered.start(0);
              const maxEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
              const bufferDuration = maxEnd - minStart;
              if (bufferDuration > 1.0) bufferNotification(maxEnd);
            }

            // Record goodput sample — SWMA on per-group object timing.
            // The publisher bursts a GOP's objects back-to-back so the
            // intra-group rate reflects link capacity, not source bitrate.
            struct.tracker.recordObject(object.payload.byteLength, object.location.group);
            struct.lastGroupId = object.location.group;

            // Read PRFT box (if any) at the head of the CMAF chunk.
            // Publisher prepends `prft` per ISO/IEC 14496-12 §8.16.5 so the
            // receiver can compute end-to-end latency per frame. MSE skips
            // unknown top-level boxes, so the chunk is appended unchanged.
            // `object.payload` is already a Uint8Array view at the right
            // offset — pass it directly so we don't accidentally read from
            // byte 0 of a shared underlying ArrayBuffer.
            const captureMs = readPrftCaptureMs(object.payload);
            if (captureMs !== null) {
              this.#latencyTracker.record(Date.now() - captureMs);
            }
          } catch (error) {
            logger.error('media', 'Error processing media object:', error);
            controller.error(error);
          }
        },
      });

      // Pipe to the writable stream
      const promise = struct.source.pipeTo(writable, { signal: ac.signal });

      // Cleanup stream — for live streams, do NOT call endOfStream() when the
      // pipe ends. The readable stream can close transiently (e.g., during a
      // SWITCH, relay reconnection, or subscription update). Calling endOfStream()
      // permanently seals the MediaSource, preventing any further data from being
      // appended. Only call endOfStream() when the player is being disposed.
      promise.catch(error => {
        if (!['AbortError', 'InternalError'].includes(error.name)) {
          logger.error('media', 'Stream pipe error:', error);
        }
      });
    }
  }

  getMetrics(): {
    bandwidthBps: number;
    fastEmaBps: number;
    slowEmaBps: number;
    bufferSeconds: number;
    activeTrack: string | null;
    droppedFrames: number;
    totalFrames: number;
    playbackRate: number;
    deliveryTimeMs: number;
    lastObjectBytes: number;
    readyState: number;
    paused: boolean;
    currentTime: number;
    bufferedRanges: string;
    mseReadyState: string;
    videoErrorCode: number;
    latencyTrendRatio: number;
    lastLatencyMs: number;
  } {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    const el = this.#element;
    const buffered = el?.buffered;
    const bufferSeconds =
      buffered && buffered.length > 0 && el
        ? Math.max(0, buffered.end(buffered.length - 1) - el.currentTime)
        : 0;
    const quality = el?.getVideoPlaybackQuality?.();
    let bufferedRanges = '';
    if (buffered) {
      const parts: string[] = [];
      for (let i = 0; i < buffered.length; i++) {
        parts.push(`${buffered.start(i).toFixed(2)}-${buffered.end(i).toFixed(2)}`);
      }
      bufferedRanges = parts.join(',');
    }
    return {
      bandwidthBps: videoStruct?.tracker.getBandwidthBps() ?? 0,
      fastEmaBps: videoStruct?.tracker.getFastEmaBps() ?? 0,
      slowEmaBps: videoStruct?.tracker.getSlowEmaBps() ?? 0,
      bufferSeconds,
      activeTrack: videoStruct?.trackName ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? 0,
      totalFrames: quality?.totalVideoFrames ?? 0,
      playbackRate: el?.playbackRate ?? 1,
      deliveryTimeMs: videoStruct?.tracker.getLastDeliveryTimeMs() ?? 0,
      lastObjectBytes: videoStruct?.tracker.getLastObjectBytes() ?? 0,
      readyState: el?.readyState ?? 0,
      paused: el?.paused ?? true,
      currentTime: el?.currentTime ?? 0,
      bufferedRanges,
      mseReadyState: this.#mse?.readyState ?? 'closed',
      videoErrorCode: el?.error?.code ?? 0,
      latencyTrendRatio: this.#latencyTracker.getTrendRatio(),
      lastLatencyMs: this.#latencyTracker.getLastLatencyMs(),
    };
  }

  setEmaHalfLives(halfLifeFastSec: number, halfLifeSlowSec: number): void {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    videoStruct?.tracker.setHalfLives(halfLifeFastSec, halfLifeSlowSec);
  }

  /**
   * Active bandwidth probe (per Kuo, KTH MSc 2025 §3.4.3.1 Algorithm 1;
   * IETF 119 MoQ bandwidth-measurement slides).
   *
   * Subscribes to a synthetic `.probe:<size>:<priority>` track that the
   * relay handles by generating one payload of the requested size and
   * closing the stream. We measure both the **probe** bytes (p) and the
   * **video-track** bytes (v) received during the same wall-clock window,
   * matching Algorithm 1's `BWE = (v + p) / Δt`. Combining v + p
   * estimates total link throughput rather than just the probe's
   * residual capacity.
   *
   * Returns 0 on subscribe failure or no data.
   */
  async probeTrackBandwidth(trackName: string, durationMs: number): Promise<number> {
    if (!this.client) return 0;
    const fullTrackName = getFullTrackName(this.#options.namespace, trackName);

    // Snapshot the active video tracker's cumulative bytes before the probe
    // window opens. Diff at the end gives us v (real-track bytes received
    // concurrently with the probe).
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    const vBytesStart = videoStruct?.tracker.getCumulativeBytes() ?? 0;
    const tStart = Date.now();

    const result = await this.client.subscribe({
      fullTrackName,
      groupOrder: GroupOrder.Original,
      filterType: FilterType.LatestObject,
      forward: true,
      priority: 255,
    });
    if (result instanceof SubscribeError) return 0;

    const reader = result.stream.getReader();
    let pBytes = 0;
    let count = 0;

    try {
      while (Date.now() - tStart < durationMs) {
        const remaining = durationMs - (Date.now() - tStart);
        const timeoutP = new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        );
        const readP = reader.read() as Promise<{
          done: boolean;
          value: typeof MoqtObject.prototype | undefined;
        }>;
        const r = await Promise.race([readP, timeoutP]);
        if (r.done || !r.value) break;
        if (r.value.isEndOfGroup()) continue;
        const len = r.value.payload?.byteLength ?? 0;
        if (len === 0) continue;
        pBytes += len;
        count++;
      }
    } catch {
      /* swallow — return what we have */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      this.client.unsubscribe(result.requestId).catch(() => {});
    }

    const tEnd = Date.now();
    const dtSec = (tEnd - tStart) / 1000;
    if (count === 0 || dtSec <= 0) return 0;

    const vBytesEnd = videoStruct?.tracker.getCumulativeBytes() ?? vBytesStart;
    const vBytes = Math.max(0, vBytesEnd - vBytesStart);

    // BWE = (v + p) × 8 / Δt — Algorithm 1 line 9.
    return ((vBytes + pBytes) * 8) / dtSec;
  }

  /**
   * Updates the onTrackSwitched callback post-construction.
   * Called by app.tsx after creating the Player and AbrController,
   * to wire the ABR switching guard release without a circular dependency.
   */
  setOnTrackSwitched(cb: (trackName: string) => void): void {
    this.#options.onTrackSwitched = cb;
  }

  /**
   * Abort an in-flight track switch. Called by AbrController when its
   * switching-guard timeout fires — meaning the chosen target track is
   * unfulfillable (typically: upswitch fired right before a regime change
   * dropped the link below the target's source rate). Clearing
   * `pendingSwitch` ensures any stale data arriving later on the abandoned
   * track is dropped by the write handler's `objectTrackName !==
   * struct.pendingSwitch?.trackName` filter rather than belatedly applied.
   */
  abortPendingSwitch(): void {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    if (!videoStruct) return;
    videoStruct.pendingSwitch = null;
  }

  /**
   * Seamlessly switches the active video track using the MoQ SWITCH message.
   * The relay will complete delivery of the current group then begin sending
   * the new track. The WritableStream.write handler detects the group boundary
   * and re-injects the new init segment before appending the first new payload.
   *
   * Fire-and-forget from AbrController: do NOT await this externally.
   * The #switching guard in AbrController is released via onTrackSwitched callback.
   */
  async switchTrack(trackName: string): Promise<void> {
    if (!this.client) return;
    if (!this.catalog) return;

    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    if (!videoStruct) return;

    const fullTrackName = getFullTrackName(this.#options.namespace, trackName);
    const initData = this.catalog.getInitData(trackName);
    const role = this.catalog.getRole(trackName);
    const codec = this.catalog.getCodecString(trackName);

    if (!initData || !role || !codec) {
      logger.error('media', `switchTrack: missing catalog data for track ${trackName}`);
      this.#options.onTrackSwitched?.(videoStruct.trackName);
      return;
    }

    const mimeType = `${role}/mp4; codecs="${codec}"`;

    try {
      const result = await this.client.switch({
        fullTrackName,
        subscriptionRequestId: videoStruct.requestId,
      });

      if (result instanceof SubscribeError) {
        logger.error(
          'media',
          `switchTrack: SWITCH rejected for ${trackName}:`,
          result.errorReason.phrase,
        );
        this.#options.onTrackSwitched?.(videoStruct.trackName);
        return;
      }

      // Success: update requestId, arm the write handler.
      // Do NOT reset the tracker — the bandwidth estimate from the previous
      // track is still a valid indicator of network capacity. Resetting it
      // creates a blind spot where ABR rules see 0 bandwidth and can't
      // downgrade if the new track is too aggressive. (dash.js doesn't reset
      // throughput on quality switches either.)
      videoStruct.requestId = result.requestId;
      // Arm the write handler for init segment re-injection at the next group
      // boundary. The onTrackSwitched callback (which releases the ABR switching
      // guard) is NOT called here — it fires in the write handler AFTER the relay
      // has actually delivered data on the new track. This prevents rapid
      // consecutive SWITCH messages that corrupt the relay's switch context.
      videoStruct.pendingSwitch = { trackName, initData: initData.buffer as ArrayBuffer, mimeType };
    } catch (error) {
      logger.error('media', 'switchTrack: unexpected error', error);
      this.#options.onTrackSwitched?.(videoStruct.trackName);
    }
  }

  async #newSourceBufferMSE(struct: MOQStreamStruct, trackName: string) {
    if (!this.#mse) throw new Error('MediaSource not initialized');

    // Wait for media source to be open
    if (this.#mse.readyState === 'closed') {
      await new Promise(resolve => {
        const onSourceOpen = () => {
          this.#mse!.removeEventListener('sourceopen', onSourceOpen);
          resolve(true);
        };
        this.#mse!.addEventListener('sourceopen', onSourceOpen);
      });
    }

    // Get the MIME type
    const codecString = this.catalog?.getCodecString(trackName);
    const role = this.catalog?.getRole(trackName);
    if (!codecString || !role) {
      await this.unsubscribe(struct.requestId);
      throw new Error(`Failed to get codec or role for track: ${trackName}`);
    }

    // Check if the MIME type is supported
    const mimeType = `${role}/mp4; codecs="${codecString}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      await this.unsubscribe(struct.requestId);
      throw new Error(`MIME type not supported: ${mimeType}`);
    }

    // Create a new SourceBuffer
    const sourceBuffer = this.#mse.addSourceBuffer(mimeType);

    // Register the SourceBuffer
    struct.buffer = {
      ac: new AbortController(),
      sourceBuffer,
    };
  }

  async retrieveCatalog(): Promise<CMSFCatalog> {
    if (!this.client) throw new Error('MOQProcessor not initialized');

    let struct: MOQStreamStruct;
    if (this.#options.receiveCatalogViaSubscribe) {
      struct = await this.subscribe({ trackName: 'catalog', priority: 0 });
    } else {
      const result = await this.client.fetch({
        groupOrder: GroupOrder.Original,
        priority: 0,
        typeAndProps: {
          type: FetchType.StandAlone,
          props: {
            fullTrackName: getFullTrackName(this.#options.namespace, 'catalog'),
            startLocation: this.#options.catalogLocation[0],
            endLocation: this.#options.catalogLocation[1],
          },
        },
      });
      if (result instanceof FetchError)
        throw new Error(`Error occured during catalog fetch: ${result.reasonPhrase.phrase}`);
      const tracker = new GoodputTracker();
      struct = {
        trackName: 'catalog',
        requestId: result.requestId,
        source: result.stream,
        tracker,
        lastGroupId: -1n,
        pendingSwitch: null,
      };
    }

    // Pull the latest catalog object
    if (!struct.source) {
      throw new Error(
        'Catalog stream unavailable — the publisher may have disconnected. Restart the relay and publisher, then reconnect.',
      );
    }
    const reader = struct.source.getReader();
    let buffer: ArrayBufferLike | undefined;
    while (!buffer) {
      const result = await reader.read();
      if (result.done) {
        reader.releaseLock();
        throw new Error('Catalog stream closed unexpectedly while waiting for data');
      }
      const value = result.value;
      if (value.isEndOfGroup()) continue;
      if (!value.payload?.buffer) {
        logger.warn('media', 'Received catalog object without payload, ignoring');
        continue;
      }
      buffer = value.payload.buffer;
    }

    // Parse and store the catalog
    const catalog = CMSFCatalog.from(buffer);

    // Unsubscribe from the catalog stream since we only needed the latest object
    if (this.#options.receiveCatalogViaSubscribe) await this.unsubscribe(struct.requestId);
    return catalog;
  }

  private async subscribe(params: SubscribeOptions): Promise<MOQStreamStruct> {
    if (!this.client) throw new Error('MOQProcessor not initialized');

    // Send the appropriate control message
    let struct: MOQStreamStruct;
    const result = await this.client.subscribe({
      fullTrackName: getFullTrackName(this.#options.namespace, params.trackName),
      groupOrder: GroupOrder.Original,
      filterType: FilterType.LatestObject,
      forward: true,
      priority: params.priority ?? 0,
    });
    if (result instanceof SubscribeError)
      throw new Error(`Error occured during subscription: ${result.errorReason.phrase}`);
    const tracker = new GoodputTracker();
    struct = {
      trackName: params.trackName,
      requestId: result.requestId,
      source: result.stream,
      tracker,
      lastGroupId: -1n,
      pendingSwitch: null,
    };

    // Add the stream to the pool
    this.#streams.push(struct);
    return struct;
  }

  private async unsubscribe(requestId: bigint) {
    if (!this.client) throw new Error('MOQProcessor not initialized');

    // Find the stream struct
    const index = this.#streams.findIndex(s => s.requestId === requestId);
    if (index === -1) throw new Error(`No active subscription found for requestId ${requestId}`);
    const struct = this.#streams[index];
    if (!struct) throw new Error(`No active subscription found for requestId ${requestId}`);

    // Send the UNSUBSCRIBE message
    await this.client.unsubscribe(struct.requestId);

    // Remove the stream from the pool
    this.#streams.splice(index, 1);
  }
}

function getFullTrackName(ns: Tuple, name: string): FullTrackName {
  return FullTrackName.tryNew(ns, new TextEncoder().encode(name));
}
