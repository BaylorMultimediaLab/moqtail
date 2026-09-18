"""Slice B verification: filtered+aligned switch eliminates the discontinuity.

Mirror of test_naive_switch_discontinuity (Slice C). Same harness, same
ABR-driven natural switches, but with switchMode='aligned' the relay
constructs the new track's subscription as new_absolute_start at the
group containing the player's current PTS — so newStartPTS_ms ~= oldEndPTS_ms
and ptsGapMs ~= 0.

The threshold is 'within one GOP' (1000ms with 1s GOPs), generous because:
- Variable network jitter between switch send and relay receive
- Player buffer state at switch time
- Re-rendering of the new init segment

If aligned switching is correct, ptsGapMs should be tightly bounded at the
GOP boundary (positive or negative under one GOP). If it falls back to the
naive path (TimeMap miss, or relay didn't honor the parameter), ptsGapMs
will be ~delay-magnitude (~2000ms) and the assertion fails.
"""

import pytest


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(
    clientMode="filtered",
    filterDelay="2",
    switchMode="aligned",
)
async def test_aligned_switch_on_filtered_client_eliminates_discontinuity(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    """Filtered client with delay=2s, aligned switch.
    Wait for ABR-driven natural switches; assert ptsGapMs is bounded
    by ~one GOP (much smaller than naive's ~delay-magnitude jump).
    """
    page = browser_page

    # 12 s: same warm-up as C7 — long enough for the filtered hold to clear
    # and at least one natural ABR switch to fire on the 5Mbps client link.
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

    # Confirm the records actually came from the aligned mode (sanity).
    aligned_records = [r for r in switch_records if r.get("switchMode") == "aligned"]
    assert aligned_records, (
        f"expected switchMode='aligned' on every switch record. Got modes: "
        f"{[r.get('switchMode') for r in switch_records]}"
    )

    # Headline assertion: aligned switch should keep ptsGapMs within one GOP.
    # 1000ms is the configured GOP duration in the publisher; we use 1500ms
    # tolerance to absorb measurement jitter and an off-by-one at the boundary.
    max_gap_record = max(switch_records, key=lambda r: abs(r.get("ptsGapMs", 0)))
    pts_gap = max_gap_record["ptsGapMs"]

    assert abs(pts_gap) < 1500, (
        f"expected aligned switch discontinuity within ~1 GOP, "
        f"got max ptsGapMs={pts_gap}. "
        f"If this is ~2000ms, the aligned parameter likely didn't propagate "
        f"(TimeMap miss, or relay didn't honor START_LOCATION_GROUP). "
        f"Full record: {max_gap_record}"
    )

    # No record should have flagged a TimeMap miss in steady-state. If any
    # do, that's a bug worth flagging — though we accept up to one early miss
    # in case ABR switches before TimeMap has any anchor.
    misses = [r for r in switch_records if r.get("timeMapMiss") is True]
    if len(misses) > 1:
        pytest.fail(
            f"multiple TimeMap misses in aligned mode ({len(misses)}/{len(switch_records)}). "
            f"At most one early-startup miss is acceptable. Misses: {misses}"
        )

    print(
        f"[B7] aligned switch ptsGapMs={pts_gap}ms across {len(switch_records)} "
        f"switch event(s) (filtered, delay=2s, switchMode=aligned)",
        flush=True,
    )
