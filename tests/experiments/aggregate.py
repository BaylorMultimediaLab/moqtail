"""Walk results/ recursively and emit aggregate.csv + aggregate_summary.csv."""
import argparse
import csv
import json
import statistics
from pathlib import Path
from typing import Any


def build_aggregate(results_root: Path, experiment: str) -> list[dict[str, Any]]:
    """Walk results_root recursively, find all summary.json with matching experiment.

    The directory layout doesn't matter: every summary.json carries its own
    `experiment` field. We filter by that field instead of by path so the
    function tolerates whatever layout pytest (or the user) writes.
    """
    rows = []
    for summary_path in sorted(results_root.rglob("summary.json")):
        try:
            data = json.loads(summary_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("experiment") == experiment:
            rows.append(data)
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


def aggregate_experiment(results_root: Path, experiment: str) -> tuple[Path, Path]:
    """Walk results_root recursively for summaries matching experiment, write both
    aggregate CSVs. Returns the paths."""
    rows = build_aggregate(results_root, experiment)
    summary = build_aggregate_summary(rows)
    out_dir = results_root / experiment
    out_dir.mkdir(parents=True, exist_ok=True)
    agg_path = out_dir / "aggregate.csv"
    summary_path = out_dir / "aggregate_summary.csv"
    write_csv(rows, agg_path)
    write_csv(summary, summary_path)
    return agg_path, summary_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("experiment", help="Experiment id (e1, e2, e3, e4, e6)")
    parser.add_argument(
        "--results-root",
        default=str(Path(__file__).resolve().parent / "results"),
        help="Root directory containing run artifacts (default: tests/experiments/results/).",
    )
    args = parser.parse_args()
    root = Path(args.results_root)
    if not root.exists():
        raise SystemExit(f"No results dir at {root}")
    agg_path, summary_path = aggregate_experiment(root, args.experiment)
    print(f"Wrote {agg_path}")
    print(f"Wrote {summary_path}")


if __name__ == "__main__":
    main()
