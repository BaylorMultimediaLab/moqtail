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

//! MOQT (draft-18) session for the publisher.
//!
//! The control plane is a pair of unidirectional streams carrying only SETUP.
//! Every request (PUBLISH from us, FETCH/SUBSCRIBE from the relay) travels on
//! its own bidirectional request stream, and media goes out on unidirectional
//! subgroup streams. This mirrors `apps/client/src/{connection,publisher}.rs`.

use anyhow::{Context, Result};
use bytes::Bytes;
use moqtail::model::common::location::Location;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::common::tuple::{Tuple, TupleField};
use moqtail::model::control::constant::SUPPORTED_VERSIONS;
use moqtail::model::control::control_message::{ControlMessage, ControlMessageTrait};
use moqtail::model::control::publish::Publish;
use moqtail::model::control::request_error::RequestError;
use moqtail::model::control::request_ok::RequestOk;
use moqtail::model::control::setup::{Setup, SetupSender};
use moqtail::model::data::constant::DEFAULT_PUBLISHER_PRIORITY;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::model::error::{RequestErrorCode, TerminationCode};
use moqtail::model::parameter::message_parameter::MessageParameter;
use moqtail::model::parameter::setup_option::SetupOption;
use moqtail::transport::connection::TransportConnection;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use moqtail::transport::data_stream_handler::{HeaderInfo, SendDataStream};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};
use wtransport::endpoint::ConnectOptions;
use wtransport::quinn;
use wtransport::quinn::TransportConfig;
use wtransport::{ClientConfig, Endpoint, tls};

/// The MOQT versions this publisher offers (`wt-available-protocols` on
/// WebTransport, ALPN on raw QUIC).
pub const CLIENT_SUPPORTED_VERSIONS: &str = "moqt-18";

/// Publisher-side view of a MOQT session.
pub struct MoqConnection {
  /// Next client-initiated Request ID (draft-18: even, increasing by 2 per request).
  next_request_id: u64,
  pub connection: Arc<TransportConnection>,
  /// Held for the session's lifetime: closing the control stream is a
  /// protocol violation. Unused after SETUP.
  #[allow(dead_code)]
  control_stream: ControlStreamHandler,
  /// One reader task per PUBLISH request stream. Each holds its stream open
  /// (the publication lives as long as the stream) and drains whatever the
  /// relay sends back on it (REQUEST_UPDATE for Forward State, etc.).
  request_streams: Vec<JoinHandle<()>>,
  /// Accepts the relay's request streams (FETCH for a pushed track, ...).
  #[allow(dead_code)]
  request_acceptor: JoinHandle<()>,
}

impl Drop for MoqConnection {
  fn drop(&mut self) {
    for h in &self.request_streams {
      h.abort();
    }
    self.request_acceptor.abort();
  }
}

impl MoqConnection {
  /// Connects to `endpoint`, which is either an `https://` URL (WebTransport)
  /// or a `moqt://` URL (raw QUIC), and completes the SETUP exchange.
  pub async fn establish(endpoint: &str, validate_cert: bool) -> Result<Self> {
    let no_cert_validation = !validate_cert;
    let mut setup_options = Vec::new();

    let connection = if let Some(rest) = endpoint.strip_prefix("moqt://") {
      // Native QUIC has no HTTP CONNECT to carry the authority/path, so
      // CLIENT_SETUP carries them instead.
      let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], rest[idx..].to_string()),
        None => (rest, String::new()),
      };
      setup_options.push(
        SetupOption::new_authority(authority.to_string())
          .try_into()
          .unwrap(),
      );
      setup_options.push(SetupOption::new_path(path).try_into().unwrap());
      connect_quic(authority, no_cert_validation).await?
    } else {
      connect_webtransport(endpoint, no_cert_validation).await?
    };

    info!("Connected! Connection ID: {}", connection.stable_id());
    let connection = Arc::new(connection);

    // Open our half of the control plane and write CLIENT_SETUP first, then
    // accept the server's half.
    info!("Opening control stream and sending SETUP...");
    let mut send_stream = connection.open_uni().await?;
    let client_setup = Setup::new(setup_options);
    let setup_bytes = client_setup
      .serialize()
      .map_err(|e| anyhow::anyhow!("Failed to serialize CLIENT_SETUP: {e:?}"))?;
    send_stream
      .write_all(&setup_bytes)
      .await
      .map_err(|e| anyhow::anyhow!("Failed to send CLIENT_SETUP: {e:?}"))?;

    info!("Waiting for server control stream...");
    let recv_stream = connection.accept_uni().await?;
    let mut control_stream = ControlStreamHandler::new(send_stream, recv_stream);

    info!("Waiting for SETUP...");
    match control_stream.read_setup().await {
      Ok(m) => {
        if let Err(code) = m.validate_incoming(SetupSender::Server, connection.kind()) {
          anyhow::bail!("Server sent a client-only setup option: {:?}", code);
        }
        info!("SETUP received: {:?}", m);
      }
      Err(TerminationCode::VersionNegotiationFailed) => {
        anyhow::bail!(
          "Version negotiation failed: server does not support versions: {}",
          SUPPORTED_VERSIONS
        );
      }
      Err(TerminationCode::ProtocolViolation) => {
        anyhow::bail!("Server control stream did not begin with SETUP");
      }
      Err(e) => anyhow::bail!("Failed to receive SETUP: {:?}", e),
    };

    let request_acceptor = tokio::spawn(serve_request_streams(connection.clone()));

    Ok(MoqConnection {
      connection,
      control_stream,
      request_streams: Vec::new(),
      next_request_id: 0,
      request_acceptor,
    })
  }

  /// Publishes a track on the relay and waits for PUBLISH_OK (REQUEST_OK).
  /// Returns the track_alias that was registered. The request stream stays
  /// open for the session so the publication persists.
  pub async fn publish_track(
    &mut self,
    namespace: &str,
    track_name: &str,
    track_alias: u64,
  ) -> Result<u64> {
    let ns = Tuple::from_utf8_path(namespace);

    info!(
      "Publishing track: namespace={}, name={}, alias={}",
      namespace, track_name, track_alias
    );

    // Every request needs its own id even though the answer comes back on this
    // same request stream: the relay keys the publisher's registrations by it.
    let request_id = self.next_request_id;
    self.next_request_id += 2;
    let publish = Publish::new(
      request_id,
      ns,
      TupleField::from_utf8(track_name),
      track_alias,
      vec![
        MessageParameter::new_forward(true),
        MessageParameter::new_largest_object(Location::new(0, 0)),
      ],
      vec![],
    );

    let (send, recv) = self.connection.open_bi().await?;
    let mut request_stream = ControlStreamHandler::new(send, recv);
    request_stream
      .send(&ControlMessage::Publish(Box::new(publish)))
      .await
      .map_err(|e| anyhow::anyhow!("Failed to send PUBLISH: {:?}", e))?;

    match request_stream.next_message().await {
      Ok(ControlMessage::RequestOk(m)) => {
        m.validate_track_properties(false)
          .map_err(|_| anyhow::anyhow!("PUBLISH_OK carried Track Properties"))?;
        info!(
          "Track published: name={}, alias={}",
          track_name, track_alias
        );
      }
      Ok(ControlMessage::RequestError(e)) => {
        anyhow::bail!("PUBLISH rejected: {:?}", e);
      }
      Ok(m) => anyhow::bail!("Expected REQUEST_OK, got {:?}", m),
      Err(e) => anyhow::bail!("Failed waiting for REQUEST_OK: {:?}", e),
    }

    // Keep the request stream open and drain what the relay sends on it. A
    // relay may answer PUBLISH with Forward State 0 and raise it later with a
    // REQUEST_UPDATE; this publisher sends regardless (the relay caches and
    // forwards once anyone subscribes), so the update only needs to be read.
    let name = track_name.to_owned();
    self.request_streams.push(tokio::spawn(async move {
      loop {
        match request_stream.next_message().await {
          Ok(ControlMessage::RequestUpdate(u)) => {
            debug!("PUBLISH stream for {}: REQUEST_UPDATE {:?}", name, u);
          }
          Ok(m) => debug!("PUBLISH stream for {}: {:?}", name, m),
          Err(e) => {
            warn!("PUBLISH stream for {} ended: {:?}", name, e);
            break;
          }
        }
      }
    }));

    Ok(track_alias)
  }

  /// Sends `payload` as a single MoQ object on a new subgroup stream.
  /// `group_id` should increment each time the catalog is resent so that
  /// subscribers waiting for new objects will receive the latest catalog.
  pub async fn send_catalog_object(
    &self,
    track_alias: u64,
    group_id: u64,
    payload: Bytes,
  ) -> Result<()> {
    send_catalog_object_on_connection(&self.connection, track_alias, group_id, payload).await
  }

  /// Same as `send_catalog_object` but callable with just the raw connection
  /// (for use from background tasks that don't hold the full MoqConnection).
  pub async fn send_catalog_object_static(
    connection: &Arc<TransportConnection>,
    track_alias: u64,
    group_id: u64,
    payload: Bytes,
  ) -> Result<()> {
    send_catalog_object_on_connection(connection, track_alias, group_id, payload).await
  }
}

/// Accepts the relay's request streams for the session's lifetime. The only
/// request a relay sends a pushed-track publisher is FETCH (to backfill a
/// downstream FETCH); this publisher keeps no history, so it is rejected
/// promptly rather than left to time out on the relay side.
async fn serve_request_streams(connection: Arc<TransportConnection>) {
  loop {
    let (send, recv) = match connection.accept_bi().await {
      Ok(streams) => streams,
      Err(e) => {
        info!("Request stream accept ended: {:?}", e);
        break;
      }
    };
    tokio::spawn(async move {
      let mut request_stream = ControlStreamHandler::new(send, recv);
      match request_stream.next_message().await {
        Ok(ControlMessage::Fetch(m)) => {
          info!(
            "Rejecting FETCH {} from relay: this publisher keeps no history",
            m.request_id
          );
          let reason = ReasonPhrase::try_new("publisher keeps no history".to_string())
            .expect("reason within length limit");
          let err = RequestError::new(RequestErrorCode::NotSupported, 0, reason);
          if let Err(e) = request_stream.send_impl(&err).await {
            error!("Failed to send FETCH RequestError: {:?}", e);
          }
        }
        Ok(ControlMessage::TrackStatus(m)) => {
          info!("TRACK_STATUS from relay for {:?}", m.track_name);
          let ok = RequestOk::new(vec![]);
          if let Err(e) = request_stream.send_impl(&ok).await {
            error!("Failed to send TrackStatus RequestOk: {:?}", e);
          }
        }
        Ok(other) => {
          info!("Unexpected request from relay: {:?}", other);
          let reason =
            ReasonPhrase::try_new("not supported".to_string()).expect("reason within length limit");
          let err = RequestError::new(RequestErrorCode::NotSupported, 0, reason);
          let _ = request_stream.send_impl(&err).await;
        }
        Err(e) => info!("Request stream read error: {:?}", e),
      }
      drop(request_stream);
    });
  }
}

/// Inner implementation shared by `send_catalog_object` and `send_catalog_object_static`.
async fn send_catalog_object_on_connection(
  connection: &Arc<TransportConnection>,
  track_alias: u64,
  group_id: u64,
  payload: Bytes,
) -> Result<()> {
  let stream = connection
    .open_uni()
    .await
    .context("failed to open catalog uni stream")?;

  let header = SubgroupHeader::new_with_explicit_id(
    track_alias,
    group_id,
    0,       // subgroup_id
    Some(0), // publisher_priority (catalog is highest priority)
    false,   // no object properties
    true,    // end_of_group
    true,    // first_object: a fresh stream, object 0 is the first in it
  );
  let header_info = HeaderInfo::Subgroup { header };
  let stream = Arc::new(Mutex::new(stream));
  let mut handler = SendDataStream::new(stream, header_info)
    .await
    .context("failed to initialize catalog stream handler")?;

  let subgroup_object = SubgroupObject {
    object_id: 0,
    properties: None,
    object_status: None,
    payload: Some(payload),
  };
  let object = Object::try_from_subgroup(
    subgroup_object,
    track_alias,
    group_id,
    Some(0),
    Some(0),
    DEFAULT_PUBLISHER_PRIORITY,
  )
  .context("failed to build catalog object")?;

  handler
    .send_object(&object, None)
    .await
    .context("failed to write catalog object")?;
  handler
    .flush()
    .await
    .context("failed to flush catalog stream")?;
  handler
    .finish()
    .await
    .context("failed to finish catalog stream")?;

  info!(
    "Catalog object sent on alias={} group={}",
    track_alias, group_id
  );
  Ok(())
}

/// Connects over WebTransport (HTTP/3). MOQT version negotiation happens via
/// the `wt-available-protocols` header, not ALPN.
async fn connect_webtransport(
  server: &str,
  no_cert_validation: bool,
) -> Result<TransportConnection> {
  let c = ClientConfig::builder().with_bind_default();

  let tls_config = if no_cert_validation {
    tls::client::build_default_tls_config(
      Arc::new(tls::rustls::RootCertStore::empty()),
      Some(Arc::new(tls::client::NoServerVerification::new())),
    )
  } else {
    tls::client::build_default_tls_config(Arc::new(tls::build_native_cert_store()), None)
  };

  let transport_config = TransportConfig::default();
  let config = c
    .with_custom_tls_and_transport(tls_config, transport_config)
    .keep_alive_interval(Some(Duration::from_secs(3)))
    .max_idle_timeout(Some(Duration::from_secs(120)))
    .unwrap()
    .build();

  info!("Connecting via WebTransport to {}", server);
  let endpoint = Endpoint::client(config)?;
  let wt_available_protocols: Vec<String> = CLIENT_SUPPORTED_VERSIONS
    .split(',')
    .map(|s| format!("\"{}\"", s.trim()))
    .collect();
  let options = ConnectOptions::builder(server)
    .add_header("wt-available-protocols", wt_available_protocols.join(", "))
    .build();

  let connection = endpoint.connect(options).await?;
  Ok(TransportConnection::WebTransport(connection))
}

/// Connects over raw QUIC (`moqt://authority[/path]`). ALPN is the MOQT
/// version string itself, which is what the relay's ALPN demux routes on.
async fn connect_quic(authority: &str, no_cert_validation: bool) -> Result<TransportConnection> {
  let (host, port) = match authority.rsplit_once(':') {
    Some((host, port)) => (
      host,
      port
        .parse::<u16>()
        .map_err(|_| anyhow::anyhow!("invalid port in moqt:// authority: {}", authority))?,
    ),
    None => (authority, 443u16),
  };

  let mut tls_config = if no_cert_validation {
    tls::client::build_default_tls_config(
      Arc::new(tls::rustls::RootCertStore::empty()),
      Some(Arc::new(tls::client::NoServerVerification::new())),
    )
  } else {
    tls::client::build_default_tls_config(Arc::new(tls::build_native_cert_store()), None)
  };
  tls_config.alpn_protocols = CLIENT_SUPPORTED_VERSIONS
    .replace(' ', "")
    .split(',')
    .map(|version| version.as_bytes().to_vec())
    .collect();

  let quic_crypto_config = quinn::crypto::rustls::QuicClientConfig::try_from(tls_config)?;

  let mut transport_config = TransportConfig::default();
  transport_config.keep_alive_interval(Some(Duration::from_secs(3)));
  transport_config.max_idle_timeout(Some(Duration::from_secs(120).try_into()?));

  let mut client_config = quinn::ClientConfig::new(Arc::new(quic_crypto_config));
  client_config.transport_config(Arc::new(transport_config));

  let bind_addr: SocketAddr = if host.parse::<std::net::Ipv6Addr>().is_ok() {
    "[::]:0".parse()?
  } else {
    "0.0.0.0:0".parse()?
  };
  let endpoint = quinn::Endpoint::client(bind_addr)?;

  info!("Connecting via raw QUIC to {}:{}", host, port);
  let remote_addr = resolve_host_port(host, port).await?;
  let connection = endpoint
    .connect_with(client_config, remote_addr, host)?
    .await?;
  Ok(TransportConnection::Quic(connection))
}

async fn resolve_host_port(host: &str, port: u16) -> Result<SocketAddr> {
  if let Ok(ip) = host.parse::<IpAddr>() {
    return Ok(SocketAddr::new(ip, port));
  }
  tokio::net::lookup_host((host, port))
    .await?
    .next()
    .ok_or_else(|| anyhow::anyhow!("DNS resolution failed for host: {}", host))
}
