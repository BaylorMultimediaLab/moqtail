"""Slice A E2E smoke: filtered client connects, plays, receives data."""

import time

import pytest


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="filtered", filterDelay="2")
async def test_filtered_connect_receives_data(
    net, relay_proc, publisher_proc, browser_page, collector, results_dir
):
    """A filtered client (delay=2s) connects after publisher warm-up,
    plays without error, and receives at least one media object.

    This is a smoke test: it does NOT assert the precise behind-live offset
    (that comes in Phase C with the connect-time discontinuity metric).
    What it verifies is that the wire-level integration of DELAY_GROUPS
    end-to-end (client encode -> relay parse -> resolve start_location ->
    deliver objects -> client receive) works without errors.
    """
    page = browser_page

    # Let the publisher run for >2 seconds so largest > delay_groups.
    # browser_page already clicked Connect during fixture setup; we just
    # let data flow.
    await collector.collect_for(page, duration_s=8)

    # Verify the client received at least one media object.
    first_group = await page.evaluate(
        "() => window.__moqtailMetrics?.firstReceivedGroupId"
    )
    assert first_group is not None, (
        "filtered client never received a media object — relay may have rejected "
        "DELAY_GROUPS, may be holding indefinitely, or the integration is broken"
    )
    assert first_group >= 0, f"unexpected first group id: {first_group}"

    # Verify ABR pipeline came up (sanity check: SubscribeOk arrived, stream
    # is flowing). __moqtailMetrics.abr is populated once the pipeline starts.
    abr_active = await page.evaluate(
        "() => window.__moqtailMetrics?.abr != null"
    )
    assert abr_active, "ABR pipeline never came up after filtered connect"

    # Verify no SubscribeError was thrown (catalog-level error would surface
    # as a connection failure visible in browser logs; a per-track error
    # would prevent first_group from being set, which we already checked).

    print(f"[test_filtered_connect] firstReceivedGroupId={first_group} "
          f"(filtered, delay=2s, after 8s warmup)", flush=True)
