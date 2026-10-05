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

**If Firefox became the snap.** Ubuntu's own `firefox` package is a script
that launches the snap, and its version has an epoch (`1:1snap...`) that
beats Mozilla's unless the pin above is in place, so an unattended upgrade
can replace the binary between batches. The symptom is every run aborting
with "browser exited early" and `browser.log` saying
`cannot find tracking cgroup`; `firefox --version` still prints a version.
The runner now refuses the wrapper with a pointer here. To recover:

```sh
apt-cache policy firefox                      # Installed: 1:1snap... means the wrapper won
cat /etc/apt/preferences.d/mozilla            # the pin must exist with Pin-Priority: 1000
sudo apt update && sudo apt install -y --allow-downgrades firefox
sudo snap remove firefox                      # optional; stops it coming back through the snap
head -c 200 /usr/bin/firefox | file -         # must be an ELF binary, not a shell script
firefox --version
```

Then re-run section 5's two validation runs before continuing a batch, since
the Firefox version changed.

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
`gops_per_variant` seconds. It also tells the publisher to use whatever
ladder the cache was prepared with (`--ladder-spec cache`), so a cache made
by `prepare_tears_of_steel.sh` (five explicit rungs) and one made by the
command above (the four-rung default) both just work. The shipped clips give about 112 s, which fits
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
unshaped run's. Ubuntu's sudo caches the credential per terminal, so run the
runner from the terminal where you ran `sudo -v`, not under `nohup` or a
service. If `sudo -n` fails mid-run anyway, add a NOPASSWD rule instead of
relying on the timestamp:

```sh
echo "$USER ALL=(root) NOPASSWD: /usr/sbin/ip, /usr/sbin/tc, /usr/bin/kill" | sudo tee /etc/sudoers.d/moqtail
sudo chmod 440 /etc/sudoers.d/moqtail
```

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

## 8b. Cross-mechanism diagnostic (pr1378 versus native)

Same profile and repetitions as the pilot, on the pr1378 branch, both floors
and both client types. The runner rebuilds the relay for the branch and
refuses a mechanism that does not match the checkout.

```sh
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for mode in next-group playhead; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode $mode --client-mode live-edge \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode $mode --client-mode time-shifted --time-shift 10 \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/all.csv --stats results/all_stats.csv
python3 experiments/compare.py results/*/     # one column per condition, native included
```

## 8c. Controller ablation (2×2), then the re-pilot

The cross-mechanism diagnostic showed the switching loop is controller-wide,
so the controller is stabilised before the grid. Two independent fixes, four
arms, on the two conditions where oscillation is easiest to see: native
live-edge and pr1378 next-group live-edge. Three repetitions each; 24 runs,
about 1 h 40 min. `--controller` records the arm in the identity block and in
the run id (`_ctl-<arm>`), and `compare.py` shows one column per arm.

```sh
# native arms (branch switch/native)
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
for arm in baseline probe guard both; do
  python3 experiments/run_experiment.py --mechanism native --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
# pr1378 next-group arms (branch switch/pr1378)
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for arm in baseline probe guard both; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/ablation.csv --stats results/ablation_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results ablation-$(hostname)-$(date +%Y%m%d).tar.gz
```

Read the table by arm: `switches / min`, `A->B->A reversals`, `superseded` and
`up-guard vetoes` should fall; `down-reaction s` and `up-recovery s` should
stay close to the baseline; `stalls`, `stalled s` and the seam rows say what the
remaining switches cost. Pick the smallest arm that removes the pathological
switching without slowing the step-down reaction, then run the re-pilot with
that arm on both mechanisms and both client types (`--repeat 3`), and only then
freeze the controller and start the grid. Keep `switch/pr1674` out until its
SWITCH_FROM hard/soft conformance is done.

One diagnostic run is also worth adding to the re-pilot: pr1378 next-group,
time-shifted, with `--log-objects`, so the per-frame `OBJECT_RECV` records show
whether the relay delivers whole groups to a delayed subscription across a
switch (the diagnostic runs showed 2-frame slivers and 917 ms holes at the
seams that became visible, and 3–6 s holes after the capacity drop).

## 8d. Second ablation: the post-seam triggers

The first ablation showed the guard slows the loop but the switch itself
re-arms it (latency-trend on the first post-seam group, switch-history on the
rung's own earlier drops; `docs/abr-controller.md` 9.3). Same two conditions,
three new arms on top of the guard, three repetitions: 18 runs, about
1 h 15 min. The `guard` runs from 8c are the reference column.

```sh
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
for arm in guard-lat guard-hist guard-lat-hist; do
  python3 experiments/run_experiment.py --mechanism native --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for arm in guard-lat guard-hist guard-lat-hist; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/ablation2.csv --stats results/ablation2_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results ablation2-$(hostname)-$(date +%Y%m%d).tar.gz
```

The decisive rows are `mean played rung index` (does the client reach rung 4
on 6 Mbps and rung 3 on 1.5 Mbps), `switches / min`, `A->B->A reversals`,
`down-reaction s` and `up-recovery s` (only meaningful once the client
actually climbs), `stalled s` and `media errors`.

## 8e. Third ablation: the buffer signal

The second ablation removed the latency-trend and switch-history triggers and
the loop continued at the same rate on the buffer rules, which read the
per-group burst sawtooth as a drain (`docs/abr-controller.md` 9.4). Three
arms, same two conditions, three repetitions: 18 runs, about 1 h 15 min.

```sh
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
for arm in env lat-env guard-lat-env; do
  python3 experiments/run_experiment.py --mechanism native --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for arm in env lat-env guard-lat-env; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/ablation3.csv --stats results/ablation3_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results ablation3-$(hostname)-$(date +%Y%m%d).tar.gz
```

`env` alone shows whether the buffer signal is the root cause; `lat-env`
adds the post-seam latency reset; `guard-lat-env` adds the up-guard as a
slow-start. Read `mean played rung index` first: an arm that works reaches
rung 4 in the 6 Mbps phases and rung 3 at 1.5 Mbps, and `down-reaction s` /
`up-recovery s` become meaningful for the first time.

## 8f. Fourth ablation: the switch-history rule

`lat-env` is the first arm in which the client climbs (`docs/abr-controller.md`
9.5); what still cycles is SwitchHistoryRule's eviction. Three arms, same two
conditions, three repetitions: 18 runs, about 1 h 15 min.

```sh
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
for arm in lat-env-hist lat-env-veto guard-lat-env-veto; do
  python3 experiments/run_experiment.py --mechanism native --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for arm in lat-env-hist lat-env-veto guard-lat-env-veto; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/ablation4.csv --stats results/ablation4_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results ablation4-$(hostname)-$(date +%Y%m%d).tar.gz
```

`lat-env-hist` removes the rule, `lat-env-veto` keeps its memory as a cap,
`guard-lat-env-veto` adds the up-guard as a slow-start. The candidate for the
grid is the arm with the lowest `switches / min` and `A->B->A reversals` whose
`mean played rung index` and `played kbps` stay close to `lat-env`.

## 8g. Fifth ablation: the veto with a 60 s memory

The veto arm removed the loop but banned every rung for the rest of the run
once the capacity dropped (`docs/abr-controller.md` 9.6). Two arms, same two
conditions, three repetitions: 12 runs, about 50 min.

```sh
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
for arm in lat-env-veto60 guard-lat-env-veto60; do
  python3 experiments/run_experiment.py --mechanism native --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
for arm in lat-env-veto60 guard-lat-env-veto60; do
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode live-edge --controller $arm \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  sudo -v
done
python3 experiments/analyze.py results/*/ --quiet --csv results/ablation5.csv --stats results/ablation5_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results ablation5-$(hostname)-$(date +%Y%m%d).tar.gz
```

What a working arm looks like: reversals in single digits like `lat-env-veto`,
a phase-3 played rung that recovers toward the phase-1 value instead of 0.00,
and `up-recovery s` that is finite. The arm that does that is the grid
controller.

## 8h. Re-pilot with the frozen controller, then the grid

`--controller grid` is the frozen configuration (`docs/abr-controller.md`
9.7). The re-pilot is both mechanisms and both client types, three
repetitions: 12 runs, about 50 min. It checks that the controller behaves on
the time-shifted client (where the envelope and the window are near no-ops)
before the grid is launched.

```sh
for branch in native pr1378; do
  git checkout switch/$branch && git reset --hard origin/switch/$branch
  mech=$([ $branch = native ] && echo "--mechanism native" || echo "--mechanism pr1378 --mechanism-mode next-group")
  for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift 10"; do
    sudo -v
    python3 experiments/run_experiment.py $mech $client --controller grid \
        --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --final
  done
done
python3 experiments/analyze.py results/*/ --quiet --csv results/repilot.csv --stats results/repilot_stats.csv
python3 experiments/compare.py results/*/
experiments/pack_results.sh results repilot-$(hostname)-$(date +%Y%m%d).tar.gz
```

Then the grid is the same command with `--repeat 5` (or 10) per condition,
adding the other profiles as planned. `switch/pr1674` joins once its
SWITCH_FROM hard/soft conformance is done.

## 9a. Before the grid: the PR #1378 delivery diagnostic

Two runs with per-object logging, so `summary.json` `delivery` can say how
many objects of each group the client received (`truncated_groups`), and the
relay log can be read against it. About 10 min.

```sh
git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
sudo -v
python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode time-shifted --time-shift 10 \
    --controller grid --log-objects --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --final
git checkout switch/native && git reset --hard origin/switch/native
sudo -v
python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
    --controller grid --log-objects --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --final
python3 experiments/analyze.py results/*/ --quiet
grep -h "delivery" results/*/summary.md
experiments/pack_results.sh results delivery-$(hostname)-$(date +%Y%m%d).tar.gz
```

The native run is the control: its groups should be complete after the drop.
The grid's native conditions can start in parallel; the PR #1378 time-shifted
condition waits for this.

First result (2026-09-29): PR #1378 had 78 of 222 groups cut on the wire
(one to two objects of 24 received, nothing discarded by the client), all
after the capacity drop; native had none cut on the wire but 830 stale-track
objects delivered and discarded. The cause is in the relay: a replaced
subscription was finished with a QUIC FIN, which delivers everything already
queued on its streams, so the abandoned backlog (lower group ids, higher
stream priority) kept the link while the target's streams got a trickle.
The pr1378 relay now resets the replaced subscription's data streams
(`SWITCH_SOURCE_RESET`).

Second result (2026-09-29, with the reset): no starvation, no long stalls,
nothing discarded, but 50 of 217 groups still cut on the wire. After some
landings the target subscription delivers only object 0 of each group, at
the live cadence, until a later landing restores full groups. To tell a relay
filter from a client-library drop the relay now logs `OBJECT_SENT` per object
(the runner passes `--enable-object-logging` with `--log-objects`), and the
analyzer splits the wire-cut groups into `cut at the relay` / `lost after
send`.

Third result (2026-09-30): 44 of the 55 cut groups were written in full by
the relay and lost after send; relay-to-client latency was 0.9–3.4 s during
the drop and the probe alone carried 1.2 Mbps of the 1.5 Mbps link
(`docs/abr-controller.md` 9.9). Two candidate fixes, both mechanisms, with
per-object logging (4 runs, about 20 min):

```sh
for arm in grid-noprobe grid-probe64k; do
  git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
  sudo -v
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group --client-mode time-shifted --time-shift 10 \
      --controller $arm --log-objects --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --final
  git checkout switch/native && git reset --hard origin/switch/native
  sudo -v
  python3 experiments/run_experiment.py --mechanism native --client-mode time-shifted --time-shift 10 \
      --controller $arm --log-objects --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --final
done
python3 experiments/analyze.py results/*/ --quiet
python3 experiments/compare.py results/*/
```

Read `probe load Mbps`, `relay->client latency p50 ms`, `truncated groups`
and `stalled s`.

Result (2026-09-30): `grid-probe64k` won on every row (PR #1378: stalls
27 s → 4.8 s, 2.9 Mbps played, shift kept for 81 s; native latency p50
92 ms) and `grid` now includes the 64 KB cap. The grid (section 8h, with
`--repeat 5`) can start; its first three repetitions per condition are the
re-pilot of the final controller.

## 9b. Grid status after the first batch (2026-09-30)

First batch: 5 repetitions × 4 conditions with `--controller grid` (probe cap
included; runs recorded under `grid` before 2026-09-30 have no cap and are
told apart by `identity.controller_params`). Live-edge: 10 of 10 valid.
Time-shifted: 3 of 5 valid per mechanism. Three of the four invalid runs
died of Firefox `MEDIA_ERR_DECODE` at a switch to 720p/1080p (the
time-shifted client now spends most of its time at the top rungs, which is
where the decoder fails); the fourth sat at one position with readyState 2
for 28 s while the decoder chewed through the buffer, which the frozen-frame
watchdog did not see because it counted decoded frames.

Player changes for the next batch (mechanism-neutral): `abort()` before
`changeType()`, objects discarded between a new init segment and the first
keyframe (`DROP_STALE` reason `pre-keyframe`; native lands on object 1),
and freeze detection on `currentTime`. Top up the time-shifted conditions
to five valid runs with extra repetitions (indices continue from 5):

```sh
for branch in native pr1378; do
  git checkout switch/$branch && git reset --hard origin/switch/$branch
  mech=$([ $branch = native ] && echo "--mechanism native" || echo "--mechanism pr1378 --mechanism-mode next-group")
  sudo -v
  python3 experiments/run_experiment.py $mech --client-mode time-shifted --time-shift 10 --controller grid \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 3 --repeat-start 5 --final
done
```

Then the other profiles of the grid with the same command shape. `analyze.py
--stats` pools by condition and ignores `repeat_index`, so extra repetitions
simply join their condition; invalid runs stay excluded.

## 10. After the step_down_up grid: the remaining batches

The step_down_up condition is complete (five or more valid runs per condition,
`grid_capped*.csv`). Everything below uses the frozen controller
(`--controller grid`). First move the pre-cap `grid` runs out of the way so
nothing pools them by accident (`compare.py` labels them `grid(uncapped)` and
`analyze.py --stats` keeps them apart by `controller_params`, but a clean
folder is simpler):

```sh
mkdir -p results-uncapped && mv results/20260929*_ctl-grid results-uncapped/ 2>/dev/null || true
```

The batches, in the order that serves the paper. Each line is 20 runs
(2 mechanisms × 2 client types × 5 repetitions), about 80 minutes. Run them
inside `tmux` (or `screen`) so a dropped SSH session does not kill a batch,
with `systemd-inhibit --what=sleep sleep infinity &` so the machine cannot
suspend, after `export ENC=...` and `sudo -v` in that same terminal. The
`run_batch` function lives only in the terminal where it was pasted; paste it
again in a new one.

```sh
run_batch() {  # $1 profile, $2.. extra args (e.g. --bg-flows 2); SHIFT=<s> sets the time shift (default 10)
  local profile=$1; shift
  git fetch -q origin
  for branch in native pr1378; do
    git checkout switch/$branch && git reset --hard origin/switch/$branch
    mech=$([ $branch = native ] && echo "--mechanism native" || echo "--mechanism pr1378 --mechanism-mode next-group")
    for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift ${SHIFT:-10}"; do
      sudo -v
      python3 experiments/run_experiment.py $mech $client --controller grid \
          --profile experiments/profiles/$profile.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 5 --final "$@"
    done
  done
}
run_batch stable_3mbps                 # steady state between rungs: the per-switch seam cost with no capacity event
run_batch step_down_up_fqcodel         # same steps, AQM queue: are the FIFO-queue findings queue-model specific?
run_batch step_down_up --bg-flows 2    # competing TCP (host default CUBIC; record it)
SHIFT=5  run_batch step_down_up        # shift-depth sweep: the behind-live axis the paper is about
SHIFT=20 run_batch step_down_up        # (10 s is the completed grid)
```

Pack each batch separately (`pack_results.sh results <name>.tar.gz`) and
send it; `analyze.py --stats` and `compare.py` pool by condition, so the
batches can be analysed together at the end.

### 10a. Shift-depth results so far (2026-10-02)

| time shift | native stalled s / retained s / kbps | pr1378 stalled s / retained s / kbps |
| ---------- | ------------------------------------ | ------------------------------------ |
| 5 s        | 17 / 1.7 / 1454 (n=4)                | 7.2 / 4.6 / 1924 (n=5)               |
| 10 s       | 24 / 1.5 / 1514 (n=6)                | 12 / 4.9 / 1647 (n=5)                |
| 20 s       | 3.4 / 6.5 / 1861 (n=5)               | 0.16 / 20 / 1513 (n=3)               |

At 20 s the buffer carries both clients through the 60 s drop (native's seam
holes become invisible: pause p95 42 ms). The two invalid pr1378 20 s runs
froze at holes 10–20 s ahead of the playhead: the stream reset on switch had
discarded the source's last groups below the seam. The pr1378 relay now
resets only streams at or above the seam and finishes the rest; the 20 s
pr1378 condition needs two more repetitions (`--repeat 2 --repeat-start 5`)
after `git reset --hard origin/switch/pr1378`.

### 10b. The third mechanism: SWITCH_FROM (switch/pr1674)

`switch/pr1674` carries the harness and the frozen controller but has never
run the validation or a diagnostic. Its soft mode is the one closest to the
paper's idea (the target starts at the playhead group and the old track
drains up to it), so it belongs in the grid once it passes the same gate the
others did:

1. Section 5 (one validation run per client type, `--mechanism switch-from
--mechanism-mode soft`), then the same with `hard`.
2. Section 8b's shape: both modes × both client types × 3 repetitions on
   step_down_up with `--controller grid` (12 runs), plus one time-shifted soft
   run with `--log-objects`.
3. Read `compare.py` next to the pr1378 and native columns, and the
   `delivery`, `discarded` and `truncated` lines of the time-shifted run. Soft
   mode re-delivers `[playhead, live)` like pr1378's playhead floor, so the
   range-jump deferral and the seam removal rules matter; send the bundle and
   the branch gets the same treatment the others had before it joins the grid.

### 10d. Reaction time, measured where it can be attributed

In the step_down_up grid every run carries `detection_reliable = false`.
The flag is now per capacity change and means: the controller made a
decision in the 5 s before the change, so the first decision after it cannot
be attributed to the change. With the frozen controller the live-edge client
switches every 1.3–1.8 s and the time-shifted client flips 1080p/720p on the
latency-trend rule at about 47 s and 56 s, so in that grid only some
live-edge down-steps are quiet-before (native 3 of 5, pr1378 4 of 5; t2 about
0.3–0.5 s, t4 about 1.3–2.6 s) and no time-shifted one is. The outcome
metrics `down-reaction s` and `up-recovery s` (played rung held 5 s) need no
attribution, but on the live-edge client the down one reads near zero only
because the client was already below the fitting rung when the drop came.
Neither is a reaction-time claim.

`detect_step` is the profile for that claim: 6 → 0.8 → 6 Mbps, run with
`--abr maxBitrate=1200000`, so both client types sit stably at 720p-1200k
before the drop (0.2 s per group at 6 Mbps; the controller clamps every rule
to the cap and does not probe above it) and must leave it at 0.8 Mbps (1.5 s
per group). The cap is part of the run identity (`abr_overrides`), so these
runs never pool with the grid. 20 runs, about 80 minutes:

```sh
run_batch detect_step --abr maxBitrate=1200000
```

Read `down detection attributable (frac)`, then `down t2 decision s` and
`down t4 landed s` (attributable events only), `down-reaction s` and
`up-recovery s`, per mechanism and client type.

### 10c. Optional: the media-second-82 decoder hotspot

Eight decode errors and several readyState-2 freezes sit at media second 82
(720p, 1080p, 480p) and second 23 (1080p). If the cache keeps one file per
group, decoding those groups offline tells whether the content is the cause:

```sh
ffmpeg -v error -i <init-of-720p> -i <group-82-of-720p> -f null - 2>&1 | head   # any decode errors printed = content
```

If they are clean, the position is a coincidence of where the time-shifted
client meets the capacity drop (media 82 s is run time 72 s with a 10 s shift).

## 11. The cache was misaligned: check it, realign it, then re-measure

Every batch so far lost at least one run to a decode error or a readyState-2
freeze at a seam, and the per-object logs showed why: the publisher's encode
path stamped each packet the encoder emitted with the decode time and the
keyframe flag of the frame it had just _sent_, but x265 emits with a latency
of about ten frames. Every cached group file therefore holds the last ten
frames of the previous GOP followed by the first frames of its own; object 0
is a P-frame and the IDR sits at packet 10. No switch mechanism can land on a
keyframe at a group boundary with such a cache, `landed_on_group_start` does
not mean "landed on a keyframe", and Firefox either skips to the next IDR
(part of the seam holes) or fails (`MEDIA_ERR_DECODE`, the freezes). Both
mechanisms were affected equally, so the comparison stands, but the absolute
seam numbers of every Linux batch include this artifact.

The encoder is fixed (packets are bucketed by their own pts and keyframe
flag) and two tools exist. Stop any running batch first.

```sh
git fetch origin && git checkout harness && git reset --hard origin/harness
python3 scripts/check_cache.py "$ENC"                 # expect PROBLEM lines: packet 0 not a random-access picture
python3 scripts/realign_cache.py "$ENC"               # rewrites in place, keeps $ENC.bak
python3 scripts/check_cache.py "$ENC"                 # must end with "OK: every group starts with a keyframe and has one"
```

### 11a. Fresh start

Everything measured before the realignment is archived on the analysis
machine, so the Linux results can go. In the terminal that runs batches:

```sh
# 1. stop whatever is running (Ctrl-C in its tmux window first), then clear leftovers
pkill -f run_experiment.py; pkill -f target/release/relay; pkill -f target/release/publisher; pkill -f firefox; pkill -f vite
sudo ip netns del moqc 2>/dev/null; sudo ip link del veth-moqh 2>/dev/null; true

# 2. archive the old runs out of the way (or delete them; the bundles already sent are the record)
cd ~/Documents/Baylor\ Research/moqtail
mv results results-prealign-$(date +%Y%m%d) 2>/dev/null; mv logs logs-prealign-$(date +%Y%m%d) 2>/dev/null; rm -rf results-uncapped; mkdir -p results logs

# 3. current code, realigned cache
git fetch origin && git checkout harness && git reset --hard origin/harness
export ENC=data/encoded/tears_of_steel_240s_1080p
python3 scripts/check_cache.py "$ENC"
python3 scripts/realign_cache.py "$ENC"
python3 scripts/check_cache.py "$ENC"      # must end with OK

# 4. validation, one run per client type (section 5), then the grid (section 8h) and the shift sweep (section 10)
```

Then section 5's two validation runs, then the grid again with the frozen
controller (section 8h with `--repeat 5`, then the shift sweep of section
10). Keep the earlier bundles: they are the record of how the controller was
fixed, and the controller findings (buffer sawtooth, probe load, latency
trend, switch history) do not depend on keyframe alignment. The seam and
stall numbers for the paper come from the realigned runs only, and
`identity` tells them apart by `git_sha` (realigned runs are at or after the
commit that added this section).

### 11b. The fresh grid (2026-10-02) and the native promotion defect

`results-linux-2026-10-01/fresh-grid` (step_down_up, controller `grid`, 5
reps per cell, 20 of 20 valid). First batch on the realigned cache, and the
first with `landed_on_keyframe` read from each landing object's moof:

| condition (ctl grid)      | sw/min | landed on a keyframe | stalled s | viewer pause p95 ms | seam hole p50 ms | mean rung | shift kept (last 60 s) |
| ------------------------- | ------ | -------------------- | --------- | ------------------- | ---------------- | --------- | ---------------------- |
| native, live-edge         | 20     | 0.41                 | 22        | 2019                | 0 (max 3000)     | 1.54      | 1.2 s                  |
| native, time-shifted 10 s | 15     | 0.37                 | 16        | 1903                | 0 (max 8958)     | 2.20      | 1.6 s                  |
| pr1378 next-group, live   | 17     | 1.00                 | 0.17      | 42                  | 0                | 2.29      | 1.1 s                  |
| pr1378 next-group, 10 s   | 10     | 1.00                 | 0.04      | 46                  | 0 (max 958)      | 3.22      | 11 s                   |

pr1378 lands on object 0 and on a keyframe every time, with no stall worth
the name. Native lands on object 1 in 60 % of switches, and the sync flag
confirms object 1 is never a keyframe, so the player discards the rest of
that group (`DROP_STALE` pre-keyframe, 23 objects) and the seam is a 1 s
hole: a ~1 s viewer pause at the live edge, a 1 s range-jump when
time-shifted. Relay `SWITCH_PROMOTED` records show exactly when: upstream's
`check_switch_context` promotes on the first object of the target track
whose group is >= the source's last sent group and sets the start location
to (source last sent group + 1, object 0). When the target variant's group g
reaches the relay before the source's group g (half the time; the variants
are encoded and published independently), the trigger is object 0 of group
g and the start location is group g itself, and the code still returns
"do not forward" for the triggering object ("wait for the next group"). The
client's first object is then object 1. When the source is level with the
target, the trigger is one group early, the start is the next group, and
the landing is object 0 a second later.

This is an upstream implementation defect, not the mechanism's design (the
intent is clearly "start at the group boundary"), so it is measured both
ways: `--mechanism native` is upstream as shipped; `--mechanism native
--mechanism-mode forward-trigger` adds `--forward-promotion-trigger` to the
relay (switch/native only), which forwards the triggering object when it is
at or after the start location. `SWITCH_PROMOTED.trigger_forwarded` records
which happened. Run the fixed arm next to the as-shipped grid before the
remaining section 10 batches (10 runs, ~70 min):

```sh
cd ~/Documents/Baylor\ Research/moqtail && export ENC=data/encoded/tears_of_steel_240s_1080p
git fetch origin && git checkout switch/native && git reset --hard origin/switch/native
for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift 10"; do
  sudo -v
  python3 experiments/run_experiment.py --mechanism native --mechanism-mode forward-trigger $client --controller grid \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 5 --final
done
bash experiments/pack_results.sh results fresh-native-ft.tar.gz
```

Then the section 10 batches; to include the fixed native arm there, add
`native-ft` to `run_batch`'s branch loop with
`mech="--mechanism native --mechanism-mode forward-trigger"` on branch
`switch/native`.

**Validity rule.** The validator first excluded one native time-shifted
rep for a 10.3 s freeze (the old rule: playhead advancing in half the
intervals, never still for 10 s). Inspection showed no apparatus fault:
one session, no media error, no logging gap, processes alive, the watchdog
correctly reporting "frozen at the buffered end, nothing later to play".
The client had consumed its shift, dropped to 240p at the live edge, asked
for 480p, and then starved for 11.6 s while the 1.5 Mbps link carried
1.34 Mbps of the abandoned 720p/1080p groups (83-90) that the relay kept
delivering and the client discarded; the promoted 480p objects queued
behind them. That is the native mechanism's lack of source cancellation,
a real outcome, and excluding it would have flattered native. The rule is
now: a run is invalid when the experiment cannot be interpreted because
the apparatus failed (destroyed session, or the playhead frozen over 10 s
_while playable data existed_: a player wedge); it stays valid however
badly the system under test performs. Re-validated under that rule all 20
runs pass, and native time-shifted starvation is systematic: 4 of 5 reps,
6.3-11.6 s each, all after the shift was consumed. `analyze.py` reports
`longest_frozen_with_data_ms` and `frozen_with_data_ms_total` so the
apparatus share of any stall time stays visible (0.0-0.8 s here, the
watchdog's own 3-6 s reaction windows at most).

**A pr1378 finding from the same inspection: buffer-unaware
minimum-switching-group selection.** The one long pr1378 stall (9.4 s,
time-shifted rep 0, after the shift was consumed) is not starvation. The
client's `next-group` floor was "last received group of the current
subscription + 1", computed from transport progress alone. After an
earlier catch-up had filled the element buffer to 109.6 s while the
current 1080p subscription lagged at group 105, the 1080p -> 240p switch
asked for Minimum Switching Group 106, behind the playhead at 108.6. The
relay re-delivered groups 106-109 (already buffered), the ABR flipped back
to 1080p with floor 107 (2.7 s per group on 1.5 Mbps), and the playhead
sat at the buffered end for 9.4 s while the link carried content behind
it. 5 of 156 pr1378 time-shifted switches landed more than 0.5 s behind
the playhead (0 on the live edge, 0 for native); the analyzer now reports
that count as `landed_behind_playhead` for every mechanism. The floor
itself is legitimate; the fix (applied on switch/pr1378, 2026-10-02) makes
it buffer-aware: `1 + max(last received group, highest group completely
present in a buffered range ahead of the playhead)`. A group the range ends
partway through does not count, so its missing tail is still re-requested.
Every switch now emits `SWITCH_FLOOR` (recv_floor_group,
buffer_floor_group, selected_min_group, playhead_group, buffer_end_s,
buffered_ranges), so the selection stays observable. The two pr1378 cells
of the fresh grid predate the fix and are re-run with it (10 runs,
~70 min) alongside the native forward-trigger arm:

```sh
cd ~/Documents/Baylor\ Research/moqtail && export ENC=data/encoded/tears_of_steel_240s_1080p
git fetch origin && git checkout switch/pr1378 && git reset --hard origin/switch/pr1378
for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift 10"; do
  sudo -v
  python3 experiments/run_experiment.py --mechanism pr1378 --mechanism-mode next-group $client --controller grid \
      --profile experiments/profiles/step_down_up.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 5 --final
done
bash experiments/pack_results.sh results fresh-pr1378-v2.tar.gz
```

The pre-fix pr1378 runs stay in the bundle as the record of the defect
(`git_sha` before this commit); the paper's pr1378 numbers come from the
re-run.

Two measurement notes from this batch. `seam_buffer_hole_ms` was reading
the hole behind the presented frame's buffered range, which after a native
object-1 landing is still in the buffer a switch later, so keyframe
landings were charged a 1 s hole they did not cause; the player now reports
that raw value as `buffer_hole_behind_ms` and both it and the analyzer
attribute a hole to the seam only when the first presented frame skipped
past it (the table above is after re-analysis). And the detection
attribution flag is still false on three of four cells, so the t0->t2
numbers are still not reportable (section 10d stands).

### 11c. The grid again, from the beginning (2026-10-02)

Both fixes above change what the grid measures (native forward-trigger is a
new arm; pr1378 next-group is buffer-aware now), so the step_down_up grid is
re-run in full on the current code and the results folder holds only that.
The fresh-grid bundle already extracted on the analysis machine is the
record of the pre-fix runs; the Linux copy can go.

```sh
# 1. nothing running, clean netns
pkill -f run_experiment.py; pkill -f target/release/relay; pkill -f target/release/publisher; pkill -f firefox; pkill -f vite
sudo ip netns del moqc 2>/dev/null; sudo ip link del veth-moqh 2>/dev/null; true

# 2. empty results (the bundle fresh-grid.tar.gz is already on the analysis machine)
cd ~/Documents/Baylor\ Research/moqtail
rm -rf results logs && mkdir -p results logs
export ENC=data/encoded/tears_of_steel_240s_1080p
python3 scripts/check_cache.py "$ENC" | tail -1        # must say OK

# 3. the grid: three arms x two client types x 5 reps = 30 runs, about 2 h
run_grid() {  # $1 profile, $2.. extra args; SHIFT=<s> sets the time shift (default 10)
  local profile=$1; shift
  git fetch -q origin
  for arm in native native-ft pr1378; do
    case $arm in
      native)    branch=switch/native; mech="--mechanism native" ;;
      native-ft) branch=switch/native; mech="--mechanism native --mechanism-mode forward-trigger" ;;
      pr1378)    branch=switch/pr1378; mech="--mechanism pr1378 --mechanism-mode next-group" ;;
    esac
    git checkout $branch && git reset --hard origin/$branch
    for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift ${SHIFT:-10}"; do
      sudo -v
      python3 experiments/run_experiment.py $mech $client --controller grid \
          --profile experiments/profiles/$profile.json --duration 200 --net netns --encoded-dir "$ENC" --repeat 5 --final "$@"
    done
  done
}
run_grid step_down_up

# 4. pack and send
bash experiments/pack_results.sh results fresh-grid-v2.tar.gz
```

Every run is validated as it finishes (apparatus-only rule, 11b), so no
separate validation runs are needed; a FAIL in the runner's summary line
means an apparatus fault and is worth a look before the next arm. If the
terminal is new, `run_grid` has to be pasted again (it lives only in the
shell where it was defined). The section 10 batches then use `run_grid`
in place of `run_batch`, same arguments (`run_grid stable_3mbps`,
`SHIFT=5 run_grid step_down_up`, ...), so every later batch carries all
three arms.

### 11d. fresh-grid-v2 (2026-10-03): three arms, 30 of 30 valid

`results-linux-2026-10-01/fresh-grid-v2`, step_down_up, controller `grid`,
5 reps per cell, every run on the realigned cache with both fixes in:

| condition                    | sw/min | keyframe landings | behind playhead | stalled s | pause p95 ms | mean rung | stale objects discarded | shift kept |
| ---------------------------- | ------ | ----------------- | --------------- | --------- | ------------ | --------- | ----------------------- | ---------- |
| native, live-edge            | 19     | 0.36              | 0               | 22        | 2061         | 1.35      | 1002                    | 1.2 s      |
| native, 10 s shift           | 16     | 0.35              | 0               | 7.6       | 1403         | 1.88      | 892                     | 1.8 s      |
| native forward-trigger, live | 17     | 1.00              | 0               | 0.36      | 26           | 2.21      | 161                     | 1.1 s      |
| native forward-trigger, 10 s | 9.6    | 1.00              | 0               | 0.00      | 34           | 3.04      | 47                      | 11 s       |
| pr1378 next-group, live      | 18     | 1.00              | 0               | 0.14      | 32           | 1.92      | 0                       | 1.1 s      |
| pr1378 next-group, 10 s      | 12     | 1.00              | 0               | 0.05      | 42           | 2.76      | 0                       | 11 s       |

Both fixes do what they were meant to: the forward-trigger arm lands on a
keyframe on every switch (as-shipped native: 35 %), and no pr1378 switch
lands behind the playhead any more (5 of 156 before). With the keyframe
problem removed, the two mechanisms are close on seam cost; what separates
them is source cancellation (native keeps delivering the abandoned track:
~1000 discarded stale objects per run as shipped, 47-161 with the fix, 0
for pr1378) and, on the time-shifted client, the shift itself: the fixed
native arm and pr1378 both keep the 10 s shift through the drop, as-shipped
native consumes it. As-shipped native time-shifted did not starve this time
(4 of 5 reps did in the first grid), so that outcome is variable.

**Open item: post-switch delivery pauses on pr1378, time-shifted only.**
Two pr1378 time-shifted reps starved (9.0 s and 10.8 s without an append;
one of them stalled 9.4 s because its buffer was already empty after a
burst of flapping switches). The signature across all ten pr1378
time-shifted runs of both grids: after a promotion, delivery resumes 3.5 to
14 s late in 3-6 switches per run, then the relay flushes the missing
groups in one burst (rep 0: group 126 held from 103.6 s to 112.9 s, then
groups 126-133 in 0.3 s). The five pr1378 live-edge runs and all ten
forward-trigger runs have no such gap; as-shipped native shows only the
3-4 s gaps its object-1 landings explain. The relay had every group cached
(CACHE_STATS), the connection was healthy (probes completed during the
hold), no REQUEST_UPDATE was sent, and the DELAY_GROUPS hold path was not
taken (no SUBSCRIBE_HOLD). The remaining candidates are the joining cache
replay of the switch's live subscription (`subscription.rs` "Joining state
... from location to end", whose end bound and `read_objects` wait decide
when live forwarding starts) and stream-credit back-pressure on
`open_uni`. Both show in `relay.log`, which the bundle does not include.
From the Linux box, for the stalled rep:

```sh
cd ~/Documents/Baylor\ Research/moqtail
R=results/20261003T041151Z_pr1378-next-group_shift10s_step_down_up_bg0_r0_ctl-grid
tar czf pr1378-r0-logs.tar.gz "$R"/relay.log "$R"/browser.log "$R"/relay-logs
```

Until this is understood, pr1378's time-shifted stall and starvation
numbers are provisional (the other columns do not depend on it).

### 11e. The pr1378 post-switch pauses, read from the relay log (2026-10-03)

`results-linux-2026-10-01/pr1378-r0-logs` (relay.log of the stalled rep).
The relay did not withhold anything. At 04:14:03.827 (103.4 s) it opened
the 240p PUBLISH (request 57), wrote the catch-up FETCH for group 125 and,
in the same millisecond, replayed group 126 from the cache onto
`subgroup_1_126_0`; from then on it opened one live stream per second
(127 at 04.25, 128 at 05.25, ... 131 at 08.25), each closed cleanly 70 ms
later. The client received group 125 at once and groups 126-133 together
at 04:14:13.3. The nine seconds were spent in the QUIC connection, not in
the relay.

What the connection was doing is visible in the client's own probes, which
measure what the connection delivers at top QUIC priority:

| 1.5 Mbps window      | pr1378 10 s shift (rep 0) | native forward-trigger 10 s shift | pr1378 live-edge |
| -------------------- | ------------------------- | --------------------------------- | ---------------- |
| 60-75 s (after drop) | 0.96-1.31                 | 1.26-1.58                         | 1.30-1.58        |
| 95-103 s (flapping)  | 0.96-1.18                 | 1.29-1.58                         | 1.29-1.57        |
| 104-112 s (the hold) | 0.42-0.61                 | 1.29-1.55                         | 1.30-1.58        |

The pr1378 time-shifted connection was running 20-30 % below the shaped
rate the whole time and collapsed to a third of it during the hold, while
two other connections on the identical link delivered the full rate. The
relay's QUIC stack is quinn with BBR; the bottleneck is a 100-packet
tail-drop FIFO (0.7 s at 1.5 Mbps, 0.17 s at 6 Mbps). pr1378 on a
time-shifted client is the one configuration that dumps several cached
groups onto the link at once on every switch (catch-up FETCH plus the
joining replay, both written in one go, on top of the FIN'd remainder of
the replaced subscription), and the frozen controller was switching every
0.3-1 s in that window. Burst, queue overflow, loss, congestion-window
collapse; and within the collapsed window the relay's stream scheduler
(ascending group order across every stream of the connection) sends the
older, already-abandoned bytes before the live group the client needs.
Across both grids the same pauses appear in 3-6 switches of every pr1378
time-shifted run and in none of the live-edge or forward-trigger runs, so
this is a property of the configuration, not of one rep. It is a transport
interaction, not a relay defect, and it is exactly what the fq_codel
profile in section 10 is there to test: if the pauses vanish under AQM the
queue is the cause; if they stay, the relay's catch-up pacing is.

Made observable: the relay now emits `CONN_STATS` once per second per
connection (rtt, cwnd, cumulative lost packets/bytes, congestion events,
bytes sent); the analyzer's `conn` block and compare.py's "QUIC loss rate",
"cwnd min" and "congestion events" rows read it, and "probe-measured
throughput min / p50" turns the probes into a capacity reading for every
run. Next on the Linux box, with the same `run_grid` as 11c:

```sh
run_grid step_down_up_fqcodel          # same steps, AQM queue: do the pauses vanish?
bash experiments/pack_results.sh results fqcodel.tar.gz
```

If they do, the paper reports pr1378's time-shifted stalls as a tail-drop
artefact and uses the fq_codel grid for the time-shifted comparison; if
not, the relay's catch-up delivery gets pacing and the pr1378 time-shifted
cells are re-run. Either way the 11d numbers for the other five cells
stand.

### 11f. After the rebuild: the preflight (2026-10-04)

Everything measured so far was made before the audit of 2026-10-04
(`docs/audit-2026-10-04.md`) and the rebuild that followed it
(`docs/rebuild-2026-10-04.md`). None of it is reused. The rebuilt stack
is checked first by a preflight: short runs whose validator asserts the
apparatus invariants (segmentation batches off at the relay and at the
queue, the tc tree as specified, the relay running the congestion
controller and flags the run says, every switch ending in exactly one
record, keyframe landings, no landing behind the playhead, delivery at
the link rate after every capacity step). A run that breaks one is
invalid and says which. No grid batch starts until a full preflight round
passes.

The arms and their branches:

| arm                 | branch          | runner flags                                          |
| ------------------- | --------------- | ----------------------------------------------------- |
| native (as shipped) | `switch/native` | `--mechanism native`                                  |
| native (fixed)      | `switch/native` | `--mechanism native --mechanism-mode forward-trigger` |
| PR #1378            | `switch/pr1378` | `--mechanism pr1378 --mechanism-mode next-group`      |

The controller is `min` (the runner's default), the relay runs CUBIC
with UDP segmentation off, and the runner builds the relay, publisher
and client library on every run, so a branch change cannot leave a stale
binary.

```sh
# 1. clean state (as in 11a)
pkill -f run_experiment.py; pkill -f target/release/relay; pkill -f target/release/publisher; pkill -f firefox; pkill -f vite
sudo ip netns del moqc 2>/dev/null; sudo ip link del veth-moqh 2>/dev/null; true
cd ~/Documents/Baylor\ Research/moqtail
mv results results-prerebuild-$(date +%Y%m%d) 2>/dev/null; mkdir -p results logs
git fetch origin
export ENC=data/encoded/tears_of_steel_240s_1080p
git checkout harness && git reset --hard origin/harness
python3 scripts/check_cache.py "$ENC" | tail -1          # must say OK

# 2. the preflight: every arm x client type x profile, repetition-major (each
#    repetition runs every condition once, so slow drift cannot line up with an arm)
preflight() {  # $1 = number of repetitions (default 3)
  local reps=${1:-3}
  git fetch -q origin
  for rep in $(seq 0 $((reps - 1))); do
    for arm in native native-ft pr1378; do
      case $arm in
        native)    branch=switch/native; mech="--mechanism native" ;;
        native-ft) branch=switch/native; mech="--mechanism native --mechanism-mode forward-trigger" ;;
        pr1378)    branch=switch/pr1378; mech="--mechanism pr1378 --mechanism-mode next-group" ;;
      esac
      git checkout -q $branch && git reset -q --hard origin/$branch
      for client in "--client-mode live-edge" "--client-mode time-shifted --time-shift 10"; do
        for prof in unshaped:60 preflight_step:90; do
          sudo -v
          python3 experiments/run_experiment.py $mech $client \
              --profile experiments/profiles/${prof%%:*}.json --duration ${prof##*:} \
              --net netns --encoded-dir "$ENC" --repeat-index $rep --preflight --final
        done
      done
    done
  done
}
preflight 3        # 36 runs, about 80 minutes

# 3. one line per run: PASS, or the checks that failed
python3 - <<'PY'
import json, pathlib
for v in sorted(pathlib.Path("results").glob("*/validation.json")):
    d = json.loads(v.read_text())
    print(("PASS " if d.get("passed") else "FAIL ") + v.parent.name, "" if d.get("passed") else d.get("failed"))
PY

# 4. pack and send (and, if any run failed, its relay log too)
bash experiments/pack_results.sh results preflight.tar.gz
tar czf preflight-relay-logs.tar.gz results/*/relay.log
```

What I check in the bundle, beyond PASS/FAIL: CONN_STATS (loss, cwnd,
smoothed RTT, pacer rate, datagrams per send) on the stepped profile, and
whether delivery after the restore to 6 Mbps reaches the link rate on
every arm (`pf-delivery-rate`: in fresh-grid-v2, 14 of 30 runs stayed at
the low step's rate). If every run passes, the grid follows with the
same loop shape (`step_down_up`, 200 s, 5 repetitions); if not, the
failing checks say which layer to fix before anything else runs.

### 11g. The preflight again (2026-10-05)

The first preflight (`results-linux-2026-10-05/preflight`, 36 runs) passed every
unshaped run and failed every shaped one. Four defects, all fixed on every
branch, with a failing test each:

- the validator's `pf-qdisc` read the step's `tc` commands, and a capacity step
  is a `tc class change` that names only htb (the kernel tree was right in every
  run); it now reads the recorded tree and the htb class rate;
- the runner started the profile and the duration at the browser spawn, so the
  page load (6.6 s native, 6.9 s pr1378 over the shaped link) shortened every
  session to ~83.5 s and moved every step earlier, by a different amount per
  branch (the `samples` failures); both now start at the client's CONNECT_START;
- the relay could not reset a stream it had already FIN'd: on pr1378 every
  time-shifted shaped run then received ~1.9 MB of abandoned groups at or above
  the switch seams (`pf-delivery-rate` 0.7 of the 1.5 Mbit/s step);
- the relay reuses a track's alias for every subscription to it, so a late
  object of an earlier subscription to the switch target landed four pr1378
  switches below their start group, and one run's decoder failed
  (MEDIA_ERR_DECODE, `pf-terminal`); the player now drops such objects, and
  the validator has `pf-landing` and `media-error`.

Native and native forward-trigger delivered at the link rate on every step,
the restore to 6 Mbps included: the BBR stall of fresh-grid-v2 is gone under
CUBIC.

Run the same preflight again (11f, steps 1 to 4) after moving the first round
aside:

```sh
cd ~/Documents/Baylor\ Research/moqtail
mv results results-preflight1-$(date +%Y%m%d); mkdir -p results logs
git fetch origin && git checkout harness && git reset --hard origin/harness
# then 11f step 1 (clean state, cache check), step 2 (`preflight 3`), steps 3 and 4
```

Expected: every run PASS. Shaped sessions now last 90 s (`samples` ≥ 324),
`SESSION_START.page_load_s` is recorded per run, pr1378 time-shifted
`DROP_STALE{unrouted}` falls from ~1.9 MB to the bytes already on the wire at
each seam, and no `DROP_STALE{earlier-subscription}` should be needed often (it
is the guard, reported per run).

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
