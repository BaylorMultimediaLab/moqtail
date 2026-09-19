// Copyright 2026 The MOQtail Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Experiment event log (project-local, protocol-neutral).
//!
//! One JSON object per line, written to the path given by `--event-log`.
//! Every record carries `ts` (UNIX milliseconds), `src: "relay"` and an
//! `event` name; the remaining fields are event specific. The client and the
//! publisher write the same shape so a run can be merged on `ts`.
//!
//! Disabled (every call is a no-op) unless `init` was called with a path.
//! Volume is low (subscribe / switch / cache events, one stats line per
//! track per second), so a mutex-guarded buffered writer flushed on every
//! record is enough and keeps events durable if the relay is killed.

use serde_json::{Map, Value, json};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};

static SINK: OnceLock<Mutex<BufWriter<File>>> = OnceLock::new();

/// Open the event log. Safe to call more than once; only the first call wins.
pub fn init(path: &str) {
  if path.is_empty() {
    return;
  }
  if let Some(parent) = std::path::Path::new(path).parent()
    && !parent.as_os_str().is_empty()
    && let Err(e) = std::fs::create_dir_all(parent)
  {
    error!("event log: cannot create {}: {}", parent.display(), e);
    return;
  }
  match OpenOptions::new().create(true).append(true).open(path) {
    Ok(file) => {
      if SINK.set(Mutex::new(BufWriter::new(file))).is_ok() {
        info!("event log: writing to {}", path);
      }
    }
    Err(e) => error!("event log: cannot open {}: {}", path, e),
  }
}

pub fn enabled() -> bool {
  SINK.get().is_some()
}

/// UNIX time in milliseconds with sub-millisecond precision.
pub fn now_ms() -> f64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs_f64() * 1000.0)
    .unwrap_or(0.0)
}

/// Append one record. `fields` must be a JSON object; `ts`, `src` and
/// `event` are added by this function.
pub fn emit(event: &str, fields: Value) {
  let Some(sink) = SINK.get() else {
    return;
  };
  let mut record = Map::new();
  record.insert("ts".into(), json!(now_ms()));
  record.insert("src".into(), json!("relay"));
  record.insert("event".into(), json!(event));
  if let Value::Object(extra) = fields {
    for (k, v) in extra {
      record.insert(k, v);
    }
  }
  let line = Value::Object(record).to_string();
  if let Ok(mut w) = sink.lock() {
    let _ = w.write_all(line.as_bytes());
    let _ = w.write_all(b"\n");
    let _ = w.flush();
  }
}

/// Render a full track name as a readable string for event records.
pub fn track_name_string(name: &moqtail::model::data::full_track_name::FullTrackName) -> String {
  let ns: Vec<String> = name
    .namespace
    .fields
    .iter()
    .map(|f| f.to_string())
    .collect();
  format!(
    "{}/{}",
    ns.join("/"),
    String::from_utf8_lossy(name.name.as_bytes())
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn emit_is_a_noop_when_not_initialised() {
    // Must not panic and must not create files.
    emit("TEST", json!({ "a": 1 }));
  }

  #[test]
  fn now_ms_is_recent() {
    let t = now_ms();
    assert!(t > 1.6e12, "ts should be UNIX ms, got {t}");
  }
}
