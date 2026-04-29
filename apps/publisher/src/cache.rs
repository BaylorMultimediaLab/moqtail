use anyhow::{Context, Result};
use base64::Engine;
use bytes::Bytes;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use crate::encoder::EncodedGop;

/// Bumped if the on-disk format ever changes incompatibly. Replay rejects a
/// cache whose `meta.json` reports a different value.
pub const SCHEMA_VERSION: u32 = 1;

const TOP_META_FILE: &str = "meta.json";
const TOP_META_TMP: &str = "meta.json.tmp";
const VARIANT_META_FILE: &str = "variant.json";

#[derive(Debug, Clone)]
pub struct VariantMeta {
  pub quality: String,
  pub width: u16,
  pub height: u16,
  pub bitrate_kbps: u32,
  pub framerate: f64,
  pub codec: String,
  pub extradata: Bytes,
}

#[derive(Debug, Clone)]
pub struct TopMeta {
  pub schema_version: u32,
  pub source_width: u16,
  pub source_height: u16,
  pub framerate: f64,
  pub target_latency_ms: u32,
  pub variants: Vec<String>,
  pub gops_per_variant: u64,
}

pub fn variant_dir(root: &Path, quality: &str) -> PathBuf {
  root.join(quality)
}

pub fn gop_path(variant_dir: &Path, index: u64) -> PathBuf {
  variant_dir.join(format!("{:06}.gop", index))
}

/// True when the cache root contains a finalized `meta.json`. The atomic
/// rename in `write_top_meta_atomic` makes presence equivalent to
/// "all variant files were on disk before this file appeared".
pub fn is_complete(root: &Path) -> bool {
  root.join(TOP_META_FILE).is_file()
}

/// Counts files matching `{6 digits}.gop` in a variant directory.
pub fn gop_count(variant_dir: &Path) -> Result<u64> {
  let mut count: u64 = 0;
  for entry in
    fs::read_dir(variant_dir).with_context(|| format!("read_dir {}", variant_dir.display()))?
  {
    let entry = entry?;
    let name = entry.file_name();
    let s = match name.to_str() {
      Some(s) => s,
      None => continue,
    };
    if s.len() == 10 && s.ends_with(".gop") && s[..6].chars().all(|c| c.is_ascii_digit()) {
      count += 1;
    }
  }
  Ok(count)
}

pub fn write_gop(path: &Path, gop: &EncodedGop) -> Result<()> {
  let file = OpenOptions::new()
    .write(true)
    .create(true)
    .truncate(true)
    .open(path)
    .with_context(|| format!("create {}", path.display()))?;
  let mut w = BufWriter::new(file);

  let count = u32::try_from(gop.packets.len())
    .with_context(|| format!("packet_count overflow at {}", path.display()))?;
  w.write_all(&count.to_le_bytes())?;
  for packet in &gop.packets {
    let len = u32::try_from(packet.len())
      .with_context(|| format!("packet length overflow at {}", path.display()))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(packet)?;
  }
  w.flush()?;
  Ok(())
}

pub fn read_gop(path: &Path, group_id: u64) -> Result<EncodedGop> {
  let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
  let mut r = BufReader::new(file);
  let mut u32buf = [0u8; 4];

  r.read_exact(&mut u32buf)
    .with_context(|| format!("read packet_count at {}", path.display()))?;
  let count = u32::from_le_bytes(u32buf) as usize;

  let mut packets = Vec::with_capacity(count);
  for _ in 0..count {
    r.read_exact(&mut u32buf)
      .with_context(|| format!("read packet_len at {}", path.display()))?;
    let len = u32::from_le_bytes(u32buf) as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)
      .with_context(|| format!("read packet payload at {}", path.display()))?;
    packets.push(Bytes::from(buf));
  }
  Ok(EncodedGop { group_id, packets })
}

pub fn write_variant_meta(variant_dir: &Path, meta: &VariantMeta) -> Result<()> {
  fs::create_dir_all(variant_dir)
    .with_context(|| format!("create variant dir {}", variant_dir.display()))?;
  let json = serde_json::json!({
    "quality": &meta.quality,
    "width": meta.width,
    "height": meta.height,
    "bitrate_kbps": meta.bitrate_kbps,
    "framerate": meta.framerate,
    "codec": &meta.codec,
    "extradata_b64": base64::engine::general_purpose::STANDARD.encode(&meta.extradata),
  });
  let path = variant_dir.join(VARIANT_META_FILE);
  let bytes = serde_json::to_vec_pretty(&json)?;
  fs::write(&path, &bytes).with_context(|| format!("write {}", path.display()))?;
  Ok(())
}

pub fn read_variant_meta(variant_dir: &Path) -> Result<VariantMeta> {
  let path = variant_dir.join(VARIANT_META_FILE);
  let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
  let v: Value =
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

  let quality = field_str(&v, "quality", &path)?.to_string();
  let width = field_u16(&v, "width", &path)?;
  let height = field_u16(&v, "height", &path)?;
  let bitrate_kbps = field_u32(&v, "bitrate_kbps", &path)?;
  let framerate = field_f64(&v, "framerate", &path)?;
  let codec = field_str(&v, "codec", &path)?.to_string();
  let extradata_b64 = field_str(&v, "extradata_b64", &path)?;
  let extra = base64::engine::general_purpose::STANDARD
    .decode(extradata_b64.as_bytes())
    .with_context(|| format!("decode extradata_b64 in {}", path.display()))?;

  Ok(VariantMeta {
    quality,
    width,
    height,
    bitrate_kbps,
    framerate,
    codec,
    extradata: Bytes::from(extra),
  })
}

pub fn read_top_meta(root: &Path) -> Result<TopMeta> {
  let path = root.join(TOP_META_FILE);
  let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
  let v: Value =
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;

  let schema_version = field_u32(&v, "schema_version", &path)?;
  if schema_version != SCHEMA_VERSION {
    anyhow::bail!(
      "{}: schema_version {} not supported (expected {}); delete the cache directory and re-prepare",
      path.display(),
      schema_version,
      SCHEMA_VERSION
    );
  }
  let source_width = field_u16(&v, "source_width", &path)?;
  let source_height = field_u16(&v, "source_height", &path)?;
  let framerate = field_f64(&v, "framerate", &path)?;
  let target_latency_ms = field_u32(&v, "target_latency_ms", &path)?;
  let gops_per_variant = field_u64(&v, "gops_per_variant", &path)?;

  let variants_arr = v
    .get("variants")
    .and_then(|x| x.as_array())
    .with_context(|| format!("missing 'variants' array in {}", path.display()))?;
  let variants = variants_arr
    .iter()
    .map(|x| {
      x.as_str()
        .map(|s| s.to_string())
        .with_context(|| format!("non-string element in 'variants' in {}", path.display()))
    })
    .collect::<Result<Vec<_>>>()?;

  Ok(TopMeta {
    schema_version,
    source_width,
    source_height,
    framerate,
    target_latency_ms,
    variants,
    gops_per_variant,
  })
}

pub fn write_top_meta_atomic(root: &Path, meta: &TopMeta) -> Result<()> {
  fs::create_dir_all(root).with_context(|| format!("create cache root {}", root.display()))?;
  let final_path = root.join(TOP_META_FILE);
  let tmp_path = root.join(TOP_META_TMP);

  let json = serde_json::json!({
    "schema_version": meta.schema_version,
    "source_width": meta.source_width,
    "source_height": meta.source_height,
    "framerate": meta.framerate,
    "target_latency_ms": meta.target_latency_ms,
    "variants": &meta.variants,
    "gops_per_variant": meta.gops_per_variant,
  });
  let bytes = serde_json::to_vec_pretty(&json)?;

  {
    let mut f = OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .open(&tmp_path)
      .with_context(|| format!("open {}", tmp_path.display()))?;
    f.write_all(&bytes)?;
    f.flush()?;
    f.sync_all()
      .with_context(|| format!("fsync {}", tmp_path.display()))?;
  }
  fs::rename(&tmp_path, &final_path)
    .with_context(|| format!("rename {} -> {}", tmp_path.display(), final_path.display()))?;
  Ok(())
}

fn field_str<'a>(v: &'a Value, key: &str, path: &Path) -> Result<&'a str> {
  v.get(key)
    .and_then(|x| x.as_str())
    .with_context(|| format!("missing or non-string '{}' in {}", key, path.display()))
}

fn field_u64(v: &Value, key: &str, path: &Path) -> Result<u64> {
  v.get(key)
    .and_then(|x| x.as_u64())
    .with_context(|| format!("missing or non-integer '{}' in {}", key, path.display()))
}

fn field_u32(v: &Value, key: &str, path: &Path) -> Result<u32> {
  let n = field_u64(v, key, path)?;
  u32::try_from(n).with_context(|| format!("'{}' overflows u32 in {}", key, path.display()))
}

fn field_u16(v: &Value, key: &str, path: &Path) -> Result<u16> {
  let n = field_u64(v, key, path)?;
  u16::try_from(n).with_context(|| format!("'{}' overflows u16 in {}", key, path.display()))
}

fn field_f64(v: &Value, key: &str, path: &Path) -> Result<f64> {
  v.get(key)
    .and_then(|x| x.as_f64())
    .with_context(|| format!("missing or non-number '{}' in {}", key, path.display()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU64, Ordering};

  struct TempDir(PathBuf);
  impl TempDir {
    fn new(label: &str) -> Self {
      static N: AtomicU64 = AtomicU64::new(0);
      let n = N.fetch_add(1, Ordering::Relaxed);
      let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
      let path = std::env::temp_dir().join(format!(
        "moqtail-cache-{}-{}-{}-{}",
        label,
        std::process::id(),
        nanos,
        n
      ));
      fs::create_dir_all(&path).unwrap();
      TempDir(path)
    }
    fn path(&self) -> &Path {
      &self.0
    }
  }
  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn sample_top_meta() -> TopMeta {
    TopMeta {
      schema_version: SCHEMA_VERSION,
      source_width: 1920,
      source_height: 1080,
      framerate: 30.0,
      target_latency_ms: 1500,
      variants: vec!["1080p".into(), "720p".into()],
      gops_per_variant: 30,
    }
  }

  #[test]
  fn test_gop_round_trip_byte_equal() {
    let td = TempDir::new("gop-rt");
    let path = td.path().join("000000.gop");
    let gop = EncodedGop {
      group_id: 42,
      packets: vec![
        Bytes::from_static(b"\x00\x01\x02\x03"),
        Bytes::from_static(b"hello"),
        Bytes::from(vec![0x55u8; 1000]),
      ],
    };
    write_gop(&path, &gop).unwrap();
    let read = read_gop(&path, 42).unwrap();
    assert_eq!(read.group_id, 42);
    assert_eq!(read.packets.len(), gop.packets.len());
    for (a, b) in read.packets.iter().zip(gop.packets.iter()) {
      assert_eq!(a.as_ref(), b.as_ref());
    }
  }

  #[test]
  fn test_gop_empty_packets() {
    let td = TempDir::new("gop-empty");
    let path = td.path().join("000000.gop");
    let gop = EncodedGop {
      group_id: 0,
      packets: vec![],
    };
    write_gop(&path, &gop).unwrap();
    let read = read_gop(&path, 0).unwrap();
    assert_eq!(read.group_id, 0);
    assert!(read.packets.is_empty());
  }

  #[test]
  fn test_variant_meta_round_trip() {
    let td = TempDir::new("variant-rt");
    let extradata: Vec<u8> = (0u32..512u32).map(|i| (i & 0xFF) as u8).collect();
    let meta = VariantMeta {
      quality: "1080p".to_string(),
      width: 1920,
      height: 1080,
      bitrate_kbps: 4000,
      framerate: 29.97,
      codec: "hev1.1.6.L120.B0".to_string(),
      extradata: Bytes::from(extradata.clone()),
    };
    write_variant_meta(td.path(), &meta).unwrap();
    let read = read_variant_meta(td.path()).unwrap();
    assert_eq!(read.quality, "1080p");
    assert_eq!(read.width, 1920);
    assert_eq!(read.height, 1080);
    assert_eq!(read.bitrate_kbps, 4000);
    assert!((read.framerate - 29.97).abs() < 1e-9);
    assert_eq!(read.codec, "hev1.1.6.L120.B0");
    assert_eq!(read.extradata.as_ref(), extradata.as_slice());
  }

  #[test]
  fn test_top_meta_atomic_write_no_partial() {
    let td = TempDir::new("top-atomic");
    write_top_meta_atomic(td.path(), &sample_top_meta()).unwrap();
    assert!(
      !td.path().join(TOP_META_TMP).exists(),
      "tmp file should be gone after rename"
    );
    assert!(
      td.path().join(TOP_META_FILE).exists(),
      "meta.json should exist"
    );
    let read = read_top_meta(td.path()).unwrap();
    assert_eq!(read.variants, vec!["1080p".to_string(), "720p".to_string()]);
    assert_eq!(read.gops_per_variant, 30);
    assert_eq!(read.schema_version, SCHEMA_VERSION);
  }

  #[test]
  fn test_is_complete_requires_meta_json() {
    let td = TempDir::new("is-complete");
    let v = td.path().join("1080p");
    fs::create_dir_all(&v).unwrap();
    write_gop(
      &v.join("000000.gop"),
      &EncodedGop {
        group_id: 0,
        packets: vec![],
      },
    )
    .unwrap();
    assert!(!is_complete(td.path()));
    write_top_meta_atomic(td.path(), &sample_top_meta()).unwrap();
    assert!(is_complete(td.path()));
  }

  #[test]
  fn test_gop_count_zero_padded_naming() {
    let td = TempDir::new("gop-count");
    let v = td.path().join("v");
    fs::create_dir_all(&v).unwrap();
    let gop = EncodedGop {
      group_id: 0,
      packets: vec![],
    };
    write_gop(&v.join("000000.gop"), &gop).unwrap();
    write_gop(&v.join("000001.gop"), &gop).unwrap();
    write_gop(&v.join("000002.gop"), &gop).unwrap();
    fs::write(v.join("0.gop"), b"").unwrap();
    fs::write(v.join("notgop.txt"), b"").unwrap();
    fs::write(v.join("variant.json"), b"{}").unwrap();
    assert_eq!(gop_count(&v).unwrap(), 3);
  }

  #[test]
  fn test_read_top_meta_rejects_wrong_schema_version() {
    let td = TempDir::new("schema");
    let mut meta = sample_top_meta();
    meta.schema_version = 999;
    write_top_meta_atomic(td.path(), &meta).unwrap();
    let err = read_top_meta(td.path()).unwrap_err();
    let msg = format!("{:#}", err);
    assert!(msg.contains("schema_version"), "msg = {msg}");
  }
}
