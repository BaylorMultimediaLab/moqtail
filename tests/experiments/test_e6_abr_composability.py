"""E6: ABR rule composability across bandwidth profiles.

8 configs x 3 profiles x 5 runs = 120 cells. Each cell:
- Filtered client at filterDelay=10, switchMode=aligned (both fixed)
- ABR config from ABR_CONFIGS injected via window.__abrSettingsOverride
- Bandwidth profile (stable / step / sinusoidal) driven via tc/netem

Aligned-mode invariant: n_discontinuities must equal 0 across all cells.
Failures of that assertion indicate a switching bug, not a bad ABR config.
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
    abr_url_overrides and abr_settings_override markers."""
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
                            clientMode="filtered",
                            filterDelay="10",
                            switchMode="aligned",
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
async def test_e6_abr_composability(
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
        "experiment": "e6",
        "cell_id": cell_id,
        "run_index": run_index,
        "abr_config_name": config_name,
        "bandwidth_profile_name": profile_name,
        "filter_delay_s": 10,
    }
    (results_dir / "cell_params.json").write_text(json.dumps(cell_params))

    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log_path,
        switch_records=results_dir / "switch_records.json",
        cell_params={**cell_params, "success": True},
    )
    write_run_summary(summary, results_dir / "summary.json")

    # Aligned-mode invariant: zero discontinuities (>50ms PTS gaps).
    assert summary["n_discontinuities"] == 0, (
        f"aligned mode should produce zero discontinuities; got "
        f"{summary['n_discontinuities']} (max_pts_gap_ms={summary['max_pts_gap_ms']})"
    )
    assert summary["current_time_at_end_s"] >= 55, (
        f"playback didn't advance: end={summary['current_time_at_end_s']}"
    )
