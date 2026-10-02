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
