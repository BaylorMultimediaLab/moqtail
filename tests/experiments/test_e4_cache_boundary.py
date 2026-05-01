"""E4: cache-availability boundary for the aligned primitive.

5 delays x 5 runs = 25 parametric cells. Each cell:
- Filtered client at filterDelay seconds behind live
- Aligned switching primitive
- Relay --cache-size 20 (so delays > 20 hit the cache-miss path)
- Forces an upswitch from the lowest variant to the highest at t=30s
- Parses the relay log for the resolved decision

Expected boundary: delay <= 20 lands Ready; delay > 20 lands ClampedToOldest.
The aligned switch should produce a near-zero PTS gap in the Ready case;
the ClampedToOldest case is the operating-boundary observation we measure.

Note on videoAutoSwitch:
Path B was taken. Investigation of apps/client-js/src/app.tsx (lines 266-286)
shows that the URL-readable ABR settings are limited to numeric fields
(bufferTimeDefault, stableBufferTime, bandwidthSafetyFactor, initialBitrate,
minBitrate, maxBitrate). The boolean videoAutoSwitch is NOT URL-readable.
Therefore Path A (adding videoAutoSwitch="false" to abr_url_overrides) would
have no effect. Under Path B, ABR may have already switched to the highest
variant (video-720p-5000k) by t=30s given 10 Mbps headroom. The force_switch
target is still video-720p-5000k; when from==to the player re-subscribes but
the relay decision (Ready vs ClampedToOldest) still reflects the delay boundary.
The PTS-gap assertion still holds for the Ready path.
"""

import asyncio
import json

import pytest

from profiles import apply_stable
from summary import build_run_summary, write_run_summary
from trace_helpers import force_switch, parse_relay_decisions


_DELAYS = [5, 10, 20, 30, 40]
_RUNS_PER_CELL = 5
_CACHE_SIZE = 20
_TARGET_TRACK = "video-720p-5000k"


def _delay_params():
    # Path B: videoAutoSwitch is not URL-readable, so we do not add it.
    return [
        pytest.param(
            delay,
            marks=pytest.mark.abr_url_overrides(
                clientMode="filtered",
                filterDelay=str(delay),
                switchMode="aligned",
            ),
        )
        for delay in _DELAYS
    ]


@pytest.mark.asyncio
@pytest.mark.relay_cache_size(_CACHE_SIZE)
@pytest.mark.parametrize("delay", _delay_params(), ids=[f"delay{d}" for d in _DELAYS])
@pytest.mark.parametrize("run_index", range(_RUNS_PER_CELL), ids=[f"run{i}" for i in range(_RUNS_PER_CELL)])
async def test_e4_cache_boundary(
    delay, run_index,
    net, relay_proc, publisher_proc, browser_page, collector, results_dir,
):
    cell_id = f"cache{_CACHE_SIZE}_delay{delay}"
    page = browser_page
    _, relay_log_path = relay_proc

    profile_task = asyncio.create_task(apply_stable(net, bw_mbps=10.0))
    collect_task = asyncio.create_task(collector.collect_for(page, duration_s=60))

    try:
        # Force the upswitch at t=30s into the collection window.
        await asyncio.sleep(30)
        await force_switch(page, _TARGET_TRACK)
        await collect_task
    finally:
        profile_task.cancel()
        try:
            await profile_task
        except (asyncio.CancelledError, Exception):
            pass

    switch_records = await page.evaluate(
        "() => window.__moqtailMetrics?.switchDiscontinuities ?? []"
    )
    metrics_csv = results_dir / "metrics.csv"
    collector.save_csv(metrics_csv)
    (results_dir / "switch_records.json").write_text(json.dumps(switch_records))

    relay_log = relay_log_path.read_text()
    decisions = parse_relay_decisions(relay_log)
    # The most recent decision corresponds to the force_switch resubscribe.
    decision = decisions[-1] if decisions else {"classification": "Unknown"}

    cell_params = {
        "experiment": "e4",
        "cell_id": cell_id,
        "run_index": run_index,
        "filter_delay_s": delay,
        "relay_cache_size": _CACHE_SIZE,
    }
    (results_dir / "cell_params.json").write_text(json.dumps(cell_params))

    expected_ready = delay <= _CACHE_SIZE
    relay_decision = decision.get("classification", "Unknown")
    pts_gaps = [
        abs(r.get("ptsGapMs", 0))
        for r in switch_records
        if r.get("eventType") == "switch"
    ]
    pts_gap = max(pts_gaps) if pts_gaps else 0.0

    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log_path,
        switch_records=results_dir / "switch_records.json",
        cell_params={**cell_params, "success": True},
        extra={
            "relay_decision": relay_decision,
            "relay_clamp_target_group": (
                decision.get("start_location_group") if relay_decision == "ClampedToOldest" else None
            ),
            "force_switch_pts_gap_ms": pts_gap,
        },
    )
    write_run_summary(summary, results_dir / "summary.json")

    if expected_ready:
        assert relay_decision == "Ready", (
            f"delay={delay} <= cache_size={_CACHE_SIZE} should land Ready, "
            f"got {relay_decision}"
        )
        assert pts_gap <= 50, (
            f"Ready path should produce near-zero ptsGapMs, got {pts_gap}"
        )
    else:
        assert relay_decision == "ClampedToOldest", (
            f"delay={delay} > cache_size={_CACHE_SIZE} should land "
            f"ClampedToOldest, got {relay_decision}"
        )
