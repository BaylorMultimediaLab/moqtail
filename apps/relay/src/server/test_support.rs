// Copyright 2026 The MOQtail Authors
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

//! Test fixtures shared by the relay's unit tests: a loopback QUIC connection
//! pair (self-signed, no verification), an `MOQTClient` wrapping the server end,
//! a process-wide `AppConfig` built from the CLI defaults, a track fed the way a
//! publisher's ingest feeds it, and a peer-side collector that parses every data
//! stream the relay opens.
//!
//! The pair is real quinn on 127.0.0.1, so tests that need a QUIC write to
//! succeed or fail (M21), a stream to be opened, or a subscription task to run
//! (replay/live overlap, promotion) exercise the production path end to end.

use super::client::MOQTClient;
use super::config::{AppConfig, Cli};
use super::subscription::{Subscription, SubscriptionOrigin};
use super::track::{Track, TrackOrigin, TrackStatus};
use super::utils::build_stream_id;
use bytes::Bytes;
use clap::Parser;
use moqtail::model::common::tuple::{Tuple, TupleField};
use moqtail::model::control::setup::Setup;
use moqtail::model::data::constant::DEFAULT_PUBLISHER_PRIORITY;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::transport::connection::TransportConnection;
use moqtail::transport::data_stream_handler::{HeaderInfo, RecvDataStream};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::sync::RwLock;
use wtransport::quinn;

const TEST_ALPN: &[u8] = b"test-moqt";

/// A connected (client, server) pair of raw QUIC connections on the loopback.
pub(crate) async fn quic_pair() -> (TransportConnection, TransportConnection) {
  quic_pair_with_server_transport(None).await
}

/// As `quic_pair`, with the server end running on `transport` (e.g. the relay's own
/// `AppConfig::transport_config`).
pub(crate) async fn quic_pair_with_server_transport(
  transport: Option<quinn::TransportConfig>,
) -> (TransportConnection, TransportConnection) {
  let server_identity =
    wtransport::Identity::self_signed(std::iter::once("localhost")).expect("self-signed identity");

  let mut server_tls = wtransport::tls::server::build_default_tls_config(server_identity);
  server_tls.alpn_protocols = vec![TEST_ALPN.to_vec()];
  let quic_server_config =
    quinn::crypto::rustls::QuicServerConfig::try_from(server_tls).expect("server crypto");
  let mut server_config = quinn::ServerConfig::with_crypto(Arc::new(quic_server_config));
  if let Some(transport) = transport {
    server_config.transport_config(Arc::new(transport));
  }
  let server_endpoint = quinn::Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap())
    .expect("server endpoint");
  let server_addr = server_endpoint.local_addr().unwrap();

  let (tx, rx) = tokio::sync::oneshot::channel();
  tokio::spawn(async move {
    let incoming = server_endpoint.accept().await.expect("incoming");
    let connection = incoming.await.expect("connection");
    let _ = tx.send((connection, server_endpoint));
  });

  let mut client_tls = wtransport::tls::client::build_default_tls_config(
    Arc::new(wtransport::tls::rustls::RootCertStore::empty()),
    Some(Arc::new(
      wtransport::tls::client::NoServerVerification::new(),
    )),
  );
  client_tls.alpn_protocols = vec![TEST_ALPN.to_vec()];
  let quic_client_config =
    quinn::crypto::rustls::QuicClientConfig::try_from(client_tls).expect("client crypto");
  let client_config = quinn::ClientConfig::new(Arc::new(quic_client_config));

  let client_endpoint =
    quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).expect("client endpoint");
  let client = client_endpoint
    .connect_with(client_config, server_addr, "localhost")
    .expect("connect")
    .await
    .expect("handshake");

  let (server, server_endpoint) = rx.await.expect("server side");
  // Keep the endpoints alive for as long as the connections are; dropping an
  // Endpoint closes its connections.
  std::mem::forget(client_endpoint);
  std::mem::forget(server_endpoint);

  (
    TransportConnection::Quic(client),
    TransportConnection::Quic(server),
  )
}

/// An `MOQTClient` the relay would hold for the peer at the other end of `server`.
pub(crate) fn relay_client(connection_id: usize, server: TransportConnection) -> Arc<MOQTClient> {
  Arc::new(MOQTClient::new(
    connection_id,
    Arc::new(server),
    Arc::new(Setup::new(vec![])),
    0,
  ))
}

/// Polls `check` every few milliseconds until it returns true or `timeout` passes.
pub(crate) async fn wait_until<F, Fut>(timeout: Duration, mut check: F) -> bool
where
  F: FnMut() -> Fut,
  Fut: std::future::Future<Output = bool>,
{
  let deadline = tokio::time::Instant::now() + timeout;
  loop {
    if check().await {
      return true;
    }
    if tokio::time::Instant::now() >= deadline {
      return false;
    }
    tokio::time::sleep(Duration::from_millis(5)).await;
  }
}

/// The relay's configuration with every CLI default, shared by all tests.
pub(crate) fn test_config() -> &'static AppConfig {
  static CONFIG: OnceLock<AppConfig> = OnceLock::new();
  CONFIG.get_or_init(|| AppConfig::from_cli(Cli::parse_from(["relay"])))
}

pub(crate) const TEST_NAMESPACE: &str = "/moqtail";
/// Publisher priority the test publisher writes in its subgroup headers.
pub(crate) const TEST_PUBLISHER_PRIORITY: u8 = 128;

pub(crate) fn full_track_name(track: &str) -> FullTrackName {
  FullTrackName {
    namespace: Tuple::from_utf8_path(TEST_NAMESPACE),
    name: TupleField::from_utf8(track),
  }
}

/// A confirmed track whose objects arrive through `publish`, as a publisher's
/// PUBLISH would set it up.
pub(crate) fn test_track(relay_track_id: u64, track: &str) -> Track {
  Track::new(
    relay_track_id,
    full_track_name(track),
    test_config(),
    TrackStatus::Confirmed {
      upstream_parameters: vec![],
    },
    TrackOrigin::Publish,
  )
}

/// Ingests one object the way the session's uni-stream reader does: one subgroup
/// (0) per group, the header travelling with object 0. Fans out to the track's
/// subscriptions, then caches.
pub(crate) async fn publish(track: &Track, group: u64, object: u64) {
  let header = HeaderInfo::Subgroup {
    header: SubgroupHeader::new_with_explicit_id(
      track.relay_track_id,
      group,
      0,
      Some(TEST_PUBLISHER_PRIORITY),
      false,
      true,
      true,
    ),
  };
  let stream_id = build_stream_id(track.relay_track_id, &header);
  let payload = Bytes::from(format!("{}:{group}:{object}", track.relay_track_id));
  let object_model = Object::try_from_subgroup(
    SubgroupObject {
      object_id: object,
      properties: None,
      object_status: None,
      payload: Some(payload),
    },
    track.relay_track_id,
    group,
    Some(0),
    Some(TEST_PUBLISHER_PRIORITY),
    DEFAULT_PUBLISHER_PRIORITY,
  )
  .expect("object");
  track
    .new_subgroup_object(&stream_id, &object_model, (object == 0).then_some(&header))
    .await
    .expect("ingest");
}

/// Adds `client`'s subscription to `track` and registers it with the client, as
/// the SUBSCRIBE handler does. Forwarding stays held until the test calls
/// `mark_alias_announced`.
pub(crate) async fn subscribe(
  track: &Track,
  client: &Arc<MOQTClient>,
  origin: impl Into<SubscriptionOrigin>,
  is_switch: bool,
) -> Arc<RwLock<Subscription>> {
  let subscription = track
    .add_subscription(client.clone(), origin, is_switch)
    .await
    .expect("subscription");
  client
    .subscriptions
    .add_subscription(track.full_track_name.clone(), Arc::downgrade(&subscription))
    .await;
  subscription
}

/// One object as the subscriber parsed it off a data stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Delivered {
  /// Order in which the subscriber accepted the stream (0 = first).
  pub stream: usize,
  pub track_alias: u64,
  pub group: u64,
  pub object: u64,
}

/// Everything the subscriber end of a `quic_pair` receives on uni streams.
#[derive(Clone, Default)]
pub(crate) struct Received(Arc<StdMutex<Vec<Delivered>>>);

impl Received {
  pub fn all(&self) -> Vec<Delivered> {
    self.0.lock().unwrap().clone()
  }

  /// (group, object) of every object of one track, in arrival order per stream.
  pub fn objects(&self, track_alias: u64) -> Vec<(u64, u64)> {
    let mut v: Vec<Delivered> = self
      .all()
      .into_iter()
      .filter(|d| d.track_alias == track_alias)
      .collect();
    v.sort_by_key(|d| (d.stream, d.group, d.object));
    v.into_iter().map(|d| (d.group, d.object)).collect()
  }

  /// Number of distinct streams that carried objects of `group` on one track.
  pub fn streams_for(&self, track_alias: u64, group: u64) -> usize {
    let mut streams: Vec<usize> = self
      .all()
      .into_iter()
      .filter(|d| d.track_alias == track_alias && d.group == group)
      .map(|d| d.stream)
      .collect();
    streams.sort_unstable();
    streams.dedup();
    streams.len()
  }

  /// Times each (group, object) of one track was delivered.
  pub fn counts(&self, track_alias: u64) -> BTreeMap<(u64, u64), usize> {
    let mut counts = BTreeMap::new();
    for loc in self.objects(track_alias) {
      *counts.entry(loc).or_insert(0) += 1;
    }
    counts
  }
}

/// Accepts every uni stream `peer` is sent and parses it with the library's
/// receive path, recording each object.
pub(crate) fn collect_streams(peer: TransportConnection) -> Received {
  let received = Received::default();
  let sink = received.clone();
  tokio::spawn(async move {
    let mut index = 0usize;
    while let Ok(recv) = peer.accept_uni().await {
      let stream = index;
      index += 1;
      let sink = sink.clone();
      tokio::spawn(async move {
        let data = RecvDataStream::new(recv, Arc::new(RwLock::new(BTreeMap::new())));
        loop {
          let (_, object) = data.next_object().await;
          let Some(object) = object else { break };
          sink.0.lock().unwrap().push(Delivered {
            stream,
            track_alias: object.track_alias,
            group: object.location.group,
            object: object.location.object,
          });
        }
      });
    }
  });
  received
}
