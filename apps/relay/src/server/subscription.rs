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
use moqtail::transport::connection::{TransportSendStream, TransportWriteError};
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
/// The result is shifted down by one (saturating at i32::MIN) so it is always below
/// `CONTROL_STREAM_PRIORITY`: control and request streams go first.
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
  let priority = match group_order {
    GroupOrder::Ascending | GroupOrder::Original => band_min + BAND_SIZE - 1 - group_slot,
    GroupOrder::Descending => band_min + group_slot,
  };
  // The bands fill the whole i32 range, so the top slot of the top band (sub 0,
  // pub 0) would be i32::MAX, the priority of control and request streams. Every
  // slot moves down by one so data stays strictly below them (R3-D2); the bottom
  // slot saturates, so the two lowest slots of the (255, 255) band share i32::MIN
  // (where the probe sits). Relative order is otherwise unchanged.
  (priority - 1).max(i32::MIN as i64) as i32
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
  /// Objects dropped because the subscriber had stopped (STOP_SENDING) their stream.
  pub stopped_stream_objects_dropped: AtomicU64,
}

/// How a FIN'd stream's wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FinishOutcome {
  /// The subscriber acknowledged everything.
  Acknowledged,
  /// A reset of the subscription abandoned what was still unsent.
  Reset,
}

#[derive(Debug)]
struct FinishingEntry {
  stream: Arc<Mutex<TransportSendStream>>,
  /// Dropped with the entry; ends the acknowledgement wait of a reset stream.
  _cancel: tokio::sync::oneshot::Sender<()>,
}

/// A subscription's FIN'd data streams whose data the subscriber has not yet
/// acknowledged, and the reset that covers streams from now on.
#[derive(Debug, Default)]
pub(crate) struct FinishingStreams {
  /// Keyed by the stream id and the stream's identity: two streams can share an
  /// id (a subgroup reopened after the subscriber stopped it), and one must not
  /// displace the other.
  entries: HashMap<(StreamId, usize), FinishingEntry>,
  /// Set by a reset of the subscription: (group, code). Streams of groups at or
  /// above the group (every stream for 0, FETCH streams included) are reset with
  /// the code instead of FIN'd from then on, so a close racing a reset cannot
  /// deliver what the reset abandons.
  reset_from: Option<(u64, u64)>,
}

impl FinishingStreams {
  #[cfg(test)]
  pub(crate) fn is_empty(&self) -> bool {
    self.entries.is_empty()
  }

  fn key(id: &StreamId, stream: &Arc<Mutex<TransportSendStream>>) -> (StreamId, usize) {
    (id.clone(), Arc::as_ptr(stream) as usize)
  }

  fn covered(id: &StreamId, from_group: u64) -> bool {
    from_group == 0 || id.group_id.is_some_and(|g| g >= from_group)
  }

  fn reset_code_for(&self, id: &StreamId) -> Option<u64> {
    self
      .reset_from
      .filter(|(g, _)| Self::covered(id, *g))
      .map(|(_, code)| code)
  }

  /// Removes the entry of `id` if it is still `stream`'s.
  fn retire(&mut self, id: &StreamId, stream: &Arc<Mutex<TransportSendStream>>) {
    self.entries.remove(&Self::key(id, stream));
  }
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
  /// Data streams this subscription has FIN'd whose data the subscriber has not yet
  /// acknowledged. A FIN'd stream's queued bytes are still sent, so a reset of this
  /// subscription's streams (cancel, too far behind, a switch seam) must reach these
  /// too; an entry leaves once the acknowledgement (or a reset) ends the stream.
  finishing_streams: Arc<RwLock<FinishingStreams>>,
  /// Data streams the subscriber stopped (STOP_SENDING, seen as a write that failed
  /// with ClosedOrStopped). The rest of such a subgroup is dropped rather than sent
  /// on a reopened stream (R3-D3). An entry is retired when the publisher's stream
  /// for it closes, after which nothing more of that subgroup can be queued.
  stopped_streams: Arc<RwLock<std::collections::HashSet<StreamId>>>,
  /// Monotonic count of data streams opened for this subscription, including
  /// empty subgroups. Reported as PUBLISH_DONE Stream Count.
  opened_stream_count: Arc<AtomicU64>,
  /// SUBGROUP data streams opened for this subscription, per Group, kept for the
  /// subscription's lifetime (finished and reset streams included;
  /// `send_stream_last_object_ids` forgets a stream once it ends). Counted when
  /// the open begins, before the subscription can finish (R7-D3). Read at a
  /// SWITCH hand-over for the below-seam stream count (pr1378, R6 D2).
  opened_streams_by_group: Arc<std::sync::Mutex<std::collections::BTreeMap<u64, u64>>>,
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
      counters: Arc::new(SubscriptionCounters::default()),
      subscriber,
      event_rx,
      send_stream_last_object_ids: Arc::new(RwLock::new(HashMap::new())),
      finishing_streams: Arc::new(RwLock::new(FinishingStreams::default())),
      stopped_streams: Arc::new(RwLock::new(std::collections::HashSet::new())),
      opened_stream_count: Arc::new(AtomicU64::new(0)),
      opened_streams_by_group: Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new())),
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
                          // The previous group's replay is over (R3-D5).
                          if let Some(previous) = last_stream_id.take() {
                            instance
                              .finish_replayed_stream_if_complete(&cache, &previous)
                              .await;
                          }
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
                // The last replayed group: finished only if the publisher is done
                // with it too; the newest group normally is not, and continues live.
                if let Some(last) = last_stream_id.take() {
                  instance
                    .finish_replayed_stream_if_complete(&cache, &last)
                    .await;
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

  /// SUBGROUP data streams opened for this subscription for Groups below `group`,
  /// however they ended (finished, reset or still open). At a SWITCH hand-over,
  /// with `group` = G_switch, this is the count the target PUBLISH's
  /// SWITCH_TRANSITION carries (project-local third field, R6 D2).
  pub fn opened_streams_below(&self, group: u64) -> u64 {
    let by_group = self
      .opened_streams_by_group
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    by_group.range(..group).map(|(_, n)| *n).sum()
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
        // handle_header registers the stream (R7-D3).
        let _ = self.handle_header(pending_header_info).await;
      }
    }

    Ok(())
  }

  pub async fn finish(&self) {
    if self
      .finished
      .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
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
      let connection_id = self.client_connection_id;
      let relay_track_id = self.relay_track_id;
      let total = stream_ids.len();

      // Every stream is FIN'd now, in this task, so each is in `finishing_streams`
      // (resettable) before this returns; only the acknowledgements are awaited in the
      // background, together (R7-D6): one stream after another cost the subscriber a
      // round trip per open stream before the last one ended, and the switch hand-over
      // waits for the replaced subscription's streams to end.
      let mut acks = Vec::with_capacity(total);
      for stream_id in stream_ids {
        match self.begin_close_data_stream(&stream_id).await {
          Ok(Some(ack)) => acks.push((stream_id, ack)),
          Ok(None) => debug!(
            "Background stream cleanup: stream not found for subscriber={} stream_id={} relay_track_id={}",
            connection_id, stream_id, relay_track_id
          ),
          Err(e) => warn!(
            "Background stream cleanup error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
            connection_id, stream_id, relay_track_id, e
          ),
        }
      }

      tokio::spawn(async move {
        info!(
          "Starting background cleanup of {} streams for subscriber={} relay_track_id={}",
          total, connection_id, relay_track_id
        );
        let mut closing = tokio::task::JoinSet::new();
        for (stream_id, ack) in acks {
          closing.spawn(async move { (stream_id, ack.await) });
        }
        while let Some(joined) = closing.join_next().await {
          match joined {
            Ok((stream_id, Err(e))) => warn!(
              "Background stream cleanup error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
              connection_id, stream_id, relay_track_id, e
            ),
            Ok((stream_id, Ok(outcome))) => debug!(
              "Background stream cleanup ({:?}) for subscriber={} stream_id={} relay_track_id={}",
              outcome, connection_id, stream_id, relay_track_id
            ),
            Err(e) => warn!(
              "Background stream cleanup task failed for subscriber={} relay_track_id={} error: {:?}",
              connection_id, relay_track_id, e
            ),
          }
        }
        info!(
          "Background cleanup completed for subscriber={} relay_track_id={} ({} streams)",
          connection_id, relay_track_id, total
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

  /// Reset every data stream this subscription has opened with the given code:
  /// the open ones (draining the map so `finish` does not then try to close a stream
  /// already reset) and the FIN'd, unacknowledged ones. From now on a stream this
  /// subscription would FIN is reset instead (see `FinishingStreams::reset_from`).
  async fn reset_data_streams(&self, code: u64) {
    let finished = self.reset_finishing_streams(code, 0).await;
    let stream_ids: Vec<StreamId> = {
      let mut map = self.send_stream_last_object_ids.write().await;
      map.drain().map(|(stream_id, _)| stream_id).collect()
    };
    for stream_id in stream_ids {
      self.subscriber.reset_stream(&stream_id, code).await;
    }
    debug!(
      "reset data streams of subscriber={} relay_track_id={}: {} FIN'd streams reset",
      self.client_connection_id, self.relay_track_id, finished
    );
  }

  /// FINs one of this subscription's data streams. The stream enters
  /// `finishing_streams` before it leaves the connection's send-stream map, both
  /// under checks that make every interleaving with a reset safe: a stream a reset
  /// of this subscription already covers (`reset_from`) is reset, never FIN'd; a
  /// stream another close is already finishing is left to it; a stream reopened
  /// under the same id is not touched. The returned future resolves when the
  /// subscriber has acknowledged everything or a reset ended the stream, and then
  /// retires the entry. `None` when there was nothing for this call to finish.
  async fn begin_close_data_stream(
    &self,
    stream_id: &StreamId,
  ) -> Result<Option<impl std::future::Future<Output = Result<FinishOutcome>> + Send + 'static>> {
    let Some(stream) = self.subscriber.get_stream(stream_id).await else {
      return Ok(None);
    };
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
      let mut finishing = self.finishing_streams.write().await;
      let key = FinishingStreams::key(stream_id, &stream);
      if finishing.entries.contains_key(&key) {
        return Ok(None);
      }
      if let Some(code) = finishing.reset_code_for(stream_id) {
        drop(finishing);
        self
          .subscriber
          .reset_stream_matching(stream_id, &stream, code)
          .await;
        return Ok(None);
      }
      finishing.entries.insert(
        key,
        FinishingEntry {
          stream: stream.clone(),
          _cancel: cancel_tx,
        },
      );
    }
    let ack = match self
      .subscriber
      .begin_close_stream_matching(stream_id, &stream)
      .await
    {
      Ok(Some(ack)) => ack,
      other => {
        // Closed or reset concurrently, or the id now holds another stream.
        self
          .finishing_streams
          .write()
          .await
          .retire(stream_id, &stream);
        return other.map(|_| None);
      }
    };
    let finishing = self.finishing_streams.clone();
    let stream_id = stream_id.clone();
    let connection_id = self.client_connection_id;
    Ok(Some(async move {
      let res = tokio::select! {
        r = ack => r.map(|_| FinishOutcome::Acknowledged).map_err(|e| {
          anyhow::anyhow!("stream {} did not finish for subscriber={}: {:?}", stream_id, connection_id, e)
        }),
        // The entry was dropped by a reset (its sender with it): a reset stream's
        // acknowledgement wait would otherwise last until the connection closes.
        _ = cancel_rx => Ok(FinishOutcome::Reset),
      };
      finishing.write().await.retire(&stream_id, &stream);
      res
    }))
  }

  /// FINs one of this subscription's data streams and waits until the subscriber
  /// has acknowledged it or a reset ended it (see `begin_close_data_stream`).
  /// `Ok(false)` when there was nothing for this call to finish.
  async fn close_data_stream(&self, stream_id: &StreamId) -> Result<bool> {
    match self.begin_close_data_stream(stream_id).await? {
      None => Ok(false),
      Some(ack) => ack.await.map(|_| true),
    }
  }

  /// Resets this subscription's FIN'd but unacknowledged data streams of groups at or
  /// above `from_group` (0: all of them, FETCH streams included) and makes every
  /// later close of such a stream a reset (`FinishingStreams::reset_from`). Returns
  /// how many FIN'd streams were reset.
  async fn reset_finishing_streams(&self, code: u64, from_group: u64) -> usize {
    let streams: Vec<(StreamId, Arc<Mutex<TransportSendStream>>)> = {
      let mut finishing = self.finishing_streams.write().await;
      finishing.reset_from = Some(match finishing.reset_from {
        Some((g, c)) if g <= from_group => (g, c),
        _ => (from_group, code),
      });
      let keys: Vec<(StreamId, usize)> = finishing
        .entries
        .keys()
        .filter(|(id, _)| FinishingStreams::covered(id, from_group))
        .cloned()
        .collect();
      keys
        .into_iter()
        .filter_map(|k| finishing.entries.remove(&k).map(|e| (k.0, e.stream)))
        .collect()
    };
    let n = streams.len();
    for (stream_id, stream) in streams {
      // An already acknowledged stream is gone; resetting it is a harmless no-op.
      if let Err(e) = stream.lock().await.reset(code) {
        debug!(
          "reset of finishing stream {} for subscriber={}: {:?}",
          stream_id, self.client_connection_id, e
        );
      }
    }
    n
  }

  /// Ends a subscription replaced by a switch at `seam_group`: data streams of
  /// groups at or above the seam are reset (the target covers them and the
  /// subscriber will discard them), streams of groups below it are finished so
  /// that whatever is still queued on them is delivered. On a saturated link a
  /// deep-buffer subscriber has one or two groups below the seam still in
  /// flight; resetting those left holes 10-20 s ahead of its playhead
  /// (shift-20 s batch, 2026-10-02), while finishing everything let the backlog
  /// above the seam starve the target (delivery diagnostic, 2026-09-29).
  ///
  /// Streams at or above the seam that were already FIN'd (their group complete)
  /// but not yet acknowledged are reset too (preflight 2026-10-05: they used to
  /// escape, and each time-shifted shaped run received ~1.9 MB of them). Returns
  /// how many open and how many FIN'd streams were reset.
  pub async fn cancel_from_group(&self, seam_group: u64) -> (usize, usize) {
    info!(
      "Ending replaced subscription for subscriber={} relay_track_id={}: resetting streams at/above group {}",
      self.client_connection_id, self.relay_track_id, seam_group
    );
    // The bound first: from here on no stream at or above the seam can be FIN'd,
    // whatever order the closes and this sweep run in.
    let reset_finished = self
      .reset_finishing_streams(StreamResetCode::Cancelled.to_u64(), seam_group)
      .await;
    let above: Vec<StreamId> = {
      let mut map = self.send_stream_last_object_ids.write().await;
      let keys: Vec<StreamId> = map
        .keys()
        .filter(|id| id.group_id.is_some_and(|g| g >= seam_group))
        .cloned()
        .collect();
      for k in &keys {
        map.remove(k);
      }
      keys
    };
    let reset_open = above.len();
    for stream_id in above {
      self
        .subscriber
        .reset_stream(&stream_id, StreamResetCode::Cancelled.to_u64())
        .await;
    }
    self.finish().await;
    (reset_open, reset_finished)
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

        // The subscriber stopped this subgroup's stream: the rest of the subgroup is
        // not wanted, and must not go out on a reopened stream (R3-D3).
        if self.stopped_streams.read().await.contains(&stream_id) {
          self
            .counters
            .stopped_stream_objects_dropped
            .fetch_add(1, Ordering::Relaxed);
          debug!(
            "Dropping object of a stream the subscriber stopped: subscriber={} stream_id={} relay_track_id={} location: {:?}",
            self.client_connection_id, stream_id, self.relay_track_id, object.location
          );
          return;
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
            // handle_header registers the stream (R7-D3).
            if let Ok((stream_id, send_stream)) = self.handle_header(header.clone()).await {
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
                // A new stream: its first object is encoded from scratch, not as a
                // delta from whatever an earlier stream for this id last carried
                // (R3-D3).
                match self.handle_header(h).await {
                  Ok((_, send_stream)) => Some(send_stream),
                  Err(_) => None,
                }
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
          if let Err(e) = &write_result
            && e
              .downcast_ref::<TransportWriteError>()
              .is_some_and(|e| matches!(e, TransportWriteError::ClosedOrStopped))
          {
            // The subscriber stopped this stream (the client already dropped it
            // from its send-stream map). Remember it so the rest of the subgroup is
            // dropped instead of reopening the stream (R3-D3).
            info!(
              "Subscriber stopped stream: subscriber={} stream_id={} relay_track_id={}; dropping the rest of the subgroup",
              self.client_connection_id, stream_id, self.relay_track_id
            );
            self.stopped_streams.write().await.insert(stream_id.clone());
            self
              .send_stream_last_object_ids
              .write()
              .await
              .remove(&stream_id);
          }
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

      // B (pr1378, R7-D3): a SUBGROUP stream is counted per group before it is
      // opened, under the send-stream map's lock with `finished` checked. `finish`
      // sets the flag before it drains the map under that lock, and the hand-over
      // reads B after `finish`, so every stream whose open began before the
      // subscription finished is in B (one whose open completes afterwards is
      // FIN'd or reset below, and the subscriber sees it), and no stream is opened
      // once it has finished. Counting when the open returned missed an open that
      // was waiting (e.g. for stream credit) when B was read.
      if let HeaderInfo::Subgroup { header } = &header_info {
        let _map = self.send_stream_last_object_ids.write().await;
        if self.finished.load(Ordering::Acquire) {
          return Err(anyhow::anyhow!(
            "subscription finished before stream {} was opened subscriber={} relay_track_id={}",
            stream_id,
            self.client_connection_id,
            self.relay_track_id
          ));
        }
        *self
          .opened_streams_by_group
          .lock()
          .unwrap_or_else(|poisoned| poisoned.into_inner())
          .entry(header.group_id)
          .or_insert(0) += 1;
      }

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

      // Register the stream for `finish` to end, unless the subscription finished
      // while this open waited (R7-D3): `finish` sets the flag before it drains the
      // map under this same lock, so a stream registered here is always drained,
      // and one that finds the flag set is ended here instead of being left open
      // for the rest of the session.
      let registered = {
        let mut map = self.send_stream_last_object_ids.write().await;
        let finished = self.finished.load(Ordering::Acquire);
        if !finished {
          map.insert(stream_id.clone(), None);
        }
        !finished
      };
      if !registered {
        self
          .end_stream_opened_after_finish(&stream_id, group_id)
          .await;
        return Err(anyhow::anyhow!(
          "stream {} opened after the subscription finished subscriber={} relay_track_id={}",
          stream_id,
          self.client_connection_id,
          self.relay_track_id
        ));
      }

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

  /// Ends a data stream whose open completed after `finish` had already drained
  /// this subscription's streams (R7-D3). A stream of a group within the
  /// subscription's end bound (or with no bound) is FIN'd, so the subscriber sees it
  /// end like the others `finish` closed; one beyond the bound (at or above a
  /// switch seam) is reset, as nothing on it is wanted.
  async fn end_stream_opened_after_finish(&self, stream_id: &StreamId, group_id: u64) {
    let beyond_bound = {
      let state = self.subscription_state.read().await;
      state.exceeds_end_group(group_id)
    };
    warn!(
      "Stream opened after the subscription finished: subscriber={} stream_id={} relay_track_id={} group={} ({})",
      self.client_connection_id,
      stream_id,
      self.relay_track_id,
      group_id,
      if beyond_bound { "reset" } else { "finished" }
    );
    if beyond_bound {
      self
        .subscriber
        .reset_stream(stream_id, StreamResetCode::Cancelled.to_u64())
        .await;
    } else if let Err(e) = self.close_data_stream(stream_id).await {
      warn!(
        "Failed to finish a stream opened after the subscription finished: subscriber={} stream_id={} relay_track_id={} error: {:?}",
        self.client_connection_id, stream_id, self.relay_track_id, e
      );
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

  /// Called by the joining replay when it has written the last cached object of the
  /// group on `stream_id` (R3-D5). If the publisher's stream for that subgroup has
  /// already closed and the replay wrote everything the cache holds of it, the
  /// subgroup is complete and its stream is finished here: a subscription
  /// registered after the publisher's stream closed never receives the StreamClosed
  /// that would otherwise finish it, and an unfinished stream holds one of the
  /// subscriber's uni-stream credits for the rest of the session. A subgroup still
  /// being published (normally the newest group) stays open and continues live;
  /// its StreamClosed finishes it. So does one whose cache holds objects past what
  /// the replay wrote (added after the replay read the group: they and the close
  /// are in this subscription's live queue).
  async fn finish_replayed_stream_if_complete(&self, cache: &TrackCache, stream_id: &StreamId) {
    if self
      .active_subgroup_headers
      .read()
      .await
      .contains_key(stream_id)
    {
      return;
    }
    let Some(replayed) = self
      .subscription_state
      .read()
      .await
      .replayed_through
      .get(stream_id)
      .copied()
    else {
      return;
    };
    let (Some(group), Some(subgroup)) = (stream_id.group_id, stream_id.subgroup_id) else {
      return;
    };
    let cached_last = match cache.get_group(group).await {
      Some(objects) => objects
        .read()
        .await
        .iter()
        .filter(|o| o.subgroup_id == subgroup)
        .map(|o| o.object_id)
        .max(),
      None => None,
    };
    if cached_last.is_some_and(|last| last > replayed) {
      return;
    }
    info!(
      "Joining replay finished complete group: subscriber={} stream_id={} relay_track_id={} last object {}",
      self.client_connection_id, stream_id, self.relay_track_id, replayed
    );
    let _ = self.handle_stream_closed(stream_id).await;
  }

  async fn handle_stream_closed(&self, stream_id: &StreamId) -> Result<()> {
    // Handle the stream closed event
    debug!("Stream closed: {}", stream_id.get_stream_id());

    // The publisher's subgroup is over: nothing more of it can arrive.
    self.stopped_streams.write().await.remove(stream_id);

    // remove the stream id from send_stream_last_object_ids immediately
    let mut send_stream_last_object_ids = self.send_stream_last_object_ids.write().await;
    send_stream_last_object_ids.remove(stream_id);
    drop(send_stream_last_object_ids); // Release the lock immediately

    // FIN now (the stream becomes resettable in `finishing_streams`) and wait for the
    // subscriber's acknowledgement in a separate task, so the subscription event loop
    // is not blocked (25 fps = ~40 ms between objects).
    let connection_id = self.client_connection_id;
    let relay_track_id = self.relay_track_id;
    match self.begin_close_data_stream(stream_id).await {
      Ok(Some(ack)) => {
        let stream_id = stream_id.clone();
        tokio::spawn(async move {
          match ack.await {
            Ok(outcome) => debug!(
              "handle_stream_closed | {:?} for subscriber={} stream_id={} relay_track_id={}",
              outcome, connection_id, stream_id, relay_track_id
            ),
            Err(e) => warn!(
              "handle_stream_closed | error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
              connection_id, stream_id, relay_track_id, e
            ),
          }
        });
      }
      Ok(None) => debug!(
        "handle_stream_closed | stream not found for subscriber={} stream_id={} relay_track_id={}",
        connection_id, stream_id, relay_track_id
      ),
      Err(e) => warn!(
        "handle_stream_closed | error for subscriber={} stream_id={} relay_track_id={} error: {:?}",
        connection_id, stream_id, relay_track_id, e
      ),
    }

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

  /// R3-D2: control/request streams > every video stream > the probe, for every
  /// subscriber and publisher priority, both group orders and the band-edge group
  /// slots. The probe ties only with the lowest video slots of the (255, 255) band.
  #[test]
  fn control_outranks_every_video_band_which_outranks_the_probe() {
    use moqtail::transport::connection::CONTROL_STREAM_PRIORITY;
    let probe = probe_stream_priority();
    for sub in 0u8..=255 {
      for pub_ in 0u8..=255 {
        for &order in &[GroupOrder::Ascending, GroupOrder::Descending] {
          for group in [0u64, 1, 65534, 65535, 65536, u64::MAX] {
            let video = compute_stream_priority(sub, pub_, order, group);
            assert!(
              video < CONTROL_STREAM_PRIORITY,
              "video (sub={sub} pub={pub_} order={order:?} group={group}) = {video} ties control"
            );
            if (sub, pub_) == (255, 255) {
              assert!(video >= probe);
            } else {
              assert!(
                video > probe,
                "video (sub={sub} pub={pub_} order={order:?} group={group}) = {video} vs probe"
              );
            }
          }
        }
      }
    }
    // The harness's values: player SUBSCRIBE/SWITCH at 0, publisher at 128.
    let harness_video = compute_stream_priority(0, 128, GroupOrder::Ascending, 0);
    assert!(harness_video > 2_000_000_000, "{harness_video}");
    assert_eq!(CONTROL_STREAM_PRIORITY, i32::MAX);
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

/// R3-D5: a joining replay's streams for groups the publisher had already finished
/// were never finished (no StreamClosed reaches a subscription registered after the
/// publisher's stream closed), each holding one of the subscriber's uni-stream
/// credits for the rest of the session.
#[cfg(test)]
mod tests_replay_finishes_complete_groups {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, collect_streams, publish, quic_pair, relay_client, subscribe, test_track,
    wait_until,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use std::time::Duration;

  const TRACK: u64 = 1;

  fn from(group: u64) -> Subscribe {
    Subscribe::new_absolute_start(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      Location::new(group, 0),
      vec![],
    )
  }

  async fn open(client: &Arc<MOQTClient>, group: u64) -> bool {
    client
      .get_stream(&StreamId::new_subgroup(TRACK, group, Some(0)))
      .await
      .is_some()
  }

  /// The reviewer's scenario: groups 10 and 11 complete (publisher streams closed)
  /// and 12 in progress when the subscription replays from 10. After the replay the
  /// streams of 10 and 11 are finished; 12 stays open, continues live on the same
  /// stream, and is finished when the publisher closes it.
  #[tokio::test]
  async fn replayed_streams_of_complete_groups_are_finished() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(77, server);
    let received = collect_streams(peer);
    let track = test_track(TRACK, "video-720p");
    for g in 10..=11 {
      for o in 0..3 {
        publish(&track, g, o).await;
      }
      track
        .stream_closed(&StreamId::new_subgroup(TRACK, g, Some(0)))
        .await
        .unwrap();
    }
    for o in 0..3 {
      publish(&track, 12, o).await;
    }
    let sub = subscribe(&track, &client, from(10), false).await;
    sub.read().await.mark_alias_announced();
    assert!(
      wait_until(Duration::from_secs(5), || {
        let r = received.clone();
        async move { r.objects(TRACK).len() >= 9 }
      })
      .await
    );
    assert!(
      wait_until(Duration::from_secs(2), || {
        let client = client.clone();
        async move { !open(&client, 10).await && !open(&client, 11).await }
      })
      .await,
      "the streams of complete groups 10 and 11 are still open"
    );
    assert!(
      open(&client, 12).await,
      "the newest group stays open for live"
    );

    for o in 3..5 {
      publish(&track, 12, o).await;
    }
    assert!(
      wait_until(Duration::from_secs(5), || {
        let r = received.clone();
        async move { r.objects(TRACK).contains(&(12, 4)) }
      })
      .await
    );
    assert_eq!(
      received.streams_for(TRACK, 12),
      1,
      "12 continues on one stream"
    );
    track
      .stream_closed(&StreamId::new_subgroup(TRACK, 12, Some(0)))
      .await
      .unwrap();
    assert!(
      wait_until(Duration::from_secs(2), || {
        let client = client.clone();
        async move { !open(&client, 12).await }
      })
      .await
    );
    let expected: Vec<(u64, u64)> = (10..=11)
      .flat_map(|g| (0..3).map(move |o| (g, o)))
      .chain((0..5).map(|o| (12, o)))
      .collect();
    let mut got = received.objects(TRACK);
    got.sort();
    assert_eq!(got, expected);
  }

  /// A replayed group whose publisher stream is still open is left to the live
  /// path (its StreamClosed finishes it), even when a later group exists.
  #[tokio::test]
  async fn a_replayed_group_still_being_published_stays_open() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(78, server);
    let received = collect_streams(peer);
    let track = test_track(TRACK, "video-720p");
    for o in 0..3 {
      publish(&track, 10, o).await;
    }
    for o in 0..3 {
      publish(&track, 11, o).await;
    }
    let sub = subscribe(&track, &client, from(10), false).await;
    sub.read().await.mark_alias_announced();
    assert!(
      wait_until(Duration::from_secs(5), || {
        let r = received.clone();
        async move { r.objects(TRACK).len() >= 6 }
      })
      .await
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(open(&client, 10).await, "10 is still being published");
    publish(&track, 10, 3).await;
    track
      .stream_closed(&StreamId::new_subgroup(TRACK, 10, Some(0)))
      .await
      .unwrap();
    assert!(
      wait_until(Duration::from_secs(2), || {
        let client = client.clone();
        async move { !open(&client, 10).await }
      })
      .await
    );
    assert!(received.objects(TRACK).contains(&(10, 3)));
    assert_eq!(received.streams_for(TRACK, 10), 1);
  }
}

/// R3-D3: a subscriber's STOP_SENDING on a data stream. The relay used to reopen the
/// stream for the next object (mid-subgroup join) and encode that object's id as a
/// delta from the last id written on the stopped stream, so the subscriber read
/// 5/2..5/4 as 5/1..5/3.
#[cfg(test)]
mod tests_stop_sending {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, publish, quic_pair, relay_client, subscribe, test_track,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::transport::connection::{TransportConnection, TransportRecvStream};
  use moqtail::transport::data_stream_handler::RecvDataStream;
  use std::time::Duration;

  const TRACK: u64 = 1;

  fn latest() -> Subscribe {
    Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    )
  }

  /// (group, object) of every object on `recv`, as the subscriber parses them, until
  /// nothing arrives for 500 ms.
  async fn objects_on(recv: TransportRecvStream) -> Vec<(u64, u64)> {
    let data = RecvDataStream::new(
      recv,
      Arc::new(RwLock::new(std::collections::BTreeMap::new())),
    );
    let mut ids = vec![];
    while let Ok((_, Some(o))) =
      tokio::time::timeout(Duration::from_millis(500), data.next_object()).await
    {
      ids.push((o.location.group, o.location.object));
    }
    ids
  }

  async fn next_stream(peer: &TransportConnection, wait: Duration) -> Option<TransportRecvStream> {
    tokio::time::timeout(wait, peer.accept_uni())
      .await
      .ok()
      .and_then(|r| r.ok())
  }

  /// The reviewer's scenario: the subscriber stops the group-5 stream after 5/0;
  /// 5/1..5/4 follow. The rest of the subgroup is dropped (the subscriber asked for
  /// that), no stream is reopened for it, and group 6 arrives on its own stream with
  /// its own ids.
  #[tokio::test]
  async fn a_stopped_stream_is_not_reopened_and_later_groups_keep_their_ids() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(88, server);
    let track = test_track(TRACK, "video-720p");
    let sub = subscribe(&track, &client, latest(), false).await;
    let counters = sub.read().await.counters.clone();
    sub.read().await.mark_alias_announced();

    publish(&track, 5, 0).await;
    let first = peer.accept_uni().await.unwrap();
    first.stop(0x10);
    tokio::time::sleep(Duration::from_millis(200)).await;
    for o in 1..5 {
      publish(&track, 5, o).await;
      tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if let Some(reopened) = next_stream(&peer, Duration::from_secs(1)).await {
      panic!(
        "group 5 was reopened after STOP_SENDING, carrying {:?} (published 5/1..5/4)",
        objects_on(reopened).await
      );
    }

    track
      .stream_closed(&StreamId::new_subgroup(TRACK, 5, Some(0)))
      .await
      .unwrap();
    for o in 0..3 {
      publish(&track, 6, o).await;
    }
    let next = next_stream(&peer, Duration::from_secs(3))
      .await
      .expect("group 6 is delivered");
    assert_eq!(objects_on(next).await, vec![(6, 0), (6, 1), (6, 2)]);
    assert!(
      counters
        .stopped_stream_objects_dropped
        .load(Ordering::Relaxed)
        >= 3,
      "the rest of group 5 is dropped"
    );
  }

  /// Should a stream ever be reopened (here: it vanished from the send-stream map
  /// without the subscriber stopping it), the first object on the new stream is
  /// encoded from scratch, not as a delta from the old stream's last id.
  #[tokio::test]
  async fn a_reopened_stream_starts_its_object_ids_afresh() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(89, server);
    let track = test_track(TRACK, "video-720p");
    let sub = subscribe(&track, &client, latest(), false).await;
    sub.read().await.mark_alias_announced();

    publish(&track, 5, 0).await;
    publish(&track, 5, 1).await;
    let first = peer.accept_uni().await.unwrap();
    let first_objects = tokio::spawn(objects_on(first));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let gone = client
      .remove_stream_by_stream_id(&StreamId::new_subgroup(TRACK, 5, Some(0)))
      .await;
    assert!(gone.is_some());
    publish(&track, 5, 3).await;
    publish(&track, 5, 4).await;
    let reopened = next_stream(&peer, Duration::from_secs(3))
      .await
      .expect("the stream is reopened from the cached header");
    assert_eq!(objects_on(reopened).await, vec![(5, 3), (5, 4)]);
    assert_eq!(first_objects.await.unwrap(), vec![(5, 0), (5, 1)]);
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

/// R7-D6: ending a subscription with several data streams open FINs them all at
/// once, so the subscriber sees every stream end about one round trip after the
/// finish, not one round trip per stream.
#[cfg(test)]
mod tests_finish_streams_concurrently {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, publish, relay_client, subscribe, test_track, webtransport_pair_delayed,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::transport::data_stream_handler::RecvDataStream;
  use std::time::{Duration, Instant};

  const TRACK: u64 = 1;
  const STREAMS: u64 = 6;
  const ONE_WAY: Duration = Duration::from_millis(40);

  #[tokio::test]
  async fn finish_ends_every_open_stream_within_about_one_round_trip() {
    let (peer, server) = webtransport_pair_delayed(ONE_WAY).await;
    let client = relay_client(95, server);
    let track = test_track(TRACK, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();

    // One open stream per group: the publisher's streams never close here.
    for group in 1..=STREAMS {
      publish(&track, group, 0).await;
    }
    let (ended_tx, mut ended_rx) = tokio::sync::mpsc::unbounded_channel::<Instant>();
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    for _ in 0..STREAMS {
      let recv = tokio::time::timeout(Duration::from_secs(5), peer.accept_uni())
        .await
        .expect("stream within 5 s")
        .expect("stream");
      let (ended_tx, seen_tx) = (ended_tx.clone(), seen_tx.clone());
      tokio::spawn(async move {
        let data = RecvDataStream::new(
          recv,
          Arc::new(RwLock::new(std::collections::BTreeMap::new())),
        );
        while let (_, Some(_)) = data.next_object().await {
          let _ = seen_tx.send(());
        }
        let _ = ended_tx.send(Instant::now());
      });
    }
    for _ in 0..STREAMS {
      tokio::time::timeout(Duration::from_secs(5), seen_rx.recv())
        .await
        .expect("each stream's first object");
    }

    let finished_at = Instant::now();
    sub.read().await.finish().await;
    let mut last_end = finished_at;
    for _ in 0..STREAMS {
      let ended = tokio::time::timeout(Duration::from_secs(5), ended_rx.recv())
        .await
        .expect("every stream ends")
        .unwrap();
      last_end = last_end.max(ended);
    }
    let took = last_end - finished_at;
    // One way to deliver the FINs; sequential closing (each finish awaiting the
    // peer's ACK before the next FIN) takes about one round trip per stream
    // (here 40 ms + 5 x 80 ms).
    assert!(
      took < 4 * ONE_WAY,
      "the last of {STREAMS} streams ended {took:?} after finish (one way {ONE_WAY:?})"
    );
  }
}

/// R7-D3 (shared half): an object event that passed the end-group check before the
/// subscription was bounded and finished can complete its `open_stream` after
/// `finish()` drained the send-stream map. That stream used to be inserted into the
/// map anyway and was never FIN'd or reset. The race is made deterministic by
/// granting the relay a single uni stream: the second group's open waits for credit
/// while the test finishes the subscription.
#[cfg(test)]
mod tests_open_racing_finish {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, publish, quic_pair_with_transports, relay_client, subscribe, test_track,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::transport::connection::{
    TransportConnection, TransportReadError, TransportRecvStream,
  };
  use std::time::Duration;

  const TRACK: u64 = 1;

  /// How a stream ends on the subscriber's side, read to its end.
  #[derive(Debug, PartialEq, Eq)]
  enum End {
    Fin,
    Reset(u64),
    StillOpen,
  }

  async fn read_to_end(recv: &mut TransportRecvStream) -> End {
    let mut buf = [0u8; 256];
    loop {
      match tokio::time::timeout(Duration::from_secs(1), recv.read(&mut buf)).await {
        Err(_) => return End::StillOpen,
        Ok(Ok(Some(_))) => continue,
        Ok(Ok(None)) => return End::Fin,
        Ok(Err(TransportReadError::Reset(code))) => return End::Reset(code),
        Ok(Err(e)) => panic!("read failed: {e:?}"),
      }
    }
  }

  /// Opens group 1's stream, then queues group 2 while the relay has no stream
  /// credit left, bounds the subscription at `end_group` and finishes it. Returns how
  /// the stream the racing open finally created ends on the subscriber.
  async fn racing_open_after_finish(conn: usize, end_group: u64) -> End {
    let mut subscriber_transport = wtransport::quinn::TransportConfig::default();
    subscriber_transport.max_concurrent_uni_streams(1u32.into());
    let (peer, server): (TransportConnection, TransportConnection) =
      quic_pair_with_transports(None, Some(subscriber_transport)).await;
    let client = relay_client(conn, server);
    let track = test_track(TRACK, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();

    publish(&track, 1, 0).await;
    let mut first = tokio::time::timeout(Duration::from_secs(5), peer.accept_uni())
      .await
      .expect("group 1's stream")
      .unwrap();
    // Group 2 passes the end-group check (none yet) and waits for stream credit.
    publish(&track, 2, 0).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    {
      let sub = sub.read().await;
      sub.subscription_state.write().await.end_group = Some(end_group);
      sub.finish().await;
    }
    // Group 1's stream ends (FIN by finish); reading it to the end returns the
    // credit, and the racing open completes.
    assert_eq!(read_to_end(&mut first).await, End::Fin);
    let mut racing = tokio::time::timeout(Duration::from_secs(5), peer.accept_uni())
      .await
      .expect("the racing open completes once credit returns")
      .unwrap();
    read_to_end(&mut racing).await
  }

  /// A racing stream at or above the bound (the switch seam) is reset: the
  /// subscriber discards that span anyway.
  #[tokio::test]
  async fn a_stream_opened_after_finish_above_the_bound_is_reset() {
    assert_eq!(
      racing_open_after_finish(96, 1).await,
      End::Reset(StreamResetCode::Cancelled.to_u64())
    );
  }

  /// A racing stream below the bound is FIN'd, so the subscriber sees it end.
  #[tokio::test]
  async fn a_stream_opened_after_finish_below_the_bound_is_finished() {
    assert_eq!(racing_open_after_finish(97, 2).await, End::Fin);
  }
}

/// R7-D3 (pr1378 half): B, the below-seam stream count the target PUBLISH carries,
/// is read at the hand-over after `finish()`. An open of a below-seam group that
/// was waiting (here for stream credit) when the subscription finished completes
/// afterwards and is FIN'd (shared half), so the subscriber sees it; it used to be
/// counted only once its open returned, after B was read. Every stream the
/// subscriber can see must be in B, or the player's done condition (B ended
/// below-seam streams) can hold while a counted stream is still delivering.
#[cfg(test)]
mod tests_below_seam_count_race {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, publish, quic_pair_with_transports, relay_client, subscribe, test_track,
  };
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::transport::connection::TransportConnection;
  use std::time::Duration;

  #[tokio::test]
  async fn a_below_seam_open_racing_the_hand_over_is_in_b() {
    let mut subscriber_transport = wtransport::quinn::TransportConfig::default();
    subscriber_transport.max_concurrent_uni_streams(1u32.into());
    let (peer, server): (TransportConnection, TransportConnection) =
      quic_pair_with_transports(None, Some(subscriber_transport)).await;
    let client = relay_client(98, server);
    let track = test_track(1, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();

    publish(&track, 1, 0).await;
    let mut first = tokio::time::timeout(Duration::from_secs(5), peer.accept_uni())
      .await
      .expect("group 1's stream")
      .unwrap();
    // Group 2's open waits for stream credit.
    publish(&track, 2, 0).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The hand-over at G_switch = 3: bound at 2, end, read B.
    let below_seam = {
      let sub = sub.read().await;
      sub.subscription_state.write().await.end_group = Some(2);
      sub.finish().await;
      sub.opened_streams_below(3)
    };

    // Group 1's stream ends; its credit lets the racing open complete.
    let mut buf = [0u8; 256];
    while let Ok(Some(_)) = first.read(&mut buf).await {}
    let mut seen = 1;
    while let Ok(Ok(mut recv)) =
      tokio::time::timeout(Duration::from_millis(500), peer.accept_uni()).await
    {
      seen += 1;
      while let Ok(Some(_)) = recv.read(&mut buf).await {}
    }
    assert_eq!(seen, 2, "groups 1 and 2 reach the subscriber");
    assert_eq!(
      below_seam, seen,
      "B must count every below-seam stream the subscriber sees"
    );
  }
}

/// Preflight 2026-10-05: a stream the relay had FIN'd (its group complete) but whose
/// bytes were still queued behind a saturated link could no longer be reset.
/// `close_stream` took it out of the send-stream map and held it until the subscriber
/// acknowledged everything, so a later reset of the subscription (cancel; on
/// switch/pr1378 the switch seam) missed it and its stale bytes arrived seconds later.
/// Here a 2 MB group crosses a 200 ms round trip from a cold congestion window, so its
/// stream is FIN'd long before its last bytes are sent; cancelling the subscription
/// must reset it.
#[cfg(test)]
mod tests_reset_reaches_finishing_streams {
  use super::*;
  use crate::server::test_support::{
    TEST_NAMESPACE, relay_client, subscribe, test_track, wait_until, webtransport_pair_delayed,
  };
  use crate::server::track::Track;
  use crate::server::utils::build_stream_id;
  use moqtail::model::common::tuple::{Tuple, TupleField};
  use moqtail::model::data::subgroup_header::SubgroupHeader;
  use moqtail::model::data::subgroup_object::SubgroupObject;
  use moqtail::transport::connection::TransportReadError;
  use std::time::Duration;

  const TRACK: u64 = 1;
  const OBJECTS: u64 = 32;
  const OBJECT_BYTES: usize = 64 * 1024;
  const ONE_WAY: Duration = Duration::from_millis(100);

  async fn publish_large(track: &Track, group: u64, object: u64) -> StreamId {
    let header = HeaderInfo::Subgroup {
      header: SubgroupHeader::new_with_explicit_id(TRACK, group, 0, Some(0), false, true, true),
    };
    let stream_id = build_stream_id(TRACK, &header);
    let object_model = Object::try_from_subgroup(
      SubgroupObject {
        object_id: object,
        properties: None,
        object_status: None,
        payload: Some(Bytes::from(vec![7u8; OBJECT_BYTES])),
      },
      TRACK,
      group,
      Some(0),
      Some(0),
      DEFAULT_PUBLISHER_PRIORITY,
    )
    .expect("object");
    track
      .new_subgroup_object(&stream_id, &object_model, (object == 0).then_some(&header))
      .await
      .expect("ingest");
    stream_id
  }

  #[tokio::test]
  async fn cancel_resets_a_finished_stream_whose_bytes_are_still_queued() {
    let (peer, server) = webtransport_pair_delayed(ONE_WAY).await;
    let client = relay_client(98, server);
    let track = test_track(TRACK, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();

    // The subscriber reads everything it is sent and reports how the stream ended.
    let (end_tx, end_rx) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
      let mut recv = peer.accept_uni().await.expect("the group's stream");
      let mut buf = vec![0u8; 65_536];
      let end = loop {
        match recv.read(&mut buf).await {
          Ok(Some(_)) => continue,
          Ok(None) => break "fin".to_string(),
          Err(TransportReadError::Reset(code)) => break format!("reset {code}"),
          Err(e) => break format!("error {e:?}"),
        }
      };
      let _ = end_tx.send(end);
      std::mem::forget(peer);
    });

    let mut stream_id = None;
    for object in 0..OBJECTS {
      stream_id = Some(publish_large(&track, 1, object).await);
    }
    track
      .stream_closed(&stream_id.unwrap())
      .await
      .expect("stream closed");
    let finishing = sub.read().await.finishing_streams.clone();
    assert!(
      wait_until(Duration::from_secs(5), || {
        let finishing = finishing.clone();
        async move { !finishing.read().await.is_empty() }
      })
      .await,
      "the closed group's stream is FIN'd and awaiting acknowledgement"
    );

    sub.read().await.cancel().await;

    let end = tokio::time::timeout(Duration::from_secs(10), end_rx)
      .await
      .expect("the stream ends")
      .unwrap();
    assert_eq!(
      end,
      format!("reset {}", StreamResetCode::Cancelled.to_u64())
    );
    assert!(
      finishing.read().await.is_empty(),
      "the reset retires the entry"
    );
  }
  /// pr1378: the switch seam. A FIN'd group below the seam is media the subscriber
  /// plays before the seam and must arrive whole (FIN); a FIN'd group at or above it
  /// is covered by the target and must be reset.
  #[tokio::test]
  async fn cancel_from_group_resets_finished_streams_at_or_above_the_seam_only() {
    let (peer, server) = webtransport_pair_delayed(ONE_WAY).await;
    let client = relay_client(99, server);
    let track = test_track(TRACK, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();

    // Streams are accepted in the order the relay opened them: group 1, then 2.
    let (end_tx, mut end_rx) = tokio::sync::mpsc::unbounded_channel::<(usize, String)>();
    tokio::spawn(async move {
      for i in 0..2 {
        let mut recv = peer.accept_uni().await.expect("a group's stream");
        let end_tx = end_tx.clone();
        tokio::spawn(async move {
          let mut buf = vec![0u8; 65_536];
          let end = loop {
            match recv.read(&mut buf).await {
              Ok(Some(_)) => continue,
              Ok(None) => break "fin".to_string(),
              Err(TransportReadError::Reset(code)) => break format!("reset {code}"),
              Err(e) => break format!("error {e:?}"),
            }
          };
          let _ = end_tx.send((i, end));
        });
      }
      std::mem::forget(peer);
    });

    for group in 1..=2 {
      let mut stream_id = None;
      for object in 0..OBJECTS / 2 {
        stream_id = Some(publish_large(&track, group, object).await);
      }
      track
        .stream_closed(&stream_id.unwrap())
        .await
        .expect("stream closed");
    }
    let finishing = sub.read().await.finishing_streams.clone();
    assert!(
      wait_until(Duration::from_secs(5), || {
        let finishing = finishing.clone();
        async move { finishing.read().await.entries.len() == 2 }
      })
      .await,
      "both groups are FIN'd and awaiting acknowledgement"
    );

    let (reset_open, reset_finished) = sub.read().await.cancel_from_group(2).await;
    assert_eq!((reset_open, reset_finished), (0, 1));

    // Group 2 is reset; when none of its bytes (the WebTransport stream header
    // included) reached the subscriber first, WebTransport cannot place it and the
    // subscriber never sees the stream at all. Either way nothing of it is delivered.
    let mut ends = std::collections::BTreeMap::new();
    let mut wait = Duration::from_secs(15);
    while let Ok(Some((i, end))) = tokio::time::timeout(wait, end_rx.recv()).await {
      ends.insert(i, end);
      if ends.len() == 2 {
        break;
      }
      // Once group 1 has ended, group 2 (had it not been reset) would follow within
      // about a second on this link.
      wait = Duration::from_secs(5);
    }
    assert_eq!(
      ends.get(&0).map(String::as_str),
      Some("fin"),
      "group 1, below the seam, arrives whole: {ends:?}"
    );
    let reset = format!("reset {}", StreamResetCode::Cancelled.to_u64());
    assert!(
      ends.get(&1).is_none_or(|e| *e == reset),
      "group 2, at the seam, is reset or never surfaces: {ends:?}"
    );
  }

  /// Opens group 1 on a delayed link with `objects` large objects; returns the
  /// subscription, the track, the group's stream id and a receiver of how the
  /// subscriber saw the stream end.
  async fn one_large_group(
    conn: usize,
    objects: u64,
  ) -> (
    Arc<RwLock<Subscription>>,
    Track,
    StreamId,
    tokio::sync::oneshot::Receiver<String>,
  ) {
    let (peer, server) = webtransport_pair_delayed(ONE_WAY).await;
    let client = relay_client(conn, server);
    let track = test_track(TRACK, "video-720p");
    let latest = Subscribe::new_latest_object(
      1,
      Tuple::from_utf8_path(TEST_NAMESPACE),
      TupleField::from_utf8("video-720p"),
      vec![MessageParameter::new_forward(true)],
    );
    let sub = subscribe(&track, &client, latest, false).await;
    sub.read().await.mark_alias_announced();
    let (end_tx, end_rx) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
      let mut recv = peer.accept_uni().await.expect("the group's stream");
      let mut buf = vec![0u8; 65_536];
      let end = loop {
        match recv.read(&mut buf).await {
          Ok(Some(_)) => continue,
          Ok(None) => break "fin".to_string(),
          Err(TransportReadError::Reset(code)) => break format!("reset {code}"),
          Err(e) => break format!("error {e:?}"),
        }
      };
      let _ = end_tx.send(end);
      std::mem::forget(peer);
    });
    let mut stream_id = None;
    for object in 0..objects {
      stream_id = Some(publish_large(&track, 1, object).await);
    }
    (sub, track, stream_id.unwrap(), end_rx)
  }

  /// Review 2026-10-05: a close that runs after a reset of the subscription (here
  /// the group completes after the reset's sweep) must reset the stream, not FIN it.
  #[tokio::test]
  async fn a_close_after_a_reset_resets_instead_of_finishing() {
    let (sub, track, stream_id, end_rx) = one_large_group(100, OBJECTS).await;
    // The reset's sweep finds nothing FIN'd yet: the group's stream is still open
    // and, as in the race, already out of the open-stream bookkeeping.
    sub
      .read()
      .await
      .send_stream_last_object_ids
      .write()
      .await
      .remove(&stream_id);
    let swept = sub
      .read()
      .await
      .reset_finishing_streams(StreamResetCode::Cancelled.to_u64(), 0)
      .await;
    assert_eq!(swept, 0);
    track
      .stream_closed(&stream_id)
      .await
      .expect("stream closed");
    let end = tokio::time::timeout(Duration::from_secs(10), end_rx)
      .await
      .expect("the stream ends")
      .unwrap();
    assert_eq!(
      end,
      format!("reset {}", StreamResetCode::Cancelled.to_u64())
    );
  }

  /// Review 2026-10-05: quinn frees a stream reset after FIN without waking its
  /// `stopped()` waiter, so the acknowledgement wait of a reset stream lasted until
  /// the connection closed. It must end with the reset.
  #[tokio::test]
  async fn a_reset_ends_the_acknowledgement_wait() {
    let (sub, _track, stream_id, _end_rx) = one_large_group(101, OBJECTS).await;
    let ack = sub
      .read()
      .await
      .begin_close_data_stream(&stream_id)
      .await
      .expect("close")
      .expect("an open stream to finish");
    sub
      .read()
      .await
      .reset_finishing_streams(StreamResetCode::Cancelled.to_u64(), 0)
      .await;
    let outcome = tokio::time::timeout(Duration::from_secs(2), ack)
      .await
      .expect("the wait ends with the reset")
      .expect("no error");
    assert_eq!(outcome, FinishOutcome::Reset);
  }
}
