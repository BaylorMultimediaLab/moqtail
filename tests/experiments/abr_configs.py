"""ABR rule configurations for the E3/E4 sweep.

Each config isolates one rule (or a small composition) so its individual
contribution to delivered bitrate, switch count, and stall behavior is
observable without confounding from an always-on safety floor.

All configs pin the join rung to the middle of the 5-rung ladder
(1200 kbps `video-720p-1200k`) via `initialBitrate`, so cells start
from a known, comparable rung across the three bandwidth profiles.
The client honors this override in app.tsx by selecting the closest-
bitrate track instead of using the WebTransport bandwidth estimate.

Seven configs total:
  none          — no rule active; the no-adaptation reference
  thrpt / bola  — quality drivers, one at a time
  bola+thrpt    — the two quality drivers composed
  all           — every dash.js rule active simultaneously, except
                  LoLP/L2A (which assume exclusive ownership of the
                  switching decision)
  lolp / l2a    — standalone algorithms (assume exclusive ownership
                  of the switching decision)
"""

# Middle rung of the 5-rung experiment ladder (400k, 800k, 1200k, 2500k, 5000k).
# Drives `firstVideo` selection in app.tsx when present.
_JOIN_BITRATE_BPS = 1_200_000


def _all_off() -> dict:
    """Every rule explicitly inactive. Each config below flips one or more back on."""
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


def _config(*active: str) -> dict:
    rules = _all_off()
    for name in active:
        rules[name] = {"active": True}
    return {
        "initialBitrate": _JOIN_BITRATE_BPS,
        "rules": rules,
    }


def _config_all_except(*disabled: str) -> dict:
    """Every rule active except the named ones (e.g. LoLP/L2A)."""
    rules = _all_off()
    for name in rules:
        rules[name] = {"active": True}
    for name in disabled:
        rules[name] = {"active": False}
    return {
        "initialBitrate": _JOIN_BITRATE_BPS,
        "rules": rules,
    }


ABR_CONFIGS = {
    # No adaptation: every rule disabled. Pinned to the middle rung; the
    # delivered bitrate under each profile bounds what passive playback can
    # achieve when the network must absorb whatever the variant emits.
    "none": _config(),

    # Quality drivers, one at a time.
    "thrpt": _config("ThroughputRule"),
    "bola": _config("BolaRule"),

    # Both quality drivers composed (dash.js style: ThroughputRule + BolaRule).
    "bola+thrpt": _config("ThroughputRule", "BolaRule"),

    # All dash.js-style rules active simultaneously. Excludes LoLP/L2A (which
    # are standalone algorithms — see below). Compositionality reference: what
    # happens when every dash.js rule runs together.
    "all": _config_all_except("LoLPRule", "L2ARule"),

    # Standalone algorithms whose internal state machine assumes exclusive
    # ownership of the switching decision (no composition with other rules).
    "lolp": _config("LoLPRule"),
    "l2a": _config("L2ARule"),
}
