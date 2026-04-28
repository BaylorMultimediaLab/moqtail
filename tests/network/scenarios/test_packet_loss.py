"""Scenario 5: Packet loss on relay-client link."""

import time

import pytest

from assertions import assert_max_switches, assert_quality_floor
from shaper import shape_link2


@pytest.mark.asyncio
async def test_packet_loss(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Apply 5% packet loss on link2 with 5 Mbps bandwidth.

    Assert client stabilizes (no oscillation) and quality floor is maintained.
    """
    page = browser_page

    shape_link2(net, bw_mbps=5.0, loss_pct=5.0)

    test_start = time.time()
    await collector.collect_for(page, duration_s=60)
    test_end = time.time()

    assert_max_switches(
        collector, test_start, test_end, thresholds["max_switches_per_minute"]
    )

    assert_quality_floor(collector, test_start, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
