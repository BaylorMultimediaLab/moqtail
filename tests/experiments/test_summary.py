import json
from pathlib import Path

from summary import build_run_summary


# Real CSV header from tests/network/metrics_collector.py:save_csv (lines 125-131).
# 18 columns: timestamp, active_track, active_track_index, buffer_seconds,
# bandwidth_bps, fast_ema_bps, slow_ema_bps, dropped_frames, total_frames,
# playback_rate, delivery_time_ms, mode, ready_state, paused, current_time,
# buffered_ranges, mse_ready_state, video_error_code
_REAL_CSV_HEADER = (
    "timestamp,active_track,active_track_index,buffer_seconds,"
    "bandwidth_bps,fast_ema_bps,slow_ema_bps,dropped_frames,"
    "total_frames,playback_rate,delivery_time_ms,mode,"
    "ready_state,paused,current_time,buffered_ranges,"
    "mse_ready_state,video_error_code"
)


def _row(
    timestamp: str = "2026-04-30T00:00:00Z",
    active_track: str = "video-720p-1200k",
    active_track_index: int = 2,
    buffer_seconds: float = 1.5,
    bandwidth_bps: float = 1_500_000.0,
    fast_ema_bps: float = 1_500_000.0,
    slow_ema_bps: float = 1_500_000.0,
    dropped_frames: int = 0,
    total_frames: int = 0,
    playback_rate: float = 1.0,
    delivery_time_ms: float = 0.0,
    mode: str = "filtered",
    ready_state: int = 4,
    paused: bool = False,
    current_time: float = 0.0,
    buffered_ranges: str = "",
    mse_ready_state: int = 1,
    video_error_code: int = 0,
) -> str:
    return (
        f"{timestamp},{active_track},{active_track_index},{buffer_seconds},"
        f"{bandwidth_bps},{fast_ema_bps},{slow_ema_bps},{dropped_frames},"
        f"{total_frames},{playback_rate},{delivery_time_ms},{mode},"
        f"{ready_state},{paused},{current_time},{buffered_ranges},"
        f"{mse_ready_state},{video_error_code}"
    )


def test_build_run_summary_minimum_shape(tmp_path: Path):
    metrics_csv = tmp_path / "metrics.csv"
    metrics_csv.write_text(
        _REAL_CSV_HEADER + "\n"
        + _row(timestamp="2026-04-30T00:00:00Z", dropped_frames=0, total_frames=0, current_time=0.0) + "\n"
        + _row(timestamp="2026-04-30T00:00:01Z", dropped_frames=0, total_frames=25, current_time=1.0) + "\n"
        + _row(timestamp="2026-04-30T00:01:00Z", dropped_frames=5, total_frames=1500, current_time=60.0) + "\n"
    )
    relay_log = tmp_path / "relay.log"
    relay_log.write_text("")
    switch_records_json = tmp_path / "switch_records.json"
    switch_records_json.write_text(json.dumps([
        {"eventType": "switch", "ptsGapMs": 12.5, "ts": 30.0, "fromTrack": "q400", "toTrack": "q5000"},
    ]))
    summary = build_run_summary(
        metrics_csv=metrics_csv,
        relay_log=relay_log,
        switch_records=switch_records_json,
        cell_params={"experiment": "e1", "cell_id": "baseline", "run_index": 0},
    )
    assert summary["experiment"] == "e1"
    assert summary["cell_id"] == "baseline"
    assert summary["run_index"] == 0
    assert summary["n_switches"] == 1
    assert summary["max_pts_gap_ms"] == 12.5
    assert summary["dropped_frames"] == 5
    assert summary["total_frames"] == 1500
    assert summary["current_time_at_end_s"] >= 1.0
