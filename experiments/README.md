# Experiments

Shared runner and analysis for the three switching-mechanism branches. The
code is identical on `switch/native`, `switch/pr1378` and `switch/pr1674`; the
branch checked out decides the mechanism, `--mechanism` only labels the run.

## Prerequisites

For a Linux machine, follow `docs/pilot-linux.md` end to end; it covers
the browser choice (Firefox, since Chrome cannot decode our HEVC on Linux),
the pinned relay certificate, shaping without running the runner as root,
and what to send back.

- `cargo build --release --workspace` (relay and publisher binaries)
- a prepared GOP cache: run `scripts/run-stack.sh` once (it encodes
  `data/video/smoking_test_1080p_ts.mp4` into `data/encoded/...`)
- `npm install` at the repo root (Vite dev server serves the player)
- Chromium or Google Chrome on the PATH (or `--browser <path>`)
- for shaping: Linux, root, `iproute2` (`ip`, `tc`); for background traffic
  `iperf3`

## Before any series: validate one run of each client type

```sh
git checkout switch/native
python3 experiments/run_experiment.py --mechanism native --client-mode live-edge \
    --profile experiments/profiles/stable_10mbps.json --duration 60 --net none --log-objects
python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
    --profile experiments/profiles/stable_10mbps.json --duration 60 --net none --log-objects
python3 experiments/validate.py results/<live-edge run>
python3 experiments/validate.py results/<time-shifted run>
```

`validate.py` checks, with numbers: the identity block; live-edge client
target 0 and small mean distance; time-shifted client pre-switch distance
within 1.5 GOPs of `delay_groups x GOP` and no relay clamp; per-switch
ordering t2 <= t3 <= relay recv <= promoted <= t4 <= applied <= t5; client
to relay one-way delay within the shared-host clock assumption; and the
publisher -> relay -> client join of several groups. Fix anything that fails
before generating data.

## Pilot, then Experiment 1

The runner records an immutable identity block per run (`run_meta.json`
`identity`: run id, git SHA, branch, mechanism, mechanism_mode, client type,
delay groups, GOP, ladder, profile, trace, qdisc, background flows,
repeat index, start time), refuses a `--mechanism` that does not match the
checked-out branch, and repeats a condition with `--repeat N`. Pilot first,
3 to 5 repetitions per condition, analysed end to end:

```sh
git checkout switch/native
sudo python3 experiments/run_experiment.py --mechanism native --client-mode live-edge \
    --profile experiments/profiles/step_down_up.json --duration 200 --net netns --repeat 5
sudo python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
    --profile experiments/profiles/step_down_up.json --duration 200 --net netns --repeat 5
python3 experiments/analyze.py results/* --csv results/pilot.csv --stats results/pilot_stats.csv
```

`--stats` reports, per condition, n, median, IQR and a bootstrap 95 %
confidence interval of the median for every metric; use the pilot spread
to pick the repetition count for the full grid (2 client types x 4 profiles
x N repetitions). Then run the grid with `stable_3mbps`, `stable_10mbps`,
`step_down_up` and `step_down_up_fqcodel`, and with `--bg-flows 1|4
[--bg-pattern bursty]` for competing traffic. On macOS use `--net none`
(unshaped smoke tests only).

The other mechanisms use the same commands on their branches:
`--mechanism pr1378 --mechanism-mode next-group|playhead` on `switch/pr1378`,
`--mechanism switch-from --mechanism-mode hard|soft` on `switch/pr1674`.

## What a run does

1. starts the relay with `--event-log`, the publisher in replay mode with
   `--no-loop` (so the media timeline never wraps inside a run) and the Vite
   dev server;
2. waits for the relay cache to hold more than the requested shift;
3. applies the profile's first step, starts background flows, then opens the
   player in headless Chromium with `?run=<id>&autoConnect=1&clientMode=...`;
4. applies later profile steps on schedule, samples RSS/CPU of relay,
   publisher and browser once per second;
5. stops everything, copies the client log next to the others, writes
   `run_meta.json` and runs `analyze.py`.

Network profiles are JSON (`profiles/`): `steps` with `at_s`, `rate_mbps`,
`delay_ms`, `loss_pct`, plus the bottleneck `queue` (`tail-drop` or
`fq_codel`) and `queue_pkts`. A `trace` profile replays a `t_s,rate_mbps` CSV.

## Output

`results/<run_id>/summary.md` is the human-readable summary; `summary.json`
has every number, including per-switch timelines and per-capacity-change
detection timelines. `analyze.py --csv` writes one row per run for plotting.
Record and metric definitions: `docs/measurement-schema.md`.

## Notes

- The relay's QUIC congestion control is BBR; iperf3 uses the host default
  (usually CUBIC) unless `--bg-cc` is given. Record both in the write-up.
- With 1 s GOPs a 10 s shift is exactly 10 groups; the relay cache default
  (1000 groups) is far larger, so a time-shifted SUBSCRIBE is never clamped.
- A time-shifted client can only buffer up to its shift, so the ABR's 18 s
  `stableBufferTime` is out of reach for it. Pass `--abr
'stableBufferTime=8&bufferTimeDefault=8'` to test the controller in a
  regime it can reach, and report both.
