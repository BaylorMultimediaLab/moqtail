use anyhow::{Context, Result};
use std::path::Path;

pub struct VideoInfo {
  pub width: u16,
  pub height: u16,
  pub framerate: f64,
}

/// Converts packed YUV420P bytes to an NV12 ffmpeg frame.
/// NV12 has the same Y plane as YUV420P but interleaves U and V into a single
/// UV plane (UVUVUV…) instead of separate planes.  VAAPI on AMD requires NV12
/// surfaces — YUV420P surfaces are rejected at encode time.
pub fn yuv420p_to_nv12_frame(data: &[u8], width: u32, height: u32) -> ffmpeg_next::frame::Video {
  let mut frame = ffmpeg_next::frame::Video::new(ffmpeg_next::format::Pixel::NV12, width, height);

  let w = width as usize;
  let h = height as usize;
  let half_w = w / 2;
  let half_h = h / 2;
  let y_size = w * h;
  let uv_size = half_w * half_h;

  // Copy Y plane (identical layout to YUV420P).
  let y_stride = frame.stride(0);
  for row in 0..h {
    let src = &data[row * w..row * w + w];
    let dst_start = row * y_stride;
    frame.data_mut(0)[dst_start..dst_start + w].copy_from_slice(src);
  }

  // Interleave U and V into the NV12 UV plane.
  let u_src = &data[y_size..y_size + uv_size];
  let v_src = &data[y_size + uv_size..y_size + 2 * uv_size];
  let uv_stride = frame.stride(1);
  for row in 0..half_h {
    for col in 0..half_w {
      let dst = row * uv_stride + col * 2;
      frame.data_mut(1)[dst] = u_src[row * half_w + col];
      frame.data_mut(1)[dst + 1] = v_src[row * half_w + col];
    }
  }

  frame
}

/// Reconstructs an ffmpeg Video frame from packed YUV420P bytes.
/// Handles stride-padded ffmpeg frame layouts correctly.
/// Used by both the scaler (input frames) and encoder (scaled frames).
pub fn yuv420p_to_video_frame(data: &[u8], width: u32, height: u32) -> ffmpeg_next::frame::Video {
  let mut frame =
    ffmpeg_next::frame::Video::new(ffmpeg_next::format::Pixel::YUV420P, width, height);

  let w = width as usize;
  let h = height as usize;
  let y_size = w * h;
  let uv_size = (w / 2) * (h / 2);

  let y_stride = frame.stride(0);
  for row in 0..h {
    let src_start = row * w;
    let dst_start = row * y_stride;
    frame.data_mut(0)[dst_start..dst_start + w].copy_from_slice(&data[src_start..src_start + w]);
  }

  let half_w = w / 2;
  let half_h = h / 2;
  let u_stride = frame.stride(1);
  let u_offset = y_size;
  for row in 0..half_h {
    let src_start = u_offset + row * half_w;
    let dst_start = row * u_stride;
    frame.data_mut(1)[dst_start..dst_start + half_w]
      .copy_from_slice(&data[src_start..src_start + half_w]);
  }

  let v_stride = frame.stride(2);
  let v_offset = y_size + uv_size;
  for row in 0..half_h {
    let src_start = v_offset + row * half_w;
    let dst_start = row * v_stride;
    frame.data_mut(2)[dst_start..dst_start + half_w]
      .copy_from_slice(&data[src_start..src_start + half_w]);
  }

  frame
}

pub async fn get_video_info(video_path: &str) -> Result<VideoInfo> {
  let path = video_path.to_owned();
  tokio::task::spawn_blocking(move || read_video_info(&path))
    .await
    .context("video info task panicked")?
}

fn read_video_info(video_path: &str) -> Result<VideoInfo> {
  let path = Path::new(video_path);
  let f = std::fs::File::open(path).with_context(|| format!("failed to open {video_path}"))?;
  let size = f.metadata()?.len();
  let reader = std::io::BufReader::new(f);
  let mp4 = mp4::Mp4Reader::read_header(reader, size)
    .with_context(|| format!("failed to read MP4 header from {video_path}"))?;

  for track in mp4.tracks().values() {
    if track.track_type().ok() == Some(mp4::TrackType::Video) {
      return Ok(VideoInfo {
        width: track.width(),
        height: track.height(),
        framerate: track.frame_rate(),
      });
    }
  }

  anyhow::bail!("no video track found in {video_path}")
}
