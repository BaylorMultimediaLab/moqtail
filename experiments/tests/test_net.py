"""Unit tests for the shaping command builders and parsers in experiments/net.py.

Run: python3 -m unittest experiments/tests/test_net.py (stdlib only, no root,
no tc). Audit findings covered: C5 (offloads off, byte-sized queue, recorded
stats), M1 (in-place changes, no del/add after setup), M2 (one topology for
both queues, codel target >= 1.5 x MTU time).
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import net  # noqa: E402
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

    def test_leaf_stats_picks_leaf_and_mean_pkt(self):
        st = net.leaf_stats(TC_S_SHOW, Shape(6, 40), Topology())
        self.assertEqual(st["leaf"]["handle"], "20:")
        self.assertAlmostEqual(st["leaf"]["mean_pkt_bytes"], 12300000 / 8500)
        self.assertEqual(len(st["tree"]), 3)

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


if __name__ == "__main__":
    unittest.main()
