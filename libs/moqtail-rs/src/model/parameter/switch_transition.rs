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

//! SWITCH_TRANSITION (moq-transport PR #1378, "SWITCH for Client-side ABR").
//!
//! Carried on the target Track's PUBLISH a relay opens in answer to a SWITCH so
//! the subscriber learns where the seam is:
//!
//! ```text
//! SWITCH_TRANSITION {
//!   Switching Group ID (i),     // G_switch: first group on the new track
//!   Live Edge Group ID (i),     // target's live edge when the PUBLISH was opened
//!   [Below-Seam Streams (i)]    // project-local, optional (see below)
//! }
//! ```
//!
//! Wire-wise it is the odd-typed (0x73) bytes-valued message parameter
//! [`MessageParameter::SwitchTransition`]; this module holds the typed value and
//! its payload codec.
//!
//! **Project-local extension (deliberate deviation, audit R6 D2).** The PR's
//! payload is the first two varints. This relay appends a third: the number of
//! data streams it opened on the replaced subscription for Groups below
//! G_switch (finished ones included). With it a subscriber knows when the
//! replaced subscription has delivered everything below the seam: every one of
//! those streams has been seen and has ended. PUBLISH_DONE's Stream Count cannot
//! say that: it also counts the streams at or above the seam, which the relay
//! resets and which may never reach the subscriber. A two-varint payload (the
//! PR's form, and this project's before the extension) still decodes, with the
//! count absent.

use bytes::{Buf, Bytes, BytesMut};

use crate::model::common::varint::{BufMutVarIntExt, BufVarIntExt};
use crate::model::error::ParseError;
use crate::model::parameter::message_parameter::MessageParameter;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwitchTransition {
  /// G_switch: the first group_id delivered on the target Track.
  pub switching_group_id: u64,
  /// The target Track's live edge group_id at the moment the PUBLISH opened.
  pub live_edge_group_id: u64,
  /// Project-local: data streams the relay opened on the replaced subscription
  /// for Groups below G_switch, finished ones included. `None` = not carried
  /// (the PR's two-field form).
  pub below_seam_streams: Option<u64>,
}

impl SwitchTransition {
  pub fn new(switching_group_id: u64, live_edge_group_id: u64) -> Self {
    Self {
      switching_group_id,
      live_edge_group_id,
      below_seam_streams: None,
    }
  }

  /// This value carrying the project-local below-seam stream count.
  pub fn with_below_seam_streams(mut self, below_seam_streams: Option<u64>) -> Self {
    self.below_seam_streams = below_seam_streams;
    self
  }

  /// The typed message parameter ready to drop into a PUBLISH's parameter list.
  pub fn to_message_parameter(&self) -> MessageParameter {
    MessageParameter::SwitchTransition {
      switching_group_id: self.switching_group_id,
      live_edge_group_id: self.live_edge_group_id,
      below_seam_streams: self.below_seam_streams,
    }
  }

  /// Encode the payload: two varints, plus the below-seam stream count when set.
  pub fn to_bytes(&self) -> Result<Bytes, ParseError> {
    let mut payload = BytesMut::new();
    payload.put_vi(self.switching_group_id)?;
    payload.put_vi(self.live_edge_group_id)?;
    if let Some(count) = self.below_seam_streams {
      payload.put_vi(count)?;
    }
    Ok(payload.freeze())
  }

  /// Decode the payload: two varints, optionally a third (the below-seam stream
  /// count). Anything after that is malformed.
  pub fn from_bytes(mut value: Bytes) -> Result<Self, ParseError> {
    let switching_group_id = value.get_vi()?;
    let live_edge_group_id = value.get_vi()?;
    let below_seam_streams = if value.has_remaining() {
      Some(value.get_vi()?)
    } else {
      None
    };
    if value.has_remaining() {
      return Err(ParseError::KeyValueFormattingError {
        context: "SwitchTransition::from_bytes",
      });
    }
    Ok(Self {
      switching_group_id,
      live_edge_group_id,
      below_seam_streams,
    })
  }

  /// Find the first SWITCH_TRANSITION parameter in a list, if any.
  pub fn from_parameters(params: &[MessageParameter]) -> Option<Self> {
    params.iter().find_map(|p| match p {
      MessageParameter::SwitchTransition {
        switching_group_id,
        live_edge_group_id,
        below_seam_streams,
      } => Some(
        Self::new(*switching_group_id, *live_edge_group_id)
          .with_below_seam_streams(*below_seam_streams),
      ),
      _ => None,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::model::common::pair::KeyValuePair;
  use crate::model::parameter::constant::MessageParameterType;

  #[test]
  fn payload_roundtrip() {
    let st = SwitchTransition::new(42, 100);
    let bytes = st.to_bytes().unwrap();
    assert_eq!(SwitchTransition::from_bytes(bytes).unwrap(), st);
  }

  #[test]
  fn roundtrip_via_message_parameter_wire_form() {
    // Full KeyValuePair serialize/deserialize cycle, as it travels on a PUBLISH
    // parameter list: an odd type, so a length-prefixed bytes value.
    let st = SwitchTransition::new(7, 9);
    let kvp: KeyValuePair = st.to_message_parameter().try_into().unwrap();
    assert_eq!(
      kvp.get_type(),
      MessageParameterType::SwitchTransition as u64
    );
    let mut buf = kvp.serialize().unwrap();
    let parsed = KeyValuePair::deserialize(&mut buf).unwrap();
    let param = MessageParameter::deserialize(&parsed).unwrap();
    assert_eq!(SwitchTransition::from_parameters(&[param]).unwrap(), st);
  }

  #[test]
  fn from_parameters_ignores_other_params() {
    let other = MessageParameter::new_delay_groups(5);
    assert!(SwitchTransition::from_parameters(&[other]).is_none());
    assert!(SwitchTransition::from_parameters(&[]).is_none());
  }

  #[test]
  fn trailing_bytes_after_the_count_are_rejected() {
    let mut payload = BytesMut::new();
    payload.put_vi(1).unwrap();
    payload.put_vi(2).unwrap();
    payload.put_vi(3).unwrap();
    payload.put_vi(4).unwrap();
    assert!(SwitchTransition::from_bytes(payload.freeze()).is_err());
  }

  /// R6 D2: the project-local third field round-trips, and the PR's two-field
  /// form still decodes, with the count absent.
  #[test]
  fn below_seam_stream_count_roundtrips_and_the_two_field_form_still_decodes() {
    let st = SwitchTransition::new(42, 100).with_below_seam_streams(Some(3));
    let bytes = st.to_bytes().unwrap();
    assert_eq!(
      bytes.len(),
      SwitchTransition::new(42, 100).to_bytes().unwrap().len() + 1,
      "the count is one more varint after the PR's two"
    );
    assert_eq!(SwitchTransition::from_bytes(bytes).unwrap(), st);

    let mut two = BytesMut::new();
    two.put_vi(42).unwrap();
    two.put_vi(100).unwrap();
    let old = SwitchTransition::from_bytes(two.freeze()).unwrap();
    assert_eq!(old, SwitchTransition::new(42, 100));
    assert_eq!(old.below_seam_streams, None);

    let zero = SwitchTransition::new(5, 6).with_below_seam_streams(Some(0));
    assert_eq!(
      SwitchTransition::from_bytes(zero.to_bytes().unwrap()).unwrap(),
      zero
    );

    let kvp: KeyValuePair = st.to_message_parameter().try_into().unwrap();
    let mut buf = kvp.serialize().unwrap();
    let parsed = KeyValuePair::deserialize(&mut buf).unwrap();
    let param = MessageParameter::deserialize(&parsed).unwrap();
    assert_eq!(SwitchTransition::from_parameters(&[param]).unwrap(), st);
  }

  #[test]
  fn large_group_ids_roundtrip() {
    let st = SwitchTransition::new(1_000_000, 2u64.pow(30));
    assert_eq!(
      SwitchTransition::from_bytes(st.to_bytes().unwrap()).unwrap(),
      st
    );
  }
}
