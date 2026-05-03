"""ABR rule configurations for E6 sweep.

Each config is a partial AbrSettings dict written to window.__abrSettingsOverride.
The 'rules' subdict toggles individual rule.active flags; merged over
DEFAULT_ABR_SETTINGS by the client at AbrController construction.

Always-on safety rules (never toggled off across configs):
  InsufficientBufferRule, BufferDrainRateRule, LatencyTrendRule,
  AbandonRequestsRule, SwitchHistoryRule, ProbeRule

Quality-driver configs (the variable being swept):
  none, throughput-only, bola-only, default, dampened, aggressive, lolp, l2a
"""

# Always-on safety rules.
_SAFETY_ON = {
    "InsufficientBufferRule": {"active": True},
    "BufferDrainRateRule": {"active": True},
    "LatencyTrendRule": {"active": True},
    "AbandonRequestsRule": {"active": True},
    "SwitchHistoryRule": {"active": True},
    "ProbeRule": {"active": True},
}


def _config(rules_overrides: dict, **extra) -> dict:
    return {"rules": {**_SAFETY_ON, **rules_overrides}, **extra}


ABR_CONFIGS = {
    "none": _config({
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "throughput-only": _config({
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "bola-only": _config({
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": True},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "default": _config({
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": True},
    }),
    "dampened": _config({
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": True},
        "SwitchHistoryRule": {
            "active": True,
            "parameters": {"sampleSize": 4, "switchPercentageThreshold": 0.20},
        },
    }),
    "aggressive": _config(
        {
            "ThroughputRule": {"active": True},
            "BolaRule": {"active": True},
        },
        bandwidthSafetyFactor=1.0,
    ),
    "lolp": _config({
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": True},
    }),
    "l2a": _config({
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "L2ARule": {"active": True},
    }),
}
