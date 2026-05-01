from trace_helpers import (
    parse_relay_decisions,
    detect_rebuffers_from_metrics,
)


SAMPLE_RELAY_LOG = """
2026-04-30 21:09 INFO Subscribe delay-mode resolved: request_id=1 largest=Location { group: 50, object: 0 } oldest_cached=Some(0) -> start_location=Location { group: 30, object: 0 }
2026-04-30 21:10 INFO Subscribe delay-mode resolved: request_id=2 largest=Location { group: 60, object: 0 } oldest_cached=Some(40) -> start_location=Location { group: 40, object: 0 }
2026-04-30 21:11 INFO Subscribe delay-mode HOLD: request_id=3 delay_groups=200 largest=Location { group: 5, object: 0 }; awaiting live edge advance
"""


def test_parse_relay_decisions_finds_ready_clamped_and_hold():
    decisions = parse_relay_decisions(SAMPLE_RELAY_LOG)
    classifications = [d["classification"] for d in decisions]
    assert classifications == ["Ready", "ClampedToOldest", "Hold"]
    assert decisions[0]["start_location_group"] == 30
    assert decisions[1]["start_location_group"] == 40
    assert decisions[2]["delay_groups"] == 200


def test_detect_rebuffers_from_metrics_thresholds():
    samples = [
        (0.0, 1.0), (0.25, 1.0),
        (0.5, 0.05), (0.75, 0.05), (1.0, 0.05),  # 0.75s rebuffer (3 consecutive < 0.1)
        (1.25, 0.5), (1.5, 1.0),
        (10.0, 0.0), (10.25, 0.0),  # 0.25s rebuffer
    ]
    rebuffers = detect_rebuffers_from_metrics(samples, threshold_s=0.1, min_duration_s=0.25)
    assert len(rebuffers) == 2
    assert abs(rebuffers[0]["duration_s"] - 0.5) < 1e-6
    assert abs(rebuffers[1]["duration_s"] - 0.25) < 1e-6
