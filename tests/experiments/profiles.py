"""Bandwidth profiles for paper experiments.

Each profile exposes:
  - a *_schedule generator producing (time_offset_s, bw_mbps) tuples — pure,
    unit-testable
  - an `apply_*` async coroutine that consumes the schedule and calls
    shaper.shape_link2 against the Mininet `net` fixture at the right times

The schedule is the contract; the apply step is a thin adapter so we can
unit-test the profile logic without Mininet.
"""
import asyncio
import math
import sys
from pathlib import Path
from typing import Iterator

# Reach into tests/network for shape_link2.
_NETWORK_DIR = Path(__file__).resolve().parent.parent / "network"
if str(_NETWORK_DIR) not in sys.path:
    sys.path.insert(0, str(_NETWORK_DIR))
from shaper import shape_link2  # noqa: E402


def stable_schedule(bw_mbps: float, duration_s: float) -> Iterator[tuple[float, float]]:
    """Single tick at t=0; bandwidth holds for `duration_s`.

    `duration_s` isn't used for the schedule itself (it's a hint to the apply
    coroutine on how long to keep the asyncio task alive), but kept in the
    signature so all *_schedule functions are uniform.
    """
    yield (0.0, bw_mbps)


def step_schedule(
    initial_mbps: float, drop_mbps: float, drop_at_s: float, recover_at_s: float
) -> Iterator[tuple[float, float]]:
    """3-tick schedule: initial at t=0, drop at drop_at_s, recover at recover_at_s."""
    yield (0.0, initial_mbps)
    yield (float(drop_at_s), drop_mbps)
    yield (float(recover_at_s), initial_mbps)


def sinusoidal_schedule(
    low_mbps: float,
    high_mbps: float,
    period_s: float,
    duration_s: float,
    tick_s: float = 1.0,
) -> Iterator[tuple[float, float]]:
    """Sine wave between `low_mbps` and `high_mbps`, sampled every `tick_s`.

    The wave is centered at the midline of the two bounds with amplitude
    half-the-span; sin(0) = 0 places t=0 at the midline, ramping toward
    `high_mbps` first.
    """
    midline = (low_mbps + high_mbps) / 2
    amplitude = (high_mbps - low_mbps) / 2
    n_ticks = int(duration_s / tick_s)
    for i in range(n_ticks):
        t = i * tick_s
        bw = midline + amplitude * math.sin(2 * math.pi * t / period_s)
        yield (t, bw)


async def _apply_schedule(net, schedule: Iterator[tuple[float, float]]) -> None:
    """Wait until each tick's time, then call shape_link2 with that bandwidth.

    `net` is the Mininet network from the pytest fixture. Calls to
    `shape_link2` are synchronous (they fork tc commands) — we wrap them
    in an async function so callers can await alongside `collector.collect_for`.
    """
    last_time = 0.0
    for t, bw in schedule:
        delay = max(0.0, t - last_time)
        if delay > 0:
            await asyncio.sleep(delay)
        last_time = t
        shape_link2(net, bw_mbps=bw)


async def apply_stable(net, bw_mbps: float, duration_s: float = 60.0) -> None:
    await _apply_schedule(net, stable_schedule(bw_mbps, duration_s))


async def apply_step(
    net, initial_mbps: float, drop_mbps: float, drop_at_s: float, recover_at_s: float
) -> None:
    await _apply_schedule(net, step_schedule(initial_mbps, drop_mbps, drop_at_s, recover_at_s))


async def apply_sinusoidal(
    net, low_mbps: float, high_mbps: float, period_s: float, duration_s: float = 60.0
) -> None:
    await _apply_schedule(net, sinusoidal_schedule(low_mbps, high_mbps, period_s, duration_s))
