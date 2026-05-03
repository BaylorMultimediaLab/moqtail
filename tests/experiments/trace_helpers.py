"""Post-run analysis helpers shared across experiment test files.

- parse_relay_decisions: extract Ready/ClampedToOldest/Hold from relay.log
- detect_rebuffers_from_metrics: derive rebuffer events from buffer-seconds samples
- force_switch: thin wrapper around the client's window.__forceSwitch debug hook
"""
import re
from typing import Iterable


# Matches:
#   Subscribe delay-mode resolved Ready: request_id=N largest=Location { group: G, object: O }
#   oldest_cached=(Some(C)|None) -> start_location=Location { group: S, object: 0 }
_RESOLVED_READY_RE = re.compile(
    r"Subscribe delay-mode resolved Ready:.*?"
    r"largest=Location \{ group: (\d+), object: \d+ \}.*?"
    r"oldest_cached=(Some\((\d+)\)|None).*?"
    r"-> start_location=Location \{ group: (\d+), object: \d+ \}"
)
# Matches:
#   Subscribe delay-mode resolved ClampedToOldest: request_id=N largest=Location { group: G, object: O }
#   oldest_cached=(Some(C)|None) -> start_location=Location { group: S, object: 0 }
_RESOLVED_CLAMPED_RE = re.compile(
    r"Subscribe delay-mode resolved ClampedToOldest:.*?"
    r"largest=Location \{ group: (\d+), object: \d+ \}.*?"
    r"oldest_cached=(Some\((\d+)\)|None).*?"
    r"-> start_location=Location \{ group: (\d+), object: \d+ \}"
)
# Matches:
#   Subscribe delay-mode HOLD: request_id=N delay_groups=D largest=Location { group: G, object: O };
_HOLD_RE = re.compile(
    r"Subscribe delay-mode HOLD:.*?delay_groups=(\d+).*?"
    r"largest=Location \{ group: (\d+), object: \d+ \}"
)


def parse_relay_decisions(log_text: str) -> list[dict]:
    """Walk relay log lines, classify each delay-mode subscribe decision.

    Returns list of dicts: {classification, largest_group, start_location_group,
    oldest_cached_group?, delay_groups?}

    Classification is read directly from the relay log's explicit marker:
      - 'resolved Ready:' line -> 'Ready'
      - 'resolved ClampedToOldest:' line -> 'ClampedToOldest'
      - 'HOLD:' line -> 'Hold'
    """
    decisions = []
    for line in log_text.splitlines():
        if "delay-mode HOLD" in line:
            m = _HOLD_RE.search(line)
            if m:
                decisions.append({
                    "classification": "Hold",
                    "delay_groups": int(m.group(1)),
                    "largest_group": int(m.group(2)),
                    "start_location_group": None,
                    "oldest_cached_group": None,
                })
            continue
        if "delay-mode resolved Ready:" in line:
            m = _RESOLVED_READY_RE.search(line)
            if not m:
                continue
            largest_group = int(m.group(1))
            oldest_str = m.group(3)
            oldest_cached = int(oldest_str) if oldest_str else None
            start_group = int(m.group(4))
            decisions.append({
                "classification": "Ready",
                "largest_group": largest_group,
                "oldest_cached_group": oldest_cached,
                "start_location_group": start_group,
                "delay_groups": None,
            })
            continue
        if "delay-mode resolved ClampedToOldest:" in line:
            m = _RESOLVED_CLAMPED_RE.search(line)
            if not m:
                continue
            largest_group = int(m.group(1))
            oldest_str = m.group(3)
            oldest_cached = int(oldest_str) if oldest_str else None
            start_group = int(m.group(4))
            decisions.append({
                "classification": "ClampedToOldest",
                "largest_group": largest_group,
                "oldest_cached_group": oldest_cached,
                "start_location_group": start_group,
                "delay_groups": None,
            })
    return decisions


def detect_rebuffers_from_metrics(
    samples: Iterable[tuple[float, float]],
    threshold_s: float = 0.1,
    min_duration_s: float = 0.25,
) -> list[dict]:
    """Detect rebuffer events from a series of (elapsed_s, buffer_s) samples.

    A rebuffer is a contiguous run of samples where buffer_s < threshold_s,
    sustained for at least `min_duration_s`. Duration is computed as the
    timestamp of the last low sample minus the first low sample (so two
    contiguous samples at t=10.0 and t=10.25 is a 0.25s event).
    """
    events = []
    in_event = False
    event_start = 0.0
    last_low_t = 0.0
    for t, buf in samples:
        if buf < threshold_s:
            if not in_event:
                in_event = True
                event_start = t
            last_low_t = t
        else:
            if in_event:
                duration = last_low_t - event_start
                if duration >= min_duration_s:
                    events.append({"start_s": event_start, "end_s": last_low_t, "duration_s": duration})
                in_event = False
    # Handle a rebuffer that extends to the end of the sample stream
    if in_event:
        duration = last_low_t - event_start
        if duration >= min_duration_s:
            events.append({"start_s": event_start, "end_s": last_low_t, "duration_s": duration})
    return events


async def force_switch(page, track_name: str) -> None:
    """Trigger the client-js debug-only force-switch hook.

    The hook is installed by Player.initialize() in apps/client-js/src/lib/player.ts
    when running in a browser context. Track names follow the catalog format
    (e.g. "video-720p-5000k" for the 5 Mbps rung of the experiment ladder).
    """
    await page.evaluate("(name) => window.__forceSwitch(name)", track_name)
