"""E5: naive switch on an UNFILTERED client produces ~zero playhead gap.

Control experiment for E2 (filtered + naive). Demonstrates that the
naive switch failure mode quantified in E2 is OFFSET-INDUCED: when
the client is at the live edge (unfiltered), naive switching still
works because newStartPTS ≈ playheadPTS by construction.

5 runs at the same bandwidth profile as E2/E3 (step 3M->500k->3M)
so the drop forces a downswitch. With clientMode=unfiltered,
playheadGapMs should be near zero (we use the aligned envelope's
50 ms tolerance as the assertion threshold).

Per-run output lands at:
  tests/experiments/results/test_e5_unfiltered_naive[runN]/<timestamp>/
"""

import asyncio
import json

import pytest

from profiles import apply_step
from summary import build_run_summary, write_run_summary


_RUNS_PER_CELL = 5


@pytest.mark.asyncio
@pytest.mark.abr_url_overrides(clientMode="unfiltered", switchMode="naive")
@pytest.mark.parametrize(
    "run_index", range(_RUNS_PER_CELL), ids=[f"run{i}" for i in range(_RUNS_PER_CELL)]
)
async def test_e5_unfiltered_naive(
    run_index,
    net, relay_proc, publisher_proc, browser_page, collector, results_dir,
):
    cell_id = "unfiltered_naive"
    page = browser_page
    _, relay_log_path = relay_proc

    # Wait for stable buffer >= 2.0s before starting the bandwidth profile.
    deadline = asyncio.get_event_loop().time() + 10
    while asyncio.get_event_loop().time() < deadline:
        buf = await page.evaluate(
            "() => window.__moqtailMetrics?.abr?.bufferSeconds ?? 0"
        )
        if (buf or 0) >= 2.0:
            break
        await asyncio.sleep(0.25)

    # Same step profile as E2/E3 so the bandwidth drop forces a downswitch.
    profile_task = asyncio.create_task(
        apply_step(net, initial_mbps=3.0, drop_mbps=0.5, drop_at_s=30, recover_at_s=45)
    )
    try:
        await collector.collect_for(page, duration_s=60)
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
    cell_params = {
        "experiment": "e5",
        "cell_id": cell_id,
        "run_index": run_index,
    }
    (results_dir / "cell_params.json").write_text(json.dumps(cell_params))

    switches = [r for r in switch_records if r.get("eventType") == "switch"]
    success = len(switches) >= 1

    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log_path,
        switch_records=results_dir / "switch_records.json",
        cell_params={
            **cell_params,
            "success": success,
            "skip_reason": None if success else "no switch fired",
        },
    )
    write_run_summary(summary, results_dir / "summary.json")

    if not success:
        pytest.skip(
            f"No switch fired in run; environment too stable. "
            f"{len(switch_records)} total records."
        )
    # Unfiltered + naive: playhead sits at the live edge, naive delivers
    # from the live edge -> newStartPTS ≈ playheadPTS, so the gap is ~0.
    # 50 ms tolerance matches the original aligned-mode threshold.
    assert summary["max_playhead_gap_ms"] <= 50, (
        f"expected near-zero playheadGapMs (unfiltered + naive), "
        f"got max_playhead_gap_ms={summary['max_playhead_gap_ms']}"
    )
