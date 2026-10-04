#!/usr/bin/env python3
"""Run one experiment: relay + publisher + browser client under a network profile.

Everything the run produces lands in ``results/<run_id>/``:

    run_meta.json            arguments, git revision, profile, timings
    relay-events.jsonl       relay event log (SUBSCRIBE_RECV, SWITCH_RECV, CACHE_STATS, ...)
    publisher-events.jsonl   publisher event log (RUN_META, GROUP_EMIT)
    client-events.jsonl      browser event log (SAMPLE, ABR_TICK, SWITCH_*, STALL_*, ...)
    runner-events.jsonl      NET_CHANGE, BG_FLOW_*, PROC_STATS
    relay.log / publisher.log / vite.log / browser.log
    summary.json, summary.md (from analyze.py)

Typical Experiment-1 invocations (native SWITCH, live-edge vs 10 s time-shifted):

    sudo python3 experiments/run_experiment.py --mechanism native \\
        --client-mode live-edge --profile experiments/profiles/step_down_up.json \\
        --duration 200 --net netns --repeat 5
    sudo python3 experiments/run_experiment.py --mechanism native \\
        --client-mode time-shifted --time-shift 10 --profile experiments/profiles/step_down_up.json \\
        --duration 200 --net netns --repeat 5
    git checkout switch/pr1378 && python3 experiments/run_experiment.py --mechanism pr1378 \\
        --mechanism-mode playhead --client-mode time-shifted ...

``--net none`` runs unshaped (macOS, smoke tests). The binaries must already be
built (``cargo build --release --workspace``) and the GOP cache prepared
(``scripts/run-stack.sh`` does both on first run).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from net import (  # noqa: E402
    DEFAULT_OFFLOADS, BackgroundFlows, load_profile, make_backend, profile_shapes, profile_topology,
    step_record, tc_version,
)

# Mechanism label -> the modes it accepts (empty = takes none), the branch it
# runs on, and the player URL parameter that selects the mode.
MECHANISM_MODES = {"native": {"forward-trigger"}, "pr1378": {"next-group", "playhead"}, "switch-from": {"hard", "soft"}}
# Mechanisms whose mode is optional: no mode = the mechanism as shipped upstream.
# native/forward-trigger is the one-line relay fix for the promotion defect found on
# the fresh grid (docs/pilot-linux.md 11b): upstream drops the promotion-triggering
# object even when it is object 0 of the start group, so the client lands on object 1.
MECHANISM_MODE_OPTIONAL = {"native"}
MECHANISM_BRANCH = {"native": "switch/native", "pr1378": "switch/pr1378", "switch-from": "switch/pr1674"}
MECHANISM_URL_PARAM = {"native": None, "pr1378": "switchFloor", "switch-from": "switchFromMode"}

# Controller arm -> player URL parameters (apps/client-js/src/app.tsx reads them into
# abrSettings.controller, logged in RUN_META). 'baseline' is the controller as shipped.
# The probe fix and the post-switch up-guard are separate knobs so the 2x2 ablation
# can attribute effects (docs/abr-controller.md, section 9).
GUARD = {"upGuardSamples": 3, "upGuardRelease": "landed"}
PROBE = {"probeMinBytes": 250000, "probeMinDurationMs": 300}
# The controller family is selected by one URL parameter, `controllerArm`, with
# the values min | grid | baseline (the player reads that name). `min` is the
# paper controller (docs/rebuild-2026-10-04.md, "Controller min"); its constants
# live in the client (W5) and are logged in RUN_META.controller. Every arm
# passes the parameter explicitly, so no arm depends on the player's default;
# the ablation arms below are knobs on the shipped controller (baseline) and
# the grid-* arms are the frozen grid controller with one knob changed.
CONTROLLER_ARM_PARAM = "controllerArm"
CONTROLLER_ARMS = ("min", "grid", "baseline")
DEFAULT_CONTROLLER = "min"
CONTROLLER_KNOBS = {
    "baseline": {},
    "min": {},
    "probe": PROBE,
    "guard": GUARD,
    "both": {**PROBE, **GUARD},
    # Second ablation (docs/pilot-linux.md 8d): the down half of the loop is
    # triggered by the switch itself (latency-trend on the first post-seam group,
    # switch-history on the rung's own earlier drops), so these arms remove those
    # triggers on top of the guard.
    "guard-lat": {**GUARD, "latencyResetOnLanding": 1},
    "guard-hist": {**GUARD, "switchHistoryMode": "off"},
    "guard-lat-hist": {**GUARD, "latencyResetOnLanding": 1, "switchHistoryMode": "off"},
    # Third ablation (docs/pilot-linux.md 8e): with latency-trend and switch-history
    # out of the way the down half moved to the buffer rules, which read the
    # per-group burst sawtooth at the live edge as a 1 s/s drain. 'env' gives the
    # rules the one-group envelope of the buffer instead.
    "env": {"bufferSignal": "envelope"},
    "lat-env": {"latencyResetOnLanding": 1, "bufferSignal": "envelope"},
    "guard-lat-env": {**GUARD, "latencyResetOnLanding": 1, "bufferSignal": "envelope"},
    # Fourth ablation (docs/pilot-linux.md 8f): with the buffer signal and the latency
    # window fixed, the last false trigger is SwitchHistoryRule's eviction; 'veto'
    # caps below a dropping rung instead, 'hist' turns the rule off.
    "lat-env-hist": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "off"},
    "lat-env-veto": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto"},
    "guard-lat-env-veto": {**GUARD, "latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto"},
    # Fifth ablation (docs/pilot-linux.md 8g): the veto without a window bans a rung for
    # the rest of the run (the up-visits that would clear the ban are the ones it
    # prevents). A 60 s window makes a failed climb cost one retry per minute.
    "lat-env-veto60": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto", "switchHistoryWindowS": 60},
    "guard-lat-env-veto60": {**GUARD, "latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto", "switchHistoryWindowS": 60},
    # The frozen controller for the grid (docs/abr-controller.md 9.7 and 9.9):
    # lat-env-veto60 plus the 64 KB probe cap (= grid-probe64k), named so the
    # identity block says what it is. Runs recorded before 2026-09-30 under
    # "grid" had no probe cap (identity.controller_params shows which).
    "grid": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto", "switchHistoryWindowS": 60, "probeMaxBytes": 65536},
    # Probe load (docs/abr-controller.md 9.9): the probe fills a FIFO bottleneck queue
    # (1.2 Mbps of probe on a 1.5 Mbps link, 0.9 s standing delay). Off, or capped.
    "grid-noprobe": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto", "switchHistoryWindowS": 60, "probeMode": "off"},
    "grid-probe64k": {"latencyResetOnLanding": 1, "bufferSignal": "envelope", "switchHistoryMode": "veto", "switchHistoryWindowS": 60, "probeMaxBytes": 65536},
}


def controller_family(arm: str) -> str:
    """The `controllerArm` value for a runner arm: min, grid (grid and grid-*)
    or baseline (the shipped controller and its ablation knobs)."""
    if arm in CONTROLLER_ARMS:
        return arm
    return "grid" if arm.startswith("grid-") else "baseline"


# Runner arm -> player URL parameters: the family first, then the arm's knobs.
CONTROLLER_PARAMS = {arm: {CONTROLLER_ARM_PARAM: controller_family(arm), **knobs}
                     for arm, knobs in CONTROLLER_KNOBS.items()}


def controller_params(args) -> dict:
    """URL parameters for the selected arm plus --controller-param overrides
    (numeric values become numbers, anything else stays a string)."""
    params = dict(CONTROLLER_PARAMS[args.controller])
    for kv in args.controller_param or []:
        k, _, v = kv.partition("=")
        if not v:
            sys.exit(f"--controller-param expects KEY=VALUE, got {kv!r}")
        try:
            num = float(v)
        except ValueError:
            params[k] = v
            continue
        if not math.isfinite(num):
            params[k] = v  # 'inf', 'nan': passed through as written
        else:
            params[k] = int(num) if num == int(num) else num
    if params.get(CONTROLLER_ARM_PARAM) not in CONTROLLER_ARMS:
        sys.exit(f"{CONTROLLER_ARM_PARAM} must be one of {CONTROLLER_ARMS}, got {params.get(CONTROLLER_ARM_PARAM)!r}")
    return params


def _client_run_meta(out: Path) -> dict:
    p = ROOT / "logs" / out.name / "client-events.jsonl"
    if not p.exists():
        p = out / "client-events.jsonl"
    if not p.exists():
        return {}
    with p.open() as f:
        for line in f:
            if '"RUN_META"' in line:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("event") == "RUN_META":
                    return rec
    return {}


def ladder_id(encoded_dir: Path, ladder_spec: str) -> str:
    """The prepared cache names the ladder: its directory plus its rung names."""
    meta = encoded_dir / "meta.json"
    if meta.exists():
        try:
            variants = json.loads(meta.read_text()).get("variants") or []
            return f"{encoded_dir.name}:{'+'.join(variants)}"
        except json.JSONDecodeError:
            pass
    return f"{ladder_spec}@{encoded_dir.name}"


def cache_meta_hash(encoded_dir: Path) -> str | None:
    """sha256 of the prepared cache's meta.json: the cache can change under the
    same directory name (pilot-linux.md 11), so the name alone is not an identity."""
    import hashlib
    p = encoded_dir / "meta.json"
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def cache_gops(encoded_dir: Path) -> int | None:
    try:
        v = json.loads((encoded_dir / "meta.json").read_text()).get("gops_per_variant")
        return int(v) if v is not None else None
    except (OSError, ValueError, json.JSONDecodeError):
        return None


# Relay flags the runner pins explicitly, with identical values on every
# mechanism branch (M20: branch defaults differ, e.g. switch/pr1674 raised
# track_alias_resolution_timeout_ms 500 -> 2000; switch/pr1378 adds
# --t-switch-ms). Units follow the relay's flag names (seconds unless _ms).
RELAY_PINNED = {
    "--keep-alive-interval": "3",
    "--max-idle-timeout": "7",
    "--track-alias-resolution-timeout-ms": "2000",
    "--downstream-alias-timeout-ms": "3000",
    "--publish-done-stream-timeout-ms": "2000",
}
# Flags only some relays know; passed when `--help` lists them, else skipped
# (recorded as skipped in run_meta). A mechanism that needs one makes it
# required (RELAY_REQUIRED_BY_MECHANISM).
RELAY_BRANCH_OPTIONAL = {"--t-switch-ms": "3000"}
RELAY_REQUIRED_BY_MECHANISM = {"pr1378": ("--t-switch-ms",)}
# Relay flags the contract requires (W4 adds them); their absence is an error
# unless --allow-missing-relay-flags, and a --final run never allows it.
RELAY_REQUIRED_NEW = ("--congestion-controller", "--udp-gso")
# QUIC UDP segmentation offload at the relay. Device offloads do not stop quinn's
# UDP_SEGMENT batches, which reach the qdisc as one skb (C5); the relay turns them off.
RELAY_UDP_GSO = "off"
# Seconds to wait after SIGTERM before SIGKILL: above the relay's 10 s shutdown drain,
# so its event log is flushed by the relay itself rather than lost to a kill.
STOP_WAIT_S = 12.0
PUBLISHER_REQUIRED_NEW = {"--variant-priority": "128"}

# Readiness and safety constants (rebuild contract, "Shaping", runner paragraph).
WARMUP_S = 15.0  # publisher first GROUP_EMIT -> browser start, both client types
RELAY_READY_TIMEOUT_S = 15.0  # relay.log listening line
PUBLISHER_READY_TIMEOUT_S = 30.0  # first GROUP_EMIT in publisher-events.jsonl
CLIENT_STARTUP_TIMEOUT_S = 30.0  # STARTUP in client-events.jsonl after browser spawn
CACHE_MARGIN_S = 30.0  # refuse duration + warmup + margin > gops_per_variant
RELAY_LISTENING_NEEDLE = "is running on"  # apps/relay/src/server.rs start(): "<version> is running on N UDP socket(s)"


def check_cache_length(duration: float, warmup: float, gops: int | None, margin: float = CACHE_MARGIN_S) -> str | None:
    """Error text when the prepared cache is too short for the run (publisher
    exits when it runs out, aborting the run), else None."""
    if gops is None:
        return "meta.json has no gops_per_variant"
    need = duration + warmup + margin
    if need > gops:
        return (f"the GOP cache holds {gops} groups (1 s each) but the run needs duration {duration:g} + warmup "
                f"{warmup:g} + margin {margin:g} = {need:g}; shorten --duration or prepare a longer cache")
    return None


def warmup_gate(first_group_ts_ms: float | None, warmup_s: float, seen_at_s: float) -> float:
    """Epoch seconds at which the browser may start: the publisher's first
    GROUP_EMIT (its own `ts`, ms, same host clock) plus the warm-up. Without a
    usable `ts`, from when the runner saw the record."""
    try:
        anchor = float(first_group_ts_ms) / 1000.0
    except (TypeError, ValueError):
        anchor = seen_at_s
    if not (0 < anchor <= seen_at_s + 5):  # a ts from the future is not a clock we share
        anchor = seen_at_s
    return anchor + warmup_s


def measured_warmup(first_group_ts_ms: float | None, spawned_at_s: float) -> float | None:
    try:
        return round(spawned_at_s - float(first_group_ts_ms) / 1000.0, 3)
    except (TypeError, ValueError):
        return None


def aborted_validation(final: bool) -> dict:
    """validation.json for a run that did not complete; analyze/compare exclude it (M20)."""
    return {"passed": False, "final": final, "failed": ["aborted"], "checks": []}


def binary_flags(binary: Path) -> set[str]:
    """Long option names a clap binary lists in `--help`."""
    import re
    try:
        out = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return set(re.findall(r"(?m)^\s*(?:-\w, )?(--[a-z0-9][a-z0-9-]*)", out.stdout + out.stderr))


def _no_help(binary: str, flags: set[str]) -> None:
    if not flags:
        raise SystemExit(f"could not read any option from `{binary} --help` (binary missing, not executable, or not "
                         "a clap binary); rebuild it with `cargo build --release -p relay -p publisher`")


def pinned_relay_args(flags: set[str], cc: str, cache_size: int, allow_missing: bool,
                      mechanism: str | None = None) -> tuple[list[str], dict]:
    """Relay argv additions and a record of what was pinned/skipped/missing.
    Every flag passed is one `relay --help` lists; a contract flag the binary
    lacks is a clear error (never a clap usage failure after the start)."""
    _no_help("relay", flags)
    argv: list[str] = []
    record: dict = {"pinned": {}, "skipped": [], "missing": []}
    for flag, value in {"--cache-size": str(cache_size), **RELAY_PINNED}.items():
        if flag in flags:
            argv += [flag, value]
            record["pinned"][flag] = value
        else:
            record["missing"].append(flag)
    required_here = RELAY_REQUIRED_BY_MECHANISM.get(mechanism or "", ())
    for flag, value in RELAY_BRANCH_OPTIONAL.items():
        if flag in flags:
            argv += [flag, value]
            record["pinned"][flag] = value
        elif flag in required_here:
            record["missing"].append(flag)
        else:
            record["skipped"].append(flag)
    if "--congestion-controller" in flags:
        argv += ["--congestion-controller", cc]
        record["pinned"]["--congestion-controller"] = cc
    else:
        record["missing"].append("--congestion-controller")
    if "--udp-gso" in flags:
        argv += ["--udp-gso", RELAY_UDP_GSO]
        record["pinned"]["--udp-gso"] = RELAY_UDP_GSO
    else:
        record["missing"].append("--udp-gso")
    if record["missing"] and not allow_missing:
        raise SystemExit(
            "the relay binary does not accept " + ", ".join(record["missing"]) + " (checked `relay --help`).\n"
            "The contract (docs/rebuild-2026-10-04.md, Transport fairness) requires every timeout and the\n"
            "congestion controller to be pinned by the runner. Rebuild the relay from a branch that has W4's\n"
            "flags, or pass --allow-missing-relay-flags for a smoke test (refused with --final).")
    return argv, record


def pinned_publisher_args(flags: set[str], allow_missing: bool) -> tuple[list[str], dict]:
    _no_help("publisher", flags)
    argv: list[str] = []
    record = {"pinned": {}, "missing": []}
    for flag, value in PUBLISHER_REQUIRED_NEW.items():
        if flag in flags:
            argv += [flag, value]
            record["pinned"][flag] = value
        else:
            record["missing"].append(flag)
    if record["missing"] and not allow_missing:
        raise SystemExit(
            "the publisher binary does not accept " + ", ".join(record["missing"]) + " (checked `publisher --help`).\n"
            "The contract requires one priority for all variants, passed explicitly. Rebuild the publisher from a\n"
            "branch that has W4's flag, or pass --allow-missing-relay-flags for a smoke test (refused with --final).")
    return argv, record


# Flags the runner always passes to the binaries, independent of the pins.
RELAY_BASE_FLAGS = ("--port", "--host", "--cert-file", "--key-file", "--log-folder", "--event-log")
PUBLISHER_BASE_FLAGS = ("--encoded-dir", "--max-variants", "--ladder-spec", "--no-loop", "--event-log")


def check_base_flags(binary: str, flags: set[str], needed: tuple[str, ...]) -> None:
    missing = [f for f in needed if f not in flags]
    if missing:
        raise SystemExit(f"`{binary} --help` does not list {', '.join(missing)}, which the runner passes on every run; "
                         "this binary is not one the runner supports")


def relay_reported_cc(rec: dict | None) -> str | None:
    """`congestion_controller` from a RELAY_CONFIG record, top level or under
    `config`."""
    if not rec:
        return None
    cc = rec.get("congestion_controller")
    if cc is None and isinstance(rec.get("config"), dict):
        cc = rec["config"].get("congestion_controller")
    return str(cc).lower() if cc is not None else None


def check_relay_config(rec: dict | None, cc: str, allow_missing: bool) -> str | None:
    """Error text unless the relay's own RELAY_CONFIG confirms the requested
    congestion controller (smoke tests may run a relay without the record)."""
    if rec is None:
        return None if allow_missing else (
            "relay emitted no RELAY_CONFIG within 5 s of start; this relay predates the contract "
            "(docs/rebuild-2026-10-04.md). Rebuild it, or --allow-missing-relay-flags for a smoke test")
    got = relay_reported_cc(rec)
    if got is None:
        return None if allow_missing else "relay RELAY_CONFIG has no congestion_controller field"
    if got != cc:
        return f"relay reports congestion_controller={got!r}, runner asked for {cc!r}"
    gso = rec.get("udp_gso")
    if gso is None and isinstance(rec.get("config"), dict):
        gso = rec["config"].get("udp_gso")
    if gso is None:
        return None if allow_missing else "relay RELAY_CONFIG has no udp_gso field"
    if str(gso).lower() != RELAY_UDP_GSO:
        return f"relay reports udp_gso={gso!r}, runner requires {RELAY_UDP_GSO!r}"
    return None


IDENTITY_PROBES = ("git_sha", "branch", "dirty_worktree", "delay_groups", "gop_duration_ms", "ladder_id",
                   "cache_meta_hash", "kernel", "tc_version")


def build_identity(args, *, run_id: str, repeat_index: int, stamp: str, profile: dict, net_backend: str,
                   offloads: dict | None, relay_config: dict | None, warmup_s: float, browser: str | None,
                   probes: dict) -> dict:
    """run_meta.json `identity` (docs/rebuild-2026-10-04.md, "Identity"). Pure:
    everything read from the host, git, the cache or the client log comes in
    through `probes` (keys IDENTITY_PROBES)."""
    missing = [k for k in IDENTITY_PROBES if k not in probes]
    if missing:
        raise ValueError(f"identity probes missing: {missing}")
    shaped = net_backend != "none"
    return {
        "run_id": run_id,
        "git_sha": probes["git_sha"],
        "branch": probes["branch"],
        "mechanism": args.mechanism,
        "mechanism_mode": args.mechanism_mode,
        "controller": args.controller,
        "controller_family": controller_family(args.controller),
        "controller_params": controller_params(args),
        "client_type": args.client_mode,
        "time_shift_s": args.time_shift if args.client_mode == "time-shifted" else 0,
        "delay_groups": probes["delay_groups"],
        "gop_duration_ms": probes["gop_duration_ms"],
        "ladder_id": probes["ladder_id"],
        "network_profile": profile["name"],
        "trace_id": Path(profile["trace_file"]).stem if profile.get("trace_file") else None,
        "qdisc": profile["queue"] if shaped else "none",
        "background_flows": args.bg_flows,
        "background_pattern": args.bg_pattern if args.bg_flows else None,
        "repeat_index": repeat_index,
        "timestamp_start": stamp,
        "dirty_worktree": probes["dirty_worktree"],
        "final": args.final,
        "duration_s": args.duration,
        "abr_overrides": args.abr or None,
        "browser": browser,
        # Transport and apparatus identity (rebuild contract, "Identity").
        "congestion_controller": args.cc,
        "relay_config": relay_config,
        "cache_meta_hash": probes["cache_meta_hash"],
        "kernel": probes["kernel"],
        "tc_version": probes["tc_version"],
        "offloads_disabled": bool((offloads or {}).get("all_off")) if shaped else None,
        "warmup_s": warmup_s,
    }


def find_record(path: Path, event: str) -> dict | None:
    """First JSONL record with `event` in `path`, or None."""
    if not path.exists():
        return None
    try:
        with path.open() as f:
            for line in f:
                if f'"{event}"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("event") == event:
                    return rec
    except OSError:
        return None
    return None


def wait_record(path: Path, event: str, timeout: float, proc: subprocess.Popen | None = None,
                what: str = "") -> dict | None:
    """Poll `path` for `event` up to `timeout` s; None on timeout. Raises if `proc` exits meanwhile."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rec = find_record(path, event)
        if rec is not None:
            return rec
        if proc is not None and proc.poll() is not None:
            raise SystemExit(f"{what or event}: process exited with {proc.returncode} before emitting {event}")
        time.sleep(0.2)
    return None


def wait_log_line(path: Path, needle: str, timeout: float, proc: subprocess.Popen | None = None,
                  what: str = "") -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if needle in path.read_text(errors="replace"):
                return True
        except OSError:
            pass
        if proc is not None and proc.poll() is not None:
            raise SystemExit(f"{what}: process exited with {proc.returncode} before logging {needle!r}; see {path}")
        time.sleep(0.2)
    return False


def client_delay_groups(out: Path):
    return _client_run_meta(out).get("delay_groups")


def client_gop_duration_ms(out: Path):
    return _client_run_meta(out).get("gop_duration_ms")


def now_ms() -> float:
    return time.time() * 1000.0


class RunnerLog:
    def __init__(self, path: Path) -> None:
        self.f = path.open("a", buffering=1)

    def emit(self, event: str, fields: dict | None = None) -> None:
        rec = {"ts": now_ms(), "src": "runner", "event": event}
        rec.update(fields or {})
        self.f.write(json.dumps(rec) + "\n")

    def close(self) -> None:
        self.f.close()


def worktree_dirty() -> bool:
    """Tracked modifications or untracked (non-ignored) files in the repo."""
    try:
        out = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        return bool(out.strip())
    except Exception:
        return True


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return ""


def spawn(cmd: list[str], log: Path, cwd: Path = ROOT, env: dict | None = None,
          new_session: bool = True) -> subprocess.Popen:
    f = log.open("ab")
    print("[run] $", " ".join(cmd))
    return subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=env,
                            preexec_fn=os.setsid if new_session else None)


def _killpg(pgid: int, sig: int) -> None:
    """Signal a process group; a group that contains root-owned wrappers
    (sudo ip netns exec ...) is signalled through sudo instead."""
    try:
        os.killpg(pgid, sig)
    except PermissionError:
        subprocess.run(["sudo", "-n", "kill", f"-{sig}", "--", f"-{pgid}"], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(p: subprocess.Popen | None, name: str, pattern: str | None = None) -> None:
    """Stop a spawned process. With `pattern`, the real process sits behind
    privilege wrappers in its own session, so it is signalled by command line
    (its processes belong to the invoking user) and the wrapper chain follows."""
    if p is None or p.poll() is not None:
        return
    if pattern:
        subprocess.run(["pkill", "-TERM", "-f", pattern], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            p.wait(timeout=STOP_WAIT_S)
        except Exception:
            subprocess.run(["pkill", "-KILL", "-f", pattern], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"[run] stopped {name}")
        return
    try:
        pgid = os.getpgid(p.pid)
    except ProcessLookupError:
        return
    _killpg(pgid, signal.SIGTERM)
    try:
        p.wait(timeout=STOP_WAIT_S)
    except Exception:
        _killpg(pgid, signal.SIGKILL)
    print(f"[run] stopped {name}")


def proc_stats(pid: int) -> dict | None:
    try:
        out = subprocess.run(["ps", "-o", "rss=,%cpu=", "-p", str(pid)], capture_output=True, text=True).stdout.split()
        if len(out) >= 2:
            return {"rss_bytes": int(out[0]) * 1024, "cpu_pct": float(out[1])}
    except Exception:
        pass
    return None


def wait_port(host: str, port: int, timeout: float) -> bool:
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.25)
    return False


def warm_vite(base: str) -> None:
    """Load the page and its entry module twice. Vite optimises dependencies on
    the first request and then forces a full page reload; if that happened
    inside a run the client would restart mid-experiment (new request ids,
    a second CLOCK_MAP), so trigger it here and wait until the served entry is
    stable."""
    import urllib.request
    last = None
    for attempt in range(6):
        try:
            html = urllib.request.urlopen(base + "/", timeout=10).read()
            entry = urllib.request.urlopen(base + "/src/main.tsx", timeout=10).read()
        except Exception as e:  # noqa: BLE001
            print(f"[run] vite warm-up attempt {attempt}: {e}")
            time.sleep(2)
            continue
        if last == (len(html), len(entry)) and attempt > 0:
            print("[run] vite warm")
            return
        last = (len(html), len(entry))
        time.sleep(3)
    print("[run] WARNING: vite entry did not stabilise; a mid-run reload is possible")


class Vite:
    """The Vite dev server: serves the player and receives client events
    (POST /__events -> logs/<run_id>/client-events.jsonl). Per run by
    default; with --keep-vite one instance serves every repetition of the
    same arm (it is mechanism-agnostic within a branch) and `warm_vite` runs
    once, saving the dependency-optimisation reload per run. When shared it
    binds 0.0.0.0 so the listener survives the veth being recreated between
    repetitions; the page URL still uses the namespace-facing address. A
    shared Vite starts before the first run has created the veth, so its
    readiness probe and warm-up go through the loopback address (dependency
    optimisation does not depend on the address the page is requested on)."""

    def __init__(self, page_host: str, port: int, log: Path, shared: bool) -> None:
        self.page_host, self.port, self.log, self.shared = page_host, port, log, shared
        self.proc: subprocess.Popen | None = None

    @property
    def base_url(self) -> str:
        return f"http://{self.page_host}:{self.port}"

    def bind_and_probe_hosts(self) -> tuple[str, str]:
        """(address Vite binds, address the runner probes and warms it on)."""
        if self.page_host in ("localhost", "127.0.0.1"):
            return self.page_host, "127.0.0.1"
        if self.shared:
            return "0.0.0.0", "127.0.0.1"
        return self.page_host, self.page_host

    def start(self) -> None:
        bind, probe_host = self.bind_and_probe_hosts()
        self.proc = spawn([
            "npm", "run", "--prefix", str(ROOT / "apps/client-js"), "dev", "--",
            "--host", bind, "--port", str(self.port), "--strictPort",
        ], self.log, env=dict(os.environ))
        if not wait_port(probe_host, self.port, 60):
            raise SystemExit(f"vite did not come up on {probe_host}:{self.port}; see {self.log}")
        warm_vite(f"http://{probe_host}:{self.port}")

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        stop(self.proc, "vite")


def find_browser(explicit: str | None) -> str | None:
    """Explicit path, else Firefox, else a Chromium. Firefox first because it
    decodes HEVC in software everywhere; Chrome on Linux needs a working VA-API
    HEVC decoder and renders black frames on NVIDIA (docs/pilot-linux.md)."""
    candidates = [explicit] if explicit else []
    candidates += [
        shutil.which("firefox"), shutil.which("firefox-esr"),
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"), shutil.which("chrome"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return None


def browser_kind(path: str) -> str:
    return "firefox" if "firefox" in Path(path).name.lower() else "chromium"


def refuse_snap_wrapper(path: str) -> None:
    """Ubuntu's `firefox` deb is a shell script that execs the snap, and a snap
    cannot be launched inside the network namespace (snap-confine: "cannot find
    tracking cgroup"; the browser exits before loading the page). Ubuntu's
    package also wins over Mozilla's by epoch unless packages.mozilla.org is
    pinned, so an unattended upgrade can swap the binary between batches."""
    try:
        head = Path(path).read_bytes()[:4096]
    except OSError:
        return
    if head.startswith(b"#!") and b"snap" in head:
        raise SystemExit(
            f"{path} is the snap wrapper, which the runner cannot launch in the namespace.\n"
            "Install Mozilla's deb and pin it (docs/pilot-linux.md section 1, 'If Firefox became the snap'):\n"
            "  apt-cache policy firefox          # shows which origin won\n"
            "  sudo apt install --allow-downgrades firefox   # with the packages.mozilla.org pin in place\n"
            "or pass --browser /path/to/mozilla/firefox.")


FIREFOX_PREFS = """
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("media.block-autoplay-until-in-foreground", false);
user_pref("media.hevc.enabled", true);
user_pref("dom.webtransport.enabled", true);
user_pref("network.http.http3.disable_when_third_party_roots_found", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("app.update.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("dom.disable_beforeunload", true);
"""
# The page is served over plain http. `localhost` is a secure context by
# definition, but the namespace's host address (10.200.0.1) is not, and
# WebTransport only exists in secure contexts; each browser has a way to
# declare one origin trustworthy.
FIREFOX_SECURE_CONTEXT_PREF = 'user_pref("dom.securecontext.allowlist", "%s");\n'


def browser_command(browser: str, url: str, out: Path, headed: bool, page_host: str, page_port: int) -> list[str]:
    insecure_origin = page_host not in ("localhost", "127.0.0.1", "::1")
    if browser_kind(browser) == "firefox":
        profile = out / "firefox-profile"
        profile.mkdir(exist_ok=True)
        prefs = FIREFOX_PREFS + (FIREFOX_SECURE_CONTEXT_PREF % page_host if insecure_origin else "")
        (profile / "user.js").write_text(prefs)
        cmd = [browser, "--no-remote", "--new-instance", "--profile", str(profile),
               "--width", "1280", "--height", "800"]
        if not headed:
            cmd.append("--headless")
        return cmd + [url]
    cmd = [
        browser, "--no-first-run", "--no-default-browser-check", "--disable-gpu-vsync",
        "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors",
        "--webtransport-developer-mode", "--enable-features=WebTransportDeveloperMode",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        f"--user-data-dir={out / 'chrome-profile'}", "--window-size=1280,800",
    ]
    if insecure_origin:
        cmd.append(f"--unsafely-treat-insecure-origin-as-secure=http://{page_host}:{page_port}")
    if os.geteuid() == 0:
        cmd.append("--no-sandbox")  # Chromium refuses to start as root otherwise
    if not headed:
        cmd.append("--headless=new")
    return cmd + [url]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mechanism", required=True, choices=list(MECHANISM_MODES),
                    help="switching mechanism under test; must match the checked-out branch")
    ap.add_argument("--mechanism-mode", default=None,
                    help="mechanism-specific mode: pr1378 next-group|playhead, switch-from hard|soft; none for native")
    ap.add_argument("--repeat", type=int, default=1, help="independent repetitions of this condition (arm-major)")
    ap.add_argument("--repeat-start", type=int, default=0, help="first repeat_index (to extend a series)")
    ap.add_argument("--repeat-index", type=int, default=None,
                    help="run exactly this one repetition, with a stable run id (no timestamp) so an external "
                         "repetition-major loop can run every arm once per rep; excludes --repeat/--repeat-start")
    ap.add_argument("--client-mode", choices=["live-edge", "time-shifted"], default="live-edge")
    ap.add_argument("--time-shift", type=float, default=10.0, help="seconds behind live for time-shifted clients")
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--duration", type=float, default=180.0, help="seconds of playback to record")
    ap.add_argument("--warmup", type=float, default=WARMUP_S,
                    help="seconds between the publisher's first GROUP_EMIT and the browser start, the same for "
                         "both client types (recorded as identity.warmup_s); must exceed --time-shift + 2")
    ap.add_argument("--net", choices=["none", "netns"], default="none")
    ap.add_argument("--offloads", default=",".join(DEFAULT_OFFLOADS),
                    help="ethtool -K features turned off on both veth ends before any qdisc is added (netns only); "
                         "the read-back `ethtool -k` state is recorded on every NET_CHANGE")
    ap.add_argument("--bg-flows", type=int, default=0, help="number of competing iperf3 TCP flows")
    ap.add_argument("--bg-pattern", choices=["steady", "bursty"], default="steady")
    ap.add_argument("--bg-cc", default=None, help="TCP congestion control for iperf3 (cubic, bbr)")
    ap.add_argument("--encoded-dir", type=Path, default=ROOT / "data/encoded/smoking_test_1080p_ts")
    ap.add_argument("--max-variants", type=int, default=4)
    ap.add_argument("--ladder-spec", default="cache",
                    help="publisher ladder; `cache` (default) uses the ladder the GOP cache was prepared with")
    ap.add_argument("--cache-size", type=int, default=1000, help="relay --cache-size (groups per track)")
    ap.add_argument("--cc", choices=["cubic", "bbr"], default="cubic",
                    help="relay QUIC congestion controller (--congestion-controller), recorded as "
                         "identity.congestion_controller; cubic is the paper's primary, bbr the sensitivity batch")
    ap.add_argument("--allow-missing-relay-flags", action="store_true",
                    help="smoke tests only: run even if the relay/publisher binary lacks the contract's flags "
                         "(--congestion-controller, timeouts, --variant-priority); refused with --final")
    ap.add_argument("--relay-port", type=int, default=4433)
    ap.add_argument("--vite-port", type=int, default=5173)
    ap.add_argument("--keep-vite", action="store_true",
                    help="start the Vite dev server once and keep it across the repetitions of this invocation "
                         "(skips the vite warm-up after the first rep); its log goes to <results>/vite_<stamp>.log")
    ap.add_argument("--browser", default=None, help="path to a Firefox or Chromium binary (default: Firefox if found, else Chromium)")
    ap.add_argument("--cert-dir", type=Path, default=ROOT / "apps/relay/cert",
                    help="directory with the relay's cert.pem/key.pem; if hash.txt is there (scripts/gen-dev-cert.sh) the player pins it")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--log-objects", action="store_true", help="one OBJECT_RECV per frame (needed for VMAF joins)")
    ap.add_argument("--abr", default="", help="extra ABR URL params, e.g. 'stableBufferTime=8&bufferTimeDefault=8'")
    ap.add_argument("--controller", choices=list(CONTROLLER_PARAMS), default=DEFAULT_CONTROLLER,
                    help="ABR controller arm: min (the paper controller, default; one URL param "
                         f"{CONTROLLER_ARM_PARAM}=min) | grid (the frozen pre-rebuild controller) | baseline (as shipped) "
                         "| the ablation arms of docs/abr-controller.md 9; recorded in the identity block")
    ap.add_argument("--controller-param", action="append", metavar="KEY=VALUE",
                    help="override one controller URL parameter (grid/baseline knobs: probeMinBytes, probeMinDurationMs, "
                         "upGuardSamples, upGuardRelease, latencyResetOnLanding, switchHistoryMode, switchHistoryWindowS, "
                         "bufferSignal, bufferEnvelopeMs, probeMode, probeMaxBytes; min: see docs/abr-controller.md)")
    ap.add_argument("--label", default="", help="free-text label appended to the run id")
    ap.add_argument("--results", type=Path, default=ROOT / "results")
    ap.add_argument("--no-analyze", action="store_true")
    ap.add_argument("--final", action="store_true",
                    help="paper-quality run: refuse a dirty worktree up front and validate with --final")
    ap.add_argument("--no-rust-build", action="store_true",
                    help="skip `cargo build --release -p relay -p publisher` (the relay differs per mechanism branch)")
    ap.add_argument("--no-lib-build", action="store_true",
                    help="skip rebuilding libs/moqtail-ts (the player imports its dist, which goes stale across branches)")
    args = ap.parse_args()

    modes = MECHANISM_MODES[args.mechanism]
    if args.mechanism_mode is not None and args.mechanism_mode not in modes:
        ap.error(f"--mechanism {args.mechanism} takes --mechanism-mode one of {sorted(modes)}"
                 + (" (or none)" if args.mechanism in MECHANISM_MODE_OPTIONAL else ""))
    if args.mechanism_mode is None and modes and args.mechanism not in MECHANISM_MODE_OPTIONAL:
        ap.error(f"--mechanism {args.mechanism} needs --mechanism-mode one of {sorted(modes)}")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if args.final and worktree_dirty():
        ap.error("--final requires a clean git worktree (commit or stash first)")
    if args.final and args.allow_missing_relay_flags:
        ap.error("--final refuses --allow-missing-relay-flags: every relay/publisher flag must be pinned")
    if args.client_mode == "time-shifted" and args.time_shift + 2.0 > args.warmup:
        ap.error(f"--warmup {args.warmup:g} is too short for --time-shift {args.time_shift:g}: the relay cache must "
                 "hold more than the shift before the client subscribes (need time_shift + 2)")
    if str(args.encoded_dir) in ("", "."):
        ap.error("--encoded-dir is empty: if you pass \"$ENC\", export it in this shell first (docs/pilot-linux.md step 3)")
    if not (args.encoded_dir / "meta.json").exists():
        ap.error(f"no prepared GOP cache at {args.encoded_dir} (no meta.json); prepare it with the publisher as in "
                 "docs/pilot-linux.md step 3")
    err = check_cache_length(args.duration, args.warmup, cache_gops(args.encoded_dir))
    if err:
        ap.error(err)
    expected_branch = MECHANISM_BRANCH[args.mechanism]
    if branch != expected_branch:
        ap.error(f"--mechanism {args.mechanism} runs on branch {expected_branch}, but HEAD is {branch}")

    controller_params(args)  # a malformed --controller-param fails here, before any run directory exists

    if args.repeat_index is not None:
        if args.repeat != 1 or args.repeat_start != 0:
            ap.error("--repeat-index excludes --repeat and --repeat-start")
        reps = [args.repeat_index]
    else:
        reps = list(range(args.repeat_start, args.repeat_start + args.repeat))

    shared_vite: Vite | None = None
    if args.keep_vite:
        page_host = make_backend(args.net).vite_host
        args.results.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        shared_vite = Vite(page_host, args.vite_port, args.results / f"vite_{stamp}.log", shared=True)
        shared_vite.start()
    try:
        for repeat_index in reps:
            code = run_once(args, repeat_index, shared_vite)
            if code != 0:
                return code
    finally:
        if shared_vite is not None:
            shared_vite.stop()
    return 0


def run_id_for(args, profile_name: str, repeat_index: int, stamp: str | None) -> str:
    """`<stamp>_<mech[-mode]>_<client>_<profile>_bg<N>_r<rep>[_ctl-<arm>][_<label>]`.
    With --repeat-index the stamp is omitted so an external repetition-major
    loop (README, "Run ordering") gets a stable id per (condition, rep)."""
    mode = "live-edge" if args.client_mode == "live-edge" else f"shift{args.time_shift:g}s"
    mech = args.mechanism + (f"-{args.mechanism_mode}" if args.mechanism_mode else "")
    run_id = f"{mech}_{mode}_{profile_name}_bg{args.bg_flows}_r{repeat_index}"
    if stamp:
        run_id = f"{stamp}_{run_id}"
    if args.controller != "baseline":
        run_id += f"_ctl-{args.controller}"
    if args.label:
        run_id += f"_{args.label}"
    return run_id


def run_once(args, repeat_index: int, shared_vite: Vite | None = None) -> int:
    profile = load_profile(args.profile)
    topo = profile_topology(profile, offloads=tuple(f for f in args.offloads.split(",") if f))
    shapes = profile_shapes(profile)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_id = run_id_for(args, profile["name"], repeat_index, None if args.repeat_index is not None else stamp)
    out = args.results / run_id
    if out.exists():
        raise SystemExit(f"{out} exists: this (condition, repeat_index) was already run; delete it, use another "
                         "--repeat-index, or add --label")
    out.mkdir(parents=True, exist_ok=False)
    print(f"[run] run_id={run_id}\n[run] out={out}")

    # From here on the run directory exists, so every failure (a build, the
    # namespace setup, a readiness gate, Ctrl-C) must leave an invalid
    # validation.json behind: all of it runs inside the try below (M20).
    rlog = RunnerLog(out / "runner-events.jsonl")
    backend = make_backend(args.net)
    procs: dict[str, subprocess.Popen] = {}
    browser: str | None = None
    browser_pattern: str | None = None
    relay_config: dict | None = None
    relay_pins: dict = {}
    publisher_pins: dict = {}
    warmup = 0.0
    bg = BackgroundFlows(backend, args.bg_flows, args.bg_pattern, cc=args.bg_cc, log=rlog.emit)
    exit_code = 0
    try:
        if not args.no_lib_build:
            # The player imports the built library (libs/moqtail-ts/dist); a checkout
            # of another mechanism branch leaves a dist that no longer matches.
            print("[run] building libs/moqtail-ts")
            subprocess.run(["npm", "run", "--prefix", str(ROOT / "libs/moqtail-ts"), "build"], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        if not args.no_rust_build:
            # The relay differs per mechanism branch and a stale target/release binary
            # silently runs the wrong mechanism; an up-to-date build is a no-op.
            print("[run] cargo build --release (relay, publisher)")
            subprocess.run(["cargo", "build", "--release", "-p", "relay", "-p", "publisher"], check=True, cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        backend.setup(topo)

        # Relay ------------------------------------------------------------
        relay_bin = ROOT / "target/release/relay"
        publisher_bin = ROOT / "target/release/publisher"
        for b in (relay_bin, publisher_bin):
            if not b.exists():
                raise SystemExit(f"missing {b}; run: cargo build --release --workspace")
        (out / "relay-logs").mkdir()
        # Every timeout and the congestion controller are pinned explicitly, with
        # identical values on every branch (M20); what each binary accepts is read
        # from its --help so a missing flag is a clear error, not a clap failure.
        relay_flags = binary_flags(relay_bin)
        relay_pin_argv, relay_pins = pinned_relay_args(relay_flags, args.cc, args.cache_size,
                                                       args.allow_missing_relay_flags, args.mechanism)
        check_base_flags("relay", relay_flags,
                         RELAY_BASE_FLAGS + (("--enable-object-logging",) if args.log_objects else ()))
        publisher_flags = binary_flags(publisher_bin)
        publisher_pin_argv, publisher_pins = pinned_publisher_args(publisher_flags, args.allow_missing_relay_flags)
        check_base_flags("publisher", publisher_flags, PUBLISHER_BASE_FLAGS)
        if args.mechanism == "native" and args.mechanism_mode == "forward-trigger" \
                and "--forward-promotion-trigger" not in relay_flags:
            raise SystemExit("this relay has no --forward-promotion-trigger; build it from switch/native")
        procs["relay"] = spawn([
            str(relay_bin), "--port", str(args.relay_port), "--host", backend.relay_host,
            "--cert-file", str(args.cert_dir / "cert.pem"),
            "--key-file", str(args.cert_dir / "key.pem"),
            "--log-folder", str(out / "relay-logs"),
            "--event-log", str(out / "relay-events.jsonl"),
            *relay_pin_argv,
            # --log-objects: the relay logs OBJECT_SENT per object handed to a subscriber
            # (and its per-subscription object files under relay-logs/).
            *(["--enable-object-logging"] if args.log_objects else []),
            # native/forward-trigger: relay forwards the promotion-triggering object when it
            # is at or after the start location (switch/native only; other relays lack the flag).
            *(["--forward-promotion-trigger"]
              if args.mechanism == "native" and args.mechanism_mode == "forward-trigger" else []),
        ], out / "relay.log")
        if not wait_log_line(out / "relay.log", RELAY_LISTENING_NEEDLE, RELAY_READY_TIMEOUT_S, procs["relay"], "relay"):
            raise SystemExit(f"relay did not log its listening line ({RELAY_LISTENING_NEEDLE!r}) within "
                             f"{RELAY_READY_TIMEOUT_S:g} s; see {out / 'relay.log'}")
        # The relay's own view of its configuration (RELAY_CONFIG, W4) is the
        # record of what actually ran; kept in run_meta as `relay_config`.
        relay_config = wait_record(out / "relay-events.jsonl", "RELAY_CONFIG", 5.0, procs["relay"], "relay")
        err = check_relay_config(relay_config, args.cc, args.allow_missing_relay_flags)
        if err:
            raise SystemExit(err)

        # Vite dev server (serves the player and receives client events). It
        # starts before the publisher so its start-up time (up to ~25 s with
        # the dependency warm-up) cannot stretch the warm-up below. ----------
        if shared_vite is not None:
            if not shared_vite.alive():
                raise SystemExit(f"the shared vite exited; see {shared_vite.log}")
            vite = shared_vite
            (out / "vite.log").write_text(f"shared vite (--keep-vite); log: {shared_vite.log}\n")
        else:
            vite = Vite(backend.vite_host, args.vite_port, out / "vite.log", shared=False)
            vite.start()
        procs["vite"] = vite.proc

        # Publisher (replay from the prepared cache, no loop so the media
        # timeline never wraps inside a run; cache presence and length were
        # checked in main()) -------------------------------------------------
        procs["publisher"] = spawn([
            str(publisher_bin), f"https://{backend.relay_host}:{args.relay_port}",
            "--encoded-dir", str(args.encoded_dir), "--max-variants", str(args.max_variants),
            "--ladder-spec", args.ladder_spec, "--no-loop",
            "--event-log", str(out / "publisher-events.jsonl"),
            *publisher_pin_argv,
        ], out / "publisher.log")

        # Browser start is gated on the publisher's first GROUP_EMIT plus a fixed
        # warm-up, the same for both client types, so the media second at which
        # a profile step hits does not depend on the client type or on how long
        # anything else took (audit report 4, "live-edge offset at client join").
        # The gate is anchored to the record's own `ts`, not to when the runner
        # read it, and the shaping tree is built inside the warm-up.
        first_group = wait_record(out / "publisher-events.jsonl", "GROUP_EMIT", PUBLISHER_READY_TIMEOUT_S,
                                  procs["publisher"], "publisher")
        if first_group is None:
            raise SystemExit(f"publisher emitted no GROUP_EMIT within {PUBLISHER_READY_TIMEOUT_S:g} s; "
                             f"see {out / 'publisher.log'}")
        warmup = args.warmup
        gate = warmup_gate(first_group.get("ts"), warmup, time.time())
        rlog.emit("PUBLISHER_READY", {"first_group_emit_ts": first_group.get("ts"), "warmup_s": warmup,
                                      "browser_gate_ts": gate * 1000.0})
        print(f"[run] first GROUP_EMIT seen; warming up for {warmup:g}s")

        # Initial network state, then background flows -----------------------
        steps = profile["steps"]
        t0: float | None = None  # browser spawn; profile steps are scheduled from it

        def apply_step(idx: int) -> None:
            """Apply profile step `idx` (the first call builds and verifies the
            tree, later ones change it in place) and record the resolved
            commands, the leaf's `tc -s` counters and the offload state (C5, M1)."""
            shape = shapes[idx]
            started = now_ms()
            res = backend.apply(shape)
            applied = now_ms()
            # `ts` is when the last tc command returned (the change is in force);
            # the `tc -s` read below takes a few ms more and must not delay it.
            rlog.emit("NET_CHANGE", {**step_record(shape, topo), "ts": applied, "apply_started_ts": started,
                                     "at_s": steps[idx]["at_s"], "step_index": idx,
                                     "elapsed_s": round(time.time() - t0, 3) if t0 is not None else None,
                                     "applied": bool(res.get("applied")), "tc": res.get("tc", []),
                                     "qdisc_stats": backend.stats(), "offloads": backend.offloads or None})
        apply_step(0)
        time.sleep(max(0.0, gate - time.time()))
        bg.start(args.duration + 30)

        # Browser ------------------------------------------------------------
        url = (f"http://{backend.vite_host}:{args.vite_port}/?run={run_id}&autoConnect=1"
               f"&clientMode={args.client_mode}&timeShift={args.time_shift:g}"
               f"&relay=https://{backend.relay_host}:{args.relay_port}")
        if args.log_objects:
            url += "&logObjects=1"
        if args.mechanism_mode and MECHANISM_URL_PARAM[args.mechanism]:
            url += f"&{MECHANISM_URL_PARAM[args.mechanism]}={args.mechanism_mode}"
        for k, v in controller_params(args).items():
            url += f"&{k}={v}"
        if args.abr:
            url += "&" + args.abr
        hash_file = args.cert_dir / "hash.txt"
        if hash_file.exists():
            url += "&certHash=" + hash_file.read_text().strip()
        browser = find_browser(args.browser)
        if browser is None:
            raise SystemExit("no Firefox or Chromium found; pass --browser")
        # The profile directory is unique to this run and appears on the browser's
        # command line, which is how the browser is found again to stop it when it
        # runs behind privilege wrappers.
        browser_pattern = str(out / ("firefox-profile" if browser_kind(browser) == "firefox" else "chrome-profile"))
        if not args.headed:
            # A headless browser must not depend on the desktop session: a DISPLAY
            # that points at a logged-out or changed X/Wayland session makes GTK
            # fail at startup and the browser exits before loading the page.
            for k in ("DISPLAY", "WAYLAND_DISPLAY"):
                os.environ.pop(k, None)
            os.environ["MOZ_HEADLESS"] = "1"
        if browser_kind(browser) == "firefox":
            refuse_snap_wrapper(browser)
        procs["browser"] = spawn(backend.wrap(browser_command(browser, url, out, args.headed, backend.vite_host, args.vite_port)),
                                 out / "browser.log",
                                 new_session=not backend.detaches_itself)
        rlog.emit("BROWSER_START", {"url": url, "binary": browser, "kind": browser_kind(browser),
                                    "headless": not args.headed, "cert_pinned": hash_file.exists(),
                                    "warmup_measured_s": measured_warmup(first_group.get("ts"), time.time())})

        # Main loop: apply steps on schedule, sample process stats -----------
        t0 = time.time()
        step_idx = 1
        last_stats = 0.0
        client_log = ROOT / "logs" / run_id / "client-events.jsonl"
        startup_seen = False
        while time.time() - t0 < args.duration:
            elapsed = time.time() - t0
            if step_idx < len(steps) and elapsed >= steps[step_idx]["at_s"]:
                apply_step(step_idx)
                step_idx += 1
            if not startup_seen:
                if find_record(client_log, "STARTUP") is not None:
                    startup_seen = True
                    rlog.emit("CLIENT_READY", {"after_browser_spawn_s": round(elapsed, 3)})
                elif elapsed > CLIENT_STARTUP_TIMEOUT_S:
                    raise SystemExit(f"client logged no STARTUP within {CLIENT_STARTUP_TIMEOUT_S:g} s of the browser "
                                     f"spawn; see {out / 'browser.log'} and {client_log}")
            bg.tick()
            if time.time() - last_stats >= 1.0:
                last_stats = time.time()
                if backend.name != "none" and os.geteuid() != 0 and int(last_stats) % 240 == 0:
                    subprocess.run(["sudo", "-n", "-v"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for name, p in procs.items():
                    if name == "vite":
                        continue
                    st = proc_stats(p.pid)
                    if st:
                        rlog.emit("PROC_STATS", {"process": name, "pid": p.pid, **st})
                for name, p in procs.items():
                    if p.poll() is not None:
                        raise SystemExit(f"{name} exited early with {p.returncode}; see {out / (name + '.log')}")
            time.sleep(0.2)
        rlog.emit("RUN_END", {"elapsed_s": time.time() - t0, "qdisc_stats": backend.stats()})
    except BaseException as e:  # noqa: BLE001 - always tear down
        exit_code = 1 if not isinstance(e, KeyboardInterrupt) else 130
        print(f"[run] aborting: {e!r}")
        rlog.emit("RUN_ABORT", {"error": repr(e)})
    finally:
        if exit_code != 0:
            # First thing, before anything else in this block can fail: an aborted
            # run is marked invalid so analyze/compare exclude it (M20).
            (out / "validation.json").write_text(json.dumps(aborted_validation(args.final), indent=2))
        # Give the browser a moment to flush its event buffer, then stop it first.
        time.sleep(1.5)
        stop(procs.get("browser"), "browser", browser_pattern if backend.detaches_itself else None)
        time.sleep(1.0)
        bg.stop()
        for name in ("publisher", "relay") + (() if shared_vite is not None else ("vite",)):
            stop(procs.get(name), name)
        # The namespace and veth go away with everything queued; the tree is
        # never modified after the run's last step (M1).
        backend.teardown()
        rlog.close()
        src = ROOT / "logs" / run_id / "client-events.jsonl"
        if src.exists():
            shutil.copy(src, out / "client-events.jsonl")
        else:
            print(f"[run] WARNING: no client events at {src}")
        # Immutable identity of this experiment instance. Every raw record lives
        # under results/<run_id>/, so a row of any aggregate can be rebuilt from
        # the raw logs plus this block alone.
        identity = build_identity(
            args, run_id=run_id, repeat_index=repeat_index, stamp=stamp, profile=profile,
            net_backend=backend.name, offloads=backend.offloads, relay_config=relay_config, warmup_s=warmup,
            browser=browser_kind(browser) if browser else None,
            probes={
                "git_sha": git("rev-parse", "HEAD"),
                "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                "dirty_worktree": worktree_dirty(),
                "delay_groups": client_delay_groups(out),
                "gop_duration_ms": client_gop_duration_ms(out),
                "ladder_id": ladder_id(args.encoded_dir, args.ladder_spec),
                "cache_meta_hash": cache_meta_hash(args.encoded_dir),
                "kernel": os.uname().release,
                "tc_version": tc_version(),
            })
        meta = {
            "identity": identity,
            "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
            "profile": profile, "host": os.uname().nodename, "platform": sys.platform,
            "net_backend": backend.name,
            "net": {"topology": {k: (list(v) if isinstance(v, tuple) else v) for k, v in vars(topo).items()},
                    "offloads": backend.offloads or None, "kernel": identity["kernel"],
                    "tc_version": identity["tc_version"]},
            "relay_config": relay_config,
            "publisher_config": find_record(out / "publisher-events.jsonl", "PUBLISHER_CONFIG"),
            "relay_flags": relay_pins, "publisher_flags": publisher_pins,
            # kept for older readers
            "run_id": run_id, "git_branch": identity["branch"], "git_sha": identity["git_sha"], "started": stamp,
        }
        if exit_code != 0:
            meta["validity"] = {"passed": False, "final": args.final, "aborted": True}
        (out / "run_meta.json").write_text(json.dumps(meta, indent=2))
        print(f"[run] wrote {out / 'run_meta.json'}")
        if not args.no_analyze and exit_code == 0:
            subprocess.run([sys.executable, str(HERE / "analyze.py"), str(out), "--quiet"], check=False)
            vcmd = [sys.executable, str(HERE / "validate.py"), str(out)] + (["--final"] if args.final else [])
            print("[run] validation:")
            v = subprocess.run(vcmd, check=False)
            meta["validity"] = {"passed": v.returncode == 0, "final": args.final}
            (out / "run_meta.json").write_text(json.dumps(meta, indent=2))
            if v.returncode != 0:
                print(f"[run] WARNING: validation FAILED; the run is marked invalid (see {out / 'validation.json'})")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
