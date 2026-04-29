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
}
