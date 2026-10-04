use anyhow::{Context, Result};
use moqtail::model::data::constant::DEFAULT_PUBLISHER_PRIORITY;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::transport::connection::TransportConnection;
use moqtail::transport::data_stream_handler::{HeaderInfo, SendDataStream};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::cmaf;
use crate::encoder::EncodedGop;

/// How the objects of a group are timed on the way out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectTiming {
  /// Sleep this long after each object (replay mode; see `send_track`).
  pub inter_object_delay: Option<Duration>,
  /// Re-stamp each chunk's `prft` NTP time when the object is sent. Replay mode:
  /// the cached chunks carry their encode-time NTP, and stamping a whole GOP once
  /// at emission gave every object of the group the same time, so per-frame
  /// latency on the client was group-granular. Live mode keeps the encoder's
  /// per-frame stamp (`false`).
  pub prft_at_send: bool,
}

impl ObjectTiming {
  pub const LIVE: Self = Self {
    inter_object_delay: None,
    prft_at_send: false,
  };
}

/// The payload to send for one encoded chunk: with `prft_at_send`, its leading
/// `prft` box carries the current wall clock; otherwise the bytes are unchanged.
pub fn object_payload(packet: &bytes::Bytes, prft_at_send: bool) -> bytes::Bytes {
  if prft_at_send {
    cmaf::replace_prft_ntp(packet.clone(), cmaf::now_ntp_timestamp())
  } else {
    packet.clone()
  }
}

/// Subgroup ID used for the single subgroup per group in this publisher.
/// Per MoQ draft, having exactly one subgroup per group (subgroup_id = 0) is
/// valid for non-layered, non-scalable delivery. Named here to make the intent
/// explicit and make future changes easy to locate.
const SINGLE_SUBGROUP_ID: u8 = 0;

/// Sends encoded GOPs over a MoQ track using per-group subgroup streams.
///
/// Each GOP maps to one MoQ group; each encoded packet within the GOP maps to
/// one MoQ object within that group's subgroup stream.
///
/// `publisher_priority` is the MoQ Publisher Priority written into every subgroup
/// header (lower number = higher priority). The relay's QUIC scheduler orders
/// streams by (subscriber priority, publisher priority) band before group recency,
/// so every video variant is given the same value (`--variant-priority`, default
/// 128): with distinct per-variant values the order in which the old and new
/// track's bytes left the relay at a switch seam depended on ladder position (M3).
///
/// # Stream-per-group note
/// A new QUIC stream is opened per GOP (~1 per second). This preserves MoQ
/// group semantics — subscribers can join at any group boundary — at the cost
/// of one stream setup per GOP. A future optimisation is to use the MoQ
/// TRACK_STREAM format, which carries group_id per object and supports
/// multi-group delivery on one stream, but the current library API does not
/// expose that stream type yet.
///
/// `timing.inter_object_delay`: if `Some`, sleep that long after each object send.
/// `timing.prft_at_send`: re-stamp each chunk's prft NTP time as it is sent.
/// Live mode passes `None` because the upstream encoder naturally paces
/// packets ~ms apart (each frame is an encoder round-trip). Replay mode reads
/// a whole GOP from disk in microseconds and would otherwise burst all 60
/// objects at QUIC line rate, which races with the relay's
/// per-subscriber stream-creation on the first object after a switch and
/// leads to the relay dropping objects 1..N (see relay subscription.rs's
/// `Send stream not found` path). 2 ms per object reproduces live's pacing.
pub async fn send_track(
  connection: Arc<TransportConnection>,
  track_alias: u64,
  label: String,
  publisher_priority: u8,
  mut gop_rx: tokio::sync::mpsc::Receiver<EncodedGop>,
  emit_barrier: Arc<tokio::sync::Barrier>,
  timing: ObjectTiming,
) -> Result<()> {
  info!("Sender ({} alias={}): starting", label, track_alias);

  const RATE_LOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

  let mut groups_sent = 0u64;
  let mut first_group_logged = false;
  let mut last_log = std::time::Instant::now();
  let mut groups_at_last_log = 0u64;

  while let Some(gop) = gop_rx.recv().await {
    // Pins all variants to the same group_id per wall-clock tick. Without this,
    // the relay's Switch gate (new.group_id >= old.last_sent.group) never
    // clears when switching to a higher bitrate whose pipeline fills slower.
    emit_barrier.wait().await;

    // Stamped at the start of the send, so it precedes the relay's CACHE_GROUP
    // and the client's receipt of the same group in a cross-process join.
    crate::events::emit(
      "GROUP_EMIT",
      serde_json::json!({
        "track": format!("video-{label}"),
        "track_alias": track_alias,
        "group": gop.group_id,
        "objects": gop.packets.len(),
        "bytes": gop.packets.iter().map(|p| p.len() as u64).sum::<u64>(),
      }),
    );

    match send_group(&connection, track_alias, publisher_priority, &gop, timing).await {
      Ok(()) => {
        groups_sent += 1;
        if !first_group_logged {
          info!(
            "Sender ({} alias={}): first group sent (group_id={})",
            label, track_alias, gop.group_id
          );
          first_group_logged = true;
        }
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(last_log);
        if elapsed >= RATE_LOG_INTERVAL {
          let delta = groups_sent - groups_at_last_log;
          let rate = delta as f64 / elapsed.as_secs_f64();
          info!(
            "Sender ({} alias={}): {:.2} groups/sec over last {:.1}s (last_group_id={}, total={})",
            label,
            track_alias,
            rate,
            elapsed.as_secs_f64(),
            gop.group_id,
            groups_sent
          );
          last_log = now;
          groups_at_last_log = groups_sent;
        }
      }
      Err(e) => {
        // A single failed group (e.g. a transient stream error) should not kill
        // the entire sender task for a live stream. Log and continue.
        warn!(
          "Sender ({} alias={}): error sending group {}: {:#}",
          label, track_alias, gop.group_id, e
        );
      }
    }
  }

  info!(
    "Sender ({} alias={}): finished, {} groups sent",
    label, track_alias, groups_sent
  );
  Ok(())
}

/// Sends a single MoQ group (GOP) on its own subgroup stream.
async fn send_group(
  connection: &Arc<TransportConnection>,
  track_alias: u64,
  publisher_priority: u8,
  gop: &EncodedGop,
  timing: ObjectTiming,
) -> Result<()> {
  let stream = connection
    .open_uni()
    .await
    .context("failed to open uni stream")?;

  let subgroup_header = SubgroupHeader::new_with_explicit_id(
    track_alias,
    gop.group_id,
    SINGLE_SUBGROUP_ID as u64,
    Some(publisher_priority),
    false, // no object properties
    true,  // contains_end_of_group: one subgroup per group
    true,  // first_object: a fresh stream per group starts at object 0
  );
  let header_info = HeaderInfo::Subgroup {
    header: subgroup_header,
  };

  // Arc<Mutex<>> is mandated by the SendDataStream API.
  let stream = Arc::new(Mutex::new(stream));
  let mut handler = SendDataStream::new(stream, header_info)
    .await
    .context("failed to initialize subgroup stream handler")?;

  let mut prev_object_id: Option<u64> = None;
  for (object_id, packet_data) in gop.packets.iter().enumerate() {
    let object_id = object_id as u64;
    let subgroup_object = SubgroupObject {
      object_id,
      properties: None, // None is correct; Some(vec![]) wastes bytes on the wire
      object_status: None,
      // Bytes::clone is O(1); a prft re-stamp copies the chunk once.
      payload: Some(object_payload(packet_data, timing.prft_at_send)),
    };

    let object = Object::try_from_subgroup(
      subgroup_object,
      track_alias,
      gop.group_id,
      Some(SINGLE_SUBGROUP_ID as u64),
      Some(publisher_priority),
      DEFAULT_PUBLISHER_PRIORITY,
    )
    .with_context(|| format!("failed to build object {}", object_id))?;

    handler
      .send_object(&object, prev_object_id)
      .await
      .with_context(|| format!("failed to write object {}", object_id))?;

    prev_object_id = Some(object_id);

    if let Some(delay) = timing.inter_object_delay {
      tokio::time::sleep(delay).await;
    }
  }

  handler
    .flush()
    .await
    .context("failed to flush subgroup stream")?;
  handler
    .finish()
    .await
    .context("failed to finish subgroup stream")?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use bytes::Bytes;

  fn prft_ntp(chunk: &Bytes) -> u64 {
    u64::from_be_bytes(chunk[16..24].try_into().unwrap())
  }

  fn ntp_to_ms(ntp: u64) -> f64 {
    (ntp >> 32) as f64 * 1000.0 + (ntp & 0xFFFF_FFFF) as f64 * 1000.0 / 4294967296.0
  }

  /// Replay mode: two objects of one group sent a few ms apart carry their own
  /// send times (they used to share the group's emission stamp), so the client's
  /// per-frame latency is per object.
  #[test]
  fn replay_objects_carry_their_own_send_time() {
    let encoded_at = cmaf::wrap_cmaf_chunk(1, 0, 3000, true, b"frame");
    std::thread::sleep(Duration::from_millis(20));
    let first = object_payload(&encoded_at, true);
    std::thread::sleep(Duration::from_millis(10));
    let second = object_payload(&encoded_at, true);
    let gap_ms = ntp_to_ms(prft_ntp(&second)) - ntp_to_ms(prft_ntp(&first));
    assert!((9.0..200.0).contains(&gap_ms), "gap {gap_ms} ms");
    assert!(
      prft_ntp(&first) > prft_ntp(&encoded_at),
      "re-stamped at send"
    );
    assert_eq!(
      &first[24..],
      &encoded_at[24..],
      "only the NTP field changes"
    );
  }

  /// Live mode keeps the encoder's stamp untouched.
  #[test]
  fn live_objects_keep_the_encoder_stamp() {
    let encoded_at = cmaf::wrap_cmaf_chunk(1, 0, 3000, true, b"frame");
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(object_payload(&encoded_at, false), encoded_at);
    assert_eq!(ObjectTiming::LIVE.inter_object_delay, None);
  }

  #[test]
  fn test_single_subgroup_id_is_zero() {
    // Verifies the constant matches the MoQ spec intent:
    // subgroup_id = 0 is valid for single-subgroup-per-group delivery.
    assert_eq!(SINGLE_SUBGROUP_ID, 0);
  }

  #[test]
  fn test_encoded_gop_packets_accessible() {
    // Smoke-test that the renamed EncodedGop field is reachable from sender.
    let gop = EncodedGop {
      group_id: 7,
      packets: vec![Bytes::from_static(b"pkt")],
    };
    assert_eq!(gop.group_id, 7);
    assert_eq!(gop.packets.len(), 1);
  }
}
