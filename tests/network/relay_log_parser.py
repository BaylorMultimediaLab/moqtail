"""Parse relay stdout and object log files for switch events and object delivery data."""

import re
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SwitchEvent:
    timestamp: float
    from_track: str | None
    to_track: str
    subscriber_id: int


@dataclass
class ObjectRecord:
    group_id: int
    subgroup_id: int
    object_id: int
    payload_size: int
    send_status: bool
    received_time: int


@dataclass
class RelayLogParser:
    log_lines: list[str] = field(default_factory=list)
    switch_events: list[SwitchEvent] = field(default_factory=list)

    # Matches: "received Switch message: Switch { ... track_namespace: "..." ... track_name: "..." ... }"
    _switch_pattern: re.Pattern = field(
        default_factory=lambda: re.compile(
            r"received Switch message:.*track_namespace.*?\"([^\"]+)\".*track_name.*?\"([^\"]+)\""
        ),
        init=False,
    )

    def parse_stdout(self, stdout_text: str) -> list[SwitchEvent]:
        events = []
        for line in stdout_text.splitlines():
            match = self._switch_pattern.search(line)
            if match:
                namespace = match.group(1)
                track_name = match.group(2)
                full_track = f"{namespace}/{track_name}"
                event = SwitchEvent(
                    timestamp=time.time(),
                    from_track=None,
                    to_track=full_track,
                    subscriber_id=0,
                )
                events.append(event)
        self.switch_events.extend(events)
        return events

    def parse_incremental(self, new_lines: list[str]) -> list[SwitchEvent]:
        self.log_lines.extend(new_lines)
        return self.parse_stdout("\n".join(new_lines))

    @staticmethod
    def parse_object_log(log_path: Path) -> list[ObjectRecord]:
        # CSV: group_id,subgroup_id,object_id,payload_size,send_status,received_time
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
        return sorted(log_dir.glob("sub_*.log"))
