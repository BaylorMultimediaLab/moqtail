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
use crate::server::client::switch_context::SwitchStatus;
use crate::server::session::Session;
use crate::server::session_context::SessionContext;
use crate::server::stream_id::StreamId;
use crate::server::track::{Track, TrackStatus};
use bytes::Bytes;
use core::result::Result;
use moqtail::model::common::location::Location;
use moqtail::model::common::pair::KeyValuePair;
use moqtail::model::control::constant::{FilterType, GroupOrder};
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::model::error::TerminationCode;
use moqtail::model::parameter::constant::VersionSpecificParameterType;
use moqtail::model::{
  common::reason_phrase::ReasonPhrase, control::control_message::ControlMessage,
};
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use moqtail::transport::data_stream_handler::SubscribeRequest;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::{debug, error, info, warn};

/// Search a SUBSCRIBE message's parameters for the project-local DELAY_GROUPS
/// (VarInt). Returns the first match's value, or None if not present.
///
/// Used by the SUBSCRIBE handler when computing a delay-mode start location:
/// the relay puts a filtered client `delay_groups` behind the live edge.
#[allow(dead_code)]
fn parse_delay_groups(params: &[KeyValuePair]) -> Option<u64> {
  params.iter().find_map(|p| match p {
    KeyValuePair::VarInt { type_value, value }
      if *type_value == VersionSpecificParameterType::DelayGroups as u64 =>
    {
      Some(*value)
    }
    _ => None,
  })
}

/// Search a SWITCH message's parameters for the project-local
/// START_LOCATION_GROUP (VarInt). Returns the first match's value, or None
/// if not present. Used by handle_switch_message to start the new track at
/// an absolute group_id rather than at the live edge.
fn parse_start_location_group(params: &[KeyValuePair]) -> Option<u64> {
  params.iter().find_map(|p| match p {
    KeyValuePair::VarInt { type_value, value }
      if *type_value == VersionSpecificParameterType::StartLocationGroup as u64 =>
    {
      Some(*value)
    }
    _ => None,
  })
}

/// The relay's decision after applying a `DELAY_GROUPS` parameter to a SUBSCRIBE.
#[derive(Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum DelayedStart {
  /// The requested target is in-window; deliver from this location.
  Ready(Location),
  /// The requested target predates the cache; deliver from the oldest available.
  ClampedToOldest(Location),
  /// `largest_location.group < delay_groups` (stream too young) — register the
  /// subscribe in a pending state and resolve once the live edge advances.
  Hold { delay_groups: u64 },
}

/// Decide what start_location a delayed (filtered) SUBSCRIBE should use.
///
/// Pure function: no I/O, no async, no side effects. Inputs are the relay's
/// current view of the live edge (`largest`), the delay the client requested
/// (`delay_groups`), and the oldest group currently in the cache (or None
/// if the relay hasn't started caching yet).
#[allow(dead_code)]
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

// Synthetic-probe track aliases live well above any plausible publisher-
// assigned alias so they can't collide with real video tracks. Per IETF 119
// MoQ bandwidth-measurement slides, a subscriber can request a one-shot
// payload of arbitrary size by subscribing to `.probe:<size>:<priority>`.
//
// QUIC varints (RFC 9000 §16) can only encode values up to 2^62 - 1, so the
// alias must stay below that. 2^60 is far above any plausible publisher
// alias (publishers in this codebase use small u64 starting from 1) and
// well within varint range.
const PROBE_ALIAS_BASE: u64 = 1u64 << 60;
static PROBE_ALIAS_COUNTER: AtomicU64 = AtomicU64::new(0);
const PROBE_MAX_SIZE: usize = 16 * 1024 * 1024;
// Per-object chunk size. WebTransport's read() returns once per MoQ object,
// so the receiver only sees inter-arrival timing if the probe is split into
// multiple objects. 4 KB ≈ a few MTU-sized packets per object — small
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
/// switch-context tracking — the probe is a pure relay-side artifact and
/// must never collide with real-track state. The relay sends SubscribeOk
/// (which teaches the client a synthetic track_alias), opens a uni stream
/// with a SubgroupHeader, writes one SubgroupObject of `size` zero bytes,
/// and closes the stream.
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

  // Allocate a unique synthetic alias. PROBE_ALIAS_BASE puts these in a
  // range no publisher would ever assign.
  let track_alias = PROBE_ALIAS_BASE + PROBE_ALIAS_COUNTER.fetch_add(1, Ordering::Relaxed);

  // SubscribeOk first so the client maps track_alias before any data lands.
  let subscribe_ok = moqtail::model::control::subscribe_ok::SubscribeOk::new_ascending_with_content(
    sub.request_id,
    track_alias,
    0, // expires — irrelevant for one-shot
    Some(Location::new(0, 0)),
    None,
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
    0,            // group_id
    0,            // subgroup_id
    pub_priority, // publisher_priority
    false,        // has_extensions
    true,         // contains_end_of_group — single-object subgroup
  );

  let header_bytes = match header.serialize() {
    Ok(b) => b,
    Err(e) => {
      warn!("probe: failed to serialize header: {:?}", e);
      return Ok(());
    }
  };

  let stream_id = StreamId::new_subgroup(track_alias, 0, Some(0));

  // Stream-scheduling priority 0 — yield to real video under congestion.
  let send_stream = match client.open_stream(&stream_id, header_bytes, 0).await {
    Ok(s) => s,
    Err(e) => {
      warn!("probe: failed to open stream: {:?}", e);
      return Ok(());
    }
  };

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
      extension_headers: None,
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

async fn handle_subscribe_message(
  client: Arc<MOQTClient>,
  control_stream_handler: &mut ControlStreamHandler,
  sub: Subscribe,
  context: Arc<SessionContext>,
  is_switch: bool,
) -> Result<(), TerminationCode> {
  info!("received Subscribe message: {:?}", sub);
  let track_namespace = sub.track_namespace.clone();
  let request_id = sub.request_id;
  let full_track_name = sub.get_full_track_name();

  // check request id
  {
    let max_request_id = context
      .max_request_id
      .load(std::sync::atomic::Ordering::Relaxed);
    if request_id >= max_request_id {
      warn!(
        "request id ({}) is greater than max request id ({})",
        request_id, max_request_id
      );
      return Err(TerminationCode::TooManyRequests);
    }
  }

  // Synthetic-probe shortcut. A SUBSCRIBE for `.probe:<size>:<priority>` is
  // not routed to any publisher; the relay generates one object of `size`
  // bytes locally and ends. This intentionally skips track_manager
  // registration and publisher lookup so probe traffic can never share a
  // track_alias with real video and corrupt switch_context.
  if let Some((size, priority)) = parse_probe_track_name(sub.track_name.as_bytes()) {
    return handle_probe_subscribe(client, control_stream_handler, sub, size, priority).await;
  }

  // find who is the publisher
  // first we try with the full track name
  // if not found, we try with the announced track namespace
  // in both cases, the first publisher that satisfies the condition is returned
  // TODO: support multiple publishers
  let publisher = {
    debug!("trying to get the publisher");
    let m = context.client_manager.read().await;
    debug!(
      "client manager obtained, current client id: {}",
      context.connection_id
    );
    match m.get_publisher_by_full_track_name(&full_track_name).await {
      Some(p) => Some(p),
      None => {
        info!(
          "no publisher found for full track name: {:?}",
          &full_track_name
        );
        let m = context.client_manager.read().await;
        debug!(
          "client manager obtained, current client id: {}",
          context.connection_id
        );
        m.get_publisher_by_announced_track_namespace(&track_namespace)
          .await
      }
    }
  };

  let publisher = if let Some(publisher) = publisher {
    publisher.clone()
  } else {
    info!(
      "no publisher found for track namespace: {:?}",
      track_namespace
    );
    // send SubscribeError
    let subscribe_error = moqtail::model::control::subscribe_error::SubscribeError::new(
      sub.request_id,
      moqtail::model::control::constant::SubscribeErrorCode::TrackDoesNotExist,
      ReasonPhrase::try_new("Unknown track namespace".to_string()).unwrap(),
    );
    control_stream_handler
      .send_impl(&subscribe_error)
      .await
      .unwrap();
    return Ok(());
  };

  publisher.add_subscriber(context.connection_id).await;

  info!(
    "Subscriber ({}) added to the publisher ({})",
    context.connection_id, publisher.connection_id
  );

  let original_request_id = sub.request_id;

  // Atomic get-or-create: first subscriber creates, subsequent ones find existing
  let (track_arc, is_creator) = context
    .track_manager
    .get_or_create_track(&full_track_name, || {
      Track::new(
        0, // provisional alias, updated on SubscribeOk from publisher
        full_track_name.clone(),
        publisher.connection_id,
        context.server_config,
        TrackStatus::Pending,
      )
    })
    .await;

  let track = track_arc.read().await;

  // Delay-mode handling: filtered clients subscribe with DELAY_GROUPS asking
  // the relay to start delivery `delay_groups` behind the live edge.
  let mut sub = sub;
  if let Some(delay_groups) = parse_delay_groups(&sub.subscribe_parameters) {
    info!(
      "Subscribe has DELAY_GROUPS={} (request_id={})",
      delay_groups, sub.request_id
    );
    // Loop until we can resolve the requested start position.
    // Mesa-style condition wait: arm the Notify *before* re-reading state
    // to avoid lost-wakeup races (a notify_waiters between our compute and
    // our await would otherwise be missed).
    let mut registered = false;
    loop {
      let notified = track.live_edge_advanced.notified();
      tokio::pin!(notified);
      notified.as_mut().enable();

      let largest = track.largest_location.read().await.clone();
      let oldest_cached = track.cache.oldest_group_id().await;
      let decision = compute_delayed_start(Some(largest.clone()), delay_groups, oldest_cached);

      match decision {
        DelayedStart::Ready(loc) | DelayedStart::ClampedToOldest(loc) => {
          info!(
            "Subscribe delay-mode resolved: request_id={} largest={:?} \
             oldest_cached={:?} -> start_location={:?}",
            sub.request_id, largest, oldest_cached, loc
          );
          sub.start_location = Some(loc);
          sub.filter_type = FilterType::AbsoluteStart;
          // Drain any holding-state record for this request (we may have
          // registered earlier; try_resolve also clears any other now-Ready
          // entries from concurrent subscribers, which is fine — informational).
          if registered {
            let _ = track.holding_subscribes.write().await.try_resolve(largest);
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
            // Register the holding state (observability / future drain).
            track
              .holding_subscribes
              .write()
              .await
              .register(sub.request_id, dg);
            registered = true;
          }
          // Wait for the live edge to advance, then re-check.
          notified.await;
          // Loop again. The Notify arm we placed before the read still
          // covers any notify_waiters that fired during the read; if
          // such a notify already happened, this `.await` returns
          // immediately, and we re-evaluate.
        }
      }
    }
  }

  add_subscription(sub.clone(), &track, client.clone(), is_switch).await;

  let res: Result<(), TerminationCode> = if is_creator {
    // First subscriber for this track: forward Subscribe to publisher
    info!(
      "First subscriber for track {:?}, forwarding to publisher",
      &full_track_name
    );

    let mut new_sub = sub.clone();
    new_sub.forward = true;
    new_sub.request_id =
      Session::get_next_relay_request_id(context.relay_next_request_id.clone()).await;

    publisher
      .queue_message(ControlMessage::Subscribe(Box::new(new_sub.clone())))
      .await;

    // Store relay subscribe request mapping
    // TODO: we need to add a timeout here or another loop to control expired requests
    let req = SubscribeRequest::new(
      original_request_id,
      context.connection_id,
      sub.clone(),
      Some(new_sub.clone()),
    );
    let mut requests = context.relay_subscribe_requests.write().await;
    requests.insert(new_sub.request_id, req.clone());
    info!(
      "inserted request into relay's subscribe requests: {:?} with relay's request id: {:?}",
      req, new_sub.request_id
    );
    // Do NOT send SubscribeOk yet -- wait for publisher confirmation
    Ok(())
  } else {
    // Subsequent subscriber: track already exists
    let track = track_arc.read().await;
    let status = track.get_status().await;

    match status {
      TrackStatus::Confirmed {
        publisher_track_alias,
        expires,
        largest_location,
      } => {
        info!(
          "Track confirmed, sending SubscribeOk to subscriber {}",
          client.connection_id
        );
        let subscribe_ok =
          moqtail::model::control::subscribe_ok::SubscribeOk::new_ascending_with_content(
            sub.request_id,
            publisher_track_alias,
            expires,
            largest_location,
            None,
          );
        control_stream_handler.send_impl(&subscribe_ok).await
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
          "Track rejected, sending SubscribeError to subscriber {}",
          client.connection_id
        );
        let subscribe_error = moqtail::model::control::subscribe_error::SubscribeError::new(
          sub.request_id,
          error_code,
          reason_phrase,
        );
        control_stream_handler.send_impl(&subscribe_error).await
      }
    }
  };

  // Store in client's subscribe requests on success
  if res.is_ok() {
    let mut requests = client.subscribe_requests.write().await;
    let orig_req = SubscribeRequest::new(original_request_id, context.connection_id, sub, None);
    requests.insert(original_request_id, orig_req.clone());
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
  _client: Arc<MOQTClient>,
  _control_stream_handler: &mut ControlStreamHandler,
  msg: moqtail::model::control::subscribe_ok::SubscribeOk,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!("received SubscribeOk message: {:?}", msg);
  let request_id = msg.request_id;

  // Look up and remove the relay subscribe request (no longer needed after processing)
  let sub_request = {
    let mut requests = context.relay_subscribe_requests.write().await;
    debug!("current requests: {:?}", requests);
    match requests.remove(&request_id) {
      Some(m) => {
        info!("request id is verified: {:?}", request_id);
        m
      }
      None => {
        warn!("request id is not verified: {:?}", request_id);
        return Ok(());
      }
    }
  };

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

  // Confirm the track with publisher's metadata
  {
    let mut track = track_arc.write().await;
    track
      .confirm(msg.track_alias, msg.expires, msg.largest_location.clone())
      .await;
  }

  // Register the track alias for data stream routing
  context
    .track_manager
    .add_track_alias(msg.track_alias, full_track_name.clone())
    .await;

  // Send SubscribeOk to the FIRST subscriber (the creator)
  {
    let subscriber = {
      let mngr = context.client_manager.read().await;
      mngr.get(sub_request.requested_by).await
    };
    if let Some(subscriber) = subscriber {
      let subscribe_ok =
        moqtail::model::control::subscribe_ok::SubscribeOk::new_ascending_with_content(
          sub_request.original_request_id,
          msg.track_alias,
          msg.expires,
          msg.largest_location.clone(),
          None,
        );
      info!(
        "sending SubscribeOk to creator subscriber: {:?}",
        subscriber.connection_id
      );
      subscriber
        .queue_message(ControlMessage::SubscribeOk(Box::new(subscribe_ok)))
        .await;
    } else {
      warn!(
        "creator subscriber not found: {:?}",
        sub_request.requested_by
      );
    }
  }

  // Send SubscribeOk to ALL pending subscribers
  {
    let track = track_arc.read().await;
    let pending = {
      let mut pending = track.pending_subscribers.write().await;
      std::mem::take(&mut *pending)
    };

    for (subscriber_request_id, subscriber_connection_id) in pending {
      let subscriber = {
        let mngr = context.client_manager.read().await;
        mngr.get(subscriber_connection_id).await
      };
      if let Some(subscriber) = subscriber {
        let subscribe_ok =
          moqtail::model::control::subscribe_ok::SubscribeOk::new_ascending_with_content(
            subscriber_request_id,
            msg.track_alias,
            msg.expires,
            msg.largest_location.clone(),
            None,
          );
        info!(
          "sending SubscribeOk to pending subscriber: {:?}",
          subscriber.connection_id
        );
        subscriber
          .queue_message(ControlMessage::SubscribeOk(Box::new(subscribe_ok)))
          .await;
      }
    }
  }

  // Subscription was already added in the Subscribe handler,
  // so we do NOT call add_subscription again here.
  Ok(())
}

async fn handle_unsubscribe_message(
  client: Arc<MOQTClient>,
  _control_stream_handler: &mut ControlStreamHandler,
  unsubscribe_message: moqtail::model::control::unsubscribe::Unsubscribe,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!("received Unsubscribe message: {:?}", unsubscribe_message);
  // stop sending objects for the track for the subscriber
  // by removing the subscription
  // find the track alias by using the request id
  let requests = client.subscribe_requests.read().await;
  let request = requests.get(&unsubscribe_message.request_id);
  if request.is_none() {
    // a warning is enough
    warn!(
      "request not found for request id: {:?}",
      unsubscribe_message.request_id
    );
    return Ok(());
  }
  let request = request.unwrap();
  let full_track_name = request.original_subscribe_request.get_full_track_name();

  // remove the subscription from the track
  let track_option = context.track_manager.get_track(&full_track_name).await;

  if let Some(track_lock) = track_option {
    let track = track_lock.write().await;
    track.remove_subscription(context.connection_id).await;
  } else {
    tracing::warn!(
      "Ignored Unsubscribe: Track {:?} already removed.",
      full_track_name
    );
  }

  // remove the subscription from the client
  client
    .subscriptions
    .remove_subscription(&full_track_name)
    .await;

  Ok(())
}

async fn handle_subscribe_update_message(
  client: Arc<MOQTClient>,
  _control_stream_handler: &mut ControlStreamHandler,
  subscribe_update_message: moqtail::model::control::subscribe_update::SubscribeUpdate,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!(
    "received SubscribeUpdate message: {:?}",
    subscribe_update_message
  );

  // a subscribe update message contains subscription_request_id
  // which is the request id of the subscription we want to update
  let sub_request_id = subscribe_update_message.subscription_request_id;

  let requests = client.subscribe_requests.read().await;
  let request = requests.get(&sub_request_id);
  if request.is_none() {
    warn!(
      "request not found for subscriber request id: {:?}",
      sub_request_id
    );
    return Err(TerminationCode::ProtocolViolation);
  }
  let request = request.unwrap();

  // we can not get the full track name and hence, the track instance
  let full_track_name = request.original_subscribe_request.get_full_track_name();
  let track_lock = context.track_manager.get_track(&full_track_name).await;

  if track_lock.is_none() {
    warn!("track not found for track name: {:?}", full_track_name);
    return Err(TerminationCode::ProtocolViolation);
  }

  let track_arc = track_lock.unwrap();
  let track_guard = track_arc.read().await;

  if let Some(subscription) = track_guard.get_subscription(context.connection_id).await {
    let sub = subscription.read().await;
    match sub.update_subscription(subscribe_update_message).await {
      Ok(_) => info!(
        "subscription updated, track: {:?} subscriber: {}",
        full_track_name, context.connection_id
      ),
      Err(e) => error!(
        "subscription could not be updated, track: {:?} subscriber: {} error: {:?}",
        full_track_name, context.connection_id, e
      ),
    }
  }
  Ok(())
}

async fn handle_subscribe_error_message(
  _client: Arc<MOQTClient>,
  _control_stream_handler: &mut ControlStreamHandler,
  subscribe_error_message: moqtail::model::control::subscribe_error::SubscribeError,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!(
    "received SubscribeError message: {:?}",
    subscribe_error_message
  );
  let msg = subscribe_error_message;
  let request_id = msg.request_id;

  // Look up and remove the relay subscribe request
  let sub_request = {
    let mut requests = context.relay_subscribe_requests.write().await;
    match requests.remove(&request_id) {
      Some(m) => m,
      None => {
        warn!("SubscribeError for unknown request id: {:?}", request_id);
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

  // Send SubscribeError to the FIRST subscriber (the creator)
  {
    let subscriber = {
      let mngr = context.client_manager.read().await;
      mngr.get(sub_request.requested_by).await
    };
    if let Some(subscriber) = subscriber {
      let subscribe_error = moqtail::model::control::subscribe_error::SubscribeError::new(
        sub_request.original_request_id,
        msg.error_code,
        msg.reason_phrase.clone(),
      );
      subscriber
        .queue_message(ControlMessage::SubscribeError(Box::new(subscribe_error)))
        .await;
    }
  }

  // Send SubscribeError to ALL pending subscribers
  if let Some(track_arc) = &track_arc {
    let track = track_arc.read().await;
    let pending = {
      let mut pending = track.pending_subscribers.write().await;
      std::mem::take(&mut *pending)
    };

    for (subscriber_request_id, subscriber_connection_id) in pending {
      let subscriber = {
        let mngr = context.client_manager.read().await;
        mngr.get(subscriber_connection_id).await
      };
      if let Some(subscriber) = subscriber {
        let subscribe_error = moqtail::model::control::subscribe_error::SubscribeError::new(
          subscriber_request_id,
          msg.error_code,
          msg.reason_phrase.clone(),
        );
        subscriber
          .queue_message(ControlMessage::SubscribeError(Box::new(subscribe_error)))
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
  control_stream_handler: &mut ControlStreamHandler,
  switch_message: moqtail::model::control::switch::Switch,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  info!("received Switch message: {:?}", switch_message);

  // now different from a normal subscribe, we need to
  // check whether there is a related track to switch from
  let switch_from_track = {
    let requests = client.subscribe_requests.read().await;

    let req = requests.get(&switch_message.subscription_request_id);
    match req {
      Some(req) => {
        let track_name = req.original_subscribe_request.get_full_track_name();
        if let Some(track) = context.track_manager.get_track(&track_name).await {
          info!(
            "found old track request, original request id: {:?}",
            req.original_request_id
          );
          Some(track.clone())
        } else {
          warn!("old track not found for track name: {:?}", track_name);
          None
        }
      }
      None => None,
    }
  };

  if switch_from_track.is_none() {
    warn!(
      "no existing track found for switch subscription request id: {:?}",
      switch_message.subscription_request_id
    );
    return Err(TerminationCode::ProtocolViolation);
  }

  let switch_from_track_guard = switch_from_track.unwrap();

  let switch_from_track = switch_from_track_guard.read().await;

  if let Some(sub) = client
    .subscriptions
    .get_subscription(&switch_from_track.full_track_name)
    .await
  {
    if sub.upgrade().is_none() {
      warn!(
        "subscription weak reference is dead for track: {:?} subscriber: {}",
        switch_from_track.full_track_name, context.connection_id
      );
      return Err(TerminationCode::ProtocolViolation);
    }

    let mut is_active = false;
    if let Some(sub) = sub.upgrade() {
      let sub = sub.read().await;
      is_active = sub.is_active().await;
    }

    if !is_active {
      warn!(
        "subscription is not active for track: {:?} subscriber: {}",
        switch_from_track.full_track_name, context.connection_id
      );
      return Err(TerminationCode::ProtocolViolation);
    }
  } else {
    warn!(
      "no subscription found for track: {:?} subscriber: {}",
      switch_from_track.full_track_name, context.connection_id
    );
    return Err(TerminationCode::ProtocolViolation);
  }

  // Inspect for START_LOCATION_GROUP: when present, start the new track at
  // the requested absolute group (aligned switch). Otherwise default to the
  // existing live-edge ("naive switch") semantic.
  let subscribe = match parse_start_location_group(&switch_message.subscribe_parameters) {
    Some(start_group) => {
      info!(
        "Switch has START_LOCATION_GROUP={}; using new_absolute_start (request_id={})",
        start_group, switch_message.request_id
      );
      Subscribe::new_absolute_start(
        switch_message.request_id,
        switch_message.track_namespace.clone(),
        switch_message.track_name.clone(),
        0,
        GroupOrder::Original,
        true,
        Location {
          group: start_group,
          object: 0,
        },
        switch_message.subscribe_parameters.clone(),
      )
    }
    None => Subscribe::new_latest_object(
      switch_message.request_id,
      switch_message.track_namespace.clone(),
      switch_message.track_name.clone(),
      0,
      GroupOrder::Original,
      true,
      switch_message.subscribe_parameters.clone(),
    ),
  };

  let new_full_track_name = subscribe.get_full_track_name();

  if let Err(e) = handle_subscribe_message(
    client.clone(),
    control_stream_handler,
    subscribe,
    context.clone(),
    true, // is_switch
  )
  .await
  {
    error!("error handling switch subscribe message: {:?}", e);
    Err(e)
  } else {
    info!("switch subscribe message handled successfully");

    // update the switch context
    client
      .switch_context
      .add_or_update_switch_item(new_full_track_name, SwitchStatus::Next)
      .await;

    let switch_from_track_name = switch_from_track.full_track_name.clone();

    client
      .switch_context
      .add_or_update_switch_item(switch_from_track_name, SwitchStatus::Current)
      .await;

    Ok(())
  }
}

pub async fn handle(
  client: Arc<MOQTClient>,
  control_stream_handler: &mut ControlStreamHandler,
  msg: ControlMessage,
  context: Arc<SessionContext>,
) -> Result<(), TerminationCode> {
  match msg {
    ControlMessage::Subscribe(m) => {
      handle_subscribe_message(client, control_stream_handler, *m, context, false).await
    }
    ControlMessage::SubscribeOk(m) => {
      handle_subscribe_ok_message(client, control_stream_handler, *m, context).await
    }
    ControlMessage::Unsubscribe(m) => {
      handle_unsubscribe_message(client, control_stream_handler, *m, context).await
    }
    ControlMessage::SubscribeUpdate(m) => {
      handle_subscribe_update_message(client, control_stream_handler, *m, context).await
    }
    ControlMessage::SubscribeError(m) => {
      handle_subscribe_error_message(client, control_stream_handler, *m, context).await
    }
    ControlMessage::Switch(m) => {
      handle_switch_message(client, control_stream_handler, *m, context).await
    }
    _ => {
      // no-op
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests_parse_delay_groups {
  use super::*;

  fn delay_groups_kvp(value: u64) -> KeyValuePair {
    KeyValuePair::VarInt {
      type_value: VersionSpecificParameterType::DelayGroups as u64,
      value,
    }
  }

  #[test]
  fn parse_delay_groups_returns_some_when_present() {
    let params = vec![delay_groups_kvp(5)];
    assert_eq!(parse_delay_groups(&params), Some(5));
  }

  #[test]
  fn parse_delay_groups_returns_none_when_absent() {
    let params: Vec<KeyValuePair> = vec![];
    assert_eq!(parse_delay_groups(&params), None);
  }

  #[test]
  fn parse_delay_groups_ignores_other_params() {
    let params = vec![KeyValuePair::VarInt {
      type_value: VersionSpecificParameterType::DeliveryTimeout as u64,
      value: 99,
    }];
    assert_eq!(parse_delay_groups(&params), None);
  }

  #[test]
  fn parse_delay_groups_tolerates_duplicate_returns_first() {
    // Defensive: if a peer sends two DELAY_GROUPS entries, return the first.
    let params = vec![delay_groups_kvp(7), delay_groups_kvp(11)];
    assert_eq!(parse_delay_groups(&params), Some(7));
  }

  #[test]
  fn parse_delay_groups_ignores_bytes_kvp_with_same_type_id() {
    // Defensive: 0x70 is even (varint), so a Bytes KVP with the same type
    // would be malformed; we shouldn't extract a value from it.
    use bytes::Bytes;
    let params = vec![KeyValuePair::Bytes {
      type_value: VersionSpecificParameterType::DelayGroups as u64,
      value: Bytes::from_static(b"oops"),
    }];
    assert_eq!(parse_delay_groups(&params), None);
  }
}

#[cfg(test)]
mod tests_compute_delayed_start {
  use super::*;
  use moqtail::model::common::location::Location;

  fn loc(group: u64, object: u64) -> Location {
    Location { group, object }
  }

  #[test]
  fn ready_when_largest_is_well_above_delay_and_target_in_cache() {
    // largest=100, delay=2 -> target=98; oldest=0 (deep cache) -> Ready(98,0)
    let result = compute_delayed_start(Some(loc(100, 0)), 2, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(98, 0)));
  }

  #[test]
  fn hold_when_largest_below_delay() {
    // largest=1, delay=5 -> can't subtract -> Hold{delay=5}
    let result = compute_delayed_start(Some(loc(1, 0)), 5, Some(0));
    assert_eq!(result, DelayedStart::Hold { delay_groups: 5 });
  }

  #[test]
  fn ready_when_largest_exactly_equals_delay() {
    // Boundary case: largest.group == delay_groups → target_group = 0,
    // which is in-window when oldest=0. Pins the hold/release pivot at
    // exact equality (would catch a regression to `<=` in the Hold check).
    let result = compute_delayed_start(Some(loc(5, 0)), 5, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(0, 0)));
  }

  #[test]
  fn hold_when_largest_is_none() {
    // No live edge known yet -> Hold
    let result = compute_delayed_start(None, 5, None);
    assert_eq!(result, DelayedStart::Hold { delay_groups: 5 });
  }

  #[test]
  fn clamped_to_oldest_when_target_below_cache_window() {
    // largest=100, delay=80 -> target=20; oldest=50 -> Clamp to (50,0)
    let result = compute_delayed_start(Some(loc(100, 0)), 80, Some(50));
    assert_eq!(result, DelayedStart::ClampedToOldest(loc(50, 0)));
  }

  #[test]
  fn ready_when_delay_is_zero() {
    // delay=0 means "behave like LatestObject" -> target equals largest
    let result = compute_delayed_start(Some(loc(100, 0)), 0, Some(0));
    assert_eq!(result, DelayedStart::Ready(loc(100, 0)));
  }

  #[test]
  fn ready_when_target_exactly_equals_oldest_cached() {
    // largest=100, delay=50 -> target=50; oldest=50 -> not below, so Ready (not Clamp)
    let result = compute_delayed_start(Some(loc(100, 0)), 50, Some(50));
    assert_eq!(result, DelayedStart::Ready(loc(50, 0)));
  }

  #[test]
  fn ready_when_oldest_cached_is_none() {
    // No cache info -> trust the target. (Conservative: if we don't know
    // the cache window, don't preemptively clamp.)
    let result = compute_delayed_start(Some(loc(100, 0)), 80, None);
    assert_eq!(result, DelayedStart::Ready(loc(20, 0)));
  }
}

#[cfg(test)]
mod tests_parse_start_location_group {
  use super::*;
  use moqtail::model::common::pair::KeyValuePair;
  use moqtail::model::parameter::constant::VersionSpecificParameterType;

  fn start_location_kvp(value: u64) -> KeyValuePair {
    KeyValuePair::VarInt {
      type_value: VersionSpecificParameterType::StartLocationGroup as u64,
      value,
    }
  }

  #[test]
  fn parse_returns_some_when_present() {
    let params = vec![start_location_kvp(42)];
    assert_eq!(parse_start_location_group(&params), Some(42));
  }

  #[test]
  fn parse_returns_none_when_absent() {
    let params: Vec<KeyValuePair> = vec![];
    assert_eq!(parse_start_location_group(&params), None);
  }

  #[test]
  fn parse_ignores_other_params() {
    let params = vec![KeyValuePair::VarInt {
      type_value: VersionSpecificParameterType::DelayGroups as u64,
      value: 99,
    }];
    assert_eq!(parse_start_location_group(&params), None);
  }

  #[test]
  fn parse_ignores_bytes_kvp_with_same_type_id() {
    use bytes::Bytes;
    let params = vec![KeyValuePair::Bytes {
      type_value: VersionSpecificParameterType::StartLocationGroup as u64,
      value: Bytes::from_static(b"oops"),
    }];
    assert_eq!(parse_start_location_group(&params), None);
  }
}
