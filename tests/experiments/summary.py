"""Per-run summary builder: rolls up metrics.csv + switch records into summary.json."""
import csv
import json
from pathlib import Path
from typing import Any


def build_run_summary(
    metrics_csv: Path,
    relay_log: Path,
    switch_records: Path,
    cell_params: dict[str, Any],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a summary dict suitable for writing to summary.json.

    Reads the metrics CSV, switch_records.json, and (optionally) the relay log,
    and produces a flat dict combining cell parameters with derived metrics.

    The discontinuity threshold (50ms) is the same as Task 4.3's E3 assertion:
    aligned switching should never produce a >50ms PTS gap, so any switch
    above that line is counted as a discontinuity. Below threshold, switches
    are still counted (n_switches) but not flagged.
    """
    rows = list(csv.DictReader(metrics_csv.open()))
    switches = json.loads(switch_records.read_text()) if switch_records.exists() else []
    switch_events = [s for s in switches if s.get("eventType") == "switch"]

    last_row = rows[-1] if rows else {}
    pts_gaps = [abs(s.get("ptsGapMs", 0)) for s in switch_events]

    summary: dict[str, Any] = dict(cell_params)
    summary.update({
        "n_switches": len(switch_events),
        "n_discontinuities": sum(1 for g in pts_gaps if g > 50),
        "max_pts_gap_ms": max(pts_gaps) if pts_gaps else 0.0,
        "mean_pts_gap_ms": (sum(pts_gaps) / len(pts_gaps)) if pts_gaps else 0.0,
        "dropped_frames": int(last_row.get("dropped_frames", 0) or 0),
        "total_frames": int(last_row.get("total_frames", 0) or 0),
        "current_time_at_end_s": float(last_row.get("current_time", 0) or 0),
        "switch_records": switch_events,
    })
    if extra:
        summary.update(extra)
    return summary


def write_run_summary(summary: dict[str, Any], dest: Path) -> None:
    """Persist a summary dict to disk as pretty-printed JSON."""
    dest.write_text(json.dumps(summary, indent=2, default=str))
