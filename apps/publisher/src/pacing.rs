use std::time::{Duration, Instant};

/// Holds emission until the wall-clock slot for GOP N arrives, simulating a
/// live source whose frames take real time to capture. Anchored to a single
/// `start` instant so the long-run rate is exactly one GOP per
/// `gop_duration_secs`. Returns immediately if we're already past the target
/// (the caller is slower than real-time and should just emit as soon as it can).
///
/// `start` should be `Instant::now()` captured once at the beginning of the
/// stream — passing a fresh `Instant::now()` per call would silently drift.
///
/// Used by both the live decoder ([crate::decoder]) and the cached-GOP
/// replay reader ([crate::replay]) so the pacing invariant is in one place.
pub fn pace_gop_emit(start: Instant, gop_duration_secs: f64, gop_id: u64) {
  let target = start + Duration::from_secs_f64(gop_duration_secs * (gop_id + 1) as f64);
  let now = Instant::now();
  if target > now {
    std::thread::sleep(target - now);
  }
}

/// Async variant: same anchored target, but yields to the tokio runtime
/// instead of blocking the OS thread. Use from async tasks
/// (e.g. [crate::replay]); `pace_gop_emit` is for `spawn_blocking` contexts.
pub async fn pace_gop_emit_async(start: Instant, gop_duration_secs: f64, gop_id: u64) {
  let target = start + Duration::from_secs_f64(gop_duration_secs * (gop_id + 1) as f64);
  let now = Instant::now();
  if target > now {
    tokio::time::sleep(target - now).await;
  }
}
