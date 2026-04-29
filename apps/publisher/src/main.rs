mod adaptive;
mod cache;
mod catalog;
mod cli;
mod cmaf;
mod connection;
mod decoder;
mod encoder;
mod pacing;
mod replay;
mod scaler;
mod sender;
mod video;

use anyhow::{Context, Result};
use bytes::Bytes;
use clap::Parser;
use cli::Cli;
use connection::MoqConnection;
use encoder::{EncodedGop, HardwareEncoder};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Barrier, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::filter::LevelFilter;

/// Catalog track is always alias 0; per-variant aliases start at 1.
const CATALOG_ALIAS: u64 = 0;

/// Per-object delay to inject in replay mode so cached GOPs hit the wire at
/// roughly live's intra-GOP cadence (encoder takes ~ms per packet). Without
/// this, replay bursts all 60 objects at QUIC line rate and the relay's
/// per-subscriber stream-creation can't keep up after a track switch — see
/// the relay's `Send stream not found` retry path.
const REPLAY_INTER_OBJECT_DELAY: Duration = Duration::from_millis(2);

#[tokio::main]
async fn main() -> Result<()> {
  init_logging();

  let cli = Cli::parse();
  ffmpeg_next::init().expect("failed to initialize ffmpeg");

  match cli.encoded_dir.clone() {
    None => run_live(cli).await,
    Some(dir) if cache::is_complete(&dir) => run_replay(cli, dir).await,
    Some(dir) => run_prepare(cli, dir).await,
  }
}

// ── LIVE MODE ────────────────────────────────────────────────────────────────

async fn run_live(cli: Cli) -> Result<()> {
  let hw_encoder = encoder::detect_hardware_encoder();
  let video_info = video::get_video_info(&cli.video_path).await?;
  info!(
    "Source: {}x{} @ {:.2} fps",
    video_info.width, video_info.height, video_info.framerate
  );
  info!("Catalog target latency: {} ms", cli.target_latency_ms);

  let variants = adaptive::quality_variants(&video_info, cli.max_variants as usize)?;
  log_variants(&variants);

  let extras = collect_extradata(&variants, video_info.framerate, hw_encoder.as_ref()).await?;
  let catalog_tracks = build_catalog_tracks(
    &variants,
    &extras,
    video_info.framerate,
    cli.target_latency_ms,
  );
  let catalog_json = catalog::build_catalog_json(&catalog_tracks)?;
  info!("Catalog JSON built ({} bytes)", catalog_json.len());

  let mut moq = MoqConnection::establish(&cli.endpoint, cli.validate_cert).await?;
  let track_aliases =
    publish_all_tracks(&mut moq, &cli.namespace, &variants, &catalog_json).await?;

  let cancel = CancellationToken::new();
  let mut tasks: Vec<JoinHandle<Result<()>>> = Vec::new();
  tasks.push(spawn_catalog_refresh(
    moq.connection.clone(),
    catalog_json.clone(),
    cancel.clone(),
  ));

  let (raw_txs, mut raw_rxs) = make_raw_channels(variants.len());

  let emit_barrier = Arc::new(Barrier::new(variants.len()));
  let variant_count = variants.len();
  for (i, variant) in variants.into_iter().enumerate() {
    let track_alias = track_aliases[i];
    let publisher_priority = (variant_count as u8).saturating_sub(i as u8);
    let conn = moq.connection.clone();
    let raw_rx = raw_rxs.remove(0);
    let cancel_v = cancel.clone();
    let hw = hw_encoder.clone();
    let barrier = emit_barrier.clone();
    let source_w = video_info.width as u32;
    let source_h = video_info.height as u32;
    let framerate = video_info.framerate;

    tasks.push(tokio::spawn(async move {
      run_live_variant(
        variant,
        source_w,
        source_h,
        framerate,
        hw,
        conn,
        track_alias,
        publisher_priority,
        raw_rx,
        barrier,
        cancel_v,
      )
      .await
    }));
  }

  let video_path = cli.video_path.clone();
  let framerate = video_info.framerate;
  let cancel_for_decoder = cancel.clone();
  tasks.push(tokio::spawn(async move {
    tokio::select! {
      result = decoder::decode(video_path, framerate, raw_txs, false) => {
        if let Err(ref e) = result {
          error!("Decoder failed: {:?}", e);
          cancel_for_decoder.cancel();
        }
        result
      }
      _ = cancel_for_decoder.cancelled() => {
        info!("Decoder cancelled");
        Ok(())
      }
    }
  }));

  for task in tasks {
    task.await??;
  }

  info!("All pipelines finished, closing connection...");
  moq.connection.close(0u32.into(), b"Done");
  Ok(())
}

async fn run_live_variant(
  variant: adaptive::QualityVariant,
  source_w: u32,
  source_h: u32,
  framerate: f64,
  hw: Option<HardwareEncoder>,
  conn: Arc<wtransport::Connection>,
  track_alias: u64,
  publisher_priority: u8,
  raw_rx: mpsc::Receiver<decoder::RawGop>,
  emit_barrier: Arc<Barrier>,
  cancel: CancellationToken,
) -> Result<()> {
  let (scaled_tx, scaled_rx) = mpsc::channel(1);
  let (gop_tx, gop_rx) = mpsc::channel(1);

  info!(
    "Starting pipeline: {} (alias={}, priority={})",
    variant.quality, track_alias, publisher_priority
  );

  let scale_handle = tokio::spawn(scaler::scale(
    source_w,
    source_h,
    variant.width,
    variant.height,
    raw_rx,
    scaled_tx,
  ));
  let encode_handle = tokio::spawn(encoder::encode(
    framerate,
    variant.width as u32,
    variant.height as u32,
    variant.bitrate_kbps,
    hw,
    scaled_rx,
    gop_tx,
  ));
  let send_handle = tokio::spawn(sender::send_track(
    conn,
    track_alias,
    variant.quality.to_string(),
    publisher_priority,
    gop_rx,
    emit_barrier,
    None,
  ));

  let (sr, er, sd) = tokio::join!(scale_handle, encode_handle, send_handle);
  let result = (|| {
    sr??;
    er??;
    sd??;
    Ok::<(), anyhow::Error>(())
  })();

  if let Err(ref e) = result {
    error!("Live pipeline {}: {:?}", variant.quality, e);
    cancel.cancel();
  }
  result
}

// ── PREPARE MODE ─────────────────────────────────────────────────────────────

async fn run_prepare(cli: Cli, encoded_dir: PathBuf) -> Result<()> {
  std::fs::create_dir_all(&encoded_dir)
    .with_context(|| format!("create cache dir {}", encoded_dir.display()))?;
  info!(
    "Prepare mode: populating cache at {} from {}",
    encoded_dir.display(),
    cli.video_path
  );

  let hw_encoder = encoder::detect_hardware_encoder();
  let video_info = video::get_video_info(&cli.video_path).await?;
  info!(
    "Source: {}x{} @ {:.2} fps",
    video_info.width, video_info.height, video_info.framerate
  );

  let variants = adaptive::quality_variants(&video_info, cli.max_variants as usize)?;
  log_variants(&variants);

  let extras = collect_extradata(&variants, video_info.framerate, hw_encoder.as_ref()).await?;

  // Write per-variant metadata up front (deterministic; doesn't depend on encoded GOPs).
  for (variant, extra) in variants.iter().zip(extras.iter()) {
    let dir = cache::variant_dir(&encoded_dir, &variant.quality.to_string());
    let codec = catalog::codec_string_from_extradata(extra);
    let meta = cache::VariantMeta {
      quality: variant.quality.to_string(),
      width: variant.width,
      height: variant.height,
      bitrate_kbps: variant.bitrate_kbps,
      framerate: video_info.framerate,
      codec,
      extradata: extra.clone(),
    };
    cache::write_variant_meta(&dir, &meta)?;
  }

  let cancel = CancellationToken::new();
  let (raw_txs, mut raw_rxs) = make_raw_channels(variants.len());

  let mut variant_handles: Vec<JoinHandle<Result<u64>>> = Vec::with_capacity(variants.len());
  for variant in variants.iter().cloned() {
    let raw_rx = raw_rxs.remove(0);
    let cancel_v = cancel.clone();
    let hw = hw_encoder.clone();
    let source_w = video_info.width as u32;
    let source_h = video_info.height as u32;
    let framerate = video_info.framerate;
    let variant_dir = cache::variant_dir(&encoded_dir, &variant.quality.to_string());

    variant_handles.push(tokio::spawn(async move {
      run_prepare_variant(
        variant,
        source_w,
        source_h,
        framerate,
        hw,
        variant_dir,
        raw_rx,
        cancel_v,
      )
      .await
    }));
  }

  let video_path = cli.video_path.clone();
  let framerate = video_info.framerate;
  let cancel_for_decoder = cancel.clone();
  let decode_handle: JoinHandle<Result<()>> = tokio::spawn(async move {
    tokio::select! {
      result = decoder::decode(video_path, framerate, raw_txs, true) => {
        if let Err(ref e) = result {
          error!("Decoder failed: {:?}", e);
          cancel_for_decoder.cancel();
        }
        result
      }
      _ = cancel_for_decoder.cancelled() => {
        info!("Decoder cancelled");
        Ok(())
      }
    }
  });

  decode_handle.await??;

  let mut counts: Vec<u64> = Vec::with_capacity(variant_handles.len());
  for handle in variant_handles {
    counts.push(handle.await??);
  }

  let first = counts[0];
  if !counts.iter().all(|&c| c == first) {
    anyhow::bail!(
      "Prepare: variants emitted different GOP counts {:?} (cache would be inconsistent)",
      counts
    );
  }

  let top_meta = cache::TopMeta {
    schema_version: cache::SCHEMA_VERSION,
    source_width: video_info.width,
    source_height: video_info.height,
    framerate: video_info.framerate,
    target_latency_ms: cli.target_latency_ms,
    variants: variants.iter().map(|v| v.quality.to_string()).collect(),
    gops_per_variant: first,
  };
  cache::write_top_meta_atomic(&encoded_dir, &top_meta)?;

  info!(
    "Cache prepared at {} ({} GOPs/variant). Re-run the same command to start replaying.",
    encoded_dir.display(),
    first
  );
  Ok(())
}

async fn run_prepare_variant(
  variant: adaptive::QualityVariant,
  source_w: u32,
  source_h: u32,
  framerate: f64,
  hw: Option<HardwareEncoder>,
  variant_dir: PathBuf,
  raw_rx: mpsc::Receiver<decoder::RawGop>,
  cancel: CancellationToken,
) -> Result<u64> {
  let (scaled_tx, scaled_rx) = mpsc::channel(1);
  let (gop_tx, gop_rx) = mpsc::channel(1);

  info!(
    "Starting prepare pipeline: {} -> {}",
    variant.quality,
    variant_dir.display()
  );

  let scale_handle = tokio::spawn(scaler::scale(
    source_w,
    source_h,
    variant.width,
    variant.height,
    raw_rx,
    scaled_tx,
  ));
  let encode_handle = tokio::spawn(encoder::encode(
    framerate,
    variant.width as u32,
    variant.height as u32,
    variant.bitrate_kbps,
    hw,
    scaled_rx,
    gop_tx,
  ));
  let writer_handle: JoinHandle<Result<u64>> = tokio::spawn(cache_writer(variant_dir, gop_rx));

  let (sr, er, wr) = tokio::join!(scale_handle, encode_handle, writer_handle);
  let result = (|| {
    sr??;
    er??;
    let count = wr??;
    Ok::<u64, anyhow::Error>(count)
  })();

  if let Err(ref e) = result {
    error!("Prepare pipeline {}: {:?}", variant.quality, e);
    cancel.cancel();
  }
  result
}

async fn cache_writer(variant_dir: PathBuf, mut rx: mpsc::Receiver<EncodedGop>) -> Result<u64> {
  let mut idx: u64 = 0;
  while let Some(gop) = rx.recv().await {
    let path = cache::gop_path(&variant_dir, idx);
    let path_for_task = path.clone();
    tokio::task::spawn_blocking(move || cache::write_gop(&path_for_task, &gop))
      .await
      .map_err(|e| anyhow::anyhow!("cache_writer task panicked at {}: {}", path.display(), e))??;
    idx += 1;
  }
  Ok(idx)
}

// ── REPLAY MODE ──────────────────────────────────────────────────────────────

async fn run_replay(cli: Cli, encoded_dir: PathBuf) -> Result<()> {
  info!("Replay mode: streaming from {}", encoded_dir.display());

  let top_meta = cache::read_top_meta(&encoded_dir)?;
  info!(
    "Cache: {}x{} @ {:.2} fps, {} variants, {} GOPs/variant",
    top_meta.source_width,
    top_meta.source_height,
    top_meta.framerate,
    top_meta.variants.len(),
    top_meta.gops_per_variant
  );

  // Validate the cached variant set against the current invocation's request.
  let synth_video_info = video::VideoInfo {
    width: top_meta.source_width,
    height: top_meta.source_height,
    framerate: top_meta.framerate,
  };
  let expected_variants = adaptive::quality_variants(&synth_video_info, cli.max_variants as usize)?;
  let expected_qualities: Vec<String> = expected_variants
    .iter()
    .map(|v| v.quality.to_string())
    .collect();
  if top_meta.variants != expected_qualities {
    anyhow::bail!(
      "Cache variant set {:?} does not match current request (max_variants={}) which would produce {:?}; delete {} and re-prepare",
      top_meta.variants,
      cli.max_variants,
      expected_qualities,
      encoded_dir.display()
    );
  }

  // Read every variant's metadata from disk; sanity-check GOP file count.
  let mut variant_metas: Vec<cache::VariantMeta> = Vec::with_capacity(top_meta.variants.len());
  for q in &top_meta.variants {
    let dir = cache::variant_dir(&encoded_dir, q);
    let meta = cache::read_variant_meta(&dir)?;
    let on_disk = cache::gop_count(&dir)?;
    if on_disk != top_meta.gops_per_variant {
      anyhow::bail!(
        "Cache variant {} reports {} GOPs in {} but meta.json says {}; cache is inconsistent — delete and re-prepare",
        q,
        on_disk,
        dir.display(),
        top_meta.gops_per_variant
      );
    }
    variant_metas.push(meta);
  }

  // Rebuild catalog using persisted extradata.
  let catalog_tracks: Vec<catalog::CatalogTrack> = variant_metas
    .iter()
    .map(|vm| {
      let init_seg = catalog::build_init_segment(&vm.extradata, vm.width, vm.height);
      catalog::CatalogTrack {
        name: format!("video-{}", vm.quality),
        codec: vm.codec.clone(),
        width: vm.width,
        height: vm.height,
        bitrate_bps: vm.bitrate_kbps * 1000,
        framerate: vm.framerate,
        role: "video".to_owned(),
        target_latency_ms: cli.target_latency_ms,
        init_segment: init_seg,
      }
    })
    .collect();
  let catalog_json = catalog::build_catalog_json(&catalog_tracks)?;
  info!(
    "Catalog JSON built from cache ({} bytes)",
    catalog_json.len()
  );

  let mut moq = MoqConnection::establish(&cli.endpoint, cli.validate_cert).await?;
  // Build a borrowed-variant view of the cache so publish_all_tracks works
  // without re-running quality_variants against the source video.
  let variants_for_publish: Vec<adaptive::QualityVariant> = variant_metas
    .iter()
    .zip(expected_variants.iter())
    .map(|(_vm, ev)| ev.clone())
    .collect();
  let track_aliases = publish_all_tracks(
    &mut moq,
    &cli.namespace,
    &variants_for_publish,
    &catalog_json,
  )
  .await?;

  let cancel = CancellationToken::new();
  let mut tasks: Vec<JoinHandle<Result<()>>> = Vec::new();
  tasks.push(spawn_catalog_refresh(
    moq.connection.clone(),
    catalog_json.clone(),
    cancel.clone(),
  ));

  let emit_barrier = Arc::new(Barrier::new(variant_metas.len()));
  let variant_count = variant_metas.len();
  let gop_duration_secs = top_meta.framerate.recip() * encoder::gop_size(top_meta.framerate) as f64;

  for (i, vm) in variant_metas.into_iter().enumerate() {
    let track_alias = track_aliases[i];
    let publisher_priority = (variant_count as u8).saturating_sub(i as u8);
    let conn = moq.connection.clone();
    let cancel_v = cancel.clone();
    let barrier = emit_barrier.clone();
    let variant_dir = cache::variant_dir(&encoded_dir, &vm.quality);
    let quality = vm.quality.clone();
    let gops_per_variant = top_meta.gops_per_variant;

    tasks.push(tokio::spawn(async move {
      run_replay_variant(
        quality,
        variant_dir,
        gops_per_variant,
        gop_duration_secs,
        conn,
        track_alias,
        publisher_priority,
        barrier,
        cancel_v,
      )
      .await
    }));
  }

  for task in tasks {
    task.await??;
  }

  info!("Replay finished, closing connection...");
  moq.connection.close(0u32.into(), b"Done");
  Ok(())
}

async fn run_replay_variant(
  quality: String,
  variant_dir: PathBuf,
  gops_per_variant: u64,
  gop_duration_secs: f64,
  conn: Arc<wtransport::Connection>,
  track_alias: u64,
  publisher_priority: u8,
  emit_barrier: Arc<Barrier>,
  cancel: CancellationToken,
) -> Result<()> {
  let (gop_tx, gop_rx) = mpsc::channel(1);

  info!(
    "Starting replay: {} (alias={}, priority={})",
    quality, track_alias, publisher_priority
  );

  let read_handle = tokio::spawn(replay::replay_variant(
    variant_dir,
    gops_per_variant,
    gop_duration_secs,
    quality.clone(),
    gop_tx,
  ));
  let send_handle = tokio::spawn(sender::send_track(
    conn,
    track_alias,
    quality.clone(),
    publisher_priority,
    gop_rx,
    emit_barrier,
    Some(REPLAY_INTER_OBJECT_DELAY),
  ));

  let (rr, sr) = tokio::join!(read_handle, send_handle);
  let result = (|| {
    rr??;
    sr??;
    Ok::<(), anyhow::Error>(())
  })();
  if let Err(ref e) = result {
    error!("Replay pipeline {}: {:?}", quality, e);
    cancel.cancel();
  }
  result
}

// ── shared helpers ───────────────────────────────────────────────────────────

fn log_variants(variants: &[adaptive::QualityVariant]) {
  info!("{} adaptive variants", variants.len());
  for v in variants {
    info!(
      "  {} — {}x{} @ {} kbps (CBR/HEVC)",
      v.quality, v.width, v.height, v.bitrate_kbps
    );
  }
}

/// Probes the encoder once per variant and returns each variant's HEVC
/// extradata (HVCC). Same logic both live and prepare modes use to seed the
/// catalog's init segment; replay mode reads the cached value instead.
async fn collect_extradata(
  variants: &[adaptive::QualityVariant],
  framerate: f64,
  hw_encoder: Option<&HardwareEncoder>,
) -> Result<Vec<Bytes>> {
  info!(
    "Probing encoder extradata for {} variants...",
    variants.len()
  );
  let mut out = Vec::with_capacity(variants.len());
  for v in variants {
    let extra = encoder::get_extradata(
      framerate,
      v.width as u32,
      v.height as u32,
      v.bitrate_kbps,
      hw_encoder.cloned(),
    )
    .await?;
    out.push(extra);
  }
  Ok(out)
}

fn build_catalog_tracks(
  variants: &[adaptive::QualityVariant],
  extras: &[Bytes],
  framerate: f64,
  target_latency_ms: u32,
) -> Vec<catalog::CatalogTrack> {
  variants
    .iter()
    .zip(extras.iter())
    .map(|(v, extra)| {
      let init_seg = catalog::build_init_segment(extra, v.width, v.height);
      let codec = catalog::codec_string_from_extradata(extra);
      catalog::CatalogTrack {
        name: format!("video-{}", v.quality),
        codec,
        width: v.width,
        height: v.height,
        bitrate_bps: v.bitrate_kbps * 1000,
        framerate,
        role: "video".to_owned(),
        target_latency_ms,
        init_segment: init_seg,
      }
    })
    .collect()
}

async fn publish_all_tracks(
  moq: &mut MoqConnection,
  namespace: &str,
  variants: &[adaptive::QualityVariant],
  catalog_json: &Bytes,
) -> Result<Vec<u64>> {
  moq
    .publish_track(namespace, "catalog", CATALOG_ALIAS)
    .await?;
  moq
    .send_catalog_object(CATALOG_ALIAS, 0, catalog_json.clone())
    .await?;
  info!("Catalog track published and object sent");

  let mut aliases = Vec::with_capacity(variants.len());
  for (i, v) in variants.iter().enumerate() {
    let track_name = format!("video-{}", v.quality);
    let track_alias = (i as u64) + 1;
    moq
      .publish_track(namespace, &track_name, track_alias)
      .await?;
    aliases.push(track_alias);
  }
  info!("All {} tracks published", aliases.len());
  Ok(aliases)
}

fn spawn_catalog_refresh(
  conn: Arc<wtransport::Connection>,
  catalog_json: Bytes,
  cancel: CancellationToken,
) -> JoinHandle<Result<()>> {
  tokio::spawn(async move {
    let mut group_id: u64 = 1;
    loop {
      tokio::select! {
        _ = tokio::time::sleep(tokio::time::Duration::from_secs(2)) => {
          if let Err(e) = MoqConnection::send_catalog_object_static(
            &conn, CATALOG_ALIAS, group_id, catalog_json.clone()
          ).await {
            tracing::warn!("Catalog refresh (group {}): {:#}", group_id, e);
          }
          group_id += 1;
        }
        _ = cancel.cancelled() => {
          info!("Catalog refresh task cancelled");
          break;
        }
      }
    }
    Ok::<(), anyhow::Error>(())
  })
}

fn make_raw_channels(
  count: usize,
) -> (
  Vec<mpsc::Sender<decoder::RawGop>>,
  Vec<mpsc::Receiver<decoder::RawGop>>,
) {
  let mut txs = Vec::with_capacity(count);
  let mut rxs = Vec::with_capacity(count);
  for _ in 0..count {
    let (tx, rx) = mpsc::channel(1);
    txs.push(tx);
    rxs.push(rx);
  }
  (txs, rxs)
}

fn init_logging() {
  let env_filter = EnvFilter::builder()
    .with_default_directive(LevelFilter::INFO.into())
    .from_env_lossy();

  tracing_subscriber::fmt()
    .with_target(true)
    .with_level(true)
    .with_env_filter(env_filter)
    .init();
}
