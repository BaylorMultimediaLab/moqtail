use crate::video::VideoInfo;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LadderSpec {
  /// Today's hardcoded resolution-coupled ladder.
  Default,
  /// All variants at the same resolution; bitrates explicit.
  /// Mapping `720p` -> height=720, width chosen from 16:9 (1280).
  SingleRes {
    height: u16,
    bitrates_kbps: Vec<u32>,
  },
}

impl LadderSpec {
  pub fn parse(s: &str) -> Result<Self, String> {
    if s == "default" {
      return Ok(LadderSpec::Default);
    }
    let (res_part, bitrate_part) = s
      .split_once(':')
      .ok_or_else(|| format!("ladder-spec: missing ':' in '{}'", s))?;
    if res_part.is_empty() || bitrate_part.is_empty() {
      return Err(format!("ladder-spec: empty section in '{}'", s));
    }
    let height: u16 = res_part
      .strip_suffix('p')
      .ok_or_else(|| format!("ladder-spec: resolution must end in 'p' in '{}'", s))?
      .parse()
      .map_err(|e| format!("ladder-spec: bad height in '{}': {}", s, e))?;
    let bitrates_kbps: Vec<u32> = bitrate_part
      .split(',')
      .map(|x| {
        x.trim()
          .parse::<u32>()
          .map_err(|e| format!("ladder-spec: bad bitrate '{}': {}", x, e))
      })
      .collect::<Result<Vec<_>, _>>()?;
    if bitrates_kbps.is_empty() {
      return Err(format!("ladder-spec: empty bitrate list in '{}'", s));
    }
    Ok(LadderSpec::SingleRes {
      height,
      bitrates_kbps,
    })
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
  Q360p,
  Q480p,
  Q720p,
  Q1080p,
  /// Synthetic variant used when LadderSpec::SingleRes generates multiple
  /// rungs at the same resolution but different bitrates. Track name becomes
  /// e.g. "720p-400k" so MoQ track aliases stay unique.
  SameResRung {
    height: u16,
    bitrate_kbps: u32,
  },
}

#[derive(Debug, Clone)]
pub struct QualityVariant {
  pub quality: Quality,
  pub width: u16,
  pub height: u16,
  pub bitrate_kbps: u32,
}

/// CBR bitrate ladder for HEVC encoding with 1-second GOPs.
const VARIANTS: &[(Quality, u16, u16, u32)] = &[
  (Quality::Q1080p, 1920, 1080, 4000), // 4 Mbps
  (Quality::Q720p, 1280, 720, 2000),   // 2 Mbps
  (Quality::Q480p, 854, 480, 1000),    // 1 Mbps
  (Quality::Q360p, 640, 360, 500),     // 0.5 Mbps
];

/// Returns the quality variants available for the given source video.
/// Only includes tiers at or below the source resolution.
/// When `max_variants` would trim the list, the highest and lowest tiers
/// are always kept and middle tiers are dropped first.
/// Returns an error if no variants match (source below 360p).
pub fn quality_variants(
  info: &VideoInfo,
  max_variants: usize,
) -> anyhow::Result<Vec<QualityVariant>> {
  let mut variants: Vec<QualityVariant> = VARIANTS
    .iter()
    .filter(|(_, _w, h, _)| *h <= info.height)
    .map(|&(quality, width, height, bitrate_kbps)| QualityVariant {
      quality,
      width,
      height,
      bitrate_kbps,
    })
    .collect();

  if variants.is_empty() {
    anyhow::bail!(
      "source resolution {}x{} is below the minimum supported tier (360p)",
      info.width,
      info.height
    );
  }

  // Trim to max_variants, keeping the highest (first) and lowest (last)
  // tiers and dropping middle ones.
  while variants.len() > max_variants && variants.len() > 2 {
    // Remove the second-to-last element (lowest middle tier)
    variants.remove(variants.len() - 2);
  }

  Ok(variants)
}

/// Generate variants according to a `LadderSpec`. `LadderSpec::Default` defers
/// to the legacy `quality_variants(info, 4)`; `LadderSpec::SingleRes` emits
/// `bitrates_kbps.len()` variants all at the requested height with the requested
/// bitrates. Width is selected from a 16:9 mapping.
pub fn quality_variants_for_spec(
  info: &VideoInfo,
  spec: &LadderSpec,
) -> Result<Vec<QualityVariant>, String> {
  match spec {
    LadderSpec::Default => quality_variants(info, 4).map_err(|e| format!("{}", e)),
    LadderSpec::SingleRes {
      height,
      bitrates_kbps,
    } => {
      let width: u16 = match height {
        2160 => 3840,
        1080 => 1920,
        720 => 1280,
        480 => 854,
        360 => 640,
        h => return Err(format!("LadderSpec::SingleRes: unsupported height {}", h)),
      };
      // Source-resolution check — refuse to upscale.
      if *height > info.height {
        return Err(format!(
          "LadderSpec::SingleRes: height {} exceeds source height {}",
          height, info.height
        ));
      }
      let variants = bitrates_kbps
        .iter()
        .map(|&bitrate_kbps| QualityVariant {
          quality: Quality::SameResRung {
            height: *height,
            bitrate_kbps,
          },
          width,
          height: *height,
          bitrate_kbps,
        })
        .collect();
      Ok(variants)
    }
  }
}

impl std::fmt::Display for Quality {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Quality::Q360p => write!(f, "360p"),
      Quality::Q480p => write!(f, "480p"),
      Quality::Q720p => write!(f, "720p"),
      Quality::Q1080p => write!(f, "1080p"),
      Quality::SameResRung {
        height,
        bitrate_kbps,
      } => write!(f, "{}p-{}k", height, bitrate_kbps),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn video(width: u16, height: u16) -> VideoInfo {
    VideoInfo {
      width,
      height,
      framerate: 30.0,
    }
  }

  #[test]
  fn test_1080p_source_returns_all_variants() {
    let variants = quality_variants(&video(1920, 1080), 4).unwrap();
    assert_eq!(variants.len(), 4);
    assert_eq!(variants[0].quality, Quality::Q1080p);
    assert_eq!(variants[1].quality, Quality::Q720p);
    assert_eq!(variants[2].quality, Quality::Q480p);
    assert_eq!(variants[3].quality, Quality::Q360p);
  }

  #[test]
  fn test_720p_source_excludes_1080p() {
    let variants = quality_variants(&video(1280, 720), 4).unwrap();
    assert_eq!(variants.len(), 3);
    assert_eq!(variants[0].quality, Quality::Q720p);
    assert_eq!(variants[1].quality, Quality::Q480p);
    assert_eq!(variants[2].quality, Quality::Q360p);
  }

  #[test]
  fn test_480p_source_excludes_720p_and_above() {
    let variants = quality_variants(&video(854, 480), 4).unwrap();
    assert_eq!(variants.len(), 2);
    assert_eq!(variants[0].quality, Quality::Q480p);
    assert_eq!(variants[1].quality, Quality::Q360p);
  }

  #[test]
  fn test_360p_source_returns_only_360p() {
    let variants = quality_variants(&video(640, 360), 4).unwrap();
    assert_eq!(variants.len(), 1);
    assert_eq!(variants[0].quality, Quality::Q360p);
  }

  #[test]
  fn test_below_360p_returns_error() {
    let result = quality_variants(&video(320, 240), 4);
    assert!(result.is_err());
  }

  #[test]
  fn test_bitrate_ladder_values() {
    let variants = quality_variants(&video(1920, 1080), 4).unwrap();
    assert_eq!(variants[0].bitrate_kbps, 4000); // 4 Mbps
    assert_eq!(variants[1].bitrate_kbps, 2000); // 2 Mbps
    assert_eq!(variants[2].bitrate_kbps, 1000); // 1 Mbps
    assert_eq!(variants[3].bitrate_kbps, 500); // 0.5 Mbps
  }

  #[test]
  fn test_resolution_values() {
    let variants = quality_variants(&video(1920, 1080), 4).unwrap();
    assert_eq!((variants[0].width, variants[0].height), (1920, 1080));
    assert_eq!((variants[1].width, variants[1].height), (1280, 720));
    assert_eq!((variants[2].width, variants[2].height), (854, 480));
    assert_eq!((variants[3].width, variants[3].height), (640, 360));
  }

  #[test]
  fn test_non_standard_source_includes_lower_tiers() {
    let variants = quality_variants(&video(1600, 900), 4).unwrap();
    assert_eq!(variants.len(), 3);
    assert_eq!(variants[0].quality, Quality::Q720p);
  }

  #[test]
  fn test_narrow_width_still_includes_matching_height() {
    let variants = quality_variants(&video(1440, 1080), 4).unwrap();
    assert_eq!(variants.len(), 4);
    assert_eq!(variants[0].quality, Quality::Q1080p);
  }

  #[test]
  fn test_quality_display() {
    assert_eq!(format!("{}", Quality::Q1080p), "1080p");
    assert_eq!(format!("{}", Quality::Q720p), "720p");
    assert_eq!(format!("{}", Quality::Q480p), "480p");
    assert_eq!(format!("{}", Quality::Q360p), "360p");
  }

  #[test]
  fn test_hevc_bitrate_ladder() {
    let variants = quality_variants(&video(1920, 1080), 4).unwrap();
    assert_eq!(variants[0].bitrate_kbps, 4000); // 1080p
    assert_eq!(variants[1].bitrate_kbps, 2000); // 720p
    assert_eq!(variants[2].bitrate_kbps, 1000); // 480p
    assert_eq!(variants[3].bitrate_kbps, 500); // 360p
  }

  #[test]
  fn test_max_variants_2_keeps_highest_and_lowest() {
    let variants = quality_variants(&video(1920, 1080), 2).unwrap();
    assert_eq!(variants.len(), 2);
    assert_eq!(variants[0].quality, Quality::Q1080p);
    assert_eq!(variants[1].quality, Quality::Q360p);
  }

  #[test]
  fn test_max_variants_3_drops_one_middle() {
    let variants = quality_variants(&video(1920, 1080), 3).unwrap();
    assert_eq!(variants.len(), 3);
    assert_eq!(variants[0].quality, Quality::Q1080p);
    assert_eq!(variants[1].quality, Quality::Q720p);
    assert_eq!(variants[2].quality, Quality::Q360p);
  }

  #[test]
  fn ladder_spec_parses_default() {
    assert_eq!(LadderSpec::parse("default").unwrap(), LadderSpec::Default);
  }

  #[test]
  fn ladder_spec_parses_single_res_720p_five_rungs() {
    let spec = LadderSpec::parse("720p:400,800,1200,2500,5000").unwrap();
    assert_eq!(
      spec,
      LadderSpec::SingleRes {
        height: 720,
        bitrates_kbps: vec![400, 800, 1200, 2500, 5000],
      }
    );
  }

  #[test]
  fn ladder_spec_rejects_garbage() {
    assert!(LadderSpec::parse("nonsense").is_err());
    assert!(LadderSpec::parse("720p:").is_err());
    assert!(LadderSpec::parse("720p:abc").is_err());
    assert!(LadderSpec::parse(":400,800").is_err());
  }

  #[test]
  fn quality_variants_single_res_720p_emits_n_variants_at_same_resolution() {
    let info = video(1920, 1080);
    let spec = LadderSpec::SingleRes {
      height: 720,
      bitrates_kbps: vec![400, 800, 1200, 2500, 5000],
    };
    let variants = quality_variants_for_spec(&info, &spec).unwrap();
    assert_eq!(variants.len(), 5);
    for v in &variants {
      assert_eq!(v.height, 720);
      assert_eq!(v.width, 1280);
    }
    assert_eq!(
      variants.iter().map(|v| v.bitrate_kbps).collect::<Vec<_>>(),
      vec![400, 800, 1200, 2500, 5000]
    );
  }

  #[test]
  fn quality_variants_default_path_unchanged() {
    let info = video(1920, 1080);
    let from_default = quality_variants_for_spec(&info, &LadderSpec::Default).unwrap();
    let baseline = quality_variants(&info, 4).unwrap();
    assert_eq!(from_default.len(), baseline.len());
    for (a, b) in from_default.iter().zip(baseline.iter()) {
      assert_eq!(a.bitrate_kbps, b.bitrate_kbps);
      assert_eq!(a.width, b.width);
      assert_eq!(a.height, b.height);
    }
  }

  #[test]
  fn same_res_rung_display_format() {
    let q = Quality::SameResRung {
      height: 720,
      bitrate_kbps: 400,
    };
    assert_eq!(q.to_string(), "720p-400k");
    let q2 = Quality::SameResRung {
      height: 720,
      bitrate_kbps: 5000,
    };
    assert_eq!(q2.to_string(), "720p-5000k");
  }
}
