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
//! and a leaked `AppConfig` built from the CLI defaults.
//!
//! The pair is real quinn on 127.0.0.1, so tests that need a QUIC write to
//! succeed or fail (M21), a stream to be opened, or a subscription task to run
//! (replay/live overlap, promotion) exercise the production path end to end.

use super::client::MOQTClient;
use moqtail::model::control::setup::Setup;
use moqtail::transport::connection::TransportConnection;
use std::sync::Arc;
use std::time::Duration;
use wtransport::quinn;

const TEST_ALPN: &[u8] = b"test-moqt";

/// A connected (client, server) pair of raw QUIC connections on the loopback.
pub(crate) async fn quic_pair() -> (TransportConnection, TransportConnection) {
  let server_identity =
    wtransport::Identity::self_signed(std::iter::once("localhost")).expect("self-signed identity");

  let mut server_tls = wtransport::tls::server::build_default_tls_config(server_identity);
  server_tls.alpn_protocols = vec![TEST_ALPN.to_vec()];
  let quic_server_config =
    quinn::crypto::rustls::QuicServerConfig::try_from(server_tls).expect("server crypto");
  let server_config = quinn::ServerConfig::with_crypto(Arc::new(quic_server_config));
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
