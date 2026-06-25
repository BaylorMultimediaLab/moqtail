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

//! SWITCH_TRANSITION version-specific parameter (draft-ietf-moq-transport
//! PR #1378, "SWITCH for Client-side ABR").
//!
//! The relay attaches this parameter to the target Track's PUBLISH so the
//! subscriber knows exactly where the seam is after a SWITCH:
//!
//! ```text
//! SWITCH_TRANSITION {
//!   Switching Group ID (i),   // G_switch — first group on the new track
//!   Live Edge Group ID (i)    // target's live edge when PUBLISH was opened
//! }
//! ```
//!
//! Everything in `[Switching Group ID, Live Edge Group ID)` arrives on the
//! catch-up FETCH_HEADER stream; everything from the live edge onward arrives
//! on the normal SUBGROUP_HEADER streams.
//!
//! Wire-wise this is an *odd*-typed (`0x73`) `KeyValuePair::Bytes` whose value
//! is the two varints back to back.

use bytes::{Bytes, BytesMut};

use crate::model::common::pair::KeyValuePair;
use crate::model::common::varint::{BufMutVarIntExt, BufVarIntExt};
use crate::model::error::ParseError;
use crate::model::parameter::constant::VersionSpecificParameterType;

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

  /// Encode as the `0x73` bytes-valued `KeyValuePair` ready to drop into a
  /// PUBLISH's parameter list.
  pub fn to_key_value_pair(&self) -> Result<KeyValuePair, ParseError> {
    let mut payload = BytesMut::new();
    payload.put_vi(self.switching_group_id)?;
    payload.put_vi(self.live_edge_group_id)?;
    KeyValuePair::try_new_bytes(
      VersionSpecificParameterType::SwitchTransition as u64,
      payload.freeze(),
    )
  }

  /// Decode the two-varint payload of a SWITCH_TRANSITION value.
  pub fn from_bytes(mut value: Bytes) -> Result<Self, ParseError> {
    let switching_group_id = value.get_vi()?;
    let live_edge_group_id = value.get_vi()?;
    Ok(Self {
      switching_group_id,
      live_edge_group_id,
    })
  }

  /// Find and decode the first SWITCH_TRANSITION parameter in a list, if any.
  /// Returns `None` when the parameter is absent or carries the wrong (varint)
  /// shape.
  pub fn from_parameters(params: &[KeyValuePair]) -> Option<Self> {
    params.iter().find_map(|p| match p {
      KeyValuePair::Bytes { type_value, value }
        if *type_value == VersionSpecificParameterType::SwitchTransition as u64 =>
      {
        Self::from_bytes(value.clone()).ok()
      }
      _ => None,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn roundtrip_via_key_value_pair() {
    let st = SwitchTransition::new(42, 100);
    let kvp = st.to_key_value_pair().unwrap();

    // Type is the odd SWITCH_TRANSITION code, carried as a bytes pair.
    assert_eq!(
      kvp.get_type(),
      VersionSpecificParameterType::SwitchTransition as u64
    );

    let decoded = SwitchTransition::from_parameters(std::slice::from_ref(&kvp)).unwrap();
    assert_eq!(decoded, st);
  }

  #[test]
  fn serializes_through_key_value_pair_wire_form() {
    // Full KeyValuePair serialize/deserialize cycle, as it would travel on a
    // PUBLISH parameter list.
    let st = SwitchTransition::new(7, 9);
    let kvp = st.to_key_value_pair().unwrap();
    let mut buf = kvp.serialize().unwrap();
    let parsed = KeyValuePair::deserialize(&mut buf).unwrap();
    assert_eq!(SwitchTransition::from_parameters(&[parsed]).unwrap(), st);
  }

  #[test]
  fn from_parameters_ignores_other_params() {
    let other = KeyValuePair::try_new_varint(
      VersionSpecificParameterType::StartLocationGroup as u64,
      5,
    )
    .unwrap();
    assert!(SwitchTransition::from_parameters(&[other]).is_none());
  }

  #[test]
  fn from_parameters_absent_is_none() {
    assert!(SwitchTransition::from_parameters(&[]).is_none());
  }

  #[test]
  fn large_group_ids_roundtrip() {
    // Exercise multi-byte varints near the QUIC varint ceiling.
    let st = SwitchTransition::new(1_000_000, 2u64.pow(30));
    let kvp = st.to_key_value_pair().unwrap();
    let decoded = SwitchTransition::from_parameters(&[kvp]).unwrap();
    assert_eq!(decoded, st);
  }
}
