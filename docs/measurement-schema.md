# Measurement schema and metric definitions

This is the shared, mechanism-neutral measurement layer on `harness`. It is
inherited unchanged by `switch/native`, `switch/pr1378` and `switch/pr1674`, so
every run of every mechanism produces the same records and the same summary.

## Record format

Every component writes JSON Lines. One object per line:

```json
{ "ts": 1758240000123.4, "src": "client", "event": "SWITCH_SENT", "...": "..." }
```

| field   | meaning                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------- |
| `ts`    | UNIX milliseconds, `Date.now()` / `SystemTime::now()`. Comparable across processes on one host. |
| `perf`  | (client only) `performance.now()`; monotonic. `CLOCK_MAP` gives the mapping.                    |
| `src`   | `client`, `relay`, `publisher`, `runner`                                                        |
| `event` | record type (below)                                                                             |
| `seq`   | (client only) per-run sequence number                                                           |

Files per run (written by `experiments/run_experiment.py` into `results/<run_id>/`):
`client-events.jsonl`, `relay-events.jsonl`, `publisher-events.jsonl`,
`runner-events.jsonl`, `run_meta.json`, process logs, and after analysis
`summary.json` / `summary.md`.

Enable the logs by hand with `relay --event-log <file>`,
`publisher --event-log <file>` and the player URL parameter `?run=<id>`
(the Vite dev server writes `logs/<id>/client-events.jsonl`).

## Run metadata

`run_meta.json` carries an `identity` block (run id, git SHA, branch, mechanism,
`mechanism_mode`, `client_type`, `delay_groups`, `gop_duration_ms`, `ladder_id`,
`network_profile`, `trace_id`, `qdisc`, `background_flows`, `repeat_index`,
`timestamp_start`); every aggregate row is rebuilt from it plus the raw logs.
`experiments/validate.py` checks one run and writes `validation.json`; the
runner calls it after every run and stores `validity` in `run_meta.json`.
`analyze.py` excludes invalid runs (validation failed, more than one page
session, wall-clock gaps, and with `--final` a dirty worktree) from the
aggregate CSV and from `--stats`, which reports per condition median, IQR and
a bootstrap 95 % CI of the median across repetitions. `identity.dirty_worktree`
and `identity.final` are always recorded.

- client `RUN_META`: `run_id`, `relay_url`, `namespace`, `client_mode`
  (`live-edge` = live-edge client, `time-shifted` = time-shifted client),
  `time_shift_s`, `delay_groups`, `target_shift_ms`, `gop_duration_ms`,
  `initial_bandwidth_bps`, `startup_track`, `abr_settings`, `ladder`.
- publisher `RUN_META`: `mode` (`replay`/`live`), `gops_per_variant`, `loop`,
  `framerate`, `ladder` (track, resolution, bitrate, `gop_duration_ms`, codec).
- runner `run_meta.json`: CLI arguments, profile (with resolved steps), git
  branch and SHA, host, network backend.

`delay_groups = round(time_shift_s * 1000 / gop_duration_ms)` and
`target_shift_ms = delay_groups * gop_duration_ms`. The wire carries whole
groups, so the target is stated in groups, not in the seconds typed.

## Event types

### Client (`apps/client-js/src/lib/events`)

| event                                            | when                                                                                       | key fields                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOCK_MAP`                                      | log start                                                                                  | `performance_time_origin`, `date_now`, `user_agent`                                                                                                                                                                                                                                                                                                                             |
| `CONNECT_START`, `CONNECTED`, `CATALOG`          | connection setup                                                                           | `connect_ms`, `tracks`                                                                                                                                                                                                                                                                                                                                                          |
| `SUBSCRIBE_SENT`, `SUBSCRIBE_OK`                 | media SUBSCRIBE                                                                            | `track`, `delay_groups`, `largest_group`, `expected_start_group`, `rtt_ms`                                                                                                                                                                                                                                                                                                      |
| `FIRST_OBJECT`                                   | first media object of the run                                                              | `group`, `object`, `expected_start_group`, `clamped`                                                                                                                                                                                                                                                                                                                            |
| `STARTUP`                                        | first rendered frame                                                                       | `startup_delay_ms`, `connect_to_first_object_ms`, `first_object_to_first_frame_ms`                                                                                                                                                                                                                                                                                              |
| `SAMPLE`                                         | every 250 ms                                                                               | `buffer_s`, `bitrate_kbps`, `track`, `group`, `playhead_ms`, `buffered_end_ms`, `live_edge_distance_ms`, `time_shift_error_ms`, `last_latency_ms`, `playback_rate`, `dropped_frames`, `total_frames`                                                                                                                                                                            |
| `THROUGHPUT_SAMPLE`                              | a group's SWMA sample is finalised                                                         | `group`, `bytes`, `duration_ms`, `bps`, `swma_bps`, `fast_ema_bps`, `slow_ema_bps`                                                                                                                                                                                                                                                                                              |
| `ABR_TICK`                                       | every controller tick where rules ran                                                      | `rules` (every rule's index/priority/reason or null), `skipped`, `chosen`, signals                                                                                                                                                                                                                                                                                              |
| `ABR_DECISION`                                   | a switch is requested                                                                      | `from`, `to`, indices, `reason`, `rule_reason`, `priority`, signals                                                                                                                                                                                                                                                                                                             |
| `ABR_GATED`, `ABR_GUARD_TIMEOUT`, `ABR_STRATEGY` | slow-start veto, guard timeout, BOLA/throughput toggle                                     |                                                                                                                                                                                                                                                                                                                                                                                 |
| `SWITCH_SENT`, `SWITCH_OK`, `SWITCH_ERROR`       | the SWITCH request                                                                         | `request_id`, `old_request_id`, `playhead_ms`, `playhead_group`, `last_received_group`, `rtt_ms`                                                                                                                                                                                                                                                                                |
| `SWITCH_FIRST_OBJECT`                            | first object of the new track arrives                                                      | `group`, `object`, `since_sent_ms`                                                                                                                                                                                                                                                                                                                                              |
| `SWITCH_APPLIED`                                 | new init segment appended                                                                  | `media_seam_gap_ms` (first target PTS − last source end PTS), `seam_ahead_of_playhead_ms` (first target PTS − playhead at send: media still to play before the new representation is seen), `new_start_pts_ms`, `old_end_pts_ms`                                                                                                                                                |
| `SWITCH_FIRST_FRAME`                             | first _presented_ frame of the new representation (presented `mediaTime` crossed the seam) | `switch_visibility_delay_ms` (since SWITCH_SENT), `playback_position_jump_ms` (presented-mediaTime discontinuity beyond one frame; 0 = played through), `viewer_pause_ms` (wall-clock pause at the seam beyond one frame), `seam_buffer_hole_ms` (hole in the element's buffered ranges just before the presented frame's range; what a range-jump seek crosses), `seam_pts_ms` |
| `DROP_STALE`                                     | object of a non-current track discarded                                                    | `track`, `group`, `object`                                                                                                                                                                                                                                                                                                                                                      |
| `STALL_START`, `STALL_END`                       | rebuffer episode                                                                           | `cause` (`waiting` from the element, `frozen` from the frame counter), `duration_ms`, `playhead_ms`                                                                                                                                                                                                                                                                             |
| `SEEK`                                           | playhead moved by code                                                                     | `reason` (`startup`, `wedge`, `range-jump`, `visibility`), `from_ms`, `to_ms`, `gap_ms`                                                                                                                                                                                                                                                                                         |
| `PLAYBACK_RATE`                                  | catch-up / catch-down / reset                                                              | `rate`, `reason`, `latency_s`, `target_s`                                                                                                                                                                                                                                                                                                                                       |
| `PROBE`                                          | active bandwidth probe result                                                              | `p_bytes`, `v_bytes`, `dt_ms`, `bps`                                                                                                                                                                                                                                                                                                                                            |
| `OBJECT_RECV`                                    | every object (only with `?logObjects=1`)                                                   | `track`, `group`, `object`, `bytes`, `pts_ms`, `prft_capture_ms`, `latency_ms`                                                                                                                                                                                                                                                                                                  |
| `ERROR`                                          | any failure                                                                                | `where`, `message`                                                                                                                                                                                                                                                                                                                                                              |

### Relay (`apps/relay/src/server/events.rs`)

| event             | fields                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUBSCRIBE_RECV`  | `conn`, `request_id`, `track`, `is_switch`, `delay_groups`, `decision` (`live`/`ready`/`clamped`), `largest_group`, `oldest_cached_group`, `start_group`, `held` |
| `SUBSCRIBE_HOLD`  | a delayed SUBSCRIBE waiting for the live edge                                                                                                                    |
| `SWITCH_RECV`     | `conn`, `request_id`, `old_request_id`, `track`                                                                                                                  |
| `SWITCH_PROMOTED` | the new track became Current: `trigger_group`, `start_group`                                                                                                     |
| `PROBE`           | synthetic probe served                                                                                                                                           |
| `CACHE_STATS`     | once per second per track: `groups`, `bytes`, `oldest_group`, `newest_group`                                                                                     |
| `CACHE_GROUP`     | a group's first object entered a track's cache: `relay_track_id`, `group`, `first_object` (joins publisher `GROUP_EMIT` to client `OBJECT_RECV`)                 |
| `CACHE_EVICT`     | `group`, `objects`, `bytes`, `cause`                                                                                                                             |

Mechanism branches add their own relay events (for example a fill or
catch-up stream) using the same helper; they must keep these names.

### Publisher (`apps/publisher/src/events.rs`)

`RUN_META` once, then `GROUP_EMIT` per group per variant (`track`, `group`,
`objects`, `bytes`). In replay mode the source GOP of group `g` is
`g mod gops_per_variant`; with `--no-loop` (the runner default) it is `g`.

### Runner (`experiments/run_experiment.py`)

`NET_CHANGE` (`rate_mbps`, `delay_ms`, `loss_pct`, `queue`, `applied`),
`BG_FLOWS`, `BG_FLOW_ON`, `BG_FLOW_OFF`, `BROWSER_START`, `PROC_STATS`
(`process`, `rss_bytes`, `cpu_pct`), `RUN_END`, `RUN_ABORT`.

## Metric definitions

- **Startup delay** = `STARTUP.startup_delay_ms`: `CONNECT_START` to the
  first frame reported by `requestVideoFrameCallback`. Split into
  connect-to-first-object and first-object-to-first-frame.
- **Rebuffer episode**: from `STALL_START` to `STALL_END` after the first
  frame. `waiting` episodes come from the media element; `frozen` episodes
  from the frame counter not advancing for two 500 ms ticks while playing
  (credited from the first frozen tick). Seeks that jump a gap are listed
  separately because they end stalls the element would otherwise report.
- **Time-shift error** (signed) = `live_edge_distance_ms - target_shift_ms`,
  where `live_edge_distance_ms = (prft.media_ms + (now - prft.capture_ms)) - playhead_ms`
  from the most recent Producer Reference Time box on the video track.
  Positive means further behind live than requested. `abs` statistics are
  reported alongside. A live-edge client's target is 0, so its error equals
  its live-edge distance, which is the metric for that client type.
- **Switch timeline** per switch: `t2` decision (`ABR_DECISION`), `t3`
  `SWITCH_SENT` (and `SWITCH_OK` round trip), relay `SWITCH_RECV` and
  `SWITCH_PROMOTED` (with the group the relay started the new track at),
  `t4` = **switch_delivery_latency_ms** (`SWITCH_FIRST_OBJECT`), `SWITCH_APPLIED`
  with **media_seam_gap_ms** (buffer continuity at the seam) and
  **seam_ahead_of_playhead_ms** (how much media the viewer still plays before
  the new representation; on native SWITCH the playhead does _not_ jump, it
  plays through to the seam), `t5` = **switch_visibility_delay_ms**
  (`SWITCH_FIRST_FRAME`, the first presented frame past the seam) with
  **playback_position_jump_ms**, **viewer_pause_ms** and **seam_buffer_hole_ms**
  measured at that crossing, plus **seam_dropped_source_frames** (source objects
  discarded after landing because the relay kept delivering the source's
  in-progress group), **landed_on_group_start**, and **superseded** (a later
  switch landed before this seam was reached, so it was never visible). The names deliberately separate the buffer seam from the viewer's
  playback position.
- **Switching diagnostics** (`switching`): switches per minute, inter-switch
  interval median/min, direction reversals (consecutive opposite switches
  within `--reversal-window`, default 5 s) and A→B→A reversals, cooldown
  activations (`ABR_GUARD_TIMEOUT`), slow-start vetoes, switches by
  triggering rule.
- **Feedback windows** (`feedback`, `switch_windows.csv`): per switch, a
  ±`--feedback-window` (5 s) alignment of throughput samples, per-frame
  latency, the latency-trend peak, every rule's votes for a change, and the
  next switch (delay and its rule). The run summary counts switches followed
  within the window and how many of those the latency-trend rule triggered,
  which is the test of the self-induced feedback hypothesis.
- **Initial shift window** (`time_shift.initial_window`): the first
  `--initial-window` (5 s) after the first presented frame, with its start and
  end timestamps stored in the summary; the mean live-edge distance in it is
  the shift the relay delivered before playback drift.
- **Detection** per capacity change (`NET_CHANGE` = `t0`): `t1` is the first
  `THROUGHPUT_SAMPLE` within the tolerance of the new rate (25 % by default,
  `analyze.py --t1-tolerance`); `t2..t5` as above for the first decision in
  the right direction.
- **Recovery** after an up-step: quality recovery is the first `SAMPLE`
  whose track index is back at the pre-drop index; offset recovery is the
  first time `|time_shift_error| <= 500 ms` holds for 5 s.
- **Bitrate**: time-weighted mean of the active track's ladder bitrate over
  `SAMPLE`s, plus the share of time per track.
- **Cache cost**: max/mean `CACHE_STATS.bytes` per track and summed, eviction
  count and bytes; relay RSS and CPU from `PROC_STATS`. Payloads are shared
  with in-flight sends, so `RSS - bytes` fluctuates with delivery activity.
- **Per-frame quality join**: `OBJECT_RECV` gives (`track`, `group`, `object`,
  `pts_ms`) per received frame; one object is one frame, so a VMAF table
  keyed by (track, source GOP, frame) joins directly.
