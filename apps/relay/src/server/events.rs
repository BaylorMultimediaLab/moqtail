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
//!
//! Records are written off the forwarding path: `emit` stamps `ts`, then hands
//! the record to a dedicated writer thread over an unbounded channel and returns.
//! The writer serialises, buffers and flushes every `FLUSH_INTERVAL` while there
//! is something unflushed, and on `flush()`. One channel and one writer keep the
//! records in `emit` order. `flush()` is called when the relay is asked to stop
//! (SIGTERM / Ctrl-C) and again on exit, so a stopped relay loses nothing; a
//! killed one loses at most the last `FLUSH_INTERVAL` of records. (The writer
//! used to take a mutex, write and flush per record inside the forwarding task:
//! synchronous disk I/O per OBJECT_SENT at ~300 objects/s per client.)

use serde_json::{Map, Value, json};
use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::sync::OnceLock;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{error, info};

/// Longest a record waits in the writer's buffer before it reaches the file.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(200);
/// How long `flush()` waits for the writer to confirm.
const FLUSH_WAIT: Duration = Duration::from_secs(2);

enum Command {
  Record(Map<String, Value>),
  Flush(mpsc::SyncSender<()>),
}

/// The sending half of an event log: cheap to call from any task or thread.
pub struct EventLog {
  tx: Sender<Command>,
}

impl EventLog {
  /// Starts the writer thread over `out`.
  pub fn spawn<W: Write + Send + 'static>(out: W, flush_interval: Duration) -> Self {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
      .name("event-log".into())
      .spawn(move || write_loop(rx, BufWriter::new(out), flush_interval))
      .expect("spawn event-log writer");
    Self { tx }
  }

  /// Queues one record; never blocks on I/O.
  pub fn record(&self, record: Map<String, Value>) {
    let _ = self.tx.send(Command::Record(record));
  }

  /// Writes and flushes everything queued before this call. Returns false if the
  /// writer did not confirm within `FLUSH_WAIT`.
  pub fn flush(&self) -> bool {
    let (ack_tx, ack_rx) = mpsc::sync_channel(1);
    if self.tx.send(Command::Flush(ack_tx)).is_err() {
      return false;
    }
    ack_rx.recv_timeout(FLUSH_WAIT).is_ok()
  }
}

fn write_loop<W: Write>(rx: Receiver<Command>, mut out: BufWriter<W>, flush_interval: Duration) {
  // Time the oldest unflushed record was written, if any.
  let mut unflushed_since: Option<Instant> = None;
  loop {
    let command = match unflushed_since {
      Some(since) => rx.recv_timeout(flush_interval.saturating_sub(since.elapsed())),
      None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
    };
    match command {
      Ok(Command::Record(record)) => {
        let line = Value::Object(record).to_string();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        match unflushed_since {
          Some(since) if since.elapsed() >= flush_interval => {
            let _ = out.flush();
            unflushed_since = None;
          }
          Some(_) => {}
          None => unflushed_since = Some(Instant::now()),
        }
      }
      Ok(Command::Flush(ack)) => {
        let _ = out.flush();
        unflushed_since = None;
        let _ = ack.send(());
      }
      Err(RecvTimeoutError::Timeout) => {
        let _ = out.flush();
        unflushed_since = None;
      }
      Err(RecvTimeoutError::Disconnected) => {
        let _ = out.flush();
        return;
      }
    }
  }
}

static SINK: OnceLock<EventLog> = OnceLock::new();

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
  if SINK.get().is_some() {
    return;
  }
  match OpenOptions::new().create(true).append(true).open(path) {
    Ok(file) => {
      if SINK.set(EventLog::spawn(file, FLUSH_INTERVAL)).is_ok() {
        info!("event log: writing to {}", path);
      }
    }
    Err(e) => error!("event log: cannot open {}: {}", path, e),
  }
}

pub fn enabled() -> bool {
  SINK.get().is_some()
}

/// Writes out everything emitted so far. Called when the relay is told to stop.
pub fn flush() {
  if let Some(sink) = SINK.get()
    && !sink.flush()
  {
    error!("event log: flush not confirmed within {:?}", FLUSH_WAIT);
  }
}

/// UNIX time in milliseconds with sub-millisecond precision.
pub fn now_ms() -> f64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs_f64() * 1000.0)
    .unwrap_or(0.0)
}

fn build_record(event: &str, fields: Value) -> Map<String, Value> {
  let mut record = Map::new();
  record.insert("ts".into(), json!(now_ms()));
  record.insert("src".into(), json!("relay"));
  record.insert("event".into(), json!(event));
  if let Value::Object(extra) = fields {
    for (k, v) in extra {
      record.insert(k, v);
    }
  }
  record
}

/// Append one record. `fields` must be a JSON object; `ts`, `src` and
/// `event` are added by this function.
pub fn emit(event: &str, fields: Value) {
  #[cfg(test)]
  test_capture::push(build_record(event, fields.clone()));
  let Some(sink) = SINK.get() else {
    return;
  };
  sink.record(build_record(event, fields));
}

/// Tests read back what the code under test emitted (the file sink is never opened
/// in tests). Shared by every test in the process, so callers filter by a field
/// unique to their test, e.g. `conn`.
#[cfg(test)]
pub(crate) mod test_capture {
  use serde_json::{Map, Value};
  use std::sync::Mutex;

  static RECORDS: Mutex<Vec<Value>> = Mutex::new(Vec::new());

  pub(super) fn push(record: Map<String, Value>) {
    RECORDS.lock().unwrap().push(Value::Object(record));
  }

  /// Every captured record named `event` whose `conn` is `conn`, in emit order.
  pub(crate) fn records(event: &str, conn: usize) -> Vec<Value> {
    RECORDS
      .lock()
      .unwrap()
      .iter()
      .filter(|r| r["event"] == event && r["conn"] == conn)
      .cloned()
      .collect()
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
    // Must not panic and must not create files; tests can still read it back.
    emit("TEST", json!({ "conn": 424242, "a": 1 }));
    let captured = test_capture::records("TEST", 424242);
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0]["a"], 1);
  }

  /// A Write whose bytes the test can read while the writer thread holds it.
  #[derive(Clone, Default)]
  struct Shared(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
  impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
      self.0.lock().unwrap().extend_from_slice(buf);
      Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
      Ok(())
    }
  }
  impl Shared {
    fn lines(&self) -> Vec<Value> {
      String::from_utf8(self.0.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
    }
  }

  /// Records reach the output in emit order, including from several threads'
  /// interleaved emits (each thread's own order is kept), and `flush` makes them
  /// all visible.
  #[test]
  fn records_are_written_in_order_and_flush_makes_them_visible() {
    let out = Shared::default();
    let log = std::sync::Arc::new(EventLog::spawn(out.clone(), Duration::from_secs(3600)));
    for i in 0..100 {
      log.record(build_record("E", json!({ "i": i })));
    }
    let threads: Vec<_> = (0..4)
      .map(|t| {
        let log = log.clone();
        std::thread::spawn(move || {
          for i in 0..250 {
            log.record(build_record("T", json!({ "t": t, "i": i })));
          }
        })
      })
      .collect();
    for t in threads {
      t.join().unwrap();
    }
    assert!(log.flush());
    let lines = out.lines();
    assert_eq!(lines.len(), 1100);
    let seq: Vec<i64> = lines[..100]
      .iter()
      .map(|l| l["i"].as_i64().unwrap())
      .collect();
    assert_eq!(seq, (0..100).collect::<Vec<_>>());
    for t in 0..4 {
      let per_thread: Vec<i64> = lines
        .iter()
        .filter(|l| l["event"] == "T" && l["t"] == t)
        .map(|l| l["i"].as_i64().unwrap())
        .collect();
      assert_eq!(per_thread, (0..250).collect::<Vec<_>>());
    }
    assert!(
      lines
        .iter()
        .all(|l| l["src"] == "relay" && l["ts"].is_f64())
    );
  }

  /// Without an explicit flush, a record reaches the output within the flush
  /// interval (the bound on what a killed relay can lose).
  #[test]
  fn records_are_flushed_periodically() {
    struct Flushes {
      written: Shared,
      visible: Shared,
    }
    impl Write for Flushes {
      fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written.write(buf)
      }
      fn flush(&mut self) -> std::io::Result<()> {
        let bytes = self.written.0.lock().unwrap().clone();
        *self.visible.0.lock().unwrap() = bytes;
        Ok(())
      }
    }
    let visible = Shared::default();
    let log = EventLog::spawn(
      Flushes {
        written: Shared::default(),
        visible: visible.clone(),
      },
      Duration::from_millis(50),
    );
    log.record(build_record("E", json!({ "i": 1 })));
    let deadline = Instant::now() + Duration::from_secs(2);
    while visible.lines().is_empty() && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
      visible.lines().len(),
      1,
      "flushed without an explicit flush"
    );
  }

  /// Emitting does not wait on the output: a writer stuck in I/O does not hold up
  /// the caller.
  #[test]
  fn emit_does_not_wait_for_io() {
    struct Slow;
    impl Write for Slow {
      fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        std::thread::sleep(Duration::from_millis(50));
        Ok(buf.len())
      }
      fn flush(&mut self) -> std::io::Result<()> {
        std::thread::sleep(Duration::from_millis(50));
        Ok(())
      }
    }
    let log = EventLog::spawn(Slow, Duration::from_millis(1));
    let start = Instant::now();
    for i in 0..200 {
      log.record(build_record("E", json!({ "i": i })));
    }
    assert!(
      start.elapsed() < Duration::from_millis(200),
      "200 emits took {:?}",
      start.elapsed()
    );
  }

  #[test]
  fn now_ms_is_recent() {
    let t = now_ms();
    assert!(t > 1.6e12, "ts should be UNIX ms, got {t}");
  }
}
