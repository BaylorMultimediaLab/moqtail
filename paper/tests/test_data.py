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


def test_compute_avg_delivered_bitrate_kbps_returns_positive_for_real_run():
    from _data import compute_avg_delivered_bitrate_kbps, find_median_run_dir
    # Use a known run from E6 (or fall back to E3 which definitely has data).
    run_dir = find_median_run_dir(
        experiment="e3", cell_id="aligned_offset20", metric="max_playhead_gap_ms"
    )
    bitrate = compute_avg_delivered_bitrate_kbps(run_dir)
    # Bitrates are in [400, 5000] kbps for the 720p ladder; time-weighted
    # average must land somewhere in that closed range.
    assert 400 <= bitrate <= 5000, f"bitrate {bitrate} outside ladder range"


def test_compute_avg_delivered_bitrate_kbps_handles_unknown_track_format():
    """If active_track is missing or doesn't match the pattern, NaN rows are
    excluded from the time-weighted mean (not propagated as NaN)."""
    from _data import compute_avg_delivered_bitrate_kbps
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        # Synthetic metrics.csv: 3 rows, last row has unknown track.
        csv_text = (
            "timestamp,active_track,bandwidth_bps,current_time\n"
            "0.0,video-720p-1200k,0,0.0\n"
            "1.0,video-720p-2500k,0,1.0\n"
            "2.0,unknown,0,2.0\n"
        )
        (tmp_dir / "metrics.csv").write_text(csv_text)
        bitrate = compute_avg_delivered_bitrate_kbps(tmp_dir)
        # Time-weighted across the 2 valid rows: 1s @ 1200 + 1s @ 2500 = 1850 kbps
        # (the unknown row's dt=1s is dropped because its bitrate is NaN).
        assert 1800 <= bitrate <= 1900, f"expected ~1850, got {bitrate}"


def test_e6_avg_bitrate_matrix_returns_8x3_with_real_values():
    from _data import E6_COL_ORDER, E6_ROW_ORDER, e6_avg_bitrate_matrix
    matrix = e6_avg_bitrate_matrix()
    assert matrix.shape == (8, 3)
    assert list(matrix.index) == E6_ROW_ORDER
    assert list(matrix.columns) == E6_COL_ORDER
    # At least some cells must have non-NaN bitrates from completed runs.
    assert matrix.notna().any(axis=None)
