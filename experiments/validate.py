#!/usr/bin/env python3
"""Validation suite for one experiment run: is the instrumentation telling the truth?

    python3 experiments/validate.py results/<run_id> [--gop-tolerance 1.5] [--clock-tolerance-ms 250]
    python3 experiments/validate.py results/<run_id> --preflight     # apparatus invariants (60 s run per arm)

Run it on a short unshaped run of each client type before generating a series.
Checks (each PASS / FAIL / SKIP / INFO with the numbers behind it):

  single-session  one client page session, no wall-clock gaps > 5 s in SAMPLE
  identity        run_meta.json carries the identity block and it matches the client RUN_META (client type,
                  delay groups, controller arm: RUN_META.controller_arm == identity.controller_family, or
                  identity.controller when the family is absent; skipped when the client did not log it)
  aborted         the runner did not mark the run aborted (validation.json {"failed": ["aborted"]} or
                  run_meta.json validity.aborted)
  completed       RUN_END is present and elapsed_s is within --duration-tolerance-s of the configured duration
  samples         SAMPLE count >= --sample-fraction x duration / 0.25 s
  net-applied     every NET_CHANGE was applied (a run with the `none` backend is unshaped by design)
  live-edge       live-edge client: target shift is 0 and the mean live-edge distance in the first --window-s is
                  small (under --gop-tolerance GOPs)
  time-shifted    time-shifted client: mean live-edge distance in the first --window-s
                  seconds after the first frame is within --gop-tolerance GOPs of
                  delay_groups x GOP, and the first group was the expected one (not clamped)
  ordering        for every switch: decision <= sent <= relay SWITCH_RECV <= relay
                  SWITCH_PROMOTED <= first object <= applied <= first frame (where present)
  terminals       every switch has exactly one terminal; no unjoined or duplicate switch records
  relay-stamps    mechanisms whose relay emits SWITCH_PROMOTED (native, native forward-trigger,
                  pr1378): every non-failed switch (not sent in the last 5 s) has relay_promoted_ms
  clocks          relay SWITCH_RECV follows the client's SWITCH_SENT by a plausible
                  one-way delay (0 .. --clock-tolerance-ms); the client's CLOCK_MAP is present
  join            for several groups G: publisher GROUP_EMIT(G) <= relay CACHE_GROUP(G)
                  <= client receipt of G
  playback        the measurement stayed interpretable: the playhead never stood
                  still longer than --max-freeze-s WHILE PLAYABLE DATA EXISTED (a
                  player wedge), and the MoQ session was not destroyed by a failed
                  switch. A freeze with nothing to play is starvation, an outcome
                  of the system under test, and keeps the run valid however long
                  it lasts (the advancing fraction is reported, not judged)
  clean-worktree  (--final only) the run was made from a committed tree

--preflight adds the apparatus invariants of docs/rebuild-2026-10-04.md ("Preflight"):

  pf-keyframe       keyframe landings = 100 % (as-shipped native: reported, not asserted)
  pf-behind         landed_behind_playhead = 0
  pf-terminal       every switch has exactly one terminal; none left open except those sent within
                    5 s + target shift of the end; with switch_seq, no terminal inferred without its
                    record (SWITCH_SUPERSEDED); no conflicting, unjoined or duplicate records
  pf-unrouted       DROP_STALE{unrouted} bytes after the first switch settled (reported)
  pf-relay-cc       RELAY_CONFIG.congestion_controller matches the run identity
  pf-qdisc          qdisc_stats on every applied NET_CHANGE; the recorded tc commands show netem / htb /
                    bfifo|fq_codel on a rate-limited step and netem on an unshaped one
  pf-gso            qdisc_stats.leaf.gso_at_qdisc false on every rate-limited NET_CHANGE (fails when true;
                    a top-level gso_at_qdisc is read only when the leaf has none)
  pf-maxpacket      qdisc_stats.leaf.maxpacket <= 1514 when recorded (reported above, fails above 3000)
  pf-warmup         BROWSER_START.warmup_measured_s within 15 +- 1 s (reported)
  pf-offloads       identity.offloads_disabled is true (reported)
  pf-loss           unshaped profile: CONN_STATS loss rate < 0.1 %
  pf-relay-gso      the relay sends one UDP datagram per I/O on the client connection
                    (CONN_STATS udp_tx_datagrams / udp_tx_ios <= 1.05): no GSO batches (C5)
  pf-delivery-rate  every rate-limited step: over [step + 10 s, next step), the median
                    THROUGHPUT_SAMPLE rate of link-limited groups (bytes x 8 / 50 ms >= rate, i.e. a
                    group the publisher's ~50 ms burst cannot deliver faster than the link) lies in
                    [0.6, 1.15] x rate. When it does not, the 64 KB probe's pure transfer rate in the
                    same window tells the cause: probe as low as video = the connection delivered
                    less than the link (transport / congestion control); probe near the rate while
                    video is low = client-side timing (M11)
  pf-probe-rate     lowest step <= 1.5 Mbps: probe-measured throughput p50 >= 0.8 x rate (reported;
                    the min arm runs without the probe)

Writes validation.json into the run directory; analyze.py and compare.py exclude
runs whose validation did not pass (``valid is not True``) unless told otherwise.

Exit status 1 if any check fails.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import PROMOTING_MECHANISMS, analyze, last_session, load, run_marked_aborted, track_matches, wall_clock_gaps  # noqa: E402

END_GRACE_MS = 5000.0  # switches sent this close to the run end may legitimately be unfinished


def fmt_pct(v) -> str:
    return "-" if v is None else f"{v * 100:.0f} %"


# Delivery rate (pf-delivery-rate). The publisher writes a group's objects ~2 ms apart,
# so a group leaves the relay within ~50 ms; a group whose bytes cannot cross the link in
# that time is link-limited and its intra-group arrival rate measures the link. Smaller
# groups (low rungs) are publisher-paced and say nothing about capacity.
ESTIMATOR_SETTLE_MS = 10_000
ESTIMATOR_BURST_S = 0.05
ESTIMATOR_MIN_SAMPLES = 3
ESTIMATOR_BAND = (0.6, 1.15)


def _median(vals: list[float]) -> float:
    vals = sorted(vals)
    n = len(vals)
    return vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2


def delivery_rate(applied: list[dict], tput: list[dict], probes: list[dict] | None, client_end: float | None) -> tuple[bool | None, str]:
    """Per rate-limited step, the median THROUGHPUT_SAMPLE.bps of link-limited groups over
    [step + settle, next step) must lie in ESTIMATOR_BAND x rate. Returns (ok, detail);
    ok is None when no step had enough link-limited samples to judge. A step out of band is
    attributed with the probe's pure transfer rate (p_bytes x 8 / dt_ms, probes >= 60 KB) in
    the same window when probes exist: within 25 % of the video rate means the connection
    itself delivered that little (transport); at least 0.6 x rate means client-side timing."""
    steps = sorted((c for c in applied if c.get("rate_mbps") is not None), key=lambda c: c["ts"])
    if not steps:
        return None, "no rate-limited step"
    ends = [c["ts"] for c in sorted(applied, key=lambda c: c["ts"])]
    parts, judged, bad = [], 0, 0
    for c in steps:
        rate_bps = c["rate_mbps"] * 1e6
        later = [t for t in ends if t > c["ts"]]
        end = later[0] if later else (client_end if client_end is not None else float("inf"))
        lo_t = c["ts"] + ESTIMATOR_SETTLE_MS
        vals = sorted(r["bps"] for r in tput
                      if r.get("bps") and r.get("bytes") and lo_t <= r["ts"] < end
                      and r["bytes"] * 8 / ESTIMATOR_BURST_S >= rate_bps)
        if len(vals) < ESTIMATOR_MIN_SAMPLES:
            parts.append(f"{c['rate_mbps']} Mbps at_s={c.get('at_s')}: {len(vals)} link-limited samples (not judged)")
            continue
        n = len(vals)
        med = _median(vals)
        lo, hi = ESTIMATOR_BAND
        ok = lo * rate_bps <= med <= hi * rate_bps
        judged += 1
        bad += 0 if ok else 1
        cause = ""
        if not ok:
            pr = [r["p_bytes"] * 8 / (r["dt_ms"] / 1000) for r in (probes or [])
                  if r.get("src", "client") == "client" and r.get("dt_ms") and (r.get("p_bytes") or 0) >= 60_000
                  and lo_t <= r["ts"] < end]
            if pr:
                pmed = _median(pr)
                if abs(pmed - med) <= 0.25 * med:
                    cause = f"; probe transfer {pmed / 1e6:.2f} Mbps over {len(pr)} probes: the connection delivered this little (transport)"
                elif pmed >= lo * rate_bps:
                    cause = f"; probe transfer {pmed / 1e6:.2f} Mbps over {len(pr)} probes: the link was there, client-side timing (M11)"
                else:
                    cause = f"; probe transfer {pmed / 1e6:.2f} Mbps over {len(pr)} probes: inconclusive"
            else:
                cause = "; no probe in the window to attribute the cause (see CONN_STATS cwnd/rtt)"
        parts.append(f"{c['rate_mbps']} Mbps at_s={c.get('at_s')}: median {med / 1e6:.2f} Mbps over {n} link-limited groups "
                     f"(required {lo * c['rate_mbps']:.2f}-{hi * c['rate_mbps']:.2f}){'' if ok else ' OUT OF BAND' + cause}")
    if not judged:
        return None, "; ".join(parts)
    return bad == 0, "; ".join(parts)


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, name: str, ok: bool | None, detail: str) -> None:
        self.rows.append((name, "SKIP" if ok is None else ("PASS" if ok else "FAIL"), detail))

    def info(self, name: str, detail: str) -> None:
        """A reported quantity that never fails the run."""
        self.rows.append((name, "INFO", detail))

    @property
    def failed(self) -> bool:
        return any(r[1] == "FAIL" for r in self.rows)

    def render(self) -> str:
        w = max(len(r[0]) for r in self.rows)
        return "\n".join(f"{r[1]:4}  {r[0]:{w}}  {r[2]}" for r in self.rows)


def _leaf(rec: dict) -> dict:
    """qdisc_stats.leaf of a NET_CHANGE / RUN_END record ({} when absent)."""
    qs = rec.get("qdisc_stats")
    return (qs.get("leaf") or {}) if isinstance(qs, dict) else {}


def _gso_at_qdisc(rec: dict):
    """The GSO verdict of a NET_CHANGE: qdisc_stats.leaf.gso_at_qdisc (what the runner writes),
    else a top-level gso_at_qdisc. True / False / None (unknown)."""
    leaf = _leaf(rec)
    if "gso_at_qdisc" in leaf:
        return leaf["gso_at_qdisc"]
    return rec.get("gso_at_qdisc")


def _text(v) -> str:
    return v if isinstance(v, str) else json.dumps(v) if v is not None else ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", type=Path)
    ap.add_argument("--gop-tolerance", type=float, default=1.5, help="tolerance in GOPs for distance checks")
    ap.add_argument("--clock-tolerance-ms", type=float, default=250.0)
    ap.add_argument("--join-samples", type=int, default=5)
    ap.add_argument("--window-s", type=float, default=5.0, help="seconds after the first frame used for the initial-shift check")
    ap.add_argument("--max-freeze-s", type=float, default=10.0, help="longest tolerated stretch without playhead progress")
    ap.add_argument("--duration-tolerance-s", type=float, default=5.0, help="|RUN_END.elapsed_s - duration| allowed")
    ap.add_argument("--sample-fraction", type=float, default=0.9, help="required SAMPLE count as a fraction of duration / 0.25 s")
    ap.add_argument("--final", action="store_true",
                    help="paper-quality gate: also require a clean git worktree at run time")
    ap.add_argument("--preflight", action="store_true", help="also assert the apparatus invariants (see above)")
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
    required = ["run_id", "git_sha", "branch", "mechanism", "client_type", "delay_groups", "gop_duration_ms",
                "ladder_id", "network_profile", "qdisc", "background_flows", "repeat_index", "timestamp_start"]
    missing = [k for k in required if k not in identity]
    consistent = (identity.get("client_type") == client_meta.get("client_mode")
                  and identity.get("delay_groups") == client_meta.get("delay_groups"))
    # The controller arm the client ran (RUN_META.controller_arm, resolved by the controller)
    # must be the one the runner asked for: identity.controller_family (the URL controllerArm
    # of the runner arm), or identity.controller when the family is absent. Clients before the
    # min arm did not log controller_arm; the comparison is then skipped.
    want_arm = identity.get("controller_family") or identity.get("controller")
    got_arm = client_meta.get("controller_arm")
    arm_ok = got_arm is None or want_arm is None or got_arm == want_arm
    rep.add("identity", not missing and consistent and arm_ok,
            f"missing={missing or 'none'}; client_type={identity.get('client_type')} vs client RUN_META "
            f"{client_meta.get('client_mode')}; delay_groups={identity.get('delay_groups')} vs {client_meta.get('delay_groups')}; "
            f"controller arm {want_arm} (identity.{'controller_family' if identity.get('controller_family') else 'controller'}) vs client "
            f"RUN_META.controller_arm {got_arm if got_arm is not None else 'not logged'}")

    # aborted / completed / samples / net-applied ----------------------------------------
    # The runner marks an aborted run in validation.json (failed: ["aborted"]) and in
    # run_meta.json (validity.aborted); re-validating such a run keeps it invalid.
    aborted = run_marked_aborted(args.run)
    rep.add("aborted", not aborted, f"runner abort marker (validation.json / run_meta.validity): {'aborted' if aborted else 'none'}")

    # summary.json is (re)written once, with the validity block, at the end (not with --no-write).
    summary = analyze(args.run, initial_window_s=args.window_s)
    duration = summary.get("duration_s")
    run_end = summary.get("run_end") or {}
    if duration is None:
        rep.add("completed", None, f"configured duration unknown; RUN_END present={run_end.get('present')} elapsed_s={run_end.get('elapsed_s')}")
        rep.add("samples", None, f"configured duration unknown; SAMPLE count={summary['playback'].get('samples')}")
    else:
        el = run_end.get("elapsed_s")
        ok = bool(run_end.get("present")) and el is not None and abs(el - duration) <= args.duration_tolerance_s
        rep.add("completed", ok, f"RUN_END present={run_end.get('present')} elapsed_s={el} vs duration {duration} (+-{args.duration_tolerance_s:g} s)")
        need = args.sample_fraction * duration / 0.25
        n = summary["playback"].get("samples") or 0
        rep.add("samples", n >= need, f"SAMPLE count={n} required >= {need:.0f} ({args.sample_fraction:g} x {duration:g} s / 0.25 s)")
    changes = by("NET_CHANGE")
    unapplied = [c for c in changes if not c.get("applied")]
    backend_none = (meta.get("net_backend") == "none") or (meta.get("args", {}).get("net") == "none")
    if not changes:
        rep.add("net-applied", None, "no NET_CHANGE records")
    elif unapplied and backend_none:
        rep.add("net-applied", True, f"{len(unapplied)} of {len(changes)} NET_CHANGE not applied: network backend 'none' (unshaped run by design)")
    else:
        rep.add("net-applied", not unapplied, f"{len(changes) - len(unapplied)} of {len(changes)} NET_CHANGE applied"
                + (f"; unapplied at_s={[c.get('at_s') for c in unapplied]}" if unapplied else ""))

    gop = client_meta.get("gop_duration_ms") or 1000
    client_type = client_meta.get("client_mode")
    startup = next(iter(by("STARTUP")), None)
    samples = [s for s in by("SAMPLE") if startup and s["ts"] >= startup["ts"] and s.get("live_edge_distance_ms") is not None]
    # The analyzer owns the initial-shift window definition (stored in the
    # summary), so the check and the reported number cannot drift apart.
    initial = summary["time_shift"]["initial_window"]
    pre_switch = [s for s in samples if initial["end_ms"] is not None and s["ts"] < initial["end_ms"]]

    # live-edge / time-shifted ----------------------------------------------
    if client_type == "live-edge":
        # Setup check only: the client started at the live edge. Drifting behind
        # live later in the run is an outcome the analyzer reports, not an invalid run.
        dist = [s["live_edge_distance_ms"] for s in pre_switch]
        mean = statistics.fmean(dist) if dist else None
        bound = (1 + args.gop_tolerance) * gop
        ok = bool(dist) and client_meta.get("target_shift_ms") == 0 and 0 <= mean <= bound
        rep.add("live-edge", ok, f"initial-window [{initial['definition']}] target_shift_ms={client_meta.get('target_shift_ms')} "
                                 f"mean_distance_ms={mean and round(mean, 1)} (n={len(dist)}, bound {bound:.0f})")
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

    # terminals ----------------------------------------------------------------
    sw_block = summary.get("switches", {})
    terms = sw_block.get("terminals") or {}
    join = sw_block.get("join") or {}
    one_each = sum(terms.values()) == sw_block.get("count", 0)
    unjoined = {k: v for k, v in (join.get("unjoined") or {}).items() if k != "SWITCH_SKIPPED"}
    ok = one_each and not unjoined and not join.get("duplicates") and not join.get("conflicting_terminals")
    rep.add("terminals", ok if switches else None,
            f"terminals={terms} sum={sum(terms.values())} of {sw_block.get('count')}; join={'switch_seq' if join.get('seq_join') else 'fallback'}; "
            f"unjoined={unjoined or 'none'} duplicates={join.get('duplicates') or 'none'} conflicting={join.get('conflicting_terminals')}")

    # relay-stamps ---------------------------------------------------------------
    client_end = max((r["ts"] for r in recs if r.get("src") == "client"), default=None)
    mech = identity.get("mechanism") or summary.get("mechanism")
    if mech in PROMOTING_MECHANISMS and switches:
        due = [sw for sw in switches if sw["terminal"] != "error"
               and (client_end is None or sw["ts"] <= client_end - END_GRACE_MS)]
        missing_stamps = [sw for sw in due if sw.get("relay_promoted_ms") is None]
        rep.add("relay-stamps", not missing_stamps,
                f"mechanism {mech}: {len(due) - len(missing_stamps)} of {len(due)} non-failed switches have relay_promoted_ms"
                + (f"; missing seq={[sw['switch_seq'] for sw in missing_stamps][:5]}" if missing_stamps else ""))
    else:
        rep.add("relay-stamps", None, f"mechanism {mech}: no SWITCH_PROMOTED requirement" if switches else "no switches")

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
    # A run is invalid when the experiment cannot be interpreted because the
    # apparatus failed; it stays valid when the system under test performs badly,
    # even catastrophically, as long as the measurement remains correct. So only
    # a freeze WITH playable data (a player wedge) or a destroyed session fails
    # this check; starvation of any length is a stall, not an exclusion.
    pb = summary.get("playback", {})
    frac = pb.get("advancing_fraction"); longest = pb.get("longest_no_progress_ms") or 0
    wedged = pb.get("longest_frozen_with_data_ms")
    if wedged is None:  # summary from an older analyzer: fall back to the raw freeze length
        wedged = longest
    destroyed = summary.get("switches", {}).get("session_destroyed")
    ok = frac is not None and wedged <= args.max_freeze_s * 1000 and not destroyed
    starved = (summary.get("starvation") or {}).get("raw_total_ms") or 0
    rep.add("playback", ok, f"playhead advancing in {fmt_pct(frac)} of sample intervals (reported, not judged); longest no-progress "
                            f"{longest / 1000:.1f} s, of which frozen with playable data {wedged / 1000:.1f} s (max {args.max_freeze_s:g}: "
                            f"a player wedge is an apparatus failure, starvation is an outcome); session destroyed={destroyed}; "
                            f"data starved {starved / 1000:.1f} s (raw episodes from the last append)")

    # worktree ---------------------------------------------------------------
    dirty = identity.get("dirty_worktree")
    if args.final:
        rep.add("clean-worktree", dirty is False, f"dirty_worktree={dirty} (required false for --final)")
    else:
        rep.add("clean-worktree", None, f"dirty_worktree={dirty} (only enforced with --final)")

    # preflight ----------------------------------------------------------------
    if args.preflight:
        mode = identity.get("mechanism_mode") or summary.get("mechanism_mode")
        as_shipped_native = mech == "native" and not mode
        known = sw_block.get("landed_on_keyframe_known") or 0
        kf = sw_block.get("landed_on_keyframe") or 0
        detail = f"landed on a keyframe {kf} of {known} known ({fmt_pct(kf / known) if known else '-'})"
        if not known:
            rep.add("pf-keyframe", None, detail + "; no landed switch")
        elif as_shipped_native:
            rep.info("pf-keyframe", detail + " (as-shipped native: reported, not asserted)")
        else:
            rep.add("pf-keyframe", kf == known, detail + " (required 100 %)")
        behind = sw_block.get("landed_behind_playhead") or 0
        rep.add("pf-behind", behind == 0, f"landed_behind_playhead={behind} (required 0)")
        # A switch may legitimately still be open when the run ends: it needs the delivery
        # time plus the buffered media ahead of the seam (the target shift) to be presented.
        grace = END_GRACE_MS + (client_meta.get("target_shift_ms") or 0)
        open_late = [sw for sw in switches if sw["terminal"] == "open" and (client_end is None or sw["ts"] <= client_end - grace)]
        # With switch_seq the client emits SWITCH_SUPERSEDED; an inferred terminal then means a
        # record is missing. Old bundles (fallback join) have only inferred superseded switches.
        inferred = [sw for sw in switches if sw.get("terminal_source") == "inferred"] if join.get("seq_join") else []
        rep.add("pf-terminal", one_each and not open_late and not inferred and not join.get("conflicting_terminals")
                and not unjoined and not join.get("duplicates"),
                f"terminals={terms}; open switches sent > {grace / 1000:g} s before the end={len(open_late)}; "
                f"terminal inferred without a record (switch_seq bundles)={len(inferred)}; conflicting={join.get('conflicting_terminals')}; "
                f"unjoined={unjoined or 'none'}; duplicates={join.get('duplicates') or 'none'}")
        first_sw = switches[0]["ts"] if switches else None
        settled = (first_sw + 5000) if first_sw is not None else None
        unrouted = [r for r in by("DROP_STALE") if r.get("reason") == "unrouted" and (settled is None or r["ts"] >= settled)]
        rep.info("pf-unrouted", f"DROP_STALE{{unrouted}} after the first switch settled: {len(unrouted)} objects, "
                                f"{sum(r.get('bytes') or 0 for r in unrouted)} bytes (expected 0)")
        relay_cfg = next(iter(by("RELAY_CONFIG")), None)
        want_cc = identity.get("congestion_controller") or summary.get("congestion_controller")
        if relay_cfg is None:
            rep.add("pf-relay-cc", False, f"no RELAY_CONFIG record; identity congestion_controller={want_cc}")
        else:
            got = relay_cfg.get("congestion_controller")
            rep.add("pf-relay-cc", got is not None and got == want_cc, f"RELAY_CONFIG.congestion_controller={got} vs identity {want_cc}")
        applied = [c for c in changes if c.get("applied")]
        with_stats = [c for c in applied if c.get("qdisc_stats") is not None]
        unshaped = (not applied) or all(c.get("rate_mbps") is None for c in applied) or "unshaped" in str(summary.get("profile"))
        # Rate-limited steps need netem root -> htb -> bfifo|fq_codel; the unshaped profile
        # has the netem delay alone (the leaf qdisc_stats are then netem's).
        bad_tree = []
        for c in applied:
            text = " ".join(_text(c.get(k)) for k in ("tc", "tc_show", "qdisc_tree")).lower()
            levels = {"netem": "netem" in text, "htb": "htb" in text, "leaf": any(k in text for k in ("bfifo", "fq_codel"))}
            need = ("netem",) if c.get("rate_mbps") is None else ("netem", "htb", "leaf")
            if not all(levels[k] for k in need):
                bad_tree.append(f"at_s={c.get('at_s')} rate={c.get('rate_mbps')} saw {sorted(k for k, v in levels.items() if v)}")
        if not applied:
            rep.add("pf-qdisc", None, "no applied NET_CHANGE (unshaped run)")
        else:
            rep.add("pf-qdisc", len(with_stats) == len(applied) and not bad_tree,
                    f"qdisc_stats on {len(with_stats)} of {len(applied)} applied NET_CHANGE; tc tree (netem only when unshaped, "
                    f"netem/htb/leaf when rate-limited) wrong on: {bad_tree or 'none'}")
        # Offloads: GSO super-packets at the qdisc make a packet-counted queue meaningless (C5).
        # The runner writes the verdict into the leaf (net.leaf_stats: qdisc_stats.leaf.gso_at_qdisc);
        # a top-level gso_at_qdisc is read only when the leaf has none.
        limited = [c for c in applied if c.get("rate_mbps") is not None]
        gso = [_gso_at_qdisc(c) for c in limited]
        if not limited:
            rep.add("pf-gso", None, "no rate-limited NET_CHANGE")
        elif any(g is True for g in gso):
            rep.add("pf-gso", False, f"gso_at_qdisc true on {sum(1 for g in gso if g is True)} of {len(limited)} rate-limited NET_CHANGE (required false)")
        elif all(g is False for g in gso):
            rep.add("pf-gso", True, f"gso_at_qdisc false on all {len(limited)} rate-limited NET_CHANGE")
        else:
            rep.info("pf-gso", f"gso_at_qdisc unknown on {sum(1 for g in gso if g is None)} of {len(limited)} rate-limited NET_CHANGE")
        maxpk = []
        for c in applied + list(by("RUN_END")):
            leaf = _leaf(c)
            if leaf.get("maxpacket") is not None:
                maxpk.append(leaf["maxpacket"])
        if not maxpk:
            rep.add("pf-maxpacket", None, "no qdisc_stats.leaf.maxpacket recorded")
        elif max(maxpk) > 3000:
            rep.add("pf-maxpacket", False, f"leaf maxpacket max={max(maxpk)} B > 3000 (super-packets reach the qdisc; expected <= 1514)")
        elif max(maxpk) > 1514:
            rep.info("pf-maxpacket", f"leaf maxpacket max={max(maxpk)} B (expected <= 1514; fails above 3000)")
        else:
            rep.add("pf-maxpacket", True, f"leaf maxpacket max={max(maxpk)} B (<= 1514)")
        bstart = next(iter(by("BROWSER_START")), None)
        warm = (bstart or {}).get("warmup_measured_s")
        rep.info("pf-warmup", f"BROWSER_START.warmup_measured_s={warm} (expected 15 +- 1 s: "
                              f"{'within' if warm is not None and abs(warm - 15) <= 1 else 'OUTSIDE' if warm is not None else 'not recorded'})")
        rep.info("pf-offloads", f"identity.offloads_disabled={identity.get('offloads_disabled')} (expected true)")
        conn = summary.get("conn") or {}
        if unshaped and conn.get("samples"):
            rep.add("pf-loss", (conn.get("loss_rate") or 0) < 0.001,
                    f"unshaped profile: CONN_STATS loss rate={conn.get('loss_rate'):.5f} (lost {conn.get('lost_packets')} of {conn.get('sent_packets')}; required < 0.1 %)")
        else:
            rep.add("pf-loss", None, "shaped profile or no CONN_STATS" if not unshaped else "no CONN_STATS records")
        dpi = conn.get("tx_datagrams_per_io")
        if dpi is None:
            rep.add("pf-relay-gso", None, "no CONN_STATS udp_tx_datagrams/udp_tx_ios on the client connection")
        else:
            rep.add("pf-relay-gso", dpi <= 1.05, f"relay sent {dpi:.3f} UDP datagrams per I/O to the client (required <= 1.05: no GSO batches)")
        est_ok, est_detail = delivery_rate(applied, list(by("THROUGHPUT_SAMPLE")), list(by("PROBE")), client_end)
        rep.add("pf-delivery-rate", est_ok, est_detail)
        steps = [p for p in (summary.get("link") or {}).get("probe_measured_per_step", []) if p.get("rate_mbps") is not None and p["rate_mbps"] <= 1.5]
        if steps:
            low = min(steps, key=lambda p: p["rate_mbps"])
            p50 = low.get("p50_mbps")
            rep.info("pf-probe-rate", f"step {low['rate_mbps']} Mbps (at_s={low.get('at_s')}): probe-measured p50={p50 and round(p50, 2)} Mbps "
                                      f"over {low['probes']} probes (expected >= {0.8 * low['rate_mbps']:.2f}; reported only)")
        else:
            rep.info("pf-probe-rate", "no probe on a step <= 1.5 Mbps (the min arm runs without the probe)")

    print(rep.render())
    if not args.no_write:
        failed = [r[0] for r in rep.rows if r[1] == "FAIL"]
        summary["validity"] = {"valid": not rep.failed, "reasons": failed, "final": args.final, "aborted": aborted}
        (args.run / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
        (args.run / "validation.json").write_text(json.dumps({
            "passed": not rep.failed, "final": args.final, "preflight": args.preflight,
            "failed": failed,
            "checks": [{"name": r[0], "status": r[1], "detail": r[2]} for r in rep.rows],
            "gop_tolerance": args.gop_tolerance, "clock_tolerance_ms": args.clock_tolerance_ms,
            "window_s": args.window_s, "duration_tolerance_s": args.duration_tolerance_s, "sample_fraction": args.sample_fraction,
        }, indent=2))
    return 1 if rep.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
