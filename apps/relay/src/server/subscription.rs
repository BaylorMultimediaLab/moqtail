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
use crate::server::track::ActiveSubgroupHeaderMap;
use crate::server::track::TrackEvent;
use crate::server::track_cache::CacheConsumeEvent;
use crate::server::track_cache::TrackCache;
use crate::server::utils;
use anyhow::Result;
use bytes::Bytes;
use moqtail::model::common::location::Location;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::control::constant::FilterType;
use moqtail::model::control::constant::GroupOrder;
use moqtail::model::control::constant::PublishDoneStatusCode;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::control::request_update::RequestUpdate;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::data::constant::DEFAULT_PUBLISHER_PRIORITY;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::error::StreamResetCode;
use moqtail::model::parameter::message_parameter::{
  MessageParameter, apply_message_parameter_update,
};
use moqtail::transport::connection::TransportSendStream;
use moqtail::transport::data_stream_handler::HeaderInfo;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::Mutex;
use tokio::sync::Notify;
use tokio::sync::RwLock;
use tokio::sync::mpsc::UnboundedReceiver;
use tracing::trace;
use tracing::warn;
use tracing::{debug, error, info};

#[derive(Debug, Clone)]
pub enum SubscriptionOrigin {
  Subscribe(Subscribe),
  Publish(Publish),
}

impl SubscriptionOrigin {
  pub fn request_id(&self) -> u64 {
    match self {
      SubscriptionOrigin::Subscribe(s) => s.request_id,
      SubscriptionOrigin::Publish(p) => p.request_id,
    }
  }
}
impl From<Subscribe> for SubscriptionOrigin {
  fn from(msg: Subscribe) -> Self {
    SubscriptionOrigin::Subscribe(msg)
  }
}

impl From<Publish> for SubscriptionOrigin {
  fn from(msg: Publish) -> Self {
    SubscriptionOrigin::Publish(msg)
  }
}

#[derive(Debug, Clone)]
pub struct SubscriptionState {
  pub subscriber_priority: u8,
  pub group_order: GroupOrder,
  pub forward: bool,
  pub filter_type: FilterType,
  pub start_location: Option<Location>,
  /// Inclusive last group to forward; `None` = unbounded.
  pub end_group: Option<u64>,
  pub subscribe_parameters: Vec<MessageParameter>,
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

impl From<SubscriptionOrigin> for SubscriptionState {
  fn from(origin: SubscriptionOrigin) -> Self {
    match origin {
      SubscriptionOrigin::Subscribe(subscribe) => {
        let subscriber_priority = subscribe
          .subscribe_parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::SubscriberPriority { priority } = p {
              Some(*priority)
            } else {
              None
            }
          })
          .unwrap_or(128);

        let group_order = subscribe
          .subscribe_parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::GroupOrder { order } = p {
              Some(*order)
            } else {
              None
            }
          })
          .unwrap_or(GroupOrder::Ascending);

        let forward = subscribe
          .subscribe_parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::Forward { forward } = p {
              Some(*forward)
            } else {
              None
            }
          })
          .unwrap_or(true);

        let (filter_type, start_location, end_group) = subscribe
          .subscribe_parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::SubscriptionFilter {
              filter_type,
              start_location,
              end_group,
            } = p
            {
              Some((*filter_type, start_location.clone(), *end_group))
            } else {
              None
            }
          })
          .unwrap_or((FilterType::LatestObject, None, None));

        let is_joining = start_location.is_some();
        Self {
          subscriber_priority,
          group_order,
          forward,
          filter_type,
          start_location,
          end_group,
          subscribe_parameters: subscribe.subscribe_parameters,
          last_sent_max_location: None,
          last_received_object_location: None,
          replay_watermarks: HashMap::new(),
          // A SUBSCRIBE that names an explicit start location (delay-mode or
          // AbsoluteStart) must have
          // the cached objects in [start_location, live edge] replayed before
          // live objects flow. The replay path below is gated on `is_joining`;
          // without it those cached objects are silently dropped.
          is_joining,
        }
      }
      SubscriptionOrigin::Publish(publish) => {
        let subscriber_priority = publish
          .parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::SubscriberPriority { priority } = p {
              Some(*priority)
            } else {
              None
            }
          })
          .unwrap_or(128);

        let group_order = publish
          .parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::GroupOrder { order } = p {
              Some(*order)
            } else {
              None
            }
          })
          .unwrap_or(GroupOrder::Ascending);

        let forward = publish
          .parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::Forward { forward } = p {
              Some(*forward)
            } else {
              None
            }
          })
          .unwrap_or(true);

        let (filter_type, start_location, end_group) = publish
          .parameters
          .iter()
          .find_map(|p| {
            if let MessageParameter::SubscriptionFilter {
              filter_type,
              start_location,
              end_group,
            } = p
            {
              Some((*filter_type, start_location.clone(), *end_group))
            } else {
              None
            }
          })
          .unwrap_or((FilterType::LatestObject, None, None));

        Self {
          subscriber_priority,
          group_order,
          forward,
          filter_type,
          start_location,
          end_group,
          subscribe_parameters: publish.parameters,
          last_sent_max_location: None,
          last_received_object_location: None,
          replay_watermarks: HashMap::new(),
          is_joining: false,
        }
      }
    }
  }
}

/// Compute QUIC stream priority from MOQT scheduling parameters.
///
/// The i32 space is divided into 65536 bands (one per sub_prio × pub_prio pair).
/// Within each band, group_id determines relative position according to group_order:
///   Ascending / Original – lower group_id = higher priority (counts down from band_max)
///   Descending            – higher group_id = higher priority (counts up from band_min)
pub(crate) fn compute_stream_priority(
  sub_prio: u8,
  pub_prio: u8,
  group_order: GroupOrder,
  group_id: u64,
) -> i32 {
  const BAND_SIZE: i64 = 65536;
  let priority_index = (255 - sub_prio as i64) * 256 + (255 - pub_prio as i64);
  let band_min = i32::MIN as i64 + priority_index * BAND_SIZE;
  let group_slot = (group_id % BAND_SIZE as u64) as i64;
  match group_order {
    GroupOrder::Ascending | GroupOrder::Original => (band_min + BAND_SIZE - 1 - group_slot) as i32,
    GroupOrder::Descending => (band_min + group_slot) as i32,
  }
}

#[derive(Debug, Clone)]
pub struct Subscription {
  pub request_id: u64,
  relay_track_id: u64,
  #[allow(dead_code)] // retained for diagnostics; unread since the switch pipeline moved off it
  pub full_track_name: FullTrackName,
  pub subscription_state: Arc<RwLock<SubscriptionState>>,
  subscriber: Arc<MOQTClient>,
  event_rx: Arc<Mutex<Option<UnboundedReceiver<TrackEvent>>>>,
  send_stream_last_object_ids: Arc<RwLock<HashMap<StreamId, Option<u64>>>>,
  /// Monotonic count of data streams opened for this subscription, including
  /// empty subgroups. Reported as PUBLISH_DONE Stream Count.
  opened_stream_count: Arc<AtomicU64>,
  finished: Arc<AtomicBool>,
  #[allow(dead_code)]
  cache: TrackCache,
  client_connection_id: usize,
  object_logger: ObjectLogger,
  config: &'static AppConfig,
  /// Subgroup header cached while forward=false. Cleared when forward becomes true (stream opened)
  /// or when a new group starts (old group ended without forward ever becoming true).
  pending_header: Arc<Mutex<Option<(StreamId, HeaderInfo)>>>,
  /// Shared map of open publisher subgroup streams and their original subgroup header.
  /// Used to open a QUIC send stream for a new mid-group subscriber with the exact
  /// original header rather than a synthesized one.
  active_subgroup_headers: ActiveSubgroupHeaderMap,
  /// Set once the control message carrying this subscriber's track alias has gone out
  /// (SUBSCRIBE_OK, or PUBLISH when the relay pushes). Data streams carry only the
  /// alias, so a subscriber that gets one first cannot place it and drops the objects.
  /// Forwarding waits for this, and the queued Objects follow in order.
  alias_announced: Arc<AtomicBool>,
  alias_announced_notify: Arc<Notify>,
}

#[allow(clippy::too_many_arguments)]
impl Subscription {
  fn create_instance(
    relay_track_id: u64,
    full_track_name: FullTrackName,
    request_id: u64,
    origin_message: SubscriptionOrigin,
    subscriber: Arc<MOQTClient>,
    event_rx: Arc<Mutex<Option<UnboundedReceiver<TrackEvent>>>>,
    cache: TrackCache,
    client_connection_id: usize,
    log_folder: String,
    config: &'static AppConfig,
    active_subgroup_headers: ActiveSubgroupHeaderMap,
  ) -> Self {
    Self {
      relay_track_id,
      full_track_name,
      request_id,
      subscription_state: Arc::new(RwLock::new(origin_message.into())),
      subscriber,
      event_rx,
      send_stream_last_object_ids: Arc::new(RwLock::new(HashMap::new())),
      opened_stream_count: Arc::new(AtomicU64::new(0)),
      finished: Arc::new(AtomicBool::new(false)),
      cache,
      client_connection_id,
      object_logger: ObjectLogger::new(log_folder),
      config,
      pending_header: Arc::new(Mutex::new(None)),
      active_subgroup_headers,
      alias_announced: Arc::new(AtomicBool::new(false)),
      alias_announced_notify: Arc::new(Notify::new()),
    }
  }

  /// Called once the subscriber has been sent its track alias, releasing forwarding.
  pub fn mark_alias_announced(&self) {
    self.alias_announced.store(true, Ordering::Release);
    self.alias_announced_notify.notify_waiters();
  }

  /// Waits for the alias to be announced, giving up after `downstream_alias_timeout`
  /// so a subscription that never gets one still drains rather than queueing forever.
  async fn wait_for_alias_announced(&self) {
    if self.alias_announced.load(Ordering::Acquire) {
      return;
    }
    // Registered before the second check, so a notify landing between the two is not
    // lost. Waking can only come from mark_alias_announced, which sets the flag first.
    let notified = self.alias_announced_notify.notified();
    if self.alias_announced.load(Ordering::Acquire) || self.is_finished().await {
      return;
    }
    if tokio::time::timeout(self.config.downstream_alias_timeout, notified)
      .await
      .is_err()
    {
      warn!(
        "no track alias sent to subscriber {} within {:?}; forwarding anyway",
        self.client_connection_id, self.config.downstream_alias_timeout
      );
    }
  }

  pub fn new(
    relay_track_id: u64,
    full_track_name: FullTrackName,
    origin_message: SubscriptionOrigin,
    subscriber: Arc<MOQTClient>,
    event_rx: UnboundedReceiver<TrackEvent>,
    cache: TrackCache,
    client_connection_id: usize,
    log_folder: String,
    config: &'static AppConfig,
    active_subgroup_headers: ActiveSubgroupHeaderMap,
  ) -> Self {
    let event_rx = Arc::new(Mutex::new(Some(event_rx)));
    let sub = Self::create_instance(
      relay_track_id,
      full_track_name,
      origin_message.request_id(),
      origin_message,
      subscriber,
      event_rx,
      cache.clone(),
      client_connection_id,
      log_folder,
      config,
      active_subgroup_headers,
    );

    info!(
      "Created new Subscription instance for subscriber={} relay_track_id={} subscription state: {:?}",
      client_connection_id, relay_track_id, sub.subscription_state
    );

    let mut instance = sub.clone();

    tokio::spawn(async move {
      // Nothing may go out before the subscriber knows the alias those streams carry.
      instance.wait_for_alias_announced().await;

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
            //   - If last_received_object_location is set (e.g. a SWITCH seam or a
            //     reconnect), replay up to it.
            //   - Otherwise (initial subscribe -- the common delay-mode case), replay
            //     up to the cache's newest group at this moment. Anything newer
            //     arrives via the live-forward path after `is_joining` clears.
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
                "Joining state - subscriber={} relay_track_id={} from location: {:?} to end: {:?}",
                instance.client_connection_id, relay_track_id, start_location, end
              );
              // Exactly what this replay pass delivers, keyed by
              // (group_id, subgroup_id) -> max object_id. Published into
              // SubscriptionState after the loop, so the replayed objects
              // themselves (which flow through handle_track_event below)
              // are never self-filtered.
              let mut replay_watermarks: HashMap<(u64, u64), u64> = HashMap::new();
              {
                let mut object_receiver =
                  cache.read_objects(start_location, end.clone(), false).await;

                let mut last_group: u64 = u64::MAX;
                let mut last_stream_id: Option<StreamId> = None;

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
                          let has_properties = object.properties.as_ref().is_some();

                          // create a fake subgroup header using the object attributes
                          // TODO: It think contains_end_of_group should be checked by looking at
                          // the last object. Need to look into this.
                          let subgroup_header = HeaderInfo::Subgroup {
                            header: SubgroupHeader::new_with_explicit_id(
                              relay_track_id,
                              object.group_id,
                              object.subgroup_id,
                              Some(object.publisher_priority),
                              has_properties,
                              false,
                              // first_object: a relay
                              // forwarding a subgroup which begins with the subgroup's
                              // first-ever object MUST set FIRST_OBJECT. This cache-join
                              // path replays from `start_location`, which may be
                              // mid-subgroup, and the first-ever object is not
                              // necessarily object_id 0, so the cache does not tell us
                              // whether we are at that object. We therefore always leave
                              // FIRST_OBJECT unset here. This is a known conformance gap
                              // for the case where we do start at the first object;
                              // closing it is deferred to #229 / RS-14.
                              false,
                            ),
                          };
                          info!(
                            "FROM CACHE: Joining state - subscriber={} relay_track_id={} sending subgroup header: {:?}",
                            instance.client_connection_id, relay_track_id, subgroup_header
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

                        let the_object = Object::try_from_fetch(object, relay_track_id).unwrap();

                        let track_event = TrackEvent::SubgroupObject {
                          stream_id: stream_id.unwrap(),
                          object: the_object,
                          header_info,
                        };
                        info!(
                          "Joining state - subscriber={} relay_track_id={} sending object location: {:?}",
                          instance.client_connection_id, relay_track_id, track_event
                        );
                        instance.handle_track_event(track_event).await;
                      }
                      CacheConsumeEvent::EndLocation => {}
                    },
                    None => {
                      warn!("handle_fetch_messages | No object.");
                      break;
                    }
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
              "Finished joining state for subscriber={} relay_track_id={}",
              instance.client_connection_id, relay_track_id
            );
          }
        }

        tokio::select! {
          biased;
          _ = instance.receive() => {
            continue;
          }
          // TODO: implement max timeout here
          // 5 second timeout to check if the subscription is still valid
          _ = tokio::time::sleep(tokio::time::Duration::from_millis(5000)) => {
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

  /// Number of data streams opened for this subscription (PUBLISH_DONE Stream
  /// Count), including subgroups that carried no objects.
  pub fn opened_stream_count(&self) -> u64 {
    self.opened_stream_count.load(Ordering::Relaxed)
  }

  // Returns true if the subscription is active (not finished and forwarding objects)
  #[allow(dead_code)] // retained accessor; no longer used after the PUBLISH-based SWITCH rework
  pub async fn is_active(&self) -> bool {
    !self.is_finished().await && self.is_forwarding().await
  }

  pub fn subscriber(&self) -> Arc<MOQTClient> {
    self.subscriber.clone()
  }

  // This method updates the subscribe message with the new request update
  // Returns Ok if the update is successful
  // Returns error if the update is invalid
  pub async fn update_subscription(&self, request_update: RequestUpdate) -> Result<()> {
    let forward_becoming_true = {
      let mut state = self.subscription_state.write().await;

      // Extract filter_type, start_location and end_group from SubscriptionFilter parameter
      let (new_filter_type, new_start_location, new_end_group) = request_update
        .parameters
        .iter()
        .find_map(|p| {
          if let MessageParameter::SubscriptionFilter {
            filter_type,
            start_location,
            end_group,
          } = p
          {
            Some((Some(*filter_type), start_location.clone(), *end_group))
          } else {
            None
          }
        })
        .unwrap_or((None, None, None));

      if let Some(ref new_loc) = new_start_location {
        state.start_location = Some(new_loc.clone());
      }

      // Update explicit subscription state fields if they are present in the parameters.
      // Track whether forward transitions false to true so we can flush pending_header below.
      let mut transition = false;
      for param in &request_update.parameters {
        match param {
          MessageParameter::SubscriberPriority { priority } => {
            state.subscriber_priority = *priority;
          }
          MessageParameter::Forward { forward } => {
            if *forward && !state.forward {
              transition = true;
            }
            state.forward = *forward;
          }
          _ => {}
        }
      }

      if let Some(ft) = new_filter_type {
        state.filter_type = ft;
      }
      if let Some(eg) = new_end_group {
        state.end_group = Some(eg);
      }

      // Update parameters. If a parameter included in SUBSCRIBE is not present in
      // REQUEST_UPDATE, its value remains unchanged. There is no mechanism
      // to remove a parameter from a request.
      apply_message_parameter_update(&mut state.subscribe_parameters, request_update.parameters);

      info!(
        "update_subscription | new subscription state for relay_track_id={}: {:?}",
        self.relay_track_id, state
      );

      transition
      // write lock on subscription_state is dropped here
    };

    // If forward just became true, open the stream for the current mid-group header
    // that was cached while forward=false.
    if forward_becoming_true {
      let pending = self.pending_header.lock().await.take();
      if let Some((pending_stream_id, pending_header_info)) = pending {
        info!(
          "update_subscription | forward became true, opening pending stream {} for subscriber={} relay_track_id={}",
          pending_stream_id, self.client_connection_id, self.relay_track_id
        );
        if self.handle_header(pending_header_info).await.is_ok() {
          self
            .send_stream_last_object_ids
            .write()
            .await
            .insert(pending_stream_id, None);
        }
      }
    }

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
      "Finishing subscription for subscriber={} relay_track_id={}",
      self.client_connection_id, self.relay_track_id
    );

    info!(
      "Subscription finished for subscriber={} relay_track_id={}",
      self.client_connection_id, self.relay_track_id
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
      let relay_track_id = self.relay_track_id;

      // Spawn background task for graceful stream cleanup
      tokio::spawn(async move {
        info!(
          "Starting background cleanup of {} streams for subscriber={} relay_track_id={}",
          stream_ids.len(),
          connection_id,
          relay_track_id
        );

        for stream_id in stream_ids.iter() {
          let res = subscriber.close_stream(stream_id).await;
          if let Err(e) = res {
            warn!(
              "Background stream cleanup error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
              connection_id, stream_id, relay_track_id, e
            );
          } else if let Ok(closed) = res {
            if closed {
              debug!(
                "Background stream cleanup successful for subscriber={} stream_id={} relay_track_id={}",
                connection_id, stream_id, relay_track_id
              );
            } else {
              debug!(
                "Background stream cleanup: stream not found for subscriber={} stream_id={} relay_track_id={}",
                connection_id, stream_id, relay_track_id
              );
            }
          }
        }

        info!(
          "Background cleanup completed for subscriber={} relay_track_id={} ({} streams)",
          connection_id,
          relay_track_id,
          stream_ids.len()
        );
      });
    }
  }

  async fn receive(&mut self) {
    debug!(
      "Receiving for subscriber: {} track: {}",
      self.client_connection_id, self.relay_track_id
    );

    let mut event_rx_guard = self.event_rx.lock().await;
    let (recv_result, backlog) = {
      let Some(ref mut rx) = *event_rx_guard else {
        return;
      };
      let event = rx.recv().await;
      let backlog = rx.len();
      (event, backlog)
    };

    trace!(
      "Received event for subscriber={} relay_track_id={}: {:?}",
      self.client_connection_id, self.relay_track_id, recv_result
    );

    // Slow-subscriber shedding: once the queued backlog exceeds the limit, the
    // subscriber can't keep up, so reset its data streams with TOO_FAR_BEHIND.
    let max_lag = self.config.max_subscriber_lag;
    if max_lag > 0 && backlog as u64 > max_lag && !self.finished.load(Ordering::Relaxed) {
      warn!(
        "Subscriber {} too far behind on relay_track_id={} ({} queued > {}); resetting data streams (TOO_FAR_BEHIND)",
        self.client_connection_id, self.relay_track_id, backlog, max_lag
      );
      event_rx_guard.take();
      drop(event_rx_guard);
      self
        .reset_data_streams(StreamResetCode::TooFarBehind.to_u64())
        .await;
      self.finish().await;
      return;
    }

    match recv_result {
      Some(event) if !self.finished.load(Ordering::Relaxed) => {
        drop(event_rx_guard);
        self.handle_track_event(event).await;
      }
      Some(_) => {
        event_rx_guard.take();
      }
      None => {
        info!(
          "Event receiver closed for subscriber={} relay_track_id={}, finishing subscription",
          self.client_connection_id, self.relay_track_id
        );
        self.finish().await;
        event_rx_guard.take();
        drop(event_rx_guard);
      }
    }
  }

  /// Reset every data stream this subscription has opened with the given code.
  /// Resets every open data stream, draining the map so `finish` does not then try to
  /// close a stream that has already been reset.
  async fn reset_data_streams(&self, code: u64) {
    let stream_ids: Vec<StreamId> = {
      let mut map = self.send_stream_last_object_ids.write().await;
      map.drain().map(|(stream_id, _)| stream_id).collect()
    };
    for stream_id in stream_ids {
      self.subscriber.reset_stream(&stream_id, code).await;
    }
  }

  /// Ends the subscription because the subscriber cancelled it.
  ///
  /// A cancelled subscription's streams are reset, not finished. A finish is a FIN,
  /// which asks the peer to take delivery of everything already written — data the
  /// subscriber has just said it no longer wants.
  pub async fn cancel(&self) {
    info!(
      "Cancelling subscription for subscriber={} relay_track_id={}",
      self.client_connection_id, self.relay_track_id
    );
    self
      .reset_data_streams(StreamResetCode::Cancelled.to_u64())
      .await;
    self.finish().await;
  }

  async fn handle_track_event(&self, event: TrackEvent) {
    debug!(
      "Event received for subscriber={} relay_track_id={} event: {:?}",
      self.client_connection_id, self.relay_track_id, event
    );
    match event {
      TrackEvent::SubgroupObject {
        mut object,
        stream_id,
        header_info,
      } => {
        object.track_alias = self.relay_track_id;
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
              "Object before start location for subscriber={} relay_track_id={} object location: {:?} start location: {:?}",
              self.client_connection_id, self.relay_track_id, object.location, start
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
              "Duplicate of joining replay; skipping - subscriber={} relay_track_id={} location: {:?}",
              self.client_connection_id, self.relay_track_id, object.location
            );
            return;
          }

          if state.exceeds_end_group(object.location.group) {
            debug!(
              "Object beyond end group for subscriber={} relay_track_id={} object location: {:?} end group: {:?}",
              self.client_connection_id, self.relay_track_id, object.location, state.end_group
            );
            return;
          }

          if !state.forward {
            // Cache the subgroup header so we can open the stream immediately
            // if forward transitions to true mid-group (sub-update-forward method).
            if let Some(ref header) = header_info {
              let mut pending = self.pending_header.lock().await;
              *pending = Some((stream_id.clone(), header.clone()));
            }
            return;
          }
        }

        // Entering forward=true: clear any stale pending header (group boundary case).
        // If forward was already true, pending_header is None and this is a no-op.
        {
          let mut pending = self.pending_header.lock().await;
          pending.take();
        }

        // Handle header info if this is the first object
        let send_stream = if let Some(header) = header_info {
          if let HeaderInfo::Subgroup { header: _ } = header {
            info!(
              "Creating stream - subscriber={} relay_track_id={} now={} received time={} object: {:?} header: {:?}",
              self.client_connection_id,
              self.relay_track_id,
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
                "Stream created - subscriber={} stream_id={} relay_track_id={} now={} received time={} object: {:?}",
                self.client_connection_id,
                stream_id,
                self.relay_track_id,
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
          match self.subscriber.get_stream(&stream_id).await {
            Some(s) => Some(s),
            None => {
              // New subscriber joined mid-subgroup. Look up the original header
              // from the track-level cache and open a QUIC send stream with it.
              let cached = self
                .active_subgroup_headers
                .read()
                .await
                .get(&stream_id)
                .cloned();
              if let Some(h) = cached {
                debug!(
                  "mid-subgroup join: opening stream from cached header for subscriber={} relay_track_id={} stream_id={}",
                  self.client_connection_id, self.relay_track_id, stream_id
                );
                self
                  .handle_header(h)
                  .await
                  .ok()
                  .map(|(_, send_stream)| send_stream)
              } else {
                None
              }
            }
          }
        };

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
              self.client_connection_id, stream_id, previous_object_id, object.location
            );
            return;
          }

          debug!(
            "Received Object event: subscriber={} stream_id={} relay_track_id={} previous_object_id: {:?} object: {:?} now={} received time={}",
            self.client_connection_id,
            stream_id,
            self.relay_track_id,
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
            drop(send_stream_last_object_ids); // Release the lock immediately

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
                self.relay_track_id,
                self.client_connection_id,
                &object,
                send_status,
                object_received_time,
              )
              .await;
          }
        } else {
          error!(
            "Received Object event without a valid send stream for subscriber={} stream_id={} relay_track_id={} object: {:?} now={} received time={}",
            self.client_connection_id,
            stream_id,
            self.relay_track_id,
            object.location,
            utils::passed_time_since_start(),
            object_received_time
          );
        }
      }
      TrackEvent::Datagram { object } => {
        // Handle datagram - serialize full MOQT datagram format
        // Must include type, track_alias, group_id, object_id, publisher_priority, and payload

        let location = Location::new(object.group_id, object.object_id);
        {
          let mut state = self.subscription_state.write().await;
          state.update_last_received_object_location(location.clone());
        }

        // A datagram is subject to the same filter and forward state as any other
        // object. There is no stream to hold open, so nothing is cached for a later
        // forward transition: a datagram missed while paused is simply missed.
        {
          let state = self.subscription_state.read().await;
          if let Some(start) = &state.start_location
            && location < *start
          {
            debug!(
              "Datagram before start location for subscriber={} relay_track_id={} object location: {:?} start location: {:?}",
              self.client_connection_id, self.relay_track_id, location, start
            );
            return;
          }

          if state.exceeds_end_group(location.group) {
            debug!(
              "Datagram beyond end group for subscriber={} relay_track_id={} object location: {:?} end group: {:?}",
              self.client_connection_id, self.relay_track_id, location, state.end_group
            );
            return;
          }

          if !state.forward {
            debug!(
              "Not forwarding datagram for subscriber={} relay_track_id={}: forward state is 0",
              self.client_connection_id, self.relay_track_id
            );
            return;
          }
        }

        let mut norm_object = object.clone();
        norm_object.track_alias = self.relay_track_id;

        match norm_object.serialize() {
          Ok(serialized_bytes) => {
            if let Err(e) = self
              .subscriber
              .write_datagram_object(serialized_bytes)
              .await
            {
              error!("Failed to write datagram: {:?}", e);
            }
          }
          Err(e) => {
            error!("Failed to serialize datagram: {:?}", e);
          }
        }
      }
      TrackEvent::StreamClosed { stream_id } => {
        info!(
          "Received StreamClosed event: subscriber={} stream_id={} relay_track_id={}",
          self.client_connection_id, stream_id, self.relay_track_id
        );
        let _ = self.handle_stream_closed(&stream_id).await;
      }
      TrackEvent::PublisherDisconnected {
        status_code,
        reason,
      } => {
        info!(
          "Received PublisherDisconnected event: subscriber={}, status={:?} reason={} relay_track_id={}",
          self.client_connection_id, status_code, reason, self.relay_track_id
        );

        // Send PublishDone message and finish the subscription
        if let Err(e) = self.send_publish_done(status_code, &reason).await {
          error!(
            "Failed to send PublishDone for publisher disconnect: subscriber={} relay_track_id={} error: {:?}",
            self.client_connection_id, self.relay_track_id, e
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
  ) -> Result<(StreamId, Arc<Mutex<TransportSendStream>>)> {
    // Handle the header information
    debug!("Handling header: {:?}", header_info);
    let stream_id = self.get_stream_id(&header_info);

    if let Ok(header_payload) = self.get_header_payload(&header_info).await {
      // hex dump the header payload
      debug!(
        "subscription::handle_object | header payload: {:?}",
        utils::bytes_to_hex(&header_payload)
      );

      let (pub_prio, group_id) = match &header_info {
        HeaderInfo::Subgroup { header } => (
          header
            .publisher_priority
            .unwrap_or(DEFAULT_PUBLISHER_PRIORITY),
          header.group_id,
        ),
        HeaderInfo::Fetch { .. } => (DEFAULT_PUBLISHER_PRIORITY, 0u64),
      };
      let (sub_prio, group_order) = {
        let state = self.subscription_state.read().await;
        (state.subscriber_priority, state.group_order)
      };
      let priority = compute_stream_priority(sub_prio, pub_prio, group_order, group_id);

      let send_stream = match self
        .subscriber
        .open_stream(&stream_id, header_payload, priority)
        .await
      {
        Ok(send_stream) => send_stream,
        Err(e) => {
          error!(
            "Failed to open stream {}: {:?} subscriber={} relay_track_id={}",
            stream_id, e, self.client_connection_id, self.relay_track_id
          );
          return Err(e);
        }
      };

      info!("Created stream: {}", stream_id.get_stream_id());

      // Count every data stream opened for this subscription (PUBLISH_DONE
      // Stream Count), including subgroups that end up carrying no objects.
      self.opened_stream_count.fetch_add(1, Ordering::Relaxed);

      Ok((stream_id, send_stream.clone()))
    } else {
      error!(
        "Failed to serialize header payload for stream {} subscriber={} relay_track_id={}",
        stream_id, self.client_connection_id, self.relay_track_id
      );
      Err(anyhow::anyhow!(
        "Failed to serialize header payload for stream {} subscriber={} relay_track_id={}",
        stream_id,
        self.client_connection_id,
        self.relay_track_id
      ))
    }
  }

  async fn handle_object(
    &self,
    object: Object,
    previous_object_id: Option<u64>,
    stream_id: &StreamId,
    send_stream: Arc<Mutex<TransportSendStream>>,
  ) -> Result<()> {
    debug!(
      "Handling object relay_track_id={} location: {:?} stream_id={} diff_ms={}",
      self.relay_track_id,
      object.location,
      stream_id,
      utils::passed_time_since_start()
    );

    let object_location = object.location.clone();

    // This loop will keep the stream open and process incoming objects
    // TODO: revisit this logic to handle also fetch requests
    if let Ok(sub_object) = object.try_into_subgroup() {
      let has_properties = sub_object.properties.is_some();
      let object_bytes = match sub_object.serialize(previous_object_id, has_properties) {
        Ok(data) => data,
        Err(e) => {
          error!(
            "Error in serializing object before writing to stream for subscriber={} relay_track_id={}, location: {:?}, previous_object_id: {:?}, error: {:?}",
            self.client_connection_id, self.relay_track_id, object_location, previous_object_id, e
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
            "Error writing object to stream for subscriber={} relay_track_id={}, error: {:?}",
            self.client_connection_id, self.relay_track_id, open_stream_err
          );
          open_stream_err
        })
    } else {
      debug!(
        "Could not convert object to subgroup. stream_id: {:?} subscriber={} relay_track_id={}",
        stream_id, self.client_connection_id, self.relay_track_id
      );
      Err(anyhow::anyhow!(
        "Could not convert object to subgroup. stream_id: {:?} subscriber={} relay_track_id={}",
        stream_id,
        self.client_connection_id,
        self.relay_track_id
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
    let relay_track_id = self.relay_track_id;

    tokio::spawn(async move {
      debug!(
        "Starting graceful stream closure in background: subscriber={} stream_id={} relay_track_id={}",
        connection_id, stream_id, relay_track_id
      );

      let res = subscriber.close_stream(&stream_id).await;
      if let Err(e) = res {
        warn!(
          "handle_stream_closed | error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
          connection_id, stream_id, relay_track_id, e
        );
      } else if let Ok(closed) = res {
        if closed {
          debug!(
            "handle_stream_closed | successful for subscriber={} stream_id={} relay_track_id={}",
            connection_id, stream_id, relay_track_id
          );
        } else {
          debug!(
            "handle_stream_closed | stream not found for subscriber={} stream_id={} relay_track_id={}",
            connection_id, stream_id, relay_track_id
          );
        }
      }
    });

    // Return immediately to avoid blocking the event loop
    Ok(())
  }

  async fn get_header_payload(&self, header_info: &HeaderInfo) -> Result<Bytes> {
    let connection_id = self.client_connection_id;
    match header_info {
      HeaderInfo::Subgroup { header } => header.serialize(Some(self.relay_track_id)).map_err(|e| {
        error!(
          "Error serializing subgroup header: {:?} subscriber={} relay_track_id={}",
          e, connection_id, self.relay_track_id
        );
        e.into()
      }),
      HeaderInfo::Fetch {
        header,
        fetch_request: _,
      } => header.serialize().map_err(|e| {
        error!(
          "Error serializing fetch header: {:?} subscriber={} relay_track_id={}",
          e, connection_id, self.relay_track_id
        );
        e.into()
      }),
    }
  }

  fn get_stream_id(&self, header_info: &HeaderInfo) -> StreamId {
    utils::build_stream_id(self.relay_track_id, header_info)
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
      status_code,
      self.opened_stream_count.load(Ordering::Relaxed),
      reason_phrase,
    );

    // PUBLISH_DONE ends a subscription, so it belongs on that subscription's own
    // request stream rather than the control stream.
    if !self
      .subscriber
      .send_response(
        self.request_id,
        ControlMessage::PublishDone(Box::new(publish_done)),
      )
      .await
    {
      warn!(
        "No request stream for subscriber={} request_id={}; PUBLISH_DONE dropped",
        self.client_connection_id, self.request_id
      );
      return Ok(());
    }

    info!(
      "Sent PublishDone to subscriber={} relay_track_id={} for request_id={} stream_count={}",
      self.client_connection_id,
      self.relay_track_id,
      self.request_id,
      self.opened_stream_count.load(Ordering::Relaxed)
    );

    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use moqtail::model::control::constant::GroupOrder;

  #[test]
  fn test_highest_priority_near_i32_max() {
    let p = compute_stream_priority(0, 0, GroupOrder::Ascending, 0);
    assert!(
      p > 2_100_000_000,
      "highest priority should be near i32::MAX, got {p}"
    );
  }

  #[test]
  fn test_lowest_priority_near_i32_min() {
    let p = compute_stream_priority(255, 255, GroupOrder::Ascending, 0);
    assert!(
      p < -2_100_000_000,
      "lowest priority should be near i32::MIN, got {p}"
    );
  }

  #[test]
  fn test_ascending_lower_group_higher_priority() {
    let p0 = compute_stream_priority(0, 0, GroupOrder::Ascending, 0);
    let p1 = compute_stream_priority(0, 0, GroupOrder::Ascending, 1);
    assert!(p0 > p1, "group 0 should outrank group 1 in Ascending order");
  }

  #[test]
  fn test_descending_higher_group_higher_priority() {
    let p0 = compute_stream_priority(0, 0, GroupOrder::Descending, 0);
    let p1 = compute_stream_priority(0, 0, GroupOrder::Descending, 1);
    assert!(
      p1 > p0,
      "group 1 should outrank group 0 in Descending order"
    );
  }

  #[test]
  fn test_original_same_as_ascending() {
    for g in [0u64, 1, 100, 65535] {
      assert_eq!(
        compute_stream_priority(10, 20, GroupOrder::Original, g),
        compute_stream_priority(10, 20, GroupOrder::Ascending, g),
        "Original should behave like Ascending for group {g}"
      );
    }
  }

  #[test]
  fn test_subscriber_priority_dominates() {
    // sub=0,pub=255 must outrank sub=1,pub=0 regardless of group
    let high = compute_stream_priority(0, 255, GroupOrder::Ascending, 0);
    let low = compute_stream_priority(1, 0, GroupOrder::Ascending, 0);
    assert!(
      high > low,
      "subscriber priority must dominate publisher priority"
    );
  }

  #[test]
  fn test_publisher_priority_tie_break() {
    let high = compute_stream_priority(10, 0, GroupOrder::Ascending, 0);
    let low = compute_stream_priority(10, 1, GroupOrder::Ascending, 0);
    assert!(high > low, "lower pub_prio number = higher priority");
  }

  #[test]
  fn test_all_values_within_i32_range() {
    for sub in [0u8, 128, 255] {
      for pub_ in [0u8, 128, 255] {
        for &order in &[
          GroupOrder::Ascending,
          GroupOrder::Descending,
          GroupOrder::Original,
        ] {
          for group in [0u64, 1, 65534, 65535, 65536, u64::MAX] {
            let _ = compute_stream_priority(sub, pub_, order, group); // must not panic/overflow
          }
        }
      }
    }
  }
}

#[cfg(test)]
mod tests_from_subscribe_is_joining {
  use super::*;
  use moqtail::model::common::tuple::{Tuple, TupleField};

  fn dummy_namespace() -> Tuple {
    Tuple::from_utf8_path("/test")
  }

  fn dummy_track_name() -> TupleField {
    TupleField::from_utf8("video")
  }

  #[test]
  fn is_joining_is_true_when_start_location_is_some() {
    let sub = Subscribe::new_absolute_start(
      1,
      dummy_namespace(),
      dummy_track_name(),
      Location {
        group: 50,
        object: 0,
      },
      vec![],
    );
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
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
       cache-replay path silently drops cached objects"
    );
  }

  #[test]
  fn is_joining_is_false_when_start_location_is_none() {
    let sub = Subscribe::new_latest_object(1, dummy_namespace(), dummy_track_name(), vec![]);
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    assert_eq!(state.start_location, None);
    assert!(!state.is_joining);
  }
}

#[cfg(test)]
mod tests_replay_watermark_dedup {
  use super::*;
  use moqtail::model::common::tuple::{Tuple, TupleField};

  fn state_with_watermark(group: u64, subgroup: u64, max_object: u64) -> SubscriptionState {
    let sub = Subscribe::new_absolute_start(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      Location { group, object: 0 },
      vec![],
    );
    let mut state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    state
      .replay_watermarks
      .insert((group, subgroup), max_object);
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
    assert!(state.is_replay_duplicate(
      &Location {
        group: 10,
        object: 5
      },
      Some(0)
    ));
    assert!(state.is_replay_duplicate(
      &Location {
        group: 10,
        object: 0
      },
      Some(0)
    ));
  }

  #[test]
  fn object_above_watermark_passes() {
    // Cached after the snapshot: only the live event exists; must pass.
    let state = state_with_watermark(10, 0, 5);
    assert!(!state.is_replay_duplicate(
      &Location {
        group: 10,
        object: 6
      },
      Some(0)
    ));
  }

  #[test]
  fn interleaved_subgroup_straggler_passes() {
    // Why the watermark is per-(group, subgroup) and not a max location:
    // subgroup 1's object 3 can arrive after subgroup 0's object 9 was
    // replayed. It was never in the snapshot, so it must NOT be dropped —
    // a single max-location threshold (e.g. (group, u64::MAX)) would
    // swallow it and re-open a seam gap.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(
      &Location {
        group: 10,
        object: 3
      },
      Some(1)
    ));
  }

  #[test]
  fn older_group_straggler_passes() {
    // Same argument across groups: a late object in a group the replay
    // never saw has no watermark and must pass.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(
      &Location {
        group: 9,
        object: 2
      },
      Some(0)
    ));
  }

  #[test]
  fn object_without_subgroup_passes() {
    // try_from_fetch always sets Some(subgroup_id), so a replay can never
    // have delivered a subgroup-less object; never treat one as a duplicate.
    let state = state_with_watermark(10, 0, 9);
    assert!(!state.is_replay_duplicate(
      &Location {
        group: 10,
        object: 1
      },
      None
    ));
  }

  #[test]
  fn empty_watermarks_never_filter() {
    // No replay ran (live-only LatestObject subscription): nothing filtered.
    let sub = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      vec![],
    );
    let state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    assert!(!state.is_replay_duplicate(
      &Location {
        group: 0,
        object: 0
      },
      Some(0)
    ));
  }
}

#[cfg(test)]
mod tests_end_group_bound {
  use super::*;
  use moqtail::model::common::tuple::{Tuple, TupleField};

  fn unbounded_state() -> SubscriptionState {
    let sub = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path("/test"),
      TupleField::from_utf8("video"),
      vec![],
    );
    SubscriptionState::from(SubscriptionOrigin::from(sub))
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
