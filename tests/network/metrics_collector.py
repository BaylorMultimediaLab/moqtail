"""Polls window.__moqtailMetrics from a Playwright page at regular intervals."""

import asyncio
import csv
import json
import time
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ClientMetricsSample:
    timestamp: float
    active_track: str | None
    active_track_index: int
    buffer_seconds: float
    bandwidth_bps: float
    fast_ema_bps: float
    slow_ema_bps: float
    dropped_frames: int
    total_frames: int
    playback_rate: float
    delivery_time_ms: float
    mode: str
    ready_state: int = 0
    paused: bool = False
    current_time: float = 0.0
    buffered_ranges: str = ""
    mse_ready_state: str = ""
    video_error_code: int = 0


@dataclass
class SwitchRecord:
    timestamp: float
    from_track: str
    to_track: str
    reason: str
    buffer_at_switch: float
    ema_at_switch: float


@dataclass
class MetricsCollector:
    samples: list[ClientMetricsSample] = field(default_factory=list)
    switches: list[SwitchRecord] = field(default_factory=list)
    _seen_switch_count: int = field(default=0, init=False)

    async def poll_once(self, page) -> ClientMetricsSample | None:
        raw = await page.evaluate("() => window.__moqtailMetrics")
        if raw is None or raw.get("abr") is None:
            return None

        abr = raw["abr"]
        sample = ClientMetricsSample(
            timestamp=time.time(),
            active_track=abr.get("activeTrack"),
            active_track_index=abr.get("activeTrackIndex", -1),
            buffer_seconds=abr.get("bufferSeconds", 0.0),
            bandwidth_bps=abr.get("bandwidthBps", 0.0),
            fast_ema_bps=abr.get("fastEmaBps", 0.0),
            slow_ema_bps=abr.get("slowEmaBps", 0.0),
            dropped_frames=abr.get("droppedFrames", 0),
            total_frames=abr.get("totalFrames", 0),
            playback_rate=abr.get("playbackRate", 1.0),
            delivery_time_ms=abr.get("deliveryTimeMs", 0.0),
            mode=abr.get("mode", "auto"),
            ready_state=abr.get("readyState", 0),
            paused=abr.get("paused", False),
            current_time=abr.get("currentTime", 0.0),
            buffered_ranges=abr.get("bufferedRanges", ""),
            mse_ready_state=abr.get("mseReadyState", ""),
            video_error_code=abr.get("videoErrorCode", 0),
        )
        self.samples.append(sample)

        switch_history = abr.get("switchHistory", [])
        new_switches = switch_history[self._seen_switch_count :]
        for sw in new_switches:
            ts_ms = sw.get("ts")
            timestamp = ts_ms / 1000.0 if ts_ms is not None else time.time()
            self.switches.append(
                SwitchRecord(
                    timestamp=timestamp,
                    from_track=sw.get("fromTrack", ""),
                    to_track=sw.get("toTrack", ""),
                    reason=sw.get("reason", "unknown"),
                    buffer_at_switch=sw.get("bufferAtSwitch", 0.0),
                    ema_at_switch=sw.get("emaBwAtSwitch", 0.0),
                )
            )
        self._seen_switch_count = len(switch_history)

        return sample

    async def collect_for(self, page, duration_s: float, interval_ms: int = 500) -> None:
        end_time = time.time() + duration_s
        while time.time() < end_time:
            await self.poll_once(page)
            await asyncio.sleep(interval_ms / 1000.0)

    def get_quality_at(self, t: float) -> str | None:
        for sample in reversed(self.samples):
            if sample.timestamp <= t:
                return sample.active_track
        return None

    def get_buffer_min(self, start_t: float, end_t: float) -> float:
        relevant = [s for s in self.samples if start_t <= s.timestamp <= end_t]
        if not relevant:
            return 0.0
        return min(s.buffer_seconds for s in relevant)

    def get_switches_in_window(self, start_t: float, end_t: float) -> list[SwitchRecord]:
        return [sw for sw in self.switches if start_t <= sw.timestamp <= end_t]

    def save_csv(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "timestamp", "active_track", "active_track_index", "buffer_seconds",
                "bandwidth_bps", "fast_ema_bps", "slow_ema_bps", "dropped_frames",
                "total_frames", "playback_rate", "delivery_time_ms", "mode",
                "ready_state", "paused", "current_time", "buffered_ranges",
                "mse_ready_state", "video_error_code",
            ])
            for s in self.samples:
                writer.writerow([
                    s.timestamp, s.active_track, s.active_track_index, s.buffer_seconds,
                    s.bandwidth_bps, s.fast_ema_bps, s.slow_ema_bps, s.dropped_frames,
                    s.total_frames, s.playback_rate, s.delivery_time_ms, s.mode,
                    s.ready_state, s.paused, s.current_time, s.buffered_ranges,
                    s.mse_ready_state, s.video_error_code,
                ])

    def save_switches_json(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = [
            {
                "timestamp": sw.timestamp,
                "from_track": sw.from_track,
                "to_track": sw.to_track,
                "reason": sw.reason,
                "buffer_at_switch": sw.buffer_at_switch,
                "ema_at_switch": sw.ema_at_switch,
            }
            for sw in self.switches
        ]
        path.write_text(json.dumps(data, indent=2))
