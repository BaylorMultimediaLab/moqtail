"""Shared data-loading helpers for the MMSys paper figures.

Reads from tests/experiments/results/ relative to the paper/ project
root. Each helper returns a pandas DataFrame shaped for a specific
figure (long for boxplots, wide for heat maps).

Source-of-truth for column names is tests/experiments/aggregate.py and
tests/experiments/summary.py — match those exactly.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

# Absolute path to tests/experiments/results/ resolved from this file's
# location. Two parents up from `paper/figures/_data.py` → repo root,
# then descend.
RESULTS_ROOT = (Path(__file__).resolve().parents[2] / "tests" / "experiments" / "results").resolve()

# E6 row/column ordering for Fig 5. Matches the spec literally.
E6_ROW_ORDER = [
    "none", "throughput-only", "bola-only", "default",
    "dampened", "aggressive", "lolp", "l2a",
]
E6_COL_ORDER = ["stable1.5M", "step3M_500k", "sin600k_3M"]


def load_aggregate(experiment: str) -> pd.DataFrame:
    """Load the long-format aggregate CSV for an experiment (one row per run).

    Raises FileNotFoundError if the experiment hasn't been aggregated yet.
    """
    path = RESULTS_ROOT / experiment / "aggregate.csv"
    if not path.exists():
        raise FileNotFoundError(f"aggregate.csv missing for {experiment} at {path}")
    return pd.read_csv(path)


def load_aggregate_summary(experiment: str) -> pd.DataFrame:
    """Load the per-cell summary CSV (mean/std/p95 columns)."""
    path = RESULTS_ROOT / experiment / "aggregate_summary.csv"
    if not path.exists():
        raise FileNotFoundError(f"aggregate_summary.csv missing for {experiment} at {path}")
    return pd.read_csv(path)


def find_median_run_dir(experiment: str, cell_id: str, metric: str) -> Path:
    """Return the per-run results directory whose `metric` is closest to the
    cell's median value. Used by Fig 3 to pick a representative trace.

    Looks under RESULTS_ROOT for any directory whose summary.json carries
    matching {experiment, cell_id} fields. The directory name is
    pytest's parametrized ID, e.g.
    ``test_e3_aligned_switch[run2-offset20]/<timestamp>/``.
    """
    candidates: list[tuple[float, Path]] = []
    for summary_path in sorted(RESULTS_ROOT.rglob("summary.json")):
        try:
            data = json.loads(summary_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("experiment") != experiment or data.get("cell_id") != cell_id:
            continue
        if metric not in data or data[metric] is None:
            continue
        candidates.append((float(data[metric]), summary_path.parent))

    if not candidates:
        raise FileNotFoundError(
            f"No runs found for experiment={experiment}, cell_id={cell_id}"
        )

    metric_values = sorted(v for v, _ in candidates)
    median_value = metric_values[len(metric_values) // 2]
    # Closest run to the median value (ties broken by lexicographic path).
    return min(candidates, key=lambda vp: (abs(vp[0] - median_value), str(vp[1])))[1]


def load_run_metrics(run_dir: Path) -> pd.DataFrame:
    """Read a single run's metrics.csv and add a wall_clock_s column.

    The `timestamp` column is Unix epoch seconds (float). wall_clock_s
    is timestamp − timestamp[0], so plots start at t=0.
    """
    df = pd.read_csv(run_dir / "metrics.csv")
    df["wall_clock_s"] = df["timestamp"] - df["timestamp"].iloc[0]
    return df


def e4_decision_counts() -> pd.DataFrame:
    """Return per-cell counts of Ready vs ClampedToOldest for E4 Fig 4(a).

    Output columns: cell_id, delay_s, ready, clamped, n_runs.
    delay_s is parsed from cell_id ("cache20_delay21" -> 21).
    """
    df = load_aggregate("e4")
    rows = []
    for cell_id, grp in df.groupby("cell_id"):
        delay_s = int(cell_id.split("delay")[-1])
        rows.append({
            "cell_id": cell_id,
            "delay_s": delay_s,
            "ready": int((grp["relay_decision"] == "Ready").sum()),
            "clamped": int((grp["relay_decision"] == "ClampedToOldest").sum()),
            "n_runs": len(grp),
        })
    return pd.DataFrame(rows).sort_values("delay_s").reset_index(drop=True)


def e6_heatmap_matrix(metric: str) -> pd.DataFrame:
    """Reshape the E6 aggregate_summary into an 8x3 heat-map matrix.

    Rows are ABR configs in E6_ROW_ORDER; columns are bandwidth profiles
    in E6_COL_ORDER. Cells with no data appear as NaN (Fig 5 will draw
    them with a hatched mask).

    Cell-ids in the summary are formatted "{config}_{profile}".
    """
    summary = load_aggregate_summary("e6")
    if metric not in summary.columns:
        raise KeyError(
            f"metric {metric!r} not found in e6 aggregate_summary; "
            f"available columns: {list(summary.columns)}"
        )
    parsed = summary["cell_id"].str.split("_", n=1, expand=True)
    summary["abr_config"] = parsed[0]
    summary["profile"] = parsed[1]
    pivot = summary.pivot(index="abr_config", columns="profile", values=metric)
    return pivot.reindex(index=E6_ROW_ORDER, columns=E6_COL_ORDER)
