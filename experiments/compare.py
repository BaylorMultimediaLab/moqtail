#!/usr/bin/env python3
"""Side-by-side comparison of conditions (mechanism, mode, client type) from
analyzed runs. Reads each run's summary.json (analyze.py must have run) and
prints one column per condition with the median over its valid repetitions.

    python3 experiments/compare.py results/*/ [--all]   # --all keeps invalid runs
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

ROWS = [
    ("runs (valid)", lambda s: 1),
    ("switches", lambda s: s["switches"]["count"]),
    ("switches / min", lambda s: s["switching"]["switches_per_minute"]),
    ("A->B->A reversals", lambda s: s["switching"]["aba_reversals"]),
    ("median inter-switch s", lambda s: (s["switching"]["median_inter_switch_interval_ms"] or 0) / 1000 or None),
    ("landed on keyframe (frac)", lambda s: s["switches"]["landed_on_group_start"] / s["switches"]["count"] if s["switches"]["count"] else None),
    ("seam buffer hole p50 ms", lambda s: s["switches"]["seam_buffer_hole_ms"].get("p50")),
    ("seam buffer hole max ms", lambda s: s["switches"]["seam_buffer_hole_ms"].get("max")),
    ("viewer pause p95 ms", lambda s: s["switches"]["viewer_pause_ms"].get("p95")),
    ("switch visibility p50 ms", lambda s: s["switches"]["switch_visibility_delay_ms"].get("p50")),
    ("switch delivery p50 ms", lambda s: s["switches"]["switch_delivery_latency_ms"].get("p50")),
    ("dropped source frames p50", lambda s: s["switches"]["seam_dropped_source_frames"].get("p50")),
    ("superseded", lambda s: s["switches"]["superseded"]),
    ("stalls", lambda s: s["stalls"]["count"]),
    ("stalled s", lambda s: s["stalls"]["total_ms"] / 1000),
    ("stall max ms", lambda s: s["stalls"]["max_ms"]),
    ("played kbps", lambda s: s["bitrate"].get("time_weighted_mean_kbps")),
    ("startup ms", lambda s: s["startup"]["startup_delay_ms"]),
    ("live-edge dist mean ms", lambda s: s["time_shift"]["live_edge_distance_ms"].get("mean")),
    ("initial-window dist ms", lambda s: s["time_shift"]["initial_window"]["live_edge_distance_ms"].get("mean")),
    ("time to half shift s", lambda s: (s["time_shift"]["time_to_half_shift_ms"] or 0) / 1000 or None),
    ("buffer mean s", lambda s: s["time_shift"]["buffer_s"].get("mean")),
    ("followed <5 s (frac)", lambda s: s["feedback"]["summary"]["followed_within_window"] / s["switches"]["count"] if s["switches"]["count"] else None),
    ("by latency trend (frac)", lambda s: s["feedback"]["summary"]["followed_within_window_by_latency_trend"] / s["switches"]["count"] if s["switches"]["count"] else None),
]


def cond_key(s: dict) -> str:
    i = s.get("identity") or {}
    mech = (i.get("mechanism") or s.get("mechanism") or "?") + (f"/{i['mechanism_mode']}" if i.get("mechanism_mode") else "")
    ct = i.get("client_type") or s.get("client_mode")
    if ct == "time-shifted":
        ct += f" {i.get('time_shift_s') or s.get('time_shift_s') or ''}s"
    return f"{mech}\n{ct}\n{i.get('network_profile') or s.get('profile')}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--all", action="store_true", help="include runs whose validation failed")
    args = ap.parse_args()
    groups: dict[str, list[dict]] = {}
    for r in args.runs:
        p = r / "summary.json"
        if not p.exists():
            continue
        s = json.loads(p.read_text())
        v = s.get("validity", {})
        if v.get("valid") is False and not args.all:
            continue
        groups.setdefault(cond_key(s), []).append(s)
    if not groups:
        print("no analyzed runs"); return 1
    conds = sorted(groups)
    rules: dict[str, dict[str, float]] = {}
    for c in conds:
        acc: dict[str, list[int]] = {}
        for s in groups[c]:
            for rule, n in s["switching"]["switches_by_rule"].items():
                acc.setdefault(rule, []).append(n)
        rules[c] = {k: statistics.median(v) for k, v in acc.items()}
    w = 26
    header = " " * w + "".join(f"{c.splitlines()[0]:>22}" for c in conds)
    print(header)
    for line in (1, 2):
        print(" " * w + "".join(f"{c.splitlines()[line]:>22}" for c in conds))
    print("-" * (w + 22 * len(conds)))
    for name, fn in ROWS:
        cells = []
        for c in conds:
            vals = [fn(s) for s in groups[c]]
            vals = [v for v in vals if v is not None]
            if name == "runs (valid)":
                cells.append(f"{len(groups[c]):>22}")
            elif not vals:
                cells.append(f"{'-':>22}")
            else:
                m = statistics.median(vals)
                cells.append(f"{m:>22.2f}" if isinstance(m, float) and abs(m) < 10 else f"{m:>22.0f}")
        print(f"{name:<{w}}" + "".join(cells))
    print("-" * (w + 22 * len(conds)))
    all_rules = sorted({r for c in conds for r in rules[c]})
    for rule in all_rules:
        print(f"{'switches by ' + rule:<{w}}" + "".join(f"{rules[c].get(rule, 0):>22.0f}" for c in conds))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
