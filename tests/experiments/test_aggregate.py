import json
from pathlib import Path

from aggregate import build_aggregate, build_aggregate_summary


def _write_run(dir_: Path, summary: dict) -> None:
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / "summary.json").write_text(json.dumps(summary))


def test_build_aggregate_collects_all_runs(tmp_path: Path):
    exp_dir = tmp_path / "e2"
    _write_run(exp_dir / "naive_offset5" / "run0_t1", {
        "experiment": "e2", "cell_id": "naive_offset5", "run_index": 0,
        "n_switches": 2, "max_pts_gap_ms": 250.0, "n_discontinuities": 1, "success": True,
    })
    _write_run(exp_dir / "naive_offset5" / "run1_t2", {
        "experiment": "e2", "cell_id": "naive_offset5", "run_index": 1,
        "n_switches": 2, "max_pts_gap_ms": 280.0, "n_discontinuities": 1, "success": True,
    })
    _write_run(exp_dir / "naive_offset10" / "run0_t1", {
        "experiment": "e2", "cell_id": "naive_offset10", "run_index": 0,
        "n_switches": 1, "max_pts_gap_ms": 120.0, "n_discontinuities": 1, "success": True,
    })
    rows = build_aggregate(exp_dir)
    assert len(rows) == 3
    assert {r["cell_id"] for r in rows} == {"naive_offset5", "naive_offset10"}


def test_build_aggregate_summary_groups_by_cell(tmp_path: Path):
    rows = [
        {"cell_id": "naive_offset5", "experiment": "e2", "max_pts_gap_ms": 250.0, "n_switches": 2, "success": True},
        {"cell_id": "naive_offset5", "experiment": "e2", "max_pts_gap_ms": 280.0, "n_switches": 2, "success": True},
        {"cell_id": "naive_offset10", "experiment": "e2", "max_pts_gap_ms": 120.0, "n_switches": 1, "success": True},
    ]
    summary = build_aggregate_summary(rows)
    assert len(summary) == 2
    by_cell = {s["cell_id"]: s for s in summary}
    assert by_cell["naive_offset5"]["n_runs"] == 2
    assert abs(by_cell["naive_offset5"]["max_pts_gap_ms_mean"] - 265.0) < 1e-6
    assert by_cell["naive_offset5"]["success_rate"] == 1.0
