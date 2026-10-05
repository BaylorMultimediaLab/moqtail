import { describe, it, expect, vi } from 'vitest';
import { events } from '@/lib/events/EventLog';
import { AbrController } from '../AbrController';
import { AbrRulesCollection } from '../AbrRulesCollection';
import { DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrSettings, Track } from '../types';

// R4-D3: the envelope (EmergencyBufferRule's low branch) armed as soon as a
// frame was presented, while its window still held pre-roll zeros or less
// than bufferEnvelopeMs of history. On a live-edge client the first tick at a
// sawtooth trough then read as a drain, and the low branch fired once on the
// live-edge client only (20-24 of 288 simulated pairs in the second review).

const TRACKS: Track[] = [150, 200, 500, 1200, 4000].map(k => ({
  name: 'r' + k,
  bitrate: k * 1000,
}));

const minSettings = (): AbrSettings => ({
  ...DEFAULT_ABR_SETTINGS,
  rules: { ...DEFAULT_ABR_SETTINGS.rules },
  controller: { ...DEFAULT_ABR_SETTINGS.controller, arm: 'min' },
});

interface SimOptions {
  /** Contiguous buffer over the four ticks of a group (the per-group sawtooth). */
  saw: number[];
  mbps: number;
  startRung: number;
  /** Tick of the group boundary within the sawtooth. */
  phase: number;
  /** Ticks from a send to its landing. */
  land: number;
  /** Ticks before the first presented frame (totalFrames 0). */
  warmTicks: number;
  /** Buffer reported during the warm-up: 0 (pre-roll) or the sawtooth's peak. */
  warmBuffer: 'zero' | 'full';
  seconds: number;
}

/** Every decision the controller sends, as `tick:track:reason`. */
async function sim(o: SimOptions): Promise<string[]> {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const reasons: string[] = [];
  const spy = vi.spyOn(events, 'emit').mockImplementation((e: string, f?: unknown) => {
    if (e === 'ABR_DECISION') reasons.push(String((f as { reason: string }).reason));
  });
  try {
    let active = TRACKS[o.startRung]!.name;
    let frames = 0;
    let sampleCount = 0;
    const byTrack: Record<string, number> = {};
    const complete = (t: string) => {
      sampleCount++;
      byTrack[t] = (byTrack[t] ?? 0) + 1;
    };
    let buf = 0;
    let k = 0;
    const sent: string[] = [];
    const player = {
      lastSwitchSeq: null,
      getMetrics: () => ({
        bandwidthBps: o.mbps * 1e6,
        fastEmaBps: o.mbps * 1e6,
        slowEmaBps: o.mbps * 1e6,
        bufferSeconds: buf,
        bufferContigSeconds: buf,
        activeTrack: active,
        droppedFrames: 0,
        totalFrames: frames,
        playbackRate: 1,
        deliveryTimeMs: 50,
        lastObjectBytes: 8000,
        sampleCount,
        samplesByTrack: { ...byTrack },
        latencyTrendRatio: 1,
        lastLatencyMs: 0,
        playheadMs: k * 250,
        latestSeamPtsMs: null,
      }),
      switchTrack: vi.fn(async (t: string) => {
        sent.push(`${k}:${t}`);
        return null;
      }),
      setEmaHalfLives: vi.fn(),
      probeTrackBandwidth: vi.fn(async () => ({ bps: 0, dtMs: 0 })),
    };
    const s = minSettings();
    const c = new AbrController(player as never, new AbrRulesCollection(s), TRACKS, s, () => {});
    let pend: { track: string; at: number } | null = null;
    const peak = Math.max(...o.saw);
    for (k = 0; k < o.warmTicks + o.seconds * 4; k++) {
      const playing = k >= o.warmTicks;
      const groupTick = (k + o.phase) % 4 === 0;
      if (pend && k >= pend.at && groupTick) {
        const src = active;
        active = pend.track;
        c.onTrackSwitched(active);
        complete(src);
        pend = null;
      }
      if (groupTick) complete(active);
      buf = playing ? o.saw[(k + o.phase) % 4]! : o.warmBuffer === 'full' ? peak : 0;
      if (playing) frames += 7;
      const before = sent.length;
      await c._tick();
      if (sent.length > before) pend = { track: sent.at(-1)!.split(':')[1]!, at: k + o.land };
      vi.advanceTimersByTime(250);
    }
    return sent.map((x, i) => `${x}:${reasons[i] ?? '-'}`);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
}

const SAWS: Record<string, number[]> = {
  'trough 0.35': [1.1, 0.85, 0.6, 0.35],
  'trough 0.2': [1.0, 0.75, 0.45, 0.2],
};

describe('min arm: the envelope warms up after the first frame (R4-D3)', () => {
  for (const [warmTicks, warmBuffer] of [
    [8, 'zero'],
    [0, 'zero'],
    [8, 'full'],
  ] as const) {
    it(`warm-up ${warmTicks} ticks (${warmBuffer}): identical decisions on both client types`, async () => {
      const diffs: string[] = [];
      for (const [name, saw] of Object.entries(SAWS))
        for (const startRung of [0, 2, 4])
          for (const phase of [0, 1, 2, 3])
            for (const mbps of [0.6, 1.4, 5.0]) {
              const base = { mbps, startRung, phase, land: 1, warmTicks, warmBuffer, seconds: 20 };
              const live = await sim({ ...base, saw });
              const shifted = await sim({ ...base, saw: saw.map(x => x + 9) });
              if (JSON.stringify(live) !== JSON.stringify(shifted))
                diffs.push(
                  `${name} start=${startRung} ph=${phase} ${mbps}Mbps: live ${live.join(',')} | shifted ${shifted.join(',')}`,
                );
            }
      expect(diffs).toEqual([]);
    }, 60_000);
  }

  it('no low-branch emergency within bufferEnvelopeMs of the first frame, even at a trough', async () => {
    // Start at the top rung on 0.6 Mbps at a trough: before the fix the first
    // presented tick read the trough (or the pre-roll zeros) as a drain.
    const live = await sim({
      saw: SAWS['trough 0.35']!,
      mbps: 0.6,
      startRung: 4,
      phase: 3,
      land: 1,
      warmTicks: 8,
      warmBuffer: 'zero',
      seconds: 3,
    });
    expect(live.filter(d => d.endsWith('auto-emergency'))).toEqual([]);
  });
});
