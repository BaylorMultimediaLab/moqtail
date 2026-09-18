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
//!   Switching Group ID (i),   // G_switch: first group on the new track
//!   Live Edge Group ID (i)    // target's live edge when the PUBLISH was opened
//! }
//! ```
//!
//! Wire-wise it is the odd-typed (0x73) bytes-valued message parameter
//! [`MessageParameter::SwitchTransition`]; this module holds the typed value and
//! its two-varint payload codec.

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
}

impl SwitchTransition {
  pub fn new(switching_group_id: u64, live_edge_group_id: u64) -> Self {
    Self {
      switching_group_id,
      live_edge_group_id,
    }
  }

  /// The typed message parameter ready to drop into a PUBLISH's parameter list.
  pub fn to_message_parameter(&self) -> MessageParameter {
    MessageParameter::SwitchTransition {
      switching_group_id: self.switching_group_id,
      live_edge_group_id: self.live_edge_group_id,
    }
  }

  /// Encode the two-varint payload of a SWITCH_TRANSITION value.
  pub fn to_bytes(&self) -> Result<Bytes, ParseError> {
    let mut payload = BytesMut::new();
    payload.put_vi(self.switching_group_id)?;
    payload.put_vi(self.live_edge_group_id)?;
    Ok(payload.freeze())
  }

  /// Decode the two-varint payload of a SWITCH_TRANSITION value.
  pub fn from_bytes(mut value: Bytes) -> Result<Self, ParseError> {
    let switching_group_id = value.get_vi()?;
    let live_edge_group_id = value.get_vi()?;
    if value.has_remaining() {
      return Err(ParseError::KeyValueFormattingError {
        context: "SwitchTransition::from_bytes",
      });
    }
    Ok(Self {
      switching_group_id,
      live_edge_group_id,
    })
  }

  /// Find the first SWITCH_TRANSITION parameter in a list, if any.
  pub fn from_parameters(params: &[MessageParameter]) -> Option<Self> {
    params.iter().find_map(|p| match p {
      MessageParameter::SwitchTransition {
        switching_group_id,
        live_edge_group_id,
      } => Some(Self::new(*switching_group_id, *live_edge_group_id)),
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
  fn trailing_bytes_are_rejected() {
    let mut payload = BytesMut::new();
    payload.put_vi(1).unwrap();
    payload.put_vi(2).unwrap();
    payload.put_vi(3).unwrap();
    assert!(SwitchTransition::from_bytes(payload.freeze()).is_err());
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
