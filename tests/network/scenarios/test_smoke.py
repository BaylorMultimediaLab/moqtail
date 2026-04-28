"""Smoke test: the full stack starts and the client decodes video.

No ABR assertions — just verifies relay + publisher + client end-to-end:
catalog reaches the client, MSE accepts the publisher's HEVC, and the
decoder advances frames. If this fails the rest of the suite can't pass.
"""

import pytest


@pytest.mark.asyncio
async def test_smoke(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    page = browser_page

    # Sample for ~10 s; Connect already happened in the fixture.
    await collector.collect_for(page, duration_s=10)

    collector.save_csv(results_dir / "metrics.csv")
    collector.save_switches_json(results_dir / "switches.json")

    assert collector.samples, "No metrics samples collected"

    first, last = collector.samples[0], collector.samples[-1]

    # Frames must advance — otherwise the GPU decoder stalled (the
    # PIPELINE_ERROR_DISCONNECTED symptom that froze earlier runs).
    assert last.total_frames > first.total_frames, (
        f"Decoder stalled: total_frames {first.total_frames} → {last.total_frames}. "
        f"See {results_dir / 'browser_console.log'} for video.error details."
    )

    # Some real video data must have made it through, not just an init segment.
    assert last.total_frames >= 30, (
        f"Only {last.total_frames} frames decoded in 10s — playback never sustained."
    )

    assert last.active_track, "Client never picked a video track"
