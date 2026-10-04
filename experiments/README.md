# Experiments

Shared runner and analysis for the switching-mechanism branches. The code is
identical on `switch/native`, `switch/pr1378` and `switch/pr1674`; the branch
checked out decides the mechanism, `--mechanism` only labels the run and the
runner refuses a label that does not match HEAD.

This file describes the apparatus (runner, shaping, profiles). Metric and
record definitions are in `docs/measurement-schema.md`; the contract every
component follows is `docs/rebuild-2026-10-04.md`.

## Prerequisites

For a Linux machine, follow `docs/pilot-linux.md` end to end; it covers the
browser choice (Firefox, since Chrome cannot decode our HEVC on Linux), the
pinned relay certificate, shaping without running the runner as root, and
what to send back.

- `cargo build --release --workspace` (relay and publisher binaries; the
  runner rebuilds them per run unless `--no-rust-build`)
- a prepared GOP cache with a `meta.json` (`scripts/run-stack.sh` once, or
  the publisher's prepare mode as in `docs/pilot-linux.md` step 3)
- `npm install` at the repo root (Vite dev server serves the player)
- Firefox (preferred) or a Chromium on the PATH (or `--browser <path>`)
- for shaping: Linux, `iproute2` (`ip`, `tc`) and `ethtool`, as root or
  with passwordless sudo for those three (plus `kill`); for background
  traffic `iperf3`

## Shaping

One topology for both queue models, host-side veth egress (relay -> client):

```
relay (host, 10.200.0.1)                              browser (netns moqc, 10.200.0.2)
   |                                                                    ^
   v  veth-moqh egress                                                  |  veth-moqc egress
 [1:]  netem  delay 20ms limit 10000      propagation, never the      [1:] netem delay 20ms limit 10000
   |                                      bottleneck                     (return path: ACKs, SUBSCRIBE, SWITCH)
   v  parent 1:1
 [2:]  htb    class 2:10 rate R ceil R    the bottleneck rate
   |
   v  parent 2:10
 [20:] leaf   bfifo limit queue_pkts x 1500         tail-drop, counted in BYTES
          or  fq_codel limit 10240 target t interval 100ms ecn
              t = max(5 ms, 1.5 x 1500 x 8 / R)      recorded as codel_target_ms
   |
   v
 veth-moqc (ingress, netns)  ->  browser
```

`delay_ms` in a profile is the round trip; half is applied on each side.
Offloads are disabled on **both** veth ends (`ethtool -K <if> gso off tso off
gro off tx-udp-segmentation off rx-udp-gro-forwarding off`, one feature per
command so a name this kernel lacks is tolerated) **before** any qdisc is
added, and `ethtool -k` is read back and recorded.

GSO and the queue (audit C5). Turning device offloads off does **not** stop
an application's own UDP GSO batches from reaching the qdisc: quinn-udp
sends with `UDP_SEGMENT`, the kernel keeps the batch as one skb through the
qdisc and segments it only after dequeue (`validate_xmit_skb`), whatever
the device features say. Two consequences, and how the apparatus handles
them:

- The queue limit must not count skbs. The leaf is a `bfifo` whose limit is
  in **bytes** (`queue_pkts x 1500`), which is right for any skb size; the
  old `netem limit 100` counted skbs.
- HTB charges and releases a batch as one unit, so if batches reach the
  qdisc the shaped link is bursty at the scale of one batch (24 KB is
  128 ms at 1.5 Mbps). `tc -s` counts a batch as `gso_segs` packets, so
  bytes/packets cannot reveal it; the leaf's `gso_at_qdisc` does, from
  fq_codel's `maxpacket` (largest skb seen) and from the bytes per skb in
  the backlog. If the preflight finds batches, the fix is in the relay
  (quinn `TransportConfig::enable_segmentation_offload(false)`, W4) or,
  untested, `--offloads gso,tso,gro,tx-udp-segmentation,rx-udp-gro-forwarding,tx`
  (without checksum offload the kernel refuses UDP GSO with `EIO`, after
  which quinn-udp stops batching).

Why netem is the root. netem is classful with exactly one class (`1:1`) and
netem(8) documents it as the parent of a rate limiter; the kernel's
`netem_find` accepts any class id, so `parent 1:1` (used here) and
`parent 1:` both attach the child. The delay line is traversed first and
the bottleneck queue second, which keeps the queue after the propagation
delay like a real access link, and lets tail-drop and fq_codel differ in
**one line** (the leaf; audit M2). The alternatives were rejected: HTB root
with a netem leaf cannot host a second leaf for the AQM arm, and an IFB
would move the delay to the ingress side with a different drop point.
Whether this kernel accepts a child under netem is settled by `--verify`
(below) and by the preflight.

Capacity steps are applied **in place** (`tc class change` for the rate,
`tc qdisc change` for the leaf and, when delay or loss change, the netems).
The tree is built once per run and never deleted between steps, so nothing
queued is dropped at the instant the reaction metrics start (audit M1). The
only `del root` is at setup, to clear a leftover from a crashed run.

Review the exact commands without running anything (works on macOS):

```sh
python3 experiments/net.py --dry-run --profile experiments/profiles/step_down_up.json
python3 experiments/net.py --dry-run --profile experiments/profiles/step_down_up_fqcodel.json
```

Build the tree on Linux, check it, tear it down (needs root/sudo):

```sh
sudo python3 experiments/net.py --verify --profile experiments/profiles/step_down_up.json
```

`--verify` builds the namespace and step 0, then requires `tc qdisc show
dev veth-moqh` to list exactly netem `1:` root, htb `2:` parent `1:1` and the
leaf `20:` parent `2:10` (and a root netem on the namespace side), printing
the tree and the parsed counters; it fails loudly otherwise. The runner runs
the same check after its first `apply` and aborts the run if it fails.

### What is recorded where

| where                                              | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner-events.jsonl` `NET_CHANGE` (every step)    | `ts` (when the last `tc` command of the step returned, i.e. the change is in force), `apply_started_ts`, `elapsed_s` (since the browser spawn; null for step 0), `rate_mbps`, `delay_ms`, `loss_pct`, `jitter_ms`, `queue`, `queue_pkts`, `queue_bytes` (bfifo) or `codel_target_ms`/`codel_interval_ms`/`codel_limit_pkts`/`codel_ecn` (fq_codel), `netem_limit_pkts`, `at_s`, `step_index`, `applied`, `tc` (the resolved command lines run for this step), `qdisc_stats`, `offloads`                                                                                |
| `qdisc_stats`                                      | `leaf`: kind, handle, parent, options, `sent_bytes`, `sent_pkts` (GSO segments), `dropped` (skbs), `overlimits`, `requeues`, `backlog_bytes`, `backlog_pkts` (skbs); fq_codel adds `maxpacket`, `ecn_mark` (CE marks: congestion signals that are not drops), `drop_overlimit`, `new_flow_count`; GSO evidence `max_skb_bytes`, `backlog_bytes_per_skb`, `gso_at_qdisc` (true / false / null = no evidence); `tree`: every qdisc parsed from `tc -s qdisc show`; `raw`: the text. Counters are cumulative: per-step values are differences between consecutive records |
| `offloads`                                         | per end (`host`, `ns`): requested feature -> `off`, `on`, `off [fixed]`, `absent`; `all_off`; the `ethtool -K` results                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RUN_END`                                          | `elapsed_s`, final `qdisc_stats`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PUBLISHER_READY`, `CLIENT_READY`, `BROWSER_START` | readiness gates (below): `first_group_emit_ts`, `browser_gate_ts` (= that ts + warm-up), `after_browser_spawn_s`, `warmup_measured_s` (browser spawn − first GROUP_EMIT)                                                                                                                                                                                                                                                                                                                                                                                               |
| `RUN_ABORT`                                        | `error`: why the run stopped early                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `run_meta.json` `net`                              | the resolved `Topology` (interfaces, queue, limits, offload list), the offload summary, `kernel`, `tc_version`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `run_meta.json` `identity`                         | ... `qdisc`, `congestion_controller`, `relay_config`, `cache_meta_hash`, `kernel`, `tc_version`, `offloads_disabled`, `warmup_s` (see Identity)                                                                                                                                                                                                                                                                                                                                                                                                                        |

## What a run does

1. Checks, before anything starts: branch matches `--mechanism`; the GOP
   cache exists and `duration + warmup + 30 <= gops_per_variant` (the
   publisher stops when the cache runs out, which would abort the run);
   `--warmup >= --time-shift + 2`; `--controller-param` values parse; for
   `--final`, a clean worktree and no `--allow-missing-relay-flags`.
2. Creates `results/<run_id>/`. From here on **everything** runs inside one
   `try`/`finally`: the library and cargo builds, the namespace, every gate.
3. Creates the namespace and veth pair, disables offloads, records
   `ethtool -k` (`--net netns`).
4. Reads `relay --help` and `publisher --help`: every flag the runner passes
   must be listed (the table below plus `--port --host --cert-file
--key-file --log-folder --event-log`, and `--encoded-dir --max-variants
--ladder-spec --no-loop --event-log` for the publisher); a missing one is
   a clear error naming it, never a clap usage failure mid-start.
5. Starts the relay and waits for its listening line in `relay.log` (15 s),
   then for its `RELAY_CONFIG` record (5 s), whose `congestion_controller`
   must equal `--cc`.
6. Starts Vite (or reuses it, `--keep-vite`) **before** the publisher, so
   Vite's start-up cannot lengthen the warm-up.
7. Starts the publisher in replay mode with `--no-loop` (the media timeline
   never wraps inside a run) and `--variant-priority 128`, and waits for
   its first `GROUP_EMIT` (30 s). The browser gate is that record's own
   `ts` + `--warmup` (default 15 s, **the same for both client types**, so
   the media second at which a profile step hits does not depend on the
   client type); `PUBLISHER_READY` records it.
8. Inside the warm-up: builds the shaping tree for step 0 and verifies it
   (`NET_CHANGE` step 0). At the gate: starts background flows, opens the
   player in the headless browser with
   `?run=<id>&autoConnect=1&clientMode=...&controllerArm=min...`
   (`BROWSER_START` with the measured warm-up). The browser spawn is `t0`.
9. Aborts unless the client's `STARTUP` appears in
   `logs/<run_id>/client-events.jsonl` within 30 s of `t0`
   (`CLIENT_READY`); applies later steps in place at `t0 + at_s`; samples
   RSS/CPU of relay, publisher and browser once per second; aborts if any
   process exits.
10. Writes `RUN_END` with the final queue counters, stops the browser
    first, then background flows, publisher, relay (and Vite unless
    shared), deletes the namespace, copies the client log next to the
    others, writes `run_meta.json`, runs `analyze.py` and `validate.py`.

On **any** abort or non-zero exit (a failed build, namespace setup,
missing flag, readiness timeout, early process exit, Ctrl-C) the `finally`
block first writes `validation.json {"passed": false, "final": <bool>,
"failed": ["aborted"], "checks": []}`, then `run_meta.json` with
`validity.aborted = true`, so `analyze.py`, `compare.py` and `plot.py`
exclude the run. A (condition, rep) that aborted keeps its directory; to
re-run it under `--repeat-index`, move the directory away first.

### Relay and publisher flags pinned by the runner

Identical on every branch (`docs/rebuild-2026-10-04.md`, "Transport
fairness"); `run_meta.json` `relay_flags`/`publisher_flags` records what was
pinned, skipped (unknown to this binary and optional) or missing.

| flag                                  | value                             | note                                                                                    |
| ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| `--congestion-controller`             | `--cc` (default `cubic`)          | required; `--cc bbr` for the sensitivity batch; must match `RELAY_CONFIG`               |
| `--keep-alive-interval`               | 3 (s)                             |                                                                                         |
| `--max-idle-timeout`                  | 7 (s)                             |                                                                                         |
| `--track-alias-resolution-timeout-ms` | 2000                              | harness/native/pr1378 defaulted to 500, pr1674 to 2000; now the same everywhere         |
| `--downstream-alias-timeout-ms`       | 3000                              |                                                                                         |
| `--publish-done-stream-timeout-ms`    | 2000                              |                                                                                         |
| `--t-switch-ms`                       | 3000                              | required on `pr1378`; passed to any other relay that lists it, else recorded as skipped |
| `--cache-size`                        | `--cache-size` (1000)             |                                                                                         |
| `--forward-promotion-trigger`         | with `native` + `forward-trigger` | switch/native only                                                                      |
| publisher `--variant-priority`        | 128                               | required; one priority for all video variants                                           |

`--allow-missing-relay-flags` lets a binary without the contract flags run
for a smoke test (the relay may then also lack `RELAY_CONFIG`); `--final`
refuses it. A relay whose `RELAY_CONFIG` names a different congestion
controller is refused in every mode.

### Identity

`run_meta.json` `identity` (built by `build_identity`) is the immutable
description of a run: run id, git SHA and branch, mechanism and mode,
controller arm, its family (`controller_family`: min, grid or baseline) and
its URL parameters, client type and shift, delay groups, GOP, ladder id,
`cache_meta_hash` (sha256 of the cache's `meta.json`, since a cache can
change under the same name), profile, trace, qdisc, background flows, repeat
index, start time, dirty-worktree flag, final flag, duration, ABR overrides,
browser, `congestion_controller`, `relay_config` (the relay's own
`RELAY_CONFIG` record), `kernel`, `tc_version`, `offloads_disabled`
(every requested offload read back off on both ends; null without shaping)
and `warmup_s` (the configured warm-up; the measured one is in
`BROWSER_START`). There is no `seed`.

## Controller arms

The player selects its controller from one URL parameter,
`controllerArm=min|grid|baseline`, and the runner passes it on **every**
arm, so no arm depends on the player's default. `--controller min` (the
default) sends only `controllerArm=min`; its constants are the client's
and are logged in `RUN_META.controller`. `grid` (the frozen pre-rebuild
controller) sends `controllerArm=grid` plus its knobs, and `baseline` (as
shipped) sends `controllerArm=baseline`. The ablation arms of
`docs/abr-controller.md` 9 stay runnable: the `grid-*` arms send
`controllerArm=grid`, the others `controllerArm=baseline`, each with its
knobs. `--controller-param KEY=VALUE` overrides one URL parameter
(numbers become numbers); a `controllerArm` outside the three values is
refused. The arm is part of the identity and a condition key, so arms are
never pooled.

## Run ordering

Run the grid **repetition-major**: every arm once per repetition, so slow
drift (thermal, background updates) is spread over arms instead of
confounded with one. `--repeat-index N` runs exactly one repetition with a
stable run id (`<mech[-mode]>_<client>_<profile>_bg<N>_r<N>[_ctl-<arm>]`, no
timestamp), refuses a (condition, rep) that already exists, and so lets the
outer loop resume after an interruption (finished reps are skipped with an
error message, the loop goes on). `--keep-vite` keeps one Vite dev server
across the repetitions of one invocation (it does not survive a branch
change, so it pays off with `--repeat` inside an arm; the loop below uses
one run per invocation and leaves it off). A shared Vite binds `0.0.0.0`
(the veth is recreated per run) and is probed on `127.0.0.1`; keep the box
off untrusted networks while it runs.

```sh
export ENC=data/encoded/tears_of_steel_240s_1080p
run_one() {  # $1 arm, $2 client args, $3 profile, $4 rep, $5.. extra
  local arm=$1 client=$2 profile=$3 rep=$4; shift 4
  case $arm in
    native)    branch=switch/native; mech="--mechanism native" ;;
    native-ft) branch=switch/native; mech="--mechanism native --mechanism-mode forward-trigger" ;;
    pr1378)    branch=switch/pr1378; mech="--mechanism pr1378 --mechanism-mode next-group" ;;
  esac
  git checkout -q $branch && git reset -q --hard origin/$branch
  sudo -v
  python3 experiments/run_experiment.py $mech $client --controller min \
      --profile experiments/profiles/$profile.json --duration 180 --net netns --encoded-dir "$ENC" \
      --repeat-index $rep --final "$@"
}
for rep in 0 1 2 3 4; do
  for arm in native native-ft pr1378; do
    run_one $arm "--client-mode live-edge" step_down_up $rep
    run_one $arm "--client-mode time-shifted --time-shift 10" step_down_up $rep
  done
done
```

(`--duration 180` with the default 15 s warm-up needs a cache of at least
225 groups; the 240-group clip fits, 200 s would not.)

## Flags

| flag                                                                      | meaning                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `--mechanism`, `--mechanism-mode`                                         | arm label (must match the branch) and mode: native `forward-trigger` (optional), pr1378 `next-group                                   | playhead`, switch-from `hard                                                                                            | soft` |
| `--client-mode live-edge                                                  | time-shifted`, `--time-shift S`                                                                                                       | client type; the shift is `delay_groups x GOP`                                                                          |
| `--profile`, `--duration`, `--warmup`                                     | network profile JSON, seconds recorded from the browser spawn, seconds between first GROUP_EMIT and browser spawn (default 15)        |
| `--net none                                                               | netns`, `--offloads a,b,c`                                                                                                            | shaping backend; the `ethtool -K` features turned off (default `gso,tso,gro,tx-udp-segmentation,rx-udp-gro-forwarding`) |
| `--cc cubic                                                               | bbr`, `--cache-size`                                                                                                                  | relay congestion controller (recorded) and cache size                                                                   |
| `--encoded-dir`, `--max-variants`, `--ladder-spec`                        | prepared GOP cache (its `meta.json` gives the cache length and `cache_meta_hash`), publisher variants, ladder (`cache` = as prepared) |
| `--relay-port`, `--vite-port`, `--cert-dir`                               | relay UDP port, Vite port, relay certificate directory (`hash.txt` there is pinned by the player)                                     |
| `--controller`, `--controller-param`                                      | ABR arm and overrides                                                                                                                 |
| `--repeat N`, `--repeat-start I`, `--repeat-index I`                      | arm-major repetitions (stamped ids) or one repetition with a stable id                                                                |
| `--keep-vite`                                                             | one Vite for all repetitions of this invocation                                                                                       |
| `--bg-flows N`, `--bg-pattern`, `--bg-cc`                                 | competing iperf3 TCP flows                                                                                                            |
| `--log-objects`, `--abr`, `--label`, `--results`, `--browser`, `--headed` | per-object logging, extra ABR URL params, id suffix, output root, browser binary, show the window                                     |
| `--final`                                                                 | paper-quality run: clean worktree, pinned flags, `validate.py --final`                                                                |
| `--allow-missing-relay-flags`                                             | smoke tests on a binary without the contract flags (refused with `--final`)                                                           |
| `--no-analyze`, `--no-rust-build`, `--no-lib-build`                       | skip post-run analysis / the per-run cargo and library builds                                                                         |

## Profiles

JSON in `profiles/`: `queue` (`tail-drop` or `fq_codel`), `queue_pkts` (the
bfifo size is `queue_pkts x 1500` bytes; ignored by fq_codel, whose limit is
10240 packets), optional `codel_ecn` (default true), and `steps` with
`at_s`, `rate_mbps`, `delay_ms` (RTT), `loss_pct`, optional `jitter_ms`.
Either every step has a `rate_mbps` or none does (the tree is built once).
A `trace` profile replays a `t_s,rate_mbps` CSV (`traces/`).

- `step_down_up` (6 -> 1.5 -> 6 Mbps at 60 s and 120 s, tail-drop) and
  `step_down_up_fqcodel` (same steps, fq_codel leaf) differ only in the leaf
  line; `step_down_up_100s` is the compressed variant for short caches.
- `detect_step` (6 -> 0.8 -> 6) for the reaction-time claims, with
  `--abr maxBitrate=1200000`.
- `stable_3mbps`, `stable_10mbps`.
- `unshaped` (40 ms RTT, no rate limit: netem only) for the preflight loss
  check.

## Before any series: preflight

`docs/rebuild-2026-10-04.md` "Preflight": one 60 s run per arm and client
type on `unshaped` and at 1.5 Mbps, checked with `validate.py --preflight`.
Among its checks that come from the runner: every `NET_CHANGE` carries
`qdisc_stats` with a three-level tree (`netem` -> `htb` -> leaf; one level,
the netem, on `unshaped`), `offloads_disabled` is true,
`RELAY_CONFIG.congestion_controller` matches the identity, and `RUN_END` is
present with `elapsed ~ duration`. Read as well, not yet asserted: the
leaf's `gso_at_qdisc` on the fq_codel run (`maxpacket` 1514 = no GSO
batches at the qdisc; anything above about 3 KB = batches, see "GSO and the
queue"), and `warmup_measured_s` within 0.5 s of 15.

## Output

`results/<run_id>/` holds `run_meta.json`, `relay-events.jsonl`,
`publisher-events.jsonl`, `client-events.jsonl`, `runner-events.jsonl`,
the process logs, `validation.json`, and after analysis `summary.json` /
`summary.md`. `analyze.py --csv` writes one row per run; `compare.py
results/*/` prints one column per condition (mechanism, client type,
profile + background flows, qdisc, congestion controller, controller arm)
with the median over valid repetitions. `pack_results.sh [results] [out]`
bundles everything a reviewer needs without browser profiles and process
logs.

### Figures

`plot.py` turns analyzed runs into paper figures. It groups runs into the same
conditions as `compare.py` and de-duplicates runs that appear in several
extracted bundles.

```sh
pip install matplotlib                                                          # once
python3 experiments/plot.py results-linux-*/grid/results/*/ --list              # conditions, rep counts
python3 experiments/plot.py results-linux-*/grid/results/*/ --filter ctl=min --out figures/grid
```

Outputs (pdf and png by default, `--format png` for one): `bars_<metric>`
(median over repetitions, IQR error bar, one dot per repetition), `summary`
(the headline metrics stacked), `traj_live_edge_*` / `traj_rung_*` /
`traj_buffer_*` (per-repetition trajectories with a median line and dashed
network-change markers, one file per profile x controller x client type),
`seam_*` (ECDFs of viewer pause, buffer hole and visibility delay per switch),
and `index.md` listing every file. `--x`, `--hue` and `--facet` choose which
condition field becomes the bar group, the bar colour and the panel.

## Notes

- The relay's QUIC congestion controller is CUBIC unless `--cc bbr`; it is
  passed explicitly, reported back by the relay in `RELAY_CONFIG` and part
  of the condition key. iperf3 uses the host default (usually CUBIC) unless
  `--bg-cc` is given.
- With 1 s GOPs a 10 s shift is exactly 10 groups; the relay cache (1000
  groups) is far larger, so a time-shifted SUBSCRIBE is never clamped, and
  the 15 s warm-up guarantees the cache holds more than the shift when the
  client subscribes.
- A time-shifted client can only buffer up to its shift, so an 18 s
  `stableBufferTime` is out of reach for it (`grid`/`baseline` arms); pass
  `--abr 'stableBufferTime=8&bufferTimeDefault=8'` to test those arms in a
  regime they can reach, and report both.
- Unit tests for the command builders, parsers and the runner's pure
  helpers (stdlib only, no root, no tc; they also check every flag the
  runner passes against the relay's and publisher's clap structs in this
  checkout): `python3 -m unittest discover -s experiments/tests -t .`
  from the repository root.
