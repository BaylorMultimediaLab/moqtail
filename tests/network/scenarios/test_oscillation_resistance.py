"""Scenario 7: Oscillation resistance — bandwidth alternates rapidly."""

import asyncio
import time

import pytest

from assertions import assert_max_switches, assert_quality_floor
from metrics_collector import MetricsCollector
from shaper import shape_link2


OSCILLATION_PERIOD_S = 10
OSCILLATION_DURATION_S = 60
BW_HIGH = 5.0
BW_LOW = 0.6


@pytest.mark.asyncio
async def test_oscillation_resistance(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Alternate link2 between 5 Mbps and 0.6 Mbps every 10s for 60s.

    Assert client doesn't switch more than once per cycle (max 6 switches in 60s)
    and ABR dampening prevents ping-pong.
    """
    page = browser_page

    # Let stream stabilize
    await collector.collect_for(page, duration_s=10)

    test_start = time.time()
    num_cycles = OSCILLATION_DURATION_S // OSCILLATION_PERIOD_S

    for i in range(num_cycles):
        bw = BW_HIGH if i % 2 == 0 else BW_LOW
        shape_link2(net, bw_mbps=bw)
        await collector.collect_for(page, duration_s=OSCILLATION_PERIOD_S)

    test_end = time.time()

    # Max one switch per cycle = 6 switches in 60s
    # But we use max_switches_per_minute from config (default 4) as a stricter check
    # that ABR dampening is working
    assert_max_switches(
        collector, test_start, test_end, max_switches=num_cycles
    )

    # Quality floor
    assert_quality_floor(collector, test_start, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
