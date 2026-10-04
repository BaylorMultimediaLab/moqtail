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
use crate::server::config::AppConfig;
use crate::server::events;
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
  pub end_group: u64,
  pub subscribe_parameters: Vec<MessageParameter>,
  pub last_sent_max_location: Option<Location>,
  pub last_received_object_location: Option<Location>,
  pub is_joining: bool,
  /// Highest object id the cache replay wrote on each data stream (keyed by the
  /// relay-side StreamId: track, group, subgroup). An object of the newest group
  /// that arrived between this subscription's registration and the replay's read
  /// of that group is both in the cache and in the live queue; the live copy is
  /// dropped when it is at or below this mark. Per stream rather than one
  /// watermark, so a late object of an earlier group (streams are ingested
  /// concurrently) is not mistaken for a duplicate.
  pub replayed_through: HashMap<StreamId, u64>,
}

impl SubscriptionState {
  /// Whether `object_id` on `stream_id` was already delivered by the cache replay.
  pub fn covered_by_replay(&self, stream_id: &StreamId, object_id: u64) -> bool {
    self
      .replayed_through
      .get(stream_id)
      .is_some_and(|max| object_id <= *max)
  }

  fn record_replayed(&mut self, stream_id: StreamId, object_id: u64) {
    self
      .replayed_through
      .entry(stream_id)
      .and_modify(|max| *max = (*max).max(object_id))
      .or_insert(object_id);
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
              Some((*filter_type, start_location.clone(), end_group.unwrap_or(0)))
            } else {
              None
            }
          })
          .unwrap_or((FilterType::LatestObject, None, 0));

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
          // A SUBSCRIBE that names an explicit start location (delay-mode or
          // AbsoluteStart) must have
          // the cached objects in [start_location, live edge] replayed before
          // live objects flow. The replay path below is gated on `is_joining`;
          // without it those cached objects are silently dropped.
          is_joining,
          replayed_through: HashMap::new(),
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
              Some((*filter_type, start_location.clone(), end_group.unwrap_or(0)))
            } else {
              None
            }
          })
          .unwrap_or((FilterType::LatestObject, None, 0));

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
          is_joining: false,
          replayed_through: HashMap::new(),
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

/// QUIC stream priority of the relay's synthetic `.probe:` streams (M3).
///
/// The lowest slot the formula above can produce: subscriber and publisher priority
/// 255 (the lowest band) and the last group slot of that band. A literal 0 sat in the
/// middle of the i32 range, which is above every video stream of a subscriber whose
/// priority is 128 (the default the promoted subscription fell back to) and below
/// those of a priority-0 subscriber, so whether the probe starved video depended on
/// which SUBSCRIBE created the subscription. This value is below every video stream
/// for any subscriber priority other than the (255, 255) corner, where it ties.
pub(crate) fn probe_stream_priority() -> i32 {
  compute_stream_priority(255, 255, GroupOrder::Ascending, u64::MAX)
}

/// Per-subscription counters of what the forwarding path did, for tests and
/// diagnostics. Not reset.
#[derive(Debug, Default)]
pub(crate) struct SubscriptionCounters {
  /// Objects QUIC accepted (OBJECT_SENT.sent = true), replayed or live.
  pub objects_written: AtomicU64,
  /// Objects whose serialize or write failed (OBJECT_SENT.sent = false).
  pub write_failures: AtomicU64,
  /// Live objects dropped because the cache replay had already delivered them.
  pub live_duplicates_dropped: AtomicU64,
}

#[derive(Debug, Clone)]
pub struct Subscription {
  pub request_id: u64,
  relay_track_id: u64,
  pub full_track_name: FullTrackName,
  pub subscription_state: Arc<RwLock<SubscriptionState>>,
  pub(crate) counters: Arc<SubscriptionCounters>,
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
  check_switch_context_on_next_object: Arc<AtomicBool>,
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
      counters: Arc::new(SubscriptionCounters::default()),
      subscriber,
      event_rx,
      send_stream_last_object_ids: Arc::new(RwLock::new(HashMap::new())),
      opened_stream_count: Arc::new(AtomicU64::new(0)),
      finished: Arc::new(AtomicBool::new(false)),
      cache,
      client_connection_id,
      object_logger: ObjectLogger::new(log_folder),
      config,
      check_switch_context_on_next_object: Arc::new(AtomicBool::new(false)),
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

                        let replay_stream_id = stream_id.clone().unwrap();
                        let replayed_object_id = object.object_id;
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
                        // Whatever the write did, the live copy of this object (if one
                        // is queued) must not be written on the same stream again.
                        instance
                          .subscription_state
                          .write()
                          .await
                          .record_replayed(replay_stream_id, replayed_object_id);
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
              // The live path's duplicate filter is `replayed_through` (per stream,
              // recorded above as each object is replayed), not this location.
              let mut state = instance.subscription_state.write().await;
              state.last_received_object_location = Some(end);
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
        state.end_group = eg;
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

  // Notify the subscription to check the switch context on the next object
  pub async fn notify_switch(&self) {
    info!(
      "Notifying subscription to check switch context on next object for subscriber={} relay_track_id={}",
      self.client_connection_id, self.relay_track_id
    );
    self
      .check_switch_context_on_next_object
      .store(true, std::sync::atomic::Ordering::Relaxed);
  }

  async fn check_switch_context(&self, object_location: &Location) -> bool {
    // if the object is after the end group, finish the subscription
    let status = self
      .subscriber
      .switch_context
      .get_switch_status(&self.full_track_name)
      .await;

    if status.is_none() {
      // not in a switch context, always forward
      return true;
    }

    let status = status.unwrap();

    match status {
      SwitchStatus::Next => {
        // check whether the group id of this track
        // is equal to or greater than the one of
        // the switch context's current track
        // if so, set this track as current
        let mut switch_at_next_group = false;
        let mut new_start_location = None;
        let current_track_name = self.subscriber.switch_context.get_current().await;
        let mut old_last_sent_max: Option<Location> = None;

        if let Some(current_track_name) = current_track_name.clone() {
          let current_subscription_opt = self
            .subscriber
            .subscriptions
            .get_subscription(&current_track_name)
            .await;

          if let Some(current_subscription) = current_subscription_opt
            && let Some(current_subscription) = current_subscription.upgrade()
          {
            let current_subscription = current_subscription.read().await;
            let current_state = current_subscription.subscription_state.read().await;
            let last_sent_max_location = current_state.last_sent_max_location.clone();
            old_last_sent_max = last_sent_max_location.clone();

            if let Some(loc) = last_sent_max_location {
              switch_at_next_group = object_location.group >= loc.group;
              let mut loc_clone = loc.clone();
              loc_clone.group += 1; // switch at the next group after the last sent max location of the current track
              loc_clone.object = 0; // reset object id to 0 to read from the start of the group
              new_start_location = Some(loc_clone);
            } else {
              // if there is no last sent location, we can switch
              switch_at_next_group = true;
            }
          }
        } else {
          // no current track, we can switch
          switch_at_next_group = true;
        }

        if switch_at_next_group {
          // set this track as current
          let subscriber = self.subscriber.clone();
          let full_track_name = self.full_track_name.clone();

          // the following method also sets the current active track's status to None if any
          info!(
            "check_switch_context: Setting track to Current for subscriber={} relay_track_id={} object location group: {}",
            self.client_connection_id, self.relay_track_id, object_location.group
          );
          subscriber
            .switch_context
            .add_or_update_switch_item(full_track_name.clone(), SwitchStatus::Current)
            .await;

          // set forward to true and set start group the next group
          let mut state = self.subscription_state.write().await;
          state.forward = true;

          state.is_joining = true;

          if new_start_location.is_some() {
            state.start_location = new_start_location;
          } else {
            state.start_location = Some(Location {
              object: 0,
              group: object_location.group + 1,
            });
          }

          state.end_group = 0; // remove end group limit

          // old_track / old_last_sent_group: the track this one replaces and the
          // group its last accepted write belonged to (the seam's anchor: start_group
          // is that + 1). trigger_forwarded: as shipped the trigger is never forwarded
          // (this branch returns false below).
          events::emit(
            "SWITCH_PROMOTED",
            serde_json::json!({
              "conn": self.client_connection_id,
              "relay_track_id": self.relay_track_id,
              "track": events::track_name_string(&self.full_track_name),
              "trigger_group": object_location.group,
              "trigger_object": object_location.object,
              "start_group": state.start_location.as_ref().map(|l| l.group),
              "old_track": current_track_name.as_ref().map(events::track_name_string),
              "old_last_sent_group": old_last_sent_max.as_ref().map(|l| l.group),
              "trigger_forwarded": false,
            }),
          );

          info!(
            "check_switch_context: Will forward objects for subscriber={} relay_track_id={} starting from group: {}",
            self.client_connection_id,
            self.relay_track_id,
            state.start_location.as_ref().unwrap().group
          );
        } else {
          // Do not forward objects for Next status until switch condition is met
          // set forward to false if it is true
          if self.is_forwarding().await {
            info!(
              "check_switch_context: Setting forward to false for Next track for subscriber={} relay_track_id={} object location group: {}",
              self.client_connection_id, self.relay_track_id, object_location.group
            );
            self.subscription_state.write().await.forward = false;
          }
        }
        // even if the switch_at_next_group is true,
        // we return false here to wait for the next group to switch
        false
      }
      SwitchStatus::Current => true,
      SwitchStatus::None => {
        // set forward to false if it is true
        if self.is_forwarding().await {
          info!(
            "check_switch_context: Setting end group to {} for None track for subscriber={} relay_track_id={}",
            object_location.group, self.client_connection_id, self.relay_track_id
          );
          let mut state = self.subscription_state.write().await;
          state.forward = false;
          state.end_group = object_location.group;
          // The moment this (demoted) track stops forwarding: last_group is the group
          // of its last accepted write, i.e. the old side of the seam; stop_group is
          // the group whose first object found it demoted (not forwarded). Its open
          // streams are FIN'd as the publisher's close, not reset.
          events::emit(
            "SWITCH_DEMOTED",
            serde_json::json!({
              "conn": self.client_connection_id,
              "relay_track_id": self.relay_track_id,
              "old_track": events::track_name_string(&self.full_track_name),
              "last_group": state.last_sent_max_location.as_ref().map(|l| l.group),
              "last_object": state.last_sent_max_location.as_ref().map(|l| l.object),
              "stop_group": object_location.group,
              "stop_object": object_location.object,
            }),
          );
        }

        false
      }
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
        if self.live_event_covered_by_replay(&event).await {
          return;
        }
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

  /// Live path only: whether this queued event repeats an object the cache replay
  /// already handed to the serializer, in which case it is dropped and counted.
  ///
  /// An object that arrived between this subscription's registration (from when the
  /// track fans live objects into its queue) and the replay's read of its group is in
  /// both. Written again it would follow itself on the same stream, and the object-id
  /// delta cannot encode that ("Error in serializing object", OBJECT_SENT.sent =
  /// false); if it carries the subgroup header it would open a second stream for the
  /// group and deliver the replayed objects twice. Per (group, subgroup) stream, at or
  /// below the highest object id the replay wrote there.
  ///
  /// A StreamClosed for a replayed stream retires its mark: the publisher's stream has
  /// ended, so nothing more of it can be queued.
  async fn live_event_covered_by_replay(&self, event: &TrackEvent) -> bool {
    match event {
      TrackEvent::SubgroupObject {
        stream_id, object, ..
      } => {
        let covered = self
          .subscription_state
          .read()
          .await
          .covered_by_replay(stream_id, object.location.object);
        if covered {
          self
            .counters
            .live_duplicates_dropped
            .fetch_add(1, Ordering::Relaxed);
          debug!(
            "Dropping live copy of replayed object for subscriber={} relay_track_id={} stream_id={} location: {:?}",
            self.client_connection_id, self.relay_track_id, stream_id, object.location
          );
        }
        covered
      }
      TrackEvent::StreamClosed { stream_id } => {
        let mut state = self.subscription_state.write().await;
        if !state.replayed_through.is_empty() {
          state.replayed_through.remove(stream_id);
        }
        false
      }
      _ => false,
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

        // Check switch context state if needed
        // Whether when a new header is received or when notified about a switch context change
        let check_switch = self
          .check_switch_context_on_next_object
          .load(std::sync::atomic::Ordering::Relaxed);
        if header_info.is_some() || check_switch {
          if check_switch {
            self
              .check_switch_context_on_next_object
              .store(false, std::sync::atomic::Ordering::Relaxed);
          }
          // Check whether this track is in a switch context and update forward state
          if !self.check_switch_context(&object.location).await {
            // if this returns false, do not start the stream
            info!(
              "Not forwarding object for subscriber={} relay_track_id={} due to switch context state",
              self.client_connection_id, self.relay_track_id
            );
            return;
          }
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

          if state.end_group > 0 && object.location.group > state.end_group {
            debug!(
              "Object beyond end group for subscriber={} relay_track_id={} object location: {:?} end group: {}",
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
          if send_status {
            self
              .counters
              .objects_written
              .fetch_add(1, Ordering::Relaxed);
          } else {
            self.counters.write_failures.fetch_add(1, Ordering::Relaxed);
          }

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
            // Experiment log: one record per object handed to this subscriber's
            // QUIC stream (the client logs OBJECT_RECV per object appended), so a
            // group the client did not get can be traced to the relay's filter,
            // the stream (reset / never sent) or the client library.
            crate::server::events::emit(
              "OBJECT_SENT",
              serde_json::json!({
                "conn": self.client_connection_id,
                "relay_track_id": self.relay_track_id,
                "track": crate::server::events::track_name_string(&self.full_track_name),
                "request_id": self.request_id,
                "group": object.location.group,
                "object": object.location.object,
                "sent": send_status,
              }),
            );
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

          if state.end_group > 0 && location.group > state.end_group {
            debug!(
              "Datagram beyond end group for subscriber={} relay_track_id={} object location: {:?} end group: {}",
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

  /// M3: the probe must never outrank video, whatever subscriber priority the
  /// SUBSCRIBE (or a promoted SWITCH subscription) ended up with. Checked for the
  /// two priorities that occur in the harness (0 from the player, 128 the relay
  /// default) across every publisher priority, both group orders and the group
  /// slots at the band edges.
  #[test]
  fn probe_priority_is_below_every_video_band_for_subscriber_priorities_0_and_128() {
    let probe = probe_stream_priority();
    assert_eq!(
      probe,
      i32::MIN,
      "probe takes the lowest slot of the lowest band"
    );
    for sub in [0u8, 128] {
      for pub_ in 0u8..=255 {
        for &order in &[
          GroupOrder::Ascending,
          GroupOrder::Original,
          GroupOrder::Descending,
        ] {
          for group in [0u64, 1, 1000, 65534, 65535, 65536, u64::MAX] {
            let video = compute_stream_priority(sub, pub_, order, group);
            assert!(
              video > probe,
              "video (sub={sub} pub={pub_} order={order:?} group={group}) = {video} must outrank probe {probe}"
            );
          }
        }
      }
    }
  }

  /// A literal 0 (the previous probe priority) is NOT below video for a
  /// priority-128 subscriber: this is the defect the derived value fixes.
  #[test]
  fn literal_zero_would_outrank_default_priority_video() {
    let video_default_sub = compute_stream_priority(128, 128, GroupOrder::Ascending, 0);
    assert!(
      video_default_sub < 0,
      "literal 0 sits above a 128/128 video stream"
    );
    assert!(probe_stream_priority() < video_default_sub);
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

/// Replay/live overlap (Report 5, Major): a joining subscription replays the cache
/// while live objects queue behind it; an object of the newest group that arrived in
/// between is in both.
#[cfg(test)]
mod tests_replay_live_overlap {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, collect_streams, publish, quic_pair, relay_client, subscribe, test_track,
    wait_until,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use std::time::Duration;

  const TRACK: u64 = 1;

  /// The mark is per stream: a late object of an earlier group the replay did not
  /// reach is not mistaken for a duplicate, as one watermark location would.
  #[test]
  fn replay_marks_are_per_stream() {
    let sub = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![],
    );
    let mut state = SubscriptionState::from(SubscriptionOrigin::from(sub));
    let g11 = StreamId::new_subgroup(TRACK, 11, Some(0));
    let g12 = StreamId::new_subgroup(TRACK, 12, Some(0));
    state.record_replayed(g11.clone(), 3);
    state.record_replayed(g12.clone(), 0);
    state.record_replayed(g12.clone(), 4);
    assert!(state.covered_by_replay(&g11, 3));
    assert!(!state.covered_by_replay(&g11, 4), "late object of group 11");
    assert!(state.covered_by_replay(&g12, 0));
    assert!(state.covered_by_replay(&g12, 4));
    assert!(!state.covered_by_replay(&g12, 5));
    let g13 = StreamId::new_subgroup(TRACK, 13, Some(0));
    assert!(!state.covered_by_replay(&g13, 0), "never replayed");
  }

  #[tokio::test]
  async fn a_joining_replay_and_the_live_queue_deliver_each_object_once() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(7, server);
    let received = collect_streams(peer);
    let track = test_track(TRACK, "video-720p");

    // Before the SUBSCRIBE: groups 10 and 11 whole, group 12 objects 0..3. Cache only.
    for g in 10..=11 {
      for o in 0..6 {
        publish(&track, g, o).await;
      }
    }
    for o in 0..3 {
      publish(&track, 12, o).await;
    }

    let subscription = subscribe(
      &track,
      &client,
      Subscribe::new_absolute_start(
        1,
        Tuple::from_utf8_path(TEST_NAMESPACE),
        TupleField::from_utf8("video-720p"),
        Location::new(10, 0),
        vec![],
      ),
      false,
    )
    .await;

    // Registered but not yet forwarding: these are queued AND cached, so the replay
    // (which reads the cache once forwarding is released) delivers them as well.
    for o in 3..6 {
      publish(&track, 12, o).await;
    }
    for o in 0..3 {
      publish(&track, 13, o).await;
    }

    let (counters, sub) = {
      let s = subscription.read().await;
      (s.counters.clone(), s.clone())
    };
    sub.mark_alias_announced();

    // 10, 11, 12 whole and 13/0..3, each once.
    assert!(
      wait_until(Duration::from_secs(5), || {
        let received = received.clone();
        async move { received.objects(TRACK).len() >= 21 }
      })
      .await,
      "replay + live delivered {:?}",
      received.objects(TRACK)
    );

    // Purely live from here.
    for o in 3..6 {
      publish(&track, 13, o).await;
    }
    for o in 0..6 {
      publish(&track, 14, o).await;
    }
    assert!(
      wait_until(Duration::from_secs(5), || {
        let received = received.clone();
        async move { received.objects(TRACK).len() >= 30 }
      })
      .await,
      "live delivered {:?}",
      received.objects(TRACK)
    );
    // Anything still in flight would show up as an extra object.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let counts = received.counts(TRACK);
    let duplicated: Vec<_> = counts.iter().filter(|(_, n)| **n > 1).collect();
    assert!(duplicated.is_empty(), "delivered twice: {duplicated:?}");
    let expected: Vec<(u64, u64)> = (10..=14)
      .flat_map(|g| (0..6).map(move |o| (g, o)))
      .collect();
    assert_eq!(counts.keys().copied().collect::<Vec<_>>(), expected);
    for g in 10..=14 {
      assert_eq!(received.streams_for(TRACK, g), 1, "group {g} on one stream");
    }
    assert_eq!(counters.write_failures.load(Ordering::Relaxed), 0);
    assert_eq!(counters.objects_written.load(Ordering::Relaxed), 30);
    assert_eq!(
      counters.live_duplicates_dropped.load(Ordering::Relaxed),
      6,
      "12/3..6 and 13/0..3 were replayed and queued"
    );
  }
}

/// Native SWITCH on harness: the switched (target) subscription is gated by
/// `check_switch_context`; the source keeps forwarding until its next group.
#[cfg(test)]
mod tests_native_switch {
  use super::*;
  use crate::server::message_handlers::subscribe_handler::with_native_switch_statuses;
  use crate::server::test_support::{
    Received, TEST_NAMESPACE, collect_streams, publish, quic_pair, relay_client, subscribe,
    test_track, wait_until,
  };
  use crate::server::track::Track;
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::model::error::TerminationCode;
  use std::time::Duration;

  const OLD: u64 = 1;
  const NEW: u64 = 2;

  fn latest(request_id: u64, track: &str) -> Subscribe {
    Subscribe::new_latest_object(
      request_id,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8(track),
      vec![MessageParameter::new_forward(true)],
    )
  }

  async fn wait_for(received: &Received, alias: u64, loc: (u64, u64)) -> bool {
    wait_until(Duration::from_secs(5), || {
      let received = received.clone();
      async move { received.objects(alias).contains(&loc) }
    })
    .await
  }

  /// A client subscribed to the old track, which has delivered group 5 objects
  /// 0..5, and a new track that has published group 5 objects 0..3.
  struct Fixture {
    client: Arc<MOQTClient>,
    received: Received,
    old: Track,
    new: Track,
  }

  /// `conn` must be unique per test: captured events are filtered by it.
  async fn fixture(conn: usize) -> Fixture {
    let (peer, server) = quic_pair().await;
    let client = relay_client(conn, server);
    let received = collect_streams(peer);
    let old = test_track(OLD, "video-360p");
    let new = test_track(NEW, "video-720p");
    let old_sub = subscribe(&old, &client, latest(1, "video-360p"), false).await;
    old_sub.read().await.mark_alias_announced();
    for o in 0..5 {
      publish(&old, 5, o).await;
    }
    assert!(wait_for(&received, OLD, (5, 4)).await);
    for o in 0..3 {
      publish(&new, 5, o).await;
    }
    Fixture {
      client,
      received,
      old,
      new,
    }
  }

  /// What the handler's SUBSCRIBE does for the switch, as far as forwarding goes:
  /// create the target subscription (is_switch arms the one-shot check) and release
  /// its forwarding (SUBSCRIBE_OK sent).
  async fn switched_subscribe(f: &Fixture) -> Arc<RwLock<Subscription>> {
    let sub = subscribe(&f.new, &f.client, latest(3, "video-720p"), true).await;
    sub.read().await.mark_alias_announced();
    sub
  }

  /// The defect, reproduced with the old ordering (statuses set after the SUBSCRIBE
  /// was handled): an object the target dequeues in between is forwarded ungated,
  /// mid-group, and the source is not demoted for it.
  #[tokio::test]
  async fn statuses_set_after_the_subscribe_let_a_mid_group_object_through() {
    let f = fixture(21).await;
    let _new_sub = switched_subscribe(&f).await;
    publish(&f.new, 5, 3).await;
    assert!(
      wait_for(&f.received, NEW, (5, 3)).await,
      "the window forwards (5, 3) of the target: {:?}",
      f.received.objects(NEW)
    );
    assert_eq!(f.client.switch_context.get_current().await, None);
  }

  /// The fix: the statuses are in place before the target can forward, so the same
  /// object meets the Next branch: the target is promoted to start at the group after
  /// the source's last sent one, and nothing of group 5 is forwarded from it.
  #[tokio::test]
  async fn statuses_set_before_the_subscribe_gate_the_first_object() {
    let f = fixture(22).await;
    let new_name = f.new.full_track_name.clone();
    let old_name = f.old.full_track_name.clone();
    with_native_switch_statuses(
      &f.client.switch_context,
      new_name.clone(),
      old_name,
      async {
        switched_subscribe(&f).await;
        Ok(())
      },
    )
    .await
    .unwrap();
    publish(&f.new, 5, 3).await;
    publish(&f.new, 5, 4).await;
    for o in 0..3 {
      publish(&f.old, 6, o).await;
      publish(&f.new, 6, o).await;
    }
    assert!(wait_for(&f.received, NEW, (6, 2)).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
      f.received.objects(NEW),
      vec![(6, 0), (6, 1), (6, 2)],
      "the target starts at the next group"
    );
    assert!(
      f.received.objects(OLD).iter().all(|(g, _)| *g == 5),
      "the source stops at its next group: {:?}",
      f.received.objects(OLD)
    );
    assert_eq!(f.client.switch_context.get_current().await, Some(new_name));

    // The relay's account of the same seam.
    let promoted = crate::server::events::test_capture::records("SWITCH_PROMOTED", 22);
    assert_eq!(promoted.len(), 1, "{promoted:?}");
    let p = &promoted[0];
    assert_eq!(p["track"], "moqtail/video-720p");
    assert_eq!(p["trigger_group"], 5);
    assert_eq!(p["trigger_object"], 3);
    assert_eq!(p["start_group"], 6);
    assert_eq!(p["old_track"], "moqtail/video-360p");
    assert_eq!(p["old_last_sent_group"], 5);
    assert_eq!(p["trigger_forwarded"], false);
    let demoted = crate::server::events::test_capture::records("SWITCH_DEMOTED", 22);
    assert_eq!(demoted.len(), 1, "{demoted:?}");
    let d = &demoted[0];
    assert_eq!(d["old_track"], "moqtail/video-360p");
    assert_eq!(d["relay_track_id"], OLD);
    assert_eq!(d["last_group"], 5);
    assert_eq!(d["last_object"], 4);
    assert_eq!(d["stop_group"], 6);
    assert_eq!(d["stop_object"], 0);
  }

  /// The ordering itself: when the SUBSCRIBE runs (and with it SUBSCRIBE_OK and the
  /// release of forwarding), target = Next and source = Current are already set.
  #[tokio::test]
  async fn the_subscribe_runs_with_the_statuses_already_set() {
    let ctx = crate::server::client::switch_context::SwitchContext::new();
    let target = crate::server::test_support::full_track_name("video-720p");
    let source = crate::server::test_support::full_track_name("video-360p");
    let seen = Arc::new(Mutex::new(None));
    let seen_in = seen.clone();
    let ctx_in = ctx.clone();
    let (t, s) = (target.clone(), source.clone());
    with_native_switch_statuses(&ctx, target.clone(), source.clone(), async move {
      *seen_in.lock().await = Some((
        ctx_in.get_switch_status(&t).await,
        ctx_in.get_switch_status(&s).await,
      ));
      Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
      *seen.lock().await,
      Some((Some(SwitchStatus::Next), Some(SwitchStatus::Current)))
    );
  }

  /// A SUBSCRIBE that fails leaves the switch context as it was.
  #[tokio::test]
  async fn a_failed_subscribe_restores_the_statuses() {
    let ctx = crate::server::client::switch_context::SwitchContext::new();
    let target = crate::server::test_support::full_track_name("video-720p");
    let source = crate::server::test_support::full_track_name("video-360p");
    let pending = crate::server::test_support::full_track_name("video-1080p");
    ctx
      .add_or_update_switch_item(pending.clone(), SwitchStatus::Next)
      .await;
    let before = ctx.snapshot().await;
    let res = with_native_switch_statuses(&ctx, target, source, async {
      Err(TerminationCode::InternalError)
    })
    .await;
    assert!(res.is_err());
    assert_eq!(ctx.snapshot().await, before);
  }
}
