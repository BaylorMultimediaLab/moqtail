// Copyright 2025 The MOQtail Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Relay-initiated delivery for the SWITCH message (draft-ietf-moq-transport
//! PR #1378, "SWITCH for Client-side ABR").
//!
//! Under PR #1378 the relay carries out a switch by *opening a PUBLISH* toward
//! the subscriber for the target Track — it does not mutate the existing
//! subscription. These helpers build the two control-message shapes that flow
//! on success and on failure; the catch-up `FETCH_HEADER` data stream and the
//! `handle_switch_message` integration that drives them are a later step
//! verified against the network harness.
//!
//! Both helpers are side-effect-free beyond enqueuing a control message on the
//! subscriber, so they are safe to call from the switch handler before any data
//! stream is opened.

use std::sync::Arc;
use std::time::{Duration, Instant};

use moqtail::model::common::location::Location;
use moqtail::model::common::pair::KeyValuePair;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::common::tuple::{Tuple, TupleField};
use moqtail::model::control::constant::{GroupOrder, PublishDoneStatusCode};
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::data::fetch_header::FetchHeader;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::error::ParseError;
use moqtail::model::parameter::switch_transition::SwitchTransition;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tracing::{error, info};

use crate::server::client::MOQTClient;
use crate::server::session::Session;
use crate::server::session_context::SessionContext;
use crate::server::stream_id::StreamId;
use crate::server::switch_guard::SwitchFailure;
use crate::server::switch_selection::{SwitchSelection, select_switch_group};
use crate::server::track::{Track, TrackStatus};
use crate::server::track_cache::CacheConsumeEvent;
use moqtail::model::control::fetch::{Fetch, StandAloneFetchProps};
use moqtail::transport::data_stream_handler::FetchRequest;

/// Poll cadence for the T_switch-bounded waits (G_switch identification and
/// the source drain). The budget itself is the guard's `DEFAULT_T_SWITCH`:
/// the switch handler computes ONE deadline at SWITCH receipt and threads it
/// through both phases, so together they honor the draft's "MUST complete the
/// operation within an implementation-specific timeout T_switch".
const SWITCH_DRAIN_POLL: Duration = Duration::from_millis(50);

/// QUIC send priority for the SWITCH catch-up stream. SWITCH PR #1378: the relay
/// SHOULD give the catch-up stream a HIGHER priority than concurrent SUBGROUP
/// streams for the target track until the catch-up stream closes — the
/// subscriber needs `[G_switch, live_edge)` first to assemble a gap-free
/// buffer; live objects are only playable once the seam is filled. Subgroup
/// streams are opened with `i32::MAX - elapsed_ms_since_start`
/// (subscription.rs), which is strictly below `i32::MAX` for any stream opened
/// after process start, so `i32::MAX` statically outranks them all for this
/// stream's whole lifetime. Ordinary client-issued FETCH responses keep
/// priority 0 in fetch_handler.rs — the draft's SHOULD covers only the switch
/// catch-up stream.
const SWITCH_CATCHUP_STREAM_PRIORITY: i32 = i32::MAX;

/// Open the target Track's PUBLISH for a successful SWITCH.
///
/// The PUBLISH advertises the live edge as its largest location and carries the
/// `SWITCH_TRANSITION` parameter so the subscriber learns the seam: catch-up
/// covers `[switch_transition.switching_group_id, live_edge)`, live objects
/// follow from the live edge. `publish_request_id` is the relay-allocated
/// Request ID the subscriber will see on the inbound PUBLISH (it did not
/// pre-allocate it — the client handles this via its peer-publish path).
pub(crate) async fn send_switch_publish(
  subscriber: &Arc<MOQTClient>,
  publish_request_id: u64,
  target: &FullTrackName,
  track_alias: u64,
  live_edge: Location,
  target_parameters: &[KeyValuePair],
  switch_transition: SwitchTransition,
) -> Result<(), ParseError> {
  // Per SWITCH PR #1378 the SWITCH's parameter set IS the complete parameter set for the
  // target PUBLISH (the target does not inherit the old subscription's params).
  // Carry those parameters through, then append SWITCH_TRANSITION so the
  // subscriber learns the seam.
  let mut parameters = target_parameters.to_vec();
  parameters.push(switch_transition.to_key_value_pair()?);
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    track_alias,
    GroupOrder::Original,
    1, // content_exists: data will follow
    Some(live_edge),
    1, // forward
    parameters,
  );
  subscriber
    .queue_message(ControlMessage::Publish(Box::new(publish)))
    .await;
  Ok(())
}

/// Report a failed SWITCH per PR #1378's always-PUBLISH discipline: still open
/// the target PUBLISH (so the subscriber has a request to terminate), then
/// immediately `PUBLISH_DONE` it with the mapped status code. The current
/// subscription is left untouched — no disconnect, replacing today's
/// `ProtocolViolation` teardown.
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn send_switch_failure(
  subscriber: &Arc<MOQTClient>,
  publish_request_id: u64,
  target: &FullTrackName,
  track_alias: u64,
  failure: SwitchFailure,
) {
  // SWITCH PR #1378: "The SWITCH_TRANSITION parameter MUST appear in a PUBLISH
  // opened by a Relay in response to a SWITCH message" — the failure PUBLISH
  // is such a PUBLISH. Its presence is also what lets the subscriber classify
  // this PUBLISH as switch-related (and consume the pending switch) rather
  // than treat it as an unsolicited peer publish. No seam was selected, so
  // carry {0, 0} as placeholders; the subscriber keys off the immediately
  // following PUBLISH_DONE status code, not these values.
  let parameters = SwitchTransition::new(0, 0)
    .to_key_value_pair()
    .map(|p| vec![p])
    .unwrap_or_default();
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    track_alias,
    GroupOrder::Original,
    0, // content_exists: no data will follow a failed switch
    None,
    0, // forward
    parameters,
  );
  subscriber
    .queue_message(ControlMessage::Publish(Box::new(publish)))
    .await;

  let reason = ReasonPhrase::try_new(format!("switch: {failure:?}"))
    .unwrap_or_else(|_| ReasonPhrase::try_new(String::new()).unwrap());
  let done = PublishDone::new(publish_request_id, failure.status_code(), 0, reason);
  subscriber
    .queue_message(ControlMessage::PublishDone(Box::new(done)))
    .await;
}

/// Deliver the catch-up range `[g_switch, live_edge)` of the target Track on a
/// dedicated unidirectional stream that begins with a `FETCH_HEADER` carrying
/// the target PUBLISH's Request ID (PR #1378). Live objects from `live_edge`
/// onward arrive separately on the subscription's SUBGROUP streams.
///
/// Spawns a task and returns immediately. A no-op when `g_switch >= live_edge`
/// (the switch lands at the live edge, so there is nothing to catch up). Mirrors
/// the ranged delivery in `fetch_handler` but is relay-initiated.
///
/// The stream is opened — and FIN'd — unconditionally once `g_switch <
/// live_edge`: the subscriber was told via SWITCH_TRANSITION to expect this
/// range, and the draft requires the relay to open the catch-up stream and
/// send FIN after its last object. If the cache yields nothing (evicted
/// between G_switch selection and delivery), that is an *empty* catch-up
/// stream — FETCH_HEADER then immediate FIN — not an absent one; a lazily
/// opened stream would leave the subscriber waiting on a range that never
/// terminates.
/// The catch-up range for a switch: `[G_switch, live_edge)` expressed as the
/// inclusive `(start, end)` pair `TrackCache::read_objects` expects, where
/// `end.object == 0` means "the whole end group". `None` when
/// `g_switch >= live_edge`: the switch lands at or above the live edge, so
/// there is nothing to catch up — SUBGROUP delivery covers the seam.
/// `live_edge - 1` cannot underflow: it is only computed when
/// `g_switch < live_edge`, which forces `live_edge >= 1`.
pub(crate) fn switch_catchup_range(g_switch: u64, live_edge: u64) -> Option<(Location, Location)> {
  if g_switch >= live_edge {
    return None;
  }
  Some((Location::new(g_switch, 0), Location::new(live_edge - 1, 0)))
}

/// The seam bound applied to the source subscription once its drain completes:
/// forward nothing above `G_switch - 1`. `None` for `g_switch == 0` — nothing
/// exists below Group 0, so no bound is applied (`drain_source_below`
/// early-returns before bounding in that case).
///
/// `g_switch == 1` yields `Some(0)`: a real bound at Group 0. This is the case
/// the old `u64` encoding could not express — it wrote `0`, which the
/// forwarding filter read as "no limit", leaking Groups >= 1 across the seam.
pub(crate) fn seam_end_group_bound(g_switch: u64) -> Option<u64> {
  g_switch.checked_sub(1)
}

/// True once the source has delivered everything below the seam that the
/// relay holds: its last-sent location has reached `drain_target`, the
/// greatest cached location strictly below `G_switch` on the current Track
/// (re-evaluated by the caller each poll, so a still-growing group keeps
/// moving the bar). `None` target = nothing below the seam is held = nothing
/// to drain. This replaces the old `last_sent.group + 1 >= g_switch` check,
/// which (a) opened the PUBLISH while the tail of Group `G_switch - 1` was
/// still queued (last-sent being IN the group is not having FINISHED it), and
/// (b) stalled to a spurious TIMEOUT when `G_switch - 1` is a hole shared by
/// both Tracks — which the relaxed selection expressly permits. Residual
/// approximation, documented rather than hidden: when the group below the
/// seam is still growing, objects can arrive after the last poll observed the
/// cache; the target chases the cache, not the (unknowable) end of group.
pub(crate) fn drain_complete(
  last_sent: Option<&Location>,
  drain_target: Option<&Location>,
) -> bool {
  match drain_target {
    None => true,
    Some(target) => last_sent.is_some_and(|sent| sent >= target),
  }
}

/// Builds the live subscription opened for the target Track of a switch.
///
/// SUBGROUP delivery must cover every object at/after the seam's live
/// boundary: catch-up ends at `live_edge` (exclusive), so live delivery
/// starts at `(max(g_switch, live_edge), 0)`. The `max` matters when the
/// selected boundary sits at or above the live edge: there is no catch-up
/// stream then, and starting at `live_edge` would leak Groups
/// `[live_edge, G_switch)` that the source is still responsible for.
///
/// `AbsoluteStart` (not `LatestObject`) is load-bearing: it sets
/// `is_joining`, whose cache replay delivers the already-received head of the
/// start group before live-forward resumes. `LatestObject` attaches mid-group
/// and drops `(live_edge, 0..now)` — an undecodable hole exactly at the seam,
/// typically the group's keyframe.
pub(crate) fn build_switch_live_sub(
  target_request_id: u64,
  track_namespace: Tuple,
  track_name: TupleField,
  g_switch: u64,
  live_edge: u64,
  parameters: Vec<KeyValuePair>,
) -> Subscribe {
  Subscribe::new_absolute_start(
    target_request_id,
    track_namespace,
    track_name,
    0,
    GroupOrder::Original,
    true,
    Location::new(g_switch.max(live_edge), 0),
    parameters,
  )
}

#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) fn spawn_switch_catchup_stream(
  subscriber: Arc<MOQTClient>,
  target_track: Arc<RwLock<Track>>,
  publish_request_id: u64,
  g_switch: u64,
  live_edge: u64,
) {
  let Some((start, end)) = switch_catchup_range(g_switch, live_edge) else {
    return;
  };
  tokio::spawn(async move {
    let track = target_track.read().await;
    let track_alias = track.track_alias;
    let mut object_rx = track.cache.read_objects(start, end, false).await;

    let fetch_header = FetchHeader::new(publish_request_id);
    let stream_id = StreamId::new_fetch(track_alias, publish_request_id);

    // Open eagerly (see doc comment): the FETCH_HEADER announces the range and
    // the trailing FIN terminates it even when zero objects follow.
    let send_stream = match subscriber
      .open_stream(
        &stream_id,
        fetch_header.serialize().unwrap(),
        SWITCH_CATCHUP_STREAM_PRIORITY,
      )
      .await
    {
      Ok(ss) => ss,
      Err(e) => {
        error!("switch catch-up: failed to open stream {stream_id}: {e:?}");
        return;
      }
    };

    let mut object_count: u64 = 0;
    while let Some(event) = object_rx.recv().await {
      match event {
        CacheConsumeEvent::Object(object) => {
          if let Err(e) = subscriber
            .write_stream_object(
              &stream_id,
              object.object_id,
              object.serialize().unwrap(),
              Some(send_stream.clone()),
            )
            .await
          {
            error!("switch catch-up: write failed on {stream_id}: {e:?}");
            break;
          }
          object_count += 1;
        }
        CacheConsumeEvent::EndLocation(_) | CacheConsumeEvent::NoObject => {}
      }
    }

    if let Err(e) = send_stream.lock().await.shutdown().await {
      error!("switch catch-up: error closing stream {stream_id}: {e:?}");
    }
    subscriber.remove_stream_by_stream_id(&stream_id).await;
    info!(
      "switch catch-up: delivered {object_count} objects on {stream_id} for [{g_switch}, {live_edge})"
    );
  });
}

/// Outcome of identifying G_switch within the T_switch window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // consumed by handle_switch_message
pub(crate) enum SelectOutcome {
  /// A qualifying common boundary was identified.
  Ready(u64),
  /// No qualifying boundary materialized before the deadline — the SWITCH PR's
  /// TIMEOUT ("could not identify G_switch within T_switch").
  TimedOut,
  /// An UNSUBSCRIBE for the Current Subscribe Request ID arrived while
  /// waiting; the caller must answer with the SUBSCRIPTION_ENDED failure.
  Abandoned,
  /// The upstream rejected the target Track (SubscribeError -> the track's
  /// Rejected status) while waiting — the target genuinely is not available at
  /// the publisher, so the caller must answer DOES_NOT_EXIST rather than
  /// letting the wait spin to a misleading TIMEOUT.
  TargetRejected,
}

/// Identify G_switch, waiting — bounded by `deadline` — for a qualifying
/// boundary to materialize.
///
/// The SWITCH PR #1378 frames T_switch as the window the relay has to IDENTIFY G_switch
/// (TIMEOUT means "could not identify G_switch within T_switch"), not a
/// one-shot check at SWITCH receipt: a floor naming a group the target has not
/// produced yet — e.g. a subscriber at the live edge switching at its NEXT
/// boundary — must wait for that group while the relay "MUST continue
/// forwarding Objects from the current subscription" (which this wait leaves
/// completely untouched). Re-evaluates the selection every
/// [`SWITCH_DRAIN_POLL`] against the tracks' live cache state, and exits early
/// if the switch is abandoned by an UNSUBSCRIBE.
#[allow(dead_code)] // consumed by handle_switch_message
pub(crate) async fn poll_select_switch_group(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  target_track: &Arc<RwLock<Track>>,
  minimum_switching_group_id: u64,
  current_sub_req_id: u64,
  generation: u64,
  deadline: Instant,
) -> SelectOutcome {
  loop {
    if subscriber
      .switch_in_flight
      .lock()
      .await
      .is_abandoned(current_sub_req_id, generation)
    {
      return SelectOutcome::Abandoned;
    }
    // A target the relay is establishing upstream for this switch surfaces an
    // upstream SubscribeError as the track's Rejected status; keeping the wait
    // alive past that point could only end in a misleading TIMEOUT.
    if matches!(
      target_track.read().await.get_status().await,
      TrackStatus::Rejected { .. }
    ) {
      return SelectOutcome::TargetRejected;
    }
    match select_switch_group(current_track, target_track, minimum_switching_group_id).await {
      SwitchSelection::Ready(g) => return SelectOutcome::Ready(g),
      SwitchSelection::NoCommonBoundary => {
        if Instant::now() >= deadline {
          return SelectOutcome::TimedOut;
        }
        tokio::time::sleep(SWITCH_DRAIN_POLL).await;
      }
    }
  }
}

/// Relay chaining, SWITCH PR #1378 "and/or FETCH requests": backfill the switch
/// target's missing history from the upstream relay.
///
/// The lazy upstream subscription only live-forwards, so Groups older than its
/// establishment — including the client's Minimum Switching Group ID floor and
/// anything published during the SUBSCRIBE handshake window — exist only
/// upstream. This task waits (bounded by the switch's T_switch deadline) for
/// the upstream confirmation, then issues one standalone upstream FETCH for
/// `[floor, end]`, where `end` stops below the oldest locally held group (a
/// refetch of held groups would waste upstream bandwidth) or, when nothing is
/// held, at the upstream's advertised live edge (seeded into
/// `largest_location` by `Track::confirm`). The fetch range and the lazy
/// subscription's live-forwarding may overlap — an object arriving upstream
/// between the subscription registering and the fetch-cache read reaches this
/// relay twice — which is safe: `TrackCache::add_object` is idempotent and
/// order-restoring, so the double ingest collapses in the cache instead of
/// reaching subscribers. The response's FETCH_HEADER stream
/// is ingested by the ordinary data plane (`handle_uni_stream` routes it via
/// the upstream client's `fetch_requests` into `new_subgroup_object`), so the
/// backfilled Groups land in the cache and the concurrently polling G_switch
/// selection picks them up. Runs only when the target is served by the
/// upstream link — only relays answer FETCH from cache.
///
/// Best-effort: an upstream FetchError (nothing cached in range) is a benign
/// no-op downstream, and selection proceeds with whatever live-forwarding
/// supplies.
pub(crate) fn spawn_upstream_backfill(
  context: Arc<SessionContext>,
  target_track: Arc<RwLock<Track>>,
  target: FullTrackName,
  floor: u64,
  deadline: Instant,
) {
  tokio::spawn(async move {
    let Some(upstream) = context.client_manager.read().await.get_upstream().await else {
      return;
    };
    if target_track.read().await.publisher_connection_id != upstream.connection_id {
      return;
    }

    // Wait for upstream confirmation: it carries the track alias and (via the
    // largest_location seeding in Track::confirm) the upstream's known edge.
    let alias = loop {
      match target_track.read().await.get_status().await {
        TrackStatus::Confirmed {
          publisher_track_alias,
          ..
        } => break publisher_track_alias,
        TrackStatus::Rejected { .. } => return,
        TrackStatus::Pending => {
          if Instant::now() >= deadline {
            return;
          }
          tokio::time::sleep(SWITCH_DRAIN_POLL).await;
        }
      }
    };

    let (known_edge, local_oldest) = {
      let t = target_track.read().await;
      let edge = t.largest_location.read().await.group;
      let oldest = t.cache.oldest_group_id().await;
      (edge, oldest)
    };
    let end_group = match local_oldest {
      Some(oldest) if floor < oldest => oldest - 1,
      Some(_) => return, // history at/below the floor is already held
      None => known_edge,
    };
    if floor > end_group {
      return;
    }

    // Request-id parity: this FETCH goes to the upstream link, where the
    // relay is the CLIENT — even ids (the upstream's parity gate enforces it).
    let request_id =
      Session::get_next_upstream_request_id(context.upstream_next_request_id.clone()).await;
    let fetch = Fetch::new_standalone(
      request_id,
      0,
      GroupOrder::Original,
      StandAloneFetchProps {
        track_namespace: target.namespace.clone(),
        track_name: target.name.clone(),
        start_location: Location::new(floor, 0),
        end_location: Location::new(end_group, 0),
      },
      Vec::new(),
    );
    let record = FetchRequest::new(request_id, upstream.connection_id, fetch.clone(), alias);
    // Both maps matter: relay_fetch_requests validates the upstream's FetchOk
    // control message; the upstream client's fetch_requests routes the
    // FETCH_HEADER data stream (handle_uni_stream resolves the track alias
    // through it).
    context
      .relay_fetch_requests
      .write()
      .await
      .insert(request_id, record.clone());
    upstream
      .fetch_requests
      .write()
      .await
      .insert(request_id, record);
    info!(
      "switch backfill: upstream FETCH [{floor}, {end_group}] for {target:?} (request {request_id})"
    );
    upstream
      .queue_message(ControlMessage::Fetch(Box::new(fetch)))
      .await;
  });
}

/// Captured pre-seam bound for unwinding on PUBLISH failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeamBoundUndo {
  pub prior_end_group: Option<u64>,
}

/// Outcome of draining the source Track below the switch boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainOutcome {
  /// All source Objects in Groups below `g_switch` were delivered. The source
  /// is NOT yet bounded at the seam: the caller must first win the publish
  /// claim (`mark_published`) and only then apply the bound via
  /// [`apply_seam_bound`] — so an abandoned or superseded task never mutates
  /// the source subscription at all (draft: on any failure the relay "MUST
  /// NOT alter the current subscription").
  Drained,
  /// The drain did not finish within the T_switch deadline. The source is
  /// left completely unchanged; the caller aborts with TIMEOUT.
  TimedOut,
  /// An UNSUBSCRIBE for the Current Subscribe Request ID arrived mid-drain
  /// (SWITCH PR #1378 abandon rule). The source is left unchanged; the caller
  /// must answer with PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED).
  Abandoned,
}

/// Drain the source subscription up to the switch boundary (SWITCH PR #1378 strict
/// ordering): wait — bounded by `deadline`, the same T_switch deadline that
/// bounded G_switch identification — until source delivery has reached
/// `g_switch - 1`. The caller awaits this BEFORE opening the target PUBLISH so
/// that all source Objects in Groups below `g_switch` are delivered first (no
/// concurrent source/target transmission across the seam, even when the source
/// is itself lagging under congestion).
///
/// Returns [`DrainOutcome::Drained`] if the source drained in time. The drain
/// itself never mutates the source: the seam bound is applied by the caller
/// via [`apply_seam_bound`], AFTER it wins the publish claim, so that every
/// non-Claimed outcome (timeout, abandon, supersede) leaves the current
/// subscription untouched. Returns [`DrainOutcome::TimedOut`] on timeout, so
/// the caller can abort the switch (rather than terminating the source and
/// truncating undelivered Objects below `g_switch`). Each poll also checks
/// the subscriber's abandon mark for this switch's `generation` and returns
/// [`DrainOutcome::Abandoned`] as soon as an UNSUBSCRIBE for
/// `current_sub_req_id` abandons the switch — without this the loop would spin
/// to the deadline (a removed subscription's last-sent stops advancing) and
/// misreport the UNSUBSCRIBE race as TIMEOUT.
pub(crate) async fn drain_source_below(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  connection_id: usize,
  g_switch: u64,
  current_sub_req_id: u64,
  generation: u64,
  deadline: Instant,
) -> DrainOutcome {
  if g_switch == 0 {
    return DrainOutcome::Drained;
  }
  let Some(sub_arc) = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await
  else {
    // No source subscription to drain; nothing to truncate.
    return DrainOutcome::Drained;
  };

  // Wait until last-sent reaches G_switch-1 (or timeout/abandon).
  loop {
    // SWITCH PR #1378 UNSUBSCRIBE race: exit as soon as the switch is abandoned so
    // the caller can emit the SUBSCRIPTION_ENDED failure PUBLISH promptly.
    if subscriber
      .switch_in_flight
      .lock()
      .await
      .is_abandoned(current_sub_req_id, generation)
    {
      return DrainOutcome::Abandoned;
    }
    let drained = {
      // Re-read the drain target each poll: below-seam groups can still be
      // growing (a switch at the next boundary drains the current live
      // group), and holes must not be waited on.
      let drain_target = current_track
        .read()
        .await
        .cache
        .max_location_below_group(g_switch)
        .await;
      let sub = sub_arc.read().await;
      let state = sub.subscription_state.read().await;
      drain_complete(state.last_sent_max_location.as_ref(), drain_target.as_ref())
    };
    if drained {
      return DrainOutcome::Drained;
    }
    if Instant::now() >= deadline {
      return DrainOutcome::TimedOut;
    }
    tokio::time::sleep(SWITCH_DRAIN_POLL).await;
  }
}

/// Bound the source subscription at the seam — forward nothing at/above
/// `g_switch` — capturing the prior `end_group` for unwind. Called by the
/// switch task AFTER the drain confirmed AND the publish claim was won
/// (`ClaimResult::Claimed`): sequencing the bound after the claim guarantees
/// an abandoned or superseded task has not touched the source subscription,
/// and that two racing switch tasks can never both apply (or unwind) a bound.
/// Returns `None` — nothing mutated, nothing to unwind — when `g_switch == 0`
/// (nothing exists below Group 0) or the subscription is already gone; the
/// small window between the drain's last poll and this bound is covered by
/// the same residual-approximation argument as [`drain_complete`].
pub(crate) async fn apply_seam_bound(
  current_track: &Arc<RwLock<Track>>,
  connection_id: usize,
  g_switch: u64,
) -> Option<SeamBoundUndo> {
  let bound = seam_end_group_bound(g_switch)?;
  let sub_arc = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await?;
  let prior_end_group = {
    let sub = sub_arc.read().await;
    let mut state = sub.subscription_state.write().await;
    let prior = state.end_group;
    state.end_group = Some(bound);
    prior
  };
  Some(SeamBoundUndo { prior_end_group })
}

/// Unwind the seam bound applied by [`apply_seam_bound`] after
/// the target PUBLISH failed to open (SWITCH PR #1378: on any failure the relay
/// "MUST NOT alter the current subscription"). Restores the exact prior
/// `end_group` — `0` means "no limit", but a genuine bound from the original
/// SUBSCRIBE is also possible, which is why the captured value is restored
/// rather than blindly clearing to `0`. A no-op if the subscription vanished
/// meanwhile (its teardown owns the state then).
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn restore_source_end_group(
  current_track: &Arc<RwLock<Track>>,
  connection_id: usize,
  prior_end_group: Option<u64>,
) {
  if let Some(sub_arc) = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await
  {
    sub_arc
      .read()
      .await
      .subscription_state
      .write()
      .await
      .end_group = prior_end_group;
  }
}

/// Terminate the source subscription after the handover (SWITCH PR #1378
/// Close-After-Switch): send PUBLISH_DONE on its (the current) Request ID, then
/// drop relay state.
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn terminate_source(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  current_full_track_name: &FullTrackName,
  connection_id: usize,
  current_sub_req_id: u64,
) {
  // Capture the subscription first: state removal below drops it from the
  // maps, but the Arc keeps it alive long enough to signal PUBLISH_DONE (which
  // only queues on the subscriber's control message queue).
  let sub_arc = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await;

  // Commit ALL state removal BEFORE queueing PUBLISH_DONE. The instant the
  // subscriber observes PUBLISH_DONE it may react — e.g. issue another SWITCH
  // naming this Request ID — and the control loop processes that concurrently
  // with the tail of this task. If the signal precedes the cleanup, the stale
  // id still passes the Established gate and drives a switch off a dead
  // subscription (caught by the e2e test
  // stale_switch_request_id_is_silently_dropped). The subscribe_requests entry
  // is the gate key, so it goes first.
  subscriber
    .subscribe_requests
    .write()
    .await
    .remove(&current_sub_req_id);
  current_track
    .read()
    .await
    .remove_subscription(connection_id)
    .await;
  subscriber
    .subscriptions
    .remove_subscription(current_full_track_name)
    .await;

  // Only now tell the subscriber the replaced subscription is over.
  if let Some(sub_arc) = sub_arc {
    let sub = sub_arc.read().await;
    if let Err(e) = sub
      .send_publish_done(
        PublishDoneStatusCode::SubscriptionEnded,
        "switched to target track",
      )
      .await
    {
      error!("switch teardown: failed to send PUBLISH_DONE: {e:?}");
    }
  }
}

#[cfg(test)]
mod tests_switch_seam_helpers {
  use super::*;
  use crate::server::subscription::SubscriptionState;
  use moqtail::model::control::constant::FilterType;

  fn loc(group: u64, object: u64) -> Location {
    Location { group, object }
  }

  fn namespace() -> Tuple {
    Tuple::from_utf8_path("/test")
  }

  fn track_name() -> TupleField {
    TupleField::from_utf8("video")
  }

  // ---- seam_end_group_bound ----

  #[test]
  fn seam_bound_for_g_switch_one_is_a_real_bound_at_group_zero() {
    // THE sentinel regression: under the old u64 encoding the bound for
    // G_switch == 1 was written as 0, which the forwarding filter read as
    // "no limit" — the source leaked Groups >= 1 across the seam while the
    // target delivered the same groups via catch-up.
    assert_eq!(seam_end_group_bound(1), Some(0));
  }

  #[test]
  fn seam_bound_for_g_switch_zero_is_unbounded() {
    // Nothing exists below Group 0; drain_source_below early-returns with
    // undo: None and applies no bound.
    assert_eq!(seam_end_group_bound(0), None);
  }

  #[test]
  fn seam_bound_is_g_switch_minus_one() {
    assert_eq!(seam_end_group_bound(10), Some(9));
  }

  // ---- drain_complete ----

  #[test]
  fn drain_not_complete_when_nothing_sent_but_target_exists() {
    assert!(!drain_complete(None, Some(&loc(0, 2))));
    assert!(!drain_complete(None, Some(&loc(3, 7))));
  }

  #[test]
  fn drain_complete_when_nothing_below_seam_is_held() {
    // No target = nothing below G_switch in the cache = nothing to drain —
    // even if the source has sent nothing at all.
    assert!(drain_complete(None, None));
    assert!(drain_complete(Some(&loc(9, 9)), None));
  }

  #[test]
  fn mid_group_tail_holds_the_drain() {
    // THE flaw the old `group + 1 >= g_switch` check had: last-sent being IN
    // Group G_switch-1 is not having finished it. With the cache holding
    // (4, 7), a last-sent of (4, 3) must keep the PUBLISH closed until the
    // tail is delivered.
    assert!(!drain_complete(Some(&loc(4, 3)), Some(&loc(4, 7))));
    assert!(drain_complete(Some(&loc(4, 7)), Some(&loc(4, 7))));
  }

  #[test]
  fn shared_hole_below_seam_converges() {
    // G_switch - 1 is a hole on the current Track (the relaxed selection
    // permits shared holes): the target is the highest AVAILABLE group below
    // the seam, so the drain completes at (2, 5) instead of waiting forever
    // for a Group 4 that will never exist (the old check's spurious TIMEOUT).
    assert!(drain_complete(Some(&loc(2, 5)), Some(&loc(2, 5))));
    assert!(!drain_complete(Some(&loc(2, 4)), Some(&loc(2, 5))));
  }

  #[test]
  fn drain_complete_when_source_already_past_seam() {
    // Behind-live / buffer-replacement switch: the source forwarded past
    // G_switch before the SWITCH arrived; last-sent dominates any below-seam
    // target and the drain is immediately complete.
    assert!(drain_complete(Some(&loc(7, 2)), Some(&loc(4, 9))));
  }

  // ---- switch_catchup_range ----

  #[test]
  fn catchup_range_is_half_open() {
    // [G_switch, live_edge): end group is live_edge - 1, and end.object == 0
    // means "the whole end group" in read_objects' range semantics.
    assert_eq!(switch_catchup_range(2, 6), Some((loc(2, 0), loc(5, 0))));
  }

  #[test]
  fn catchup_skipped_at_or_above_live_edge() {
    // The switch lands at/above the live edge: no catch-up stream; SUBGROUP
    // delivery covers the seam (see build_switch_live_sub's max()).
    assert_eq!(switch_catchup_range(6, 6), None);
    assert_eq!(switch_catchup_range(7, 6), None);
  }

  #[test]
  fn catchup_range_at_live_edge_one_does_not_underflow() {
    // live_edge == 1 with g_switch == 0 is the smallest non-empty range:
    // exactly Group 0. Pins the `live_edge - 1` underflow guard (the
    // subtraction is only reachable when live_edge >= 1).
    assert_eq!(switch_catchup_range(0, 1), Some((loc(0, 0), loc(0, 0))));
  }

  // ---- build_switch_live_sub ----

  #[test]
  fn live_sub_starts_at_live_edge_when_seam_below_edge() {
    // Normal switch: catch-up covers [g_switch, live_edge); live delivery
    // must begin exactly at (live_edge, 0) — no gap, no overlap.
    let sub = build_switch_live_sub(42, namespace(), track_name(), 3, 7, Vec::new());
    assert_eq!(sub.start_location, Some(loc(7, 0)));
  }

  #[test]
  fn live_sub_starts_at_g_switch_when_seam_above_edge() {
    // No-catch-up case: nothing below G_switch may be delivered for the
    // target. Starting at live_edge here would leak Groups [live_edge,
    // g_switch) that the source is still responsible for — duplicates at
    // the seam.
    let sub = build_switch_live_sub(42, namespace(), track_name(), 9, 7, Vec::new());
    assert_eq!(sub.start_location, Some(loc(9, 0)));
  }

  #[test]
  fn live_sub_start_at_exact_edge() {
    let sub = build_switch_live_sub(42, namespace(), track_name(), 7, 7, Vec::new());
    assert_eq!(sub.start_location, Some(loc(7, 0)));
  }

  #[test]
  fn live_sub_uses_absolute_start_and_engages_joining_replay() {
    // THE seam-gap regression: reverting this to new_latest_object makes
    // is_joining false — no cache replay — and the already-received head of
    // the live-edge group, (live_edge, 0..now), is delivered by neither the
    // catch-up stream (which ends below live_edge) nor the live path
    // (which only forwards objects arriving after attach). That hole is
    // typically the group's keyframe.
    let sub = build_switch_live_sub(42, namespace(), track_name(), 3, 7, Vec::new());
    assert!(matches!(sub.filter_type, FilterType::AbsoluteStart));
    assert_eq!(sub.end_group, None, "live sub must be unbounded");
    assert_eq!(sub.request_id, 42);
    let state = SubscriptionState::from(sub);
    assert!(
      state.is_joining,
      "AbsoluteStart must set is_joining so the cache replay covers the \
       already-received head of the start group"
    );
  }
}
