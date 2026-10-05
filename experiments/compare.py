#!/usr/bin/env python3
"""Side-by-side comparison of conditions from analyzed runs. Reads each run's
summary.json (analyze.py must have run) and prints one column per condition
(mechanism/mode, client type, network profile + qdisc + congestion controller +
background flows, controller arm) with the summary over its valid repetitions.

    python3 experiments/compare.py results/*/ [--all]   # --all keeps invalid runs

Rows come in three blocks: the headline set of docs/measurement-schema.md, the
reaction rows (detect_step profile only) and, below a separator, diagnostics.
Cell kinds:

  median     median over repetitions
  frac       Bernoulli per run: shown as k/n (fraction), never a median
  censored   right-censored per run (None = never happened): shown as k/n with
             the event and the median with never = inf; runs where the metric is
             not applicable (live-edge client, reaction N/A) are left out of n
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import censored_summary, is_valid  # noqa: E402

NA = object()  # "not applicable for this run": excluded from the column's n


def _ms_to_s(v):
    return v / 1000 if v is not None else None


def _reaction(s: dict, key: str):
    rx = s.get("reaction") or {}
    if rx.get("reaction_na_reason"):
        return NA
    return _ms_to_s(rx.get(key))


def _time_to_half_shift(s: dict):
    ts = s.get("time_shift") or {}
    if ts.get("half_shift_lost") is None:
        return NA
    return _ms_to_s(ts.get("time_to_half_shift_ms"))


def _half_shift_lost(s: dict):
    v = (s.get("time_shift") or {}).get("half_shift_lost")
    return NA if v is None else v


def _frac(num, den):
    return (num / den) if den else None


HEADLINE = [
    ("runs (valid)", lambda s: 1, "count"),
    ("switches / min (run duration)", lambda s: s["switching"]["switches_per_minute"], "median"),
    ("A->B->A reversals", lambda s: s["switching"]["aba_reversals"], "median"),
    ("superseded (frac of switches)", lambda s: s["switches"].get("superseded_frac"), "median"),
    ("presented rung mean", lambda s: s["bitrate"].get("presented_rung_mean"), "median"),
    ("presented kbps", lambda s: s["bitrate"].get("presented_kbps"), "median"),
    ("fit share, low window (frac)", lambda s: (s.get("shares") or {}).get("fit_share_low"), "median"),
    ("share >= pre-drop rung after restore", lambda s: (s.get("shares") or {}).get("pre_drop_share_after_restore"), "median"),
    ("pre-drop rung (median presented)", lambda s: (s.get("shares") or {}).get("pre_drop_rung"), "median"),
    ("stall s (episodes >= 250 ms)", lambda s: s["stalls"]["total_ms"] / 1000, "median"),
    ("stall count (>= 250 ms)", lambda s: s["stalls"]["count"], "median"),
    ("stall blips (< 250 ms, count)", lambda s: s["stalls"].get("blips"), "median"),
    ("media skipped s (gap seeks)", lambda s: _ms_to_s(s["stalls"].get("media_skipped_ms")), "median"),
    ("starvation s (subset of stall)", lambda s: s["starvation"]["total_ms"] / 1000, "median"),
    ("viewer pause p95 ms (own 1st frame)", lambda s: s["switches"]["viewer_pause_ms"].get("p95"), "median"),
    ("visibility p50 ms (own 1st frame)", lambda s: s["switches"]["switch_visibility_delay_ms"].get("p50"), "median"),
    ("startup ms", lambda s: s["startup"]["startup_delay_ms"], "median"),
    ("shift retained, last 60 s (s)", lambda s: _ms_to_s(s["time_shift"].get("retained_live_edge_ms")), "median"),
    ("half shift lost (k/n runs)", _half_shift_lost, "frac"),
    ("time to half shift s (k/n, never=inf)", _time_to_half_shift, "censored"),
    ("live-edge dist mean ms (after window)", lambda s: (s["time_shift"].get("live_edge_after_window_ms") or {}).get("mean"), "median"),
    ("landed on a keyframe (frac)", lambda s: _frac(s["switches"]["landed_on_keyframe"], s["switches"].get("landed_on_keyframe_known")), "median"),
]

# Reaction rows: only from the detect_step profile and only for runs whose presented rung
# at the drop was above the fitting rung; every other run is N/A (left out of k/n).
REACTION = [
    ("down-reaction s (detect_step; k/n)", lambda s: _reaction(s, "down_reaction_ms"), "censored"),
    ("up-recovery s (detect_step; k/n)", lambda s: _reaction(s, "up_recovery_ms"), "censored"),
]

DIAGNOSTICS = [
    ("switches", lambda s: s["switches"]["count"], "median"),
    ("superseded", lambda s: s["switches"]["superseded"], "median"),
    ("open at run end", lambda s: s["switches"].get("open"), "median"),
    ("failed (SWITCH_ERROR)", lambda s: s["switches"]["failed"], "median"),
    ("median inter-switch s", lambda s: _ms_to_s(s["switching"]["median_inter_switch_interval_ms"]), "median"),
    ("stall max ms", lambda s: s["stalls"]["max_ms"], "median"),
    ("data starved s (raw, from last append)", lambda s: _ms_to_s((s.get("starvation") or {}).get("raw_total_ms")), "median"),
    ("wedge seeks skipped s", lambda s: _ms_to_s(s["stalls"].get("wedge_skipped_ms")), "median"),
    ("gap seeks (after window)", lambda s: s["stalls"].get("gap_seeks"), "median"),
    ("range-jumps deferred", lambda s: s["stalls"]["range_jumps_deferred"], "median"),
    ("frozen with playable data s (apparatus)", lambda s: (s["playback"].get("frozen_with_data_ms_total") or 0) / 1000, "median"),
    ("subscribed rung mean (diagnostic)", lambda s: s["bitrate"].get("subscribed_rung_mean"), "median"),
    ("subscribed kbps (diagnostic)", lambda s: s["bitrate"].get("subscribed_kbps"), "median"),
    ("rung at drop (presented)", lambda s: (s.get("shares") or {}).get("rung_at_drop"), "median"),
    ("fit rung (0.9 x low rate)", lambda s: (s.get("shares") or {}).get("fit_rung"), "median"),
    ("landed on object 0 (frac)", lambda s: _frac(s["switches"]["landed_on_group_start"], s["switches"]["count"]), "median"),
    ("landed behind playhead", lambda s: s["switches"].get("landed_behind_playhead"), "median"),
    ("seam buffer hole p50 ms", lambda s: s["switches"]["seam_buffer_hole_ms"].get("p50"), "median"),
    ("seam buffer hole max ms", lambda s: s["switches"]["seam_buffer_hole_ms"].get("max"), "median"),
    ("switch delivery p50 ms (t4)", lambda s: s["switches"]["switch_delivery_latency_ms"].get("p50"), "median"),
    ("relay promoted p50 ms", lambda s: (s["switches"].get("relay_promoted_ms") or {}).get("p50"), "median"),
    ("visibility p95 ms (own 1st frame)", lambda s: s["switches"]["switch_visibility_delay_ms"].get("p95"), "median"),
    ("dropped source frames p50", lambda s: s["switches"]["seam_dropped_source_frames"].get("p50"), "median"),
    ("down detection attributable (k/n)", lambda s: (NA if (s["reaction"].get("reaction_na_reason") or s["reaction"].get("down_reliable") is None) else bool(s["reaction"].get("down_reliable"))), "frac"),
    ("down t2 decision s (attributable)", lambda s: _ms_to_s(s["reaction"].get("down_t2_ms")), "median"),
    ("down t4 landed s (attributable)", lambda s: _ms_to_s(s["reaction"].get("down_t4_ms")), "median"),
    ("slow-start vetoes", lambda s: s["switching"].get("slow_start_vetoes"), "median"),
    ("up-guard vetoes", lambda s: s["switching"]["up_guard_vetoes"], "median"),
    ("up-dwell vetoes", lambda s: s["switching"].get("up_dwell_vetoes"), "median"),
    ("other gated (any other why)", lambda s: sum((s["switching"].get("other_gated") or {}).values()) if "other_gated" in s["switching"] else None, "median"),
    ("phantom switches (never landed)", lambda s: s["switching"].get("phantom_switches"), "median"),
    ("skipped attempts (not sent)", lambda s: s["switches"].get("skipped_attempts", s["switches"].get("skipped_not_sent")), "median"),
    ("probes discarded", lambda s: s["switching"]["probes_discarded"], "median"),
    ("media errors", lambda s: len(s.get("media_errors", [])), "median"),
    ("truncated groups (log-objects)", lambda s: s["delivery"]["truncated_groups"], "median"),
    ("discarded stale objects", lambda s: s["discarded"]["objects"], "median"),
    ("discarded unrouted bytes", lambda s: s["discarded"].get("unrouted_bytes"), "median"),
    ("probe load Mbps", lambda s: s["link"]["probe_mbps"], "median"),
    ("probe-measured throughput min Mbps", lambda s: s["link"].get("probe_measured_mbps", {}).get("min"), "median"),
    ("probe-measured throughput p50 Mbps", lambda s: s["link"].get("probe_measured_mbps", {}).get("p50"), "median"),
    ("QUIC loss rate (relay CONN_STATS)", lambda s: s.get("conn", {}).get("loss_rate"), "median"),
    ("QUIC cwnd min KB", lambda s: (s.get("conn", {}).get("cwnd_bytes", {}).get("min") or 0) / 1000 or None, "median"),
    ("QUIC congestion events", lambda s: s.get("conn", {}).get("congestion_events"), "median"),
    ("relay->client latency p50 ms", lambda s: s["link"]["send_recv_latency_ms"].get("p50"), "median"),
    ("live-edge dist mean ms (whole run)", lambda s: s["time_shift"]["live_edge_distance_ms"].get("mean"), "median"),
    ("initial-window dist ms", lambda s: s["time_shift"]["initial_window"]["live_edge_distance_ms"].get("mean"), "median"),
    ("closest to live (s)", lambda s: _ms_to_s(s["time_shift"].get("min_live_edge_ms")), "median"),
    ("buffer mean s", lambda s: s["time_shift"]["buffer_s"].get("mean"), "median"),
    ("followed <5 s (frac)", lambda s: _frac(s["feedback"]["summary"]["followed_within_window"], s["switches"]["count"]), "median"),
    ("by latency trend (frac)", lambda s: _frac(s["feedback"]["summary"]["followed_within_window_by_latency_trend"], s["switches"]["count"]), "median"),
    ("run duration s", lambda s: s.get("run_duration_s"), "median"),
]
ROWS = HEADLINE + REACTION + DIAGNOSTICS
KIND_BY_NAME = {name: kind for name, _, kind in ROWS}


def cond_key(s: dict) -> str:
    """Four lines: mechanism/mode, client type, profile + qdisc + congestion controller
    (+ background flows), controller arm. Runs with different keys are never pooled."""
    i = s.get("identity") or {}
    mech = (i.get("mechanism") or s.get("mechanism") or "?") + (f"/{i['mechanism_mode']}" if i.get("mechanism_mode") else "")
    ct = i.get("client_type") or s.get("client_mode")
    if ct == "time-shifted":
        ct += f" {i.get('time_shift_s') or s.get('time_shift_s') or ''}s"
    ctl = i.get("controller") or "baseline"
    if i.get("abr_overrides"):
        ctl += " " + i["abr_overrides"]
    params = i.get("controller_params") or {}
    # "grid" before 2026-09-30 had no probe cap; keep the two apart in the table.
    if ctl == "grid" and not params.get("probeMaxBytes"):
        ctl = "grid(uncapped)"
    bg = i.get("background_flows") or 0
    qdisc = i.get("qdisc") or s.get("qdisc") or "?"
    cc = i.get("congestion_controller") or s.get("congestion_controller") or "bbr"
    profile = i.get("network_profile") or s.get("profile")
    return f"{mech}\n{ct or ''}\n{profile}{' bg' + str(bg) if bg else ''} {qdisc} {cc}\nctl {ctl}"


def cell(kind: str, values: list, width: int) -> str:
    """Render one table cell from the per-run values of a condition (NA already removed
    for frac/censored; None kept for censored = never)."""
    if kind == "count":
        return f"{len(values):>{width}}"
    if kind == "frac":
        vals = [v for v in values if v is not None]
        if not vals:
            return f"{'-':>{width}}"
        k = sum(1 for v in vals if v)
        return f"{f'{k}/{len(vals)} ({k / len(vals):.2f})':>{width}}"
    if kind == "censored":
        c = censored_summary(values)
        if c["of"] == 0:
            return f"{'-':>{width}}"
        m = c["median_censored_s"]
        ms = "inf" if m is None or math.isinf(m) else f"{m:.1f}"
        text = f"{c['n']}/{c['of']} {ms}"
        return f"{text:>{width}}"
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return f"{'-':>{width}}"
    m = statistics.median(vals)
    return f"{m:>{width}.2f}" if abs(m) < 10 else f"{m:>{width}.0f}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--all", action="store_true", help="include runs whose validation did not pass")
    ap.add_argument("--headline-only", action="store_true", help="omit the diagnostics block")
    args = ap.parse_args()
    groups: dict[str, list[dict]] = {}
    for r in args.runs:
        p = r / "summary.json"
        if not p.exists():
            continue
        s = json.loads(p.read_text())
        if not is_valid(s.get("validity")) and not args.all:
            continue
        groups.setdefault(cond_key(s), []).append(s)
    if not groups:
        print("no analyzed runs (run analyze.py first; validation must have passed unless --all)")
        return 1
    conds = sorted(groups)
    rules: dict[str, dict[str, float]] = {}
    for c in conds:
        acc: dict[str, list[int]] = {}
        for s in groups[c]:
            for rule, n in s["switching"]["switches_by_rule"].items():
                acc.setdefault(rule, []).append(n)
        rules[c] = {k: statistics.median(v) for k, v in acc.items()}
    w, cw = 40, 24
    # Header: mechanism, client, profile (+bg), "qdisc cc", controller arm.
    header_rows = []
    for c in conds:
        lines = c.splitlines()
        profile, _, rest = lines[2].partition(" ")
        header_rows.append([lines[0], lines[1], profile, rest, lines[3]])
    for li in range(5):
        print(" " * w + "".join(f"{h[li][-cw:]:>{cw}}" for h in header_rows))
    sep = "-" * (w + cw * len(conds))
    print(sep)
    blocks = [("", HEADLINE), ("reaction (detect_step profile only)", REACTION)]
    if not args.headline_only:
        blocks.append(("diagnostics", DIAGNOSTICS))
    for title, block in blocks:
        if title:
            print(sep)
            print(f"{title:<{w}}")
        for name, fn, kind in block:
            cells = []
            for c in conds:
                vals = [fn(s) for s in groups[c]]
                vals = [v for v in vals if v is not NA]
                cells.append(cell(kind, vals, cw))
            print(f"{name:<{w}}" + "".join(cells))
    print(sep)
    all_rules = sorted({r for c in conds for r in rules[c]})
    for rule in all_rules:
        print(f"{'switches by ' + rule:<{w}}" + "".join(f"{rules[c].get(rule, 0):>{cw}.0f}" for c in conds))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
