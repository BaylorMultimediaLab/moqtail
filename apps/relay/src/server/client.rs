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

pub(crate) mod track_subscription_map;

use crate::server::switch_guard::SwitchInFlight;
use crate::server::{
  client::track_subscription_map::TrackSubscriptionMap,
  message_handlers::fetch_handler::FetchStop,
  session_context::PendingRequest,
  stream_id::{StreamId, StreamType},
  utils,
};
use anyhow::Result;
#[allow(dead_code)]
use bytes::Bytes;
use moqtail::{
  model::{
    common::tuple::Tuple,
    control::{control_message::ControlMessage, setup::Setup},
    data::full_track_name::FullTrackName,
    error::StreamResetCode,
  },
  transport::{
    connection::{TransportConnection, TransportKind, TransportSendStream, TransportWriteError},
    data_stream_handler::{FetchRequest, SubscribeRequest},
  },
};

use std::{
  collections::{BTreeMap, HashMap, VecDeque},
  sync::Arc,
  time::Duration,
};
use tokio::sync::Notify;
use tokio::sync::{Mutex, RwLock, mpsc, watch};
use tokio::time::Instant;
use tracing::{debug, error, info, warn};

/// Token-bucket rate limiter. All streams of one subscriber share a single
/// bucket so they compete for bandwidth — the QUIC scheduler then drains
/// higher-priority streams first when writes are pending.
#[derive(Debug)]
struct TokenBucket {
  rate_bytes_per_sec: f64,
  tokens: f64,
  last_refill: Instant,
}

impl TokenBucket {
  fn new(rate_kbps: u64) -> Self {
    let rate = rate_kbps as f64 * 1000.0 / 8.0; // kbps → bytes/sec
    Self {
      rate_bytes_per_sec: rate,
      tokens: rate, // start with one second worth of tokens
      last_refill: Instant::now(),
    }
  }

  async fn consume(&mut self, bytes: usize) {
    let now = Instant::now();
    let elapsed = now.duration_since(self.last_refill).as_secs_f64();
    self.tokens = (self.tokens + elapsed * self.rate_bytes_per_sec).min(self.rate_bytes_per_sec); // cap at 1 second of burst
    self.last_refill = now;

    let needed = bytes as f64;
    if self.tokens < needed {
      let deficit = needed - self.tokens;
      let wait = Duration::from_secs_f64(deficit / self.rate_bytes_per_sec);
      tokio::time::sleep(wait).await;
      self.tokens = 0.0;
    } else {
      self.tokens -= needed;
    }
  }
}

/// Number of partitions for send stream management to reduce lock contention.
/// Each partition contains a separate HashMap protected by its own RwLock.
/// Higher values reduce contention but increase memory overhead.
/// Should be a power of 2 for optimal modulo performance.
pub const SEND_STREAM_PARTITION_COUNT: usize = 16;

pub type SendStreamMap = HashMap<String, Arc<Mutex<TransportSendStream>>>;
pub type SendStreamLock = Arc<RwLock<SendStreamMap>>;
pub type SendStreamList = Vec<SendStreamLock>;

// Per-request response channels, sharded like the send-stream map so a
// register/lookup only locks one partition.
pub type ResponseSenderMap = HashMap<u64, mpsc::UnboundedSender<ControlMessage>>;
pub type ResponseSenderList = Vec<Arc<RwLock<ResponseSenderMap>>>;

#[derive(Debug, Clone)]
pub(crate) struct MOQTClient {
  pub connection_id: usize,
  pub transport_kind: TransportKind,
  pub connection: Arc<TransportConnection>,
  #[allow(dead_code)]
  pub client_setup: Arc<Setup>,
  pub announced_track_namespaces: Arc<RwLock<Vec<Tuple>>>, // the track namespaces the publisher announced
  pub outbound_announcements: Arc<RwLock<HashMap<Tuple, u64>>>, //Maps a Namespace to the outbound request_id we used to announce it to the client
  pub published_tracks: Arc<RwLock<HashMap<u64, FullTrackName>>>, // request_id -> track the client is publishing
  pub subscribers: Arc<RwLock<Vec<usize>>>, // the subscribers the client is subscribed to

  pub message_queue: Arc<RwLock<VecDeque<ControlMessage>>>, // the control messages the client has sent
  pub message_notify: Arc<Notify>, // notify when a new message is available
  pub send_streams: Arc<SendStreamList>,

  // Per-request response channels, keyed by the request's (downstream) request id
  // and sharded across partitions. A request stream registers its sender here so
  // responses/follow-ups produced elsewhere (e.g. a deferred SUBSCRIBE_OK fan-out)
  // are delivered onto that stream instead of the control stream.
  pub response_senders: Arc<ResponseSenderList>,

  // fetch requests that this client sent to the relay
  pub incoming_fetch_requests: Arc<RwLock<BTreeMap<u64, FetchRequest>>>,
  // fetch requests that the relay sent to this client
  pub outgoing_fetch_requests: Arc<RwLock<BTreeMap<u64, FetchRequest>>>,

  // this contains the requests made by the client and the corresponding request.
  // The key value is the original request id.
  pub subscribe_requests: Arc<RwLock<BTreeMap<u64, SubscribeRequest>>>,

  pub inbound_requests: Arc<RwLock<BTreeMap<u64, PendingRequest>>>,

  // Senders for cancelling active fetch tasks, keyed by request_id.
  pub fetch_cancel_senders: Arc<RwLock<HashMap<u64, watch::Sender<FetchStop>>>>,

  // this contains the subscriptions made by the client
  pub subscriptions: TrackSubscriptionMap,

  // SWITCH PR #1378 single-in-flight SWITCH guard, keyed by Current Subscribe
  // Request ID. Admitted/rejected (EXCESSIVE_LOAD) by the switch handler;
  // entries self-expire at T_switch.
  pub switch_in_flight: Arc<Mutex<SwitchInFlight>>,

  // Optional per-connection write rate limiter. All streams of this client share
  // the same bucket so they compete for bandwidth, exercising QUIC stream priority.
  rate_limiter: Option<Arc<Mutex<TokenBucket>>>,
}

impl MOQTClient {
  /// `write_kbps_limit` is the configured per-connection write cap (0 = none); the
  /// session passes `AppConfig::write_kbps_limit`.
  pub(crate) fn new(
    connection_id: usize,
    connection: Arc<TransportConnection>,
    client_setup: Arc<Setup>,
    write_kbps_limit: u64,
  ) -> Self {
    let mut send_streams = Vec::with_capacity(SEND_STREAM_PARTITION_COUNT);
    for _ in 0..SEND_STREAM_PARTITION_COUNT {
      send_streams.push(Arc::new(RwLock::new(HashMap::new())));
    }

    let kbps = write_kbps_limit;
    let rate_limiter = if kbps > 0 {
      Some(Arc::new(Mutex::new(TokenBucket::new(kbps))))
    } else {
      None
    };

    MOQTClient {
      connection_id,
      transport_kind: connection.kind(),
      connection,
      client_setup,
      announced_track_namespaces: Arc::new(RwLock::new(Vec::new())),
      outbound_announcements: Arc::new(RwLock::new(HashMap::new())),
      published_tracks: Arc::new(RwLock::new(HashMap::new())),
      subscribers: Arc::new(RwLock::new(Vec::new())),
      message_queue: Arc::new(RwLock::new(VecDeque::new())),
      message_notify: Arc::new(Notify::default()),
      send_streams: Arc::new(send_streams),
      response_senders: Arc::new(
        (0..SEND_STREAM_PARTITION_COUNT)
          .map(|_| Arc::new(RwLock::new(HashMap::new())))
          .collect(),
      ),
      incoming_fetch_requests: Arc::new(RwLock::new(BTreeMap::new())),
      outgoing_fetch_requests: Arc::new(RwLock::new(BTreeMap::new())),
      subscribe_requests: Arc::new(RwLock::new(BTreeMap::new())),
      inbound_requests: Arc::new(RwLock::new(BTreeMap::new())),
      fetch_cancel_senders: Arc::new(RwLock::new(HashMap::new())),
      subscriptions: TrackSubscriptionMap::new(),
      switch_in_flight: Arc::new(Mutex::new(SwitchInFlight::new())),
      rate_limiter,
    }
  }

  pub(crate) async fn add_announced_track_namespace(&self, track_namespace: Tuple) {
    let mut announced_track_namespaces = self.announced_track_namespaces.write().await;
    announced_track_namespaces.push(track_namespace);
  }

  /// Leaving a withdrawn namespace here would keep routing subscriptions to this client.
  pub(crate) async fn remove_announced_track_namespace(&self, track_namespace: &Tuple) {
    let mut announced_track_namespaces = self.announced_track_namespaces.write().await;
    announced_track_namespaces.retain(|ns| ns != track_namespace);
  }

  pub(crate) async fn add_subscriber(&self, subscriber_id: usize) {
    let mut subscribers = self.subscribers.write().await;
    subscribers.push(subscriber_id);
  }

  pub(crate) async fn get_outbound_announce_id(&self, namespace: &Tuple) -> Option<u64> {
    let map = self.outbound_announcements.read().await;
    map.get(namespace).cloned()
  }

  pub(crate) async fn add_published_track(&self, request_id: u64, full_track_name: FullTrackName) {
    let mut published_tracks = self.published_tracks.write().await;
    published_tracks.insert(request_id, full_track_name);
  }

  /// Get the next control message from the queue.
  /// This function will block until a message is available and will return the message.
  pub(crate) async fn wait_for_next_message(&self) -> ControlMessage {
    loop {
      // Acquire the lock and check if there's a message
      let mut message_queue = self.message_queue.write().await;
      if let Some(message) = message_queue.pop_front() {
        return message;
      }
      // Drop the lock before waiting
      drop(message_queue);
      // TODO: what happens when the client disconnects?
      self.message_notify.notified().await;
    }
  }

  // Also, update queue_message to notify:
  pub(crate) async fn queue_message(&self, control_message: ControlMessage) {
    let mut message_queue = self.message_queue.write().await;
    message_queue.push_back(control_message);
    self.message_notify.notify_one();
  }

  /// The response-sender shard for a request id (sequential ids spread evenly).
  fn response_partition(&self, request_id: u64) -> usize {
    (request_id % self.response_senders.len() as u64) as usize
  }

  /// Register a request stream's response channel under its request id.
  pub(crate) async fn register_response_sender(
    &self,
    request_id: u64,
    tx: mpsc::UnboundedSender<ControlMessage>,
  ) {
    let idx = self.response_partition(request_id);
    self.response_senders[idx]
      .write()
      .await
      .insert(request_id, tx);
  }

  /// Remove a request stream's response channel (on stream close).
  pub(crate) async fn unregister_response_sender(&self, request_id: u64) {
    let idx = self.response_partition(request_id);
    self.response_senders[idx].write().await.remove(&request_id);
  }

  /// Deliver a message onto the request stream registered for `request_id`.
  /// Returns true if a request stream was registered and accepted it; false
  /// otherwise (the caller may fall back to the control-stream queue).
  pub(crate) async fn send_response(&self, request_id: u64, message: ControlMessage) -> bool {
    let idx = self.response_partition(request_id);
    let senders = self.response_senders[idx].read().await;
    match senders.get(&request_id) {
      Some(tx) => tx.send(message).is_ok(),
      None => false,
    }
  }

  /// Calculate the partition index for stream distribution across buckets.
  /// This method implements a load balancing strategy to distribute streams
  /// across multiple stream buckets to improve performance and reduce contention.
  fn get_partition_index(&self, stream_id: &StreamId) -> usize {
    let value = match stream_id.stream_type {
      StreamType::Fetch => {
        // Use a simple hash combining relay_track_id and fetch_request_id
        stream_id
          .relay_track_id
          .wrapping_add(stream_id.fetch_request_id.unwrap_or(0).wrapping_mul(13))
      }
      StreamType::Subgroup => {
        // Better distribution using prime number multipliers
        stream_id
          .relay_track_id
          .wrapping_add(stream_id.group_id.unwrap_or(0).wrapping_mul(17))
          .wrapping_add(stream_id.subgroup_id.unwrap_or(0).wrapping_mul(31))
      }
    };

    // Convert to bytes for fnv_hash function
    let value_bytes = value.to_le_bytes();
    (utils::fnv_hash(&value_bytes) % SEND_STREAM_PARTITION_COUNT as u64) as usize
  }

  fn get_stream_map(
    &self,
    stream_id: &StreamId,
  ) -> Arc<RwLock<HashMap<String, Arc<Mutex<TransportSendStream>>>>> {
    let partition_index = self.get_partition_index(stream_id);
    debug!(
      "get_stream_map | stream_id: {} partition_index: {}",
      stream_id, partition_index
    );
    self.send_streams[partition_index].clone()
  }

  pub async fn get_stream(&self, stream_id: &StreamId) -> Option<Arc<Mutex<TransportSendStream>>> {
    let send_stream_map = self.get_stream_map(stream_id);
    let send_streams = send_stream_map.read().await;
    let send_stream = send_streams.get(stream_id.get_stream_id().as_str());
    send_stream.cloned()
  }

  pub async fn open_stream(
    &self,
    stream_id: &StreamId,
    header_payload: Bytes,
    priority: i32, // Priority for the stream
  ) -> Result<Arc<Mutex<TransportSendStream>>> {
    let send_stream = match self.get_stream(stream_id).await {
      Some(s) => {
        debug!(
          "open_stream | Send stream for {} already exists connection_id: {}",
          stream_id, self.connection_id
        );
        s
      }
      None => {
        // Opening can wait for the subscriber to grant stream credit, so it happens
        // with no partition lock held: the other streams of this partition keep
        // being found and written meanwhile (R3-D5).
        // The priority is in place before the first byte (the WebTransport stream
        // header included), so the stream is never queued at quinn's default 0
        // (R3-D6).
        let opened = self
          .connection
          .open_uni_with_priority(priority)
          .await
          .map_err(|e| anyhow::anyhow!("Failed to open send stream: {:?}", e))?;
        let send_stream_map = self.get_stream_map(stream_id);
        let mut send_streams = send_stream_map.write().await;
        match send_streams.entry(stream_id.get_stream_id().to_string()) {
          std::collections::hash_map::Entry::Vacant(entry) => {
            let s = Arc::new(Mutex::new(opened));
            entry.insert(s.clone());
            info!(
              "open_stream | added send_stream to send streams ({}) connection_id: {}",
              stream_id, self.connection_id
            );
            s
          }
          std::collections::hash_map::Entry::Occupied(existing) => {
            // Another open of the same id won the race while this one waited.
            debug!(
              "open_stream | Send stream for {} opened concurrently connection_id: {}",
              stream_id, self.connection_id
            );
            let mut extra = opened;
            let _ = extra.reset(StreamResetCode::Cancelled.to_u64());
            existing.get().clone()
          }
        }
      }
    };

    debug!(
      "open_stream |  writing to stream ({}) connection_id: {}",
      stream_id, self.connection_id
    );

    // Write the header payload to the stream
    match send_stream.lock().await.write_all(&header_payload).await {
      Ok(..) => {
        debug!(
          "open_stream |  wrote to stream ({}) connection_id: {}",
          stream_id, self.connection_id
        );
      }
      Err(e) => {
        error!(
          "open_stream |  Failed to write header payload to send stream ({}) connection_id: {}",
          stream_id, self.connection_id
        );

        // remove this from the streams
        let send_stream_map = self.get_stream_map(stream_id);
        let mut send_streams = send_stream_map.write().await;
        send_streams.remove(&stream_id.get_stream_id().to_string());

        return Err(anyhow::anyhow!(
          "Failed to write header payload to send stream ({}): {:?} connection_id: {}",
          stream_id,
          self.connection_id,
          e
        ));
      }
    };

    Ok(send_stream.clone())
  }

  // Remove the stream from the map and finish it
  // if the stream is found, return true, else false
  pub async fn close_stream(&self, stream_id: &StreamId) -> Result<bool> {
    let stream = self.remove_stream_by_stream_id(stream_id).await;

    if let Some(send_stream) = stream {
      // gracefully close the stream
      let mut stream = send_stream.lock().await;

      // gracefully close the stream
      // No new data may be written after calling this method.
      // Completes when the peer has acknowledged all sent data, retransmitting data as needed.
      stream
        .finish()
        .await
        .map_err(|e| {
          error!(
            "close_stream | Failed to finish send stream ({}): {:?} connection_id: {}",
            stream_id, e, self.connection_id
          );
          anyhow::anyhow!("Failed to finish send stream ({}): {:?}", stream_id, e)
        })
        .map(|_| true)
    } else {
      // it is possible that no stream was created for this stream id
      // because the subscription can be in no forwarding state
      debug!(
        "close_stream | Send stream not found for {} connection_id: {}",
        stream_id, self.connection_id
      );
      Ok(false)
    }
  }

  // Just remove the stream from the stream_map
  // The caller finishes the stream and calls this to remove it from the map
  pub async fn remove_stream_by_stream_id(
    &self,
    stream_id: &StreamId,
  ) -> Option<Arc<Mutex<TransportSendStream>>> {
    let send_stream_map = self.get_stream_map(stream_id);
    let mut send_streams = send_stream_map.write().await;
    send_streams.remove(stream_id.get_stream_id().as_str())
  }

  /// Reset a data stream with an application error code (QUIC RESET_STREAM) and
  /// drop it from the send-stream map.
  pub async fn reset_stream(&self, stream_id: &StreamId, code: u64) {
    if let Some(stream) = self.remove_stream_by_stream_id(stream_id).await
      && let Err(e) = stream.lock().await.reset(code)
    {
      warn!("Error resetting data stream {}: {:?}", stream_id, e);
    }
  }

  pub async fn write_stream_object(
    &self,
    stream_id: &StreamId,
    object_id: u64,
    object: Bytes,
    the_stream: Option<Arc<Mutex<TransportSendStream>>>,
  ) -> Result<(), anyhow::Error> {
    debug!(
      "write_stream_object | Writing object to stream ({} - {}) connection_id: {}",
      object_id, stream_id, self.connection_id
    );

    let send_stream = {
      if let Some(send_stream) = the_stream {
        Some(send_stream)
      } else {
        let stream_map = self.get_stream_map(stream_id);
        let send_streams = stream_map.read().await;
        send_streams
          .get(stream_id.get_stream_id().as_str())
          .cloned()
      }
    };

    // Rate-limit before writing so all streams of this connection compete for
    // the shared bandwidth budget, causing QUIC buffers to fill and the QUIC
    // stream priority scheduler to choose between them.
    if let Some(rl) = &self.rate_limiter {
      rl.lock().await.consume(object.len()).await;
    }

    // M21: a failed write is an error to the caller. It used to be swallowed, so
    // OBJECT_SENT.sent read true and last_sent_max_location advanced for objects
    // that were never handed to QUIC, and the next switch's start group was then
    // computed from them.
    if let Some(s) = send_stream {
      let mut stream = s.lock().await;
      match stream.write_all(&object).await {
        Ok(..) => Ok(()),
        Err(e) => {
          if let TransportWriteError::ClosedOrStopped = &e {
            warn!(
              "write_stream_object | Send stream is closed or stopped ({})",
              stream_id.get_stream_id()
            );
            drop(stream);
            // remove this from the streams
            let stream_map = self.get_stream_map(stream_id);
            let mut send_streams = stream_map.write().await;
            send_streams.remove(stream_id.get_stream_id().as_str());
          }
          // The transport error is kept as the source, so a caller can tell a
          // stream the peer stopped (ClosedOrStopped) from other failures.
          Err(anyhow::Error::new(e).context(format!(
            "write to stream {} failed for connection_id {}",
            stream_id, self.connection_id
          )))
        }
      }
    } else {
      warn!(
        "write_stream_object | Send stream not found for {} connection_id: {}",
        stream_id, self.connection_id
      );
      Err(anyhow::anyhow!(
        "send stream not found ({}) for connection_id {}",
        stream_id,
        self.connection_id
      ))
    }
  }

  pub async fn write_datagram_object(&self, object: Bytes) -> Result<(), anyhow::Error> {
    debug!(
      "write_datagram_object | Writing datagram object connection_id: {}",
      self.connection_id
    );

    // Write the object payload directly to the connection as a datagram
    self.connection.send_datagram(object)?;
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::server::stream_id::{StreamId, StreamType};

  /// Test helper struct that exposes the partition logic for testing
  struct PartitionTester;

  impl PartitionTester {
    /// Expose the partition index calculation logic for testing
    /// This replicates the logic from MOQTClient::get_partition_index
    fn get_partition_index(stream_id: &StreamId) -> usize {
      let value = match stream_id.stream_type {
        StreamType::Fetch => {
          // Use a simple hash combining relay_track_id and fetch_request_id
          stream_id
            .relay_track_id
            .wrapping_add(stream_id.fetch_request_id.unwrap_or(0).wrapping_mul(13))
        }
        StreamType::Subgroup => {
          // Better distribution using prime number multipliers
          stream_id
            .relay_track_id
            .wrapping_add(stream_id.group_id.unwrap_or(0).wrapping_mul(17))
            .wrapping_add(stream_id.subgroup_id.unwrap_or(0).wrapping_mul(31))
        }
      };

      // Convert to bytes for fnv_hash function
      let value_bytes = value.to_le_bytes();
      (utils::fnv_hash(&value_bytes) % SEND_STREAM_PARTITION_COUNT as u64) as usize
    }
  }

  /// Helper function to create a Fetch stream ID
  fn create_fetch_stream_id(relay_track_id: u64, fetch_request_id: u64) -> StreamId {
    StreamId {
      stream_type: StreamType::Fetch,
      relay_track_id,
      group_id: None,
      subgroup_id: None,
      fetch_request_id: Some(fetch_request_id),
    }
  }

  /// Helper function to create a Subgroup stream ID
  fn create_subgroup_stream_id(
    relay_track_id: u64,
    group_id: Option<u64>,
    subgroup_id: Option<u64>,
  ) -> StreamId {
    StreamId {
      stream_type: StreamType::Subgroup,
      relay_track_id,
      group_id,
      subgroup_id,
      fetch_request_id: None,
    }
  }

  #[test]
  fn test_get_partition_index_fetch_streams() {
    // Test basic fetch stream partitioning
    let stream_id1 = create_fetch_stream_id(100, 1);
    let partition1 = PartitionTester::get_partition_index(&stream_id1);
    assert!(
      partition1 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    let stream_id2 = create_fetch_stream_id(100, 2);
    let partition2 = PartitionTester::get_partition_index(&stream_id2);
    assert!(
      partition2 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    // Different fetch request IDs should potentially give different partitions
    // (though not guaranteed due to hash collisions)
    let stream_id3 = create_fetch_stream_id(100, 1000);
    let partition3 = PartitionTester::get_partition_index(&stream_id3);
    assert!(
      partition3 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );
  }

  #[test]
  fn test_get_partition_index_fetch_streams_consistency() {
    // Test that the same inputs always produce the same output
    let stream_id = create_fetch_stream_id(42, 123);
    let partition1 = PartitionTester::get_partition_index(&stream_id);
    let partition2 = PartitionTester::get_partition_index(&stream_id);
    assert_eq!(
      partition1, partition2,
      "Same input should always produce same partition"
    );
  }

  #[test]
  fn test_get_partition_index_fetch_streams_edge_cases() {
    // Test with fetch_request_id = None (should default to 0)
    let mut stream_id = create_fetch_stream_id(100, 1);
    stream_id.fetch_request_id = None;
    let partition = PartitionTester::get_partition_index(&stream_id);
    assert!(
      partition < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    // Test with large values
    let stream_id_large = create_fetch_stream_id(u64::MAX, u64::MAX);
    let partition_large = PartitionTester::get_partition_index(&stream_id_large);
    assert!(
      partition_large < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds for large values"
    );

    // Test with zero values
    let stream_id_zero = create_fetch_stream_id(0, 0);
    let partition_zero = PartitionTester::get_partition_index(&stream_id_zero);
    assert!(
      partition_zero < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds for zero values"
    );
  }

  #[test]
  fn test_get_partition_index_subgroup_streams() {
    // Test basic subgroup stream partitioning
    let stream_id1 = create_subgroup_stream_id(100, Some(1), Some(1));
    let partition1 = PartitionTester::get_partition_index(&stream_id1);
    assert!(
      partition1 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    let stream_id2 = create_subgroup_stream_id(100, Some(2), Some(1));
    let partition2 = PartitionTester::get_partition_index(&stream_id2);
    assert!(
      partition2 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    let stream_id3 = create_subgroup_stream_id(200, Some(1), Some(1));
    let partition3 = PartitionTester::get_partition_index(&stream_id3);
    assert!(
      partition3 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );
  }

  #[test]
  fn test_get_partition_index_subgroup_streams_consistency() {
    // Test that the same inputs always produce the same output
    let stream_id = create_subgroup_stream_id(42, Some(7), Some(13));
    let partition1 = PartitionTester::get_partition_index(&stream_id);
    let partition2 = PartitionTester::get_partition_index(&stream_id);
    assert_eq!(
      partition1, partition2,
      "Same input should always produce same partition"
    );
  }

  #[test]
  fn test_get_partition_index_subgroup_streams_none_values() {
    // Test with None group_id and subgroup_id (should default to 0)
    let stream_id1 = create_subgroup_stream_id(100, None, None);
    let partition1 = PartitionTester::get_partition_index(&stream_id1);
    assert!(
      partition1 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    // Test with Some group_id and None subgroup_id
    let stream_id2 = create_subgroup_stream_id(100, Some(5), None);
    let partition2 = PartitionTester::get_partition_index(&stream_id2);
    assert!(
      partition2 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );

    // Test with None group_id and Some subgroup_id
    let stream_id3 = create_subgroup_stream_id(100, None, Some(3));
    let partition3 = PartitionTester::get_partition_index(&stream_id3);
    assert!(
      partition3 < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds"
    );
  }

  #[test]
  fn test_get_partition_index_subgroup_streams_large_values() {
    // Test with large values to ensure no overflow
    let stream_id_large = create_subgroup_stream_id(u64::MAX, Some(u64::MAX), Some(u64::MAX));
    let partition_large = PartitionTester::get_partition_index(&stream_id_large);
    assert!(
      partition_large < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds for large values"
    );

    // Test with values that might cause overflow in naive implementations
    let stream_id_overflow =
      create_subgroup_stream_id(u64::MAX / 2, Some(u64::MAX / 3), Some(u64::MAX / 5));
    let partition_overflow = PartitionTester::get_partition_index(&stream_id_overflow);
    assert!(
      partition_overflow < SEND_STREAM_PARTITION_COUNT,
      "Partition index should be within bounds for overflow-prone values"
    );
  }

  #[test]
  fn test_get_partition_index_distribution_quality() {
    let mut distribution = [0; SEND_STREAM_PARTITION_COUNT];
    let test_count = 1000usize;

    // Test distribution quality for fetch streams
    for i in 0..test_count {
      let stream_id = create_fetch_stream_id((i % 10) as u64, i as u64);
      let partition = PartitionTester::get_partition_index(&stream_id);
      distribution[partition] += 1;
    }

    // Check that distribution is reasonably even (no partition should be empty or overly full)
    let expected_per_partition = test_count / SEND_STREAM_PARTITION_COUNT;
    let tolerance = expected_per_partition / 2; // Allow 50% deviation

    for (i, &count) in distribution.iter().enumerate() {
      assert!(
        count > 0,
        "Partition {} should have at least one entry for good distribution",
        i
      );
      assert!(
        count < expected_per_partition + tolerance,
        "Partition {} has too many entries ({}), expected around {}",
        i,
        count,
        expected_per_partition
      );
      // print the distribution
      println!("Partition {}: {}", i, count);
    }
  }

  #[test]
  fn test_get_partition_index_subgroup_distribution_quality() {
    let mut distribution = [0; SEND_STREAM_PARTITION_COUNT];
    let test_count = 1000usize;

    // Test distribution quality for subgroup streams
    for i in 0..test_count {
      let stream_id = create_subgroup_stream_id(
        (i % 10) as u64,       // track_alias
        Some((i / 10) as u64), // group_id
        Some((i % 5) as u64),  // subgroup_id
      );
      let partition = PartitionTester::get_partition_index(&stream_id);
      distribution[partition] += 1;
    }

    // Check that distribution is reasonably even
    let expected_per_partition = test_count / SEND_STREAM_PARTITION_COUNT;
    let tolerance = expected_per_partition / 2; // Allow 50% deviation

    for (i, &count) in distribution.iter().enumerate() {
      assert!(
        count > 0,
        "Partition {} should have at least one entry for good distribution",
        i
      );
      assert!(
        count < expected_per_partition + tolerance,
        "Partition {} has too many entries ({}), expected around {}",
        i,
        count,
        expected_per_partition
      );
      // print out the distribution
      println!("Partition {}: {}", i, count);
    }
  }

  #[test]
  fn test_get_partition_index_different_stream_types() {
    // Test that fetch and subgroup streams with similar parameters can have different partitions
    let fetch_stream = create_fetch_stream_id(100, 50);
    let subgroup_stream = create_subgroup_stream_id(100, Some(50), Some(0));

    let fetch_partition = PartitionTester::get_partition_index(&fetch_stream);
    let subgroup_partition = PartitionTester::get_partition_index(&subgroup_stream);

    // Both should be within bounds
    assert!(fetch_partition < SEND_STREAM_PARTITION_COUNT);
    assert!(subgroup_partition < SEND_STREAM_PARTITION_COUNT);

    // They should potentially be different (though not guaranteed due to hashing)
    // This test mainly ensures both algorithms work correctly
  }

  #[test]
  fn test_get_partition_index_deterministic() {
    let test_cases = vec![
      create_fetch_stream_id(42, 123),
      create_subgroup_stream_id(42, Some(123), Some(456)),
      create_subgroup_stream_id(0, None, None),
      create_fetch_stream_id(u64::MAX, 0),
    ];

    for stream_id in test_cases {
      let partition1 = PartitionTester::get_partition_index(&stream_id);
      let partition2 = PartitionTester::get_partition_index(&stream_id);
      assert_eq!(
        partition1, partition2,
        "Multiple calls should produce same partition for same stream_id"
      );
    }
  }
}

/// M21: `write_stream_object` reports what QUIC accepted. Over a real loopback
/// connection, so the failures are the ones the relay meets in a run.
#[cfg(test)]
mod tests_write_stream_object {
  use super::*;
  use crate::server::test_support::{quic_pair, relay_client, wait_until};

  fn header() -> Bytes {
    Bytes::from_static(b"hdr")
  }

  #[tokio::test]
  async fn write_to_an_open_stream_succeeds() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(1, server);
    let stream_id = StreamId::new_subgroup(1, 0, Some(0));
    let stream = client.open_stream(&stream_id, header(), 0).await.unwrap();
    client
      .write_stream_object(&stream_id, 0, Bytes::from_static(b"obj0"), Some(stream))
      .await
      .expect("a write to an open stream is accepted");
  }

  /// There was a comment saying a missing stream "is not an error"; it is one, or
  /// OBJECT_SENT.sent reads true for an object that went nowhere.
  #[tokio::test]
  async fn write_to_an_unknown_stream_is_an_error() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(1, server);
    let stream_id = StreamId::new_subgroup(1, 42, Some(0));
    let res = client
      .write_stream_object(&stream_id, 0, Bytes::from_static(b"obj0"), None)
      .await;
    assert!(res.is_err(), "no stream was opened for this id");
  }

  /// The peer's STOP_SENDING used to be logged and reported as Ok.
  #[tokio::test]
  async fn write_after_the_peer_stops_the_stream_is_an_error_and_drops_the_stream() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(1, server);
    let stream_id = StreamId::new_subgroup(1, 0, Some(0));
    let stream = client.open_stream(&stream_id, header(), 0).await.unwrap();
    client
      .write_stream_object(
        &stream_id,
        0,
        Bytes::from_static(b"obj0"),
        Some(stream.clone()),
      )
      .await
      .unwrap();

    let recv = peer.accept_uni().await.expect("peer sees the stream");
    recv.stop(0x10);

    // STOP_SENDING takes a round trip to land; until then writes are buffered.
    let failed = wait_until(Duration::from_secs(5), || {
      let client = client.clone();
      let stream = stream.clone();
      let stream_id = stream_id.clone();
      async move {
        client
          .write_stream_object(&stream_id, 1, Bytes::from_static(b"obj1"), Some(stream))
          .await
          .is_err()
      }
    })
    .await;
    assert!(
      failed,
      "a write after STOP_SENDING must be reported as an error"
    );
    assert!(
      client.get_stream(&stream_id).await.is_none(),
      "a stopped stream is dropped from the send-stream map"
    );
  }

  /// R3-D6: a data stream carries its priority from the moment it is opened.
  #[tokio::test]
  async fn a_data_stream_is_opened_at_its_priority() {
    let (_peer, server) = quic_pair().await;
    let client = relay_client(1, server);
    let stream_id = StreamId::new_subgroup(1, 0, Some(0));
    let stream = client
      .open_stream(&stream_id, header(), 123_456)
      .await
      .unwrap();
    assert_eq!(stream.lock().await.priority(), Some(123_456));
  }

  /// Video bytes the subscriber had read when a response on its request stream
  /// reached it, with a 1 MB top-band video backlog queued ahead of the response.
  async fn video_read_before_response(
    accept: impl AsyncFnOnce(
      &TransportConnection,
    ) -> (
      TransportSendStream,
      moqtail::transport::connection::TransportRecvStream,
    ),
  ) -> usize {
    use crate::server::subscription::compute_stream_priority;
    use moqtail::model::control::constant::GroupOrder;
    use std::sync::atomic::{AtomicUsize, Ordering};
    const VIDEO_BYTES: usize = 1024 * 1024;
    let (peer, server) = quic_pair().await;
    let client = relay_client(1, server);

    let (mut request, mut response) = peer.open_bi().await.unwrap();
    request.write_all(b"SUBSCRIBE").await.unwrap();
    let (mut relay_send, _relay_recv) = accept(&client.connection).await;

    // No yield from here until both are queued: the backlog first, then the response.
    let stream_id = StreamId::new_subgroup(1, 7, Some(0));
    let video_priority = compute_stream_priority(0, 128, GroupOrder::Ascending, 7);
    let video = client
      .open_stream(&stream_id, header(), video_priority)
      .await
      .unwrap();
    video
      .lock()
      .await
      .write_all(&vec![1u8; VIDEO_BYTES])
      .await
      .unwrap();
    relay_send.write_all(b"SUBSCRIBE_OK").await.unwrap();

    let video_read = Arc::new(AtomicUsize::new(0));
    let reader = {
      let video_read = video_read.clone();
      tokio::spawn(async move {
        let mut recv = peer.accept_uni().await.unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(Some(n)) = recv.read(&mut buf).await {
          if video_read.fetch_add(n, Ordering::SeqCst) + n >= VIDEO_BYTES {
            break;
          }
        }
        peer
      })
    };
    let mut buf = [0u8; 12];
    let mut got = 0;
    while got < buf.len() {
      got += response.read(&mut buf[got..]).await.unwrap().unwrap();
    }
    let at_response = video_read.load(Ordering::SeqCst);
    assert_eq!(&buf, b"SUBSCRIBE_OK");
    let _ = tokio::time::timeout(Duration::from_secs(10), reader).await;
    at_response
  }

  /// R3-D2: a response on a request stream the relay accepted goes ahead of video,
  /// so a SWITCH's SUBSCRIBE_OK cannot arrive after the target's data (which the
  /// client discards as unrouted). quinn's default stream priority is 0, below the
  /// whole band a priority-0 subscriber's video sits in.
  #[tokio::test]
  async fn a_request_stream_response_is_not_queued_behind_video() {
    let read = video_read_before_response(async |conn: &TransportConnection| {
      conn.accept_request_stream().await.unwrap()
    })
    .await;
    assert!(
      read < 256 * 1024,
      "the response arrived after {read} B of video"
    );
  }

  /// R3-D5: opening a stream can wait for the subscriber to grant stream credit.
  /// Meanwhile no partition lock is held, so the other streams of that partition
  /// can still be found and written.
  #[tokio::test]
  async fn a_stream_waiting_for_credit_does_not_block_its_partition() {
    let mut subscriber_transport = wtransport::quinn::TransportConfig::default();
    subscriber_transport.max_concurrent_uni_streams(1u32.into());
    let (peer, server) =
      crate::server::test_support::quic_pair_with_transports(None, Some(subscriber_transport))
        .await;
    let client = relay_client(1, server);
    let a = StreamId::new_subgroup(1, 0, Some(0));
    let partition = client.get_partition_index(&a);
    let b = (1..10_000u64)
      .map(|g| StreamId::new_subgroup(1, g, Some(0)))
      .find(|id| client.get_partition_index(id) == partition)
      .expect("a stream id in the same partition");

    client.open_stream(&a, header(), 0).await.unwrap();
    let opener = {
      let client = client.clone();
      let b = b.clone();
      tokio::spawn(async move { client.open_stream(&b, header(), 0).await.is_ok() })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!opener.is_finished(), "b waits for credit (one uni stream)");

    let found = tokio::time::timeout(Duration::from_secs(1), client.get_stream(&a)).await;
    assert!(
      matches!(found, Ok(Some(_))),
      "the partition is blocked while b waits for credit"
    );
    let written = tokio::time::timeout(
      Duration::from_secs(1),
      client.write_stream_object(&a, 0, Bytes::from_static(b"obj0"), None),
    )
    .await;
    assert!(matches!(written, Ok(Ok(()))));

    // Credit comes back once a's stream is done; b then opens.
    let mut recv = peer.accept_uni().await.unwrap();
    assert!(client.close_stream(&a).await.unwrap());
    let mut buf = [0u8; 64];
    while let Ok(Some(_)) = recv.read(&mut buf).await {}
    assert!(
      tokio::time::timeout(Duration::from_secs(5), opener)
        .await
        .expect("b opens once credit returns")
        .unwrap()
    );
  }

  /// The whole connection going away is reported too (ConnectionLost).
  #[tokio::test]
  async fn write_after_the_connection_closed_is_an_error() {
    let (peer, server) = quic_pair().await;
    let client = relay_client(1, server);
    let stream_id = StreamId::new_subgroup(1, 0, Some(0));
    let stream = client.open_stream(&stream_id, header(), 0).await.unwrap();
    peer.close(0, b"bye");
    let failed = wait_until(Duration::from_secs(5), || {
      let client = client.clone();
      let stream = stream.clone();
      let stream_id = stream_id.clone();
      async move {
        client
          .write_stream_object(&stream_id, 1, Bytes::from_static(b"obj1"), Some(stream))
          .await
          .is_err()
      }
    })
    .await;
    assert!(
      failed,
      "a write after the connection closed must be an error"
    );
  }
}
