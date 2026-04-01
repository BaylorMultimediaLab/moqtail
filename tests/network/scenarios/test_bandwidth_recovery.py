"""Scenario 3: Bandwidth recovery (upswitch) on relay-client link."""

import time

import pytest

from assertions import assert_downswitch_within, assert_upswitch_within, assert_quality_floor
from metrics_collector import MetricsCollector
from shaper import shape_link2


@pytest.mark.asyncio
async def test_bandwidth_recovery(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Start at 0.6 Mbps (360p), then restore to 5 Mbps.

    Assert client upswitches to 1080p within threshold.
    """
    page = browser_page

    # Phase 1: Low bandwidth — settle on 360p
    shape_link2(net, bw_mbps=0.6)
    await collector.collect_for(page, duration_s=20)

    # Verify client is at 360p before restoring
    assert_downswitch_within(
        collector,
        change_time=collector.samples[0].timestamp,
        max_latency_s=20,
        expected_quality="360p",
    )

    # Phase 2: Restore to 5 Mbps
    restore_time = time.time()
    shape_link2(net, bw_mbps=5.0)
    await collector.collect_for(page, duration_s=30)

    # Assert upswitch to 1080p within 30s
    assert_upswitch_within(
        collector,
        change_time=restore_time,
        max_latency_s=30,
        expected_quality="1080p",
    )

    # Assert quality floor throughout
    test_end = time.time()
    assert_quality_floor(collector, collector.samples[0].timestamp, test_end, thresholds["quality_floor"])

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
