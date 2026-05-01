"""Walk results/<experiment>/ and emit aggregate.csv + aggregate_summary.csv."""
import argparse
import csv
import json
import statistics
from pathlib import Path
from typing import Any


def build_aggregate(experiment_dir: Path) -> list[dict[str, Any]]:
    """Walk experiment_dir/<cell_id>/run*/summary.json and return all summaries as a list.

    Order is deterministic: cell dirs sorted alphabetically, run dirs sorted
    alphabetically within each cell. Skips run dirs without summary.json (a
    failed run that didn't produce one).
    """
    rows = []
    for cell_dir in sorted(p for p in experiment_dir.iterdir() if p.is_dir()):
        for run_dir in sorted(p for p in cell_dir.iterdir() if p.is_dir()):
            summary_path = run_dir / "summary.json"
            if not summary_path.exists():
                continue
            rows.append(json.loads(summary_path.read_text()))
    return rows


# Numeric fields aggregated per cell. Other fields (cell_id, experiment,
# run_index, success, switch_records, ...) are either grouping keys or non-numeric.
_NUMERIC_FIELDS = [
    "n_switches",
    "n_discontinuities",
    "max_pts_gap_ms",
    "mean_pts_gap_ms",
    "avg_delivered_bitrate_kbps",
    "mean_e2e_latency_ms",
    "p50_e2e_latency_ms",
    "p95_e2e_latency_ms",
    "rebuffer_count",
    "rebuffer_total_ms",
    "dropped_frames",
    "total_frames",
    "current_time_at_end_s",
]


def build_aggregate_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group rows by cell_id; produce mean/std/min/max/p95 for each numeric
    field plus success_rate."""
    by_cell: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_cell.setdefault(r["cell_id"], []).append(r)

    summary = []
    for cell_id, cell_rows in by_cell.items():
        n = len(cell_rows)
        cell_summary = {
            "experiment": cell_rows[0].get("experiment", ""),
            "cell_id": cell_id,
            "n_runs": n,
            "success_rate": sum(1 for r in cell_rows if r.get("success", True)) / n,
        }
        for field in _NUMERIC_FIELDS:
            values = [r[field] for r in cell_rows if field in r and r[field] is not None]
            if not values:
                continue
            cell_summary[f"{field}_mean"] = statistics.fmean(values)
            cell_summary[f"{field}_std"] = statistics.pstdev(values) if len(values) > 1 else 0.0
            cell_summary[f"{field}_min"] = min(values)
            cell_summary[f"{field}_max"] = max(values)
            try:
                # statistics.quantiles requires n>=2; n=20 buckets gives the
                # 5%-95% range with index -1 == p95.
                cell_summary[f"{field}_p95"] = statistics.quantiles(values, n=20)[-1]
            except statistics.StatisticsError:
                cell_summary[f"{field}_p95"] = max(values)
        summary.append(cell_summary)
    return summary


def write_csv(rows: list[dict[str, Any]], dest: Path) -> None:
    """Write rows as CSV with auto-discovered column union. No-op for empty rows."""
    if not rows:
        dest.write_text("")
        return
    fieldnames = sorted({k for r in rows for k in r.keys()})
    with dest.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def aggregate_experiment(experiment_dir: Path) -> tuple[Path, Path]:
    """Walk an experiment results dir, write both aggregate CSVs. Returns the paths."""
    rows = build_aggregate(experiment_dir)
    summary = build_aggregate_summary(rows)
    agg_path = experiment_dir / "aggregate.csv"
    summary_path = experiment_dir / "aggregate_summary.csv"
    write_csv(rows, agg_path)
    write_csv(summary, summary_path)
    return agg_path, summary_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "experiment",
        help="Experiment subdirectory under tests/experiments/results/ (e.g. e2)",
    )
    args = parser.parse_args()
    base = Path(__file__).resolve().parent / "results" / args.experiment
    if not base.exists():
        raise SystemExit(f"No results dir at {base}")
    agg_path, summary_path = aggregate_experiment(base)
    print(f"Wrote {agg_path}")
    print(f"Wrote {summary_path}")


if __name__ == "__main__":
    main()
