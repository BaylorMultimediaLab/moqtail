"""Unit tests for bandwidth profile schedule generators.

We test the *schedule* (list of (time_offset_s, bw_mbps) tuples) rather than
running tc commands, so these are fast and don't need Mininet.
"""
import math

from profiles import step_schedule, sinusoidal_schedule, stable_schedule


def test_stable_schedule_single_tick():
    schedule = list(stable_schedule(bw_mbps=2.5, duration_s=10))
    assert schedule == [(0.0, 2.5)]


def test_step_schedule_three_ticks():
    schedule = list(step_schedule(initial_mbps=3.0, drop_mbps=0.5, drop_at_s=30, recover_at_s=45))
    assert schedule == [(0.0, 3.0), (30.0, 0.5), (45.0, 3.0)]


def test_sinusoidal_schedule_matches_sine():
    schedule = list(sinusoidal_schedule(low_mbps=0.6, high_mbps=3.0, period_s=60, duration_s=60, tick_s=1.0))
    assert len(schedule) == 60
    assert schedule[0][0] == 0.0
    midline = (0.6 + 3.0) / 2
    amplitude = (3.0 - 0.6) / 2
    expected_at_15s = midline + amplitude * math.sin(2 * math.pi * 15 / 60)
    actual_at_15s = next(bw for (t, bw) in schedule if t == 15.0)
    assert abs(actual_at_15s - expected_at_15s) < 0.01
