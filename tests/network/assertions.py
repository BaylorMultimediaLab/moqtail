"""Reusable assertion functions for ABR network testing."""

from metrics_collector import MetricsCollector, SwitchRecord


def extract_resolution(track_name: str | None) -> str | None:
    """Extract resolution label from a track name.

    Track names follow the pattern: "video-{resolution}" (e.g., "video-1080p").
    Returns the resolution part (e.g., "1080p") or None.
    """
    if track_name is None:
        return None
    # Handle formats like "video-1080p", "video-720p", etc.
    for res in ["1080p", "720p", "480p", "360p"]:
        if res in track_name:
            return res
    return track_name


QUALITY_ORDER = ["360p", "480p", "720p", "1080p"]


def quality_index(resolution: str) -> int:
    """Return numeric index for a resolution (higher = better)."""
    try:
        return QUALITY_ORDER.index(resolution)
    except ValueError:
        return -1


def assert_downswitch_within(
    collector: MetricsCollector,
    change_time: float,
    max_latency_s: float,
    expected_quality: str,
) -> None:
    """Assert that the client switched to expected quality within max_latency_s of change_time.

    Args:
        collector: MetricsCollector with collected data.
        change_time: Unix timestamp when bandwidth was changed.
        max_latency_s: Maximum allowed seconds to switch.
        expected_quality: Expected resolution (e.g., "720p").
    """
    deadline = change_time + max_latency_s
    switches = collector.get_switches_in_window(change_time, deadline)

    # Check if any switch landed on or below the expected quality
    for sw in switches:
        sw_res = extract_resolution(sw.to_track)
        if sw_res and quality_index(sw_res) <= quality_index(expected_quality):
            return  # Success

    # Also check if the client was already at or below the expected quality
    quality_at_deadline = extract_resolution(collector.get_quality_at(deadline))
    if quality_at_deadline and quality_index(quality_at_deadline) <= quality_index(expected_quality):
        return  # Already at correct quality

    actual = extract_resolution(collector.get_quality_at(deadline))
    raise AssertionError(
        f"Expected client to reach {expected_quality} within {max_latency_s}s of bandwidth change. "
        f"Actual quality at deadline: {actual}. "
        f"Switches in window: {[(extract_resolution(s.to_track), s.timestamp - change_time) for s in switches]}"
    )


def assert_upswitch_within(
    collector: MetricsCollector,
    change_time: float,
    max_latency_s: float,
    expected_quality: str,
) -> None:
    """Assert that the client switched up to expected quality within max_latency_s.

    Args:
        collector: MetricsCollector with collected data.
        change_time: Unix timestamp when bandwidth was restored.
        max_latency_s: Maximum allowed seconds to upswitch.
        expected_quality: Expected resolution (e.g., "1080p").
    """
    deadline = change_time + max_latency_s
    switches = collector.get_switches_in_window(change_time, deadline)

    for sw in switches:
        sw_res = extract_resolution(sw.to_track)
        if sw_res and quality_index(sw_res) >= quality_index(expected_quality):
            return  # Success

    quality_at_deadline = extract_resolution(collector.get_quality_at(deadline))
    if quality_at_deadline and quality_index(quality_at_deadline) >= quality_index(expected_quality):
        return

    actual = extract_resolution(collector.get_quality_at(deadline))
    raise AssertionError(
        f"Expected client to reach {expected_quality} within {max_latency_s}s of bandwidth restoration. "
        f"Actual quality at deadline: {actual}. "
        f"Switches in window: {[(extract_resolution(s.to_track), s.timestamp - change_time) for s in switches]}"
    )


def assert_no_rebuffering(
    collector: MetricsCollector,
    start_time: float,
    end_time: float,
) -> None:
    """Assert that buffer never hit 0 during the time window.

    Args:
        collector: MetricsCollector with collected data.
        start_time: Window start.
        end_time: Window end.
    """
    min_buffer = collector.get_buffer_min(start_time, end_time)
    if min_buffer <= 0:
        # Find the exact time buffer hit 0
        zero_samples = [
            s for s in collector.samples
            if start_time <= s.timestamp <= end_time and s.buffer_seconds <= 0
        ]
        zero_times = [f"{s.timestamp - start_time:.1f}s" for s in zero_samples[:5]]
        raise AssertionError(
            f"Buffer hit 0 (rebuffering) at offsets: {zero_times}. "
            f"Min buffer in window: {min_buffer:.3f}s"
        )


def assert_buffer_above(
    collector: MetricsCollector,
    start_time: float,
    end_time: float,
    min_buffer_s: float,
) -> None:
    """Assert buffer stayed above a minimum threshold.

    Args:
        collector: MetricsCollector with collected data.
        start_time: Window start.
        end_time: Window end.
        min_buffer_s: Minimum acceptable buffer in seconds.
    """
    actual_min = collector.get_buffer_min(start_time, end_time)
    if actual_min < min_buffer_s:
        raise AssertionError(
            f"Buffer dropped to {actual_min:.3f}s, below minimum {min_buffer_s}s"
        )


def assert_quality_floor(
    collector: MetricsCollector,
    start_time: float,
    end_time: float,
    floor: str = "360p",
) -> None:
    """Assert that quality never went below the floor.

    Args:
        collector: MetricsCollector with collected data.
        start_time: Window start.
        end_time: Window end.
        floor: Minimum acceptable quality (e.g., "360p").
    """
    floor_idx = quality_index(floor)
    relevant = [s for s in collector.samples if start_time <= s.timestamp <= end_time]
    for sample in relevant:
        res = extract_resolution(sample.active_track)
        if res and quality_index(res) < floor_idx:
            raise AssertionError(
                f"Quality dropped below floor {floor}: got {res} at "
                f"offset {sample.timestamp - start_time:.1f}s"
            )


def assert_max_switches(
    collector: MetricsCollector,
    start_time: float,
    end_time: float,
    max_switches: int,
) -> None:
    """Assert that the number of quality switches didn't exceed a maximum.

    Args:
        collector: MetricsCollector with collected data.
        start_time: Window start.
        end_time: Window end.
        max_switches: Maximum allowed switches.
    """
    switches = collector.get_switches_in_window(start_time, end_time)
    if len(switches) > max_switches:
        switch_details = [
            f"{extract_resolution(s.from_track)}->{extract_resolution(s.to_track)} at +{s.timestamp - start_time:.1f}s"
            for s in switches
        ]
        raise AssertionError(
            f"Too many switches: {len(switches)} > {max_switches}. "
            f"Switches: {switch_details}"
        )


def assert_no_crash(collector: MetricsCollector, start_time: float, end_time: float) -> None:
    """Assert that the client kept reporting metrics (didn't crash or hang).

    Expects at least one sample per 2 seconds.

    Args:
        collector: MetricsCollector with collected data.
        start_time: Window start.
        end_time: Window end.
    """
    duration = end_time - start_time
    relevant = [s for s in collector.samples if start_time <= s.timestamp <= end_time]
    expected_min_samples = max(1, int(duration / 2))
    if len(relevant) < expected_min_samples:
        raise AssertionError(
            f"Client may have crashed or hung: only {len(relevant)} samples in {duration:.0f}s "
            f"(expected at least {expected_min_samples})"
        )
