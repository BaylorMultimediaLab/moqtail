"""Scenario 2: Sudden bandwidth drop on relay-client link."""

import time

import pytest

from assertions import assert_downswitch_within, assert_quality_floor
from shaper import shape_link2


@pytest.mark.asyncio
async def test_sudden_drop(
    net, relay_proc, publisher_proc, browser_page, collector, thresholds, results_dir
):
    """Drop link2 from 5 Mbps to 0.6 Mbps instantly.

    Assert client reaches 360p within downswitch threshold.
    Rebuffering is tolerated for sudden drops but must recover.
    """
    page = browser_page

    # Phase 1: Stable at 5 Mbps for 20s
    shape_link2(net, bw_mbps=5.0)
    await collector.collect_for(page, duration_s=20)

    # Phase 2: Sudden drop to 0.6 Mbps
    drop_time = time.time()
    shape_link2(net, bw_mbps=0.6)
    await collector.collect_for(page, duration_s=30)

    # Assert client switched down to 360p
    assert_downswitch_within(
        collector,
        change_time=drop_time,
        max_latency_s=thresholds["downswitch_latency_s"],
        expected_quality="360p",
    )

    # Assert quality floor maintained
    test_end = time.time()
    assert_quality_floor(collector, drop_time, test_end, thresholds["quality_floor"])

    # Check that if rebuffering happened, playback recovered
    # (buffer should be > 0 by end of the 30s hold period)
    recovery_deadline = drop_time + thresholds["rebuffer_recovery_s"]
    late_samples = [
        s for s in collector.samples
        if s.timestamp >= recovery_deadline
    ]
    if late_samples:
        assert late_samples[-1].buffer_seconds > 0, (
            f"Client did not recover from rebuffering within {thresholds['rebuffer_recovery_s']}s. "
            f"Buffer at end: {late_samples[-1].buffer_seconds:.3f}s"
        )

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")
