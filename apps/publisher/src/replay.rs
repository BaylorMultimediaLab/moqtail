use anyhow::Result;
use bytes::Bytes;
use std::path::PathBuf;
use std::time::Instant;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::cache;
use crate::cmaf;
use crate::encoder::EncodedGop;
use crate::pacing::pace_gop_emit_async;

/// Reads pre-encoded GOPs from `<variant_dir>/NNNNNN.gop` and forwards them at
/// the wall-clock cadence (one GOP per `gop_duration_secs`) to the existing
/// per-variant sender via `gop_tx`. After the last file it loops back to
/// `000000.gop` but keeps incrementing `group_id`, so MoQ relays/subscribers
/// see a monotonically rising sequence across the wraparound.
pub async fn replay_variant(
  variant_dir: PathBuf,
  gops_per_variant: u64,
  gop_duration_secs: f64,
  label: String,
  gop_tx: mpsc::Sender<EncodedGop>,
) -> Result<()> {
  if gops_per_variant == 0 {
    anyhow::bail!(
      "Replay ({}): cache reports 0 GOPs in {}",
      label,
      variant_dir.display()
    );
  }

  info!(
    "Replay ({}): {} GOPs in {}",
    label,
    gops_per_variant,
    variant_dir.display()
  );

  let pacing_start = Instant::now();
  let mut group_id: u64 = 0;

  loop {
    let file_index = group_id % gops_per_variant;
    let path = cache::gop_path(&variant_dir, file_index);

    let read_path = path.clone();
    let gid = group_id;
    let gop = tokio::task::spawn_blocking(move || cache::read_gop(&read_path, gid))
      .await
      .map_err(|e| anyhow::anyhow!("Replay ({}): read task panicked: {}", label, e))??;

    pace_gop_emit_async(pacing_start, gop_duration_secs, group_id).await;

    // Stamp every packet's prft box with the current wall clock. The cached
    // bytes carry the encode-time NTP timestamp, which would otherwise tell
    // the receiver this segment is hours old and starve playback (latency
    // tracker drains the buffer, ABR bottoms out, framerate readout dies).
    let gop = stamp_prft_now(gop);

    if gop_tx.send(gop).await.is_err() {
      info!("Replay ({}): downstream sender dropped, exiting", label);
      return Ok(());
    }

    group_id += 1;

    if file_index + 1 == gops_per_variant {
      // Wrap-around log so it's visible in test runs.
      warn!(
        "Replay ({}): wrapped past last cached GOP, next group_id={}",
        label, group_id
      );
    }
  }
}

fn stamp_prft_now(gop: EncodedGop) -> EncodedGop {
  let ntp = cmaf::now_ntp_timestamp();
  let packets: Vec<Bytes> = gop
    .packets
    .into_iter()
    .map(|pkt| cmaf::replace_prft_ntp(pkt, ntp))
    .collect();
  EncodedGop {
    group_id: gop.group_id,
    packets,
  }
}
