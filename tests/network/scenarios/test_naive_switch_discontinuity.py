"""Slice C verification: naive SWITCH is seam-gap-free under SWITCH PR #1378 conformance.

HISTORY: this scenario originally demonstrated the paper's failure case — a
behind-live (filtered) client using the relay's 0-sentinel "naive" SWITCH
jumped to the live edge, producing a large forward ptsGapMs. The 0-sentinel
was removed for SWITCH PR #1378 conformance: Minimum Switching Group ID = 0 is an
ordinary floor (oldest common boundary), and naive mode now expresses
"as close to live as possible" by flooring at the client's latest received
group. The relay re-delivers from that group (buffer replacement) plus a
catch-up range, so the seam is gap-free and ptsGapMs lands near 0 even on a
filtered client.

This test therefore now asserts the CONFORMANT behavior: a filtered client's
natural ABR switch produces a bounded buffer-end gap. Reproducing the paper's
historical discontinuity baseline requires a pre-conformance build (any commit
before the 0-sentinel removal).

The harness's 5Mbps client link causes ABR to downswitch from a higher
default to 360p shortly after connect; that natural switch is enough
to exercise the metric without any forced-switch mechanism.

The sibling test_aligned_switch.py continues to assert playheadGapMs ≈ 0
for aligned mode.
"""

import pytest

# One group is 1s of media in the harness ladder; a gap-free seam that
# re-delivers the in-progress group should keep the buffer-end gap well
# under a group duration. Generous 2x margin for timing jitter.
MAX_SEAM_GAP_MS = 2000


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="filtered", filterDelay="2")
async def test_naive_switch_on_filtered_client_is_gap_free(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    """Filtered client with delay=2s, naive switch (conformant floor-at-latest).
    Wait for ABR-driven natural switches; expect a bounded, near-zero ptsGapMs
    instead of the historical live-edge jump."""
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

    # Find the largest |ptsGapMs| across switches. With the conformant
    # floor-at-latest naive mode the new track re-delivers from the client's
    # latest received group, so no switch should exhibit the historical
    # ~filterDelay (2000ms+) forward jump to the live edge.
    max_gap = max(switch_records, key=lambda r: abs(r.get("ptsGapMs", 0)))
    pts_gap = max_gap["ptsGapMs"]

    assert abs(pts_gap) <= MAX_SEAM_GAP_MS, (
        f"expected gap-free naive switch (floor at latest received group, "
        f"SWITCH PR #1378 conformant), got max ptsGapMs={pts_gap} — this is the "
        f"pre-conformance live-edge-jump signature. All switch records: "
        f"{switch_records}"
    )

    print(
        f"[C7] conformant naive switch max ptsGapMs={pts_gap}ms across "
        f"{len(switch_records)} switch event(s) (filtered, delay=2s)",
        flush=True,
    )
