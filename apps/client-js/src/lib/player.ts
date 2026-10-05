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
import { MOQtailClient, type DiscardedStreamInfo } from 'moqtail/client';
import { CMSFCatalog, MessageParameters, type MessageParameter } from 'moqtail/model';
import { logger } from '@/lib/logger';
import { GoodputTracker } from '@/lib/goodput';
import { LatencyTracker } from '@/lib/latencyTracker';
import { StallTracker } from '@/lib/stall';
import { parseMoofMediaInfo } from '@/lib/util/MoofParser';
import { TimeMap } from '@/lib/abr/TimeMap';
import type { ProbeResult } from '@/lib/abr/ProbeManager';
import { events } from '@/lib/events/EventLog';
import { estimateLiveEdge, readPrft, targetShiftMs, type PrftAnchor } from '@/lib/events/liveEdge';
import {
  DEFAULT_LIVE_EDGE_DELAY,
  GapFillLog,
  contiguousBufferAheadS,
  type GapFillQuery,
  type GapFillState,
} from '@/lib/buffer';
import {
  SeamTracker,
  nextPageSwitchSeq,
  seamBehindPlayhead,
  switchAppliedFields,
  type SwitchRecord,
} from '@/lib/seam';

interface PendingSwitch {
  trackName: string;
  initData: ArrayBuffer;
  mimeType: string;
  /** The switch's own record (C1): identity, send-time snapshots, landing and seam. */
  record: SwitchRecord;
  /**
   * The lowest group the switched subscription can deliver. An object of the
   * target track below it is a late object of an earlier subscription to that
   * track: the relay may reuse a track alias for the same track (draft-18 11.1),
   * so the library maps such an object to the new subscription. Native: the
   * source's last received group when the SWITCH was sent (the relay starts the
   * target at or after what it sent of the source). PR #1378: the Minimum
   * Switching Group the SWITCH carried (G_switch is at or above it).
   */
  minGroup: bigint;
}

interface MOQStreamStruct {
  trackName: string;
  source: ReadableStream<MoqtObject>;
  requestId: bigint;
  tracker: GoodputTracker;
  pendingSwitch: PendingSwitch | null;
  /**
   * The current subscription's lowest deliverable group (its switch's
   * `PendingSwitch.minGroup` from the landing on; undefined for the initial
   * subscription). Objects of the current track below it are late objects of an
   * earlier subscription to the same track and are dropped.
   */
  currentMinGroup?: bigint;
  /** End PTS (ms) of the last appended segment from the active track (the append front). Updated after a successful append only (M9). Undefined until the first segment is appended. */
  lastAppendedEndPTS_ms: number | undefined;
  /** Frame duration (ms) of the most recently parsed object, for seam arithmetic. */
  lastFrameDurationMs?: number;
  /** performance.now() of the last successful media append (data-starvation watchdog). */
  lastAppendPerf?: number;
  /**
   * A switched-to track whose init segment could not be applied at landing.
   * Retried before the next object append instead of erroring the write
   * stream, which used to end delivery for the rest of the run silently.
   */
  pendingInit?: { mimeType: string; initData: ArrayBuffer; attempts: number };
  /**
   * Set when a new init segment has been applied: objects are discarded until
   * the first object 0 of a group (the keyframe). A mechanism that lands
   * mid-group (native SWITCH lands on object 1) otherwise hands the decoder
   * non-keyframe HEVC frames right after a configuration change; Firefox
   * drops them to the next keyframe on a good day and fails with
   * MEDIA_ERR_DECODE on a bad one. The visible seam is the same either way.
   */
  awaitKeyframe?: boolean;
  buffer?: {
    sourceBuffer: SourceBuffer;
    ac: AbortController;
  };
}

interface SubscribeOptions {
  trackName: string;
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
  /**
   * Called when a switchTrack() completes (success or failure) with the track
   * the player is now on and the switch's `switch_seq` (undefined only when
   * the switch failed before a number was allocated). Releases the ABR
   * switching guard.
   */
  onTrackSwitched?: (trackName: string, switchSeq?: number) => void;
  /** Called when the first frame of a switched-to track is presented (the seam became visible). */
  onSwitchVisible?: (trackName: string) => void;
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
  onTrackSwitched: undefined as ((trackName: string, switchSeq?: number) => void) | undefined,
  onSwitchVisible: undefined as ((trackName: string) => void) | undefined,
  clientMode: 'live-edge' as 'time-shifted' | 'live-edge',
  timeShiftSeconds: 0,
  logObjects: false,
  landingRequiresAliasMapping: true,
} satisfies Required<Omit<PlayerOptions, 'onTrackSwitched' | 'onSwitchVisible'>> &
  Pick<PlayerOptions, 'onTrackSwitched' | 'onSwitchVisible'>;

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
 * Scheduling of every media subscription, identical on every branch
 * (transport fairness): the relay orders streams by subscriber priority, then
 * group order. The player's SUBSCRIBEs use these.
 */
export const MEDIA_SCHEDULING = { priority: 0, groupOrder: GroupOrder.Ascending } as const;

/**
 * Parameters of every SWITCH: the same SubscriberPriority and GroupOrder as the
 * SUBSCRIBE, carried explicitly so the switched subscription is scheduled like
 * the original one. A SWITCH without them is scheduled at the relay's default
 * (priority 128): below the old subscription's remaining streams and the
 * probe. The relay also inherits the old subscription's values for a native
 * SWITCH that carries none; carrying them makes every branch say the same.
 *
 * Exported for unit testing.
 */
export function buildSwitchParameters(): MessageParameter[] {
  return new MessageParameters()
    .addSubscriberPriority(MEDIA_SCHEDULING.priority)
    .addGroupOrder(MEDIA_SCHEDULING.groupOrder)
    .build();
}

/**
 * DROP_STALE fields for a data stream the library discarded without delivering
 * it (M15): no subscription claimed its track alias in time, so the library
 * cancelled it with STOP_SENDING and reported what it had read. `track` is the
 * name the alias last mapped to (null once the library has forgotten it).
 * Same record as the player's own drops, so every arm counts discarded media
 * on the same basis whether the library or the player dropped it.
 *
 * Exported for unit testing.
 */
export function unroutedDropFields(
  info: DiscardedStreamInfo,
  state: { current: string | null; pending: string | null },
): Record<string, unknown> {
  return {
    reason: info.reason,
    track: info.fullTrackName ? new TextDecoder().decode(info.fullTrackName.name) : null,
    current: state.current,
    pending: state.pending,
    group: Number(info.groupId),
    subgroup: info.subgroupId !== undefined ? Number(info.subgroupId) : null,
    track_alias: Number(info.trackAlias),
    bytes: info.bytes,
  };
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

/**
 * Reads a `?certHash=` query parameter (base64url SHA-256 of the relay's DER
 * certificate) and turns it into WebTransport `serverCertificateHashes`.
 *
 * Firefox's HTTP/3 stack rejects a certificate issued by a locally-installed
 * CA even when that CA is trusted, so pinning the leaf hash is the only way to
 * reach a dev relay from Firefox; Chrome accepts either route. Browsers honour
 * a pinned hash only for ECDSA P-256 certificates valid 14 days or less, see
 * scripts/gen-dev-cert.sh. Absent the parameter, nothing changes.
 */
function serverCertificateHashesFromUrl(): { transportOptions: WebTransportOptions } | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('certHash');
  if (!raw) return undefined;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const value = Uint8Array.from(bin, c => c.charCodeAt(0));
    return { transportOptions: { serverCertificateHashes: [{ algorithm: 'sha-256', value }] } };
  } catch {
    logger.error('media', 'certHash query parameter is not valid base64url; ignoring it');
    return undefined;
  }
}

export class Player {
  catalog: CMSFCatalog | null = null;
  client: MOQtailClient | null = null;

  #element: HTMLVideoElement | null = null;
  #mse?: MediaSource;
  #streams: MOQStreamStruct[] = [];
  #options: Required<Omit<PlayerOptions, 'onTrackSwitched' | 'onSwitchVisible'>> &
    Pick<PlayerOptions, 'onTrackSwitched' | 'onSwitchVisible'>;
  // Data-starvation watchdog: performance.now() of the last successful append
  // when a DATA_STARVED episode was opened; undefined while data flows.
  #starvedSince: number | undefined;
  // settings.controller.latencyResetOnLanding: clear the latency-trend window
  // when a switch lands (see ControllerSettings).
  #resetLatencyOnLanding = false;
  // Watchdog heartbeat, logged in SAMPLE: one run froze for 46 s without a
  // single watchdog action and the log could not say whether the watchdog ran.
  #watchdog = { ticks: 0, frozen: 0, unhandled: 0 };
  #disposers: Array<() => void> = [];
  // Per-frame end-to-end latency window (last 100 samples ≈ 4 s at 25 fps).
  // Fed by PRFT timestamps extracted from the head of each CMAF chunk.
  // `LatencyTrendRule` reads `getTrendRatio()` for downswitch decisions.
  #latencyTracker = new LatencyTracker();
  // Connect-time state (Task C4) for time-shifted-mode clamp detection.
  // Captured in subscribe(); reported on FIRST_OBJECT.
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
  // Stall episodes (STALL_START / STALL_END) from the element's events and the
  // frozen-playhead watchdog; never overlapping (F15).
  #stalls = new StallTracker(
    (event, fields) => events.emit(event, fields),
    () => ({
      ready: this.#element !== null && this.#firstFrameSeen,
      playheadMs: (this.#element?.currentTime ?? 0) * 1000,
      // The track the viewer is looking at, not the one being received (M13).
      track: this.getMetrics().presentedTrack,
    }),
  );
  // Per-switch records (C1): switch_seq, landing, seam and first-frame state.
  // Numbers come from the page-wide sequence so a reconnect never reuses one.
  #seams = new SeamTracker(nextPageSwitchSeq);
  // Video appends that landed inside a gap (buffered media after them): the
  // fills the gap-crossing policy waits for (F4).
  #gapFills = new GapFillLog();
  // switch_seq allocated by the latest switchTrack call (F14).
  #lastSwitchSeq: number | null = null;

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
        ...(serverCertificateHashesFromUrl() ?? {}),
      });
    } catch (error) {
      logger.error('media', 'Failed to connect to relay', (error as Error).message);
      events.emit('ERROR', { where: 'connect', message: (error as Error).message });
      throw error;
    }
    events.emit('CONNECTED', { connect_ms: performance.now() - this.#tConnectStart });
    // Streams the library cancels for want of a route (M15) are counted here,
    // on the same basis as the write handler's own drops.
    this.client.onStreamDiscarded = info => {
      const vs = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
      const fields = unroutedDropFields(info, {
        current: vs?.trackName ?? null,
        pending: vs?.pendingSwitch?.trackName ?? null,
      });
      events.emit('DROP_STALE', fields);
      // Attributed to its group if that group is open, else reported with the
      // stream's next THROUGHPUT_SAMPLE as unrouted_bytes (F6).
      vs?.tracker.recordDiscardedBytes(
        info.bytes,
        info.groupId,
        typeof fields.track === 'string' ? fields.track : null,
      );
    };

    // Debug-only escape hatch: lets the network test harness force a SWITCH
    // without going through the AbrController. Used by Slice C/Phase B E2Es
    // (see tests/network/scenarios/test_naive_switch_discontinuity.py). Not
    // for production use — direct switchTrack() calls bypass the ABR
    // switching guard's bookkeeping.
    if (typeof window !== 'undefined') {
      (
        window as Window & { __forceSwitch?: (trackName: string) => Promise<number | null> }
      ).__forceSwitch = (trackName: string) => this.switchTrack(trackName);
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

    // Firefox ships getStats() as a stub that rejects; treat that as "no
    // estimate" rather than aborting the connect.
    let s1: StatsResult;
    let s2: StatsResult;
    const t1 = Date.now();
    let t2 = t1;
    try {
      s1 = await getStats();
      await new Promise(r => setTimeout(r, 200));
      s2 = await getStats();
      t2 = Date.now();
    } catch {
      return 0;
    }

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

    // Stall watchdog. Detects a playhead that does not advance while playing
    // (a stall whether or not the element fired `waiting`) and records what
    // it saw. It never seeks: crossing gaps and recovering from a decoder
    // wedge is the one gap-crossing policy in MSEBuffer (lib/buffer.ts, M14),
    // which used to be overridden from here after 1 s.
    const el = this.#element;
    let lastFrames = 0;
    let lastTime = -1;
    const wedgeIntervalId = setInterval(() => {
      this.#watchdog.ticks += 1;
      const q = el.getVideoPlaybackQuality?.();
      const frames = q?.totalVideoFrames ?? 0;
      this.#checkStarvation(el);
      // Progress means the playhead moved. Decoded frames alone do not: one
      // run sat at the same currentTime with readyState 2 for 28 s while
      // totalVideoFrames rose by 9000 (the decoder chewing through a 37 s
      // buffer it never presented).
      const time = el.currentTime;
      const advanced = time > lastTime + 0.01 || (lastTime < 0 && frames > lastFrames);
      lastFrames = frames;
      if (advanced) lastTime = time;
      // Frozen frames while playing is a stall whether or not the element
      // fired `waiting`: the tracker opens one after ~1 s of confirmed freeze,
      // credited from the first frozen tick but never from before the
      // previous episode's end (F15).
      const frozenSince = this.#stalls.watchdogTick(
        performance.now(),
        advanced,
        !el.paused && !el.ended,
      );
      this.#watchdog.frozen = frozenSince;
      if (advanced || el.paused || el.ended || frozenSince < 2) return;
      // Frozen for 3 s: say what the watchdog saw, once every 10 s, so a run
      // the gap policy could not recover is diagnosable from the log.
      if (frozenSince >= 6 && (frozenSince - 6) % 20 === 0) {
        this.#watchdog.unhandled += 1;
        const buf = el.buffered;
        const parts: string[] = [];
        for (let i = 0; i < buf.length; i++)
          parts.push(`${buf.start(i).toFixed(3)}-${buf.end(i).toFixed(3)}`);
        events.emit('WEDGE_UNHANDLED', {
          playhead_ms: el.currentTime * 1000,
          ready_state: el.readyState,
          paused: el.paused,
          ended: el.ended,
          frozen_ticks: frozenSince,
          buffered_ranges: parts.join(','),
          mse_ready_state: this.#mse?.readyState ?? 'closed',
        });
      }
    }, 500);
    this.#disposers.push(() => clearInterval(wedgeIntervalId));

    // Element-reported stalls: `waiting` opens, `playing` closes. Frozen-frame
    // detection above catches stalls the element never reports.
    const onWaiting = () => this.#stalls.waiting(performance.now());
    const onPlaying = () => this.#stalls.playing(performance.now());
    // A fatal media element error (e.g. MEDIA_ERR_DECODE = 3 from the HEVC
    // decoder) makes every later append fail; record it as its own event so a
    // run that died this way is classified as a decoder failure, not a stall.
    const onError = () =>
      events.emit('MEDIA_ERROR', {
        code: el.error?.code ?? null,
        message: el.error?.message ?? null,
        playhead_ms: el.currentTime * 1000,
        track: this.getMetrics().activeTrack,
        mse_ready_state: this.#mse?.readyState ?? 'closed',
      });
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('error', onError);
    this.#disposers.push(() => {
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('error', onError);
    });

    // Wait for the SourceBuffer's next `updateend`. Bounded: an `updateend`
    // that never comes (seen once per few hundred switches on Firefox) used to
    // park the write handler forever, and with it every later append.
    const waitForBufferUpdate = (sourceBuffer: SourceBuffer, timeoutMs = 3000) =>
      new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onEnd = () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        sourceBuffer.addEventListener('updateend', onEnd, { once: true });
        timer = setTimeout(() => {
          sourceBuffer.removeEventListener('updateend', onEnd);
          events.emit('ERROR', {
            where: 'updateend-timeout',
            timeout_ms: timeoutMs,
            sb_updating: sourceBuffer.updating,
            mse_ready_state: this.#mse?.readyState ?? 'closed',
          });
          resolve();
        }, timeoutMs);
      });

    // Apply a track's init segment (changeType + append). Failures are logged
    // as ERROR events and reported to the caller; they never error the stream.
    const applyInit = async (
      sourceBuffer: SourceBuffer,
      mimeType: string,
      initData: ArrayBuffer,
      track: string,
    ): Promise<boolean> => {
      try {
        if (sourceBuffer.updating) await waitForBufferUpdate(sourceBuffer);
        // Reset the segment parser before the new codec configuration, as
        // dash.js does when it switches representations: leftover parser
        // state from the old track's last partial append is one way to hand
        // the decoder frames that do not match the new init segment.
        if (this.#mse?.readyState === 'open') sourceBuffer.abort();
        sourceBuffer.changeType(mimeType);
        sourceBuffer.appendBuffer(initData);
        await waitForBufferUpdate(sourceBuffer);
        return true;
      } catch (error) {
        const err = error as Error & { name?: string };
        logger.error('media', `switchTrack: failed to apply init segment for ${track}:`, error);
        events.emit('ERROR', {
          where: 'switch-init-append',
          track,
          name: err?.name ?? null,
          message: err?.message ?? String(error),
          sb_updating: sourceBuffer.updating,
          mse_ready_state: this.#mse?.readyState ?? 'closed',
          video_error_code: this.#element?.error?.code ?? 0,
        });
        return false;
      }
    };

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
            const route = this.#route(struct, objectTrackName, object.location.group);
            if (route === 'stale') {
              logger.info(
                'media',
                `Dropping stale track data (${objectTrackName}); current=${struct.trackName} pending=${struct.pendingSwitch?.trackName ?? 'none'}`,
              );
              this.#dropStale(struct, object, objectTrackName, {
                track: objectTrackName,
                current: struct.trackName,
                pending: struct.pendingSwitch?.trackName ?? null,
                group: object.location.group,
                bytes: object.payload.byteLength,
                object: object.location.object,
              });
              return;
            }

            if (route === 'pre-landing') {
              // Same track name, but the library has not yet seen a stream for
              // the switched subscription: this is a trailing object of the
              // earlier subscription to that track, not the switch landing.
              this.#dropStale(struct, object, objectTrackName, {
                track: objectTrackName,
                current: struct.trackName,
                pending: struct.pendingSwitch?.trackName ?? null,
                group: object.location.group,
                bytes: object.payload.byteLength,
                object: object.location.object,
                reason: 'pre-landing',
              });
              return;
            }

            if (route === 'earlier-subscription') {
              // A late object of an earlier subscription to this track, below what
              // the current (or switched) subscription can deliver: appending it
              // would put the old subscription's frames behind the seam, and
              // landing on it would start the switch below its own start group.
              this.#dropStale(struct, object, objectTrackName, {
                track: objectTrackName,
                current: struct.trackName,
                pending: struct.pendingSwitch?.trackName ?? null,
                group: object.location.group,
                bytes: object.payload.byteLength,
                object: object.location.object,
                reason: 'earlier-subscription',
                floor_group: this.#floorGroup(struct, objectTrackName) ?? null,
              });
              return;
            }

            if (route === 'land' && struct.pendingSwitch) {
              const { initData, mimeType, trackName: newTrackName, record } = struct.pendingSwitch;
              const fromTrack = struct.trackName; // capture BEFORE overwriting
              // The source's last appended frame at the moment the switch lands
              // (the send-time snapshot in the record predates ~1 GOP of source
              // frames that arrived while the SWITCH was in flight).
              const sourceEndAtLandingMs = struct.lastAppendedEndPTS_ms;
              struct.trackName = newTrackName;
              struct.currentMinGroup = struct.pendingSwitch.minGroup;
              struct.pendingSwitch = null;
              // Whether the landing object is a keyframe: the trun sync-sample flag
              // of its moof (undefined when the moof carries no flags).
              const newTimescale = this.catalog?.getTimescale(newTrackName);
              const landingIsSync =
                newTimescale && newTimescale > 0
                  ? parseMoofMediaInfo(
                      new Uint8Array(
                        object.payload.buffer,
                        object.payload.byteOffset,
                        object.payload.byteLength,
                      ),
                      newTimescale,
                    )?.isSync
                  : undefined;

              // The landing object. The seam fields come from the first object
              // that passes the keyframe gate (SWITCH_APPLIED, M9).
              events.emit('SWITCH_FIRST_OBJECT', {
                switch_seq: record.seq,
                from: fromTrack,
                to: newTrackName,
                group: object.location.group,
                object: object.location.object,
                landed_on_keyframe: landingIsSync ?? null,
                since_sent_ms: performance.now() - record.sentAt,
              });
              // A previous landing whose seam was never presented is overwritten now.
              const { superseded } = this.#seams.landed(record, {
                group: Number(object.location.group),
                object: Number(object.location.object),
                landedOnKeyframe: landingIsSync ?? null,
                sourceEndMs: sourceEndAtLandingMs,
                now: performance.now(),
              });
              for (const old of superseded) {
                events.emit('SWITCH_SUPERSEDED', {
                  switch_seq: old.seq,
                  by_switch_seq: record.seq,
                  playhead_ms: (this.#element?.currentTime ?? 0) * 1000,
                  landed: true,
                });
              }
              // Nothing of the target is appended before a sync sample, the landing
              // object included: the gate below decides for every object, and the
              // first one it lets into the buffer applies the switch.
              struct.awaitKeyframe = true;
              if (this.#resetLatencyOnLanding) {
                this.#latencyTracker.reset();
                events.emit('LATENCY_WINDOW_RESET', { track: newTrackName });
              }

              if (!(await applyInit(sourceBuffer, mimeType, initData, newTrackName))) {
                // Keep the pipeline alive: retry the init before the next object
                // append and drop this object (it cannot be decoded without it).
                struct.pendingInit = { mimeType, initData, attempts: 1 };
                this.#options.onTrackSwitched?.(newTrackName, record.seq);
                this.#seams.discarded();
                this.#dropStale(struct, object, objectTrackName, {
                  track: objectTrackName,
                  current: struct.trackName,
                  pending: null,
                  group: Number(object.location.group),
                  bytes: object.payload.byteLength,
                  object: Number(object.location.object),
                  reason: 'init-pending',
                });
                return;
              }

              // NOW release the ABR switching guard — the relay has completed the
              // transition and delivered data on the new track. Safe to switch again.
              this.#options.onTrackSwitched?.(newTrackName, record.seq);
            }

            // Publisher emits one moof+mdat per access unit (see apps/publisher/src/cmaf.rs),
            // so each moof's tfdt is a per-frame decode time and the trun carries that
            // frame's duration. End PTS = decodeTime + frameDuration (NOT + gopDuration).
            const timescale = this.catalog?.getTimescale(struct.trackName);
            let decodeTimeMs: number | undefined;
            const info =
              timescale && timescale > 0
                ? parseMoofMediaInfo(
                    new Uint8Array(
                      object.payload.buffer,
                      object.payload.byteOffset,
                      object.payload.byteLength,
                    ),
                    timescale,
                  )
                : undefined;

            if (struct.pendingInit) {
              const pi = struct.pendingInit;
              pi.attempts += 1;
              if (await applyInit(sourceBuffer, pi.mimeType, pi.initData, struct.trackName)) {
                events.emit('SWITCH_INIT_RECOVERED', {
                  track: struct.trackName,
                  attempts: pi.attempts,
                });
                struct.pendingInit = undefined;
                // The landing block's gate, which a failed init used to skip: the
                // switch is applied by the first sync sample after the recovery.
                struct.awaitKeyframe = true;
              } else {
                this.#seams.discarded();
                this.#dropStale(struct, object, objectTrackName, {
                  track: objectTrackName,
                  current: struct.trackName,
                  pending: struct.pendingSwitch?.trackName ?? null,
                  group: Number(object.location.group),
                  bytes: object.payload.byteLength,
                  object: Number(object.location.object),
                  reason: 'init-pending',
                });
                return;
              }
            }

            if (struct.awaitKeyframe) {
              const isSync = info?.isSync ?? object.location.object === 0n;
              if (!isSync) {
                this.#seams.discarded();
                this.#dropStale(struct, object, objectTrackName, {
                  track: objectTrackName,
                  current: struct.trackName,
                  pending: struct.pendingSwitch?.trackName ?? null,
                  group: Number(object.location.group),
                  object: Number(object.location.object),
                  bytes: object.payload.byteLength,
                  reason: 'pre-keyframe',
                });
                return;
              }
            }
            decodeTimeMs = info?.decodeTimeMs;

            // Append the data
            let maxRetries = 5;
            // When the successful appendBuffer call was made: the seam's target
            // append front is dated here, not at updateend (F9).
            let appendCalledAt = performance.now();
            while (maxRetries--) {
              try {
                // Append the data
                appendCalledAt = performance.now();
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

            if (maxRetries < 0) {
              events.emit('ERROR', {
                where: 'append-exhausted',
                track: objectTrackName,
                group: Number(object.location.group),
                object: Number(object.location.object),
                bytes: object.payload.byteLength,
                mse_ready_state: this.#mse?.readyState ?? 'closed',
                video_error_code: this.#element?.error?.code ?? 0,
              });
            } else {
              const nowPerf = performance.now();
              if (this.#starvedSince !== undefined) {
                events.emit('DATA_RESUMED', {
                  track: objectTrackName,
                  group: Number(object.location.group),
                  starved_ms: nowPerf - this.#starvedSince,
                });
                this.#starvedSince = undefined;
              }
              struct.lastAppendPerf = nowPerf;
              // The gate stays armed until a sync sample is actually in the buffer.
              struct.awaitKeyframe = false;
              // Append front and TimeMap move only for a frame that is in the buffer.
              if (info !== undefined) {
                struct.lastAppendedEndPTS_ms = info.decodeTimeMs + info.frameDurationMs;
                struct.lastFrameDurationMs = info.frameDurationMs;
                // A frame with buffered media after it landed inside a gap: a
                // fill (refetch or catch-up), not live delivery at the end (F4).
                if (this.catalog?.getRole(struct.trackName) === 'video') {
                  const endS = struct.lastAppendedEndPTS_ms / 1000;
                  const ranges = sourceBuffer.buffered;
                  if (ranges.length > 0 && ranges.start(ranges.length - 1) > endS + 0.001) {
                    this.#gapFills.record(endS, nowPerf);
                  }
                }
                // Feed the TimeMap so measurements can resolve playhead -> group.
                // Only the first object of each group records (idempotent in TimeMap),
                // and frame 0 of a group has decodeTime == group start PTS.
                if (this.#timeMap) {
                  this.#timeMap.recordGroupBoundary(
                    Number(object.location.group),
                    info.decodeTimeMs,
                  );
                }
                // Every target frame moves the pending switch's append front; the
                // first one applies the switch (M9). Only the video track switches.
                const applied =
                  this.catalog?.getRole(struct.trackName) === 'video'
                    ? this.#seams.appended({
                        ptsMs: info.decodeTimeMs,
                        endPtsMs: info.decodeTimeMs + info.frameDurationMs,
                        group: Number(object.location.group),
                        object: Number(object.location.object),
                        now: nowPerf,
                        appendStartedAt: appendCalledAt,
                      })
                    : null;
                if (applied !== null) {
                  events.emit(
                    'SWITCH_APPLIED',
                    switchAppliedFields(applied, {
                      now: nowPerf,
                      playheadMs: this.#element ? this.#element.currentTime * 1000 : undefined,
                    }),
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

            // Throughput: arrival spacing of this object's group (M11). A frame
            // that could not be appended still crossed the link. The tracker
            // also keeps the highest group received per track (F10).
            this.#recordArrival(struct, object, objectTrackName, info, maxRetries < 0);

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

  /**
   * What the write handler does with an object of `objectTrackName` on
   * `struct`: `stale` (neither the current track nor the pending switch
   * target: dropped), `pre-landing` (the pending target's name, but the
   * library has not mapped the switched subscription yet: a trailing object
   * of an earlier subscription to that track, dropped), `earlier-subscription`
   * (the current or pending target's name, but `group` is below what that
   * subscription can deliver, see `PendingSwitch.minGroup`: dropped), `land` (the
   * pending switch lands on it) or `current` (append).
   */
  #route(
    struct: MOQStreamStruct,
    objectTrackName: string,
    group?: bigint,
  ): 'stale' | 'pre-landing' | 'earlier-subscription' | 'land' | 'current' {
    const pending = struct.pendingSwitch;
    if (objectTrackName !== struct.trackName && objectTrackName !== pending?.trackName) {
      return 'stale';
    }
    if (
      pending &&
      objectTrackName === pending.trackName &&
      this.#options.landingRequiresAliasMapping &&
      objectTrackName !== struct.trackName &&
      this.client !== null &&
      !this.client.subscriptionAliasMap.has(struct.requestId)
    ) {
      return 'pre-landing';
    }
    const floor = this.#floorGroup(struct, objectTrackName);
    if (group !== undefined && floor !== undefined && group < floor) return 'earlier-subscription';
    if (pending && objectTrackName === pending.trackName) return 'land';
    return 'current';
  }

  /** The lowest group the subscription `objectTrackName` routes to can deliver (see #route). */
  #floorGroup(struct: MOQStreamStruct, objectTrackName: string): bigint | undefined {
    const pending = struct.pendingSwitch;
    if (pending && objectTrackName === pending.trackName) return pending.minGroup;
    if (objectTrackName === struct.trackName) return struct.currentMinGroup;
    return undefined;
  }

  /**
   * The write handler's routing of a video object of `trackName` right now
   * (see #route); null without a video stream. For tests.
   */
  routeVideoObject(
    trackName: string,
    group?: bigint,
  ): 'stale' | 'pre-landing' | 'earlier-subscription' | 'land' | 'current' | null {
    const vs = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    return vs ? this.#route(vs, trackName, group) : null;
  }

  /**
   * DROP_STALE for an object the write handler will not append; the object is
   * still a link arrival of its group (THROUGHPUT_SAMPLE discarded_bytes).
   */
  #dropStale(
    struct: MOQStreamStruct,
    object: MoqtObject,
    objectTrackName: string,
    fields: Record<string, unknown>,
  ): void {
    events.emit('DROP_STALE', fields);
    this.#recordArrival(struct, object, objectTrackName, undefined, true);
  }

  /**
   * Feeds one received object into the stream's throughput tracker, timed by
   * the library's receive stamp and kept per (track, group) (M11), and emits a
   * THROUGHPUT_SAMPLE for every group sample that closes. `info` is the
   * object's parsed moof when the caller already has it.
   */
  #recordArrival(
    struct: MOQStreamStruct,
    object: MoqtObject,
    objectTrackName: string,
    info: { frameDurationMs: number } | undefined,
    discarded: boolean,
  ): void {
    const bytes = object.payload?.byteLength ?? 0;
    if (info === undefined && object.payload) {
      const timescale = this.catalog?.getTimescale(objectTrackName);
      info =
        timescale && timescale > 0
          ? parseMoofMediaInfo(
              new Uint8Array(
                object.payload.buffer,
                object.payload.byteOffset,
                object.payload.byteLength,
              ),
              timescale,
            )
          : undefined;
    }
    // The last object of a group: object ids run 0..frames-1 with one frame per
    // object, frames = GOP / frame duration.
    const gopMs = this.#timeMap?.gopDurationMs;
    const lastInGroup =
      info !== undefined && gopMs !== undefined && info.frameDurationMs > 0
        ? Number(object.location.object) >= Math.round(gopMs / info.frameDurationMs) - 1
        : undefined;
    const samples = struct.tracker.recordObject(bytes, object.location.group, {
      recvAt: object.recvAt,
      track: objectTrackName,
      lastInGroup,
      discarded,
    });
    for (const sample of samples) {
      events.emit('THROUGHPUT_SAMPLE', {
        track: sample.track,
        group: sample.group,
        bytes: sample.bytes,
        duration_ms: sample.durationMs,
        bps: sample.bps,
        // Bytes of this group dropped by the player, plus library (unrouted)
        // discards of this group while it was open.
        discarded_bytes: sample.discardedBytes,
        // Library (unrouted) discards no open group could take (already
        // sampled, never routed, or unknown track), any track, since this
        // stream's previous sample; every such byte is reported once (F6).
        unrouted_bytes: sample.unroutedBytes,
        objects: sample.objects,
        swma_bps: struct.tracker.getBandwidthBps(),
        fast_ema_bps: struct.tracker.getFastEmaBps(),
        slow_ema_bps: struct.tracker.getSlowEmaBps(),
        sample_count: struct.tracker.getSampleCount(),
      });
    }
  }

  getMetrics(): {
    bandwidthBps: number;
    fastEmaBps: number;
    slowEmaBps: number;
    /** Last buffered range end minus playhead (counts across holes), s. */
    bufferSeconds: number;
    /** End of the buffered range containing the playhead minus playhead, 0 if none (M12), s. */
    bufferContigSeconds: number;
    /** The track subscribed to: switches at the landing. */
    activeTrack: string | null;
    /** The track whose media is at the playhead: switches at the seam (M13). */
    presentedTrack: string | null;
    /**
     * PTS (ms) of the latest applied switch seam whose region (from the hole in
     * front of it) the playhead has entered; null when none. With `playheadMs`
     * it anchors SwitchHistoryRule's seam exemption at the seam being
     * presented (F2).
     */
    latestSeamPtsMs: number | null;
    droppedFrames: number;
    totalFrames: number;
    playbackRate: number;
    deliveryTimeMs: number;
    lastObjectBytes: number;
    sampleCount: number;
    /** Closed THROUGHPUT_SAMPLE groups per track (the group's own track). */
    samplesByTrack: Record<string, number>;
    readyState: number;
    paused: boolean;
    ended: boolean;
    watchdogTicks: number;
    frozenTicks: number;
    currentTime: number;
    bufferedRanges: string;
    mseReadyState: string;
    videoErrorCode: number;
    latencyTrendRatio: number;
    lastLatencyMs: number;
    /** Means of the older / recent half of the latency window; undefined until it is full. */
    latencyOlderMeanMs: number | undefined;
    latencyRecentMeanMs: number | undefined;
    /** Target shift behind live: 0 live-edge, delay_groups x GOP time-shifted, ms. */
    targetShiftMs: number;
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
    const bufferContigSeconds =
      buffered && el ? contiguousBufferAheadS(buffered, el.currentTime) : 0;
    const playheadMs = (el?.currentTime ?? 0) * 1000;
    const shift = targetShiftMs({
      clientMode: this.#options.clientMode,
      timeShiftSeconds: this.#options.timeShiftSeconds,
      gopDurationMs: this.#timeMap?.gopDurationMs ?? 0,
      liveEdgeDelaySeconds: DEFAULT_LIVE_EDGE_DELAY,
    }).targetShiftMs;
    const latencyMeans = this.#latencyTracker.getHalfMeans();
    const bufferedEndMs =
      buffered && buffered.length > 0 ? buffered.end(buffered.length - 1) * 1000 : 0;
    let liveEdgeDistanceMs = Number.NaN;
    let timeShiftErrorMs = Number.NaN;
    if (this.#prftAnchor && el) {
      const est = estimateLiveEdge({
        anchor: this.#prftAnchor,
        nowMs: Date.now(),
        playheadMs,
        targetShiftMs: shift,
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
      bufferContigSeconds,
      activeTrack: videoStruct?.trackName ?? null,
      presentedTrack: this.#seams.presentedTrack(playheadMs) ?? videoStruct?.trackName ?? null,
      latestSeamPtsMs: this.#seams.seamRegionAt(
        playheadMs,
        videoStruct?.lastFrameDurationMs ?? 1000 / 30,
      ),
      droppedFrames: quality?.droppedVideoFrames ?? 0,
      totalFrames: quality?.totalVideoFrames ?? 0,
      playbackRate: el?.playbackRate ?? 1,
      deliveryTimeMs: videoStruct?.tracker.getLastDeliveryTimeMs() ?? 0,
      lastObjectBytes: videoStruct?.tracker.getLastObjectBytes() ?? 0,
      sampleCount: videoStruct?.tracker.getSampleCount() ?? 0,
      samplesByTrack: videoStruct?.tracker.getSamplesByTrack() ?? {},
      readyState: el?.readyState ?? 0,
      paused: el?.paused ?? true,
      ended: el?.ended ?? false,
      watchdogTicks: this.#watchdog.ticks,
      frozenTicks: this.#watchdog.frozen,
      currentTime: el?.currentTime ?? 0,
      bufferedRanges,
      mseReadyState: this.#mse?.readyState ?? 'closed',
      videoErrorCode: el?.error?.code ?? 0,
      latencyTrendRatio: this.#latencyTracker.getTrendRatio(),
      lastLatencyMs: this.#latencyTracker.getLastLatencyMs(),
      latencyOlderMeanMs: latencyMeans?.olderMs,
      latencyRecentMeanMs: latencyMeans?.recentMs,
      targetShiftMs: shift,
      playheadMs,
      bufferedEndMs,
      liveEdgeDistanceMs,
      timeShiftErrorMs,
      activeGroup,
    };
  }

  /**
   * Data starvation: nothing has been appended for STARVATION_MS while the
   * buffer ahead of the playhead is (nearly) empty. Separates "no data is
   * arriving" (relay or library stopped delivering, typically right after a
   * switch) from a decoder wedge, which has data buffered ahead. Recorded, not
   * repaired: in an experiment a starving subscription is a mechanism failure
   * that must show up as such.
   */
  static readonly STARVATION_MS = 4000;
  #checkStarvation(el: HTMLVideoElement): void {
    if (this.#starvedSince !== undefined || !this.#firstFrameSeen) return;
    const vs = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    if (!vs || vs.lastAppendPerf === undefined) return;
    const now = performance.now();
    if (now - vs.lastAppendPerf < Player.STARVATION_MS) return;
    const buf = el.buffered;
    const ahead = buf.length > 0 ? buf.end(buf.length - 1) - el.currentTime : 0;
    if (ahead > 0.5) return;
    this.#starvedSince = vs.lastAppendPerf;
    events.emit('DATA_STARVED', {
      track: vs.trackName,
      request_id: Number(vs.requestId),
      pending: vs.pendingSwitch?.trackName ?? null,
      last_group: Number(this.#lastGroupOf(vs)),
      since_last_append_ms: now - vs.lastAppendPerf,
      playhead_ms: el.currentTime * 1000,
      buffered_end_ms: buf.length > 0 ? buf.end(buf.length - 1) * 1000 : null,
      ready_state: el.readyState,
      mse_ready_state: this.#mse?.readyState ?? 'closed',
      init_pending: vs.pendingInit !== undefined,
    });
  }

  /** Highest group id received for the stream's current track, -1n before any (F10). */
  #lastGroupOf(struct: MOQStreamStruct): bigint {
    return struct.tracker.getMaxGroup(struct.trackName) ?? -1n;
  }

  /** End PTS (ms) of the most recently appended video frame: where new data is landing in the buffer. */
  getAppendFrontMs(): number | undefined {
    return this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video')
      ?.lastAppendedEndPTS_ms;
  }

  /**
   * The gap-crossing policy's fill probe (F4): the furthest end of the video
   * appends that landed inside a gap within `q.windowMs` and end inside
   * [q.fromS, q.toS), with the last-appended front for the record.
   */
  getGapFillState(q: GapFillQuery): GapFillState {
    const front = this.getAppendFrontMs();
    return {
      appendFrontS: front !== undefined ? front / 1000 : undefined,
      ...this.#gapFills.state(q, performance.now()),
    };
  }

  /** Duration (ms) of the most recently parsed video frame; undefined before the first one. */
  getFrameDurationMs(): number | undefined {
    return this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video')
      ?.lastFrameDurationMs;
  }

  /**
   * True from SWITCH_SENT (the write handler is armed provisionally before the
   * SWITCH is awaited, F12) until the target's first object lands; a refusal
   * or an error rolls the arming back (to an older switch still pending, if
   * any).
   */
  hasSwitchInFlight(): boolean {
    return (
      this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video')?.pendingSwitch != null
    );
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
   * whose media time lies in the pending switch's appended target range
   * [seam PTS, target append front] is the first frame of the new
   * representation the viewer sees (SeamTracker.presented, M10). At that frame:
   *   switch_visibility_delay_ms = now - switchSentAt
   *   playback_position_jump_ms  = mediaTime - previous mediaTime - one frame
   *                                (0 when the seam is played through contiguously)
   *   viewer_pause_ms            = wall-clock gap to the previous presented frame
   *                                beyond one frame period (0 when smooth)
   * The poll also reports STARTUP on the first presented frame.
   */
  #installPerceivedPausePoll(): void {
    if (!this.#element) return;
    // requestVideoFrameCallback reports each presented frame with its media
    // time; where it is missing, fall back to an animation-frame poll that
    // reads currentTime (coarser, but the seam crossing is still detected).
    // Every record this poll emits says which one it was.
    const el = this.#element;
    const rvfc = (
      el as HTMLVideoElement & {
        requestVideoFrameCallback?: (
          cb: (now: number, m: VideoFrameCallbackMetadata) => void,
        ) => number;
      }
    ).requestVideoFrameCallback;
    const source: 'rvfc' | 'raf' = typeof rvfc === 'function' ? 'rvfc' : 'raf';
    let prevMediaMs: number | undefined;
    let prevNowMs: number | undefined;
    const poll = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      if (!this.#element) return;
      const mediaMs = metadata.mediaTime * 1000;
      if (!this.#firstFrameSeen) {
        this.#firstFrameSeen = true;
        events.emit('STARTUP', {
          source,
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
      const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
      const frameMs = videoStruct?.lastFrameDurationMs ?? 1000 / 30;
      // When the frame was handed to the compositor (rVFC), else the callback time.
      const presentedAt = metadata.presentationTime ?? now;
      const rec = this.#seams.presented({ mediaMs, frameMs, now: presentedAt });
      if (rec !== null && rec.seamPtsMs !== undefined) {
        const seam = rec.seamPtsMs;
        const visibilityDelayMs = now - rec.sentAt;
        const jumpMs = prevMediaMs !== undefined ? mediaMs - prevMediaMs - frameMs : null;
        const pauseMs = prevNowMs !== undefined ? Math.max(0, now - prevNowMs - frameMs) : null;
        // Ground truth for the seam: the hole in the element's buffered ranges
        // at the seam (0 = the seam lies inside one contiguous range). This is
        // what a range-jump seek crosses; the parsed-PTS gap above cannot see
        // frames the decoder never presented. The hole behind the presented
        // frame's range counts only when that range begins at or after the
        // seam; otherwise it is an older hole still sitting in the buffer, and
        // the seam itself was contiguous. The raw value stays available as
        // buffer_hole_behind_ms.
        let bufferHoleMs: number | null = null;
        let bufferHoleBehindMs: number | null = null;
        const ranges = this.#element.buffered;
        for (let i = 0; i < ranges.length; i++) {
          const startMs = ranges.start(i) * 1000;
          if (startMs - frameMs <= mediaMs && mediaMs <= ranges.end(i) * 1000 + frameMs) {
            bufferHoleBehindMs = i > 0 ? startMs - ranges.end(i - 1) * 1000 : 0;
            bufferHoleMs = startMs >= seam - frameMs / 2 ? bufferHoleBehindMs : 0;
            break;
          }
        }
        events.emit('SWITCH_FIRST_FRAME', {
          switch_seq: rec.seq,
          from: rec.from,
          to: rec.to,
          seam_pts_ms: seam,
          presented_pts_ms: mediaMs,
          switch_visibility_delay_ms: visibilityDelayMs,
          playback_position_jump_ms: jumpMs,
          viewer_pause_ms: pauseMs,
          seam_buffer_hole_ms: bufferHoleMs,
          buffer_hole_behind_ms: bufferHoleBehindMs,
          target_append_front_ms: rec.targetAppendFrontMs ?? null,
          // The seam landed behind the playhead the switch was sent at; the
          // frame above is still target media (M10), reached later.
          seam_behind_playhead: seamBehindPlayhead(rec),
          source,
        });

        this.#options.onSwitchVisible?.(rec.to);
      }
      prevMediaMs = mediaMs;
      prevNowMs = now;
      schedule(poll);
    };
    const schedule =
      typeof rvfc === 'function'
        ? (cb: (now: number, m: VideoFrameCallbackMetadata) => void) => rvfc.call(el, cb)
        : (cb: (now: number, m: VideoFrameCallbackMetadata) => void) =>
            requestAnimationFrame(now =>
              cb(now, { mediaTime: el.currentTime } as VideoFrameCallbackMetadata),
            );
    schedule(poll);
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
   * Returns bps 0 on subscribe failure or no data.
   */
  async probeTrackBandwidth(trackName: string, durationMs: number): Promise<ProbeResult> {
    if (!this.client) return { bps: 0, dtMs: 0 };
    const fullTrackName = getFullTrackName(this.#options.namespace, trackName);

    // Snapshot the active video tracker's cumulative bytes before the probe
    // window opens. Diff at the end gives us v (real-track bytes received
    // concurrently with the probe).
    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    const vBytesStart = videoStruct?.tracker.getCumulativeBytes() ?? 0;
    const tStart = Date.now();

    // The probe stays at the lowest subscriber priority: the relay derives its
    // stream priority below every video stream regardless, and 255 says the same.
    const result = await this.client.subscribe({
      fullTrackName,
      groupOrder: MEDIA_SCHEDULING.groupOrder,
      filterType: FilterType.LatestObject,
      forward: true,
      priority: 255,
    });
    if (result instanceof RequestError) return { bps: 0, dtMs: 0 };

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
    // Date.now() of the first and last probe object received (F13): the
    // burst's own span, without the subscribe RTT before it and the idle wait
    // after it that dt_ms includes.
    let firstObjectAt: number | null = null;

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
        if (firstObjectAt === null) firstObjectAt = lastObjectAt;
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
        first_object_ms: firstObjectAt,
        last_object_ms: count > 0 ? lastObjectAt : null,
        bps: 0,
      });
      return { bps: 0, dtMs: tEnd - tStart };
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
      // Subscribe sent to the end of the read (RTT and idle wait included).
      dt_ms: tEnd - tStart,
      // Epoch ms (Date.now) of the first and last probe object received.
      first_object_ms: firstObjectAt,
      last_object_ms: lastObjectAt,
      stream_done: streamDone,
      bps,
    });
    // dtMs includes the idle wait after the last object; the burst itself is
    // shorter, so a minimum-duration filter on it is conservative.
    return { bps, dtMs: lastObjectAt - tStart };
  }

  /**
   * Updates the onTrackSwitched callback post-construction.
   * Called by app.tsx after creating the Player and AbrController,
   * to wire the ABR switching guard release without a circular dependency.
   */
  setOnTrackSwitched(cb: (trackName: string, switchSeq?: number) => void): void {
    this.#options.onTrackSwitched = cb;
  }

  /** Wires the seam-visible notification (post-switch up-guard release in 'visible' mode). */
  setOnSwitchVisible(cb: (trackName: string) => void): void {
    this.#options.onSwitchVisible = cb;
  }

  /** Controller knob: reset the per-frame latency window when a switch lands. */
  setResetLatencyOnLanding(enabled: boolean): void {
    this.#resetLatencyOnLanding = enabled;
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
  async switchTrack(trackName: string): Promise<number | null> {
    // Set synchronously below once a number is allocated, so the caller can
    // read it right after the call returns its promise (F14).
    this.#lastSwitchSeq = null;
    if (!this.client) return null;
    if (!this.catalog) return null;

    const videoStruct = this.#streams.find(s => this.catalog?.getRole(s.trackName) === 'video');
    if (!videoStruct) return null;

    const fullTrackName = getFullTrackName(this.#options.namespace, trackName);
    const initData = this.catalog.getInitData(trackName);
    const role = this.catalog.getRole(trackName);
    const codec = this.catalog.getCodecString(trackName);

    if (!initData || !role || !codec) {
      logger.error('media', `switchTrack: missing catalog data for track ${trackName}`);
      this.#options.onTrackSwitched?.(videoStruct.trackName);
      return null;
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

    // Pre-allocate the new request id and update videoStruct.requestId BEFORE
    // awaiting client.switch(). If a second switchTrack call (ABR tick or
    // force_switch) starts before this one completes, it will read the
    // already-incremented requestId and pass it as subscriptionRequestId in
    // its own SWITCH — preventing the stale-id chain that the relay rejects
    // as ProtocolViolation and tears the WebTransport down. Concurrency on
    // the wire is preserved; only the id-state read is moved to before the
    // await.
    const subscriptionRequestId = videoStruct.requestId;
    // A previous switch that has not landed yet (its request id has no track
    // alias in the library) cannot be switched away from: the library treats
    // that as an internal error and destroys the whole session. This happens
    // when the ABR guard times out and re-fires. Skip instead.
    if (!this.client.subscriptionAliasMap.has(subscriptionRequestId)) {
      logger.warn(
        'media',
        `switchTrack: previous switch has not landed; skipping switch to ${trackName}`,
      );
      // Not sent, so no SWITCH_SENT; the attempt still gets its own number.
      const skippedSeq = this.#seams.allocateSeq();
      this.#lastSwitchSeq = skippedSeq;
      events.emit('SWITCH_SKIPPED', {
        switch_seq: skippedSeq,
        from: videoStruct.trackName,
        to: trackName,
        reason: 'previous switch not landed',
        pending_request_id: subscriptionRequestId,
      });
      this.#options.onTrackSwitched?.(videoStruct.trackName, skippedSeq);
      return skippedSeq;
    }
    const newRequestId = this.client.allocateNextRequestId();
    videoStruct.requestId = newRequestId;
    // Read once: the SWITCH_SENT record and the target's lower bound must agree.
    const sourceLastGroup = this.#lastGroupOf(videoStruct);

    const record = this.#seams.sent(videoStruct.trackName, trackName, {
      playheadMs: playheadPTS_ms,
      appendFrontMs: videoStruct.lastAppendedEndPTS_ms,
      sentAt: switchSentAt,
    });
    this.#lastSwitchSeq = record.seq;
    events.emit('SWITCH_SENT', {
      switch_seq: record.seq,
      from: videoStruct.trackName,
      to: trackName,
      request_id: newRequestId,
      old_request_id: subscriptionRequestId,
      playhead_ms: playheadPTS_ms ?? null,
      playhead_group:
        playheadPTS_ms !== undefined && this.#timeMap?.hasAnchor()
          ? this.#timeMap.groupContainingPTS(playheadPTS_ms)
          : null,
      // Highest group received on the current track (any order, dropped
      // objects included), -1 before any (F10; feeds pr1378's floor).
      last_received_group: sourceLastGroup,
      // The append front (end PTS of the last appended frame). buffered_end_ms
      // is the same value under its historical name; SAMPLE.buffered_end_ms is
      // the element's last buffered range end, a different quantity.
      append_front_ms: videoStruct.lastAppendedEndPTS_ms ?? null,
      buffered_end_ms: videoStruct.lastAppendedEndPTS_ms ?? null,
    });

    // Arm the write handler provisionally, before awaiting the SWITCH (F12).
    // The library maps the new subscription's alias when it processes
    // SWITCH_OK, and a target data stream can deliver objects to the write
    // handler before this function's continuation runs; armed only after the
    // await, those objects were dropped as stale, and if the first was the
    // keyframe the seam moved a GOP later. The alias check in #route still
    // keeps objects from before SWITCH_OK out ('pre-landing'). Rolled back on
    // a refusal or an error unless the switch already landed.
    const pending: PendingSwitch = {
      trackName,
      initData: initData.buffer as ArrayBuffer,
      mimeType,
      record,
      minGroup: sourceLastGroup,
    };
    const previousPending = videoStruct.pendingSwitch;
    videoStruct.pendingSwitch = pending;
    const rollback = () => {
      if (videoStruct.pendingSwitch === pending && record.landedAt === undefined) {
        videoStruct.pendingSwitch = previousPending;
      }
    };

    try {
      const result = await this.client.switch({
        requestId: newRequestId,
        fullTrackName,
        subscriptionRequestId,
        parameters: buildSwitchParameters(),
      });

      if (result instanceof RequestError) {
        rollback();
        logger.error(
          'media',
          `switchTrack: SWITCH rejected for ${trackName}:`,
          result.reasonPhrase.phrase,
        );
        events.emit('SWITCH_ERROR', {
          switch_seq: record.seq,
          to: trackName,
          request_id: newRequestId,
          reason: result.reasonPhrase.phrase,
          rtt_ms: performance.now() - switchSentAt,
        });
        // Roll back the optimistic id update so the next switchTrack attempt
        // references the still-active subscription rather than the failed one.
        videoStruct.requestId = subscriptionRequestId;
        this.#options.onTrackSwitched?.(videoStruct.trackName, record.seq);
        return record.seq;
      }

      // Confirm the arming: the write handler re-injects the init segment at
      // the landing. The onTrackSwitched callback (which releases the ABR
      // switching guard) is NOT called here — it fires in the write handler
      // AFTER the relay has actually delivered data on the new track. This
      // prevents rapid consecutive SWITCH messages that corrupt the relay's
      // switch context. Tracker is intentionally not reset — the
      // previous-track bandwidth estimate is still a valid indicator of
      // network capacity. (dash.js doesn't reset throughput on quality
      // switches either.)
      this.#confirmPendingSwitch(videoStruct, pending);
      events.emit('SWITCH_OK', {
        switch_seq: record.seq,
        to: trackName,
        request_id: newRequestId,
        rtt_ms: performance.now() - switchSentAt,
      });
    } catch (error) {
      rollback();
      logger.error('media', 'switchTrack: unexpected error', error);
      events.emit('SWITCH_ERROR', {
        switch_seq: record.seq,
        to: trackName,
        request_id: newRequestId,
        reason: String(error),
        rtt_ms: performance.now() - switchSentAt,
      });
      // Roll back the optimistic id update on unexpected failure too.
      videoStruct.requestId = subscriptionRequestId;
      this.#options.onTrackSwitched?.(videoStruct.trackName, record.seq);
    }
    return record.seq;
  }

  /**
   * `switch_seq` of the most recent switchTrack call, set synchronously during
   * the call (null when it returned before allocating one). The controller
   * stores it on its pending record so ABR_DECISION / ABR_SWITCH_PHANTOM name
   * the switch they decided (F14).
   */
  get lastSwitchSeq(): number | null {
    return this.#lastSwitchSeq;
  }

  /**
   * The relay accepted `pending` (armed provisionally before the SWITCH was
   * awaited, F12; it may even have landed already). A switch that was
   * accepted earlier and has not landed was replaced and can never land: it
   * ends in SWITCH_SUPERSEDED (C1), so every switch has exactly one terminal
   * record. If a newer switch re-armed the stream in the meantime, this one
   * can never land either and is superseded by it.
   */
  #confirmPendingSwitch(struct: MOQStreamStruct, pending: PendingSwitch): void {
    const playheadMs = (this.#element?.currentTime ?? 0) * 1000;
    const newer = struct.pendingSwitch;
    if (newer !== pending && pending.record.landedAt === undefined) {
      pending.record.supersededBy = newer?.record.seq;
      events.emit('SWITCH_SUPERSEDED', {
        switch_seq: pending.record.seq,
        by_switch_seq: newer?.record.seq ?? null,
        playhead_ms: playheadMs,
        landed: false,
      });
      return;
    }
    for (const old of this.#seams.armed(pending.record).superseded) {
      events.emit('SWITCH_SUPERSEDED', {
        switch_seq: old.seq,
        by_switch_seq: pending.record.seq,
        playhead_ms: playheadMs,
        landed: false,
      });
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
      struct = await this.subscribe({ trackName: 'catalog' });
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
      groupOrder: MEDIA_SCHEDULING.groupOrder,
      filterType: FilterType.LatestObject,
      forward: true,
      priority: MEDIA_SCHEDULING.priority,
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

    // Capture connect-time state for media tracks (not catalog) so FIRST_OBJECT
    // can report whether the relay clamped the start group. We only
    // populate #expectedStartGroupId for time-shifted mode with a non-zero
    // delay_groups; otherwise the relay does not clamp and we have nothing to
    // detect against.
    if (params.trackName !== 'catalog' && this.catalog) {
      const gopDurationMs = this.catalog.getGopDurationMs(params.trackName);
      const largest = result.largestLocation;
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

    // Abandoned groups are closed after two group times (GOP from the catalog).
    const tracker = new GoodputTracker(
      3,
      8,
      params.trackName !== 'catalog' && this.catalog
        ? this.catalog.getGopDurationMs(params.trackName)
        : undefined,
    );
    struct = {
      trackName: params.trackName,
      requestId: result.requestId,
      source: result.stream,
      tracker,
      pendingSwitch: null,
      lastAppendedEndPTS_ms: undefined,
    };

    // The startup video track is what is presented until the first seam.
    if (params.trackName !== 'catalog' && this.catalog?.getRole(params.trackName) === 'video') {
      this.#seams.setInitialTrack(params.trackName);
    }

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
