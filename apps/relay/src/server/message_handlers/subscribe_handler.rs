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

use crate::server::client::MOQTClient;
use crate::server::events;
use crate::server::message_handlers::parameters;
use crate::server::session::Session;
use crate::server::session_context::{PendingRequest, SessionContext};
use crate::server::stream_id::StreamId;
use crate::server::track::{Track, TrackOrigin, TrackStatus, await_publisher_streams};
use bytes::Bytes;
use core::result::Result;
use moqtail::model::common::location::Location;
use moqtail::model::control::constant::FilterType;
use moqtail::model::control::constant::PublishDoneStatusCode;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::control::request_error::RequestError;
use moqtail::model::control::request_ok::RequestOk;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::control::subscribe_ok::SubscribeOk;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::model::error::RequestErrorCode;
use moqtail::model::error::StreamResetCode;
use moqtail::model::error::TerminationCode;
use moqtail::model::parameter::message_parameter::{
  MessageParameter, MessageParameterVecExt, apply_message_parameter_update,
};
use moqtail::model::property::track_property::has_unsupported_mandatory;
use moqtail::model::{
  common::reason_phrase::ReasonPhrase, control::control_message::ControlMessage,
};
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use moqtail::transport::data_stream_handler::SubscribeRequest;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::oneshot;
use tracing::{debug, error, info, warn};

/// Search a SUBSCRIBE message's parameters for the project-local DELAY_GROUPS
/// parameter. Returns the first match's value, or None if not present.
///
/// Used by the SUBSCRIBE handler when computing a delay-mode start location:
/// the relay puts a filtered client `delay_groups` behind the live edge.
fn parse_delay_groups(params: &[MessageParameter]) -> Option<u64> {
  params.iter().find_map(|p| match p {
    MessageParameter::DelayGroups { groups } => Some(*groups),
    _ => None,
  })
}

/// The relay's decision after applying a `DELAY_GROUPS` parameter to a SUBSCRIBE.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DelayedStart {
  /// The requested target is in-window; deliver from this location.
  Ready(Location),
  /// The requested target predates the cache; deliver from the oldest available.
  ClampedToOldest(Location),
  /// `largest_location.group < delay_groups` (stream too young) -- register the
  /// subscribe in a pending state and resolve once the live edge advances.
  Hold { delay_groups: u64 },
}

/// Decide what start_location a delayed (filtered) SUBSCRIBE should use.
///
/// Pure function: no I/O, no async, no side effects. Inputs are the relay's
/// current view of the live edge (`largest`), the delay the client requested
/// (`delay_groups`), and the oldest group currently in the cache (or None
/// if the relay hasn't started caching yet).
pub(crate) fn compute_delayed_start(
  largest: Option<Location>,
  delay_groups: u64,
  oldest_cached_group: Option<u64>,
) -> DelayedStart {
  let Some(largest_loc) = largest else {
    return DelayedStart::Hold { delay_groups };
  };
  if largest_loc.group < delay_groups {
    return DelayedStart::Hold { delay_groups };
  }
  let target_group = largest_loc.group - delay_groups;
  let target = Location {
    group: target_group,
    object: 0,
  };
  if let Some(oldest) = oldest_cached_group
    && target_group < oldest
  {
    return DelayedStart::ClampedToOldest(Location {
      group: oldest,
      object: 0,
    });
  }
  DelayedStart::Ready(target)
}

// Synthetic-probe track aliases live well above any plausible relay-assigned
// alias so they can't collide with real video tracks. Per IETF 119 MoQ
// bandwidth-measurement slides, a subscriber can request a one-shot payload of
// arbitrary size by subscribing to `.probe:<size>:<priority>`.
//
// QUIC varints (RFC 9000 §16) can only encode values up to 2^62 - 1, so the
// alias must stay below that. 2^60 is far above any plausible relay track id
// and well within varint range.
const PROBE_ALIAS_BASE: u64 = 1u64 << 60;
static PROBE_ALIAS_COUNTER: AtomicU64 = AtomicU64::new(0);
const PROBE_MAX_SIZE: usize = 16 * 1024 * 1024;
// Per-object chunk size. WebTransport's read() returns once per MoQ object,
// so the receiver only sees inter-arrival timing if the probe is split into
// multiple objects. 4 KB ≈ a few MTU-sized packets per object -- small
// enough to give SWMA-style timing samples, large enough that overhead
// per object is negligible.
const PROBE_CHUNK_SIZE: usize = 4096;

/// Parse `.probe:<size>:<priority>` from a track-name byte slice.
/// Returns `(size_bytes, priority_byte)` on match.
fn parse_probe_track_name(name_bytes: &[u8]) -> Option<(usize, u8)> {
  let s = std::str::from_utf8(name_bytes).ok()?;
  let rest = s.strip_prefix(".probe:")?;
  let mut parts = rest.splitn(3, ':');
  let size: usize = parts.next()?.parse().ok()?;
  let priority: u8 = parts.next()?.parse().ok()?;
  if parts.next().is_some() {
    return None;
  }
  if size == 0 || size > PROBE_MAX_SIZE {
    return None;
  }
  Some((size, priority))
}

/// Synthesize one object of `size` bytes for a `.probe:` SUBSCRIBE.
///
/// Bypasses the normal publisher lookup, track_manager registration, and
/// switch-context tracking -- the probe is a pure relay-side artifact and
/// must never collide with real-track state. The relay sends SubscribeOk
/// (which teaches the client a synthetic track_alias), opens a uni stream
/// with a SubgroupHeader, writes `size` zero bytes as a run of
/// SubgroupObjects, and closes the stream.
async fn handle_probe_subscribe(
  client: Arc<MOQTClient>,
  control_stream_handler: &mut ControlStreamHandler,
  sub: Subscribe,
  size: usize,
  probe_priority: u8,
) -> Result<(), TerminationCode> {
  info!(
    "synthetic probe: request_id={} size={} priority={}",
    sub.request_id, size, probe_priority
  );
  events::emit(
    "PROBE",
    serde_json::json!({
      "conn": client.connection_id,
      "request_id": sub.request_id,
      "size": size,
      "priority": probe_priority,
    }),
  );

  // Allocate a unique synthetic alias. PROBE_ALIAS_BASE puts these in a
  // range no real track would ever get.
  let track_alias = PROBE_ALIAS_BASE + PROBE_ALIAS_COUNTER.fetch_add(1, Ordering::Relaxed);

  // SubscribeOk first so the client maps track_alias before any data lands.
  let subscribe_ok = SubscribeOk::new(
    track_alias,
    vec![MessageParameter::new_largest_object(Location::new(0, 0))],
    vec![],
  );
  if let Err(e) = control_stream_handler.send_impl(&subscribe_ok).await {
    warn!("probe: failed to send SubscribeOk: {:?}", e);
    return Ok(());
  }

  // Translate slide convention (priority byte: 0=low, non-zero=high) to MoQ
  // publisher_priority (lower numeric = higher priority). 0 → 255 (lowest).
  let pub_priority: u8 = if probe_priority == 0 { 255 } else { 0 };

  let header = SubgroupHeader::new_with_explicit_id(
    track_alias,
    0,                  // group_id
    0,                  // subgroup_id
    Some(pub_priority), // publisher_priority
    false,              // has_properties
    true,               // contains_end_of_group -- single-subgroup group
    true,               // first_object -- the stream starts at object 0
  );

  let header_bytes = match header.serialize(Some(track_alias)) {
    Ok(b) => b,
    Err(e) => {
      warn!("probe: failed to serialize header: {:?}", e);
      return Ok(());
    }
  };

  let stream_id = StreamId::new_subgroup(track_alias, 0, Some(0));

  // Stream-scheduling priority 0 -- yield to real video under congestion.
  let send_stream = match client.open_stream(&stream_id, header_bytes, 0).await {
    Ok(s) => s,
    Err(e) => {
      warn!("probe: failed to open stream: {:?}", e);
      return Ok(());
    }
  };

  // The probe is one finite group on one stream: tell the subscriber so on
  // the request stream now (draft-18 PUBLISH_DONE with Stream Count 1). The
  // subscriber then ends the subscription itself once that stream completes
  // instead of cancelling it while probe data may still be in flight.
  let done = PublishDone::new(
    PublishDoneStatusCode::TrackEnded,
    1,
    ReasonPhrase::try_new("probe complete".to_string()).unwrap(),
  );
  if let Err(e) = control_stream_handler.send_impl(&done).await {
    warn!("probe: failed to send PUBLISH_DONE: {:?}", e);
  }

  // Split the probe payload across multiple SubgroupObjects so the client
  // sees several read() events on one stream and can compute inter-arrival
  // throughput (SWMA-style) rather than a single point sample.
  let mut bytes_remaining = size;
  let mut object_id: u64 = 0;
  let mut prev_object_id: Option<u64> = None;
  while bytes_remaining > 0 {
    let chunk = std::cmp::min(bytes_remaining, PROBE_CHUNK_SIZE);
    let payload = Bytes::from(vec![0u8; chunk]);
    let sub_object = SubgroupObject {
      object_id,
      properties: None,
      object_status: None,
      payload: Some(payload),
    };
    let object_bytes = match sub_object.serialize(prev_object_id, false) {
      Ok(b) => b,
      Err(e) => {
        warn!("probe: failed to serialize chunk {}: {:?}", object_id, e);
        let _ = client.close_stream(&stream_id).await;
        return Ok(());
      }
    };
    if let Err(e) = client
      .write_stream_object(
        &stream_id,
        object_id,
        object_bytes,
        Some(send_stream.clone()),
      )
      .await
    {
      warn!("probe: failed to write chunk {}: {:?}", object_id, e);
      break;
    }
    prev_object_id = Some(object_id);
    object_id += 1;
    bytes_remaining -= chunk;
  }

  let _ = client.close_stream(&stream_id).await;

  info!(
    "synthetic probe: completed alias={} size={} priority={}",
    track_alias, size, pub_priority
  );
  Ok(())
}

async fn add_subscription(
  subscribe: Subscribe,
  track: &Track,
  subscriber: Arc<MOQTClient>,
  is_switch: bool,
) -> bool {
  match track
    .add_subscription(subscriber.clone(), subscribe, is_switch)
    .await
  {
    Ok(subscription) => {
      subscriber
        .subscriptions
        .add_subscription(track.full_track_name.clone(), Arc::downgrade(&subscription))
        .await;
      true
    }
    Err(_) => false, // error already logged in add_subscription and it means that subscription already exists
  }
}

/// Forward a SUBSCRIBE to the upstream publisher on its own bidirectional request
/// stream, then read the response (and follow-ups) on that stream and dispatch
/// them so the result fans out to the downstream subscribers.
async fn forward_subscribe_upstream(
  publisher: Arc<MOQTClient>,
  new_sub: Subscribe,
  context: Arc<SessionContext>,
) {
  let relay_request_id = new_sub.request_id;
  upstream_subscribe_exchange(publisher, new_sub, context.clone()).await;

  // The entry exists to resolve this publisher's response against, and the exchange
  // has ended one way or another: answered, declined, timed out, cancelled, or never
  // sent. Dropping it here covers every exit inside, several of which return early.
  context
    .relay_pending_requests
    .write()
    .await
    .remove(&relay_request_id);
}

async fn upstream_subscribe_exchange(
  publisher: Arc<MOQTClient>,
  new_sub: Subscribe,
  context: Arc<SessionContext>,
) {
  let (send, recv) = match publisher.connection.open_bi().await {
    Ok(streams) => streams,
    Err(e) => {
      error!("Failed to open upstream subscribe stream: {:?}", e);
      return;
    }
  };
  // The response returns on this stream, so correlate it by the relay request id
  // we sent upstream rather than a field in the response.
  let relay_request_id = new_sub.request_id;
  let full_track_name = new_sub.get_full_track_name();
  let mut upstream = ControlStreamHandler::new(send, recv).with_peer_id(publisher.connection_id);
  if let Err(e) = upstream
    .send(&ControlMessage::Subscribe(Box::new(new_sub)))
    .await
  {
    error!("Failed to send upstream SUBSCRIBE: {:?}", e);
    return;
  }

  // Register a cancel signal on the track so the last downstream unsubscribe
  // resets this upstream stream and the publisher observes CANCELLED.
  let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
  if let Some(track) = context.track_manager.get_track(&full_track_name).await {
    track
      .read()
      .await
      .upstream_subscribe_cancellers
      .lock()
      .await
      .push(cancel_tx);
  }

  // A publisher owes exactly one SUBSCRIBE_OK or REQUEST_ERROR. One that stays
  // connected and sends neither would otherwise hold the subscriber's request stream
  // open forever, and — where several publishers were asked — keep the others' answers
  // from ever being acted on. The deadline only covers that first response; once it
  // arrives the stream lives as long as the subscription does.
  let answer_deadline = tokio::time::sleep(context.server_config.upstream_subscribe_timeout);
  tokio::pin!(answer_deadline);
  let mut answered = false;

  loop {
    tokio::select! {
      biased;
      _ = &mut cancel_rx => {
        info!("Downstream unsubscribed; resetting upstream subscribe stream (CANCELLED)");
        // Break and tear the stream down after the loop: `reset_and_stop`
        // consumes `upstream`, which can't be moved inside the select while the
        // `next_message()` branch borrows it. Reset the send half and stop the
        // recv half with the same CANCELLED code, so the publisher sees a
        // coherent cancellation on both halves rather than a STOP_SENDING(0)
        // (InternalError) emitted when the handler is dropped.
        break;
      }
      _ = &mut answer_deadline, if !answered => {
        warn!(
          "Publisher {} did not answer the SUBSCRIBE for {:?} in time; treating it as declined",
          publisher.connection_id, full_track_name
        );
        let err = RequestError::new(
          RequestErrorCode::Timeout,
          0,
          ReasonPhrase::try_new("Publisher did not answer the subscribe".to_string()).unwrap(),
        );
        end_upstream_subscription(
          relay_request_id,
          publisher.connection_id,
          &full_track_name,
          err,
          PublishDoneStatusCode::InternalError,
          context.clone(),
        )
        .await;
        break;
      }
      msg = upstream.next_message() => {
        answered = true;
        match msg {
          Ok(ControlMessage::SubscribeOk(m)) => {
            if let Err(e) =
              handle_subscribe_ok_message(publisher.clone(), relay_request_id, *m, context.clone())
                .await
            {
              error!("Error handling upstream SubscribeOk: {:?}", e);
              return;
            }
          }
          Ok(ControlMessage::RequestError(m)) => {
            let status = publish_done_status_for(m.error_code);
            end_upstream_subscription(
              relay_request_id,
              publisher.connection_id,
              &full_track_name,
              *m,
              status,
              context.clone(),
            )
            .await;
            return;
          }
          Ok(ControlMessage::PublishDone(m)) => {
            // Upstream is done for this track; relay its PUBLISH_DONE (status and
            // reason verbatim) to the downstream subscribers. It usually arrives
            // coalesced with the upstream stream FIN.
            info!(
              "Upstream PUBLISH_DONE for {:?}: status={:?} reason={}",
              full_track_name,
              m.status_code,
              m.reason_phrase.as_str()
            );
            if let Some(track) = context.track_manager.get_track(&full_track_name).await {
              // The message overtakes the data streams it accounts for, so hold it
              // until its Stream Count of them has finished arriving. Passing it on
              // first closes the downstream streams mid-object and understates the
              // Stream Count the relay reports in turn.
              await_publisher_streams(
                &track,
                publisher.connection_id,
                m.stream_count,
                context.server_config.publish_done_stream_timeout,
              )
              .await;

              if let Err(e) = track
                .read()
                .await
                .notify_publish_done(m.status_code, m.reason_phrase.as_str().to_string())
                .await
              {
                error!("Failed to relay upstream PUBLISH_DONE downstream: {:?}", e);
              }
            }
            return;
          }
          Ok(other) => {
            warn!("Unexpected {:?} on upstream subscribe stream", other.get_type());
            let err = RequestError::new(
              RequestErrorCode::InternalError,
              0,
              ReasonPhrase::try_new("Unexpected message on upstream subscription stream".to_string()).unwrap(),
            );
            // Nothing about the track changed; the pipeline misbehaved.
            end_upstream_subscription(
              relay_request_id,
              publisher.connection_id,
              &full_track_name,
              err,
              PublishDoneStatusCode::InternalError,
              context.clone(),
            )
            .await;
            return;
          }
          Err(code) => {
            warn!("Upstream subscribe stream closed with error; resetting: {:?}", code);
            let err = RequestError::new(
              RequestErrorCode::InternalError,
              0,
              ReasonPhrase::try_new("Upstream subscription failed".to_string()).unwrap(),
            );
            // The upstream stream is gone, so the track is no longer being published.
            end_upstream_subscription(
              relay_request_id,
              publisher.connection_id,
              &full_track_name,
              err,
              PublishDoneStatusCode::TrackEnded,
              context.clone(),
            )
            .await;
            return;
          }
        }
      }
    }
  }

  upstream.reset_and_stop(StreamResetCode::Cancelled.to_u64());
}

/// The PUBLISH_DONE status that carries an upstream REQUEST_ERROR downstream. Only a few
/// of the two registries line up; the rest are a generic failure as far as a subscriber
/// is concerned.
fn publish_done_status_for(error_code: RequestErrorCode) -> PublishDoneStatusCode {
  match error_code {
    RequestErrorCode::Unauthorized => PublishDoneStatusCode::Unauthorized,
    RequestErrorCode::GoingAway => PublishDoneStatusCode::GoingAway,
    RequestErrorCode::MalformedTrack => PublishDoneStatusCode::MalformedTrack,
    RequestErrorCode::ExcessiveLoad => PublishDoneStatusCode::ExcessiveLoad,
    RequestErrorCode::DoesNotExist => PublishDoneStatusCode::TrackEnded,
    _ => PublishDoneStatusCode::InternalError,
  }
}

/// Ends every downstream subscription for a track whose upstream subscription failed.
///
/// Which message ends it depends on how far the downstream request got. One still
/// waiting for its answer is answered with REQUEST_ERROR. One already accepted has had
/// its single response, and only PUBLISH_DONE can end it — a second response on that
/// stream would be a protocol violation.
async fn end_upstream_subscription(
  relay_request_id: u64,
  publisher_connection_id: usize,
  full_track_name: &FullTrackName,
  error: RequestError,
  status_code: PublishDoneStatusCode,
  context: Arc<SessionContext>,
) {
  let track = context.track_manager.get_track(full_track_name).await;
  let (confirmed, others_may_still_accept) = match &track {
    Some(track) => {
      let track = track.read().await;
      let confirmed = matches!(*track.status.read().await, TrackStatus::Confirmed { .. });
      // This publisher has answered; whatever remains counted has not.
      let remaining = track
        .pending_upstream_subscribe_count
        .fetch_sub(1, Ordering::SeqCst)
        .saturating_sub(1);
      (confirmed, remaining > 0)
    }
    None => (false, false),
  };

  if !confirmed {
    // `handle_subscribe_error_message` marks the whole track Rejected and answers the
    // subscriber's request stream, ending the subscription for everyone. One publisher
    // declining is not grounds for that while others may still accept, and the stream
    // takes exactly one response either way. Every publisher answers or times out, so
    // the last one to do so reaches this with nothing outstanding and decides.
    if others_may_still_accept {
      info!(
        "A publisher declined {:?}; others have yet to answer, so the subscriber waits",
        full_track_name
      );
      return;
    }
    let _ = handle_subscribe_error_message(relay_request_id, error, context).await;
    return;
  }

  // The track was already accepted, so this publisher's failure ends its own upstream
  // subscription rather than the request. Only when it was the last publisher serving
  // the track is there nothing left to deliver, and the subscribers are told it is
  // over; while another still serves it they carry on and must not hear PUBLISH_DONE.
  let Some(track) = track else {
    return;
  };
  let still_served = {
    let track = track.read().await;
    let mut aliases = track.publisher_aliases.write().await;
    aliases.remove(&publisher_connection_id);
    !aliases.is_empty()
  };

  if still_served {
    info!(
      "Upstream subscription for {:?} from publisher {} failed; other publishers still serve it",
      full_track_name, publisher_connection_id
    );
    return;
  }

  info!(
    "Last upstream subscription for {:?} failed after acceptance; ending downstream with PUBLISH_DONE",
    full_track_name
  );
  if let Err(e) = track
    .read()
    .await
    .notify_publish_done(status_code, error.reason_phrase.as_str().to_string())
    .await
  {
    error!("Failed to end downstream subscriptions: {:?}", e);
  }
}

async fn handle_subscribe_message(
  client: Arc<MOQTClient>,
  stream_handler: &mut ControlStreamHandler,
  sub: Subscribe,
  context: Arc<SessionContext>,
  is_switch: bool,
) -> Result<(), TerminationCode> {
  info!("received Subscribe message: {:?}", sub);
  let track_namespace = sub.track_namespace.clone();
  let full_track_name = sub.get_full_track_name();

  // Reserved namespaces are resolved locally and never forwarded upstream.
  if let Some(reason) =
    crate::server::utils::reserved_namespace_rejection(&track_namespace, &sub.track_name)
  {
    info!("Rejecting SUBSCRIBE for reserved namespace: {}", reason);
    let err = RequestError::new(
      RequestErrorCode::DoesNotExist,
      0,
      ReasonPhrase::try_new(reason.to_string()).unwrap(),
    );
    stream_handler.send_impl(&err).await.unwrap();
    return Ok(());
  }

  // Synthetic-probe shortcut. A SUBSCRIBE for `.probe:<size>:<priority>` is
  // not routed to any publisher; the relay generates one object of `size`
  // bytes locally and ends. This intentionally skips track_manager
  // registration and publisher lookup so probe traffic can never share a
  // track_alias with real video and corrupt per-track subscription state.
  if let Some((size, priority)) = parse_probe_track_name(sub.track_name.as_bytes()) {
    return handle_probe_subscribe(client, stream_handler, sub, size, priority).await;
  }

  // Every publisher of the exact Track, plus every publisher that announced a namespace
  // it falls under. A SUBSCRIBE goes to all of them, not to whichever matched first.
  let publishers = {
    debug!("trying to get the publishers");
    context
      .client_manager
      .get_publishers_for_track(&full_track_name)
      .await
  };

  if publishers.is_empty() {
    info!(
      "no publisher found for track namespace: {:?}",
      track_namespace
    );
    // Dump what the relay actually had registered at the miss, so the sent
    // full track name / namespace can be compared against live registrations.
    info!(
      "SUBSCRIBE miss: sent full_track_name={:?} namespace={:?}; registrations:{}",
      full_track_name,
      track_namespace,
      context.client_manager.dump_registrations().await
    );
    // send RequestError
    let subscribe_error = RequestError::new(
      RequestErrorCode::DoesNotExist,
      0, //TODO: Maybe decide on another retry interval?
      ReasonPhrase::try_new("Unknown track namespace".to_string()).unwrap(),
    );
    stream_handler.send_impl(&subscribe_error).await.unwrap();
    return Ok(());
  };

  for publisher in &publishers {
    publisher.add_subscriber(context.connection_id).await;
  }

  info!(
    "Subscriber ({}) added to {} publisher(s) for {:?}",
    context.connection_id,
    publishers.len(),
    full_track_name
  );

  let original_request_id = sub.request_id;

  // Atomic get-or-create: first subscriber creates, subsequent ones find existing
  let (track_arc, is_creator) = context
    .track_manager
    .get_or_create_track(&full_track_name, |relay_track_id| {
      Track::new(
        relay_track_id,
        full_track_name.clone(),
        context.server_config,
        TrackStatus::Pending,
        TrackOrigin::Subscribe,
      )
    })
    .await;

  // Delay-mode handling: filtered clients subscribe with DELAY_GROUPS asking
  // the relay to start delivery `delay_groups` behind the live edge. The
  // SUBSCRIBE is rewritten to AbsoluteStart at the computed group before the
  // subscription is created, so the cache-replay path serves the backlog.
  let mut sub = sub;
  if let Some(delay_groups) = parse_delay_groups(&sub.subscribe_parameters) {
    info!(
      "Subscribe has DELAY_GROUPS={} (request_id={})",
      delay_groups, sub.request_id
    );
    // Clone the handles out of the guard: the hold below awaits, and the
    // track lock must not be held across it.
    let (live_edge_advanced, cache, holding_subscribes) = {
      let track = track_arc.read().await;
      (
        track.live_edge_advanced.clone(),
        track.cache.clone(),
        track.holding_subscribes.clone(),
      )
    };
    // Loop until we can resolve the requested start position.
    // Mesa-style condition wait: arm the Notify *before* re-reading state
    // to avoid lost-wakeup races (a notify_waiters between our compute and
    // our await would otherwise be missed).
    let mut registered = false;
    loop {
      let notified = live_edge_advanced.notified();
      tokio::pin!(notified);
      notified.as_mut().enable();

      let largest = { track_arc.read().await.largest_object().await };
      let oldest_cached = cache.oldest_group_id().await;
      let decision = compute_delayed_start(largest.clone(), delay_groups, oldest_cached);

      let clamped = matches!(decision, DelayedStart::ClampedToOldest(_));
      match decision {
        DelayedStart::Ready(loc) | DelayedStart::ClampedToOldest(loc) => {
          info!(
            "Subscribe delay-mode resolved: request_id={} largest={:?} \
             oldest_cached={:?} -> start_location={:?}",
            sub.request_id, largest, oldest_cached, loc
          );
          events::emit(
            "SUBSCRIBE_RECV",
            serde_json::json!({
              "conn": context.connection_id,
              "request_id": sub.request_id,
              "track": events::track_name_string(&full_track_name),
              "is_switch": is_switch,
              "delay_groups": delay_groups,
              "decision": if clamped { "clamped" } else { "ready" },
              "largest_group": largest.as_ref().map(|l| l.group),
              "oldest_cached_group": oldest_cached,
              "start_group": loc.group,
              "held": registered,
            }),
          );
          sub
            .subscribe_parameters
            .set_param(MessageParameter::new_subscription_filter(
              FilterType::AbsoluteStart,
              Some(loc),
              None,
            ));
          // Drain any holding-state record for this request (informational).
          if registered && let Some(largest) = largest {
            let _ = holding_subscribes.write().await.try_resolve(largest);
          }
          break;
        }
        DelayedStart::Hold { delay_groups: dg } => {
          if !registered {
            info!(
              "Subscribe delay-mode HOLD: request_id={} delay_groups={} \
               largest={:?}; awaiting live edge advance",
              sub.request_id, dg, largest
            );
            events::emit(
              "SUBSCRIBE_HOLD",
              serde_json::json!({
                "conn": context.connection_id,
                "request_id": sub.request_id,
                "track": events::track_name_string(&full_track_name),
                "delay_groups": dg,
                "largest_group": largest.as_ref().map(|l| l.group),
              }),
            );
            holding_subscribes
              .write()
              .await
              .register(sub.request_id, dg);
            registered = true;
          }
          // Wait for the live edge to advance, then re-check. The Notify arm
          // placed before the read still covers any notify_waiters that fired
          // during the read; if one already happened this returns at once.
          notified.await;
        }
      }
    }
  }

  if events::enabled() && parse_delay_groups(&sub.subscribe_parameters).is_none() {
    let largest = { track_arc.read().await.largest_object().await };
    events::emit(
      "SUBSCRIBE_RECV",
      serde_json::json!({
        "conn": context.connection_id,
        "request_id": sub.request_id,
        "track": events::track_name_string(&full_track_name),
        "is_switch": is_switch,
        "delay_groups": serde_json::Value::Null,
        "decision": "live",
        "largest_group": largest.as_ref().map(|l| l.group),
      }),
    );
  }

  // Scoped so the guard is gone before anything below reaches for this lock again.
  // tokio's RwLock is not reentrant and hands the lock to a queued writer first, so a
  // task that reads twice deadlocks against itself the moment a writer arrives in
  // between -- and it stays holding the first guard, wedging the track for everyone.
  let subscription_added = {
    let track = track_arc.read().await;
    add_subscription(sub.clone(), &track, client.clone(), is_switch).await
  };

  // An endpoint may hold only one subscription per track in a given role. A SWITCH is
  // the exception: it deliberately reuses the existing subscription, and the failure
  // here is how it hands over.
  if !subscription_added && !is_switch {
    info!(
      "Rejecting SUBSCRIBE from {} for {:?}: already subscribed",
      context.connection_id, &full_track_name
    );
    let err = RequestError::new(
      RequestErrorCode::DuplicateSubscription,
      0,
      ReasonPhrase::try_new("already subscribed to this track".to_string()).unwrap(),
    );
    stream_handler.send_impl(&err).await.unwrap();
    return Ok(());
  }

  let res: Result<(), TerminationCode> = if is_creator {
    // First subscriber for this track: forward Subscribe to publisher
    info!(
      "First subscriber for track {:?}, forwarding to publisher",
      &full_track_name
    );

    // Counted before any request goes out, since a publisher can answer while the rest
    // are still being sent.
    {
      let track = track_arc.read().await;
      track
        .pending_upstream_subscribe_count
        .store(publishers.len(), Ordering::SeqCst);
    }

    for publisher in &publishers {
      let mut new_sub = sub.clone();
      new_sub.subscribe_parameters = parameters::upstream_subscribe();
      // Its own request id, which is what routes this publisher's response back.
      new_sub.request_id =
        Session::get_next_relay_request_id(context.relay_next_request_id.clone()).await;

      // Store the relay subscribe request mapping before forwarding, so the
      // upstream response can be routed back to this subscription.
      // TODO: we need to add a timeout here or another loop to control expired requests
      let req = SubscribeRequest::new(
        original_request_id,
        context.connection_id,
        sub.clone(),
        Some(new_sub.clone()),
      );
      {
        let mut requests = context.relay_pending_requests.write().await;
        requests.insert(new_sub.request_id, PendingRequest::Subscribe(req.clone()));
      }
      info!(
        "forwarding SUBSCRIBE for {:?} to publisher {} as relay request {}",
        full_track_name, publisher.connection_id, new_sub.request_id
      );

      // Forward SUBSCRIBE upstream on its own bidirectional request stream and read
      // the response there, per the request-stream model.
      let publisher_fwd = publisher.clone();
      let context_fwd = context.clone();
      tokio::spawn(async move {
        forward_subscribe_upstream(publisher_fwd, new_sub, context_fwd).await;
      });
    }

    // Do NOT send SubscribeOk yet -- wait for publisher confirmation
    Ok(())
  } else {
    // Subsequent subscriber: track already exists
    let track = track_arc.read().await;
    let status = track.get_status().await;

    match status {
      TrackStatus::Confirmed {
        upstream_parameters,
      } => {
        info!(
          "Track confirmed, sending SubscribeOk to subscriber {}",
          client.connection_id
        );
        let cached_properties = { track.track_properties.read().await.clone() };
        let params =
          parameters::downstream_subscribe_ok(&upstream_parameters, track.largest_object().await);
        let subscribe_ok = moqtail::model::control::subscribe_ok::SubscribeOk::new(
          track.relay_track_id,
          params,
          cached_properties,
        );
        let sent = stream_handler.send_impl(&subscribe_ok).await;
        if sent.is_ok()
          && let Some(subscription) = track.get_subscription(client.connection_id).await
        {
          subscription.read().await.mark_alias_announced();
        }
        sent
      }
      TrackStatus::Pending => {
        info!(
          "Track pending, subscriber {} will wait for confirmation",
          client.connection_id
        );
        let mut pending = track.pending_subscribers.write().await;
        pending.push((sub.request_id, context.connection_id));
        Ok(())
      }
      TrackStatus::Rejected {
        error_code,
        reason_phrase,
      } => {
        info!(
          "Track rejected, sending RequestError to subscriber {}",
          client.connection_id
        );
        let subscribe_error = RequestError::new(
          error_code,
          0, //TODO: Maybe decide on another retry interval?
          reason_phrase,
        );
        stream_handler.send_impl(&subscribe_error).await
      }
    }
  };

  // A subscriber attaching to a PUBLISH-created track is what makes the relay
  // want Objects, so tell the publisher to start sending.
  if res.is_ok() {
    super::publish_handler::ensure_upstream_forwarding(&track_arc, &context).await;
  }

  // Store in client's subscribe requests on success
  if res.is_ok() {
    let mut requests = client.subscribe_requests.write().await;
    let orig_req = SubscribeRequest::new(original_request_id, context.connection_id, sub, None);
    requests.insert(original_request_id, orig_req.clone());

    // dual bookkeeping here, necessary evil
    let mut inbound = client.inbound_requests.write().await;
    inbound.insert(
      original_request_id,
      PendingRequest::Subscribe(orig_req.clone()),
    );

    debug!(
      "inserted request into client's subscribe requests: {:?}",
      orig_req
    );
  } else {
    error!("error in adding subscription: {:?}", res);
  }
  res
}

async fn handle_subscribe_ok_message(
  // The publisher that sent this SUBSCRIBE_OK; its connection id keys the track alias.
  publisher: Arc<MOQTClient>,
  // The relay request id we sent upstream; this stream identifies the request.
  request_id: u64,
  msg: moqtail::model::control::subscribe_ok::SubscribeOk,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!("received SubscribeOk message: {:?}", msg);

  // Look up the relay subscribe request from the unified map
  let sub_request = {
    let requests = context.relay_pending_requests.read().await;
    match requests.get(&request_id).cloned() {
      Some(PendingRequest::Subscribe(m)) => {
        info!("request id is verified: {:?}", request_id);
        m
      }
      Some(_) => {
        warn!(
          "request id matched but wrong type for SubscribeOk: {:?}",
          request_id
        );
        return Ok(());
      }
      None => {
        warn!("request id is not verified: {:?}", request_id);
        return Ok(());
      }
    }
  };

  // SUBSCRIBE_OK with an unsupported mandatory track property. Reuse the
  // RequestError fan-out to cancel and notify downstream subscribers.
  if has_unsupported_mandatory(&msg.track_properties) {
    warn!(
      "SubscribeOk for request {} carries an unsupported mandatory track property; rejecting",
      request_id
    );
    let reason = ReasonPhrase::try_new("Unsupported mandatory track property".to_string())
      .map_err(|_| TerminationCode::InternalError)?;
    let err = RequestError::new(RequestErrorCode::UnsupportedExtension, 0, reason);
    return handle_subscribe_error_message(request_id, err, context).await;
  }

  let full_track_name = sub_request.original_subscribe_request.get_full_track_name();

  // The track must already exist (pre-created in Subscribe handler)
  let track_arc = match context.track_manager.get_track(&full_track_name).await {
    Some(t) => t,
    None => {
      error!(
        "Track not found for SubscribeOk, this should not happen: {:?}",
        &full_track_name
      );
      return Ok(());
    }
  };

  // Confirm the track with publisher's metadata; capture relay_track_id for SubscribeOk messages
  let (relay_track_id, confirmed_now) = {
    let mut track = track_arc.write().await;
    let confirmed_now = track
      .confirm(
        publisher.connection_id,
        msg.track_alias,
        msg.subscribe_parameters.clone(),
        msg.track_properties.clone(),
      )
      .await;
    // This publisher has answered.
    track
      .pending_upstream_subscribe_count
      .fetch_sub(1, Ordering::SeqCst);
    (track.relay_track_id, confirmed_now)
  };

  // Register the publisher's alias for data stream routing. Every accepting publisher
  // needs this, whether or not it was the one that confirmed the track, or its Objects
  // arrive on a stream the relay cannot route.
  context
    .track_manager
    .add_track_alias(
      publisher.connection_id,
      msg.track_alias,
      full_track_name.clone(),
    )
    .await;

  // Only the publisher that confirmed the track answers downstream. The others are now
  // serving it too, but the subscribers were told once already and their request
  // streams take exactly one response.
  if !confirmed_now {
    info!(
      "Publisher {} also accepted {:?}; subscribers already answered",
      publisher.connection_id, full_track_name
    );
    return Ok(());
  }

  // What the relay advertises downstream is not what upstream sent: by the time this
  // runs the relay may already have seen a later Object than upstream knew of.
  let downstream_params = {
    let track = track_arc.read().await;
    parameters::downstream_subscribe_ok(&msg.subscribe_parameters, track.largest_object().await)
  };

  // Send SubscribeOk to the FIRST subscriber (the creator)
  {
    let subscriber = { context.client_manager.get(sub_request.requested_by).await };
    if let Some(subscriber) = subscriber {
      let cached_properties = {
        let track = track_arc.read().await;
        track.track_properties.read().await.clone()
      };
      let subscribe_ok = moqtail::model::control::subscribe_ok::SubscribeOk::new(
        relay_track_id,
        downstream_params.clone(),
        cached_properties,
      );
      info!(
        "sending SubscribeOk to creator subscriber: {:?}",
        subscriber.connection_id
      );
      let delivered = subscriber
        .send_response(
          sub_request.original_request_id,
          ControlMessage::SubscribeOk(Box::new(subscribe_ok)),
        )
        .await;
      if !delivered {
        warn!(
          "no request stream for creator subscriber request {}",
          sub_request.original_request_id
        );
      } else if let Some(subscription) = track_arc
        .read()
        .await
        .get_subscription(subscriber.connection_id)
        .await
      {
        subscription.read().await.mark_alias_announced();
      }
    } else {
      warn!(
        "creator subscriber not found: {:?}",
        sub_request.requested_by
      );
    }
  }

  // Send SubscribeOk to ALL pending subscribers
  {
    // Released before the loop: the loop reads this same lock again, and a second read
    // taken while the first is still held deadlocks against any writer queued between
    // them.
    let pending = {
      let track = track_arc.read().await;
      let mut pending = track.pending_subscribers.write().await;
      std::mem::take(&mut *pending)
    };

    for (subscriber_request_id, subscriber_connection_id) in pending {
      let subscriber = { context.client_manager.get(subscriber_connection_id).await };
      if let Some(subscriber) = subscriber {
        let cached_properties = {
          let track = track_arc.read().await;
          track.track_properties.read().await.clone()
        };
        let subscribe_ok = moqtail::model::control::subscribe_ok::SubscribeOk::new(
          relay_track_id,
          downstream_params.clone(),
          cached_properties,
        );
        info!(
          "sending SubscribeOk to pending subscriber: {:?}",
          subscriber.connection_id
        );
        let delivered = subscriber
          .send_response(
            subscriber_request_id,
            ControlMessage::SubscribeOk(Box::new(subscribe_ok)),
          )
          .await;
        if !delivered {
          warn!(
            "no request stream for pending subscriber request {}",
            subscriber_request_id
          );
        } else {
          let subscription = {
            let track = track_arc.read().await;
            track.get_subscription(subscriber.connection_id).await
          };
          if let Some(subscription) = subscription {
            subscription.read().await.mark_alias_announced();
          }
        }
      }
    }
  }

  // Subscription was already added in the Subscribe handler,
  // so we do NOT call add_subscription again here.
  Ok(())
}

/// Cancel a subscription when its SUBSCRIBE request stream is reset or closed.
pub(crate) async fn cancel_subscription(
  client: Arc<MOQTClient>,
  request_id: u64,
  context: &Arc<SessionContext>,
) {
  // SWITCH PR #1378 cancel race: "If the subscriber [cancels] the Current
  // Subscribe Request ID before the Relay has opened a PUBLISH for the target
  // Track, the Relay MUST abandon the SWITCH and MUST open a PUBLISH for the
  // target Track and immediately send PUBLISH_DONE with Status Code
  // SUBSCRIPTION_ENDED." Under draft-18 the cancel is the subscriber closing or
  // resetting the subscription's request stream, which lands here. Mark the
  // in-flight switch abandoned FIRST (before any teardown, to shrink the race
  // window); the switch task observes the mark -- mid-drain or at its atomic
  // mark_published() claim -- and emits the mandated failure PUBLISH. abandon()
  // returns false when there is nothing to abandon (no switch in flight, or its
  // PUBLISH already opened), in which case this is ordinary teardown, which
  // proceeds below in every case.
  if client
    .switch_in_flight
    .lock()
    .await
    .abandon(request_id, std::time::Instant::now())
  {
    info!(
      "cancel: abandoning in-flight SWITCH for Current Subscribe Request ID {}",
      request_id
    );
  }

  // find the track alias by using the request id
  let full_track_name = {
    let requests = client.subscribe_requests.read().await;
    let request = requests.get(&request_id);
    if request.is_none() {
      warn!("request not found for request id: {:?}", request_id);
      return;
    }
    request
      .unwrap()
      .original_subscribe_request
      .get_full_track_name()
  }; // read lock dropped here

  // remove the subscription from the track
  let track_option = context.track_manager.get_track(&full_track_name).await;

  if let Some(track_lock) = track_option {
    let (is_last_subscriber, origin) = {
      let track = track_lock.read().await;
      track.remove_subscription(context.connection_id).await;
      // When the last subscriber goes away, reset the upstream subscribe streams so
      // the publishers observe the cancellation. One per publisher serving the track.
      let last = if track.subscriber_count().await == 0 {
        for cancel in track.upstream_subscribe_cancellers.lock().await.drain(..) {
          let _ = cancel.send(());
        }
        true
      } else {
        false
      };
      (last, track.origin)
    }; // track read lock dropped here

    // Only a SUBSCRIBE-created track is removed here: its upstream subscription
    // has just been cancelled, so its cached state is stale and the next
    // SUBSCRIBE must re-subscribe upstream rather than be answered from it. A
    // PUBLISH-created track has a publisher still pushing to it and outlives
    // any number of subscribers.
    if is_last_subscriber && origin == TrackOrigin::Subscribe {
      context.track_manager.remove_track(&full_track_name).await;
      info!(
        "Removed track {:?} after last subscriber left; next SUBSCRIBE will re-subscribe upstream",
        full_track_name
      );
    }
  } else {
    warn!(
      "Subscription cancel: Track {:?} already removed.",
      full_track_name
    );
  }

  // remove the subscription from the client
  client
    .subscriptions
    .remove_subscription(&full_track_name)
    .await;

  // Remove the request from the client's request map so it doesn't leak
  {
    let mut requests = client.subscribe_requests.write().await;
    requests.remove(&request_id);

    let mut inbound = client.inbound_requests.write().await;
    inbound.remove(&request_id);

    debug!(
      "Cleaned up client subscribe request {} on cancel",
      request_id
    );
  }
}

pub async fn handle_request_update(
  client: Arc<MOQTClient>,
  stream_handler: &mut ControlStreamHandler,
  update_msg: moqtail::model::control::request_update::RequestUpdate,
  context: Arc<SessionContext>,
  existing_req_id: u64,
) -> Result<(), TerminationCode> {
  let full_track_name = {
    let mut client_requests = client.subscribe_requests.write().await;
    match client_requests.get_mut(&existing_req_id) {
      Some(req) => {
        apply_message_parameter_update(
          &mut req.original_subscribe_request.subscribe_parameters,
          update_msg.parameters.clone(),
        );
        req.original_subscribe_request.get_full_track_name()
      }
      None => {
        warn!(
          "RequestUpdate existing_request_id {} is not a valid Subscribe request for this client",
          existing_req_id
        );
        return Err(TerminationCode::ProtocolViolation);
      }
    }
  };

  {
    let mut inbound = client.inbound_requests.write().await;
    if let Some(PendingRequest::Subscribe(req)) = inbound.get_mut(&existing_req_id) {
      apply_message_parameter_update(
        &mut req.original_subscribe_request.subscribe_parameters,
        update_msg.parameters.clone(),
      );
    }
  }

  // 2. Get the track instance
  let track_lock = context.track_manager.get_track(&full_track_name).await;

  if track_lock.is_none() {
    warn!("Track not found for track name: {:?}", full_track_name);
    return Err(TerminationCode::ProtocolViolation);
  }

  let track_arc = track_lock.unwrap();

  // Apply the update, releasing the track/sub read locks before responding or
  // terminating so termination can take the track write lock.
  let update_result = {
    let track_guard = track_arc.read().await;
    match track_guard.get_subscription(client.connection_id).await {
      Some(subscription) => Some(
        subscription
          .read()
          .await
          .update_subscription(update_msg)
          .await,
      ),
      None => None,
    }
  };

  match update_result {
    Some(Ok(())) => {
      info!(
        "Subscription updated successfully for track: {:?}",
        full_track_name
      );
      // The update may have turned this subscriber's Forward State on, which is
      // the first thing wanting Objects from a PUBLISH-created track.
      super::publish_handler::ensure_upstream_forwarding(&track_arc, &context).await;
      let ok_msg = RequestOk::new(vec![]);
      let _ = stream_handler.send_impl(&ok_msg).await;
    }
    Some(Err(e)) => {
      error!(
        "Subscription update failed for track: {:?}, error: {:?}",
        full_track_name, e
      );

      let err_msg = RequestError::new(
        RequestErrorCode::InternalError,
        0,
        ReasonPhrase::try_new(format!("Update failed: {:?}", e))
          .unwrap_or_else(|_| ReasonPhrase::try_new("Update failed".to_string()).unwrap()),
      );
      let _ = stream_handler.send_impl(&err_msg).await;

      // A failed update terminates the subscription with PUBLISH_DONE(UPDATE_FAILED).
      let stream_count = match track_arc
        .read()
        .await
        .get_subscription(client.connection_id)
        .await
      {
        Some(sub) => sub.read().await.opened_stream_count(),
        None => 0,
      };
      let done = PublishDone::new(
        PublishDoneStatusCode::UpdateFailed,
        stream_count,
        ReasonPhrase::try_new("REQUEST_UPDATE failed".to_string()).unwrap(),
      );
      let _ = stream_handler.send_impl(&done).await;

      track_arc
        .write()
        .await
        .remove_subscription(client.connection_id)
        .await;
      client
        .subscriptions
        .remove_subscription(&full_track_name)
        .await;
    }
    None => {
      warn!(
        "No active subscription found for client {} on track {:?}",
        client.connection_id, full_track_name
      );

      let err_msg = RequestError::new(
        RequestErrorCode::DoesNotExist,
        0,
        ReasonPhrase::try_new("Subscription not found".to_string()).unwrap(),
      );
      let _ = stream_handler.send_impl(&err_msg).await;
    }
  }

  Ok(())
}
async fn handle_subscribe_error_message(
  // The relay request id we sent upstream; this stream identifies the request.
  request_id: u64,
  subscribe_error_message: RequestError,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!(
    "received RequestError message: {:?}",
    subscribe_error_message
  );
  let msg = subscribe_error_message;

  // Look up and remove the relay subscribe request from the unified map
  let sub_request = {
    let mut requests = context.relay_pending_requests.write().await;
    match requests.remove(&request_id) {
      Some(PendingRequest::Subscribe(m)) => m,
      Some(_) => {
        warn!("RequestError for mismatched request type: {:?}", request_id);
        return Ok(());
      }
      None => {
        warn!("RequestError for unknown request id: {:?}", request_id);
        return Ok(());
      }
    }
  };

  let full_track_name = sub_request.original_subscribe_request.get_full_track_name();

  // Mark track as Rejected (if it exists)
  let track_arc = context.track_manager.get_track(&full_track_name).await;
  if let Some(track_arc) = &track_arc {
    let track = track_arc.read().await;
    track
      .reject(msg.error_code, msg.reason_phrase.clone())
      .await;
  }

  // Send RequestError to the FIRST subscriber (the creator)
  {
    let subscriber = { context.client_manager.get(sub_request.requested_by).await };
    if let Some(subscriber) = subscriber {
      let subscribe_error = RequestError::new(
        msg.error_code,
        0, //TODO: Maybe decide on another retry interval?
        msg.reason_phrase.clone(),
      );
      subscriber
        .send_response(
          sub_request.original_request_id,
          ControlMessage::RequestError(Box::new(subscribe_error)),
        )
        .await;
    }
  }

  // Send RequestError to ALL pending subscribers
  if let Some(track_arc) = &track_arc {
    let track = track_arc.read().await;
    let pending = {
      let mut pending = track.pending_subscribers.write().await;
      std::mem::take(&mut *pending)
    };

    for (subscriber_request_id, subscriber_connection_id) in pending {
      let subscriber = { context.client_manager.get(subscriber_connection_id).await };
      if let Some(subscriber) = subscriber {
        let subscribe_error = RequestError::new(
          msg.error_code,
          0, //TODO: Maybe decide on another retry interval?
          msg.reason_phrase.clone(),
        );
        subscriber
          .send_response(
            subscriber_request_id,
            ControlMessage::RequestError(Box::new(subscribe_error)),
          )
          .await;
      }
    }
  }

  // Remove the pre-created track from TrackManager
  if track_arc.is_some() {
    let mut tracks = context.track_manager.tracks.write().await;
    tracks.remove(&full_track_name);
  }

  Ok(())
}

async fn handle_switch_message(
  client: Arc<MOQTClient>,
  _stream_handler: &mut ControlStreamHandler,
  switch_message: moqtail::model::control::switch::Switch,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!("received Switch message: {:?}", switch_message);
  events::emit(
    "SWITCH_RECV",
    serde_json::json!({
      "conn": context.connection_id,
      "request_id": serde_json::Value::Null,
      "old_request_id": switch_message.current_subscribe_request_id,
      "minimum_switching_group": switch_message.minimum_switching_group_id,
      "track": format!(
        "{:?}/{}",
        switch_message.track_namespace, switch_message.track_name
      ),
    }),
  );

  // SWITCH PR #1378: the relay carries out the switch by opening a PUBLISH for
  // the target Track toward the subscriber (it does not mutate the existing
  // subscription). Every post-validation outcome opens the target PUBLISH and
  // reports via PUBLISH_DONE, leaving the current subscription untouched on
  // failure -- no ProtocolViolation disconnect.
  use crate::server::switch_delivery::{
    DrainOutcome, SeamBoundUndo, SelectOutcome, apply_seam_bound, build_switch_live_sub,
    drain_source_below, poll_select_switch_group, restore_source_end_group, send_switch_failure,
    send_switch_publish, spawn_switch_catchup_stream, switch_catchup_priority,
    switch_subscriber_priority, switch_target_parameters, terminate_source,
  };
  use crate::server::switch_guard::{AdmitResult, ClaimResult, SwitchFailure};
  use moqtail::model::parameter::switch_transition::SwitchTransition;
  use std::time::Instant;

  let target_full_track_name = switch_message.get_full_track_name();
  let current_sub_req_id = switch_message.current_subscribe_request_id;

  // SWITCH PR #1378 pre-PUBLISH gate -- this MUST come before anything else:
  // "Upon receiving a SWITCH message, the Relay MUST first validate that the
  // Current Subscribe Request ID identifies an Established subscription. If no
  // such subscription exists, the Relay MUST NOT open a PUBLISH for the target
  // Track and MUST NOT modify any existing subscription state."
  //
  // This is the ONE SWITCH outcome that produces no PUBLISH at all -- the
  // subscriber's client.switch() resolves through its local response timeout.
  // A known request id whose track has already been torn down is treated the
  // same way: that subscription is no longer Established.
  let current_track_arc = {
    let requests = client.subscribe_requests.read().await;
    match requests.get(&current_sub_req_id) {
      Some(req) => {
        let name = req.original_subscribe_request.get_full_track_name();
        context.track_manager.get_track(&name).await
      }
      None => None,
    }
  };
  let current_track_arc = match current_track_arc {
    Some(t) => t,
    None => {
      warn!(
        "switch: Current Subscribe Request ID {} does not identify an Established \
         subscription; dropping SWITCH (no PUBLISH, no state change)",
        current_sub_req_id
      );
      return Ok(());
    }
  };
  let current_full_track_name = current_track_arc.read().await.full_track_name.clone();
  // "Established" means a live subscription on the track for THIS connection,
  // not merely a leftover request-map entry.
  if current_track_arc
    .read()
    .await
    .get_subscription(context.connection_id)
    .await
    .is_none()
  {
    warn!(
      "switch: request id {} has no live subscription; dropping SWITCH (no PUBLISH, no state change)",
      current_sub_req_id
    );
    return Ok(());
  }

  // Single in-flight SWITCH per Current Subscribe Request ID -> EXCESSIVE_LOAD.
  // Checked immediately after the Established gate, before the target Track is
  // resolved. One T_switch deadline for the whole operation, anchored at SWITCH
  // receipt: the same `admitted_at` seeds both the guard entry's expiry and the
  // task's deadline, so the instant the slot becomes reclaimable by a newer
  // SWITCH is exactly the instant this task's own polls start reporting
  // TimedOut. `generation` is this admission's ownership token.
  let t_switch = context.server_config.get_t_switch();
  let admitted_at = Instant::now();
  let t_switch_deadline = admitted_at + t_switch;
  let generation = {
    let mut guard = client.switch_in_flight.lock().await;
    match guard.try_admit(current_sub_req_id, admitted_at, t_switch) {
      AdmitResult::Admitted { generation } => generation,
      AdmitResult::Rejected => {
        drop(guard);
        let rid = Session::get_next_relay_request_id(context.relay_next_request_id.clone()).await;
        send_switch_failure(
          &client,
          rid,
          &target_full_track_name,
          0,
          SwitchFailure::AlreadyInFlight,
        )
        .await;
        return Ok(());
      }
    }
  };

  // Resolve the target Track. This relay serves the tracks its publishers
  // PUBLISHed or that an earlier SUBSCRIBE established; a target it does not
  // carry is reported as DOES_NOT_EXIST (the lazy upstream establishment and
  // relay-chaining backfill of the draft-14 implementation are not ported to
  // the draft-18 request-stream model). This runs after admission, so the
  // failure path releases the guard slot -- otherwise a retry within T_switch
  // would be spuriously rejected with EXCESSIVE_LOAD.
  let Some(target_track_arc) = context
    .track_manager
    .get_track(&target_full_track_name)
    .await
  else {
    warn!(
      "switch: target track {:?} is not known to this relay",
      target_full_track_name
    );
    let rid = Session::get_next_relay_request_id(context.relay_next_request_id.clone()).await;
    send_switch_failure(
      &client,
      rid,
      &target_full_track_name,
      0,
      SwitchFailure::TargetTrackMissing,
    )
    .await;
    client
      .switch_in_flight
      .lock()
      .await
      .complete(current_sub_req_id, generation);
    return Ok(());
  };
  let target_alias = target_track_arc.read().await.relay_track_id;

  // The relay (not the subscriber) allocates the target delivery's Request ID.
  let target_request_id =
    Session::get_next_relay_request_id(context.relay_next_request_id.clone()).await;

  // Per SWITCH PR #1378 the SWITCH's parameter set is the complete parameter set
  // for the target PUBLISH; the relay restates the transport fields it owns.
  let target_parameters = switch_target_parameters(&switch_message.subscribe_parameters);
  let subscriber_priority = switch_subscriber_priority(&target_parameters);

  // Strict ordering (soft switch): identify G_switch, drain the source Track's
  // Objects in Groups below it, THEN terminate the source, attach the target
  // subscription, open the target PUBLISH and start catch-up + live delivery.
  // The whole sequence runs in a task so the request stream isn't blocked while
  // selection waits for a boundary or the drain waits on a lagging source.
  let target_namespace = switch_message.track_namespace.clone();
  let target_name = switch_message.track_name.clone();
  let minimum_switching_group_id = switch_message.minimum_switching_group_id;
  let connection_id = context.connection_id;
  tokio::spawn(async move {
    // (0) Identify G_switch within T_switch: the smallest group at/above the
    // client's Minimum Switching Group ID that is a common boundary between
    // the two Tracks and past which the target can supply every group the
    // current Track would have supplied below the live edge (see
    // switch_selection.rs). Selection is a T_switch-bounded wait, not a
    // one-shot check: a floor naming a group the target has not produced yet
    // waits here for that group to materialize while the current subscription
    // keeps forwarding untouched.
    let g_switch = match poll_select_switch_group(
      &client,
      &current_track_arc,
      &target_track_arc,
      minimum_switching_group_id,
      current_sub_req_id,
      generation,
      t_switch_deadline,
    )
    .await
    {
      SelectOutcome::Ready(g) => g,
      SelectOutcome::TimedOut => {
        warn!(
          "switch: could not identify G_switch within T_switch for {:?} (min={})",
          target_full_track_name, minimum_switching_group_id
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::NoCommonBoundary,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
      SelectOutcome::Abandoned => {
        info!(
          "switch: abandoned by cancel of request id {current_sub_req_id} during G_switch selection; reporting SUBSCRIPTION_ENDED"
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::SubscriptionEnded,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
      SelectOutcome::TargetRejected => {
        warn!(
          "switch: upstream rejected target track {:?}; reporting DOES_NOT_EXIST",
          target_full_track_name
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::TargetTrackMissing,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
    };
    info!(
      "switch: target={:?} g_switch={} target_request_id={}",
      target_full_track_name, g_switch, target_request_id
    );

    // (1) Drain the source below G_switch before any target Object is sent,
    // sharing the T_switch deadline with selection above. On timeout (severe
    // congestion) abort with TIMEOUT and leave the current subscription
    // unchanged. The drain itself does not mutate the source: the seam bound is
    // applied AFTER the claim in (1b) succeeds, so every non-Claimed outcome
    // leaves the current subscription untouched.
    match drain_source_below(
      &client,
      &current_track_arc,
      connection_id,
      g_switch,
      current_sub_req_id,
      generation,
      t_switch_deadline,
    )
    .await
    {
      DrainOutcome::Drained | DrainOutcome::Abandoned => {}
      DrainOutcome::TimedOut => {
        warn!(
          "switch: source drain timed out below g_switch={g_switch}; aborting, current subscription unchanged"
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::DrainTimeout,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
    };

    // (1b) Cancel race: atomically claim the right to open the target PUBLISH.
    // abandon() (cancel_subscription) and mark_published() (here) are
    // serialized on the same mutex, so exactly one side wins.
    let claim = {
      let mut guard = client.switch_in_flight.lock().await;
      guard.mark_published(current_sub_req_id, generation)
    };
    match claim {
      ClaimResult::Claimed => {}
      ClaimResult::Abandoned => {
        info!(
          "switch: abandoned by cancel of request id {current_sub_req_id} before target PUBLISH; reporting SUBSCRIPTION_ENDED"
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::SubscriptionEnded,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
      ClaimResult::Superseded => {
        warn!(
          "switch: T_switch elapsed and a newer SWITCH took over request id {current_sub_req_id}; reporting TIMEOUT"
        );
        send_switch_failure(
          &client,
          target_request_id,
          &target_full_track_name,
          target_alias,
          SwitchFailure::Superseded,
        )
        .await;
        client
          .switch_in_flight
          .lock()
          .await
          .complete(current_sub_req_id, generation);
        return;
      }
    }

    // (1c) Claim won: bound the source at the seam so it does not forward
    // Groups >= G_switch concurrently with the target before teardown.
    let drain_undo = apply_seam_bound(&current_track_arc, connection_id, g_switch).await;

    // (1d) Re-read the target's live edge NOW -- the draft pins
    // SWITCH_TRANSITION's Live Edge Group ID to the live edge "at the time the
    // PUBLISH is opened". largest_location is monotonic, so it is >= the
    // selection-time snapshot and g_switch <= live edge holds.
    let live_edge = target_track_arc
      .read()
      .await
      .largest_location
      .read()
      .await
      .group;

    // (2) Build the live subscription: AbsoluteStart at (max(g_switch,
    // live_edge), 0) with the joining cache replay -- see build_switch_live_sub.
    let live_sub = build_switch_live_sub(
      target_request_id,
      target_namespace,
      target_name,
      g_switch,
      live_edge,
      target_parameters.clone(),
    );

    // (3) Close-After-Switch: terminate the source with PUBLISH_DONE on the
    // current Request ID and drop relay state.
    terminate_source(
      &client,
      &current_track_arc,
      &current_full_track_name,
      connection_id,
      current_sub_req_id,
    )
    .await;

    // (4) Attach the live subscription on the target Track (objects from the
    // live edge onward, on SUBGROUP streams) + relay-side request mapping. The
    // catch-up stream's priority sits above every live group of the target.
    let catchup_priority = switch_catchup_priority(subscriber_priority);
    let subscription = {
      let target_track = target_track_arc.read().await;
      if !add_subscription(live_sub.clone(), &target_track, client.clone(), false).await {
        error!(
          "switch: could not attach the target subscription for {:?}",
          target_full_track_name
        );
      }
      target_track.get_subscription(connection_id).await
    };
    let Some(subscription) = subscription else {
      // The seam bound on the (already terminated) source is moot; report the
      // failure so the subscriber does not wait for a PUBLISH that never comes.
      if let Some(SeamBoundUndo { prior_end_group }) = drain_undo {
        restore_source_end_group(&current_track_arc, connection_id, prior_end_group).await;
      }
      send_switch_failure(
        &client,
        target_request_id,
        &target_full_track_name,
        target_alias,
        SwitchFailure::PublishBuildFailed,
      )
      .await;
      client
        .switch_in_flight
        .lock()
        .await
        .complete(current_sub_req_id, generation);
      return;
    };
    {
      let req = SubscribeRequest::new(target_request_id, connection_id, live_sub, None);
      client
        .subscribe_requests
        .write()
        .await
        .insert(target_request_id, req.clone());
      client
        .inbound_requests
        .write()
        .await
        .insert(target_request_id, PendingRequest::Subscribe(req));
    }
    // The new subscription is what wants Objects from the target, so a
    // PUBLISH-created track's publisher may need to be told to forward.
    super::publish_handler::ensure_upstream_forwarding(&target_track_arc, &context).await;

    // (5) Open the target PUBLISH on its own request stream, carrying
    // SWITCH_TRANSITION { G_switch, live edge }. The subscription's alias is
    // announced by that PUBLISH, so live forwarding starts once it is out.
    send_switch_publish(
      client.clone(),
      context.clone(),
      target_track_arc.clone(),
      subscription,
      target_request_id,
      &target_full_track_name,
      Location::new(live_edge, 0),
      &target_parameters,
      SwitchTransition::new(g_switch, live_edge),
    )
    .await;

    // (6) Catch-up range [G_switch, live edge) on a FETCH_HEADER stream.
    spawn_switch_catchup_stream(
      client.clone(),
      target_track_arc.clone(),
      target_request_id,
      g_switch,
      live_edge,
      catchup_priority,
    );

    // (7) Release the in-flight guard.
    client
      .switch_in_flight
      .lock()
      .await
      .complete(current_sub_req_id, generation);
  });

  Ok(())
}

pub async fn handle(
  client: Arc<MOQTClient>,
  stream_handler: &mut ControlStreamHandler,
  msg: ControlMessage,
  context: Arc<SessionContext>,
  opening_request_id: Option<u64>,
) -> Result<(), TerminationCode> {
  match msg {
    ControlMessage::Subscribe(m) => {
      handle_subscribe_message(client, stream_handler, *m, context, false).await
    }
    ControlMessage::RequestUpdate(m) => {
      let Some(target_request_id) = opening_request_id else {
        return Err(TerminationCode::ProtocolViolation);
      };
      handle_request_update(client, stream_handler, *m, context, target_request_id).await
    }
    ControlMessage::Switch(m) => handle_switch_message(client, stream_handler, *m, context).await,
    _ => {
      // no-op
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn upstream_errors_map_to_a_publish_done_status() {
    for (error, status) in [
      (
        RequestErrorCode::Unauthorized,
        PublishDoneStatusCode::Unauthorized,
      ),
      (
        RequestErrorCode::GoingAway,
        PublishDoneStatusCode::GoingAway,
      ),
      (
        RequestErrorCode::MalformedTrack,
        PublishDoneStatusCode::MalformedTrack,
      ),
      (
        RequestErrorCode::ExcessiveLoad,
        PublishDoneStatusCode::ExcessiveLoad,
      ),
      (
        RequestErrorCode::DoesNotExist,
        PublishDoneStatusCode::TrackEnded,
      ),
      // No counterpart: a subscriber can only be told something went wrong.
      (
        RequestErrorCode::InvalidRange,
        PublishDoneStatusCode::InternalError,
      ),
      (
        RequestErrorCode::Timeout,
        PublishDoneStatusCode::InternalError,
      ),
    ] {
      assert_eq!(publish_done_status_for(error), status, "for {error:?}");
    }
  }
}

#[cfg(test)]
mod tests_parse_delay_groups {
  use super::*;

  #[test]
  fn parse_delay_groups_returns_some_when_present() {
    let params = vec![MessageParameter::new_delay_groups(5)];
    assert_eq!(parse_delay_groups(&params), Some(5));
  }

  #[test]
  fn parse_delay_groups_returns_none_when_absent() {
    let params: Vec<MessageParameter> = vec![];
    assert_eq!(parse_delay_groups(&params), None);
  }

  #[test]
  fn parse_delay_groups_ignores_other_params() {
    let params = vec![MessageParameter::new_object_delivery_timeout(99)];
    assert_eq!(parse_delay_groups(&params), None);
  }

  #[test]
  fn parse_delay_groups_tolerates_duplicate_returns_first() {
    let params = vec![
      MessageParameter::new_delay_groups(7),
      MessageParameter::new_delay_groups(11),
    ];
    assert_eq!(parse_delay_groups(&params), Some(7));
  }
}

#[cfg(test)]
mod tests_compute_delayed_start {
  use super::*;

  fn loc(group: u64, object: u64) -> Location {
    Location { group, object }
  }

  #[test]
  fn ready_when_largest_is_well_above_delay_and_target_in_cache() {
    let result = compute_delayed_start(Some(loc(100, 0)), 2, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(98, 0)));
  }

  #[test]
  fn hold_when_largest_below_delay() {
    let result = compute_delayed_start(Some(loc(1, 0)), 5, Some(0));
    assert_eq!(result, DelayedStart::Hold { delay_groups: 5 });
  }

  #[test]
  fn ready_when_largest_exactly_equals_delay() {
    let result = compute_delayed_start(Some(loc(5, 0)), 5, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(0, 0)));
  }

  #[test]
  fn hold_when_largest_is_none() {
    let result = compute_delayed_start(None, 5, None);
    assert_eq!(result, DelayedStart::Hold { delay_groups: 5 });
  }

  #[test]
  fn clamped_to_oldest_when_target_below_cache_window() {
    let result = compute_delayed_start(Some(loc(100, 0)), 80, Some(50));
    assert_eq!(result, DelayedStart::ClampedToOldest(loc(50, 0)));
  }

  #[test]
  fn ready_when_delay_is_zero() {
    let result = compute_delayed_start(Some(loc(100, 0)), 0, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(100, 0)));
  }

  #[test]
  fn ready_when_target_exactly_equals_oldest_cached() {
    let result = compute_delayed_start(Some(loc(100, 0)), 50, Some(50));
    assert_eq!(result, DelayedStart::Ready(loc(50, 0)));
  }

  #[test]
  fn ready_when_oldest_cached_is_none() {
    let result = compute_delayed_start(Some(loc(100, 0)), 80, None);
    assert_eq!(result, DelayedStart::Ready(loc(20, 0)));
  }
}

#[cfg(test)]
mod tests_parse_probe_track_name {
  use super::*;

  #[test]
  fn parses_size_and_priority() {
    assert_eq!(parse_probe_track_name(b".probe:4096:1"), Some((4096, 1)));
  }

  #[test]
  fn rejects_non_probe_names() {
    assert_eq!(parse_probe_track_name(b"video-720p"), None);
    assert_eq!(parse_probe_track_name(b".probe:0:1"), None);
    assert_eq!(parse_probe_track_name(b".probe:10:1:extra"), None);
  }
}
