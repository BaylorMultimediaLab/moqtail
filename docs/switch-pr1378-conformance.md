# SWITCH (moq-transport PR #1378) — conformance notes

The relay (`apps/relay`) and the TypeScript client (`libs/moqtail-ts`) implement
[SWITCH for Client-side ABR (moq-wg/moq-transport#1378)](https://github.com/moq-wg/moq-transport/pull/1378):
the SWITCH control message (`0x1B`), relay-local switch processing (G_switch
selection, drain-before-PUBLISH, catch-up FETCH_HEADER stream, Close-After-Switch),
the SWITCH_TRANSITION parameter (`0x73`), and the PR's failure discipline.

This file records the places where the implementation deliberately departs from
— or fills gaps in — the letter of the PR text, so reviewers don't rediscover
them as bugs and the rationale survives the people who made the calls.

## Deviation: a late relay answer is declined, not a PROTOCOL_VIOLATION

**Spec text.** "If a PUBLISH contains a SWITCH_TRANSITION parameter but no
pending SWITCH exists for that target Track, the receiver MUST close the
session with PROTOCOL_VIOLATION."

**Why the client has a response deadline the spec doesn't mention.** The PR
defines exactly one SWITCH outcome that produces _no_ PUBLISH at all: the
pre-validation gate (the Current Subscribe Request ID does not identify an
Established subscription — the relay must stay silent). A subscriber therefore
cannot distinguish "my SWITCH was dropped at the gate; no answer will ever
come" from "the answer is still in flight" except by a local deadline.
`MOQtailClient.switch()` resolves as a `SwitchFailure(Timeout)` after
`SWITCH_RESPONSE_TIMEOUT_MS` (6000 ms, 2x the relay's default T_switch of
3000 ms, so a relay operating within its own budget always wins the race).
T_switch is configurable on the relay (`--t-switch-ms`, default 3000);
operators raising it past 3000 must raise the client's
`SWITCH_RESPONSE_TIMEOUT_MS` in step, or the client will time out switches
the relay would still complete — landing in the late-answer path below.

**The deviation.** A relay answer that arrives _after_ that local deadline is,
from the spec's viewpoint, still answering a pending SWITCH (the spec has no
client-timeout concept); from the client's bookkeeping, no pending SWITCH
exists any more. Read literally, the spec's sentence would require closing the
session — punishing a relay that behaved correctly, and tearing down every
other subscription on the session, because of network delay. Instead, the
client records a **tombstone** per timed-out SWITCH (keyed by target track,
TTL `SWITCH_TOMBSTONE_TTL_MS` = 30 s) and treats a SWITCH*TRANSITION PUBLISH
that matches a live tombstone as a \_late* answer, not an _unsolicited_ one
(`libs/moqtail-ts/src/client/handler/publish.ts`):

- **Late failure PUBLISH** (Forward State 0): dropped; the trailing
  PUBLISH_DONE resolves to a no-op. Nothing was established on either side.
- **Late success PUBLISH**: receiver routing is registered first — the relay
  has already opened the catch-up FETCH_HEADER stream and the target's
  SUBGROUP streams, and failing their route lookup would itself escalate to a
  protocol violation — then the track is unsubscribed after the route-wait
  window (`LATE_SWITCH_UNSUBSCRIBE_DELAY_MS`). The pushed stream is never
  exposed to the application.

A SWITCH_TRANSITION PUBLISH with **no** live tombstone remains a
PROTOCOL_VIOLATION exactly as the spec requires: liberal acceptance is
deferred by the TTL, never disabled.

**Consequence applications must know (late success).** The relay _completed_
the switch: Close-After-Switch already terminated the current subscription on
the relay side. The application, however, was told the switch failed
(`SwitchFailure` with status `Timeout`) and kept its current-subscription
state — state that now refers to a torn-down track. It learns the truth only
when the old request id's PUBLISH_DONE(`SUBSCRIPTION_ENDED`) arrives.
Applications should therefore treat a `Timeout` SwitchFailure as "the source
subscription may be gone" and handle a subsequent PUBLISH_DONE for the old
request id (e.g. by re-subscribing) rather than assuming the pre-switch world
is intact.

## Minor notes (gap-filling, not conflicts)

- **Failure PUBLISH carries SWITCH_TRANSITION `{0, 0}`.** The spec requires
  SWITCH*TRANSITION in "a PUBLISH opened by a Relay in response to a SWITCH
  message" and the failure PUBLISH is such a PUBLISH — but no seam was
  selected, so the relay sends placeholder zeros. The parameter's \_presence*
  is what lets the subscriber classify the PUBLISH as switch-related; the
  outcome is keyed off the immediately following PUBLISH_DONE status code,
  never off these values.
- **Group-availability granularity.** The spec counts a group available "as
  soon as [the relay] has received sufficient bytes to parse an Object header
  identifying GroupID g"; the relay's cache marks a group available at its
  first fully ingested object. Availability is thus recognized strictly no
  earlier than the spec allows, never wrongly.
- **T_switch reclamation.** The spec caps a Current Subscribe Request ID at
  one in-flight SWITCH but does not say when the slot frees if a switch
  wedges. The relay self-expires the in-flight guard at `T_switch`
  (`apps/relay/src/server/switch_guard.rs`); a superseded task answers with
  the draft's TIMEOUT and provably never touches the source subscription
  (generation-token ownership).

## Draft-18 port notes

The implementation now runs on moqtail's draft-18 request-stream model
(upstream `main`, base/2026-09-03). What changed relative to the draft-14
implementation this document originally described:

- **SWITCH travels on the request stream of the subscription it replaces**
  (there is no shared control stream for requests any more). It is not a
  `First` message and never opens a stream of its own.
- **The relay's answer is a relay-opened PUBLISH request stream.** The target
  PUBLISH carries `FORWARD = 1`, `LARGEST_OBJECT = (live edge, 0)` and
  `SWITCH_TRANSITION`; the subscriber accepts it with REQUEST_OK on that
  stream. The subscription's eventual PUBLISH_DONE goes out on the same
  stream, and the subscriber cancels the pushed subscription by resetting it
  (`MOQtailClient.unsubscribe(publishRequestId)`).
- **A failure PUBLISH carries `FORWARD = 0`** (draft-18 PUBLISH has no
  `content_exists` field) plus the placeholder `SWITCH_TRANSITION {0, 0}`,
  immediately followed by PUBLISH_DONE with the status on the same stream.
- **PUBLISH_DONE(SUBSCRIPTION_ENDED) for the replaced subscription** goes out on
  that subscription's own request stream (Close-After-Switch).
- **Status codes.** `EXCESSIVE_LOAD` reuses draft-18's own code (0x9);
  `TIMEOUT` (0xA), `DOES_NOT_EXIST` (0xB) and `NOT_SUPPORTED` (0xC) are
  project-local codepoints draft-18 leaves unused.
- **SWITCH_TRANSITION is a typed message parameter** (`0x73`, odd, bytes-valued)
  in both libraries; draft-18 rejects unknown parameter types at parse time, so
  it can no longer be a raw key-value pair.
- **Cancel race.** Draft-18 has no UNSUBSCRIBE message; the abandon rule fires
  when the subscriber closes or resets the current subscription's request
  stream (`cancel_subscription`).
- **Not ported:** the relay-chaining upstream link (`--upstream-url`), the lazy
  upstream establishment of an unknown switch target and its backfill FETCH,
  and the draft-14 `tests/switch_e2e.rs` harness. A target track this relay does
  not carry is answered with DOES_NOT_EXIST.

## Experiment knobs and events on this branch

- The player's `switchFloor` option (URL `?switchFloor=next-group|playhead`,
  Settings panel "Switch Floor") chooses the SWITCH's Minimum Switching Group
  ID: `next-group` names the boundary after the latest group the client holds,
  `1 + max(last received group, highest group completely present in a buffered
range ahead of the playhead)`, so the switch lands as close to live as
  possible without re-requesting media the element already has. Until
  2026-10-02 it used the last received group alone (buffer-unaware
  minimum-switching-group selection): after a catch-up had filled the element
  further ahead than the current subscription had delivered, the floor pointed
  behind the playhead, the relay re-delivered buffered groups, and the link was
  spent behind the playhead (a 9.4 s freeze on the fresh grid). The
  `SWITCH_FLOOR` event records both candidate floors and the selection on
  every switch. `playhead` names the group the
  player is currently showing (a time-shifted client switches at the point it
  is watching and re-fetches the buffered groups on the new track). The
  default is `next-group`. The chosen floor is recorded in the client's
  `SWITCH_SENT` event as `minimum_switching_group`, and `RUN_META` carries
  `switch_floor`.
- Relay events specific to this mechanism: `SWITCH_RECV` carries
  `minimum_switching_group`; `SWITCH_PROMOTED` is emitted when the target
  PUBLISH opens, with `start_group` = G_switch and the target's live edge;
  `SWITCH_FAILED` carries the failure kind and status code. The shared record
  schema is in `docs/measurement-schema.md`.

## Rebuild changes (2026-10-04, audit C3, M5, M6)

Each entry names the behaviour as it is now; the audit ids are in the commit
messages.

- **Attach before terminate (P4).** Once the publish claim is won the relay
  attaches the target subscription first (it forwards nothing until its
  PUBLISH is out: `mark_alias_announced`), then bounds the source at
  `G_switch - 1`, sends PUBLISH_DONE(SUBSCRIPTION_ENDED) on the source's
  request stream and ends it (Close-After-Switch:
  `switch_delivery::hand_over_to_target`). A target that cannot be attached
  (the connection already holds a subscription on it, which includes a SWITCH
  to the current track) is answered with the PublishBuildFailed failure PUBLISH
  and the source is untouched, as the PR's failure discipline requires. The
  former undo path (restoring the source's end group after it had already been
  torn down) is gone.
- **Catch-up priority and the switch's scheduling parameters (P3).** The
  catch-up FETCH_HEADER stream is scheduled like any FETCH response stream:
  `compute_stream_priority(subscriber priority, publisher priority of the
target's group G_switch, group order, G_switch)`. With ascending order that
  is above every live group of the target (the PR's SHOULD) and below the
  replaced subscription's streams of groups < G_switch, which play first (it
  used to take the top of the publisher-0 band, above that remainder). The
  subscriber priority and group order come from the SWITCH's
  SUBSCRIBER_PRIORITY / GROUP_ORDER parameters; a SWITCH that omits them runs
  at the replaced subscription's values, which the relay also writes into the
  target PUBLISH's parameters. **Deviation, deliberate:** the PR says nothing
  is inherited; the two scheduling fields are, so a parameterless SWITCH
  cannot drop the target below the source's band (audit C3). The player sends
  both on every SWITCH, so in the experiments nothing is actually inherited.
  The failure PUBLISH's request stream opens at `CONTROL_STREAM_PRIORITY`
  before its first byte, like every request stream the relay opens.
- **SWITCH_WAIT and distinguishable failures (P6).** When G_switch selection
  first misses (the floor names a group the target has not produced, or no
  common gap-free boundary exists yet) the relay emits `SWITCH_WAIT {floor,
live_edge_current, live_edge_target, waiting_for}` once per switch, so a
  T_switch wait is visible before its TIMEOUT. NoCommonBoundary, DrainTimeout
  and Superseded all answer with status TIMEOUT (0xA); the player's
  `SWITCH_ERROR.failure` names which, from the relay's reason phrase
  (`switch: <kind>`), and `ClientTimeout` marks the library's own response
  deadline (no relay answer at all).
- **The replaced subscription is read until it is done (P1, audit M5; review
  R6 D1-D3).** The PR has the relay deliver every current-track object below
  G_switch before PUBLISH_DONE(SUBSCRIPTION_ENDED); the player used to stop
  reading the old subscription at SWITCH_OK, so those objects crossed the link
  and were never used. The player now queues the target PUBLISH's stream behind
  the old one (`apps/client-js/src/lib/switchSources.ts`) and keeps feeding the
  old one to the write handler until it is done, structurally:

  > Done(S) ⇔ PUBLISH_DONE(S) received ∧ G_switch known (SWITCH_OK) ∧ B of S's
  > data streams below G_switch have ended (FIN or reset) ∧ S's own catch-up
  > stream (if S was itself a switch target with one) has ended or has reached
  > G_switch.

  _Catch-up of a replaced target (review R7 D1)._ The catch-up is delivered in
  ascending group order, so its first object of a group >= G_switch proves that
  everything below the seam it carries has been delivered. The library reports
  each group a catch-up reaches (`onCatchUpProgress`, after the object is
  queued) and keeps the catch-up's open-stream entry at the group being
  delivered (it was fixed at 0), so `stopDataStreams(S, G_switch)` and
  `finishReceiver` cut a catch-up that has passed the seam. Waiting for the
  catch-up's end used to hold the release for the whole catch-up, the span at or
  above the seam (dropped anyway) included: up to ~2 s, released as
  `drain-timeout`. The relay ends it at the source too: when a switch target is
  itself replaced (`terminate_source`), its catch-up, if still delivering, stops
  before the new G_switch and FINs (`switch_delivery::bound_switch_catchup`). It
  is not reset: its objects below the new seam play before it. The released
  route records `catch_up_reached_group` on `SWITCH_SOURCE_RELEASED`.

  B comes from the relay (the project-local SWITCH_TRANSITION field below).
  Ended streams are a subset of the seen ones, which are a subset of the B the
  relay opened, so "B ended" means every below-seam stream was seen and ended.
  The library reports each routed stream's end (`onDataStreamEnded`) after its
  last object is queued; on Done the player calls `finishReceiver`, which stops
  (STOP_SENDING) S's streams still open (at or above the seam), releases its
  alias route (late streams take the unrouted path, `DROP_STALE{unrouted}`) and
  closes S's object stream after the objects already queued, so nothing below
  the seam is lost; S is then released as `drained` and unsubscribed. The switch
  therefore lands right after the old track's tail, in play order. Fallbacks:
  `drain-timeout`, when B is absent (a relay without the field) or Done is not
  reached (a below-seam stream reset upstream before its header never shows
  up), 2 s after the later of PUBLISH_DONE, SWITCH_OK and the last below-seam
  object or stream end; `cap`, 6 s after SWITCH_OK without a PUBLISH_DONE. A
  PUBLISH_DONE before SWITCH_OK waits for it; B = 0 is done at PUBLISH_DONE. A
  route whose stream ends while the SWITCH replacing it is still unanswered
  (common at the live edge: the library completes it at its PUBLISH_DONE, which
  precedes the target PUBLISH) is reported as `closed-before-ok` with that
  switch's seq. Failed, late-success and superseded switches never set G_switch
  on a route and keep their release paths. This replaced a 300 ms quiet period
  after PUBLISH_DONE, which delayed about 40 % of time-shifted landings by
  150-250 ms (and with them the controller's guard release) and could release
  before a below-seam tail held up by loss. `SWITCH_SOURCE_RELEASED` records
  each release with its reason and B. `onPeerPublishDone` names the request id
  of the subscription the PUBLISH_DONE ends.

  The library completes a receiver on its own once PUBLISH_DONE's Stream Count
  of its streams have **ended** and none routed to it is still open (D1: it used
  to count accepted streams, and a PUBLISH_DONE that overtook the tail of a
  still-open stream closed the receiver and lost the tail; probes were exposed
  too, the relay sends a probe's PUBLISH_DONE right after SUBSCRIBE_OK). For a
  replaced subscription that is often never reached, which is why Done above
  uses B, not the Stream Count.

- **Old-track objects at or above G_switch are dropped once it is known (P2,
  audit M6; review R6 D5, R7 D2).** From SWITCH_OK (which carries
  SWITCH_TRANSITION) the write handler drops every object of the replaced
  subscription whose group is at or above G_switch as
  `DROP_STALE{reason: post-seam}`: the target's catch-up delivers that span on
  the new track, and appending both put two representations in one span of the
  SourceBuffer. Before SWITCH_OK only the floor the player sent is known
  (G_switch is at or above the floor; the source keeps forwarding while
  selection waits and is bounded at the seam only at the hand-over), so objects
  of the replaced route at or above the floor are held, in arrival order, until
  the answer: SWITCH_OK appends those below G_switch and drops the rest
  (`DROP_STALE{post-seam, held: true}`); a failure or refusal appends them all.
  The hold ends exactly when the switch resolves; the library resolves every
  switch within its response deadline (`SWITCH_RESPONSE_TIMEOUT_MS`, 6 s, a
  `ClientTimeout` failure), which is therefore the hold's time bound (R7 D2:
  it had a 3 s bound from SWITCH_SENT, but a success can arrive up to T_switch
  after the relay's own admission plus a round trip; the bound then appended
  everything held, the post-seam duplicate included, as `bound-time`). Its
  only other bound is 4 MiB; a tripped bound appends everything held and is
  logged. `SWITCH_HOLD_RELEASED` records each hold that held something, and the
  analyzer counts them by outcome (`switches.hold_released`, with
  `bound_trips`). (Until R6 these objects were appended, 1-3 frames in
  practice, biasing `media_seam_gap_ms` by -42..-125 ms.)
- **PUBLISH_DONE for the replaced subscription (P5, audit M6).** The player
  handles every PUBLISH_DONE on a video subscription (`handlePublishDone`):
  for the subscription a SWITCH replaces it starts that route's release (P1)
  and it is logged as `PUBLISH_DONE_RECV`. The relay sends Close-After-Switch
  before it opens the target PUBLISH, so it normally arrives while the switch
  is still pending (`role: current`, `switch_in_flight: true`). A PUBLISH_DONE
  for the current subscription with no switch pending (the late-success case
  above, or the track ending) is logged with a warning; the player does not
  re-subscribe.
- **Unrouted catch-up streams (P7, library).** A FETCH_HEADER stream whose
  request id names no FETCH of this client and no PUBLISH receiver (after the
  route-wait window) used to be a PROTOCOL_VIOLATION that closed the session.
  It now takes the unrouted path like a SUBGROUP stream: STOP_SENDING(CANCELLED)
  and a discard report (`streamType: 'fetch'`, `requestId`), logged by the
  player as `DROP_STALE{unrouted, stream_type: fetch}`. This is the catch-up of
  a switch whose target the client has already released (e.g. the late-success
  path, or a target superseded before its catch-up arrived).
- **Runner (P8).** `--mechanism pr1378 --mechanism-mode next-group|playhead`
  passes `--t-switch-ms 3000`, `--congestion-controller` and `--udp-gso off`
  (never the native-fix flags), selects the floor with `?switchFloor=`, and
  refuses a run whose RELAY_CONFIG does not report `t_switch_ms` = 3000 (or
  reports a native-fix field true).
- **Records the analysis reads (P9).** `SWITCH_PROMOTED` carries `promoted_ts`
  (epoch ms of the promotion decision, here the instant the target PUBLISH is
  opened; the same meaning as on the native arms), so `relay_promoted_ms` is
  computed alike on every arm. The analyzer joins pr1378's switches by
  `switch_seq` (SWITCH_FLOOR included; `SWITCH_SENT.request_id` is null),
  takes G_switch from SWITCH_OK's `switching_group` (older bundles: the
  relay's `SWITCH_PROMOTED.start_group`), joins the relay's `SWITCH_WAIT` by
  the replaced subscription's request id, and summarises the floor
  (`switches.floor`), failures by kind (`switches.failures`) and the data
  routes (`switch_routes`).

## Review R6 notes (2026-10-04)

- **Deviation, deliberate: a project-local third SWITCH_TRANSITION field.** The
  PR's SWITCH_TRANSITION value is `{Switching Group ID (i), Live Edge Group ID
(i)}`. This relay appends `Below-Seam Streams (i)` (B): the number of SUBGROUP
  data streams it opened on the replaced subscription for Groups below G_switch,
  finished, reset and open ones alike, read at the hand-over once the source is
  ended (`Subscription::opened_streams_below`, a per-group open counter that is
  kept for the subscription's lifetime; `send_stream_last_object_ids` forgets a
  stream once it ends). A stream is counted when its open begins, under the
  send-stream map's lock with the subscription's `finished` flag checked, and
  none is opened once it has finished (review R7 D3): an open that was already
  waiting (e.g. for stream credit) when the source ended completes afterwards,
  and is then FIN'd if its group is within the seam bound or reset beyond it,
  never left open (the shared half of the fix); it is in B because it was
  counted before B was read. It used to be counted when its open returned, so a
  below-seam stream the subscriber sees could be missing from B, and the
  player's done condition could hold while a counted stream was still
  delivering. An open that fails after it was counted leaves B one too high:
  the player then waits and falls back to `drain-timeout`, it never cuts.
  Encoding: the varints back to back in the bytes-valued
  parameter `0x73`; a two-varint value (the PR's form, and this project's before
  R6) still decodes in both libraries, with B absent, and the player then falls
  back to `drain-timeout`; anything after the third varint is malformed. A
  malformed value (fewer than two varints, trailing bytes, not bytes-valued) is
  a PROTOCOL_VIOLATION in both libraries (review R7 D4: the TypeScript library
  used to drop the parameter, so the switch's PUBLISH looked like an ordinary
  peer publish and the SWITCH hung to its response deadline): the PUBLISH does
  not parse, the client closes the session, and every pending SWITCH resolves at
  once as a failure (`session closed: ...`, `SWITCH_ERROR.failure` =
  `SessionClosed`). The failure PUBLISH still carries `{0, 0}` without B. B is
  also on
  `SWITCH_PROMOTED.below_seam_streams`. PUBLISH_DONE's Stream Count is left
  exactly as the spec defines it.
- **"Delivered" before PUBLISH_DONE means written to QUIC.** The PR has the
  relay deliver every object below G_switch before PUBLISH_DONE. The relay's
  drain (`drain_source_below`) waits until the source's last sent location (which
  advances only on a successful write) reaches the last object below the seam it
  holds, i.e. until every such object has been written to its QUIC stream, not
  until the subscriber has received it. PUBLISH_DONE can therefore overtake the
  tail of a below-seam stream on the wire; the subscriber side (D1 above) waits
  for the streams to end rather than for the message.
- **PUBLISH_DONE Stream Count includes streams reset before their first byte.**
  The count is incremented when the relay opens a stream (the header is queued
  with it). Close-After-Switch resets the source's streams at or above the seam
  right after PUBLISH_DONE; a reset stream whose header had not left yet never
  reaches the subscriber, yet it is counted. That is spec-exact (the publisher
  opened it) and is why the player's release uses B, not the Stream Count.
- **Gap: cancelling a pushed current subscription does not reach the cancel
  race.** The PR's cancel race (the subscriber cancels the Current Subscribe
  Request ID while a SWITCH is in flight: the relay abandons the switch) is
  implemented in `cancel_subscription`, which the session calls when a
  SUBSCRIBE's request stream is closed or reset. The request stream of a PUBLISH
  the relay pushed (a switch target, now the current subscription) is served by
  `forward_publish_downstream` (`message_handlers/publish_handler.rs`), whose
  read loop ends on `Err(_) => break` without calling `cancel_subscription`:
  resetting it neither abandons an in-flight SWITCH nor tears the subscription
  down (it forwards until the connection closes). No effect in the experiments,
  checked against every `unsubscribe` call in `apps/client-js/src/lib/player.ts`
  and the library: the player cancels a pushed subscription only (a) as a
  replaced route after its switch succeeded, when the relay has already ended
  it (Close-After-Switch), (b) at dispose, followed at once by the session's
  disconnect, and (c) in the library's late-success path, for a target the
  player never adopted and so never names in a SWITCH. It never cancels a pushed
  current subscription while a SWITCH could be in flight on it.
