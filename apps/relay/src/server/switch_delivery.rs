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

//! Relay-side delivery helpers for SWITCH (moq-transport PR #1378) on the
//! draft-18 request-stream model.
//!
//! The SWITCH handler (`subscribe_handler::handle_switch_message`) identifies
//! G_switch, drains the source subscription below it, and then hands over to the
//! target Track. The pieces of that hand-over that touch the wire live here:
//!
//! - the target PUBLISH the relay opens toward the subscriber (its own bidi
//!   request stream, carrying SWITCH_TRANSITION), and the always-PUBLISH failure
//!   discipline (PUBLISH immediately followed by PUBLISH_DONE with the status);
//! - the catch-up FETCH_HEADER stream for `[G_switch, live_edge)`;
//! - the source-side seam bound, drain wait and Close-After-Switch teardown.

use std::sync::Arc;
use std::time::{Duration, Instant};

use moqtail::model::common::location::Location;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::common::tuple::{Tuple, TupleField};
use moqtail::model::control::constant::{GroupOrder, PublishDoneStatusCode};
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::data::fetch_header::FetchHeader;
use moqtail::model::data::fetch_object::{FetchObject, FetchObjectContext};
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::parameter::message_parameter::{MessageParameter, MessageParameterVecExt};
use moqtail::model::parameter::switch_transition::SwitchTransition;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::server::client::MOQTClient;
use crate::server::message_handlers::publish_handler::forward_publish_downstream;
use crate::server::session_context::SessionContext;
use crate::server::stream_id::StreamId;
use crate::server::subscription::{Subscription, compute_stream_priority};
use crate::server::switch_guard::SwitchFailure;
use crate::server::switch_selection::{SwitchSelection, select_switch_group};
use crate::server::track::{Track, TrackStatus};
use crate::server::track_cache::CacheConsumeEvent;

const SWITCH_DRAIN_POLL: Duration = Duration::from_millis(50);

/// QUIC send priority for the catch-up FETCH_HEADER stream (audit M6, R3-D2):
/// the slot a subgroup stream of group `g_switch` gets in the switch's own band,
/// `compute_stream_priority(subscriber priority, publisher priority at G_switch,
/// group order, G_switch)`, the same rule as every FETCH response stream
/// (`fetch_handler::fetch_stream_priority`). With ascending order that is above
/// every live group of the target (all >= the live edge > G_switch: the draft's
/// SHOULD that the catch-up outrank the target's concurrent SUBGROUP streams) and
/// below the replaced subscription's streams of groups < G_switch, which play
/// first. It used to take the top of the publisher-0 band, above that remainder,
/// which inverted play order.
pub(crate) fn switch_catchup_priority(
  subscriber_priority: u8,
  group_order: GroupOrder,
  publisher_priority: u8,
  g_switch: u64,
) -> i32 {
  compute_stream_priority(
    subscriber_priority,
    publisher_priority,
    group_order,
    g_switch,
  )
}

/// The subscriber priority and group order a switch runs at (audit C3/M6): the
/// SWITCH's own SUBSCRIBER_PRIORITY and GROUP_ORDER parameters, else those of the
/// subscription it replaces (as the native arm's switched subscription does).
pub(crate) fn switch_scheduling(
  params: &[MessageParameter],
  inherited: (u8, GroupOrder),
) -> (u8, GroupOrder) {
  let priority = params
    .iter()
    .find_map(|p| match p {
      MessageParameter::SubscriberPriority { priority } => Some(*priority),
      _ => None,
    })
    .unwrap_or(inherited.0);
  let order = params
    .iter()
    .find_map(|p| match p {
      MessageParameter::GroupOrder { order } => Some(*order),
      _ => None,
    })
    .unwrap_or(inherited.1);
  (priority, order)
}

/// Deserialize a SWITCH's raw parameter list into typed message parameters,
/// dropping anything unknown: per SWITCH PR #1378 this set IS the complete
/// parameter set for the target PUBLISH, and the transport-level fields the relay
/// owns (Forward, LargestObject, the SubscriptionFilter, SWITCH_TRANSITION) are
/// restated by the relay below, never taken from the subscriber. Subscriber
/// priority and group order are the one exception (see `switch_scheduling`): a
/// SWITCH that omits them runs at the replaced subscription's, so the target
/// subscription and its catch-up stay in the source's band.
pub(crate) fn switch_target_parameters(
  raw: &[moqtail::model::common::pair::KeyValuePair],
  inherited: (u8, GroupOrder),
) -> Vec<MessageParameter> {
  let mut params: Vec<MessageParameter> = raw
    .iter()
    .filter_map(|kvp| MessageParameter::deserialize(kvp).ok())
    .filter(|p| {
      !matches!(
        p,
        MessageParameter::Forward { .. }
          | MessageParameter::LargestObject { .. }
          | MessageParameter::SubscriptionFilter { .. }
          | MessageParameter::SwitchTransition { .. }
      )
    })
    .collect();
  let (priority, order) = switch_scheduling(&params, inherited);
  params.set_param(MessageParameter::new_subscriber_priority(priority));
  params.set_param(MessageParameter::new_group_order(order));
  params
}

/// The request stream a switch-failure PUBLISH goes out on, opened at
/// `CONTROL_STREAM_PRIORITY` before its first byte like every request stream the
/// relay opens (R3-D2, R3-D6).
pub(crate) async fn open_switch_failure_stream(
  subscriber: &MOQTClient,
) -> Result<
  (
    moqtail::transport::connection::TransportSendStream,
    moqtail::transport::connection::TransportRecvStream,
  ),
  moqtail::transport::connection::TransportConnectionError,
> {
  subscriber.connection.open_request_stream().await
}

/// Open the target PUBLISH toward the subscriber on its own request stream and
/// serve it there for as long as the switched subscription lives (draft-18
/// `forward_publish_downstream`): the PUBLISH_OK comes back on it and the
/// subscription's eventual PUBLISH_DONE goes out on it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_switch_publish(
  subscriber: Arc<MOQTClient>,
  context: Arc<SessionContext>,
  target_track: Arc<RwLock<Track>>,
  subscription: Arc<RwLock<Subscription>>,
  publish_request_id: u64,
  target: &FullTrackName,
  live_edge: Location,
  target_parameters: &[MessageParameter],
  switch_transition: SwitchTransition,
) {
  let (relay_track_id, track_properties) = {
    let track = target_track.read().await;
    (
      track.relay_track_id,
      track.track_properties.read().await.clone(),
    )
  };
  crate::server::events::emit(
    "SWITCH_PROMOTED",
    serde_json::json!({
      "conn": subscriber.connection_id,
      "relay_track_id": relay_track_id,
      "track": crate::server::events::track_name_string(target),
      "request_id": publish_request_id,
      "start_group": switch_transition.switching_group_id,
      "live_edge_group": switch_transition.live_edge_group_id,
      "live_edge_object": live_edge.object,
    }),
  );
  let mut parameters = target_parameters.to_vec();
  parameters.set_param(MessageParameter::new_forward(true));
  parameters.set_param(MessageParameter::new_largest_object(live_edge));
  parameters.set_param(switch_transition.to_message_parameter());
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    relay_track_id,
    parameters,
    track_properties,
  );
  tokio::spawn(async move {
    forward_publish_downstream(
      subscriber,
      publish,
      Some(subscription),
      target_track,
      context,
    )
    .await;
  });
}

/// SWITCH PR #1378 failure discipline: every post-validation failure still opens
/// the target PUBLISH and immediately closes it with PUBLISH_DONE carrying the
/// status code, on that PUBLISH's own request stream. The PUBLISH carries
/// SWITCH_TRANSITION `{0, 0}` so the subscriber classifies it as switch-related,
/// and Forward State 0 marks it as a failure answer (no data follows); the
/// subscriber keys the outcome off the PUBLISH_DONE status code.
pub(crate) async fn send_switch_failure(
  subscriber: &Arc<MOQTClient>,
  publish_request_id: u64,
  target: &FullTrackName,
  track_alias: u64,
  failure: SwitchFailure,
) {
  let parameters = vec![
    MessageParameter::new_forward(false),
    SwitchTransition::new(0, 0).to_message_parameter(),
  ];
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    track_alias,
    parameters,
    vec![],
  );
  crate::server::events::emit(
    "SWITCH_FAILED",
    serde_json::json!({
      "conn": subscriber.connection_id,
      "track": crate::server::events::track_name_string(target),
      "request_id": publish_request_id,
      "failure": format!("{failure:?}"),
      "status_code": failure.status_code() as u64,
    }),
  );
  let reason = ReasonPhrase::try_new(format!("switch: {failure:?}"))
    .unwrap_or_else(|_| ReasonPhrase::try_new(String::new()).unwrap());
  let done = PublishDone::new(failure.status_code(), 0, reason);

  let (send, recv) = match open_switch_failure_stream(subscriber).await {
    Ok(streams) => streams,
    Err(e) => {
      error!("switch failure: could not open a request stream toward the subscriber: {e:?}");
      return;
    }
  };
  let mut stream = ControlStreamHandler::new(send, recv).with_peer_id(subscriber.connection_id);
  if let Err(e) = stream
    .send(&ControlMessage::Publish(Box::new(publish)))
    .await
  {
    error!("switch failure: failed to send the failure PUBLISH: {e:?}");
    return;
  }
  if let Err(e) = stream
    .send(&ControlMessage::PublishDone(Box::new(done)))
    .await
  {
    error!("switch failure: failed to send PUBLISH_DONE: {e:?}");
    return;
  }
  // FIN, then drain what the subscriber writes back (its PUBLISH_OK / REQUEST_ERROR)
  // until it closes its half; dropping the handler early would reset the stream
  // out from under the two messages just written.
  stream.finish().await;
  tokio::spawn(async move {
    while let Ok(msg) = stream.next_message().await {
      debug!(
        "switch failure stream: ignoring {:?} from the subscriber",
        msg.get_type()
      );
    }
  });
  info!(
    "switch: reported {:?} for {:?} on request {}",
    failure, target, publish_request_id
  );
}

/// Catch-up range `[G_switch, live_edge)`: `None` when the switch lands at or
/// above the live edge (SUBGROUP delivery covers the seam).
pub(crate) fn switch_catchup_range(g_switch: u64, live_edge: u64) -> Option<(Location, Location)> {
  if g_switch >= live_edge {
    return None;
  }
  Some((Location::new(g_switch, 0), Location::new(live_edge - 1, 0)))
}

/// The inclusive end-group bound applied to the source at the seam:
/// `G_switch - 1`, or `None` when nothing exists below Group 0.
pub(crate) fn seam_end_group_bound(g_switch: u64) -> Option<u64> {
  g_switch.checked_sub(1)
}

/// True once the source has delivered everything the cache holds below the
/// seam (`drain_target` is the highest held location below G_switch).
pub(crate) fn drain_complete(
  last_sent: Option<&Location>,
  drain_target: Option<&Location>,
) -> bool {
  match drain_target {
    None => true,
    Some(target) => last_sent.is_some_and(|sent| sent >= target),
  }
}

/// The live subscription the relay attaches to the target after the switch:
/// AbsoluteStart at `(max(G_switch, live_edge), 0)` so the joining replay covers
/// the already-received head of the start group, unbounded above.
pub(crate) fn build_switch_live_sub(
  target_request_id: u64,
  track_namespace: Tuple,
  track_name: TupleField,
  g_switch: u64,
  live_edge: u64,
  parameters: Vec<MessageParameter>,
) -> Subscribe {
  let mut params = parameters;
  params.set_param(MessageParameter::new_forward(true));
  Subscribe::new_absolute_start(
    target_request_id,
    track_namespace,
    track_name,
    Location::new(g_switch.max(live_edge), 0),
    params,
  )
}

/// Deliver `[G_switch, live_edge)` from the target's cache on a FETCH_HEADER
/// stream whose request id is the target PUBLISH's, so the subscriber routes it
/// into the same receiver as the live SUBGROUP objects.
///
/// Snapshot semantics (inherited from `TrackCache::read_objects`): groups that
/// land after the call are not delivered here -- they arrive on the live
/// subscription instead, which starts at the live edge sampled at PUBLISH time.
pub(crate) fn spawn_switch_catchup_stream(
  subscriber: Arc<MOQTClient>,
  target_track: Arc<RwLock<Track>>,
  publish_request_id: u64,
  g_switch: u64,
  live_edge: u64,
  priority: i32,
) {
  let Some((start, end)) = switch_catchup_range(g_switch, live_edge) else {
    return;
  };
  tokio::spawn(async move {
    let (relay_track_id, mut object_rx) = {
      let track = target_track.read().await;
      (
        track.relay_track_id,
        track.cache.read_objects(start, end, false).await,
      )
    };

    let fetch_header = FetchHeader::new(publish_request_id);
    let stream_id = StreamId::new_fetch(relay_track_id, publish_request_id);

    // Open eagerly: the FETCH_HEADER announces the range and the trailing FIN
    // terminates it even when zero objects follow.
    let send_stream = match subscriber
      .open_stream(&stream_id, fetch_header.serialize().unwrap(), priority)
      .await
    {
      Ok(ss) => ss,
      Err(e) => {
        error!("switch catch-up: failed to open stream {stream_id}: {e:?}");
        return;
      }
    };

    let mut prev_ctx: Option<FetchObjectContext> = None;
    let mut object_count: u64 = 0;
    while let Some(event) = object_rx.recv().await {
      match event {
        CacheConsumeEvent::Object(object) => {
          let object_id = object.object_id;
          let fetch_obj = FetchObject::Object(object);
          let serialized = match fetch_obj.serialize(prev_ctx.as_ref(), GroupOrder::Ascending) {
            Ok(b) => b,
            Err(e) => {
              error!("switch catch-up: failed to serialize object {object_id}: {e:?}");
              break;
            }
          };
          prev_ctx = fetch_obj.context();
          if let Err(e) = subscriber
            .write_stream_object(&stream_id, object_id, serialized, Some(send_stream.clone()))
            .await
          {
            error!("switch catch-up: write failed on {stream_id}: {e:?}");
            break;
          }
          object_count += 1;
        }
        CacheConsumeEvent::EndLocation | CacheConsumeEvent::NoObject => {}
      }
    }

    if let Err(e) = subscriber.close_stream(&stream_id).await {
      warn!("switch catch-up: error closing stream {stream_id}: {e:?}");
    }
    info!(
      "switch catch-up: delivered {object_count} objects on {stream_id} for [{g_switch}, {live_edge})"
    );
  });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SelectOutcome {
  /// A qualifying common boundary was identified.
  Ready(u64),
  /// No qualifying boundary materialized before the deadline -- the SWITCH PR's
  /// TIMEOUT ("could not identify G_switch within T_switch").
  TimedOut,
  /// The source subscription was cancelled while waiting; the caller must
  /// answer with the SUBSCRIPTION_ENDED failure.
  Abandoned,
  /// The upstream rejected the target Track while waiting -- the target
  /// genuinely is not available, so the caller answers DOES_NOT_EXIST.
  TargetRejected,
}

/// T_switch-bounded G_switch identification. The O(n) availability scans in
/// `select_switch_group` run only when either cache's availability generation
/// moved; the tick itself bounds abandon/reject/deadline detection.
pub(crate) async fn poll_select_switch_group(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  target_track: &Arc<RwLock<Track>>,
  minimum_switching_group_id: u64,
  current_sub_req_id: u64,
  generation: u64,
  deadline: Instant,
) -> SelectOutcome {
  let mut last_avail: Option<(u64, u64)> = None;
  let mut wait_reported = false;
  loop {
    if subscriber
      .switch_in_flight
      .lock()
      .await
      .is_abandoned(current_sub_req_id, generation)
    {
      return SelectOutcome::Abandoned;
    }
    if matches!(
      target_track.read().await.get_status().await,
      TrackStatus::Rejected { .. }
    ) {
      return SelectOutcome::TargetRejected;
    }
    let avail = (
      current_track.read().await.cache.generation(),
      target_track.read().await.cache.generation(),
    );
    if last_avail != Some(avail) {
      last_avail = Some(avail);
      if let SwitchSelection::Ready(g) =
        select_switch_group(current_track, target_track, minimum_switching_group_id).await
      {
        return SelectOutcome::Ready(g);
      }
      if !wait_reported {
        // The first miss: selection now waits (within T_switch) for the floor
        // or a common boundary to materialise. Said once per switch (P6).
        wait_reported = true;
        let live_edge_current = current_track
          .read()
          .await
          .largest_location
          .read()
          .await
          .group;
        let (target_name, live_edge_target) = {
          let t = target_track.read().await;
          let edge = t.largest_location.read().await.group;
          (t.full_track_name.clone(), edge)
        };
        crate::server::events::emit(
          "SWITCH_WAIT",
          serde_json::json!({
            "conn": subscriber.connection_id,
            "old_request_id": current_sub_req_id,
            "track": crate::server::events::track_name_string(&target_name),
            "floor": minimum_switching_group_id,
            "live_edge_current": live_edge_current,
            "live_edge_target": live_edge_target,
            // floor: the floor is above the target's live edge (a next-group
            // floor naming a group not produced yet); boundary: no common
            // gap-free boundary at or above the floor yet.
            "waiting_for": if minimum_switching_group_id > live_edge_target { "floor" } else { "boundary" },
          }),
        );
      }
    }
    if Instant::now() >= deadline {
      return SelectOutcome::TimedOut;
    }
    tokio::time::sleep(SWITCH_DRAIN_POLL).await;
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainOutcome {
  /// All source Objects in Groups below `g_switch` were delivered. The source
  /// is NOT yet bounded at the seam: the caller must first win the publish
  /// claim and attach the target; [`hand_over_to_target`] then applies the bound.
  Drained,
  /// The drain did not finish within the T_switch deadline; the source is left
  /// unchanged and the caller aborts with TIMEOUT.
  TimedOut,
  /// The source subscription was cancelled mid-drain; the source is left
  /// unchanged and the caller answers SUBSCRIPTION_ENDED.
  Abandoned,
}

/// Wait until the source has delivered everything below G_switch (or the
/// deadline / an abandon).
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
    return DrainOutcome::Drained;
  };

  let mut drain_target: Option<Location> = None;
  let mut last_avail: Option<u64> = None;
  loop {
    if subscriber
      .switch_in_flight
      .lock()
      .await
      .is_abandoned(current_sub_req_id, generation)
    {
      return DrainOutcome::Abandoned;
    }
    {
      let track = current_track.read().await;
      let avail = track.cache.generation();
      if last_avail != Some(avail) {
        last_avail = Some(avail);
        drain_target = track.cache.max_location_below_group(g_switch).await;
      }
    }
    let drained = {
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

/// Bound the source at the seam so it does not forward Groups >= G_switch
/// concurrently with the target before teardown. Applied only after the target
/// is attached (`hand_over_to_target`), so it is never undone.
pub(crate) async fn apply_seam_bound(
  current_track: &Arc<RwLock<Track>>,
  connection_id: usize,
  g_switch: u64,
) {
  let Some(bound) = seam_end_group_bound(g_switch) else {
    return;
  };
  let Some(sub_arc) = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await
  else {
    return;
  };
  let sub = sub_arc.read().await;
  sub.subscription_state.write().await.end_group = Some(bound);
}

/// Close-After-Switch: drop the relay's state for the replaced subscription
/// FIRST, then tell the subscriber with PUBLISH_DONE(SUBSCRIPTION_ENDED) on that
/// subscription's request stream. State goes first because the subscriber may
/// react to the PUBLISH_DONE at once (e.g. another SWITCH naming this Request
/// ID), and a stale entry would let that pass the Established gate.
pub(crate) async fn terminate_source(
  subscriber: &Arc<MOQTClient>,
  current_track: &Arc<RwLock<Track>>,
  current_full_track_name: &FullTrackName,
  connection_id: usize,
  current_sub_req_id: u64,
  g_switch: u64,
) {
  let sub_arc = current_track
    .read()
    .await
    .get_subscription(connection_id)
    .await;

  subscriber
    .subscribe_requests
    .write()
    .await
    .remove(&current_sub_req_id);
  subscriber
    .inbound_requests
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
    // Reset the replaced subscription's data streams instead of finishing them.
    // A finish is a FIN: QUIC delivers everything already queued on the stream.
    // Above the seam that queue is the old track's backlog, which the subscriber
    // will discard and which starved the target's streams (delivery diagnostic,
    // 2026-09-29: 78 of 222 groups cut on the wire): reset those. Below the seam
    // it is media the subscriber will play before it reaches the seam (a
    // deep-buffer subscriber on a saturated link has a group or two in flight):
    // finish those.
    let streams = sub.opened_stream_count();
    crate::server::events::emit(
      "SWITCH_SOURCE_RESET",
      serde_json::json!({
        "conn": connection_id,
        "request_id": current_sub_req_id,
        "track": crate::server::events::track_name_string(current_full_track_name),
        "streams_opened": streams,
        "seam_group": g_switch,
      }),
    );
    // Streams at/above the seam are reset; streams below it finish and deliver.
    sub.cancel_from_group(g_switch).await;
  }
}

/// Attaches the target subscription for `live_sub` to `target_track`. `None`
/// when it cannot be attached (the connection already holds a subscription on
/// the target). The attached subscription forwards nothing until its PUBLISH
/// has gone out (`mark_alias_announced` in `forward_publish_downstream`).
pub(crate) async fn attach_switch_target(
  subscriber: &Arc<MOQTClient>,
  target_track: &Arc<RwLock<Track>>,
  live_sub: Subscribe,
) -> Option<Arc<RwLock<Subscription>>> {
  let track = target_track.read().await;
  match track
    .add_subscription(subscriber.clone(), live_sub, false)
    .await
  {
    Ok(subscription) => {
      subscriber
        .subscriptions
        .add_subscription(track.full_track_name.clone(), Arc::downgrade(&subscription))
        .await;
      Some(subscription)
    }
    Err(_) => None,
  }
}

/// The hand-over from the source to the target once the publish claim is won,
/// attach first (audit M6): the target subscription is attached, then the source
/// is bounded at the seam and ended (Close-After-Switch). `None` = the target
/// could not be attached; nothing has touched the source then, so the
/// PublishBuildFailed answer's "current subscription untouched" holds.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn hand_over_to_target(
  subscriber: &Arc<MOQTClient>,
  target_track: &Arc<RwLock<Track>>,
  live_sub: Subscribe,
  current_track: &Arc<RwLock<Track>>,
  current_full_track_name: &FullTrackName,
  current_sub_req_id: u64,
  g_switch: u64,
) -> Option<Arc<RwLock<Subscription>>> {
  let connection_id = subscriber.connection_id;
  let subscription = attach_switch_target(subscriber, target_track, live_sub).await?;
  // Bound the source at the seam so it forwards no Group >= G_switch while it
  // is being ended, then end it.
  apply_seam_bound(current_track, connection_id, g_switch).await;
  terminate_source(
    subscriber,
    current_track,
    current_full_track_name,
    connection_id,
    current_sub_req_id,
    g_switch,
  )
  .await;
  Some(subscription)
}

#[cfg(test)]
mod tests_switch_seam_helpers {
  use super::*;
  use crate::server::subscription::{SubscriptionOrigin, SubscriptionState};
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
    // Under a u64 encoding the bound for G_switch == 1 was written as 0, which
    // the forwarding filter read as "no limit" -- the source leaked Groups >= 1
    // across the seam while the target delivered the same groups via catch-up.
    assert_eq!(seam_end_group_bound(1), Some(0));
  }

  #[test]
  fn seam_bound_for_g_switch_zero_is_unbounded() {
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
    assert!(drain_complete(None, None));
    assert!(drain_complete(Some(&loc(9, 9)), None));
  }

  #[test]
  fn mid_group_tail_holds_the_drain() {
    assert!(!drain_complete(Some(&loc(4, 3)), Some(&loc(4, 7))));
    assert!(drain_complete(Some(&loc(4, 7)), Some(&loc(4, 7))));
  }

  #[test]
  fn shared_hole_below_seam_converges() {
    assert!(drain_complete(Some(&loc(2, 5)), Some(&loc(2, 5))));
    assert!(!drain_complete(Some(&loc(2, 4)), Some(&loc(2, 5))));
  }

  #[test]
  fn drain_complete_when_source_already_past_seam() {
    assert!(drain_complete(Some(&loc(7, 2)), Some(&loc(4, 9))));
  }

  // ---- switch_catchup_range ----

  #[test]
  fn catchup_range_is_half_open() {
    assert_eq!(switch_catchup_range(2, 6), Some((loc(2, 0), loc(5, 0))));
  }

  #[test]
  fn catchup_skipped_at_or_above_live_edge() {
    assert_eq!(switch_catchup_range(6, 6), None);
    assert_eq!(switch_catchup_range(7, 6), None);
  }

  #[test]
  fn catchup_range_at_live_edge_one_does_not_underflow() {
    assert_eq!(switch_catchup_range(0, 1), Some((loc(0, 0), loc(0, 0))));
  }

  // ---- switch_catchup_priority ----

  #[test]
  fn catchup_priority_outranks_every_live_group_of_the_target() {
    // The target's live subgroup streams carry groups >= the live edge > G_switch,
    // in the same (sub, pub) band.
    for pub_prio in [0u8, 1, 4, 128, 255] {
      let catchup = switch_catchup_priority(0, GroupOrder::Ascending, pub_prio, 10);
      for group in [11u64, 12, 100, 65_535] {
        assert!(catchup > compute_stream_priority(0, pub_prio, GroupOrder::Ascending, group));
      }
    }
  }

  #[test]
  fn catchup_priority_respects_the_subscriber_band() {
    // A higher-priority subscriber (lower value) keeps outranking the
    // catch-up of a lower-priority one.
    assert!(
      compute_stream_priority(0, 255, GroupOrder::Ascending, 65_535)
        > switch_catchup_priority(128, GroupOrder::Ascending, 0, 0)
    );
  }

  /// P3 (audit M6): the catch-up [G_switch, live_edge) plays after the source's
  /// groups below G_switch, so the source remainder (same subscriber band after
  /// C3, uniform publisher priority) must outrank it.
  #[test]
  fn catchup_ranks_below_the_source_remainder_and_above_the_target_live_groups() {
    let (sub, publisher, g_switch, live_edge) = (0u8, 128u8, 10u64, 12u64);
    let catchup = switch_catchup_priority(sub, GroupOrder::Ascending, publisher, g_switch);
    assert!(
      catchup < compute_stream_priority(sub, publisher, GroupOrder::Ascending, g_switch - 1),
      "the source's group below the seam must go first"
    );
    assert!(catchup > compute_stream_priority(sub, publisher, GroupOrder::Ascending, live_edge));
    assert_eq!(
      catchup,
      compute_stream_priority(sub, publisher, GroupOrder::Ascending, g_switch)
    );
  }

  #[test]
  fn switch_parameters_win_and_the_replaced_subscription_fills_the_rest() {
    let carried = vec![
      MessageParameter::new_subscriber_priority(0),
      MessageParameter::new_group_order(GroupOrder::Descending),
    ];
    assert_eq!(
      switch_scheduling(&carried, (128, GroupOrder::Ascending)),
      (0, GroupOrder::Descending)
    );
    assert_eq!(
      switch_scheduling(&[], (7, GroupOrder::Ascending)),
      (7, GroupOrder::Ascending)
    );
  }

  // ---- switch_target_parameters ----

  #[test]
  fn target_parameters_drop_relay_owned_fields() {
    let raw: Vec<moqtail::model::common::pair::KeyValuePair> = vec![
      MessageParameter::new_forward(false).try_into().unwrap(),
      MessageParameter::new_delay_groups(3).try_into().unwrap(),
      MessageParameter::new_largest_object(loc(9, 9))
        .try_into()
        .unwrap(),
    ];
    let params = switch_target_parameters(&raw, (0, GroupOrder::Ascending));
    assert_eq!(
      params,
      vec![
        MessageParameter::new_delay_groups(3),
        MessageParameter::new_subscriber_priority(0),
        MessageParameter::new_group_order(GroupOrder::Ascending),
      ]
    );
  }

  // ---- build_switch_live_sub ----

  #[test]
  fn live_sub_starts_at_live_edge_when_seam_below_edge() {
    let sub = build_switch_live_sub(42, namespace(), track_name(), 3, 7, Vec::new());
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    assert_eq!(state.start_location, Some(loc(7, 0)));
  }

  #[test]
  fn live_sub_starts_at_g_switch_when_seam_above_edge() {
    let sub = build_switch_live_sub(42, namespace(), track_name(), 9, 7, Vec::new());
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    assert_eq!(state.start_location, Some(loc(9, 0)));
  }

  #[test]
  fn live_sub_uses_absolute_start_and_engages_joining_replay() {
    let sub = build_switch_live_sub(42, namespace(), track_name(), 3, 7, Vec::new());
    assert_eq!(sub.request_id, 42);
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    assert!(matches!(state.filter_type, FilterType::AbsoluteStart));
    assert_eq!(state.end_group, None, "live sub must be unbounded");
    assert!(state.forward);
    assert!(
      state.is_joining,
      "AbsoluteStart must set is_joining so the cache replay covers the \
       already-received head of the start group"
    );
  }
}

/// P4 (audit M6): the hand-over attaches the target before it ends the source,
/// so a target that cannot be attached leaves the source exactly as it was.
#[cfg(test)]
mod tests_switch_hand_over {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, quic_pair, relay_client, subscribe, test_track,
  };

  fn latest(request_id: u64, track: &str) -> Subscribe {
    Subscribe::new_latest_object(
      request_id,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8(track),
      vec![MessageParameter::new_forward(true)],
    )
  }

  fn live_sub(request_id: u64) -> Subscribe {
    build_switch_live_sub(
      request_id,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      4,
      6,
      vec![],
    )
  }

  #[tokio::test]
  async fn a_target_that_cannot_be_attached_leaves_the_source_untouched() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(61, server);
    let current = Arc::new(RwLock::new(test_track(1, "video-360p")));
    let target = Arc::new(RwLock::new(test_track(2, "video-720p")));
    subscribe(
      &*current.read().await,
      &client,
      latest(1, "video-360p"),
      false,
    )
    .await;
    // The connection already holds the target track: the attach fails.
    subscribe(
      &*target.read().await,
      &client,
      latest(3, "video-720p"),
      false,
    )
    .await;
    let name = current.read().await.full_track_name.clone();

    let out = hand_over_to_target(&client, &target, live_sub(5), &current, &name, 1, 4).await;

    assert!(out.is_none(), "the attach must fail");
    let source = current
      .read()
      .await
      .get_subscription(61)
      .await
      .expect("the source must still be attached");
    let source = source.read().await;
    assert!(!source.is_finished().await, "the source must not be ended");
    assert_eq!(
      source.subscription_state.read().await.end_group,
      None,
      "the source must not be bounded at the seam"
    );
    assert!(client.subscriptions.get_subscription(&name).await.is_some());
  }

  #[tokio::test]
  async fn a_hand_over_attaches_the_target_and_ends_the_source() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(62, server);
    let current = Arc::new(RwLock::new(test_track(1, "video-360p")));
    let target = Arc::new(RwLock::new(test_track(2, "video-720p")));
    let source = subscribe(
      &*current.read().await,
      &client,
      latest(1, "video-360p"),
      false,
    )
    .await;
    let name = current.read().await.full_track_name.clone();

    let out = hand_over_to_target(&client, &target, live_sub(5), &current, &name, 1, 4).await;

    let attached = out.expect("the target must be attached");
    assert_eq!(attached.read().await.request_id, 5);
    assert!(target.read().await.get_subscription(62).await.is_some());
    assert!(current.read().await.get_subscription(62).await.is_none());
    assert!(source.read().await.is_finished().await);
  }
}

/// P3 (R3-D2/D6): the failure PUBLISH's request stream is a control-priority
/// stream from its first byte (it used to open at quinn's default 0, below every
/// video stream of a priority-0 subscriber).
#[cfg(test)]
mod tests_switch_failure_stream {
  use super::*;
  use crate::server::test_support::{quic_pair, relay_client};
  use moqtail::transport::connection::CONTROL_STREAM_PRIORITY;

  #[tokio::test]
  async fn the_failure_publish_stream_opens_at_the_control_priority() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(71, server);
    let (send, _recv) = open_switch_failure_stream(&client).await.expect("open");
    assert_eq!(send.priority(), Some(CONTROL_STREAM_PRIORITY));
  }
}

/// P6: selection that waits for the floor says so (SWITCH_WAIT) instead of a
/// silent wait that ends in a TIMEOUT indistinguishable from the others.
#[cfg(test)]
mod tests_switch_wait {
  use super::*;
  use crate::server::test_support::{publish, quic_pair, relay_client, test_track};

  #[tokio::test]
  async fn a_floor_above_the_live_edge_emits_switch_wait_once_then_times_out() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(81, server);
    let current = test_track(1, "video-360p");
    let target = test_track(2, "video-720p");
    for g in 0..=4 {
      publish(&current, g, 0).await;
      publish(&target, g, 0).await;
    }
    let current = Arc::new(RwLock::new(current));
    let target = Arc::new(RwLock::new(target));
    let outcome = poll_select_switch_group(
      &client,
      &current,
      &target,
      9,
      1,
      0,
      Instant::now() + Duration::from_millis(200),
    )
    .await;
    assert_eq!(outcome, SelectOutcome::TimedOut);
    let waits = crate::server::events::test_capture::records("SWITCH_WAIT", 81);
    assert_eq!(waits.len(), 1, "{waits:?}");
    let w = &waits[0];
    assert_eq!(w["floor"], 9);
    assert_eq!(w["live_edge_current"], 4);
    assert_eq!(w["live_edge_target"], 4);
    assert_eq!(w["old_request_id"], 1);
    assert_eq!(w["track"], "moqtail/video-720p");
  }

  #[tokio::test]
  async fn a_ready_floor_emits_no_switch_wait() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(82, server);
    let current = test_track(1, "video-360p");
    let target = test_track(2, "video-720p");
    for g in 0..=4 {
      publish(&current, g, 0).await;
      publish(&target, g, 0).await;
    }
    let current = Arc::new(RwLock::new(current));
    let target = Arc::new(RwLock::new(target));
    let outcome = poll_select_switch_group(
      &client,
      &current,
      &target,
      3,
      1,
      0,
      Instant::now() + Duration::from_millis(200),
    )
    .await;
    assert_eq!(outcome, SelectOutcome::Ready(3));
    assert!(crate::server::events::test_capture::records("SWITCH_WAIT", 82).is_empty());
  }
}
