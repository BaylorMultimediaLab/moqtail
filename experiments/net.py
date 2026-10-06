#!/usr/bin/env python3
"""Network shaping for the experiment runner (docs/rebuild-2026-10-04.md, "Shaping").

Two backends:

* ``none``  -- no shaping; every ``apply`` is only logged. Use it on macOS or
  for smoke tests.
* ``netns`` -- Linux only, needs root (or passwordless sudo for ip/tc/ethtool).
  Creates a network namespace for the browser, joined to the host by a veth
  pair. The relay (and Vite) listen on the host side; the browser inside the
  namespace reaches them through the veth. The relay->client direction is
  shaped on the host-side veth egress, the client->relay direction gets the
  other half of the propagation delay on the namespace-side veth egress.

One topology for both queue models (host-side egress, relay -> client)::

    root  netem delay <half>ms limit 10000            handle 1:   propagation, never the bottleneck
      └ htb  (parent 1:1)  class 2:10 rate R ceil R   handle 2:   the bottleneck rate
          └ leaf (parent 2:10)                        handle 20:
                bfifo limit <queue_pkts x 1500>                   tail-drop, counted in bytes
             or fq_codel limit 10240 target <t> interval 100ms    t = max(5 ms, 1.5 x MTU time at R)

Namespace-side egress (client -> relay): ``netem delay <half>ms limit 10000``.

Why netem is the root: netem is classful with exactly one class (``1:1``),
documented in netem(8) as the parent for a rate limiter; the kernel's
``netem_find`` accepts any class id, so ``parent 1:1`` (used here) and
``parent 1:`` both attach the child. The delay line is traversed first and
the bottleneck queue second, which keeps the queue after the propagation
delay like a real access link. The alternative (HTB root, netem leaf) cannot
host a second leaf qdisc for the AQM arm, and an IFB would put the delay on
the ingress side with a different drop point; both were rejected so that
tail-drop and fq_codel differ only in the leaf.

Capacity steps are applied in place (``tc class change`` for the rate,
``tc qdisc change`` for the leaf and the netem delay/loss); the tree is built
once per run and never deleted between steps, so nothing queued is dropped at
a step. Before any qdisc is added the offloads (GSO, TSO, GRO, UDP GSO, UDP
GRO forwarding) are disabled on both veth ends, and ``ethtool -k`` is
recorded.

What turning offloads off does *not* do: an application that builds UDP GSO
batches itself (``UDP_SEGMENT``, which quinn-udp uses on Linux) hands the
qdisc one skb per batch whatever the device features say; the kernel
segments it only after the qdisc, in ``validate_xmit_skb``. The leaf is
therefore a ``bfifo`` sized in bytes (its limit is right whatever the skb
size), but HTB still releases a batch as one unit, and ``tc -s`` counts a
batch as ``gso_segs`` packets, so bytes/packets cannot reveal it. What can:
fq_codel's ``maxpacket`` (largest skb seen) and the bytes per queued skb in
``backlog``; ``leaf_stats`` reports both as ``gso_at_qdisc``. The fix, if
the preflight finds batches at the qdisc, is in the relay (quinn
``TransportConfig::enable_segmentation_offload(false)``) or, untested,
``--offloads ...,tx`` (no checksum offload on the route device makes the
kernel refuse UDP GSO with EIO, after which quinn-udp stops batching).

Everything that builds a command line is a pure function of the profile and
is unit-tested in ``experiments/tests/test_net.py``. ``--dry-run`` prints the
commands per step without running anything; ``--verify`` builds the tree on
a Linux host, checks ``tc qdisc show`` lists the three levels, and tears it
down again.

Background TCP flows (iperf3) run from inside the namespace to an iperf3
server on the host, so they share the bottleneck with the video.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

MTU_BYTES = 1500
NETEM_LIMIT_PKTS = 10000
CODEL_LIMIT_PKTS = 10240
CODEL_INTERVAL_MS = 100
CODEL_MIN_TARGET_MS = 5.0
CODEL_TARGET_MTU_FACTOR = 1.5
# `ethtool -K` short names, in the order they are applied. `ethtool -k` reports
# them under the long names in OFFLOAD_LONG_NAMES.
DEFAULT_OFFLOADS = ("gso", "tso", "gro", "tx-udp-segmentation", "rx-udp-gro-forwarding")
OFFLOAD_LONG_NAMES = {
    "gso": "generic-segmentation-offload",
    "tso": "tcp-segmentation-offload",
    "gro": "generic-receive-offload",
    "sg": "scatter-gather",
    "tx": "tx-checksumming",
    "rx": "rx-checksumming",
}

# Handles of the three levels; fixed so `tc ... change` always addresses the
# same objects and the verifier knows what to expect.
NETEM_HANDLE = "1:"
NETEM_CLASS = "1:1"
HTB_HANDLE = "2:"
HTB_CLASS = "2:10"
LEAF_HANDLE = "20:"

QUEUES = ("tail-drop", "fq_codel")


@dataclass(frozen=True)
class Shape:
    rate_mbps: float | None = None  # None = no rate limit (netem-only tree)
    delay_ms: float = 0.0  # round trip; half is applied on each side
    loss_pct: float = 0.0
    jitter_ms: float = 0.0


@dataclass(frozen=True)
class Topology:
    host_if: str = "veth-moqh"
    ns: str = "moqc"
    ns_if: str = "veth-moqc"
    queue: str = "tail-drop"
    queue_pkts: int = 100
    mtu: int = MTU_BYTES
    netem_limit: int = NETEM_LIMIT_PKTS
    codel_limit: int = CODEL_LIMIT_PKTS
    codel_interval_ms: int = CODEL_INTERVAL_MS
    codel_ecn: bool = True  # fq_codel's kernel default; made explicit so the command says so
    offloads: tuple[str, ...] = DEFAULT_OFFLOADS

    def __post_init__(self) -> None:
        if self.queue not in QUEUES:
            raise ValueError(f"queue must be one of {QUEUES}, got {self.queue!r}")
        if self.queue_pkts <= 0:
            raise ValueError("queue_pkts must be positive")


@dataclass(frozen=True)
class Cmd:
    """One shell command. ``check`` false = failure is tolerated (cleanup, optional features)."""
    argv: str
    check: bool = True
    why: str = ""

    def __str__(self) -> str:
        return self.argv + ("" if self.check else "   # failure tolerated")


# -- pure builders -----------------------------------------------------------

def fmt_num(x: float) -> str:
    """12.0 -> '12', 22.5 -> '22.5'; tc parses both."""
    return f"{x:g}"


def rate_arg(rate_mbps: float) -> str:
    """tc rate in kbit (decimal; tc's mbit/kbit are powers of ten). 1.5 -> '1500kbit'."""
    return f"{int(round(rate_mbps * 1000))}kbit"


def queue_bytes(queue_pkts: int, mtu: int = MTU_BYTES) -> int:
    return queue_pkts * mtu


def codel_target_ms(rate_mbps: float, mtu: int = MTU_BYTES) -> float:
    """max(5 ms, 1.5 x serialisation time of one MTU packet at the step's rate)."""
    mtu_time_ms = mtu * 8 / (rate_mbps * 1000.0)
    return max(CODEL_MIN_TARGET_MS, CODEL_TARGET_MTU_FACTOR * mtu_time_ms)


def netem_opts(shape: Shape, topo: Topology) -> str:
    half = shape.delay_ms / 2.0
    s = f"delay {fmt_num(half)}ms"
    if shape.jitter_ms:
        s += f" {fmt_num(shape.jitter_ms / 2.0)}ms"
    if shape.loss_pct > 0:
        s += f" loss {fmt_num(shape.loss_pct)}%"
    return s + f" limit {topo.netem_limit}"


def leaf_opts(shape: Shape, topo: Topology) -> str:
    if topo.queue == "tail-drop":
        return f"bfifo limit {queue_bytes(topo.queue_pkts, topo.mtu)}"
    assert shape.rate_mbps is not None
    t = codel_target_ms(shape.rate_mbps, topo.mtu)
    ecn = "ecn" if topo.codel_ecn else "noecn"
    return f"fq_codel limit {topo.codel_limit} target {fmt_num(t)}ms interval {topo.codel_interval_ms}ms {ecn}"


def ns_exec(topo: Topology, cmd: str) -> str:
    return f"ip netns exec {topo.ns} {cmd}"


def offload_commands(topo: Topology) -> list[Cmd]:
    """One `ethtool -K <if> <feature> off` per feature per end, so an unsupported
    name on this kernel (reported by ethtool, tolerated here) does not stop the
    others from being applied. Then `ethtool -k` on both ends for the record."""
    cmds: list[Cmd] = []
    for feat in topo.offloads:
        cmds.append(Cmd(f"ethtool -K {topo.host_if} {feat} off", check=False, why="offload host end"))
    for feat in topo.offloads:
        cmds.append(Cmd(ns_exec(topo, f"ethtool -K {topo.ns_if} {feat} off"), check=False, why="offload ns end"))
    host_k, ns_k = readback_commands(topo)
    cmds.append(Cmd(host_k, why="record offloads host end"))
    cmds.append(Cmd(ns_k, why="record offloads ns end"))
    return cmds


def readback_commands(topo: Topology) -> tuple[str, str]:
    """`ethtool -k` on the host end and on the namespace end, in that order."""
    return f"ethtool -k {topo.host_if}", ns_exec(topo, f"ethtool -k {topo.ns_if}")


def setup_commands(shape: Shape, topo: Topology) -> list[Cmd]:
    """Build the tree for the first step. The leading `del root` only clears a
    leftover from an earlier crashed run; it is the only del in a run."""
    h, c = topo.host_if, topo.ns_if
    cmds = [
        Cmd(f"tc qdisc del dev {h} root", check=False, why="clear leftovers"),
        Cmd(ns_exec(topo, f"tc qdisc del dev {c} root"), check=False, why="clear leftovers"),
        Cmd(f"tc qdisc add dev {h} root handle {NETEM_HANDLE} netem {netem_opts(shape, topo)}", why="propagation"),
    ]
    if shape.rate_mbps is not None:
        r = rate_arg(shape.rate_mbps)
        cmds += [
            Cmd(f"tc qdisc add dev {h} parent {NETEM_CLASS} handle {HTB_HANDLE} htb default {HTB_CLASS.split(':')[1]}",
                why="bottleneck"),
            Cmd(f"tc class add dev {h} parent {HTB_HANDLE} classid {HTB_CLASS} htb rate {r} ceil {r}", why="rate"),
            Cmd(f"tc qdisc add dev {h} parent {HTB_CLASS} handle {LEAF_HANDLE} {leaf_opts(shape, topo)}", why="queue"),
        ]
    cmds.append(Cmd(ns_exec(topo, f"tc qdisc add dev {c} root handle {NETEM_HANDLE} netem {netem_opts(shape, topo)}"),
                    why="return path"))
    return cmds


def change_commands(prev: Shape, new: Shape, topo: Topology) -> list[Cmd]:
    """In-place changes from `prev` to `new`; only what differs is touched.
    Nothing is deleted or added, so queued packets survive the step."""
    if (prev.rate_mbps is None) != (new.rate_mbps is None):
        raise ValueError("a profile cannot switch between rate-limited and unlimited steps "
                         "(the tree is built once; use two profiles)")
    h, c = topo.host_if, topo.ns_if
    cmds: list[Cmd] = []
    if netem_opts(prev, topo) != netem_opts(new, topo):
        cmds.append(Cmd(f"tc qdisc change dev {h} root handle {NETEM_HANDLE} netem {netem_opts(new, topo)}",
                        why="delay/loss"))
    if new.rate_mbps is not None:
        if prev.rate_mbps != new.rate_mbps:
            r = rate_arg(new.rate_mbps)
            cmds.append(Cmd(f"tc class change dev {h} parent {HTB_HANDLE} classid {HTB_CLASS} htb rate {r} ceil {r}",
                            why="rate"))
        if leaf_opts(prev, topo) != leaf_opts(new, topo):
            cmds.append(Cmd(f"tc qdisc change dev {h} parent {HTB_CLASS} handle {LEAF_HANDLE} {leaf_opts(new, topo)}",
                            why="queue"))
    if netem_opts(prev, topo) != netem_opts(new, topo):
        cmds.append(Cmd(ns_exec(topo, f"tc qdisc change dev {c} root handle {NETEM_HANDLE} netem {netem_opts(new, topo)}"),
                        why="return path"))
    return cmds


def step_commands(steps: list[Shape], topo: Topology) -> list[list[Cmd]]:
    """Commands per profile step: setup for the first, in-place changes after."""
    out: list[list[Cmd]] = []
    prev: Shape | None = None
    for s in steps:
        out.append(setup_commands(s, topo) if prev is None else change_commands(prev, s, topo))
        prev = s
    return out


def expected_tree(shape: Shape, topo: Topology) -> list[tuple[str, str, str]]:
    """(kind, handle, parent) the host-side `tc qdisc show` must list."""
    tree = [("netem", NETEM_HANDLE, "root")]
    if shape.rate_mbps is not None:
        leaf = "bfifo" if topo.queue == "tail-drop" else "fq_codel"
        tree += [("htb", HTB_HANDLE, NETEM_CLASS), (leaf, LEAF_HANDLE, HTB_CLASS)]
    return tree


# -- parsers -----------------------------------------------------------------

_QDISC_HEAD = re.compile(r"^qdisc (?P<kind>\S+) (?P<handle>\S+) (?:(?P<root>root)|parent (?P<parent>\S+))(?P<opts>.*)$")
_SENT = re.compile(r"Sent (?P<bytes>\d+) bytes (?P<pkts>\d+) pkt \(dropped (?P<dropped>\d+), overlimits (?P<over>\d+) requeues (?P<req>\d+)\)")
# tc prints sizes with sprint_size(): plain bytes, or "<n>Kb"/"<n>Mb" when the
# value is within a few bytes of a multiple of 1024 (e.g. "backlog 3Kb 2p").
_BACKLOG = re.compile(r"backlog (?P<num>\d+(?:\.\d+)?)(?P<unit>[KM]?)b (?P<pkts>\d+)p")
# fq_codel extended stats (`tc -s`): maxpacket is the largest skb seen, the
# direct evidence of GSO batches at the qdisc; ecn_mark counts CE marks, which
# are congestion signals that never show up as drops.
_XSTAT = re.compile(r"\b(?P<name>maxpacket|drop_overlimit|new_flow_count|ecn_mark) (?P<val>\d+)")
_UNIT = {"": 1, "K": 1024, "M": 1024 * 1024}


def _size(num: str, unit: str) -> int:
    return int(round(float(num) * _UNIT[unit]))


def parse_qdisc_show(text: str) -> list[dict]:
    """Parse `tc [-s] qdisc show dev X` into one dict per qdisc: kind, handle,
    parent ('root' for the root), options, and when `-s` was given sent_bytes,
    sent_pkts, dropped, overlimits, requeues, backlog_bytes, backlog_pkts, and
    fq_codel's maxpacket/drop_overlimit/new_flow_count/ecn_mark.

    `sent_pkts` counts GSO segments (the kernel adds gso_segs per skb), while
    `backlog_pkts` and `dropped` count skbs."""
    out: list[dict] = []
    cur: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        m = _QDISC_HEAD.match(line)
        if m:
            cur = {"kind": m["kind"], "handle": m["handle"], "parent": "root" if m["root"] else m["parent"],
                   "options": m["opts"].strip()}
            out.append(cur)
            continue
        if cur is None:
            continue
        m = _SENT.search(line)
        if m:
            cur.update(sent_bytes=int(m["bytes"]), sent_pkts=int(m["pkts"]), dropped=int(m["dropped"]),
                       overlimits=int(m["over"]), requeues=int(m["req"]))
            continue
        m = _BACKLOG.search(line)
        if m:
            cur.update(backlog_bytes=_size(m["num"], m["unit"]), backlog_pkts=int(m["pkts"]))
        for m in _XSTAT.finditer(line):
            cur[m["name"]] = int(m["val"])
    return out


def verify_tree(show_text: str, shape: Shape, topo: Topology) -> list[str]:
    """Errors (empty = ok) for the host-side tree against `expected_tree`."""
    got = parse_qdisc_show(show_text)
    want = expected_tree(shape, topo)
    errors: list[str] = []
    by_handle = {q["handle"]: q for q in got}
    for kind, handle, parent in want:
        q = by_handle.get(handle)
        if q is None:
            errors.append(f"missing qdisc {kind} handle {handle} (parent {parent})")
            continue
        if q["kind"] != kind:
            errors.append(f"handle {handle}: expected {kind}, found {q['kind']}")
        if q["parent"] != parent:
            errors.append(f"handle {handle}: expected parent {parent}, found {q['parent']}")
    extra = [q for q in got if q["handle"] not in {h for _, h, _ in want} and q["kind"] not in ("ingress", "clsact")]
    for q in extra:
        errors.append(f"unexpected qdisc {q['kind']} {q['handle']} parent {q['parent']}")
    if not got:
        errors.append("tc qdisc show listed nothing")
    return errors


# qdisc_pkt_len of one wire packet on a veth: MTU + Ethernet header. A skb
# larger than twice that can only be a GSO batch.
L2_HEADER_BYTES = 14


def gso_evidence(leaf: dict, mtu: int = MTU_BYTES) -> dict:
    """Whether GSO batches reached the leaf, from what `tc -s` can show.

    `sent_bytes / sent_pkts` cannot tell (packets are counted per segment), so
    the evidence is fq_codel's `maxpacket` (largest skb ever seen, run-wide)
    and the bytes per queued skb in the `backlog` snapshot. `gso_at_qdisc` is
    True when either exceeds two wire packets, False only when fq_codel saw
    traffic and its largest skb was one wire packet, None otherwise (bfifo
    with an empty or small-packet backlog proves nothing)."""
    wire = mtu + L2_HEADER_BYTES
    bq, pq = leaf.get("backlog_bytes"), leaf.get("backlog_pkts")
    per_skb = (bq / pq) if pq else None
    maxpkt = leaf.get("maxpacket")
    verdict: bool | None = None
    if (maxpkt is not None and maxpkt > 2 * wire) or (per_skb is not None and per_skb > 2 * wire):
        verdict = True
    elif maxpkt is not None and leaf.get("sent_pkts") and maxpkt <= wire:
        verdict = False
    return {"max_skb_bytes": maxpkt, "backlog_bytes_per_skb": per_skb, "gso_at_qdisc": verdict}


_HTB_CLASS_HEAD = re.compile(r"^class htb (?P<classid>\S+) .*?\brate (?P<rate>\d+(?:\.\d+)?)(?P<unit>[KMG]?)bit\b")
_RATE_UNIT = {"": 1, "K": 1_000, "M": 1_000_000, "G": 1_000_000_000}


def parse_htb_class_rate(text: str, classid: str = HTB_CLASS) -> int | None:
    """The rate (bit/s) of htb class `classid` in `tc class show dev X`, None if absent.
    tc prints the rate with decimal SI units ("1500Kbit", "6Mbit")."""
    for raw in text.splitlines():
        m = _HTB_CLASS_HEAD.match(raw.strip())
        if m and m["classid"] == classid:
            return round(float(m["rate"]) * _RATE_UNIT[m["unit"]])
    return None


def parse_udp_snmp(text: str) -> dict[str, int]:
    """The `Udp:` counters of /proc/net/snmp (header line, then values)."""
    rows = [line.split() for line in text.splitlines() if line.startswith("Udp:")]
    if len(rows) < 2:
        return {}
    return {k: int(v) for k, v in zip(rows[0][1:], rows[1][1:]) if v.lstrip("-").isdigit()}


def leaf_stats(show_text: str, shape: Shape, topo: Topology) -> dict:
    """The bottleneck leaf's counters from `tc -s qdisc show dev <host_if>`
    (bytes, packets, drops, backlog, plus fq_codel's extended stats), the GSO
    evidence of `gso_evidence`, the whole parsed tree and the raw text."""
    tree = parse_qdisc_show(show_text)
    leaf_handle = LEAF_HANDLE if shape.rate_mbps is not None else NETEM_HANDLE
    leaf = next((q for q in tree if q["handle"] == leaf_handle), None)
    stats = {"leaf": None, "tree": tree, "raw": show_text.strip()}
    if leaf is not None:
        stats["leaf"] = {**leaf, **gso_evidence(leaf, topo.mtu)}
    return stats


_ETHTOOL_K = re.compile(r"^(?P<name>[a-z0-9-]+): (?P<state>on|off)(?P<fixed> \[fixed\])?", re.I)


def parse_ethtool_k(text: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for raw in text.splitlines():
        m = _ETHTOOL_K.match(raw.strip())
        if m:
            out[m["name"]] = {"on": m["state"].lower() == "on", "fixed": bool(m["fixed"])}
    return out


def offload_summary(features: tuple[str, ...], ethtool_k_text: str) -> dict:
    """Requested features -> 'off' | 'on' | 'off [fixed]' | 'on [fixed]' | 'absent',
    and `all_off`: every requested feature is off or absent (an absent feature
    cannot be on)."""
    parsed = parse_ethtool_k(ethtool_k_text)
    per: dict[str, str] = {}
    for f in features:
        name = OFFLOAD_LONG_NAMES.get(f, f)
        st = parsed.get(name)
        if st is None:
            per[f] = "absent"
        else:
            per[f] = ("on" if st["on"] else "off") + (" [fixed]" if st["fixed"] else "")
    return {"features": per, "all_off": all(not v.startswith("on") for v in per.values())}


# -- profiles ----------------------------------------------------------------

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
    if prof["queue"] not in QUEUES:
        raise SystemExit(f"{path}: queue must be one of {QUEUES}")
    prof["steps"] = sorted(prof["steps"], key=lambda s: s["at_s"])
    if not prof["steps"] or prof["steps"][0]["at_s"] != 0:
        raise SystemExit(f"{path}: the first step must be at_s 0")
    limited = {s.get("rate_mbps") is not None for s in prof["steps"]}
    if len(limited) > 1:
        raise SystemExit(f"{path}: all steps must have a rate_mbps, or none (the tree is built once per run)")
    return prof


def profile_shapes(prof: dict) -> list[Shape]:
    return [Shape(rate_mbps=s.get("rate_mbps"), delay_ms=s.get("delay_ms", 0), loss_pct=s.get("loss_pct", 0),
                  jitter_ms=s.get("jitter_ms", 0)) for s in prof["steps"]]


def profile_topology(prof: dict, **overrides) -> Topology:
    kw = {"queue": prof["queue"], "queue_pkts": int(prof["queue_pkts"])}
    if "codel_ecn" in prof:
        kw["codel_ecn"] = bool(prof["codel_ecn"])
    kw.update(overrides)
    return Topology(**kw)


def step_record(shape: Shape, topo: Topology) -> dict:
    """Resolved queue parameters for the NET_CHANGE record."""
    rec = {"rate_mbps": shape.rate_mbps, "delay_ms": shape.delay_ms, "loss_pct": shape.loss_pct,
           "jitter_ms": shape.jitter_ms, "queue": topo.queue, "queue_pkts": topo.queue_pkts,
           "netem_limit_pkts": topo.netem_limit}
    if shape.rate_mbps is None:
        return rec
    if topo.queue == "tail-drop":
        rec["queue_bytes"] = queue_bytes(topo.queue_pkts, topo.mtu)
    else:
        rec.update(codel_target_ms=round(codel_target_ms(shape.rate_mbps, topo.mtu), 3),
                   codel_interval_ms=topo.codel_interval_ms, codel_limit_pkts=topo.codel_limit,
                   codel_ecn=topo.codel_ecn)
    return rec


# -- execution ----------------------------------------------------------------

def sudo_prefix() -> list[str]:
    """`ip`/`tc`/`ethtool` need root. Run them through non-interactive sudo when
    the runner itself is unprivileged (the browser, relay and publisher then
    stay the user's own processes). `sudo -v` once before a series, or a
    NOPASSWD rule for ip/tc/ethtool/kill, keeps the prompt out of the run."""
    return [] if os.geteuid() == 0 else ["sudo", "-n"]


def _run(cmd: str, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess:
    argv = sudo_prefix() + shlex.split(cmd)
    if not quiet:
        print(f"[net] $ {' '.join(argv)}")
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def run_cmds(cmds: list[Cmd]) -> list[dict]:
    """Run commands in order; a failing `check` command raises after recording."""
    results = []
    for c in cmds:
        r = _run(c.argv, check=False)
        results.append({"cmd": c.argv, "rc": r.returncode, "stderr": r.stderr.strip()[:500],
                        "stdout": r.stdout[:20000]})
        if c.check and r.returncode != 0:
            raise SystemExit(f"[net] command failed ({r.returncode}): {c.argv}\n{r.stderr.strip()}")
    return results


def tc_version() -> str | None:
    try:
        r = subprocess.run(["tc", "-V"], capture_output=True, text=True)
        return (r.stdout or r.stderr).strip() or None
    except OSError:
        return None


class NoneBackend:
    name = "none"

    def __init__(self, **_: object) -> None:
        self.topo: Topology | None = None
        self.offloads: dict = {}

    def setup(self, topo: Topology) -> None:
        self.topo = topo
        print("[net] backend=none: no shaping will be applied")

    def apply(self, shape: Shape) -> dict:
        print(f"[net] (not applied) {shape}")
        return {"tc": [], "applied": False}

    def verify(self, shape: Shape) -> None:
        pass

    def stats(self) -> dict | None:
        return None

    def client_udp(self) -> dict | None:
        return None

    def teardown(self) -> None:
        pass

    def wrap(self, cmd: list[str]) -> list[str]:
        """Command prefix to run a process on the client side (none here)."""
        return cmd

    @property
    def detaches_itself(self) -> bool:
        return False

    @property
    def relay_host(self) -> str:
        return "127.0.0.1"

    @property
    def vite_host(self) -> str:
        return "localhost"


class NetnsBackend:
    name = "netns"

    def __init__(
        self,
        ns: str = "moqc",
        host_if: str = "veth-moqh",
        ns_if: str = "veth-moqc",
        host_ip: str = "10.200.0.1",
        ns_ip: str = "10.200.0.2",
        prefix: int = 24,
    ) -> None:
        self.ns, self.host_if, self.ns_if = ns, host_if, ns_if
        self.host_ip, self.ns_ip, self.prefix = host_ip, ns_ip, prefix
        self.topo: Topology | None = None
        self.current: Shape | None = None
        self.offloads: dict = {}

    # -- lifecycle -----------------------------------------------------------
    def setup(self, topo: Topology) -> None:
        self.topo = Topology(**{**asdict(topo), "host_if": self.host_if, "ns": self.ns, "ns_if": self.ns_if})
        if os.geteuid() != 0:
            probe = subprocess.run(["sudo", "-n", "true"], capture_output=True)
            if probe.returncode != 0:
                raise SystemExit("[net] backend=netns needs passwordless sudo for ip/tc/ethtool: run `sudo -v` first "
                                 "(or add a NOPASSWD rule), then retry")
        for tool in ("ip", "tc", "ethtool"):
            if shutil.which(tool) is None and not Path(f"/usr/sbin/{tool}").exists() and not Path(f"/sbin/{tool}").exists():
                raise SystemExit(f"[net] {tool} not found; install iproute2 and ethtool")
        self.teardown()
        _run(f"ip netns add {self.ns}")
        _run(f"ip link add {self.host_if} type veth peer name {self.ns_if}")
        _run(f"ip link set {self.ns_if} netns {self.ns}")
        _run(f"ip addr add {self.host_ip}/{self.prefix} dev {self.host_if}")
        _run(f"ip link set {self.host_if} up")
        _run(f"ip netns exec {self.ns} ip addr add {self.ns_ip}/{self.prefix} dev {self.ns_if}")
        _run(f"ip netns exec {self.ns} ip link set {self.ns_if} up")
        _run(f"ip netns exec {self.ns} ip link set lo up")
        _run(f"ip netns exec {self.ns} ip route add default via {self.host_ip}")
        # Offloads off on both ends before any qdisc exists (C5).
        results = run_cmds(offload_commands(self.topo))
        host_k, ns_k = (next(r["stdout"] for r in results if r["cmd"] == cmd)
                        for cmd in readback_commands(self.topo))
        self.offloads = {
            "requested": list(self.topo.offloads),
            "host": offload_summary(self.topo.offloads, host_k),
            "ns": offload_summary(self.topo.offloads, ns_k),
            "ethtool_K": [{k: v for k, v in r.items() if k != "stdout"} for r in results if " -K " in r["cmd"]],
        }
        self.offloads["all_off"] = self.offloads["host"]["all_off"] and self.offloads["ns"]["all_off"]
        print(f"[net] offloads host={self.offloads['host']['features']} ns={self.offloads['ns']['features']}")
        _run(f"ip netns exec {self.ns} ping -c 1 -W 1 {self.host_ip}", check=False, quiet=True)

    def teardown(self) -> None:
        _run(f"ip netns del {self.ns}", check=False, quiet=True)
        _run(f"ip link del {self.host_if}", check=False, quiet=True)
        self.current = None

    # -- shaping -------------------------------------------------------------
    def apply(self, shape: Shape) -> dict:
        """First call builds the tree and verifies it; later calls change it in
        place. Returns the resolved commands and their results."""
        assert self.topo is not None, "setup() first"
        if self.current is None:
            cmds = setup_commands(shape, self.topo)
        else:
            cmds = change_commands(self.current, shape, self.topo)
        results = run_cmds(cmds)
        self.current = shape
        if len(cmds) and cmds[0].why == "clear leftovers":
            self.verify(shape)
        return {"tc": [c.argv for c in cmds], "tc_results": results, "applied": True}

    def show(self, stats: bool = False) -> str:
        return _run(f"tc {'-s ' if stats else ''}qdisc show dev {self.host_if}", check=False, quiet=True).stdout

    def verify(self, shape: Shape) -> None:
        """Fail loudly unless `tc qdisc show` lists every level of the tree on the
        host side and the netem on the namespace side."""
        assert self.topo is not None
        errors = verify_tree(self.show(), shape, self.topo)
        ns_show = _run(f"ip netns exec {self.ns} tc qdisc show dev {self.ns_if}", check=False, quiet=True).stdout
        ns_tree = parse_qdisc_show(ns_show)
        if not any(q["kind"] == "netem" and q["parent"] == "root" for q in ns_tree):
            errors.append(f"namespace side: no root netem on {self.ns_if}: {ns_show.strip()!r}")
        if errors:
            raise SystemExit("[net] shaping tree verification FAILED:\n  " + "\n  ".join(errors)
                             + f"\nhost side `tc qdisc show dev {self.host_if}`:\n{self.show()}")
        print(f"[net] verified tree on {self.host_if}: " + " -> ".join(
            f"{k} {h}" for k, h, _ in expected_tree(shape, self.topo)))

    def stats(self) -> dict | None:
        """`leaf_stats` of the host-side tree, plus on a rate-limited step the htb
        class's rate as the kernel holds it (`htb_class.rate_bps`): a capacity step
        is a `tc class change`, which the qdisc listing does not show."""
        if self.topo is None or self.current is None:
            return None
        out = leaf_stats(self.show(stats=True), self.current, self.topo)
        if self.current.rate_mbps is not None:
            text = _run(f"tc class show dev {self.host_if}", check=False, quiet=True).stdout
            out["htb_class"] = {"classid": HTB_CLASS, "rate_bps": parse_htb_class_rate(text)}
        return out

    def client_udp(self) -> dict | None:
        """The client namespace's UDP counters (InDatagrams, InErrors, RcvbufErrors,
        ...) and the socket receive-buffer limits: a datagram the browser's socket had
        no room for is lost after the qdisc, where `tc -s` cannot see it (preflight 3:
        22-36 packets lost in a startup burst on three unshaped runs, 0 at the qdisc)."""
        if self.topo is None:
            return None
        snmp = _run(f"ip netns exec {self.ns} cat /proc/net/snmp", check=False, quiet=True).stdout
        out: dict = {"udp": parse_udp_snmp(snmp)}
        for key in ("net.core.rmem_default", "net.core.rmem_max"):
            r = _run(f"ip netns exec {self.ns} sysctl -n {key}", check=False, quiet=True)
            out[key.split(".")[-1]] = int(r.stdout.strip()) if r.stdout.strip().isdigit() else None
        return out

    # -- helpers -------------------------------------------------------------
    def wrap(self, cmd: list[str]) -> list[str]:
        """Run `cmd` inside the namespace. Entering a namespace needs root; the
        command itself is dropped back to the invoking user so the browser
        never runs as root (Chromium refuses, Firefox misbehaves, and the
        profile would be root-owned)."""
        if os.geteuid() == 0:
            return ["ip", "netns", "exec", self.ns] + cmd
        user = os.environ.get("SUDO_USER") or os.environ.get("USER") or str(os.getuid())
        keep = [f"{k}={v}" for k, v in os.environ.items()
                if k in ("HOME", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "LANG", "MOZ_LOG", "MOZ_LOG_FILE",
                         "MOZ_HEADLESS")]
        # `runuser` (util-linux) lets root become the user without consulting the
        # sudo policy. `setsid -w` detaches the command into its own session only
        # *after* sudo has run: Ubuntu's sudo caches credentials per terminal, so
        # the sudo itself must keep the runner's terminal (a session-less sudo
        # sees no timestamp and fails with "a password is required").
        return ["sudo", "-n", "ip", "netns", "exec", self.ns, "runuser", "-u", user, "--",
                "setsid", "-w", "env", *keep] + cmd

    @property
    def detaches_itself(self) -> bool:
        """The wrapped command creates its own session; the caller must not."""
        return os.geteuid() != 0

    @property
    def relay_host(self) -> str:
        return self.host_ip

    @property
    def vite_host(self) -> str:
        return self.host_ip


def make_backend(name: str, **kwargs: object):
    if name == "none":
        return NoneBackend(**kwargs)
    if name == "netns":
        return NetnsBackend(**kwargs)
    raise SystemExit(f"unknown net backend {name!r}")


class BackgroundFlows:
    """iperf3 TCP flows from the client side to the relay side.

    ``pattern`` is ``steady`` (N parallel flows for the whole run) or
    ``bursty`` (N flows on for ``on_s`` seconds, off for ``off_s``).
    """

    def __init__(self, backend, flows: int, pattern: str = "steady", on_s: float = 10, off_s: float = 10,
                 port: int = 5201, cc: str | None = None, log=None) -> None:
        self.backend, self.flows, self.pattern = backend, flows, pattern
        self.on_s, self.off_s, self.port, self.cc = on_s, off_s, port, cc
        self.server: subprocess.Popen | None = None
        self.client: subprocess.Popen | None = None
        self.log = log or (lambda *_: None)
        self._next_toggle = 0.0
        self._on = False

    def start(self, duration_s: float) -> None:
        if self.flows <= 0:
            return
        self.server = subprocess.Popen(["iperf3", "-s", "-p", str(self.port)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        if self.pattern == "steady":
            self._start_client(duration_s)
        else:
            self._next_toggle = time.time()
        self.log("BG_FLOWS", {"flows": self.flows, "pattern": self.pattern, "cc": self.cc, "port": self.port})

    def _start_client(self, seconds: float) -> None:
        cmd = ["iperf3", "-c", self.backend.relay_host, "-p", str(self.port), "-t", str(int(seconds)),
               "-P", str(self.flows)]
        if self.cc:
            cmd += ["-C", self.cc]
        self.client = subprocess.Popen(self.backend.wrap(cmd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       preexec_fn=None if self.backend.detaches_itself else os.setsid)
        self._on = True
        self.log("BG_FLOW_ON", {"flows": self.flows, "seconds": seconds})

    def tick(self) -> None:
        """Call periodically; drives the bursty pattern."""
        if self.flows <= 0 or self.pattern != "bursty":
            return
        now = time.time()
        if now < self._next_toggle:
            return
        if self._on:
            if self.client:
                self.client.terminate()
            self._on = False
            self.log("BG_FLOW_OFF", {})
            self._next_toggle = now + self.off_s
        else:
            self._start_client(self.on_s)
            self._next_toggle = now + self.on_s

    def stop(self) -> None:
        # The client may sit behind sudo/runuser wrappers: signal it by command line.
        subprocess.run(["pkill", "-TERM", "-f", f"iperf3 -c {self.backend.relay_host}"], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for p in (self.client, self.server):
            if p and p.poll() is None:
                p.terminate()


# -- CLI: dry-run and verify -------------------------------------------------

def dry_run_text(prof: dict, topo: Topology) -> str:
    shapes = profile_shapes(prof)
    lines = [f"# profile {prof['name']}: queue={topo.queue} queue_pkts={topo.queue_pkts} "
             f"host_if={topo.host_if} ns={topo.ns} ns_if={topo.ns_if}",
             "# setup (once, before any qdisc):"]
    lines += [f"  {c}" for c in offload_commands(topo)]
    for i, (shape, cmds) in enumerate(zip(shapes, step_commands(shapes, topo))):
        rec = step_record(shape, topo)
        extra = ""
        if "queue_bytes" in rec:
            extra = f" queue_bytes={rec['queue_bytes']}"
        elif "codel_target_ms" in rec:
            extra = f" codel_target_ms={rec['codel_target_ms']:g}"
        lines.append(f"# step {i} at_s={prof['steps'][i]['at_s']:g}: rate_mbps={shape.rate_mbps} delay_ms={shape.delay_ms:g} "
                     f"loss_pct={shape.loss_pct:g}{extra}" + ("" if cmds else " (no change)"))
        lines += [f"  {c}" for c in cmds]
    lines.append("# expected `tc qdisc show dev %s` after setup: %s" % (
        topo.host_if, "; ".join(f"{k} {h} parent {p}" for k, h, p in expected_tree(shapes[0], topo))))
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Shaping command builder (dry-run) and tree verifier.")
    ap.add_argument("--profile", type=Path, required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="print the exact commands per step; runs nothing")
    g.add_argument("--verify", action="store_true",
                   help="Linux: build netns + tree for step 0, check `tc qdisc show` lists every level, tear down")
    ap.add_argument("--offloads", default=",".join(DEFAULT_OFFLOADS), help="ethtool -K features to turn off")
    ap.add_argument("--ns", default="moqc")
    ap.add_argument("--host-if", default="veth-moqh")
    ap.add_argument("--ns-if", default="veth-moqc")
    args = ap.parse_args()

    prof = load_profile(args.profile)
    offloads = tuple(f for f in args.offloads.split(",") if f)
    topo = profile_topology(prof, host_if=args.host_if, ns=args.ns, ns_if=args.ns_if, offloads=offloads)
    if args.dry_run:
        print(dry_run_text(prof, topo))
        return 0
    backend = NetnsBackend(ns=args.ns, host_if=args.host_if, ns_if=args.ns_if)
    shape = profile_shapes(prof)[0]
    try:
        backend.setup(topo)
        backend.apply(shape)  # verifies after the setup commands
        print(backend.show())
        print(json.dumps(backend.stats(), indent=2))
        print("offloads:", json.dumps(backend.offloads["host"]["features"]), json.dumps(backend.offloads["ns"]["features"]))
        print(f"kernel {os.uname().release}; {tc_version()}")
    finally:
        backend.teardown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
