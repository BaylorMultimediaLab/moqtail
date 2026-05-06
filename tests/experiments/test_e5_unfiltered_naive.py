"""E5: ABR composability under unfiltered + naive switching.

Exact mirror of E6's parameter sweep (8 ABR configs × 3 bandwidth
profiles × 5 runs) but with clientMode=unfiltered and switchMode=naive
instead of E6's filtered+aligned. Together with E2/E6, characterises
how naive switching's playhead gap scales with the client's offset
behind live edge.

Physics: playheadGapMs ≈ (filterDelay + buffer_occupancy_at_switch) × 1000
because naive delivery places the new track at the buffer-end (≈ live
edge) while the playhead trails by the player's buffer plus any
filterDelay. With clientMode=unfiltered there is no filterDelay, so
the gap collapses to roughly the buffer occupancy (≈ 2–3 s with the
default stableBufferTime).

The assertion bound is 5000 ms — generous enough to absorb the
default buffer plus normal jitter, but tight enough to fail loudly
if a regression accidentally re-introduces filterDelay or breaks the
unfiltered subscription path. Compare against E2 where the same
naive switch produces 7–35 s gaps once filterDelay is added.

Per-run output lands at:
  tests/experiments/results/test_e5_unfiltered_naive[runN-{cell_id}]/<timestamp>/
"""

import asyncio
import json

import pytest

from abr_configs import ABR_CONFIGS
from profiles import apply_stable, apply_step, apply_sinusoidal
from summary import build_run_summary, write_run_summary


_RUNS_PER_CELL = 5


def _make_profile_task(net, profile_name: str):
    if profile_name == "stable1.5M":
        return asyncio.create_task(apply_stable(net, 1.5))
    if profile_name == "step3M_500k":
        return asyncio.create_task(apply_step(net, 3.0, 0.5, 30, 50))
    if profile_name == "sin600k_3M":
        return asyncio.create_task(
            apply_sinusoidal(net, 0.6, 3.0, period_s=60, duration_s=60)
        )
    raise ValueError(f"unknown profile: {profile_name}")


def _cell_params():
    """Build pytest.param entries stamping each cell with its
    abr_url_overrides and abr_settings_override markers.

    Same shape as E6's _cell_params() but with clientMode=unfiltered,
    switchMode=naive, no filterDelay.
    """
    params = []
    for config_name, settings in ABR_CONFIGS.items():
        for profile_name in ("stable1.5M", "step3M_500k", "sin600k_3M"):
            cell_id = f"{config_name}_{profile_name}"
            params.append(
                pytest.param(
                    config_name,
                    profile_name,
                    marks=[
                        pytest.mark.abr_url_overrides(
                            clientMode="unfiltered",
                            switchMode="naive",
                        ),
                        pytest.mark.abr_settings_override(settings),
                    ],
                    id=cell_id,
                )
            )
    return params


@pytest.mark.asyncio
@pytest.mark.parametrize("config_name,profile_name", _cell_params())
@pytest.mark.parametrize(
    "run_index", range(_RUNS_PER_CELL), ids=[f"run{i}" for i in range(_RUNS_PER_CELL)]
)
async def test_e5_unfiltered_naive(
    config_name, profile_name, run_index,
    net, relay_proc, publisher_proc, browser_page, collector, results_dir,
):
    cell_id = f"{config_name}_{profile_name}"
    page = browser_page
    _, relay_log_path = relay_proc

    profile_task = _make_profile_task(net, profile_name)
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
    (results_dir / "abr_settings.json").write_text(
        json.dumps(ABR_CONFIGS[config_name], indent=2)
    )
    cell_params = {
        "experiment": "e5",
        "cell_id": cell_id,
        "run_index": run_index,
        "abr_config_name": config_name,
        "bandwidth_profile_name": profile_name,
    }
    (results_dir / "cell_params.json").write_text(json.dumps(cell_params))

    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log_path,
        switch_records=results_dir / "switch_records.json",
        cell_params={**cell_params, "success": True},
    )
    write_run_summary(summary, results_dir / "summary.json")

    # Unfiltered + naive: playhead trails buffer-end (≈ live edge) by
    # the player's startup buffer (~2–3 s with default stableBufferTime),
    # so playheadGap ≈ buffer_occupancy × 1000 — typically 2000–4000 ms.
    # The 5000 ms bound is generous enough to absorb buffer + jitter
    # but tight enough to flag a regression. Compare to E2 where the
    # same naive switch produces 7000–35000 ms gaps with filterDelay added.
    assert summary["max_playhead_gap_ms"] <= 5000, (
        f"expected playheadGapMs ≈ buffer occupancy (~2-3 s) for "
        f"unfiltered + naive, got max_playhead_gap_ms={summary['max_playhead_gap_ms']} "
        f"(diag max_pts_gap_ms={summary['max_pts_gap_ms']})"
    )
    # Sanity: a switch must have fired so the assertion above is meaningful.
    assert summary["n_switches"] > 0, (
        f"no switches fired; assertion trivially passed "
        f"(playback ended at {summary['current_time_at_end_s']}s)"
    )
