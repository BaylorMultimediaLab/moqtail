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

use crate::server::stream_id::StreamId;
use bytes::Bytes;
use fnv::FnvHasher;
use moqtail::{
  model::control::control_message::ControlMessageTrait, transport::data_stream_handler::HeaderInfo,
};
use once_cell::sync::Lazy;
use std::hash::Hasher;
use std::time::Instant;

// Static reference time: set when the program starts
pub static BASE_TIME: Lazy<Instant> = Lazy::new(Instant::now);

pub fn print_msg_bytes(msg: &impl ControlMessageTrait) {
  let bytes = msg.serialize();
  print_bytes(bytes.as_ref().unwrap());
}

pub fn print_bytes(buffer: &Bytes) {
  for byte in buffer.iter() {
    print!("{byte:02X} ");
  }
  println!();
}

pub fn bytes_to_hex(buffer: &Bytes) -> String {
  let mut hex = String::new();
  for byte in buffer.iter() {
    hex.push_str(&format!("{byte:02X} "));
  }
  hex
}

pub fn build_stream_id(track_alias: u64, header: &HeaderInfo) -> StreamId {
  match header {
    HeaderInfo::Fetch {
      header,
      fetch_request: _,
    } => StreamId::new_fetch(track_alias, header.request_id),
    HeaderInfo::Subgroup { header } => {
      StreamId::new_subgroup(track_alias, header.group_id, header.subgroup_id)
    }
  }
}

pub fn passed_time_since_start() -> u128 {
  (Instant::now() - *BASE_TIME).as_millis()
}

/// QUIC send priority for a data stream opened "now": a single band shared by
/// every subgroup stream on the connection, decaying by 1 per millisecond of
/// process uptime, so an older stream always outranks a newer one. Any code
/// that needs to slot a stream relative to subgroup streams (e.g. the SWITCH
/// catch-up stream, which must sit just above the target track's subgroup
/// streams without starving other tracks) must derive its value from this
/// same band, never from an absolute constant. Wraps every ~24.8 days
/// (i32::MAX ms) — at the wrap instant relative ordering across the seam
/// inverts; a pre-existing artifact of the scheme, shared by all users.
pub fn current_stream_priority() -> i32 {
  i32::MAX - (passed_time_since_start() % i32::MAX as u128) as i32
}

pub fn fnv_hash(bytes: &[u8]) -> u64 {
  let mut hasher = FnvHasher::default();
  hasher.write(bytes);
  hasher.finish()
}
