"""Tests for experiments/analyze.py, compare.py and validate.py (stdlib unittest).

    python3 -m unittest discover -s experiments/tests -t .     # from the repository root

Each synthetic test reproduces one finding of docs/audit-2026-10-04.md as it
appeared before the fix (the assertion names the finding). Set
MOQTAIL_ANALYZE_DIR to a directory holding another analyze.py to run the same
tests against it (the audit's reproduction step).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPERIMENTS = HERE.parent
sys.path.insert(0, os.environ.get("MOQTAIL_ANALYZE_DIR", str(EXPERIMENTS)))

import analyze  # noqa: E402
import compare  # noqa: E402
import plot  # noqa: E402  (matplotlib is imported lazily in plot.main)

T0 = 1_700_000_000_000.0  # STARTUP wall clock, ms
LADDER = [
    {"track": "video-240p-150k", "bitrate": 150_000},
    {"track": "video-360p-200k", "bitrate": 200_000},
    {"track": "video-480p-500k", "bitrate": 500_000},
    {"track": "video-720p-1200k", "bitrate": 1_200_000},
    {"track": "video-1080p-4000k", "bitrate": 4_000_000},
]
R = [t["track"] for t in LADDER]  # R[i] = track of rung i
REAL_RUN_NAME = "20261003T030600Z_native_shift10s_step_down_up_bg0_r3_ctl-grid"


def _find_real_run() -> Path | None:
    """The fresh-grid-v2 bundle is not tracked by git: look for it in $MOQTAIL_FGV2_RESULTS,
    then in `results-linux-2026-10-01/` of the repository or of any parent directory (a git
    worktree under .claude/worktrees/ finds the main checkout's copy). Read-only: analyze()
    writes nothing."""
    env = os.environ.get("MOQTAIL_FGV2_RESULTS")
    roots = [Path(env)] if env else []
    roots += [p / "results-linux-2026-10-01" / "fresh-grid-v2" / "results" for p in EXPERIMENTS.parents]
    for root in roots:
        if (root / REAL_RUN_NAME / "client-events.jsonl").exists():
            return root / REAL_RUN_NAME
    return None


REAL_RUN = _find_real_run()


def ev(event: str, ts: float, **fields) -> dict:
    rec = {"ts": ts, "src": "client", "event": event, "session": 1}
    rec.update(fields)
    return rec


def runner(event: str, ts: float, **fields) -> dict:
    rec = {"ts": ts, "src": "runner", "event": event}
    rec.update(fields)
    return rec


def samples(start: float, end: float, track_at, playhead_at=None, presented_at=None, step: float = 250.0) -> list[dict]:
    """SAMPLE every `step` ms; `track_at(t)` gives the subscribed track, `playhead_at(t)` the
    playhead (default: advancing with wall time), `presented_at(t)` SAMPLE.presented_track."""
    out = []
    t = start
    while t <= end:
        tr = track_at(t)
        rec = ev("SAMPLE", t, track=tr, bitrate_kbps=next(x["bitrate"] for x in LADDER if x["track"] == tr) / 1000,
                 playhead_ms=(playhead_at(t) if playhead_at else (t - T0)), buffer_s=5.0,
                 live_edge_distance_ms=10_000.0, time_shift_error_ms=0.0)
        if presented_at is not None:
            rec["presented_track"] = presented_at(t)
        out.append(rec)
        t += step
    return out


def write_run(tmp: Path, client: list[dict], runner_recs: list[dict] | None = None, profile: str = "step_down_up",
              client_mode: str = "time-shifted", target_shift_ms: int = 10_000, startup_track: str = R[0],
              duration_s: float = 200.0, identity_extra: dict | None = None, validation: dict | None = None,
              relay_recs: list[dict] | None = None, meta_extra: dict | None = None, client_meta_extra: dict | None = None) -> Path:
    meta = ev("RUN_META", T0 - 100, client_mode=client_mode, time_shift_s=target_shift_ms / 1000, delay_groups=target_shift_ms // 1000,
              target_shift_ms=target_shift_ms, gop_duration_ms=1000, startup_track=startup_track, ladder=LADDER,
              **(client_meta_extra or {}))
    recs = [meta] + sorted(client, key=lambda r: r["ts"])
    (tmp / "client-events.jsonl").write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    (tmp / "runner-events.jsonl").write_text("\n".join(json.dumps(r) for r in (runner_recs or [])) + "\n")
    if relay_recs:
        (tmp / "relay-events.jsonl").write_text("\n".join(json.dumps(r) for r in relay_recs) + "\n")
    identity = {"run_id": tmp.name, "git_sha": "0" * 40, "branch": "harness", "ladder_id": "test", "timestamp_start": "20261004T000000Z",
                "mechanism": "native", "mechanism_mode": None, "controller": "min", "client_type": client_mode,
                "delay_groups": target_shift_ms // 1000, "gop_duration_ms": 1000, "network_profile": profile, "qdisc": "tail-drop",
                "background_flows": 0, "repeat_index": 0, "duration_s": duration_s}
    identity.update(identity_extra or {})
    meta_json = {"run_id": tmp.name, "identity": identity, "profile": {"name": profile},
                 "args": {"duration": duration_s}, "net_backend": "netns"}
    meta_json.update(meta_extra or {})
    (tmp / "run_meta.json").write_text(json.dumps(meta_json))
    if validation is not None:
        (tmp / "validation.json").write_text(json.dumps(validation))
    return tmp


def startup(track: str = R[0]) -> list[dict]:
    return [ev("CONNECT_START", T0 - 1200), ev("FIRST_OBJECT", T0 - 50, track=track, group=13, object=0, expected_start_group=13, clamped=False),
            ev("STARTUP", T0, track=track, playhead_ms=0, startup_delay_ms=1200.0)]


def switch(seq: int, ts: float, frm: str, to: str, land_after_ms: float | None = 500.0, with_seq: bool = False,
           rule_reason: str = "throughput", decided_before_ms: float = 1.0, decision: str = "landing",
           decision_seq: bool | None = None) -> list[dict]:
    """One switch as the player and controller log it. The controller decides at
    ``ts - decided_before_ms`` and logs ABR_DECISION only when the switch LANDS (at
    SWITCH_APPLIED, with ``decided_ts`` and ``landed_after_ms``; ``switch_seq`` too when
    ``decision_seq``, default ``with_seq``). ``decision="legacy"`` reproduces clients
    before 2026-10-04 (ABR_DECISION at the decision, no decided_ts); ``"none"`` omits it."""
    extra = {"switch_seq": seq} if with_seq else {}
    reason = "auto-upgrade" if R.index(to) > R.index(frm) else "auto-downgrade"
    decided = ts - decided_before_ms
    out = [ev("SWITCH_SENT", ts, **{"from": frm, "to": to, "request_id": seq * 2, "old_request_id": seq * 2 - 2, "playhead_ms": ts - T0}, **extra),
           ev("SWITCH_OK", ts + 50, to=to, request_id=seq * 2, rtt_ms=50, **extra)]
    if decision == "legacy":
        out.append(ev("ABR_DECISION", decided, **{"from": frm, "to": to, "reason": reason, "rule_reason": rule_reason}))
    if land_after_ms is not None:
        out += [ev("SWITCH_FIRST_OBJECT", ts + land_after_ms, **{"from": frm, "to": to, "group": 20 + seq, "object": 0, "since_sent_ms": land_after_ms,
                                                                 "landed_on_keyframe": True}, **extra),
                ev("SWITCH_APPLIED", ts + land_after_ms + 1, **{"from": frm, "to": to, "group": 20 + seq, "object": 0, "media_seam_gap_ms": 0,
                                                              "seam_ahead_of_playhead_ms": 9000, "landed_on_group_start": True, "landed_on_keyframe": True,
                                                              "since_sent_ms": land_after_ms + 1}, **extra)]
        if decision == "landing":
            dseq = {"switch_seq": seq} if (with_seq if decision_seq is None else decision_seq) else {}
            out.append(ev("ABR_DECISION", ts + land_after_ms + 1, **{"from": frm, "to": to, "reason": reason, "rule_reason": rule_reason,
                                                                    "decided_ts": decided, "landed_after_ms": ts + land_after_ms + 1 - decided}, **dseq))
    return out


def first_frame(ts: float, frm: str, to: str, vis_ms: float, seq: int | None = None, pause_ms: float = 3.0) -> dict:
    extra = {"switch_seq": seq} if seq is not None else {}
    return ev("SWITCH_FIRST_FRAME", ts, **{"from": frm, "to": to, "switch_visibility_delay_ms": vis_ms, "playback_position_jump_ms": 0.0,
                                           "viewer_pause_ms": pause_ms, "seam_buffer_hole_ms": 0, "seam_pts_ms": 1000, "presented_pts_ms": 1000}, **extra)


class TmpRun(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name) / "run"
        self.dir.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()


class SwitchIdentity(TmpRun):
    """C1: SWITCH_FIRST_FRAME joined to the wrong switch when targets repeat."""

    def test_fallback_join_repeated_targets(self):
        A, B = R[0], R[4]
        client = startup(A)
        client += switch(1, T0 + 1000, A, B)      # lands at +1500
        client += switch(2, T0 + 2000, B, A)      # lands at +2500 -> overwrites seam of #1
        client += switch(3, T0 + 3000, A, B)      # lands at +3500 -> overwrites seam of #2
        client.append(first_frame(T0 + 5000, A, B, vis_ms=2000.0))   # belongs to #3 only
        client += samples(T0, T0 + 8000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]["list"]
        # C1 before the fix: switch #1 also claimed the first frame (visibility 4000 ms),
        # superseded was 1 (only #2) and the visibility / pause stats had n=2.
        self.assertIsNone(sw[0]["switch_visibility_delay_ms"])
        self.assertEqual(s["switches"]["superseded"], 2)
        self.assertEqual(s["switches"]["switch_visibility_delay_ms"]["n"], 1)
        self.assertEqual(s["switches"]["switch_visibility_delay_ms"]["p50"], 2000.0)
        self.assertEqual(s["switches"]["viewer_pause_ms"]["n"], 1)
        self.assertEqual([x["terminal"] for x in sw], ["superseded", "superseded", "first_frame"])
        self.assertEqual([x["superseded_by"] for x in sw], [2, 3, None])

    def test_visibility_from_record_field(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B)
        client.append(first_frame(T0 + 4000, A, B, vis_ms=2750.0))  # wall clock says 3000, record says 2750
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual(s["switches"]["list"][0]["switch_visibility_delay_ms"], 2750.0)

    def test_switch_seq_join_and_superseded_record(self):
        A, B = R[0], R[4]
        client = startup(A)
        client += switch(1, T0 + 1000, A, B, with_seq=True)
        client += switch(2, T0 + 2000, B, A, with_seq=True)
        client += switch(3, T0 + 3000, A, B, with_seq=True)
        client += switch(4, T0 + 4000, B, R[2], land_after_ms=None, with_seq=True)
        client.append(ev("SWITCH_SUPERSEDED", T0 + 2500, switch_seq=1, by_switch_seq=2, playhead_ms=1500))
        client.append(ev("SWITCH_SUPERSEDED", T0 + 3500, switch_seq=2, by_switch_seq=3, playhead_ms=2500))
        # The first frame record of #3 arrives after #4 was sent; with switch_seq it still joins #3.
        client.append(first_frame(T0 + 4500, A, B, vis_ms=1500.0, seq=3))
        client.append(ev("SWITCH_ERROR", T0 + 4100, to=R[2], request_id=8, reason="relay refused", switch_seq=4))
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]["list"]
        self.assertTrue(s["switches"]["join"]["seq_join"])
        self.assertEqual([x["terminal"] for x in sw], ["superseded", "superseded", "first_frame", "error"])
        self.assertEqual([x["terminal_source"] for x in sw], ["record", "record", "record", "record"])
        self.assertEqual([x["superseded_by"] for x in sw], [2, 3, None, None])
        self.assertEqual(s["switches"]["failed"], 1)

    def test_every_switch_has_exactly_one_terminal(self):
        A, B = R[0], R[4]
        client = startup(A)
        client += switch(1, T0 + 1000, A, B) + switch(2, T0 + 2000, B, A) + switch(3, T0 + 3000, A, B)
        client += switch(4, T0 + 7000, B, A, land_after_ms=None)  # open: run ended before it landed
        client.append(first_frame(T0 + 5000, A, B, vis_ms=2000.0))
        client += samples(T0, T0 + 8000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        t = s["switches"]["terminals"]
        self.assertEqual(set(t), set(analyze.TERMINALS))
        self.assertEqual(sum(t.values()), s["switches"]["count"])
        self.assertEqual(t["open"], 1)
        self.assertEqual(s["switches"]["superseded_frac"], 2 / 4)


class SkippedAttempts(TmpRun):
    """D7: SWITCH_SKIPPED is emitted WITHOUT a SWITCH_SENT and with its own switch_seq (an
    attempt, not a switch); there is no `skipped` terminal."""

    def test_skipped_is_an_attempt_not_a_terminal(self):
        A, B = R[0], R[4]
        self.assertNotIn("skipped", analyze.TERMINALS)
        client = startup(A) + switch(1, T0 + 1000, A, B, with_seq=True)
        client.append(first_frame(T0 + 3000, A, B, vis_ms=2000.0, seq=1))
        client.append(ev("SWITCH_SKIPPED", T0 + 1200, switch_seq=2, **{"from": A, "to": R[2]}, reason="previous switch not landed",
                         pending_request_id=2))
        # A SKIPPED record that reuses a sent switch's seq (contract violation) still ends nothing.
        client += switch(3, T0 + 4000, B, A, with_seq=True)
        client.append(ev("SWITCH_SKIPPED", T0 + 4100, switch_seq=3, **{"from": B, "to": A}, reason="previous switch not landed",
                         pending_request_id=6))
        client.append(first_frame(T0 + 6000, B, A, vis_ms=2000.0, seq=3))
        client += samples(T0, T0 + 8000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]
        self.assertEqual(sw["count"], 2)
        self.assertEqual([x["terminal"] for x in sw["list"]], ["first_frame", "first_frame"])   # before: #3 was `skipped`
        self.assertEqual(set(sw["terminals"]), set(analyze.TERMINALS))
        self.assertEqual((sw["skipped_not_sent"], sw["skipped_attempts"]), (2, 2))


class SeamHole(TmpRun):
    """D8: buffer_hole_behind_ms was filled from seam_buffer_hole_ms, and the analyzer's 100 ms
    rule overrode the player's own seam attribution on new bundles."""

    def run_with(self, ff_fields: dict) -> dict:
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B, with_seq=True)
        ff = first_frame(T0 + 3000, A, B, vis_ms=2000.0, seq=1)
        ff.update(ff_fields)
        client.append(ff)
        client += samples(T0, T0 + 6000, lambda t: A)
        return analyze.analyze(write_run(self.dir, client))["switches"]["list"][0]

    def test_new_bundle_uses_the_players_attribution(self):
        x = self.run_with({"seam_buffer_hole_ms": 250, "buffer_hole_behind_ms": 600, "seam_pts_ms": 1000,
                           "presented_pts_ms": 1040, "seam_behind_playhead": False})
        self.assertEqual(x["seam_buffer_hole_ms"], 250)     # before: 0 (presented within 100 ms of the seam)
        self.assertEqual(x["buffer_hole_behind_ms"], 600)   # before: 250 (copied from seam_buffer_hole_ms)
        self.assertEqual(x["seam_hole_rule"], "player")

    def test_player_attribution_without_seam_behind_playhead(self):
        # Clients from 2026-10-02 (fresh-grid-v2) already attributed the hole and reported the raw
        # one as buffer_hole_behind_ms, before seam_behind_playhead existed.
        x = self.run_with({"seam_buffer_hole_ms": 250, "buffer_hole_behind_ms": 250, "seam_pts_ms": 1000, "presented_pts_ms": 1000})
        self.assertEqual((x["seam_buffer_hole_ms"], x["seam_hole_rule"]), (250, "player"))   # before: 0

    def test_old_bundle_keeps_the_100_ms_rule(self):
        x = self.run_with({"seam_buffer_hole_ms": 250, "seam_pts_ms": 1000, "presented_pts_ms": 1040})
        self.assertEqual(x["seam_buffer_hole_ms"], 0)
        self.assertEqual(x["buffer_hole_behind_ms"], 250)   # old clients reported the raw hole as seam_buffer_hole_ms
        self.assertEqual(x["seam_hole_rule"], "analyzer-100ms")


class GatedAndPhantom(TmpRun):
    """D11: ABR_GATED was counted as one number (switches.gated_slow_start = every ABR_GATED);
    up-dwell vetoes and phantom switches were not counted at all."""

    def test_gated_per_why_and_phantoms(self):
        A, B = R[0], R[4]
        client = startup(A)
        for i, why in enumerate(["slow-start", "slow-start", "post-switch-up-guard", "up-dwell", "up-dwell", "up-dwell", "novel"]):
            client.append(ev("ABR_GATED", T0 + 100 * (i + 1), why=why, from_index=0, to_index=4))
        client.append(ev("ABR_GATED", T0 + 900, from_index=0, to_index=4))   # pre-`why` clients: slow-start
        for i in range(2):
            client.append(ev("ABR_SWITCH_PHANTOM", T0 + 2000 + i, **{"from": A, "to": B, "landed": A, "reason": "auto-upgrade",
                                                                    "rule_reason": "throughput", "decided_ms_ago": 10}))
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switching"]
        self.assertEqual((sw["slow_start_vetoes"], sw["up_guard_vetoes"], sw["up_dwell_vetoes"]), (3, 1, 3))
        self.assertEqual(sw["other_gated"], {"novel": 1})
        self.assertEqual(sw["phantom_switches"], 2)
        self.assertEqual(s["switches"]["gated_slow_start"], 3)        # before: 8 (every ABR_GATED)
        rows = {name: fn for name, fn, _ in compare.ROWS}
        self.assertEqual(rows["up-dwell vetoes"](s), 3)
        self.assertEqual(rows["slow-start vetoes"](s), 3)
        self.assertEqual(rows["other gated (any other why)"](s), 1)
        self.assertEqual(rows["phantom switches (never landed)"](s), 2)
        self.assertEqual(rows["skipped attempts (not sent)"](s), 0)


class ClientConnection(TmpRun):
    """R3-D8: the client's QUIC connection in CONN_STATS was 'the one with the most bytes sent',
    and its summaries included the relay's 10 s shutdown drain after RUN_END."""

    @staticmethod
    def conn_stats(conn: int, t: float, *, rtt: float, tx: int, lost: int, sent: int, cwnd: int = 30_000) -> dict:
        return {"ts": t, "src": "relay", "event": "CONN_STATS", "conn": conn, "rtt_ms": rtt, "cwnd": cwnd, "udp_tx_bytes": tx,
                "udp_tx_datagrams": sent, "udp_tx_ios": sent, "lost_packets": lost, "sent_packets": sent, "congestion_events": lost,
                "pacer_rate_bps": cwnd * 8 * 1.25 / (rtt / 1000)}

    def test_client_conn_by_id_and_run_window(self):
        client = startup() + samples(T0, T0 + 60_000, lambda t: R[0])
        relay = [{"ts": T0 - 1000, "src": "relay", "event": "SUBSCRIBE_RECV", "conn": 11, "request_id": 2, "track": "moqtail/" + R[0]},
                 {"ts": T0 - 1500, "src": "relay", "event": "SUBSCRIBE_RECV", "conn": 11, "request_id": 0, "track": "moqtail/catalog"}]
        for i in range(-3, 71):
            t = T0 + i * 1000
            phase = "pre" if i < 0 else "run" if t <= T0 + 60_000 else "drain"
            # conn 11 (the client): 100 sent / 5 lost before STARTUP, then 1000 sent / 10 lost in the run,
            # then the drain with a 400 ms RTT and heavy loss.
            sent = {"pre": 100, "run": 100 + 1000 * i // 60, "drain": 1100 + 10 * (i - 60)}[phase]
            lost = {"pre": 5, "run": 5 + 10 * i // 60, "drain": 15 + 10 * (i - 60)}[phase]
            relay.append(self.conn_stats(11, t, rtt={"pre": 40.0, "run": 40.0, "drain": 400.0}[phase], tx=sent * 1200, lost=lost, sent=sent))
            # conn 12 (not the client: the publisher's connection in this test) sends more bytes.
            relay.append(self.conn_stats(12, t, rtt=2.0, tx=10_000_000 + i, lost=0, sent=10_000 + i))
        run = [runner("RUN_END", T0 + 60_000, elapsed_s=61.0)]
        s = analyze.analyze(write_run(self.dir, client, run, duration_s=61.0, relay_recs=relay))
        c = s["conn"]
        self.assertEqual((c["conn_id"], c["conn_source"]), (11, "relay_records"))    # before: conn 12 (most bytes)
        self.assertEqual(c["rtt_ms"]["max"], 40.0)                                   # the drain's 400 ms excluded
        self.assertEqual((c["lost_packets"], c["sent_packets"]), (10, 1000))         # within [STARTUP, RUN_END]
        self.assertAlmostEqual(c["loss_rate"], 0.01)

    def test_old_bundle_falls_back_to_most_bytes(self):
        client = startup() + samples(T0, T0 + 10_000, lambda t: R[0])
        relay = [self.conn_stats(c, T0 + i * 1000, rtt=40.0, tx=(i + 1) * (1000 if c == 12 else 10), lost=0, sent=i + 1)
                 for i in range(10) for c in (11, 12)]
        s = analyze.analyze(write_run(self.dir, client, relay_recs=relay))
        self.assertEqual((s["conn"]["conn_id"], s["conn"]["conn_source"]), (12, "most_bytes"))


class Censoring(unittest.TestCase):
    """M19: censored metrics summarised by the median of the runs where the event happened."""

    def test_censored_summary_never_is_inf(self):
        c = analyze.censored_summary([10.0, None, None, 20.0, None])
        self.assertEqual((c["n"], c["of"]), (2, 5))
        self.assertEqual(c["median_s"], 15.0)          # the survivorship-biased number (the old row)
        self.assertTrue(math.isinf(c["median_censored_s"]))
        c = analyze.censored_summary([10.0, 20.0, None])
        self.assertEqual(c["median_censored_s"], 20.0)
        self.assertEqual(analyze.censored_summary([])["of"], 0)

    def test_condition_stats_censored_and_fraction_columns(self):
        base = {k: None for k in analyze.AGG_COLUMNS}
        base.update({"mechanism": "native", "client_type": "time-shifted", "network_profile": "step_down_up"})
        rows = []
        for tths, lost in ((60_000, True), (None, False), (None, False)):
            r = dict(base)
            r.update({"time_to_half_shift_ms": tths, "half_shift_lost": lost})
            rows.append(r)
        c = analyze.condition_stats(rows)[0]
        self.assertEqual((c["time_to_half_shift_n"], c["time_to_half_shift_of"]), (1, 3))
        self.assertEqual(c["time_to_half_shift_median_s"], 60.0)
        self.assertTrue(math.isinf(c["time_to_half_shift_median_censored_s"]))
        # No median of a Bernoulli: the fraction.
        self.assertAlmostEqual(c["half_shift_lost_frac"], 1 / 3)
        self.assertNotIn("half_shift_lost_median", c)

    def test_compare_cells(self):
        self.assertEqual(compare.cell("censored", [10.0, None, 20.0], 12).strip(), "2/3 20.0")
        self.assertEqual(compare.cell("censored", [None, None, 5.0], 12).strip(), "1/3 inf")
        # No median of a Bernoulli: a fraction k/n.
        self.assertEqual(compare.cell("frac", [True, False, True], 14).strip(), "2/3 (0.67)")
        self.assertEqual(compare.cell("median", [1.0, 3.0, None], 8).strip(), "2.00")

    def test_not_applicable_runs_leave_the_denominator(self):
        live = {"time_shift": {"half_shift_lost": None, "time_to_half_shift_ms": None}}
        shifted_never = {"time_shift": {"half_shift_lost": False, "time_to_half_shift_ms": None}}
        shifted_lost = {"time_shift": {"half_shift_lost": True, "time_to_half_shift_ms": 60_000}}
        fn = dict((n, f) for n, f, _ in compare.ROWS)["time to half shift s (k/n, never=inf)"]
        vals = [fn(s) for s in (live, shifted_never, shifted_lost)]
        vals = [v for v in vals if v is not compare.NA]
        self.assertEqual(compare.cell("censored", vals, 12).strip(), "1/2 inf")


class PresentedRung(TmpRun):
    """M13: 'played rung' measured the subscribed track (SAMPLE.track switches at landing)."""

    def test_presented_from_first_frame_transitions(self):
        A, B = R[0], R[4]
        client = startup(A)
        client += switch(1, T0 + 9_500, A, B)                       # lands at +10 s: SAMPLE.track flips to B
        client.append(first_frame(T0 + 20_000, A, B, vis_ms=10_500.0))  # visible only at +20 s
        client += samples(T0, T0 + 40_000, lambda t: B if t >= T0 + 10_000 else A)
        s = analyze.analyze(write_run(self.dir, client))
        br = s["bitrate"]
        # M13 before the fix: the only "played" rung was the subscribed one (3.0 here).
        self.assertAlmostEqual(br.get("presented_rung_mean", br.get("mean_rung_index")), 4 * 20 / 40, places=1)
        self.assertEqual(br["presented_source"], "first_frame")
        self.assertAlmostEqual(br["subscribed_rung_mean"], 4 * 30 / 40, places=1)   # the old number
        self.assertAlmostEqual(br["presented_rung_mean"], 4 * 20 / 40, places=1)
        self.assertLess(br["presented_rung_mean"], br["subscribed_rung_mean"])
        self.assertEqual(br["mean_rung_index"], br["subscribed_rung_mean"])  # legacy alias is the old value

    def test_presented_track_from_sample_when_present(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 9_500, A, B)
        client.append(first_frame(T0 + 20_000, A, B, vis_ms=10_500.0))
        client += samples(T0, T0 + 40_000, lambda t: B if t >= T0 + 10_000 else A,
                          presented_at=lambda t: B if t >= T0 + 25_000 else A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual(s["bitrate"]["presented_source"], "sample")
        self.assertAlmostEqual(s["bitrate"]["presented_rung_mean"], 4 * 15 / 40, places=1)

    def test_only_advancing_playhead_time_counts(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 500, A, B)
        client.append(first_frame(T0 + 1000, A, B, vis_ms=500.0))
        # 10 s at B advancing, then 10 s at B frozen (stalled samples must not count as presented).
        client += samples(T0 + 1000, T0 + 21_000, lambda t: B, playhead_at=lambda t: min(t - T0, 11_000))
        s = analyze.analyze(write_run(self.dir, client))
        self.assertAlmostEqual(s["bitrate"]["presented_advancing_s"], 10.0, delta=0.5)
        self.assertAlmostEqual(s["bitrate"]["presented_kbps"], 4000.0, places=0)


class StallsAndSeeks(TmpRun):
    """M19: media skipped by seeks invisible; 15-30 ms blips counted as stalls; startup jump counted."""

    def test_media_skipped_gap_seeks_after_window(self):
        client = startup()
        client.append(ev("SEEK", T0 - 20, reason="startup", from_ms=0, to_ms=4000))
        client.append(ev("SEEK", T0 + 10, reason="range-jump", from_ms=4000, to_ms=13_000))      # positioning jump, in the window
        client.append(ev("SEEK", T0 + 20_000, reason="range-jump", from_ms=25_000, to_ms=27_000))  # 2000 ms
        client.append(ev("SEEK", T0 + 30_000, reason="unwedge", from_ms=23_999.999, to_ms=24_001))  # 1.001 ms
        client.append(ev("SEEK", T0 + 40_000, reason="gap", from_ms=50_000, to_ms=50_500, gap_ms=500, deferred_ms=1000))
        client.append(ev("SEEK", T0 + 50_000, reason="wedge", from_ms=60_000, to_ms=61_000, gap_ms=1000))
        client += samples(T0, T0 + 60_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        st = s["stalls"]
        # M19 before the fix: media skipped by gap seeks was not a metric at all (0 here).
        self.assertAlmostEqual(st.get("media_skipped_ms", 0), 2501.001, places=2)
        self.assertEqual(st["gap_seeks"], 3)             # the startup positioning jump is excluded
        self.assertEqual(st["wedge_skipped_ms"], 1000)
        self.assertEqual(st["seeks"], {"startup": 1, "gap": 4, "wedge": 1, "visibility": 0})
        self.assertEqual(st["range_jump_deferred_ms_total"], 1000)

    def test_stall_blips_separate(self):
        client = startup()
        for start, dur in ((T0 - 500, 400), (T0 + 1000, 30), (T0 + 5000, 500), (T0 + 9000, 20)):
            client.append(ev("STALL_START", start, cause="waiting", playhead_ms=0, track=R[0]))
            client.append(ev("STALL_END", start + dur, cause="waiting", playhead_ms=0, duration_ms=dur))
        client += samples(T0, T0 + 12_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        st = s["stalls"]
        self.assertEqual((st["count"], st["total_ms"], st["max_ms"]), (1, 500, 500))   # before: count 3, total 550
        self.assertEqual((st["blips"], st["blips_ms"]), (2, 50))
        self.assertEqual(st["all_count"], 3)   # the pre-startup episode is excluded
        self.assertEqual(s["starvation"]["subset_of"], "stalls.total_ms")

    def test_frozen_stall_starts_at_end_minus_duration(self):
        # D5: the player backdates a `frozen` stall to the first frozen watchdog tick, so its
        # STALL_START is logged ~0.5-1 s after the stall began; STALL_END.duration_ms is exact.
        client = startup()
        client.append(ev("DATA_STARVED", T0 + 9000, since_last_append_ms=4000, track=R[0]))
        client.append(ev("DATA_RESUMED", T0 + 9800, starved_ms=4800))
        client.append(ev("STALL_START", T0 + 10_000, cause="frozen", playhead_ms=9500, track=R[0]))
        client.append(ev("STALL_END", T0 + 12_000, cause="frozen", playhead_ms=9500, duration_ms=2500))
        client += samples(T0, T0 + 20_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        ep = s["stalls"]["episodes"][0]
        self.assertEqual(ep["ts"], T0 + 9500)            # before: T0 + 10_000 (STALL_START.ts)
        self.assertEqual(ep["duration_ms"], 2500)
        self.assertEqual(s["starvation"]["total_ms"], 300)   # [9500, 9800) overlaps the starvation episode; before: 0

    def test_reopened_frozen_stall_is_not_counted_twice(self):
        # The player's current output for one 7.0 s freeze (9.5-16.5 s) during which the element
        # fired `playing` without playhead progress: `playing` no longer ends a frozen episode, so
        # there is one STALL_START (logged at the confirming tick, 10.0 s) and one STALL_END at
        # the progress, credited from the first frozen tick.
        client = startup()
        client.append(ev("STALL_START", T0 + 10_000, cause="frozen", playhead_ms=9000, track=R[0]))
        client.append(ev("STALL_END", T0 + 16_500, cause="frozen", playhead_ms=9000, duration_ms=7000))
        client += samples(T0, T0 + 20_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        st = s["stalls"]
        self.assertEqual((st["count"], st["total_ms"], st["max_ms"]), (1, 7000, 7000))
        self.assertEqual(st["episodes"][0]["ts"], T0 + 9500)
        self.assertEqual(st["overlapping_merged"], 0)

    def test_old_bundle_overlapping_frozen_stalls_are_merged(self):
        # Old bundles (before F15, fresh-grid-v2 pr1378 shift10s r0): `playing` closed a frozen
        # stall while the watchdog still counted frozen ticks, which reopened it backdated to the
        # original freeze start. The two episodes overlap; the stalled time is their union
        # (7.0 s, not 13.5 s). The merge stays as a safety net for those bundles.
        client = startup()
        client.append(ev("STALL_START", T0 + 10_000, cause="frozen", playhead_ms=9000, track=R[0]))
        client.append(ev("STALL_END", T0 + 16_000, cause="frozen", playhead_ms=9000, duration_ms=6500))
        client.append(ev("STALL_START", T0 + 16_050, cause="frozen", playhead_ms=9000, track=R[0]))
        client.append(ev("STALL_END", T0 + 16_500, cause="frozen", playhead_ms=9000, duration_ms=7000))
        client += samples(T0, T0 + 20_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        st = s["stalls"]
        self.assertEqual((st["count"], st["total_ms"], st["max_ms"]), (1, 7000, 7000))
        self.assertEqual(st["overlapping_merged"], 1)

    def test_client_records_after_run_end_are_clipped(self):
        # D6: the browser keeps logging after the runner's RUN_END (teardown); those records
        # were counted in samples, the presented/subscribed weighting, playback and stalls.
        A, B = R[0], R[4]
        client = startup(A)
        client.append(ev("STALL_START", T0 + 58_000, cause="waiting", playhead_ms=58_000, track=A))
        client.append(ev("STALL_END", T0 + 64_000, cause="waiting", playhead_ms=58_000, duration_ms=6000))
        client.append(ev("STALL_START", T0 + 66_000, cause="waiting", playhead_ms=60_000, track=B))   # open, after RUN_END
        client.append(ev("SEEK", T0 + 67_000, reason="gap", from_ms=60_000, to_ms=63_000, gap_ms=3000))
        client += samples(T0, T0 + 80_000, lambda t: A if t <= T0 + 60_000 else B,
                          playhead_at=lambda t: (t - T0) if t <= T0 + 58_000 else 58_000 if t <= T0 + 64_000 else (t - T0) - 6000)
        run = [runner("RUN_END", T0 + 60_000, elapsed_s=61.0)]
        s = analyze.analyze(write_run(self.dir, client, run, duration_s=61.0))
        self.assertEqual(s["playback"]["samples"], 241)                       # before: 321 (to T0 + 80 s)
        self.assertAlmostEqual(s["bitrate"]["sampled_s"], 60.0, places=3)
        self.assertEqual(s["bitrate"]["subscribed_rung_mean"], 0)              # B only after RUN_END
        self.assertAlmostEqual(s["bitrate"]["presented_advancing_s"], 58.0, places=3)
        self.assertEqual((s["stalls"]["count"], s["stalls"]["total_ms"]), (1, 2000))   # before: 2 episodes, 6000 + 14000 ms
        self.assertFalse(s["stalls"]["open_at_end"])
        self.assertEqual(s["stalls"]["media_skipped_ms"], 0)

    def test_switches_per_minute_over_run_duration(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 10_000, A, B) + switch(2, T0 + 11_000, B, A)
        client += samples(T0, T0 + 55_000, lambda t: A)
        run = [runner("RUN_END", T0 + 60_000, elapsed_s=61.2)]
        s = analyze.analyze(write_run(self.dir, client, run, duration_s=61.2))
        self.assertAlmostEqual(s["switching"]["switches_per_minute"], 2.0, places=3)   # before: 120/min
        self.assertAlmostEqual(s["run_duration_s"], 60.0, places=3)
        self.assertEqual(s["switching"]["switch_span_s"], 1.0)


class SwitchesClippedAtRunEnd(TmpRun):
    """R4-D2: SWITCH_SENT after RUN_END were counted while the switches/min denominator ends at
    RUN_END. Only switches sent at or before RUN_END are switches of the run; the records of a
    dropped switch must not join an earlier switch or show up as unjoined/duplicate."""

    def _run(self, with_seq: bool) -> dict:
        A, B = R[0], R[4]
        seq = (lambda n: {"switch_seq": n}) if with_seq else (lambda n: {})
        client = startup(A)
        client += switch(1, T0 + 10_000, A, B, with_seq=with_seq)
        client.append(first_frame(T0 + 12_000, A, B, vis_ms=2000.0, seq=1 if with_seq else None))
        client += switch(2, T0 + 58_000, B, A, land_after_ms=None, with_seq=with_seq)   # open at the run end
        # After RUN_END (T0 + 60 s): switch 3 is sent, lands, is presented, and supersedes 2.
        client += switch(3, T0 + 61_000, A, B, with_seq=with_seq)
        client.append(first_frame(T0 + 61_800, A, B, vis_ms=800.0, seq=3 if with_seq else None))
        if with_seq:
            client.append(ev("SWITCH_SUPERSEDED", T0 + 61_050, switch_seq=2, by_switch_seq=3, landed=False))
        # An attempt after RUN_END that was never sent, and its phantom.
        client.append(ev("SWITCH_SKIPPED", T0 + 62_000, **{"from": B, "to": A, "reason": "previous switch not landed"}, **seq(4)))
        client.append(ev("ABR_SWITCH_PHANTOM", T0 + 62_000, **{"from": B, "to": A, "landed": B, "reason": "auto-downgrade",
                                                               "rule_reason": "throughput", "decided_ts": T0 + 61_999}, **seq(4)))
        client += samples(T0, T0 + 63_000, lambda t: A)
        run = [runner("RUN_END", T0 + 60_000, elapsed_s=61.0)]
        return analyze.analyze(write_run(self.dir, client, run, duration_s=61.0))

    def _check(self, s: dict) -> None:
        sw = s["switches"]
        self.assertEqual(sw["count"], 2)                                         # before: 3
        self.assertEqual([x["switch_seq"] for x in sw["list"]], [1, 2])
        self.assertAlmostEqual(s["switching"]["switches_per_minute"], 2.0, places=3)   # before: 3.0
        self.assertEqual(sw["terminals"]["first_frame"], 1)
        self.assertEqual(sw["terminals"]["open"], 1)                             # 2's superseder is outside the run
        self.assertEqual(sw["superseded_frac"], 0.0)
        self.assertEqual(s["switching"]["direction_reversals"], 0)              # before: 1 (2 -> 3, 3 s apart)
        self.assertEqual(sw["switch_visibility_delay_ms"]["n"], 1)              # before: 2 (3's 800 ms)
        unjoined = {k: v for k, v in sw["join"]["unjoined"].items()}
        self.assertEqual(unjoined, {})
        self.assertEqual(sw["join"]["duplicates"], {})
        self.assertEqual(sw["join"]["after_run_end"], 1)
        self.assertEqual((sw["skipped_attempts"], sw["skipped_not_sent"]), (0, 0))
        self.assertEqual(s["switching"]["phantom_switches"], 0)
        self.assertEqual((sw["decision_join"]["unjoined_decisions"], sw["decision_join"]["unjoined_phantoms"]), (0, 0))

    def test_switch_records_with_seq(self):
        self._check(self._run(with_seq=True))

    def test_switch_records_fallback_join(self):
        self._check(self._run(with_seq=False))


class Validity(TmpRun):
    """M20: aborted runs got no validation.json and were counted (`valid is None` passed `is False`)."""

    def test_aborted_marker_and_unvalidated_are_excluded(self):
        (self.dir / "validation.json").write_text(json.dumps({"passed": False, "failed": ["aborted"]}))
        v = analyze.read_validity(self.dir)
        self.assertIs(v["valid"], False)
        self.assertTrue(v["aborted"])
        self.assertFalse(analyze.is_valid(v))
        (self.dir / "validation.json").unlink()
        v = analyze.read_validity(self.dir)
        self.assertIsNone(v["valid"])
        self.assertFalse(analyze.is_valid(v))          # before: None passed the `is False` test
        (self.dir / "validation.json").write_text(json.dumps({"passed": True, "failed": []}))
        self.assertTrue(analyze.is_valid(analyze.read_validity(self.dir)))
        self.assertFalse(analyze.is_valid({"valid": True, "passed": False} | {"valid": None}))

    def test_condition_key_includes_qdisc_and_congestion_controller(self):
        for k in ("qdisc", "congestion_controller", "controller"):
            self.assertIn(k, analyze.CONDITION_KEYS)
        s = {"identity": {"mechanism": "native", "client_type": "live-edge", "network_profile": "step_down_up", "qdisc": "fq_codel",
                          "controller": "min"}}
        key = compare.cond_key(s)
        self.assertIn("fq_codel", key)
        self.assertIn("bbr", key)       # default for runs that did not record it
        self.assertIn("ctl min", key)
        s["identity"]["congestion_controller"] = "cubic"
        self.assertIn("cubic", compare.cond_key(s))
        self.assertNotEqual(key, compare.cond_key(s))


class Reaction(TmpRun):
    """C2: reaction/recovery not comparable; reported regardless of the rung at the drop and the profile."""

    def net(self, low: float):
        return [runner("NET_CHANGE", T0 - 5000, rate_mbps=6, at_s=0, applied=True),
                runner("NET_CHANGE", T0 + 60_000, rate_mbps=low, at_s=60, applied=True),
                runner("NET_CHANGE", T0 + 120_000, rate_mbps=6, at_s=120, applied=True),
                runner("RUN_END", T0 + 200_000, elapsed_s=200.1)]

    def test_not_detect_step_profile_is_na(self):
        client = startup(R[4]) + samples(T0, T0 + 199_000, lambda t: R[4])
        s = analyze.analyze(write_run(self.dir, client, self.net(1.5), profile="step_down_up", startup_track=R[4]))
        self.assertIsNone(s["reaction"]["down_reaction_ms"])   # C2 before the fix: reported for every profile
        self.assertIn("detect_step", s["reaction"]["reaction_na_reason"])
        # The per-event diagnostics still carry the precondition (rung 4 > fit 3 at 1.5 Mbps).
        self.assertTrue(s["detection"][0]["precondition"])
        self.assertEqual((s["detection"][0]["rung_at_drop"], s["detection"][0]["fit_index"]), (4, 3))

    def test_already_fitting_is_na(self):
        # detect_step: 0.8 Mbps -> fit = rung 2 (500k <= 0.72 Mbps? no: 0.9 x 0.8 = 0.72 Mbps -> 500k fits, 1200k does not)
        client = startup(R[2]) + samples(T0, T0 + 199_000, lambda t: R[2])
        s = analyze.analyze(write_run(self.dir, client, self.net(0.8), profile="detect_step", startup_track=R[2]))
        self.assertIsNone(s["reaction"]["down_reaction_ms"])   # C2 before the fix: a 0 ms "reaction"
        self.assertEqual(s["detection"][0]["fit_index"], 2)
        self.assertFalse(s["detection"][0]["precondition"])
        self.assertIsNone(s["reaction"]["down_reaction_ms"])
        self.assertIn("already at a fitting rung", s["reaction"]["reaction_na_reason"])
        # before the fix this run reported a 0 ms "reaction"

    def test_detect_step_with_precondition_reports_presented_reaction(self):
        A, B = R[4], R[2]
        client = startup(A) + switch(1, T0 + 61_000, A, B)            # lands at +61.5 s (subscribed flips)
        client.append(first_frame(T0 + 65_000, A, B, vis_ms=4000.0))  # presented at +65 s
        client += switch(2, T0 + 130_000, B, A)
        client.append(first_frame(T0 + 135_000, B, A, vis_ms=5000.0))
        client += samples(T0, T0 + 199_000, lambda t: B if T0 + 61_500 <= t < T0 + 130_500 else A)
        s = analyze.analyze(write_run(self.dir, client, self.net(0.8), profile="detect_step", startup_track=A))
        rx = s["reaction"]
        self.assertIsNone(rx["reaction_na_reason"])
        self.assertAlmostEqual(rx["down_reaction_ms"], 5000.0, delta=300)   # presented, not subscribed (1500 ms)
        self.assertAlmostEqual(rx["up_recovery_ms"], 15_000.0, delta=300)
        self.assertEqual(rx["pre_drop_index"], 4)


class Shares(TmpRun):
    """C2 replacement metrics: fit_share_low and pre_drop_share_after_restore."""

    def test_shares(self):
        A, B = R[4], R[3]
        net = [runner("NET_CHANGE", T0 - 5000, rate_mbps=6, at_s=0, applied=True),
               runner("NET_CHANGE", T0 + 60_000, rate_mbps=1.5, at_s=60, applied=True),
               runner("NET_CHANGE", T0 + 120_000, rate_mbps=6, at_s=120, applied=True),
               runner("RUN_END", T0 + 200_000, elapsed_s=200.0)]
        client = startup(A) + switch(1, T0 + 65_000, A, B)
        client.append(first_frame(T0 + 70_000, A, B, vis_ms=5000.0))
        client += switch(2, T0 + 145_000, B, A)
        client.append(first_frame(T0 + 150_000, B, A, vis_ms=5000.0))
        client += samples(T0, T0 + 200_000, lambda t: B if T0 + 65_500 <= t < T0 + 145_500 else A)
        s = analyze.analyze(write_run(self.dir, client, net, startup_track=A))
        sh = s["shares"]
        self.assertEqual((sh["fit_rung"], sh["pre_drop_rung"], sh["rung_at_drop"]), (3, 4, 4))
        self.assertAlmostEqual(sh["fit_share_low"], 50 / 55, delta=0.01)          # [65, 120): rung <= 3 from 70
        self.assertAlmostEqual(sh["pre_drop_share_after_restore"], 50 / 75, delta=0.01)  # [125, 200): rung >= 4 from 150
        self.assertEqual(s["time_shift"]["half_shift_lost"], False)


class SwitchIdentityEdges(TmpRun):
    """C1, the fallback join's edge cases."""

    def test_pending_switch_replaced_before_landing_is_superseded(self):
        # #1 is acknowledged but #2 is acknowledged before #1 lands: the client replaces the
        # pending switch, #1 never lands and never gets a first frame.
        A, B, C = R[0], R[2], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B, land_after_ms=None) + switch(2, T0 + 1200, A, C, land_after_ms=600)
        client.append(first_frame(T0 + 3000, A, C, vis_ms=1800.0))
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]["list"]
        self.assertEqual([(x["terminal"], x["terminal_source"]) for x in sw], [("superseded", "inferred"), ("first_frame", "record")])
        self.assertEqual(sw[0]["superseded_by"], 2)

    def test_first_frame_is_never_moved_to_an_earlier_switch(self):
        # Two first-frame records with the same (from, to) after one SWITCH_SENT: the second
        # is a duplicate of the last matching switch, not the first frame of the earlier one.
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B) + switch(2, T0 + 2000, B, A) + switch(3, T0 + 3000, A, B)
        client.append(first_frame(T0 + 5000, A, B, vis_ms=2000.0))
        client.append(first_frame(T0 + 5500, A, B, vis_ms=2500.0))
        client += samples(T0, T0 + 8000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual([x["terminal"] for x in s["switches"]["list"]], ["superseded", "superseded", "first_frame"])
        self.assertEqual(s["switches"]["join"]["duplicates"], {"SWITCH_FIRST_FRAME": 1})

    def test_first_frame_with_unmatched_from_joins_on_target(self):
        A, B, C = R[0], R[2], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, C)
        client.append(first_frame(T0 + 3000, B, C, vis_ms=2000.0))   # `from` matches no SWITCH_SENT
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual(s["switches"]["list"][0]["terminal"], "first_frame")
        self.assertEqual(s["switches"]["join"]["to_only_joins"], 1)

    def test_seq_join_with_missing_superseded_record_is_inferred(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B, with_seq=True) + switch(2, T0 + 2000, B, A, with_seq=True)
        client.append(first_frame(T0 + 4000, B, A, vis_ms=2000.0, seq=2))
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]["list"]
        self.assertEqual([(x["terminal"], x["terminal_source"]) for x in sw], [("superseded", "inferred"), ("first_frame", "record")])


class DecisionJoin(TmpRun):
    """D1 (review 2026-10-04): ABR_DECISION is emitted at the LANDING with decided_ts, and was
    joined as "the last decision with ts <= SENT + 5 ms and the same target"."""

    def test_decision_logged_at_landing_joins_its_own_switch(self):
        A, B = R[0], R[4]
        for with_seq in (False, True):
            with self.subTest(with_seq=with_seq):
                client = startup(A)
                client += switch(1, T0 + 1000, A, B, rule_reason="probe bwe", decided_before_ms=2, with_seq=with_seq)
                client += switch(2, T0 + 2000, B, A, rule_reason="buffer-drain", with_seq=with_seq)
                client += switch(3, T0 + 3000, A, B, rule_reason="throughput", decided_before_ms=3, with_seq=with_seq)
                client.append(first_frame(T0 + 5000, A, B, vis_ms=2000.0, seq=3 if with_seq else None))
                client += samples(T0, T0 + 8000, lambda t: A)
                s = analyze.analyze(write_run(self.dir, client))
                sw = s["switches"]["list"]
                # Before the fix: #1 and #2 had no decision (theirs is logged after SENT) and #3
                # took #1's decision (logged at #1's landing, 1500 ms before #3 was sent).
                self.assertEqual([x["rule_reason"] for x in sw], ["probe bwe", "buffer-drain", "throughput"])
                self.assertEqual([x["t2_decision_ms"] for x in sw], [2, 1, 3])
                self.assertEqual([x["decision_source"] for x in sw], ["switch_seq" if with_seq else "decided_ts"] * 3)
                self.assertEqual(s["switching"]["switches_by_rule"], {"probe bwe": 1, "buffer-drain": 1, "throughput": 1})

    def test_decided_ts_join_requires_matching_pair_and_bound(self):
        A, B = R[0], R[4]
        client = startup(A)
        # Decided 1.5 s before it was sent: outside [0, 1000] ms, so it is not this switch's decision.
        client += switch(1, T0 + 2000, A, B, decided_before_ms=1500)
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertIsNone(s["switches"]["list"][0]["t2_decision_ms"])
        self.assertIsNone(s["switches"]["list"][0]["decision_source"])
        self.assertEqual(s["switches"]["decision_join"]["unjoined_decisions"], 1)
        self.assertEqual(s["switches"]["join"]["unjoined"], {})   # the switch join (terminals check) is unaffected

    def test_switch_that_never_lands_from_phantom_or_tick(self):
        A, B, C = R[0], R[2], R[4]
        client = startup(A)
        # #1 never lands and the controller logged a phantom; #2 never lands, no phantom:
        # the last ABR_TICK at or before its SWITCH_SENT whose chosen index is the target.
        client += switch(1, T0 + 1000, A, C, land_after_ms=None)
        client.append(ev("ABR_SWITCH_PHANTOM", T0 + 1500, **{"from": A, "to": C, "landed": A, "reason": "auto-upgrade",
                                                            "rule_reason": "probe bwe", "decided_ms_ago": 501}))
        client.append(ev("ABR_TICK", T0 + 2500, track=A, active_index=0, chosen={"index": 3, "reason": "throughput", "rule": "ThroughputRule"}))
        client.append(ev("ABR_TICK", T0 + 2750, track=A, active_index=0, chosen={"index": 2, "reason": "latency trend 150% > 120%",
                                                                                 "rule": "LatencyTrendRule"}))
        client.append(ev("ABR_TICK", T0 + 2900, track=A, active_index=0, chosen=None))
        client += switch(2, T0 + 3000, A, B, land_after_ms=None)
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]["list"]
        self.assertEqual([x["decision_source"] for x in sw], ["phantom", "tick"])
        self.assertEqual([x["rule_reason"] for x in sw], ["probe bwe", "latency trend 150% > 120%"])
        self.assertEqual(sw[0]["t2_decision_ms"], 1)      # decided at 1500 - 501 ms, sent at 1000
        self.assertEqual(sw[1]["t2_decision_ms"], 250)
        self.assertEqual(sw[1]["reason"], "auto-upgrade")
        self.assertEqual(s["switching"]["switches_by_rule"], {"probe bwe": 1, "latency trend": 1})
        self.assertEqual(s["switching"]["decision_sources"], {"phantom": 1, "tick": 1})

    def test_legacy_decision_before_sent(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B, decision="legacy", rule_reason="latency trend 130% > 120%")
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        x = s["switches"]["list"][0]
        self.assertEqual((x["decision_source"], x["t2_decision_ms"], x["rule_reason"]), ("legacy_ts", 1, "latency trend 130% > 120%"))

    def test_detection_t2_and_quiet_before_use_decided_ts(self):
        A, B = R[4], R[2]
        net = [runner("NET_CHANGE", T0 - 5000, rate_mbps=6, at_s=0, applied=True),
               runner("NET_CHANGE", T0 + 60_000, rate_mbps=0.8, at_s=60, applied=True),
               runner("NET_CHANGE", T0 + 120_000, rate_mbps=6, at_s=120, applied=True),
               runner("RUN_END", T0 + 200_000, elapsed_s=200.0)]
        client = startup(A)
        # A switch decided 6 s before the drop that LANDS 1 s before it: the controller was
        # quiet in the 5 s before t0 (before the fix its landing-time record made it "not quiet").
        client += switch(1, T0 + 53_900, A, R[3], land_after_ms=5000, decided_before_ms=100)
        # Reaction: decided at t0 + 1000, sent at t0 + 1010, landed at t0 + 3010.
        client += switch(2, T0 + 61_010, R[3], B, land_after_ms=2000, decided_before_ms=10)
        client += samples(T0, T0 + 199_000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client, net, profile="detect_step", startup_track=A))
        d = s["detection"][0]
        self.assertTrue(d["quiet_before"])
        self.assertEqual(d["t2_ms"], 1000)              # before the fix: 2011 (the landing)
        self.assertEqual(d["t3_ms"], 1010)


def landed_off_keyframe_then_superseded(seq: int, ts: float, frm: str, to: str, by: int) -> list[dict]:
    """A switch whose landing object is not a keyframe and that a newer switch supersedes
    before the keyframe gate let anything in: SWITCH_FIRST_OBJECT, no SWITCH_APPLIED."""
    return switch(seq, ts, frm, to, land_after_ms=None, with_seq=True) + [
        ev("SWITCH_FIRST_OBJECT", ts + 300, **{"from": frm, "to": to, "group": 40, "object": 7, "since_sent_ms": 300,
                                               "landed_on_keyframe": False}, switch_seq=seq),
        ev("SWITCH_SUPERSEDED", ts + 900, switch_seq=seq, by_switch_seq=by, playhead_ms=ts - T0, landed=True)]


class KeyframeLandings(TmpRun):
    """D3: landed_on_keyframe was read from SWITCH_APPLIED only, so a switch that landed on a
    non-keyframe and was superseded before any append left the denominator."""

    def test_landing_flag_from_first_object(self):
        A, B = R[0], R[4]
        client = startup(A) + landed_off_keyframe_then_superseded(1, T0 + 1000, A, B, by=2)
        client += switch(2, T0 + 1500, A, R[2], with_seq=True)
        client.append(first_frame(T0 + 4000, A, R[2], vis_ms=2500.0, seq=2))
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        sw = s["switches"]
        self.assertEqual([x["landed_on_keyframe"] for x in sw["list"]], [False, True])
        self.assertEqual((sw["landed_on_keyframe"], sw["landed_on_keyframe_known"]), (1, 2))   # before: 1 of 1

    def test_applied_flag_is_the_fallback(self):
        A, B = R[0], R[4]
        client = startup(A) + switch(1, T0 + 1000, A, B)
        for r in client:
            if r["event"] == "SWITCH_FIRST_OBJECT":
                del r["landed_on_keyframe"]          # bundles before 2026-10: the flag is on SWITCH_APPLIED only
        client += samples(T0, T0 + 6000, lambda t: A)
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual((s["switches"]["landed_on_keyframe"], s["switches"]["landed_on_keyframe_known"]), (1, 1))


class Starvation(TmpRun):
    """M19: starvation is reported as a subset of stall time."""

    def test_starvation_is_the_stall_time_inside_starvation_episodes(self):
        client = startup()
        # Starvation from the last append at +10 s (DATA_STARVED at +14 s) to +20 s; the buffer
        # plays out until +15 s, then a 5 s stall. A second starvation without any stall.
        client.append(ev("DATA_STARVED", T0 + 14_000, since_last_append_ms=4000, track=R[0]))
        client.append(ev("STALL_START", T0 + 15_000, cause="waiting", playhead_ms=15_000, track=R[0]))
        client.append(ev("STALL_END", T0 + 20_000, cause="waiting", playhead_ms=15_000, duration_ms=5000))
        client.append(ev("DATA_RESUMED", T0 + 20_000, starved_ms=10_000))
        client.append(ev("DATA_STARVED", T0 + 34_000, since_last_append_ms=4000, track=R[0]))
        client.append(ev("DATA_RESUMED", T0 + 36_000, starved_ms=6000))
        client += samples(T0, T0 + 40_000, lambda t: R[0])
        s = analyze.analyze(write_run(self.dir, client))
        self.assertEqual(s["starvation"]["raw_total_ms"], 16_000)   # before the fix: the headline, 16 s > 5 s of stall
        self.assertEqual(s["starvation"]["total_ms"], 5000)
        self.assertLessEqual(s["starvation"]["total_ms"], s["stalls"]["total_ms"])


class ValidateScript(TmpRun):
    """M20 and the 2026-10 validation rules, through validate.py itself."""

    def complete_run(self, *, run_end: bool = True, applied: bool = True, promoted: bool = True, with_seq: bool = False,
                     superseded_record: bool = True, validation: dict | None = None, mechanism_mode: str | None = None,
                     rates: tuple = (6, 1.5), net_fields: dict | None = None, meta_extra: dict | None = None,
                     extra_client: list[dict] | None = None, identity_extra: dict | None = None,
                     client_meta_extra: dict | None = None) -> Path:
        A, B = R[0], R[4]
        client = startup(A) + [ev("CLOCK_MAP", T0 - 1100, user_agent="Mozilla/5.0 Firefox/157.0")]
        client += switch(1, T0 + 1000, A, B, with_seq=with_seq) + switch(2, T0 + 2000, B, A, with_seq=with_seq)
        client.append(first_frame(T0 + 4000, B, A, vis_ms=2000.0, seq=2 if with_seq else None))
        if with_seq and superseded_record:
            client.append(ev("SWITCH_SUPERSEDED", T0 + 2500, switch_seq=1, by_switch_seq=2, playhead_ms=2500))
        client += samples(T0, T0 + 60_000, lambda t: A)
        client += extra_client or []
        runner_recs = [runner("NET_CHANGE", T0 - 5000, rate_mbps=rates[0], at_s=0, applied=True, **(net_fields or {})),
                       runner("NET_CHANGE", T0 + 30_000, rate_mbps=rates[1], at_s=30, applied=applied, **(net_fields or {}))]
        if run_end:
            runner_recs.append(runner("RUN_END", T0 + 60_100, elapsed_s=60.0))
        relay = []
        for seq, ts, to in ((1, T0 + 1000, B), (2, T0 + 2000, A)):
            relay.append({"ts": ts + 20, "src": "relay", "event": "SWITCH_RECV", "request_id": seq * 2, "old_request_id": seq * 2 - 2})
            if promoted:
                relay.append({"ts": ts + 21, "src": "relay", "event": "SWITCH_PROMOTED", "track": "moqtail/" + to, "start_group": 20 + seq})
        return write_run(self.dir, client, runner_recs, duration_s=60.0, validation=validation, relay_recs=relay,
                         identity_extra={"mechanism_mode": mechanism_mode, **(identity_extra or {})}, meta_extra=meta_extra,
                         client_meta_extra=client_meta_extra)

    def validate(self, run: Path, *extra: str) -> tuple[int, dict[str, str]]:
        p = subprocess.run([sys.executable, str(EXPERIMENTS / "validate.py"), str(run), "--no-write", *extra],
                           capture_output=True, text=True, timeout=60)
        status = {}
        for line in p.stdout.splitlines():
            parts = line.split(None, 2)
            if len(parts) >= 2 and parts[0] in ("PASS", "FAIL", "SKIP", "INFO"):
                status[parts[1]] = parts[0]
        return p.returncode, status

    def test_complete_run_passes(self):
        code, st = self.validate(self.complete_run())
        self.assertEqual(code, 0, st)
        for k in ("completed", "samples", "net-applied", "terminals", "relay-stamps", "aborted"):
            self.assertEqual(st[k], "PASS", k)

    def test_identity_controller_arm_matches_client(self):
        # D10: the arm the client ran (RUN_META.controller_arm) must be the arm the runner recorded
        # (identity.controller_family; identity.controller when the family is absent).
        _, st = self.validate(self.complete_run(identity_extra={"controller": "grid-noprobe", "controller_family": "grid"},
                                                client_meta_extra={"controller_arm": "grid"}))
        self.assertEqual(st["identity"], "PASS")
        _, st = self.validate(self.complete_run(identity_extra={"controller": "grid", "controller_family": "grid"},
                                                client_meta_extra={"controller_arm": "min"}))
        self.assertEqual(st["identity"], "FAIL")      # before the fix: PASS
        _, st = self.validate(self.complete_run(identity_extra={"controller": "min"}, client_meta_extra={"controller_arm": "baseline"}))
        self.assertEqual(st["identity"], "FAIL")
        _, st = self.validate(self.complete_run(identity_extra={"controller": "min"}))   # old client: no controller_arm
        self.assertEqual(st["identity"], "PASS")

    def test_aborted_marker_fails(self):
        code, st = self.validate(self.complete_run(validation={"passed": False, "failed": ["aborted"]}))
        self.assertEqual((code, st["aborted"]), (1, "FAIL"))

    def test_missing_run_end_fails(self):
        code, st = self.validate(self.complete_run(run_end=False))
        self.assertEqual((code, st["completed"]), (1, "FAIL"))

    def test_unapplied_net_change_fails(self):
        code, st = self.validate(self.complete_run(applied=False))
        self.assertEqual((code, st["net-applied"]), (1, "FAIL"))

    def test_missing_relay_promoted_fails_on_native(self):
        code, st = self.validate(self.complete_run(promoted=False))
        self.assertEqual((code, st["relay-stamps"]), (1, "FAIL"))

    def test_run_meta_abort_marker_fails_and_is_invalid(self):
        run = self.complete_run(meta_extra={"validity": {"aborted": True}})
        code, st = self.validate(run)
        self.assertEqual((code, st["aborted"]), (1, "FAIL"))
        v = analyze.read_validity(run)                 # no validation.json, but the runner marked it aborted
        self.assertEqual((v["valid"], v["aborted"]), (False, True))

    def test_preflight_tc_tree_gso_and_maxpacket(self):
        shaped_tc = ["tc qdisc add dev veth-moqh root handle 1: netem delay 20ms limit 10000",
                     "tc class add dev veth-moqh parent 1: classid 1:10 htb rate 6mbit ceil 6mbit",
                     "tc qdisc add dev veth-moqh parent 1:10 handle 10: bfifo limit 150000"]
        good = {"tc": shaped_tc, "qdisc_stats": {"leaf": {"bytes": 1, "packets": 1, "drops": 0, "maxpacket": 1514}}, "gso_at_qdisc": False}
        _, st = self.validate(self.complete_run(net_fields=good), "--preflight")
        self.assertEqual((st["pf-qdisc"], st["pf-gso"], st["pf-maxpacket"]), ("PASS", "PASS", "PASS"))
        _, st = self.validate(self.complete_run(net_fields=dict(good, gso_at_qdisc=True)), "--preflight")
        self.assertEqual(st["pf-gso"], "FAIL")
        _, st = self.validate(self.complete_run(net_fields=dict(good, qdisc_stats={"leaf": {"maxpacket": 64_000}})), "--preflight")
        self.assertEqual(st["pf-maxpacket"], "FAIL")
        _, st = self.validate(self.complete_run(net_fields=dict(good, qdisc_stats={"leaf": {"maxpacket": 2000}})), "--preflight")
        self.assertEqual(st["pf-maxpacket"], "INFO")
        _, st = self.validate(self.complete_run(net_fields=dict(good, tc=shaped_tc[:1])), "--preflight")
        self.assertEqual(st["pf-qdisc"], "FAIL")       # rate-limited step without htb / leaf
        # Unshaped profile: the netem delay alone is the expected tree.
        unshaped = {"tc": shaped_tc[:1], "qdisc_stats": {"leaf": {"bytes": 1}}, "gso_at_qdisc": None}
        _, st = self.validate(self.complete_run(rates=(None, None), net_fields=unshaped), "--preflight")
        self.assertEqual((st["pf-qdisc"], st["pf-gso"]), ("PASS", "SKIP"))
        self.assertEqual((st["pf-warmup"], st["pf-offloads"]), ("INFO", "INFO"))

    def test_preflight_gso_read_from_the_leaf(self):
        # D2: the runner writes gso_at_qdisc inside qdisc_stats.leaf (net.leaf_stats), not at the
        # top level of NET_CHANGE; before the fix pf-gso saw "unknown" on every runner record.
        shaped_tc = ["tc qdisc add dev veth-moqh root handle 1: netem delay 20ms limit 10000",
                     "tc class add dev veth-moqh parent 1: classid 1:10 htb rate 6mbit ceil 6mbit",
                     "tc qdisc add dev veth-moqh parent 1:10 handle 10: bfifo limit 150000"]
        leaf = {"kind": "bfifo", "sent_bytes": 1, "sent_pkts": 1, "dropped": 0, "backlog_bytes": 0, "backlog_pkts": 0,
                "max_skb_bytes": None, "backlog_bytes_per_skb": None}
        _, st = self.validate(self.complete_run(net_fields={"tc": shaped_tc, "qdisc_stats": {"leaf": dict(leaf, gso_at_qdisc=True)}}),
                              "--preflight")
        self.assertEqual(st["pf-gso"], "FAIL")
        _, st = self.validate(self.complete_run(net_fields={"tc": shaped_tc, "qdisc_stats": {"leaf": dict(leaf, gso_at_qdisc=False, maxpacket=1514)}}),
                              "--preflight")
        self.assertEqual(st["pf-gso"], "PASS")
        _, st = self.validate(self.complete_run(net_fields={"tc": shaped_tc, "qdisc_stats": {"leaf": dict(leaf, gso_at_qdisc=None)}}),
                              "--preflight")
        self.assertEqual(st["pf-gso"], "INFO")

    def test_relay_promoted_from_promoted_ts(self):
        # Fixed native arm: a held-back trigger's SWITCH_PROMOTED is written after the
        # joining replay; the timeline must use the decision time, or the ordering check
        # sees promotion after the first object.
        run = self.complete_run()
        rel = run / "relay-events.jsonl"
        recs = [json.loads(l) for l in rel.read_text().splitlines() if l.strip()]
        for r in recs:
            if r["event"] == "SWITCH_PROMOTED":
                r["promoted_ts"] = r["ts"]
                r["ts"] = r["ts"] + 5000          # emitted late, after the replay
        rel.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
        s = analyze.analyze(run)
        first = s["switches"]["list"][0]
        self.assertLess(first["relay_promoted_ms"], 100)
        code, st = self.validate(run)
        self.assertEqual(st["ordering"], "PASS")

    def test_preflight_relay_gso_from_conn_stats(self):
        # C5: the relay must send one UDP datagram per I/O to the client (no GSO batches).
        def with_conn(datagrams, ios):
            run = self.complete_run()
            rel = run / "relay-events.jsonl"
            recs = [json.loads(l) for l in rel.read_text().splitlines() if l.strip()]
            for i in range(60):
                t = T0 + i * 1000
                recs.append({"ts": t, "src": "relay", "event": "CONN_STATS", "conn": 7, "udp_tx_bytes": 1_000_000 + i,
                             "udp_tx_datagrams": datagrams * (i + 1), "udp_tx_ios": ios * (i + 1), "sent_packets": 10 * (i + 1),
                             "lost_packets": 0, "rtt_ms": 42.0, "cwnd": 30_000})
            rel.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
            return run
        _, st = self.validate(with_conn(100, 100), "--preflight")
        self.assertEqual(st["pf-relay-gso"], "PASS")
        _, st = self.validate(with_conn(400, 100), "--preflight")
        self.assertEqual(st["pf-relay-gso"], "FAIL")
        _, st = self.validate(self.complete_run(), "--preflight")
        self.assertEqual(st["pf-relay-gso"], "SKIP")

    def test_preflight_keyframe_counts_landings_superseded_before_append(self):
        # D3: the off-keyframe landing has no SWITCH_APPLIED; pf-keyframe passed (2 of 2) before the fix.
        extra = landed_off_keyframe_then_superseded(3, T0 + 5000, R[0], R[4], by=4) + switch(4, T0 + 5500, R[0], R[2], with_seq=True)
        _, st = self.validate(self.complete_run(with_seq=True, mechanism_mode="forward-trigger", extra_client=extra), "--preflight")
        self.assertEqual(st["pf-keyframe"], "FAIL")

    def test_preflight_requires_superseded_records_with_switch_seq(self):
        _, st = self.validate(self.complete_run(with_seq=True), "--preflight")
        self.assertEqual(st["pf-terminal"], "PASS")
        self.assertEqual(st["pf-keyframe"], "INFO")      # as-shipped native: reported, not asserted
        self.assertEqual(st["pf-relay-cc"], "FAIL")      # no RELAY_CONFIG record
        _, st = self.validate(self.complete_run(with_seq=True, superseded_record=False), "--preflight")
        self.assertEqual(st["pf-terminal"], "FAIL")
        _, st = self.validate(self.complete_run(with_seq=True, mechanism_mode="forward-trigger"), "--preflight")
        self.assertEqual(st["pf-keyframe"], "PASS")


class CompareAndPlot(TmpRun):
    """M20 exclusion in compare.py and the corrected flag in plot.py."""

    def test_compare_excludes_runs_without_passed_validation(self):
        client = startup() + samples(T0, T0 + 10_000, lambda t: R[0])
        run = write_run(self.dir, client)
        s = analyze.analyze(run)
        for validity in ({"valid": None, "reasons": ["not validated"]}, {"valid": False, "reasons": ["aborted"], "aborted": True}):
            s["validity"] = validity
            (run / "summary.json").write_text(json.dumps(s, default=str))
            p = subprocess.run([sys.executable, str(EXPERIMENTS / "compare.py"), str(run)], capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 1, p.stdout)       # before the fix: valid None was counted
            self.assertIn("no analyzed runs", p.stdout)
        s["validity"] = {"valid": True, "reasons": []}
        (run / "summary.json").write_text(json.dumps(s, default=str))
        p = subprocess.run([sys.executable, str(EXPERIMENTS / "compare.py"), str(run)], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("reaction (detect_step profile only)", p.stdout)
        self.assertIn("diagnostics", p.stdout)

    def test_plot_uses_the_terminal(self):
        self.assertTrue(plot.presented_switch({"terminal": "first_frame", "superseded": False}))
        self.assertFalse(plot.presented_switch({"terminal": "open", "superseded": False}))   # old flag said presented
        self.assertFalse(plot.presented_switch({"terminal": "superseded"}))
        self.assertTrue(plot.presented_switch({"superseded": False}))                       # pre-2026-10 summary
        runs = [{"time_shift": {"half_shift_lost": v, "time_to_half_shift_ms": t}} for v, t in ((True, 60_000), (False, None), (False, None))]
        h, _, label = plot.bar_value("half shift lost (k/n runs)", runs)
        self.assertAlmostEqual(h, 1 / 3)
        self.assertEqual(label, "1/3")
        h, dots, label = plot.bar_value("time to half shift s (k/n, never=inf)", runs)
        self.assertTrue(math.isinf(h))
        self.assertEqual((dots, label), ([60.0], "never (1/3)"))


class RealRun(unittest.TestCase):
    """Regression on one real fresh-grid-v2 run (skipped when the bundle is not checked out)."""

    @unittest.skipUnless(REAL_RUN is not None, "results-linux-2026-10-01/fresh-grid-v2 not available")
    def test_invariants(self):
        s = analyze.analyze(REAL_RUN)
        sw = s["switches"]
        self.assertTrue(all(x["terminal"] in analyze.TERMINALS for x in sw["list"]))
        self.assertEqual(sum(sw["terminals"].values()), sw["count"])
        self.assertEqual(sw["terminals"]["first_frame"], sw["switch_visibility_delay_ms"]["n"])
        self.assertEqual(sw["terminals"]["first_frame"], sw["viewer_pause_ms"]["n"])
        self.assertTrue(all(x["first_frame_ts"] is not None for x in sw["list"] if x["terminal"] == "first_frame"))
        self.assertTrue(all(x["switch_visibility_delay_ms"] is None for x in sw["list"] if x["terminal"] != "first_frame"))
        # native shift10s r3: 58 switches, 30 own first frames; the old analyzer said superseded = 1.
        self.assertEqual(sw["count"], 58)
        self.assertEqual(sw["terminals"]["first_frame"], 30)
        self.assertGreaterEqual(sw["superseded"], 20)
        self.assertEqual(sw["join"]["unjoined"], {})
        self.assertEqual(sw["join"]["duplicates"], {})
        self.assertIsNotNone(s["run_duration_s"])
        self.assertLess(s["bitrate"]["presented_rung_mean"], s["bitrate"]["subscribed_rung_mean"])
        self.assertIn("detect_step", s["reaction"]["reaction_na_reason"])
        self.assertGreater(s["stalls"]["media_skipped_ms"], 0)


if __name__ == "__main__":
    unittest.main()


def relay(event: str, ts: float, **fields) -> dict:
    rec = {"ts": ts, "src": "relay", "event": event, "conn": 3}
    rec.update(fields)
    return rec


class Pr1378Records(TmpRun):
    """P9: a pr1378 bundle in the rebuilt format: SWITCH_FLOOR and every switch record
    carry switch_seq, SWITCH_SENT.request_id is null (the relay allocates the id),
    SWITCH_OK names the switching group, SWITCH_ERROR the failure kind, the relay
    emits SWITCH_WAIT and SWITCH_PROMOTED.promoted_ts, the player logs post-seam drops,
    route releases and PUBLISH_DONE."""

    def bundle(self) -> Path:
        A, B = R[4], R[2]
        t1, t2 = T0 + 10_000, T0 + 20_000
        client = startup(A) + [ev("CLOCK_MAP", T0 - 1100, user_agent="Mozilla/5.0 Firefox/157.0")]
        # switch 1: next-group floor 15 (buffer floor 15, recv floor 14), relay picks 16
        client += [
            ev("SWITCH_FLOOR", t1 - 1, switch_seq=1, switch_floor="next-group", recv_floor_group=14, buffer_floor_group=15,
               selected_min_group=15, playhead_group=10, buffer_end_s=15.0, buffered_ranges="0.00-15.00"),
            ev("SWITCH_SENT", t1, switch_seq=1, **{"from": A, "to": B}, request_id=None, old_request_id=0,
               switch_floor="next-group", minimum_switching_group=15, playhead_ms=t1 - T0, last_received_group=13),
            ev("SWITCH_OK", t1 + 60, switch_seq=1, to=B, request_id=7, switching_group=16, live_edge_group=17, rtt_ms=60),
            ev("PUBLISH_DONE_RECV", t1 + 40, request_id=0, track=A, status=5, stream_count=3, role="current",
               switch_in_flight=True, pending_switch_seq=1),
            ev("DROP_STALE", t1 + 200, track=A, group=16, object=0, bytes=4000, reason="post-seam", seam_group=16, switch_seq=1),
            ev("DROP_STALE", t1 + 210, track=A, group=16, object=1, bytes=1000, reason="post-seam", seam_group=16, switch_seq=1),
            ev("SWITCH_SOURCE_RELEASED", t1 + 500, switch_seq=1, request_id=0, track=A, reason="publish-done-idle", seam_group=16,
               held_ms=440.0, publish_done=True, objects_after_switch_ok=12, post_seam_dropped=2),
            ev("SWITCH_FIRST_OBJECT", t1 + 510, switch_seq=1, **{"from": A, "to": B}, group=16, object=0, landed_on_keyframe=True),
            ev("SWITCH_APPLIED", t1 + 511, switch_seq=1, **{"from": A, "to": B}, group=16, object=0, media_seam_gap_ms=0,
               seam_ahead_of_playhead_ms=5000, landed_on_group_start=True, landed_on_keyframe=True),
            ev("SWITCH_FIRST_FRAME", t1 + 5000, switch_seq=1, **{"from": A, "to": B}, switch_visibility_delay_ms=5000.0,
               playback_position_jump_ms=0.0, viewer_pause_ms=3.0, seam_buffer_hole_ms=0),
        ]
        # switch 2: floor above the live edge; the relay waits and answers TIMEOUT
        client += [
            ev("SWITCH_FLOOR", t2 - 1, switch_seq=2, switch_floor="next-group", recv_floor_group=30, buffer_floor_group=None,
               selected_min_group=30, playhead_group=20, buffer_end_s=25.0, buffered_ranges="0.00-25.00"),
            ev("SWITCH_SENT", t2, switch_seq=2, **{"from": B, "to": A}, request_id=None, old_request_id=7,
               switch_floor="next-group", minimum_switching_group=30, playhead_ms=t2 - T0, last_received_group=29),
            ev("SWITCH_SKIPPED", t2 + 100, switch_seq=3, **{"from": B, "to": R[1]}, reason="switch in flight", pending_request_id=7),
            ev("SWITCH_ERROR", t2 + 3050, switch_seq=2, to=A, request_id=None, status=10, reason="switch: NoCommonBoundary",
               failure="NoCommonBoundary", rtt_ms=3050),
        ]
        client += samples(T0, T0 + 60_000, lambda t: A if t < t1 + 511 else B)
        relay_recs = [
            relay("SWITCH_RECV", t1 + 20, request_id=None, old_request_id=0, minimum_switching_group=15, track="moqtail/" + B),
            relay("SWITCH_PROMOTED", t1 + 30, track="moqtail/" + B, request_id=7, start_group=16, live_edge_group=17,
                  live_edge_object=0, promoted_ts=t1 + 30),
            relay("SWITCH_RECV", t2 + 20, request_id=None, old_request_id=7, minimum_switching_group=30, track="moqtail/" + A),
            relay("SWITCH_WAIT", t2 + 21, old_request_id=7, track="moqtail/" + A, floor=30, live_edge_current=27,
                  live_edge_target=27, waiting_for="floor"),
            relay("SWITCH_FAILED", t2 + 3020, track="moqtail/" + A, request_id=9, failure="NoCommonBoundary", status_code=10),
        ]
        runner_recs = [runner("NET_CHANGE", T0 - 5000, rate_mbps=6, at_s=0, applied=True),
                       runner("NET_CHANGE", T0 + 30_000, rate_mbps=1.5, at_s=30, applied=True),
                       runner("RUN_END", T0 + 60_100, elapsed_s=60.0)]
        return write_run(self.dir, client, runner_recs, duration_s=60.0, relay_recs=relay_recs,
                         identity_extra={"mechanism": "pr1378", "mechanism_mode": "next-group"},
                         client_meta_extra={"switch_floor": "next-group"})

    def test_switches_join_by_seq_with_null_request_ids(self):
        s = analyze.analyze(self.bundle())
        sw = s["switches"]
        self.assertEqual(sw["count"], 2)
        self.assertTrue(sw["join"]["seq_join"])
        self.assertEqual(sw["join"]["unjoined"], {"SWITCH_SKIPPED": 1})
        self.assertEqual(sw["terminals"]["first_frame"], 1)
        self.assertEqual(sw["terminals"]["error"], 1)
        first, second = sw["list"]
        self.assertEqual(first["selected_min_group"], 15)
        self.assertEqual(first["switching_group"], 16)
        self.assertAlmostEqual(first["relay_promoted_ms"], 30.0)
        self.assertFalse(first["relay_waited"])
        self.assertIsNone(first["failure"])
        self.assertEqual(second["failure"], "NoCommonBoundary")
        self.assertTrue(second["relay_waited"])
        self.assertEqual(second["relay_waiting_for"], "floor")

    def test_floor_failure_and_route_statistics(self):
        s = analyze.analyze(self.bundle())
        floor = s["switches"]["floor"]
        self.assertEqual(floor["count"], 2)
        self.assertEqual(floor["modes"], {"next-group": 2})
        self.assertEqual(floor["buffer_raised"], 1)     # buffer floor above the receive floor
        self.assertEqual(floor["seam_above_floor_groups"]["p50"], 1)
        self.assertEqual(floor["relay_waits"], 1)
        self.assertEqual(s["switches"]["failures"], {"NoCommonBoundary": 1})
        routes = s["switch_routes"]
        self.assertEqual(routes["post_seam_drops"], {"objects": 2, "bytes": 5000})
        self.assertEqual(routes["released"]["by_reason"], {"publish-done-idle": 1})
        self.assertEqual(routes["released"]["held_ms"]["p50"], 440.0)
        self.assertEqual(routes["publish_done_recv"], {"current": 1})

    def test_validates(self):
        p = subprocess.run([sys.executable, str(EXPERIMENTS / "validate.py"), str(self.bundle()), "--no-write"],
                           capture_output=True, text=True, timeout=60)
        status = {}
        for line in p.stdout.splitlines():
            parts = line.split(None, 2)
            if len(parts) >= 2 and parts[0] in ("PASS", "FAIL", "SKIP", "INFO"):
                status[parts[1]] = parts[0]
        for k in ("terminals", "relay-stamps", "ordering", "clocks"):
            self.assertEqual(status.get(k), "PASS", (k, p.stdout))


class Pr1378WaitJoin(TmpRun):
    """R6 D4: a relay SWITCH_WAIT joins only the switch whose relay attempt it falls in:
    after that switch's SWITCH_RECV and before the next SWITCH_RECV naming the same
    old_request_id, its SWITCH_PROMOTED or its SWITCH_FAILED. The reviewer's case: a
    DrainTimeout without a wait, retried from the same old request id with a wait 4 s
    later, used to take the retry's wait (the window was a flat 10 s)."""

    def bundle(self) -> Path:
        A, B, C, D = R[4], R[2], R[3], R[1]
        t1, t2 = T0 + 20_000, T0 + 24_000
        client = startup(A)
        # The route being replaced is the startup subscription (request id 0) both times.
        client += [
            ev("SWITCH_FLOOR", t1 - 1, switch_seq=1, switch_floor="next-group", recv_floor_group=27,
               buffer_floor_group=None, selected_min_group=27, playhead_group=15, buffer_end_s=25.0,
               buffered_ranges="0.00-25.00"),
            ev("SWITCH_SENT", t1, switch_seq=1, **{"from": A, "to": C}, request_id=None, old_request_id=0,
               switch_floor="next-group", minimum_switching_group=27, playhead_ms=t1 - T0, last_received_group=26),
            ev("SWITCH_ERROR", t1 + 3040, switch_seq=1, to=C, request_id=None, status=10, reason="switch: DrainTimeout",
               failure="DrainTimeout", rtt_ms=3040),
            ev("SWITCH_FLOOR", t2 - 1, switch_seq=2, switch_floor="next-group", recv_floor_group=31,
               buffer_floor_group=None, selected_min_group=31, playhead_group=19, buffer_end_s=29.0,
               buffered_ranges="0.00-29.00"),
            ev("SWITCH_SENT", t2, switch_seq=2, **{"from": A, "to": D}, request_id=None, old_request_id=0,
               switch_floor="next-group", minimum_switching_group=31, playhead_ms=t2 - T0, last_received_group=30),
            ev("SWITCH_OK", t2 + 900, switch_seq=2, to=D, request_id=11, switching_group=31, live_edge_group=31, rtt_ms=900),
            ev("SWITCH_FIRST_OBJECT", t2 + 1251, switch_seq=2, **{"from": A, "to": D}, group=31, object=0,
               landed_on_keyframe=True),
            ev("SWITCH_APPLIED", t2 + 1252, switch_seq=2, **{"from": A, "to": D}, group=31, object=0, media_seam_gap_ms=0,
               seam_ahead_of_playhead_ms=10000, landed_on_group_start=True, landed_on_keyframe=True),
            ev("SWITCH_FIRST_FRAME", t2 + 11_000, switch_seq=2, **{"from": A, "to": D}, switch_visibility_delay_ms=11000.0,
               playback_position_jump_ms=0.0, viewer_pause_ms=3.0, seam_buffer_hole_ms=0),
        ]
        client += samples(T0, T0 + 60_000, lambda t: A if t < t2 + 1252 else D)
        relay_recs = [
            relay("SWITCH_RECV", t1 + 20, request_id=None, old_request_id=0, minimum_switching_group=27,
                  track="moqtail/" + C),
            relay("SWITCH_FAILED", t1 + 3020, track="moqtail/" + C, request_id=9, failure="DrainTimeout", status_code=10),
            relay("SWITCH_RECV", t2 + 20, request_id=None, old_request_id=0, minimum_switching_group=31,
                  track="moqtail/" + D),
            relay("SWITCH_WAIT", t2 + 21, old_request_id=0, track="moqtail/" + D, floor=31, live_edge_current=30,
                  live_edge_target=30, waiting_for="floor"),
            relay("SWITCH_PROMOTED", t2 + 865, track="moqtail/" + D, request_id=11, start_group=31, live_edge_group=31,
                  live_edge_object=0, promoted_ts=t2 + 865),
        ]
        runner_recs = [runner("NET_CHANGE", T0 - 5000, rate_mbps=6, at_s=0, applied=True),
                       runner("RUN_END", T0 + 60_100, elapsed_s=60.0)]
        return write_run(self.dir, client, runner_recs, duration_s=60.0, relay_recs=relay_recs,
                         identity_extra={"mechanism": "pr1378", "mechanism_mode": "next-group"},
                         client_meta_extra={"switch_floor": "next-group"})

    def test_a_retry_keeps_its_own_wait(self):
        s = analyze.analyze(self.bundle())
        failed, retry = s["switches"]["list"]
        self.assertEqual(failed["failure"], "DrainTimeout")
        self.assertFalse(failed["relay_waited"])
        self.assertTrue(retry["relay_waited"])
        self.assertEqual(retry["relay_waiting_for"], "floor")
        self.assertEqual(s["switches"]["floor"]["relay_waits"], 1)


class Pr1378OldBundle(Pr1378Records):
    """P9: a pr1378 bundle from before SWITCH_OK carried the switching group takes
    G_switch from the relay's SWITCH_PROMOTED.start_group."""

    def test_switching_group_from_promoted(self):
        run = self.bundle()
        cl = run / "client-events.jsonl"
        recs = [json.loads(l) for l in cl.read_text().splitlines() if l.strip()]
        for r in recs:
            if r["event"] == "SWITCH_OK":
                r.pop("switching_group", None)
        cl.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
        s = analyze.analyze(run)
        self.assertEqual(s["switches"]["list"][0]["switching_group"], 16)
        self.assertEqual(s["switches"]["floor"]["seam_above_floor_groups"]["p50"], 1)
