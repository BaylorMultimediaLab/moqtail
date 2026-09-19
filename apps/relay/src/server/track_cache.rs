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

use moka::future::Cache;
use moka::notification::RemovalCause;
use moqtail::model::data::fetch_object::FetchObjectPayload;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tracing::{error, info, trace};

use super::config::{AppConfig, CacheExpirationType};
use super::events;

/// Composite cache key combining relay_track_id and group_id for global uniqueness
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheKey {
  pub relay_track_id: u64,
  pub group_id: u64,
}

impl CacheKey {
  /// Create a new cache key
  pub fn new(relay_track_id: u64, group_id: u64) -> Self {
    Self {
      relay_track_id,
      group_id,
    }
  }
}

impl std::fmt::Display for CacheKey {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "track:{}_group:{}", self.relay_track_id, self.group_id)
  }
}

// Type alias for the cached value (group objects)
type GroupObjects = Arc<RwLock<Vec<FetchObjectPayload>>>;

#[derive(Debug, Clone)]
pub struct TrackCache {
  pub relay_track_id: u64,
  // Moka cache for storing groups of objects with composite keys
  cache: Cache<CacheKey, GroupObjects>,
  #[allow(dead_code)] // Used in eviction listener closure
  log_folder: String,
  /// Payload bytes currently held for this track (sum over cached groups).
  /// Maintained at insert and eviction so the experiment log can report the
  /// memory cost of caching several representations.
  bytes: Arc<AtomicU64>,
}

/// Snapshot of one track cache for the experiment event log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheStats {
  pub groups: u64,
  pub bytes: u64,
  pub oldest_group: Option<u64>,
  pub newest_group: Option<u64>,
}

impl TrackCache {
  pub fn new(relay_track_id: u64, cache_size: usize, config: &AppConfig) -> Self {
    let log_folder = config.log_folder.clone();
    let log_folder_for_listener = log_folder.clone();
    let bytes = Arc::new(AtomicU64::new(0));
    let bytes_for_listener = bytes.clone();

    let cache_builder = Cache::builder()
      .max_capacity(cache_size as u64)
      .eviction_listener(move |key: Arc<CacheKey>, value: GroupObjects, cause| {
        let relay_track_id = key.relay_track_id;
        let group_id = key.group_id;
        let log_folder = log_folder_for_listener.clone();
        let bytes = bytes_for_listener.clone();

        tokio::spawn(async move {
          let (object_count, group_bytes) = {
            let objects = value.read().await;
            let b: u64 = objects.iter().map(|o| o.payload.len() as u64).sum();
            (objects.len(), b)
          };
          bytes.fetch_sub(
            group_bytes.min(bytes.load(Ordering::Relaxed)),
            Ordering::Relaxed,
          );
          events::emit(
            "CACHE_EVICT",
            serde_json::json!({
              "relay_track_id": relay_track_id,
              "group": group_id,
              "objects": object_count,
              "bytes": group_bytes,
              "cause": format!("{cause:?}"),
            }),
          );
          Self::log_cache_eviction(log_folder, relay_track_id, group_id, object_count, cause).await;
        });
      });

    // Configure expiration based on config
    let cache = match config.cache_expiration_type {
      CacheExpirationType::Ttl => {
        info!(
          "track_cache::new | configuring TTL cache | track: {} duration: {}min",
          relay_track_id, config.cache_expiration_minutes
        );
        cache_builder
          .time_to_live(config.get_cache_expiration_duration())
          .build()
      }
      CacheExpirationType::Tti => {
        info!(
          "track_cache::new | configuring TTI cache | track: {} duration: {}min",
          relay_track_id, config.cache_expiration_minutes
        );
        cache_builder
          .time_to_idle(config.get_cache_expiration_duration())
          .build()
      }
    };

    Self {
      relay_track_id,
      cache,
      log_folder,
      bytes,
    }
  }

  /// Groups, payload bytes and group-id bounds currently cached for this track.
  pub async fn stats(&self) -> CacheStats {
    let mut oldest = None;
    let mut newest = None;
    for (k, _) in self.cache.iter() {
      if k.relay_track_id != self.relay_track_id {
        continue;
      }
      oldest = Some(oldest.map_or(k.group_id, |o: u64| o.min(k.group_id)));
      newest = Some(newest.map_or(k.group_id, |n: u64| n.max(k.group_id)));
    }
    CacheStats {
      groups: self.cache.entry_count(),
      bytes: self.bytes.load(Ordering::Relaxed),
      oldest_group: oldest,
      newest_group: newest,
    }
  }

  /// Log cache eviction events to cache_eviction.log
  async fn log_cache_eviction(
    log_folder: String,
    relay_track_id: u64,
    group_id: u64,
    object_count: usize,
    cause: RemovalCause,
  ) {
    let log_filename = "cache_eviction.log";
    let log_path = std::path::Path::new(&log_folder).join(log_filename);

    let cause_str = match cause {
      RemovalCause::Size => "SIZE",
      RemovalCause::Expired => "EXPIRED",
      RemovalCause::Explicit => "EXPLICIT",
      RemovalCause::Replaced => "REPLACED",
    };

    let log_entry = format!(
      "{},{},{},{}\n",
      relay_track_id, group_id, object_count, cause_str
    );

    // Create logs directory if it doesn't exist
    if let Err(e) = tokio::fs::create_dir_all(&log_folder).await {
      error!("Failed to create log directory {}: {:?}", log_folder, e);
      return;
    }

    // Append to log file
    match OpenOptions::new()
      .create(true)
      .append(true)
      .open(&log_path)
      .await
    {
      Ok(mut file) => {
        if let Err(e) = file.write_all(log_entry.as_bytes()).await {
          error!(
            "Failed to write to cache eviction log file {:?}: {:?}",
            log_path, e
          );
        }
      }
      Err(e) => {
        error!(
          "Failed to open cache eviction log file {:?}: {:?}",
          log_path, e
        );
      }
    }
  }

  pub async fn add_object(&self, object: FetchObjectPayload) {
    let cache_key = CacheKey::new(self.relay_track_id, object.group_id);
    self
      .bytes
      .fetch_add(object.payload.len() as u64, Ordering::Relaxed);

    // Check if group already exists in cache
    if let Some(existing_objects) = self.cache.get(&cache_key).await {
      // Add object to existing group
      let mut objects = existing_objects.write().await;
      objects.push(object.clone());
      trace!(
        "track_cache::add_object | added object to existing group | track: {} group: {} object_id: {} total_objects: {}",
        self.relay_track_id,
        object.group_id,
        object.object_id,
        objects.len()
      );
    } else {
      // Create new group with this object
      let new_group_objects = Arc::new(RwLock::new(vec![object.clone()]));
      self.cache.insert(cache_key, new_group_objects).await;
      trace!(
        "track_cache::add_object | created new group | track: {} group: {} object_id: {}",
        self.relay_track_id, object.group_id, object.object_id
      );
    }
  }

  /// Get cache statistics (for monitoring/debugging)
  #[allow(dead_code)]
  pub async fn get_cache_stats(&self) -> (u64, u64) {
    (self.cache.entry_count(), self.cache.weighted_size())
  }

  /// Manually run pending tasks (for testing or maintenance)
  #[allow(dead_code)]
  pub async fn run_pending_tasks(&self) {
    self.cache.run_pending_tasks().await;
  }

  /// Get a specific group if it exists
  #[allow(dead_code)]
  pub async fn get_group(&self, group_id: u64) -> Option<GroupObjects> {
    let cache_key = CacheKey::new(self.relay_track_id, group_id);
    self.cache.get(&cache_key).await
  }

  /// Check if a group exists in cache
  #[allow(dead_code)]
  pub async fn contains_group(&self, group_id: u64) -> bool {
    let cache_key = CacheKey::new(self.relay_track_id, group_id);
    self.cache.contains_key(&cache_key)
  }

  /// Returns the smallest group_id currently in the cache, or None if empty.
  /// Used by the SUBSCRIBE handler to clamp delay-mode start_locations to the
  /// oldest available group when the requested target predates the cache window.
  #[allow(dead_code)]
  pub async fn oldest_group_id(&self) -> Option<u64> {
    self
      .cache
      .iter()
      .filter(|(k, _)| k.relay_track_id == self.relay_track_id)
      .map(|(k, _)| k.group_id)
      .min()
  }

  /// Returns the largest group_id currently in the cache for this track,
  /// or None if empty. Mirror of `oldest_group_id`.
  ///
  /// Used by the SUBSCRIBE/replay path: when a delay-mode subscribe has no
  /// prior `last_received_object_location` (initial subscribe), this gives
  /// the upper bound for cache replay so the subscriber receives objects in
  /// the range [start_location, newest_group_id] before live forwarding takes
  /// over.
  #[allow(dead_code)]
  pub async fn newest_group_id(&self) -> Option<u64> {
    self
      .cache
      .iter()
      .filter(|(k, _)| k.relay_track_id == self.relay_track_id)
      .map(|(k, _)| k.group_id)
      .max()
  }
}

#[cfg(test)]
mod tests_group_bounds {
  use super::*;
  use crate::server::config::CacheExpirationType;
  use bytes::Bytes;
  use moqtail::model::data::constant::ObjectForwardingPreference;
  use std::time::Duration;

  fn test_config() -> AppConfig {
    AppConfig {
      port: 0,
      host: String::new(),
      cert_file: String::new(),
      key_file: String::new(),
      max_idle_timeout: 60,
      keep_alive_interval: 30,
      cache_size: 100,
      log_folder: String::new(),
      cache_expiration_type: CacheExpirationType::Ttl,
      cache_expiration_minutes: 30,
      enable_object_logging: false,
      enable_token_logging: false,
      token_log_path: String::new(),
      io_sockets: 1,
      max_request_streams: 10,
      max_active_requests: 0,
      max_subscriber_lag: 0,
      max_publish_streams: 0,
      write_kbps_limit: 0,
      redirect_uri: None,
      max_upstream_fetch_gaps: 10,
      upstream_fetch_timeout: Duration::from_secs(10),
      upstream_subscribe_timeout: Duration::from_secs(10),
      track_alias_resolution_timeout: Duration::from_millis(500),
      downstream_alias_timeout: Duration::from_millis(3000),
      publish_done_stream_timeout: Duration::from_millis(2000),
      dedup_retained_groups: 30,
      event_log: String::new(),
    }
  }

  fn fetch_object(group_id: u64, object_id: u64) -> FetchObjectPayload {
    FetchObjectPayload {
      group_id,
      subgroup_id: 0,
      object_id,
      publisher_priority: 0,
      forwarding_preference: ObjectForwardingPreference::Subgroup,
      properties: None,
      payload: Bytes::from_static(b"x"),
    }
  }

  #[tokio::test]
  async fn oldest_group_id_returns_none_when_empty() {
    let cfg = test_config();
    let cache = TrackCache::new(1, 100, &cfg);
    assert_eq!(cache.oldest_group_id().await, None);
    assert_eq!(cache.newest_group_id().await, None);
  }

  #[tokio::test]
  async fn oldest_and_newest_group_id_track_the_present_groups() {
    let cfg = test_config();
    let cache = TrackCache::new(1, 100, &cfg);
    cache.add_object(fetch_object(7, 0)).await;
    cache.add_object(fetch_object(5, 0)).await;
    cache.add_object(fetch_object(9, 0)).await;
    // moka inserts may be eventually-consistent; force pending tasks
    cache.run_pending_tasks().await;
    assert_eq!(cache.oldest_group_id().await, Some(5));
    assert_eq!(cache.newest_group_id().await, Some(9));
  }

  #[tokio::test]
  async fn stats_count_groups_and_payload_bytes() {
    let cfg = test_config();
    let cache = TrackCache::new(1, 100, &cfg);
    cache.add_object(fetch_object(3, 0)).await;
    cache.add_object(fetch_object(3, 1)).await;
    cache.add_object(fetch_object(4, 0)).await;
    cache.run_pending_tasks().await;
    let s = cache.stats().await;
    assert_eq!(s.groups, 2);
    assert_eq!(s.bytes, 3, "one byte per test payload");
    assert_eq!(s.oldest_group, Some(3));
    assert_eq!(s.newest_group, Some(4));
  }

  #[tokio::test]
  async fn group_bounds_handle_single_group() {
    let cfg = test_config();
    let cache = TrackCache::new(1, 100, &cfg);
    cache.add_object(fetch_object(42, 0)).await;
    cache.run_pending_tasks().await;
    assert_eq!(cache.oldest_group_id().await, Some(42));
    assert_eq!(cache.newest_group_id().await, Some(42));
  }
}
