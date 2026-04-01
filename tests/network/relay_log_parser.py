"""Parse relay stdout and object log files for switch events and object delivery data."""

import re
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SwitchEvent:
    """A track switch event extracted from relay logs."""

    timestamp: float  # Unix timestamp (seconds)
    from_track: str | None  # Previous track name (None if first subscription)
    to_track: str  # New track name
    subscriber_id: int  # Connection ID of the subscriber


@dataclass
class ObjectRecord:
    """A single object delivery record from per-subscriber log files."""

    group_id: int
    subgroup_id: int
    object_id: int
    payload_size: int
    send_status: bool
    received_time: int  # Milliseconds since epoch


@dataclass
class RelayLogParser:
    """Parses relay stdout for switch events and reads object log CSVs."""

    log_lines: list[str] = field(default_factory=list)
    switch_events: list[SwitchEvent] = field(default_factory=list)

    # Pattern for: "received Switch message: Switch { ... }"
    # Extracts track_namespace and track_name from the debug output
    _switch_pattern: re.Pattern = field(
        default_factory=lambda: re.compile(
            r"received Switch message:.*track_namespace.*?\"([^\"]+)\".*track_name.*?\"([^\"]+)\""
        ),
        init=False,
    )

    def parse_stdout(self, stdout_text: str) -> list[SwitchEvent]:
        """Parse relay stdout text for switch events.

        Args:
            stdout_text: Complete relay stdout output.

        Returns:
            List of SwitchEvent objects found.
        """
        events = []
        for line in stdout_text.splitlines():
            match = self._switch_pattern.search(line)
            if match:
                namespace = match.group(1)
                track_name = match.group(2)
                full_track = f"{namespace}/{track_name}"
                event = SwitchEvent(
                    timestamp=time.time(),
                    from_track=None,  # Not available from this log line alone
                    to_track=full_track,
                    subscriber_id=0,
                )
                events.append(event)
        self.switch_events.extend(events)
        return events

    def parse_incremental(self, new_lines: list[str]) -> list[SwitchEvent]:
        """Parse newly-appended relay stdout lines (for live tailing).

        Args:
            new_lines: New lines since last call.

        Returns:
            List of new SwitchEvent objects.
        """
        self.log_lines.extend(new_lines)
        return self.parse_stdout("\n".join(new_lines))

    @staticmethod
    def parse_object_log(log_path: Path) -> list[ObjectRecord]:
        """Parse a per-subscriber object log CSV file.

        File format: group_id,subgroup_id,object_id,payload_size,send_status,object_received_time

        Args:
            log_path: Path to the log file (e.g., sub_1_2.log).

        Returns:
            List of ObjectRecord objects.
        """
        records = []
        if not log_path.exists():
            return records

        for line in log_path.read_text().strip().splitlines():
            parts = line.strip().split(",")
            if len(parts) < 6:
                continue
            records.append(
                ObjectRecord(
                    group_id=int(parts[0]),
                    subgroup_id=int(parts[1]),
                    object_id=int(parts[2]),
                    payload_size=int(parts[3]),
                    send_status=parts[4].strip().lower() == "true",
                    received_time=int(parts[5]),
                )
            )
        return records

    @staticmethod
    def find_subscriber_logs(log_dir: Path) -> list[Path]:
        """Find all subscriber log files in a directory.

        Args:
            log_dir: Directory to search.

        Returns:
            List of paths matching sub_*.log pattern.
        """
        return sorted(log_dir.glob("sub_*.log"))
