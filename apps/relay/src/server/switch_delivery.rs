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
use moqtail::model::control::constant::{GroupOrder, PublishDoneStatusCode};
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::data::fetch_header::FetchHeader;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::error::ParseError;
use moqtail::model::parameter::switch_transition::SwitchTransition;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tracing::{error, info};

use crate::server::client::MOQTClient;
use crate::server::stream_id::StreamId;
use crate::server::switch_guard::SwitchFailure;
use crate::server::track::Track;
use crate::server::track_cache::CacheConsumeEvent;

/// Relay-side `T_switch` budget for draining the source subscription before
/// terminating it. Kept at/under the client's switch guard so a congested drain
/// can't wedge the teardown.
const SWITCH_DRAIN_TIMEOUT: Duration = Duration::from_millis(3000);
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
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) fn spawn_switch_catchup_stream(
  subscriber: Arc<MOQTClient>,
  target_track: Arc<RwLock<Track>>,
  publish_request_id: u64,
  g_switch: u64,
  live_edge: u64,
) {
  if g_switch >= live_edge {
    return;
  }
  tokio::spawn(async move {
    let track = target_track.read().await;
    let track_alias = track.track_alias;
    // [g_switch, live_edge): stop one group below the edge — the live edge and
    // beyond are delivered by the subscription's SUBGROUP streams.
    let start = Location::new(g_switch, 0);
    let end = Location::new(live_edge.saturating_sub(1), 0);
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

/// Captured pre-seam bound for unwinding on PUBLISH failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeamBoundUndo {
  pub prior_end_group: Option<u64>,
}

/// Outcome of draining the source Track below the switch boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) enum DrainOutcome {
  /// All source Objects in Groups below `g_switch` were delivered; the source
  /// is now bounded at the seam and the target PUBLISH may open.
  /// `prior_end_group` is the source's `end_group` before the seam bound was
  /// applied (`None` when nothing was bounded — `g_switch == 0` or no source
  /// subscription), so a caller whose PUBLISH subsequently fails can unwind
  /// the bound via [`restore_source_end_group`] and leave the current
  /// subscription unaltered, as the draft's failure discipline requires.
  /// `undo` is `Some` iff a seam bound was applied (its inner value may be
  /// `None` = previously unbounded); `None` when nothing was bounded.
  Drained { undo: Option<SeamBoundUndo> },
  /// The drain did not finish within `SWITCH_DRAIN_TIMEOUT`. The source is
  /// left completely unchanged; the caller aborts with TIMEOUT.
  TimedOut,
  /// An UNSUBSCRIBE for the Current Subscribe Request ID arrived mid-drain
  /// (SWITCH PR #1378 abandon rule). The source is left unchanged; the caller
  /// must answer with PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED).
  Abandoned,
}

/// Drain the source subscription up to the switch boundary (SWITCH PR #1378 strict
/// ordering): wait — bounded by `SWITCH_DRAIN_TIMEOUT` — until source delivery
/// has reached `g_switch - 1`. The caller awaits this BEFORE opening the target
/// PUBLISH so that all source Objects in Groups below `g_switch` are delivered
/// first (no concurrent source/target transmission across the seam, even when
/// the source is itself lagging under congestion).
///
/// Returns [`DrainOutcome::Drained`] if the source drained in time. On success
/// — and ONLY on success — the source is bounded to Groups below `g_switch` so
/// it cannot then forward across the seam. Returns [`DrainOutcome::TimedOut`]
/// on timeout WITHOUT mutating the source, so the caller can abort the switch
/// and leave the current subscription unchanged (rather than terminating it
/// and truncating undelivered source Objects below `g_switch`). Each poll also
/// checks the subscriber's abandon mark and returns
/// [`DrainOutcome::Abandoned`] as soon as an UNSUBSCRIBE for
/// `current_sub_req_id` abandons the switch — without this the loop would spin
/// to the deadline (a removed subscription's last-sent stops advancing) and
/// misreport the UNSUBSCRIBE race as TIMEOUT.
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn drain_source_below(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  connection_id: usize,
  g_switch: u64,
  current_sub_req_id: u64,
) -> DrainOutcome {
  if g_switch == 0 {
    return DrainOutcome::Drained {
      undo: None,
    };
  }
  let Some(sub_arc) = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await
  else {
    // No source subscription to drain; nothing to truncate.
    return DrainOutcome::Drained { undo: None };
  };

  // Wait until last-sent reaches G_switch-1 (or timeout/abandon). The source
  // is NOT bounded during the wait so that a timeout leaves it completely
  // unchanged.
  let deadline = Instant::now() + SWITCH_DRAIN_TIMEOUT;
  loop {
    // SWITCH PR #1378 UNSUBSCRIBE race: exit as soon as the switch is abandoned so
    // the caller can emit the SUBSCRIPTION_ENDED failure PUBLISH promptly.
    if subscriber
      .switch_in_flight
      .lock()
      .await
      .is_abandoned(current_sub_req_id)
    {
      return DrainOutcome::Abandoned;
    }
    let drained = {
      let sub = sub_arc.read().await;
      let state = sub.subscription_state.read().await;
      state
        .last_sent_max_location
        .as_ref()
        .map(|loc| loc.group + 1 >= g_switch)
        .unwrap_or(false)
    };
    if drained {
      // Drain confirmed: bound the source at the seam so it does not forward
      // Groups >= G_switch concurrently with the target before teardown.
      // Capture the prior bound under the same write lock so the caller can
      // unwind exactly what was replaced if the target PUBLISH fails.
      let prior_end_group = {
        let sub = sub_arc.read().await;
        let mut state = sub.subscription_state.write().await;
        let prior = state.end_group;
        // g_switch == 1 now yields Some(0): a real bound at group 0, where the
        // old u64 sentinel silently meant "no limit".
        state.end_group = Some(g_switch - 1);
        prior
      };
      return DrainOutcome::Drained {
        undo: Some(SeamBoundUndo { prior_end_group })
      };
    }
    if Instant::now() >= deadline {
      return DrainOutcome::TimedOut;
    }
    tokio::time::sleep(SWITCH_DRAIN_POLL).await;
  }
}

/// Unwind the seam bound applied by a successful [`drain_source_below`] after
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
  if let Some(sub_arc) = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await
  {
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
  current_track
    .read()
    .await
    .remove_subscription(connection_id)
    .await;
  subscriber
    .subscriptions
    .remove_subscription(current_full_track_name)
    .await;
  // PR #1378 gate hygiene: the replaced subscription is no longer
  // Established. Without this, a later SWITCH naming this Request ID passes
  // the pre-PUBLISH gate and drives a full switch off a dead subscription.
  subscriber
    .subscribe_requests
    .write()
    .await
    .remove(&current_sub_req_id);
}
