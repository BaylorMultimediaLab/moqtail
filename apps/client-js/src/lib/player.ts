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
  FetchType,
  FilterType,
  FullTrackName,
  GroupOrder,
  Location,
  MoqtObject,
  RequestError,
  Tuple,
} from 'moqtail';
import { MOQtailClient } from 'moqtail/client';
import { CMSFCatalog, MessageParameters, type MessageParameter } from 'moqtail/model';
import { logger } from '@/lib/logger';
import { GoodputTracker } from '@/lib/goodput';
import { LatencyTracker } from '@/lib/latencyTracker';
import { parseMoofBaseMediaDecodeTime, parseMoofMediaInfo } from '@/lib/util/MoofParser';
import { TimeMap } from '@/lib/abr/TimeMap';
import { events } from '@/lib/events/EventLog';
import { estimateLiveEdge, readPrft, targetShiftMs, type PrftAnchor } from '@/lib/events/liveEdge';
import { DEFAULT_LIVE_EDGE_DELAY } from '@/lib/buffer';

/**
 * One record per track-switch (or, in C4, per time-shifted connect).
 * Pushed to window.__moqtailMetrics.switchDiscontinuities for offline analysis.
 */
export interface DiscontinuityRecord {
  eventType: 'connect' | 'switch';
  switchSentAt: number;
  switchAppliedAt: number;
  fromTrack?: string;
  toTrack: string;

  // PTS-domain (headline)
  oldEndPTS_ms?: number;
  newStartPTS_ms: number;
  /** Media seam gap: newStartPTS_ms - oldEndPTS_ms. Buffered-region continuity at
   *  the seam (0 = contiguous), not a viewer-visible discontinuity. */
  mediaSeamGapMs: number;
  /** Playhead at the moment switchTrack() fired (video.currentTime * 1000). Undefined for `connect` records. */
  playheadPTS_ms?: number;
  /** Seam distance ahead of the playhead: newStartPTS_ms - playheadPTS_ms, i.e. how
   *  much media the viewer still plays before seeing the new representation.
   *  Undefined for `connect` records. */
  seamAheadOfPlayheadMs?: number;

  // wall-clock context
  wallClockMs: number;
  /** Wall-clock pause at the seam crossing beyond one frame period (ms). */
  viewerPauseMs?: number;

  // connect-time clamp signal (Task C4)
  expectedStartGroup?: number;
  actualStartGroup?: number;
  clampedByRelay?: boolean;

  // mode context (every record)
  clientMode: 'time-shifted' | 'live-edge';
  timeShiftSeconds: number;
}

interface PendingSwitch {
  trackName: string;
  initData: ArrayBuffer;
  mimeType: string;
  /** Snapshot of struct.lastAppendedEndPTS_ms at the moment switchTrack() was called. */
  oldEndPTS_ms: number | undefined;
  /** Snapshot of video.currentTime * 1000 at switchTrack() call, for `seamAheadOfPlayheadMs`. */
  playheadPTS_ms: number | undefined;
  /** performance.now() at switchTrack() call — for wallClockMs and the visibility delay. */
  switchSentAt: number;
  /** videoElement.getVideoPlaybackQuality().totalVideoFrames at switch time (diagnostic). */
  framesAtSwitch: number;
}

interface MOQStreamStruct {
  trackName: string;
  source: ReadableStream<MoqtObject>;
  requestId: bigint;
  tracker: GoodputTracker;
  lastGroupId: bigint;
  pendingSwitch: PendingSwitch | null;
  /** End PTS (ms) of the last appended segment from the active track. Updated before each appendBuffer call. Undefined until the first segment is appended. */
  lastAppendedEndPTS_ms: number | undefined;
  /** Set true after the first new-track frame is presented post-switch. Reset when pendingSwitch is set. */
  firstFrameAfterSwitchSeen?: boolean;
  /**
   * Media time (ms) where the new representation begins in the buffer: the
   * first appended target frame's PTS. The rVFC poll watches presented
   * `mediaTime` cross it; that presented frame is the first the viewer sees
   * of the new representation. Set when the new init segment is applied;
   * cleared by the poll.
   */
  postSwitchSeamPTS_ms?: number;
  /** Frame duration (ms) of the most recently parsed object, for seam arithmetic. */
  lastFrameDurationMs?: number;
  /** Snapshot of pendingSwitch.switchSentAt at the moment of init-segment application. */
  postSwitchSentAt?: number;
  /** Source track of the switch whose first frame is awaited (for SWITCH_FIRST_FRAME). */
  postSwitchFromTrack?: string;
  /** tracker.getSampleCount() after the previous object; a change means a THROUGHPUT_SAMPLE was finalised. */
  lastSampleCount?: number;
  /** Track name to attach viewerPauseMs to in switchDiscontinuities. */
  postSwitchToTrack?: string;
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
  /** Pre-connect: 'time-shifted' clients subscribe behind live by `timeShiftSeconds`; 'live-edge' is today's behavior. */
  clientMode?: 'time-shifted' | 'live-edge';
  /** When clientMode === 'time-shifted', subscribe at `timeShiftSeconds` behind the live edge. */
  timeShiftSeconds?: number;
  /** Experiment log: emit one OBJECT_RECV record per received media object (frame). */
  logObjects?: boolean;
  /**
   * A pending switch "lands" only once the client library has mapped the
   * switched subscription's request id to a track alias, i.e. a data stream
   * for the target arrived after the switch. Without this, trailing objects
   * of an earlier subscription to the same track (A -> B -> A) are mistaken
   * for the new track and the next switch fails inside the library.
   */
  landingRequiresAliasMapping?: boolean;
}

const DefaultOptions = {
  relayUrl: 'https://relay.moqtail.dev',
  namespace: Tuple.fromUtf8Path('/moqtail'),
  receiveCatalogViaSubscribe: false,
  catalogLocation: [new Location(0n, 0n), new Location(0n, 1n)],
  onTrackSwitched: undefined as ((trackName: string) => void) | undefined,
  clientMode: 'live-edge' as 'time-shifted' | 'live-edge',
  timeShiftSeconds: 0,
  logObjects: false,
  landingRequiresAliasMapping: true,
} satisfies Required<Omit<PlayerOptions, 'onTrackSwitched'>> &
  Pick<PlayerOptions, 'onTrackSwitched'>;

/**
 * Builds the `parameters` field for a media-track SUBSCRIBE.
 *
 * - For live-edge mode: returns `undefined` (no parameters added — today's behavior).
 * - For time-shifted mode: returns a parameter list carrying
 *   `DELAY_GROUPS = round(timeShiftSeconds * 1000 / gopDurationMs)`.
 *
 * The relay reads `DELAY_GROUPS` and starts delivery `delay_groups` behind the live edge.
 */
export function buildSubscribeParameters(opts: {
  clientMode: 'time-shifted' | 'live-edge';
  timeShiftSeconds: number;
  gopDurationMs: number;
}): MessageParameter[] | undefined {
  if (opts.clientMode !== 'time-shifted') return undefined;
  if (opts.timeShiftSeconds <= 0) return undefined;
  const delayGroups = Math.round((opts.timeShiftSeconds * 1000) / opts.gopDurationMs);
  if (delayGroups <= 0) return undefined;
  return new MessageParameters().addDelayGroups(delayGroups).build();
}

/**
 * Compute the seek target for playback startup. Live-edge clients seek
 * 1.0s behind the live edge so MSE has buffer runway; time-shifted clients
 * are already `timeShiftSeconds` behind live and don't need the extra
 * offset.
 *
 * Exported for unit testing.
 */
export const LIVE_EDGE_STARTUP_OFFSET_SECONDS = 1.0;

export function computeStartupTarget(opts: {
  end: number;
  baseTarget: number;
  clientMode: 'time-shifted' | 'live-edge';
  /** Seconds-behind-live-edge target for time-shifted mode. Ignored when live-edge.
   *  Defaults to 0 (today's broken behavior) only when not provided — callers
   *  in time-shifted mode SHOULD pass this. */
  timeShiftSeconds?: number;
}): number {
  const offset =
    opts.clientMode === 'time-shifted'
      ? (opts.timeShiftSeconds ?? 0)
      : LIVE_EDGE_STARTUP_OFFSET_SECONDS;
  return Math.max(opts.baseTarget, opts.end - offset);
}

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
  // Connect-time state (Task C4) for time-shifted-mode clamp detection.
  // Captured in subscribe(); consumed once on the first received object.
  #connectSentAt: number | undefined;
  #expectedStartGroupId: number | undefined;
  // PTS <-> group lookup populated from incoming object decode times.
  // Measurement only: maps the playhead to the group it is showing.
  #timeMap: TimeMap | undefined;
  // Most recent Producer Reference Time seen on the video track; anchors the
  // live-edge estimate (see lib/events/liveEdge.ts).
  #prftAnchor: PrftAnchor | undefined;
  #videoTimescale = 0;
  // Startup timeline (performance.now()) for the STARTUP record.
  #tConnectStart: number | undefined;
  #tFirstObject: number | undefined;
  #firstFrameSeen = false;
  // Open stall, if any: STALL_START was emitted and STALL_END is pending.
  #stall: { startPerf: number; cause: 'waiting' | 'frozen'; playheadMs: number } | null = null;

  constructor(options: Partial<PlayerOptions> = {}) {
    this.#options = { ...DefaultOptions, ...options };
  }

  async initialize() {
    // If we already received the catalog, skip initialization
    if (this.catalog) return this.catalog;

    this.#tConnectStart = performance.now();
    events.emit('CONNECT_START', { relay_url: this.#options.relayUrl });
    try {
      // Initialize the client and fetch the catalog
      this.client = await MOQtailClient.new({
        url: this.#options.relayUrl,
      });
    } catch (error) {
      logger.error('media', 'Failed to connect to relay', (error as Error).message);
      events.emit('ERROR', { where: 'connect', message: (error as Error).message });
      throw error;
    }
    events.emit('CONNECTED', { connect_ms: performance.now() - this.#tConnectStart });

    // Debug-only escape hatch: lets the network test harness force a SWITCH
    // without going through the AbrController. Used by Slice C/Phase B E2Es
    // (see tests/network/scenarios/test_naive_switch_discontinuity.py). Not
    // for production use — direct switchTrack() calls bypass the ABR
    // switching guard's bookkeeping.
    if (typeof window !== 'undefined') {
      (window as Window & { __forceSwitch?: (trackName: string) => Promise<void> }).__forceSwitch =
        (trackName: string) => this.switchTrack(trackName);
    }

    // Fetch the catalog
    try {
      this.catalog = await this.retrieveCatalog();
    } catch (error) {
      logger.error('media', 'Failed to retrieve catalog', (error as Error).message);
      events.emit('ERROR', { where: 'catalog', message: (error as Error).message });
      throw error;
    }
    events.emit('CATALOG', {
      since_connect_ms: performance.now() - this.#tConnectStart,
      tracks: this.catalog.getTracks().map(t => ({
        name: t.name,
        role: t.role,
        bitrate: t.bitrate,
        width: t.width,
        height: t.height,
      })),
    });

    // Construct the TimeMap once, anchored on the video track's GOP duration.
    // Quality variants share a TimeMap — gopDurationMs is equal across them in practice.
    const videoTracks = this.catalog?.getTracks('video');
    const videoTrack = videoTracks?.[0];
    if (videoTrack) {
      const gopDurationMs = this.catalog!.getGopDurationMs(videoTrack.name);
      this.#timeMap = new TimeMap(gopDurationMs);
      this.#videoTimescale = this.catalog!.getTimescale(videoTrack.name) ?? 0;
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

    // Tear down the debug-only force-switch hook installed in initialize().
    if (typeof window !== 'undefined') {
      delete (window as Window & { __forceSwitch?: unknown }).__forceSwitch;
    }

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
        this.#closeStall();
        return;
      }
      if (el.paused || el.ended) return;
      frozenSince += 1;
      if (frozenSince < 2) return; // wait ~1s of confirmed freeze
      // Frozen frames while playing is a stall whether or not the element
      // fired `waiting`; the interval is credited from the first frozen tick.
      this.#openStall('frozen', performance.now() - 500 * (frozenSince - 1));
      const buf = el.buffered;
      for (let i = 0; i < buf.length - 1; i++) {
        const end = buf.end(i);
        const nextStart = buf.start(i + 1);
        if (el.currentTime >= end - 0.05 && nextStart > end && nextStart - end < 1.5) {
          logger.info(
            'media',
            `Wedge detected at ${el.currentTime.toFixed(2)}s, seeking across ${end.toFixed(2)}-${nextStart.toFixed(2)} gap`,
          );
          events.emit('SEEK', {
            reason: 'wedge',
            from_ms: el.currentTime * 1000,
            to_ms: (nextStart + 0.001) * 1000,
            gap_ms: (nextStart - end) * 1000,
          });
          el.currentTime = nextStart + 0.001;
          frozenSince = 0;
          return;
        }
      }
    }, 500);
    this.#disposers.push(() => clearInterval(wedgeIntervalId));

    // Element-reported stalls: `waiting` opens, `playing` closes. Frozen-frame
    // detection above catches stalls the element never reports.
    const onWaiting = () => this.#openStall('waiting', performance.now());
    const onPlaying = () => this.#closeStall();
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('playing', onPlaying);
    this.#disposers.push(() => {
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('playing', onPlaying);
    });

    // Convenience function to wait for buffer updates
    const waitForBufferUpdate = (sourceBuffer: SourceBuffer) =>
      new Promise<void>(resolve =>
        sourceBuffer.addEventListener('updateend', () => resolve(), { once: true }),
      );

    // Seek behind the live edge so the player starts with buffer runway.
    // Without this offset the player lands on the live edge (0 s buffer),
    // immediately stalls, recovers for a moment, then stalls again —
    // creating the "video gets stuck" symptom.

    let gotNotification = 0;
    let target = 0;
    const bufferNotification = (end: number) => {
      if (gotNotification >= this.#streams.length) return false;

      // Start behind the live edge so there is buffer to consume while
      // new data continues arriving. The MSEBuffer module then fine-tunes
      // the distance via playback-rate adjustments (catchup / catchdown).
      target = computeStartupTarget({
        end,
        baseTarget: target,
        clientMode: this.#options.clientMode,
        timeShiftSeconds: this.#options.timeShiftSeconds,
      });

      gotNotification++;
      if (gotNotification === this.#streams.length) {
        logger.info(
          'media',
          `All buffers ready, seeking to ${target.toFixed(2)}s (live edge ${end.toFixed(2)}s)`,
        );
        events.emit('SEEK', {
          reason: 'startup',
          from_ms: this.#element!.currentTime * 1000,
          to_ms: target * 1000,
          buffered_end_ms: end * 1000,
        });
        this.#element!.currentTime = target;
        this.#element!.play();
        // Install the rVFC poll that detects first-frame-rendered post-switch
        // and the seam-crossing metrics. Safe to install once playback
        // has started — the element is non-null and ready to render frames.
        this.#installPerceivedPausePoll();
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
              events.emit('DROP_STALE', {
                track: objectTrackName,
                current: struct.trackName,
                pending: struct.pendingSwitch?.trackName ?? null,
                group: object.location.group,
                object: object.location.object,
              });
              return;
            }

            if (
              struct.pendingSwitch &&
              objectTrackName === struct.pendingSwitch.trackName &&
              this.#options.landingRequiresAliasMapping &&
              objectTrackName !== struct.trackName &&
              this.client !== null &&
              !this.client.subscriptionAliasMap.has(struct.requestId)
            ) {
              // Same track name, but the library has not yet seen a stream for
              // the switched subscription: this is a trailing object of the
              // earlier subscription to that track, not the switch landing.
              events.emit('DROP_STALE', {
                track: objectTrackName,
                current: struct.trackName,
                pending: struct.pendingSwitch.trackName,
                group: object.location.group,
                object: object.location.object,
                reason: 'pre-landing',
              });
              return;
            }

            if (struct.pendingSwitch && objectTrackName === struct.pendingSwitch.trackName) {
              const {
                initData,
                mimeType,
                trackName: newTrackName,
                oldEndPTS_ms,
                playheadPTS_ms,
                switchSentAt,
                framesAtSwitch,
              } = struct.pendingSwitch;
              const fromTrack = struct.trackName; // capture BEFORE overwriting
              // The source's last appended frame at the moment the switch lands
              // (the send-time snapshot in pendingSwitch predates ~1 GOP of
              // source frames that arrived while the SWITCH was in flight).
              const sourceEndAtApplyPTS_ms = struct.lastAppendedEndPTS_ms;
              struct.trackName = newTrackName;
              struct.pendingSwitch = null;
              struct.firstFrameAfterSwitchSeen = false;
              // Stash post-switch state on sibling struct fields that survive the
              // pendingSwitch clear; the rVFC poll consumes them once the presented
              // media time crosses the seam.
              void framesAtSwitch;
              struct.postSwitchSentAt = switchSentAt;
              struct.postSwitchToTrack = newTrackName;
              struct.postSwitchFromTrack = fromTrack;
              events.emit('SWITCH_FIRST_OBJECT', {
                from: fromTrack,
                to: newTrackName,
                group: object.location.group,
                object: object.location.object,
                since_sent_ms: performance.now() - switchSentAt,
              });

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

              // Compute and push the discontinuity record. PTS-gap is the headline
              // metric: signed difference between the first appended frame's PTS on
              // the new track and the last appended frame's end PTS on the old track.
              const newTimescale = this.catalog?.getTimescale(newTrackName);
              const newStartPTS_ms =
                newTimescale && newTimescale > 0
                  ? parseMoofBaseMediaDecodeTime(
                      new Uint8Array(
                        object.payload.buffer,
                        object.payload.byteOffset,
                        object.payload.byteLength,
                      ),
                      newTimescale,
                    )
                  : undefined;

              events.emit('SWITCH_APPLIED', {
                from: fromTrack,
                to: newTrackName,
                group: object.location.group,
                object: object.location.object,
                new_start_pts_ms: newStartPTS_ms ?? null,
                old_end_pts_ms: sourceEndAtApplyPTS_ms ?? null,
                old_end_pts_at_send_ms: oldEndPTS_ms ?? null,
                // Seam continuity of the appended media: first target frame PTS
                // minus the last appended source frame's end PTS at landing time
                // (0 = contiguous, >0 = hole, <0 = overlap: the target restarts
                // inside media the source already covered).
                media_seam_gap_ms:
                  newStartPTS_ms !== undefined && sourceEndAtApplyPTS_ms !== undefined
                    ? newStartPTS_ms - sourceEndAtApplyPTS_ms
                    : null,
                // A switch that lands on object 0 starts on the group's keyframe.
                landed_on_group_start: object.location.object === 0n,
                playhead_ms: playheadPTS_ms ?? null,
                // How far ahead of the viewer the new representation lands: the
                // media the viewer still has to play before seeing it. NOT a
                // playback-position jump; that is measured at the seam crossing.
                seam_ahead_of_playhead_ms:
                  newStartPTS_ms !== undefined && playheadPTS_ms !== undefined
                    ? newStartPTS_ms - playheadPTS_ms
                    : null,
                since_sent_ms: performance.now() - switchSentAt,
              });
              struct.postSwitchSeamPTS_ms = newStartPTS_ms;

              if (newStartPTS_ms !== undefined) {
                const mediaSeamGapMs =
                  sourceEndAtApplyPTS_ms !== undefined
                    ? newStartPTS_ms - sourceEndAtApplyPTS_ms
                    : 0;
                const seamAheadOfPlayheadMs =
                  playheadPTS_ms !== undefined ? newStartPTS_ms - playheadPTS_ms : undefined;
                const wallClockMs = performance.now() - switchSentAt;
                const record: DiscontinuityRecord = {
                  eventType: 'switch',
                  switchSentAt,
                  switchAppliedAt: performance.now(),
                  fromTrack,
                  toTrack: newTrackName,
                  oldEndPTS_ms,
                  newStartPTS_ms,
                  mediaSeamGapMs,
                  playheadPTS_ms,
                  seamAheadOfPlayheadMs,
                  wallClockMs,
                  clientMode: this.#options.clientMode,
                  timeShiftSeconds: this.#options.timeShiftSeconds,
                };
                if (typeof window !== 'undefined') {
                  const w = window as Window & {
                    __moqtailMetrics?: {
                      switchDiscontinuities?: DiscontinuityRecord[];
                      [k: string]: unknown;
                    };
                  };
                  w.__moqtailMetrics ??= {} as Window['__moqtailMetrics'] & object;
                  const metrics = w.__moqtailMetrics as Window['__moqtailMetrics'] & {
                    switchDiscontinuities?: DiscontinuityRecord[];
                  };
                  metrics.switchDiscontinuities ??= [];
                  metrics.switchDiscontinuities.push(record);
                }
              }

              // NOW release the ABR switching guard — the relay has completed the
              // transition and delivered data on the new track. Safe to switch again.
              this.#options.onTrackSwitched?.(newTrackName);
            }

            // Update lastAppendedEndPTS_ms before appending. C3 will read this for the
            // "old end PTS" half of the discontinuity calculation.
            // Publisher emits one moof+mdat per access unit (see apps/publisher/src/cmaf.rs),
            // so each moof's tfdt is a per-frame decode time and the trun carries that
            // frame's duration. End PTS = decodeTime + frameDuration (NOT + gopDuration).
            const timescale = this.catalog?.getTimescale(struct.trackName);
            let decodeTimeMs: number | undefined;
            if (timescale && timescale > 0) {
              const info = parseMoofMediaInfo(
                new Uint8Array(
                  object.payload.buffer,
                  object.payload.byteOffset,
                  object.payload.byteLength,
                ),
                timescale,
              );
              if (info !== undefined) {
                decodeTimeMs = info.decodeTimeMs;
                struct.lastAppendedEndPTS_ms = info.decodeTimeMs + info.frameDurationMs;
                struct.lastFrameDurationMs = info.frameDurationMs;
                // Feed the TimeMap so measurements can resolve playhead -> group.
                // Only the first object of each group records (idempotent in TimeMap),
                // and frame 0 of a group has decodeTime == group start PTS.
                if (this.#timeMap) {
                  this.#timeMap.recordGroupBoundary(
                    Number(object.location.group),
                    info.decodeTimeMs,
                  );
                }
              }
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
            const previousGroupId = struct.lastGroupId;
            struct.tracker.recordObject(object.payload.byteLength, object.location.group);
            struct.lastGroupId = object.location.group;
            // A group roll-over finalises the previous group's throughput sample.
            const sampleCountNow = struct.tracker.getSampleCount();
            if (struct.lastSampleCount !== undefined && sampleCountNow > struct.lastSampleCount) {
              events.emit('THROUGHPUT_SAMPLE', {
                track: struct.trackName,
                group: previousGroupId,
                bytes: struct.tracker.getLastSampleBytes(),
                duration_ms: struct.tracker.getLastDeliveryTimeMs(),
                bps: struct.tracker.getLastSampleBps(),
                swma_bps: struct.tracker.getBandwidthBps(),
                fast_ema_bps: struct.tracker.getFastEmaBps(),
                slow_ema_bps: struct.tracker.getSlowEmaBps(),
                sample_count: sampleCountNow,
              });
            }
            struct.lastSampleCount = sampleCountNow;

            // First-received-group export for E2E smoke + connect-time metrics (Phase C).
            // Only set once across all streams to capture the earliest received group.
            if (typeof window !== 'undefined') {
              if (window.__moqtailMetrics === undefined) {
                window.__moqtailMetrics = { abr: null, samples: null };
              }
              const isFirstObject = window.__moqtailMetrics.firstReceivedGroupId === undefined;
              if (isFirstObject) {
                window.__moqtailMetrics.firstReceivedGroupId = Number(object.location.group);
                this.#tFirstObject = performance.now();
                const expectedGroup = this.#expectedStartGroupId;
                events.emit('FIRST_OBJECT', {
                  track: struct.trackName,
                  group: object.location.group,
                  object: object.location.object,
                  pts_ms: decodeTimeMs ?? null,
                  expected_start_group: expectedGroup ?? null,
                  clamped:
                    expectedGroup !== undefined
                      ? Number(object.location.group) > expectedGroup
                      : null,
                  since_connect_ms:
                    this.#tConnectStart !== undefined
                      ? this.#tFirstObject - this.#tConnectStart
                      : null,
                });

                // Connect-time discontinuity record (Task C4): emit only if we
                // were in time-shifted mode AND we have a known expected start
                // group (i.e. the relay sent a SubscribeOk with largestLocation
                // and delay_groups was non-zero).
                if (
                  this.#options.clientMode === 'time-shifted' &&
                  this.#expectedStartGroupId !== undefined &&
                  this.#connectSentAt !== undefined
                ) {
                  const expected = this.#expectedStartGroupId;
                  const actual = Number(object.location.group);
                  // Relay clamps when our requested target was older than the
                  // oldest cached group: it returns a more-recent group instead.
                  const clampedByRelay = actual > expected;

                  const connectTimescale = this.catalog?.getTimescale(struct.trackName);
                  const newStartPTS_ms =
                    connectTimescale && connectTimescale > 0
                      ? parseMoofBaseMediaDecodeTime(
                          new Uint8Array(
                            object.payload.buffer,
                            object.payload.byteOffset,
                            object.payload.byteLength,
                          ),
                          connectTimescale,
                        )
                      : undefined;

                  const connectGopDurationMs =
                    this.catalog?.getGopDurationMs(struct.trackName) ?? 1000;
                  const mediaSeamGapMs = (actual - expected) * connectGopDurationMs;
                  const wallClockMs = performance.now() - this.#connectSentAt;

                  const record: DiscontinuityRecord = {
                    eventType: 'connect',
                    switchSentAt: this.#connectSentAt,
                    switchAppliedAt: performance.now(),
                    toTrack: struct.trackName,
                    newStartPTS_ms: newStartPTS_ms ?? 0,
                    mediaSeamGapMs,
                    wallClockMs,
                    expectedStartGroup: expected,
                    actualStartGroup: actual,
                    clampedByRelay,
                    clientMode: this.#options.clientMode,
                    timeShiftSeconds: this.#options.timeShiftSeconds,
                  };
                  window.__moqtailMetrics.switchDiscontinuities ??= [];
                  window.__moqtailMetrics.switchDiscontinuities.push(record);
                }
              }
            }

            // Read PRFT box (if any) at the head of the CMAF chunk.
            // Publisher prepends `prft` per ISO/IEC 14496-12 §8.16.5 so the
            // receiver can compute end-to-end latency per frame. MSE skips
            // unknown top-level boxes, so the chunk is appended unchanged.
            // `object.payload` is already a Uint8Array view at the right
            // offset — pass it directly so we don't accidentally read from
            // byte 0 of a shared underlying ArrayBuffer.
            const prft = readPrft(object.payload);
            let latencyMs: number | null = null;
            if (prft !== null) {
              latencyMs = Date.now() - prft.captureMs;
              this.#latencyTracker.record(latencyMs);
              const anchorTimescale =
                this.catalog?.getTimescale(objectTrackName) ?? this.#videoTimescale;
              if (anchorTimescale > 0) {
                this.#prftAnchor = {
                  captureMs: prft.captureMs,
                  mediaMs: (prft.mediaTime * 1000) / anchorTimescale,
                };
              }
            }
            if (this.#options.logObjects) {
              events.emit('OBJECT_RECV', {
                track: objectTrackName,
                group: object.location.group,
                object: object.location.object,
                bytes: object.payload.byteLength,
                pts_ms: decodeTimeMs ?? null,
                prft_capture_ms: prft?.captureMs ?? null,
                latency_ms: latencyMs,
              });
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
    sampleCount: number;
    readyState: number;
    paused: boolean;
    currentTime: number;
    bufferedRanges: string;
    mseReadyState: string;
    videoErrorCode: number;
    latencyTrendRatio: number;
    lastLatencyMs: number;
    playheadMs: number;
    bufferedEndMs: number;
    liveEdgeDistanceMs: number;
    timeShiftErrorMs: number;
    activeGroup: number | null;
  } {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    const el = this.#element;
    const buffered = el?.buffered;
    const bufferSeconds =
      buffered && buffered.length > 0 && el
        ? Math.max(0, buffered.end(buffered.length - 1) - el.currentTime)
        : 0;
    const playheadMs = (el?.currentTime ?? 0) * 1000;
    const bufferedEndMs =
      buffered && buffered.length > 0 ? buffered.end(buffered.length - 1) * 1000 : 0;
    let liveEdgeDistanceMs = Number.NaN;
    let timeShiftErrorMs = Number.NaN;
    if (this.#prftAnchor && el) {
      const gopDurationMs = this.#timeMap?.gopDurationMs ?? 0;
      const target = targetShiftMs({
        clientMode: this.#options.clientMode,
        timeShiftSeconds: this.#options.timeShiftSeconds,
        gopDurationMs,
        liveEdgeDelaySeconds: DEFAULT_LIVE_EDGE_DELAY,
      });
      const est = estimateLiveEdge({
        anchor: this.#prftAnchor,
        nowMs: Date.now(),
        playheadMs,
        targetShiftMs: target.targetShiftMs,
      });
      liveEdgeDistanceMs = est.liveEdgeDistanceMs;
      timeShiftErrorMs = est.timeShiftErrorMs;
    }
    const activeGroup =
      this.#timeMap && el && this.#timeMap.hasAnchor()
        ? (this.#timeMap.groupContainingPTS(playheadMs) ?? null)
        : null;
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
      sampleCount: videoStruct?.tracker.getSampleCount() ?? 0,
      readyState: el?.readyState ?? 0,
      paused: el?.paused ?? true,
      currentTime: el?.currentTime ?? 0,
      bufferedRanges,
      mseReadyState: this.#mse?.readyState ?? 'closed',
      videoErrorCode: el?.error?.code ?? 0,
      latencyTrendRatio: this.#latencyTracker.getTrendRatio(),
      lastLatencyMs: this.#latencyTracker.getLastLatencyMs(),
      playheadMs,
      bufferedEndMs,
      liveEdgeDistanceMs,
      timeShiftErrorMs,
      activeGroup,
    };
  }

  #openStall(cause: 'waiting' | 'frozen', startPerf: number): void {
    if (this.#stall !== null || !this.#element) return;
    if (!this.#firstFrameSeen) return; // pre-startup waiting is startup delay, not a stall
    const playheadMs = this.#element.currentTime * 1000;
    this.#stall = { startPerf, cause, playheadMs };
    events.emit('STALL_START', {
      cause,
      playhead_ms: playheadMs,
      track: this.getMetrics().activeTrack,
    });
  }

  #closeStall(): void {
    if (this.#stall === null) return;
    const s = this.#stall;
    this.#stall = null;
    events.emit('STALL_END', {
      cause: s.cause,
      playhead_ms: s.playheadMs,
      duration_ms: performance.now() - s.startPerf,
    });
  }

  setEmaHalfLives(halfLifeFastSec: number, halfLifeSlowSec: number): void {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    videoStruct?.tracker.setHalfLives(halfLifeFastSec, halfLifeSlowSec);
  }

  /**
   * Anchor the active video tracker's throughput EMA to a conservative startup
   * estimate (bps) so the first real per-group sample can't seed the EMA from a
   * startup burst. See GoodputTracker.seedEma. No-op once real samples exist.
   */
  seedThroughputEstimate(bps: number): void {
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    videoStruct?.tracker.seedEma(bps);
  }

  /**
   * Recurring requestVideoFrameCallback poll.
   *
   * Every presented frame reports its `mediaTime`. The first presented frame
   * whose media time is at or past a pending switch's seam PTS is the first
   * frame of the new representation the viewer sees. At that frame:
   *   switch_visibility_delay_ms = now - switchSentAt
   *   playback_position_jump_ms  = mediaTime - previous mediaTime - one frame
   *                                (0 when the seam is played through contiguously)
   *   viewer_pause_ms            = wall-clock gap to the previous presented frame
   *                                beyond one frame period (0 when smooth)
   * The poll also reports STARTUP on the first presented frame.
   */
  #installPerceivedPausePoll(): void {
    if (!this.#element) return;
    let prevMediaMs: number | undefined;
    let prevNowMs: number | undefined;
    const poll = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      if (!this.#element) return;
      const mediaMs = metadata.mediaTime * 1000;
      if (!this.#firstFrameSeen) {
        this.#firstFrameSeen = true;
        events.emit('STARTUP', {
          track: this.getMetrics().activeTrack,
          playhead_ms: mediaMs,
          connect_to_first_object_ms:
            this.#tConnectStart !== undefined && this.#tFirstObject !== undefined
              ? this.#tFirstObject - this.#tConnectStart
              : null,
          first_object_to_first_frame_ms:
            this.#tFirstObject !== undefined ? now - this.#tFirstObject : null,
          startup_delay_ms: this.#tConnectStart !== undefined ? now - this.#tConnectStart : null,
        });
      }
      for (const struct of this.#streams) {
        const seam = struct.postSwitchSeamPTS_ms;
        if (
          struct.firstFrameAfterSwitchSeen !== true &&
          seam !== undefined &&
          struct.postSwitchSentAt !== undefined &&
          struct.postSwitchToTrack !== undefined
        ) {
          const frameMs = struct.lastFrameDurationMs ?? 1000 / 30;
          if (mediaMs < seam - frameMs / 2) continue;
          struct.firstFrameAfterSwitchSeen = true;
          const visibilityDelayMs = now - struct.postSwitchSentAt;
          const jumpMs = prevMediaMs !== undefined ? mediaMs - prevMediaMs - frameMs : null;
          const pauseMs = prevNowMs !== undefined ? Math.max(0, now - prevNowMs - frameMs) : null;
          const targetTrack = struct.postSwitchToTrack;
          // Ground truth for the seam: the hole in the element's buffered ranges
          // just before the range that holds the presented frame (0 = the seam
          // lies inside one contiguous range). This is what a range-jump seek
          // crosses; the parsed-PTS gap above cannot see frames the decoder
          // never presented.
          let bufferHoleMs: number | null = null;
          const ranges = this.#element.buffered;
          for (let i = 0; i < ranges.length; i++) {
            if (
              ranges.start(i) * 1000 - frameMs <= mediaMs &&
              mediaMs <= ranges.end(i) * 1000 + frameMs
            ) {
              bufferHoleMs = i > 0 ? (ranges.start(i) - ranges.end(i - 1)) * 1000 : 0;
              break;
            }
          }
          events.emit('SWITCH_FIRST_FRAME', {
            from: struct.postSwitchFromTrack ?? null,
            to: targetTrack,
            seam_pts_ms: seam,
            presented_pts_ms: mediaMs,
            switch_visibility_delay_ms: visibilityDelayMs,
            playback_position_jump_ms: jumpMs,
            viewer_pause_ms: pauseMs,
            seam_buffer_hole_ms: bufferHoleMs,
          });

          if (typeof window !== 'undefined' && window.__moqtailMetrics) {
            const records = window.__moqtailMetrics.switchDiscontinuities;
            if (records) {
              for (let i = records.length - 1; i >= 0; i--) {
                const r = records[i];
                if (r && r.eventType === 'switch' && r.toTrack === targetTrack) {
                  r.viewerPauseMs = pauseMs ?? undefined;
                  break;
                }
              }
            }
          }

          struct.postSwitchSeamPTS_ms = undefined;
          struct.postSwitchSentAt = undefined;
          struct.postSwitchToTrack = undefined;
          struct.postSwitchFromTrack = undefined;
        }
      }
      prevMediaMs = mediaMs;
      prevNowMs = now;
      this.#element.requestVideoFrameCallback(poll);
    };
    this.#element.requestVideoFrameCallback(poll);
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
    if (result instanceof RequestError) return 0;

    const reader = result.stream.getReader();
    let pBytes = 0;
    let count = 0;
    // The probe is one finite burst; the relay ends the subscription with
    // PUBLISH_DONE once its stream completes. Read until the stream ends, or
    // the burst has gone quiet, or a hard cap, so the subscription is never
    // cancelled while probe data is still in flight (that data would then hit
    // the library as an unknown track alias).
    const idleMs = 250;
    const capMs = Math.max(durationMs * 10, 5000);
    let streamDone = false;
    let lastObjectAt = tStart;

    try {
      for (;;) {
        const now = Date.now();
        if (now - tStart >= capMs) break;
        if (count > 0 && now - lastObjectAt >= idleMs) break;
        const wait = count > 0 ? idleMs - (now - lastObjectAt) : capMs - (now - tStart);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutP = new Promise<{ done: false; value: undefined; timeout: true }>(resolve => {
          timer = setTimeout(() => resolve({ done: false, value: undefined, timeout: true }), wait);
        });
        const readP = reader.read() as Promise<{
          done: boolean;
          value: typeof MoqtObject.prototype | undefined;
          timeout?: false;
        }>;
        const r = await Promise.race([readP, timeoutP]);
        if (timer !== undefined) clearTimeout(timer);
        if ('timeout' in r && r.timeout) continue;
        if (r.done) {
          streamDone = true;
          break;
        }
        if (!r.value || r.value.isEndOfGroup()) continue;
        const len = r.value.payload?.byteLength ?? 0;
        if (len === 0) continue;
        pBytes += len;
        count++;
        lastObjectAt = Date.now();
      }
    } catch {
      /* swallow — return what we have */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      if (!streamDone) {
        this.client.unsubscribe(result.requestId).catch(() => {});
      }
    }

    const tEnd = Date.now();
    const dtSec = (tEnd - tStart) / 1000;
    if (count === 0 || dtSec <= 0) {
      events.emit('PROBE', {
        track: trackName,
        p_bytes: pBytes,
        objects: count,
        dt_ms: tEnd - tStart,
        bps: 0,
      });
      return 0;
    }

    const vBytesEnd = videoStruct?.tracker.getCumulativeBytes() ?? vBytesStart;
    const vBytes = Math.max(0, vBytesEnd - vBytesStart);

    // BWE = (v + p) × 8 / Δt — Algorithm 1 line 9.
    const bps = ((vBytes + pBytes) * 8) / dtSec;
    events.emit('PROBE', {
      track: trackName,
      p_bytes: pBytes,
      v_bytes: vBytes,
      objects: count,
      dt_ms: tEnd - tStart,
      stream_done: streamDone,
      bps,
    });
    return bps;
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

    // Snapshot playhead + wall clock BEFORE sending the SWITCH so that
    // playheadPTS_ms pairs with the targetGroup decision below. Capturing
    // these after `await client.switch()` reads playhead AFTER the relay
    // round-trip — the playhead can advance past a group boundary in that
    // window (offset30 with mininet ~50ms RTT cleared one GOP, pushing
    // |playheadGap| just above gopDurationMs even when alignment was
    // correct at the moment of decision).
    const playheadPTS_ms = this.#element !== null ? this.#element.currentTime * 1000 : undefined;
    const switchSentAt = performance.now();
    const framesAtSwitch = this.#element?.getVideoPlaybackQuality().totalVideoFrames ?? 0;

    // Pre-allocate the new request id and update videoStruct.requestId BEFORE
    // awaiting client.switch(). If a second switchTrack call (ABR tick or
    // force_switch) starts before this one completes, it will read the
    // already-incremented requestId and pass it as subscriptionRequestId in
    // its own SWITCH — preventing the stale-id chain that the relay rejects
    // as ProtocolViolation and tears the WebTransport down. Concurrency on
    // the wire is preserved; only the id-state read is moved to before the
    // await.
    const subscriptionRequestId = videoStruct.requestId;
    const newRequestId = this.client.allocateNextRequestId();
    videoStruct.requestId = newRequestId;

    events.emit('SWITCH_SENT', {
      from: videoStruct.trackName,
      to: trackName,
      request_id: newRequestId,
      old_request_id: subscriptionRequestId,
      playhead_ms: playheadPTS_ms ?? null,
      playhead_group:
        playheadPTS_ms !== undefined && this.#timeMap?.hasAnchor()
          ? this.#timeMap.groupContainingPTS(playheadPTS_ms)
          : null,
      last_received_group: videoStruct.lastGroupId,
      buffered_end_ms: videoStruct.lastAppendedEndPTS_ms ?? null,
    });

    try {
      const result = await this.client.switch({
        requestId: newRequestId,
        fullTrackName,
        subscriptionRequestId,
      });

      if (result instanceof RequestError) {
        logger.error(
          'media',
          `switchTrack: SWITCH rejected for ${trackName}:`,
          result.reasonPhrase.phrase,
        );
        events.emit('SWITCH_ERROR', {
          to: trackName,
          request_id: newRequestId,
          reason: result.reasonPhrase.phrase,
          rtt_ms: performance.now() - switchSentAt,
        });
        // Roll back the optimistic id update so the next switchTrack attempt
        // references the still-active subscription rather than the failed one.
        videoStruct.requestId = subscriptionRequestId;
        this.#options.onTrackSwitched?.(videoStruct.trackName);
        return;
      }

      // Arm the write handler for init segment re-injection at the next group
      // boundary. The onTrackSwitched callback (which releases the ABR switching
      // guard) is NOT called here — it fires in the write handler AFTER the relay
      // has actually delivered data on the new track. This prevents rapid
      // consecutive SWITCH messages that corrupt the relay's switch context.
      // Tracker is intentionally not reset — the previous-track bandwidth
      // estimate is still a valid indicator of network capacity. (dash.js
      // doesn't reset throughput on quality switches either.)
      videoStruct.pendingSwitch = {
        trackName,
        initData: initData.buffer as ArrayBuffer,
        mimeType,
        oldEndPTS_ms: videoStruct.lastAppendedEndPTS_ms,
        playheadPTS_ms,
        switchSentAt,
        framesAtSwitch,
      };
      videoStruct.firstFrameAfterSwitchSeen = false; // reset for next switch
      events.emit('SWITCH_OK', {
        to: trackName,
        request_id: newRequestId,
        rtt_ms: performance.now() - switchSentAt,
      });
    } catch (error) {
      logger.error('media', 'switchTrack: unexpected error', error);
      events.emit('SWITCH_ERROR', {
        to: trackName,
        request_id: newRequestId,
        reason: String(error),
        rtt_ms: performance.now() - switchSentAt,
      });
      // Roll back the optimistic id update on unexpected failure too.
      videoStruct.requestId = subscriptionRequestId;
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
          type: FetchType.Standalone,
          props: {
            fullTrackName: getFullTrackName(this.#options.namespace, 'catalog'),
            startLocation: this.#options.catalogLocation[0],
            endLocation: this.#options.catalogLocation[1],
          },
        },
      });
      if (result instanceof RequestError)
        throw new Error(`Error occured during catalog fetch: ${result.reasonPhrase.phrase}`);
      const tracker = new GoodputTracker();
      struct = {
        trackName: 'catalog',
        requestId: result.requestId,
        source: result.stream,
        tracker,
        lastGroupId: -1n,
        pendingSwitch: null,
        lastAppendedEndPTS_ms: undefined,
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

    // Build delay-mode parameters only for non-catalog tracks. The catalog
    // is fetched at startup and has no notion of "live edge"; never delay it.
    let parameters: MessageParameter[] | undefined;
    if (params.trackName !== 'catalog' && this.catalog) {
      const gopDurationMs = this.catalog.getGopDurationMs(params.trackName);
      parameters = buildSubscribeParameters({
        clientMode: this.#options.clientMode,
        timeShiftSeconds: this.#options.timeShiftSeconds,
        gopDurationMs,
      });
    }

    // Send the appropriate control message
    let struct: MOQStreamStruct;
    const subscribeSentAt = performance.now();
    if (params.trackName !== 'catalog') {
      events.emit('SUBSCRIBE_SENT', {
        track: params.trackName,
        client_mode: this.#options.clientMode,
        time_shift_s: this.#options.timeShiftSeconds,
        delay_groups: parameters ? Number(parameters[0]!.toKeyValuePair().value) : 0,
      });
    }
    const result = await this.client.subscribe({
      fullTrackName: getFullTrackName(this.#options.namespace, params.trackName),
      groupOrder: GroupOrder.Original,
      filterType: FilterType.LatestObject,
      forward: true,
      priority: params.priority ?? 0,
      parameters,
    });
    if (result instanceof RequestError) {
      events.emit('ERROR', {
        where: 'subscribe',
        track: params.trackName,
        message: result.reasonPhrase.phrase,
      });
      throw new Error(`Error occured during subscription: ${result.reasonPhrase.phrase}`);
    }

    // Capture connect-time state for media tracks (not catalog) so C4 can emit
    // a connect-time discontinuity record on the first arriving object. We only
    // populate #expectedStartGroupId for time-shifted mode with a non-zero
    // delay_groups; otherwise the relay does not clamp and we have nothing to
    // detect against.
    if (params.trackName !== 'catalog' && this.catalog) {
      const gopDurationMs = this.catalog.getGopDurationMs(params.trackName);
      const largest = result.largestLocation;
      this.#connectSentAt = performance.now();
      if (this.#options.clientMode === 'time-shifted' && largest !== undefined) {
        const delayGroups = Math.round((this.#options.timeShiftSeconds * 1000) / gopDurationMs);
        if (delayGroups > 0) {
          // expected = largest - delay_groups (saturating at 0)
          this.#expectedStartGroupId = Math.max(0, Number(largest.group) - delayGroups);
        }
      }
      events.emit('SUBSCRIBE_OK', {
        track: params.trackName,
        request_id: result.requestId,
        rtt_ms: performance.now() - subscribeSentAt,
        largest_group: largest !== undefined ? largest.group : null,
        largest_object: largest !== undefined ? largest.object : null,
        expected_start_group: this.#expectedStartGroupId ?? null,
      });
    }

    const tracker = new GoodputTracker();
    struct = {
      trackName: params.trackName,
      requestId: result.requestId,
      source: result.stream,
      tracker,
      lastGroupId: -1n,
      pendingSwitch: null,
      lastAppendedEndPTS_ms: undefined,
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
