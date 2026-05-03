"""Tests for shared data-loading helpers.

These tests exercise the helpers against the real
tests/experiments/results/ tree — the same data the figures consume —
so a regression in the layout (e.g. someone renames cell_id) breaks the
test before the figures.
"""
from pathlib import Path

import pandas as pd
import pytest

from _data import (
    RESULTS_ROOT,
    e4_decision_counts,
    e6_heatmap_matrix,
    find_median_run_dir,
    load_aggregate,
    load_run_metrics,
)


def test_results_root_resolves_to_experiment_results():
    # The figures load from tests/experiments/results/, two levels up from paper/.
    assert RESULTS_ROOT.exists(), f"experiment results not at {RESULTS_ROOT}"
    assert (RESULTS_ROOT / "e2" / "aggregate.csv").exists()
    assert (RESULTS_ROOT / "e3" / "aggregate.csv").exists()
    assert (RESULTS_ROOT / "e4" / "aggregate.csv").exists()


def test_load_aggregate_returns_dataframe_with_expected_columns():
    df = load_aggregate("e2")
    assert isinstance(df, pd.DataFrame)
    # cell_id and max_playhead_gap_ms are the keys Figs 2 & 5 group by.
    assert "cell_id" in df.columns
    assert "max_playhead_gap_ms" in df.columns
    # E2 has 4 cells * 5 runs = 20 rows.
    assert len(df) == 20


def test_load_aggregate_unknown_experiment_raises():
    with pytest.raises(FileNotFoundError):
        load_aggregate("e99")


def test_find_median_run_dir_returns_existing_directory_for_e3():
    # Fig 3's source: pick the run from cell aligned_offset20 whose
    # max_playhead_gap_ms is closest to the cell's median.
    run_dir = find_median_run_dir(experiment="e3", cell_id="aligned_offset20",
                                  metric="max_playhead_gap_ms")
    assert run_dir.exists()
    assert (run_dir / "metrics.csv").exists()
    assert (run_dir / "switch_records.json").exists()


def test_load_run_metrics_returns_timestamped_dataframe():
    run_dir = find_median_run_dir(experiment="e3", cell_id="aligned_offset20",
                                  metric="max_playhead_gap_ms")
    metrics = load_run_metrics(run_dir)
    assert "timestamp" in metrics.columns
    assert "current_time" in metrics.columns
    assert "bandwidth_bps" in metrics.columns
    # First row's timestamp becomes wall_clock_s = 0.0 by convention.
    assert metrics.iloc[0]["wall_clock_s"] == pytest.approx(0.0, abs=1e-6)
    assert metrics["wall_clock_s"].is_monotonic_increasing


def test_e4_decision_counts_returns_one_row_per_cell():
    counts = e4_decision_counts()
    # 5 delays in E4: 5, 10, 21, 30, 40.
    assert len(counts) == 5
    assert set(counts["cell_id"]) == {
        "cache20_delay5", "cache20_delay10", "cache20_delay21",
        "cache20_delay30", "cache20_delay40",
    }
    # Counts sum to n_runs (5) per cell.
    assert (counts["ready"] + counts["clamped"] == 5).all()


def test_e6_heatmap_matrix_returns_8x3_grid():
    # NOTE: avg_delivered_bitrate_kbps_mean is not yet in e6 summary.json;
    # using n_switches_mean (a real column) until the metric is backfilled.
    matrix = e6_heatmap_matrix(metric="n_switches_mean")
    # 8 ABR configs (rows) x 3 bandwidth profiles (columns).
    assert matrix.shape == (8, 3)
    # Row order is fixed: none -> l2a (matches Fig 5 spec).
    assert list(matrix.index) == [
        "none", "throughput-only", "bola-only", "default",
        "dampened", "aggressive", "lolp", "l2a",
    ]
    assert list(matrix.columns) == ["stable1.5M", "step3M_500k", "sin600k_3M"]
