# Experiments

Shared runner and analysis for the three switching-mechanism branches. The
code is identical on `switch/native`, `switch/pr1378` and `switch/pr1674`; the
branch checked out decides the mechanism, `--mechanism` only labels the run.

## Prerequisites

- `cargo build --release --workspace` (relay and publisher binaries)
- a prepared GOP cache: run `scripts/run-stack.sh` once (it encodes
  `data/video/smoking_test_1080p_ts.mp4` into `data/encoded/...`)
- `npm install` at the repo root (Vite dev server serves the player)
- Chromium or Google Chrome on the PATH (or `--browser <path>`)
- for shaping: Linux, root, `iproute2` (`ip`, `tc`); for background traffic
  `iperf3`

## Experiment 1: native SWITCH, live-edge vs 10 s time-shifted client

```sh
git checkout switch/native
cargo build --release --workspace
for rep in 1 2 3; do
  sudo python3 experiments/run_experiment.py --mechanism native --client-mode unfiltered \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --label r$rep
  sudo python3 experiments/run_experiment.py --mechanism native --client-mode filtered --filter-delay 10 \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --label r$rep
done
python3 experiments/analyze.py results/* --csv results/experiment1.csv
```

Repeat with `stable_3mbps.json` and `stable_10mbps.json` for the constrained
and broadband regimes, and with `--bg-flows 1|4 [--bg-pattern bursty]` for
competing TCP traffic. On macOS use `--net none` (unshaped smoke test).

The same commands on `switch/pr1378` and `switch/pr1674` (with `--mechanism
pr1378` / `pr1674`) produce comparable summaries.

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
  (1000 groups) is far larger, so a filtered SUBSCRIBE is never clamped.
- A time-shifted client can only buffer up to its shift, so the ABR's 18 s
  `stableBufferTime` is out of reach for it. Pass `--abr
'stableBufferTime=8&bufferTimeDefault=8'` to test the controller in a
  regime it can reach, and report both.
