/**
 * Copyright 2025 The MOQtail Authors
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

import { ControlRecvStream, ControlSendStream, ControlStream } from './control_stream'
import { RequestStream } from './request_stream'
import {
  PublishNamespace,
  Namespace,
  NamespaceDone,
  Setup,
  ControlMessage,
  Fetch,
  FetchOk,
  FetchType,
  FilterType,
  GoAway,
  GroupOrder,
  Subscribe,
  SubscribeNamespace,
  SubscribeTracks,
  RequestError,
  RequestErrorCode,
  RequestUpdate,
  Publish,
  RequestOk,
  Switch,
  SubscribeOk,
  TrackStatus,
  ControlMessageType,
  SUPPORTED_VERSIONS,
  PublishBlocked,
  PublishDone,
  PublishDoneStatusCode,
} from '../model/control'
import {
  Datagram,
  FetchHeader,
  FetchHeaderType,
  FetchObject,
  FullTrackName,
  MoqtObject,
  ObjectForwardingPreference,
  SubgroupHeader,
  SubgroupHeaderType,
  SubgroupObject,
  RequestIdMap,
} from '../model/data'
import { FrozenByteBuffer } from '../model/common/byte_buffer'
import { ObjectDeliveryTimeoutProperty, TrackProperty } from '../model/property/track_property'
import { RecvStream } from './data_stream'
import {
  InternalError,
  Location,
  MOQtailError,
  ProtocolViolationError,
  ReasonPhrase,
  SetupOptions,
  assertNoAuthorityOverWebTransport,
  Tuple,
  MessageParameter,
  Forward,
  SwitchTransition,
  SubscriberPriority,
  GroupOrderParam,
  SubscriptionFilter,
  StreamResetCode,
  resolveTransportUrl,
} from '../model'
import { Track } from './track/track'
import { LiveTrackSource } from './track/content_source'
import { PublishNamespaceRequest } from './request/publish_namespace'
import { FetchRequest } from './request/fetch'
import { SubscribeRequest } from './request/subscribe'
import { PublishRequest } from './request/publish'
import { TrackStatusRequest } from './request/track_status'
import { getHandlerForControlMessage, getHandlerForRequestStreamMessage } from './handler/handler'
import { SubscribePublication } from './publication/subscribe'
import { FetchPublication } from './publication/fetch'
import { PublishPublication } from './publication/publish'
import { random60bitId } from './util/random_id'
import { isValidTrackAlias } from './util/validators'
import { PeerStreamResetError, streamResetCodeOf, streamResetReason } from './util/stream_reset'
import {
  MOQtailRequest,
  SubscribeOptions,
  SubscribeUpdateOptions,
  FetchOptions,
  MOQtailClientOptions,
  SwitchOptions,
  EarlyDiscardPolicyConfig,
  SubscribeResult,
  SwitchSuccess,
  SwitchFailure,
  DiscardedStreamInfo,
  DataStreamEnd,
  DataStreamEndInfo,
  PushedReceiver,
  TrackAliasHolder,
} from './types'
import { SendDatagramStream } from './datagram_stream'
import { logger, LogLevel, setLogLevel, setLogEnabledModules } from '../util/logger'

/**
 * @public
 * Represents a Media Over QUIC Transport (MOQT) client session.
 *
 * Use {@link MOQtailClient.new} to establish a connection and perform MOQT operations such as subscribing to tracks,
 * fetching historical data, announcing tracks for publication, and managing session lifecycle.
 *
 * Once initialized, the client provides high-level methods for MOQT requests and publishing. If a protocol violation
 * occurs, the client will terminate and must be re-initialized.
 *
 * ## Usage
 *
 * ### Connect and Subscribe to a Track
 * ```ts
 * const client = await MOQtailClient.new({ url });
 * const result = await client.subscribe({
 *   fullTrackName,
 *   filterType: FilterType.LatestObject,
 *   forward: true,
 *   groupOrder: GroupOrder.Original,
 *   priority: 0
 * });
 * if (!(result instanceof RequestError)) {
 *   for await (const object of result.stream) {
 *     // Consume MOQT objects
 *   }
 * }
 * ```
 *
 * ### Publish a namespace for Publishing
 * ```ts
 * const client = await MOQtailClient.new({ url });
 * const publishNamespaceResult = await client.publishNamespace(["camera", "main"]);
 * if (!(publishNamespaceResult instanceof RequestError)) {
 *   // Ready to publish objects under this namespace
 * }
 * ```
 *
 * ### Graceful Shutdown
 * ```ts
 * await client.disconnect();
 * ```
 */
/** How long a data stream waits for the subscription it belongs to be registered. */
const ALIAS_RESOLUTION_TIMEOUT_MS = 500

export class MOQtailClient {
  /**
   * Namespace prefixes (tuples) the peer has requested announce notifications for via SUBSCRIBE_NAMESPACE.
   * Used to decide which locally issued ANNOUNCE messages should be forwarded (future optimization: prefix trie).
   */
  readonly peerSubscribeNamespace = new Set<Tuple>()
  /**
   * Namespace prefixes this client has subscribed to (issued SUBSCRIBE_NAMESPACE). Enables automatic filtering
   * of incoming NAMESPACE / NAMESPACE_DONE. Maintained locally; no dedupe of overlapping / shadowing prefixes yet.
   */
  readonly subscribedNamespaces = new Set<Tuple>()

  readonly subscribedTracks = new Set<Tuple>()
  /**
   * Track namespaces this client has successfully published (received REQUEST_OK). Source of truth for
   * deciding what to withdraw on teardown or targeted removal (future optimization: prefix trie).
   */
  readonly publishedNamespaces = new Set<Tuple>()
  /**
   * Locally registered track definitions keyed by full track name string. Populated via addOrUpdateTrack.
   * Does not imply the track has been announced or has active publications.
   */
  readonly trackSources: Map<string, Track> = new Map()
  /**
   * All in‑flight request objects keyed by requestId (SUBSCRIBE, FETCH, ANNOUNCE, etc). Facilitates lookup
   * when responses / data arrive. Entries are removed on completion or error.
   */
  readonly requests: Map<bigint, MOQtailRequest> = new Map()
  /**
   * Active publications (SUBSCRIBE or FETCH) keyed by requestId to manage object stream controllers and lifecycle.
   * Subset / specialization view of `requests`.
   */
  readonly publications: Map<bigint, SubscribePublication | FetchPublication | PublishPublication> = new Map()
  /**
   * Active SUBSCRIBE request wrappers keyed by track alias for rapid alias -\> subscription resolution during
   * incoming unidirectional data handling.
   */
  readonly subscriptions: Map<bigint, any> = new Map()
  /**
   * Bidirectional track alias \<-\> subscription requestId mapping
   */
  readonly subscriptionAliasMap: Map<bigint, bigint> = new Map()
  /**
   * Bidirectional requestId \<-\> full track name mapping to reconstruct metadata for incoming objects.
   */
  readonly requestIdMap: RequestIdMap = new RequestIdMap()
  /**
   * Maps track aliases to full track names for quick resolution during data handling.
   */
  readonly aliasFullTrackNameMap: Map<bigint, FullTrackName> = new Map()
  /**
   * Pending state updates keyed by requestId and applied once a new track alias is seen.
   * Used to avoid premature state updates.
   */
  readonly pendingStateUpdates: Map<bigint, (newTrackAlias: bigint) => boolean> = new Map()
  /**
   * Receivers for tracks the peer pushed with PUBLISH, keyed by the PUBLISH's own
   * request id (the id a PUBLISH_DONE on that stream is correlated by). Pushed
   * receivers are not in `requests`, which only holds requests this side issued.
   */
  readonly pushedReceivers: Map<bigint, PushedReceiver> = new Map()

  /**
   * The routed SUBGROUP data streams whose ingest has not ended yet, per receiver.
   * Read by {@link MOQtailClient.stopDataStreams}.
   */
  readonly #openDataStreams: Map<TrackAliasHolder, Set<{ groupId: bigint; stop: () => Promise<void> }>> = new Map()

  /**
   * The bidirectional request stream each locally issued request runs on, keyed by the
   * requestId of the message that opened it (draft-18 §3.3.2). The stream stays open for
   * the request's lifetime: responses and follow-ups arrive on it, updates are written to
   * it, and closing it is how the request is cancelled.
   */
  readonly #requestStreams: Map<bigint, RequestStream> = new Map()

  /**
   * Request ids of requests re-issued after a per-request GOAWAY (§10.4), which consumes
   * a fresh Request ID each time (§10.1). The id the caller was given stays the client's
   * key for the request; these two maps translate it to and from the id now on the wire.
   */
  readonly #wireRequestIds: Map<bigint, bigint> = new Map()
  readonly #clientRequestIds: Map<bigint, bigint> = new Map()

  /**
   * Namespace path -\> the requestId that announced or subscribed to it, so the
   * namespace-keyed APIs ({@link MOQtailClient.unpublishNamespace}) can find the
   * stream to close.
   */
  readonly #namespaceRequestIds: Map<string, bigint> = new Map()

  /**
   * In-flight SWITCH operations keyed by target {@link FullTrackName.toString},
   * each a FIFO queue of resolvers. Per SWITCH PR #1378 a SWITCH is acknowledged
   * by the relay opening a PUBLISH carrying SWITCH_TRANSITION for the target
   * track (not a SubscribeOk). The PUBLISH handler shifts the oldest resolver
   * for that track and completes it with the pushed object stream
   * ({@link SwitchSuccess}) or — via the parked-failure path below — with a
   * {@link SwitchFailure}. The queue tolerates multiple concurrent switches to
   * the same target track (the PUBLISH alone cannot identify which source
   * subscription it replaces), resolving them in send order.
   */
  readonly pendingSwitches: Map<string, Array<(result: SwitchSuccess | SwitchFailure) => void>> = new Map()
  /**
   * Request streams that peer-opened PUBLISHes arrived on, keyed by the PUBLISH's
   * request id. Under draft-18 resetting that stream is how a pushed subscription
   * (an unsolicited peer publish, or the post-switch subscription of SWITCH PR
   * #1378) is cancelled; see {@link MOQtailClient.unsubscribe}.
   */
  readonly pushedRequestStreams: Map<bigint, RequestStream> = new Map()
  /**
   * Switch resolvers parked by a *failure* PUBLISH (SWITCH_TRANSITION present,
   * Forward State 0), keyed by that PUBLISH's request id. The relay
   * immediately follows such a PUBLISH with PUBLISH_DONE carrying the failure
   * status code; handlerPublishDone completes the resolver with a
   * {@link SwitchFailure} built from it. If that PUBLISH_DONE never arrives
   * (relay crash or teardown between the two control messages), the entry is
   * reaped when the owning switch()'s local response deadline settles the
   * promise — see removeOwnResolver — so a parked resolver can never outlive
   * its switch() call.
   */
  readonly pendingSwitchFailures: Map<bigint, (result: SwitchFailure) => void> = new Map()
  /**
   * Expiry timestamps (ms epoch) of SWITCH requests that hit the local
   * response deadline, keyed by target-track key; one entry per timed-out
   * SWITCH. Per SWITCH PR #1378, a PUBLISH carrying SWITCH_TRANSITION with no
   * pending SWITCH requires closing the session with PROTOCOL_VIOLATION. A
   * relay answer that arrives after the local deadline is late, not
   * unsolicited, so handlerPublish consumes one unexpired entry and declines
   * the PUBLISH instead (see handler/publish.ts). An unmatched
   * SWITCH_TRANSITION with no tombstone remains a protocol violation.
   *
   * This softening of the spec's letter is a documented, deliberate
   * deviation — the deadline these tombstones compensate for is a
   * client-side invention the spec's silent pre-validation failure forces on
   * us. Rationale, exact behavior per late-PUBLISH kind, and the
   * application-visible consequence of a late SUCCESS answer live in
   * docs/switch-pr1378-conformance.md.
   */
  readonly lateSwitchTombstones: Map<string, number[]> = new Map()
  /**
   * Client-side deadline for the relay to answer a SWITCH with a PUBLISH.
   * Sized at 2x the relay's default T_switch (`--t-switch-ms`, 3000 ms) so a
   * relay operating within its own budget always wins the race. Deployments
   * that raise the relay's `--t-switch-ms` past 3000 must raise this in
   * step, or switches the relay would still complete resolve as local
   * Timeout failures (the late-answer tombstone path).
   * See {@link MOQtailClient.switch}.
   */
  static readonly SWITCH_RESPONSE_TIMEOUT_MS = 6000
  /**
   * Retention window for {@link MOQtailClient.lateSwitchTombstones} entries. Must cover the
   * relay's T_switch plus worst-case network delay; kept bounded so
   * unsolicited SWITCH_TRANSITION detection is only deferred, not disabled.
   */
  static readonly SWITCH_TOMBSTONE_TTL_MS = 30_000
  /** Underlying WebTransport session (set after successful construction in MOQtailClient.new). */
  webTransport!: WebTransport
  /** Validated Setup message the server sent back during handshake (protocol parameters negotiated). */
  #serverSetup!: Setup
  /** Outgoing / incoming control message stream pair. */
  controlStream!: ControlStream
  /** Reader over incoming uni streams: the control recv half first, data streams after. */
  #incomingUniStreams!: ReadableStreamDefaultReader<ReadableStream<Uint8Array>>
  /** Timeout (ms) applied to reading incoming data streams; undefined =\> no explicit timeout. */
  dataStreamTimeoutMs?: number
  /** Timeout (ms) for control stream read operations; undefined =\> no explicit timeout. */
  controlStreamTimeoutMs?: number
  /**
   * How long an incoming data stream waits for its track alias to be claimed before
   * it is discarded as unrouted (ms). A data stream can overtake the SUBSCRIBE_OK (or
   * PUBLISH) that names its alias, since the two travel on different streams.
   */
  trackAliasResolutionTimeoutMs: number = ALIAS_RESOLUTION_TIMEOUT_MS

  /** Flag indicating the client has been disconnected/destroyed and cannot accept further API calls. */
  #isDestroyed = false
  /** Internal monotonically increasing client-assigned request id counter (even/odd parity scheme advances by 2). */
  #dontUseRequestId: bigint = 0n
  /** Active early discard policy; undefined means no per-stream deadline is applied. */
  #earlyDiscardPolicy: EarlyDiscardPolicyConfig | undefined

  /**
   * TODO: onNamespaceAnnounced may be a better name
   * Fired when an PUBLISH_NAMESPACE control message is processed for a track namespace.
   * Use to update UI or trigger discovery logic.
   * Discovery event.
   */
  onNamespacePublished?: (msg: PublishNamespace) => void

  /**
   * Fired on GOAWAY reception signaling graceful session wind-down.
   * Use to prepare for disconnect or cleanup.
   * Lifecycle handler.
   */
  onGoaway?: (msg: GoAway) => void

  /**
   * Whether the peer has sent a GOAWAY on the control stream. Once it has, this side
   * should not start new requests (§10.4); a second one closes the session with
   * PROTOCOL_VIOLATION.
   */
  goawayReceived = false

  /**
   * Fired if the underlying WebTransport session fails (ready -\> closed prematurely).
   * Use to log or alert on transport errors.
   * Lifecycle/error handler.
   */
  onWebTransportFail?: () => void

  /**
   * Fired exactly once when the client transitions to terminated (disconnect).
   * Use to clean up resources or notify user.
   * Lifecycle handler.
   */
  onSessionTerminated?: (reason?: unknown) => void

  /**
   * Invoked after each outbound control message is sent.
   * Use for logging or analytics.
   * Informational event.
   */
  onMessageSent?: (msg: ControlMessage) => void

  /**
   * Invoked upon receiving each inbound control message before handling.
   * Use for logging or debugging.
   * Informational event.
   */
  onMessageReceived?: (msg: ControlMessage) => void

  /**
   * Invoked for each decoded data object/header arriving on a uni stream (fetch or subgroup).
   * Use to process or display incoming media/data.
   * Informational event.
   */
  onDataReceived?: (data: SubgroupObject | SubgroupHeader | FetchObject | FetchHeader) => void

  /**
   * Invoked after enqueuing each outbound data object/header.
   * Reserved for future use.
   * Informational event.
   */
  onDataSent?: (data: SubgroupObject | SubgroupHeader | FetchObject | FetchHeader) => void

  /**
   * Invoked when an incoming data stream is dropped without its objects being
   * delivered, with the reason and the bytes it had cost (M15). Today the one reason
   * is `unrouted`: no subscription claimed the stream's track alias. The stream is
   * cancelled with STOP_SENDING(CANCELLED) before this fires.
   * Accounting event: lets an application count link usage it never consumed.
   */
  onStreamDiscarded?: (info: DiscardedStreamInfo) => void

  /**
   * Invoked when a data stream that was routed to a receiver (a SUBSCRIBE or a
   * pushed PUBLISH receiver) ends, after its last object was enqueued on the
   * receiver's object stream: how it ended (`fin`, `reset`, `stopped`), its group
   * and subgroup, and what it delivered. Fires before the receiver is checked for
   * completion. Exceptions thrown by the callback are logged and swallowed.
   */
  onDataStreamEnded?: (info: DataStreamEndInfo) => void

  /**
   * General-purpose error callback for surfaced exceptions not thrown to caller synchronously.
   * Use to log or display errors.
   * Error handler.
   */
  onError?: (er: unknown) => void

  /** Invoked for each decoded datagram object/status arriving. */
  onDatagramReceived?: (data: Datagram) => void

  /** Invoked after enqueuing each outbound datagram object/status. */
  onDatagramSent?: (data: Datagram) => void

  /** Fired when an inbound PUBLISH control message is received. */
  onPeerPublish?: (msg: Publish, stream: ReadableStream<MoqtObject>) => void

  /**
   * Fired when an inbound PUBLISH_DONE control message is received, with the request
   * id of the stream it arrived on (the subscription it ends), before the library
   * completes that subscription.
   */
  onPeerPublishDone?: (msg: PublishDone, requestId: bigint) => void

  /** Fired when an inbound SUBSCRIBE_NAMESPACE control message is received. */
  onPeerSubscribeNamespace?: (msg: SubscribeNamespace) => void

  /** Fired when an inbound SUBSCRIBE_TRACKS control message is received. */
  onPeerSubscribeTracks?: (msg: SubscribeTracks) => void

  /**
   * Fired when a PUBLISH_BLOCKED arrives on a {@link MOQtailClient.subscribeTracks}
   * stream: the peer has a matching track but no bidi stream to send its PUBLISH on
   * until its stream limit lifts (§10.20). `prefix` is the prefix this side subscribed
   * with, which is what the message's suffix hangs off.
   */
  onPeerPublishBlocked?: (prefix: Tuple, msg: PublishBlocked) => void

  /** Fired when a NAMESPACE message arrives on a SUBSCRIBE_NAMESPACE bi-stream (prefix + suffix). */
  onPeerNamespace?: (prefix: Tuple, suffix: Tuple) => void

  /** Fired when a NAMESPACE_DONE message arrives on a SUBSCRIBE_NAMESPACE bi-stream (prefix + suffix). */
  onPeerNamespaceDone?: (prefix: Tuple, suffix: Tuple) => void

  /** Datagram writer for sending datagrams. */
  #datagramWriter: WritableStreamDefaultWriter<Uint8Array> | undefined

  /** Datagram reader for receiving datagrams. */
  #datagramReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  /** Flag indicating if datagram reception loop is active. */
  #isReceivingDatagrams = false

  /** Controller for the received objects stream. */
  #receivedDatagramObjectController?: ReadableStreamDefaultController<MoqtObject>

  /** Per-track handlers for received datagrams. */
  #datagramTrackHandlers: Map<string, (obj: MoqtObject) => void> = new Map()

  /**
   * Stream of all received MoqtObjects from datagrams across all tracks
   * Consumer should filter by fullTrackName as needed
   *
   * WARNING: Only one reader should be active. For multiple subscribers,
   * use subscribeToTrackDatagrams() instead
   */
  readonly receivedDatagramObjects: ReadableStream<MoqtObject>

  /**
   * Allocate the next client-originated request id using the even/odd stride pattern (increments by 2).
   * Ensures uniqueness within the session and leaves space for peer-assigned ids if parity strategy is employed.
   */
  get #nextClientRequestId(): bigint {
    const id = this.#dontUseRequestId
    this.#dontUseRequestId += 2n
    return id
  }

  /**
   * Generates a safe, sequential local request ID for tracking pushed/incoming tracks.
   */
  allocatePseudoRequestId(): bigint {
    return this.#nextClientRequestId
  }

  /**
   * Pre-allocate a client-originated request id for an outbound control message.
   *
   * Pass the result back via the matching options' `requestId` field (e.g.
   * {@link SwitchOptions.subscriptionRequestId}). This lets the caller update its own
   * subscription-id state synchronously *before* awaiting the operation —
   * required when multiple concurrent calls would otherwise read a stale
   * subscription_request_id and the relay would reject the racing message.
   */
  allocateNextRequestId(): bigint {
    return this.#nextClientRequestId
  }

  /**
   * Gets the current server setup configuration.
   *
   * @returns The {@link Setup} instance the server sent back during handshake.
   */
  get serverSetup(): Setup {
    return this.#serverSetup
  }

  /**
   * Returns true if datagram support is currently active
   */
  get isDatagramsEnabled(): boolean {
    return this.#isReceivingDatagrams
  }

  /**
   * Sets the global log level for all moqtail-ts loggers.
   * @param level - The minimum {@link LogLevel} to output. Use `LogLevel.NONE` to silence all logs.
   */
  static setLogLevel(level: LogLevel): void {
    setLogLevel(level)
  }

  /**
   * Restricts log output to the specified module names. Pass `null` to allow all modules.
   * @param modules - Array of module name strings, or `null` to enable all modules.
   */
  static setLogEnabledModules(modules: string[] | null): void {
    setLogEnabledModules(modules)
  }

  /**
   * Guard that throws if the client has been destroyed (disconnect already called). Used at start of public APIs
   * to fail fast rather than perform partial operations on a torn-down session.
   * @throws MOQtailError when #isDestroyed is true.
   */
  #ensureActive() {
    if (this.#isDestroyed) throw new MOQtailError('MOQtailClient is destroyed and cannot be used.')
  }

  private constructor() {
    // Create a stream for received datagram objects
    this.receivedDatagramObjects = new ReadableStream<MoqtObject>({
      start: (controller) => {
        this.#receivedDatagramObjectController = controller
      },
      cancel: () => this.stopDatagrams(),
    })
  }

  /**
   * Establishes a new {@link MOQtailClient} session over WebTransport and performs the MOQT setup handshake.
   *
   * @param args - {@link MOQtailClientOptions}
   *
   * @returns Promise resolving to a ready {@link MOQtailClient} instance.
   *
   * @throws :{@link ProtocolViolationError} If the server sends an unexpected or invalid message during setup.
   *
   * @example Minimal connection
   * ```ts
   * const client = await MOQtailClient.new({
   *   url: 'https://relay.example.com/transport'
   * });
   * ```
   *
   * @example With callbacks and options
   * ```ts
   * const client = await MOQtailClient.new({
   *   url,
   *   setupOptions: new SetupOptions().addPath('/live'),
   *   transportOptions: { congestionControl: 'default' },
   *   dataStreamTimeoutMs: 5000,
   *   controlStreamTimeoutMs: 2000,
   *   enableDatagrams: true,
   *   callbacks: {
   *     onMessageSent: msg => console.log('Sent:', msg),
   *     onMessageReceived: msg => console.log('Received:', msg),
   *     onSessionTerminated: reason => console.warn('Session ended:', reason),
   *     onDatagramReceived: data => console.log('Datagram:', data),
   *   }
   * });
   * ```
   */
  static async new(args: MOQtailClientOptions): Promise<MOQtailClient> {
    let {
      url,
      setupOptions,
      transportOptions,
      dataStreamTimeoutMs,
      controlStreamTimeoutMs,
      enableDatagrams,
      callbacks,
    } = args
    const client = new MOQtailClient()

    // send supported versions
    // The protocols are sent in wt-available-protocols header
    if (!transportOptions) {
      transportOptions = { protocols: [] }
    }
    if (!transportOptions.protocols) {
      transportOptions = { ...transportOptions, protocols: [...SUPPORTED_VERSIONS] }
    } else {
      transportOptions.protocols.push(...SUPPORTED_VERSIONS)
    }

    logger.log('MOQtailClient', 'transportOptions', transportOptions)

    const { transportUrl, moqtUrl } = resolveTransportUrl(url)
    if (moqtUrl) {
      logger.log('MOQtailClient', `moqt:// resolved to ${transportUrl}`)
      if (moqtUrl.fragment)
        logger.log('MOQtailClient', `moqt:// fragment (local-only): ${moqtUrl.fragment.kind}:${moqtUrl.fragment.value}`)
    }

    client.webTransport = new WebTransport(transportUrl, transportOptions)

    await client.webTransport.ready
    try {
      if (callbacks?.onMessageSent) client.onMessageSent = callbacks.onMessageSent
      if (callbacks?.onMessageReceived) client.onMessageReceived = callbacks.onMessageReceived
      if (callbacks?.onSessionTerminated) client.onSessionTerminated = callbacks.onSessionTerminated
      if (callbacks?.onDatagramReceived) client.onDatagramReceived = callbacks.onDatagramReceived
      if (callbacks?.onDatagramSent) client.onDatagramSent = callbacks.onDatagramSent

      if (dataStreamTimeoutMs) client.dataStreamTimeoutMs = dataStreamTimeoutMs
      if (controlStreamTimeoutMs) client.controlStreamTimeoutMs = controlStreamTimeoutMs

      // The control plane is a pair of uni streams. Open our send half and write
      // SETUP first so it goes out without waiting on the server's half, which the
      // relay only opens after accepting ours. Control streams get the highest priority.
      const sendStream = await client.webTransport.createUnidirectionalStream({
        sendOrder: Number.MAX_SAFE_INTEGER,
      })
      const sendHalf = new ControlSendStream(sendStream, client.onMessageSent)
      const params = setupOptions ? setupOptions.build() : new SetupOptions().build()
      assertNoAuthorityOverWebTransport(params)
      await sendHalf.send(new Setup(params))

      // The server's control stream is the first uni stream it opens; every later
      // one is a data stream, so the same reader is reused by #acceptIncomingUniStreams.
      client.#incomingUniStreams = client.webTransport.incomingUnidirectionalStreams.getReader()
      const { value: recvStream, done: recvStreamDone } = await client.#incomingUniStreams.read()
      if (recvStreamDone || !recvStream)
        throw new ProtocolViolationError('MOQtailClient.new', 'Session closed before the server control stream')
      const recvHalf = new ControlRecvStream(recvStream, client.controlStreamTimeoutMs, client.onMessageReceived)
      client.controlStream = new ControlStream(sendHalf, recvHalf)

      const reader = client.controlStream.stream.getReader()
      const { value: response, done } = await reader.read()
      if (done) throw new ProtocolViolationError('MOQtailClient.new', 'Stream closed after client setup')
      if (!(response instanceof Setup))
        throw new ProtocolViolationError('MOQtailClient.new', 'Expected setup as the first control message')

      client.#serverSetup = response
      reader.releaseLock()

      client.#handleIncomingControlMessages()
      client.#acceptIncomingUniStreams()
      client.#acceptIncomingBiStreams()

      // Optionally enable datagram support
      if (enableDatagrams) {
        await client.startDatagrams()
      }

      return client
    } catch (error) {
      await client.disconnect(
        new InternalError('MOQtailClient.new', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Start receiving datagrams from the WebTransport connection.
   * Must be called before datagrams can be received (unless enableDatagrams: true was set in options).
   *
   * @throws MOQtailError if client is destroyed or datagrams already started
   */
  async startDatagrams(): Promise<void> {
    this.#ensureActive()

    if (this.#isReceivingDatagrams) {
      logger.warn('MOQtailClient', 'Datagrams already started')
      return
    }

    logger.log('MOQtailClient', 'Starting datagram support...')
    this.#datagramReader = this.webTransport.datagrams.readable.getReader()
    this.#datagramWriter = this.webTransport.datagrams.writable.getWriter()
    this.#isReceivingDatagrams = true

    // Start background datagram reception
    this.#acceptIncomingDatagrams()
    logger.log('MOQtailClient', 'Datagram support started')
  }

  /**
   * Stop receiving datagrams and release resources.
   * Idempotent - safe to call multiple times.
   */
  async stopDatagrams(): Promise<void> {
    if (!this.#isReceivingDatagrams) return

    logger.log('MOQtailClient', 'Stopping datagram support...')
    this.#isReceivingDatagrams = false
    this.#datagramTrackHandlers.clear()

    if (this.#datagramReader) {
      await this.#datagramReader.cancel().catch(() => {})
      this.#datagramReader.releaseLock()
      this.#datagramReader = undefined
    }

    if (this.#datagramWriter) {
      await this.#datagramWriter.close().catch(() => {})
      this.#datagramWriter = undefined
    }

    if (this.#receivedDatagramObjectController) {
      try {
        this.#receivedDatagramObjectController.close()
      } catch {
        // Already closed
      }
    }
  }

  /**
   * Subscribe to receive datagrams for a specific track.
   * Multiple tracks can have separate handlers that run concurrently.
   *
   * @param trackAlias - Track alias to subscribe to
   * @param handler - Function called for each received MoqtObject on this track
   * @returns Unsubscribe function to remove the handler
   *
   * @example
   * ```ts
   * const unsubscribe = client.subscribeToTrackDatagrams(trackAlias, (obj) => {
   *   console.log('Received datagram:', obj.payload);
   * });
   * // Later: unsubscribe();
   * ```
   */
  subscribeToTrackDatagrams(trackAlias: bigint, handler: (obj: MoqtObject) => void): () => void {
    const key = trackAlias.toString()
    logger.log('MOQtailClient', `Registering datagram handler for trackAlias=${trackAlias}`)
    this.#datagramTrackHandlers.set(key, handler)

    return () => {
      logger.log('MOQtailClient', `Unregistering datagram handler for trackAlias=${trackAlias}`)
      this.#datagramTrackHandlers.delete(key)
    }
  }

  /**
   * Unsubscribe from datagram delivery for a specific track.
   *
   * @param trackAlias - Track alias to unsubscribe from
   */
  unsubscribeFromTrackDatagrams(trackAlias: bigint): void {
    const key = trackAlias.toString()
    this.#datagramTrackHandlers.delete(key)
  }

  /**
   * Create a datagram sender for a specific track.
   *
   * @param trackAlias - Track alias for outgoing datagrams
   * @returns SendDatagramStream for writing MoqtObjects as datagrams
   * @throws MOQtailError if datagram writer not initialized (call startDatagrams() first)
   *
   * @example
   * ```ts
   * const sender = client.createDatagramSender(trackAlias);
   * await sender.write(moqtObject);
   * ```
   */
  createDatagramSender(trackAlias: bigint): SendDatagramStream {
    this.#ensureActive()

    if (!this.#datagramWriter) {
      throw new MOQtailError(
        'Datagrams not started. Call startDatagrams() first or set enableDatagrams: true in options.',
      )
    }

    logger.log('MOQtailClient', `Creating datagram sender for trackAlias=${trackAlias}`)
    return SendDatagramStream.fromWriter(this.#datagramWriter, trackAlias, this.onDatagramSent)
  }

  /**
   * Send a single MoqtObject as a datagram.
   * Convenience method for one-off datagram sends.
   *
   * @param trackAlias - Track alias for this object
   * @param object - MoqtObject to send
   * @throws MOQtailError if datagram writer not initialized
   *
   * @example
   * ```ts
   * await client.sendDatagram(trackAlias, moqtObject);
   * ```
   */
  async sendDatagram(trackAlias: bigint, object: MoqtObject): Promise<void> {
    this.#ensureActive()

    if (!this.#datagramWriter) {
      throw new MOQtailError(
        'Datagrams not started. Call startDatagrams() first or set enableDatagrams: true in options.',
      )
    }

    const datagram = object.tryIntoDatagram(trackAlias)
    const serialized = datagram.serialize().toUint8Array()
    if (this.onDatagramSent) this.onDatagramSent(datagram)

    await this.#datagramWriter.write(serialized)
  }

  /**
   * Background loop that receives and parses incoming datagrams.
   */
  async #acceptIncomingDatagrams(): Promise<void> {
    logger.log('MOQtailClient', 'Starting datagram reception loop...')

    try {
      while (this.#isReceivingDatagrams && this.#datagramReader) {
        const { done, value: datagramBytes } = await this.#datagramReader.read()

        if (done) {
          logger.log('MOQtailClient', 'Datagram reader done, stopping reception')
          this.#isReceivingDatagrams = false
          if (this.#receivedDatagramObjectController) {
            try {
              this.#receivedDatagramObjectController.close()
            } catch {
              // Already closed
            }
          }
          break
        }

        if (!datagramBytes || datagramBytes.length === 0) {
          continue
        }

        try {
          const datagram = Datagram.deserialize(new FrozenByteBuffer(datagramBytes))
          const trackAlias = datagram.trackAlias

          if (this.onDatagramReceived) {
            this.onDatagramReceived(datagram)
          }

          const fullTrackName = this.#resolveTrackAlias(trackAlias)
          const moqtObject = MoqtObject.fromDatagram(datagram, fullTrackName)

          // Dispatch to track-specific handler if registered
          const trackKey = trackAlias.toString()
          const handler = this.#datagramTrackHandlers.get(trackKey)
          if (handler) {
            try {
              handler(moqtObject)
            } catch (handlerError) {
              logger.warn('MOQtailClient', 'Datagram track handler error:', handlerError)
            }
          }

          // Also enqueue to the general stream
          if (this.#receivedDatagramObjectController) {
            try {
              this.#receivedDatagramObjectController.enqueue(moqtObject)
            } catch {
              // Stream closed
            }
          }
        } catch (error) {
          // Log but don't break - individual datagrams may be corrupt/unknown
          logger.warn('MOQtailClient', 'Failed to parse datagram:', error)
          continue
        }
      }
    } catch (error) {
      logger.error('MOQtailClient', 'Datagram reception error:', error)
      if (this.#receivedDatagramObjectController) {
        try {
          this.#receivedDatagramObjectController.error(error)
        } catch {
          // Already errored/closed
        }
      }
      this.#isReceivingDatagrams = false
    }
  }

  /**
   * Resolve track alias to full track name using client's request ID map.
   * Falls back to a placeholder if not found.
   */
  #resolveTrackAlias(trackAlias: bigint): FullTrackName {
    try {
      const requestId = this.subscriptionAliasMap.get(trackAlias)
      if (requestId !== undefined) {
        return this.requestIdMap.getNameByRequestId(requestId)
      }
      return FullTrackName.tryNew('unknown', `track-${trackAlias}`)
    } catch {
      return FullTrackName.tryNew('unknown', `track-${trackAlias}`)
    }
  }

  /**
   * Sets (or replaces) the client-level default early discard policy for incoming subgroup streams.
   *
   * When set, each incoming subgroup QUIC stream is given a deadline of `subgroupReceiveTimeout` ms to
   * complete. If the stream has not finished within that window it is cancelled — objects already
   * delivered to the subscription are kept, but no further objects arrive from that stream.
   *
   * This is a client-wide default. Individual subscriptions can override it via the `earlyDiscardPolicy`
   * field in {@link SubscribeOptions}, which takes precedence over this setting.
   *
   * The policy takes effect on the next stream accepted after this call. Passing a new config
   * replaces the previous one. Pass `undefined` to remove the default.
   *
   * @example
   * ```ts
   * client.setEarlyDiscardPolicy({ subgroupReceiveTimeout: 2000 })
   * ```
   */
  setEarlyDiscardPolicy(config: EarlyDiscardPolicyConfig | undefined): void {
    this.#ensureActive()
    this.#earlyDiscardPolicy = config
  }

  /**
   * Gracefully terminates this {@link MOQtailClient} session and releases underlying {@link https://developer.mozilla.org/docs/Web/API/WebTransport | WebTransport} resources.
   *
   * @param reason - Optional application-level reason (string or error) recorded and wrapped in an {@link InternalError}
   * passed to the {@link MOQtailClient.onSessionTerminated | onSessionTerminated} callback.
   *
   * @returns Promise that resolves once shutdown logic completes. Subsequent calls are safe no-ops.
   *
   * @example Basic usage
   * ```ts
   * await client.disconnect();
   * ```
   *
   * @example With reason
   * ```ts
   * await client.disconnect('user logout');
   * ```
   *
   * @example Idempotent double call
   * ```ts
   * await client.disconnect();
   * await client.disconnect(); // no error
   * ```
   *
   * @example Page unload safety
   * ```ts
   * window.addEventListener('beforeunload', () => {
   *   client.disconnect('page unload');
   * });
   * ```
   */
  async disconnect(reason?: unknown) {
    logger.log('MOQtailClient', 'disconnect', reason)
    if (this.#isDestroyed) return
    this.#isDestroyed = true

    // Stop datagrams first
    await this.stopDatagrams()

    // Close every open request stream so peers see each request cancelled rather than
    // only the session going away.
    const openStreams = [...this.#requestStreams.values()]
    this.#requestStreams.clear()
    this.#namespaceRequestIds.clear()
    await Promise.allSettled(openStreams.map((requestStream) => requestStream.close()))

    if (!this.webTransport.closed) this.webTransport.close()
    if (this.onSessionTerminated)
      this.onSessionTerminated(
        new InternalError('MOQtailClient.disconnect', reason instanceof Error ? reason.message : String(reason)),
      )
  }

  /**
   * Registers or updates a {@link Track} definition for local publishing or serving.
   *
   * A {@link Track} describes a logical media/data stream, identified by a unique name and namespace.
   * - If `trackSource.live` is present, the track can be served to subscribers in real-time.
   * - If `trackSource.past` is present, the track can be fetched for historical data.
   * - If both are present, the track supports both live and historical access.
   *
   * @param track - The {@link Track} instance to add or update. See {@link TrackSource} for live/past source options.
   * @returns void
   * @throws : {@link MOQtailError} If the client has been destroyed.
   *
   * @example Create a live video track from getUserMedia
   * ```ts
   * const stream = await navigator.mediaDevices.getUserMedia({ video: true });
   * const videoTrack = stream.getVideoTracks()[0];
   *
   * // Convert video frames to MoqtObject instances using your chosen scheme (e.g. WARP, CMAF, etc.)
   * // This part is application-specific and not provided by MOQtail:
   * const liveReadableStream: ReadableStream<MoqtObject> = ...
   *
   * // Register the track for live subscription
   * client.addOrUpdateTrack({
   *   fullTrackName: { namespace: ["camera"], name: "main" },
   *   trackSource: { live: liveReadableStream },
   *   publisherPriority: 0 // highest priority
   * });
   *
   * // For a hybrid track (live + past):
   * import { MemoryObjectCache } from './track/object_cache';
   * const cache = new MemoryObjectCache(); // Caches are not yet fully supported
   * client.addOrUpdateTrack({
   *   fullTrackName: { namespace: ["camera"], name: "main" },
   *   trackSource: { live: liveReadableStream, past: cache },
   *   publisherPriority: 8
   * });
   * ```
   */
  addOrUpdateTrack(track: Track) {
    this.#ensureActive()
    if (!isValidTrackAlias(track.trackAlias)) {
      track.trackAlias = random60bitId()
    }
    this.trackSources.set(track.fullTrackName.toString(), track)
  }

  /**
   * Removes a previously registered {@link Track} from this client's local catalog.
   *
   * This deletes the in-memory entry inserted via {@link MOQtailClient.addOrUpdateTrack}, so future lookups by its {@link Track.fullTrackName} will fail.
   * Does **not** automatically:
   * - Withdraw the namespace announcement (call {@link MOQtailClient.unpublishNamespace} separately if you want to inform peers)
   * - Cancel active subscriptions or fetches (they continue until normal completion)
   * - Affect already-sent objects.
   *
   * If the track was not present, the call is a silent no-op (idempotent removal).
   *
   * @param track - The exact {@link Track} instance (its canonical name is used as the key).
   * @throws : {@link MOQtailError} If the client has been destroyed.
   *
   * @example
   * ```ts
   * // Register a track
   * client.addOrUpdateTrack(track);
   *
   * // Later, when no longer publishing:
   * client.removeTrack(track);
   *
   * // Optionally, inform peers that the namespace is no longer available:
   * await client.unpublishNamespace(track.fullTrackName.namespace);
   * ```
   */
  removeTrack(track: Track) {
    this.#ensureActive()
    this.trackSources.delete(track.fullTrackName.toString())
  }

  /**
   * Subscribes to a track and returns a stream of {@link MoqtObject}s matching the requested window and relay forwarding mode.
   *
   * - `forward: true` tells the relay to forward objects to this subscriber as they arrive.
   * - `forward: false` means the relay subscribes upstream but buffers objects locally, not forwarding them to you.
   * - `filterType: AbsoluteStart` lets you specify a start position in the future; the stream waits for that object. If the start location is \< the latest object
   * observed at the publisher then it behaves as `filterType: LatestObject`
   * - `filterType: AbsoluteRange` lets you specify a start and end group, both of should be in the future; the stream waits for those objects. If the start location is \< the latest object
   * observed at the publisher then it behaves as `filterType: LatestObject`.
   *
   * The method returns either a {@link RequestError} (on refusal) or an object with the subscription `requestId` and a `ReadableStream` of {@link MoqtObject}s.
   * Use the `requestId` for {@link MOQtailClient.unsubscribe} or {@link MOQtailClient.subscribeUpdate}. Use the `stream` to decode and display objects.
   *
   * @param args - {@link SubscribeOptions} describing the subscription window and relay forwarding behavior.
   * @returns Either a {@link RequestError} or `{ requestId, stream }` for consuming objects.
   * @throws : {@link MOQtailError} If the client is destroyed.
   * @throws : {@link ProtocolViolationError} If required fields are missing or inconsistent.
   * @throws : {@link InternalError} On transport/protocol failure (disconnect is triggered before rethrow).
   *
   * @example Subscribe to the latest object and receive future objects as they arrive
   * ```ts
   * const result = await client.subscribe({
   *   fullTrackName,
   *   filterType: FilterType.LatestObject,
   *   forward: true,
   *   groupOrder: GroupOrder.Original,
   *   priority: 32
   * });
   * if (!(result instanceof RequestError)) {
   *   for await (const obj of result.stream) {
   *     // decode and display obj
   *   }
   * }
   * ```
   *
   * @example Subscribe to a future range (waits for those objects to arrive)
   * ```ts
   * const result = await client.subscribe({
   *   fullTrackName,
   *   filterType: FilterType.AbsoluteRange,
   *   startLocation: futureStart,
   *   endGroup: futureEnd,
   *   forward: true,
   *   groupOrder: GroupOrder.Original,
   *   priority: 128
   * });
   * ```
   */
  async subscribe(args: SubscribeOptions): Promise<RequestError | SubscribeResult> {
    this.#ensureActive()
    try {
      let { fullTrackName, priority, groupOrder, forward, filterType, parameters, startLocation, endGroup } = args

      logger.debug(
        'MOQtailClient',
        `subscribe: ftn="${fullTrackName}" filterType=${filterType} priority=${priority} forward=${forward} groupOrder=${groupOrder}`,
      )

      let msg: Subscribe
      if (typeof endGroup === 'number') endGroup = BigInt(endGroup)
      const baseParams: MessageParameter[] = [
        new SubscriberPriority(priority),
        new Forward(forward),
        ...(groupOrder !== GroupOrder.Original ? [new GroupOrderParam(groupOrder)] : []),
        ...(parameters ?? []),
      ]
      switch (filterType) {
        case FilterType.LatestObject:
          msg = Subscribe.newLatestObject(this.#nextClientRequestId, fullTrackName, baseParams)
          break
        case FilterType.NextGroupStart:
          msg = Subscribe.newNextGroupStart(this.#nextClientRequestId, fullTrackName, baseParams)
          break
        case FilterType.AbsoluteStart:
          if (!startLocation)
            throw new ProtocolViolationError(
              'MOQtailClient.subscribe',
              'FilterType.AbsoluteStart must have a start location',
            )
          msg = Subscribe.newAbsoluteStart(this.#nextClientRequestId, fullTrackName, startLocation, baseParams)
          break
        case FilterType.AbsoluteRange:
          if (startLocation === undefined || endGroup === undefined)
            throw new ProtocolViolationError(
              'MOQtailClient.subscribe',
              'FilterType.AbsoluteRange must have a start location and an end group',
            )
          if (endGroup > 0 && startLocation.group >= endGroup)
            throw new ProtocolViolationError('MOQtailClient.subscribe', 'End group must be greater than start group')

          msg = Subscribe.newAbsoluteRange(
            this.#nextClientRequestId,
            fullTrackName,
            startLocation,
            endGroup,
            baseParams,
          )
          break
      }
      const request = new SubscribeRequest(msg)
      request.earlyDiscardPolicy = args.earlyDiscardPolicy
      this.requests.set(request.requestId, request)
      this.requestIdMap.addMapping(request.requestId, request.fullTrackName)

      logger.debug('MOQtailClient', `subscribe: sending SUBSCRIBE requestId=${msg.requestId} ftn="${fullTrackName}"`)
      await this.#openRequestStream(request.requestId, msg)
      logger.debug(
        'MOQtailClient',
        `subscribe: SUBSCRIBE sent, awaiting SUBSCRIBE_OK/REQUEST_ERROR requestId=${msg.requestId}`,
      )

      const response = await request

      if (response instanceof RequestError) {
        logger.error(
          'MOQtailClient',
          `subscribe: SUBSCRIBE_ERROR requestId=${request.requestId} code=${response.errorCode} reason="${response.reasonPhrase.phrase}"`,
        )
        this.requests.delete(request.requestId)
        this.requestIdMap.removeMappingByRequestId(request.requestId)
        return response
      } else {
        logger.debug(
          'MOQtailClient',
          `subscribe: SUBSCRIBE_OK requestId=${request.requestId} trackAlias=${response.trackAlias}`,
        )
        this.claimTrackAlias(response.trackAlias, request)
        return {
          requestId: msg.requestId,
          stream: request.stream,
          largestLocation: MessageParameter.largestLocationOf(response.parameters),
        }
      }
    } catch (error) {
      logger.error(
        'MOQtailClient',
        `subscribe: unexpected error — ${error instanceof Error ? error.message : String(error)}`,
      )
      await this.disconnect(
        new InternalError('MOQtailClient.subscribe', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Stops an active subscription identified by its original SUBSCRIBE `requestId`.
   *
   * Resets the subscription's request stream with `CANCELLED` if it is still active. If the id is unknown or already
   * cleaned up, the call is a silent no-op (hence multiple calls are idempotent).
   *
   * Use this when you no longer want incoming objects for a track (e.g. user navigated away, switching quality).
   * Canceling the consumer stream reader does **not** auto-unsubscribe; call this explicitly for prompt cleanup.
   *
   * @param requestId - The id returned from {@link MOQtailClient.subscribe}.
   * @returns Promise that resolves once the request stream has been reset.
   * @throws :{@link MOQtailError} If the client is destroyed.
   * @throws :{@link InternalError} Wrapped lower-level failure while attempting to send (session will be disconnected first).
   *
   * @remarks
   * - Only targets SUBSCRIBE requests, not fetches. Passing a fetch request id is ignored (no-op).
   * - Safe to call multiple times; extra calls have no effect.
   *
   * @example Subscribe and later unsubscribe
   * ```ts
   * const sub = await client.subscribe({ fullTrackName, filterType: FilterType.LatestObject, forward: true, groupOrder: GroupOrder.Original, priority: 0 });
   * if (!(sub instanceof RequestError)) {
   *   // ...consume objects...
   *   await client.unsubscribe(sub.requestId);
   * }
   * ```
   *
   * @example Idempotent usage
   * ```ts
   * await client.unsubscribe(123n);
   * await client.unsubscribe(123n); // no error
   * ```
   */
  async unsubscribe(requestId: bigint | number): Promise<void> {
    this.#ensureActive()
    if (typeof requestId === 'number') requestId = BigInt(requestId)
    let cleanupData: { requestId: bigint; subscription: SubscribeRequest } | null = null

    try {
      if (this.requests.has(requestId)) {
        const subscription = this.requests.get(requestId)!
        if (subscription instanceof SubscribeRequest) {
          cleanupData = { requestId, subscription }

          // Draft-18 §3.3.2: there is no UNSUBSCRIBE. Resetting the subscription's
          // request stream is what tells the publisher to stop, and the code it reads
          // back off that reset is CANCELLED.
          await this.#resetRequestStream(requestId, StreamResetCode.Cancelled)
          subscription.unsubscribe()
        }
      } else if (
        this.subscriptionAliasMap.has(requestId) ||
        this.pushedRequestStreams.has(requestId) ||
        this.pushedReceivers.has(requestId)
      ) {
        // PUBLISH-originated subscription (unsolicited peer publish, or the
        // post-switch subscription of SWITCH PR #1378). It was never registered in
        // `requests` — the relay pushed it via PUBLISH — but the relay tracks
        // it under this PUBLISH's request id, so an UNSUBSCRIBE frame with
        // that id tears it down relay-side. Locally, close the pushed stream
        // and drop the routing entries (including the pseudo-id ones the
        // PUBLISH handler registered).
        // The alias route may already be released (finishReceiver), while the
        // request stream is still to be reset.
        const trackAlias = this.subscriptionAliasMap.get(requestId)
        // Draft-18 §3.3.2: a pushed PUBLISH is cancelled by resetting the request
        // stream it arrived on; the relay reads CANCELLED off that reset and tears
        // the subscription down under this PUBLISH's request id.
        const pushed = this.pushedRequestStreams.get(requestId)
        if (pushed) {
          this.pushedRequestStreams.delete(requestId)
          await pushed.reset(StreamResetCode.Cancelled)
        }

        // The receiver registered for this PUBLISH (pushedReceivers is keyed by its
        // request id); the alias route is released only if this receiver still owns
        // it (M16: the same track's alias may already belong to a newer receiver).
        const receiver =
          this.pushedReceivers.get(requestId) ??
          (trackAlias !== undefined ? this.subscriptions.get(trackAlias) : undefined)
        try {
          receiver?.controller?.close()
        } catch {
          // Stream already closed/errored — cleanup proceeds regardless.
        }
        this.pushedReceivers.delete(requestId)
        if (receiver) this.releaseTrackAlias(receiver)
        this.subscriptionAliasMap.delete(requestId)
        if (receiver?.pseudoRequestId !== undefined) {
          this.subscriptionAliasMap.delete(receiver.pseudoRequestId)
          this.requestIdMap.removeMappingByRequestId(receiver.pseudoRequestId)
        }
      }
      // Q: Throw? Idempotent?
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.unsubscribe', error instanceof Error ? error.message : String(error)),
      )
      throw error
    } finally {
      if (cleanupData) {
        this.requests.delete(cleanupData.requestId)
        this.releaseTrackAlias(cleanupData.subscription)
        this.requestIdMap.removeMappingByRequestId(cleanupData.requestId)
      }
    }
  }

  /**
   * Narrows or updates an active subscription window and/or relay forwarding behavior.
   *
   * Use this to:
   * - Move the start of the subscription forward (trim history or future window).
   * - Move the end group earlier (shorten the window).
   * - Change relay forwarding (`forward: false` stops forwarding new objects, `true` resumes).
   * - Adjust subscriber priority.
   *
   * Only narrowing is allowed: you cannot move the start earlier or the end group later than the original subscription.
   * Forwarding and priority can be changed at any time.
   *
   * @param args - {@link SubscribeUpdateOptions} referencing the original subscription `requestId` and new bounds.
   * @returns Promise that resolves when the update control frame is sent.
   * @throws :{@link MOQtailError} If the client is destroyed.
   * @throws :{@link ProtocolViolationError} If the update would widen the window (earlier start, later end group, or invalid ordering).
   * @throws :{@link InternalError} On transport/control failure (disconnect is triggered before rethrow).
   *
   * @remarks
   * - Only applies to active SUBSCRIBE requests; ignored if the request is not a subscription.
   * - Omitting a parameter (e.g. `priority`) leaves the previous value unchanged.
   * - Setting `forward: false` stops relay forwarding new objects after the current window drains.
   * - Safe to call multiple times; extra calls with unchanged bounds have no effect.
   *
   * @example Trim start forward
   * ```ts
   * await client.subscribeUpdate({ requestId, startLocation: laterLoc, endGroup, forward: true, priority });
   * ```
   *
   * @example Convert tailing subscription into bounded slice
   * ```ts
   * await client.subscribeUpdate({ requestId, startLocation: origStart, endGroup: cutoffGroup, forward: false, priority });
   * ```
   *
   * @example Lower priority only
   * ```ts
   * await client.subscribeUpdate({ requestId, startLocation: currentStart, endGroup: currentEnd, forward: true, priority: 200 });
   * ```
   */
  async subscribeUpdate(args: SubscribeUpdateOptions): Promise<void> {
    this.#ensureActive()
    let { subscriptionRequestId, priority, forward, parameters, startLocation, endGroup } = args
    if (endGroup && startLocation.group >= endGroup)
      throw new ProtocolViolationError('MOQtailClient.subscribeUpdate', 'End group must be greater than start group')
    try {
      if (this.requests.has(subscriptionRequestId)) {
        const request = this.requests.get(subscriptionRequestId)!
        if (request instanceof SubscribeRequest) {
          const trackAlias = this.subscriptionAliasMap.get(subscriptionRequestId)
          if (!isValidTrackAlias(trackAlias))
            throw new InternalError('MOQtailClient.subscribeUpdate', 'Request exists but track alias mapping does not')
          const subscription = this.subscriptions.get(trackAlias)
          if (!subscription)
            throw new InternalError('MOQtailClient.subscribeUpdate', 'Request exists but subscription does not')
          // TODO: If a parameter included in SUBSCRIBE is not present in SUBSCRIBE_UPDATE, its value remains unchanged.
          // There is no mechanism to remove a parameter from a subscription. We can add parameters but check for duplicate params
          const requestId = this.#nextClientRequestId
          const updateParams: MessageParameter[] = [
            new SubscriberPriority(priority),
            new Forward(forward),
            new SubscriptionFilter(FilterType.AbsoluteRange, startLocation, endGroup),
            ...(parameters ?? []),
          ]
          const msg = new RequestUpdate(requestId, updateParams)
          subscription.update(msg) // This also updates the request since both maps store the same object
          // A REQUEST_UPDATE travels on the stream of the request it updates.
          await this.#requestStreamFor(subscriptionRequestId, 'MOQtailClient.subscribeUpdate').send(msg)
        }
      }
      // Q: Throw? Idempotent?
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.subscribeUpdate', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Switches an active subscription to a different track (SWITCH PR #1378).
   *
   * Use this to change the subscribed track without tearing down and re-establishing a new subscription.
   * The relay answers by opening a PUBLISH for the target track; on success it
   * terminates the replaced subscription (Close-After-Switch), on failure the
   * current subscription is left untouched.
   *
   * @param args - {@link SwitchOptions} referencing the original subscription `requestId` and new track name.
   * @returns Promise resolving with the relay's answer: a {@link SwitchSuccess}
   *   (relay-allocated request id, pushed object stream, and the seam via
   *   SWITCH_TRANSITION) or a {@link SwitchFailure} carrying the PUBLISH_DONE
   *   status code — or a local-timeout {@link SwitchFailure} when no answer
   *   arrives within {@link MOQtailClient.SWITCH_RESPONSE_TIMEOUT_MS}.
   * @throws :{@link MOQtailError} If the client is destroyed.
   * @throws :{@link InternalError} On transport/control failure (disconnect is triggered before rethrow).
   *
   * @remarks
   * - Only applies to active SUBSCRIBE requests; ignored if the request is not a subscription.
   * - Parameters are NOT inherited from the current subscription. Per SWITCH
   *   PR #1378 the SWITCH's parameter set is the COMPLETE parameter set for
   *   the target PUBLISH; omitting {@link SwitchOptions.parameters} sends an
   *   empty set. Restate anything (e.g. auth tokens) the target track needs.
   * - A local-timeout {@link SwitchFailure} (status `Timeout`, no relay
   *   answer) is NOT proof the switch didn't happen: the relay may still
   *   complete it late, in which case it has already terminated the current
   *   subscription and this client quietly declines the late answer. Treat a
   *   Timeout failure as "the source subscription may be gone" and handle a
   *   subsequent PUBLISH_DONE for `subscriptionRequestId` (e.g. by
   *   re-subscribing). See docs/switch-pr1378-conformance.md.
   *
   * @example Switch to a different track
   * ```ts
   * const r = await client.switch({
   *   subscriptionRequestId,
   *   fullTrackName: newTrackName,
   *   minimumSwitchingGroupId: latestReceivedGroupId, // floor: no live-edge sentinel exists
   * });
   * if (r instanceof SwitchFailure) {
   *   // relay could not switch; current subscription is untouched
   * } else {
   *   // adopt the relay-allocated id for the next SWITCH / unsubscribe
   *   currentRequestId = r.requestId;
   *   // r.switchTransition gives the seam: catch-up covers
   *   // [switchingGroupId, liveEdgeGroupId)
   * }
   * ```
   */
  async switch(args: SwitchOptions): Promise<SwitchSuccess | SwitchFailure> {
    this.#ensureActive()
    // minimumSwitchingGroupId is required (no `?? 0n` default): an omitted
    // floor silently requested full buffer replacement — the relay resolves
    // 0n to the OLDEST common boundary — which is the most expensive
    // transition the protocol can express. Callers must state their floor.
    const { fullTrackName, subscriptionRequestId, minimumSwitchingGroupId } = args
    const parameters: MessageParameter[] = args.parameters ?? []
    const key = fullTrackName.toString()

    // Remove exactly this call's resolver from every map it may sit in
    // (other concurrent switches to the same target track keep theirs):
    // the pendingSwitches FIFO while awaiting the PUBLISH, or — when a
    // failure PUBLISH arrived but its PUBLISH_DONE never did (relay crash or
    // session teardown between the two control messages) — the parked entry
    // in pendingSwitchFailures, which nothing else would ever reap.
    let ownResolver: ((result: SwitchSuccess | SwitchFailure) => void) | undefined
    const removeOwnResolver = () => {
      if (!ownResolver) return
      const queue = this.pendingSwitches.get(key)
      if (queue) {
        const i = queue.indexOf(ownResolver)
        if (i !== -1) queue.splice(i, 1)
        if (queue.length === 0) this.pendingSwitches.delete(key)
      }
      for (const [publishRequestId, parked] of this.pendingSwitchFailures) {
        if (parked === ownResolver) {
          this.pendingSwitchFailures.delete(publishRequestId)
          break
        }
      }
    }

    try {
      // Per SWITCH PR #1378 the subscriber allocates no request id and receives no
      // SubscribeOk. The relay acknowledges by opening a PUBLISH carrying
      // SWITCH_TRANSITION for the target track; the PUBLISH handler
      // (handler/publish.ts) resolves this promise with the pushed object
      // stream (success) or, together with handler/publish_done.ts, a
      // SwitchFailure carrying the relay's PUBLISH_DONE status (failure).
      // `subscriptionRequestId` is the relay's Request ID for the subscription
      // being replaced (the relay validates it and tears it down on success —
      // Close-After-Switch; on failure it is left untouched).
      const result = new Promise<SwitchSuccess | SwitchFailure>((resolve) => {
        let settled = false
        // Local response deadline. Required because a pre-validation SWITCH
        // failure (unknown Current Subscribe Request ID) is answered with no
        // PUBLISH at all per the draft, so the promise would otherwise hang.
        // Sized at 2x the relay's DEFAULT_T_SWITCH (3000 ms). A tombstone is
        // recorded so a PUBLISH arriving after the deadline is declined as a
        // late answer rather than treated as an unsolicited SWITCH_TRANSITION
        // (see handler/publish.ts).
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          removeOwnResolver()
          // Sweep expired tombstones (all keys) while adding this one, so
          // tracks that never see another SWITCH or PUBLISH don't accumulate
          // dead entries forever.
          const now = Date.now()
          for (const [trackKey, entries] of this.lateSwitchTombstones) {
            const live = entries.filter((expiry) => expiry > now)
            if (live.length === 0) this.lateSwitchTombstones.delete(trackKey)
            else this.lateSwitchTombstones.set(trackKey, live)
          }
          const tombstones = this.lateSwitchTombstones.get(key) ?? []
          tombstones.push(now + MOQtailClient.SWITCH_TOMBSTONE_TTL_MS)
          this.lateSwitchTombstones.set(key, tombstones)
          resolve(
            new SwitchFailure(
              PublishDoneStatusCode.Timeout,
              `no relay response to SWITCH within ${MOQtailClient.SWITCH_RESPONSE_TIMEOUT_MS} ms`,
            ),
          )
        }, MOQtailClient.SWITCH_RESPONSE_TIMEOUT_MS)
        ownResolver = (r: SwitchSuccess | SwitchFailure) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(r)
        }
        const queue = this.pendingSwitches.get(key) ?? []
        queue.push(ownResolver)
        this.pendingSwitches.set(key, queue)
      })

      // The subscription being replaced is either one this client opened with
      // SUBSCRIBE, or the one the relay opened with the PUBLISH that answered
      // the previous SWITCH (its request id was adopted by the caller). Both
      // are current subscriptions; the second lives on a relay-opened stream.
      const request = this.requests.get(subscriptionRequestId)
      const pushedStream = this.pushedRequestStreams.get(subscriptionRequestId)
      const isSubscribe = request instanceof SubscribeRequest
      const isPushed = pushedStream !== undefined && this.subscriptionAliasMap.has(subscriptionRequestId)
      if (!isSubscribe && !isPushed)
        throw new ProtocolViolationError('MOQtailClient.switch', 'Current Subscribe Request ID is not a subscription')

      const kvpParams = parameters.map((p) => p.toKeyValuePair())
      const msg = new Switch(subscriptionRequestId, fullTrackName, minimumSwitchingGroupId, kvpParams)
      // SWITCH replaces an existing subscription, so it travels on that subscription's
      // request stream (draft-18 §3.3.2): the stream this client opened for its
      // SUBSCRIBE, or the stream the relay opened for its PUBLISH. The relay's
      // answer is a PUBLISH on a new relay-opened request stream, never a
      // message on this one.
      const requestStream = isSubscribe
        ? this.#requestStreamFor(subscriptionRequestId, 'MOQtailClient.switch')
        : pushedStream!
      await requestStream.send(msg)

      return await result
    } catch (error) {
      removeOwnResolver()
      await this.disconnect(
        new InternalError('MOQtailClient.switch', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * One-shot retrieval of a bounded object span, optionally anchored to an existing subscription, returning a stream of {@link MoqtObject}s.
   *
   * Choose a fetch type via `typeAndProps.type`:
   * - Standalone: Historical slice of a specific {@link FullTrackName} independent of active subscriptions.
   * - Relative: Range relative to the JOINING subscription's current (largest) location; use when you want "N groups back" from live.
   * - Absolute: Absolute group/object offsets tied to an existing subscription (stable anchor) even if that subscription keeps forwarding.
   *
   * Field highlights (in {@link FetchOptions}):
   * - priority: 0 (highest) .. 255 (lowest); out-of-range rejected; non-integers rounded by caller expectation.
   * - groupOrder: {@link (GroupOrder:enum).Original} to preserve publisher order; or reorder ascending/descending if supported by server.
   * - typeAndProps: Discriminated union carrying parameters specific to each fetch mode (see examples).
   * - parameters: Optional version-specific extension block.
   *
   * Returns either a {@link RequestError} (refusal / invalid request at protocol level) or `{ requestId, stream }` whose `stream`
   * ends naturally after the bounded range completes (no explicit cancel needed for normal completion).
   *
   * Use cases:
   * - Grab a historical window for scrubbing UI while a separate live subscription tails.
   * - Late joiner fetching a short back-buffer then discarding the stream.
   * - Analytics batch job pulling a fixed slice without subscribing long-term.
   *
   * @throws MOQtailError If client is destroyed.
   * @throws ProtocolViolationError Priority out of [0-255] or missing/invalid joining subscription id for Relative/Absolute.
   * @throws InternalError Transport/control failure (the client disconnects first) then rethrows original error.
   *
   * @remarks
   * - Relative / Absolute require an existing active SUBSCRIBE `joiningRequestId`; if not found a {@link ProtocolViolationError} is thrown.
   * - Result stream is finite; reader close occurs automatically when last object delivered.
   * - Use {@link MOQtailClient.fetchCancel} only for early termination (not yet fully implemented: see TODO in code).
   *
   * @example Standalone window
   * ```ts
   * const r = await client.fetch({
   *   priority: 64,
   *   groupOrder: GroupOrder.Original,
   *   typeAndProps: {
   *     type: FetchType.Standalone,
   *     props: { fullTrackName, startLocation, endLocation }
   *   }
   * })
   * if (!(r instanceof RequestError)) {
   *   for await (const obj of r.stream as any) {
   *     // consume objects then stream ends automatically
   *   }
   * }
   * ```
   *
   * @example Relative to live subscription (e.g. last 5 groups)
   * ```ts
   * const sub = await client.subscribe({ fullTrackName, filterType: FilterType.LatestObject, forward: true, groupOrder: GroupOrder.Original, priority: 0 })
   * if (!(sub instanceof RequestError)) {
   *   const slice = await client.fetch({
   *     priority: 32,
   *     groupOrder: GroupOrder.Original,
   *     typeAndProps: { type: FetchType.Relative, props: { joiningRequestId: sub.requestId, joiningStart: 0n } }
   *   })
   * }
   * ```
   */
  // TODO: figure out how to handle joining fetch types
  // Do we need an existing subscription? What happens if that subscription forwards objects?
  // Will the subscribe objects be pushed through this FetchRequest.controller?
  async fetch(args: FetchOptions): Promise<RequestError | { requestId: bigint; stream: ReadableStream<MoqtObject> }> {
    this.#ensureActive()
    try {
      const { priority, groupOrder, typeAndProps, parameters } = args
      if (priority < 0 || priority > 255)
        throw new ProtocolViolationError(
          'MOQtailClient.fetch',
          `subscriberPriority: ${priority} must be in range of [0-255]`,
        )
      const params: MessageParameter[] = [
        new SubscriberPriority(priority),
        ...(groupOrder !== GroupOrder.Original ? [new GroupOrderParam(groupOrder)] : []),
        ...(parameters ?? []),
      ]
      let msg: Fetch
      let joiningRequest: MOQtailRequest | undefined
      // Generate unique requestId at the beginning to ensure uniqueness
      const requestId = this.#nextClientRequestId
      logger.log(
        'MOQtailClient',
        'fetch: generated requestId:',
        requestId,
        'for fetch type:',
        typeAndProps.type,
        'current #dontUseRequestId:',
        this.#dontUseRequestId,
      )
      switch (typeAndProps.type) {
        case FetchType.Standalone:
          msg = new Fetch(requestId, { type: typeAndProps.type, props: typeAndProps.props }, params)
          break

        case FetchType.Relative:
          joiningRequest = this.requests.get(typeAndProps.props.joiningRequestId)
          if (!(joiningRequest instanceof SubscribeRequest))
            throw new ProtocolViolationError(
              'MOQtailClient.fetch',
              `No subscribe request for the given joiningRequestId: ${typeAndProps.props.joiningRequestId}`,
            )
          // The peer knows the subscription by the id it was last issued under (§10.1).
          msg = new Fetch(
            requestId,
            {
              type: typeAndProps.type,
              props: {
                ...typeAndProps.props,
                joiningRequestId: this.#wireRequestId(typeAndProps.props.joiningRequestId),
              },
            },
            params,
          )
          break
        case FetchType.Absolute:
          joiningRequest = this.requests.get(typeAndProps.props.joiningRequestId)
          if (!(joiningRequest instanceof SubscribeRequest))
            throw new ProtocolViolationError(
              'MOQtailClient.fetch',
              `No subscribe request for the given joiningRequestId: ${typeAndProps.props.joiningRequestId}`,
            )
          msg = new Fetch(
            requestId,
            {
              type: typeAndProps.type,
              props: {
                ...typeAndProps.props,
                joiningRequestId: this.#wireRequestId(typeAndProps.props.joiningRequestId),
              },
            },
            params,
          )
          break
      }
      const request = new FetchRequest(msg)
      logger.log(
        'MOQtailClient',
        'fetch: storing FetchRequest with requestId:',
        msg.requestId,
        'for fetch type:',
        typeAndProps.type,
      )
      logger.log('MOQtailClient', 'fetch: full fetch message:', {
        requestId: msg.requestId,
        fetchType: typeAndProps.type,
        joiningRequestId: typeAndProps.type !== FetchType.Standalone ? typeAndProps.props.joiningRequestId : 'N/A',
      })
      this.requests.set(msg.requestId, request)
      logger.log('MOQtailClient', 'fetch: about to send fetch message to server')
      await this.#openRequestStream(msg.requestId, msg)
      logger.log('MOQtailClient', 'fetch: fetch message sent successfully, waiting for response')
      const response = await request
      if (response instanceof RequestError) {
        this.requests.delete(msg.requestId)
        return response
      } else {
        const stream = request.stream
        return { requestId: msg.requestId, stream }
      }
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.fetch', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Request early termination of an in‑flight FETCH identified by its `requestId`.
   *
   * Use when the consumer no longer needs the remaining objects (user scrubbed away, UI panel closed, replaced by a new fetch).
   * Resets the fetch's request stream with `CANCELLED` if the id currently maps to an active fetch; otherwise silent no-op (idempotent).
   *
   * Parameter semantics:
   * - requestId: bigint returned from {@link MOQtailClient.fetch}. Numbers auto-converted to bigint.
   *
   * Current behavior / limitations:
   * - Data stream closure after cancel is TODO (objects may still arrive briefly).
   * - Unknown / already finished request: ignored without error.
   * - Only targets FETCH requests (not subscriptions).
   *
   * @throws MOQtailError If client is destroyed.
   * @throws InternalError Failure while sending the cancel (client disconnects first).
   *
   * @remarks
   * Follow-up improvement planned: actively close associated readable stream controller immediately upon acknowledgment.
   *
   * @example Cancel shortly after starting
   * ```ts
   * const r = await client.fetch({ priority: 32, groupOrder: GroupOrder.Original, typeAndProps: { type: FetchType.Standalone, props: { fullTrackName, startLocation, endLocation } } })
   * if (!(r instanceof RequestError)) {
   *   // user navigated away
   *   await client.fetchCancel(r.requestId)
   * }
   * ```
   *
   * @example Idempotent double cancel
   * ```ts
   * await client.fetchCancel(456n)
   * await client.fetchCancel(456n) // no error
   * ```
   */
  async fetchCancel(requestId: bigint | number) {
    this.#ensureActive()
    try {
      if (typeof requestId === 'number') requestId = BigInt(requestId)
      const request = this.requests.get(requestId)
      if (request instanceof FetchRequest) {
        // Draft-18 §3.3.2: there is no FETCH_CANCEL. Resetting the fetch's request
        // stream with CANCELLED is the cancellation. The FetchRequest stays in
        // `requests` so the objects already in flight still resolve their track name.
        // TODO: mark the fetch's data streams for closure.
        await this.#resetRequestStream(requestId, StreamResetCode.Cancelled)
      }
      // No matching fetch request, idempotent
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.fetchCancel', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Proactively push a track to the relay/peer.
   */
  async publish(
    fullTrackName: FullTrackName,
    forward: boolean,
    trackAlias: bigint,
    parameters?: MessageParameter[],
    trackProperties?: TrackProperty[],
  ) {
    this.#ensureActive()
    try {
      const requestId = this.#nextClientRequestId

      const msg = new Publish(
        requestId,
        fullTrackName,
        trackAlias,
        [new Forward(forward), ...(parameters ?? [])],
        trackProperties ?? [],
      )

      const request = new PublishRequest(msg)

      // Map the alias and request ID for outgoing data multiplexing
      this.requests.set(msg.requestId, request)
      this.requestIdMap.addMapping(msg.requestId, fullTrackName)
      this.subscriptionAliasMap.set(msg.requestId, trackAlias)

      await this.#openRequestStream(msg.requestId, msg)
      const response = await request

      if (response instanceof RequestError) {
        this.requests.delete(msg.requestId)
        this.requestIdMap.removeMappingByRequestId(msg.requestId)
        this.subscriptionAliasMap.delete(msg.requestId)
        return response
      } else {
        // Return the trackAlias so the application can use client.createDatagramSender(trackAlias)
        // or open uni-streams.
        return { requestId: msg.requestId, trackAlias: trackAlias }
      }
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.publish', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Signals the end of a published track to the peer/relay.
   * * @param publishRequestId - The original requestId used when `publish()` was called.
   */
  async publishDone(publishRequestId: bigint | number, statusCode: number = 0, reasonPhrase: string = 'Track Ended') {
    this.#ensureActive()
    try {
      if (typeof publishRequestId === 'number') publishRequestId = BigInt(publishRequestId)

      // Create the PublishDone message. (StreamCount is set to 0n as a default)
      // It carries no request id: the stream it is sent on names the request it ends.
      const msg = new PublishDone(statusCode, 0n, new ReasonPhrase(reasonPhrase))

      // PUBLISH_DONE is the last message on the PUBLISH request's own stream.
      const requestStream = this.#requestStreams.get(publishRequestId)
      if (requestStream) {
        await requestStream.send(msg)
        await this.#closeRequestStream(publishRequestId)
      } else {
        logger.warn('MOQtailClient', `publishDone: no request stream for requestId=${publishRequestId}`)
      }

      // Clean up local publisher-side state
      this.requests.delete(publishRequestId)
      this.requestIdMap.removeMappingByRequestId(publishRequestId)
      this.subscriptionAliasMap.delete(publishRequestId)
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.publishDone', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Registers an incoming PUBLISH announcement as a valid data receiver.
   * This prepares the client to ingest pushed data streams matching the published alias.
   * * @param msg - The incoming Publish control message
   * @returns - A stream of MoqtObjects being pushed by the publisher
   */
  acceptPushedTrack(msg: Publish): ReadableStream<MoqtObject> {
    this.#ensureActive()

    let streamController!: ReadableStreamDefaultController<MoqtObject>
    const stream = new ReadableStream<MoqtObject>({
      start(c) {
        streamController = c
      },
    })

    // 1. Map the request ID to the full track name so the parser knows what track this is
    this.requestIdMap.addMapping(msg.requestId, msg.fullTrackName)

    // 2. Create a pseudo-subscription object that mimics a SubscribeRequest
    // This perfectly matches the shape #handleRecvStreams expects
    const receiver: PushedReceiver = {
      requestId: msg.requestId,
      fullTrackName: msg.fullTrackName,
      streamsAccepted: 0n,
      streamsEnded: 0n,
      expectedStreams: undefined,
      largestLocation: undefined,
      controller: streamController,
    }

    // 3. Register the receiver in the main routing table using the publisher's alias,
    // and under the PUBLISH's id for the PUBLISH_DONE that completes it.
    this.claimTrackAlias(msg.trackAlias, receiver)
    this.pushedReceivers.set(msg.requestId, receiver)

    return stream
  }

  /**
   * Records that `holder` now owns `trackAlias`: incoming data streams for that alias
   * route to it, and its request id maps to the alias (M16, ported from the pr1674
   * shape). Exposed for the request-stream handlers; applications do not call it.
   */
  claimTrackAlias(trackAlias: bigint, holder: TrackAliasHolder): void {
    this.subscriptions.set(trackAlias, holder)
    this.subscriptionAliasMap.set(holder.requestId, trackAlias)
    this.aliasFullTrackNameMap.set(trackAlias, holder.fullTrackName)
  }

  /**
   * Drops `holder`'s alias route, but only if `holder` still owns the alias. Relay
   * aliases are stable per track, so on A to B to A the second A subscription is
   * handed the alias the first one had; the first one's late completion must leave
   * the second one's route alone (M16).
   */
  releaseTrackAlias(holder: TrackAliasHolder): void {
    const trackAlias = this.subscriptionAliasMap.get(holder.requestId)
    this.subscriptionAliasMap.delete(holder.requestId)
    if (trackAlias === undefined) return
    if (this.subscriptions.get(trackAlias) !== holder) return
    this.subscriptions.delete(trackAlias)
    this.aliasFullTrackNameMap.delete(trackAlias)
  }

  /**
   * Completes a subscription or pushed receiver once PUBLISH_DONE has named its
   * stream count and that many of its data streams have ended (FIN, reset or
   * stopped), with none of the streams routed to it still open: closes its object
   * stream and releases its alias route. Returns whether it completed. Called from
   * the PUBLISH_DONE handler and from the end of each data stream, whichever comes
   * last.
   *
   * Counting ended streams, not accepted ones: PUBLISH_DONE can overtake the tail
   * of a stream that is still delivering (the relay sends it once the last stream
   * is opened and written, not once the subscriber has read it), and closing on
   * the accepted count lost every object that stream still carried. A stream
   * routed after completion finds no route and takes the unrouted path.
   */
  completeIfDone(holder: SubscribeRequest | PushedReceiver): boolean {
    if (holder.expectedStreams === undefined) return false
    if (BigInt(holder.streamsEnded) < BigInt(holder.expectedStreams)) return false
    // No stream routed to it may still be delivering (every accepted stream has
    // ended; a mechanism may route further streams to a receiver, which then
    // hold its completion the same way).
    if (this.#openDataStreams.has(holder)) return false
    try {
      holder.controller?.close()
    } catch {
      // already closed or errored
    }
    this.releaseTrackAlias(holder)
    if (holder instanceof SubscribeRequest) {
      this.requests.delete(holder.requestId)
    } else {
      for (const [publishRequestId, receiver] of this.pushedReceivers) {
        if (receiver === holder) this.pushedReceivers.delete(publishRequestId)
      }
    }
    logger.debug('MOQtailClient', `subscription ${holder.requestId} completed after ${holder.expectedStreams} streams`)
    return true
  }

  /**
   * Asks the peer to stop (STOP_SENDING(CANCELLED)) every data stream routed to the
   * receiver with request id `requestId` that is still open and whose group is at
   * or above `fromGroup` (every open stream when `fromGroup` is omitted). Each one
   * ends with {@link DataStreamEndInfo.end} `stopped`; objects it had already
   * delivered stay on the receiver's object stream. Returns how many it stopped.
   */
  async stopDataStreams(requestId: bigint, fromGroup?: bigint): Promise<number> {
    const stops: Promise<void>[] = []
    for (const [holder, open] of this.#openDataStreams) {
      if (this.#receiverRequestId(holder) !== requestId) continue
      for (const stream of open) {
        if (fromGroup === undefined || stream.groupId >= fromGroup) stops.push(stream.stop())
      }
    }
    await Promise.all(stops)
    return stops.length
  }

  /**
   * Ends the receiver with request id `requestId` (a SUBSCRIBE or a pushed PUBLISH
   * receiver) on the application's word that it has everything it needs: its alias
   * route is released (streams that arrive later take the unrouted path), every
   * stream still open on it is stopped ({@link MOQtailClient.stopDataStreams}), and
   * its object stream is closed, so a reader still gets every object already
   * enqueued and then the end. The request itself stays known, so
   * {@link MOQtailClient.unsubscribe} still cancels it. Returns whether a receiver
   * was found.
   */
  async finishReceiver(requestId: bigint): Promise<boolean> {
    const request = this.requests.get(requestId)
    const holder = request instanceof SubscribeRequest ? request : this.pushedReceivers.get(requestId)
    if (holder === undefined) return false
    this.releaseTrackAlias(holder)
    await this.stopDataStreams(requestId)
    try {
      holder.controller?.close()
    } catch {
      // already closed or errored
    }
    return true
  }

  /**
   * The request id a receiver is addressed by: a pushed receiver's PUBLISH request
   * id (its key in {@link MOQtailClient.pushedReceivers}), otherwise its own.
   */
  #receiverRequestId(holder: TrackAliasHolder): bigint {
    for (const [publishRequestId, receiver] of this.pushedReceivers) {
      if (receiver === holder) return publishRequestId
    }
    return holder.requestId
  }

  // TODO: Each announced track should checked against ongoing subscribe_namespace
  // If matches it should send an announce to that peer automatically
  /**
   * Declare (publish) a track namespace to the peer so subscribers using matching prefixes (via {@link MOQtailClient.subscribeNamespace})
   * can discover and begin subscribing/fetching its tracks.
   *
   * Typical flow (publisher side):
   * 1. Prepare / register one or more {@link Track} objects locally (see {@link MOQtailClient.addOrUpdateTrack}).
   * 2. Call `publishNamespace(namespace)` once per namespace prefix to expose those tracks.
   * 3. Later, call {@link MOQtailClient.unpublishNamespace} when no longer publishing under that namespace.
   *
   * Parameter semantics:
   * - trackNamespace: Tuple representing the namespace prefix (e.g. ["camera","main"]). All tracks whose full names start with this tuple are considered within the announce scope.
   * - parameters: Optional {@link MessageParameters}; omitted =\> default instance.
   *
   * Returns: {@link RequestOk} on success (namespace added to `publishedNamespaces`) or {@link RequestError} explaining refusal.
   *
   * Use cases:
   * - Make a camera or sensor namespace available before any objects are pushed.
   * - Dynamically expose a newly created room / session namespace.
   * - Re-announce after reconnect to repopulate discovery state.
   *
   * @throws MOQtailError If client is destroyed.
   * @throws InternalError Transport/control failure while sending or awaiting response (client disconnects first).
   *
   * @remarks
   * - Duplicate announce detection is TODO (currently a second call will still send another PUBLISH_NAMESPACE; receiver behavior may vary).
   * - Successful announces are tracked in `publishedNamespaces`; manual removal occurs via {@link MOQtailClient.unpublishNamespace}.
   * - Discovery subscribers (those who issued {@link MOQtailClient.subscribeNamespace}) will receive the resulting {@link PublishNamespace} message.
   *
   * @example Minimal announce
   * ```ts
   * const res = await client.publishNamespace(["camera","main"])
   * if (res instanceof RequestOk) {
   *   // ready to publish objects under tracks with this namespace prefix
   * }
   * ```
   *
   * @example PublishNamespace with parameters block
   * ```ts
   * const params = new MessageParameters().setSomeExtensionFlag(true)
   * const resp = await client.publishNamespace(["room","1234"], params)
   * ```
   */
  async publishNamespace(trackNamespace: Tuple, parameters?: MessageParameter[]) {
    this.#ensureActive()
    try {
      // TODO: Check for duplicate announces
      const params: MessageParameter[] = parameters ?? []
      const msg = new PublishNamespace(this.#nextClientRequestId, trackNamespace, params)
      const request = new PublishNamespaceRequest(msg.requestId, msg)
      this.requests.set(msg.requestId, request)
      await this.#openRequestStream(msg.requestId, msg)
      const response = await request

      if (response instanceof RequestOk) {
        this.publishedNamespaces.add(msg.trackNamespace)
        // The stream stays open for as long as the namespace is announced; closing it
        // is what withdraws the announcement (see unpublishNamespace).
        this.#namespaceRequestIds.set(msg.trackNamespace.toUtf8Path(), msg.requestId)
      } else {
        await this.#closeRequestStream(msg.requestId)
      }

      this.requests.delete(msg.requestId)
      return response
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.publishNamespace', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Withdraw a previously announced namespace so new subscribers no longer discover its tracks.
   *
   * Use when shutting down publishing for a logical scope (camera offline, room closed, session ended).
   * Removes the namespace from `publishedNamespaces` locally and closes the stream its PUBLISH_NAMESPACE opened,
   * which is what withdraws the announcement (§3.3.2). This is also how an announce is retracted before the peer
   * has finished processing it.
   *
   * Parameter semantics:
   * - trackNamespace: Exact tuple used during {@link MOQtailClient.publishNamespace}. Must match to be removed from internal set.
   *
   * Behavior:
   * - Does not delete locally registered {@link Track} objects (they remain in `trackSources`).
   * - Does not forcibly end active subscriptions that were already established; peers simply stop discovering it for new ones.
   * - Silent if the namespace was not currently recorded (idempotent style).
   *
   * @throws MOQtailError If client is destroyed before sending.
   * @throws (rethrows original error) Any lower-level failure while sending results in a disconnect (unwrapped TODO: future wrap with InternalError for consistency).
   *
   * @remarks
   * Peers that issued {@link MOQtailClient.subscribeNamespace} for a matching prefix should receive the resulting NAMESPACE_DONE.
   * Consider calling this before {@link MOQtailClient.disconnect} to give consumers prompt notice.
   *
   * @example Basic usage
   * ```ts
   * await client.unpublishNamespace(["camera","main"])
   * ```
   *
   * @example Idempotent
   * ```ts
   * await client.unpublishNamespace(["camera","main"]) // first time
   * await client.unpublishNamespace(["camera","main"]) // no error, already removed
   * ```
   */
  async unpublishNamespace(trackNamespace: Tuple) {
    this.#ensureActive()
    try {
      this.publishedNamespaces.delete(trackNamespace)
      // Draft-18 §3.3.2: there is no PUBLISH_NAMESPACE_DONE. Closing the stream the
      // PUBLISH_NAMESPACE opened withdraws the announcement.
      await this.#closeNamespaceRequestStream(trackNamespace)
    } catch (err) {
      // TODO: Match against error cases
      await this.disconnect()
      throw err
    }
  }

  /**
   * Subscribes to namespace announcements under a prefix (§10.18). Discovery only: the
   * peer answers NAMESPACE and NAMESPACE_DONE for matching namespaces, and nothing is
   * subscribed to. To be sent the tracks themselves, use
   * {@link MOQtailClient.subscribeTracks}.
   */
  async subscribeNamespace(
    trackNamespacePrefix: Tuple,
    parameters?: MessageParameter[],
  ): Promise<{ response: RequestOk | RequestError; cancel: () => Promise<void> }> {
    this.#ensureActive()
    try {
      const params: MessageParameter[] = parameters ?? []
      const msg = new SubscribeNamespace(this.#nextClientRequestId, trackNamespacePrefix, params)

      // No #openRequestStream here: NAMESPACE / NAMESPACE_DONE carry only a suffix, so
      // they are only meaningful next to the prefix that opened this stream. The generic
      // pump has no prefix to hand them, hence the bespoke drain below.
      const requestStream = await RequestStream.open(this.webTransport, msg)
      this.#requestStreams.set(msg.requestId, requestStream)

      logger.log(
        'MOQtailClient',
        'subscribeNamespace | sent msg',
        msg,
        msg.trackNamespacePrefix.toUtf8Path(),
        msg.requestId,
      )

      const response = await requestStream.next()

      if (!response) {
        throw new InternalError('MOQtailClient.subscribeNamespace', 'Stream closed before response')
      }
      if (!(response instanceof RequestOk || response instanceof RequestError)) {
        throw new ProtocolViolationError('MOQtailClient.subscribeNamespace', 'Unexpected response message type')
      }

      logger.log('MOQtailClient', 'subscribeNamespace | got response', response)

      if (response instanceof RequestOk) {
        this.subscribedNamespaces.add(trackNamespacePrefix)
        this.#namespaceRequestIds.set(trackNamespacePrefix.toUtf8Path(), msg.requestId)
        void this.#drainNamespaceStream(requestStream, msg.requestId, trackNamespacePrefix)
      } else {
        await this.#closeRequestStream(msg.requestId)
      }

      return {
        response,
        cancel: async () => {
          this.subscribedNamespaces.delete(trackNamespacePrefix)
          this.#namespaceRequestIds.delete(trackNamespacePrefix.toUtf8Path())
          await this.#closeRequestStream(msg.requestId)
        },
      }
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.subscribeNamespace', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  async subscribeTracks(
    trackNamespacePrefix: Tuple,
    parameters?: MessageParameter[],
  ): Promise<{ response: RequestOk | RequestError; cancel: () => Promise<void> }> {
    this.#ensureActive()
    try {
      const msg = new SubscribeTracks(this.#nextClientRequestId, trackNamespacePrefix, parameters ?? [])
      const requestStream = await RequestStream.open(this.webTransport, msg)
      this.#requestStreams.set(msg.requestId, requestStream)

      const response = await requestStream.next()
      if (!response) {
        throw new InternalError('MOQtailClient.subscribeTracks', 'Stream closed before response')
      }
      if (!(response instanceof RequestOk || response instanceof RequestError)) {
        throw new ProtocolViolationError('MOQtailClient.subscribeTracks', 'Unexpected response message type')
      }

      if (response instanceof RequestOk) {
        this.subscribedTracks.add(trackNamespacePrefix)
        void this.#pumpRequestStream(msg.requestId, requestStream)
      } else {
        await this.#closeRequestStream(msg.requestId)
      }

      return {
        response,
        cancel: async () => {
          this.subscribedTracks.delete(trackNamespacePrefix)
          await this.#closeRequestStream(msg.requestId)
        },
      }
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.subscribeTracks', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  async #drainNamespaceStream(requestStream: RequestStream, requestId: bigint, prefix: Tuple): Promise<void> {
    try {
      while (true) {
        const msg = await requestStream.next()
        if (!msg) break
        if (msg instanceof Namespace && this.onPeerNamespace) {
          this.onPeerNamespace(prefix, msg.trackNamespaceSuffix)
        } else if (msg instanceof NamespaceDone && this.onPeerNamespaceDone) {
          this.onPeerNamespaceDone(prefix, msg.trackNamespaceSuffix)
        }
      }
    } finally {
      this.#requestStreams.delete(requestId)
      this.#namespaceRequestIds.delete(prefix.toUtf8Path())
    }
  }

  /**
   * Ends a prefix subscription started with {@link MOQtailClient.subscribeNamespace}.
   *
   * @param trackNamespacePrefix - The prefix that subscription was opened with.
   */
  async unsubscribeNamespace(trackNamespacePrefix: Tuple) {
    this.#ensureActive()
    try {
      // Draft-18 §3.3.2: there is no UNSUBSCRIBE_NAMESPACE. Closing the stream the
      // SUBSCRIBE_NAMESPACE opened ends the prefix subscription.
      this.subscribedNamespaces.delete(trackNamespacePrefix)
      await this.#closeNamespaceRequestStream(trackNamespacePrefix)
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.unsubscribeNamespace', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Asks the peer for the current status of a track.
   *
   * TRACK_STATUS is the seventh `First`-marked type: it opens its own bidi stream and
   * the REQUEST_OK answering it comes back there, after which the stream is closed.
   *
   * @param fullTrackName - The track to report on.
   * @param trackAlias - Alias to carry in the request.
   * @param parameters - Optional message parameters.
   * @returns A {@link RequestOk} on success or a {@link RequestError} on refusal.
   *
   * @example
   * ```ts
   * const status = await client.trackStatus(fullTrackName, trackAlias)
   * if (!(status instanceof RequestError)) {
   *   // track exists
   * }
   * ```
   */
  async trackStatus(
    fullTrackName: FullTrackName,
    trackAlias: bigint,
    parameters?: MessageParameter[],
  ): Promise<RequestOk | RequestError> {
    this.#ensureActive()
    try {
      const msg = TrackStatus.newLatestObject(
        this.#nextClientRequestId,
        trackAlias,
        fullTrackName,
        128,
        GroupOrder.Original,
        false,
        parameters ?? [],
      )
      const request = new TrackStatusRequest(msg)
      this.requests.set(msg.requestId, request)
      await this.#openRequestStream(msg.requestId, msg)
      const response = await request
      await this.#closeRequestStream(msg.requestId)
      this.requests.delete(msg.requestId)
      return response
    } catch (error) {
      await this.disconnect(
        new InternalError('MOQtailClient.trackStatus', error instanceof Error ? error.message : String(error)),
      )
      throw error
    }
  }

  /**
   * Opens a bidi request stream for `first` and starts reading responses off it.
   *
   * @param requestId - The requestId carried by `first`; the key the stream is filed under.
   */
  async #openRequestStream(requestId: bigint, first: ControlMessage): Promise<RequestStream> {
    const requestStream = await RequestStream.open(this.webTransport, first)
    this.#requestStreams.set(requestId, requestStream)
    void this.#pumpRequestStream(requestId, requestStream)
    return requestStream
  }

  /**
   * Re-issues one request on a fresh stream after the peer sent a GOAWAY on its request
   * stream (§10.4). Only that request moves: the session, and every other request on it,
   * are left alone.
   *
   * The re-issued request consumes a new Request ID (§10.1), so the opening message is
   * re-stamped with it. The id the caller holds keeps naming the request; only the id on
   * the wire changes.
   *
   * @returns True if the request was re-issued here. A GOAWAY naming a new session URI
   * is not: opening a session is the application's call, so it is surfaced through
   * {@link MOQtailClient.onGoaway} and the request stream is closed.
   *
   * @internal
   */
  async migrateRequest(requestId: bigint, goAway: GoAway): Promise<boolean> {
    const oldStream = this.#requestStreams.get(requestId)
    const first = oldStream?.first
    if (!oldStream || !first) {
      logger.warn('MOQtailClient', `GOAWAY on a request stream this side did not open (request id ${requestId})`)
      return false
    }

    if (goAway.newSessionUri) {
      logger.log('MOQtailClient', `GOAWAY migrates request ${requestId} to ${goAway.newSessionUri}`)
      this.onGoaway?.(goAway)
      await this.#closeRequestStream(requestId)
      return false
    }

    // A copy, not the original: the caller still holds that message and its id.
    const wireRequestId = this.#nextClientRequestId
    const reissued = ControlMessage.deserialize(ControlMessage.serialize(first))
    ;(reissued as { requestId: bigint }).requestId = wireRequestId
    this.#wireRequestIds.set(requestId, wireRequestId)
    this.#clientRequestIds.set(wireRequestId, requestId)

    oldStream.migrated = true
    await oldStream.close()
    await this.#openRequestStream(requestId, reissued)
    logger.log('MOQtailClient', `re-issued request ${requestId} as request id ${wireRequestId}`)
    return true
  }

  /** The Request ID `requestId` currently travels under, which a migration has moved on. */
  #wireRequestId(requestId: bigint): bigint {
    return this.#wireRequestIds.get(requestId) ?? requestId
  }

  /** The request a peer-supplied Request ID belongs to, undoing any migration. */
  #clientRequestId(wireRequestId: bigint): bigint {
    return this.#clientRequestIds.get(wireRequestId) ?? wireRequestId
  }

  /**
   * The stream a previously issued request runs on.
   *
   * @throws :{@link InternalError} If the request has no open stream — it was never
   * issued, or it has already completed or been cancelled.
   */
  #requestStreamFor(requestId: bigint, context: string): RequestStream {
    const requestStream = this.#requestStreams.get(requestId)
    if (!requestStream) throw new InternalError(context, `No open request stream for request id ${requestId}`)
    return requestStream
  }

  /**
   * Reads responses and follow-ups off a locally opened request stream until the peer
   * closes it. Each message belongs to this request by virtue of the stream it arrived
   * on, so no request id is consulted to route it.
   */
  async #pumpRequestStream(requestId: bigint, requestStream: RequestStream): Promise<void> {
    // §10.5: the response is the first message on the response stream, so anything
    // arriving here means the request was answered.
    let answered = false
    try {
      while (true) {
        const msg = await requestStream.next()
        if (!msg) break
        const handler = getHandlerForRequestStreamMessage(msg)
        if (!handler) {
          throw new ProtocolViolationError(
            'MOQtailClient',
            `${msg.constructor.name} is not valid on a request stream (request id ${requestId})`,
          )
        }
        await handler(this, msg, requestStream, requestId)
        answered = true
      }
      logger.debug('MOQtailClient', `request stream for requestId=${requestId} closed by peer`)
    } catch (error) {
      logger.error('MOQtailClient', `request stream for requestId=${requestId} failed`, error)
    } finally {
      // A migrated request lives on under the same id on its new stream, so this one
      // ending is not the request ending.
      if (!requestStream.migrated) {
        this.#requestStreams.delete(requestId)
        // A stream that dies before answering leaves the caller awaiting forever.
        if (!answered) {
          this.requests
            .get(requestId)
            ?.reject(new InternalError('MOQtailClient', `Request stream closed before answering request ${requestId}`))
        }
      }
    }
  }

  /** Closes the request stream filed under `requestId`, if it is still open. */
  async #closeRequestStream(requestId: bigint): Promise<void> {
    const requestStream = this.#requestStreams.get(requestId)
    if (!requestStream) return
    this.#requestStreams.delete(requestId)
    await requestStream.close()
  }

  /**
   * Resets the request stream filed under `requestId` with `code`, if it is still open.
   * §3.3.2: this is how draft-18 cancels a request now that the cancel messages are
   * gone — the peer reads the code back off the RESET_STREAM.
   */
  async #resetRequestStream(requestId: bigint, code: StreamResetCode): Promise<void> {
    const requestStream = this.#requestStreams.get(requestId)
    if (!requestStream) return
    this.#requestStreams.delete(requestId)
    await requestStream.reset(code)
  }

  /** Closes the request stream opened for `namespace`, if there is one. */
  async #closeNamespaceRequestStream(namespace: Tuple): Promise<void> {
    const path = namespace.toUtf8Path()
    const requestId = this.#namespaceRequestIds.get(path)
    if (requestId === undefined) return
    this.#namespaceRequestIds.delete(path)
    await this.#closeRequestStream(requestId)
  }

  /**
   * Reads the shared control stream, which after draft-18 §3.3 carries only SETUP and
   * GOAWAY. SETUP is consumed by the handshake, so GOAWAY is all that is handled here;
   * every request type has its own bidi stream.
   */
  async #handleIncomingControlMessages(): Promise<void> {
    this.#ensureActive()
    try {
      const reader = this.controlStream.stream.getReader()
      while (true) {
        const { done, value: msg } = await reader.read()
        if (done) throw new MOQtailError('WebTransport session is terminated')
        const handler = getHandlerForControlMessage(msg)
        if (!handler) {
          // Strictly a PROTOCOL_VIOLATION, but the relay still pushes a few messages
          // here (PUBLISH_DONE, REQUEST_UPDATE fan-out) that draft-18 puts on request
          // streams. Warn rather than tear the session down until that is cleaned up.
          logger.warn(
            'MOQtailClient',
            `${msg.constructor.name} on the control stream; draft-18 allows only SETUP and GOAWAY there`,
          )
          continue
        }
        await handler(this, msg)
      }
    } catch (error) {
      this.disconnect()
      throw error
    }
  }

  async #acceptIncomingUniStreams() {
    this.#ensureActive()
    const reader = this.#incomingUniStreams
    let isDone = false
    while (!isDone) {
      try {
        const { done, value: stream } = await reader.read()
        if (done) {
          isDone = true
          throw new MOQtailError('WebTransport session is terminated')
        }
        // Not awaited -- streams are served concurrently -- so its rejection has to be
        // handled here rather than by the enclosing catch, or it surfaces as an
        // unhandled rejection. A peer reset is an ordinary way for a data stream to
        // end (the subscription was dropped, TooFarBehind, a delivery timeout), so it
        // is reported, not escalated: one stream ending must not stop the accept loop.
        this.#handleRecvStreams(stream).catch((error) => {
          if (error instanceof PeerStreamResetError) {
            logger.debug('MOQtailClient', `data stream ended: ${error.message}`)
            return
          }
          logger.error('MOQtailClient', 'handleRecvStreams error', error)
        })
      } catch (error) {
        logger.error('MOQtailClient', 'acceptIncomingUniStreams error', error)
        if (this.#isDestroyed) break
      }
    }
  }
  #acceptIncomingBiStreams(): void {
    void (async () => {
      const reader = this.webTransport.incomingBidirectionalStreams.getReader()
      while (true) {
        const { value: biStream, done } = await reader.read()
        if (done) break
        void this.#dispatchIncomingRequestStream(new RequestStream(biStream))
      }
    })()
  }

  /**
   * Serves one peer-opened request stream: the first message must be a `First`-marked
   * type, its handler answers on this same stream, and follow-ups are read until the
   * peer closes it. That close is the peer's cancellation, so it tears down whatever
   * the first message started.
   */
  async #dispatchIncomingRequestStream(requestStream: RequestStream): Promise<void> {
    const first = await requestStream.next()
    if (!first) return

    if (!ControlMessageType.isFirst(first.getType())) {
      logger.warn('MOQtailClient', `${first.constructor.name} may not open a request stream; resetting it`)
      await requestStream.reset(StreamResetCode.InternalError)
      return
    }

    // The first message names the request; everything later on this stream belongs to it.
    const openingRequestId = (first as { requestId: bigint }).requestId
    requestStream.openingType = first.getType()

    try {
      let msg: ControlMessage | undefined = first
      while (msg) {
        const handler = getHandlerForRequestStreamMessage(msg)
        if (!handler) {
          throw new ProtocolViolationError(
            'MOQtailClient',
            `No handler for ${msg.constructor.name} on a request stream`,
          )
        }
        await handler(this, msg, requestStream, openingRequestId)
        msg = await requestStream.next()
      }
    } catch (error) {
      logger.error('MOQtailClient', 'incoming request stream failed', error)
    } finally {
      // The peer closed or reset the stream: cancel whatever it was serving. Every
      // First-marked type carries a request id, but the union as a whole does not.
      const requestId = 'requestId' in first ? first.requestId : undefined
      if (requestId !== undefined) {
        this.publications.get(requestId)?.cancel()
        this.publications.delete(requestId)
      }
      await requestStream.close()
    }
  }

  // TODO: Handle request cancellation. Cancel streams are expected to receive some on-fly objects.
  // Do a timeout? Wait for certain amount of objects?
  /**
   * Poll `lookup` until it yields a value or {@link MOQtailClient.trackAliasResolutionTimeoutMs}
   * passes. Used by the data-stream handler to tolerate data streams racing ahead of
   * the control message that installs their routing state (a SUBSCRIBE_OK, or after
   * a SWITCH the relay's PUBLISH: the relay opens the catch-up FETCH_HEADER stream and
   * the target's SUBGROUP streams right after it). Each data stream is handled on its
   * own task, so waiting here blocks nothing else.
   */
  async #waitForDataRoute<T>(lookup: () => T | undefined): Promise<{ value: T } | undefined> {
    const deadline = Date.now() + this.trackAliasResolutionTimeoutMs
    let result = lookup()
    while (result === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      result = lookup()
    }
    // Boxed on purpose: SubscribeRequest is a thenable (it implements
    // PromiseLike so callers can `await` a SUBSCRIBE's response). Returning it
    // bare from an async function makes the await chain adopt it, so the
    // caller would receive the resolved SubscribeOk instead of the routing
    // object it asked for — dropping `controller` and silently discarding
    // every object on the track.
    return result === undefined ? undefined : { value: result }
  }

  async #handleRecvStreams(incomingUniStream: ReadableStream): Promise<void> {
    this.#ensureActive()
    try {
      const recvStream = await RecvStream.new(
        incomingUniStream,
        this.dataStreamTimeoutMs,
        this.onDataReceived,
        (header) => {
          if (!(header instanceof FetchHeader)) return GroupOrder.Original
          const request = this.requests.get(this.#clientRequestId(header.requestId))
          if (!(request instanceof FetchRequest)) return GroupOrder.Original
          return MessageParameter.groupOrderOf(request.message.parameters)
        },
      )
      const header = recvStream.header
      const reader = recvStream.stream.getReader()

      if (header instanceof FetchHeader) {
        // The header names the fetch by the id it was issued under, which a migration
        // may have moved on from.
        const request = this.requests.get(this.#clientRequestId(header.requestId))
        if (request && request instanceof FetchRequest) {
          let fullTrackName: FullTrackName
          switch (request.message.typeAndProps.type) {
            case FetchType.Standalone:
              fullTrackName = request.message.typeAndProps.props.fullTrackName
              break
            case FetchType.Relative:
            case FetchType.Absolute: {
              const joiningSubscription = this.requests.get(request.message.typeAndProps.props.joiningRequestId)
              if (joiningSubscription instanceof SubscribeRequest) {
                fullTrackName = joiningSubscription.fullTrackName
                break
              }
              throw new ProtocolViolationError(
                '_handleRecvStreams',
                'No active subscription for given joining request id',
              )
            }
            default:
              throw new ProtocolViolationError('_handleRecvStreams', 'Unknown fetchType')
          }

          try {
            while (true) {
              const { done, value: nextObject } = await reader.read()
              if (done) {
                // Fetch data stream complete - don't delete request here, FetchOk handler will do it
                request.controller?.close()
                break
              }
              if (nextObject) {
                if (nextObject instanceof FetchObject) {
                  if (nextObject.kind === 'end_of_range') {
                    // Draft-16 §10.4.4.2: End-of-Range markers describe gaps in the
                    // response and do not carry application payloads. Skip for now.
                    continue
                  }
                  // TODO: validate if it's a valid fetch object, asc or desc?
                  const moqtObject = MoqtObject.fromFetchObject(nextObject, fullTrackName)
                  request.controller?.enqueue(moqtObject)
                  continue
                }
                throw new ProtocolViolationError('MOQtailClient', 'Received subgroup object after fetch header')
              }
            }
          } finally {
            reader.releaseLock()
          }
          return
        }

        // Per SWITCH PR #1378 SWITCH catch-up a relay-initiated FETCH_HEADER stream whose
        // request id maps to a peer-published track alias (set up in the PUBLISH
        // handler) rather than a client-issued FetchRequest. Route its objects
        // into that receiver so [G_switch, live_edge) reaches the same stream as
        // the live SUBGROUP objects.
        //
        // The relay opens this stream immediately after queueing the PUBLISH
        // control message, and QUIC gives no ordering between the control
        // stream and data streams — so this FETCH_HEADER can arrive before
        // handlerPublish has installed the route. Wait briefly for it rather
        // than tearing the session down on a benign race.
        const catchupRoute = (
          await this.#waitForDataRoute(() => {
            const alias = this.subscriptionAliasMap.get(header.requestId)
            if (alias === undefined) return undefined
            const receiver = this.subscriptions.get(alias)
            const name = this.aliasFullTrackNameMap.get(alias)
            return receiver && name ? { receiver, name } : undefined
          })
        )?.value
        if (catchupRoute) {
          const { receiver: catchupReceiver, name: catchupName } = catchupRoute
          // R6 D2: the catch-up is one of the receiver's routed streams. It is
          // registered as open, so it holds the receiver's completion, can be
          // stopped (stopDataStreams / finishReceiver) and has its end reported
          // (streamType 'fetch'): the player waits for it before it releases a
          // replaced subscription whose own catch-up still carries groups below
          // the next seam.
          let end: DataStreamEnd = 'reset'
          let stoppedHere = false
          let objectsDelivered = 0
          let firstGroup: bigint | undefined
          let lastSubgroupId: bigint | undefined
          let openStreams = this.#openDataStreams.get(catchupReceiver)
          if (!openStreams) {
            openStreams = new Set()
            this.#openDataStreams.set(catchupReceiver, openStreams)
          }
          const openEntry = {
            groupId: 0n,
            stop: async () => {
              stoppedHere = true
              await recvStream.stopSending(StreamResetCode.Cancelled)
            },
          }
          openStreams.add(openEntry)
          try {
            while (true) {
              const { done, value: nextObject } = await reader.read()
              if (done) {
                end = stoppedHere ? 'stopped' : 'fin'
                break
              }
              if (nextObject instanceof FetchObject) {
                const moqtObject = MoqtObject.fromFetchObject(nextObject, catchupName)
                catchupReceiver.controller?.enqueue(moqtObject)
                objectsDelivered++
                firstGroup ??= moqtObject.location.group
                lastSubgroupId = moqtObject.subgroupId ?? lastSubgroupId
                continue
              }
              throw new ProtocolViolationError('MOQtailClient', 'Received subgroup object after fetch header')
            }
          } catch (error) {
            if (stoppedHere) end = 'stopped'
            throw error
          } finally {
            reader.releaseLock()
            openStreams.delete(openEntry)
            if (openStreams.size === 0 && this.#openDataStreams.get(catchupReceiver) === openStreams) {
              this.#openDataStreams.delete(catchupReceiver)
            }
            try {
              this.onDataStreamEnded?.({
                requestId: this.#receiverRequestId(catchupReceiver),
                streamType: 'fetch',
                trackAlias: this.subscriptionAliasMap.get(header.requestId) ?? 0n,
                groupId: firstGroup ?? 0n,
                subgroupId: lastSubgroupId,
                end,
                objects: objectsDelivered,
                bytes: recvStream.bytesReceived,
              })
            } catch (callbackError) {
              logger.error('MOQtailClient', 'onDataStreamEnded callback failed', callbackError)
            }
            this.completeIfDone(catchupReceiver)
          }
          return
        }

        // Unrouted (P7): no FETCH of this client and no PUBLISH receiver claims this
        // request id (e.g. the catch-up of a switch target the client already
        // released). Like an unrouted subgroup stream (M15), not a protocol
        // violation: stop it and report what it cost.
        await recvStream.stopSending(StreamResetCode.Cancelled)
        reader.releaseLock()
        const fetchInfo: DiscardedStreamInfo = {
          reason: 'unrouted',
          streamType: 'fetch',
          requestId: header.requestId,
          trackAlias: undefined,
          groupId: undefined,
          subgroupId: undefined,
          fullTrackName: undefined,
          bytes: recvStream.bytesReceived,
        }
        logger.warn(
          'MOQtailClient',
          `discarding unrouted fetch stream requestId=${header.requestId} bytes=${fetchInfo.bytes}`,
        )
        this.onStreamDiscarded?.(fetchInfo)
        return
      } else {
        // Same control-vs-data race as the catch-up path above: after a SWITCH
        // the target track's SUBGROUP streams can arrive before the PUBLISH
        // handler registers the subscription for this alias. The pending
        // state-update callbacks are folded into the retried lookup so either
        // path can resolve the route within the wait window.
        const subscription = (
          await this.#waitForDataRoute(() => {
            let sub = this.subscriptions.get(header.trackAlias)
            if (!sub) {
              for (const [subscriptionId, callback] of this.pendingStateUpdates) {
                const matched = callback(header.trackAlias)
                if (matched) {
                  sub = this.subscriptions.get(header.trackAlias)
                  this.pendingStateUpdates.delete(subscriptionId)
                  break
                }
              }
            }
            return sub ?? undefined
          })
        )?.value

        if (subscription) {
          subscription.streamsAccepted++
          let firstObjectId: bigint | null = null
          // How this stream's ingest ends (D1): counted in `streamsEnded` and
          // reported whatever the cause, so a reset stream still lets the
          // subscription complete.
          let end: DataStreamEnd = 'reset'
          let stoppedHere = false
          let objectsDelivered = 0
          let lastSubgroupId: bigint | undefined = header.subgroupId
          let openStreams = this.#openDataStreams.get(subscription)
          if (!openStreams) {
            openStreams = new Set()
            this.#openDataStreams.set(subscription, openStreams)
          }
          const openEntry = {
            groupId: header.groupId,
            stop: async () => {
              stoppedHere = true
              await recvStream.stopSending(StreamResetCode.Cancelled)
            },
          }
          openStreams.add(openEntry)

          let subgroupTimeoutId: ReturnType<typeof setTimeout> | undefined
          const effectiveDiscardPolicy = subscription.earlyDiscardPolicy ?? this.#earlyDiscardPolicy
          if (effectiveDiscardPolicy?.subgroupReceiveTimeout !== undefined) {
            subgroupTimeoutId = setTimeout(() => {
              stoppedHere = true
              reader.cancel(streamResetReason(StreamResetCode.DeliveryTimeout)).catch(() => {})
            }, effectiveDiscardPolicy.subgroupReceiveTimeout)
          }

          try {
            while (true) {
              const { done, value: nextObject } = await reader.read()
              if (done) {
                end = stoppedHere ? 'stopped' : 'fin'
                break
              }
              if (nextObject) {
                if (nextObject instanceof SubgroupObject) {
                  // TODO: validate if it's a valid subgroup object
                  if (!firstObjectId) {
                    firstObjectId = nextObject.objectId
                  }
                  let subgroupId: bigint | null = null
                  if (SubgroupHeaderType.isSubgroupIdZero(header.type)) {
                    subgroupId = 0n
                  } else if (SubgroupHeaderType.isSubgroupIdFirstObjectId(header.type)) {
                    subgroupId = firstObjectId ?? null
                  } else if (SubgroupHeaderType.hasExplicitSubgroupId(header.type)) {
                    subgroupId = header.subgroupId ?? null
                  }

                  const fullTrackName = this.aliasFullTrackNameMap.get(header.trackAlias)
                  if (!fullTrackName) {
                    throw new ProtocolViolationError(
                      'MOQtailClient',
                      `No full track name for received track alias ${header.trackAlias} (groupId=${header.groupId})`,
                    )
                  }

                  const moqtObject = MoqtObject.fromSubgroupObject(
                    nextObject,
                    header.groupId,
                    header.publisherPriority,
                    subgroupId,
                    fullTrackName,
                  )
                  if (!subscription.largestLocation) subscription.largestLocation = moqtObject.location
                  if (subscription.largestLocation.compare(moqtObject.location) == -1)
                    subscription.largestLocation = moqtObject.location

                  subscription.controller?.enqueue(moqtObject)
                  objectsDelivered++
                  if (subgroupId !== null) lastSubgroupId = subgroupId
                  continue
                }
                throw new ProtocolViolationError('MOQtailClient', 'Received fetch object after subgroup header')
              }
            }
          } catch (error) {
            if (stoppedHere) end = 'stopped'
            throw error
          } finally {
            if (subgroupTimeoutId !== undefined) clearTimeout(subgroupTimeoutId)
            openStreams.delete(openEntry)
            if (openStreams.size === 0 && this.#openDataStreams.get(subscription) === openStreams) {
              this.#openDataStreams.delete(subscription)
            }
            subscription.streamsEnded++
            try {
              this.onDataStreamEnded?.({
                requestId: this.#receiverRequestId(subscription),
                streamType: 'subgroup',
                trackAlias: header.trackAlias,
                groupId: header.groupId,
                subgroupId: lastSubgroupId,
                end,
                objects: objectsDelivered,
                bytes: recvStream.bytesReceived,
              })
            } catch (callbackError) {
              logger.error('MOQtailClient', 'onDataStreamEnded callback failed', callbackError)
            }
            // Subscribe Cleanup: the last stream to end completes the subscription,
            // however it ended.
            this.completeIfDone(subscription)
          }
          return
        }

        // Unrouted (M15): nothing claimed this alias in time. Draining the stream to
        // its end would spend link capacity on media nobody will consume and count it
        // nowhere, so tell the peer to stop (STOP_SENDING) and report what it cost.
        // Not a protocol violation: the relay may legitimately still be flushing
        // streams of a subscription this side has just released.
        await recvStream.stopSending(StreamResetCode.Cancelled)
        reader.releaseLock()
        const info: DiscardedStreamInfo = {
          reason: 'unrouted',
          streamType: 'subgroup',
          trackAlias: header.trackAlias,
          groupId: header.groupId,
          subgroupId: header.subgroupId,
          fullTrackName: this.aliasFullTrackNameMap.get(header.trackAlias),
          bytes: recvStream.bytesReceived,
        }
        logger.warn(
          'MOQtailClient',
          `discarding unrouted data stream alias=${info.trackAlias} group=${info.groupId} bytes=${info.bytes}`,
        )
        this.onStreamDiscarded?.(info)
        return
      }
    } catch (error) {
      //this.disconnect()
      throw error
    }
  }
}

if (import.meta.vitest) {
  const { describe, it, expect, afterEach, vi } = import.meta.vitest

  /** One bidirectional stream: what the client wrote, and a way to answer on it. */
  class MockBidiStream {
    readonly sentChunks: Uint8Array[] = []
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    isClosed = false
    /** The reason the client aborted the send side with, if it did. */
    abortReason: unknown
    /** The reason the client cancelled the receive side with, if it did. */
    cancelReason: unknown
    #peer!: ReadableStreamDefaultController<Uint8Array>

    constructor() {
      this.readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.#peer = controller
        },
        cancel: (reason) => {
          this.cancelReason = reason
        },
      })
      this.writable = new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.sentChunks.push(chunk)
        },
        close: () => {
          this.isClosed = true
        },
        abort: (reason) => {
          this.isClosed = true
          this.abortReason = reason
        },
      })
    }

    /** Delivers `msg` to the client on this stream, as the peer would. */
    respond(msg: ControlMessage): void {
      this.#peer.enqueue(ControlMessage.serialize(msg).toUint8Array())
    }

    /** Everything the client has written to this stream so far. */
    get messages(): ControlMessage[] {
      return this.sentChunks.map((chunk) => ControlMessage.deserialize(new FrozenByteBuffer(chunk)))
    }
  }

  class MockWebTransport {
    static last: MockWebTransport
    readonly ready = Promise.resolve()
    readonly closed = new Promise<void>(() => {})
    readonly sentChunks: Uint8Array[] = []
    readonly uniStreamOptions: unknown[] = []
    /** Bidi streams the client opened, in order. */
    readonly biStreams: MockBidiStream[] = []
    readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>
    readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>
    #incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>
    #incomingBi!: ReadableStreamDefaultController<WebTransportBidirectionalStream>

    async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
      const biStream = new MockBidiStream()
      this.biStreams.push(biStream)
      return biStream as unknown as WebTransportBidirectionalStream
    }

    /** Opens a peer-initiated bidi stream, as the relay would for a forwarded request. */
    openIncomingBiStream(): MockBidiStream {
      const biStream = new MockBidiStream()
      this.#incomingBi.enqueue(biStream as unknown as WebTransportBidirectionalStream)
      return biStream
    }

    constructor() {
      this.incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
        start: (controller) => {
          this.#incomingBi = controller
        },
      })
      this.incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
        start: (controller) => {
          this.#incoming = controller
        },
      })
      MockWebTransport.last = this
    }

    async createUnidirectionalStream(options?: unknown): Promise<WritableStream<Uint8Array>> {
      this.uniStreamOptions.push(options)
      return new WritableStream<Uint8Array>({
        write: (chunk) => {
          this.sentChunks.push(chunk)
        },
      })
    }

    /** Reasons the client cancelled peer uni streams with, in order. */
    readonly uniCancelReasons: unknown[] = []

    /**
     * Opens a peer uni stream carrying `bytes`, left open so the reader keeps waiting.
     * The returned controller writes more onto that same stream, which is how a second
     * control message reaches the client after the handshake.
     */
    openIncomingUniStream(bytes: Uint8Array): ReadableStreamDefaultController<Uint8Array> {
      let streamController!: ReadableStreamDefaultController<Uint8Array>
      this.#incoming.enqueue(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            streamController = controller
            controller.enqueue(bytes)
          },
          cancel: (reason) => {
            this.uniCancelReasons.push(reason)
          },
        }),
      )
      return streamController
    }

    close(): void {}
  }

  describe('MOQtailClient control plane', () => {
    const originalWebTransport = globalThis.WebTransport

    afterEach(() => {
      globalThis.WebTransport = originalWebTransport
    })

    function connect(): Promise<MOQtailClient> {
      globalThis.WebTransport = MockWebTransport as unknown as typeof WebTransport
      return MOQtailClient.new({ url: 'https://relay.example/moq' })
    }

    it('handshakes over a pair of uni streams, SETUP first in both directions', async () => {
      const connecting = connect()
      const transport = MockWebTransport.last
      await vi.waitFor(() => expect(transport.sentChunks).toHaveLength(1))

      transport.openIncomingUniStream(new Setup(new SetupOptions().build()).serialize().toUint8Array())
      const client = await connecting

      expect(transport.uniStreamOptions).toEqual([{ sendOrder: Number.MAX_SAFE_INTEGER }])
      expect(ControlMessage.deserialize(new FrozenByteBuffer(transport.sentChunks[0]!))).toBeInstanceOf(Setup)
      await client.disconnect()
    })

    it('rejects a peer control stream that does not begin with SETUP', async () => {
      const connecting = connect()
      const transport = MockWebTransport.last
      await vi.waitFor(() => expect(transport.sentChunks).toHaveLength(1))

      transport.openIncomingUniStream(new GoAway('https://elsewhere.example').serialize().toUint8Array())
      await expect(connecting).rejects.toThrow('Expected setup as the first control message')
    })
  })

  describe('MOQtailClient request streams', () => {
    const originalWebTransport = globalThis.WebTransport
    const ftn = FullTrackName.tryNew('room/alice', 'video')

    afterEach(() => {
      globalThis.WebTransport = originalWebTransport
    })

    /** A connected client whose handshake is already done, plus its peer control stream. */
    async function connected(): Promise<{
      client: MOQtailClient
      transport: MockWebTransport
      control: ReadableStreamDefaultController<Uint8Array>
    }> {
      globalThis.WebTransport = MockWebTransport as unknown as typeof WebTransport
      const connecting = MOQtailClient.new({ url: 'https://relay.example/moq' })
      const transport = MockWebTransport.last
      await vi.waitFor(() => expect(transport.sentChunks).toHaveLength(1))
      const control = transport.openIncomingUniStream(new Setup(new SetupOptions().build()).serialize().toUint8Array())
      return { client: await connecting, transport, control }
    }

    /** Waits for the client to open its n-th bidi stream and write its first message. */
    async function openedStream(transport: MockWebTransport, index: number): Promise<MockBidiStream> {
      await vi.waitFor(() => {
        expect(transport.biStreams.length).toBeGreaterThan(index)
        expect(transport.biStreams[index]!.sentChunks.length).toBeGreaterThan(0)
      })
      return transport.biStreams[index]!
    }

    it('opens a stream per request and answers each on the stream it came from', async () => {
      const { client, transport } = await connected()

      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const subscribeMsg = subscribeStream.messages[0]
      expect(subscribeMsg).toBeInstanceOf(Subscribe)
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      expect(await subscribing).toMatchObject({ requestId: (subscribeMsg as Subscribe).requestId })

      const fetching = client.fetch({
        priority: 0,
        groupOrder: GroupOrder.Original,
        typeAndProps: {
          type: FetchType.Standalone,
          props: { fullTrackName: ftn, startLocation: new Location(0n, 0n), endLocation: new Location(1n, 0n) },
        },
      })
      const fetchStream = await openedStream(transport, 1)
      const fetchMsg = fetchStream.messages[0]
      expect(fetchMsg).toBeInstanceOf(Fetch)
      fetchStream.respond(new FetchOk(false, new Location(1n, 0n), []))
      expect(await fetching).toMatchObject({ requestId: (fetchMsg as Fetch).requestId })

      const publishing = client.publish(ftn, true, 9n)
      const publishStream = await openedStream(transport, 2)
      const publishMsg = publishStream.messages[0]
      expect(publishMsg).toBeInstanceOf(Publish)
      publishStream.respond(new RequestOk())
      expect(await publishing).toMatchObject({ trackAlias: 9n })

      const announcing = client.publishNamespace(Tuple.fromUtf8Path('room/alice'))
      const announceStream = await openedStream(transport, 3)
      const announceMsg = announceStream.messages[0]
      expect(announceMsg).toBeInstanceOf(PublishNamespace)
      announceStream.respond(new RequestOk())
      expect(await announcing).toBeInstanceOf(RequestOk)

      const subscribingNs = client.subscribeNamespace(Tuple.fromUtf8Path('room'))
      const subscribeNsStream = await openedStream(transport, 4)
      const subscribeNsMsg = subscribeNsStream.messages[0]
      expect(subscribeNsMsg).toBeInstanceOf(SubscribeNamespace)
      subscribeNsStream.respond(new RequestOk())
      expect((await subscribingNs).response).toBeInstanceOf(RequestOk)

      const statusing = client.trackStatus(ftn, 11n)
      const statusStream = await openedStream(transport, 5)
      const statusMsg = statusStream.messages[0]
      expect(statusMsg).toBeInstanceOf(TrackStatus)
      statusStream.respond(new RequestOk())
      expect(await statusing).toBeInstanceOf(RequestOk)

      const subscribingTracks = client.subscribeTracks(Tuple.fromUtf8Path('room'))
      const subscribeTracksStream = await openedStream(transport, 6)
      expect(subscribeTracksStream.messages[0]).toBeInstanceOf(SubscribeTracks)
      subscribeTracksStream.respond(new RequestOk())
      expect((await subscribingTracks).response).toBeInstanceOf(RequestOk)

      // All seven First-marked types, one stream each, and the control stream still
      // carries only the SETUP written during the handshake.
      expect(transport.biStreams).toHaveLength(7)
      expect(transport.sentChunks).toHaveLength(1)
      expect(ControlMessage.deserialize(new FrozenByteBuffer(transport.sentChunks[0]!))).toBeInstanceOf(Setup)

      await client.disconnect()
    })

    it('holds one prefix under both SUBSCRIBE_NAMESPACE and SUBSCRIBE_TRACKS', async () => {
      const { client, transport } = await connected()
      const prefix = Tuple.fromUtf8Path('room')

      const subscribingNs = client.subscribeNamespace(prefix)
      const nsStream = await openedStream(transport, 0)
      expect(nsStream.messages[0]).toBeInstanceOf(SubscribeNamespace)
      nsStream.respond(new RequestOk())
      expect((await subscribingNs).response).toBeInstanceOf(RequestOk)

      const subscribingTracks = client.subscribeTracks(prefix)
      const tracksStream = await openedStream(transport, 1)
      expect(tracksStream.messages[0]).toBeInstanceOf(SubscribeTracks)
      tracksStream.respond(new RequestOk())
      expect((await subscribingTracks).response).toBeInstanceOf(RequestOk)

      // Independent overlap spaces (§10.19), so the prefix is tracked twice over.
      expect(client.subscribedNamespaces.has(prefix)).toBe(true)
      expect(client.subscribedTracks.has(prefix)).toBe(true)

      await client.disconnect()
    })

    it('surfaces PUBLISH_BLOCKED on the SUBSCRIBE_TRACKS response stream', async () => {
      const { client, transport } = await connected()
      const prefix = Tuple.fromUtf8Path('room')
      const blocked: { prefix: Tuple; msg: PublishBlocked }[] = []
      client.onPeerPublishBlocked = (subscribedPrefix, msg) => {
        blocked.push({ prefix: subscribedPrefix, msg })
      }

      const subscribingTracks = client.subscribeTracks(prefix)
      const tracksStream = await openedStream(transport, 0)
      tracksStream.respond(new RequestOk())
      expect((await subscribingTracks).response).toBeInstanceOf(RequestOk)

      tracksStream.respond(new PublishBlocked(Tuple.fromUtf8Path('alice'), new TextEncoder().encode('video')))

      await vi.waitFor(() => expect(blocked).toHaveLength(1))
      // The message carries the suffix only; the prefix comes from the stream it
      // arrived on, so the blocked track is room/alice:video.
      expect(blocked[0]!.prefix.equals(prefix)).toBe(true)
      expect(blocked[0]!.msg.trackNamespaceSuffix.toUtf8Path()).toBe('/alice')
      expect(new TextDecoder().decode(blocked[0]!.msg.trackName)).toBe('video')

      await client.disconnect()
    })

    it('surfaces PREFIX_OVERLAP for a second overlapping SUBSCRIBE_TRACKS', async () => {
      const { client, transport } = await connected()

      const first = client.subscribeTracks(Tuple.fromUtf8Path('room'))
      const firstStream = await openedStream(transport, 0)
      firstStream.respond(new RequestOk())
      expect((await first).response).toBeInstanceOf(RequestOk)

      const second = client.subscribeTracks(Tuple.fromUtf8Path('room/alice'))
      const secondStream = await openedStream(transport, 1)
      expect(secondStream.messages[0]).toBeInstanceOf(SubscribeTracks)
      secondStream.respond(new RequestError(RequestErrorCode.PrefixOverlap, 0n, new ReasonPhrase('overlaps')))

      const { response } = await second
      expect(response).toBeInstanceOf(RequestError)
      expect((response as RequestError).errorCode).toBe(RequestErrorCode.PrefixOverlap)
      expect(client.subscribedTracks.size).toBe(1)

      await client.disconnect()
    })

    it('routes two concurrent SUBSCRIBE_OKs by stream, not by request id', async () => {
      const { client, transport } = await connected()
      const otherFtn = FullTrackName.tryNew('room/bob', 'video')

      const subscribingAlice = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const aliceStream = await openedStream(transport, 0)
      const subscribingBob = client.subscribe({
        fullTrackName: otherFtn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const bobStream = await openedStream(transport, 1)

      const aliceId = (aliceStream.messages[0] as Subscribe).requestId
      const bobId = (bobStream.messages[0] as Subscribe).requestId
      expect(aliceId).not.toBe(bobId)

      // Neither SUBSCRIBE_OK carries a request id, and they come back in the opposite
      // order to the requests: only the stream each arrives on can tell them apart.
      bobStream.respond(SubscribeOk.create(8n, [], []))
      aliceStream.respond(SubscribeOk.create(7n, [], []))

      expect(await subscribingAlice).toMatchObject({ requestId: aliceId })
      expect(await subscribingBob).toMatchObject({ requestId: bobId })

      // Each track alias resolved to the subscription that actually asked for it.
      expect(client.subscriptions.get(7n).fullTrackName.toString()).toBe(ftn.toString())
      expect(client.subscriptions.get(8n).fullTrackName.toString()).toBe(otherFtn.toString())
      expect(client.subscriptionAliasMap.get(aliceId)).toBe(7n)
      expect(client.subscriptionAliasMap.get(bobId)).toBe(8n)

      await client.disconnect()
    })

    it('sends REQUEST_UPDATE on the subscription stream and cancels by closing it', async () => {
      const { client, transport } = await connected()

      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const requestId = (subscribeStream.messages[0] as Subscribe).requestId
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      await subscribing

      await client.subscribeUpdate({
        subscriptionRequestId: requestId,
        startLocation: new Location(1n, 0n),
        endGroup: 5n,
        forward: false,
        priority: 200,
      })
      expect(subscribeStream.messages[1]).toBeInstanceOf(RequestUpdate)
      expect(transport.biStreams).toHaveLength(1)

      await client.unsubscribe(requestId)
      // No UNSUBSCRIBE message: closing the stream is the cancellation.
      expect(subscribeStream.messages).toHaveLength(2)
      expect(subscribeStream.isClosed).toBe(true)

      await client.disconnect()
    })

    it('refuses a REQUEST_OK carrying Track Properties outside a TRACK_STATUS_OK', async () => {
      const { client, transport } = await connected()

      const announcing = client.publishNamespace(Tuple.fromUtf8Path('room/alice'))
      const announceStream = await openedStream(transport, 0)
      // §10.5 populates Track Properties in a TRACK_STATUS_OK and nowhere else, so this
      // PUBLISH_NAMESPACE_OK is a protocol violation: the request fails rather than
      // resolving with a namespace the peer never really accepted.
      announceStream.respond(new RequestOk([], [new ObjectDeliveryTimeoutProperty(5000n)]))

      // Without the properties the same exchange resolves; see the request-per-stream
      // test above.
      await expect(announcing).rejects.toThrow()
    })

    it('answers a peer-opened request stream on that stream', async () => {
      const { client, transport } = await connected()

      const incoming = transport.openIncomingBiStream()
      const subscribe = Subscribe.newLatestObject(4n, ftn, [])
      incoming.respond(subscribe)

      // No such track is registered, so the refusal comes back here rather than on the
      // control stream.
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(RequestError)
      expect(transport.sentChunks).toHaveLength(1)

      await client.disconnect()
    })

    it('refuses a REQUEST_UPDATE on a TRACK_STATUS stream', async () => {
      const { client, transport } = await connected()

      const incoming = transport.openIncomingBiStream()
      incoming.respond(TrackStatus.newLatestObject(4n, 11n, ftn, 128, GroupOrder.Original, false, []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(RequestOk)

      // §10.9 dropped TRACK_STATUS from the request types an update may modify.
      incoming.respond(new RequestUpdate(4n, [new SubscriberPriority(200)]))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(2))
      const refusal = incoming.messages[1]
      expect(refusal).toBeInstanceOf(RequestError)
      expect((refusal as RequestError).errorCode).toBe(RequestErrorCode.NotSupported)
      // Refused, not failed: the TRACK_STATUS itself is left alone.
      expect(incoming.isClosed).toBe(false)

      await client.disconnect()
    })

    it('applies a REQUEST_UPDATE on a SUBSCRIBE stream', async () => {
      const { client, transport } = await connected()
      client.addOrUpdateTrack({
        fullTrackName: ftn,
        trackSource: { live: new LiveTrackSource(new ReadableStream<MoqtObject>()) },
        publisherPriority: 0,
        trackAlias: 7n,
      })

      const incoming = transport.openIncomingBiStream()
      incoming.respond(Subscribe.newLatestObject(4n, ftn, []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(SubscribeOk)

      incoming.respond(new RequestUpdate(4n, [new SubscriberPriority(200)]))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(2))
      expect(incoming.messages[1]).toBeInstanceOf(RequestOk)
      expect(client.publications.get(4n)).toBeInstanceOf(SubscribePublication)

      await client.disconnect()
    })

    it('ends a subscription whose REQUEST_UPDATE fails with PUBLISH_DONE(UPDATE_FAILED)', async () => {
      const { client, transport } = await connected()

      const incoming = transport.openIncomingBiStream()
      // No such track, so the SUBSCRIBE is refused and leaves no subscription to update.
      incoming.respond(Subscribe.newLatestObject(4n, ftn, []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(RequestError)

      incoming.respond(new RequestUpdate(4n, [new SubscriberPriority(200)]))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(3))
      expect((incoming.messages[1] as RequestError).errorCode).toBe(RequestErrorCode.NotSupported)
      // §10.9.1: a failed update also terminates the subscription.
      const done = incoming.messages[2]
      expect(done).toBeInstanceOf(PublishDone)
      expect((done as PublishDone).statusCode).toBe(PublishDoneStatusCode.UpdateFailed)

      await client.disconnect()
    })

    it('closes the bidi stream when a namespace request update fails', async () => {
      const { client, transport } = await connected()

      const incoming = transport.openIncomingBiStream()
      incoming.respond(new SubscribeNamespace(4n, Tuple.fromUtf8Path('room'), []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(RequestOk)

      // The client keeps no prefix-subscription state to update, so §10.9.1 ends the
      // request by closing its stream.
      incoming.respond(new RequestUpdate(4n, []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(2))
      expect(incoming.messages[1]).toBeInstanceOf(RequestError)
      await vi.waitFor(() => expect(incoming.isClosed).toBe(true))

      await client.disconnect()
    })

    it('re-issues the one request a GOAWAY migrates and leaves the session up', async () => {
      const { client, transport } = await connected()

      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const requestId = (subscribeStream.messages[0] as Subscribe).requestId

      const subscribingTracks = client.subscribeTracks(Tuple.fromUtf8Path('room'))
      const tracksStream = await openedStream(transport, 1)

      // §10.4: a GOAWAY on a request stream migrates that request and nothing else. No
      // URI, so it is re-issued on this same session.
      subscribeStream.respond(new GoAway(undefined, 250n))

      const reissuedStream = await openedStream(transport, 2)
      const reissued = reissuedStream.messages[0]
      expect(reissued).toBeInstanceOf(Subscribe)
      expect((reissued as Subscribe).fullTrackName.toString()).toBe(ftn.toString())
      // A re-issued request consumes a fresh Request ID (§10.1)...
      expect((reissued as Subscribe).requestId).not.toBe(requestId)
      expect(subscribeStream.isClosed).toBe(true)

      // ...but the caller keeps the id it was handed, and the answer on the new stream
      // completes the call it made.
      reissuedStream.respond(SubscribeOk.create(7n, [], []))
      expect(await subscribing).toMatchObject({ requestId })
      expect(client.subscriptionAliasMap.get(requestId)).toBe(7n)

      // The other request rode through untouched, and the session was never torn down.
      tracksStream.respond(new RequestOk())
      expect((await subscribingTracks).response).toBeInstanceOf(RequestOk)
      expect(transport.biStreams).toHaveLength(3)
      expect(client.goawayReceived).toBe(false)

      await client.disconnect()
    })

    it('closes the session on a second GOAWAY on the control stream', async () => {
      const { client, control } = await connected()
      const seen: GoAway[] = []
      const terminated: unknown[] = []
      client.onGoaway = (msg) => seen.push(msg)
      client.onSessionTerminated = (reason) => terminated.push(reason)

      control.enqueue(new GoAway('https://elsewhere.example', 5000n, 4n).serialize().toUint8Array())
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]!.newSessionUri).toBe('https://elsewhere.example')
      expect(seen[0]!.timeout).toBe(5000n)
      expect(seen[0]!.requestId).toBe(4n)
      expect(client.goawayReceived).toBe(true)

      // §10.4: more than one GOAWAY on the control stream is a protocol violation.
      control.enqueue(new GoAway(undefined, 0n, 6n).serialize().toUint8Array())
      await vi.waitFor(() => expect(terminated).toHaveLength(1))
      expect(seen).toHaveLength(1)
    })

    it('unsubscribes by resetting the SUBSCRIBE stream with CANCELLED', async () => {
      const { client, transport } = await connected()

      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      const subscribed = await subscribing
      expect(subscribed).not.toBeInstanceOf(RequestError)

      await client.unsubscribe((subscribed as { requestId: bigint }).requestId)

      // §3.3.2: UNSUBSCRIBE is gone. Nothing follows the SUBSCRIBE on the wire — the
      // publisher learns the subscription ended from the reset code.
      expect(subscribeStream.messages).toHaveLength(1)
      expect(streamResetCodeOf(subscribeStream.abortReason)).toBe(StreamResetCode.Cancelled)
      expect(streamResetCodeOf(subscribeStream.cancelReason)).toBe(StreamResetCode.Cancelled)

      await client.disconnect()
    })

    it('cancels a fetch by resetting the FETCH stream with CANCELLED', async () => {
      const { client, transport } = await connected()

      const fetching = client.fetch({
        priority: 0,
        groupOrder: GroupOrder.Original,
        typeAndProps: {
          type: FetchType.Standalone,
          props: { fullTrackName: ftn, startLocation: new Location(0n, 0n), endLocation: new Location(1n, 0n) },
        },
      })
      const fetchStream = await openedStream(transport, 0)
      fetchStream.respond(new FetchOk(false, new Location(1n, 0n), []))
      const fetched = await fetching
      expect(fetched).not.toBeInstanceOf(RequestError)

      await client.fetchCancel((fetched as { requestId: bigint }).requestId)

      expect(fetchStream.messages).toHaveLength(1)
      expect(streamResetCodeOf(fetchStream.abortReason)).toBe(StreamResetCode.Cancelled)

      await client.disconnect()
    })

    it('refuses a peer-opened stream that does not begin with a First-marked type', async () => {
      const { client, transport } = await connected()

      const incoming = transport.openIncomingBiStream()
      incoming.respond(new RequestOk())

      await vi.waitFor(() => expect(incoming.isClosed).toBe(true))
      expect(incoming.messages).toHaveLength(0)
      expect(streamResetCodeOf(incoming.abortReason)).toBe(StreamResetCode.InternalError)
      expect(streamResetCodeOf(incoming.cancelReason)).toBe(StreamResetCode.InternalError)

      await client.disconnect()
    })

    /** Wire bytes of one subgroup stream: header plus one object with `payloadBytes` of payload. */
    function subgroupStreamBytes(trackAlias: bigint, groupId: bigint, payloadBytes: number): Uint8Array {
      const header = new SubgroupHeader(
        SubgroupHeaderType.fromProperties(false, 0, false),
        trackAlias,
        groupId,
        0n,
        128,
      )
      const object = SubgroupObject.newWithPayload(0, null, new Uint8Array(payloadBytes))
      const headerBytes = header.serialize().toUint8Array()
      const objectBytes = object.serialize(undefined).toUint8Array()
      const bytes = new Uint8Array(headerBytes.length + objectBytes.length)
      bytes.set(headerBytes)
      bytes.set(objectBytes, headerBytes.length)
      return bytes
    }

    // M15: a stream whose alias has no route used to be drained off the wire and
    // dropped silently; now it is cancelled (STOP_SENDING) and reported with the
    // bytes it cost, so every arm counts discarded media on the same basis.
    it('cancels a data stream for an unrouted alias with STOP_SENDING and reports its bytes (M15)', async () => {
      const { client, transport } = await connected()
      client.trackAliasResolutionTimeoutMs = 20
      const discarded: DiscardedStreamInfo[] = []
      client.onStreamDiscarded = (info) => discarded.push(info)

      const bytes = subgroupStreamBytes(42n, 5n, 100)
      transport.openIncomingUniStream(bytes)

      await vi.waitFor(() => expect(discarded).toHaveLength(1))
      expect(discarded[0]).toMatchObject({ reason: 'unrouted', trackAlias: 42n, groupId: 5n, bytes: bytes.length })
      expect(discarded[0]!.fullTrackName).toBeUndefined()
      await vi.waitFor(() => expect(transport.uniCancelReasons).toHaveLength(1))
      expect(streamResetCodeOf(transport.uniCancelReasons[0])).toBe(StreamResetCode.Cancelled)

      await client.disconnect()
    })

    // R6 D2 (pr1378): the catch-up FETCH_HEADER stream routed to a PUBLISH receiver
    // is one of its routed streams: it holds the receiver's completion while it
    // delivers, and its end is reported (streamType 'fetch').
    it('holds a receiver open while its catch-up delivers and reports the catch-up end (R6 D2)', async () => {
      const { client, transport } = await connected()
      const ends: DataStreamEndInfo[] = []
      client.onDataStreamEnded = (info) => ends.push(info)
      const pushed: ReadableStream<MoqtObject>[] = []
      client.onPeerPublish = (_msg, stream) => pushed.push(stream)
      const incoming = transport.openIncomingBiStream()
      incoming.respond(new Publish(1n, ftn, 9n, [], []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      const reader = pushed[0]!.getReader()

      const header = new FetchHeader(FetchHeaderType.Type0x05, 1n).serialize().toUint8Array()
      const catchUp = transport.openIncomingUniStream(header)
      const first = FetchObject.newObject(4, 0, 0, 128, ObjectForwardingPreference.Subgroup, null, new Uint8Array(8))
      catchUp.enqueue(first.serialize().toUint8Array())
      expect((await reader.read()).value?.location.group).toBe(4n)

      incoming.respond(new PublishDone(PublishDoneStatusCode.SubscriptionEnded, 0n, new ReasonPhrase('switched')))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(client.subscriptions.has(9n)).toBe(true)

      const second = FetchObject.newObject(5, 0, 0, 128, ObjectForwardingPreference.Subgroup, null, new Uint8Array(8))
      catchUp.enqueue(second.serialize(first.toContext()!).toUint8Array())
      catchUp.close()
      expect((await reader.read()).value?.location.group).toBe(5n)
      expect((await reader.read()).done).toBe(true)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ requestId: 1n, streamType: 'fetch', groupId: 4n, end: 'fin', objects: 2 })
      expect(client.subscriptions.has(9n)).toBe(false)
      await client.disconnect()
    })

    // P7 (pr1378): a FETCH_HEADER stream whose request id has no route (no FETCH of
    // this client, no PUBLISH receiver: e.g. the catch-up of a switch whose target
    // the client already released) used to be a ProtocolViolation that closed the
    // session. It is an unrouted stream like any other: STOP_SENDING and a report.
    it('cancels a FETCH_HEADER stream with no route and reports it as unrouted (P7)', async () => {
      const { client, transport } = await connected()
      client.trackAliasResolutionTimeoutMs = 20
      const discarded: DiscardedStreamInfo[] = []
      client.onStreamDiscarded = (info) => discarded.push(info)

      const bytes = new FetchHeader(FetchHeaderType.Type0x05, 99n).serialize().toUint8Array()
      transport.openIncomingUniStream(bytes)

      await vi.waitFor(() => expect(discarded).toHaveLength(1))
      expect(discarded[0]).toMatchObject({
        reason: 'unrouted',
        streamType: 'fetch',
        requestId: 99n,
        trackAlias: undefined,
        groupId: undefined,
        bytes: bytes.length,
      })
      await vi.waitFor(() => expect(transport.uniCancelReasons).toHaveLength(1))
      expect(streamResetCodeOf(transport.uniCancelReasons[0])).toBe(StreamResetCode.Cancelled)
      expect(client.webTransport).toBeDefined()
      await client.disconnect()
    })

    // SWITCH PR #1378 failure discipline (the M16 counterpart on this branch): a
    // refused SWITCH is answered by a relay-opened PUBLISH (Forward 0,
    // SWITCH_TRANSITION {0, 0}) followed by PUBLISH_DONE with the status. The live
    // subscription is left exactly as it was, and a second SWITCH on it works.
    it('keeps the live subscription when the relay refuses a SWITCH (failure PUBLISH)', async () => {
      const { client, transport } = await connected()
      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Original,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const subscribeId = (subscribeStream.messages[0] as Subscribe).requestId
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      await subscribing

      const otherFtn = FullTrackName.tryNew('room/alice', 'video-hi')
      const switching = client.switch({
        fullTrackName: otherFtn,
        subscriptionRequestId: subscribeId,
        minimumSwitchingGroupId: 5n,
      })
      await vi.waitFor(() => expect(subscribeStream.messages).toHaveLength(2))
      expect(subscribeStream.messages[1]).toBeInstanceOf(Switch)
      const failure = transport.openIncomingBiStream()
      failure.respond(new Publish(11n, otherFtn, 8n, [new Forward(false), new SwitchTransition(0n, 0n)], []))
      failure.respond(new PublishDone(PublishDoneStatusCode.Timeout, 0n, new ReasonPhrase('switch: NoCommonBoundary')))
      const refused = await switching
      expect(refused).toBeInstanceOf(SwitchFailure)
      expect((refused as SwitchFailure).statusCode).toBe(PublishDoneStatusCode.Timeout)

      // The subscription is still live under its original id, alias and name ...
      const live = client.requests.get(subscribeId)
      expect(live).toBeInstanceOf(SubscribeRequest)
      expect(client.subscriptions.get(7n)).toBe(live)
      expect(client.subscriptionAliasMap.get(subscribeId)).toBe(7n)
      expect((live as SubscribeRequest).fullTrackName.toString()).toBe(ftn.toString())

      // ... and a second SWITCH on it is still possible and can succeed.
      const switchingAgain = client.switch({
        fullTrackName: otherFtn,
        subscriptionRequestId: subscribeId,
        minimumSwitchingGroupId: 5n,
      })
      await vi.waitFor(() => expect(subscribeStream.messages).toHaveLength(3))
      const success = transport.openIncomingBiStream()
      success.respond(new Publish(13n, otherFtn, 8n, [new Forward(true), new SwitchTransition(6n, 7n)], []))
      const landed = await switchingAgain
      expect(landed).not.toBeInstanceOf(SwitchFailure)
      expect((landed as SwitchSuccess).requestId).toBe(13n)
      expect((landed as SwitchSuccess).switchTransition.switchingGroupId).toBe(6n)
      expect(client.subscriptionAliasMap.get(13n)).toBe(8n)

      await client.disconnect()
    })

    // Transport fairness (C3): the SWITCH carries the subscriber priority and group
    // order on the wire next to the Minimum Switching Group ID; per PR #1378 they are
    // the target PUBLISH's complete parameter set.
    it('sends the SWITCH parameters and the floor on the wire', async () => {
      const { client, transport } = await connected()
      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Ascending,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const subscribe = subscribeStream.messages[0] as Subscribe
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      await subscribing

      const target = FullTrackName.tryNew('room/alice', 'video-hi')
      const switching = client.switch({
        fullTrackName: target,
        subscriptionRequestId: subscribe.requestId,
        minimumSwitchingGroupId: 42n,
        parameters: [new SubscriberPriority(0), new GroupOrderParam(GroupOrder.Ascending)],
      })
      await vi.waitFor(() => expect(subscribeStream.messages).toHaveLength(2))
      const sw = subscribeStream.messages[1] as Switch
      expect(sw.minimumSwitchingGroupId).toBe(42n)
      expect(sw.parameters).toEqual([
        new SubscriberPriority(0).toKeyValuePair(),
        new GroupOrderParam(GroupOrder.Ascending).toKeyValuePair(),
      ])
      const answer = transport.openIncomingBiStream()
      answer.respond(new Publish(21n, target, 8n, [new Forward(true), new SwitchTransition(42n, 43n)], []))
      await switching
      await client.disconnect()
    })

    // M16: relay aliases are stable per track, so A to B to A hands the second A
    // subscription the alias the first one had. The first one's late completion
    // must not delete the route the second one now owns.
    it('releases a track alias only while the releasing holder still owns it (M16)', async () => {
      const { client } = await connected()
      const first = { requestId: 2n, fullTrackName: ftn, streamsAccepted: 0n, largestLocation: undefined }
      const second = { requestId: 4n, fullTrackName: ftn, streamsAccepted: 0n, largestLocation: undefined }

      client.claimTrackAlias(7n, first)
      client.claimTrackAlias(7n, second)
      client.releaseTrackAlias(first)
      expect(client.subscriptions.get(7n)).toBe(second)
      expect(client.aliasFullTrackNameMap.get(7n)?.toString()).toBe(ftn.toString())
      expect(client.subscriptionAliasMap.has(2n)).toBe(false)
      expect(client.subscriptionAliasMap.get(4n)).toBe(7n)

      client.releaseTrackAlias(second)
      expect(client.subscriptions.has(7n)).toBe(false)
      expect(client.aliasFullTrackNameMap.has(7n)).toBe(false)
      expect(client.subscriptionAliasMap.has(4n)).toBe(false)

      await client.disconnect()
    })

    // pr1378 (P1/P5): the player releases a subscription a SWITCH replaced once its
    // PUBLISH_DONE has come, so the callback names the subscription it ends.
    it('passes the request id of the subscription a PUBLISH_DONE ends to onPeerPublishDone', async () => {
      const { client, transport } = await connected()
      const seen: bigint[] = []
      client.onPeerPublishDone = (_msg, requestId) => seen.push(requestId)
      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Ascending,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      const subscribeId = (subscribeStream.messages[0] as Subscribe).requestId
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      await subscribing
      subscribeStream.respond(
        new PublishDone(PublishDoneStatusCode.SubscriptionEnded, 0n, new ReasonPhrase('switched')),
      )
      await vi.waitFor(() => expect(seen).toEqual([subscribeId]))
      await client.disconnect()
    })

    // M16: PUBLISH_DONE for a pushed (relay-initiated PUBLISH) receiver was a no-op,
    // because pushed receivers live outside `requests`. The receiver's stream never
    // closed and its alias route was never released.
    it('completes a pushed receiver on PUBLISH_DONE once all its streams have arrived (M16)', async () => {
      const { client, transport } = await connected()
      const pushed: ReadableStream<MoqtObject>[] = []
      client.onPeerPublish = (_msg, stream) => pushed.push(stream)

      const incoming = transport.openIncomingBiStream()
      incoming.respond(new Publish(1n, ftn, 9n, [], []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      expect(incoming.messages[0]).toBeInstanceOf(RequestOk)
      expect(client.subscriptions.has(9n)).toBe(true)
      expect(pushed).toHaveLength(1)

      const dataStream = transport.openIncomingUniStream(subgroupStreamBytes(9n, 0n, 10))
      const reader = pushed[0]!.getReader()
      const { value } = await reader.read()
      expect(value?.location.group).toBe(0n)
      dataStream.close()
      incoming.respond(new PublishDone(PublishDoneStatusCode.TrackEnded, 1n, new ReasonPhrase('done')))

      const end = await reader.read()
      expect(end.done).toBe(true)
      await vi.waitFor(() => expect(client.subscriptions.has(9n)).toBe(false))
      expect(client.aliasFullTrackNameMap.has(9n)).toBe(false)

      await client.disconnect()
    })

    /**
     * Object `objectId` of a subgroup stream, as the bytes that follow its header:
     * the id is written as the delta to `previousObjectId` (the delta is built by
     * hand because `serialize` treats a previous id of 0 as absent).
     */
    function nextObjectBytes(objectId: number, payloadBytes: number, previousObjectId: bigint): Uint8Array {
      const delta = BigInt(objectId) - previousObjectId - 1n
      return SubgroupObject.newWithPayload(delta, null, new Uint8Array(payloadBytes))
        .serialize(undefined)
        .toUint8Array()
    }

    /** A pushed receiver for alias 9 and its object reader. */
    async function pushedReceiver(transport: MockWebTransport, client: MOQtailClient) {
      const pushed: ReadableStream<MoqtObject>[] = []
      client.onPeerPublish = (_msg, stream) => pushed.push(stream)
      const incoming = transport.openIncomingBiStream()
      incoming.respond(new Publish(1n, ftn, 9n, [], []))
      await vi.waitFor(() => expect(incoming.messages).toHaveLength(1))
      return { incoming, reader: pushed[0]!.getReader() }
    }

    function readWithin(reader: ReadableStreamDefaultReader<MoqtObject>, ms: number) {
      return Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ])
    }

    // D1: PUBLISH_DONE names the stream count once the publisher has opened and
    // written its last stream, so it can overtake the tail of a stream that is still
    // delivering. The receiver used to close as soon as that many streams had been
    // accepted, and the rest of the open stream was lost.
    it('keeps a receiver open while a counted stream is still delivering after PUBLISH_DONE (D1)', async () => {
      const { client, transport } = await connected()
      const { incoming, reader } = await pushedReceiver(transport, client)
      const dataStream = transport.openIncomingUniStream(subgroupStreamBytes(9n, 4n, 10))
      const first = await reader.read()
      expect(first.value?.location.group).toBe(4n)

      incoming.respond(new PublishDone(PublishDoneStatusCode.SubscriptionEnded, 1n, new ReasonPhrase('switched')))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(client.subscriptions.has(9n)).toBe(true)

      dataStream.enqueue(nextObjectBytes(1, 10, 0n))
      const second = await readWithin(reader, 500)
      expect(second).not.toBe('timeout')
      expect((second as ReadableStreamReadResult<MoqtObject>).done).toBe(false)
      expect((second as ReadableStreamReadResult<MoqtObject>).value?.location.object).toBe(1n)

      dataStream.close()
      const end = await readWithin(reader, 500)
      expect((end as ReadableStreamReadResult<MoqtObject>).done).toBe(true)
      await vi.waitFor(() => expect(client.subscriptions.has(9n)).toBe(false))
      await client.disconnect()
    })

    // D1, probe-shaped: the relay sends a probe's PUBLISH_DONE right after
    // SUBSCRIBE_OK, before the probe's data stream has even been seen.
    it('delivers every object of a SUBSCRIBE whose PUBLISH_DONE precedes its stream header (D1)', async () => {
      const { client, transport } = await connected()
      const subscribing = client.subscribe({
        fullTrackName: ftn,
        filterType: FilterType.LatestObject,
        forward: true,
        groupOrder: GroupOrder.Ascending,
        priority: 0,
      })
      const subscribeStream = await openedStream(transport, 0)
      subscribeStream.respond(SubscribeOk.create(7n, [], []))
      const result = await subscribing
      if (result instanceof RequestError) throw new Error('subscribe failed')
      subscribeStream.respond(new PublishDone(PublishDoneStatusCode.TrackEnded, 1n, new ReasonPhrase('probe')))
      await new Promise((resolve) => setTimeout(resolve, 20))

      const dataStream = transport.openIncomingUniStream(subgroupStreamBytes(7n, 3n, 10))
      const reader = result.stream.getReader()
      expect((await reader.read()).value?.location.object).toBe(0n)
      for (let id = 1; id < 4; id++) {
        dataStream.enqueue(nextObjectBytes(id, 10, BigInt(id - 1)))
        const next = await readWithin(reader, 500)
        expect((next as ReadableStreamReadResult<MoqtObject>).value?.location.object).toBe(BigInt(id))
      }
      dataStream.close()
      expect(((await readWithin(reader, 500)) as ReadableStreamReadResult<MoqtObject>).done).toBe(true)
      await client.disconnect()
    })

    // D1: a stream the peer resets has ended too; it must not hold the receiver
    // open forever, and its end is reported as a reset.
    it('counts a reset stream as ended and reports how each stream ended (D1)', async () => {
      const { client, transport } = await connected()
      const ends: DataStreamEndInfo[] = []
      client.onDataStreamEnded = (info) => ends.push(info)
      const { incoming, reader } = await pushedReceiver(transport, client)

      const finished = transport.openIncomingUniStream(subgroupStreamBytes(9n, 4n, 10))
      expect((await reader.read()).value?.location.group).toBe(4n)
      const reset = transport.openIncomingUniStream(subgroupStreamBytes(9n, 5n, 10))
      expect((await reader.read()).value?.location.group).toBe(5n)
      incoming.respond(new PublishDone(PublishDoneStatusCode.SubscriptionEnded, 2n, new ReasonPhrase('switched')))
      finished.enqueue(nextObjectBytes(1, 10, 0n))
      finished.close()
      expect((await reader.read()).value?.location.object).toBe(1n)
      await vi.waitFor(() => expect(ends).toHaveLength(1))
      expect(client.subscriptions.has(9n)).toBe(true)

      reset.error(Object.assign(new Error('reset by peer'), { streamErrorCode: 0x2 }))
      expect(((await readWithin(reader, 500)) as ReadableStreamReadResult<MoqtObject>).done).toBe(true)
      expect(ends.map((e) => [e.requestId, e.groupId, e.subgroupId, e.end, e.objects])).toEqual([
        [1n, 4n, 0n, 'fin', 2],
        [1n, 5n, 0n, 'reset', 1],
      ])
      expect(client.subscriptions.has(9n)).toBe(false)
      await client.disconnect()
    })

    // D1/D2 support: STOP_SENDING the receiver's open streams at or above a group,
    // leaving those below it running.
    it('stops only the open streams at or above a group with stopDataStreams', async () => {
      const { client, transport } = await connected()
      const ends: DataStreamEndInfo[] = []
      client.onDataStreamEnded = (info) => ends.push(info)
      const { reader } = await pushedReceiver(transport, client)
      const below = transport.openIncomingUniStream(subgroupStreamBytes(9n, 4n, 10))
      expect((await reader.read()).value?.location.group).toBe(4n)
      transport.openIncomingUniStream(subgroupStreamBytes(9n, 6n, 10))
      expect((await reader.read()).value?.location.group).toBe(6n)

      expect(await client.stopDataStreams(1n, 5n)).toBe(1)
      await vi.waitFor(() => expect(ends).toHaveLength(1))
      expect(ends[0]).toMatchObject({ groupId: 6n, end: 'stopped' })
      expect(transport.uniCancelReasons).toHaveLength(1)

      below.enqueue(nextObjectBytes(1, 10, 0n))
      expect((await reader.read()).value?.location.object).toBe(1n)
      await client.disconnect()
    })

    // D1/D2 support: the application ends a receiver itself. Objects already
    // enqueued are still read, then the end; open streams are stopped and a stream
    // that arrives later is unrouted.
    it('finishReceiver delivers what is queued, stops open streams and releases the route', async () => {
      const { client, transport } = await connected()
      const ends: DataStreamEndInfo[] = []
      const discarded: DiscardedStreamInfo[] = []
      client.onDataStreamEnded = (info) => ends.push(info)
      client.onStreamDiscarded = (info) => discarded.push(info)
      const { reader } = await pushedReceiver(transport, client)
      const below = transport.openIncomingUniStream(subgroupStreamBytes(9n, 4n, 10))
      below.enqueue(nextObjectBytes(1, 10, 0n))
      below.close()
      transport.openIncomingUniStream(subgroupStreamBytes(9n, 6n, 10))
      await vi.waitFor(() => expect(ends).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(await client.finishReceiver(1n)).toBe(true)
      const groups: bigint[] = []
      for (;;) {
        const next = await readWithin(reader, 500)
        expect(next).not.toBe('timeout')
        const result = next as ReadableStreamReadResult<MoqtObject>
        if (result.done) break
        groups.push(result.value.location.group)
      }
      expect(groups).toEqual([4n, 4n, 6n])
      await vi.waitFor(() => expect(ends).toHaveLength(2))
      expect(ends[1]).toMatchObject({ groupId: 6n, end: 'stopped', streamType: 'subgroup' })
      expect(client.subscriptions.has(9n)).toBe(false)

      transport.openIncomingUniStream(subgroupStreamBytes(9n, 7n, 10))
      await vi.waitFor(() => expect(discarded).toHaveLength(1), { timeout: 2000 })
      await client.disconnect()
    })
  })
}
