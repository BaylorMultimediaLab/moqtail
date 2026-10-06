"""Unit tests for the apparatus (W2): the shaping command builders and
parsers in experiments/net.py and the runner's pure helpers in
experiments/run_experiment.py.

Run from the repository root:

    python3 -m unittest discover -s experiments/tests -t .

Stdlib only; no root, no tc, no process of the stack is started. Audit
findings covered: C5 (offloads off before any qdisc, byte-sized queue, tc
stats recorded, GSO evidence), M1 (in-place changes, no del/add after
setup), M2 (one topology for both queues, codel target >= 1.5 x MTU time),
M20 (relay flags pinned identically and checked against --help, aborted runs
marked invalid, identity), and the runner items of audit report 4
(readiness, cache-length guard, run ids, controller arm wiring).
"""

from __future__ import annotations

import argparse
import json
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))

import net  # noqa: E402
import run_experiment as rx  # noqa: E402
from net import Shape, Topology  # noqa: E402

PROFILES = HERE.parent / "profiles"

TC_S_SHOW = """\
qdisc netem 1: root refcnt 2 limit 10000 delay 20ms
 Sent 12345678 bytes 8532 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 3000b 2p requeues 0
qdisc htb 2: parent 1:1 r2q 10 default 0x10 direct_packets_stat 0 direct_qlen 1000
 Sent 12300000 bytes 8500 pkt (dropped 17, overlimits 4021 requeues 0)
 backlog 45000b 30p requeues 0
qdisc bfifo 20: parent 2:10 limit 150000b
 Sent 12300000 bytes 8500 pkt (dropped 17, overlimits 0 requeues 0)
 backlog 45000b 30p requeues 0
"""

TC_S_FQ_CODEL = """\
qdisc netem 1: root refcnt 2 limit 10000 delay 20ms
 Sent 9000000 bytes 6000 pkt (dropped 3, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc htb 2: parent 1:1 r2q 10 default 0x10 direct_packets_stat 0 direct_qlen 1000
 Sent 9000000 bytes 6000 pkt (dropped 3, overlimits 812 requeues 0)
 backlog 0b 0p requeues 0
qdisc fq_codel 20: parent 2:10 limit 10240p flows 1024 quantum 1514 target 12ms interval 100ms memory_limit 32Mb ecn drop_batch 64
 Sent 9000000 bytes 6000 pkt (dropped 3, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
  maxpacket 1514 drop_overlimit 0 new_flow_count 5 ecn_mark 12
  new_flows_len 0 old_flows_len 1
"""

ETHTOOL_K = """\
Features for veth-moqh:
rx-checksumming: on
tx-checksumming: on
	tx-checksum-ipv4: off [fixed]
scatter-gather: on
tcp-segmentation-offload: off
	tx-tcp-segmentation: off
generic-segmentation-offload: off
generic-receive-offload: off
large-receive-offload: off [fixed]
tx-udp-segmentation: off
rx-udp-gro-forwarding: off
"""


class Builders(unittest.TestCase):
    def test_rate_arg_is_decimal_kbit(self):
        self.assertEqual(net.rate_arg(1.5), "1500kbit")
        self.assertEqual(net.rate_arg(6), "6000kbit")
        self.assertEqual(net.rate_arg(0.8), "800kbit")

    def test_queue_bytes_is_pkts_times_mtu(self):
        self.assertEqual(net.queue_bytes(100), 150000)

    def test_codel_target_floor_and_mtu_time(self):
        # 6 Mbps: 2 ms per MTU x 1.5 = 3 ms -> floor 5 ms
        self.assertEqual(net.codel_target_ms(6), 5.0)
        # 1.5 Mbps: 8 ms per MTU x 1.5 = 12 ms
        self.assertAlmostEqual(net.codel_target_ms(1.5), 12.0)
        # 0.8 Mbps: 15 ms x 1.5 = 22.5 ms
        self.assertAlmostEqual(net.codel_target_ms(0.8), 22.5)

    def test_netem_opts_half_delay_loss_limit(self):
        topo = Topology()
        self.assertEqual(net.netem_opts(Shape(6, 40), topo), "delay 20ms limit 10000")
        self.assertEqual(net.netem_opts(Shape(6, 40, loss_pct=1), topo), "delay 20ms loss 1% limit 10000")
        self.assertEqual(net.netem_opts(Shape(6, 40, jitter_ms=4), topo), "delay 20ms 2ms limit 10000")

    def test_leaf_opts_per_queue(self):
        self.assertEqual(net.leaf_opts(Shape(6, 40), Topology(queue="tail-drop", queue_pkts=100)),
                         "bfifo limit 150000")
        self.assertEqual(net.leaf_opts(Shape(1.5, 40), Topology(queue="fq_codel")),
                         "fq_codel limit 10240 target 12ms interval 100ms ecn")
        self.assertEqual(net.leaf_opts(Shape(1.5, 40), Topology(queue="fq_codel", codel_ecn=False)),
                         "fq_codel limit 10240 target 12ms interval 100ms noecn")

    def test_setup_builds_three_levels_and_return_path(self):
        cmds = [c.argv for c in net.setup_commands(Shape(6, 40), Topology())]
        self.assertEqual(cmds, [
            "tc qdisc del dev veth-moqh root",
            "ip netns exec moqc tc qdisc del dev veth-moqc root",
            "tc qdisc add dev veth-moqh root handle 1: netem delay 20ms limit 10000",
            "tc qdisc add dev veth-moqh parent 1:1 handle 2: htb default 10",
            "tc class add dev veth-moqh parent 2: classid 2:10 htb rate 6000kbit ceil 6000kbit",
            "tc qdisc add dev veth-moqh parent 2:10 handle 20: bfifo limit 150000",
            "ip netns exec moqc tc qdisc add dev veth-moqc root handle 1: netem delay 20ms limit 10000",
        ])
        checks = [c.check for c in net.setup_commands(Shape(6, 40), Topology())]
        self.assertEqual(checks, [False, False, True, True, True, True, True])

    def test_setup_unlimited_is_netem_only(self):
        cmds = [c.argv for c in net.setup_commands(Shape(None, 40), Topology())]
        self.assertEqual(len(cmds), 4)
        self.assertNotIn("htb", " ".join(cmds))
        self.assertEqual(net.expected_tree(Shape(None, 40), Topology()), [("netem", "1:", "root")])

    def test_same_topology_for_both_queues(self):
        a = [c.argv for c in net.setup_commands(Shape(6, 40), Topology(queue="tail-drop"))]
        b = [c.argv for c in net.setup_commands(Shape(6, 40), Topology(queue="fq_codel"))]
        # M2: only the leaf line differs
        diff = [(x, y) for x, y in zip(a, b) if x != y]
        self.assertEqual(len(diff), 1)
        self.assertIn("bfifo", diff[0][0])
        self.assertIn("fq_codel", diff[0][1])
        self.assertEqual(len(a), len(b))

    def test_change_rate_only_touches_the_class(self):
        cmds = net.change_commands(Shape(6, 40), Shape(1.5, 40), Topology(queue="tail-drop"))
        self.assertEqual([c.argv for c in cmds],
                         ["tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit ceil 1500kbit"])

    def test_change_codel_updates_target_with_rate(self):
        cmds = [c.argv for c in net.change_commands(Shape(6, 40), Shape(1.5, 40), Topology(queue="fq_codel"))]
        self.assertEqual(cmds, [
            "tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit ceil 1500kbit",
            "tc qdisc change dev veth-moqh parent 2:10 handle 20: fq_codel limit 10240 target 12ms interval 100ms ecn",
        ])

    def test_change_delay_touches_both_netems(self):
        cmds = [c.argv for c in net.change_commands(Shape(6, 40), Shape(6, 80, loss_pct=0.5), Topology())]
        self.assertEqual(cmds, [
            "tc qdisc change dev veth-moqh root handle 1: netem delay 40ms loss 0.5% limit 10000",
            "ip netns exec moqc tc qdisc change dev veth-moqc root handle 1: netem delay 40ms loss 0.5% limit 10000",
        ])

    def test_no_change_no_commands(self):
        self.assertEqual(net.change_commands(Shape(6, 40), Shape(6, 40), Topology()), [])

    def test_never_del_or_add_after_setup(self):
        # M1: across every profile in the repo, steps after the first contain no del/add.
        for p in sorted(PROFILES.glob("*.json")):
            prof = net.load_profile(p)
            topo = net.profile_topology(prof)
            per_step = net.step_commands(net.profile_shapes(prof), topo)
            for cmds in per_step[1:]:
                for c in cmds:
                    self.assertNotRegex(c.argv, r"\b(del|add)\b", f"{p.name}: {c.argv}")
                    self.assertIn(" change ", c.argv)

    def test_mixing_unlimited_and_limited_refused(self):
        with self.assertRaises(ValueError):
            net.change_commands(Shape(None, 40), Shape(6, 40), Topology())

    def test_offload_commands_one_per_feature_per_end(self):
        topo = Topology()
        cmds = net.offload_commands(topo)
        k_cmds = [c for c in cmds if " -K " in c.argv]
        self.assertEqual(len(k_cmds), 2 * len(net.DEFAULT_OFFLOADS))
        self.assertTrue(all(not c.check for c in k_cmds))  # unsupported names tolerated
        self.assertEqual(sum(" -k " in c.argv for c in cmds), 2)
        self.assertEqual(k_cmds[0].argv, "ethtool -K veth-moqh gso off")
        self.assertEqual(k_cmds[5].argv, "ip netns exec moqc ethtool -K veth-moqc gso off")

    def test_offloads_precede_qdiscs_in_dry_run(self):
        prof = net.load_profile(PROFILES / "step_down_up.json")
        text = net.dry_run_text(prof, net.profile_topology(prof))
        self.assertLess(text.index("ethtool -K"), text.index("tc qdisc add"))


class Parsers(unittest.TestCase):
    def test_parse_qdisc_show_stats(self):
        q = net.parse_qdisc_show(TC_S_SHOW)
        self.assertEqual([(x["kind"], x["handle"], x["parent"]) for x in q],
                         [("netem", "1:", "root"), ("htb", "2:", "1:1"), ("bfifo", "20:", "2:10")])
        leaf = q[2]
        self.assertEqual(leaf["sent_bytes"], 12300000)
        self.assertEqual(leaf["sent_pkts"], 8500)
        self.assertEqual(leaf["dropped"], 17)
        self.assertEqual(leaf["backlog_bytes"], 45000)
        self.assertEqual(leaf["backlog_pkts"], 30)
        self.assertEqual(leaf["options"], "limit 150000b")

    def test_leaf_stats_picks_leaf(self):
        st = net.leaf_stats(TC_S_SHOW, Shape(6, 40), Topology())
        self.assertEqual(st["leaf"]["handle"], "20:")
        self.assertEqual(st["leaf"]["kind"], "bfifo")
        self.assertEqual(len(st["tree"]), 3)
        self.assertIn("Sent 12300000 bytes", st["raw"])
        # bytes/packets is not a GSO detector (packets count segments), so it is not reported
        self.assertNotIn("mean_pkt_bytes", st["leaf"])
        # 45000 B over 30 skbs = 1500 B per skb: no evidence either way from a bfifo
        self.assertEqual(st["leaf"]["backlog_bytes_per_skb"], 1500)
        self.assertIsNone(st["leaf"]["gso_at_qdisc"])

    def test_leaf_stats_unshaped_is_the_netem(self):
        st = net.leaf_stats(TC_S_SHOW, Shape(None, 40), Topology())
        self.assertEqual(st["leaf"]["kind"], "netem")

    def test_backlog_with_size_suffix(self):
        # tc's sprint_size prints "3Kb"/"1Mb" when within a few bytes of a multiple of 1024
        text = ("qdisc bfifo 20: parent 2:10 limit 150000b\n"
                " Sent 1 bytes 1 pkt (dropped 0, overlimits 0 requeues 0)\n"
                " backlog 3Kb 2p requeues 0\n"
                "qdisc netem 1: root refcnt 2 limit 10000 delay 20ms\n"
                " Sent 1 bytes 1 pkt (dropped 0, overlimits 0 requeues 0)\n"
                " rate 0bit 0pps backlog 1Mb 40p requeues 0\n")
        q = net.parse_qdisc_show(text)
        self.assertEqual((q[0]["backlog_bytes"], q[0]["backlog_pkts"]), (3072, 2))
        self.assertEqual((q[1]["backlog_bytes"], q[1]["backlog_pkts"]), (1048576, 40))

    def test_fq_codel_xstats_and_gso_evidence(self):
        q = net.parse_qdisc_show(TC_S_FQ_CODEL)
        leaf = next(x for x in q if x["handle"] == "20:")
        self.assertEqual((leaf["sent_bytes"], leaf["sent_pkts"], leaf["dropped"]), (9000000, 6000, 3))
        self.assertEqual((leaf["backlog_bytes"], leaf["backlog_pkts"]), (0, 0))
        self.assertEqual(leaf["maxpacket"], 1514)
        self.assertEqual(leaf["ecn_mark"], 12)
        self.assertEqual(leaf["drop_overlimit"], 0)
        self.assertEqual(leaf["new_flow_count"], 5)
        st = net.leaf_stats(TC_S_FQ_CODEL, Shape(1.5, 40), Topology(queue="fq_codel"))
        self.assertIs(st["leaf"]["gso_at_qdisc"], False)  # largest skb ever seen = one wire packet
        batched = TC_S_FQ_CODEL.replace("maxpacket 1514", "maxpacket 24228")
        st = net.leaf_stats(batched, Shape(1.5, 40), Topology(queue="fq_codel"))
        self.assertIs(st["leaf"]["gso_at_qdisc"], True)
        self.assertEqual(st["leaf"]["max_skb_bytes"], 24228)

    def test_gso_evidence_from_bfifo_backlog(self):
        # 3 skbs holding 60 KB: GSO batches reached the queue
        self.assertIs(net.gso_evidence({"backlog_bytes": 60000, "backlog_pkts": 3})["gso_at_qdisc"], True)
        self.assertIsNone(net.gso_evidence({"backlog_bytes": 0, "backlog_pkts": 0})["gso_at_qdisc"])
        # fq_codel that has seen no traffic proves nothing
        self.assertIsNone(net.gso_evidence({"maxpacket": 0, "sent_pkts": 0})["gso_at_qdisc"])

    def test_verify_tree_ok(self):
        self.assertEqual(net.verify_tree(TC_S_SHOW, Shape(6, 40), Topology(queue="tail-drop")), [])

    def test_verify_tree_detects_missing_and_wrong_leaf(self):
        errs = net.verify_tree(TC_S_SHOW, Shape(6, 40), Topology(queue="fq_codel"))
        self.assertTrue(any("expected fq_codel" in e for e in errs))
        two_levels = "\n".join(TC_S_SHOW.splitlines()[:6])
        errs = net.verify_tree(two_levels, Shape(6, 40), Topology())
        self.assertTrue(any("missing qdisc bfifo" in e for e in errs))
        # the old (pre-rebuild) tree, HTB root with a netem leaf, must fail
        old = ("qdisc htb 1: root refcnt 2 r2q 10 default 0x10\n"
               "qdisc netem 10: parent 1:10 limit 100 delay 20ms\n")
        self.assertTrue(net.verify_tree(old, Shape(6, 40), Topology()))
        self.assertTrue(net.verify_tree("", Shape(6, 40), Topology()))

    def test_parse_ethtool_k_and_summary(self):
        parsed = net.parse_ethtool_k(ETHTOOL_K)
        self.assertEqual(parsed["generic-segmentation-offload"], {"on": False, "fixed": False})
        self.assertEqual(parsed["large-receive-offload"], {"on": False, "fixed": True})
        s = net.offload_summary(net.DEFAULT_OFFLOADS, ETHTOOL_K)
        self.assertTrue(s["all_off"])
        self.assertEqual(s["features"]["gso"], "off")
        on = ETHTOOL_K.replace("tx-udp-segmentation: off", "tx-udp-segmentation: on")
        self.assertFalse(net.offload_summary(net.DEFAULT_OFFLOADS, on)["all_off"])
        absent = ETHTOOL_K.replace("rx-udp-gro-forwarding: off\n", "")
        s = net.offload_summary(net.DEFAULT_OFFLOADS, absent)
        self.assertEqual(s["features"]["rx-udp-gro-forwarding"], "absent")
        self.assertTrue(s["all_off"])


class Profiles(unittest.TestCase):
    def test_repo_profiles_load_and_record(self):
        for p in sorted(PROFILES.glob("*.json")):
            prof = net.load_profile(p)
            topo = net.profile_topology(prof)
            for s in net.profile_shapes(prof):
                rec = net.step_record(s, topo)
                self.assertEqual(rec["queue"], prof["queue"])
                if s.rate_mbps is not None and topo.queue == "fq_codel":
                    self.assertGreaterEqual(rec["codel_target_ms"], 5.0)
                    self.assertGreaterEqual(rec["codel_target_ms"], 1.5 * 1500 * 8 / (s.rate_mbps * 1000) - 1e-9)

    def test_fqcodel_profile_differs_from_tail_drop_only_in_leaf(self):
        a = net.load_profile(PROFILES / "step_down_up.json")
        b = net.load_profile(PROFILES / "step_down_up_fqcodel.json")
        self.assertEqual(a["steps"], b["steps"])
        ta, tb = net.profile_topology(a), net.profile_topology(b)
        self.assertEqual(net.netem_opts(Shape(6, 40), ta), net.netem_opts(Shape(6, 40), tb))

    def test_profile_rejects_mixed_rate_steps(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "bad.json"
            p.write_text(json.dumps({"name": "bad", "steps": [
                {"at_s": 0, "delay_ms": 40}, {"at_s": 10, "rate_mbps": 3, "delay_ms": 40}]}))
            with self.assertRaises(SystemExit):
                net.load_profile(p)

    def test_dry_run_step_down_up(self):
        prof = net.load_profile(PROFILES / "step_down_up.json")
        text = net.dry_run_text(prof, net.profile_topology(prof))
        self.assertIn("tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit ceil 1500kbit", text)
        self.assertEqual(text.count("tc qdisc add"), 4)
        self.assertEqual(text.count("tc qdisc del"), 2)


class ContractTopology(unittest.TestCase):
    """The resolved commands of every repo profile against the contract
    (docs/rebuild-2026-10-04.md, "Shaping (W2)")."""

    def test_every_profile_step_by_step(self):
        for p in sorted(PROFILES.glob("*.json")):
            with self.subTest(profile=p.name):
                prof = net.load_profile(p)
                topo = net.profile_topology(prof)
                shapes = net.profile_shapes(prof)
                per_step = net.step_commands(shapes, topo)
                setup = [c.argv for c in per_step[0]]
                half = net.fmt_num(shapes[0].delay_ms / 2)
                # root netem on both sides: delay only, limit 10000, never a rate
                self.assertIn(f"tc qdisc add dev veth-moqh root handle 1: netem delay {half}ms limit 10000", setup)
                self.assertIn(f"ip netns exec moqc tc qdisc add dev veth-moqc root handle 1: netem delay {half}ms "
                              "limit 10000", setup)
                self.assertFalse(any(" rate " in c for c in setup if "netem" in c))
                adds = [c for c in setup if " add " in c]
                if shapes[0].rate_mbps is None:
                    self.assertEqual(len(adds), 2)
                    continue
                r = net.rate_arg(shapes[0].rate_mbps)
                self.assertEqual(adds, [
                    f"tc qdisc add dev veth-moqh root handle 1: netem delay {half}ms limit 10000",
                    "tc qdisc add dev veth-moqh parent 1:1 handle 2: htb default 10",
                    f"tc class add dev veth-moqh parent 2: classid 2:10 htb rate {r} ceil {r}",
                    f"tc qdisc add dev veth-moqh parent 2:10 handle 20: {net.leaf_opts(shapes[0], topo)}",
                    f"ip netns exec moqc tc qdisc add dev veth-moqc root handle 1: netem delay {half}ms limit 10000",
                ])
                # every later step: rate changed in place on the class (and the codel target on the leaf)
                for prev, cur, cmds in zip(shapes, shapes[1:], per_step[1:]):
                    argv = [c.argv for c in cmds]
                    if cur.rate_mbps != prev.rate_mbps:
                        rr = net.rate_arg(cur.rate_mbps)
                        self.assertIn(f"tc class change dev veth-moqh parent 2: classid 2:10 htb rate {rr} ceil {rr}",
                                      argv)
                    for c in argv:
                        self.assertNotRegex(c, r"\b(del|add|replace)\b")
                    if topo.queue == "tail-drop":
                        self.assertFalse(any("bfifo" in c for c in argv))  # the byte limit never changes
                    elif cur.rate_mbps != prev.rate_mbps and \
                            net.codel_target_ms(cur.rate_mbps) != net.codel_target_ms(prev.rate_mbps):
                        t = net.fmt_num(net.codel_target_ms(cur.rate_mbps))
                        self.assertIn(f"tc qdisc change dev veth-moqh parent 2:10 handle 20: fq_codel limit 10240 "
                                      f"target {t}ms interval 100ms ecn", argv)

    def test_codel_target_formula_over_a_range(self):
        for r in (0.3, 0.5, 0.8, 1.0, 1.2, 1.5, 2.4, 3, 3.6, 6, 10, 100):
            with self.subTest(rate=r):
                self.assertAlmostEqual(net.codel_target_ms(r), max(5.0, 1.5 * 1500 * 8 / (r * 1e6) * 1e3))
        # the crossover: 1.5 x MTU time = 5 ms at 3.6 Mbps
        self.assertAlmostEqual(net.codel_target_ms(3.6), 5.0)
        self.assertGreater(net.codel_target_ms(3.5), 5.0)

    def test_bfifo_limit_bytes_for_other_queue_sizes(self):
        for pkts in (1, 10, 64, 100, 250):
            leaf = net.leaf_opts(Shape(6, 40), Topology(queue_pkts=pkts))
            self.assertEqual(leaf, f"bfifo limit {pkts * 1500}")
            self.assertEqual(net.step_record(Shape(6, 40), Topology(queue_pkts=pkts))["queue_bytes"], pkts * 1500)

    def test_fq_codel_setup_exact(self):
        cmds = [c.argv for c in net.setup_commands(Shape(1.5, 40), Topology(queue="fq_codel"))]
        self.assertIn("tc qdisc add dev veth-moqh parent 2:10 handle 20: fq_codel limit 10240 target 12ms "
                      "interval 100ms ecn", cmds)
        # queue_pkts does not leak into fq_codel (its limit is the contract's 10240)
        cmds2 = [c.argv for c in net.setup_commands(Shape(1.5, 40), Topology(queue="fq_codel", queue_pkts=7))]
        self.assertEqual(cmds, cmds2)

    def test_step_record_codel(self):
        rec = net.step_record(Shape(0.8, 40), Topology(queue="fq_codel"))
        self.assertEqual((rec["codel_target_ms"], rec["codel_interval_ms"], rec["codel_limit_pkts"], rec["codel_ecn"]),
                         (22.5, 100, 10240, True))
        self.assertNotIn("queue_bytes", rec)
        self.assertNotIn("codel_target_ms", net.step_record(Shape(None, 40), Topology(queue="fq_codel")))

    def test_unknown_queue_refused(self):
        with self.assertRaises(ValueError):
            Topology(queue="pfifo")
        with self.assertRaises(ValueError):
            Topology(queue_pkts=0)


class DryRun(unittest.TestCase):
    def test_fqcodel_all_steps(self):
        prof = net.load_profile(PROFILES / "step_down_up_fqcodel.json")
        text = net.dry_run_text(prof, net.profile_topology(prof))
        self.assertIn("# step 0 at_s=0: rate_mbps=6 delay_ms=40 loss_pct=0 codel_target_ms=5", text)
        self.assertIn("# step 1 at_s=60: rate_mbps=1.5 delay_ms=40 loss_pct=0 codel_target_ms=12", text)
        self.assertIn("# step 2 at_s=120: rate_mbps=6 delay_ms=40 loss_pct=0 codel_target_ms=5", text)
        self.assertEqual(text.count("fq_codel limit 10240 target 12ms interval 100ms ecn"), 1)
        self.assertEqual(text.count("tc qdisc change dev veth-moqh parent 2:10 handle 20: fq_codel"), 2)
        self.assertEqual(text.count("tc class change"), 2)
        self.assertNotIn("bfifo", text)
        self.assertTrue(text.rstrip().endswith("fq_codel 20: parent 2:10"))

    def test_unchanged_step_says_so(self):
        prof = {"name": "flat", "steps": [{"at_s": 0, "rate_mbps": 3, "delay_ms": 40},
                                          {"at_s": 10, "rate_mbps": 3, "delay_ms": 40}],
                "queue": "tail-drop", "queue_pkts": 100}
        self.assertIn("(no change)", net.dry_run_text(prof, net.profile_topology(prof)))

    def test_cli_dry_run_runs_nothing(self):
        out = subprocess.run([sys.executable, str(HERE.parent / "net.py"), "--dry-run", "--profile",
                              str(PROFILES / "step_down_up.json")], capture_output=True, text=True, check=True).stdout
        self.assertIn("tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit ceil 1500kbit", out)
        self.assertNotIn("[net] $", out)  # nothing executed


class NetnsOrdering(unittest.TestCase):
    """NetnsBackend with every command intercepted: offloads go off on both
    ends before the first qdisc, steps after the first only `change`, and the
    first apply verifies the three-level tree."""

    def _fake_run(self, log):
        def run(cmd, check=True, quiet=False):
            log.append(cmd)
            out = ""
            if cmd.startswith("ethtool -k") or "ethtool -k" in cmd:
                out = ETHTOOL_K
            elif cmd.startswith("tc ") and "qdisc show dev veth-moqh" in cmd:
                out = TC_S_SHOW
            elif "tc qdisc show dev veth-moqc" in cmd:
                out = "qdisc netem 1: root refcnt 2 limit 10000 delay 20ms\n"
            return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")
        return run

    def test_order_and_in_place_steps(self):
        log: list[str] = []
        be = net.NetnsBackend()
        with mock.patch.object(net, "_run", self._fake_run(log)), mock.patch.object(net.os, "geteuid", return_value=0), \
                mock.patch.object(net.shutil, "which", return_value="/usr/sbin/x"):
            be.setup(Topology())
            be.apply(Shape(6, 40))
            n_after_setup = len(log)
            res = be.apply(Shape(1.5, 40))
            be.apply(Shape(6, 40))
            stats = be.stats()
        first_qdisc = next(i for i, c in enumerate(log) if c.startswith("tc qdisc add") or "tc qdisc add" in c)
        k_idx = [i for i, c in enumerate(log) if "ethtool -K" in c]
        self.assertEqual(len(k_idx), 2 * len(net.DEFAULT_OFFLOADS))
        self.assertLess(max(k_idx), first_qdisc)
        self.assertTrue(any(c.startswith("ethtool -K veth-moqh") for c in log))
        self.assertTrue(any(c.startswith("ip netns exec moqc ethtool -K veth-moqc") for c in log))
        # the offload read-back is not run twice
        self.assertEqual(sum(c == "ethtool -k veth-moqh" for c in log), 1)
        self.assertTrue(be.offloads["all_off"])
        self.assertEqual(be.offloads["host"]["features"]["gso"], "off")
        later = [c for c in log[n_after_setup:] if c.startswith("tc ") or " tc " in c]
        self.assertTrue(all((" change " in c) or (" show " in c) for c in later), later)
        self.assertEqual(res["tc"], ["tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit "
                                     "ceil 1500kbit"])
        self.assertEqual(stats["leaf"]["handle"], "20:")

    def test_failed_verification_aborts(self):
        log: list[str] = []
        base = self._fake_run(log)

        def run(cmd, check=True, quiet=False):
            r = base(cmd, check, quiet)
            if "qdisc show dev veth-moqh" in cmd:  # netem refused the child: only the root is listed
                r = subprocess.CompletedProcess(cmd, 0, stdout=TC_S_SHOW.splitlines()[0] + "\n", stderr="")
            return r
        be = net.NetnsBackend()
        with mock.patch.object(net, "_run", run), mock.patch.object(net.os, "geteuid", return_value=0), \
                mock.patch.object(net.shutil, "which", return_value="/usr/sbin/x"):
            be.setup(Topology())
            with self.assertRaises(SystemExit) as cm:
                be.apply(Shape(6, 40))
        self.assertIn("missing qdisc htb", str(cm.exception))

    def test_unsupported_offload_name_tolerated(self):
        log: list[str] = []
        base = self._fake_run(log)

        def run(cmd, check=True, quiet=False):
            r = base(cmd, check, quiet)
            if "rx-udp-gro-forwarding" in cmd:
                r = subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Cannot change rx-udp-gro-forwarding")
            return r
        be = net.NetnsBackend()
        with mock.patch.object(net, "_run", run), mock.patch.object(net.os, "geteuid", return_value=0), \
                mock.patch.object(net.shutil, "which", return_value="/usr/sbin/x"):
            be.setup(Topology())
        failed = [r for r in be.offloads["ethtool_K"] if r["rc"] != 0]
        self.assertEqual(len(failed), 2)  # one per end, recorded, not fatal
        self.assertTrue(all("rx-udp-gro-forwarding" in r["cmd"] for r in failed))


# -- runner (experiments/run_experiment.py) ------------------------------------

def rust_long_flags(path: Path) -> set[str]:
    """`--kebab-name` for every `#[arg(long ...)] pub snake_name:` in a clap struct."""
    text = path.read_text()
    return {"--" + m.group(1).replace("_", "-")
            for m in re.finditer(r"#\[arg\(\s*long[^\]]*\]\s*(?:///[^\n]*\n\s*)*pub (\w+):", text)}


CLAP_HELP = """\
Usage: relay [OPTIONS]

Options:
      --port <PORT>
          Port to bind

          [default: 4433]
      --host <HOST>
          Host to bind
      --cache-size <CACHE_SIZE>
          [default: 1000]
      --max-idle-timeout <MAX_IDLE_TIMEOUT>
      --keep-alive-interval <KEEP_ALIVE_INTERVAL>
      --track-alias-resolution-timeout-ms <TRACK_ALIAS_RESOLUTION_TIMEOUT_MS>
      --downstream-alias-timeout-ms <DOWNSTREAM_ALIAS_TIMEOUT_MS>
      --publish-done-stream-timeout-ms <PUBLISH_DONE_STREAM_TIMEOUT_MS>
      --congestion-controller <CONGESTION_CONTROLLER>
          [default: cubic] [possible values: cubic, bbr]
  -h, --help
          Print help
"""


def fake_binary(dir_: Path, help_text: str) -> Path:
    p = dir_ / "relay"
    p.write_text("#!/bin/sh\ncat <<'EOF'\n" + help_text + "EOF\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return p


class RelayFlags(unittest.TestCase):
    def test_binary_flags_parses_clap_help(self):
        with tempfile.TemporaryDirectory() as d:
            flags = rx.binary_flags(fake_binary(Path(d), CLAP_HELP))
        self.assertIn("--congestion-controller", flags)
        self.assertIn("--track-alias-resolution-timeout-ms", flags)
        self.assertIn("--help", flags)
        self.assertNotIn("--t-switch-ms", flags)

    def test_pinned_args_identical_values_and_t_switch_only_where_accepted(self):
        flags = set(rx.RELAY_PINNED) | {"--cache-size", "--congestion-controller", "--udp-gso"}
        argv, rec = rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        self.assertEqual(argv[argv.index("--cache-size") + 1], "1000")
        for flag, value in rx.RELAY_PINNED.items():
            self.assertIn(flag, argv)
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertEqual(argv[argv.index("--congestion-controller") + 1], "cubic")
        self.assertEqual(argv[argv.index("--udp-gso") + 1], "off")
        self.assertEqual(rec["pinned"]["--udp-gso"], "off")
        self.assertEqual(rec["skipped"], ["--t-switch-ms"])
        self.assertEqual(rec["missing"], [])
        argv2, rec2 = rx.pinned_relay_args(flags | {"--t-switch-ms"}, "bbr", 1000, allow_missing=False)
        self.assertEqual(argv2[argv2.index("--t-switch-ms") + 1], "3000")
        self.assertEqual(argv2[argv2.index("--congestion-controller") + 1], "bbr")
        self.assertEqual(rec2["skipped"], [])
        # the branch-specific default (pr1674: 2000) and harness default (500) are both overridden
        self.assertEqual(rx.RELAY_PINNED["--track-alias-resolution-timeout-ms"], "2000")

    def test_missing_contract_flag_is_a_clear_error(self):
        flags = set(rx.RELAY_PINNED) | {"--cache-size", "--udp-gso"}  # no --congestion-controller
        with self.assertRaises(SystemExit) as cm:
            rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        self.assertIn("--congestion-controller", str(cm.exception))
        self.assertIn("relay --help", str(cm.exception))
        argv, rec = rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=True)
        self.assertEqual(rec["missing"], ["--congestion-controller"])
        self.assertNotIn("--congestion-controller", argv)

    def test_missing_udp_gso_is_a_clear_error(self):
        # C5: without --udp-gso the relay's own default would decide the queue model silently.
        flags = set(rx.RELAY_PINNED) | {"--cache-size", "--congestion-controller"}
        with self.assertRaises(SystemExit) as cm:
            rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        self.assertIn("--udp-gso", str(cm.exception))

    def test_publisher_variant_priority(self):
        argv, rec = rx.pinned_publisher_args({"--variant-priority"}, allow_missing=False)
        self.assertEqual(argv, ["--variant-priority", "128"])
        old_publisher = {"--event-log", "--encoded-dir"}  # lists options, but not W4's
        with self.assertRaises(SystemExit):
            rx.pinned_publisher_args(old_publisher, allow_missing=False)
        argv, rec = rx.pinned_publisher_args(old_publisher, allow_missing=True)
        self.assertEqual((argv, rec["missing"]), ([], ["--variant-priority"]))


class Safety(unittest.TestCase):
    def test_cache_length_guard(self):
        # 200 s run + 15 s warm-up + 30 s margin = 245 > 240 groups: refused
        self.assertIsNone(rx.check_cache_length(200, 15, 240))
        self.assertIn("260", rx.check_cache_length(230, 15, 240))
        self.assertIsNotNone(rx.check_cache_length(60, 15, None))

    def test_warmup_gate_anchored_to_the_record(self):
        # the record says the first group left at t=1000 s; the runner saw it 20 s later (slow vite):
        # the browser still starts at 1000 + 15, not 20 s late
        self.assertEqual(rx.warmup_gate(1_000_000.0, 15.0, 1020.0), 1015.0)
        # no ts, or a ts that is not on our clock: from when it was seen
        self.assertEqual(rx.warmup_gate(None, 15.0, 1020.0), 1035.0)
        self.assertEqual(rx.warmup_gate("x", 15.0, 1020.0), 1035.0)
        self.assertEqual(rx.warmup_gate(9_000_000.0, 15.0, 1020.0), 1035.0)
        self.assertEqual(rx.measured_warmup(1_000_000.0, 1015.25), 15.25)
        self.assertIsNone(rx.measured_warmup(None, 1015.0))

    def test_aborted_validation_shape(self):
        v = rx.aborted_validation(final=True)
        self.assertEqual(v, {"passed": False, "final": True, "failed": ["aborted"], "checks": []})
        self.assertFalse(rx.aborted_validation(final=False)["final"])

    def test_readiness_constants(self):
        self.assertEqual(rx.WARMUP_S, 15.0)
        self.assertEqual(rx.RELAY_READY_TIMEOUT_S, 15.0)
        self.assertEqual(rx.CLIENT_STARTUP_TIMEOUT_S, 30.0)
        # the needle must match the relay's start() log line in apps/relay/src/server.rs
        server_rs = HERE.parent.parent / "apps/relay/src/server.rs"
        if server_rs.exists():
            self.assertIn(rx.RELAY_LISTENING_NEEDLE, server_rs.read_text())

    def test_wait_record_times_out_and_detects_exit(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "events.jsonl"
            self.assertIsNone(rx.wait_record(p, "GROUP_EMIT", timeout=0.3))
            import subprocess
            dead = subprocess.Popen(["true"])
            dead.wait()
            with self.assertRaises(SystemExit):
                rx.wait_record(p, "GROUP_EMIT", timeout=2.0, proc=dead, what="publisher")
            p.write_text('{"event":"GROUP_EMIT","ts":5}\n')
            self.assertEqual(rx.wait_record(p, "GROUP_EMIT", timeout=0.3)["ts"], 5)
            log = Path(d) / "relay.log"
            log.write_text("2026-10-04 INFO moqtail-relay 0.1 is running on 1 UDP socket(s) -- ...\n")
            self.assertTrue(rx.wait_log_line(log, rx.RELAY_LISTENING_NEEDLE, 0.3))
            self.assertFalse(rx.wait_log_line(log, "no such line", 0.3))


class Controller(unittest.TestCase):
    def _args(self, controller="min", overrides=None):
        import argparse
        return argparse.Namespace(controller=controller, controller_param=overrides)

    def test_min_is_default_and_one_url_param(self):
        self.assertEqual(rx.DEFAULT_CONTROLLER, "min")
        self.assertEqual(rx.CONTROLLER_ARM_PARAM, "controllerArm")  # the name the player reads
        self.assertEqual(rx.controller_params(self._args("min")), {"controllerArm": "min"})
        self.assertEqual(rx.controller_params(self._args("baseline")), {"controllerArm": "baseline"})
        grid = rx.controller_params(self._args("grid"))
        self.assertEqual(grid["controllerArm"], "grid")
        self.assertEqual(grid["probeMaxBytes"], 65536)

    def test_every_arm_names_its_family(self):
        for arm, params in rx.CONTROLLER_PARAMS.items():
            with self.subTest(arm=arm):
                self.assertIn(params["controllerArm"], ("min", "grid", "baseline"))
        self.assertEqual(rx.CONTROLLER_PARAMS["grid-noprobe"]["controllerArm"], "grid")
        self.assertEqual(rx.CONTROLLER_PARAMS["guard-lat-env-veto60"]["controllerArm"], "baseline")
        self.assertEqual(rx.controller_family("lat-env"), "baseline")

    def test_url_carries_controller_arm(self):
        # the exact query fragment the runner appends (run_once builds it the same way)
        frag = "".join(f"&{k}={v}" for k, v in rx.controller_params(self._args("min")).items())
        self.assertEqual(frag, "&controllerArm=min")

    def test_bad_arm_value_refused(self):
        with self.assertRaises(SystemExit):
            rx.controller_params(self._args("min", ["controllerArm=dash"]))

    def test_override_typing(self):
        p = rx.controller_params(self._args("min", ["upDwellGroups=4", "bufferSignal=envelope", "safety=0.9"]))
        self.assertEqual(p, {rx.CONTROLLER_ARM_PARAM: "min", "upDwellGroups": 4, "bufferSignal": "envelope",
                             "safety": 0.9})
        with self.assertRaises(SystemExit):
            rx.controller_params(self._args("min", ["novalue"]))
        # non-finite numbers pass through as written instead of crashing int()
        self.assertEqual(rx.controller_params(self._args("min", ["x=inf"]))["x"], "inf")


class RunIds(unittest.TestCase):
    def _args(self, **kw):
        import argparse
        base = dict(mechanism="pr1378", mechanism_mode="next-group", client_mode="time-shifted", time_shift=10.0,
                    bg_flows=0, controller="min", label="")
        base.update(kw)
        return argparse.Namespace(**base)

    def test_stable_id_without_stamp(self):
        rid = rx.run_id_for(self._args(), "step_down_up", 3, None)
        self.assertEqual(rid, "pr1378-next-group_shift10s_step_down_up_bg0_r3_ctl-min")
        # same inputs -> same id, so an external loop can resume by (condition, rep)
        self.assertEqual(rid, rx.run_id_for(self._args(), "step_down_up", 3, None))

    def test_stamped_id_and_baseline_suffix(self):
        rid = rx.run_id_for(self._args(mechanism="native", mechanism_mode=None, client_mode="live-edge",
                                       controller="baseline", label="x"), "stable_3mbps", 0, "20261004T120000Z")
        self.assertEqual(rid, "20261004T120000Z_native_live-edge_stable_3mbps_bg0_r0_x")


class Records(unittest.TestCase):
    def test_find_record_and_cache_meta(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "relay-events.jsonl"
            p.write_text('{"ts":1,"src":"relay","event":"CACHE_STATS"}\nnot json\n'
                         '{"ts":2,"src":"relay","event":"RELAY_CONFIG","congestion_controller":"cubic"}\n')
            self.assertEqual(rx.find_record(p, "RELAY_CONFIG")["congestion_controller"], "cubic")
            self.assertIsNone(rx.find_record(p, "PUBLISHER_CONFIG"))
            self.assertIsNone(rx.find_record(Path(d) / "missing.jsonl", "X"))
            enc = Path(d)
            (enc / "meta.json").write_text(json.dumps({"gops_per_variant": 240, "variants": ["a", "b"]}))
            self.assertEqual(rx.cache_gops(enc), 240)
            self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", rx.cache_meta_hash(enc)))
            self.assertIsNone(rx.cache_meta_hash(enc / "nope"))

    def test_find_record_since_skips_an_earlier_session(self):
        """Review 2026-10-05: a rerun under the same run id (--repeat-index) found the
        previous session's CONNECT_START first and anchored the clock on it."""
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "client-events.jsonl"
            p.write_text('{"ts":1000,"event":"CONNECT_START"}\n{"ts":9000,"event":"CONNECT_START"}\n'
                         '{"event":"CONNECT_START"}\n')
            self.assertEqual(rx.find_record(p, "CONNECT_START")["ts"], 1000)
            self.assertEqual(rx.find_record(p, "CONNECT_START", since_ms=5000)["ts"], 9000)
            self.assertIsNone(rx.find_record(p, "CONNECT_START", since_ms=10_000))



class RelayFlagsAgainstSource(unittest.TestCase):
    """Every flag the runner passes exists in the clap structs of this checkout
    (the relay/publisher W4 adds come in through --help at run time)."""

    RELAY_RS = REPO / "apps/relay/src/server/config.rs"
    PUBLISHER_RS = REPO / "apps/publisher/src/cli.rs"

    def test_rust_flag_scan(self):
        if not self.RELAY_RS.exists():
            self.skipTest("relay source not in this checkout")
        flags = rust_long_flags(self.RELAY_RS)
        self.assertIn("--track-alias-resolution-timeout-ms", flags)
        self.assertIn("--cache-size", flags)

    def test_relay_base_and_pinned_flags_exist(self):
        if not self.RELAY_RS.exists():
            self.skipTest("relay source not in this checkout")
        flags = rust_long_flags(self.RELAY_RS)
        for f in (*rx.RELAY_BASE_FLAGS, *rx.RELAY_PINNED, "--cache-size", "--enable-object-logging"):
            self.assertIn(f, flags, f"runner passes {f}, relay config.rs has no such flag")

    def test_publisher_base_flags_exist(self):
        if not self.PUBLISHER_RS.exists():
            self.skipTest("publisher source not in this checkout")
        flags = rust_long_flags(self.PUBLISHER_RS)
        for f in rx.PUBLISHER_BASE_FLAGS:
            self.assertIn(f, flags)

    def test_pr1378_requires_t_switch(self):
        flags = set(rx.RELAY_PINNED) | {"--cache-size", "--congestion-controller", "--udp-gso"}
        with self.assertRaises(SystemExit) as cm:
            rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False, mechanism="pr1378")
        self.assertIn("--t-switch-ms", str(cm.exception))
        argv, rec = rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False, mechanism="native")
        self.assertEqual(rec["skipped"], ["--t-switch-ms"])
        self.assertEqual(argv[:2], ["--cache-size", "1000"])

    def test_cache_size_is_checked_too(self):
        flags = set(rx.RELAY_PINNED) | {"--congestion-controller", "--udp-gso"}
        with self.assertRaises(SystemExit) as cm:
            rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        self.assertIn("--cache-size", str(cm.exception))

    def test_unreadable_help_is_its_own_error(self):
        for fn in (lambda: rx.pinned_relay_args(set(), "cubic", 1000, allow_missing=True),
                   lambda: rx.pinned_publisher_args(set(), allow_missing=True)):
            with self.assertRaises(SystemExit) as cm:
                fn()
            self.assertIn("could not read any option", str(cm.exception))
        self.assertEqual(rx.binary_flags(Path("/nonexistent/relay")), set())

    def test_base_flags_check(self):
        rx.check_base_flags("relay", set(rx.RELAY_BASE_FLAGS), rx.RELAY_BASE_FLAGS)
        with self.assertRaises(SystemExit) as cm:
            rx.check_base_flags("relay", set(rx.RELAY_BASE_FLAGS) - {"--event-log"}, rx.RELAY_BASE_FLAGS)
        self.assertIn("--event-log", str(cm.exception))


# A RELAY_CONFIG record that satisfies every check for a run that is not the fixed
# native arm (cubic, GSO off, both native-fix fields false).
OK_CONFIG = {"congestion_controller": "cubic", "udp_gso": "off", "forward_promotion_trigger": False,
             "native_status_before_subscribe": False}


class NativeFixedArm(unittest.TestCase):
    """R3-D7: `--mechanism native --mechanism-mode forward-trigger` is the corrected
    native arm: the relay runs with --forward-promotion-trigger AND
    --native-status-before-subscribe, and its RELAY_CONFIG must say both are on;
    every other run must report both off (as-shipped native, and the arms whose
    relays never promote natively)."""

    FLAGS = set(rx.RELAY_PINNED) | {"--cache-size", "--congestion-controller", "--udp-gso",
                                    "--forward-promotion-trigger", "--native-status-before-subscribe"}

    def test_fixed_arm_passes_both_flags(self):
        self.assertTrue(rx.is_native_fixed_arm("native", "forward-trigger"))
        self.assertEqual(rx.native_fixed_relay_args(self.FLAGS, "native", "forward-trigger"),
                         ["--forward-promotion-trigger", "--native-status-before-subscribe"])

    def test_other_arms_pass_neither(self):
        for mech, mode in (("native", None), ("pr1378", "next-group"), ("pr1378", "playhead"),
                           ("switch-from", "hard")):
            self.assertFalse(rx.is_native_fixed_arm(mech, mode))
            self.assertEqual(rx.native_fixed_relay_args(self.FLAGS, mech, mode), [])

    def test_fixed_arm_requires_both_flags_in_help(self):
        for missing in ("--forward-promotion-trigger", "--native-status-before-subscribe"):
            with self.assertRaises(SystemExit) as cm:
                rx.native_fixed_relay_args(self.FLAGS - {missing}, "native", "forward-trigger")
            self.assertIn(missing, str(cm.exception))
        # an older relay without the flags is fine for every other arm
        self.assertEqual(rx.native_fixed_relay_args(set(rx.RELAY_PINNED), "native", None), [])

    def test_relay_config_must_match_the_arm(self):
        on = dict(OK_CONFIG, forward_promotion_trigger=True, native_status_before_subscribe=True)
        self.assertIsNone(rx.check_relay_config(on, "cubic", False, native_fixed=True))
        self.assertIsNone(rx.check_relay_config(OK_CONFIG, "cubic", False, native_fixed=False))
        # both directions of a mismatch, field by field; never waived by allow_missing
        for field in ("forward_promotion_trigger", "native_status_before_subscribe"):
            half = dict(on, **{field: False})
            for allow in (False, True):
                err = rx.check_relay_config(half, "cubic", allow, native_fixed=True)
                self.assertIsNotNone(err)
                self.assertIn(field, err)
                err = rx.check_relay_config(dict(OK_CONFIG, **{field: True}), "cubic", allow, native_fixed=False)
                self.assertIsNotNone(err)
                self.assertIn(field, err)
        # a fixed relay under another arm's name is rejected too
        self.assertIsNotNone(rx.check_relay_config(on, "cubic", True, native_fixed=False))

    def test_missing_field(self):
        for field in ("forward_promotion_trigger", "native_status_before_subscribe"):
            rec = {k: v for k, v in OK_CONFIG.items() if k != field}
            self.assertIn(field, rx.check_relay_config(rec, "cubic", False))
            # a smoke run of another arm may use a relay without the field...
            self.assertIsNone(rx.check_relay_config(rec, "cubic", True))
            # ...the fixed arm may not: the record is what shows it ran fixed
            on = {k: True for k in ("forward_promotion_trigger", "native_status_before_subscribe")}
            rec_on = {k: v for k, v in dict(OK_CONFIG, **on).items() if k != field}
            self.assertIn(field, rx.check_relay_config(rec_on, "cubic", True, native_fixed=True))

    def test_fields_under_config_are_read(self):
        self.assertIsNone(rx.check_relay_config({"config": OK_CONFIG}, "cubic", False))

    def test_relay_source_has_the_flags(self):
        rs = REPO / "apps/relay/src/server/config.rs"
        if not rs.exists():
            self.skipTest("relay source not in this checkout")
        flags = rust_long_flags(rs)
        if (REPO / "apps/relay/src/server/switch_delivery.rs").exists():
            # the pr1378 relay: SWITCH is PR #1378's, so neither native flag exists;
            # it records both false and takes T_switch from the runner (P8)
            self.assertNotIn("--native-status-before-subscribe", flags)
            self.assertNotIn("--forward-promotion-trigger", flags)
            self.assertIn("--t-switch-ms", flags)
            return
        # harness has --native-status-before-subscribe; --forward-promotion-trigger is native-ft's
        self.assertIn("--native-status-before-subscribe", flags)


class Pr1378Arm(unittest.TestCase):
    """P8: `--mechanism pr1378 --mechanism-mode next-group|playhead` runs the relay with
    T_switch pinned (3000 ms), the congestion controller and UDP GSO off, never the
    native-fix flags; its RELAY_CONFIG must report the pinned t_switch_ms."""

    FLAGS = set(rx.RELAY_PINNED) | {"--cache-size", "--congestion-controller", "--udp-gso", "--t-switch-ms"}

    def test_relay_argv(self):
        for mode in ("next-group", "playhead"):
            argv, rec = rx.pinned_relay_args(self.FLAGS, "cubic", 1000, allow_missing=False, mechanism="pr1378")
            pairs = dict(zip(argv[::2], argv[1::2]))
            self.assertEqual(pairs["--t-switch-ms"], "3000")
            self.assertEqual(pairs["--congestion-controller"], "cubic")
            self.assertEqual(pairs["--udp-gso"], "off")
            self.assertEqual(rx.native_fixed_relay_args(self.FLAGS | set(rx.NATIVE_FIXED_FLAGS), "pr1378", mode), [])
            self.assertFalse(any(f in argv for f in rx.NATIVE_FIXED_FLAGS))
            self.assertEqual(rx.expected_t_switch_ms("pr1378"), 3000)

    def test_url_selects_the_floor(self):
        self.assertEqual(rx.MECHANISM_URL_PARAM["pr1378"], "switchFloor")
        self.assertEqual(rx.MECHANISM_MODES["pr1378"], {"next-group", "playhead"})

    def test_relay_config_must_report_the_pinned_t_switch(self):
        ok = dict(OK_CONFIG, t_switch_ms=3000)
        self.assertIsNone(rx.check_relay_config(ok, "cubic", False, t_switch_ms=3000))
        self.assertIsNone(rx.check_relay_config({"config": ok}, "cubic", False, t_switch_ms=3000))
        for allow in (False, True):
            err = rx.check_relay_config(dict(ok, t_switch_ms=6000), "cubic", allow, t_switch_ms=3000)
            self.assertIsNotNone(err)
            self.assertIn("t_switch_ms", err)
        err = rx.check_relay_config(OK_CONFIG, "cubic", False, t_switch_ms=3000)
        self.assertIn("t_switch_ms", err)
        # a native run does not check it
        self.assertIsNone(rx.check_relay_config(OK_CONFIG, "cubic", False))
        self.assertIsNone(rx.expected_t_switch_ms("native"))

    def test_relay_source_records_t_switch(self):
        rs = REPO / "apps/relay/src/server/config.rs"
        if not (REPO / "apps/relay/src/server/switch_delivery.rs").exists():
            self.skipTest("not the pr1378 relay")
        self.assertIn('"t_switch_ms"', rs.read_text())


class PreflightWiring(unittest.TestCase):
    def test_validate_command_passes_preflight_and_final(self):
        out = Path("/tmp/run")
        self.assertNotIn("--preflight", rx.validate_command(out, False, False))
        cmd = rx.validate_command(out, True, True)
        self.assertEqual(cmd[-2:], ["--final", "--preflight"])
        self.assertTrue(cmd[1].endswith("validate.py"))

    def test_preflight_profile_steps_leave_room_for_the_delivery_check(self):
        prof = json.loads((Path(rx.__file__).parent / "profiles" / "preflight_step.json").read_text())
        ats = [s["at_s"] for s in prof["steps"]]
        self.assertEqual(ats, [0, 30, 60])
        self.assertEqual([s["rate_mbps"] for s in prof["steps"]], [6, 1.5, 6])


class NativeFixedArmBranch(unittest.TestCase):
    """R5 D-1: the branch guard and the missing-flag message must name the same branch."""

    def test_both_native_arms_run_on_the_native_branch(self):
        self.assertEqual(rx.MECHANISM_BRANCH["native"], "switch/native")

    def test_missing_fixed_flags_name_the_guarded_branch(self):
        flags = {"--forward-promotion-trigger"}          # an older relay: one of the two flags
        with self.assertRaises(SystemExit) as cm:
            rx.native_fixed_relay_args(flags, "native", "forward-trigger")
        msg = str(cm.exception)
        self.assertIn(rx.MECHANISM_BRANCH["native"], msg)
        self.assertNotIn("rebuild/native-ft", msg)
        self.assertIn("--native-status-before-subscribe", msg)

    def test_as_shipped_native_passes_no_fixed_flags(self):
        self.assertEqual(rx.native_fixed_relay_args(set(rx.NATIVE_FIXED_FLAGS), "native", None), [])
        self.assertEqual(rx.native_fixed_relay_args(set(rx.NATIVE_FIXED_FLAGS), "native", "forward-trigger"),
                         list(rx.NATIVE_FIXED_FLAGS))


class RelayConfigCheck(unittest.TestCase):
    def test_udp_gso_must_be_off(self):
        self.assertIn("udp_gso", rx.check_relay_config({"congestion_controller": "cubic", "udp_gso": "on"}, "cubic", False))
        self.assertIn("udp_gso", rx.check_relay_config({"congestion_controller": "cubic", "udp_gso": "on"}, "cubic", True))
        self.assertIn("no udp_gso", rx.check_relay_config({"congestion_controller": "cubic"}, "cubic", False))
        self.assertIsNone(rx.check_relay_config({"congestion_controller": "cubic"}, "cubic", True))

    def test_stop_wait_exceeds_relay_drain(self):
        self.assertGreater(rx.STOP_WAIT_S, 10.0)  # the relay drains for 10 s after SIGTERM

    def test_cc_must_match(self):
        self.assertIsNone(rx.check_relay_config(dict(OK_CONFIG, event="RELAY_CONFIG"), "cubic", False))
        self.assertIsNone(rx.check_relay_config(dict(OK_CONFIG, event="RELAY_CONFIG", congestion_controller="Cubic"),
                                                "cubic", False))
        self.assertIsNone(rx.check_relay_config({"config": dict(OK_CONFIG, congestion_controller="bbr")}, "bbr", False))
        self.assertIn("runner asked for 'cubic'",
                      rx.check_relay_config({"congestion_controller": "bbr"}, "cubic", False))
        # also enforced in smoke mode: a relay that reports a different cc is never accepted
        self.assertIsNotNone(rx.check_relay_config({"congestion_controller": "bbr"}, "cubic", True))

    def test_missing_record_or_field(self):
        self.assertIn("no RELAY_CONFIG", rx.check_relay_config(None, "cubic", False))
        self.assertIsNone(rx.check_relay_config(None, "cubic", True))
        self.assertIn("no congestion_controller", rx.check_relay_config({"t_switch_ms": 3000}, "cubic", False))
        self.assertIsNone(rx.check_relay_config({"t_switch_ms": 3000}, "cubic", True))


def runner_args(tmp: Path, **kw) -> argparse.Namespace:
    enc = tmp / "enc"
    enc.mkdir(exist_ok=True)
    (enc / "meta.json").write_text(json.dumps({"gops_per_variant": 240, "variants": ["a", "b"]}))
    base = dict(mechanism="native", mechanism_mode=None, client_mode="live-edge", time_shift=10.0,
                profile=PROFILES / "step_down_up.json", duration=180.0, warmup=15.0, net="none",
                offloads=",".join(net.DEFAULT_OFFLOADS), bg_flows=0, bg_pattern="steady", bg_cc=None,
                encoded_dir=enc, max_variants=4, ladder_spec="cache", cache_size=1000, cc="cubic",
                allow_missing_relay_flags=False, relay_port=4433, vite_port=5173, keep_vite=False, browser=None,
                cert_dir=tmp, headed=False, log_objects=False, abr="", controller="min", controller_param=None,
                label="", results=tmp / "results", no_analyze=False, final=False, no_rust_build=True,
                no_lib_build=True, repeat=1, repeat_start=0, repeat_index=0)
    base.update(kw)
    return argparse.Namespace(**base)


PROBES = {"git_sha": "abc", "branch": "switch/native", "dirty_worktree": False, "delay_groups": 0,
          "gop_duration_ms": 1000, "ladder_id": "enc:a+b", "cache_meta_hash": "f" * 64, "kernel": "6.8.0",
          "tc_version": "tc utility, iproute2-6.1.0"}


class Identity(unittest.TestCase):
    CONTRACT_FIELDS = ("congestion_controller", "relay_config", "cache_meta_hash", "kernel", "tc_version",
                       "offloads_disabled", "warmup_s", "controller")

    def _ident(self, tmp, net_backend="netns", offloads=None, **kw):
        args = runner_args(tmp, **kw)
        return rx.build_identity(args, run_id="rid", repeat_index=2, stamp="20261004T000000Z",
                                 profile=net.load_profile(args.profile), net_backend=net_backend,
                                 offloads=offloads if offloads is not None else {"all_off": True},
                                 relay_config={"event": "RELAY_CONFIG", "congestion_controller": "cubic"},
                                 warmup_s=15.0, browser="firefox", probes=PROBES)

    def test_contract_fields_and_no_seed(self):
        with tempfile.TemporaryDirectory() as d:
            ident = self._ident(Path(d))
        for f in self.CONTRACT_FIELDS:
            self.assertIn(f, ident)
        self.assertNotIn("seed", ident)
        self.assertEqual(ident["congestion_controller"], "cubic")
        self.assertEqual(ident["relay_config"]["congestion_controller"], "cubic")
        self.assertEqual((ident["kernel"], ident["warmup_s"], ident["offloads_disabled"]), ("6.8.0", 15.0, True))
        self.assertEqual((ident["controller"], ident["controller_family"]), ("min", "min"))
        self.assertEqual(ident["controller_params"], {"controllerArm": "min"})
        self.assertEqual((ident["qdisc"], ident["network_profile"], ident["repeat_index"]),
                         ("tail-drop", "step_down_up", 2))

    def test_unshaped_and_offloads_not_all_off(self):
        with tempfile.TemporaryDirectory() as d:
            ident = self._ident(Path(d), net_backend="none")
            self.assertEqual(ident["qdisc"], "none")
            self.assertIsNone(ident["offloads_disabled"])
            ident = self._ident(Path(d), offloads={"all_off": False})
            self.assertIs(ident["offloads_disabled"], False)
            ident = self._ident(Path(d), offloads={})
            self.assertIs(ident["offloads_disabled"], False)

    def test_identity_is_json_and_probes_are_required(self):
        with tempfile.TemporaryDirectory() as d:
            json.dumps(self._ident(Path(d)))
            args = runner_args(Path(d))
            with self.assertRaises(ValueError):
                rx.build_identity(args, run_id="r", repeat_index=0, stamp="s", profile={"name": "x", "queue": "q"},
                                  net_backend="none", offloads=None, relay_config=None, warmup_s=0, browser=None,
                                  probes={})


class ViteHosts(unittest.TestCase):
    def test_shared_vite_probes_loopback_before_the_veth_exists(self):
        self.assertEqual(rx.Vite("10.200.0.1", 5173, Path("x"), shared=True).bind_and_probe_hosts(),
                         ("0.0.0.0", "127.0.0.1"))
        self.assertEqual(rx.Vite("10.200.0.1", 5173, Path("x"), shared=False).bind_and_probe_hosts(),
                         ("10.200.0.1", "10.200.0.1"))
        self.assertEqual(rx.Vite("localhost", 5173, Path("x"), shared=True).bind_and_probe_hosts(),
                         ("localhost", "127.0.0.1"))


class AbortedRuns(unittest.TestCase):
    """run_once with the stack replaced by a backend that fails at a chosen
    point: the run directory always gets the invalid validation.json (M20)."""

    def _run(self, exc: BaseException, where: str = "setup") -> tuple[int, Path]:
        class Boom(net.NoneBackend):
            def setup(self, topo):
                if where == "setup":
                    raise exc
                super().setup(topo)
        d = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        args = runner_args(d)
        with mock.patch.object(rx, "make_backend", lambda name, **kw: Boom()), \
                mock.patch.object(rx.time, "sleep", lambda s: None), \
                mock.patch.object(rx, "worktree_dirty", lambda: False):
            if where == "relay":
                with mock.patch.object(rx, "ROOT", d):  # no target/release/relay here: SystemExit inside try
                    code = rx.run_once(args, 0)
            else:
                code = rx.run_once(args, 0)
        outs = [p for p in (d / "results").iterdir() if p.is_dir()]
        self.assertEqual(len(outs), 1)
        return code, outs[0]

    def _assert_invalid(self, out: Path) -> None:
        v = json.loads((out / "validation.json").read_text())
        self.assertEqual(v, {"passed": False, "final": False, "failed": ["aborted"], "checks": []})
        meta = json.loads((out / "run_meta.json").read_text())
        self.assertEqual(meta["validity"], {"passed": False, "final": False, "aborted": True})
        self.assertNotIn("seed", meta["identity"])
        events = [json.loads(line)["event"] for line in (out / "runner-events.jsonl").read_text().splitlines()]
        self.assertIn("RUN_ABORT", events)

    def test_setup_failure(self):
        code, out = self._run(RuntimeError("ip netns add failed"))
        self.assertEqual(code, 1)
        self._assert_invalid(out)

    def test_ctrl_c(self):
        code, out = self._run(KeyboardInterrupt())
        self.assertEqual(code, 130)
        self._assert_invalid(out)

    def test_missing_binary(self):
        code, out = self._run(RuntimeError("unused"), where="relay")
        self.assertEqual(code, 1)
        self._assert_invalid(out)


if __name__ == "__main__":
    unittest.main()


class HtbClassRate(unittest.TestCase):
    """The capacity a step set, as the kernel holds it (`tc class show`)."""

    def test_parses_tc_rate_units(self):
        self.assertEqual(net.parse_htb_class_rate(
            "class htb 2:10 root leaf 20: prio 0 rate 1500Kbit ceil 1500Kbit burst 1599b cburst 1599b"), 1_500_000)
        self.assertEqual(net.parse_htb_class_rate(
            "class htb 2:10 root leaf 20: prio 0 rate 6Mbit ceil 6Mbit burst 1599b cburst 1599b\n"), 6_000_000)

    def test_other_classes_and_no_class(self):
        self.assertIsNone(net.parse_htb_class_rate("class htb 2:1 root rate 6Mbit ceil 6Mbit"))
        self.assertIsNone(net.parse_htb_class_rate(""))


class UdpSnmp(unittest.TestCase):
    def test_parses_the_udp_rows(self):
        text = ("Ip: Forwarding DefaultTTL\nIp: 1 64\n"
                "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\n"
                "Udp: 18124 0 36 9000 36 0 0 0 0\n")
        u = net.parse_udp_snmp(text)
        self.assertEqual(u["RcvbufErrors"], 36)
        self.assertEqual(u["InDatagrams"], 18124)
        self.assertEqual(net.parse_udp_snmp("nothing"), {})


class SessionFitsCache(unittest.TestCase):
    """The publisher runs out gops seconds after its first group; the session must end
    before that (with a few groups to spare), page load included."""

    def test_a_200_s_session_fits_the_240_s_cache_after_22_s(self):
        self.assertIsNone(rx.session_fits_cache(1_000_000, 1_022_000, 200, 240))

    def test_a_slow_page_load_that_would_run_the_cache_out_is_refused(self):
        msg = rx.session_fits_cache(1_000_000, 1_040_000, 200, 240)
        self.assertIn("needs 245.0", msg)

    def test_unknown_inputs_do_not_refuse(self):
        self.assertIsNone(rx.session_fits_cache(None, 1_022_000, 200, 240))
        self.assertIsNone(rx.session_fits_cache(1_000_000, 1_022_000, 200, None))
