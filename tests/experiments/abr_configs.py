"""ABR rule configurations for the E5/E6 sweep.

Each config isolates a single rule (or, for `none`, disables all of them)
so its individual contribution to delivered bitrate, switch count, and
stall behavior is observable without confounding from an always-on
safety floor.

All configs pin the join rung to the middle of the 5-rung ladder
(1200 kbps `video-720p-1200k`) via `initialBitrate`, so guard-only cells
start from a known, comparable rung across the three bandwidth profiles.
The client honors this override in app.tsx by selecting the closest-
bitrate track instead of using the WebTransport bandwidth estimate.

Twelve configs total:
  none                      — no rule active; serves as the no-adaptation reference
  thrpt / bola / probe      — quality drivers, one at a time
  ins-buf / drain / latency / abandon / sw-hist / drops — guard rules, one at a time
  lolp / l2a                — standalone algorithms (assume exclusive
                              ownership of the switching decision)
"""

# Middle rung of the 5-rung experiment ladder (400k, 800k, 1200k, 2500k, 5000k).
# Drives `firstVideo` selection in app.tsx when present.
_JOIN_BITRATE_BPS = 1_200_000


def _all_off() -> dict:
    """Every rule explicitly inactive. Each config below flips one back on."""
    return {
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "ProbeRule": {"active": False},
        "InsufficientBufferRule": {"active": False},
        "BufferDrainRateRule": {"active": False},
        "LatencyTrendRule": {"active": False},
        "AbandonRequestsRule": {"active": False},
        "SwitchHistoryRule": {"active": False},
        "DroppedFramesRule": {"active": False},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }


def _config(active: str | None) -> dict:
    rules = _all_off()
    if active is not None:
        rules[active] = {"active": True}
    return {
        "initialBitrate": _JOIN_BITRATE_BPS,
        "rules": rules,
    }


ABR_CONFIGS = {
    # No adaptation: every rule disabled. Pinned to the middle rung; the
    # delivered bitrate under each profile bounds what passive playback can
    # achieve when the network must absorb whatever the variant emits.
    "none": _config(None),

    # Quality drivers, one at a time.
    "thrpt": _config("ThroughputRule"),
    "bola": _config("BolaRule"),
    "probe": _config("ProbeRule"),

    # Guard rules, one at a time. With no quality driver they can only
    # constrain downward from the join rung; their delivered bitrate exposes
    # what each guard does on its own.
    "ins-buf": _config("InsufficientBufferRule"),
    "drain": _config("BufferDrainRateRule"),
    "latency": _config("LatencyTrendRule"),
    "abandon": _config("AbandonRequestsRule"),
    "sw-hist": _config("SwitchHistoryRule"),
    "drops": _config("DroppedFramesRule"),

    # Standalone algorithms whose internal state machine assumes exclusive
    # ownership of the switching decision (no composition with other rules).
    "lolp": _config("LoLPRule"),
    "l2a": _config("L2ARule"),
}
