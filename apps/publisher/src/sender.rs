use anyhow::{Context, Result};
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::transport::data_stream_handler::{HeaderInfo, SendDataStream};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::encoder::EncodedGop;

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
/// `publisher_priority` controls drop precedence at the relay under congestion:
/// lower numbers = higher priority = relay delivers these first.
/// Assign lower numbers to lower-quality tracks so the baseline quality remains
/// available under network stress.
///
/// # Stream-per-group note
/// A new QUIC stream is opened per GOP (~1 per second). This preserves MoQ
/// group semantics — subscribers can join at any group boundary — at the cost
/// of one stream setup per GOP. A future optimisation is to use the MoQ
/// TRACK_STREAM format, which carries group_id per object and supports
/// multi-group delivery on one stream, but the current library API does not
/// expose that stream type yet.
pub async fn send_track(
  connection: Arc<wtransport::Connection>,
  track_alias: u64,
  label: String,
  publisher_priority: u8,
  mut gop_rx: tokio::sync::mpsc::Receiver<EncodedGop>,
  emit_barrier: Arc<tokio::sync::Barrier>,
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

    match send_group(&connection, track_alias, publisher_priority, &gop).await {
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
  connection: &Arc<wtransport::Connection>,
  track_alias: u64,
  publisher_priority: u8,
  gop: &EncodedGop,
) -> Result<()> {
  let stream = connection
    .open_uni()
    .await?
    .await
    .context("failed to open uni stream")?;

  let subgroup_header = SubgroupHeader::new_with_explicit_id(
    track_alias,
    gop.group_id,
    SINGLE_SUBGROUP_ID as u64, // SubgroupHeader takes u64; try_from_subgroup takes u8
    publisher_priority,
    false,
    true,
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
      extension_headers: None, // None is correct; Some(vec![]) wastes bytes on the wire
      object_status: None,
      payload: Some(packet_data.clone()), // Bytes::clone is O(1) — no copy needed
    };

    let object = Object::try_from_subgroup(
      subgroup_object,
      track_alias,
      gop.group_id,
      Some(gop.group_id),
      SINGLE_SUBGROUP_ID,
    )
    .with_context(|| format!("failed to build object {}", object_id))?;

    handler
      .send_object(&object, prev_object_id)
      .await
      .with_context(|| format!("failed to write object {}", object_id))?;

    prev_object_id = Some(object_id);
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
