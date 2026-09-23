# Running the pilot on a Linux machine

Step by step, from a fresh clone to a tarball of results. The pilot is
Experiment 1's smallest useful dataset: native SWITCH, a live-edge client
and a 10 s time-shifted client, the `step_down_up` profile, 5 repetitions
each. Budget: about 30 minutes of wall clock once the setup is done (with the
100 s profile; twice that with the 200 s one).

Tested combination: Ubuntu 24.04, Firefox (Mozilla .deb build, not the
snap), no GPU needed. Chrome on Linux cannot decode our HEVC stream in
software and renders black frames on NVIDIA even with hardware decoding
enabled (`docs/nvidia-hevc.md` on `switch/pr1378` has the full record), so
the runner prefers Firefox when it finds one.

## 0. Make sure the clone is current

The branches were rebuilt on 2026-09-18 and have moved since; a clone taken
before the force-push has the wrong history. On the Linux machine:

```sh
cd moqtail
git fetch origin --prune
for b in harness switch/native switch/pr1378 switch/pr1674; do
  git checkout -q "$b" && git reset -q --hard "origin/$b"
done
git checkout switch/native
git log --oneline -1          # must show the same commit as origin/switch/native
git submodule update --init   # the data/ submodule holds the test video
```

If `git log` does not show a "pilot" commit from 2026-09-23 or later, the Mac
side has not been pushed yet; push there first (the `--force-with-lease`
commands you already have).

## 1. Install what the stack needs

```sh
sudo apt update
sudo apt install -y build-essential pkg-config clang libssl-dev \
  ffmpeg libavcodec-dev libavformat-dev libavutil-dev libavfilter-dev \
  libavdevice-dev libswscale-dev libswresample-dev \
  iproute2 iperf3 openssl python3 nodejs npm

# Rust (if missing)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Firefox from Mozilla's APT repository (the snap build cannot be launched
# inside a network namespace by the runner)
sudo install -d -m 0755 /etc/apt/keyrings
wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O- | sudo tee /etc/apt/keyrings/packages.mozilla.org.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" | sudo tee /etc/apt/sources.list.d/mozilla.list > /dev/null
printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' | sudo tee /etc/apt/preferences.d/mozilla > /dev/null
sudo apt update && sudo apt install -y firefox
firefox --version
```

Node 18+ is required by Vite; if the distro's `nodejs` is older, install it
from NodeSource or nvm.

## 2. Build once

```sh
git checkout switch/native
cargo build --release --workspace        # relay, publisher (5 to 10 minutes)
npm install                              # workspace JS deps
npm run --prefix libs/moqtail-ts build   # the player imports this dist
```

## 3. Prepare the GOP cache once

The publisher replays pre-encoded GOPs; the first preparation runs the
encoder over the test video (software x265, several minutes).

```sh
ls data/video/                           # from the submodule; pick one
export VIDEO=data/video/smoking_test_1080p.mp4
export ENC=data/encoded/$(basename "$VIDEO" .mp4)
./target/release/publisher --video-path "$VIDEO" --max-variants 4 --encoded-dir "$ENC"
cat "$ENC/meta.json"                     # gops_per_variant = seconds of media available
```

The runner replays with `--no-loop`, so a run can last at most
`gops_per_variant` seconds. The shipped clips give about 112 s, which fits
the `step_down_up_100s` profile with `--duration 100` (steps at 30 s and
60 s). For the full 200 s `step_down_up` profile prepare a longer source:
`CLIP_SECONDS=240 ./scripts/prepare_tears_of_steel.sh` (downloads Tears of
Steel, cuts 240 s, encodes the ladder into `data/encoded/tears_of_steel_240s_1080p`)
and point `ENC` there.

## 4. Relay certificate (pinned, 13 days)

Firefox will not accept a locally-trusted CA over HTTP/3, so the relay
serves a short-lived ECDSA certificate whose hash the player pins:

```sh
./scripts/gen-dev-cert.sh                # writes apps/relay/cert/{cert,key}.pem and hash.txt
```

The runner appends `?certHash=` to the player URL automatically when
`hash.txt` is present. Re-run the script every 13 days.

## 5. Validate one run of each client type, unshaped

```sh
python3 experiments/run_experiment.py --mechanism native --client-mode live-edge \
    --profile experiments/profiles/stable_10mbps.json --duration 60 --net none \
    --encoded-dir "$ENC" --log-objects
python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
    --profile experiments/profiles/stable_10mbps.json --duration 60 --net none \
    --encoded-dir "$ENC" --log-objects
```

Each run ends by printing the validation table. Every line must read
`PASS` or `SKIP`. If `identity` or `live-edge` fails with "client type
None", the browser never connected: open `results/<run>/vite.log` and
`results/<run>/relay.log` and stop here.

## 6. Validate shaping

Shaping runs the browser inside a network namespace joined to the host by a
veth pair, with the bottleneck on the relay-to-client direction. The
runner stays unprivileged and calls `ip`/`tc` through non-interactive
`sudo`, so cache your credentials first:

```sh
sudo -v
python3 experiments/run_experiment.py --mechanism native --client-mode live-edge \
    --profile experiments/profiles/stable_3mbps.json --duration 60 --net netns \
    --encoded-dir "$ENC"
```

`results/<run>/runner-events.jsonl` must contain `NET_CHANGE` with
`"applied": true`, and the summary's played bitrate must be well under the
unshaped run's. If `sudo -n` prompts fail mid-run, add a NOPASSWD rule for
`ip`, `tc` and `kill` in `/etc/sudoers.d/moqtail` instead of relying on the
timestamp.

## 7. The pilot

```sh
sudo -v
python3 experiments/run_experiment.py --mechanism native --client-mode live-edge \
    --profile experiments/profiles/step_down_up_100s.json --duration 100 --net netns \
    --encoded-dir "$ENC" --repeat 5 --final
python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
    --profile experiments/profiles/step_down_up_100s.json --duration 100 --net netns \
    --encoded-dir "$ENC" --repeat 5 --final
```

`--final` refuses a dirty worktree and validates each run with the
paper-quality gate. Use `step_down_up.json --duration 200` instead if you
prepared the longer clip. Each repetition takes duration plus about 40 s of
setup. Do not use the machine for anything heavy meanwhile, and make sure it
cannot suspend (`systemd-inhibit --what=sleep sleep infinity &` or a power
setting); a wall-clock gap marks the run invalid.

## 8. Aggregate and package

```sh
python3 experiments/analyze.py results/*/ --quiet --csv results/pilot.csv --stats results/pilot_stats.csv
experiments/pack_results.sh results pilot-$(hostname)-$(date +%Y%m%d).tar.gz
```

`pack_results.sh` re-runs the analysis, then bundles every run directory
without browser profiles and process logs (a few MB for ten runs).

## 9. What to look at, and what to send

Per run, in `results/<run_id>/`:

| file                                                                                         | what it is                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `validation.json`                                                                            | the eight checks with numbers; `passed` must be true                                                                              |
| `summary.md`                                                                                 | the human summary: startup, stalls, switches with the seam metrics, switching diagnostics, feedback windows, initial-shift window |
| `summary.json`                                                                               | every number behind it, including per-switch timelines                                                                            |
| `switch_windows.csv`                                                                         | one row per switch: throughput, latency and rule votes around it, and the next switch                                             |
| `run_meta.json`                                                                              | the identity block (mechanism, client type, profile, git SHA, repeat index, dirty worktree, browser)                              |
| `client-events.jsonl`, `relay-events.jsonl`, `publisher-events.jsonl`, `runner-events.jsonl` | the raw records                                                                                                                   |

Across runs: `results/pilot.csv` (one row per valid run) and
`results/pilot_stats.csv` (per condition: n, median, IQR, bootstrap 95 % CI).

Send the tarball. It contains everything above; nothing needs to be
extracted by hand. If a run failed validation, keep it in the bundle; the
analyzer excludes it and the `validation.json` says why.
