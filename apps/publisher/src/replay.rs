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
/// per-variant sender via `gop_tx`.
///
/// When `loop_mode` is true, after the last file the index wraps back to
/// `000000.gop` while `group_id` keeps incrementing — and each packet's CMAF
/// `tfdt.baseMediaDecodeTime` and `prft.media_time` are rewritten by
/// `cycle * cycle_offset_ticks` so the receiver sees a monotonically rising
/// decode timeline across the wraparound. Without this rewrite the cached
/// chunks carry the original encode-time tfdt (e.g. file index 17 → 17 s),
/// which lands behind the player's playhead in MSE and breaks the per-switch
/// playhead-gap invariant the experiment harness asserts on.
///
/// When `loop_mode` is false, the loop terminates cleanly after one full pass
/// through the cache (no wraparound, no rewrite needed).
pub async fn replay_variant(
  variant_dir: PathBuf,
  gops_per_variant: u64,
  gop_duration_secs: f64,
  cycle_offset_ticks: u64,
  loop_mode: bool,
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
    "Replay ({}): {} GOPs in {} (loop={})",
    label,
    gops_per_variant,
    variant_dir.display(),
    loop_mode,
  );

  let pacing_start = Instant::now();
  let mut group_id: u64 = 0;

  loop {
    let file_index = group_id % gops_per_variant;
    let cycle = group_id / gops_per_variant;
    let path = cache::gop_path(&variant_dir, file_index);

    let read_path = path.clone();
    let gid = group_id;
    let gop = tokio::task::spawn_blocking(move || cache::read_gop(&read_path, gid))
      .await
      .map_err(|e| anyhow::anyhow!("Replay ({}): read task panicked: {}", label, e))??;

    pace_gop_emit_async(pacing_start, gop_duration_secs, group_id).await;

    // First cycle uses the cached chunks' original tfdt/media_time as-is and
    // only refreshes the prft NTP timestamp. Wraparound cycles must add a
    // per-cycle offset to both tfdt.baseMediaDecodeTime and prft.media_time
    // or the receiver's MSE timeline gets disjoint regions at the wrapped
    // PTS while the playhead is still at the pre-wrap live edge.
    let gop = relabel_gop(gop, cycle, cycle_offset_ticks);

    if gop_tx.send(gop).await.is_err() {
      info!("Replay ({}): downstream sender dropped, exiting", label);
      return Ok(());
    }

    group_id += 1;

    if file_index + 1 == gops_per_variant {
      if loop_mode {
        warn!(
          "Replay ({}): wrapped past last cached GOP, next group_id={}",
          label, group_id
        );
      } else {
        info!(
          "Replay ({}): emitted last cached GOP (loop disabled), exiting",
          label
        );
        return Ok(());
      }
    }
  }
}

fn relabel_gop(gop: EncodedGop, cycle: u64, cycle_offset_ticks: u64) -> EncodedGop {
  let ntp = cmaf::now_ntp_timestamp();
  let media_time_offset = cycle.saturating_mul(cycle_offset_ticks);
  let packets: Vec<Bytes> = gop
    .packets
    .into_iter()
    .map(|pkt| relabel_packet(pkt, ntp, media_time_offset))
    .collect();
  EncodedGop {
    group_id: gop.group_id,
    packets,
  }
}

/// Patches the leading prft (ntp + media_time) and the moof/traf/tfdt
/// baseMediaDecodeTime of a single CMAF chunk produced by
/// [`cmaf::wrap_cmaf_chunk`]. Layout offsets are derived from the writer:
///   prft: bytes 0..32  (media_time at 24..32)
///   moof: bytes 32..(32 + moof_size)
///     traf:  56 + 8 = 64
///       tfhd: 64..80
///       tfdt: 80..100  (baseMediaDecodeTime at 92..100, version-1)
///
/// Returns the input `Bytes` unchanged if it isn't shaped like a wrapped
/// chunk (length / fourcc check at expected box positions).
fn relabel_packet(pkt: Bytes, ntp: u64, media_time_offset: u64) -> Bytes {
  // Bare minimum: prft (32) + moof header (8) + mfhd (16) + traf header (8) + tfhd (16) + tfdt (20) = 100
  if pkt.len() < 100 || &pkt[4..8] != b"prft" || &pkt[36..40] != b"moof" || &pkt[84..88] != b"tfdt"
  {
    return pkt;
  }

  // Extract the original values so we can add the per-cycle offset.
  let original_media_time = u64::from_be_bytes(pkt[24..32].try_into().expect("8 bytes"));
  let original_tfdt = u64::from_be_bytes(pkt[92..100].try_into().expect("8 bytes"));

  let mut bm = match pkt.try_into_mut() {
    Ok(bm) => bm,
    Err(b) => bytes::BytesMut::from(b.as_ref()),
  };
  // prft.ntp_timestamp — refresh per-emit so receivers see a live latency reading
  bm[16..24].copy_from_slice(&ntp.to_be_bytes());
  // prft.media_time and tfdt.baseMediaDecodeTime — add the per-cycle offset
  bm[24..32].copy_from_slice(
    &original_media_time
      .wrapping_add(media_time_offset)
      .to_be_bytes(),
  );
  bm[92..100].copy_from_slice(&original_tfdt.wrapping_add(media_time_offset).to_be_bytes());
  bm.freeze()
}
