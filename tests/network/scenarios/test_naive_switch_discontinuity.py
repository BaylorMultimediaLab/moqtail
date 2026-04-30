"""Slice C verification: filtered+naive switch produces non-zero discontinuity.

This test demonstrates the failure case the paper documents:
A behind-live (filtered) client that uses naive SWITCH semantics will
receive frames whose PTS jumps forward to the live edge, creating a
non-zero ptsGapMs in the discontinuity record.

The harness's 5Mbps client link causes ABR to downswitch from a higher
default to 360p shortly after connect; that natural switch is enough
to exercise the metric without any forced-switch mechanism.

Phase B's aligned switch will be verified by a sibling test that
asserts ptsGapMs ≈ 0.
"""

import pytest


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="filtered", filterDelay="2")
async def test_naive_switch_on_filtered_client_records_discontinuity(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    """Filtered client with delay=2s, naive switch (today's behavior).
    Wait for ABR-driven natural switches; expect non-zero ptsGapMs."""
    page = browser_page

    # 12 s is generous for both the 2-s filtered hold to clear AND the ABR
    # rule to fire at least one natural quality switch on the 5Mbps link.
    await collector.collect_for(page, duration_s=12)

    records = await page.evaluate(
        "() => window.__moqtailMetrics?.switchDiscontinuities ?? []"
    )
    switch_records = [r for r in records if r.get("eventType") == "switch"]

    if not switch_records:
        pytest.skip(
            f"No natural ABR switch fired in 12s — environment too stable. "
            f"Total records: {len(records)}, types: "
            f"{[r.get('eventType') for r in records]}"
        )

    # Find the largest |ptsGapMs| across switches. Filtered+naive should produce
    # a non-trivial forward jump on at least one switch.
    max_gap = max(switch_records, key=lambda r: abs(r.get("ptsGapMs", 0)))
    pts_gap = max_gap["ptsGapMs"]

    assert abs(pts_gap) > 100, (
        f"expected non-zero ptsGapMs (naive switch on filtered client), "
        f"got max ptsGapMs={pts_gap}. All switch records: {switch_records}"
    )

    print(
        f"[C7] naive switch ptsGapMs={pts_gap}ms across {len(switch_records)} "
        f"switch event(s) (filtered, delay=2s)",
        flush=True,
    )
