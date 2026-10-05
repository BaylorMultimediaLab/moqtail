"""pf-delivery-rate: link-limited groups must arrive at the link rate; out-of-band steps are attributed with the probe."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import validate  # noqa: E402

T0 = 1_000_000_000_000


def step(at_s: float, rate):
    return {"ts": T0 + at_s * 1000, "at_s": at_s, "rate_mbps": rate, "applied": True}


def samples(t_from_s: float, t_to_s: float, bps: float, nbytes: int, every_s: float = 1.0):
    out, t = [], t_from_s
    while t < t_to_s:
        out.append({"ts": T0 + t * 1000, "event": "THROUGHPUT_SAMPLE", "bps": bps, "bytes": nbytes})
        t += every_s
    return out


def probes(t_from_s: float, t_to_s: float, bps: float, every_s: float = 2.0):
    out, t = [], t_from_s
    while t < t_to_s:
        dt_ms = 65_536 * 8 / bps * 1000
        out.append({"ts": T0 + t * 1000, "event": "PROBE", "src": "client", "p_bytes": 65_536, "dt_ms": dt_ms})
        t += every_s
    return out


class DeliveryRate(unittest.TestCase):
    def test_transport_cause_when_probe_is_as_low(self):
        applied = [step(0, 6), step(60, 1.5), step(120, 6)]
        tput = samples(0, 60, 5.6e6, 150_000) + samples(60, 120, 1.42e6, 62_000) + samples(120, 180, 1.4e6, 150_000)
        ok, detail = validate.delivery_rate(applied, tput, probes(120, 180, 1.3e6), T0 + 180_000)
        self.assertFalse(ok)
        self.assertIn("(transport)", detail)

    def test_client_timing_cause_when_probe_sees_the_link(self):
        applied = [step(0, 6)]
        ok, detail = validate.delivery_rate(applied, samples(0, 60, 1.5e6, 150_000), probes(0, 60, 5.0e6), T0 + 60_000)
        self.assertFalse(ok)
        self.assertIn("client-side timing (M11)", detail)


def timed_probes(t_from_s: float, t_to_s: float, pure_bps: float, dt_bps: float, objects: int | None = 8, every_s: float = 2.0):
    """PROBE records with first/last_object_ms (2026-10 contract): objects 2..N arrive at
    `pure_bps`, while dt_ms (request to the end of the read, with the request round trip and
    the idle wait) says `dt_bps`."""
    out, t = [], t_from_s
    while t < t_to_s:
        ts = T0 + t * 1000
        n = objects or 8
        span_ms = 65_536 * (n - 1) / n * 8 / pure_bps * 1000
        rec = {"ts": ts, "event": "PROBE", "src": "client", "p_bytes": 65_536, "dt_ms": 65_536 * 8 / dt_bps * 1000,
               "first_object_ms": ts - 100 - span_ms, "last_object_ms": ts - 100}
        if objects is not None:
            rec["objects"] = objects
        out.append(rec)
        t += every_s
    return out


class ProbeTransferRate(unittest.TestCase):
    """D12: the probe's 'pure transfer rate' was p_bytes x 8 / dt_ms, and dt_ms includes the
    request round trip and the idle wait after the last object."""

    def test_first_to_last_object_rate(self):
        applied = [step(0, 6)]
        tput = samples(0, 60, 1.5e6, 150_000)
        ok, detail = validate.delivery_rate(applied, tput, timed_probes(0, 60, 6.0e6, 1.5e6), T0 + 60_000)
        self.assertFalse(ok)
        self.assertIn("client-side timing (M11)", detail)     # before: "(transport)" from dt_ms
        self.assertIn("first-to-last object", detail)

    def test_without_object_count_uses_all_bytes(self):
        applied = [step(0, 6)]
        ok, detail = validate.delivery_rate(applied, samples(0, 60, 1.5e6, 150_000), timed_probes(0, 60, 6.0e6, 1.5e6, objects=None),
                                            T0 + 60_000)
        self.assertIn("client-side timing (M11)", detail)
        self.assertIn("object count unknown", detail)

    def test_old_bundle_falls_back_to_dt_ms(self):
        applied = [step(0, 6)]
        ok, detail = validate.delivery_rate(applied, samples(0, 60, 1.5e6, 150_000), probes(0, 60, 1.5e6), T0 + 60_000)
        self.assertIn("(transport)", detail)
        self.assertIn("dt_ms", detail)


class EstimatorFidelity(unittest.TestCase):
    def test_reads_the_link_passes(self):
        applied = [step(0, 6), step(60, 1.5), step(120, 6)]
        tput = (samples(0, 60, 5.6e6, 150_000) + samples(60, 120, 1.42e6, 62_000)
                + samples(120, 180, 5.7e6, 150_000))
        ok, detail = validate.delivery_rate(applied, tput, None, T0 + 180_000)
        self.assertTrue(ok, detail)

    def test_consume_pace_after_restore_fails(self):
        # fresh-grid-v2 native-forward-trigger shift10s r1: 1.6-1.8 Mbps on a 6 Mbps link.
        applied = [step(0, 6), step(60, 1.5), step(120, 6)]
        tput = (samples(0, 60, 5.6e6, 150_000) + samples(60, 120, 1.42e6, 62_000)
                + samples(120, 180, 1.7e6, 150_000))
        ok, detail = validate.delivery_rate(applied, tput, None, T0 + 180_000)
        self.assertFalse(ok, detail)
        self.assertIn("OUT OF BAND", detail)

    def test_overestimate_fails(self):
        applied = [step(0, 1.5)]
        ok, _ = validate.delivery_rate(applied, samples(0, 60, 3.0e6, 62_000), None, T0 + 60_000)
        self.assertFalse(ok)

    def test_publisher_paced_groups_are_not_judged(self):
        # 240p groups (19 KB) leave the relay faster than 6 Mbps would carry them only in
        # ~25 ms; at 50 ms burst they are publisher-paced on a 6 Mbps link, so they are ignored.
        applied = [step(0, 6)]
        ok, detail = validate.delivery_rate(applied, samples(0, 60, 2.5e6, 19_000), None, T0 + 60_000)
        self.assertIsNone(ok, detail)

    def test_settle_window_excludes_the_transition(self):
        applied = [step(0, 6), step(60, 1.5)]
        # wrong values only in the first 10 s after each step: not judged
        tput = (samples(0, 10, 0.5e6, 150_000) + samples(10, 60, 5.6e6, 150_000)
                + samples(60, 70, 6e6, 62_000) + samples(70, 120, 1.4e6, 62_000))
        ok, detail = validate.delivery_rate(applied, tput, None, T0 + 120_000)
        self.assertTrue(ok, detail)

    def test_unshaped_run_is_not_judged(self):
        ok, _ = validate.delivery_rate([step(0, None)], samples(0, 60, 50e6, 150_000), None, T0 + 60_000)
        self.assertIsNone(ok)


if __name__ == "__main__":
    unittest.main()


def _tree(*levels):
    return [{"kind": k, "handle": h, "parent": p} for k, h, p in levels]


SHAPED_TREE = _tree(("netem", "1:", "root"), ("htb", "2:", "1:1"), ("bfifo", "20:", "2:10"))


class QdiscTree(unittest.TestCase):
    """pf-qdisc reads the kernel tree recorded after each step. Preflight 2026-10-05:
    the old check read the step's tc commands, and a capacity step (`tc class change`)
    names only htb, so every shaped run failed although the tree was right."""

    def step(self, rate, tree=SHAPED_TREE, cmds=("tc class change dev veth-moqh parent 2: classid 2:10 htb rate 1500kbit",),
             htb_rate=None):
        qs = {"tree": tree}
        if htb_rate is not None:
            qs["htb_class"] = {"classid": "2:10", "rate_bps": htb_rate}
        return {"at_s": 30, "rate_mbps": rate, "queue": "tail-drop", "applied": True, "tc": list(cmds), "qdisc_stats": qs}

    def test_a_class_change_step_with_the_full_tree_passes(self):
        self.assertEqual(validate.qdisc_tree_errors([self.step(1.5)]), [])

    def test_the_class_rate_must_be_the_steps(self):
        self.assertEqual(validate.qdisc_tree_errors([self.step(1.5, htb_rate=1_500_000)]), [])
        bad = validate.qdisc_tree_errors([self.step(1.5, htb_rate=6_000_000)])
        self.assertEqual(len(bad), 1)
        self.assertIn("htb class rate 6000000", bad[0])

    def test_a_missing_or_misplaced_level_fails(self):
        no_leaf = _tree(("netem", "1:", "root"), ("htb", "2:", "1:1"))
        self.assertIn("want bfifo 20: under 2:10, found none", validate.qdisc_tree_errors([self.step(1.5, no_leaf)])[0])
        wrong_leaf = _tree(("netem", "1:", "root"), ("htb", "2:", "1:1"), ("fq_codel", "20:", "2:10"))
        self.assertIn("found fq_codel", validate.qdisc_tree_errors([self.step(1.5, wrong_leaf)])[0])

    def test_unshaped_is_netem_alone(self):
        self.assertEqual(validate.qdisc_tree_errors([self.step(None, _tree(("netem", "1:", "root")))]), [])
        self.assertIn("unexpected htb", validate.qdisc_tree_errors([self.step(None)])[0])

    def test_bundles_without_a_recorded_tree_fall_back_to_the_commands(self):
        old = {"at_s": 0, "rate_mbps": 6, "applied": True, "qdisc_stats": {"leaf": {}},
               "tc": ["tc qdisc add dev h root handle 1: netem", "tc qdisc add dev h parent 1:1 handle 2: htb",
                      "tc qdisc add dev h parent 2:10 handle 20: bfifo limit 150000"]}
        self.assertEqual(validate.qdisc_tree_errors([old]), [])


class LandingBelowStart(unittest.TestCase):
    """pf-landing. Preflight 2026-10-05 pr1378 live-edge r2: switch 8 asked for group 61
    and the relay started there, but the first object was G60 of an earlier subscription
    to the same track; landing on it ended in MEDIA_ERR_DECODE."""

    def test_a_first_object_below_the_relay_start_is_reported(self):
        sws = [{"switch_seq": 7, "t4_group": 58, "relay_start_group": 58},
               {"switch_seq": 8, "t4_group": 60, "relay_start_group": 61},
               {"switch_seq": 9, "t4_group": None, "relay_start_group": 62},
               {"switch_seq": 10, "t4_group": 70, "relay_start_group": None}]
        self.assertEqual(validate.landing_below_start(sws), ["switch 8 landed on G60, relay start G61"])
