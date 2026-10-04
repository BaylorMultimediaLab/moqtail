#!/usr/bin/env python3
"""Summarise one or more experiment runs from their JSONL event logs.

    python3 experiments/analyze.py results/<run_id> [results/<run_id2> ...]
    python3 experiments/analyze.py results/*  --csv results/aggregate.csv

Per run it writes ``summary.json`` and ``summary.md`` next to the logs. With
several runs it also writes one aggregate CSV row per run.

Metric definitions are normative in docs/measurement-schema.md ("Metric
definitions"). In short, per run and over the last client session:

* switches               one entry per SWITCH_SENT, joined to its later records by
                         ``switch_seq`` (fallback for old bundles: last SWITCH_SENT
                         with ts <= record.ts and matching from AND to; every other
                         unresolved switch it overwrote is superseded). Every switch
                         ends in exactly one ``terminal``: first_frame, superseded,
                         error or open (run ended first); SWITCH_SKIPPED is an attempt
                         that was never sent, not a switch. Seam statistics
                         (visibility, viewer pause, hole, jump) are computed only
                         over switches with their own SWITCH_FIRST_FRAME.
* presented rung         time-weighted over SAMPLE intervals in which the playhead
                         advanced, using SAMPLE.presented_track when present and
                         otherwise the track visible between consecutive own first
                         frames. The subscribed rung (SAMPLE.track) is kept as a
                         diagnostic.
* shares                 fit_share_low: share of advancing time in
                         [t_drop + 5 s, t_restore) at a rung whose bitrate fits
                         0.9 x the low rate; pre_drop_share_after_restore: share of
                         advancing time in [t_restore + 5 s, end) at or above the
                         pre-drop rung (median presented rung, 20 s before the drop).
* reaction               down_reaction_ms / up_recovery_ms and the t1..t5
                         attribution are computed only when the presented rung at
                         the drop is above the fitting rung, and reported only from
                         the detect_step profile; otherwise null with
                         ``reaction_na_reason``.
* stalls                 STALL episodes >= 250 ms after the first frame; shorter
                         ones are ``blips``. Starvation = the stall time inside
                         DATA_STARVED episodes, a subset of stall time.
* media_skipped_ms       sum of to - from over gap seeks (``gap``; old reasons
                         ``range-jump`` / ``unwedge``) after the initial window.
* switches_per_minute    SWITCH_SENT count over ((RUN_END or last SAMPLE) - STARTUP).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from pathlib import Path

# Terminal states of a switch (one SWITCH_SENT). SWITCH_SKIPPED is not one: the player emits it
# instead of a SWITCH_SENT, with its own switch_seq (an attempt; switches.skipped_not_sent).
TERMINALS = ("first_frame", "superseded", "error", "open")
STALL_MIN_EPISODE_MS = 250.0
FIT_SAFETY = 0.9
SHARE_SETTLE_S = 5.0
PRE_DROP_WINDOW_S = 20.0
# SEEK reasons: one gap-crossing policy. Old bundles used range-jump / unwedge for what is now `gap`.
SEEK_REASON_NORMAL = {"startup": "startup", "gap": "gap", "range-jump": "gap", "unwedge": "gap", "wedge": "wedge",
                      "visibility": "visibility"}
# Mechanisms whose relay emits SWITCH_PROMOTED for every switch (validate.py requires the stamp).
PROMOTING_MECHANISMS = {"native", "pr1378"}
DEFAULT_CONGESTION_CONTROLLER = "bbr"  # every run before the 2026-10 rebuild used BBR (relay hard-coded)


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


def censored_summary(values_s: list[float | None]) -> dict:
    """Summary of a right-censored metric over repetitions, values in seconds. ``None``
    means the event never happened in that run (censored at the run end), not "unknown":
    callers drop not-applicable runs before calling. Returns ``n`` (runs with the event),
    ``of`` (all runs), ``median_s`` (median over the runs with the event only:
    survivorship-biased, kept for reference) and ``median_censored_s`` (median with every
    censored run counted as +inf), which is the number to report next to ``n``/``of``."""
    n_all = len(values_s)
    events = [v for v in values_s if v is not None]
    if n_all == 0:
        return {"n": 0, "of": 0, "median_s": None, "median_censored_s": None}
    filled = sorted(events + [math.inf] * (n_all - len(events)))
    return {"n": len(events), "of": n_all, "median_s": statistics.median(events) if events else None,
            "median_censored_s": statistics.median(filled)}


def is_valid(validity: dict | None) -> bool:
    """The inclusion test for aggregates: only runs whose validation passed. A run with
    no validation.json (``valid`` None) or an aborted run (``failed: ["aborted"]``,
    written by the runner) is excluded."""
    return bool(validity) and validity.get("valid") is True


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


def seam_hole(fframe: dict | None, tol_ms: float = 100.0) -> float | None:
    """Buffer hole attributable to this seam. One rule, the player's: since 2026-10-02 the
    client reports ``seam_buffer_hole_ms`` as the hole behind the presented frame's range only
    when that range begins at the seam (else 0), and the raw hole as ``buffer_hole_behind_ms``;
    such records (``buffer_hole_behind_ms`` present; 2026-10 records also carry
    ``seam_behind_playhead``) are used as is. Older clients reported the raw hole as
    ``seam_buffer_hole_ms``; for them only, the fallback attributes it to the seam when the
    first presented frame lies more than ``tol_ms`` past the seam PTS (something at the seam
    was skipped), else 0. Applying that rule on top of the player's would zero exactly the
    holes the player attributes (the range begins at the seam, so the first presented frame
    is the seam frame)."""
    if not fframe:
        return None
    hole = fframe.get("seam_buffer_hole_ms")
    if hole is None:
        return None
    if seam_hole_rule(fframe) == "player":
        return hole
    seam, presented = fframe.get("seam_pts_ms"), fframe.get("presented_pts_ms")
    if seam is None or presented is None:
        return hole
    return hole if presented - seam > tol_ms else 0


def seam_hole_rule(fframe: dict | None) -> str | None:
    """``player`` (records with ``buffer_hole_behind_ms`` or ``seam_behind_playhead``: the client
    attributed the hole itself) or ``analyzer-100ms`` (older records)."""
    if not fframe:
        return None
    return "player" if ("buffer_hole_behind_ms" in fframe or "seam_behind_playhead" in fframe) else "analyzer-100ms"


def hole_behind(fframe: dict | None) -> float | None:
    """The raw hole behind the presented frame's range: the record's own
    ``buffer_hole_behind_ms``; old clients reported it as ``seam_buffer_hole_ms``."""
    if not fframe:
        return None
    if "buffer_hole_behind_ms" in fframe:
        return fframe["buffer_hole_behind_ms"]
    return fframe.get("seam_buffer_hole_ms")


def _clip_episodes(episodes: list[dict], end_ts: float | None) -> list[dict]:
    """Episodes ({ts, duration_ms}) clipped to ``end_ts`` (RUN_END): one starting at or after
    it is dropped, one spanning it ends there (``clipped_at_run_end``)."""
    if end_ts is None:
        return episodes
    out = []
    for e in episodes:
        if e["ts"] >= end_ts:
            continue
        if e.get("duration_ms") is not None and e["ts"] + e["duration_ms"] > end_ts:
            e = dict(e, duration_ms=end_ts - e["ts"], clipped_at_run_end=True)
        out.append(e)
    return out


def client_connection_id(recs: list[dict], ladder: list[dict]) -> tuple[int | None, str | None]:
    """The relay's connection id of the client's session: the ``conn`` of the relay's records of
    the client's own requests (SUBSCRIBE_RECV or OBJECT_SENT for a ladder track, SWITCH_RECV),
    the latest one when there are several (a reload opens a new connection; the analyzer keeps
    the last client session). (None, None) when the bundle has no such record."""
    tracks = [t["track"] for t in ladder]
    last = None
    for r in recs:
        if r.get("src") != "relay" or r.get("conn") is None:
            continue
        ev_ = r.get("event")
        if ev_ == "SWITCH_RECV" or (ev_ in ("SUBSCRIBE_RECV", "OBJECT_SENT")
                                    and any(track_matches(r.get("track"), t) for t in tracks)):
            last = r["conn"]
    return (last, "relay_records") if last is not None else (None, None)


def _merge_overlapping(episodes: list[dict]) -> tuple[list[dict], int]:
    """Stall episodes as the union of their intervals: an episode starting before the previous
    one ended is merged into it (the end is the later of the two). Returns (episodes, merged)."""
    out: list[dict] = []
    merged = 0
    for e in sorted(episodes, key=lambda x: x["ts"]):
        if out and out[-1].get("duration_ms") is not None and e.get("duration_ms") is not None \
                and e["ts"] < out[-1]["ts"] + out[-1]["duration_ms"]:
            prev = out[-1]
            end = max(prev["ts"] + prev["duration_ms"], e["ts"] + e["duration_ms"])
            out[-1] = dict(prev, duration_ms=end - prev["ts"], merged=prev.get("merged", 0) + 1,
                           open_at_end=prev.get("open_at_end") or e.get("open_at_end"))
            if not out[-1]["open_at_end"]:
                out[-1].pop("open_at_end")
            merged += 1
            continue
        out.append(e)
    return out, merged


def landing_keyframe(first_object: dict | None, applied: dict | None) -> bool | None:
    """landed_on_keyframe of the landing object: SWITCH_FIRST_OBJECT's flag (2026-10), else
    SWITCH_APPLIED's (older bundles carry it there only); None when neither says."""
    for r in (first_object, applied):
        if r is not None and r.get("landed_on_keyframe") is not None:
            return r["landed_on_keyframe"]
    return None


def playable_data_ahead(sample: dict, min_buffer_s: float = 0.5, min_later_range_s: float = 0.1) -> bool:
    """True when the SAMPLE shows data the player could have played: at least
    `min_buffer_s` buffered ahead of the playhead, or a buffered range beginning
    later than the playhead (a range-jump target). `buffered_ranges` is the
    element's TimeRanges as "s-e,s-e" in seconds (empty/missing = unknown -> False)."""
    if (sample.get("buffer_s") or 0) >= min_buffer_s:
        return True
    ranges = sample.get("buffered_ranges")
    playhead_s = (sample.get("playhead_ms") or 0) / 1000
    if not ranges:
        return False
    for part in str(ranges).split(","):
        try:
            start_s, end_s = (float(x) for x in part.split("-"))
        except ValueError:
            continue
        if start_s > playhead_s + min_later_range_s and end_s - start_s >= min_later_range_s:
            return True
    return False


def rule_name(rule_reason) -> str:
    """'latency trend 156% > 120%' -> 'latency trend'; 'throughput' -> 'throughput'."""
    if not rule_reason:
        return "unknown"
    m = RULE_NAME_RE.match(str(rule_reason))
    return (m.group(0) if m else str(rule_reason)).strip().lower() or "unknown"


# Switch identity -----------------------------------------------------------------

_SWITCH_SLOTS = {"SWITCH_OK": "ok", "SWITCH_ERROR": "error", "SWITCH_SKIPPED": "skipped",
                 "SWITCH_FIRST_OBJECT": "first_object", "SWITCH_APPLIED": "applied",
                 "SWITCH_FIRST_FRAME": "first_frame", "SWITCH_SUPERSEDED": "superseded_rec", "SWITCH_FLOOR": "floor"}
_SWITCH_RECORD_FIELDS = ("ok", "error", "first_object", "applied", "first_frame", "superseded_rec", "floor")


def _fallback_join(joined: list[dict], r: dict, slot: str, diag: dict) -> dict | None:
    """Join a switch record without ``switch_seq`` to its SWITCH_SENT (bundles from before
    2026-10-04). Returns the switch entry or None (unjoined).

    * SWITCH_FIRST_FRAME, SWITCH_FIRST_OBJECT, SWITCH_APPLIED: the LAST SWITCH_SENT with
      ``ts <= record.ts`` whose ``from`` and ``to`` both match the record's. The client
      keeps one pending seam per stream and overwrites it whenever a newer switch lands,
      so a first frame belongs to the latest switch with that (from, to), never to an
      earlier one. If that switch already holds such a record the new one is counted as
      a duplicate, not moved to an earlier switch. A record whose ``from`` matches no
      SWITCH_SENT (the source changed between send and landing) falls back to ``to``
      alone and is counted in ``diag["to_only_joins"]``.
    * SWITCH_OK / SWITCH_ERROR: the SWITCH_SENT with the same ``request_id``; without one
      (pr1378 adopts the relay's id), the earliest unanswered SWITCH_SENT to the same
      target (responses come back in order).
    * SWITCH_FLOOR (pr1378) precedes its SWITCH_SENT by at most a few ms and joins the
      next SWITCH_SENT.
    * SWITCH_SUPERSEDED needs ``switch_seq`` (old clients never emitted it). SWITCH_SKIPPED
      never joins (see ``join_switches``).
    Every unresolved switch that is not given a first frame here is classified later by
    ``join_switches`` (superseded when a later switch overwrote its seam, else open)."""
    ts = r.get("ts", 0)
    if slot == "superseded_rec":
        return None
    if slot == "floor":
        return next((j for j in joined if j["floor"] is None and ts - 50 <= j["sent"]["ts"] <= ts + 2000), None)
    to, frm, rid = r.get("to"), r.get("from"), r.get("request_id")
    before = [j for j in joined if j["sent"]["ts"] <= ts + 1 and (to is None or j["sent"].get("to") == to)]
    if slot in ("ok", "error"):
        if rid is not None:
            by_rid = [j for j in before if j["sent"].get("request_id") == rid]
            if by_rid:
                return by_rid[-1]
        open_ = [j for j in before if j["ok"] is None and j["error"] is None]
        return open_[0] if open_ else None
    exact = [j for j in before if frm is None or j["sent"].get("from") == frm]
    if exact:
        return exact[-1]
    if before:
        diag["to_only_joins"] += 1
        return before[-1]
    return None


def join_switches(recs: list[dict]) -> tuple[list[dict], dict]:
    """One entry per SWITCH_SENT with every later record of the same switch and its
    terminal state. Join key: ``switch_seq`` when the records carry it, else the
    documented fallback (see ``_fallback_join``).

    SWITCH_SKIPPED is never joined: the player emits it INSTEAD of a SWITCH_SENT, with a
    switch_seq of its own, so it is an attempt that was not sent, not a switch; every
    SWITCH_SKIPPED is counted in ``diag["unjoined"]["SWITCH_SKIPPED"]`` (switches.skipped_not_sent).

    Terminal (exactly one per switch, in this precedence): ``error`` (SWITCH_ERROR),
    ``first_frame`` (its own SWITCH_FIRST_FRAME),
    ``superseded`` (a SWITCH_SUPERSEDED record, or inferred when there is none: a later
    switch overwrote this one's pending state before its first frame, i.e. a later switch
    landed after this one landed, or a later switch was acknowledged (SWITCH_OK, which
    replaces the pending switch) before this one landed), ``open`` (none of these before
    the run ended). ``terminal_source`` is ``record`` or ``inferred``. Returns
    (switches, diagnostics)."""
    sents = [r for r in recs if r.get("event") == "SWITCH_SENT"]
    joined = []
    for i, s in enumerate(sents):
        seq = s.get("switch_seq")
        entry = {"sent": s, "switch_seq": seq if seq is not None else i + 1,
                 "switch_seq_source": "record" if seq is not None else "fallback"}
        entry.update({k: None for k in _SWITCH_RECORD_FIELDS})
        joined.append(entry)
    by_seq = {j["switch_seq"]: j for j in joined if j["switch_seq_source"] == "record"}
    diag = {"unjoined": {}, "duplicates": {}, "conflicting_terminals": 0, "to_only_joins": 0, "seq_join": bool(by_seq)}
    for r in recs:
        slot = _SWITCH_SLOTS.get(r.get("event"))
        if slot is None:
            continue
        seq = r.get("switch_seq")
        if slot == "skipped":
            target = None
        else:
            target = by_seq.get(seq) if seq is not None else _fallback_join(joined, r, slot, diag)
        if target is None:
            diag["unjoined"][r["event"]] = diag["unjoined"].get(r["event"], 0) + 1
            continue
        if target[slot] is not None:
            diag["duplicates"][r["event"]] = diag["duplicates"].get(r["event"], 0) + 1
            continue
        target[slot] = r
    for j in joined:
        j["landed"] = j["first_object"] is not None or j["applied"] is not None
        land = [x["ts"] for x in (j["first_object"], j["applied"]) if x is not None]
        j["landed_ts"] = min(land) if land else None
    for idx, j in enumerate(joined):
        j["superseded_by"], j["terminal_source"] = None, "record"
        if j["error"] is not None:
            j["terminal"] = "error"
        elif j["first_frame"] is not None:
            j["terminal"] = "first_frame"
            if j["superseded_rec"] is not None:
                diag["conflicting_terminals"] += 1
        elif j["superseded_rec"] is not None:
            j["terminal"] = "superseded"
            j["superseded_by"] = j["superseded_rec"].get("by_switch_seq")
        else:
            later = None
            for k in joined[idx + 1:]:
                if k["error"] is not None:
                    continue
                if k["landed"] or k["first_frame"] is not None or (not j["landed"] and k["ok"] is not None):
                    later = k
                    break
            if later is not None:
                j["terminal"], j["superseded_by"], j["terminal_source"] = "superseded", later["switch_seq"], "inferred"
            else:
                j["terminal"] = "open"
    return joined, diag


# Decision attribution ------------------------------------------------------------------

DECISION_JOIN_MAX_MS = 1000.0   # a switch is sent within this long of its decision (same tick, in practice)
LEGACY_DECISION_TOL_MS = 5.0     # pre-2026-10 clients logged ABR_DECISION a few ms around SWITCH_SENT


def _decided_at(r: dict) -> float | None:
    """Decision time (epoch ms) of an ABR_DECISION / ABR_SWITCH_PHANTOM: ``decided_ts``
    (2026-10), else ``ts - decided_ms_ago`` (phantoms before ``decided_ts``), else None
    (a pre-2026-10 ABR_DECISION, logged at the decision itself)."""
    if r.get("decided_ts") is not None:
        return float(r["decided_ts"])
    if r.get("decided_ms_ago") is not None:
        return r["ts"] - float(r["decided_ms_ago"])
    return None


def join_decisions(joined: list[dict], recs: list[dict], index_of: dict) -> tuple[list[dict | None], list[dict], dict]:
    """The controller decision behind every switch, and every decision as an event.

    Since 2026-10-04 the controller logs ABR_DECISION when the switch LANDS on its target
    (with ``decided_ts``, ``landed_after_ms`` and, from the 2026-10 contract on,
    ``switch_seq``), and ABR_SWITCH_PHANTOM when it ends without landing. A switch that is
    still pending at the run end has neither. Passes, in this order, each record used once:

    1. ``switch_seq`` on the ABR_DECISION (source ``switch_seq``);
    2. ``decided_ts``: same from and to, 0 <= SENT.ts - decided_ts <= 1000 ms, the latest
       such decision (``decided_ts``);
    3. pre-2026-10 ABR_DECISION (no decided_ts, logged at the decision): same target,
       -5 ms <= SENT.ts - ts <= 1000 ms, the latest (``legacy_ts``);
    4. ABR_SWITCH_PHANTOM by ``switch_seq``, else by decision time as in 2 (``phantom``);
    5. the last ABR_TICK at or before SWITCH_SENT (within 1000 ms) whose chosen index is
       the switch target's rung (``tick``; ``reason`` from the direction, auto-emergency
       when EmergencyBufferRule chose it).

    Returns (per-switch attribution or None, decision events, diagnostics). A decision
    event is ``{"ts": decision time, reason, rule_reason, from, to, switch: index | None,
    source}``; decisions and phantoms that joined no switch (pre-2026-10 clients skipped
    the request without a SWITCH_SENT) are kept as events with ``switch`` None."""
    decisions = [r for r in recs if r.get("event") == "ABR_DECISION"]
    phantoms = [r for r in recs if r.get("event") == "ABR_SWITCH_PHANTOM"]
    ticks = [r for r in recs if r.get("event") == "ABR_TICK"]
    n = len(joined)
    out: list[dict | None] = [None] * n
    used: set[int] = set()

    def attach(i: int, r: dict, at: float, source: str) -> None:
        used.add(id(r))
        out[i] = {"ts": at, "reason": r.get("reason"), "rule_reason": r.get("rule_reason"), "source": source, "record": r}

    def by_seq(pool: list[dict], source: str) -> None:
        idx = {j["switch_seq"]: i for i, j in enumerate(joined) if j["switch_seq_source"] == "record"}
        for r in pool:
            i = idx.get(r.get("switch_seq")) if r.get("switch_seq") is not None else None
            if i is not None and out[i] is None and id(r) not in used:
                at = _decided_at(r)
                attach(i, r, at if at is not None else r["ts"], source)

    def by_time(pool: list[dict], source: str, legacy: bool) -> None:
        for i, j in enumerate(joined):
            if out[i] is not None:
                continue
            sent = j["sent"]
            best, best_at = None, None
            for r in pool:
                if id(r) in used or r.get("switch_seq") is not None:
                    continue
                at = _decided_at(r)
                if legacy != (at is None):
                    continue
                at = r["ts"] if at is None else at
                lag = sent["ts"] - at
                lo = -LEGACY_DECISION_TOL_MS if legacy else 0.0
                if not (lo <= lag <= DECISION_JOIN_MAX_MS) or r.get("to") != sent.get("to"):
                    continue
                if not legacy and r.get("from") is not None and sent.get("from") is not None and r["from"] != sent["from"]:
                    continue
                if best_at is None or at >= best_at:
                    best, best_at = r, at
            if best is not None:
                attach(i, best, best_at, source)

    by_seq(decisions, "switch_seq")
    by_time(decisions, "decided_ts", legacy=False)
    by_time(decisions, "legacy_ts", legacy=True)
    by_seq(phantoms, "phantom")
    by_time(phantoms, "phantom", legacy=False)
    for i, j in enumerate(joined):
        if out[i] is not None:
            continue
        sent = j["sent"]
        ti, fi = index_of.get(sent.get("to"), -1), index_of.get(sent.get("from"), -1)
        tick = None
        for r in ticks:
            if r["ts"] > sent["ts"]:
                break
            ch = r.get("chosen") or {}
            if id(r) not in used and sent["ts"] - r["ts"] <= DECISION_JOIN_MAX_MS and ch.get("index") is not None and ch["index"] == ti:
                tick = r
        if tick is not None:
            ch = tick["chosen"]
            reason = ("auto-emergency" if ch.get("rule") == "EmergencyBufferRule" else "auto-downgrade") if ti < fi else "auto-upgrade"
            used.add(id(tick))
            out[i] = {"ts": tick["ts"], "reason": reason, "rule_reason": ch.get("reason"), "source": "tick", "record": tick}
    events = []
    for i, a in enumerate(out):
        if a is not None:
            sent = joined[i]["sent"]
            events.append({"ts": a["ts"], "reason": a["reason"], "rule_reason": a["rule_reason"], "from": sent.get("from"),
                           "to": sent.get("to"), "switch": i, "source": a["source"]})
    loose = [r for r in decisions + phantoms if id(r) not in used]
    for r in loose:
        at = _decided_at(r)
        events.append({"ts": at if at is not None else r["ts"], "reason": r.get("reason"), "rule_reason": r.get("rule_reason"),
                       "from": r.get("from"), "to": r.get("to"), "switch": None,
                       "source": "unjoined_" + ("decision" if r.get("event") == "ABR_DECISION" else "phantom")})
    events.sort(key=lambda e: e["ts"])
    sources: dict[str, int] = {}
    for a in out:
        k = a["source"] if a is not None else "none"
        sources[k] = sources.get(k, 0) + 1
    diag = {"sources": sources,
            "unjoined_decisions": sum(1 for r in loose if r.get("event") == "ABR_DECISION"),
            "unjoined_phantoms": sum(1 for r in loose if r.get("event") == "ABR_SWITCH_PHANTOM")}
    return out, events, diag


# Presented track -------------------------------------------------------------------

class PresentedSeries:
    """The track the viewer sees at a given time. Source ``sample`` when SAMPLE carries
    ``presented_track`` (clients from 2026-10-04 on); otherwise ``first_frame``: the
    startup track until the first own SWITCH_FIRST_FRAME, then that switch's target until
    the next own first frame. Superseded, failed and open switches never become visible
    and do not appear in the series."""

    def __init__(self, samples: list[dict], switches: list[dict], startup_track: str | None):
        self.source = "sample" if any(s.get("presented_track") is not None for s in samples) else "first_frame"
        self.samples = samples
        self.transitions = sorted((sw["first_frame_ts"], sw["to"]) for sw in switches
                                  if sw.get("terminal") == "first_frame" and sw.get("first_frame_ts") is not None)
        self.startup_track = startup_track

    def track_at(self, ts: float, sample: dict | None = None) -> str | None:
        if self.source == "sample":
            if sample is not None:
                return sample.get("presented_track")
            prev = None
            for s in self.samples:
                if s["ts"] > ts:
                    break
                prev = s
            return prev.get("presented_track") if prev else None
        cur = self.startup_track
        for t, tr in self.transitions:
            if t <= ts:
                cur = tr
            else:
                break
        return cur


def advancing_intervals(samples: list[dict], series: PresentedSeries) -> list[tuple[float, float, str | None]]:
    """(start_ts, end_ts, presented_track) for every SAMPLE interval in which the playhead
    advanced by more than 1 ms. Stalled intervals carry no presented media and are excluded."""
    out = []
    for a, b in zip(samples, samples[1:]):
        if (b.get("playhead_ms") or 0) > (a.get("playhead_ms") or 0) + 1:
            out.append((a["ts"], b["ts"], series.track_at(a["ts"], a)))
    return out


def weighted_rung(intervals, index_of: dict, bitrate_of: dict, t0: float = -math.inf, t1: float = math.inf) -> dict:
    total, rung_t, kbps_t = 0.0, 0.0, 0.0
    share: dict[str, float] = {}
    for a, b, track in intervals:
        dt = max(0.0, min(b, t1) - max(a, t0))
        if dt <= 0 or track not in index_of:
            continue
        total += dt
        rung_t += index_of[track] * dt
        kbps_t += (bitrate_of.get(track) or 0) / 1000 * dt
        share[track] = share.get(track, 0.0) + dt
    if total <= 0:
        return {"rung_mean": None, "kbps": None, "rung_share": {}, "advancing_s": 0.0}
    return {"rung_mean": rung_t / total, "kbps": kbps_t / total,
            "rung_share": {str(index_of[k]): v / total for k, v in sorted(share.items(), key=lambda kv: index_of[kv[0]])},
            "advancing_s": total / 1000}


def share_in_window(intervals, index_of: dict, t0: float, t1: float, pred) -> dict:
    """Share of advancing-playhead time in [t0, t1) whose presented rung satisfies ``pred``."""
    total, hit = 0.0, 0.0
    for a, b, track in intervals:
        dt = max(0.0, min(b, t1) - max(a, t0))
        if dt <= 0 or track not in index_of:
            continue
        total += dt
        if pred(index_of[track]):
            hit += dt
    return {"share": (hit / total) if total > 0 else None, "advancing_s": total / 1000}


def fit_rung(ladder: list[dict], rate_mbps: float | None, safety: float = FIT_SAFETY) -> int | None:
    """Highest rung whose bitrate <= safety x rate; the lowest rung when none fits."""
    if rate_mbps is None or not ladder:
        return None
    fitting = [i for i, t in enumerate(ladder) if (t.get("bitrate") or 0) <= safety * rate_mbps * 1e6]
    return max(fitting) if fitting else 0


def capacity_steps(changes: list[dict]) -> dict:
    """First capacity drop and the first restore after it, from the runner's NET_CHANGE
    records (``rate_mbps`` None = unshaped). Returns ts and rates (None when absent)."""
    drop_i = None
    for i in range(1, len(changes)):
        a, b = changes[i - 1].get("rate_mbps"), changes[i].get("rate_mbps")
        if a is not None and b is not None and b < a:
            drop_i = i
            break
    out = {"t_drop": None, "low_rate_mbps": None, "pre_rate_mbps": None, "t_restore": None, "restore_rate_mbps": None}
    if drop_i is None:
        return out
    out.update({"t_drop": changes[drop_i]["ts"], "low_rate_mbps": changes[drop_i].get("rate_mbps"),
                "pre_rate_mbps": changes[drop_i - 1].get("rate_mbps")})
    for j in range(drop_i + 1, len(changes)):
        r = changes[j].get("rate_mbps")
        if r is not None and r > out["low_rate_mbps"]:
            out.update({"t_restore": changes[j]["ts"], "restore_rate_mbps": r})
            break
    return out


GATED_WHYS = ("slow-start", "post-switch-up-guard", "up-dwell")


def switching_diagnostics(switches: list[dict], by, window_s: float, run_duration_s: float | None) -> dict:
    """Behavioural diagnostics of the switch sequence itself. A run with
    A->B->A->B is different from four monotonic adaptations even at equal
    counts and equal mean bitrate. ``switches_per_minute`` is over the run
    duration ((RUN_END or last SAMPLE) - STARTUP), not the span between the first
    and last switch (two switches 1 s apart are not 120/min)."""
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
    gated: dict[str, int] = {}
    for r in by("ABR_GATED"):
        k = r.get("why") or "slow-start"
        gated[k] = gated.get(k, 0) + 1
    by_rule: dict[str, int] = {}
    by_source: dict[str, int] = {}
    for s in switches:
        k = rule_name(s.get("rule_reason"))
        by_rule[k] = by_rule.get(k, 0) + 1
        src = s.get("decision_source") or "none"
        by_source[src] = by_source.get(src, 0) + 1
    return {
        "reversal_window_s": window_s,
        "run_duration_s": run_duration_s,
        "switches_per_minute": (len(switches) / run_duration_s * 60) if run_duration_s and run_duration_s > 0 else None,
        # The old denominator (first to last switch), kept as a diagnostic only.
        "switch_span_s": span_s,
        "inter_switch_interval_ms": stats(intervals),
        "median_inter_switch_interval_ms": statistics.median(intervals) if intervals else None,
        "min_inter_switch_interval_ms": min(intervals) if intervals else None,
        "direction_reversals": reversals,
        "aba_reversals": aba,
        "cooldown_activations": len(by("ABR_GUARD_TIMEOUT")),
        # ABR_GATED per `why` (a record without `why` is from a client that gated only on slow-start).
        "gated_by_why": gated,
        "slow_start_vetoes": gated.get("slow-start", 0),
        # Up-switches held by the post-switch up-guard (controller arm 'guard'/'both').
        "up_guard_vetoes": gated.get("post-switch-up-guard", 0),
        # Up-switches held by the min arm's dwell (upDwellGroups groups since the last landing).
        "up_dwell_vetoes": gated.get("up-dwell", 0),
        "other_gated": {k: v for k, v in gated.items() if k not in GATED_WHYS},
        # Switches the controller requested that ended without landing on their target
        # (refused, skipped or failed): ABR_SWITCH_PHANTOM.
        "phantom_switches": len(by("ABR_SWITCH_PHANTOM")),
        # Probe readings dropped for a too-short burst (controller arm 'probe'/'both').
        "probes_discarded": len(by("PROBE_DISCARDED")),
        "switches_by_rule": by_rule,
        # Where each switch's rule came from (join_decisions): switch_seq, decided_ts,
        # legacy_ts, phantom, tick; none = no decision found.
        "decision_sources": {k: v for k, v in sorted(by_source.items())},
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
            initial_window_s: float = 5.0, reversal_window_s: float = 5.0, feedback_window_s: float = 5.0,
            sustain_s: float = 5.0) -> dict:
    recs, sessions = last_session(load(run))
    by = lambda ev: [r for r in recs if r.get("event") == ev]  # noqa: E731
    meta = json.loads((run / "run_meta.json").read_text()) if (run / "run_meta.json").exists() else {}
    client_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "client") or {}
    pub_meta = first(recs, "RUN_META", pred=lambda r: r.get("src") == "publisher") or {}
    ladder = sorted(client_meta.get("ladder", []), key=lambda t: t.get("bitrate") or 0)
    index_of = {t["track"]: i for i, t in enumerate(ladder)}
    bitrate_of = {t["track"]: (t.get("bitrate") or 0) for t in ladder}

    identity = dict(meta.get("identity") or {})
    # Condition key: the relay's congestion controller. Runs before the rebuild did not
    # record it and all used BBR (hard-coded in the relay).
    cc_recorded = identity.get("congestion_controller") is not None
    identity.setdefault("congestion_controller", DEFAULT_CONGESTION_CONTROLLER)
    clock = first(recs, "CLOCK_MAP")
    ua = (clock or {}).get("user_agent") or ""
    browser_version = next((ua[ua.index(k) + len(k):].split()[0] for k in ("Firefox/", "Chrome/") if k in ua), None)
    run_end = first(recs, "RUN_END")
    out: dict = {
        "run_id": meta.get("run_id", run.name),
        "identity": identity,
        "congestion_controller": identity["congestion_controller"],
        "congestion_controller_source": "identity" if cc_recorded else "default",
        "browser_version": browser_version,
        "mechanism": identity.get("mechanism") or meta.get("args", {}).get("mechanism"),
        "mechanism_mode": identity.get("mechanism_mode"),
        "repeat_index": identity.get("repeat_index"),
        "client_mode": client_meta.get("client_mode"),
        "time_shift_s": client_meta.get("time_shift_s"),
        "delay_groups": client_meta.get("delay_groups"),
        "target_shift_ms": client_meta.get("target_shift_ms"),
        "profile": meta.get("profile", {}).get("name"),
        "qdisc": identity.get("qdisc") or meta.get("profile", {}).get("queue"),
        "bg_flows": meta.get("args", {}).get("bg_flows"),
        "duration_s": identity.get("duration_s") or meta.get("args", {}).get("duration"),
        "net_backend": meta.get("net_backend"),
        "gops_per_variant": pub_meta.get("gops_per_variant"),
        "events": len(recs),
        "client_sessions": sessions,
        "wall_clock_gaps_ms": wall_clock_gaps(recs),
        "run_end": {"present": run_end is not None, "elapsed_s": run_end.get("elapsed_s") if run_end else None,
                    "ts": run_end["ts"] if run_end else None},
    }

    # Startup ---------------------------------------------------------------
    st = first(recs, "STARTUP")
    fo = first(recs, "FIRST_OBJECT")
    startup_track = (st or {}).get("track") or client_meta.get("startup_track")
    out["startup"] = {
        "startup_delay_ms": st.get("startup_delay_ms") if st else None,
        "connect_to_first_object_ms": st.get("connect_to_first_object_ms") if st else None,
        "first_object_to_first_frame_ms": st.get("first_object_to_first_frame_ms") if st else None,
        "first_group": fo.get("group") if fo else None,
        "expected_start_group": fo.get("expected_start_group") if fo else None,
        "clamped_by_relay": fo.get("clamped") if fo else None,
        "startup_track": startup_track,
    }
    win_start = st["ts"] if st else None
    win_end = (st["ts"] + initial_window_s * 1000) if st else None
    # Client records after the runner's RUN_END (the browser logs on through teardown) are
    # outside the run: samples, playback, stalls, starvation and seeks are clipped to it.
    clip_end = run_end["ts"] if run_end else None
    within = lambda ts: clip_end is None or ts <= clip_end  # noqa: E731
    client_end = max((r["ts"] for r in recs if r.get("src") == "client"), default=None)
    if client_end is not None and clip_end is not None:
        client_end = min(client_end, clip_end)
    samples = [s for s in by("SAMPLE") if (st is None or s["ts"] >= st["ts"]) and within(s["ts"])]
    # Run duration: first presented frame to RUN_END (or the last SAMPLE when the runner
    # record is missing). The denominator of switches/min and the end of the share windows.
    end_ts = run_end["ts"] if run_end else (samples[-1]["ts"] if samples else client_end)
    run_duration_s = ((end_ts - st["ts"]) / 1000) if (st and end_ts is not None and end_ts > st["ts"]) else None
    out["run_duration_s"] = run_duration_s

    # Stalls and seeks -------------------------------------------------------
    episodes = []
    open_start = None
    for r in recs:
        if r.get("event") == "STALL_START":
            open_start = r
        elif r.get("event") == "STALL_END" and open_start is not None:
            # The episode starts at STALL_END.ts - duration_ms: the player backdates a
            # `frozen` stall to its first frozen watchdog tick (STALL_START is logged 0.5-1 s
            # later), and duration_ms is measured from that start on the monotonic clock.
            dur = r.get("duration_ms")
            start_ts = (r["ts"] - dur) if dur is not None else open_start["ts"]
            episodes.append({"ts": start_ts, "start_logged_ts": open_start["ts"], "cause": r.get("cause"), "duration_ms": dur,
                             "playhead_ms": r.get("playhead_ms"), "track": open_start.get("track")})
            open_start = None
    # A stall still open when the run ended is a stall to the end of the run.
    if open_start is not None:
        last_ts = client_end if client_end is not None else open_start["ts"]
        episodes.append({"ts": open_start["ts"], "cause": open_start.get("cause"), "duration_ms": max(0.0, last_ts - open_start["ts"]),
                         "playhead_ms": open_start.get("playhead_ms"), "track": open_start.get("track"), "open_at_end": True})
    # Clip to RUN_END: an episode starting after it is not part of the run, one spanning it ends there.
    episodes = _clip_episodes(episodes, clip_end)
    # Overlapping episodes are one stall: a frozen stall that `playing` closed while the
    # watchdog still counted frozen ticks is reopened backdated to the original freeze start.
    episodes, merged_overlaps = _merge_overlapping(episodes)
    # Only episodes after the first presented frame count; the client already excludes
    # pre-startup `waiting`, this is the analyzer's own guarantee.
    episodes = [e for e in episodes if st is None or e["ts"] >= st["ts"]]
    for e in episodes:
        e["blip"] = (e["duration_ms"] or 0) < STALL_MIN_EPISODE_MS
    major = [e for e in episodes if not e["blip"]]
    blips = [e for e in episodes if e["blip"]]
    durations = [e["duration_ms"] for e in major if e["duration_ms"] is not None]
    seeks = by("SEEK")
    for s in seeks:
        s["_kind"] = SEEK_REASON_NORMAL.get(s.get("reason"), s.get("reason") or "unknown")
    after_window = lambda s: win_end is not None and s["ts"] >= win_end  # noqa: E731
    span = lambda s: max(0.0, (s.get("to_ms") or 0) - (s.get("from_ms") or 0)) if s.get("to_ms") is not None and s.get("from_ms") is not None else (s.get("gap_ms") or 0)  # noqa: E731
    gap_after = [s for s in seeks if s["_kind"] == "gap" and after_window(s) and within(s["ts"])]
    wedge_after = [s for s in seeks if s["_kind"] == "wedge" and after_window(s) and within(s["ts"])]
    out["stalls"] = {
        # Episodes >= STALL_MIN_EPISODE_MS; shorter `waiting` blips (15-30 ms around a gap seek) are counted apart.
        "count": len(major), "total_ms": sum(durations), "max_ms": max(durations) if durations else 0,
        "min_episode_ms": STALL_MIN_EPISODE_MS,
        "blips": len(blips), "blips_ms": sum(e["duration_ms"] or 0 for e in blips),
        "all_count": len(episodes),
        # Episodes that overlapped an earlier one (reopened backdated) and were merged into it.
        "overlapping_merged": merged_overlaps,
        "episodes": episodes,
        # Normalised seek vocabulary (gap = gap | range-jump | unwedge), all seeks of the session.
        "seeks": {k: sum(1 for s in seeks if s["_kind"] == k) for k in ("startup", "gap", "wedge", "visibility")},
        "seeks_raw": {reason: sum(1 for s in seeks if s.get("reason") == reason) for reason in sorted({s.get("reason") for s in seeks} - {None})},
        # Gap seeks after the initial window: excludes the startup positioning jump.
        "gap_seeks": len(gap_after),
        # Media the viewer never saw because a gap seek jumped over it (after the initial window).
        "media_skipped_ms": sum(span(s) for s in gap_after),
        # Wedge recovery seeks are listed apart (they repair a decoder wedge, not a buffer hole).
        "wedge_seeks": len(wedge_after),
        "wedge_skipped_ms": sum(span(s) for s in wedge_after),
        "open_at_end": any(e.get("open_at_end") for e in episodes),
        "wedge_gap_ms_total": sum(s.get("gap_ms") or 0 for s in seeks if s.get("reason") == "wedge"),
        # Range-jumps the buffer held back because new media was landing inside the gap
        # (RANGE_JUMP_DEFERRED is emitted once per gap), and the total wait before the jumps
        # that did happen after a deferral.
        "range_jumps_deferred": len(by("RANGE_JUMP_DEFERRED")),
        "range_jump_deferred_ms_total": sum(s.get("deferred_ms") or 0 for s in seeks if s["_kind"] == "gap"),
    }
    for s in seeks:
        s.pop("_kind", None)
    # Data starvation: nothing appended for 4 s with <= 0.5 s left ahead (DATA_STARVED)
    # until data flows again (DATA_RESUMED) or the run ends. A starving subscription is a
    # delivery failure, not a decoder wedge. The client times an episode from the LAST
    # APPEND, so the raw episode includes the seconds in which the buffer still played out
    # (fresh-grid-v2 pr1378 shift r1: 10.8 s starved, 0 s stalled). The headline
    # `starvation_s` is therefore the part of stall time (episodes >= 250 ms) that lies
    # inside a starvation episode: a subset of `stall_s` by construction, never to be
    # added to it. The raw episode total is kept as a diagnostic (`raw_total_ms`).
    starved = []
    open_st = None
    for r in recs:
        if r.get("event") == "DATA_STARVED" and open_st is None:
            open_st = r
        elif r.get("event") == "DATA_RESUMED" and open_st is not None:
            starved.append({"ts": open_st["ts"] - (open_st.get("since_last_append_ms") or 0), "duration_ms": r.get("starved_ms"),
                            "track": open_st.get("track"), "pending": open_st.get("pending"), "last_group": open_st.get("last_group")})
            open_st = None
    if open_st is not None and client_end is not None:
        start = open_st["ts"] - (open_st.get("since_last_append_ms") or 0)
        starved.append({"ts": start, "duration_ms": client_end - start, "track": open_st.get("track"),
                        "pending": open_st.get("pending"), "last_group": open_st.get("last_group"), "open_at_end": True})
    starved = _clip_episodes(starved, clip_end)
    stall_in_starvation = 0.0
    for e in starved:
        a, b = e["ts"], e["ts"] + (e["duration_ms"] or 0)
        for x in major:
            xa, xb = x["ts"], x["ts"] + (x["duration_ms"] or 0)
            stall_in_starvation += max(0.0, min(b, xb) - max(a, xa))
    out["starvation"] = {"episodes": starved, "count": len(starved),
                         # stall time (episodes >= 250 ms) inside starvation episodes: the headline
                         "total_ms": stall_in_starvation,
                         # raw episodes from the last append to DATA_RESUMED (or the run end)
                         "raw_total_ms": sum(e["duration_ms"] or 0 for e in starved),
                         "open_at_end": any(e.get("open_at_end") for e in starved),
                         "subset_of": "stalls.total_ms"}

    # Switch timelines -------------------------------------------------------
    switch_recv = by("SWITCH_RECV")
    promoted = by("SWITCH_PROMOTED")
    drops = by("DROP_STALE")
    joined, join_diag = join_switches(recs)
    attribution, decision_events, decision_diag = join_decisions(joined, recs, index_of)
    switches = []
    for j, decision in zip(joined, attribution):
        sent = j["sent"]
        rid = sent.get("request_id")
        ok, err, fobj, applied, fframe = j["ok"], j["error"], j["first_object"], j["applied"], j["first_frame"]
        # The relay's SWITCH_RECV names the subscription being replaced (old_request_id)
        # on every mechanism; the new id may be absent (null) on PR #1378.
        old_rid = sent.get("old_request_id")
        rrecv = next((r for r in switch_recv if r["ts"] >= sent["ts"] - 100
                      and ((rid is not None and r.get("request_id") == rid)
                           or (old_rid is not None and r.get("old_request_id") == old_rid))), None)
        rprom = first(promoted, "SWITCH_PROMOTED", rrecv["ts"] if rrecv else sent["ts"],
                      lambda r: track_matches(r.get("track"), sent.get("to"))) if rrecv else None
        fi, ti = index_of.get(sent.get("from"), -1), index_of.get(sent.get("to"), -1)
        d = lambda r: (r["ts"] - sent["ts"]) if r else None  # noqa: E731
        presented = j["terminal"] == "first_frame"
        # t5 from the record's own clock (perf-based) when present; the wall-clock
        # difference otherwise (bundles before 2026-09).
        vis = None
        if presented:
            vis = fframe.get("switch_visibility_delay_ms")
            if vis is None:
                vis = fframe["ts"] - sent["ts"]
        switches.append({
            "ts": sent["ts"], "from": sent.get("from"), "to": sent.get("to"),
            "switch_seq": j["switch_seq"], "switch_seq_source": j["switch_seq_source"],
            "terminal": j["terminal"], "terminal_source": j["terminal_source"],
            "superseded": j["terminal"] == "superseded", "superseded_by": j["superseded_by"],
            "landed": j["landed"],
            "first_frame_ts": fframe["ts"] if fframe else None,
            "direction": "up" if ti > fi else "down" if ti < fi else "same",
            # The controller decision behind this switch (join_decisions): its decision
            # time (decided_ts; ABR_DECISION itself is logged at the landing), reason and
            # rule, and where the attribution came from.
            "reason": decision["reason"] if decision else None,
            "rule_reason": decision["rule_reason"] if decision else None,
            "decision_source": decision["source"] if decision else None,
            "decided_ts": decision["ts"] if decision else None,
            "t2_decision_ms": (sent["ts"] - decision["ts"]) if decision else None,
            "t3_ok_ms": d(ok), "error": err.get("reason") if err else None,
            "relay_recv_ms": d(rrecv), "relay_promoted_ms": d(rprom),
            "relay_start_group": rprom.get("start_group") if rprom else None,
            # pr1378: the Minimum Switching Group the client asked for.
            "selected_min_group": j["floor"].get("selected_min_group") if j["floor"] else None,
            # t4: first object of the target arrives at the client.
            "switch_delivery_latency_ms": d(fobj), "t4_group": fobj.get("group") if fobj else None,
            "applied_ms": d(applied),
            # Buffer continuity at the seam (first appended target PTS - last source end PTS).
            "media_seam_gap_ms": applied.get("media_seam_gap_ms") if applied else None,
            # Media the viewer still plays before reaching the seam (first target PTS - playhead at send).
            "seam_ahead_of_playhead_ms": applied.get("seam_ahead_of_playhead_ms") if applied else None,
            "seam_behind_playhead": fframe.get("seam_behind_playhead") if fframe else None,
            "discarded_before_keyframe": applied.get("discarded_before_keyframe") if applied else None,
            # t5: first presented frame of the new representation. Only for a switch with
            # its OWN first-frame record (terminal first_frame).
            "switch_visibility_delay_ms": vis,
            "first_frame_source": fframe.get("source") if fframe else None,
            # Presented-mediaTime discontinuity at the seam beyond one frame (0 = played through).
            "playback_position_jump_ms": fframe.get("playback_position_jump_ms") if presented else None,
            # Wall-clock pause at the seam beyond one frame period.
            "viewer_pause_ms": fframe.get("viewer_pause_ms") if presented else None,
            # Hole in the element's buffered ranges at the seam (what a gap seek crosses): the
            # player's attribution on 2026-10 records, the 100 ms rule on older ones (seam_hole).
            "seam_buffer_hole_ms": seam_hole(fframe) if presented else None,
            "seam_hole_rule": seam_hole_rule(fframe) if presented else None,
            # The raw hole behind the presented frame's range (may be an older hole).
            "buffer_hole_behind_ms": hole_behind(fframe) if presented else None,
            # Whether the target began on object 0 of its group (its keyframe).
            "landed_on_group_start": applied.get("landed_on_group_start") if applied else None,
            # Whether the landing object's moof carries the sync-sample flag (a real keyframe).
            # From SWITCH_FIRST_OBJECT (2026-10: the landing object), so a switch that landed
            # off a keyframe and was superseded before the keyframe gate appended anything
            # (no SWITCH_APPLIED) stays in the denominator; SWITCH_APPLIED for older bundles.
            "landed_on_keyframe": landing_keyframe(fobj, applied),
            # Source-track objects that arrived after the target landed and were discarded
            # (the relay kept delivering the source's in-progress group).
            "seam_dropped_source_frames": sum(
                1 for r in drops
                if applied and applied["ts"] <= r["ts"] < applied["ts"] + 3000 and r.get("track") == sent.get("from")),
            "playhead_ms": sent.get("playhead_ms"), "playhead_group": sent.get("playhead_group"),
            "last_received_group": sent.get("last_received_group"),
        })
    presented_sw = [s for s in switches if s["terminal"] == "first_frame"]
    terminals = {t: sum(1 for s in switches if s["terminal"] == t) for t in TERMINALS}
    out["switches"] = {
        "count": len(switches),
        "terminals": terminals,
        "join": join_diag,
        "superseded": terminals["superseded"],
        "superseded_frac": (terminals["superseded"] / len(switches)) if switches else None,
        "presented": terminals["first_frame"],
        "open": terminals["open"],
        # Landed more than half a GOP behind the playhead: the mechanism (re)delivered
        # media the client had already played or buffered (buffer-unaware floor
        # selection, catch-up fills). Observable for every mechanism.
        "landed_behind_playhead": sum(
            1 for s in switches
            if s["seam_ahead_of_playhead_ms"] is not None
            and s["seam_ahead_of_playhead_ms"] < -(client_meta.get("gop_duration_ms") or 1000) / 2),
        "up": sum(1 for s in switches if s["direction"] == "up"),
        "down": sum(1 for s in switches if s["direction"] == "down"),
        "failed": terminals["error"],
        "landed": sum(1 for s in switches if s["landed"]),
        # Delivery-side stamps over every landed switch (mechanism metrics).
        "switch_delivery_latency_ms": stats([s["switch_delivery_latency_ms"] for s in switches]),
        "relay_promoted_ms": stats([s["relay_promoted_ms"] for s in switches]),
        "media_seam_gap_ms": stats([s["media_seam_gap_ms"] for s in switches]),
        "seam_ahead_of_playhead_ms": stats([s["seam_ahead_of_playhead_ms"] for s in switches]),
        "abs_seam_ahead_of_playhead_ms": stats([abs(s["seam_ahead_of_playhead_ms"]) for s in switches
                                                if s["seam_ahead_of_playhead_ms"] is not None]),
        # Seam statistics: only switches with their own first frame.
        "switch_visibility_delay_ms": stats([s["switch_visibility_delay_ms"] for s in presented_sw]),
        "playback_position_jump_ms": stats([s["playback_position_jump_ms"] for s in presented_sw]),
        "abs_playback_position_jump_ms": stats([abs(s["playback_position_jump_ms"]) for s in presented_sw
                                                if s["playback_position_jump_ms"] is not None]),
        "viewer_pause_ms": stats([s["viewer_pause_ms"] for s in presented_sw]),
        "seam_buffer_hole_ms": stats([s["seam_buffer_hole_ms"] for s in presented_sw]),
        "seam_dropped_source_frames": stats([s["seam_dropped_source_frames"] for s in switches]),
        "landed_on_group_start": sum(1 for s in switches if s["landed_on_group_start"]),
        "landed_on_keyframe": sum(1 for s in switches if s["landed_on_keyframe"]),
        "landed_on_keyframe_known": sum(1 for s in switches if s["landed_on_keyframe"] is not None),
        "list": switches,
        # Decision attribution (join_decisions): counts per source, decisions that joined no switch.
        "decision_join": decision_diag,
        "guard_timeouts": len(by("ABR_GUARD_TIMEOUT")),
        # ABR_GATED with why = slow-start (or no why); the other reasons are in switching.gated_by_why.
        "gated_slow_start": sum(1 for r in by("ABR_GATED") if (r.get("why") or "slow-start") == "slow-start"),
        # SWITCH_SKIPPED: a switch attempt the player did not send (the previous switch had
        # no alias yet). Emitted instead of a SWITCH_SENT, so never a switch (diagnostic).
        "skipped_not_sent": join_diag["unjoined"].get("SWITCH_SKIPPED", 0),
        "skipped_attempts": len(by("SWITCH_SKIPPED")),
        "session_destroyed": any("destroyed" in str(r.get("reason")) for r in by("SWITCH_ERROR")),
    }
    out["switches"]["skipped_not_landed"] = out["switches"]["skipped_not_sent"]  # legacy name
    out["switching"] = switching_diagnostics(switches, by, reversal_window_s, run_duration_s)
    out["feedback"] = feedback_windows(switches, by, feedback_window_s)

    # Samples: time shift, live edge, bitrate --------------------------------
    tse = [s.get("time_shift_error_ms") for s in samples if s.get("time_shift_error_ms") is not None]
    led = [s.get("live_edge_distance_ms") for s in samples if s.get("live_edge_distance_ms") is not None]
    initial = [s.get("live_edge_distance_ms") for s in samples
               if win_end is not None and s["ts"] < win_end and s.get("live_edge_distance_ms") is not None]
    after_win = [s.get("live_edge_distance_ms") for s in samples
                 if win_end is not None and s["ts"] >= win_end and s.get("live_edge_distance_ms") is not None]
    target_shift = client_meta.get("target_shift_ms") or 0
    tths = next(
        (s["ts"] - st["ts"] for s in samples
         if st and win_end is not None and s["ts"] >= win_end
         and s.get("live_edge_distance_ms") is not None and target_shift > 0
         and s["live_edge_distance_ms"] < target_shift / 2), None)
    out["time_shift"] = {
        "signed_error_ms": stats(tse), "abs_error_ms": stats([abs(v) for v in tse]),
        "live_edge_distance_ms": stats(led),
        # Live-edge distance after the initial window (the live-edge client's headline number).
        "live_edge_after_window_ms": stats(after_win),
        # Shift erosion: first sample after the initial window at which the client sits closer
        # than half its target to the live edge. None = never happened (right-censored at the run
        # end) for a time-shifted client; `half_shift_lost` is None for a live-edge client.
        "time_to_half_shift_ms": tths,
        "half_shift_lost": (tths is not None) if target_shift > 0 else None,
        "initial_window": {
            "definition": f"first {initial_window_s:g} s after the first presented frame",
            "start_ms": win_start, "end_ms": win_end,
            "live_edge_distance_ms": stats(initial),
            "target_shift_ms": client_meta.get("target_shift_ms"),
        },
        "buffer_s": stats([s.get("buffer_s") for s in samples]),
        "buffer_contig_s": stats([s.get("buffer_contig_s") for s in samples]),
        # Shift retained: mean live-edge distance over the last 60 s of the run (after
        # the profile's events), and the closest the client came to live at any point.
        # (by time: SAMPLEs within 60 s of the last one, not the last 240 records).
        "retained_live_edge_ms": statistics.fmean([s["live_edge_distance_ms"] for s in samples
                                                   if s["ts"] >= samples[-1]["ts"] - 60_000
                                                   and s.get("live_edge_distance_ms") is not None] or [float("nan")]),
        "min_live_edge_ms": min((s["live_edge_distance_ms"] for s in samples if s.get("live_edge_distance_ms") is not None), default=None),
        "playback_rate": stats([s.get("playback_rate") for s in samples]),
        "latency_ms": stats([s.get("last_latency_ms") for s in samples if s.get("last_latency_ms")]),
    }
    series = PresentedSeries(samples, switches, startup_track)
    adv = advancing_intervals(samples, series)
    presented_w = weighted_rung(adv, index_of, bitrate_of)
    if len(samples) >= 2:
        weighted = 0.0
        share: dict[str, float] = {}
        for a, b in zip(samples, samples[1:]):
            dt = max(0.0, (b["ts"] - a["ts"]) / 1000.0)
            weighted += (a.get("bitrate_kbps") or 0) * dt
            share[a.get("track") or "?"] = share.get(a.get("track") or "?", 0.0) + dt
        total = sum(share.values()) or 1.0
        rung_time = sum(index_of.get(k, 0) * v for k, v in share.items() if k in index_of)
        subscribed = {
            "subscribed_rung_mean": rung_time / total,
            "subscribed_kbps": weighted / total,
            "subscribed_rung_share": {str(index_of[k]): v / total for k, v in sorted(share.items(), key=lambda kv: index_of.get(kv[0], -1)) if k in index_of},
            "subscribed_track_share": {k: v / total for k, v in share.items()},
            "sampled_s": total,
        }
    else:
        subscribed = {"subscribed_rung_mean": None, "subscribed_kbps": None, "subscribed_rung_share": {},
                      "subscribed_track_share": {}, "sampled_s": 0.0}
    out["bitrate"] = {
        # Headline: what the viewer saw, weighted by the time the playhead advanced.
        "presented_rung_mean": presented_w["rung_mean"],
        "presented_kbps": presented_w["kbps"],
        "presented_rung_share": presented_w["rung_share"],
        "presented_advancing_s": presented_w["advancing_s"],
        "presented_source": series.source,
        # Diagnostic: the subscribed track (SAMPLE.track changes at landing, not at
        # visibility), wall-time weighted including stalled intervals: the old
        # `mean_rung_index` / `time_weighted_mean_kbps`.
        **subscribed,
        "mean_rung_index": subscribed["subscribed_rung_mean"],
        "time_weighted_mean_kbps": subscribed["subscribed_kbps"],
        "rung_share": subscribed["subscribed_rung_share"],
        "track_share": subscribed["subscribed_track_share"],
        "played_s": subscribed["sampled_s"],
        "dropped_frames": samples[-1].get("dropped_frames") if samples else None,
        "total_frames": samples[-1].get("total_frames") if samples else None,
    }

    # Capacity steps and shares -------------------------------------------------
    changes = by("NET_CHANGE")
    steps = capacity_steps(changes)
    t_drop, t_restore = steps["t_drop"], steps["t_restore"]
    fit_low = fit_rung(ladder, steps["low_rate_mbps"])
    pre_drop_rung = None
    if t_drop is not None:
        pre = [index_of[tr] for tr in (series.track_at(s["ts"], s) for s in samples if t_drop - PRE_DROP_WINDOW_S * 1000 <= s["ts"] < t_drop)
               if tr in index_of]
        pre_drop_rung = statistics.median_low(pre) if pre else None
    rung_at_drop = None
    if t_drop is not None:
        tr = series.track_at(t_drop)
        rung_at_drop = index_of.get(tr) if tr is not None else None
    low_share = share_in_window(adv, index_of, (t_drop + SHARE_SETTLE_S * 1000) if t_drop is not None else math.inf,
                                t_restore if t_restore is not None else (end_ts if end_ts is not None else math.inf),
                                lambda i: fit_low is not None and i <= fit_low) if (t_drop is not None and fit_low is not None) else {"share": None, "advancing_s": 0.0}
    after_share = share_in_window(adv, index_of, (t_restore + SHARE_SETTLE_S * 1000) if t_restore is not None else math.inf,
                                  end_ts if end_ts is not None else math.inf,
                                  lambda i: pre_drop_rung is not None and i >= pre_drop_rung) if (t_restore is not None and pre_drop_rung is not None) else {"share": None, "advancing_s": 0.0}
    out["shares"] = {
        "t_drop": t_drop, "t_restore": t_restore, "low_rate_mbps": steps["low_rate_mbps"], "pre_rate_mbps": steps["pre_rate_mbps"],
        "fit_safety": FIT_SAFETY, "settle_s": SHARE_SETTLE_S,
        "fit_rung": fit_low,
        "rung_at_drop": rung_at_drop,
        "pre_drop_rung": pre_drop_rung, "pre_drop_window_s": PRE_DROP_WINDOW_S,
        "fit_share_low": low_share["share"], "low_window_advancing_s": low_share["advancing_s"],
        "pre_drop_share_after_restore": after_share["share"], "after_window_advancing_s": after_share["advancing_s"],
    }

    # Detection timelines per NET_CHANGE ------------------------------------
    detections = []
    drop_precondition: bool | None = None
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
        # t2: the first controller decision (by its decision time, not the landing-time
        # ABR_DECISION record) in the step's window, in the step's direction.
        t2 = next((e for e in decision_events if t0 <= e["ts"] < window_end and
                   ((direction == "down" and e.get("reason") in ("auto-downgrade", "auto-emergency")) or
                    (direction == "up" and e.get("reason") == "auto-upgrade"))), None)
        if t2 is not None and t2["switch"] is not None:
            sw = switches[t2["switch"]]
        else:  # a decision without its own SWITCH_SENT (pre-2026-10 clients skipped it): nearest switch to its target
            sw = next((s for s in switches if t2 and s["to"] == t2.get("to") and abs(s["ts"] - t2["ts"]) < 5000), None)

        # Reaction to a down-step: the PRESENTED rung is one that fits the new capacity
        # and stays there for `sustain_s`. Recovery after an up-step: the presented rung
        # is back at (or above) the pre-drop rung and stays there for `sustain_s`.
        def sustained(pred, start_ts):
            run_from = None
            for smp in samples:
                if smp["ts"] < start_ts or smp["ts"] >= window_end:
                    continue
                tr = series.track_at(smp["ts"], smp)
                if tr in index_of and pred(index_of[tr]):
                    run_from = run_from if run_from is not None else smp["ts"]
                    if smp["ts"] - run_from >= sustain_s * 1000:
                        return run_from
                else:
                    run_from = None
            return None
        rec = {"direction": direction, "from_mbps": prev_rate, "to_mbps": new_rate, "t0": t0,
               "t1_ms": (t1["ts"] - t0) if t1 else None, "t1_bps": t1.get("bps") if t1 else None,
               "t2_ms": (t2["ts"] - t0) if t2 else None, "t2_rule": t2.get("rule_reason") if t2 else None,
               "t2_from": t2.get("from") if t2 else None, "t2_to": t2.get("to") if t2 else None,
               "t3_ms": (sw["ts"] - t0) if sw else None,
               "t4_ms": (sw["ts"] + sw["switch_delivery_latency_ms"] - t0) if sw and sw["switch_delivery_latency_ms"] else None,
               "t5_ms": (sw["ts"] + sw["switch_visibility_delay_ms"] - t0) if sw and sw["switch_visibility_delay_ms"] else None}
        # Attribution: t2 is the controller's reaction to THIS change only if the
        # controller was quiet before it (no decision in the feedback window before t0).
        decisions_before = [e for e in decision_events if t0 - feedback_window_s * 1000 <= e["ts"] < t0]
        rec["quiet_before"] = len(decisions_before) == 0
        rec["sample_before_decision"] = bool(t1 and t2 and t1["ts"] <= t2["ts"])
        rec["reliable"] = rec["quiet_before"]
        if direction == "down":
            fit_index = fit_rung(ladder, new_rate)
            tr0 = series.track_at(t0)
            r0 = index_of.get(tr0) if tr0 is not None else None
            rec["fit_index"] = fit_index
            rec["rung_at_drop"] = r0
            # Precondition for a reaction time: the viewer was above the fitting rung when
            # the capacity dropped. A client already at or below it has nothing to react to.
            if r0 is None or fit_index is None:
                rec["precondition"], rec["na_reason"] = False, "presented rung at the drop unknown"
            elif r0 <= fit_index:
                rec["precondition"], rec["na_reason"] = False, f"already at a fitting rung at the drop (rung {r0} <= fit {fit_index})"
            else:
                rec["precondition"], rec["na_reason"] = True, None
            drop_precondition = rec["precondition"]
            r_at = sustained(lambda i_: i_ <= fit_index, t0) if rec["precondition"] else None
            rec["down_reaction_ms"] = (r_at - t0) if r_at is not None else None
        if direction == "up":
            # The pre-drop rung is the median presented rung over the 20 s before the drop.
            drop_ts = changes[i - 1]["ts"]
            pre = [index_of[tr] for tr in (series.track_at(s["ts"], s) for s in samples if drop_ts - PRE_DROP_WINDOW_S * 1000 <= s["ts"] < drop_ts)
                   if tr in index_of]
            pre_index = statistics.median_low(pre) if pre else None
            rec["pre_drop_index"] = pre_index
            rec["precondition"] = bool(drop_precondition) and pre_index is not None
            rec["na_reason"] = None if rec["precondition"] else ("no qualifying drop before this restore" if drop_precondition is None else
                                                                 "the preceding drop did not qualify (see its na_reason)" if not drop_precondition else
                                                                 "pre-drop rung unknown")
            if rec["precondition"]:
                q = next((s for s in samples if s["ts"] >= t0 and index_of.get(series.track_at(s["ts"], s), -1) >= pre_index), None)
                rec["quality_recovery_ms"] = (q["ts"] - t0) if q else None
                r_at = sustained(lambda i_: i_ >= pre_index, t0)
                rec["up_recovery_ms"] = (r_at - t0) if r_at is not None else None
            else:
                rec["quality_recovery_ms"] = None
                rec["up_recovery_ms"] = None
            # Offset recovery: |error| within tolerance for offset_hold_s (time-shift metric,
            # independent of the rung precondition).
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
    med_gap = out["switching"]["median_inter_switch_interval_ms"]
    out["switching_quiet"] = med_gap is None or med_gap >= feedback_window_s * 1000
    out["detection_reliable"] = bool(detections) and all(d["reliable"] for d in detections)
    out["detection"] = detections
    # Headline reaction/recovery: the first down-step and the first up-step of the
    # profile, reported only from the detect_step profile and only when the client was
    # above the fitting rung at the drop. The per-event records above keep the
    # diagnostics for every profile.
    first_down = next((d for d in detections if d["direction"] == "down"), None)
    first_up = next((d for d in detections if d["direction"] == "up"), None)
    na_reason = None
    if out["profile"] != "detect_step":
        na_reason = f"profile {out['profile']!r}: reaction metrics are reported only from the detect_step profile"
    elif first_down is None:
        na_reason = "no capacity drop in this run"
    elif not first_down.get("precondition"):
        na_reason = first_down.get("na_reason") or "precondition not met"
    reported = na_reason is None
    out["reaction"] = {
        "sustain_s": sustain_s,
        "reaction_na_reason": na_reason,
        "rung_at_drop": first_down.get("rung_at_drop") if first_down else None,
        "fit_index": first_down.get("fit_index") if first_down else None,
        "pre_drop_index": first_up.get("pre_drop_index") if first_up else None,
        # outcome metrics (presented rung held sustain_s): no attribution needed
        "down_reaction_ms": first_down.get("down_reaction_ms") if (reported and first_down) else None,
        "up_recovery_ms": first_up.get("up_recovery_ms") if (reported and first_up) else None,
        # attribution-based reaction (t0 -> first decision), only when reliable
        "down_t2_ms": first_down["t2_ms"] if reported and first_down and first_down["reliable"] else None,
        "down_t4_ms": first_down["t4_ms"] if reported and first_down and first_down["reliable"] else None,
        "up_t2_ms": first_up["t2_ms"] if reported and first_up and first_up["reliable"] else None,
        "down_reliable": first_down["reliable"] if (reported and first_down) else None,
        "up_reliable": first_up["reliable"] if (reported and first_up) else None,
    }

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
    # QUIC path statistics of the client's connection (relay CONN_STATS, once per second,
    # cumulative counters). The client's connection is identified by its id in the relay's
    # own records of the client's requests (client_connection_id); only bundles without
    # such records fall back to the connection with the most bytes sent. Summaries cover
    # the run, [STARTUP, RUN_END]: the relay's shutdown drain after RUN_END (up to 10 s)
    # and the setup before the first frame stay out; cumulative counters are differences
    # against the last sample before the window (zero when there is none).
    conn_stats: dict[int, list[dict]] = {}
    for r in by("CONN_STATS"):
        conn_stats.setdefault(r.get("conn"), []).append(r)
    conn_id, conn_source = client_connection_id(recs, ladder)
    if conn_id is None or conn_id not in conn_stats:
        conn_id = max(conn_stats, key=lambda k: conn_stats[k][-1].get("udp_tx_bytes") or 0, default=None)
        conn_source = "most_bytes" if conn_id is not None else None
    client_conn_all = conn_stats.get(conn_id, [])
    w_lo = st["ts"] if st else -math.inf
    w_hi = run_end["ts"] if run_end else math.inf
    client_conn = [r for r in client_conn_all if w_lo <= r["ts"] <= w_hi]
    base = next((r for r in reversed(client_conn_all) if r["ts"] < w_lo), None)
    delta = lambda k: ((client_conn[-1].get(k) or 0) - ((base or {}).get(k) or 0)) if client_conn else None  # noqa: E731
    cwnd = [r["cwnd"] for r in client_conn if r.get("cwnd") is not None]
    sent_pk = delta("sent_packets")
    out["conn"] = {
        "conn_id": conn_id,
        # relay_records: by id from SUBSCRIBE_RECV / OBJECT_SENT / SWITCH_RECV for the client's
        # tracks; most_bytes: old-bundle fallback.
        "conn_source": conn_source,
        "window": {"from_ts": st["ts"] if st else None, "to_ts": run_end["ts"] if run_end else None},
        "samples": len(client_conn),
        "rtt_ms": stats([r["rtt_ms"] for r in client_conn if r.get("rtt_ms") is not None]),
        "cwnd_bytes": stats(cwnd),
        "lost_packets": delta("lost_packets"),
        "lost_bytes": delta("lost_bytes"),
        "sent_packets": sent_pk,
        "congestion_events": delta("congestion_events"),
        "loss_rate": ((delta("lost_packets") or 0) / sent_pk) if client_conn and sent_pk else (0.0 if client_conn else None),
        # UDP datagrams per send I/O on the client connection: 1.0 means no UDP
        # segmentation batches (C5); > 1 means quinn sent GSO batches.
        "tx_datagrams_per_io": (delta("udp_tx_datagrams") / delta("udp_tx_ios")) if client_conn and delta("udp_tx_ios") else None,
        "pacer_rate_bps": stats([r["pacer_rate_bps"] for r in client_conn if r.get("pacer_rate_bps") is not None]),
    }
    relay_config = first(recs, "RELAY_CONFIG")
    out["relay"] = {
        "subscribes": len(by("SUBSCRIBE_RECV")), "holds": len(by("SUBSCRIBE_HOLD")),
        "clamped": sum(1 for r in by("SUBSCRIBE_RECV") if r.get("decision") == "clamped"),
        "switch_recv": len(switch_recv), "switch_promoted": len(promoted),
        "switch_demoted": len(by("SWITCH_DEMOTED")), "switch_wait": len(by("SWITCH_WAIT")),
        "config": {k: v for k, v in relay_config.items() if k not in ("ts", "src", "event")} if relay_config else None,
    }
    out["publisher"] = {"groups_emitted": len(by("GROUP_EMIT"))}
    out["net"] = {
        "changes": len(changes),
        "applied": sum(1 for c in changes if c.get("applied")),
        "unapplied": sum(1 for c in changes if not c.get("applied")),
        "with_qdisc_stats": sum(1 for c in changes if c.get("qdisc_stats") is not None),
    }
    # Playback progress: fraction of sample intervals in which the playhead
    # advanced, the longest stretch without progress, and the longest stretch
    # without progress WHILE PLAYABLE DATA EXISTED (buffer ahead of the playhead,
    # or a later buffered range the watchdog could jump to). The latter is a
    # player wedge, i.e. an apparatus failure; a freeze with nothing to play is
    # starvation, an outcome of the system under test, and is kept as a stall.
    prog_ok, prog_n, longest, run_start = 0, 0, 0.0, None
    longest_with_data, with_data_total, data_start = 0.0, 0.0, None
    for a, b in zip(samples, samples[1:]):
        prog_n += 1
        if b.get("playhead_ms", 0) > a.get("playhead_ms", 0) + 1:
            prog_ok += 1
            run_start = None
            data_start = None
        else:
            run_start = run_start if run_start is not None else a["ts"]
            longest = max(longest, b["ts"] - run_start)
            if playable_data_ahead(a):
                data_start = data_start if data_start is not None else a["ts"]
                longest_with_data = max(longest_with_data, b["ts"] - data_start)
                with_data_total += b["ts"] - a["ts"]
            else:
                data_start = None
    out["playback"] = {
        "advancing_fraction": (prog_ok / prog_n) if prog_n else None,
        "longest_no_progress_ms": longest,
        "longest_frozen_with_data_ms": longest_with_data,
        "frozen_with_data_ms_total": with_data_total,
        "presented_frames": samples[-1].get("total_frames") if samples else None,
        "samples": len(samples),
    }
    # Delivery integrity (needs --log-objects): how many objects of each group the
    # client actually received. A group with fewer than half the expected objects is
    # "truncated": the relay stopped mid-group.
    objs = by("OBJECT_RECV")
    discarded = {"objects": len(drops),
                 "bytes": sum(r.get("bytes") or 0 for r in drops),
                 "groups": len({(r.get("track"), r.get("group")) for r in drops}),
                 # objects dropped between a new init segment and the first keyframe
                 "pre_keyframe": sum(1 for r in drops if r.get("reason") == "pre-keyframe"),
                 # library-level discard of a stream whose alias has no route (2026-10 contract)
                 "unrouted": sum(1 for r in drops if r.get("reason") == "unrouted"),
                 "unrouted_bytes": sum(r.get("bytes") or 0 for r in drops if r.get("reason") == "unrouted")}
    out["discarded"] = discarded
    if objs:
        per_group: dict[tuple, set] = {}
        last_ts = max(r["ts"] for r in objs)
        for r in objs:
            if r["ts"] > last_ts - 2000:
                continue  # the group still arriving at the end of the run is partial by construction
            per_group.setdefault((r.get("track"), r.get("group")), set()).add(r.get("object"))
        counts = [len(v) for v in per_group.values()]
        expected = max(counts) if counts else 0
        dropped: dict[tuple, int] = {}
        for r in drops:
            k = (r.get("track"), r.get("group"))
            dropped[k] = dropped.get(k, 0) + 1
        short = sorted(((t, g, len(v), dropped.get((t, g), 0)) for (t, g), v in per_group.items() if len(v) < 0.5 * expected),
                       key=lambda x: x[1])
        on_wire = [x for x in short if x[2] + x[3] < 0.5 * expected]
        sent_by_group: dict[tuple, set] = {}
        for r in by("OBJECT_SENT"):
            if r.get("sent") is False:
                continue
            for t in ladder:
                if track_matches(r.get("track"), t["track"]):
                    sent_by_group.setdefault((t["track"], r.get("group")), set()).add(r.get("object"))
                    break
        relay_cut = [x for x in on_wire if sent_by_group and len(sent_by_group.get((x[0], x[1]), ())) < 0.5 * expected]
        lost_after_send = [x for x in on_wire if sent_by_group and len(sent_by_group.get((x[0], x[1]), ())) >= 0.5 * expected]
        out["delivery"] = {"logged": True, "groups": len(per_group), "expected_objects_per_group": expected,
                           "objects_per_group": stats(counts),
                           "short_groups": len(short),
                           "truncated_groups": len(on_wire),
                           "relay_logged": bool(sent_by_group),
                           "cut_at_relay": len(relay_cut) if sent_by_group else None,
                           "lost_after_send": len(lost_after_send) if sent_by_group else None,
                           "lost_after_send_list": [{"track": t, "group": g, "received": n, "sent": len(sent_by_group.get((t, g), ()))}
                                                    for t, g, n, _ in lost_after_send[:50]],
                           "truncated_list": [{"track": t, "group": g, "objects": n, "discarded": d} for t, g, n, d in on_wire[:100]],
                           "short_list": [{"track": t, "group": g, "objects": n, "discarded": d} for t, g, n, d in short[:100]]}
    else:
        out["delivery"] = {"logged": False, "groups": 0, "expected_objects_per_group": None,
                           "objects_per_group": stats([]), "short_groups": None, "truncated_groups": None,
                           "relay_logged": False, "cut_at_relay": None, "lost_after_send": None, "lost_after_send_list": [],
                           "truncated_list": [], "short_list": []}
    # Probe load on the link and relay->client object latency (the latter needs the
    # relay's OBJECT_SENT records, i.e. --log-objects).
    probes = by("PROBE")
    probe_bytes = sum(r.get("p_bytes") or 0 for r in probes if r.get("src") == "client")
    span_s = ((recs[-1]["ts"] - recs[0]["ts"]) / 1000) if len(recs) > 1 else 0
    sent_ts: dict[tuple, float] = {}
    for r in by("OBJECT_SENT"):
        for t in ladder:
            if track_matches(r.get("track"), t["track"]):
                sent_ts.setdefault((t["track"], r.get("group"), r.get("object")), r["ts"])
                break
    lat = [r["ts"] - sent_ts[(r.get("track"), r.get("group"), r.get("object"))] for r in by("OBJECT_RECV")
           if (r.get("track"), r.get("group"), r.get("object")) in sent_ts]
    probe_bps = [r["bps"] for r in probes if r.get("src") == "client" and r.get("bps")]
    # Probe-measured throughput per capacity step: p50 of PROBE.bps between 5 s after the
    # step and the next step (the preflight compares the lowest step against 0.8 x rate).
    per_step = []
    for i, ch in enumerate(changes):
        nxt = changes[i + 1]["ts"] if i + 1 < len(changes) else math.inf
        vals = [r["bps"] for r in probes if r.get("src") == "client" and r.get("bps") and ch["ts"] + SHARE_SETTLE_S * 1000 <= r["ts"] < nxt]
        per_step.append({"at_s": ch.get("at_s"), "rate_mbps": ch.get("rate_mbps"), "probes": len(vals),
                         "p50_mbps": (pct(vals, 0.5) / 1e6) if vals else None})
    out["link"] = {"probe_bytes": probe_bytes, "probe_mbps": (probe_bytes * 8 / span_s / 1e6) if span_s else None,
                   "probes": sum(1 for r in probes if r.get("src") == "client"),
                   "probe_measured_mbps": {k: (v / 1e6 if v is not None else None) for k, v in stats(probe_bps).items()},
                   "probe_measured_per_step": per_step,
                   "send_recv_latency_ms": stats(lat)}
    out["client_errors"] = [r.get("message") for r in by("ERROR")]
    # Fatal media element errors (MEDIA_ERR_DECODE = 3 etc.): after one, every append fails.
    out["media_errors"] = [{"ts": r["ts"], "code": r.get("code"), "message": r.get("message"), "track": r.get("track"),
                            "playhead_ms": r.get("playhead_ms")} for r in by("MEDIA_ERROR")]
    return out


def run_marked_aborted(run: Path) -> bool:
    """The runner's own abort marker: ``run_meta.json`` ``validity.aborted`` (2026-10) or
    ``failed: ["aborted"]`` in the validation.json it writes for an aborted run."""
    try:
        meta = json.loads((run / "run_meta.json").read_text())
    except (OSError, json.JSONDecodeError):
        meta = {}
    if (meta.get("validity") or {}).get("aborted") is True:
        return True
    try:
        v = json.loads((run / "validation.json").read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return "aborted" in (v.get("failed") or [])


def read_validity(run: Path) -> dict:
    """validation.json is written by validate.py (the runner calls it after every
    run) or, for an aborted run, by the runner itself with ``failed: ["aborted"]``
    (and ``run_meta.json`` ``validity.aborted``). No file = not validated: ``valid``
    None, which the aggregates exclude. An aborted run is never valid."""
    p = run / "validation.json"
    aborted = run_marked_aborted(run)
    if not p.exists():
        return {"valid": False if aborted else None, "reasons": ["aborted"] if aborted else ["not validated"], "aborted": aborted}
    v = json.loads(p.read_text())
    failed = list(v.get("failed") or [])
    if aborted and "aborted" not in failed:
        failed.append("aborted")
    return {"valid": bool(v.get("passed")) and not aborted, "reasons": failed, "final": v.get("final"), "aborted": aborted}


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
    sw, stl, ts_, br, sh, rx = s["switches"], s["stalls"], s["time_shift"], s["bitrate"], s["shares"], s["reaction"]
    L = [f"# {s['run_id']}", "",
         f"mechanism={s['mechanism']} mode={s['mechanism_mode']} client={s['client_mode']} shift={s['time_shift_s']}s "
         f"(delay_groups={s['delay_groups']}, target={s['target_shift_ms']} ms) profile={s['profile']} qdisc={s.get('qdisc')} "
         f"cc={s.get('congestion_controller')} bg={s['bg_flows']} controller={(s.get('identity') or {}).get('controller') or 'baseline'}", "",
         "## Headline", "",
         "| metric | value |", "|---|---|",
         f"| run duration s (first frame to RUN_END); switches; switches/min | {fmt(s.get('run_duration_s'))}; {sw['count']}; {fmt(s['switching']['switches_per_minute'])} |",
         f"| A->B->A reversals (direction reversals) | {s['switching']['aba_reversals']} ({s['switching']['direction_reversals']}) |",
         f"| switch terminals: first_frame / superseded / error / open | {sw['terminals']['first_frame']} / {sw['terminals']['superseded']} / {sw['terminals']['error']} / {sw['terminals']['open']} (superseded frac {fmt(sw['superseded_frac'])}; join by {'switch_seq' if sw['join'].get('seq_join') else 'fallback'}) |",
         f"| presented rung mean / presented kbps (advancing time, source {br.get('presented_source')}) | {fmt(br.get('presented_rung_mean'))} / {fmt(br.get('presented_kbps'))} |",
         f"| subscribed rung mean / kbps (diagnostic, wall time) | {fmt(br.get('subscribed_rung_mean'))} / {fmt(br.get('subscribed_kbps'))} |",
         f"| fit share in the low window (fit rung {sh.get('fit_rung')}, rung at drop {sh.get('rung_at_drop')}) | {fmt(sh.get('fit_share_low'))} over {fmt(sh.get('low_window_advancing_s'))} s advancing |",
         f"| share at >= pre-drop rung after restore (pre-drop rung {sh.get('pre_drop_rung')}) | {fmt(sh.get('pre_drop_share_after_restore'))} over {fmt(sh.get('after_window_advancing_s'))} s advancing |",
         f"| stalls >= {stl['min_episode_ms']:g} ms: count / total ms / max ms; blips (count / ms) | {stl['count']} / {fmt(stl['total_ms'])} / {fmt(stl['max_ms'])}; {stl['blips']} ({fmt(stl['blips_ms'])}) |",
         f"| media skipped by gap seeks after the initial window: s (seeks); wedge seeks s (seeks) | {fmt(stl['media_skipped_ms'] / 1000)} ({stl['gap_seeks']}); {fmt(stl['wedge_skipped_ms'] / 1000)} ({stl['wedge_seeks']}) |",
         f"| starvation: stall s inside starvation episodes (subset of stall s); episodes / raw s from the last append | {fmt(s['starvation']['total_ms'] / 1000)}; {s['starvation']['count']} / {fmt(s['starvation']['raw_total_ms'] / 1000)}{' (open at end)' if s['starvation']['open_at_end'] else ''} |",
         f"| viewer pause at seam ms p50 / p95 (own first frame, n) | {fmt(sw['viewer_pause_ms'].get('p50'))} / {fmt(sw['viewer_pause_ms'].get('p95'))} (n={sw['viewer_pause_ms'].get('n')}) |",
         f"| switch visibility delay ms t5 p50 / p95 (own first frame, n) | {fmt(sw['switch_visibility_delay_ms'].get('p50'))} / {fmt(sw['switch_visibility_delay_ms'].get('p95'))} (n={sw['switch_visibility_delay_ms'].get('n')}) |",
         f"| startup delay (ms) | {fmt(s['startup']['startup_delay_ms'])} |",
         f"| shift retained in the last 60 s (mean live-edge distance ms) / half shift lost / time to half shift s | {fmt(ts_.get('retained_live_edge_ms'))} / {ts_.get('half_shift_lost')} / {fmt((ts_['time_to_half_shift_ms'] or 0) / 1000) if ts_['time_to_half_shift_ms'] else '-'} |",
         f"| live-edge distance ms mean after the initial window / p95 | {fmt(ts_['live_edge_after_window_ms'].get('mean'))} / {fmt(ts_['live_edge_after_window_ms'].get('p95'))} |",
         f"| landed on a keyframe (sync flag) | {sw['landed_on_keyframe']} of {sw['landed_on_keyframe_known']} known |",
         f"| down-reaction / up-recovery s (presented rung held {rx['sustain_s']:g} s) | {fmt((rx['down_reaction_ms'] or 0) / 1000) if rx['down_reaction_ms'] is not None else '-'} / {fmt((rx['up_recovery_ms'] or 0) / 1000) if rx['up_recovery_ms'] is not None else '-'}{(' (N/A: ' + rx['reaction_na_reason'] + ')') if rx.get('reaction_na_reason') else ''} |",
         "", "## Diagnostics", "",
         "| metric | value |", "|---|---|",
         f"| first group / expected / clamped | {s['startup']['first_group']} / {s['startup']['expected_start_group']} / {s['startup']['clamped_by_relay']} |",
         f"| seeks (all): startup / gap / wedge / visibility; deferred gaps | {stl['seeks']['startup']} / {stl['seeks']['gap']} / {stl['seeks']['wedge']} / {stl['seeks']['visibility']}; {stl['range_jumps_deferred']} |",
         f"| controller arm; gated (slow-start / up-guard / up-dwell / other); phantom switches; probes discarded | {(s.get('identity') or {}).get('controller') or 'baseline'}; {s['switching']['slow_start_vetoes']} / {s['switching']['up_guard_vetoes']} / {s['switching']['up_dwell_vetoes']} / {sum(s['switching']['other_gated'].values())}; {s['switching']['phantom_switches']}; {s['switching']['probes_discarded']} |",
         f"| delivery (needs --log-objects): groups / objects per group p50,min / short / truncated on the wire | {s['delivery']['groups']} / {fmt(s['delivery']['objects_per_group'].get('p50'))},{fmt(s['delivery']['objects_per_group'].get('min'))} / {s['delivery']['short_groups']} / {s['delivery']['truncated_groups']} |",
         f"| of the wire-cut groups (relay OBJECT_SENT): cut at the relay / lost after send | {s['delivery']['cut_at_relay']} / {s['delivery']['lost_after_send']} |",
         f"| probe load: probes / MB / mean Mbps; relay->client object latency ms p50 / p95 | {s['link']['probes']} / {s['link']['probe_bytes'] / 1e6:.1f} / {fmt(s['link']['probe_mbps'])}; {fmt(s['link']['send_recv_latency_ms'].get('p50'))} / {fmt(s['link']['send_recv_latency_ms'].get('p95'))} |",
         f"| discarded by the client (stale objects / groups / MB; pre-keyframe; unrouted bytes) | {s['discarded']['objects']} / {s['discarded']['groups']} / {s['discarded']['bytes'] / 1e6:.1f}; {s['discarded']['pre_keyframe']}; {s['discarded'].get('unrouted_bytes')} |",
         f"| media element errors (code) / client ERROR events | {len(s['media_errors'])} ({', '.join(str(e['code']) for e in s['media_errors'])}) / {len(s['client_errors'])} |",
         f"| switches (up / down / failed / landed); attempts skipped without a SWITCH_SENT | {sw['count']} ({sw['up']} / {sw['down']} / {sw['failed']} / {sw['landed']}); {sw['skipped_attempts']} |",
         f"| switch delivery latency ms, t4 (median / p95) | {fmt(sw['switch_delivery_latency_ms'].get('p50'))} / {fmt(sw['switch_delivery_latency_ms'].get('p95'))} |",
         f"| relay promoted ms (median / n of {sw['count']}) | {fmt(sw['relay_promoted_ms'].get('p50'))} / {sw['relay_promoted_ms'].get('n')} |",
         f"| media seam gap ms (median / max) | {fmt(sw['media_seam_gap_ms'].get('p50'))} / {fmt(sw['media_seam_gap_ms'].get('max'))} |",
         f"| seam ahead of playhead ms (median / abs p95); landed behind playhead | {fmt(sw['seam_ahead_of_playhead_ms'].get('p50'))} / {fmt(sw['abs_seam_ahead_of_playhead_ms'].get('p95'))}; {sw['landed_behind_playhead']} |",
         f"| playback position jump ms (median / abs p95) | {fmt(sw['playback_position_jump_ms'].get('p50'))} / {fmt(sw['abs_playback_position_jump_ms'].get('p95'))} |",
         f"| seam buffer hole ms (median / max) | {fmt(sw['seam_buffer_hole_ms'].get('p50'))} / {fmt(sw['seam_buffer_hole_ms'].get('max'))} |",
         f"| seam dropped source frames (median / max); landed on object 0 | {fmt(sw['seam_dropped_source_frames'].get('p50'))} / {fmt(sw['seam_dropped_source_frames'].get('max'))}; {sw['landed_on_group_start']} of {sw['count']} |",
         f"| join diagnostics: unjoined / duplicates / conflicting terminals; SWITCH_SKIPPED (not sent) | {sw['join'].get('unjoined')} / {sw['join'].get('duplicates')} / {sw['join'].get('conflicting_terminals')}; {sw['skipped_not_sent']} |",
         f"| playback advancing fraction / longest no-progress s / longest frozen with playable data s | {fmt(s['playback']['advancing_fraction'] and s['playback']['advancing_fraction'] * 100)} % / {fmt((s['playback']['longest_no_progress_ms'] or 0) / 1000)} / {fmt((s['playback'].get('longest_frozen_with_data_ms') or 0) / 1000)} |",
         f"| detection attributable (per change: quiet before t0) | {s['detection_reliable']}; down t2/t4 {fmt(rx['down_t2_ms'])}/{fmt(rx['down_t4_ms'])} ms, up t2 {fmt(rx['up_t2_ms'])} ms (median inter-switch {fmt(s['switching']['median_inter_switch_interval_ms'])} ms) |",
         f"| inter-switch interval ms (median / min); switch span s | {fmt(s['switching']['median_inter_switch_interval_ms'])} / {fmt(s['switching']['min_inter_switch_interval_ms'])}; {fmt(s['switching']['switch_span_s'])} |",
         f"| switches by rule | {s['switching']['switches_by_rule']} |",
         f"| switches followed within {s['feedback']['window_s']:g} s (by latency trend) | {s['feedback']['summary']['followed_within_window']} ({s['feedback']['summary']['followed_within_window_by_latency_trend']}) of {s['feedback']['summary']['switches']} |",
         f"| initial-window live-edge distance ms (mean, n) | {fmt(ts_['initial_window']['live_edge_distance_ms'].get('mean'))} (n={ts_['initial_window']['live_edge_distance_ms'].get('n')}), target {ts_['initial_window']['target_shift_ms']} |",
         f"| time-shift error ms signed mean / abs p95; closest to live ms | {fmt(ts_['signed_error_ms'].get('mean'))} / {fmt(ts_['abs_error_ms'].get('p95'))}; {fmt(ts_.get('min_live_edge_ms'))} |",
         f"| live-edge distance ms mean / p95 (whole run) | {fmt(ts_['live_edge_distance_ms'].get('mean'))} / {fmt(ts_['live_edge_distance_ms'].get('p95'))} |",
         f"| buffer s mean / p50; contiguous buffer s mean | {fmt(ts_['buffer_s'].get('mean'))} / {fmt(ts_['buffer_s'].get('p50'))}; {fmt(ts_['buffer_contig_s'].get('mean'))} |",
         f"| presented rung share; subscribed rung share | {({k: round(v, 2) for k, v in (br.get('presented_rung_share') or {}).items()})}; {({k: round(v, 2) for k, v in (br.get('subscribed_rung_share') or {}).items()})} |",
         f"| relay cache total max bytes / evictions | {s['cache']['total_max_bytes']} / {s['cache']['evictions']} |",
         f"| QUIC (client connection): rtt p50 ms / cwnd min KB / loss rate / congestion events | {fmt(s['conn']['rtt_ms'].get('p50'))} / {fmt((s['conn']['cwnd_bytes'].get('min') or 0) / 1000 or None)} / {fmt(s['conn'].get('loss_rate'))} / {s['conn'].get('congestion_events')} |",
         f"| NET_CHANGE: changes / applied / with qdisc_stats; RUN_END present (elapsed s) | {s['net']['changes']} / {s['net']['applied']} / {s['net']['with_qdisc_stats']}; {s['run_end']['present']} ({fmt(s['run_end']['elapsed_s'])}) |",
         ]
    for name, p in s["process"].items():
        L.append(f"| {name} max RSS MB / mean CPU % | {p['max_rss_bytes'] / 1e6:.1f} / {p['mean_cpu_pct']:.1f} |")
    if s["detection"]:
        L += ["", "## Detection timelines (ms after the capacity change; diagnostics for every profile)", "",
              "| change | attributable (quiet before) | precondition (rung at drop / fit; pre-drop rung) | t1 sample | t2 decision (rule) | t3 sent | t4 first obj | t5 first frame | quality rec. | offset rec. | sustained reaction/recovery |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for d in s["detection"]:
            pre = f"{d.get('precondition')} ({d.get('rung_at_drop')} / {d.get('fit_index')}; {d.get('pre_drop_index')})"
            L.append(f"| {d['from_mbps']}->{d['to_mbps']} Mbps | {d['reliable']} | {pre} | {fmt(d['t1_ms'])} | {fmt(d['t2_ms'])} ({d['t2_rule']}) | "
                     f"{fmt(d['t3_ms'])} | {fmt(d['t4_ms'])} | {fmt(d['t5_ms'])} | "
                     f"{fmt(d.get('quality_recovery_ms'))} | {fmt(d.get('offset_recovery_ms'))} | "
                     f"{fmt(d.get('down_reaction_ms', d.get('up_recovery_ms')))}{(' (' + d['na_reason'] + ')') if d.get('na_reason') else ''} |")
    if sw["list"]:
        L += ["", "## Switches", "", "| t (s) | seq | from -> to | rule | terminal | relay recv | promoted (start grp) | t4 delivery | keyframe | seam ahead | t5 visible | pause | hole | jump | dropped src frames |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        t0 = sw["list"][0]["ts"]
        for x in sw["list"]:
            term = x["terminal"] + (f"(by {x['superseded_by']})" if x["superseded_by"] is not None else "")
            L.append(f"| {(x['ts'] - t0) / 1000:.1f} | {x['switch_seq']} | {x['from']} -> {x['to']} | {rule_name(x['rule_reason'])} | {term} | {fmt(x['relay_recv_ms'])} | "
                     f"{fmt(x['relay_promoted_ms'])} ({x['relay_start_group']}) | {fmt(x['switch_delivery_latency_ms'])} | "
                     f"{x['landed_on_keyframe']} | {fmt(x['seam_ahead_of_playhead_ms'])} | {fmt(x['switch_visibility_delay_ms'])} | "
                     f"{fmt(x['viewer_pause_ms'])} | {fmt(x['seam_buffer_hole_ms'])} | {fmt(x['playback_position_jump_ms'])} | {x['seam_dropped_source_frames']} |")
    return "\n".join(L) + "\n"


IDENTITY_COLUMNS = ["run_id", "git_sha", "branch", "mechanism", "mechanism_mode", "controller", "controller_params", "abr_overrides", "client_type", "delay_groups",
                    "browser_version",
                    "gop_duration_ms", "ladder_id", "network_profile", "trace_id", "qdisc", "congestion_controller", "background_flows",
                    "repeat_index", "timestamp_start"]
METRIC_COLUMNS = ["startup_delay_ms", "run_duration_s", "stall_count", "stall_total_ms", "stall_blips", "media_skipped_ms", "wedge_skipped_ms",
                  "switch_count", "switch_up", "switch_down",
                  "switches_per_minute", "direction_reversals", "aba_reversals", "median_inter_switch_ms",
                  "cooldown_activations", "switch_delivery_latency_p50_ms", "switch_visibility_delay_p50_ms", "switch_visibility_delay_p95_ms",
                  "media_seam_gap_p50_ms", "seam_ahead_p50_ms", "seam_buffer_hole_p50_ms", "seam_dropped_frames_p50",
                  "landed_on_group_start", "landed_on_keyframe", "landed_on_keyframe_known", "presented_switches", "superseded", "superseded_frac",
                  "open_switches", "failed_switches", "landed_behind_playhead", "abs_playback_jump_p95_ms", "viewer_pause_p95_ms",
                  "followed_within_window", "followed_by_latency_trend", "initial_live_edge_mean_ms",
                  "time_to_half_shift_ms", "half_shift_lost", "advancing_fraction", "longest_no_progress_ms", "longest_frozen_with_data_ms", "session_destroyed",
                  "detection_reliable", "down_reaction_ms", "up_recovery_ms", "reaction_na_reason", "data_starved_ms", "data_starved_raw_ms",
                  "gap_seeks", "range_jumps_deferred", "slow_start_vetoes", "up_guard_vetoes", "up_dwell_vetoes", "other_gated",
                  "phantom_switches", "skipped_attempts", "probes_discarded", "media_errors",
                  "presented_rung_mean", "presented_kbps", "subscribed_rung_mean", "subscribed_kbps",
                  "fit_share_low", "pre_drop_share_after_restore", "pre_drop_rung", "rung_at_drop", "fit_rung",
                  "truncated_groups", "discarded_objects", "discarded_mb",
                  "probe_mbps", "probe_measured_min_mbps", "probe_measured_p50_mbps", "conn_loss_rate", "conn_cwnd_min_bytes",
                  "conn_congestion_events", "send_recv_latency_p50_ms", "down_t2_ms", "down_t4_ms", "up_t2_ms", "down_reliable", "up_reliable",
                  "retained_live_edge_ms", "min_live_edge_ms",
                  "shift_err_mean_ms", "shift_abs_err_p95_ms", "live_edge_mean_ms", "live_edge_after_window_ms", "buffer_mean_s",
                  "cache_max_bytes", "relay_max_rss_mb"]
AGG_COLUMNS = IDENTITY_COLUMNS + METRIC_COLUMNS
# Right-censored metrics: None = the event never happened in that run (per-condition
# summaries report the fraction with the event and the median with never = inf).
CENSORED_COLUMNS = ("time_to_half_shift_ms", "down_reaction_ms", "up_recovery_ms")
# Bernoulli metrics: per-condition summaries report the fraction, never a median.
FRACTION_COLUMNS = ("half_shift_lost", "detection_reliable", "down_reliable", "up_reliable", "session_destroyed")


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
    ident.setdefault("qdisc", s.get("qdisc"))
    ident.setdefault("congestion_controller", s.get("congestion_controller") or DEFAULT_CONGESTION_CONTROLLER)
    row = {k: ident.get(k) for k in IDENTITY_COLUMNS}
    row["controller_params"] = json.dumps(ident.get("controller_params") or {}, sort_keys=True)
    # The browser build changed between batches once (Firefox 156 -> 157); keep it per run.
    row["browser_version"] = s.get("browser_version")
    sw, stl, ts_, br, sh, rx = s["switches"], s["stalls"], s["time_shift"], s["bitrate"], s["shares"], s["reaction"]
    row.update({
        "startup_delay_ms": s["startup"]["startup_delay_ms"], "run_duration_s": s.get("run_duration_s"),
        "stall_count": stl["count"], "stall_total_ms": stl["total_ms"], "stall_blips": stl["blips"],
        "media_skipped_ms": stl["media_skipped_ms"], "wedge_skipped_ms": stl["wedge_skipped_ms"],
        "switch_count": sw["count"],
        "switch_up": sw["up"], "switch_down": sw["down"],
        "switches_per_minute": s["switching"]["switches_per_minute"],
        "direction_reversals": s["switching"]["direction_reversals"],
        "aba_reversals": s["switching"]["aba_reversals"],
        "median_inter_switch_ms": s["switching"]["median_inter_switch_interval_ms"],
        "cooldown_activations": s["switching"]["cooldown_activations"],
        "switch_delivery_latency_p50_ms": sw["switch_delivery_latency_ms"].get("p50"),
        "switch_visibility_delay_p50_ms": sw["switch_visibility_delay_ms"].get("p50"),
        "switch_visibility_delay_p95_ms": sw["switch_visibility_delay_ms"].get("p95"),
        "media_seam_gap_p50_ms": sw["media_seam_gap_ms"].get("p50"),
        "seam_ahead_p50_ms": sw["seam_ahead_of_playhead_ms"].get("p50"),
        "seam_buffer_hole_p50_ms": sw["seam_buffer_hole_ms"].get("p50"),
        "seam_dropped_frames_p50": sw["seam_dropped_source_frames"].get("p50"),
        "landed_on_group_start": sw["landed_on_group_start"],
        "landed_on_keyframe": sw["landed_on_keyframe"],
        "landed_on_keyframe_known": sw["landed_on_keyframe_known"],
        "presented_switches": sw["presented"],
        "landed_behind_playhead": sw.get("landed_behind_playhead"),
        "superseded": sw["superseded"], "superseded_frac": sw["superseded_frac"],
        "open_switches": sw["open"], "failed_switches": sw["failed"],
        "abs_playback_jump_p95_ms": sw["abs_playback_position_jump_ms"].get("p95"),
        "viewer_pause_p95_ms": sw["viewer_pause_ms"].get("p95"),
        "followed_within_window": s["feedback"]["summary"]["followed_within_window"],
        "followed_by_latency_trend": s["feedback"]["summary"]["followed_within_window_by_latency_trend"],
        "initial_live_edge_mean_ms": ts_["initial_window"]["live_edge_distance_ms"].get("mean"),
        "time_to_half_shift_ms": ts_["time_to_half_shift_ms"],
        "half_shift_lost": ts_.get("half_shift_lost"),
        "advancing_fraction": s["playback"]["advancing_fraction"],
        "longest_no_progress_ms": s["playback"]["longest_no_progress_ms"],
        "longest_frozen_with_data_ms": s["playback"].get("longest_frozen_with_data_ms"),
        "session_destroyed": sw["session_destroyed"],
        "detection_reliable": s["detection_reliable"],
        "down_reaction_ms": rx["down_reaction_ms"],
        "up_recovery_ms": rx["up_recovery_ms"],
        "reaction_na_reason": rx.get("reaction_na_reason"),
        "data_starved_ms": s["starvation"]["total_ms"],
        "data_starved_raw_ms": s["starvation"].get("raw_total_ms"),
        "gap_seeks": stl["gap_seeks"],
        "range_jumps_deferred": stl["range_jumps_deferred"],
        "slow_start_vetoes": s["switching"].get("slow_start_vetoes"),
        "up_guard_vetoes": s["switching"]["up_guard_vetoes"],
        "up_dwell_vetoes": s["switching"].get("up_dwell_vetoes"),
        "other_gated": sum((s["switching"].get("other_gated") or {}).values()),
        "phantom_switches": s["switching"].get("phantom_switches"),
        "skipped_attempts": s["switches"].get("skipped_attempts"),
        "probes_discarded": s["switching"]["probes_discarded"],
        "media_errors": len(s["media_errors"]),
        "presented_rung_mean": br.get("presented_rung_mean"), "presented_kbps": br.get("presented_kbps"),
        "subscribed_rung_mean": br.get("subscribed_rung_mean"), "subscribed_kbps": br.get("subscribed_kbps"),
        "fit_share_low": sh.get("fit_share_low"), "pre_drop_share_after_restore": sh.get("pre_drop_share_after_restore"),
        "pre_drop_rung": sh.get("pre_drop_rung"), "rung_at_drop": sh.get("rung_at_drop"), "fit_rung": sh.get("fit_rung"),
        "truncated_groups": s["delivery"]["truncated_groups"],
        "discarded_objects": s["discarded"]["objects"],
        "discarded_mb": s["discarded"]["bytes"] / 1e6,
        "probe_mbps": s["link"]["probe_mbps"],
        "probe_measured_min_mbps": s["link"].get("probe_measured_mbps", {}).get("min"),
        "conn_loss_rate": s.get("conn", {}).get("loss_rate"),
        "conn_cwnd_min_bytes": s.get("conn", {}).get("cwnd_bytes", {}).get("min"),
        "conn_congestion_events": s.get("conn", {}).get("congestion_events"),
        "probe_measured_p50_mbps": s["link"].get("probe_measured_mbps", {}).get("p50"),
        "down_t2_ms": rx["down_t2_ms"], "down_t4_ms": rx["down_t4_ms"], "up_t2_ms": rx["up_t2_ms"],
        "down_reliable": rx["down_reliable"], "up_reliable": rx["up_reliable"],
        "retained_live_edge_ms": ts_.get("retained_live_edge_ms"),
        "min_live_edge_ms": ts_.get("min_live_edge_ms"),
        "send_recv_latency_p50_ms": s["link"]["send_recv_latency_ms"].get("p50"),
        "shift_err_mean_ms": ts_["signed_error_ms"].get("mean"),
        "shift_abs_err_p95_ms": ts_["abs_error_ms"].get("p95"),
        "live_edge_mean_ms": ts_["live_edge_distance_ms"].get("mean"),
        "live_edge_after_window_ms": ts_["live_edge_after_window_ms"].get("mean"),
        "buffer_mean_s": ts_["buffer_s"].get("mean"),
        "cache_max_bytes": s["cache"]["total_max_bytes"],
        "relay_max_rss_mb": (s["process"].get("relay", {}).get("max_rss_bytes") or 0) / 1e6 or None,
    })
    return row


# Condition key: everything that must never be pooled. controller_params is part of it
# because the arm name "grid" was used before and after the probe cap was added
# (2026-09-30); qdisc and the relay's congestion controller are factors of the 2026-10
# grid (tail-drop vs fq_codel, cubic vs bbr).
CONDITION_KEYS = ["mechanism", "mechanism_mode", "controller", "controller_params", "abr_overrides", "client_type", "delay_groups",
                  "network_profile", "qdisc", "congestion_controller", "background_flows", "ladder_id"]


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
    median, IQR and a bootstrap 95 % CI of the median for each metric column.
    Censored columns (``*_ms``, None = never) become ``<name>_n`` (runs with the event),
    ``<name>_of`` (applicable runs), ``<name>_median_s`` (over the runs with the event) and
    ``<name>_median_censored_s`` (never = inf, the number to report); Bernoulli columns
    report ``_frac`` and ``_of`` only, never a median."""
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(r.get(k) for k in CONDITION_KEYS), []).append(r)
    out = []
    for key, members in sorted(groups.items(), key=lambda kv: str(kv[0])):
        rec: dict = dict(zip(CONDITION_KEYS, key))
        rec["n"] = len(members)
        for m in METRIC_COLUMNS:
            if m in FRACTION_COLUMNS:
                vals = [r[m] for r in members if r.get(m) is not None]
                rec[f"{m}_frac"] = (sum(1 for v in vals if v) / len(vals)) if vals else None
                rec[f"{m}_of"] = len(vals)
                continue
            if m in CENSORED_COLUMNS:
                # Applicability: a run where the metric is not defined (live-edge client for
                # time to half shift; reaction N/A) is left out before censoring.
                if m == "time_to_half_shift_ms":
                    app = [r for r in members if r.get("half_shift_lost") is not None]
                else:
                    app = [r for r in members if not r.get("reaction_na_reason")]
                c = censored_summary([(r[m] / 1000) if r.get(m) is not None else None for r in app])
                base = m.removesuffix("_ms")
                rec[f"{base}_n"], rec[f"{base}_of"] = c["n"], c["of"]
                rec[f"{base}_median_s"], rec[f"{base}_median_censored_s"] = c["median_s"], c["median_censored_s"]
                continue
            vals = [r[m] for r in members if r.get(m) is not None and not isinstance(r[m], str)]
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
    ap.add_argument("--sustain", type=float, default=5.0,
                    help="seconds the presented rung must hold for down-reaction / up-recovery")
    ap.add_argument("--include-invalid", action="store_true",
                    help="keep runs whose validation did not pass (invalid, aborted or not validated) in the aggregate CSV/stats")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    rows = []
    excluded = []
    for run in args.runs:
        if not run.is_dir():
            continue
        s = analyze(run, args.t1_tolerance, args.offset_tolerance, args.offset_hold,
                    args.initial_window, args.reversal_window, args.feedback_window, args.sustain)
        s["validity"] = read_validity(run)
        (run / "summary.json").write_text(json.dumps(s, indent=2, default=str))
        md = to_markdown(s)
        (run / "summary.md").write_text(md)
        write_switch_windows(run, s)
        if not args.quiet:
            print(md)
        if not is_valid(s["validity"]) and not args.include_invalid:
            excluded.append((run.name, s["validity"]["reasons"]))
            continue
        rows.append(agg_row(s))
    for name, reasons in excluded:
        print(f"excluded run {name} (validation not passed): {reasons}")
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
                                      "switch_visibility_delay_p50_ms", "presented_rung_mean")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
