use anyhow::{Context, Result};
use bytes::Bytes;
use ffmpeg_next::codec::encoder;
use ffmpeg_next::format::Pixel;
use tracing::{info, warn};

use crate::cmaf;
use crate::scaler::ScaledGop;
use crate::video::{yuv420p_to_nv12_frame, yuv420p_to_video_frame};

/// GOP size in frames so that each GOP holds exactly 1 second of video.
pub fn gop_size(framerate: f64) -> u32 {
  framerate.ceil() as u32
}

/// A single encoded GOP (Group of Pictures), representing one second of video.
/// Each GOP maps to one MoQ group.
#[derive(Debug)]
pub struct EncodedGop {
  pub group_id: u64,
  /// Encoded HEVC packets in display order, one per input frame.
  pub packets: Vec<Bytes>,
}

/// Hardware encoder type detected on the system.
#[derive(Debug, Clone)]
pub enum HardwareEncoder {
  Nvenc,         // NVIDIA NVENC
  Amf,           // AMD AMF (Windows)
  Qsv,           // Intel Quick Sync Video
  Vaapi(String), // VA-API (AMD/Intel on Linux) — carries the render device path
  VideoToolbox,  // Apple VideoToolbox
}

// ── RAII helpers ────────────────────────────────────────────────────────────

/// Owns an AVBufferRef* and unrefs it on drop.
struct AvBufRef(*mut ffmpeg_next::sys::AVBufferRef);
unsafe impl Send for AvBufRef {}
impl Drop for AvBufRef {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { ffmpeg_next::sys::av_buffer_unref(&mut self.0) };
    }
  }
}

/// Owns an AVFrame* and frees it on drop.
struct AvFramePtr(*mut ffmpeg_next::sys::AVFrame);
impl Drop for AvFramePtr {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { ffmpeg_next::sys::av_frame_free(&mut self.0) };
    }
  }
}

// ── Hardware detection ───────────────────────────────────────────────────────

/// Returns the first /dev/dri/renderD* node that exists.
fn find_vaapi_device() -> Option<String> {
  (128..=135u32)
    .map(|i| format!("/dev/dri/renderD{}", i))
    .find(|p| std::path::Path::new(p).exists())
}

/// Creates a VAAPI device context for the given render node.
/// Returns the owned buffer ref on success.
fn create_vaapi_device(device_path: &str) -> Option<AvBufRef> {
  unsafe {
    let mut raw: *mut ffmpeg_next::sys::AVBufferRef = std::ptr::null_mut();
    let c_path = std::ffi::CString::new(device_path).unwrap();
    let ret = ffmpeg_next::sys::av_hwdevice_ctx_create(
      &mut raw,
      ffmpeg_next::sys::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI,
      c_path.as_ptr(),
      std::ptr::null_mut(),
      0,
    );
    if ret < 0 || raw.is_null() {
      warn!("VAAPI: failed to open device {}: err={}", device_path, ret);
      return None;
    }
    Some(AvBufRef(raw))
  }
}

/// Creates and initialises a VAAPI hardware frames context for the given
/// device context and resolution. AMD VAAPI requires NV12 surfaces for HEVC
/// encoding — YUV420P sw_format creates surfaces the driver rejects at encode
/// time with VA_STATUS_ERROR_INVALID_SURFACE.
fn create_vaapi_frames_ctx(
  device_ctx: *mut ffmpeg_next::sys::AVBufferRef,
  width: u32,
  height: u32,
  pool_size: i32,
) -> Option<AvBufRef> {
  unsafe {
    let raw = ffmpeg_next::sys::av_hwframe_ctx_alloc(device_ctx);
    if raw.is_null() {
      return None;
    }
    let fc = (*raw).data as *mut ffmpeg_next::sys::AVHWFramesContext;
    (*fc).format = ffmpeg_next::sys::AVPixelFormat::AV_PIX_FMT_VAAPI;
    (*fc).sw_format = ffmpeg_next::sys::AVPixelFormat::AV_PIX_FMT_NV12;
    (*fc).width = width as i32;
    (*fc).height = height as i32;
    (*fc).initial_pool_size = pool_size;

    let ret = ffmpeg_next::sys::av_hwframe_ctx_init(raw);
    if ret < 0 {
      let mut r = raw;
      ffmpeg_next::sys::av_buffer_unref(&mut r);
      warn!("VAAPI: av_hwframe_ctx_init failed: {}", ret);
      return None;
    }
    Some(AvBufRef(raw))
  }
}

/// Full VAAPI probe: opens a real hw device + frames context and attempts to
/// open hevc_vaapi. The simple probe_encoder() path fails for VAAPI because it
/// uses YUV420P — VAAPI requires the vaapi pixel format and a hw_frames_ctx.
fn probe_vaapi(device_path: &str) -> bool {
  let Some(dev) = create_vaapi_device(device_path) else {
    return false;
  };
  let Some(frames) = create_vaapi_frames_ctx(dev.0, 320, 240, 4) else {
    return false;
  };

  let Some(codec) = ffmpeg_next::encoder::find_by_name("hevc_vaapi") else {
    return false;
  };
  let Ok(mut enc) = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()
  else {
    return false;
  };

  enc.set_width(320);
  enc.set_height(240);
  enc.set_format(Pixel::VAAPI);
  enc.set_time_base((1, 30));
  enc.set_bit_rate(500_000);
  unsafe { (*enc.as_mut_ptr()).hw_frames_ctx = ffmpeg_next::sys::av_buffer_ref(frames.0) };

  let opts = build_encoder_opts("hevc_vaapi", 500);
  let ok = enc.open_with(opts).is_ok();
  if ok {
    info!("VAAPI: hevc_vaapi probe succeeded on {}", device_path);
  } else {
    warn!("VAAPI: hevc_vaapi probe failed on {}", device_path);
  }
  ok
}

/// Simple probe for non-VAAPI hardware encoders. Uses YUV420P which works for
/// NVENC, AMF, QSV, and VideoToolbox but NOT for VAAPI.
fn probe_encoder(encoder_name: &str) -> bool {
  let codec = match ffmpeg_next::encoder::find_by_name(encoder_name) {
    Some(c) => c,
    None => return false,
  };

  let Ok(mut enc) = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()
  else {
    return false;
  };

  enc.set_width(320);
  enc.set_height(240);
  enc.set_format(Pixel::YUV420P);
  enc.set_time_base((1, 30));
  enc.set_bit_rate(500_000);

  let opts = build_encoder_opts(encoder_name, 500);
  match enc.open_with(opts) {
    Ok(_) => {
      info!("Hardware encoder probe succeeded: {}", encoder_name);
      true
    }
    Err(e) => {
      warn!(
        "Hardware encoder '{}' registered but failed to open (hardware unavailable?): {}",
        encoder_name, e
      );
      false
    }
  }
}

/// Detects available HEVC hardware encoders, preferring NVIDIA > AMD AMF >
/// Intel QSV > VA-API > Apple VideoToolbox.
/// Call this ONCE at startup and share the result across all encoder pipelines.
pub fn detect_hardware_encoder() -> Option<HardwareEncoder> {
  for (name, variant) in [
    ("hevc_nvenc", HardwareEncoder::Nvenc),
    ("hevc_amf", HardwareEncoder::Amf),
    ("hevc_qsv", HardwareEncoder::Qsv),
    ("hevc_videotoolbox", HardwareEncoder::VideoToolbox),
  ] {
    if probe_encoder(name) {
      return Some(variant);
    }
  }

  // VAAPI requires a hardware device context for probing — handle separately.
  if let Some(device) = find_vaapi_device()
    && probe_vaapi(&device)
  {
    return Some(HardwareEncoder::Vaapi(device));
  }

  None
}

// ── Extradata (SPS/PPS) extraction ──────────────────────────────────────────

/// Opens an encoder with the given parameters, reads `extradata` (HVCC record),
/// then immediately closes it. Returns the raw HVCC bytes needed to build an
/// MP4 init segment. Falls back to a zero-length slice if the encoder provides
/// no extradata (should not happen for any HEVC encoder).
pub async fn get_extradata(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  hw_encoder: Option<HardwareEncoder>,
) -> Result<bytes::Bytes> {
  tokio::task::spawn_blocking(move || {
    get_extradata_blocking(framerate, width, height, bitrate_kbps, hw_encoder)
  })
  .await
  .context("get_extradata task panicked")?
}

fn get_extradata_blocking(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  hw_encoder: Option<HardwareEncoder>,
) -> Result<bytes::Bytes> {
  if let Some(HardwareEncoder::Vaapi(ref device_path)) = hw_encoder {
    return get_extradata_vaapi(framerate, width, height, bitrate_kbps, device_path);
  }

  let encoder_name = encoder_name_for(hw_encoder.as_ref());
  let codec = ffmpeg_next::encoder::find_by_name(encoder_name)
    .with_context(|| format!("encoder '{}' not found", encoder_name))?;

  let mut enc = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()?;

  enc.set_width(width);
  enc.set_height(height);
  enc.set_format(Pixel::YUV420P);
  enc.set_time_base((1, framerate.ceil() as i32));

  let bitrate_bps = (bitrate_kbps as i64) * 1000;
  enc.set_bit_rate(bitrate_bps as usize);
  enc.set_max_bit_rate(bitrate_bps as usize);
  enc.set_gop(gop_size(framerate));
  unsafe {
    (*enc.as_mut_ptr()).flags |= 0x00400000; // AV_CODEC_FLAG_GLOBAL_HEADER
  }

  info!(
    "get_extradata: opening encoder '{}' for {}x{} (flags={:#010X})",
    encoder_name,
    width,
    height,
    unsafe { (*enc.as_ptr()).flags }
  );

  let opts = build_encoder_opts(encoder_name, bitrate_kbps);
  let opened = enc.open_with(opts)?;

  read_extradata(&opened, encoder_name)
}

fn get_extradata_vaapi(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  device_path: &str,
) -> Result<bytes::Bytes> {
  let dev = create_vaapi_device(device_path)
    .context("VAAPI: failed to create device context for extradata")?;
  let frames = create_vaapi_frames_ctx(dev.0, width, height, 4)
    .context("VAAPI: failed to create frames context for extradata")?;

  let codec =
    ffmpeg_next::encoder::find_by_name("hevc_vaapi").context("hevc_vaapi encoder not found")?;
  let mut enc = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()?;

  enc.set_width(width);
  enc.set_height(height);
  enc.set_format(Pixel::VAAPI);
  enc.set_time_base((1, framerate.ceil() as i32));
  let bitrate_bps = (bitrate_kbps as i64) * 1000;
  enc.set_bit_rate(bitrate_bps as usize);
  enc.set_max_bit_rate(bitrate_bps as usize);
  enc.set_gop(gop_size(framerate));
  unsafe {
    (*enc.as_mut_ptr()).flags |= 0x00400000; // AV_CODEC_FLAG_GLOBAL_HEADER
    (*enc.as_mut_ptr()).hw_frames_ctx = ffmpeg_next::sys::av_buffer_ref(frames.0);
  }

  info!(
    "get_extradata: opening encoder 'hevc_vaapi' for {}x{}",
    width, height
  );

  let opts = build_encoder_opts("hevc_vaapi", bitrate_kbps);
  let opened = enc.open_with(opts)?;
  read_extradata(&opened, "hevc_vaapi")
}

fn read_extradata(opened: &encoder::Video, encoder_name: &str) -> Result<bytes::Bytes> {
  let extra: bytes::Bytes = unsafe {
    let ctx = opened.as_ptr();
    let ptr = (*ctx).extradata;
    let size = (*ctx).extradata_size as usize;
    if ptr.is_null() || size == 0 {
      bytes::Bytes::new()
    } else {
      bytes::Bytes::copy_from_slice(std::slice::from_raw_parts(ptr, size))
    }
  };

  if extra.len() >= 4 {
    let hex_preview: String = extra
      .iter()
      .take(16)
      .map(|b| format!("{:02X}", b))
      .collect::<Vec<_>>()
      .join(" ");
    info!(
      "Extradata: {} bytes, first bytes=[{}], profile={:#04X} compat={:#04X} level={:#04X} (encoder={})",
      extra.len(),
      hex_preview,
      extra[1],
      extra[2],
      extra[3],
      encoder_name
    );
  } else {
    warn!(
      "Extradata is only {} bytes (expected ≥4) from encoder {}",
      extra.len(),
      encoder_name
    );
  }

  Ok(extra)
}

// ── Encoding ─────────────────────────────────────────────────────────────────

/// Returns the encoder codec name for the detected hardware (or software fallback).
fn encoder_name_for(hw_encoder: Option<&HardwareEncoder>) -> &'static str {
  match hw_encoder {
    Some(HardwareEncoder::Nvenc) => "hevc_nvenc",
    Some(HardwareEncoder::Amf) => "hevc_amf",
    Some(HardwareEncoder::Qsv) => "hevc_qsv",
    Some(HardwareEncoder::Vaapi(_)) => "hevc_vaapi",
    Some(HardwareEncoder::VideoToolbox) => "hevc_videotoolbox",
    None => "libx265",
  }
}

/// Builds the encoder option dictionary for the given encoder and bitrate.
fn build_encoder_opts(encoder_name: &str, bitrate_kbps: u32) -> ffmpeg_next::Dictionary<'_> {
  let mut opts = ffmpeg_next::Dictionary::new();
  let vbv_bufsize = bitrate_kbps * 2;
  let vbv_maxrate = bitrate_kbps;

  if encoder_name == "libx265" {
    opts.set("preset", "medium");
    opts.set("tune", "zerolatency");
    opts.set("profile", "main");
    opts.set(
      "x265-params",
      &format!(
        "scenecut=0:open-gop=0:bframes=0:rc-lookahead=0:vbv-bufsize={vbv_bufsize}:vbv-maxrate={vbv_maxrate}:pools=4:frame-threads=1"
      ),
    );
  } else if encoder_name == "hevc_nvenc" {
    opts.set("preset", "p4");
    opts.set("tune", "ll");
    opts.set("rc", "cbr");
    opts.set("cbr", "1");
    opts.set("bf", "0");
    opts.set("forced-idr", "1");
    opts.set("strict_gop", "1");
  } else if encoder_name == "hevc_amf" {
    opts.set("usage", "ultralowlatency");
    opts.set("quality", "speed");
    opts.set("rc", "cbr");
    opts.set("bf", "0");
    opts.set("enforce_hrd", "1");
  } else if encoder_name == "hevc_qsv" {
    opts.set("preset", "medium");
    opts.set("look_ahead", "0");
    opts.set("async_depth", "1");
    opts.set("rc_mode", "cbr");
    opts.set("bf", "0");
  } else if encoder_name == "hevc_vaapi" {
    opts.set("rc_mode", "CBR");
    opts.set("bf", "0");
  } else if encoder_name == "hevc_videotoolbox" {
    opts.set("realtime", "1");
    opts.set("profile", "main");
    opts.set("allow_sw", "0");
  }

  opts
}

pub async fn encode(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  hw_encoder: Option<HardwareEncoder>,
  mut scaled_rx: tokio::sync::mpsc::Receiver<ScaledGop>,
  on_gop: tokio::sync::mpsc::Sender<EncodedGop>,
) -> Result<()> {
  tokio::task::spawn_blocking(move || {
    encode_blocking(
      framerate,
      width,
      height,
      bitrate_kbps,
      hw_encoder,
      &mut scaled_rx,
      &on_gop,
    )
  })
  .await
  .context("encoder task panicked")?
}

fn encode_blocking(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  hw_encoder: Option<HardwareEncoder>,
  scaled_rx: &mut tokio::sync::mpsc::Receiver<ScaledGop>,
  on_gop: &tokio::sync::mpsc::Sender<EncodedGop>,
) -> Result<()> {
  if let Some(HardwareEncoder::Vaapi(ref device_path)) = hw_encoder {
    return encode_blocking_vaapi(
      framerate,
      width,
      height,
      bitrate_kbps,
      device_path,
      scaled_rx,
      on_gop,
    );
  }

  let encoder_name = encoder_name_for(hw_encoder.as_ref());

  match &hw_encoder {
    Some(HardwareEncoder::Nvenc) => info!("Using NVIDIA NVENC HEVC hardware encoder"),
    Some(HardwareEncoder::Amf) => info!("Using AMD AMF HEVC hardware encoder"),
    Some(HardwareEncoder::Qsv) => info!("Using Intel QSV HEVC hardware encoder"),
    Some(HardwareEncoder::Vaapi(_)) => unreachable!("dispatched above"),
    Some(HardwareEncoder::VideoToolbox) => info!("Using Apple VideoToolbox HEVC hardware encoder"),
    None => info!("No hardware encoder detected, using software libx265"),
  }

  info!(
    "Encoder: {}x{} @ {:.2} fps, {} kbps CBR (HEVC/{})",
    width, height, framerate, bitrate_kbps, encoder_name
  );

  let codec = ffmpeg_next::encoder::find_by_name(encoder_name)
    .with_context(|| format!("encoder '{}' not found", encoder_name))?;

  let mut encoder = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()?;

  encoder.set_width(width);
  encoder.set_height(height);
  encoder.set_format(Pixel::YUV420P);
  encoder.set_time_base((1, framerate.ceil() as i32));

  let bitrate_bps = (bitrate_kbps as i64) * 1000;
  encoder.set_bit_rate(bitrate_bps as usize);
  encoder.set_max_bit_rate(bitrate_bps as usize);
  encoder.set_gop(gop_size(framerate));
  unsafe {
    (*encoder.as_mut_ptr()).flags |= 0x00400000; // AV_CODEC_FLAG_GLOBAL_HEADER
  }

  let opts = build_encoder_opts(encoder_name, bitrate_kbps);
  let mut encoder = encoder.open_with(opts)?;

  run_encode_loop(
    &mut encoder,
    framerate,
    width,
    height,
    scaled_rx,
    on_gop,
    |enc, gop, seq| encode_gop_sw(enc, gop, width, height, framerate, seq),
  )
}

// ── VAAPI encode path ────────────────────────────────────────────────────────

fn encode_blocking_vaapi(
  framerate: f64,
  width: u32,
  height: u32,
  bitrate_kbps: u32,
  device_path: &str,
  scaled_rx: &mut tokio::sync::mpsc::Receiver<ScaledGop>,
  on_gop: &tokio::sync::mpsc::Sender<EncodedGop>,
) -> Result<()> {
  info!(
    "Using VA-API HEVC hardware encoder on {} ({}x{} @ {:.2} fps, {} kbps)",
    device_path, width, height, framerate, bitrate_kbps
  );

  let dev = create_vaapi_device(device_path).context("VAAPI: device context creation failed")?;
  let frames = create_vaapi_frames_ctx(dev.0, width, height, 8)
    .context("VAAPI: frames context creation failed")?;

  let codec =
    ffmpeg_next::encoder::find_by_name("hevc_vaapi").context("hevc_vaapi encoder not found")?;
  let mut encoder_ctx = ffmpeg_next::codec::Context::new_with_codec(codec)
    .encoder()
    .video()?;

  encoder_ctx.set_width(width);
  encoder_ctx.set_height(height);
  encoder_ctx.set_format(Pixel::VAAPI);
  encoder_ctx.set_time_base((1, framerate.ceil() as i32));
  let bitrate_bps = (bitrate_kbps as i64) * 1000;
  encoder_ctx.set_bit_rate(bitrate_bps as usize);
  encoder_ctx.set_max_bit_rate(bitrate_bps as usize);
  encoder_ctx.set_gop(gop_size(framerate));

  unsafe {
    (*encoder_ctx.as_mut_ptr()).flags |= 0x00400000; // AV_CODEC_FLAG_GLOBAL_HEADER
    (*encoder_ctx.as_mut_ptr()).hw_frames_ctx = ffmpeg_next::sys::av_buffer_ref(frames.0);
  }

  let opts = build_encoder_opts("hevc_vaapi", bitrate_kbps);
  let mut encoder = encoder_ctx.open_with(opts)?;

  info!(
    "Encoder: {}x{} @ {:.2} fps, {} kbps CBR (HEVC/hevc_vaapi)",
    width, height, framerate, bitrate_kbps
  );

  // frames.0 is valid for the lifetime of `frames` which outlives the encode loop.
  let frames_ctx_raw = frames.0;

  run_encode_loop(
    &mut encoder,
    framerate,
    width,
    height,
    scaled_rx,
    on_gop,
    |enc, gop, seq| encode_gop_vaapi(enc, gop, width, height, framerate, frames_ctx_raw, seq),
  )
}

/// Uploads one YUV420P software frame to a VAAPI hardware surface and sends
/// it to the encoder via raw FFI (avcodec_send_frame).
fn upload_and_send_vaapi(
  encoder: &mut encoder::Video,
  sw_frame: &ffmpeg_next::frame::Video,
  frames_ctx: *mut ffmpeg_next::sys::AVBufferRef,
  global_frame: u64,
  is_keyframe: bool,
) -> Result<()> {
  unsafe {
    let hw = AvFramePtr(ffmpeg_next::sys::av_frame_alloc());
    anyhow::ensure!(!hw.0.is_null(), "av_frame_alloc failed");

    let ret = ffmpeg_next::sys::av_hwframe_get_buffer(frames_ctx, hw.0, 0);
    anyhow::ensure!(ret >= 0, "av_hwframe_get_buffer failed: {}", ret);

    let ret = ffmpeg_next::sys::av_hwframe_transfer_data(hw.0, sw_frame.as_ptr() as *mut _, 0);
    anyhow::ensure!(ret >= 0, "av_hwframe_transfer_data failed: {}", ret);

    (*hw.0).pts = global_frame as i64;
    if is_keyframe {
      (*hw.0).pict_type = ffmpeg_next::sys::AVPictureType::AV_PICTURE_TYPE_I;
    }

    let ret = ffmpeg_next::sys::avcodec_send_frame(encoder.as_mut_ptr(), hw.0);
    anyhow::ensure!(ret >= 0, "avcodec_send_frame (VAAPI) failed: {}", ret);
    Ok(())
  }
}

fn encode_gop_vaapi(
  encoder: &mut encoder::Video,
  gop: &ScaledGop,
  width: u32,
  height: u32,
  framerate: f64,
  frames_ctx: *mut ffmpeg_next::sys::AVBufferRef,
  sequence_number: &mut u32,
) -> Result<EncodedGop> {
  let gop_frames = gop_size(framerate) as u64;
  let sample_duration = (TIMESCALE as f64 / framerate).round() as u32;
  let mut encoded_packets = Vec::with_capacity(gop.frames.len());

  for (frame_idx, frame_data) in gop.frames.iter().enumerate() {
    // VAAPI frames context uses NV12 sw_format (required by AMD driver).
    // Convert packed YUV420P → NV12 before GPU upload.
    let sw_frame = yuv420p_to_nv12_frame(frame_data, width, height);
    let global_frame = gop.gop_id * gop_frames + frame_idx as u64;
    let is_keyframe = frame_idx == 0;

    upload_and_send_vaapi(encoder, &sw_frame, frames_ctx, global_frame, is_keyframe)?;

    let mut packet = ffmpeg_next::Packet::empty();
    while encoder.receive_packet(&mut packet).is_ok() {
      let raw = packet.data().unwrap_or(&[]);
      let hvcc_data = cmaf::annex_b_to_hvcc(raw);
      let decode_time = global_frame * sample_duration as u64;
      let chunk = cmaf::wrap_cmaf_chunk(
        *sequence_number,
        decode_time,
        sample_duration,
        is_keyframe,
        &hvcc_data,
      );
      *sequence_number += 1;
      encoded_packets.push(chunk);
    }
  }

  Ok(EncodedGop {
    group_id: gop.gop_id,
    packets: encoded_packets,
  })
}

// ── Software encode path ─────────────────────────────────────────────────────

fn encode_gop_sw(
  encoder: &mut encoder::Video,
  gop: &ScaledGop,
  width: u32,
  height: u32,
  framerate: f64,
  sequence_number: &mut u32,
) -> Result<EncodedGop> {
  let gop_frames = gop_size(framerate) as u64;
  let sample_duration = (TIMESCALE as f64 / framerate).round() as u32;
  let mut encoded_packets = Vec::with_capacity(gop.frames.len());

  for (frame_idx, frame_data) in gop.frames.iter().enumerate() {
    let mut video_frame = yuv420p_to_video_frame(frame_data, width, height);
    let global_frame = gop.gop_id * gop_frames + frame_idx as u64;
    video_frame.set_pts(Some(global_frame as i64));

    let is_keyframe = frame_idx == 0;
    if is_keyframe {
      video_frame.set_kind(ffmpeg_next::util::picture::Type::I);
    }

    encoder.send_frame(&video_frame)?;

    let mut packet = ffmpeg_next::Packet::empty();
    while encoder.receive_packet(&mut packet).is_ok() {
      let raw = packet.data().unwrap_or(&[]);
      let hvcc_data = cmaf::annex_b_to_hvcc(raw);
      let decode_time = global_frame * sample_duration as u64;
      let chunk = cmaf::wrap_cmaf_chunk(
        *sequence_number,
        decode_time,
        sample_duration,
        is_keyframe,
        &hvcc_data,
      );
      *sequence_number += 1;
      encoded_packets.push(chunk);
    }
  }

  Ok(EncodedGop {
    group_id: gop.gop_id,
    packets: encoded_packets,
  })
}

// ── Shared encode loop ───────────────────────────────────────────────────────

/// Drives the GOP encode loop for both software and VAAPI paths.
/// `encode_one_gop` is called for each incoming GOP; it returns an EncodedGop.
fn run_encode_loop<F>(
  encoder: &mut encoder::Video,
  framerate: f64,
  _width: u32,
  _height: u32,
  scaled_rx: &mut tokio::sync::mpsc::Receiver<ScaledGop>,
  on_gop: &tokio::sync::mpsc::Sender<EncodedGop>,
  encode_one_gop: F,
) -> Result<()>
where
  F: Fn(&mut encoder::Video, &ScaledGop, &mut u32) -> Result<EncodedGop>,
{
  let mut pending_last_gop: Option<EncodedGop> = None;
  let mut sequence_number: u32 = 0;

  while let Some(gop) = scaled_rx.blocking_recv() {
    let encoded = encode_one_gop(encoder, &gop, &mut sequence_number)?;

    if let Some(previous) = pending_last_gop.replace(encoded)
      && on_gop.blocking_send(previous).is_err()
    {
      warn!("Encoder: receiver dropped, stopping");
      return Ok(());
    }
  }

  // Flush frames buffered inside the encoder and attach trailing packets to
  // the final GOP before sending it downstream.
  encoder.send_eof()?;
  let sample_duration = (TIMESCALE as f64 / framerate).round() as u32;
  let mut flushed_packets = Vec::new();
  let mut packet = ffmpeg_next::Packet::empty();
  while encoder.receive_packet(&mut packet).is_ok() {
    let raw = packet.data().unwrap_or(&[]);
    let hvcc_data = cmaf::annex_b_to_hvcc(raw);
    let pts = packet.pts().unwrap_or(0) as u64;
    let decode_time = pts * sample_duration as u64;
    let chunk = cmaf::wrap_cmaf_chunk(
      sequence_number,
      decode_time,
      sample_duration,
      false,
      &hvcc_data,
    );
    sequence_number += 1;
    flushed_packets.push(chunk);
  }

  if let Some(mut final_gop) = pending_last_gop {
    let flushed_count = flushed_packets.len();
    if flushed_count > 0 {
      final_gop.packets.extend(flushed_packets);
      info!(
        "Encoder: appended {} trailing packet(s) to final GOP {}",
        flushed_count, final_gop.group_id
      );
    }
    if on_gop.blocking_send(final_gop).is_err() {
      warn!("Encoder: receiver dropped, stopping");
      return Ok(());
    }
  } else if !flushed_packets.is_empty() {
    warn!(
      "Encoder: received {} trailing packet(s) at flush with no GOP to attach",
      flushed_packets.len()
    );
  }

  info!("Encoder: all GOPs processed");
  Ok(())
}

/// CMAF timescale matching the catalog's `timescale: 90000`.
const TIMESCALE: u32 = 90000;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_gop_size_exact_framerate() {
    assert_eq!(gop_size(30.0), 30);
    assert_eq!(gop_size(60.0), 60);
    assert_eq!(gop_size(24.0), 24);
  }

  #[test]
  fn test_gop_size_fractional_framerate_rounds_up() {
    assert_eq!(gop_size(29.97), 30);
    assert_eq!(gop_size(23.976), 24);
    assert_eq!(gop_size(59.94), 60);
  }

  #[test]
  fn test_gop_size_always_at_least_one() {
    assert_eq!(gop_size(0.5), 1);
    assert_eq!(gop_size(1.0), 1);
  }

  #[test]
  fn test_encoded_gop_uses_packets_field() {
    let gop = EncodedGop {
      group_id: 0,
      packets: vec![],
    };
    assert_eq!(gop.packets.len(), 0);
  }
}
