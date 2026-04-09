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

interface PendingSwitch {
  trackName: string;
  initData: ArrayBuffer;
  mimeType: string;
}

type SwitchOutcome = 'idle' | 'pending' | 'success' | 'rejected' | 'error';

interface SwitchTelemetry {
  outcome: SwitchOutcome;
  fromTrack: string | null;
  toTrack: string | null;
  requestedAtMs: number | null;
  settledAtMs: number | null;
  durationMs: number | null;
  fromPlaybackTime: number | null;
  toPlaybackTime: number | null;
  playbackDeltaSeconds: number | null;
  fromLiveOffsetSeconds: number | null;
  toLiveOffsetSeconds: number | null;
  liveOffsetDeltaSeconds: number | null;
  fromGroup: string | null;
  toGroup: string | null;
  groupDelta: number | null;
  alignmentErrorSeconds: number | null;
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

export interface PlayerMetrics {
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
  liveEdgeTime: number | null;
  playbackTime: number | null;
  liveOffsetSeconds: number | null;
  currentVideoGroup: string | null;
  pendingSwitchTrack: string | null;
  metadataReady: boolean;
  metadataDelayMs: number;
  switchOutcome: SwitchOutcome;
  switchFromTrack: string | null;
  switchToTrack: string | null;
  switchRequestedAtMs: number | null;
  switchSettledAtMs: number | null;
  switchDurationMs: number | null;
  switchFromPlaybackTime: number | null;
  switchToPlaybackTime: number | null;
  switchPlaybackDeltaSeconds: number | null;
  switchFromLiveOffsetSeconds: number | null;
  switchToLiveOffsetSeconds: number | null;
  switchLiveOffsetDeltaSeconds: number | null;
  switchFromGroup: string | null;
  switchToGroup: string | null;
  switchGroupDelta: number | null;
  switchAlignmentErrorSeconds: number | null;
}

export class Player {
  catalog: CMSFCatalog | null = null;
  client: MOQtailClient | null = null;

  #element: HTMLVideoElement | null = null;
  #mse?: MediaSource;
  #streams: MOQStreamStruct[] = [];
  #metadataReady = true;
  #metadataDelayMs = 0;
  #switchTelemetry: SwitchTelemetry = {
    outcome: 'idle',
    fromTrack: null,
    toTrack: null,
    requestedAtMs: null,
    settledAtMs: null,
    durationMs: null,
    fromPlaybackTime: null,
    toPlaybackTime: null,
    playbackDeltaSeconds: null,
    fromLiveOffsetSeconds: null,
    toLiveOffsetSeconds: null,
    liveOffsetDeltaSeconds: null,
    fromGroup: null,
    toGroup: null,
    groupDelta: null,
    alignmentErrorSeconds: null,
  };
  #options: Required<Omit<PlayerOptions, 'onTrackSwitched'>> &
    Pick<PlayerOptions, 'onTrackSwitched'>;

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
    this.#switchTelemetry = {
      outcome: 'idle',
      fromTrack: null,
      toTrack: null,
      requestedAtMs: null,
      settledAtMs: null,
      durationMs: null,
      fromPlaybackTime: null,
      toPlaybackTime: null,
      playbackDeltaSeconds: null,
      fromLiveOffsetSeconds: null,
      toLiveOffsetSeconds: null,
      liveOffsetDeltaSeconds: null,
      fromGroup: null,
      toGroup: null,
      groupDelta: null,
      alignmentErrorSeconds: null,
    };
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

            // Init segment re-injection after a seamless track switch.
            // Detect the transition by comparing the object's fullTrackName
            // (resolved from the wire's track_alias) against the target track.
            // The previous approach (group !== lastGroupId) fired too early —
            // the relay may continue sending old-track groups after the SWITCH
            // is acknowledged, so a group boundary change does NOT imply a track
            // transition. Checking the actual track name is authoritative.
            const objectTrackName = struct.pendingSwitch
              ? new TextDecoder().decode(object.fullTrackName.name)
              : null;

            // During rapid ABR switching (A→B→C) the relay may deliver data
            // for intermediate tracks whose pendingSwitch was overwritten.
            // Appending that data without a changeType/init-segment would
            // corrupt the SourceBuffer. Drop anything that doesn't belong
            // to either the current track or the pending switch target.
            if (
              objectTrackName !== null &&
              objectTrackName !== struct.trackName &&
              objectTrackName !== struct.pendingSwitch?.trackName
            ) {
              logger.info(
                'media',
                `Dropping intermediate track data (${objectTrackName}) while switching to ${struct.pendingSwitch?.trackName}`,
              );
              return;
            }

            if (struct.pendingSwitch && objectTrackName === struct.pendingSwitch.trackName) {
              const { initData, mimeType, trackName: newTrackName } = struct.pendingSwitch;
              struct.trackName = newTrackName;
              struct.pendingSwitch = null;

              const settledAtMs = Date.now();
              const toPlaybackTime = this.#element ? this.#element.currentTime : null;
              const toLiveEdgeTime =
                this.#element?.buffered && this.#element.buffered.length > 0
                  ? this.#element.buffered.end(this.#element.buffered.length - 1)
                  : null;
              const toLiveOffsetSeconds =
                toLiveEdgeTime !== null && toPlaybackTime !== null
                  ? Math.max(0, toLiveEdgeTime - toPlaybackTime)
                  : null;
              const fromGroupBigInt =
                this.#switchTelemetry.fromGroup !== null
                  ? BigInt(this.#switchTelemetry.fromGroup)
                  : null;
              const groupDelta =
                fromGroupBigInt !== null ? Number(object.location.group - fromGroupBigInt) : null;
              const playbackDeltaSeconds =
                this.#switchTelemetry.fromPlaybackTime !== null && toPlaybackTime !== null
                  ? toPlaybackTime - this.#switchTelemetry.fromPlaybackTime
                  : null;
              const liveOffsetDeltaSeconds =
                this.#switchTelemetry.fromLiveOffsetSeconds !== null && toLiveOffsetSeconds !== null
                  ? toLiveOffsetSeconds - this.#switchTelemetry.fromLiveOffsetSeconds
                  : null;
              const durationMs =
                this.#switchTelemetry.requestedAtMs !== null
                  ? settledAtMs - this.#switchTelemetry.requestedAtMs
                  : null;

              this.#switchTelemetry = {
                ...this.#switchTelemetry,
                outcome: 'success',
                settledAtMs,
                durationMs,
                toPlaybackTime,
                playbackDeltaSeconds,
                toLiveOffsetSeconds,
                liveOffsetDeltaSeconds,
                toGroup: object.location.group.toString(),
                groupDelta,
                alignmentErrorSeconds:
                  playbackDeltaSeconds !== null ? Math.abs(playbackDeltaSeconds) : null,
              };

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
                this.#switchTelemetry = {
                  ...this.#switchTelemetry,
                  outcome: 'error',
                  settledAtMs: Date.now(),
                };
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
                  logger.error(
                    'media',
                    `Error appending to SourceBuffer, retrying... (${maxRetries} attempts left)`,
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

            // Record goodput sample — tracker uses internal windowed byte counter
            struct.tracker.recordObject(object.payload.byteLength, 0);
            // Track last seen group for switch boundary detection
            struct.lastGroupId = object.location.group;
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

  getMetrics(): PlayerMetrics {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    const buffered = this.#element?.buffered;
    const liveEdgeTime = buffered && buffered.length > 0 ? buffered.end(buffered.length - 1) : null;
    const playbackTime = this.#element ? this.#element.currentTime : null;
    const bufferSeconds =
      liveEdgeTime !== null && playbackTime !== null ? Math.max(0, liveEdgeTime - playbackTime) : 0;
    const currentVideoGroup =
      videoStruct && videoStruct.lastGroupId >= 0n ? videoStruct.lastGroupId.toString() : null;
    const quality = this.#element?.getVideoPlaybackQuality?.();
    return {
      bandwidthBps: videoStruct?.tracker.getBandwidthBps() ?? 0,
      fastEmaBps: videoStruct?.tracker.getFastEmaBps() ?? 0,
      slowEmaBps: videoStruct?.tracker.getSlowEmaBps() ?? 0,
      bufferSeconds,
      activeTrack: videoStruct?.trackName ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? 0,
      totalFrames: quality?.totalVideoFrames ?? 0,
      playbackRate: this.#element?.playbackRate ?? 1,
      deliveryTimeMs: videoStruct?.tracker.getLastDeliveryTimeMs() ?? 0,
      lastObjectBytes: videoStruct?.tracker.getLastObjectBytes() ?? 0,
      liveEdgeTime,
      playbackTime,
      liveOffsetSeconds:
        liveEdgeTime !== null && playbackTime !== null
          ? Math.max(0, liveEdgeTime - playbackTime)
          : null,
      currentVideoGroup,
      pendingSwitchTrack: videoStruct?.pendingSwitch?.trackName ?? null,
      metadataReady: this.#metadataReady,
      metadataDelayMs: this.#metadataDelayMs,
      switchOutcome: this.#switchTelemetry.outcome,
      switchFromTrack: this.#switchTelemetry.fromTrack,
      switchToTrack: this.#switchTelemetry.toTrack,
      switchRequestedAtMs: this.#switchTelemetry.requestedAtMs,
      switchSettledAtMs: this.#switchTelemetry.settledAtMs,
      switchDurationMs: this.#switchTelemetry.durationMs,
      switchFromPlaybackTime: this.#switchTelemetry.fromPlaybackTime,
      switchToPlaybackTime: this.#switchTelemetry.toPlaybackTime,
      switchPlaybackDeltaSeconds: this.#switchTelemetry.playbackDeltaSeconds,
      switchFromLiveOffsetSeconds: this.#switchTelemetry.fromLiveOffsetSeconds,
      switchToLiveOffsetSeconds: this.#switchTelemetry.toLiveOffsetSeconds,
      switchLiveOffsetDeltaSeconds: this.#switchTelemetry.liveOffsetDeltaSeconds,
      switchFromGroup: this.#switchTelemetry.fromGroup,
      switchToGroup: this.#switchTelemetry.toGroup,
      switchGroupDelta: this.#switchTelemetry.groupDelta,
      switchAlignmentErrorSeconds: this.#switchTelemetry.alignmentErrorSeconds,
    };
  }

  setEmaAlphas(alphaFast: number, alphaSlow: number): void {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    videoStruct?.tracker.setAlphas(alphaFast, alphaSlow);
  }

  setMetadataState(ready: boolean, delayMs: number): void {
    this.#metadataReady = ready;
    this.#metadataDelayMs = Math.max(0, delayMs);
  }

  /** Poll WebTransport stats for the active video track's goodput tracker. */
  async pollGoodput(): Promise<void> {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    await videoStruct?.tracker.poll();
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
      this.#switchTelemetry = {
        ...this.#switchTelemetry,
        outcome: 'error',
        settledAtMs: Date.now(),
      };
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
        this.#switchTelemetry = {
          ...this.#switchTelemetry,
          outcome: 'rejected',
          settledAtMs: Date.now(),
        };
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
      const requestedAtMs = Date.now();
      const fromPlaybackTime = this.#element ? this.#element.currentTime : null;
      const fromLiveEdgeTime =
        this.#element?.buffered && this.#element.buffered.length > 0
          ? this.#element.buffered.end(this.#element.buffered.length - 1)
          : null;
      const fromLiveOffsetSeconds =
        fromLiveEdgeTime !== null && fromPlaybackTime !== null
          ? Math.max(0, fromLiveEdgeTime - fromPlaybackTime)
          : null;
      videoStruct.pendingSwitch = { trackName, initData: initData.buffer as ArrayBuffer, mimeType };
      this.#switchTelemetry = {
        outcome: 'pending',
        fromTrack: videoStruct.trackName,
        toTrack: trackName,
        requestedAtMs,
        settledAtMs: null,
        durationMs: null,
        fromPlaybackTime,
        toPlaybackTime: null,
        playbackDeltaSeconds: null,
        fromLiveOffsetSeconds,
        toLiveOffsetSeconds: null,
        liveOffsetDeltaSeconds: null,
        fromGroup: videoStruct.lastGroupId >= 0n ? videoStruct.lastGroupId.toString() : null,
        toGroup: null,
        groupDelta: null,
        alignmentErrorSeconds: null,
      };
    } catch (error) {
      logger.error('media', 'switchTrack: unexpected error', error);
      this.#switchTelemetry = {
        ...this.#switchTelemetry,
        outcome: 'error',
        settledAtMs: Date.now(),
      };
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
      if (this.client) tracker.setTransport(this.client.webTransport);
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
    if (this.client.webTransport) tracker.setTransport(this.client.webTransport);
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
