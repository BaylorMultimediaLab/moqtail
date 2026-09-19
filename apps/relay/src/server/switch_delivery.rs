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
use moqtail::model::data::constant::DEFAULT_PUBLISHER_PRIORITY;
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

/// QUIC send priority for the catch-up FETCH_HEADER stream. Subgroup streams
/// are scheduled in per-(subscriber priority, publisher priority) bands with
/// lower group ids ranking higher (`compute_stream_priority`); the catch-up
/// range precedes every live group of the target, so it takes the top of the
/// highest publisher band for this subscriber -- the draft's SHOULD that the
/// catch-up outrank the target's concurrent SUBGROUP streams.
pub(crate) fn switch_catchup_priority(subscriber_priority: u8) -> i32 {
  compute_stream_priority(subscriber_priority, 0, GroupOrder::Ascending, 0)
}

/// The subscriber priority a switch's target subscription runs at: the SWITCH's
/// own SUBSCRIBER_PRIORITY parameter, else the protocol default.
pub(crate) fn switch_subscriber_priority(params: &[MessageParameter]) -> u8 {
  params
    .iter()
    .find_map(|p| match p {
      MessageParameter::SubscriberPriority { priority } => Some(*priority),
      _ => None,
    })
    .unwrap_or(128)
}

/// Deserialize a SWITCH's raw parameter list into typed message parameters,
/// dropping anything unknown: per SWITCH PR #1378 this set IS the complete
/// parameter set for the target PUBLISH (nothing is inherited from the current
/// subscription), and the transport-level fields the relay owns (Forward,
/// LargestObject, the SubscriptionFilter, SWITCH_TRANSITION) are restated by the
/// relay below, never taken from the subscriber.
pub(crate) fn switch_target_parameters(
  raw: &[moqtail::model::common::pair::KeyValuePair],
) -> Vec<MessageParameter> {
  raw
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
    .collect()
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

  let (send, recv) = match subscriber.connection.open_bi().await {
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
    }
    if Instant::now() >= deadline {
      return SelectOutcome::TimedOut;
    }
    tokio::time::sleep(SWITCH_DRAIN_POLL).await;
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SeamBoundUndo {
  pub prior_end_group: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainOutcome {
  /// All source Objects in Groups below `g_switch` were delivered. The source
  /// is NOT yet bounded at the seam: the caller must first win the publish
  /// claim and only then apply the bound via [`apply_seam_bound`].
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
/// concurrently with the target before teardown.
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
    sub.finish().await;
  }
}

/// The publisher priority the relay assumes for a track's objects; kept so the
/// catch-up priority doc above has a single source of truth for the default.
#[allow(dead_code)]
pub(crate) const CATCHUP_DEFAULT_PUBLISHER_PRIORITY: u8 = DEFAULT_PUBLISHER_PRIORITY;

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
    // The live subgroup streams of the target sit in the (sub, pub) band with
    // group ids >= 0; the catch-up takes the top of the pub=0 band, which is
    // at or above every band value a live stream can get.
    for pub_prio in [0u8, 1, 4, 128, 255] {
      for group in [0u64, 1, 100, 65_535] {
        assert!(
          switch_catchup_priority(128)
            >= compute_stream_priority(128, pub_prio, GroupOrder::Ascending, group)
        );
      }
    }
  }

  #[test]
  fn catchup_priority_respects_the_subscriber_band() {
    // A higher-priority subscriber (lower value) keeps outranking the
    // catch-up of a lower-priority one.
    assert!(
      compute_stream_priority(0, 255, GroupOrder::Ascending, 65_535) > switch_catchup_priority(128)
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
    let params = switch_target_parameters(&raw);
    assert_eq!(params, vec![MessageParameter::new_delay_groups(3)]);
    assert_eq!(switch_subscriber_priority(&params), 128);
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
