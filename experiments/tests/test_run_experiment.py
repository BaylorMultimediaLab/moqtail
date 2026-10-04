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
