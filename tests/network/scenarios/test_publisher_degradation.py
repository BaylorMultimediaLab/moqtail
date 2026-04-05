"""Scenario 6: Publisher-side bandwidth degradation."""

import time

import pytest

from assertions import assert_no_crash, assert_quality_floor
from shaper import shape_link1


@pytest.mark.asyncio
async def test_publisher_degradation(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Drop link1 (publisher-relay) to 1 Mbps while link2 stays at 5 Mbps.

    Assert client adapts gracefully — no crash or hang.
    """
    page = browser_page

    # Let stream stabilize
    await collector.collect_for(page, duration_s=10)

    # Degrade publisher-side link
    degrade_time = time.time()
    shape_link1(net, bw_mbps=1.0)
    await collector.collect_for(page, duration_s=30)
    test_end = time.time()

    # Client must not crash or hang
    assert_no_crash(collector, degrade_time, test_end)

    # Quality floor — should still be at least 360p
    assert_quality_floor(collector, degrade_time, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
