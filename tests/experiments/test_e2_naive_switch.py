"""E2: naive switch on a behind-live (filtered) client produces non-zero ptsGapMs.

20 parametric cells: 4 offsets x 5 runs. Each run launches a filtered client
at the offset, hits the network with a step bandwidth drop at t=30s and
recovery at t=45s (relative to collection start), records all switch events,
and asserts the maximum |ptsGapMs| across switches is > 100 ms — the failure
mode this experiment documents.

Per-run output lands at:
  tests/experiments/results/test_e2_naive_switch[offset{N}-run{M}]/<timestamp>/
    metrics.csv, relay.log, switch_records.json, cell_params.json, summary.json
"""

import asyncio
import json

import pytest

from profiles import apply_step
from summary import build_run_summary, write_run_summary


_OFFSETS = [5, 10, 20, 30]
_RUNS_PER_CELL = 5


def _offset_params():
    return [
        pytest.param(
            offset,
            marks=pytest.mark.abr_url_overrides(
                clientMode="filtered",
                filterDelay=str(offset),
                switchMode="naive",
            ),
        )
        for offset in _OFFSETS
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", _offset_params(), ids=[f"offset{o}" for o in _OFFSETS])
@pytest.mark.parametrize("run_index", range(_RUNS_PER_CELL), ids=[f"run{i}" for i in range(_RUNS_PER_CELL)])
async def test_e2_naive_switch(
    offset, run_index,
    net, relay_proc, publisher_proc, browser_page, collector, results_dir,
):
    cell_id = f"naive_offset{offset}"
    page = browser_page
    _, relay_log_path = relay_proc

    # Wait for buffer >= 2.0s before starting the bandwidth profile (max 10s warmup).
    deadline = asyncio.get_event_loop().time() + 10
    while asyncio.get_event_loop().time() < deadline:
        buf = await page.evaluate(
            "() => window.__moqtailMetrics?.abr?.bufferSeconds ?? 0"
        )
        if (buf or 0) >= 2.0:
            break
        await asyncio.sleep(0.25)

    # Step profile: 3 Mbps -> 500 kbps @ 30s -> 3 Mbps @ 45s, relative to collection start.
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
        "experiment": "e2",
        "cell_id": cell_id,
        "run_index": run_index,
        "filter_delay_s": offset,
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
    # Naive failure mode: at least one switch produces > 100 ms forward jump.
    assert summary["max_pts_gap_ms"] > 100, (
        f"expected non-zero ptsGapMs (naive switch on filtered client), "
        f"got max_pts_gap_ms={summary['max_pts_gap_ms']}"
    )
