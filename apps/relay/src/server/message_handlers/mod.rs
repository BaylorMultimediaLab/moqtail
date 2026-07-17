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

use bytes::Bytes;
use moqtail::{
  model::{control::control_message::ControlMessage, error::TerminationCode},
  transport::control_stream_handler::ControlStreamHandler,
};
use tracing::{info, warn};

use crate::server::{client::MOQTClient, session_context::SessionContext};
use std::sync::{Arc, atomic::Ordering};
mod fetch_handler;
mod max_request_id_handler;
mod publish_handler;
mod publish_namespace_handler;
mod subscribe_handler;
mod subscribe_namespace_handler;
mod track_status_handler;
use super::utils;

/// Draft-14 request-id parity: client-initiated requests use EVEN request ids,
/// server-initiated ODD. `peer_is_server` is the role of the session's peer
/// (false for inbound sessions, true for the outbound upstream link). True =
/// the peer used an id from the wrong space — a protocol violation, and left
/// unchecked a collision hazard: this relay allocates its own request ids in
/// the odd space and keys shared request maps by id, so an off-parity peer id
/// can address relay-internal request state (e.g. the post-switch subscription
/// registered under a relay-allocated target request id).
pub(crate) fn request_id_parity_violation(peer_is_server: bool, request_id: u64) -> bool {
  let id_is_odd = request_id % 2 == 1;
  id_is_odd != peer_is_server
}

pub struct MessageHandler {}

impl MessageHandler {
  pub async fn handle(
    client: Arc<MOQTClient>,
    control_stream_handler: &mut ControlStreamHandler,
    msg: ControlMessage,
    context: Arc<SessionContext>,
  ) -> Result<(), TerminationCode> {
    // Check request ID if the message is a request
    let request_id = match &msg {
      ControlMessage::PublishNamespace(msg) => Some(msg.request_id),
      ControlMessage::Publish(msg) => Some(msg.request_id),
      ControlMessage::Fetch(msg) => Some(msg.request_id),
      ControlMessage::Subscribe(msg) => Some(msg.request_id),
      ControlMessage::SubscribeUpdate(msg) => Some(msg.request_id),
      ControlMessage::TrackStatus(msg) => Some(msg.request_id),
      ControlMessage::SubscribeNamespace(msg) => Some(msg.request_id),
      // Per SWITCH PR #1378 the subscriber allocates no Request ID for a SWITCH, so there
      // is nothing to validate against max_request_id here. The relay allocates
      // the target delivery's Request ID in the SWITCH handler.
      ControlMessage::Switch(_) => None,
      _ => None,
    };

    if let Some(request_id) = request_id {
      if request_id_parity_violation(context.peer_is_server, request_id) {
        warn!(
          "request id ({}) violates parity (peer is {}, expected {} ids) — terminating session",
          request_id,
          if context.peer_is_server { "a server" } else { "a client" },
          if context.peer_is_server { "odd" } else { "even" },
        );
        return Err(TerminationCode::ProtocolViolation);
      }
      let max_request_id = context.max_request_id.load(Ordering::Relaxed);
      if request_id >= max_request_id {
        warn!(
          "request id ({}) is greater than max request id ({})",
          request_id, max_request_id
        );
        return Err(TerminationCode::TooManyRequests);
      }
    }

    let handling_result = match &msg {
      ControlMessage::PublishNamespace(_) => {
        publish_namespace_handler::handle(
          client.clone(),
          control_stream_handler,
          msg,
          context.clone(),
        )
        .await
      }
      ControlMessage::SubscribeNamespace(_) => {
        subscribe_namespace_handler::handle(
          client.clone(),
          control_stream_handler,
          msg,
          context.clone(),
        )
        .await
      }
      ControlMessage::MaxRequestId(_) => {
        max_request_id_handler::handle(client.clone(), control_stream_handler, msg, context.clone())
          .await
      }
      ControlMessage::Subscribe(_)
      | ControlMessage::SubscribeOk(_)
      | ControlMessage::SubscribeUpdate(_)
      | ControlMessage::SubscribeError(_)
      | ControlMessage::Unsubscribe(_)
      | ControlMessage::Switch(_) => {
        subscribe_handler::handle(client.clone(), control_stream_handler, msg, context.clone())
          .await
      }
      ControlMessage::TrackStatus(_)
      | ControlMessage::TrackStatusOk(_)
      | ControlMessage::TrackStatusError(_) => {
        track_status_handler::handle(control_stream_handler, msg, context.clone()).await
      }
      ControlMessage::Fetch(_) | ControlMessage::FetchCancel(_) | ControlMessage::FetchOk(_) => {
        fetch_handler::handle(client.clone(), control_stream_handler, msg, context.clone()).await
      }
      ControlMessage::Publish(_)
      | ControlMessage::PublishDone(_)
      | ControlMessage::PublishOk(_)
      | ControlMessage::PublishError(_) => {
        publish_handler::handle(client.clone(), control_stream_handler, msg, context.clone()).await
      }

      m => {
        info!("some message received");
        let a = m.serialize().unwrap();
        let buf = Bytes::from_iter(a);
        utils::print_bytes(&buf);
        Ok(())
      }
    }; // end of if

    if let Err(termination_code) = handling_result {
      Err(termination_code)
    } else {
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests_request_id_parity {
  use super::*;

  #[test]
  fn inbound_peer_is_a_client_and_must_use_even_ids() {
    assert!(!request_id_parity_violation(false, 0));
    assert!(!request_id_parity_violation(false, 2));
    // Odd ids collide with the relay's own (odd) allocation space.
    assert!(request_id_parity_violation(false, 1));
    assert!(request_id_parity_violation(false, 3));
  }

  #[test]
  fn upstream_peer_is_a_server_and_must_use_odd_ids() {
    assert!(!request_id_parity_violation(true, 1));
    assert!(!request_id_parity_violation(true, 7));
    // Even ids from the upstream would collide with the ids this relay
    // allocates as a client on that same link.
    assert!(request_id_parity_violation(true, 0));
    assert!(request_id_parity_violation(true, 4));
  }
}
