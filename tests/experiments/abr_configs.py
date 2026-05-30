"""ABR rule configurations for E6 sweep.

Each config is a partial AbrSettings dict written to window.__abrSettingsOverride.
The 'rules' subdict toggles individual rule.active flags; merged over
DEFAULT_ABR_SETTINGS by the client at AbrController construction. Because that
merge keeps a rule's default when it isn't named, and all six safety rules
default to active=true, turning safety OFF requires naming them explicitly.

Safety is a swept variable here, not a fixed background:
  - 'all' runs with the safety rules ON (plus throughput + bola).
  - every other config runs with the safety rules OFF.
  - 'none' turns off every ABR rule (safety and quality-drivers alike).

Safety rules (toggled as a group via _SAFETY_ON / _SAFETY_OFF):
  InsufficientBufferRule, BufferDrainRateRule, LatencyTrendRule,
  AbandonRequestsRule, SwitchHistoryRule, ProbeRule

Quality-driver configs (the other variable being swept):
  all, none, throughput-only, bola-only, default, dampened, aggressive, lolp, l2a
"""

_SAFETY_RULES = (
    "InsufficientBufferRule",
    "BufferDrainRateRule",
    "LatencyTrendRule",
    "AbandonRequestsRule",
    "SwitchHistoryRule",
    "ProbeRule",
)

_SAFETY_ON = {name: {"active": True} for name in _SAFETY_RULES}
_SAFETY_OFF = {name: {"active": False} for name in _SAFETY_RULES}


def _config(rules: dict, **extra) -> dict:
    return {"rules": rules, **extra}


ABR_CONFIGS = {
    "all": _config({
        **_SAFETY_ON,
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": True},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "none": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "throughput-only": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "bola-only": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": True},
        "LoLPRule": {"active": False},
        "L2ARule": {"active": False},
    }),
    "default": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": True},
    }),
    "dampened": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": True},
        "BolaRule": {"active": True},
        # dampened exists to re-tune SwitchHistoryRule; its explicit override
        # wins over _SAFETY_OFF, so this one safety rule stays on here.
        "SwitchHistoryRule": {
            "active": True,
            "parameters": {"sampleSize": 4, "switchPercentageThreshold": 0.20},
        },
    }),
    "aggressive": _config(
        {
            **_SAFETY_OFF,
            "ThroughputRule": {"active": True},
            "BolaRule": {"active": True},
        },
        bandwidthSafetyFactor=1.0,
    ),
    "lolp": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "LoLPRule": {"active": True},
    }),
    "l2a": _config({
        **_SAFETY_OFF,
        "ThroughputRule": {"active": False},
        "BolaRule": {"active": False},
        "L2ARule": {"active": True},
    }),
}
