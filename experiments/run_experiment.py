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
        --client-mode unfiltered --profile experiments/profiles/step_down_up.json \\
        --duration 200 --net netns
    sudo python3 experiments/run_experiment.py --mechanism native \\
        --client-mode filtered --filter-delay 10 --profile experiments/profiles/step_down_up.json \\
        --duration 200 --net netns

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


def stop(p: subprocess.Popen | None, name: str) -> None:
    if p is None or p.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        p.wait(timeout=10)
    except Exception:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            pass
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


def find_browser(explicit: str | None) -> str | None:
    candidates = [explicit] if explicit else []
    candidates += [
        shutil.which("chromium"), shutil.which("chromium-browser"), shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"), shutil.which("chrome"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mechanism", required=True, help="label for the switching mechanism under test (native, pr1378, pr1674-hard, ...)")
    ap.add_argument("--client-mode", choices=["unfiltered", "filtered"], default="unfiltered")
    ap.add_argument("--filter-delay", type=float, default=10.0, help="seconds behind live for filtered clients")
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
    ap.add_argument("--browser", default=None, help="path to a Chromium binary")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--log-objects", action="store_true", help="one OBJECT_RECV per frame (needed for VMAF joins)")
    ap.add_argument("--abr", default="", help="extra ABR URL params, e.g. 'stableBufferTime=8&bufferTimeDefault=8'")
    ap.add_argument("--seed", type=int, default=None, help="recorded in run_meta; profiles are deterministic")
    ap.add_argument("--label", default="", help="free-text label appended to the run id")
    ap.add_argument("--results", type=Path, default=ROOT / "results")
    ap.add_argument("--no-analyze", action="store_true")
    ap.add_argument("--no-lib-build", action="store_true",
                    help="skip rebuilding libs/moqtail-ts (the player imports its dist, which goes stale across branches)")
    args = ap.parse_args()

    profile = load_profile(args.profile)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    mode = "live-edge" if args.client_mode == "unfiltered" else f"shift{args.filter_delay:g}s"
    run_id = f"{stamp}_{args.mechanism}_{mode}_{profile['name']}_bg{args.bg_flows}"
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
            "--cert-file", str(ROOT / "apps/relay/cert/cert.pem"),
            "--key-file", str(ROOT / "apps/relay/cert/key.pem"),
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

        # Let the publisher fill the relay cache past the requested shift so
        # a filtered SUBSCRIBE is never held (and never clamped) at startup.
        warmup = max(5.0, args.filter_delay + 3.0) if args.client_mode == "filtered" else 5.0
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
               f"&clientMode={args.client_mode}&filterDelay={args.filter_delay:g}"
               f"&relay=https://{backend.relay_host}:{args.relay_port}")
        if args.log_objects:
            url += "&logObjects=1"
        if args.abr:
            url += "&" + args.abr
        browser = find_browser(args.browser)
        if browser is None:
            raise SystemExit("no Chromium found; pass --browser")
        chrome_args = [
            browser, "--no-first-run", "--no-default-browser-check", "--disable-gpu-vsync",
            "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors",
            "--webtransport-developer-mode", "--enable-features=WebTransportDeveloperMode",
            "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
            f"--user-data-dir={out / 'chrome-profile'}", "--window-size=1280,800",
        ]
        if not args.headed:
            chrome_args.append("--headless=new")
        chrome_args.append(url)
        procs["browser"] = spawn(backend.wrap(chrome_args), out / "browser.log")
        rlog.emit("BROWSER_START", {"url": url, "binary": browser, "headless": not args.headed})

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
        meta = {
            "run_id": run_id, "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
            "profile": profile, "git_branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "git_sha": git("rev-parse", "HEAD"), "started": stamp, "host": os.uname().nodename,
            "platform": sys.platform, "net_backend": backend.name,
        }
        (out / "run_meta.json").write_text(json.dumps(meta, indent=2))
        print(f"[run] wrote {out / 'run_meta.json'}")
        if not args.no_analyze and exit_code == 0:
            subprocess.run([sys.executable, str(HERE / "analyze.py"), str(out)], check=False)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
