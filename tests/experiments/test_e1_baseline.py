"""E1: baseline single-run end-to-end smoke for the paper.

Validates the experiment harness end-to-end: 5-rung 720p ladder via
publisher --ladder-spec, stable 10 Mbps link, unfiltered client at the
live edge. Captures the catalog snapshot to confirm the published
ladder matches the paper's claimed bitrates.

Catalog access note: the client exposes tracks as a flat array under
``window.__moqtailMetrics.catalogTracks`` (added in the same commit).
Each element is a ``CMSFTrack`` object with ``role``, ``bitrate``,
``name``, etc.
"""

import asyncio
import json

import pytest

from profiles import apply_stable
from summary import build_run_summary, write_run_summary


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="unfiltered", switchMode="aligned")
async def test_e1_baseline(net, relay_proc, publisher_proc, browser_page, collector, results_dir):
    page = browser_page
    _, relay_log_path = relay_proc

    # Stable 10 Mbps for the entire window.
    profile_task = asyncio.create_task(apply_stable(net, bw_mbps=10.0))
    try:
        await collector.collect_for(page, duration_s=60)
    finally:
        profile_task.cancel()
        try:
            await profile_task
        except (asyncio.CancelledError, Exception):
            pass

    # Capture catalog tracks + switch records.
    # window.__moqtailMetrics.catalogTracks is set by app.tsx after player.initialize().
    catalog_tracks = await page.evaluate(
        "() => window.__moqtailMetrics?.catalogTracks ?? null"
    )
    switch_records = await page.evaluate(
        "() => window.__moqtailMetrics?.switchDiscontinuities ?? []"
    )

    metrics_csv = results_dir / "metrics.csv"
    collector.save_csv(metrics_csv)
    (results_dir / "switch_records.json").write_text(json.dumps(switch_records))
    cell_params = {
        "experiment": "e1",
        "cell_id": "baseline",
        "run_index": 0,
    }
    (results_dir / "cell_params.json").write_text(json.dumps(cell_params))

    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log_path,
        switch_records=results_dir / "switch_records.json",
        cell_params={**cell_params, "success": True},
        extra={"catalog_tracks": catalog_tracks},
    )
    write_run_summary(summary, results_dir / "summary.json")

    assert catalog_tracks is not None, "Catalog snapshot missing (window.__moqtailMetrics.catalogTracks)"
    video_tracks = [t for t in catalog_tracks if t.get("role") == "video"]
    assert len(video_tracks) == 5, f"expected 5 video tracks, got {len(video_tracks)}"
    bitrates = sorted(t.get("bitrate", 0) for t in video_tracks)
    expected = [400_000, 800_000, 1_200_000, 2_500_000, 5_000_000]
    assert bitrates == expected, f"ladder bitrate mismatch: got {bitrates}, expected {expected}"
    assert summary["current_time_at_end_s"] >= 55, (
        f"playback didn't advance to end of clip: end={summary['current_time_at_end_s']}"
    )
