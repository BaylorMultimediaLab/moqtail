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
import re
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


def last_session(recs: list[dict]) -> tuple[list[dict], int]:
    """Keep only the client records of the last page session (reloads restart
    request ids, so sessions must not be mixed). Returns (records, sessions)."""
    sessions = sorted({r.get("session") for r in recs if r.get("src") == "client" and r.get("session") is not None})
    if len(sessions) <= 1:
        return recs, len(sessions)
    last = sessions[-1]
    return [r for r in recs if r.get("src") != "client" or r.get("session") == last], len(sessions)


def wall_clock_gaps(recs: list[dict], event: str = "SAMPLE", threshold_ms: float = 5000.0) -> list[float]:
    ts = [r["ts"] for r in recs if r.get("event") == event]
    return [b - a for a, b in zip(ts, ts[1:]) if b - a > threshold_ms]


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


def track_matches(relay_track, client_track) -> bool:
    """Relay records name tracks as namespace/name; the client uses the bare name."""
    if client_track is None:
        return True
    if relay_track is None:
        return False
    s = str(relay_track).replace(".2d", "-")
    return s == client_track or s.endswith("/" + client_track) or s.endswith("--" + client_track)


def first(recs: list[dict], event: str, after: float = -1, pred=None) -> dict | None:
    for r in recs:
        if r.get("event") == event and r.get("ts", 0) >= after and (pred is None or pred(r)):
            return r
    return None


RULE_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z \-]*?(?=\s*[\d≥>=<(]|$)")


def rule_name(rule_reason) -> str:
    """'latency trend 156% > 120%' -> 'latency trend'; 'throughput' -> 'throughput'."""
    if not rule_reason:
        return "unknown"
    m = RULE_NAME_RE.match(str(rule_reason))
    return (m.group(0) if m else str(rule_reason)).strip().lower() or "unknown"


def switching_diagnostics(switches: list[dict], by, window_s: float) -> dict:
    """Behavioural diagnostics of the switch sequence itself. A run with
    A->B->A->B is different from four monotonic adaptations even at equal
    counts and equal mean bitrate."""
    ts = [s["ts"] for s in switches]
    intervals = [b - a for a, b in zip(ts, ts[1:])]
    span_s = (ts[-1] - ts[0]) / 1000 if len(ts) >= 2 else 0.0
    reversals, aba = 0, 0
    for i in range(1, len(switches)):
        a, b = switches[i - 1], switches[i]
        if {a["direction"], b["direction"]} == {"up", "down"} and b["ts"] - a["ts"] <= window_s * 1000:
            reversals += 1
            if a["from"] == b["to"]:
                aba += 1
    by_rule: dict[str, int] = {}
    for s in switches:
        k = rule_name(s.get("rule_reason"))
        by_rule[k] = by_rule.get(k, 0) + 1
    return {
        "reversal_window_s": window_s,
        "switches_per_minute": (len(switches) / span_s * 60) if span_s > 0 else None,
        "inter_switch_interval_ms": stats(intervals),
        "median_inter_switch_interval_ms": statistics.median(intervals) if intervals else None,
        "min_inter_switch_interval_ms": min(intervals) if intervals else None,
        "direction_reversals": reversals,
        "aba_reversals": aba,
        "cooldown_activations": len(by("ABR_GUARD_TIMEOUT")),
        "slow_start_vetoes": len(by("ABR_GATED")),
        "switches_by_rule": by_rule,
    }


def feedback_windows(switches: list[dict], by, window_s: float) -> dict:
    """Per switch, align a +-window of throughput, latency, latency-trend and
    rule votes with the next switch, to test the self-induced feedback
    hypothesis (switch -> catch-up burst -> latency trend rises -> next switch)."""
    w = window_s * 1000
    tput = by("THROUGHPUT_SAMPLE")
    samples = by("SAMPLE")
    ticks = by("ABR_TICK")
    per = []
    for i, s in enumerate(switches):
        t = s["ts"]
        pre_t = [r.get("bps") for r in tput if t - w <= r["ts"] < t]
        post_t = [r.get("bps") for r in tput if t <= r["ts"] < t + w]
        pre_l = [r.get("last_latency_ms") for r in samples if t - w <= r["ts"] < t and r.get("last_latency_ms")]
        post_l = [r.get("last_latency_ms") for r in samples if t <= r["ts"] < t + w and r.get("last_latency_ms")]
        post_ticks = [r for r in ticks if t <= r["ts"] < t + w]
        trend = [r.get("latency_trend") for r in post_ticks if r.get("latency_trend") is not None]
        votes: dict[str, int] = {}
        for r in post_ticks:
            for name, v in (r.get("rules") or {}).items():
                if v is not None and v.get("index") != r.get("active_index"):
                    votes[name] = votes.get(name, 0) + 1
        nxt = switches[i + 1] if i + 1 < len(switches) else None
        per.append({
            "ts": t, "from": s["from"], "to": s["to"], "direction": s["direction"], "rule": rule_name(s.get("rule_reason")),
            "pre_throughput_bps": stats(pre_t), "post_throughput_bps": stats(post_t),
            "pre_latency_ms": stats(pre_l), "post_latency_ms": stats(post_l),
            "post_latency_trend_peak": max(trend) if trend else None,
            "post_votes_for_change": votes,
            "next_switch_after_ms": (nxt["ts"] - t) if nxt else None,
            "next_switch_rule": rule_name(nxt.get("rule_reason")) if nxt else None,
            "next_switch_within_window": bool(nxt and nxt["ts"] - t <= w),
        })
    followed = [p for p in per if p["next_switch_within_window"]]
    return {
        "window_s": window_s,
        "per_switch": per,
        "summary": {
            "switches": len(per),
            "followed_within_window": len(followed),
            "followed_within_window_by_latency_trend": sum(1 for p in followed if p["next_switch_rule"] == "latency trend"),
            "post_latency_trend_peak": stats([p["post_latency_trend_peak"] for p in per]),
            "post_latency_peak_ms": stats([p["post_latency_ms"].get("max") for p in per if p["post_latency_ms"].get("n")]),
            "pre_latency_mean_ms": stats([p["pre_latency_ms"].get("mean") for p in per if p["pre_latency_ms"].get("n")]),
        },
    }


def analyze(run: Path, t1_tol: float = 0.25, offset_tol_ms: float = 500.0, offset_hold_s: float = 5.0,
            initial_window_s: float = 5.0, reversal_window_s: float = 5.0, feedback_window_s: float = 5.0) -> dict:
    recs, sessions = last_session(load(run))
    by = lambda ev: [r for r in recs if r.get("event") == ev]  # noqa: E731
    meta = json.loads((run / "run_meta.json").read_text()) if (run / "run_meta.json").exists() else {}
    client_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "client") or {}
    pub_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "publisher") or {}
    ladder = sorted(client_meta.get("ladder", []), key=lambda t: t.get("bitrate") or 0)
    index_of = {t["track"]: i for i, t in enumerate(ladder)}
    bitrate_of = {t["track"]: (t.get("bitrate") or 0) for t in ladder}

    identity = meta.get("identity") or {}
    out: dict = {
        "run_id": meta.get("run_id", run.name),
        "identity": identity,
        "mechanism": identity.get("mechanism") or meta.get("args", {}).get("mechanism"),
        "mechanism_mode": identity.get("mechanism_mode"),
        "repeat_index": identity.get("repeat_index"),
        "client_mode": client_meta.get("client_mode"),
        "time_shift_s": client_meta.get("time_shift_s"),
        "delay_groups": client_meta.get("delay_groups"),
        "target_shift_ms": client_meta.get("target_shift_ms"),
        "profile": meta.get("profile", {}).get("name"),
        "bg_flows": meta.get("args", {}).get("bg_flows"),
        "gops_per_variant": pub_meta.get("gops_per_variant"),
        "events": len(recs),
        "client_sessions": sessions,
        "wall_clock_gaps_ms": wall_clock_gaps(recs),
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
    # A stall still open when the run ended is a stall to the end of the run.
    if open_start is not None:
        last_ts = max((r["ts"] for r in recs if r.get("src") == "client"), default=open_start["ts"])
        episodes.append({"ts": open_start["ts"], "cause": open_start.get("cause"), "duration_ms": last_ts - open_start["ts"],
                         "playhead_ms": open_start.get("playhead_ms"), "open_at_end": True})
    durations = [e["duration_ms"] for e in episodes if e["duration_ms"] is not None]
    seeks = by("SEEK")
    out["stalls"] = {
        "count": len(episodes), "total_ms": sum(durations), "max_ms": max(durations) if durations else 0,
        "episodes": episodes,
        "seeks": {reason: sum(1 for s in seeks if s.get("reason") == reason)
                  for reason in ("startup", "wedge", "range-jump", "visibility", "unwedge")},
        "open_at_end": any(e.get("open_at_end") for e in episodes),
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
        # The client's SWITCH_OK/ERROR for this switch is the first one for the same
        # target after it was sent (request ids differ between mechanisms: native
        # allocates one up front, PR #1378 adopts the relay's afterwards).
        ok = first(recs, "SWITCH_OK", sent["ts"], lambda r: r.get("to") == sent.get("to"))
        err = first(recs, "SWITCH_ERROR", sent["ts"], lambda r: r.get("to") == sent.get("to"))
        # The relay's SWITCH_RECV names the subscription being replaced (old_request_id)
        # on every mechanism; the new id may be absent (null) on PR #1378.
        old_rid = sent.get("old_request_id")
        rrecv = next((r for r in switch_recv if r["ts"] >= sent["ts"] - 100
                      and ((rid is not None and r.get("request_id") == rid)
                           or (old_rid is not None and r.get("old_request_id") == old_rid))), None)
        rprom = first(promoted, "SWITCH_PROMOTED", rrecv["ts"] if rrecv else sent["ts"],
                      lambda r: track_matches(r.get("track"), sent.get("to"))) if rrecv else None
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
            # t4: first object of the target arrives at the client.
            "switch_delivery_latency_ms": d(fobj), "t4_group": fobj.get("group") if fobj else None,
            "applied_ms": d(applied),
            # Buffer continuity at the seam (first target PTS - last source end PTS).
            "media_seam_gap_ms": applied.get("media_seam_gap_ms") if applied else None,
            # Media the viewer still plays before reaching the seam (first target PTS - playhead at send).
            "seam_ahead_of_playhead_ms": applied.get("seam_ahead_of_playhead_ms") if applied else None,
            # t5: first presented frame of the new representation (presented mediaTime crossed the seam).
            "switch_visibility_delay_ms": d(fframe),
            # Presented-mediaTime discontinuity at the seam beyond one frame (0 = played through).
            "playback_position_jump_ms": fframe.get("playback_position_jump_ms") if fframe else None,
            # Wall-clock pause at the seam beyond one frame period.
            "viewer_pause_ms": fframe.get("viewer_pause_ms") if fframe else None,
            # Hole in the element's buffered ranges at the seam (what a range-jump seek crosses).
            "seam_buffer_hole_ms": fframe.get("seam_buffer_hole_ms") if fframe else None,
            # Whether the target began on object 0 of its group (its keyframe).
            "landed_on_group_start": applied.get("landed_on_group_start") if applied else None,
            # Source-track objects that arrived after the target landed and were discarded
            # (the relay kept delivering the source's in-progress group).
            "seam_dropped_source_frames": sum(
                1 for r in by("DROP_STALE")
                if applied and applied["ts"] <= r["ts"] < applied["ts"] + 3000 and r.get("track") == sent.get("from")),
            "playhead_ms": sent.get("playhead_ms"), "playhead_group": sent.get("playhead_group"),
            "last_received_group": sent.get("last_received_group"),
        })
    # A switch whose seam the viewer never reached because a later switch landed
    # first has no first-frame record; mark it rather than leave t5 blank.
    for i, sw in enumerate(switches):
        nxt = switches[i + 1] if i + 1 < len(switches) else None
        sw["superseded"] = bool(sw["switch_visibility_delay_ms"] is None and nxt is not None and nxt["applied_ms"] is not None)
    out["switches"] = {
        "count": len(switches),
        "superseded": sum(1 for s in switches if s["superseded"]),
        "up": sum(1 for s in switches if s["direction"] == "up"),
        "down": sum(1 for s in switches if s["direction"] == "down"),
        "failed": sum(1 for s in switches if s["error"]),
        "switch_delivery_latency_ms": stats([s["switch_delivery_latency_ms"] for s in switches]),
        "switch_visibility_delay_ms": stats([s["switch_visibility_delay_ms"] for s in switches]),
        "media_seam_gap_ms": stats([s["media_seam_gap_ms"] for s in switches]),
        "seam_ahead_of_playhead_ms": stats([s["seam_ahead_of_playhead_ms"] for s in switches]),
        "abs_seam_ahead_of_playhead_ms": stats([abs(s["seam_ahead_of_playhead_ms"]) for s in switches
                                                if s["seam_ahead_of_playhead_ms"] is not None]),
        "playback_position_jump_ms": stats([s["playback_position_jump_ms"] for s in switches]),
        "abs_playback_position_jump_ms": stats([abs(s["playback_position_jump_ms"]) for s in switches
                                                if s["playback_position_jump_ms"] is not None]),
        "viewer_pause_ms": stats([s["viewer_pause_ms"] for s in switches]),
        "seam_buffer_hole_ms": stats([s["seam_buffer_hole_ms"] for s in switches]),
        "seam_dropped_source_frames": stats([s["seam_dropped_source_frames"] for s in switches]),
        "landed_on_group_start": sum(1 for s in switches if s["landed_on_group_start"]),
        "list": switches,
        "guard_timeouts": len(by("ABR_GUARD_TIMEOUT")),
        "gated_slow_start": len(by("ABR_GATED")),
    }
    out["switching"] = switching_diagnostics(switches, by, reversal_window_s)
    out["feedback"] = feedback_windows(switches, by, feedback_window_s)
    out["switches"]["skipped_not_landed"] = len(by("SWITCH_SKIPPED"))
    out["switches"]["session_destroyed"] = any("destroyed" in str(r.get("reason")) for r in by("SWITCH_ERROR"))

    # Samples: time shift, live edge, bitrate --------------------------------
    samples = [s for s in by("SAMPLE") if st is None or s["ts"] >= st["ts"]]
    tse = [s.get("time_shift_error_ms") for s in samples if s.get("time_shift_error_ms") is not None]
    led = [s.get("live_edge_distance_ms") for s in samples if s.get("live_edge_distance_ms") is not None]
    win_start = st["ts"] if st else None
    win_end = (st["ts"] + initial_window_s * 1000) if st else None
    initial = [s.get("live_edge_distance_ms") for s in samples
               if win_end is not None and s["ts"] < win_end and s.get("live_edge_distance_ms") is not None]
    out["time_shift"] = {
        "signed_error_ms": stats(tse), "abs_error_ms": stats([abs(v) for v in tse]),
        "live_edge_distance_ms": stats(led),
        # The shift the relay actually delivered, measured before any playback
        # drift: the first `initial_window_s` seconds after the first presented
        # frame (a switch inside the window does not move the playhead).
        # Shift erosion: first sample after the initial window at which the client
        # sits closer than half its target to the live edge (None = never).
        "time_to_half_shift_ms": next(
            (s["ts"] - st["ts"] for s in samples
             if st and win_end is not None and s["ts"] >= win_end
             and s.get("live_edge_distance_ms") is not None
             and (client_meta.get("target_shift_ms") or 0) > 0
             and s["live_edge_distance_ms"] < (client_meta.get("target_shift_ms") or 0) / 2), None),
        "initial_window": {
            "definition": f"first {initial_window_s:g} s after the first presented frame",
            "start_ms": win_start, "end_ms": win_end,
            "live_edge_distance_ms": stats(initial),
            "target_shift_ms": client_meta.get("target_shift_ms"),
        },
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
               "t4_ms": (sw["ts"] + sw["switch_delivery_latency_ms"] - t0) if sw and sw["switch_delivery_latency_ms"] else None,
               "t5_ms": (sw["ts"] + sw["switch_visibility_delay_ms"] - t0) if sw and sw["switch_visibility_delay_ms"] else None}
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
    # Detection timelines only mean something when the controller is otherwise
    # quiet: with a switch every second the "first decision after the change"
    # is just the next oscillation.
    med_gap = out["switching"]["median_inter_switch_interval_ms"]
    out["detection_reliable"] = med_gap is None or med_gap >= feedback_window_s * 1000
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
    # Playback progress: fraction of sample intervals in which the playhead
    # advanced, and the longest stretch without progress.
    prog_ok, prog_n, longest, run_start = 0, 0, 0.0, None
    for a, b in zip(samples, samples[1:]):
        prog_n += 1
        if b.get("playhead_ms", 0) > a.get("playhead_ms", 0) + 1:
            prog_ok += 1
            run_start = None
        else:
            run_start = run_start if run_start is not None else a["ts"]
            longest = max(longest, b["ts"] - run_start)
    out["playback"] = {
        "advancing_fraction": (prog_ok / prog_n) if prog_n else None,
        "longest_no_progress_ms": longest,
        "presented_frames": samples[-1].get("total_frames") if samples else None,
    }
    out["client_errors"] = [r.get("message") for r in by("ERROR")]
    return out


def read_validity(run: Path) -> dict:
    """validation.json is written by validate.py (the runner calls it after every
    run). No file = not validated: kept, but flagged."""
    p = run / "validation.json"
    if not p.exists():
        return {"valid": None, "reasons": ["not validated"]}
    v = json.loads(p.read_text())
    return {"valid": bool(v.get("passed")), "reasons": v.get("failed", []), "final": v.get("final")}


def write_switch_windows(run: Path, s: dict) -> None:
    per = s["feedback"]["per_switch"]
    if not per:
        return
    cols = ["ts", "from", "to", "direction", "rule", "pre_throughput_mean_bps", "post_throughput_mean_bps",
            "pre_latency_mean_ms", "post_latency_max_ms", "post_latency_trend_peak", "post_votes_for_change",
            "next_switch_after_ms", "next_switch_rule", "next_switch_within_window"]
    with (run / "switch_windows.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for p in per:
            w.writerow([p["ts"], p["from"], p["to"], p["direction"], p["rule"],
                        p["pre_throughput_bps"].get("mean"), p["post_throughput_bps"].get("mean"),
                        p["pre_latency_ms"].get("mean"), p["post_latency_ms"].get("max"),
                        p["post_latency_trend_peak"], json.dumps(p["post_votes_for_change"]),
                        p["next_switch_after_ms"], p["next_switch_rule"], p["next_switch_within_window"]])


def fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def to_markdown(s: dict) -> str:
    L = [f"# {s['run_id']}", "",
         f"mechanism={s['mechanism']} client={s['client_mode']} shift={s['time_shift_s']}s "
         f"(delay_groups={s['delay_groups']}, target={s['target_shift_ms']} ms) profile={s['profile']} bg={s['bg_flows']}", "",
         "| metric | value |", "|---|---|",
         f"| startup delay (ms) | {fmt(s['startup']['startup_delay_ms'])} |",
         f"| first group / expected / clamped | {s['startup']['first_group']} / {s['startup']['expected_start_group']} / {s['startup']['clamped_by_relay']} |",
         f"| stalls (count / total ms / max ms) | {s['stalls']['count']} / {fmt(s['stalls']['total_ms'])} / {fmt(s['stalls']['max_ms'])} |",
         f"| seeks wedge / range-jump | {s['stalls']['seeks']['wedge']} / {s['stalls']['seeks']['range-jump']} |",
         f"| switches (up / down / failed) | {s['switches']['count']} ({s['switches']['up']} / {s['switches']['down']} / {s['switches']['failed']}) |",
         f"| switch delivery latency ms, t4 (median / p95) | {fmt(s['switches']['switch_delivery_latency_ms'].get('p50'))} / {fmt(s['switches']['switch_delivery_latency_ms'].get('p95'))} |",
         f"| switch visibility delay ms, t5 (median / p95) | {fmt(s['switches']['switch_visibility_delay_ms'].get('p50'))} / {fmt(s['switches']['switch_visibility_delay_ms'].get('p95'))} |",
         f"| media seam gap ms (median / abs max) | {fmt(s['switches']['media_seam_gap_ms'].get('p50'))} / {fmt(s['switches']['media_seam_gap_ms'].get('max'))} |",
         f"| seam ahead of playhead ms (median / p95) | {fmt(s['switches']['seam_ahead_of_playhead_ms'].get('p50'))} / {fmt(s['switches']['abs_seam_ahead_of_playhead_ms'].get('p95'))} |",
         f"| playback position jump ms (median / abs p95) | {fmt(s['switches']['playback_position_jump_ms'].get('p50'))} / {fmt(s['switches']['abs_playback_position_jump_ms'].get('p95'))} |",
         f"| viewer pause at seam ms (median / p95) | {fmt(s['switches']['viewer_pause_ms'].get('p50'))} / {fmt(s['switches']['viewer_pause_ms'].get('p95'))} |",
         f"| seam buffer hole ms (median / max) | {fmt(s['switches']['seam_buffer_hole_ms'].get('p50'))} / {fmt(s['switches']['seam_buffer_hole_ms'].get('max'))} |",
         f"| switches superseded before visible; skipped (previous not landed) | {s['switches']['superseded']} of {s['switches']['count']}; {s['switches']['skipped_not_landed']} |",
         f"| playback advancing fraction / longest no-progress s | {fmt(s['playback']['advancing_fraction'] and s['playback']['advancing_fraction'] * 100)} % / {fmt((s['playback']['longest_no_progress_ms'] or 0) / 1000)} |",
         f"| time to half shift (s) | {fmt((s['time_shift']['time_to_half_shift_ms'] or 0) / 1000) if s['time_shift']['time_to_half_shift_ms'] else '-'} |",
         f"| detection timelines reliable | {s['detection_reliable']} (median inter-switch {fmt(s['switching']['median_inter_switch_interval_ms'])} ms) |",
         f"| seam dropped source frames (median / max); landed on keyframe | {fmt(s['switches']['seam_dropped_source_frames'].get('p50'))} / {fmt(s['switches']['seam_dropped_source_frames'].get('max'))}; {s['switches']['landed_on_group_start']} of {s['switches']['count']} |",
         f"| switches/min; reversals (A->B->A) | {fmt(s['switching']['switches_per_minute'])}; {s['switching']['direction_reversals']} ({s['switching']['aba_reversals']}) |",
         f"| inter-switch interval ms (median / min) | {fmt(s['switching']['median_inter_switch_interval_ms'])} / {fmt(s['switching']['min_inter_switch_interval_ms'])} |",
         f"| switches by rule | {s['switching']['switches_by_rule']} |",
         f"| switches followed within {s['feedback']['window_s']:g} s (by latency trend) | {s['feedback']['summary']['followed_within_window']} ({s['feedback']['summary']['followed_within_window_by_latency_trend']}) of {s['feedback']['summary']['switches']} |",
         f"| initial-window live-edge distance ms (mean, n) | {fmt(s['time_shift']['initial_window']['live_edge_distance_ms'].get('mean'))} (n={s['time_shift']['initial_window']['live_edge_distance_ms'].get('n')}), target {s['time_shift']['initial_window']['target_shift_ms']} |",
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
        L += ["", "## Switches", "", "| t (s) | from -> to | rule | relay recv | promoted (start grp) | t4 delivery | landed obj0 | seam ahead | t5 visible | hole | jump | dropped src frames |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        t0 = s["switches"]["list"][0]["ts"]
        for sw in s["switches"]["list"]:
            L.append(f"| {(sw['ts'] - t0) / 1000:.1f} | {sw['from']} -> {sw['to']} | {rule_name(sw['rule_reason'])} | {fmt(sw['relay_recv_ms'])} | "
                     f"{fmt(sw['relay_promoted_ms'])} ({sw['relay_start_group']}) | {fmt(sw['switch_delivery_latency_ms'])} | "
                     f"{sw['landed_on_group_start']} | {fmt(sw['seam_ahead_of_playhead_ms'])} | {fmt(sw['switch_visibility_delay_ms'])} | "
                     f"{fmt(sw['seam_buffer_hole_ms'])} | {fmt(sw['playback_position_jump_ms'])} | {sw['seam_dropped_source_frames']} |")
    return "\n".join(L) + "\n"


IDENTITY_COLUMNS = ["run_id", "git_sha", "branch", "mechanism", "mechanism_mode", "client_type", "delay_groups",
                    "gop_duration_ms", "ladder_id", "network_profile", "trace_id", "qdisc", "background_flows",
                    "repeat_index", "timestamp_start"]
METRIC_COLUMNS = ["startup_delay_ms", "stall_count", "stall_total_ms", "switch_count", "switch_up", "switch_down",
                  "switches_per_minute", "direction_reversals", "aba_reversals", "median_inter_switch_ms",
                  "cooldown_activations", "switch_delivery_latency_p50_ms", "switch_visibility_delay_p50_ms",
                  "media_seam_gap_p50_ms", "seam_ahead_p50_ms", "seam_buffer_hole_p50_ms", "seam_dropped_frames_p50",
                  "landed_on_group_start", "superseded", "abs_playback_jump_p95_ms", "viewer_pause_p95_ms",
                  "followed_within_window", "followed_by_latency_trend", "initial_live_edge_mean_ms",
                  "time_to_half_shift_ms", "advancing_fraction", "longest_no_progress_ms", "session_destroyed",
                  "detection_reliable",
                  "shift_err_mean_ms", "shift_abs_err_p95_ms", "live_edge_mean_ms", "buffer_mean_s", "bitrate_kbps",
                  "cache_max_bytes", "relay_max_rss_mb"]
AGG_COLUMNS = IDENTITY_COLUMNS + METRIC_COLUMNS


def agg_row(s: dict) -> dict:
    """One aggregate row per run: the identity block plus the headline metrics."""
    ident = dict(s.get("identity") or {})
    # Runs recorded before the identity block existed: rebuild what we can.
    ident.setdefault("run_id", s["run_id"])
    ident.setdefault("mechanism", s["mechanism"])
    ident.setdefault("client_type", s["client_mode"])
    ident.setdefault("delay_groups", s["delay_groups"])
    ident.setdefault("network_profile", s["profile"])
    ident.setdefault("background_flows", s["bg_flows"])
    row = {k: ident.get(k) for k in IDENTITY_COLUMNS}
    row.update({
        "startup_delay_ms": s["startup"]["startup_delay_ms"], "stall_count": s["stalls"]["count"],
        "stall_total_ms": s["stalls"]["total_ms"], "switch_count": s["switches"]["count"],
        "switch_up": s["switches"]["up"], "switch_down": s["switches"]["down"],
        "switches_per_minute": s["switching"]["switches_per_minute"],
        "direction_reversals": s["switching"]["direction_reversals"],
        "aba_reversals": s["switching"]["aba_reversals"],
        "median_inter_switch_ms": s["switching"]["median_inter_switch_interval_ms"],
        "cooldown_activations": s["switching"]["cooldown_activations"],
        "switch_delivery_latency_p50_ms": s["switches"]["switch_delivery_latency_ms"].get("p50"),
        "switch_visibility_delay_p50_ms": s["switches"]["switch_visibility_delay_ms"].get("p50"),
        "media_seam_gap_p50_ms": s["switches"]["media_seam_gap_ms"].get("p50"),
        "seam_ahead_p50_ms": s["switches"]["seam_ahead_of_playhead_ms"].get("p50"),
        "seam_buffer_hole_p50_ms": s["switches"]["seam_buffer_hole_ms"].get("p50"),
        "seam_dropped_frames_p50": s["switches"]["seam_dropped_source_frames"].get("p50"),
        "landed_on_group_start": s["switches"]["landed_on_group_start"],
        "superseded": s["switches"]["superseded"],
        "abs_playback_jump_p95_ms": s["switches"]["abs_playback_position_jump_ms"].get("p95"),
        "viewer_pause_p95_ms": s["switches"]["viewer_pause_ms"].get("p95"),
        "followed_within_window": s["feedback"]["summary"]["followed_within_window"],
        "followed_by_latency_trend": s["feedback"]["summary"]["followed_within_window_by_latency_trend"],
        "initial_live_edge_mean_ms": s["time_shift"]["initial_window"]["live_edge_distance_ms"].get("mean"),
        "time_to_half_shift_ms": s["time_shift"]["time_to_half_shift_ms"],
        "advancing_fraction": s["playback"]["advancing_fraction"],
        "longest_no_progress_ms": s["playback"]["longest_no_progress_ms"],
        "session_destroyed": s["switches"]["session_destroyed"],
        "detection_reliable": s["detection_reliable"],
        "shift_err_mean_ms": s["time_shift"]["signed_error_ms"].get("mean"),
        "shift_abs_err_p95_ms": s["time_shift"]["abs_error_ms"].get("p95"),
        "live_edge_mean_ms": s["time_shift"]["live_edge_distance_ms"].get("mean"),
        "buffer_mean_s": s["time_shift"]["buffer_s"].get("mean"),
        "bitrate_kbps": s["bitrate"].get("time_weighted_mean_kbps"),
        "cache_max_bytes": s["cache"]["total_max_bytes"],
        "relay_max_rss_mb": (s["process"].get("relay", {}).get("max_rss_bytes") or 0) / 1e6 or None,
    })
    return row


CONDITION_KEYS = ["mechanism", "mechanism_mode", "client_type", "delay_groups", "network_profile", "qdisc",
                  "background_flows", "ladder_id"]


def bootstrap_ci(values: list[float], iterations: int = 2000, seed: int = 1) -> tuple[float, float] | None:
    """95 % percentile-bootstrap confidence interval of the median."""
    import random
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return None
    rng = random.Random(seed)
    meds = sorted(statistics.median([rng.choice(vals) for _ in vals]) for _ in range(iterations))
    return meds[int(0.025 * (iterations - 1))], meds[int(0.975 * (iterations - 1))]


def condition_stats(rows: list[dict]) -> list[dict]:
    """Per condition (every identity key except repeat_index and the timestamps): n,
    median, IQR and a bootstrap 95 % CI of the median for each metric column."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(r.get(k) for k in CONDITION_KEYS), []).append(r)
    out = []
    for key, members in sorted(groups.items(), key=lambda kv: str(kv[0])):
        rec: dict = dict(zip(CONDITION_KEYS, key))
        rec["n"] = len(members)
        for m in METRIC_COLUMNS:
            vals = [r[m] for r in members if r.get(m) is not None]
            if not vals:
                continue
            rec[f"{m}_median"] = statistics.median(vals)
            rec[f"{m}_q1"] = pct(vals, 0.25)
            rec[f"{m}_q3"] = pct(vals, 0.75)
            ci = bootstrap_ci(vals)
            rec[f"{m}_ci95_lo"], rec[f"{m}_ci95_hi"] = ci if ci else (None, None)
        out.append(rec)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", nargs="+", type=Path)
    ap.add_argument("--csv", type=Path, default=None, help="aggregate CSV across runs (one row per run)")
    ap.add_argument("--stats", type=Path, default=None,
                    help="per-condition CSV: n, median, IQR, bootstrap 95%% CI of the median for each metric")
    ap.add_argument("--t1-tolerance", type=float, default=0.25, help="fraction of the new rate for t1")
    ap.add_argument("--offset-tolerance", type=float, default=500.0, help="ms for offset recovery")
    ap.add_argument("--offset-hold", type=float, default=5.0, help="seconds within tolerance for offset recovery")
    ap.add_argument("--initial-window", type=float, default=5.0, help="seconds after the first frame for the initial-shift window")
    ap.add_argument("--reversal-window", type=float, default=5.0, help="seconds within which opposite switches count as a reversal")
    ap.add_argument("--feedback-window", type=float, default=5.0, help="seconds around each switch for the feedback analysis")
    ap.add_argument("--include-invalid", action="store_true",
                    help="keep runs whose validation.json says invalid in the aggregate CSV/stats (default: exclude)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    rows = []
    excluded = []
    for run in args.runs:
        if not run.is_dir():
            continue
        s = analyze(run, args.t1_tolerance, args.offset_tolerance, args.offset_hold,
                    args.initial_window, args.reversal_window, args.feedback_window)
        s["validity"] = read_validity(run)
        (run / "summary.json").write_text(json.dumps(s, indent=2, default=str))
        md = to_markdown(s)
        (run / "summary.md").write_text(md)
        write_switch_windows(run, s)
        if not args.quiet:
            print(md)
        if s["validity"]["valid"] is False and not args.include_invalid:
            excluded.append((run.name, s["validity"]["reasons"]))
            continue
        rows.append(agg_row(s))
    for name, reasons in excluded:
        print(f"excluded invalid run {name}: {reasons}")
    if args.csv and rows:
        with args.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=AGG_COLUMNS)
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {args.csv}")
    if args.stats and rows:
        conds = condition_stats(rows)
        cols: list[str] = []
        for c in conds:
            for k in c:
                if k not in cols:
                    cols.append(k)
        with args.stats.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(conds)
        print(f"wrote {args.stats} ({len(conds)} conditions)")
        for c in conds:
            print("  " + ", ".join(f"{k}={c.get(k)}" for k in CONDITION_KEYS if c.get(k) is not None) + f": n={c['n']}"
                  + "".join(f"  {m}={fmt(c.get(m + '_median'))} [{fmt(c.get(m + '_q1'))}..{fmt(c.get(m + '_q3'))}]"
                            for m in ("startup_delay_ms", "stall_count", "switch_count", "aba_reversals",
                                      "switch_visibility_delay_p50_ms", "shift_abs_err_p95_ms")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
