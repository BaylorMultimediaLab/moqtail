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
use crate::server::config::AppConfig;
use crate::server::object_logger::ObjectLogger;
use crate::server::stream_id::StreamId;
use crate::server::track::TrackEvent;
use crate::server::track_cache::CacheConsumeEvent;
use crate::server::track_cache::TrackCache;
use crate::server::utils;
use anyhow::Result;
use bytes::Bytes;
use moqtail::model::common::location::Location;
use moqtail::model::common::pair::KeyValuePair;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::control::constant::FilterType;
use moqtail::model::control::constant::GroupOrder;
use moqtail::model::control::constant::PublishDoneStatusCode;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::control::subscribe_update::SubscribeUpdate;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::transport::data_stream_handler::HeaderInfo;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::Mutex;
use tokio::sync::RwLock;
use tokio::sync::mpsc::UnboundedReceiver;
use tracing::warn;
use tracing::{debug, error, info};
use wtransport::SendStream;

#[derive(Debug, Clone)]
pub struct SubscriptionState {
  pub subscriber_priority: u8,
  pub _group_order: GroupOrder,
  pub forward: bool,
  pub _filter_type: FilterType,
  pub start_location: Option<Location>,
  /// Inclusive last group to forward; `None` = unbounded.
  pub end_group: Option<u64>,
  pub subscribe_parameters: Vec<KeyValuePair>,
  pub last_sent_max_location: Option<Location>,
  pub last_received_object_location: Option<Location>,
  pub is_joining: bool,
  /// Per-`(group_id, subgroup_id)` high-water of object IDs actually
  /// delivered by the joining cache replay. The live-forward path drops a
  /// queued SubgroupObject event iff its subgroup has a watermark at or above
  /// its object ID — i.e. iff the replay already delivered that exact object.
  /// Object IDs are monotonic within a subgroup, and `read_objects` replays a
  /// consistent per-group snapshot (the group's read lock is held for the
  /// whole iteration) while `Track::new_subgroup_object` caches every object
  /// BEFORE fanning it out, so "<= watermark" is exactly "was replayed":
  /// late arrivals the snapshot never covered — older-group stragglers or
  /// interleaved subgroups with smaller IDs — have no watermark at/above them
  /// and pass through. A single max-location threshold cannot express this
  /// and would drop such stragglers (a seam gap on the target track).
  pub replay_watermarks: HashMap<(u64, u64), u64>,
}

/// True iff writing `object_id` onto a per-(group, subgroup) send stream whose
/// last successfully sent object id is `previous` would break the stream's
/// monotonicity — equal means a duplicate, lower means a late arrival. The
/// subgroup delta encoder (`wire = id - previous - 1`) underflows on either,
/// and a strict MOQT receiver must treat a non-increasing subgroup stream as
/// malformed. `previous == None` (nothing sent yet) never blocks.
pub(crate) fn breaks_stream_monotonicity(previous: Option<u64>, object_id: u64) -> bool {
  previous.is_some_and(|prev| object_id <= prev)
}

impl SubscriptionState {
  /// True iff the joining cache replay already delivered this exact object,
  /// i.e. the object's subgroup has a replay watermark at or above its
  /// object ID. Objects with no subgroup ID never appear in a replay
  /// (`Object::try_from_fetch` always sets `Some`), so they are never
  /// duplicates of one.
  pub fn is_replay_duplicate(&self, location: &Location, subgroup_id: Option<u64>) -> bool {
    match subgroup_id {
      Some(subgroup_id) => self
        .replay_watermarks
        .get(&(location.group, subgroup_id))
        .is_some_and(|wm| location.object <= *wm),
      None => false,
    }
  }

  /// True iff `group` lies beyond the subscription's end-group bound
  /// (`None` = unbounded). `Some(0)` is a real bound at Group 0 — the case
  /// the old `u64` sentinel (0 = "no limit") could not express, which let the
  /// switch drain's seam bound for `G_switch == 1` leak Groups >= 1.
  pub fn exceeds_end_group(&self, group: u64) -> bool {
    self.end_group.is_some_and(|end| group > end)
  }

  /// Maps SUBSCRIBE_UPDATE's wire encoding of End Group (0 = "no end group")
  /// onto the internal `Option` representation. The sentinel survives only at
  /// the wire boundary; internally `None` is the sole spelling of
  /// "unbounded".
  pub fn end_group_from_update_wire(wire_end_group: u64) -> Option<u64> {
    (wire_end_group > 0).then_some(wire_end_group)
  }

  pub fn update_last_sent_max_location(&mut self, location: Location) {
    match &self.last_sent_max_location {
      Some(current_max) => {
        if location > *current_max {
          self.last_sent_max_location = Some(location);
        }
      }
      None => {
        self.last_sent_max_location = Some(location);
      }
    }
  }

  pub fn update_last_received_object_location(&mut self, location: Location) {
    match &self.last_received_object_location {
      Some(current_max) => {
        if location > *current_max {
          self.last_received_object_location = Some(location);
        }
      }
      None => {
        self.last_received_object_location = Some(location);
      }
    }
  }
}

impl From<Subscribe> for SubscriptionState {
  fn from(subscribe: Subscribe) -> Self {
    // When a SUBSCRIBE arrives with an explicit start_location (delay-mode,
    // absolute-start), we must replay
    // any cached objects in [start_location, current_largest] before live
    // objects start filtering through. The cache-replay path at lines
    // 196-299 is gated on is_joining && start_location.is_some(); without
    // is_joining=true here, those cached objects are silently dropped.
    let is_joining = subscribe.start_location.is_some();

    Self {
      subscriber_priority: subscribe.subscriber_priority,
      _group_order: subscribe.group_order,
      forward: subscribe.forward,
      _filter_type: subscribe.filter_type,
      start_location: subscribe.start_location,
      end_group: subscribe.end_group,
      subscribe_parameters: subscribe.subscribe_parameters,
      last_sent_max_location: None,
      last_received_object_location: None,
      replay_watermarks: HashMap::new(),
      is_joining,
    }
  }
}

#[derive(Debug, Clone)]
pub struct Subscription {
  pub request_id: u64,
  track_alias_ref: Arc<AtomicU64>,
  #[allow(dead_code)] // retained field; unread after the old-pipeline SWITCH removal
  pub full_track_name: FullTrackName,
  pub subscription_state: Arc<RwLock<SubscriptionState>>,
  subscriber: Arc<MOQTClient>,
  event_rx: Arc<Mutex<Option<UnboundedReceiver<TrackEvent>>>>,
  send_stream_last_object_ids: Arc<RwLock<HashMap<StreamId, Option<u64>>>>,
  finished: Arc<AtomicBool>,
  #[allow(dead_code)]
  cache: TrackCache,
  client_connection_id: usize,
  object_logger: ObjectLogger,
  config: &'static AppConfig,
}

#[allow(clippy::too_many_arguments)]
impl Subscription {
  /// Get the current track alias value (shared with SubscriptionManager).
  fn track_alias(&self) -> u64 {
    self.track_alias_ref.load(Ordering::Relaxed)
  }

  fn create_instance(
    track_alias_ref: Arc<AtomicU64>,
    full_track_name: FullTrackName,
    request_id: u64,
    subscribe_message: Subscribe,
    subscriber: Arc<MOQTClient>,
    event_rx: Arc<Mutex<Option<UnboundedReceiver<TrackEvent>>>>,
    cache: TrackCache,
    client_connection_id: usize,
    log_folder: String,
    config: &'static AppConfig,
  ) -> Self {
    Self {
      track_alias_ref,
      full_track_name,
      request_id,
      subscription_state: Arc::new(RwLock::new(subscribe_message.into())),
      subscriber,
      event_rx,
      send_stream_last_object_ids: Arc::new(RwLock::new(HashMap::new())),
      finished: Arc::new(AtomicBool::new(false)),
      cache,
      client_connection_id,
      object_logger: ObjectLogger::new(log_folder),
      config,
    }
  }
  pub fn new(
    track_alias: Arc<AtomicU64>,
    full_track_name: FullTrackName,
    subscribe_message: Subscribe,
    subscriber: Arc<MOQTClient>,
    event_rx: UnboundedReceiver<TrackEvent>,
    cache: TrackCache,
    client_connection_id: usize,
    log_folder: String,
    config: &'static AppConfig,
  ) -> Self {
    let event_rx = Arc::new(Mutex::new(Some(event_rx)));
    let sub = Self::create_instance(
      track_alias.clone(),
      full_track_name,
      subscribe_message.request_id,
      subscribe_message,
      subscriber,
      event_rx,
      cache.clone(),
      client_connection_id,
      log_folder,
      config,
    );

    let track_alias = track_alias.load(Ordering::Relaxed);

    info!(
      "Created new Subscription instance for subscriber: {} track: {} subscription state: {:?}",
      client_connection_id, track_alias, sub.subscription_state
    );

    let mut instance = sub.clone();

    tokio::spawn(async move {
      loop {
        if instance.is_finished().await {
          break;
        }

        // Handle joining state
        {
          let state = instance.subscription_state.read().await;
          let start_location = state.start_location.clone();
          let last_received_object_location_opt = state.last_received_object_location.clone();
          let is_joining = state.is_joining;
          drop(state);
          if is_joining && start_location.is_some() {
            let start_location = start_location.unwrap_or_default();

            // Determine the upper bound for cache replay:
            //   - If last_received_object_location is set (e.g. reconnect after a
            //     brief disconnect), replay up to it.
            //   - Otherwise (initial subscribe — the common delay-mode case), replay
            //     up to the cache's current newest group at this moment. Any object
            //     newer than this snapshot will arrive via the live-forward path
            //     (`instance.receive()`) after this block clears is_joining.
            let replay_end = match last_received_object_location_opt {
              Some(loc) => Some(loc),
              None => cache.newest_group_id().await.map(|g| Location {
                group: g,
                object: u64::MAX,
              }),
            };

            if let Some(end) = replay_end
              && end > start_location
            {
              info!(
                "Joining state - subscriber: {} track: {} from location: {:?} to end: {:?}",
                instance.client_connection_id, track_alias, start_location, end
              );
              let mut object_receiver =
                cache.read_objects(start_location, end.clone(), false).await;

              let mut last_group: u64 = u64::MAX;
              let mut last_stream_id: Option<StreamId> = None;
              // Exactly what this replay pass delivers, keyed by
              // (group_id, subgroup_id) -> max object_id. Published into
              // SubscriptionState after the loop, so the replayed objects
              // themselves (which flow through handle_track_event below)
              // are never self-filtered.
              let mut replay_watermarks: HashMap<(u64, u64), u64> = HashMap::new();

              loop {
                match object_receiver.recv().await {
                  Some(event) => match event {
                    CacheConsumeEvent::NoObject => {
                      // there is no object found
                      break;
                    }
                    CacheConsumeEvent::Object(object) => {
                      let (header_info, stream_id) = if last_group == u64::MAX
                        || object.group_id > last_group
                      {
                        // create a subgroup header and send a track event

                        // TODO: check this. If is_some returns true, we may not need
                        // to check the length.
                        let has_extensions = object.extension_headers.as_ref().is_some();

                        // create a fake subgroup header using the object attributes
                        // TODO: It think contains_end_of_group should be checked by looking at
                        // the last object. Need to look into the draft.
                        let subgroup_header = HeaderInfo::Subgroup {
                          header: SubgroupHeader::new_with_explicit_id(
                            track_alias,
                            object.group_id,
                            object.subgroup_id,
                            object.publisher_priority,
                            has_extensions,
                            false,
                          ),
                        };
                        info!(
                          "FROM CACHE: Joining state - subscriber: {} track: {} sending subgroup header: {:?}",
                          instance.client_connection_id, track_alias, subgroup_header
                        );
                        last_group = object.group_id;
                        let stream_id = instance.get_stream_id(&subgroup_header);
                        last_stream_id = Some(stream_id);

                        (Some(subgroup_header), last_stream_id.clone())
                      } else {
                        (None, last_stream_id.clone())
                      };

                      // Record before `object` is moved below. Duplicates of
                      // these exact objects can already sit in this
                      // subscription's event queue (cached after
                      // add_subscription but before this group's snapshot);
                      // the live-forward path drops them via this watermark.
                      let wm = replay_watermarks
                        .entry((object.group_id, object.subgroup_id))
                        .or_insert(object.object_id);
                      if object.object_id > *wm {
                        *wm = object.object_id;
                      }

                      let the_object = Object::try_from_fetch(object, track_alias).unwrap();

                      let track_event = TrackEvent::SubgroupObject {
                        stream_id: stream_id.unwrap(),
                        object: the_object,
                        header_info,
                      };
                      info!(
                        "Joining state - subscriber: {} track: {} sending object location: {:?}",
                        instance.client_connection_id, track_alias, track_event
                      );
                      instance.handle_track_event(track_event).await;
                    }
                    CacheConsumeEvent::EndLocation(_) => {}
                  },
                  None => {
                    warn!("handle_fetch_messages | No object.");
                    break;
                  }
                }
              }

              // Record the nominal replay end (upper bound for a future
              // reconnect replay) and publish the per-subgroup watermarks of
              // what was ACTUALLY delivered. Dedup against queued live events
              // uses the watermarks, not this location: a single max-location
              // threshold would also swallow late arrivals the snapshot never
              // covered. Merge rather than replace, in case a future
              // reconnect path re-enters the joining block.
              let mut state = instance.subscription_state.write().await;
              state.last_received_object_location = Some(end);
              for (key, wm) in replay_watermarks.drain() {
                let entry = state.replay_watermarks.entry(key).or_insert(wm);
                if wm > *entry {
                  *entry = wm;
                }
              }
              drop(state);
            }

            let mut state = instance.subscription_state.write().await;
            state.is_joining = false;
            info!(
              "Finished joining state for subscriber: {} track: {}",
              instance.client_connection_id, track_alias
            );
          }
        }

        tokio::select! {
          biased;
          _ = instance.receive() => {
            continue;
          }
          // 1 second timeout to check if the subscription is still valid
          _ = tokio::time::sleep(tokio::time::Duration::from_secs(1)) => {
            // TODO: implement max timeout here
            continue;
          }
        }
      }
    });

    sub
  }

  pub async fn is_finished(&self) -> bool {
    self.finished.load(Ordering::Relaxed)
  }

  #[allow(dead_code)] // retained accessor; last non-dead caller was the excised subscription-pipeline switch gate
  pub async fn is_forwarding(&self) -> bool {
    let state = self.subscription_state.read().await;
    state.forward
  }

  // Returns true if the subscription is active (not finished and forwarding objects)
  #[allow(dead_code)] // retained accessor; no longer used after the PUBLISH-based SWITCH rework
  pub async fn is_active(&self) -> bool {
    !self.is_finished().await && self.is_forwarding().await
  }

  // This method updates the subscribe message with the new subscribe update
  // It ensures that the Start Location does not decrease and the End Group does not increase
  // Returns Ok if the update is successful
  // Returns error if the update is invalid
  pub async fn update_subscription(&self, subscribe_update: SubscribeUpdate) -> Result<()> {
    let mut state = self.subscription_state.write().await;
    // map subscribe_update fields to subscribe_message

    // The Start Location MUST NOT decrease
    // and the End Group MUST NOT increase.
    // In Draft-15 end group can be increased or decreased.
    if subscribe_update.start_location < state.start_location.clone().unwrap_or_default() {
      // invalid update
      return Err(anyhow::anyhow!(
        "Invalid SubscribeUpdate: Start Location cannot decrease. Current start location: {:?} Subscribe Update Start Location: {:?}",
        state.start_location,
        subscribe_update.start_location
      ));
    }

    // update subscription state
    state.start_location = Some(subscribe_update.start_location);
    state.subscriber_priority = subscribe_update.subscriber_priority;
    state.forward = subscribe_update.forward;
    // SUBSCRIBE_UPDATE keeps the wire sentinel: 0 = no end group.
    state.end_group = SubscriptionState::end_group_from_update_wire(subscribe_update.end_group);

    // update parameters. If a parameter included in SUBSCRIBE is not present in
    // SUBSCRIBE_UPDATE, its value remains unchanged.  There is no mechanism
    // to remove a parameter from a subscription.
    for param in subscribe_update.subscribe_parameters {
      if let Some(existing_param) = state
        .subscribe_parameters
        .iter_mut()
        .find(|p| p.is_same_type(&param))
      {
        *existing_param = param;
      } else {
        state.subscribe_parameters.push(param);
      }
    }

    info!(
      "update_subscription | new subscription state for {}: {:?}",
      self.track_alias(),
      state
    );
    Ok(())
  }

  pub async fn finish(&self) {
    if self
      .finished
      .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
      .is_err()
    {
      return;
    }

    info!(
      "Finishing subscription for subscriber: {} and track: {}",
      self.client_connection_id,
      self.track_alias()
    );

    let mut receiver_guard = self.event_rx.lock().await;
    let _ = receiver_guard.take(); // This replaces the Some(receiver) with None
    drop(receiver_guard); // Release the lock

    info!(
      "Subscription finished for subscriber: {} and track: {}",
      self.client_connection_id,
      self.track_alias()
    );

    // Close all send streams asynchronously to avoid blocking subscription cleanup
    let stream_ids = {
      let mut send_stream_last_object_ids = self.send_stream_last_object_ids.write().await;
      let ids = send_stream_last_object_ids
        .keys()
        .cloned()
        .collect::<Vec<_>>();
      send_stream_last_object_ids.clear();
      ids
    };

    if !stream_ids.is_empty() {
      let subscriber = self.subscriber.clone();
      let connection_id = self.client_connection_id;
      let track_alias = self.track_alias();

      // Spawn background task for graceful stream cleanup
      tokio::spawn(async move {
        info!(
          "Starting background cleanup of {} streams for subscriber: {} track: {}",
          stream_ids.len(),
          connection_id,
          track_alias
        );

        for stream_id in stream_ids.iter() {
          let res = subscriber.close_stream(stream_id).await;
          if let Err(e) = res {
            warn!(
              "Background stream cleanup error for subscriber: {} stream_id: {} track: {} error: {:?}",
              connection_id, stream_id, track_alias, e
            );
          } else if let Ok(closed) = res {
            if closed {
              debug!(
                "Background stream cleanup successful for subscriber: {} stream_id: {} track: {}",
                connection_id, stream_id, track_alias
              );
            } else {
              debug!(
                "Background stream cleanup: stream not found for subscriber: {} stream_id: {} track: {}",
                connection_id, stream_id, track_alias
              );
            }
          }
        }

        info!(
          "Background cleanup completed for subscriber: {} track: {} ({} streams)",
          connection_id,
          track_alias,
          stream_ids.len()
        );
      });
    }
  }

  async fn receive(&mut self) {
    debug!(
      "Receiving for subscriber: {} track: {}",
      self.client_connection_id,
      self.track_alias()
    );
    let mut event_rx_guard = self.event_rx.lock().await;

    if let Some(ref mut event_rx) = *event_rx_guard {
      match event_rx.recv().await {
        Some(event) => {
          if self.finished.load(Ordering::Relaxed) {
            return;
          }
          self.handle_track_event(event).await;
        }
        None => {
          // For unbounded receivers, recv() returns None when the channel is closed
          // The channel is closed, we should finish the subscription
          info!(
            "Event receiver closed for subscriber: {} track: {}, finishing subscription",
            self.client_connection_id,
            self.track_alias()
          );
          self.finish().await;
        }
      }
    } else {
      // No receiver available, subscription has been finished
      self.finish().await;
    }
  }

  async fn handle_track_event(&self, event: TrackEvent) {
    debug!(
      "Event received for subscriber: {} track: {} event: {:?}",
      self.client_connection_id,
      self.track_alias(),
      event
    );
    match event {
      TrackEvent::SubgroupObject {
        mut object,
        mut stream_id,
        header_info,
      } => {
        object.track_alias = self.track_alias();
        stream_id.track_alias = self.track_alias();
        // update last received object location
        {
          let mut state = self.subscription_state.write().await;
          state.update_last_received_object_location(object.location.clone());
        }

        let object_received_time = utils::passed_time_since_start();

        {
          let state = self.subscription_state.read().await;
          if let Some(start) = &state.start_location
            && object.location < *start
          {
            debug!(
              "Object before start location for subscriber: {} track: {} object location: {:?} start location: {:?}",
              self.client_connection_id,
              self.track_alias(),
              object.location,
              start
            );
            return;
          }

          // Joining-replay dedup: drop this event iff the replay already
          // delivered this exact object (its subgroup's watermark is at or
          // above its object ID). Without this, an object cached between
          // add_subscription and the replay's group snapshot is sent twice —
          // and both copies resolve to the SAME subgroup StreamId, producing
          // non-increasing object IDs on one QUIC stream, which a strict
          // MOQT receiver must treat as malformed. Objects with no
          // subgroup_id never appear in the replay (try_from_fetch always
          // sets Some), so they pass through unfiltered.
          if state.is_replay_duplicate(&object.location, object.subgroup_id) {
            debug!(
              "Duplicate of joining replay; skipping - subscriber: {} track: {} location: {:?}",
              self.client_connection_id,
              self.track_alias(),
              object.location
            );
            return;
          }

          if state.exceeds_end_group(object.location.group) {
            /* With Draft-15, the end group can be increased or decreased.
            TODO: Remove the following code after draft-15 support.
            info!(
              "Finishing subscription for subscriber: {} track: {}",
              self.client_connection_id, self.track_alias
            );
            self.finish().await;
            */
            debug!(
              "Object beyond end group for subscriber: {} track: {} object location: {:?} end group: {:?}",
              self.client_connection_id,
              self.track_alias(),
              object.location,
              state.end_group
            );
            return;
          }

          if !state.forward {
            return;
          }
        }

        // Handle header info if this is the first object
        let mut send_stream = if let Some(header) = header_info {
          if let HeaderInfo::Subgroup { header: _ } = header {
            info!(
              "Creating stream - subscriber: {} track: {} now: {} received time: {} object: {:?} header: {:?}",
              self.client_connection_id,
              self.track_alias(),
              utils::passed_time_since_start(),
              object_received_time,
              object.location,
              header
            );
            if let Ok((stream_id, send_stream)) = self.handle_header(header.clone()).await {
              {
                let mut send_stream_last_object_ids =
                  self.send_stream_last_object_ids.write().await;
                send_stream_last_object_ids.insert(stream_id.clone(), None);
              }
              info!(
                "Stream created - subscriber: {} stream_id: {} track: {} now: {} received time: {} object: {:?}",
                self.client_connection_id,
                stream_id,
                self.track_alias(),
                utils::passed_time_since_start(),
                object_received_time,
                object.location
              );
              Some(send_stream)
            } else {
              // TODO: maybe log error here?
              None
            }
          } else {
            error!(
              "Received Object event with non-subgroup header: {:?}",
              header
            );
            None
          }
        } else {
          self.subscriber.get_stream(&stream_id).await
        };

        if send_stream.is_none() {
          // wait a little bit and try again
          warn!(
            "Send stream not found, retrying - subscriber: {} stream_id: {} track: {} now: {} received time: {} object: {:?}",
            self.client_connection_id,
            stream_id,
            self.track_alias(),
            utils::passed_time_since_start(),
            object_received_time,
            object.location
          );
          tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
          send_stream = self.subscriber.get_stream(&stream_id).await;
        }

        if let Some(send_stream) = send_stream {
          // Get the previous object ID for this stream
          let previous_object_id = {
            let send_stream_last_object_ids = self.send_stream_last_object_ids.read().await;
            send_stream_last_object_ids
              .get(&stream_id)
              .cloned()
              .flatten()
          };

          // Foreign-upstream fan-out guard: a fetch-backfilled object can be
          // fanned out after live objects of the same (group, subgroup) were
          // already forwarded on this stream. Reachable when a non-moqtail
          // upstream ignores DELAY_GROUPS=0 and degrades the lazy upstream
          // subscription to LatestObject: the mid-flight group's head then
          // arrives only via the backfill FETCH, behind its own tail. Writing
          // a lower (or equal) object id onto an already-advanced subgroup
          // stream underflows the delta encoder and is malformed for any
          // strict receiver — skip the write. The object itself is not lost:
          // it sits in the (idempotent, sorted) cache, so joining replays and
          // catch-up/FETCH range reads still deliver it in order.
          if breaks_stream_monotonicity(previous_object_id, object.location.object) {
            debug!(
              "Non-monotonic object for already-advanced stream; skipping fan-out - subscriber: {} stream_id: {} previous: {:?} object: {:?}",
              self.client_connection_id,
              stream_id,
              previous_object_id,
              object.location
            );
            return;
          }

          debug!(
            "Received Object event: subscriber: {} stream_id: {} track: {} previous_object_id: {:?} object: {:?} now: {} received time: {}",
            self.client_connection_id,
            stream_id,
            self.track_alias(),
            previous_object_id,
            object,
            utils::passed_time_since_start(),
            object_received_time
          );

          // Log object properties with send status if enabled
          let write_result = self
            .handle_object(
              object.clone(),
              previous_object_id,
              &stream_id,
              send_stream.clone(),
            )
            .await;
          let send_status = write_result.is_ok();

          // Update the last object ID for this stream if successful
          if send_status {
            let mut send_stream_last_object_ids = self.send_stream_last_object_ids.write().await;
            send_stream_last_object_ids.insert(stream_id.clone(), Some(object.location.object));

            // Update last sent max location
            self
              .subscription_state
              .write()
              .await
              .update_last_sent_max_location(object.location.clone());
          }

          if self.config.enable_object_logging {
            self
              .object_logger
              .log_subscription_object(
                self.track_alias(),
                self.client_connection_id,
                &object,
                send_status,
                object_received_time,
              )
              .await;
          }
        } else {
          error!(
            "Received Object event without a valid send stream for subscriber: {} stream_id: {} track: {} object: {:?} now: {} received time: {}",
            self.client_connection_id,
            stream_id,
            self.track_alias(),
            object.location,
            utils::passed_time_since_start(),
            object_received_time
          );
        }
      }
      TrackEvent::DatagramObject { object } => {
        // Handle datagram object - serialize full MOQT datagram format
        // Must include type, track_alias, group_id, object_id, publisher_priority, and payload

        let mut norm_object = object.clone();
        norm_object.track_alias = self.track_alias();

        match norm_object.serialize() {
          Ok(serialized_bytes) => {
            if let Err(e) = self
              .subscriber
              .write_datagram_object(serialized_bytes)
              .await
            {
              error!("Failed to write datagram object: {:?}", e);
            }
          }
          Err(e) => {
            error!("Failed to serialize datagram object: {:?}", e);
          }
        }
      }
      TrackEvent::StreamClosed { mut stream_id } => {
        stream_id.track_alias = self.track_alias();
        info!(
          "Received StreamClosed event: subscriber: {} stream_id: {} track: {}",
          self.client_connection_id,
          stream_id,
          self.track_alias()
        );
        let _ = self.handle_stream_closed(&stream_id).await;
      }
      TrackEvent::PublisherDisconnected { reason } => {
        info!(
          "Received PublisherDisconnected event: subscriber: {}, reason: {} track: {}",
          self.client_connection_id,
          reason,
          self.track_alias()
        );

        // Send PublishDone message and finish the subscription
        if let Err(e) = self
          .send_publish_done(PublishDoneStatusCode::TrackEnded, &reason)
          .await
        {
          error!(
            "Failed to send PublishDone for publisher disconnect: subscriber: {} track: {} error: {:?}",
            self.client_connection_id,
            self.track_alias(),
            e
          );
        }

        // Finish the subscription since the publisher is gone
        self.finish().await;
      }
    }
  }

  async fn handle_header(
    &self,
    header_info: HeaderInfo,
  ) -> Result<(StreamId, Arc<Mutex<SendStream>>)> {
    // Handle the header information
    debug!("Handling header: {:?}", header_info);
    let stream_id = self.get_stream_id(&header_info);

    if let Ok(header_payload) = self.get_header_payload(&header_info).await {
      // hex dump the header payload
      debug!(
        "subscription::handle_object | header payload: {:?}",
        utils::bytes_to_hex(&header_payload)
      );

      // set priority based on the current time
      // TODO: revisit this logic to set priority based on the subscription
      let priority = i32::MAX - (utils::passed_time_since_start() % i32::MAX as u128) as i32;

      let send_stream = match self
        .subscriber
        .open_stream(&stream_id, header_payload, priority)
        .await
      {
        Ok(send_stream) => send_stream,
        Err(e) => {
          error!(
            "Failed to open stream {}: {:?} subscriber: {} track: {}",
            stream_id,
            e,
            self.client_connection_id,
            self.track_alias()
          );
          return Err(e);
        }
      };

      info!("Created stream: {}", stream_id.get_stream_id());

      Ok((stream_id, send_stream.clone()))
    } else {
      error!(
        "Failed to serialize header payload for stream {} subscriber: {} track: {}",
        stream_id,
        self.client_connection_id,
        self.track_alias()
      );
      Err(anyhow::anyhow!(
        "Failed to serialize header payload for stream {} subscriber: {} track: {}",
        stream_id,
        self.client_connection_id,
        self.track_alias()
      ))
    }
  }

  async fn handle_object(
    &self,
    object: Object,
    previous_object_id: Option<u64>,
    stream_id: &StreamId,
    send_stream: Arc<Mutex<SendStream>>,
  ) -> Result<()> {
    debug!(
      "Handling object track: {} location: {:?} stream_id: {} diff_ms: {}",
      object.track_alias,
      object.location,
      stream_id,
      utils::passed_time_since_start()
    );

    let object_location = object.location.clone();

    // This loop will keep the stream open and process incoming objects
    // TODO: revisit this logic to handle also fetch requests
    if let Ok(sub_object) = object.try_into_subgroup() {
      let has_extensions = sub_object.extension_headers.is_some();
      let object_bytes = match sub_object.serialize(previous_object_id, has_extensions) {
        Ok(data) => data,
        Err(e) => {
          error!(
            "Error in serializing object before writing to stream for subscriber {} track: {}, location: {:?}, previous_object_id: {:?}, error: {:?}",
            self.client_connection_id,
            self.track_alias(),
            object_location,
            previous_object_id,
            e
          );
          return Err(e.into());
        }
      };

      // uncomment to print hex dump of object bytes
      /*
      debug!(
        "subscription::handle_object | object bytes: {}",
        utils::bytes_to_hex(&object_bytes)
      );
      */

      self
        .subscriber
        .write_stream_object(
          stream_id,
          sub_object.object_id,
          object_bytes,
          Some(send_stream.clone()),
        )
        .await
        .map_err(|open_stream_err| {
          error!(
            "Error writing object to stream for subscriber {} track: {}, error: {:?}",
            self.client_connection_id,
            self.track_alias(),
            open_stream_err
          );
          open_stream_err
        })
    } else {
      debug!(
        "Could not convert object to subgroup. stream_id: {:?} subscriber: {} track: {}",
        stream_id,
        self.client_connection_id,
        self.track_alias()
      );
      Err(anyhow::anyhow!(
        "Could not convert object to subgroup. stream_id: {:?} subscriber: {} track: {}",
        stream_id,
        self.client_connection_id,
        self.track_alias()
      ))
    }
  }

  async fn handle_stream_closed(&self, stream_id: &StreamId) -> Result<()> {
    // Handle the stream closed event
    debug!("Stream closed: {}", stream_id.get_stream_id());

    // remove the stream id from send_stream_last_object_ids immediately
    let mut send_stream_last_object_ids = self.send_stream_last_object_ids.write().await;
    send_stream_last_object_ids.remove(stream_id);
    drop(send_stream_last_object_ids); // Release the lock immediately

    // Perform graceful stream closure in a separate task to avoid blocking
    // the main subscription event loop. This is critical for real-time media streaming
    // where blocking operations can disrupt video flow timing (25fps = ~40ms intervals)
    let subscriber = self.subscriber.clone();
    let stream_id = stream_id.clone();
    let connection_id = self.client_connection_id;
    let track_alias = self.track_alias();

    tokio::spawn(async move {
      debug!(
        "Starting graceful stream closure in background: subscriber: {} stream_id: {} track: {}",
        connection_id, stream_id, track_alias
      );

      let res = subscriber.close_stream(&stream_id).await;
      if let Err(e) = res {
        warn!(
          "handle_stream_closed | error for subscriber: {} stream_id: {} track: {} error: {:?}",
          connection_id, stream_id, track_alias, e
        );
      } else if let Ok(closed) = res {
        if closed {
          debug!(
            "handle_stream_closed | successful for subscriber: {} stream_id: {} track: {}",
            connection_id, stream_id, track_alias
          );
        } else {
          debug!(
            "handle_stream_closed | stream not found for subscriber: {} stream_id: {} track: {}",
            connection_id, stream_id, track_alias
          );
        }
      }
    });

    // Return immediately to avoid blocking the event loop
    Ok(())
  }

  async fn get_header_payload(&self, header_info: &HeaderInfo) -> Result<Bytes> {
    let connection_id = self.client_connection_id;

    let mut rewritten_header = header_info.clone();

    match &mut rewritten_header {
      HeaderInfo::Subgroup { header } => {
        header.track_alias = self.track_alias();

        header.serialize().map_err(|e| {
          error!(
            "Error serializing subgroup header: {:?} subscriber: {} track: {}",
            e,
            connection_id,
            self.track_alias()
          );
          e.into()
        })
      }
      HeaderInfo::Fetch {
        header,
        fetch_request: _,
      } => header.serialize().map_err(|e| {
        error!(
          "Error serializing fetch header: {:?} subscriber: {} track: {}",
          e,
          connection_id,
          self.track_alias()
        );
        e.into()
      }),
    }
  }

  fn get_stream_id(&self, header_info: &HeaderInfo) -> StreamId {
    utils::build_stream_id(self.track_alias(), header_info)
  }

  /// Send PublishDone message to this subscriber
  pub async fn send_publish_done(
    &self,
    status_code: PublishDoneStatusCode,
    reason: &str,
  ) -> Result<(), anyhow::Error> {
    let reason_phrase = ReasonPhrase::try_new(reason.to_string())
      .map_err(|e| anyhow::anyhow!("Failed to create reason phrase: {:?}", e))?;

    let publish_done = PublishDone::new(
      self.request_id,
      status_code,
      0, // stream_count - set to 0 as track is ending
      reason_phrase,
    );

    self
      .subscriber
      .queue_message(ControlMessage::PublishDone(Box::new(publish_done)))
      .await;

    info!(
      "Sent PublishDone to subscriber {} track: {} for request_id {}",
      self.client_connection_id,
      self.track_alias(),
      self.request_id
    );

    Ok(())
  }
}

#[cfg(test)]
mod tests_from_subscribe_is_joining {
  use super::*;
  use moqtail::model::common::{
    location::Location,
    pair::KeyValuePair,
    tuple::{Tuple, TupleField},
  };
  use moqtail::model::control::{constant::GroupOrder, subscribe::Subscribe};

  fn dummy_namespace() -> Tuple {
    Tuple::from_utf8_path("/test")
  }

  fn dummy_track_name() -> TupleField {
    TupleField::from_utf8("video")
  }

  #[test]
  fn is_joining_is_true_when_start_location_is_some() {
    // Mirror what compute_delayed_start + the subscribe handler do for
    // a filtered SUBSCRIBE: produce a Subscribe with start_location=Some(...).
    let sub = Subscribe::new_absolute_start(
      1, // request_id
      dummy_namespace(),
      dummy_track_name(),
      0, // priority
      GroupOrder::Original,
      true, // forward
      Location {
        group: 50,
        object: 0,
      },
      Vec::<KeyValuePair>::new(), // parameters
    );
    let state = SubscriptionState::from(sub);
    assert_eq!(
      state.start_location,
      Some(Location {
        group: 50,
        object: 0
      })
    );
    assert!(
      state.is_joining,
      "is_joining must be true when start_location is set, otherwise the \
       cache-replay path at lines 196-299 silently drops cached objects"
    );
  }

  #[test]
  fn is_joining_is_false_when_start_location_is_none() {
    // Today's default behavior: LatestObject SUBSCRIBE with no start_location
    // should leave is_joining=false (no cache replay needed; live-only flow).
    let sub = Subscribe::new_latest_object(
      1,
      dummy_namespace(),
      dummy_track_name(),
      0,
      GroupOrder::Original,
      true,
      Vec::<KeyValuePair>::new(),
    );
    let state = SubscriptionState::from(sub);
    assert_eq!(state.start_location, None);
    assert!(!state.is_joining);
  }
}

#[cfg(test)]
mod tests_replay_watermark_dedup {
  use super::*;
  use moqtail::model::common::{
    location::Location,
    pair::KeyValuePair,
    tuple::{Tuple, TupleField},
  };
  use moqtail::model::control::{constant::GroupOrder, subscribe::Subscribe};

  fn state_with_watermark(group: u64, subgroup: u64, max_object: u64) -> SubscriptionState {
    let sub = Subscribe::new_absolute_start(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      0,
      GroupOrder::Original,
      true,
      Location { group, object: 0 },
      Vec::<KeyValuePair>::new(),
    );
    let mut state = SubscriptionState::from(sub);
    state.replay_watermarks.insert((group, subgroup), max_object);
    state
  }

  #[test]
  fn object_at_or_below_watermark_is_duplicate() {
    // The exact race: the object was cached between add_subscription and the
    // replay's group snapshot, so it was replayed AND queued as a live event.
    // The queued copy must be dropped — both copies resolve to the same
    // subgroup StreamId, and a second write means non-increasing object IDs
    // on one QUIC stream, which a strict MOQT receiver treats as malformed.
    let state = state_with_watermark(10, 0, 5);
    assert!(state.is_replay_duplicate(&Location { group: 10, object: 5 }, Some(0)));
    assert!(state.is_replay_duplicate(&Location { group: 10, object: 0 }, Some(0)));
  }

  #[test]
  fn object_above_watermark_passes() {
    // Cached after the snapshot: only the live event exists; must pass.
    let state = state_with_watermark(10, 0, 5);
    assert!(!state.is_replay_duplicate(&Location { group: 10, object: 6 }, Some(0)));
  }

  #[test]
  fn interleaved_subgroup_straggler_passes() {
    // Why the watermark is per-(group, subgroup) and not a max location:
    // subgroup 1's object 3 can arrive after subgroup 0's object 9 was
    // replayed. It was never in the snapshot, so it must NOT be dropped —
    // a single max-location threshold (e.g. (group, u64::MAX)) would
    // swallow it and re-open a seam gap.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(&Location { group: 10, object: 3 }, Some(1)));
  }

  #[test]
  fn older_group_straggler_passes() {
    // Same argument across groups: a late object in a group the replay
    // never saw has no watermark and must pass.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(&Location { group: 9, object: 2 }, Some(0)));
  }

  #[test]
  fn object_without_subgroup_passes() {
    // try_from_fetch always sets Some(subgroup_id), so a replay can never
    // have delivered a subgroup-less object; never treat one as a duplicate.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(&Location { group: 10, object: 1 }, None));
  }

  #[test]
  fn empty_watermarks_never_filter() {
    // No replay ran (live-only LatestObject subscription): nothing filtered.
    let sub = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      0,
      GroupOrder::Original,
      true,
      Vec::<KeyValuePair>::new(),
    );
    let state = SubscriptionState::from(sub);
    assert!(!state.is_replay_duplicate(&Location { group: 0, object: 0 }, Some(0)));
  }
}

#[cfg(test)]
mod tests_end_group_bound {
  use super::*;
  use moqtail::model::common::{
    pair::KeyValuePair,
    tuple::{Tuple, TupleField},
  };
  use moqtail::model::control::{constant::GroupOrder, subscribe::Subscribe};

  fn unbounded_state() -> SubscriptionState {
    let sub = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      0,
      GroupOrder::Original,
      true,
      Vec::<KeyValuePair>::new(),
    );
    SubscriptionState::from(sub)
  }

  #[test]
  fn bound_at_group_zero_is_a_real_bound() {
    // THE sentinel regression (8934fff fix 3): the switch drain writes
    // Some(0) when G_switch == 1. Under the old u64 encoding this was 0 =
    // "no limit" and Group 1+ objects leaked across the seam.
    let mut state = unbounded_state();
    state.end_group = Some(0);
    assert!(state.exceeds_end_group(1), "Group 1 must be filtered");
    assert!(!state.exceeds_end_group(0), "Group 0 itself must pass");
  }

  #[test]
  fn none_means_unbounded() {
    let state = unbounded_state();
    assert_eq!(state.end_group, None);
    assert!(!state.exceeds_end_group(0));
    assert!(!state.exceeds_end_group(u64::MAX));
  }

  #[test]
  fn bound_is_inclusive() {
    let mut state = unbounded_state();
    state.end_group = Some(5);
    assert!(!state.exceeds_end_group(5));
    assert!(state.exceeds_end_group(6));
  }

  #[test]
  fn update_wire_zero_maps_to_unbounded() {
    // SUBSCRIBE_UPDATE keeps the wire sentinel (0 = no end group); it must
    // be translated at the boundary, never stored.
    assert_eq!(SubscriptionState::end_group_from_update_wire(0), None);
  }

  #[test]
  fn update_wire_nonzero_maps_to_bound() {
    assert_eq!(SubscriptionState::end_group_from_update_wire(7), Some(7));
  }
}

#[cfg(test)]
mod tests_stream_monotonicity_guard {
  use super::*;

  #[test]
  fn fresh_stream_never_blocks() {
    // Nothing sent yet: any first object id is valid, including 0 and
    // arbitrary mid-group ids (a joining replay's fake-header streams start
    // wherever the replay starts).
    assert!(!breaks_stream_monotonicity(None, 0));
    assert!(!breaks_stream_monotonicity(None, u64::MAX));
  }

  #[test]
  fn increasing_ids_pass() {
    assert!(!breaks_stream_monotonicity(Some(2), 3));
    // Gaps are legal on a subgroup stream (the delta encoder expresses them).
    assert!(!breaks_stream_monotonicity(Some(2), 10));
  }

  #[test]
  fn duplicate_id_is_blocked() {
    // Equal = live-vs-fetch duplicate that slipped past cache-level
    // suppression ordering; re-sending it is a protocol violation.
    assert!(breaks_stream_monotonicity(Some(3), 3));
  }

  #[test]
  fn late_lower_id_is_blocked() {
    // THE foreign-upstream case: the mid-flight group's head arrives via the
    // backfill FETCH after its tail was live-forwarded on the same stream.
    // wire = id - previous - 1 would underflow; the head must be dropped from
    // THIS stream (the sorted cache still serves it to replays and fetches).
    assert!(breaks_stream_monotonicity(Some(3), 0));
    assert!(breaks_stream_monotonicity(Some(3), 2));
  }
}
