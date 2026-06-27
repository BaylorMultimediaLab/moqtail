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

/*
SWITCH Message {
  Type (i) = 0x1B,
  Length (16),
  Current Subscribe Request ID (i),  // the Established subscription being replaced
  Target Track Namespace (..),
  Target Track Name Length (i),
  Target Track Name (..),
  Minimum Switching Group ID (i),    // floor: do not transition before this group
  Number of Parameters (i),
  Parameters (..) ...,
}

Note: the subscriber does NOT allocate a Request ID for the SWITCH. The relay
allocates the Request ID of the target PUBLISH it opens in response. The
Minimum Switching Group ID is a lower bound, not an exact transition point: the
relay selects the smallest feasible common, gap-free boundary at or above it.
*/
use super::constant::ControlMessageType;
use super::control_message::ControlMessageTrait;
use crate::model::common::pair::KeyValuePair;
use crate::model::common::tuple::{Tuple, TupleField};
use crate::model::common::varint::{BufMutVarIntExt, BufVarIntExt};
use crate::model::data::full_track_name::FullTrackName;
use crate::model::error::ParseError;
use bytes::{Buf, BufMut, Bytes, BytesMut};

#[derive(Debug, PartialEq, Clone)]
pub struct Switch {
  /// The Established subscription being replaced ("Current Subscribe Request
  /// ID"). Must identify a live subscription; otherwise the relay must not
  /// modify existing subscription state.
  pub current_subscribe_request_id: u64,
  pub track_namespace: Tuple,
  pub track_name: TupleField,
  /// Lower bound on the transition group: the relay must not switch before
  /// this group, and selects the smallest feasible boundary at or above it.
  pub minimum_switching_group_id: u64,
  pub subscribe_parameters: Vec<KeyValuePair>,
}

#[allow(clippy::too_many_arguments)]
impl Switch {
  pub fn new(
    current_subscribe_request_id: u64,
    track_namespace: Tuple,
    track_name: TupleField,
    minimum_switching_group_id: u64,
    subscribe_parameters: Vec<KeyValuePair>,
  ) -> Self {
    Self {
      current_subscribe_request_id,
      track_namespace,
      track_name,
      minimum_switching_group_id,
      subscribe_parameters,
    }
  }

  pub fn get_full_track_name(&self) -> FullTrackName {
    FullTrackName {
      namespace: self.track_namespace.clone(),
      name: self.track_name.clone(),
    }
  }
}
impl ControlMessageTrait for Switch {
  fn serialize(&self) -> Result<Bytes, ParseError> {
    let mut buf = BytesMut::new();
    buf.put_vi(ControlMessageType::Switch)?;

    let mut payload = BytesMut::new();
    payload.put_vi(self.current_subscribe_request_id)?;

    payload.extend_from_slice(&self.track_namespace.serialize()?);
    payload.put_vi(self.track_name.len())?;
    payload.extend_from_slice(self.track_name.as_bytes());

    payload.put_vi(self.minimum_switching_group_id)?;

    payload.put_vi(self.subscribe_parameters.len())?;
    for param in &self.subscribe_parameters {
      payload.extend_from_slice(&param.serialize()?);
    }

    let payload_len: u16 = payload
      .len()
      .try_into()
      .map_err(|e: std::num::TryFromIntError| ParseError::CastingError {
        context: "Switch::serialize",
        from_type: "usize",
        to_type: "u16",
        details: e.to_string(),
      })?;

    buf.put_u16(payload_len);
    buf.extend_from_slice(&payload);
    Ok(buf.freeze())
  }

  fn parse_payload(payload: &mut Bytes) -> Result<Box<Self>, ParseError> {
    let current_subscribe_request_id = payload.get_vi()?;
    let track_namespace = Tuple::deserialize(payload)?;

    let name_len_u64 = payload.get_vi()?;
    let name_len: usize = name_len_u64
      .try_into()
      .map_err(|e: std::num::TryFromIntError| ParseError::CastingError {
        context: "Switch::parse_payload(track_name_len)",
        from_type: "u64",
        to_type: "usize",
        details: e.to_string(),
      })?;

    if payload.remaining() < name_len {
      return Err(ParseError::NotEnoughBytes {
        context: "Switch::parse_payload(track_name)",
        needed: name_len,
        available: payload.remaining(),
      });
    }
    let track_name = TupleField::new(payload.copy_to_bytes(name_len));

    let minimum_switching_group_id = payload.get_vi()?;

    let param_count_u64 = payload.get_vi()?;
    let param_count: usize =
      param_count_u64
        .try_into()
        .map_err(|e: std::num::TryFromIntError| ParseError::CastingError {
          context: "Switch::parse_payload(param_count)",
          from_type: "u64",
          to_type: "usize",
          details: e.to_string(),
        })?;

    let mut subscribe_parameters = Vec::with_capacity(param_count);
    for _ in 0..param_count {
      let param = KeyValuePair::deserialize(payload)?;
      subscribe_parameters.push(param);
    }

    Ok(Box::new(Switch {
      current_subscribe_request_id,
      track_namespace,
      track_name,
      minimum_switching_group_id,
      subscribe_parameters,
    }))
  }
  fn get_type(&self) -> ControlMessageType {
    ControlMessageType::Switch
  }
}
#[cfg(test)]
mod tests {
  use super::*;
  use bytes::Buf;

  #[test]
  fn test_roundtrip() {
    let current_subscribe_request_id = 31;
    let track_namespace = Tuple::from_utf8_path("nein/nein/nein");
    let track_name = TupleField::from_utf8("${Name}");
    let minimum_switching_group_id = 128242;
    let subscribe_parameters = vec![
      KeyValuePair::try_new_varint(0, 10).unwrap(),
      KeyValuePair::try_new_bytes(1, Bytes::from_static(b"I'll sync you up")).unwrap(),
    ];
    let switch = Switch {
      current_subscribe_request_id,
      track_namespace,
      track_name,
      minimum_switching_group_id,
      subscribe_parameters,
    };

    let mut buf = switch.serialize().unwrap();
    let msg_type = buf.get_vi().unwrap();
    assert_eq!(msg_type, ControlMessageType::Switch as u64);
    let msg_length = buf.get_u16();
    assert_eq!(msg_length as usize, buf.remaining());
    let deserialized = Switch::parse_payload(&mut buf).unwrap();
    assert_eq!(*deserialized, switch);
    assert!(!buf.has_remaining());
  }

  #[test]
  fn test_excess_roundtrip() {
    let current_subscribe_request_id = 31;
    let track_namespace = Tuple::from_utf8_path("nein/nein/nein");
    let track_name = TupleField::from_utf8("${Name}");
    let minimum_switching_group_id = 128242;
    let subscribe_parameters = vec![
      KeyValuePair::try_new_varint(0, 10).unwrap(),
      KeyValuePair::try_new_bytes(1, Bytes::from_static(b"I'll sync you up")).unwrap(),
    ];
    let switch = Switch {
      current_subscribe_request_id,
      track_namespace,
      track_name,
      minimum_switching_group_id,
      subscribe_parameters,
    };

    let serialized = switch.serialize().unwrap();
    let mut excess = BytesMut::new();
    excess.extend_from_slice(&serialized);
    excess.extend_from_slice(&[9u8, 1u8, 1u8]);
    let mut buf = excess.freeze();

    let msg_type = buf.get_vi().unwrap();
    assert_eq!(msg_type, ControlMessageType::Switch as u64);
    let msg_length = buf.get_u16();

    assert_eq!(msg_length as usize, buf.remaining() - 3);
    let deserialized = Switch::parse_payload(&mut buf).unwrap();
    assert_eq!(*deserialized, switch);
    assert_eq!(buf.chunk(), &[9u8, 1u8, 1u8]);
  }

  #[test]
  fn test_partial_message() {
    let current_subscribe_request_id = 31;
    let track_namespace = Tuple::from_utf8_path("nein/nein/nein");
    let track_name = TupleField::from_utf8("${Name}");
    let minimum_switching_group_id = 128242;
    let subscribe_parameters = vec![
      KeyValuePair::try_new_varint(0, 10).unwrap(),
      KeyValuePair::try_new_bytes(1, Bytes::from_static(b"I'll sync you up")).unwrap(),
    ];
    let switch = Switch {
      current_subscribe_request_id,
      track_namespace,
      track_name,
      minimum_switching_group_id,
      subscribe_parameters,
    };

    let mut buf = switch.serialize().unwrap();
    let msg_type = buf.get_vi().unwrap();
    assert_eq!(msg_type, ControlMessageType::Switch as u64);
    let msg_length = buf.get_u16();
    assert_eq!(msg_length as usize, buf.remaining());

    let upper = buf.remaining() / 2;
    let mut partial = buf.slice(..upper);
    let deserialized = Switch::parse_payload(&mut partial);
    assert!(deserialized.is_err());
  }
}
