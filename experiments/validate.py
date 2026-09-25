#!/usr/bin/env python3
"""Validation suite for one experiment run: is the instrumentation telling the truth?

    python3 experiments/validate.py results/<run_id> [--gop-tolerance 1.5] [--clock-tolerance-ms 250]

Run it on a short unshaped run of each client type before generating a series.
Checks (each PASS / FAIL / SKIP with the numbers behind it):

  identity      run_meta.json carries the identity block and it matches the client RUN_META
  live-edge     live-edge client: target shift is 0 and the mean live-edge distance is
                small (under --gop-tolerance GOPs)
  time-shifted  time-shifted client: mean live-edge distance in the first --window-s
                seconds after the first frame is within --gop-tolerance GOPs of
                delay_groups x GOP, and the first group was the expected one (not clamped)
  ordering      for every switch: decision <= sent <= relay SWITCH_RECV <= relay
                SWITCH_PROMOTED <= first object <= applied <= first frame (where present)
  clocks        relay SWITCH_RECV follows the client's SWITCH_SENT by a plausible
                one-way delay (0 .. --clock-tolerance-ms), which is what the
                shared-host clock assumption predicts; the client's CLOCK_MAP is present
  join          for several groups G: publisher GROUP_EMIT(G) <= relay CACHE_GROUP(G)
                <= client receipt of G (OBJECT_RECV with --log-objects, else the
                THROUGHPUT_SAMPLE that finalises G), on the track the client was on
  playback      the playhead advanced in at least half of the sample intervals,
                never stood still longer than --max-freeze-s, and the MoQ session
                was not destroyed by a failed switch
  clean-worktree (--final only) the run was made from a committed tree

Writes validation.json into the run directory; analyze.py excludes runs whose
validation failed from aggregate CSVs and statistics unless --include-invalid.

Exit status 1 if any check fails.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import analyze, last_session, load, track_matches, wall_clock_gaps  # noqa: E402


def fmt_pct(v) -> str:
    return "-" if v is None else f"{v * 100:.0f} %"


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, name: str, ok: bool | None, detail: str) -> None:
        self.rows.append((name, "SKIP" if ok is None else ("PASS" if ok else "FAIL"), detail))

    @property
    def failed(self) -> bool:
        return any(r[1] == "FAIL" for r in self.rows)

    def render(self) -> str:
        w = max(len(r[0]) for r in self.rows)
        return "\n".join(f"{r[1]:4}  {r[0]:{w}}  {r[2]}" for r in self.rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", type=Path)
    ap.add_argument("--gop-tolerance", type=float, default=1.5, help="tolerance in GOPs for distance checks")
    ap.add_argument("--clock-tolerance-ms", type=float, default=250.0)
    ap.add_argument("--join-samples", type=int, default=5)
    ap.add_argument("--window-s", type=float, default=5.0, help="seconds after the first frame used for the initial-shift check")
    ap.add_argument("--max-freeze-s", type=float, default=10.0, help="longest tolerated stretch without playhead progress")
    ap.add_argument("--final", action="store_true",
                    help="paper-quality gate: also require a clean git worktree at run time")
    ap.add_argument("--no-write", action="store_true", help="do not write validation.json into the run directory")
    args = ap.parse_args()

    recs, sessions = last_session(load(args.run))
    by = lambda ev: [r for r in recs if r.get("event") == ev]  # noqa: E731
    rep = Report()
    gaps = wall_clock_gaps(recs)
    rep.add("single-session", sessions == 1 and not gaps,
            f"client page sessions={sessions} (a reload restarts request ids); wall-clock gaps >5 s in SAMPLE: "
            f"{[round(g / 1000, 1) for g in gaps] or 'none'} (suspend or freeze)")

    # identity ---------------------------------------------------------------
    meta = json.loads((args.run / "run_meta.json").read_text()) if (args.run / "run_meta.json").exists() else {}
    identity = meta.get("identity") or {}
    client_meta = next((r for r in by("RUN_META") if r.get("src") == "client"), {})
    pub_meta = next((r for r in by("RUN_META") if r.get("src") == "publisher"), {})
    required = ["run_id", "git_sha", "branch", "mechanism", "client_type", "delay_groups", "gop_duration_ms",
                "ladder_id", "network_profile", "qdisc", "background_flows", "repeat_index", "timestamp_start"]
    missing = [k for k in required if k not in identity]
    consistent = (identity.get("client_type") == client_meta.get("client_mode")
                  and identity.get("delay_groups") == client_meta.get("delay_groups"))
    rep.add("identity", not missing and consistent,
            f"missing={missing or 'none'}; client_type={identity.get('client_type')} vs client RUN_META "
            f"{client_meta.get('client_mode')}; delay_groups={identity.get('delay_groups')} vs {client_meta.get('delay_groups')}")

    gop = client_meta.get("gop_duration_ms") or 1000
    client_type = client_meta.get("client_mode")
    startup = next(iter(by("STARTUP")), None)
    first_switch = next(iter(by("SWITCH_SENT")), None)
    samples = [s for s in by("SAMPLE") if startup and s["ts"] >= startup["ts"] and s.get("live_edge_distance_ms") is not None]
    # The analyzer owns the initial-shift window definition (stored in the
    # summary), so the check and the reported number cannot drift apart.
    summary = analyze(args.run, initial_window_s=args.window_s)
    (args.run / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    initial = summary["time_shift"]["initial_window"]
    pre_switch = [s for s in samples if initial["end_ms"] is not None and s["ts"] < initial["end_ms"]]

    # live-edge / time-shifted ----------------------------------------------
    if client_type == "live-edge":
        dist = [s["live_edge_distance_ms"] for s in samples]
        mean = statistics.fmean(dist) if dist else None
        ok = bool(dist) and client_meta.get("target_shift_ms") == 0 and 0 <= mean <= args.gop_tolerance * gop
        rep.add("live-edge", ok, f"target_shift_ms={client_meta.get('target_shift_ms')} mean_distance_ms={mean and round(mean, 1)} "
                                 f"(n={len(dist)}, bound {args.gop_tolerance * gop:.0f})")
        rep.add("time-shifted", None, "not a time-shifted client")
    elif client_type == "time-shifted":
        dist = [s["live_edge_distance_ms"] for s in pre_switch]
        mean = statistics.fmean(dist) if dist else None
        target = (client_meta.get("delay_groups") or 0) * gop
        fo = next(iter(by("FIRST_OBJECT")), {})
        ok = (bool(dist) and abs(mean - target) <= args.gop_tolerance * gop and fo.get("clamped") is False
              and fo.get("group") == fo.get("expected_start_group"))
        rep.add("time-shifted", ok, f"initial-window [{initial['definition']}] mean_distance_ms={mean and round(mean, 1)} target={target} "
                                    f"(n={len(dist)}, tol {args.gop_tolerance * gop:.0f}); first_group={fo.get('group')} "
                                    f"expected={fo.get('expected_start_group')} clamped={fo.get('clamped')}")
        rep.add("live-edge", None, "not a live-edge client")
    else:
        rep.add("live-edge", False, f"unknown client type {client_type!r}")

    # ordering ---------------------------------------------------------------
    switches = summary.get("switches", {}).get("list", [])
    bad = []
    for sw in switches:
        seq = [("t2", -(sw["t2_decision_ms"] or 0) if sw["t2_decision_ms"] is not None else None), ("t3", 0.0),
               ("relay_recv", sw["relay_recv_ms"]), ("promoted", sw["relay_promoted_ms"]),
               ("t4", sw["switch_delivery_latency_ms"]), ("applied", sw["applied_ms"]),
               ("t5", sw["switch_visibility_delay_ms"])]
        present = [(k, v) for k, v in seq if v is not None]
        for (ka, va), (kb, vb) in zip(present, present[1:]):
            if vb < va - 1e-6:
                bad.append(f"{sw['from']}->{sw['to']}: {kb}({vb:.1f}) < {ka}({va:.1f})")
    rep.add("ordering", (not bad) if switches else None,
            f"{len(switches)} switches checked; violations: {bad[:3] or 'none'}")

    # clocks -----------------------------------------------------------------
    clock = next(iter(by("CLOCK_MAP")), None)
    deltas = [sw["relay_recv_ms"] for sw in switches if sw["relay_recv_ms"] is not None]
    if deltas:
        ok = clock is not None and all(0 <= d <= args.clock_tolerance_ms for d in deltas)
        rep.add("clocks", ok, f"client SWITCH_SENT -> relay SWITCH_RECV: min={min(deltas):.1f} max={max(deltas):.1f} ms "
                              f"(n={len(deltas)}, allowed 0..{args.clock_tolerance_ms:.0f}); CLOCK_MAP={'yes' if clock else 'no'}")
    else:
        rep.add("clocks", None, "no switch to compare clocks on")

    # join -------------------------------------------------------------------
    stats_by_id = {}
    for r in by("CACHE_STATS"):
        stats_by_id[r.get("relay_track_id")] = r.get("track")
    cache_groups = {}
    for r in by("CACHE_GROUP"):
        cache_groups[(stats_by_id.get(r.get("relay_track_id")), r.get("group"))] = r["ts"]
    emits = {(r.get("track"), r.get("group")): r["ts"] for r in by("GROUP_EMIT")}
    recv = {}
    for r in by("OBJECT_RECV"):
        recv.setdefault((r.get("track"), r.get("group")), r["ts"])
    if not recv:
        # THROUGHPUT_SAMPLE is emitted when the group after G arrives; use it as an upper bound.
        for r in by("THROUGHPUT_SAMPLE"):
            recv.setdefault((r.get("track"), r.get("group")), r["ts"])
    checked, violations = 0, []
    for (track, group), t_client in sorted(recv.items(), key=lambda kv: kv[1]):
        if checked >= args.join_samples:
            break
        t_pub = emits.get((track, group))
        t_relay = next((ts for (rt, g), ts in cache_groups.items() if g == group and track_matches(rt, track)), None)
        if t_pub is None or t_relay is None:
            continue
        checked += 1
        if not (t_pub <= t_relay + 1 and t_relay <= t_client + 1):
            violations.append(f"{track} G{group}: pub {t_pub:.0f} relay {t_relay:.0f} client {t_client:.0f}")
    rep.add("join", (not violations) if checked else None,
            f"{checked} groups joined publisher->relay->client; violations: {violations or 'none'}"
            + ("" if by("OBJECT_RECV") else " (client side from THROUGHPUT_SAMPLE; use --log-objects for exact receipt)"))

    # playback ---------------------------------------------------------------
    pb = summary.get("playback", {})
    frac = pb.get("advancing_fraction"); longest = pb.get("longest_no_progress_ms") or 0
    destroyed = summary.get("switches", {}).get("session_destroyed")
    ok = frac is not None and frac >= 0.5 and longest <= args.max_freeze_s * 1000 and not destroyed
    rep.add("playback", ok, f"playhead advancing in {fmt_pct(frac)} of sample intervals (need >= 50 %); longest no-progress "
                            f"{longest / 1000:.1f} s (max {args.max_freeze_s:g}); session destroyed={destroyed}")

    # worktree ---------------------------------------------------------------
    dirty = identity.get("dirty_worktree")
    if args.final:
        rep.add("clean-worktree", dirty is False, f"dirty_worktree={dirty} (required false for --final)")
    else:
        rep.add("clean-worktree", None, f"dirty_worktree={dirty} (only enforced with --final)")

    print(rep.render())
    if not args.no_write:
        summary["validity"] = {"valid": not rep.failed, "reasons": [r[0] for r in rep.rows if r[1] == "FAIL"], "final": args.final}
        (args.run / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
        (args.run / "validation.json").write_text(json.dumps({
            "passed": not rep.failed, "final": args.final,
            "failed": [r[0] for r in rep.rows if r[1] == "FAIL"],
            "checks": [{"name": r[0], "status": r[1], "detail": r[2]} for r in rep.rows],
            "gop_tolerance": args.gop_tolerance, "clock_tolerance_ms": args.clock_tolerance_ms,
            "window_s": args.window_s,
        }, indent=2))
    return 1 if rep.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
