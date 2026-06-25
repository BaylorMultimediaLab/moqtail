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

//! Relay-initiated delivery for the SWITCH message (draft-ietf-moq-transport
//! PR #1378, "SWITCH for Client-side ABR").
//!
//! Under PR #1378 the relay carries out a switch by *opening a PUBLISH* toward
//! the subscriber for the target Track — it does not mutate the existing
//! subscription. These helpers build the two control-message shapes that flow
//! on success and on failure; the catch-up `FETCH_HEADER` data stream and the
//! `handle_switch_message` integration that drives them are a later step
//! verified against the network harness.
//!
//! Both helpers are side-effect-free beyond enqueuing a control message on the
//! subscriber, so they are safe to call from the switch handler before any data
//! stream is opened.

use std::sync::Arc;

use moqtail::model::common::location::Location;
use moqtail::model::common::reason_phrase::ReasonPhrase;
use moqtail::model::control::constant::GroupOrder;
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_done::PublishDone;
use moqtail::model::data::full_track_name::FullTrackName;
use moqtail::model::error::ParseError;
use moqtail::model::parameter::switch_transition::SwitchTransition;

use crate::server::client::MOQTClient;
use crate::server::switch_guard::SwitchFailure;

/// Open the target Track's PUBLISH for a successful SWITCH.
///
/// The PUBLISH advertises the live edge as its largest location and carries the
/// `SWITCH_TRANSITION` parameter so the subscriber learns the seam: catch-up
/// covers `[switch_transition.switching_group_id, live_edge)`, live objects
/// follow from the live edge. `publish_request_id` is the relay-allocated
/// Request ID the subscriber will see on the inbound PUBLISH (it did not
/// pre-allocate it — the client handles this via its peer-publish path).
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn send_switch_publish(
  subscriber: &Arc<MOQTClient>,
  publish_request_id: u64,
  target: &FullTrackName,
  track_alias: u64,
  live_edge: Location,
  switch_transition: SwitchTransition,
) -> Result<(), ParseError> {
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    track_alias,
    GroupOrder::Original,
    1, // content_exists: data will follow
    Some(live_edge),
    1, // forward
    vec![switch_transition.to_key_value_pair()?],
  );
  subscriber
    .queue_message(ControlMessage::Publish(Box::new(publish)))
    .await;
  Ok(())
}

/// Report a failed SWITCH per PR #1378's always-PUBLISH discipline: still open
/// the target PUBLISH (so the subscriber has a request to terminate), then
/// immediately `PUBLISH_DONE` it with the mapped status code. The current
/// subscription is left untouched — no disconnect, replacing today's
/// `ProtocolViolation` teardown.
#[allow(dead_code)] // not yet wired; consumed by handle_switch_message
pub(crate) async fn send_switch_failure(
  subscriber: &Arc<MOQTClient>,
  publish_request_id: u64,
  target: &FullTrackName,
  track_alias: u64,
  failure: SwitchFailure,
) {
  let publish = Publish::new(
    publish_request_id,
    target.namespace.clone(),
    target.name.clone(),
    track_alias,
    GroupOrder::Original,
    0, // content_exists: no data will follow a failed switch
    None,
    0, // forward
    vec![],
  );
  subscriber
    .queue_message(ControlMessage::Publish(Box::new(publish)))
    .await;

  let reason = ReasonPhrase::try_new(format!("switch: {failure:?}"))
    .unwrap_or_else(|_| ReasonPhrase::try_new(String::new()).unwrap());
  let done = PublishDone::new(publish_request_id, failure.status_code(), 0, reason);
  subscriber
    .queue_message(ControlMessage::PublishDone(Box::new(done)))
    .await;
}
