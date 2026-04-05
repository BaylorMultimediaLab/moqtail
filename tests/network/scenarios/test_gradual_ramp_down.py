"""Scenario 1: Gradual bandwidth ramp-down on relay-client link."""

import time

import pytest

from assertions import (
    assert_downswitch_within,
    assert_no_rebuffering,
    assert_quality_floor,
)
from shaper import shape_link2


RAMP_STEPS = [
    (5.0, "1080p"),
    (4.0, "1080p"),
    (3.0, "720p"),
    (2.0, "720p"),
    (1.0, "480p"),
    (0.6, "360p"),
]
STEP_DURATION_S = 15


@pytest.mark.asyncio
async def test_gradual_ramp_down(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Reduce link2 bandwidth from 5 Mbps to 0.6 Mbps in steps.

    At each step, assert the client downswitches to the expected quality
    within the configured threshold, with no rebuffering.
    """
    page = browser_page
    test_start = time.time()

    # Let the stream stabilize at initial quality
    await collector.collect_for(page, duration_s=10)

    for bw_mbps, expected_quality in RAMP_STEPS:
        step_time = time.time()
        shape_link2(net, bw_mbps=bw_mbps)

        # Collect metrics for the step duration
        await collector.collect_for(page, duration_s=STEP_DURATION_S)

        # Assert downswitch happened within threshold
        assert_downswitch_within(
            collector,
            change_time=step_time,
            max_latency_s=thresholds["downswitch_latency_s"],
            expected_quality=expected_quality,
        )

    # Assert no rebuffering across the entire test
    test_end = time.time()
    assert_no_rebuffering(collector, test_start, test_end)
    assert_quality_floor(collector, test_start, test_end, thresholds["quality_floor"])

    # Save results
    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
