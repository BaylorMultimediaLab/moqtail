"""Scenario 4: High latency on relay-client link."""

import time

import pytest

from assertions import assert_buffer_above, assert_max_switches, assert_quality_floor
from shaper import shape_link2


@pytest.mark.asyncio
async def test_high_latency(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Apply 200ms RTT + 50ms jitter on link2 with 5 Mbps bandwidth.

    Assert client maintains stable quality without unnecessary downswitches.
    """
    page = browser_page

    # Apply high latency with full bandwidth
    shape_link2(net, bw_mbps=5.0, delay_ms=200, jitter_ms=50)

    test_start = time.time()
    await collector.collect_for(page, duration_s=60)
    test_end = time.time()

    # Buffer should stay above minimum
    assert_buffer_above(
        collector, test_start, test_end, thresholds["min_stable_buffer_s"]
    )

    # Should not have excessive switches (latency alone shouldn't cause downswitches)
    assert_max_switches(
        collector, test_start, test_end, thresholds["max_switches_per_minute"]
    )

    # Quality floor
    assert_quality_floor(collector, test_start, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
