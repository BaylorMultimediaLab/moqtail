# Measurement schema and metric definitions

This is the shared, mechanism-neutral measurement layer on `harness`. It is
inherited unchanged by `switch/native`, `switch/pr1378` and `switch/pr1674`, so
every run of every mechanism produces the same records and the same summary.
The field and event names below are those of `docs/rebuild-2026-10-04.md`
("Event contract changes"); fields marked _2026-10_ are additive and absent
from bundles recorded before the rebuild, which the analyzer still reads.

## Record format

Every component writes JSON Lines. One object per line:

```json
{ "ts": 1758240000123.4, "src": "client", "event": "SWITCH_SENT", "...": "..." }
```

| field     | meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `ts`      | UNIX milliseconds, `Date.now()` / `SystemTime::now()`. Comparable across processes on one host. |
| `perf`    | (client only) `performance.now()`; monotonic. `CLOCK_MAP` gives the mapping.                    |
| `src`     | `client`, `relay`, `publisher`, `runner`                                                        |
| `event`   | record type (below)                                                                             |
| `seq`     | (client only) per-run sequence number                                                           |
| `session` | (client only) page session; a reload starts a new one and the analyzer keeps only the last      |

Files per run (written by `experiments/run_experiment.py` into `results/<run_id>/`):
`client-events.jsonl`, `relay-events.jsonl`, `publisher-events.jsonl`,
`runner-events.jsonl`, `run_meta.json`, process logs, and after analysis
`summary.json` / `summary.md` / `switch_windows.csv` and `validation.json`.

Enable the logs by hand with `relay --event-log <file>`,
`publisher --event-log <file>` and the player URL parameter `?run=<id>`
(the Vite dev server writes `logs/<id>/client-events.jsonl`).

## Run metadata

`run_meta.json` carries an `identity` block (run id, git SHA, branch, mechanism,
`mechanism_mode`, `controller` (the ABR arm: `baseline`, `grid`, `min`; older
bundles: `probe`, `guard`, `both`) with `controller_params`, `client_type`,
`delay_groups`, `gop_duration_ms`, `ladder_id`, `network_profile`, `trace_id`,
`qdisc`, `congestion_controller` (_2026-10_; the analyzer assumes `bbr` when
absent, since every run before the rebuild used the relay's hard-coded BBR),
`relay_config`, `cache_meta_hash`, `kernel`, `tc_version`, `offloads_disabled`,
`warmup_s`, `controller_family`, `duration_s`, `background_flows`,
`repeat_index`, `timestamp_start`; `seed` is gone); every aggregate row is
rebuilt from it plus the raw logs. An aborted run also carries
`run_meta.validity.aborted = true`.

**Condition key.** Runs are pooled only when all of these agree
(`analyze.CONDITION_KEYS`, `compare.cond_key`): mechanism, mechanism mode,
controller arm and its parameters, ABR overrides, client type, delay groups,
network profile, qdisc, congestion controller, background flows, ladder id.

- client `RUN_META`: `run_id`, `relay_url`, `namespace`, `client_mode`
  (`live-edge`, `time-shifted`), `time_shift_s`, `delay_groups`,
  `target_shift_ms`, `gop_duration_ms`, `initial_bandwidth_bps`,
  `startup_track`, `abr_settings`, `controller` (the arm and every effective
  constant), `ladder` (track, bitrate). The ladder is the source of rung
  indices (0 = lowest bitrate) and of the bitrate behind every kbps metric.
- publisher `RUN_META`: `mode`, `gops_per_variant`, `loop`, `framerate`,
  `ladder`. `PUBLISHER_CONFIG` (_2026-10_): ladder with bitrates, GOP, priority
  per variant (one value for every variant, `--variant-priority`, default 128),
  cache path, `meta.json` hash, and `prft` (`per_object_at_send` in replay mode:
  each object's producer reference time is stamped when it is sent, so
  per-object latency is no longer group-granular; `per_frame_at_encode` live).
- runner `run_meta.json`: CLI arguments, profile (with resolved steps), git
  branch and SHA, host, network backend (`net_backend`; `none` = unshaped).

`delay_groups = round(time_shift_s * 1000 / gop_duration_ms)` and
`target_shift_ms = delay_groups * gop_duration_ms`.

## Event types

### Client (`apps/client-js/src/lib/events`)

| event                                                                                        | when                                                                                                                                                       | key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOCK_MAP`                                                                                  | log start                                                                                                                                                  | `performance_time_origin`, `date_now`, `user_agent`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CONNECT_START`, `CONNECTED`, `CATALOG`                                                      | connection setup                                                                                                                                           | `connect_ms`, `tracks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SUBSCRIBE_SENT`, `SUBSCRIBE_OK`                                                             | media SUBSCRIBE                                                                                                                                            | `track`, `delay_groups`, `largest_group`, `expected_start_group`, `rtt_ms`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `FIRST_OBJECT`                                                                               | first media object of the run                                                                                                                              | `group`, `object`, `expected_start_group`, `clamped`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `STARTUP`                                                                                    | first rendered frame                                                                                                                                       | `track`, `startup_delay_ms`, `connect_to_first_object_ms`, `first_object_to_first_frame_ms`, `source` (_2026-10_: `rvfc` / `raf`)                                                                                                                                                                                                                                                                                                                                                                    |
| `SAMPLE`                                                                                     | every 250 ms                                                                                                                                               | `buffer_s` (total: last range end − playhead), `buffer_contig_s` (_2026-10_: end of the range containing the playhead − playhead), `bitrate_kbps`, `track` (subscribed), `presented_track` (_2026-10_: the track whose frames are on screen), `group`, `playhead_ms`, `buffered_end_ms`, `live_edge_distance_ms`, `time_shift_error_ms`, `last_latency_ms`, `playback_rate`, `dropped_frames`, `total_frames`, `ready_state`, `paused`, `ended`, `buffered_ranges`, `watchdog_ticks`, `frozen_ticks` |
| `THROUGHPUT_SAMPLE`                                                                          | a group's SWMA sample is finalised                                                                                                                         | `track` (the group's track), `group`, `bytes`, `duration_ms` (arrival spacing from `recvAt`, _2026-10_), `bps`, `swma_bps`, `fast_ema_bps`, `slow_ema_bps`, `discarded_bytes` (_2026-10_)                                                                                                                                                                                                                                                                                                            |
| `ABR_TICK`                                                                                   | every controller tick                                                                                                                                      | `track`, `active_index`, `rules` (every rule's output), `skipped`, `chosen` (`index`, `priority`, `reason`, `rule`, `tied`; null = no request), signals (`buffer_s`, `buffer_contig_s`, `bandwidth_bps`, ...)                                                                                                                                                                                                                                                                                        |
| `ABR_DECISION`                                                                               | the switch **landed** on its target (since 2026-10-04; before, when the switch was requested)                                                              | `switch_seq` (_2026-10_ review addition: the seq of the switch it decided, same page-wide counter as SWITCH_SENT), `from`, `to`, indices, `reason`, `rule_reason`, `rule`, `priority`, the signals at the decision, `decided_ts` (epoch ms of the decision), `landed_after_ms`. The record's `ts` is the landing, never the decision time                                                                                                                                                            |
| `ABR_SWITCH_PHANTOM`                                                                         | a requested switch ended without landing on its target (refused, skipped or failed)                                                                        | `switch_seq` (_2026-10_ review addition), `from`, `to`, `landed` (the track the player stayed on), `reason`, `rule_reason`, `decided_ts` (_2026-10_ review addition; older clients: `decided_ms_ago`)                                                                                                                                                                                                                                                                                                |
| `ABR_GATED`, `ABR_GUARD_TIMEOUT`, `ABR_STRATEGY`, `ABR_UP_GUARD_RELEASED`, `PROBE_DISCARDED` | controller vetoes and guards                                                                                                                               | `why`, `from_index`, `to_index`, `released`, `fresh_samples`, `min_samples`; `how`; `bps`, `dt_ms`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RANGE_JUMP_DEFERRED`                                                                        | the buffer held a gap seek because new media was landing inside the gap (once per gap)                                                                     | `playhead_ms`, `range_end_ms`, `next_start_ms`, `append_front_ms`; the eventual `SEEK` carries `deferred_ms`                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATA_STARVED`, `DATA_RESUMED`                                                               | no media appended for 4 s with an empty buffer; data flows again                                                                                           | `track`, `request_id`, `pending`, `last_group`, `since_last_append_ms`, `init_pending`; `starved_ms`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WEDGE_UNHANDLED`, `MEDIA_ERROR`, `ERROR`, `SWITCH_INIT_RECOVERED`, `LATENCY_WINDOW_RESET`   | player failures and recoveries                                                                                                                             | `playhead_ms`, `ready_state`, `buffered_ranges`; `code`, `message`; `where`, `name`; `track`, `attempts`                                                                                                                                                                                                                                                                                                                                                                                             |
| `SWITCH_SENT`                                                                                | the SWITCH request                                                                                                                                         | `switch_seq` (_2026-10_: per session, from 1, monotonic), `from`, `to`, `request_id`, `old_request_id`, `playhead_ms`, `playhead_group`, `last_received_group`, `buffered_end_ms` (the append front)                                                                                                                                                                                                                                                                                                 |
| `SWITCH_OK`, `SWITCH_ERROR`, `SWITCH_SKIPPED`                                                | the relay's answer; a request not sent (previous switch has no alias yet)                                                                                  | `switch_seq`, `to`, `request_id`, `rtt_ms`; `reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SWITCH_FLOOR`                                                                               | (pr1378) how the Minimum Switching Group ID was chosen, just before SWITCH_SENT                                                                            | `switch_seq`, `switch_floor` (mode), `recv_floor_group`, `buffer_floor_group`, `selected_min_group`, `playhead_group`, `buffer_end_s`, `buffered_ranges`                                                                                                                                                                                                                                                                                                                                             |
| `SWITCH_FIRST_OBJECT`                                                                        | the landing object of the new track arrives                                                                                                                | `switch_seq`, `from`, `to`, `group`, `object`, `since_sent_ms`, `landed_on_keyframe` (_2026-10_)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SWITCH_APPLIED`                                                                             | the first target object passes the keyframe gate (first object appended; _2026-10_, previously the landing object)                                         | `switch_seq`, `from`, `to`, `group`, `object`, `new_start_pts_ms`, `old_end_pts_ms`, `media_seam_gap_ms` (first appended target PTS − last source end PTS), `seam_ahead_of_playhead_ms` (first appended target PTS − playhead at send), `landed_on_group_start`, `landed_on_keyframe` (landing object), `landing_object`, `first_appended_object`, `discarded_before_keyframe` (_2026-10_), `since_sent_ms`                                                                                          |
| `SWITCH_FIRST_FRAME`                                                                         | first _presented_ frame of the new representation: a frame whose `mediaTime` lies in `[seam_pts, target_append_front]` (_2026-10_ bound)                   | `switch_seq`, `from`, `to`, `switch_visibility_delay_ms` (since SWITCH_SENT, performance clock), `playback_position_jump_ms`, `viewer_pause_ms`, `seam_buffer_hole_ms` / `buffer_hole_behind_ms`, `seam_pts_ms`, `presented_pts_ms`, `seam_behind_playhead` (_2026-10_), `source` (`rvfc` / `raf`, _2026-10_)                                                                                                                                                                                        |
| `SWITCH_SUPERSEDED` (_2026-10_)                                                              | a newer switch landed before this one's seam was presented (the pending seam was overwritten)                                                              | `switch_seq`, `by_switch_seq`, `playhead_ms`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DROP_STALE`                                                                                 | object of a non-current track discarded                                                                                                                    | `track`, `group`, `object`, `bytes`, `reason` (absent = stale track, `pre-landing`, `init-pending`, `pre-keyframe`, `unrouted` (_2026-10_: library-level discard of a stream whose alias has no route)), `current`, `pending`                                                                                                                                                                                                                                                                        |
| `STALL_START`, `STALL_END`                                                                   | rebuffer episode (a `frozen` episode's start is backdated to the first frozen watchdog tick: `duration_ms` counts from there, STALL_START is logged later) | `cause` (`waiting` from the element, `frozen` from the frame counter), `track` (the presented track, _2026-10_), `duration_ms`, `playhead_ms`                                                                                                                                                                                                                                                                                                                                                        |
| `SEEK`                                                                                       | playhead moved by code                                                                                                                                     | `reason` (`startup`; `gap` = the playhead crossed a buffered hole or jumped to a later range, with `from_ms`, `to_ms`, `gap_ms`, `deferred_ms`; `wedge` = no later range existed, recovery seek; `visibility`). Old bundles: `range-jump` and `unwedge`, which the analyzer reads as `gap`                                                                                                                                                                                                           |
| `PLAYBACK_RATE`                                                                              | catch-up / catch-down / reset                                                                                                                              | `rate`, `reason`, `latency_s` (buffered-end distance, not the PRFT latency), `target_s`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PROBE`                                                                                      | active bandwidth probe result                                                                                                                              | `p_bytes`, `v_bytes`, `dt_ms`, `bps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `OBJECT_RECV`                                                                                | every object (only with `?logObjects=1`)                                                                                                                   | `track`, `group`, `object`, `bytes`, `pts_ms`, `prft_capture_ms`, `latency_ms`                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Relay (`apps/relay/src/server/events.rs`)

| event                                       | fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_CONFIG` (_2026-10_)                  | at start, flat, every resolved config field: `port`, `host`, `cert_file`, `key_file`, `congestion_controller` (`cubic`/`bbr`), `cc_initial_window_bytes`, `udp_gso` (`off`/`on`), `keep_alive_interval_s`, `max_idle_timeout_s`, `cache_size`, `cache_expiration_type`, `cache_expiration_minutes`, `log_folder`, `event_log`, `enable_object_logging`, `enable_token_logging`, `token_log_path`, `io_sockets`, `max_request_streams`, `max_active_requests`, `max_subscriber_lag`, `max_publish_streams`, `write_kbps_limit`, `redirect_uri`, `max_upstream_fetch_gaps`, `upstream_fetch_timeout_secs`, `upstream_subscribe_timeout_secs`, `track_alias_resolution_timeout_ms`, `downstream_alias_timeout_ms`, `publish_done_stream_timeout_ms`, `dedup_retained_groups`, `forward_promotion_trigger` (false on harness), `quinn_transport` (quinn TransportConfig debug text); `t_switch_ms` on pr1378. The runner refuses a run whose `congestion_controller` or `udp_gso` differ from what it pinned |
| `SUBSCRIBE_RECV`                            | `conn`, `request_id`, `track`, `is_switch`, `delay_groups`, `decision` (`live`/`ready`/`clamped`), `largest_group`, `oldest_cached_group`, `start_group`, `held`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SUBSCRIBE_HOLD`                            | a delayed SUBSCRIBE waiting for the live edge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SWITCH_RECV`                               | `conn`, `request_id` (may be null on pr1378), `old_request_id`, `track`, `minimum_switching_group` (pr1378)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SWITCH_PROMOTED`                           | the new track became Current: `track`, `start_group`, `trigger_group`, `trigger_object`, `trigger_forwarded`, `old_track`, `old_last_sent_group` (_2026-10_). `trigger_forwarded` is false on harness (as-shipped native never forwards the trigger); on native forward-trigger it reports whether the trigger's write succeeded, and the record is written after that object's `OBJECT_SENT`. Emitted by native, native forward-trigger and pr1378; the validator requires the stamp on every non-failed switch there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SWITCH_DEMOTED` (_2026-10_)                | (native) the demoted subscription stopped forwarding: `conn`, `relay_track_id`, `old_track`, `last_group`, `last_object` (its last accepted write), `stop_group`, `stop_object`; also for a pending target superseded by a newer SWITCH. Join on (`conn`, `old_track`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SWITCH_WAIT` (_2026-10_)                   | (pr1378) selection waits for the floor: `floor`, `live_edge_current`, `live_edge_target`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PROBE`                                     | synthetic probe served                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OBJECT_SENT`                               | one object handed to a subscriber's stream (`--enable-object-logging`): `conn`, `relay_track_id`, `track`, `request_id`, `group`, `object`, `sent` (true only when the QUIC write succeeded, _2026-10_; it means accepted into quinn's send buffer, not transmitted or acknowledged). Since 2026-10 a joining replay's overlap with the live path is dropped before the write, so duplicates no longer appear as `sent: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CONN_STATS`                                | once per second per connection, cumulative counters: `conn`, `transport`, `rtt_ms` (smoothed), `cwnd`, `lost_packets`, `lost_bytes`, `sent_packets`, `congestion_events`, `udp_tx_bytes`, `udp_rx_bytes`, `udp_tx_datagrams`, `udp_tx_ios` (datagrams per I/O > 1 means UDP segmentation batches), `current_mtu`, `ssthresh` (CUBIC after its first congestion event, else null), `bbr_pacing_rate_bps` (BBR only; quinn does not use it), `pacer_rate_bps` (1.25 × cwnd × 8 / smoothed RTT: the rate quinn's pacer actually allows, for every controller). Quinn 0.11 exposes no application-limited flag. The analyzer's `conn` block picks the connection with the most bytes sent (the client's)                                                                                                                                                                                                                                                                                                     |
| `CACHE_STATS`, `CACHE_GROUP`, `CACHE_EVICT` | per-track cache size once per second (`groups`, `bytes`, `oldest_group`, `newest_group`, exact since 2026-10: maintained on insert and eviction); a group's first object entered the cache (`relay_track_id`, `group`, `first_object`); evictions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Publisher (`apps/publisher/src/events.rs`)

`RUN_META` once, `PUBLISHER_CONFIG` once (_2026-10_), then `GROUP_EMIT` per group
per variant (`track`, `group`, `objects`, `bytes`). With `--no-loop` (the runner
default) the source GOP of group `g` is `g`.

### Runner (`experiments/run_experiment.py`)

`NET_CHANGE` (`rate_mbps` (null = unshaped), `delay_ms`, `loss_pct`, `queue`,
`queue_pkts`, `at_s`, `applied`; _2026-10_: `apply_started_ts`, `elapsed_s`,
`tc` (list of the resolved command lines), `qdisc_stats` (`net.leaf_stats`:
`{leaf, tree, raw}`; `leaf` is the bottleneck leaf of `tc -s qdisc show` (the
netem root on an unshaped step), null when not found: `kind`, `handle`,
`parent`, `options`, `sent_bytes`, `sent_pkts` (counts GSO segments),
`dropped`, `overlimits`, `requeues`, `backlog_bytes`, `backlog_pkts` (skbs),
fq_codel only: `maxpacket`, `drop_overlimit`, `new_flow_count`, `ecn_mark`;
and the GSO evidence `max_skb_bytes`, `backlog_bytes_per_skb`,
`gso_at_qdisc` (true / false / null = unknown); `tree` is every parsed qdisc
with the same fields, `raw` the `tc -s` text), `offloads`), `BG_FLOWS`, `BG_FLOW_ON`,
`BG_FLOW_OFF`, `BROWSER_START` (_2026-10_: `warmup_measured_s`),
`PUBLISHER_READY`, `CLIENT_READY` (_2026-10_), `PROC_STATS` (`process`,
`rss_bytes`, `cpu_pct`), `RUN_END` (`elapsed_s`; _2026-10_: final
`qdisc_stats`), `RUN_ABORT`. `applied` is false on the `none` backend
(unshaped by design).

## Switch identity and terminal states

One switch = one `SWITCH_SENT`. Every later record of the same switch carries
its `switch_seq` and the analyzer joins by it (`analyze.join_switches`).

**Fallback join** (bundles without `switch_seq`, `analyze._fallback_join`).
The client before 2026-10-04 kept one pending seam per stream and overwrote it
whenever a newer switch landed, so a first-frame record always belongs to the
_latest_ switch with that seam:

- `SWITCH_FIRST_FRAME`, `SWITCH_FIRST_OBJECT`, `SWITCH_APPLIED`: the last
  `SWITCH_SENT` with `ts <= record.ts` whose `from` AND `to` both match the
  record's. If that switch already holds such a record the new one is counted
  in `switches.join.duplicates`; it is never moved to an earlier switch. A
  record whose `from` matches no SWITCH_SENT (the source changed between send
  and landing) is joined on `to` alone and counted in `join.to_only_joins`.
- `SWITCH_OK`, `SWITCH_ERROR`: the SWITCH_SENT with the same `request_id`;
  without one (pr1378 adopts the relay's id) the earliest unanswered
  SWITCH_SENT to the same target.
- `SWITCH_FLOOR` (pr1378, emitted just before its SWITCH_SENT): the next
  SWITCH_SENT.
- `SWITCH_SKIPPED` and `SWITCH_SUPERSEDED`: only by `switch_seq`. Old clients
  emitted SKIPPED _instead of_ a SWITCH_SENT, so it is not a switch; such
  records are counted as `switches.skipped_not_sent`.
- Every other unresolved switch to the first frame's target is superseded,
  and more generally every switch without its own first frame whose pending
  state a later switch overwrote (below).

Before 2026-10-04 the analyzer gave one first-frame record to every earlier
unresolved switch with the same target (C1). On fresh-grid-v2 that inflated
visibility p50 by up to 2x and p95 by 4-5x (native time-shifted 2427 → 2072 ms
and 35196 → 7864 ms; pr1378 time-shifted 10308 → 5155 ms and 52433 → 10503 ms)
and undercounted superseded switches (median per run 1 → 15 native
time-shifted, 10 → 21 pr1378 time-shifted).

**Terminal.** Every switch ends in exactly one of (`switches.list[].terminal`,
counts in `switches.terminals`):

| terminal      | meaning                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first_frame` | its own `SWITCH_FIRST_FRAME`: the viewer saw this representation                                                                                                                                                                                                                                                                                                                                                 |
| `superseded`  | `SWITCH_SUPERSEDED` record (`superseded_by` = `by_switch_seq`), or, when there is none, inferred (`terminal_source: inferred`): this switch landed and a later switch landed (or became visible) before this one's first frame, overwriting its pending seam; or this switch had not landed when a later switch was acknowledged (`SWITCH_OK` replaces the pending switch). `superseded_by` is that later switch |
| `error`       | `SWITCH_ERROR`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `skipped`     | `SWITCH_SKIPPED` joined by `switch_seq`                                                                                                                                                                                                                                                                                                                                                                          |
| `open`        | none of the above before the run ended                                                                                                                                                                                                                                                                                                                                                                           |

Precedence when several apply: `error`, `skipped`, `first_frame`,
`superseded`, `open`; a switch with both its own first frame and a
SWITCH_SUPERSEDED record is `first_frame` and counted in
`join.conflicting_terminals`. `superseded_frac` = superseded / count. Join
diagnostics (`switches.join`: unjoined and duplicate records, conflicting
terminals, `to_only_joins`, whether `switch_seq` was used) are checked by
`validate.py` (`terminals`, and `pf-terminal` with `--preflight`, which also
fails a terminal inferred without its record on a `switch_seq` bundle).

## Metric definitions

The headline set and its definitions are those of the table "Metric
definitions (W1)" in `docs/rebuild-2026-10-04.md`, which is normative: where
this file or the analyzer disagree with it, the contract wins. The table below
repeats every row with its exact implementation (per run, last client
session; `summary.json` path in parentheses). Everything not listed here is a
diagnostic and lives in `summary.json` / the `diagnostics` block of
`compare.py`.

| name                                                                                                              | definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `switches_per_min` (`switching.switches_per_minute`)                                                              | SWITCH_SENT count / `run_duration_s` in minutes, where `run_duration_s` = ((`RUN_END` or last `SAMPLE`) − `STARTUP`). The span between the first and last switch is kept as `switch_span_s` (diagnostic only; it made two switches 1 s apart 120/min).                                                                                                                                                                                                                                                             |
| `aba_reversals` (`switching.aba_reversals`)                                                                       | consecutive switches in opposite directions within 5 s (`--reversal-window`) with `a.from == b.to`; `direction_reversals` without the A→B→A condition                                                                                                                                                                                                                                                                                                                                                              |
| `superseded_frac` (`switches.superseded_frac`)                                                                    | switches with terminal `superseded` / switches (see above)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `presented_rung_mean`, `presented_kbps` (`bitrate.presented_*`)                                                   | time-weighted over SAMPLE intervals in which the playhead advanced (> 1 ms), of the rung / ladder bitrate of the _presented_ track: `SAMPLE.presented_track` when present (`presented_source: sample`), else the startup track until the first own first frame and then each `first_frame` switch's target until the next (`presented_source: first_frame`)                                                                                                                                                        |
| `subscribed_rung_mean`, `subscribed_kbps` (`bitrate.subscribed_*`)                                                | the old `mean_rung_index` / `time_weighted_mean_kbps`: wall-time weighted over `SAMPLE.track` (changes at landing, counts stalled time). Diagnostic; legacy keys kept                                                                                                                                                                                                                                                                                                                                              |
| `fit_share_low` (`shares.fit_share_low`)                                                                          | share of advancing-playhead time in `[t_drop + 5 s, t_restore)` whose presented rung ≤ `fit_rung`, the highest rung with bitrate ≤ 0.9 × the low rate (the lowest rung when none fits). `t_drop` = first NET_CHANGE that lowers the rate, `t_restore` = first later NET_CHANGE that raises it (run end when absent)                                                                                                                                                                                                |
| `pre_drop_share_after_restore` (`shares.pre_drop_share_after_restore`)                                            | share of advancing-playhead time in `[t_restore + 5 s, end)` (end = RUN_END or the last SAMPLE) whose presented rung ≥ `pre_drop_rung`, the median presented rung of the SAMPLEs in the 20 s before `t_drop` (the lower median, so it is a rung; reported as `shares.pre_drop_rung`)                                                                                                                                                                                                                               |
| `stall_s`, `stall_count`, `stall_blips` (`stalls.total_ms`, `stalls.count`, `stalls.blips`)                       | STALL_START/STALL_END episodes ≥ 250 ms starting after the first frame. An episode starts at `STALL_END.ts − duration_ms`: the player backdates a `frozen` stall to its first frozen watchdog tick, so its STALL_START is logged 0.5-1 s after the stall began; `STALL_START.ts` is used only for an episode still open at the run end, which is counted to the end. Shorter episodes are `stalls.blips` / `blips_ms` (15-30 ms `waiting` blips around gap seeks), reported beside the stall count and never in it |
| `media_skipped_s` (`stalls.media_skipped_ms`)                                                                     | sum of `to_ms − from_ms` over `gap` seeks (`range-jump` / `unwedge` on old bundles) with `ts` after the initial window (so the startup positioning jump is excluded); `stalls.gap_seeks` counts them. `wedge` seeks are listed apart (`wedge_seeks`, `wedge_skipped_ms`)                                                                                                                                                                                                                                           |
| `starvation_s` (`starvation.total_ms`)                                                                            | stall time (the episodes ≥ 250 ms above) that lies inside a starvation episode (DATA_STARVED → DATA_RESUMED or run end: nothing appended for 4 s with ≤ 0.5 s left), so a **subset** of `stall_s` by construction; never add the two. The client times a starvation episode from the last append, so the raw episode also covers the seconds in which the buffer played out (fresh-grid-v2 pr1378 time-shifted r1: 10.8 s raw, 0 s stalled); the raw total is the diagnostic `starvation.raw_total_ms`             |
| `viewer_pause_p95_ms`, `visibility_p50_ms` (`switches.viewer_pause_ms`, `switches.switch_visibility_delay_ms`)    | over switches with terminal `first_frame` only. Visibility = the record's own `switch_visibility_delay_ms` (wall-clock `ff.ts − sent.ts` only when the field is absent). Also restricted to own first frames: `playback_position_jump_ms`, `seam_buffer_hole_ms`                                                                                                                                                                                                                                                   |
| `startup_ms` (`startup.startup_delay_ms`)                                                                         | `STARTUP.startup_delay_ms`: CONNECT_START to the first frame reported by `requestVideoFrameCallback`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `retained_live_edge_s` (`time_shift.retained_live_edge_ms`)                                                       | time-shifted client: mean live-edge distance over the SAMPLEs within 60 s of the last SAMPLE (by time, not a count of records)                                                                                                                                                                                                                                                                                                                                                                                     |
| `half_shift_lost_frac`, `time_to_half_shift_s` (`time_shift.half_shift_lost`, `time_shift.time_to_half_shift_ms`) | time-shifted client: whether, and when after STARTUP, a sample after the initial window had `live_edge_distance_ms < target_shift_ms / 2`. Per condition: the fraction of runs with the event (`k/n`), and the censored median of `time_to_half_shift_ms` with never = ∞. `null` = never (`half_shift_lost: false`); `half_shift_lost` is `null` for a live-edge client (not applicable)                                                                                                                           |
| `live_edge_mean_ms` (`time_shift.live_edge_after_window_ms.mean`)                                                 | live-edge client: mean `live_edge_distance_ms` over samples after the initial window                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `landed_on_keyframe_frac` (`switches.landed_on_keyframe / landed_on_keyframe_known`)                              | landing object's moof carries the sync-sample flag (`landed_on_group_start` only says it was object 0). The flag is read from `SWITCH_FIRST_OBJECT.landed_on_keyframe` (the landing object, _2026-10_), falling back to `SWITCH_APPLIED` for older bundles, so a switch that landed off a keyframe and was superseded before the keyframe gate appended anything (no SWITCH_APPLIED) stays in the denominator; `pf-keyframe` uses these counts                                                                     |

**Reaction metrics** (`reaction.down_reaction_ms`, `reaction.up_recovery_ms`,
`down_t2_ms`, `down_t4_ms`, `up_t2_ms`): after the first capacity drop, the
time until the _presented_ rung is ≤ `fit_rung` and stays there for
`--sustain` (5 s); after the first restore, until it is ≥ the pre-drop rung
(median presented rung over the 20 s before the drop) and stays there. They
are computed only when the presented rung at the drop is above `fit_rung`
(`detection[].precondition`; a client already at a fitting rung has nothing to
react to and used to report 3-250 ms "reactions", C2) and reported only from
the `detect_step` profile; otherwise every field is `null` and
`reaction.reaction_na_reason` says why. The per-change `detection` records
(t1 throughput sample, t2 decision, t3 sent, t4 first object, t5 first frame,
`quiet_before` attribution, `offset_recovery_ms`) stay as diagnostics for every
profile.

**Censored metrics** (`time_to_half_shift_ms`, `down_reaction_ms`,
`up_recovery_ms`): per run the value is a number or `null` = the event never
happened before the run ended. Per condition they are summarised in seconds as
`{"n": runs with the event (k), "of": applicable runs (n), "median_s": median
over the runs with the event (survivorship-biased, for reference only),
"median_censored_s": median with never = +inf}` (`analyze.censored_summary`;
`analyze.py --stats` columns `<name>_n`, `<name>_of`, `<name>_median_s`,
`<name>_median_censored_s` with `<name>` the column without `_ms`).
`compare.py` prints `k/n` beside the censored median (`inf` when at least half
the runs never had the event); runs where the metric is not applicable
(live-edge client, reaction N/A) leave the denominator. Bernoulli metrics
(`half_shift_lost`, `detection_reliable`, `down_reliable`, `up_reliable`,
`session_destroyed`) are reported as fractions `k/n`, never as a median.

Other definitions, unchanged:

- **Time-shift error** (signed) = `live_edge_distance_ms - target_shift_ms`,
  where `live_edge_distance_ms = (prft.media_ms + (now - prft.capture_ms)) - playhead_ms`
  from the most recent Producer Reference Time box. A live-edge client's
  target is 0. The shift is _held_ against the buffered end (rate control) but
  _measured_ against the PRFT live edge; a delivery pause makes the controller
  catch down and the two diverge, so part of `time_shift_error` is the rate
  controller's reaction, not the mechanism's displacement.
- **Switch timeline** per switch (`switches.list[]`): `t2_decision_ms`
  (SWITCH_SENT − the decision time of its decision, below), `t3_ok_ms`, relay `relay_recv_ms` /
  `relay_promoted_ms` (+ `relay_start_group`), `switch_delivery_latency_ms`
  (t4, SWITCH_FIRST_OBJECT), `applied_ms` with `media_seam_gap_ms`,
  `seam_ahead_of_playhead_ms`, `landed_on_group_start`, `landed_on_keyframe`,
  `discarded_before_keyframe`; `switch_visibility_delay_ms` (t5) with
  `playback_position_jump_ms`, `viewer_pause_ms`, `seam_buffer_hole_ms` (the
  client's `buffer_hole_behind_ms` attributed to this seam only when the first
  presented frame is more than 100 ms past the seam PTS), `seam_behind_playhead`;
  `seam_dropped_source_frames` (source objects discarded within 3 s of landing);
  `selected_min_group` (pr1378). Delivery-side statistics (`switch_delivery_latency_ms`,
  `relay_promoted_ms`, `media_seam_gap_ms`, `seam_ahead_of_playhead_ms`) are over
  every landed switch; seam statistics over own first frames only.
  `landed_behind_playhead` counts switches whose seam lay more than half a GOP
  behind the playhead at send.
- **Switching diagnostics** (`switching`): inter-switch interval median/min,
  cooldown activations, slow-start and up-guard vetoes, probes discarded,
  switches by triggering rule (`switches_by_rule`) and where each rule came from
  (`decision_sources`).
- **Decision attribution** (`analyze.join_decisions`; per switch `reason`,
  `rule_reason`, `decided_ts`, `t2_decision_ms`, `decision_source`). The
  controller logs `ABR_DECISION` when the switch lands (its `ts` is the landing)
  and `ABR_SWITCH_PHANTOM` when it ends without landing; a switch still pending
  at the run end has neither. Each switch takes, in this order and each record
  once: the `ABR_DECISION` with its `switch_seq` (`switch_seq`); else the latest
  `ABR_DECISION` with the same `from` and `to` and `0 ≤ SENT.ts − decided_ts ≤
1000 ms` (`decided_ts`); else, for clients before 2026-10-04 (no
  `decided_ts`, logged at the decision), the latest with the same `to` and
  `−5 ≤ SENT.ts − ts ≤ 1000 ms` (`legacy_ts`); else `ABR_SWITCH_PHANTOM` by
  `switch_seq` or by decision time as above (`phantom`); else the last
  `ABR_TICK` at or before SWITCH_SENT (within 1000 ms) whose `chosen.index` is
  the target's rung (`tick`; `reason` from the direction, `auto-emergency` when
  `chosen.rule` is EmergencyBufferRule). The decision time, never the
  record's `ts`, is what t2, the detection timelines (`t2_ms`,
  `quiet_before`, `reliable`), `switches_by_rule` and the feedback windows'
  rule use. Decisions and phantoms that joined no switch (old clients skipped
  the request without a SWITCH_SENT) stay decision events for the detection
  timelines and are counted in `switches.decision_join`.
- **Feedback windows** (`feedback`, `switch_windows.csv`): per switch, a
  ±5 s alignment of throughput samples, latency, the latency-trend peak, rule
  votes and the next switch.
- **Initial window** (`time_shift.initial_window`): the first 5 s after the
  first presented frame; the mean live-edge distance in it is the shift the
  relay delivered before playback drift (the validator's setup check).
- **Playback progress** (`playback`): advancing fraction, longest no-progress
  stretch, and the longest stretch / total without progress WHILE playable data
  existed (`buffer_s >= 0.5 s` or a later buffered range): a player wedge, i.e.
  an apparatus failure, as opposed to starvation (an outcome). `samples` is the
  SAMPLE count after STARTUP.
- **Delivery integrity** (`delivery`, needs `--log-objects`): objects received
  per group; `short_groups`, `truncated_groups` (cut on the wire),
  `cut_at_relay` / `lost_after_send` with relay OBJECT_SENT. **Discarded**
  (`discarded`): DROP_STALE objects / bytes / groups, `pre_keyframe`, and
  `unrouted` / `unrouted_bytes` (library-level discards, 2026-10).
- **Link** (`link`): probe load, probe-measured throughput (`PROBE.bps`
  statistics and `probe_measured_per_step`: p50 per capacity step from 5 s after
  the step), relay→client object latency with `--log-objects`.
- **Relay / net / run_end** (`relay`, `net`, `run_end`): relay counters and the
  `RELAY_CONFIG` record; NET_CHANGE counts (applied, with `qdisc_stats`); RUN_END
  presence and `elapsed_s`.
- **Cache cost**: max/mean `CACHE_STATS.bytes` per track and summed, evictions;
  relay RSS and CPU from `PROC_STATS`.
- **Per-frame quality join**: `OBJECT_RECV` gives (`track`, `group`, `object`,
  `pts_ms`) per received frame; one object is one frame.

## Validity

`validate.py` checks one run and writes `validation.json`; the runner calls it
after every completed run and writes `{"passed": false, "final": false,
"failed": ["aborted"], "checks": []}` itself for an aborted run (and sets
`run_meta.validity.aborted`); either marker makes the run invalid, also when
it is validated again (`aborted` check, `analyze.read_validity`).
`analyze.py --csv/--stats`, `compare.py` and
`plot.py` include a run only when `validity.valid is True`
(`analyze.is_valid`): invalid, aborted and never-validated runs are excluded
unless `--include-invalid` / `--all`.

A run is invalid when the experiment cannot be interpreted because the
apparatus failed; it stays valid when the system under test performs badly,
even catastrophically, as long as the measurement remains correct. Checks:
`single-session`, `identity`, `aborted`, `completed` (RUN_END present and
`elapsed_s` within ±5 s of the configured duration), `samples` (SAMPLE count
≥ 0.9 × duration / 0.25 s), `net-applied` (every NET_CHANGE applied; the
`none` backend is unshaped by design), `live-edge` / `time-shifted` (setup
checks on the initial window), `ordering` (t2 ≤ t3 ≤ relay recv ≤ promoted ≤
t4 ≤ applied ≤ t5), `terminals` (one terminal per switch, no unjoined or
duplicate switch records), `relay-stamps` (`relay_promoted_ms` on every
non-failed switch, except those sent in the last 5 s, for native, native
forward-trigger and pr1378), `clocks`, `join`, `playback` (fails only on a
destroyed session or `longest_frozen_with_data_ms` above 10 s: a player wedge;
starvation of any length is an outcome), `clean-worktree` (`--final`).

`validate.py --preflight` adds the apparatus invariants of the rebuild contract
on a 60 s run per arm and client type: `pf-keyframe` (100 % keyframe landings;
reported, not asserted, for as-shipped native), `pf-behind`
(`landed_behind_playhead` = 0), `pf-terminal` (exactly one terminal per
switch; no switch open unless sent within 5 s + the target shift of the end;
on `switch_seq` bundles no terminal inferred without its record; no
conflicting, unjoined or duplicate records), `pf-unrouted` (DROP_STALE `unrouted`
bytes after the first switch settled; reported), `pf-relay-cc`
(`RELAY_CONFIG.congestion_controller` = identity), `pf-qdisc` (`qdisc_stats`
on every applied NET_CHANGE; the recorded `tc` commands contain netem, htb and
bfifo or fq_codel on a rate-limited step, netem alone on an unshaped one),
`pf-gso` (`qdisc_stats.leaf.gso_at_qdisc` false on every rate-limited
NET_CHANGE; fails when true, reported when unknown; a top-level
`gso_at_qdisc` is read only when the leaf has none), `pf-maxpacket` (`qdisc_stats.leaf.maxpacket`
≤ 1514 B when recorded; reported above, fails above 3000 B), `pf-warmup`
(`BROWSER_START.warmup_measured_s` within 15 ± 1 s; reported), `pf-offloads`
(`identity.offloads_disabled` true; reported), `pf-loss` (unshaped profile:
CONN_STATS loss rate < 0.1 %), `pf-delivery-rate` (every rate-limited step:
over [step + 10 s, next step) the median `THROUGHPUT_SAMPLE` rate of
link-limited groups, bytes × 8 / 50 ms ≥ rate, lies in [0.6, 1.15] × rate;
an out-of-band step is attributed with the probe's pure transfer rate in the
same window: as low as the video means the connection delivered that little
(transport), near the rate means client-side timing), `pf-probe-rate` (lowest
step ≤ 1.5 Mbps: probe-measured p50 ≥ 0.8 × rate; reported, since the `min`
arm runs without the probe). Reported checks print `INFO` and never fail the
run.

## Tests

`python3 -m unittest discover -s experiments/tests -t .` (from the repository
root) runs synthetic event logs that reproduce each audit finding (C1 repeated
targets, fallback edge cases and the `switch_seq` join, censoring, presented
vs subscribed rung, media skipped, stall blips, starvation as a subset,
aborted and unvalidated runs through `validate.py` and `compare.py`, reaction
preconditions, share windows, run-duration denominator, condition keys) plus
a regression on one real fresh-grid-v2 run (every switch has exactly one
terminal and the terminal counts sum to the switch count). The bundle is not
tracked by git; the test looks in `$MOQTAIL_FGV2_RESULTS` and then in
`results-linux-2026-10-01/fresh-grid-v2/results/` of the repository or any
parent directory, and is skipped when absent. `MOQTAIL_ANALYZE_DIR=<dir>` runs
the same tests against another `analyze.py` (the reproduction step).
