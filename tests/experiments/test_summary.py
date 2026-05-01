import json
from pathlib import Path

from summary import build_run_summary


def test_build_run_summary_minimum_shape(tmp_path: Path):
    metrics_csv = tmp_path / "metrics.csv"
    metrics_csv.write_text(
        "timestamp,elapsed_s,buffer_s,bitrate_kbps,bandwidth_kbps,fast_ema_kbps,slow_ema_kbps,"
        "dropped_frames,total_frames,playback_rate,delivery_time_ms\n"
        "2026-04-30T00:00:00Z,0.0,1.0,1200,1500.0,1500.0,1500.0,0,0,1.0,0.0\n"
        "2026-04-30T00:00:01Z,1.0,1.5,1200,1500.0,1500.0,1500.0,0,25,1.0,0.0\n"
        "2026-04-30T00:01:00Z,60.0,1.5,1200,1500.0,1500.0,1500.0,5,1500,1.0,0.0\n"
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
