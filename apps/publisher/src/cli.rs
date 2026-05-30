use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "publisher", author, version, about = "MOQtail publisher")]
pub struct Cli {
  /// Relay endpoint URL
  #[arg(default_value = "https://127.0.0.1:4433")]
  pub endpoint: String,

  /// Validate TLS certificate
  #[arg(long, default_value_t = false)]
  pub validate_cert: bool,

  /// Track namespace
  #[arg(long, short, default_value = "moqtail")]
  pub namespace: String,

  /// Path to video file
  #[arg(long, default_value = "data/video/Smoking Test.mp4")]
  pub video_path: String,

  /// Target playback latency for catalog tracks, in milliseconds
  #[arg(long, default_value_t = 1500)]
  pub target_latency_ms: u32,
  /// Maximum number of quality variants to encode (min 2, max 4).
  /// Fewer variants = less memory. The highest and lowest tiers are
  /// always included; middle tiers are dropped first.
  #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u8).range(2..=4))]
  pub max_variants: u8,

  /// Optional pre-encoded GOP cache directory.
  ///
  /// When the directory contains a finalized `meta.json`, the publisher reads
  /// pre-encoded GOPs from disk and replays them at 1 GOP/sec — no decode,
  /// no encode. When the directory is missing or has no `meta.json`, the
  /// publisher runs the full pipeline once at full speed (no pacing, no MoQ
  /// connection) and writes the encoded GOPs to disk; re-run the same command
  /// to start replaying. Layout: `<dir>/<quality>/{NNNNNN.gop, variant.json}`
  /// plus a top-level `meta.json` written atomically when prepare succeeds.
  #[arg(long)]
  pub encoded_dir: Option<PathBuf>,

  /// Ladder specification. One of: `default` (legacy resolution-coupled ladder);
  /// `<height>p:<comma-list-of-bitrates-kbps>` for one resolution at several
  /// bitrates (e.g. `720p:400,800,1200,2500,5000`); or
  /// `<height>p@<kbps>,<height>p@<kbps>,...` for an explicit per-rung
  /// resolution+bitrate ladder (e.g. `240p@150,360p@200,480p@500,720p@1200,1080p@4000`).
  /// Used by the paper experiment harness; production publisher leaves this at default.
  #[arg(long, default_value = "default")]
  pub ladder_spec: String,

  /// Replay mode only: emit each cached GOP exactly once and then stop,
  /// instead of looping back to the first GOP. Looping re-reads the cached
  /// bytes whose media PTS restarts at 0, producing a backward timeline
  /// discontinuity that wedges players at the loop seam. The paper experiment
  /// harness sets this so a fixed-length collection never straddles that seam.
  #[arg(long, default_value_t = false)]
  pub no_loop: bool,
}
