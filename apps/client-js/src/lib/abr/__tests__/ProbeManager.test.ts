import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProbeManager } from '../ProbeManager';

describe('ProbeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 before any probe completes', () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(0) };
    const pm = new ProbeManager(player);
    expect(pm.getFreshBandwidthBps()).toBe(0);
  });

  it('does not probe when trackName is null', () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(5_000_000) };
    const pm = new ProbeManager(player);
    pm.maybeProbe(null);
    expect(player.probeTrackBandwidth).not.toHaveBeenCalled();
  });

  it('fires a probe and stores the result', async () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(5_000_000) };
    const pm = new ProbeManager(player, { intervalMs: 2000, durationMs: 500 });

    pm.maybeProbe('720p');
    expect(player.probeTrackBandwidth).toHaveBeenCalledWith('720p', 500);

    await vi.runAllTimersAsync();
    expect(pm.getFreshBandwidthBps()).toBe(5_000_000);
  });

  it('throttles probes to at most one per intervalMs', async () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(5_000_000) };
    const pm = new ProbeManager(player, { intervalMs: 2000, durationMs: 500 });

    pm.maybeProbe('720p');
    await vi.runAllTimersAsync();
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(1);

    // Immediately call again — should NOT fire because intervalMs hasn't elapsed.
    pm.maybeProbe('720p');
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(1);

    // Advance just under intervalMs — still throttled.
    vi.advanceTimersByTime(1500);
    pm.maybeProbe('720p');
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(1);

    // Pass intervalMs — now eligible.
    vi.advanceTimersByTime(600);
    pm.maybeProbe('720p');
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(2);
  });

  it('does not double-fire while a probe is in flight', () => {
    let resolveFn: (n: number) => void = () => {};
    const player = {
      probeTrackBandwidth: vi.fn(() => new Promise<number>(r => (resolveFn = r))),
    };
    const pm = new ProbeManager(player, { intervalMs: 0 });

    pm.maybeProbe('720p');
    pm.maybeProbe('720p'); // second call before first resolves
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(1);

    resolveFn(3_000_000);
  });

  it('treats a stale probe result as 0 once freshnessMs elapses', async () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(5_000_000) };
    const pm = new ProbeManager(player, { freshnessMs: 1000 });

    pm.maybeProbe('720p');
    await vi.runAllTimersAsync();
    expect(pm.getFreshBandwidthBps()).toBe(5_000_000);

    vi.advanceTimersByTime(1500);
    expect(pm.getFreshBandwidthBps()).toBe(0);
  });

  it('does not overwrite the cache when a probe returns 0', async () => {
    const player = {
      probeTrackBandwidth: vi.fn().mockResolvedValueOnce(5_000_000).mockResolvedValueOnce(0),
    };
    const pm = new ProbeManager(player, { intervalMs: 0 });

    pm.maybeProbe('720p');
    await vi.runAllTimersAsync();
    expect(pm.getFreshBandwidthBps()).toBe(5_000_000);

    pm.maybeProbe('720p');
    await vi.runAllTimersAsync();
    // 0-result should not clobber the previous valid measurement.
    expect(pm.getFreshBandwidthBps()).toBe(5_000_000);
  });

  it('reset() clears state and re-enables immediate probing', async () => {
    const player = { probeTrackBandwidth: vi.fn().mockResolvedValue(5_000_000) };
    const pm = new ProbeManager(player, { intervalMs: 10_000 });

    pm.maybeProbe('720p');
    await vi.runAllTimersAsync();
    expect(pm.getFreshBandwidthBps()).toBe(5_000_000);

    pm.reset();
    expect(pm.getFreshBandwidthBps()).toBe(0);

    // Without reset, intervalMs (10s) would block this. After reset, eligible.
    pm.maybeProbe('720p');
    expect(player.probeTrackBandwidth).toHaveBeenCalledTimes(2);
  });
});
