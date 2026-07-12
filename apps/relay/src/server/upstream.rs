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

//! Outbound upstream relay link (relay chaining).
//!
//! When `--upstream-url` is configured, this relay dials the upstream relay as
//! a MoQ client (client-side SETUP over a bidirectional control stream it
//! opens) and then runs the ordinary session machinery over the connection:
//! the same control-message loop, outbound message queue, and data-plane
//! ingest that serve inbound peers. The link's `MOQTClient` is registered in
//! the `ClientManager` and marked as the upstream, making it the
//! publisher-of-last-resort: SUBSCRIBE and SWITCH resolution fall back to it
//! when no connected publisher supplies a requested track, so upstream
//! subscriptions are established lazily, per demand — nothing is fanned out
//! ahead of need.
//!
//! From the upstream relay's perspective this link is an ordinary subscriber
//! client; chains of any depth compose by each hop pointing `--upstream-url`
//! at the next.
//!
//! The link reconnects with a fixed backoff when it drops; in-flight
//! subscriptions do not survive the drop (downstream subscribers see the
//! publisher-disconnected teardown, exactly as with a directly connected
//! publisher).

use std::sync::Arc;
use std::time::Duration;

use moqtail::model::control::client_setup::ClientSetup;
use moqtail::model::control::constant;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::parameter::setup_parameter::SetupParameter;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use tokio::time::sleep;
use tracing::{error, info, warn};
use wtransport::{ClientConfig, Endpoint};

use crate::server::Server;
use crate::server::client::MOQTClient;
use crate::server::session::Session;
use crate::server::session_context::{RequestMaps, SessionContext};

/// Backoff between (re)connection attempts to the upstream relay.
const UPSTREAM_RETRY: Duration = Duration::from_secs(2);

/// Maintains the upstream link for the lifetime of the relay: connect, run
/// the session until it ends, back off, reconnect. Spawned once from
/// `Server::start` when `--upstream-url` is configured.
pub(crate) async fn run(server: Server) {
  let Some(url) = server.app_config.upstream_url.clone() else {
    return;
  };
  loop {
    match connect_and_run(&server, &url).await {
      Ok(()) => info!("upstream link to {url} closed"),
      Err(e) => warn!("upstream link to {url} failed: {e:?}"),
    }
    sleep(UPSTREAM_RETRY).await;
  }
}

/// One connection lifetime: dial, client-side SETUP, register as the upstream
/// publisher-of-last-resort, and drive the shared session loop until the
/// connection ends.
async fn connect_and_run(server: &Server, url: &str) -> anyhow::Result<()> {
  let builder = ClientConfig::builder().with_bind_default();
  let config = if server.app_config.upstream_no_cert_validation {
    builder
      .with_no_cert_validation()
      .keep_alive_interval(Some(Duration::from_secs(
        server.app_config.keep_alive_interval,
      )))
      .max_idle_timeout(Some(Duration::from_secs(server.app_config.max_idle_timeout)))?
      .build()
  } else {
    builder
      .with_native_certs()
      .keep_alive_interval(Some(Duration::from_secs(
        server.app_config.keep_alive_interval,
      )))
      .max_idle_timeout(Some(Duration::from_secs(server.app_config.max_idle_timeout)))?
      .build()
  };

  let connection = Endpoint::client(config)?.connect(url).await?;
  let (send, recv) = connection.open_bi().await?.await?;
  let mut control = ControlStreamHandler::new(send, recv);

  // Client-side SETUP: we are the client on this link. Grant the upstream the
  // same request-id budget we grant our own clients (it will push PUBLISH /
  // PUBLISH_DONE and answer with SubscribeOk ids from its own space).
  let max_request_id_param =
    SetupParameter::new_max_request_id(server.app_config.initial_max_request_id + 1)
      .try_into()
      .map_err(|e| anyhow::anyhow!("build max_request_id setup parameter: {e:?}"))?;
  let client_setup = ClientSetup::new(vec![constant::DRAFT_14], vec![max_request_id_param]);
  control
    .send_impl(&client_setup)
    .await
    .map_err(|e| anyhow::anyhow!("send ClientSetup upstream: {e:?}"))?;
  match control.next_message().await {
    Ok(ControlMessage::ServerSetup(s)) => {
      info!("upstream SETUP complete (version {:?})", s.selected_version);
    }
    Ok(other) => anyhow::bail!("expected ServerSetup from upstream, got {other:?}"),
    Err(e) => anyhow::bail!("upstream SETUP failed: {e:?}"),
  }

  let request_maps = RequestMaps {
    relay_fetch_requests: server.relay_fetch_requests.clone(),
    relay_subscribe_requests: server.relay_subscribe_requests.clone(),
    relay_track_status_requests: server.relay_track_status_requests.clone(),
  };
  let context = Arc::new(SessionContext::new(
    server.app_config,
    server.client_manager.clone(),
    server.track_manager.clone(),
    request_maps,
    connection,
    server.relay_next_request_id.clone(),
  ));

  // The upstream never sends us a ClientSetup (we are the client on this
  // link); MOQTClient stores one only for bookkeeping, so synthesize a
  // placeholder.
  let placeholder_setup = ClientSetup::new(vec![constant::DRAFT_14], vec![]);
  let client = Arc::new(MOQTClient::new(
    context.connection_id,
    Arc::new(context.connection.clone()),
    Arc::new(placeholder_setup),
  ));
  {
    let mut m = server.client_manager.write().await;
    m.add(client.clone()).await;
  }
  server
    .client_manager
    .read()
    .await
    .set_upstream(context.connection_id)
    .await;

  tokio::spawn(Session::handle_connection_close(context.clone()));

  info!(
    "upstream link established: {url} (connection {})",
    context.connection_id
  );
  let result = Session::run_session(context.clone(), client, control).await;

  // The session ended: drop the upstream marker so resolution stops routing
  // to a dead link (reconnection registers a fresh one).
  server
    .client_manager
    .read()
    .await
    .clear_upstream(context.connection_id)
    .await;

  if let Err(e) = result {
    error!("upstream session ended with error: {e:?}");
  }
  Ok(())
}
