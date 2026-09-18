"""Scenario 4: High latency on relay-client link."""

import time

import pytest

from assertions import assert_max_switches, assert_no_rebuffering, assert_quality_floor
from shaper import shape_link2


@pytest.mark.asyncio
async def test_high_latency(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Apply 200ms RTT + 50ms jitter on link2 with 5 Mbps bandwidth.

    Assert client maintains stable quality without unnecessary downswitches.
    Buffer can sit close to 0 because the player intentionally hugs the live
    edge (LIVE_EDGE_STARTUP_OFFSET = 1s, then catchup playback rate). What we
    actually care about under high RTT is that playback never *stops* —
    `assert_no_rebuffering` checks buffer > 0 across frames-decoded samples,
    which is the right semantics for a live-edge player.
    """
    page = browser_page

    shape_link2(net, bw_mbps=5.0, delay_ms=200, jitter_ms=50)

    test_start = time.time()
    await collector.collect_for(page, duration_s=60)
    test_end = time.time()

    assert_no_rebuffering(collector, test_start, test_end)

    # Latency alone shouldn't cause downswitches.
    assert_max_switches(
        collector, test_start, test_end, thresholds["max_switches_per_minute"]
    )

    assert_quality_floor(collector, test_start, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
