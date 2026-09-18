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
/// per-variant sender via `gop_tx`. When `loop_replay` is true, after the last
/// file it loops back to `000000.gop` but keeps incrementing `group_id`, so MoQ
/// relays/subscribers see a monotonically rising sequence across the wraparound
/// (the cached media PTS does restart at 0, so subscribers wedge at the seam).
/// When `loop_replay` is false, it emits each cached GOP exactly once and stops.
pub async fn replay_variant(
  variant_dir: PathBuf,
  gops_per_variant: u64,
  gop_duration_secs: f64,
  label: String,
  loop_replay: bool,
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
  let mut shifter = TimelineShifter::default();

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
    let gop = shift_timeline(gop, &mut shifter);

    if gop_tx.send(gop).await.is_err() {
      info!("Replay ({}): downstream sender dropped, exiting", label);
      return Ok(());
    }

    group_id += 1;

    if file_index + 1 == gops_per_variant {
      if !loop_replay {
        info!(
          "Replay ({}): emitted all {} GOPs (--no-loop), stopping",
          label, gops_per_variant
        );
        return Ok(());
      }
      // Wrap-around log so it's visible in test runs.
      warn!(
        "Replay ({}): wrapped past last cached GOP, next group_id={}",
        label, group_id
      );
    }
  }
}

/// Keeps the replayed media timeline monotonic across cache wraps.
///
/// The cached GOPs carry the timestamps they were encoded with, so every pass
/// through the cache restarts at zero. A subscriber appends those into one MSE
/// SourceBuffer, so on the wrap the timeline jumps backwards: the new media
/// lands in a disjoint range far behind the playhead, which is left stranded at
/// the end of the old range with nothing to play. Observed as a hard stall at
/// exactly the cache duration (309s for the default cache).
///
/// Rather than deriving the shift from cache metadata — which would drift if any
/// GOP's duration differs from the nominal one — each packet is re-stamped to
/// continue from the previous packet, so the wrap is absorbed wherever it falls.
#[derive(Default)]
struct TimelineShifter {
  /// Decode time last emitted, in media timescale ticks.
  last_emitted: Option<u64>,
  /// Typical gap between consecutive packets, learned from the stream and used
  /// to place the first packet after a wrap.
  step: Option<u64>,
}

impl TimelineShifter {
  /// Returns the decode time this packet should carry, given its original one.
  fn next(&mut self, original: u64) -> u64 {
    let emitted = match (self.last_emitted, self.step) {
      // Timeline went backwards (or stalled): this is the wrap. Continue one
      // step past the last packet emitted.
      (Some(last), step) if original <= last || self.wrapped(original, last) => {
        last.saturating_add(step.unwrap_or(1))
      }
      _ => original,
    };
    if let Some(last) = self.last_emitted
      && emitted > last
    {
      self.step = Some(emitted - last);
    }
    self.last_emitted = Some(emitted);
    emitted
  }

  /// After the first wrap the shift is permanent, so an unshifted original will
  /// read as far *behind* the emitted timeline rather than merely non-monotonic.
  fn wrapped(&self, original: u64, last: u64) -> bool {
    original < last
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

/// Re-stamps every packet in `gop` so the media timeline continues monotonically
/// across cache wraps. See [`TimelineShifter`].
fn shift_timeline(gop: EncodedGop, shifter: &mut TimelineShifter) -> EncodedGop {
  let packets: Vec<Bytes> = gop
    .packets
    .into_iter()
    .map(|pkt| match cmaf::read_decode_time(&pkt) {
      Some(original) => {
        let emitted = shifter.next(original);
        if emitted == original {
          pkt
        } else {
          cmaf::set_decode_time(pkt, emitted)
        }
      }
      None => pkt,
    })
    .collect();
  EncodedGop {
    group_id: gop.group_id,
    packets,
  }
}
