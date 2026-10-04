"""Unit tests for the runner's pure helpers (experiments/run_experiment.py).

Run: python3 -m unittest experiments/tests/test_run_experiment.py. Covers M20
(relay flags pinned identically on every branch, missing contract flags are a
clear error), identity fields, the controller arm wiring, run ids and the
cache-length guard. No process is started.
"""

from __future__ import annotations

import json
import os
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import run_experiment as rx  # noqa: E402

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
        flags = set(rx.RELAY_PINNED) | {"--congestion-controller"}
        argv, rec = rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        for flag, value in rx.RELAY_PINNED.items():
            self.assertIn(flag, argv)
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertEqual(argv[argv.index("--congestion-controller") + 1], "cubic")
        self.assertEqual(rec["skipped"], ["--t-switch-ms"])
        self.assertEqual(rec["missing"], [])
        argv2, rec2 = rx.pinned_relay_args(flags | {"--t-switch-ms"}, "bbr", 1000, allow_missing=False)
        self.assertEqual(argv2[argv2.index("--t-switch-ms") + 1], "3000")
        self.assertEqual(argv2[argv2.index("--congestion-controller") + 1], "bbr")
        self.assertEqual(rec2["skipped"], [])
        # the branch-specific default (pr1674: 2000) and harness default (500) are both overridden
        self.assertEqual(rx.RELAY_PINNED["--track-alias-resolution-timeout-ms"], "2000")

    def test_missing_contract_flag_is_a_clear_error(self):
        flags = set(rx.RELAY_PINNED)  # no --congestion-controller
        with self.assertRaises(SystemExit) as cm:
            rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=False)
        self.assertIn("--congestion-controller", str(cm.exception))
        self.assertIn("relay --help", str(cm.exception))
        argv, rec = rx.pinned_relay_args(flags, "cubic", 1000, allow_missing=True)
        self.assertEqual(rec["missing"], ["--congestion-controller"])
        self.assertNotIn("--congestion-controller", argv)

    def test_publisher_variant_priority(self):
        argv, rec = rx.pinned_publisher_args({"--variant-priority"}, allow_missing=False)
        self.assertEqual(argv, ["--variant-priority", "128"])
        with self.assertRaises(SystemExit):
            rx.pinned_publisher_args(set(), allow_missing=False)
        argv, rec = rx.pinned_publisher_args(set(), allow_missing=True)
        self.assertEqual((argv, rec["missing"]), ([], ["--variant-priority"]))


class Safety(unittest.TestCase):
    def test_cache_length_guard(self):
        # 200 s run + 15 s warm-up + 30 s margin = 245 > 240 groups: refused
        self.assertIn("245", rx.check_cache_length(200, 15, 240))
        self.assertIsNone(rx.check_cache_length(180, 15, 240))
        self.assertIsNotNone(rx.check_cache_length(60, 15, None))

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
        self.assertEqual(rx.controller_params(self._args("min")), {rx.CONTROLLER_ARM_PARAM: "min"})
        self.assertEqual(rx.controller_params(self._args("baseline")), {})
        # grid keeps its knob params, untouched by the arm param
        grid = rx.controller_params(self._args("grid"))
        self.assertNotIn(rx.CONTROLLER_ARM_PARAM, grid)
        self.assertEqual(grid["probeMaxBytes"], 65536)

    def test_override_typing(self):
        p = rx.controller_params(self._args("min", ["upDwellGroups=4", "bufferSignal=envelope", "safety=0.9"]))
        self.assertEqual(p, {rx.CONTROLLER_ARM_PARAM: "min", "upDwellGroups": 4, "bufferSignal": "envelope",
                             "safety": 0.9})
        with self.assertRaises(SystemExit):
            rx.controller_params(self._args("min", ["novalue"]))


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


if __name__ == "__main__":
    unittest.main()
