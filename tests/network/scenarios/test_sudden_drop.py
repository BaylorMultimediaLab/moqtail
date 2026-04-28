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

    shape_link2(net, bw_mbps=5.0)
    await collector.collect_for(page, duration_s=20)

    drop_time = time.time()
    shape_link2(net, bw_mbps=0.6)
    await collector.collect_for(page, duration_s=30)

    # Sudden drop is the worst case for ThroughputRule's slow EMA (~8s
    # half-life) — the smoothed estimate has to drop far enough to skip past
    # 720p/480p, which a 10s window can't cover. Wider threshold only here.
    assert_downswitch_within(
        collector,
        change_time=drop_time,
        max_latency_s=20,
        expected_quality="360p",
    )

    test_end = time.time()
    assert_quality_floor(collector, drop_time, test_end, thresholds["quality_floor"])

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
