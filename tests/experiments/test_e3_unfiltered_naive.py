"""E3: ABR composability under unfiltered + naive switching.

Exact mirror of E4's parameter sweep (13 ABR configs × 3 bandwidth
profiles × 5 runs = 195 cells) but with clientMode=unfiltered and
switchMode=naive instead of E4's filtered+aligned.

Each config isolates a single rule (or, for `none`, no rule at all)
and pins the join rung to the middle of the ladder (1200k) so
guard-only cells start from a known, comparable position. Some cells
will produce zero switches by design — `none` cannot switch, and a
guard rule that never trips under a given profile leaves the player
at the join rung.

Headline finding (vs aligned): naive switching produces a playhead
gap equal to the buffer occupancy at switch time, regardless of
whether the client has a filterDelay applied. With clientMode=
unfiltered there is no deliberate offset behind live, but the player
still maintains a startup buffer that grows whenever the network
delivers faster than the active variant's bitrate. The first naive
switch on the new track delivers from the buffer-end (≈ live edge)
while the playhead trails by however much the buffer is holding.

The assertion bound is 30 s — chosen to catch catastrophic regressions
(e.g. an accidental filterDelay re-introduction would push the gap
past 30 s) without false-flagging genuine multi-second buffer-tail
observations. Cells with zero switches satisfy the assertion trivially
(gap = 0).

Per-run output lands at:
  tests/experiments/results/test_e3_unfiltered_naive[runN-{cell_id}]/<timestamp>/
"""

import asyncio
import json

import pytest

from abr_configs import ABR_CONFIGS
from profiles import apply_stable, apply_step, apply_sinusoidal
from summary import build_run_summary, write_run_summary


_RUNS_PER_CELL = 5

# t=0 bandwidth for each profile, applied via the initial_bandwidth_mbps
# marker so the shaper is active BEFORE the WebTransport handshake. See
# the matching block in test_e4_abr_composability.py for the rationale.
_PROFILE_INITIAL_BW_MBPS = {
    "stable1.5M": 1.5,
    "step3M_500k": 3.0,
    "sin600k_3M": 1.8,
}


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

    Same shape as E4's _cell_params() but with clientMode=unfiltered,
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
                        pytest.mark.initial_bandwidth_mbps(
                            _PROFILE_INITIAL_BW_MBPS[profile_name]
                        ),
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
async def test_e3_unfiltered_naive(
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
        "experiment": "e3",
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

    # Unfiltered + naive: playheadGap ≈ buffer_occupancy_at_switch × 1000.
    # Buffer can grow to 10+ seconds on bandwidth-dynamic profiles
    # (step, sinusoidal) when the network briefly exceeds the active
    # variant's bitrate. The 30 s bound catches catastrophic regressions
    # (e.g. an accidental filterDelay re-introduction, which would push
    # the gap past 30 s) without false-flagging the genuine multi-second
    # observations this experiment is designed to measure. Cells with
    # zero switches satisfy this trivially (gap = 0), which is legitimate
    # for `none` and for guard-only configs whose trigger never fires.
    assert summary["max_playhead_gap_ms"] <= 30_000, (
        f"playheadGapMs catastrophically large for unfiltered + naive — "
        f"likely a regression in the unfiltered subscribe path or "
        f"accidental filterDelay re-introduction. "
        f"got max_playhead_gap_ms={summary['max_playhead_gap_ms']} "
        f"(diag max_pts_gap_ms={summary['max_pts_gap_ms']})"
    )
