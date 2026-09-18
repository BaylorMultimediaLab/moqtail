"""Shared data-loading helpers for the MMSys paper figures.

Reads from tests/experiments/results/ relative to the paper/ project
root. Each helper returns a pandas DataFrame shaped for a specific
figure (long for boxplots, wide for heat maps).

Source-of-truth for column names is tests/experiments/aggregate.py and
tests/experiments/summary.py — match those exactly.
"""
from __future__ import annotations

import json
import struct
from functools import lru_cache
from pathlib import Path

import pandas as pd

# Absolute path to tests/experiments/results/ resolved from this file's
# location. Two parents up from `paper/figures/_data.py` → repo root,
# then descend.
RESULTS_ROOT = (Path(__file__).resolve().parents[2] / "tests" / "experiments" / "results").resolve()

# Pre-encoded GOP cache the publisher replayed during the experiments. The
# per-rung *actual* encoded bitrate is measured from these bytes (see
# measured_rung_bitrates_kbps) rather than trusting the track-name label,
# so the figures report the real bitrate of the data the client received.
DATA_ENCODED_ROOT = (Path(__file__).resolve().parents[2] / "data" / "encoded").resolve()

# The experiment harness replays this specific multi-resolution cache
# (tests/experiments/conftest.py). Measure rung bitrates from it alone so a
# stale sibling cache (e.g. an older 720p ladder) can't leak rung names. Falls
# back to the whole encoded root if this exact directory isn't present.
ACTIVE_GOP_CACHE = DATA_ENCODED_ROOT / "tears_of_steel_120s_1080p"

# E6 row/column ordering for Fig 5. Matches the spec literally.
E6_ROW_ORDER = [
    "all", "none", "throughput-only", "bola-only", "default",
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
    """Reshape the E6 aggregate_summary into a 9x3 heat-map matrix.

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


def _parse_gop_variant_bitrate_kbps(variant_dir: Path, framerate: float) -> float:
    """Measure the actual encoded bitrate (kbps) of one ladder rung.

    Each ``NNNNNN.gop`` file is the publisher's on-disk format
    (apps/publisher/src/cache.rs::write_gop): a u32 packet count followed by
    ``[u32 len][payload]`` per encoded frame. We sum payload bytes (excluding
    the 4-byte framing per packet, which is negligible but free to skip) and
    divide by the playback duration implied by the frame count and framerate.

    Returns NaN if the variant has no parseable GOPs.
    """
    payload_bytes = 0
    frames = 0
    for gop_path in sorted(variant_dir.glob("*.gop")):
        data = gop_path.read_bytes()
        off = 0
        (count,) = struct.unpack_from("<I", data, off)
        off += 4
        for _ in range(count):
            (length,) = struct.unpack_from("<I", data, off)
            off += 4 + length
            payload_bytes += length
            frames += 1
    if frames == 0 or framerate <= 0:
        return float("nan")
    duration_s = frames / framerate
    return payload_bytes * 8 / duration_s / 1000


@lru_cache(maxsize=None)
def measured_rung_bitrates_kbps() -> dict[str, float]:
    """Map each ladder rung name (e.g. ``720p-5000k``) to its *measured*
    encoded bitrate in kbps, parsed from the pre-encoded GOP cache.

    Walks every variant directory under DATA_ENCODED_ROOT that sits beside a
    ``meta.json`` (the publisher's cache marker). Cached so the 5×61 GOP
    files are parsed once per process, not once per run. Returns an empty
    dict if the cache is absent — callers fall back to the label bitrate.
    """
    out: dict[str, float] = {}
    root = ACTIVE_GOP_CACHE if ACTIVE_GOP_CACHE.exists() else DATA_ENCODED_ROOT
    if not root.exists():
        return out
    for meta_path in sorted(root.rglob("meta.json")):
        try:
            meta = json.loads(meta_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        framerate = float(meta.get("framerate", 0.0))
        for variant in meta.get("variants", []):
            variant_dir = meta_path.parent / variant
            if not variant_dir.is_dir():
                continue
            kbps = _parse_gop_variant_bitrate_kbps(variant_dir, framerate)
            if kbps == kbps:  # not NaN
                out[variant] = kbps
    return out


def compute_avg_delivered_bitrate_kbps(run_dir: Path) -> float:
    """Time-weighted mean *selected-quality* bitrate (kbps) for one run.

    The active rung is read from `active_track` strings of the form
    ``video-<height>p-<bitrate>k`` (e.g. ``video-720p-2500k``). Its bitrate
    is the rung's *measured* encoded bitrate from the GOP cache
    (measured_rung_bitrates_kbps) rather than the nominal label — the label
    is a rate-control target, and we report the real bytes the client
    consumed. Rungs missing from the cache fall back to the label.

    Each sample is weighted by the wall-clock interval to its successor; the
    last sample has no successor (0 weight). Returns NaN if no rows remain.

    Note: this is the bitrate of the *tier the ABR selected*, not the
    throughput sustained by the link — see compute_avg_sustained_throughput_kbps.
    """
    df = load_run_metrics(run_dir)
    df = df.copy()
    measured = measured_rung_bitrates_kbps()

    def rung_bitrate(track: str) -> float:
        # "video-720p-5000k" -> rung "720p-5000k"; strip a leading role prefix.
        rung = str(track)
        if rung.startswith("video-"):
            rung = rung[len("video-"):]
        if rung in measured:
            return measured[rung]
        # Fall back to the label embedded in the name ("...-5000k" -> 5000).
        label = pd.Series([rung]).str.extract(r"-(\d+)k$")[0].iloc[0]
        return float(label) if label is not None and label == label else float("nan")

    df["bitrate_kbps"] = df["active_track"].map(rung_bitrate)
    # Time slice each row owns = gap to the next sample. Last sample has no
    # successor, so it contributes 0 weight (drop it).
    df["dt_s"] = df["wall_clock_s"].diff().shift(-1).fillna(0)
    valid = df.dropna(subset=["bitrate_kbps"])
    total_weight = valid["dt_s"].sum()
    if total_weight == 0:
        return float("nan")
    return float((valid["bitrate_kbps"] * valid["dt_s"]).sum() / total_weight)


def compute_delivered_goodput_kbps(run_dir: Path) -> float:
    """Mean *delivered goodput* (kbps) for one run — the rate of unique new
    media the link actually carried, in contrast to the quality tier the ABR
    requested (compute_avg_delivered_bitrate_kbps).

    The furthest buffered media position is ``current_time + buffer_seconds``
    (player.ts reports buffer_seconds as buffered_end − currentTime). Its net
    advance over the run is the total media *duration* delivered into MSE —
    robust to seeks and 500 ms polling jitter, since it telescopes to a single
    end-minus-start difference. Multiplying by the time-weighted measured
    selected bitrate (the tiers whose data was delivered) and dividing by the
    wall-clock window gives the kbps of unique media that flowed.

    Why this is *not* the same as raw `bandwidth_bps`: that signal is the
    goodput tracker's in-burst rate and overshoots the link under backlog.
    And why it's *below* the link capacity on a starved link: capacity spent
    re-delivering oversized GOPs the player couldn't keep up with doesn't
    advance the buffered position, so it isn't counted as unique goodput.

    Returns NaN if the run has no rows or no parseable selected bitrate.
    """
    df = load_run_metrics(run_dir)
    if df.empty:
        return float("nan")
    pos = df["current_time"] + df["buffer_seconds"]
    delivered_media_s = max(0.0, float(pos.iloc[-1] - pos.iloc[0]))
    avg_selected_kbps = compute_avg_delivered_bitrate_kbps(run_dir)
    wall_s = float(df["wall_clock_s"].iloc[-1] - df["wall_clock_s"].iloc[0])
    if wall_s <= 0 or avg_selected_kbps != avg_selected_kbps:  # NaN check
        return float("nan")
    return delivered_media_s * avg_selected_kbps / wall_s


def compute_avg_sustained_throughput_kbps(run_dir: Path) -> float:
    """Time-weighted mean of the *smoothed* throughput estimate (kbps) for one
    run — the slow-EMA bandwidth the ABR actually steers on.

    Distinct from the other two per-cell metrics:
    - compute_avg_delivered_bitrate_kbps is the tier the ABR *picked*.
    - compute_delivered_goodput_kbps is the unique media that advanced the
      buffer (selected bitrate × media delivered ÷ wall).
    - this is the throughput the link *sustained*, read from ``slow_ema_bps``
      so a single push-rate burst (the in-burst spike that inflates raw
      ``bandwidth_bps``) doesn't dominate the average.

    Each sample is weighted by the wall-clock interval to its successor; the
    last sample has no successor (0 weight). Returns NaN if no rows remain.
    """
    df = load_run_metrics(run_dir)
    df = df.copy()
    df["dt_s"] = df["wall_clock_s"].diff().shift(-1).fillna(0)
    df = df.dropna(subset=["slow_ema_bps"])
    total_weight = df["dt_s"].sum()
    if total_weight == 0:
        return float("nan")
    return float((df["slow_ema_bps"] * df["dt_s"]).sum() / total_weight) / 1000.0


def avg_metric_matrix(experiment: str, compute_fn) -> pd.DataFrame:
    """9x3 (abr_config × profile) matrix of a per-run metric, averaged per cell.

    Walks every per-run directory whose summary.json matches `experiment`,
    applies `compute_fn(run_dir) -> float` to each run, then averages across
    runs per cell. Cells with no runs appear as NaN; row/column order matches
    E6_ROW_ORDER / E6_COL_ORDER (the E5 and E6 sweeps share this grid).
    """
    rows = []
    for summary_path in sorted(RESULTS_ROOT.rglob("summary.json")):
        try:
            data = json.loads(summary_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("experiment") != experiment:
            continue
        cell_id = data.get("cell_id")
        if not cell_id:
            continue
        rows.append({"cell_id": cell_id, "value": compute_fn(summary_path.parent)})
    if not rows:
        return pd.DataFrame(index=E6_ROW_ORDER, columns=E6_COL_ORDER, dtype=float)
    df = pd.DataFrame(rows)
    parsed = df["cell_id"].str.split("_", n=1, expand=True)
    df["abr_config"] = parsed[0]
    df["profile"] = parsed[1]
    pivot = df.pivot_table(
        index="abr_config", columns="profile", values="value", aggfunc="mean"
    )
    return pivot.reindex(index=E6_ROW_ORDER, columns=E6_COL_ORDER)


def e6_avg_bitrate_matrix() -> pd.DataFrame:
    """E6 (filtered+aligned) mean selected-quality bitrate (kbps), per cell."""
    return avg_metric_matrix("e6", compute_avg_delivered_bitrate_kbps)


def e5_avg_bitrate_matrix() -> pd.DataFrame:
    """E5 (unfiltered+naive) mean selected-quality bitrate (kbps), per cell."""
    return avg_metric_matrix("e5", compute_avg_delivered_bitrate_kbps)


def e6_delivered_goodput_matrix() -> pd.DataFrame:
    """E6 mean delivered goodput (kbps) per cell — unique media the link carried."""
    return avg_metric_matrix("e6", compute_delivered_goodput_kbps)


def e5_delivered_goodput_matrix() -> pd.DataFrame:
    """E5 mean delivered goodput (kbps) per cell — unique media the link carried."""
    return avg_metric_matrix("e5", compute_delivered_goodput_kbps)


def e7_avg_bitrate_matrix() -> pd.DataFrame:
    """E7 (filtered+aligned, zero filter delay) mean selected-quality bitrate (kbps), per cell."""
    return avg_metric_matrix("e7", compute_avg_delivered_bitrate_kbps)


def e7_delivered_goodput_matrix() -> pd.DataFrame:
    """E7 mean delivered goodput (kbps) per cell — unique media the link carried."""
    return avg_metric_matrix("e7", compute_delivered_goodput_kbps)


def e5_sustained_throughput_matrix() -> pd.DataFrame:
    """E5 mean sustained throughput (kbps) per cell — smoothed slow-EMA link rate."""
    return avg_metric_matrix("e5", compute_avg_sustained_throughput_kbps)


def e6_sustained_throughput_matrix() -> pd.DataFrame:
    """E6 mean sustained throughput (kbps) per cell — smoothed slow-EMA link rate."""
    return avg_metric_matrix("e6", compute_avg_sustained_throughput_kbps)


def e7_sustained_throughput_matrix() -> pd.DataFrame:
    """E7 mean sustained throughput (kbps) per cell — smoothed slow-EMA link rate."""
    return avg_metric_matrix("e7", compute_avg_sustained_throughput_kbps)
