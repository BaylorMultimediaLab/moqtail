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
import csv
import json
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

from net import BackgroundFlows, Shape, make_backend  # noqa: E402

# Mechanism label -> the modes it accepts (empty = takes none), the branch it
# runs on, and the player URL parameter that selects the mode.
MECHANISM_MODES = {"native": set(), "pr1378": {"next-group", "playhead"}, "switch-from": {"hard", "soft"}}
MECHANISM_BRANCH = {"native": "switch/native", "pr1378": "switch/pr1378", "switch-from": "switch/pr1674"}
MECHANISM_URL_PARAM = {"native": None, "pr1378": "switchFloor", "switch-from": "switchFromMode"}


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


def load_profile(path: Path) -> dict:
    prof = json.loads(path.read_text())
    if "trace" in prof:
        trace_path = (path.parent / prof["trace"]).resolve()
        steps = []
        with trace_path.open() as f:
            for row in csv.DictReader(f):
                steps.append({
                    "at_s": float(row["t_s"]),
                    "rate_mbps": float(row["rate_mbps"]),
                    "delay_ms": prof.get("delay_ms", 0),
                    "loss_pct": prof.get("loss_pct", 0),
                })
        prof["steps"] = steps
        prof["trace_file"] = str(trace_path)
    prof.setdefault("queue", "tail-drop")
    prof.setdefault("queue_pkts", 100)
    prof["steps"] = sorted(prof["steps"], key=lambda s: s["at_s"])
    return prof


def spawn(cmd: list[str], log: Path, cwd: Path = ROOT, env: dict | None = None) -> subprocess.Popen:
    f = log.open("ab")
    print("[run] $", " ".join(cmd))
    return subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=env,
                            preexec_fn=os.setsid)


def _killpg(pgid: int, sig: int) -> None:
    """Signal a process group; a group that contains root-owned wrappers
    (sudo ip netns exec ...) is signalled through sudo instead."""
    try:
        os.killpg(pgid, sig)
    except PermissionError:
        subprocess.run(["sudo", "-n", "kill", f"-{sig}", "--", f"-{pgid}"], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(p: subprocess.Popen | None, name: str) -> None:
    if p is None or p.poll() is not None:
        return
    try:
        pgid = os.getpgid(p.pid)
    except ProcessLookupError:
        return
    _killpg(pgid, signal.SIGTERM)
    try:
        p.wait(timeout=10)
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


def browser_command(browser: str, url: str, out: Path, headed: bool) -> list[str]:
    if browser_kind(browser) == "firefox":
        profile = out / "firefox-profile"
        profile.mkdir(exist_ok=True)
        (profile / "user.js").write_text(FIREFOX_PREFS)
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
    ap.add_argument("--repeat", type=int, default=1, help="independent repetitions of this condition")
    ap.add_argument("--repeat-start", type=int, default=0, help="first repeat_index (to extend a series)")
    ap.add_argument("--client-mode", choices=["live-edge", "time-shifted"], default="live-edge")
    ap.add_argument("--time-shift", type=float, default=10.0, help="seconds behind live for time-shifted clients")
    ap.add_argument("--profile", type=Path, required=True)
    ap.add_argument("--duration", type=float, default=180.0, help="seconds of playback to record")
    ap.add_argument("--net", choices=["none", "netns"], default="none")
    ap.add_argument("--bg-flows", type=int, default=0, help="number of competing iperf3 TCP flows")
    ap.add_argument("--bg-pattern", choices=["steady", "bursty"], default="steady")
    ap.add_argument("--bg-cc", default=None, help="TCP congestion control for iperf3 (cubic, bbr)")
    ap.add_argument("--encoded-dir", type=Path, default=ROOT / "data/encoded/smoking_test_1080p_ts")
    ap.add_argument("--max-variants", type=int, default=4)
    ap.add_argument("--ladder-spec", default="default")
    ap.add_argument("--cache-size", type=int, default=1000, help="relay --cache-size (groups per track)")
    ap.add_argument("--relay-port", type=int, default=4433)
    ap.add_argument("--vite-port", type=int, default=5173)
    ap.add_argument("--browser", default=None, help="path to a Firefox or Chromium binary (default: Firefox if found, else Chromium)")
    ap.add_argument("--cert-dir", type=Path, default=ROOT / "apps/relay/cert",
                    help="directory with the relay's cert.pem/key.pem; if hash.txt is there (scripts/gen-dev-cert.sh) the player pins it")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--log-objects", action="store_true", help="one OBJECT_RECV per frame (needed for VMAF joins)")
    ap.add_argument("--abr", default="", help="extra ABR URL params, e.g. 'stableBufferTime=8&bufferTimeDefault=8'")
    ap.add_argument("--seed", type=int, default=None, help="recorded in run_meta; profiles are deterministic")
    ap.add_argument("--label", default="", help="free-text label appended to the run id")
    ap.add_argument("--results", type=Path, default=ROOT / "results")
    ap.add_argument("--no-analyze", action="store_true")
    ap.add_argument("--final", action="store_true",
                    help="paper-quality run: refuse a dirty worktree up front and validate with --final")
    ap.add_argument("--no-lib-build", action="store_true",
                    help="skip rebuilding libs/moqtail-ts (the player imports its dist, which goes stale across branches)")
    args = ap.parse_args()

    modes = MECHANISM_MODES[args.mechanism]
    if modes and args.mechanism_mode not in modes:
        ap.error(f"--mechanism {args.mechanism} needs --mechanism-mode one of {sorted(modes)}")
    if not modes and args.mechanism_mode is not None:
        ap.error(f"--mechanism {args.mechanism} takes no --mechanism-mode")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if args.final and worktree_dirty():
        ap.error("--final requires a clean git worktree (commit or stash first)")
    expected_branch = MECHANISM_BRANCH[args.mechanism]
    if branch != expected_branch:
        ap.error(f"--mechanism {args.mechanism} runs on branch {expected_branch}, but HEAD is {branch}")

    for repeat_index in range(args.repeat_start, args.repeat_start + args.repeat):
        code = run_once(args, repeat_index)
        if code != 0:
            return code
    return 0


def run_once(args, repeat_index: int) -> int:
    profile = load_profile(args.profile)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    mode = "live-edge" if args.client_mode == "live-edge" else f"shift{args.time_shift:g}s"
    mech = args.mechanism + (f"-{args.mechanism_mode}" if args.mechanism_mode else "")
    run_id = f"{stamp}_{mech}_{mode}_{profile['name']}_bg{args.bg_flows}_r{repeat_index}"
    if args.label:
        run_id += f"_{args.label}"
    out = args.results / run_id
    out.mkdir(parents=True, exist_ok=False)
    print(f"[run] run_id={run_id}\n[run] out={out}")

    if not args.no_lib_build:
        # The player imports the built library (libs/moqtail-ts/dist); a checkout
        # of another mechanism branch leaves a dist that no longer matches.
        print("[run] building libs/moqtail-ts")
        subprocess.run(["npm", "run", "--prefix", str(ROOT / "libs/moqtail-ts"), "build"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

    rlog = RunnerLog(out / "runner-events.jsonl")
    backend = make_backend(args.net)
    backend.setup()

    procs: dict[str, subprocess.Popen] = {}
    browser: str | None = None
    bg = BackgroundFlows(backend, args.bg_flows, args.bg_pattern, cc=args.bg_cc, log=rlog.emit)
    exit_code = 0
    try:
        # Relay ------------------------------------------------------------
        relay_bin = ROOT / "target/release/relay"
        publisher_bin = ROOT / "target/release/publisher"
        for b in (relay_bin, publisher_bin):
            if not b.exists():
                raise SystemExit(f"missing {b}; run: cargo build --release --workspace")
        (out / "relay-logs").mkdir()
        procs["relay"] = spawn([
            str(relay_bin), "--port", str(args.relay_port), "--host", backend.relay_host,
            "--cert-file", str(args.cert_dir / "cert.pem"),
            "--key-file", str(args.cert_dir / "key.pem"),
            "--log-folder", str(out / "relay-logs"),
            "--event-log", str(out / "relay-events.jsonl"),
            "--cache-size", str(args.cache_size),
        ], out / "relay.log")
        time.sleep(1.5)

        # Publisher (replay from the prepared cache, no loop so the media
        # timeline never wraps inside a run) ---------------------------------
        if not (args.encoded_dir / "meta.json").exists():
            raise SystemExit(f"no prepared GOP cache at {args.encoded_dir}; run scripts/run-stack.sh once")
        procs["publisher"] = spawn([
            str(publisher_bin), f"https://{backend.relay_host}:{args.relay_port}",
            "--encoded-dir", str(args.encoded_dir), "--max-variants", str(args.max_variants),
            "--ladder-spec", args.ladder_spec, "--no-loop",
            "--event-log", str(out / "publisher-events.jsonl"),
        ], out / "publisher.log")

        # Vite dev server (serves the player and receives client events) -----
        vite_env = dict(os.environ)
        procs["vite"] = spawn([
            "npm", "run", "--prefix", str(ROOT / "apps/client-js"), "dev", "--",
            "--host", backend.vite_host, "--port", str(args.vite_port), "--strictPort",
        ], out / "vite.log", env=vite_env)
        if not wait_port(backend.vite_host if backend.vite_host != "localhost" else "127.0.0.1", args.vite_port, 60):
            raise SystemExit("vite did not come up")
        warm_vite(f"http://{backend.vite_host}:{args.vite_port}")

        # Let the publisher fill the relay cache past the requested shift so
        # a time-shifted SUBSCRIBE is never held (and never clamped) at startup.
        warmup = max(5.0, args.time_shift + 3.0) if args.client_mode == "time-shifted" else 5.0
        print(f"[run] warming up publisher for {warmup:.0f}s")
        time.sleep(warmup)

        # Initial network state, then background flows -----------------------
        steps = profile["steps"]
        def apply_step(step: dict) -> None:
            shape = Shape(rate_mbps=step.get("rate_mbps"), delay_ms=step.get("delay_ms", 0),
                          loss_pct=step.get("loss_pct", 0), jitter_ms=step.get("jitter_ms", 0))
            backend.apply(shape, profile["queue"], profile["queue_pkts"])
            rlog.emit("NET_CHANGE", {"rate_mbps": shape.rate_mbps, "delay_ms": shape.delay_ms,
                                     "loss_pct": shape.loss_pct, "jitter_ms": shape.jitter_ms,
                                     "queue": profile["queue"], "queue_pkts": profile["queue_pkts"],
                                     "at_s": step["at_s"], "applied": backend.name != "none"})
        apply_step(steps[0])
        bg.start(args.duration + 30)

        # Browser ------------------------------------------------------------
        url = (f"http://{backend.vite_host}:{args.vite_port}/?run={run_id}&autoConnect=1"
               f"&clientMode={args.client_mode}&timeShift={args.time_shift:g}"
               f"&relay=https://{backend.relay_host}:{args.relay_port}")
        if args.log_objects:
            url += "&logObjects=1"
        if args.mechanism_mode:
            url += f"&{MECHANISM_URL_PARAM[args.mechanism]}={args.mechanism_mode}"
        if args.abr:
            url += "&" + args.abr
        hash_file = args.cert_dir / "hash.txt"
        if hash_file.exists():
            url += "&certHash=" + hash_file.read_text().strip()
        browser = find_browser(args.browser)
        if browser is None:
            raise SystemExit("no Firefox or Chromium found; pass --browser")
        procs["browser"] = spawn(backend.wrap(browser_command(browser, url, out, args.headed)), out / "browser.log")
        rlog.emit("BROWSER_START", {"url": url, "binary": browser, "kind": browser_kind(browser),
                                    "headless": not args.headed, "cert_pinned": hash_file.exists()})

        # Main loop: apply steps on schedule, sample process stats -----------
        t0 = time.time()
        step_idx = 1
        last_stats = 0.0
        while time.time() - t0 < args.duration:
            elapsed = time.time() - t0
            if step_idx < len(steps) and elapsed >= steps[step_idx]["at_s"]:
                apply_step(steps[step_idx])
                step_idx += 1
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
        rlog.emit("RUN_END", {"elapsed_s": time.time() - t0})
    except BaseException as e:  # noqa: BLE001 - always tear down
        exit_code = 1 if not isinstance(e, KeyboardInterrupt) else 130
        print(f"[run] aborting: {e!r}")
        rlog.emit("RUN_ABORT", {"error": repr(e)})
    finally:
        # Give the browser a moment to flush its event buffer, then stop it first.
        time.sleep(1.5)
        stop(procs.get("browser"), "browser")
        time.sleep(1.0)
        bg.stop()
        for name in ("publisher", "relay", "vite"):
            stop(procs.get(name), name)
        try:
            backend.apply(Shape(rate_mbps=None), profile["queue"], profile["queue_pkts"]) if backend.name != "none" else None
        except Exception:
            pass
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
        identity = {
            "run_id": run_id,
            "git_sha": git("rev-parse", "HEAD"),
            "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "mechanism": args.mechanism,
            "mechanism_mode": args.mechanism_mode,
            "client_type": args.client_mode,
            "time_shift_s": args.time_shift if args.client_mode == "time-shifted" else 0,
            "delay_groups": client_delay_groups(out),
            "gop_duration_ms": client_gop_duration_ms(out),
            "ladder_id": f"{args.ladder_spec}@{args.encoded_dir.name}",
            "network_profile": profile["name"],
            "trace_id": Path(profile["trace_file"]).stem if profile.get("trace_file") else None,
            "qdisc": profile["queue"] if backend.name != "none" else "none",
            "background_flows": args.bg_flows,
            "background_pattern": args.bg_pattern if args.bg_flows else None,
            "repeat_index": repeat_index,
            "timestamp_start": stamp,
            "dirty_worktree": worktree_dirty(),
            "final": args.final,
            "duration_s": args.duration,
            "abr_overrides": args.abr or None,
            "browser": browser_kind(browser) if browser else None,
            "seed": args.seed,
        }
        meta = {
            "identity": identity,
            "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
            "profile": profile, "host": os.uname().nodename, "platform": sys.platform,
            "net_backend": backend.name,
            # kept for older readers
            "run_id": run_id, "git_branch": identity["branch"], "git_sha": identity["git_sha"], "started": stamp,
        }
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
