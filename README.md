# MOQtail

Reference implementation and experiment artifacts accompanying the MMSys 2026
Special Session paper on Media-over-QUIC Transport (MOQT) ABR streaming with
time-aligned switching, filtered/unfiltered client modes, and pluggable ABR
composability.

This repository contains everything needed to reproduce the paper's figures
end-to-end: a Draft-14-compliant MOQT publisher / relay / subscriber stack, the
Mininet-based network harness, the parametrized experiment suite (E1–E4), and
the Jupyter notebooks that turn raw results into the published figures.

## What's in here

| Path                                     | Role                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| [apps/publisher/](apps/publisher/)       | Rust live publisher (FFmpeg-encoded ABR ladder over MOQT)                          |
| [apps/relay/](apps/relay/)               | Rust MOQT relay with bounded per-track cache                                       |
| [apps/client-js/](apps/client-js/)       | Browser subscriber (TypeScript/Vite) — filtered & unfiltered modes, ABR controller |
| [apps/client/](apps/client/)             | Native subscriber (Rust)                                                           |
| [libs/moqtail-rs/](libs/moqtail-rs/)     | Rust MOQT protocol library                                                         |
| [libs/moqtail-ts/](libs/moqtail-ts/)     | TypeScript MOQT protocol library                                                   |
| [tests/network/](tests/network/)         | Mininet harness — single-relay topology, link shaping, Playwright-driven Chromium  |
| [tests/experiments/](tests/experiments/) | Paper experiments E1–E4 (parametrized pytest, builds on `tests/network/`)          |
| [paper/](paper/)                         | Figure notebooks, Makefile, and `figures/` outputs                                 |

## Reproducing the paper

The full pipeline is:

```
prepare asset  →  run experiments  →  build figures
(once)            (~3.5 h on Linux)   (cd paper && make all)
```

### 1. Install prerequisites

See [INSTALLATION.md](INSTALLATION.md) for the full Linux-native setup
(Ubuntu 24.04 tested). It covers system packages (FFmpeg dev libs, mkcert,
weston for the headless harness), Rust, Node.js v18+, TLS certificates for
WebTransport, and optional VAAPI hardware encoding.

The Mininet harness additionally requires Open vSwitch, Xvfb, Chromium, and
`uv`. One-shot setup:

```bash
sudo ./tests/network/setup.sh
```

This also builds `relay` / `publisher` (release) and the `client-js` bundle.

### 2. Prepare the source video

All experiments use the first 60 s of _Tears of Steel_ re-encoded to 720p
H.264 with 1 s GOPs (low-latency convention; matches LoL+/CMCD). The script
is idempotent — safe to re-run.

```bash
./scripts/prepare_tears_of_steel.sh
```

It downloads Blender's 1080p H.264 master, scales/encodes once, and prints
the SHA-256 of the output for reproducibility. Cached at
`data/video/.cache/`; output at `data/video/tears_of_steel_60s_720p.mp4`.

### 3. Run the experiments

```bash
./scripts/run-experiments.sh                 # all experiments
./scripts/run-experiments.sh e1 e2           # selected experiments
```

The wrapper rebuilds stale Rust binaries, runs each experiment under `sudo`
(Mininet requires root namespaces), and aggregates per-cell summaries.
Per-run artifacts land at:

```
tests/experiments/results/<test_id>/<timestamp>/
  ├── metrics.csv
  ├── relay.log
  ├── publisher.log
  ├── switch_records.json
  ├── abr_settings.json
  ├── cell_params.json
  └── summary.json
```

Aggregates land at `tests/experiments/results/<exp>/aggregate.csv` and
`aggregate_summary.csv` — designed for `pd.read_csv(...).pipe(...)` workflows.

### 4. Build the figures

```bash
cd paper
uv sync
make all
```

Notebook-driven figures execute against the aggregates from step 3; the
TikZ architecture figure compiles from `figures/fig1_architecture.tex` via
`pdflatex`. Outputs (PDF + PNG) land in `paper/figures/`.

To rebuild a single figure:

```bash
make figures/fig2_e1_e2_playhead_gap.pdf
```

Notebooks are committed without cell outputs — strip with
`.venv/bin/nbstripout notebooks/<name>.ipynb` before staging, or install
the git filter once with `.venv/bin/nbstripout --install`.

## Experiments

| Exp    | What it measures                                                                                     | Cells × Runs | Wall time | Figure        |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------ | --------- | ------------- |
| **E1** | Naive (immediate) switch — PTS discontinuity under bandwidth step-down at filter delays 5/10/20/30 s | 4 × 5        | ~27 min   | Fig 2, Fig 3a |
| **E2** | Group-aligned switch — same conditions as E1, switching deferred to GOP boundary                     | 4 × 5        | ~27 min   | Fig 2, Fig 3b |
| **E3** | Unfiltered + naive ABR composability sweep                                                           | 39 × 5       | ~2.9 h    | Fig 4         |
| **E4** | Filtered + aligned ABR composability — 13 ABR configs × 3 bandwidth profiles                         | 39 × 5       | ~2.9 h    | Fig 5         |

Full per-experiment specs (parameters, run flow, assertions, summary fields)
live in [docs/superpowers/specs/2026-04-30-paper-experiments-design.md](docs/superpowers/specs/2026-04-30-paper-experiments-design.md).
The figure spec (panel layout, axes, captions, page-budget choices) is in
[docs/superpowers/specs/2026-05-03-paper-figures-design.md](docs/superpowers/specs/2026-05-03-paper-figures-design.md).

## Running individual pieces

### A specific experiment cell

```bash
sudo uv --project tests/experiments run pytest \
  tests/experiments/test_e1_naive_switch.py -v
```

### Network regression scenarios (separate from paper experiments)

```bash
sudo uv run --project tests/network pytest tests/network/scenarios/ -v
```

Available: [test_bandwidth_recovery.py](tests/network/scenarios/test_bandwidth_recovery.py),
[test_gradual_ramp_down.py](tests/network/scenarios/test_gradual_ramp_down.py),
[test_high_latency.py](tests/network/scenarios/test_high_latency.py),
[test_oscillation_resistance.py](tests/network/scenarios/test_oscillation_resistance.py),
[test_packet_loss.py](tests/network/scenarios/test_packet_loss.py),
[test_publisher_degradation.py](tests/network/scenarios/test_publisher_degradation.py),
[test_sudden_drop.py](tests/network/scenarios/test_sudden_drop.py),
[test_aligned_switch.py](tests/network/scenarios/test_aligned_switch.py),
[test_naive_switch_discontinuity.py](tests/network/scenarios/test_naive_switch_discontinuity.py),
[test_filtered_connect.py](tests/network/scenarios/test_filtered_connect.py).
Topology, link profiles, and run parameters are in
[tests/network/config.yaml](tests/network/config.yaml).

### The stack interactively (no Mininet)

```bash
npm --prefix libs/moqtail-ts run build
cargo build --release
./scripts/run-stack.sh                       # default video
./scripts/run-stack.sh data/video/my.mp4     # custom video
./scripts/run-stack.sh stop
```

| Component | URL                    |
| --------- | ---------------------- |
| Relay     | https://localhost:4433 |
| Client-JS | http://localhost:5173  |

## Authors

See [AUTHORS](AUTHORS).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Bug
reports, fixes, and documentation improvements via GitHub issues / PRs.
