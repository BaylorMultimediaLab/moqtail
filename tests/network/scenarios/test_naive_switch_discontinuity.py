"""Slice C verification: filtered+naive switch produces non-zero discontinuity.

This test demonstrates the failure case the paper documents:
A behind-live (filtered) client that uses naive SWITCH semantics
will receive frames whose PTS jumps forward to the live edge,
creating a non-zero ptsGapMs in the discontinuity record.

Aligned switch (Phase B) eliminates this gap; that's verified by
test_aligned_switch_discontinuity (Phase B's E2E).
"""

import pytest


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="filtered", filterDelay="2")
async def test_naive_switch_on_filtered_client_records_discontinuity(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    """Filtered client with delay=2s, naive switch (today's behavior).
    Force a quality change. Expect at least one 'switch' record with
    a non-zero ptsGapMs.
    """
    page = browser_page

    # Let the publisher produce >2s of data so the filtered subscribe is well past the
    # hold threshold and steady-state delivery is happening.
    await collector.collect_for(page, duration_s=5)

    # Discover an alternate video track to switch to. Catalog is loaded by now;
    # AbrController exposes the sorted track list as __moqtailMetrics.abr.tracks.
    tracks_raw = await page.evaluate(
        "() => window.__moqtailMetrics?.abr?.tracks ?? null"
    )
    tracks = (
        [t.get("name") for t in tracks_raw if isinstance(t, dict) and t.get("name")]
        if tracks_raw
        else []
    )
    assert tracks, "no video tracks discoverable for the test"

    # Pick an alternate (different from current). The first switch may be from any
    # arbitrary current track to a different one; we just need DIFFERENT.
    current = await page.evaluate(
        "() => window.__moqtailMetrics?.abr?.activeTrack ?? null"
    )
    target = next((t for t in tracks if t != current), None) or tracks[0]

    # Force the switch. The __forceSwitch debug hook returns a Promise; await it.
    await page.evaluate(
        f"async () => {{ if (window.__forceSwitch) await window.__forceSwitch('{target}'); }}"
    )

    # Give the relay time to deliver new-track data and the player time to apply
    # the new init segment + first payload. ~3s is generous for 1s GOPs.
    await collector.collect_for(page, duration_s=4)

    # Read all discontinuity records.
    records = await page.evaluate(
        "() => window.__moqtailMetrics?.switchDiscontinuities ?? []"
    )
    switch_records = [r for r in records if r.get("eventType") == "switch"]

    assert switch_records, (
        f"expected at least one 'switch' record after forcing a switch to {target}; "
        f"got {len(records)} total records, types: "
        f"{[r.get('eventType') for r in records]}"
    )

    pts_gap = switch_records[0]["ptsGapMs"]
    # filtered+naive should produce a forward-jump in PTS proportional to the
    # filter delay (~2000ms target). Wide tolerance because the exact value
    # depends on buffer state at switch time. Just assert it's clearly
    # non-zero in the positive direction.
    assert pts_gap > 100, (
        f"expected positive ptsGapMs (naive switch on filtered client). "
        f"got ptsGapMs={pts_gap}. Full record: {switch_records[0]}"
    )

    print(
        f"[C7] naive switch ptsGapMs={pts_gap}ms "
        f"(filtered, delay=2s, target track={target})",
        flush=True,
    )
