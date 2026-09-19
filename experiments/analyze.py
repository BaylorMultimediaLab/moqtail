#!/usr/bin/env python3
"""Summarise one or more experiment runs from their JSONL event logs.

    python3 experiments/analyze.py results/<run_id> [results/<run_id2> ...]
    python3 experiments/analyze.py results/*  --csv results/aggregate.csv

Per run it writes ``summary.json`` and ``summary.md`` next to the logs. With
several runs it also writes one aggregate CSV row per run.

Metric definitions (see docs/measurement-schema.md):

* startup_delay_ms        CONNECT_START -> first rendered frame (STARTUP)
* stalls                  STALL_START/STALL_END episodes after the first frame;
                          wedge/range-jump SEEKs are listed separately since
                          they hide stalls the element never reports
* switches                SWITCH_SENT count, up/down split, and per switch the
                          detection timeline t2..t5 plus the relay-side
                          SWITCH_RECV / SWITCH_PROMOTED stamps
* detection               for every NET_CHANGE: t0 (change), t1 (first
                          THROUGHPUT_SAMPLE within --t1-tolerance of the new
                          rate), t2 (first ABR_DECISION in the right
                          direction), t3 SWITCH_SENT, t4 SWITCH_FIRST_OBJECT,
                          t5 SWITCH_FIRST_FRAME
* time_shift              SAMPLE.time_shift_error_ms (signed, absolute) and
                          live_edge_distance_ms statistics
* recovery                after an up-step: quality recovery (track index back
                          to the pre-drop index) and offset recovery
                          (|time_shift_error| within --offset-tolerance for
                          --offset-hold seconds)
* bitrate                 time-weighted mean played bitrate and per-track share
* cache / process         relay CACHE_STATS and runner PROC_STATS extremes
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path


def load(run: Path) -> list[dict]:
    recs: list[dict] = []
    for name in ("client-events.jsonl", "relay-events.jsonl", "publisher-events.jsonl", "runner-events.jsonl"):
        p = run / name
        if not p.exists():
            continue
        with p.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    recs.sort(key=lambda r: r.get("ts", 0))
    return recs


def pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def stats(values: list[float]) -> dict:
    vals = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not vals:
        return {"n": 0}
    return {
        "n": len(vals), "mean": statistics.fmean(vals), "p50": pct(vals, 0.5), "p95": pct(vals, 0.95),
        "min": min(vals), "max": max(vals),
    }


def first(recs: list[dict], event: str, after: float = -1, pred=None) -> dict | None:
    for r in recs:
        if r.get("event") == event and r.get("ts", 0) >= after and (pred is None or pred(r)):
            return r
    return None


def analyze(run: Path, t1_tol: float, offset_tol_ms: float, offset_hold_s: float) -> dict:
    recs = load(run)
    by = lambda ev: [r for r in recs if r.get("event") == ev]  # noqa: E731
    meta = json.loads((run / "run_meta.json").read_text()) if (run / "run_meta.json").exists() else {}
    client_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "client") or {}
    pub_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "publisher") or {}
    ladder = sorted(client_meta.get("ladder", []), key=lambda t: t.get("bitrate") or 0)
    index_of = {t["track"]: i for i, t in enumerate(ladder)}
    bitrate_of = {t["track"]: (t.get("bitrate") or 0) for t in ladder}

    out: dict = {
        "run_id": meta.get("run_id", run.name),
        "mechanism": meta.get("args", {}).get("mechanism"),
        "client_mode": client_meta.get("client_mode"),
        "filter_delay_s": client_meta.get("filter_delay_s"),
        "delay_groups": client_meta.get("delay_groups"),
        "target_shift_ms": client_meta.get("target_shift_ms"),
        "profile": meta.get("profile", {}).get("name"),
        "bg_flows": meta.get("args", {}).get("bg_flows"),
        "gops_per_variant": pub_meta.get("gops_per_variant"),
        "events": len(recs),
    }

    # Startup ---------------------------------------------------------------
    st = first(recs, "STARTUP")
    fo = first(recs, "FIRST_OBJECT")
    out["startup"] = {
        "startup_delay_ms": st.get("startup_delay_ms") if st else None,
        "connect_to_first_object_ms": st.get("connect_to_first_object_ms") if st else None,
        "first_object_to_first_frame_ms": st.get("first_object_to_first_frame_ms") if st else None,
        "first_group": fo.get("group") if fo else None,
        "expected_start_group": fo.get("expected_start_group") if fo else None,
        "clamped_by_relay": fo.get("clamped") if fo else None,
        "startup_track": st.get("track") if st else None,
    }

    # Stalls and seeks -------------------------------------------------------
    episodes = []
    open_start = None
    for r in recs:
        if r.get("event") == "STALL_START":
            open_start = r
        elif r.get("event") == "STALL_END" and open_start is not None:
            episodes.append({"ts": open_start["ts"], "cause": r.get("cause"), "duration_ms": r.get("duration_ms"),
                             "playhead_ms": r.get("playhead_ms")})
            open_start = None
    durations = [e["duration_ms"] for e in episodes if e["duration_ms"] is not None]
    seeks = by("SEEK")
    out["stalls"] = {
        "count": len(episodes), "total_ms": sum(durations), "max_ms": max(durations) if durations else 0,
        "episodes": episodes,
        "seeks": {reason: sum(1 for s in seeks if s.get("reason") == reason)
                  for reason in ("startup", "wedge", "range-jump", "visibility")},
        "wedge_gap_ms_total": sum(s.get("gap_ms") or 0 for s in seeks if s.get("reason") == "wedge"),
    }

    # Switch timelines -------------------------------------------------------
    switch_recv = by("SWITCH_RECV")
    promoted = by("SWITCH_PROMOTED")
    switches = []
    for sent in by("SWITCH_SENT"):
        rid = sent.get("request_id")
        decision = None
        for r in reversed([d for d in by("ABR_DECISION") if d["ts"] <= sent["ts"] + 5]):
            if r.get("to") == sent.get("to"):
                decision = r
                break
        ok = first(recs, "SWITCH_OK", sent["ts"], lambda r: r.get("request_id") == rid)
        err = first(recs, "SWITCH_ERROR", sent["ts"], lambda r: r.get("request_id") == rid)
        rrecv = next((r for r in switch_recv if r.get("request_id") == rid), None)
        rprom = first(promoted, "SWITCH_PROMOTED", rrecv["ts"] if rrecv else sent["ts"],
                      lambda r: sent.get("to") is None or sent["to"] in str(r.get("track"))) if rrecv else None
        fobj = first(recs, "SWITCH_FIRST_OBJECT", sent["ts"], lambda r: r.get("to") == sent.get("to"))
        applied = first(recs, "SWITCH_APPLIED", sent["ts"], lambda r: r.get("to") == sent.get("to"))
        fframe = first(recs, "SWITCH_FIRST_FRAME", sent["ts"], lambda r: r.get("to") == sent.get("to"))
        fi, ti = index_of.get(sent.get("from"), -1), index_of.get(sent.get("to"), -1)
        d = lambda r: (r["ts"] - sent["ts"]) if r else None  # noqa: E731
        switches.append({
            "ts": sent["ts"], "from": sent.get("from"), "to": sent.get("to"),
            "direction": "up" if ti > fi else "down" if ti < fi else "same",
            "reason": decision.get("reason") if decision else None,
            "rule_reason": decision.get("rule_reason") if decision else None,
            "t2_decision_ms": (sent["ts"] - decision["ts"]) if decision else None,
            "t3_ok_ms": d(ok), "error": err.get("reason") if err else None,
            "relay_recv_ms": d(rrecv), "relay_promoted_ms": d(rprom),
            "relay_start_group": rprom.get("start_group") if rprom else None,
            "t4_first_object_ms": d(fobj), "t4_group": fobj.get("group") if fobj else None,
            "applied_ms": d(applied),
            "pts_gap_ms": applied.get("pts_gap_ms") if applied else None,
            "playhead_gap_ms": applied.get("playhead_gap_ms") if applied else None,
            "t5_first_frame_ms": d(fframe),
            "perceived_pause_ms": fframe.get("perceived_pause_ms") if fframe else None,
            "playhead_ms": sent.get("playhead_ms"), "playhead_group": sent.get("playhead_group"),
            "last_received_group": sent.get("last_received_group"),
        })
    out["switches"] = {
        "count": len(switches),
        "up": sum(1 for s in switches if s["direction"] == "up"),
        "down": sum(1 for s in switches if s["direction"] == "down"),
        "failed": sum(1 for s in switches if s["error"]),
        "t4_first_object_ms": stats([s["t4_first_object_ms"] for s in switches]),
        "t5_first_frame_ms": stats([s["t5_first_frame_ms"] for s in switches]),
        "playhead_gap_ms": stats([s["playhead_gap_ms"] for s in switches]),
        "abs_playhead_gap_ms": stats([abs(s["playhead_gap_ms"]) for s in switches if s["playhead_gap_ms"] is not None]),
        "perceived_pause_ms": stats([s["perceived_pause_ms"] for s in switches]),
        "list": switches,
        "guard_timeouts": len(by("ABR_GUARD_TIMEOUT")),
        "gated_slow_start": len(by("ABR_GATED")),
    }

    # Samples: time shift, live edge, bitrate --------------------------------
    samples = [s for s in by("SAMPLE") if st is None or s["ts"] >= st["ts"]]
    tse = [s.get("time_shift_error_ms") for s in samples if s.get("time_shift_error_ms") is not None]
    led = [s.get("live_edge_distance_ms") for s in samples if s.get("live_edge_distance_ms") is not None]
    out["time_shift"] = {
        "signed_error_ms": stats(tse), "abs_error_ms": stats([abs(v) for v in tse]),
        "live_edge_distance_ms": stats(led),
        "buffer_s": stats([s.get("buffer_s") for s in samples]),
        "playback_rate": stats([s.get("playback_rate") for s in samples]),
        "latency_ms": stats([s.get("last_latency_ms") for s in samples if s.get("last_latency_ms")]),
    }
    if len(samples) >= 2:
        weighted = 0.0
        share: dict[str, float] = {}
        for a, b in zip(samples, samples[1:]):
            dt = max(0.0, (b["ts"] - a["ts"]) / 1000.0)
            weighted += (a.get("bitrate_kbps") or 0) * dt
            share[a.get("track") or "?"] = share.get(a.get("track") or "?", 0.0) + dt
        total = sum(share.values()) or 1.0
        out["bitrate"] = {
            "time_weighted_mean_kbps": weighted / total,
            "track_share": {k: v / total for k, v in share.items()},
            "played_s": total,
            "dropped_frames": samples[-1].get("dropped_frames"),
            "total_frames": samples[-1].get("total_frames"),
        }
    else:
        out["bitrate"] = {}

    # Detection timelines per NET_CHANGE ------------------------------------
    detections = []
    changes = by("NET_CHANGE")
    for i, ch in enumerate(changes[1:], start=1):
        prev_rate = changes[i - 1].get("rate_mbps")
        new_rate = ch.get("rate_mbps")
        if prev_rate is None or new_rate is None or prev_rate == new_rate:
            continue
        direction = "down" if new_rate < prev_rate else "up"
        t0 = ch["ts"]
        window_end = changes[i + 1]["ts"] if i + 1 < len(changes) else float("inf")
        target_bps = new_rate * 1e6
        t1 = first(recs, "THROUGHPUT_SAMPLE", t0,
                   lambda r: r["ts"] < window_end and (
                       (direction == "down" and r.get("bps", 0) <= target_bps * (1 + t1_tol)) or
                       (direction == "up" and r.get("bps", 0) >= min(prev_rate * 1e6 * (1 + t1_tol), target_bps * (1 - t1_tol)))))
        t2 = first(recs, "ABR_DECISION", t0, lambda r: r["ts"] < window_end and
                   ((direction == "down" and r.get("reason") in ("auto-downgrade", "auto-emergency")) or
                    (direction == "up" and r.get("reason") == "auto-upgrade")))
        sw = next((s for s in switches if t2 and s["to"] == t2.get("to") and abs(s["ts"] - t2["ts"]) < 5000), None)
        # Recovery after an up-step: track index back to the pre-drop level.
        rec = {"direction": direction, "from_mbps": prev_rate, "to_mbps": new_rate, "t0": t0,
               "t1_ms": (t1["ts"] - t0) if t1 else None, "t1_bps": t1.get("bps") if t1 else None,
               "t2_ms": (t2["ts"] - t0) if t2 else None, "t2_rule": t2.get("rule_reason") if t2 else None,
               "t2_from": t2.get("from") if t2 else None, "t2_to": t2.get("to") if t2 else None,
               "t3_ms": (sw["ts"] - t0) if sw else None,
               "t4_ms": (sw["ts"] + sw["t4_first_object_ms"] - t0) if sw and sw["t4_first_object_ms"] else None,
               "t5_ms": (sw["ts"] + sw["t5_first_frame_ms"] - t0) if sw and sw["t5_first_frame_ms"] else None}
        if direction == "up":
            pre = [s for s in samples if s["ts"] < changes[i - 1]["ts"]]
            pre_index = index_of.get(pre[-1].get("track"), None) if pre else None
            q = first(samples, "SAMPLE", t0, lambda s: pre_index is not None and index_of.get(s.get("track"), -1) >= pre_index)
            rec["pre_drop_index"] = pre_index
            rec["quality_recovery_ms"] = (q["ts"] - t0) if q else None
            # Offset recovery: |error| within tolerance for offset_hold_s.
            hold_start = None
            off = None
            for s in samples:
                if s["ts"] < t0:
                    continue
                e = s.get("time_shift_error_ms")
                if e is not None and abs(e) <= offset_tol_ms:
                    hold_start = hold_start or s["ts"]
                    if s["ts"] - hold_start >= offset_hold_s * 1000:
                        off = hold_start
                        break
                else:
                    hold_start = None
            rec["offset_recovery_ms"] = (off - t0) if off else None
        detections.append(rec)
    out["detection"] = detections

    # Relay cache and process stats -----------------------------------------
    cache = {}
    for r in by("CACHE_STATS"):
        c = cache.setdefault(r.get("track"), {"bytes": [], "groups": []})
        c["bytes"].append(r.get("bytes", 0))
        c["groups"].append(r.get("groups", 0))
    out["cache"] = {
        "per_track": {k: {"max_bytes": max(v["bytes"]), "mean_bytes": statistics.fmean(v["bytes"]),
                          "max_groups": max(v["groups"])} for k, v in cache.items()},
        "total_max_bytes": sum(max(v["bytes"]) for v in cache.values()) if cache else 0,
        "evictions": len(by("CACHE_EVICT")),
        "eviction_bytes": sum(r.get("bytes", 0) for r in by("CACHE_EVICT")),
    }
    procs: dict[str, dict] = {}
    for r in by("PROC_STATS"):
        p = procs.setdefault(r.get("process"), {"rss": [], "cpu": []})
        p["rss"].append(r.get("rss_bytes", 0))
        p["cpu"].append(r.get("cpu_pct", 0.0))
    out["process"] = {k: {"max_rss_bytes": max(v["rss"]), "mean_cpu_pct": statistics.fmean(v["cpu"])}
                      for k, v in procs.items() if v["rss"]}
    out["relay"] = {
        "subscribes": len(by("SUBSCRIBE_RECV")), "holds": len(by("SUBSCRIBE_HOLD")),
        "clamped": sum(1 for r in by("SUBSCRIBE_RECV") if r.get("decision") == "clamped"),
        "switch_recv": len(switch_recv), "switch_promoted": len(promoted),
    }
    out["publisher"] = {"groups_emitted": len(by("GROUP_EMIT"))}
    out["client_errors"] = [r.get("message") for r in by("ERROR")]
    return out


def fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def to_markdown(s: dict) -> str:
    L = [f"# {s['run_id']}", "",
         f"mechanism={s['mechanism']} client={s['client_mode']} shift={s['filter_delay_s']}s "
         f"(delay_groups={s['delay_groups']}, target={s['target_shift_ms']} ms) profile={s['profile']} bg={s['bg_flows']}", "",
         "| metric | value |", "|---|---|",
         f"| startup delay (ms) | {fmt(s['startup']['startup_delay_ms'])} |",
         f"| first group / expected / clamped | {s['startup']['first_group']} / {s['startup']['expected_start_group']} / {s['startup']['clamped_by_relay']} |",
         f"| stalls (count / total ms / max ms) | {s['stalls']['count']} / {fmt(s['stalls']['total_ms'])} / {fmt(s['stalls']['max_ms'])} |",
         f"| seeks wedge / range-jump | {s['stalls']['seeks']['wedge']} / {s['stalls']['seeks']['range-jump']} |",
         f"| switches (up / down / failed) | {s['switches']['count']} ({s['switches']['up']} / {s['switches']['down']} / {s['switches']['failed']}) |",
         f"| switch t4 first object ms (mean / p95) | {fmt(s['switches']['t4_first_object_ms'].get('mean'))} / {fmt(s['switches']['t4_first_object_ms'].get('p95'))} |",
         f"| switch t5 first frame ms (mean / p95) | {fmt(s['switches']['t5_first_frame_ms'].get('mean'))} / {fmt(s['switches']['t5_first_frame_ms'].get('p95'))} |",
         f"| playhead gap ms (mean / abs p95) | {fmt(s['switches']['playhead_gap_ms'].get('mean'))} / {fmt(s['switches']['abs_playhead_gap_ms'].get('p95'))} |",
         f"| time-shift error ms signed mean / abs p95 | {fmt(s['time_shift']['signed_error_ms'].get('mean'))} / {fmt(s['time_shift']['abs_error_ms'].get('p95'))} |",
         f"| live-edge distance ms mean / p95 | {fmt(s['time_shift']['live_edge_distance_ms'].get('mean'))} / {fmt(s['time_shift']['live_edge_distance_ms'].get('p95'))} |",
         f"| buffer s mean / p50 | {fmt(s['time_shift']['buffer_s'].get('mean'))} / {fmt(s['time_shift']['buffer_s'].get('p50'))} |",
         f"| played bitrate kbps (time-weighted) | {fmt(s['bitrate'].get('time_weighted_mean_kbps'))} |",
         f"| relay cache total max bytes / evictions | {s['cache']['total_max_bytes']} / {s['cache']['evictions']} |",
         ]
    for name, p in s["process"].items():
        L.append(f"| {name} max RSS MB / mean CPU % | {p['max_rss_bytes'] / 1e6:.1f} / {p['mean_cpu_pct']:.1f} |")
    if s["detection"]:
        L += ["", "## Detection timelines (ms after the capacity change)", "",
              "| change | t1 sample | t2 decision (rule) | t3 sent | t4 first obj | t5 first frame | quality rec. | offset rec. |",
              "|---|---|---|---|---|---|---|---|"]
        for d in s["detection"]:
            L.append(f"| {d['from_mbps']}->{d['to_mbps']} Mbps | {fmt(d['t1_ms'])} | {fmt(d['t2_ms'])} ({d['t2_rule']}) | "
                     f"{fmt(d['t3_ms'])} | {fmt(d['t4_ms'])} | {fmt(d['t5_ms'])} | "
                     f"{fmt(d.get('quality_recovery_ms'))} | {fmt(d.get('offset_recovery_ms'))} |")
    if s["switches"]["list"]:
        L += ["", "## Switches", "", "| t (s) | from -> to | reason | relay recv | promoted (start grp) | t4 | applied | playhead gap | t5 |",
              "|---|---|---|---|---|---|---|---|---|"]
        t0 = s["switches"]["list"][0]["ts"]
        for sw in s["switches"]["list"]:
            L.append(f"| {(sw['ts'] - t0) / 1000:.1f} | {sw['from']} -> {sw['to']} | {sw['reason']} | {fmt(sw['relay_recv_ms'])} | "
                     f"{fmt(sw['relay_promoted_ms'])} ({sw['relay_start_group']}) | {fmt(sw['t4_first_object_ms'])} | "
                     f"{fmt(sw['applied_ms'])} | {fmt(sw['playhead_gap_ms'])} | {fmt(sw['t5_first_frame_ms'])} |")
    return "\n".join(L) + "\n"


AGG_COLUMNS = ["run_id", "mechanism", "client_mode", "filter_delay_s", "profile", "bg_flows", "startup_delay_ms",
               "stall_count", "stall_total_ms", "switch_count", "switch_up", "switch_down", "t4_mean_ms", "t5_mean_ms",
               "playhead_gap_mean_ms", "abs_playhead_gap_p95_ms", "shift_err_mean_ms", "shift_abs_err_p95_ms",
               "live_edge_mean_ms", "buffer_mean_s", "bitrate_kbps", "cache_max_bytes", "relay_max_rss_mb"]


def agg_row(s: dict) -> dict:
    return {
        "run_id": s["run_id"], "mechanism": s["mechanism"], "client_mode": s["client_mode"],
        "filter_delay_s": s["filter_delay_s"], "profile": s["profile"], "bg_flows": s["bg_flows"],
        "startup_delay_ms": s["startup"]["startup_delay_ms"], "stall_count": s["stalls"]["count"],
        "stall_total_ms": s["stalls"]["total_ms"], "switch_count": s["switches"]["count"],
        "switch_up": s["switches"]["up"], "switch_down": s["switches"]["down"],
        "t4_mean_ms": s["switches"]["t4_first_object_ms"].get("mean"),
        "t5_mean_ms": s["switches"]["t5_first_frame_ms"].get("mean"),
        "playhead_gap_mean_ms": s["switches"]["playhead_gap_ms"].get("mean"),
        "abs_playhead_gap_p95_ms": s["switches"]["abs_playhead_gap_ms"].get("p95"),
        "shift_err_mean_ms": s["time_shift"]["signed_error_ms"].get("mean"),
        "shift_abs_err_p95_ms": s["time_shift"]["abs_error_ms"].get("p95"),
        "live_edge_mean_ms": s["time_shift"]["live_edge_distance_ms"].get("mean"),
        "buffer_mean_s": s["time_shift"]["buffer_s"].get("mean"),
        "bitrate_kbps": s["bitrate"].get("time_weighted_mean_kbps"),
        "cache_max_bytes": s["cache"]["total_max_bytes"],
        "relay_max_rss_mb": (s["process"].get("relay", {}).get("max_rss_bytes") or 0) / 1e6 or None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--csv", type=Path, default=None, help="aggregate CSV across runs")
    ap.add_argument("--t1-tolerance", type=float, default=0.25, help="fraction of the new rate for t1")
    ap.add_argument("--offset-tolerance", type=float, default=500.0, help="ms for offset recovery")
    ap.add_argument("--offset-hold", type=float, default=5.0, help="seconds within tolerance for offset recovery")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    rows = []
    for run in args.runs:
        if not run.is_dir():
            continue
        s = analyze(run, args.t1_tolerance, args.offset_tolerance, args.offset_hold)
        (run / "summary.json").write_text(json.dumps(s, indent=2, default=str))
        md = to_markdown(s)
        (run / "summary.md").write_text(md)
        if not args.quiet:
            print(md)
        rows.append(agg_row(s))
    if args.csv and rows:
        with args.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=AGG_COLUMNS)
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
