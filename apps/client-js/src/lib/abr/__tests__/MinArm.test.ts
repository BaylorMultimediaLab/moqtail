import { describe, it, expect, vi, afterEach } from 'vitest';
import { events } from '@/lib/events/EventLog';
import { AbrController } from '../AbrController';
import { AbrRulesCollection } from '../AbrRulesCollection';
import {
  DEFAULT_ABR_SETTINGS,
  MIN_ARM_RULES,
  SwitchRequestPriority,
  resolveControllerSettings,
} from '../types';
import type { AbrSettings, ControllerSettings, Track } from '../types';

// ---------------------------------------------------------------------------
// The whole `min` configuration through _tick on synthetic inputs
// (docs/rebuild-2026-10-04.md, "Controller min (W5)").
// ---------------------------------------------------------------------------

const TRACKS: Track[] = [
  { name: '360p', bitrate: 500_000 },
  { name: '720p', bitrate: 1_500_000 },
  { name: '1080p', bitrate: 4_000_000 },
];

/** What the player reports at a tick. Everything the rules may see is explicit. */
interface Inputs {
  activeTrack: string;
  bandwidthBps: number;
  bufferContigSeconds: number;
  sampleCount: number;
  /** Total buffered-ahead (across holes); defaults to the contiguous value. */
  bufferSeconds?: number;
  /** 0 = nothing presented yet (startup). Defaults to an advancing counter. */
  totalFrames?: number;
  // Client-type-specific signals the min arm must ignore.
  targetShiftMs?: number;
  latencyTrendRatio?: number;
  latencyRecentMeanMs?: number;
  latencyOlderMeanMs?: number;
  lastLatencyMs?: number;
  playbackRate?: number;
}

function minSettings(overrides: Partial<ControllerSettings> = {}): AbrSettings {
  return {
    ...DEFAULT_ABR_SETTINGS,
    rules: { ...DEFAULT_ABR_SETTINGS.rules },
    controller: { ...DEFAULT_ABR_SETTINGS.controller, arm: 'min', ...overrides },
  };
}

function harness(initial: Inputs, settings: AbrSettings = minSettings()) {
  let current: Inputs = initial;
  let frames = 1000;
  const player = {
    getMetrics: vi.fn(() => {
      // Frames advance between calls so the switching guard's frame-advance
      // condition clears on the tick after a landing.
      frames += 7;
      const bw = current.bandwidthBps;
      return {
        bandwidthBps: bw,
        fastEmaBps: bw,
        slowEmaBps: bw,
        bufferSeconds: current.bufferSeconds ?? current.bufferContigSeconds,
        bufferContigSeconds: current.bufferContigSeconds,
        activeTrack: current.activeTrack,
        droppedFrames: 0,
        totalFrames: current.totalFrames ?? frames,
        playbackRate: current.playbackRate ?? 1,
        deliveryTimeMs: 50,
        lastObjectBytes: 8000,
        sampleCount: current.sampleCount,
        latencyTrendRatio: current.latencyTrendRatio ?? 1,
        lastLatencyMs: current.lastLatencyMs ?? 0,
        latencyRecentMeanMs: current.latencyRecentMeanMs,
        latencyOlderMeanMs: current.latencyOlderMeanMs,
        targetShiftMs: current.targetShiftMs,
      };
    }),
    switchTrack: vi.fn().mockResolvedValue(undefined),
    setEmaHalfLives: vi.fn(),
    probeTrackBandwidth: vi.fn().mockResolvedValue({ bps: 0, dtMs: 0 }),
  };
  const collection = new AbrRulesCollection(settings);
  const controller = new AbrController(player, collection, TRACKS, settings, () => {});
  const set = (i: Partial<Inputs>) => {
    current = { ...current, ...i };
  };
  const tick = async (i: Partial<Inputs> = {}) => {
    set(i);
    await controller._tick();
  };
  /** The player lands the switch: activeTrack flips, then onTrackSwitched. */
  const land = (track: string, i: Partial<Inputs> = {}) => {
    set({ ...i, activeTrack: track });
    controller.onTrackSwitched(track);
  };
  const switches = () => player.switchTrack.mock.calls.map(c => c[0] as string);
  /** Tick, and if a switch was sent, land it at once (same inputs). */
  const tickAndLand = async (i: Partial<Inputs> = {}) => {
    const before = player.switchTrack.mock.calls.length;
    await tick(i);
    const calls = player.switchTrack.mock.calls;
    if (calls.length > before) land(calls[calls.length - 1]![0] as string);
  };
  return { controller, player, collection, set, tick, land, switches, tickAndLand };
}

describe('min arm: configuration', () => {
  it('resolveControllerSettings turns on exactly ThroughputRule, EmergencyBufferRule and SwitchHistoryRule', () => {
    const r = resolveControllerSettings(minSettings());
    const active = Object.entries(r.rules)
      .filter(([, c]) => c.active)
      .map(([n]) => n)
      .sort();
    expect(active).toEqual([...MIN_ARM_RULES].sort());
    expect(r.rules.EmergencyBufferRule!.priority).toBe(SwitchRequestPriority.STRONG);
    expect(r.rules.ThroughputRule!.priority).toBe(SwitchRequestPriority.DEFAULT);
    expect(r.rules.SwitchHistoryRule!.priority).toBe(SwitchRequestPriority.DEFAULT);
  });

  it('pins the probe off, the envelope buffer signal, the 60 s veto history and the dwell as the up-guard', () => {
    const c = resolveControllerSettings(minSettings()).controller;
    expect(c.arm).toBe('min');
    expect(c.probeMode).toBe('off');
    expect(c.bufferSignal).toBe('envelope');
    expect(c.bufferEnvelopeMs).toBe(1250);
    expect(c.switchHistoryMode).toBe('veto');
    expect(c.switchHistoryWindowS).toBe(60);
    expect(c.upDwellGroups).toBe(3);
    expect(c.upGuardSamples).toBe(3);
    expect(c.upGuardRelease).toBe('landed');
    expect(c.historyIgnoreGroupsAfterLanding).toBe(2);
    expect(c.latencyResetOnLanding).toBe(false);
  });

  it("the min arm's own constants stay tunable", () => {
    const c = resolveControllerSettings(
      minSettings({
        upDwellGroups: 5,
        historyIgnoreGroupsAfterLanding: 1,
        switchHistoryWindowS: 30,
      }),
    ).controller;
    expect(c.upGuardSamples).toBe(5);
    expect(c.historyIgnoreGroupsAfterLanding).toBe(1);
    expect(c.switchHistoryWindowS).toBe(30);
  });

  it('leaves grid and baseline settings as given (only defaults filled in)', () => {
    const grid: AbrSettings = {
      ...DEFAULT_ABR_SETTINGS,
      controller: {
        ...DEFAULT_ABR_SETTINGS.controller,
        arm: 'grid',
        latencyResetOnLanding: true,
        bufferSignal: 'envelope',
        switchHistoryMode: 'veto',
        switchHistoryWindowS: 60,
        probeMaxBytes: 65_536,
      },
    };
    const r = resolveControllerSettings(grid);
    expect(r.rules).toEqual(grid.rules);
    expect(r.controller).toEqual(grid.controller);
    const base = resolveControllerSettings(DEFAULT_ABR_SETTINGS);
    expect(base.controller.arm).toBe('baseline');
    expect(base.rules).toEqual(DEFAULT_ABR_SETTINGS.rules);
  });

  it('never sends a probe and never engages BOLA (a 20 s buffer still climbs by throughput)', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 20,
      sampleCount: 10,
    });
    h.land('360p'); // startup landing at sample 10
    await h.tick({ sampleCount: 13 });
    expect(h.player.probeTrackBandwidth).not.toHaveBeenCalled();
    expect(h.switches()).toEqual(['1080p']);
  });

  it('the AbrRulesCollection built from the same settings runs only the min rules', () => {
    const collection = new AbrRulesCollection(minSettings());
    for (const name of [
      'BolaRule',
      'ProbeRule',
      'InsufficientBufferRule',
      'BufferDrainRateRule',
      'LatencyTrendRule',
      'AbandonRequestsRule',
      'DroppedFramesRule',
      'L2ARule',
      'LoLPRule',
    ]) {
      expect(collection.isRuleActive(name), name).toBe(false);
    }
    for (const name of MIN_ARM_RULES) expect(collection.isRuleActive(name), name).toBe(true);
  });
});

describe('min arm: (a) up-switch dwell', () => {
  it('no up-switch before 3 completed groups after landing', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 5,
      sampleCount: 10,
    });
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    // Landed on 720p at sample 10; the link now reads 10 Mbps.
    h.land('720p', { bandwidthBps: 10_000_000 });
    for (const sampleCount of [10, 11, 12]) {
      await h.tick({ sampleCount });
      expect(h.switches(), `sample ${sampleCount}`).toEqual(['720p']);
    }
    await h.tick({ sampleCount: 13 });
    expect(h.switches()).toEqual(['720p', '1080p']);
  });

  it('a down-switch is never held by the dwell', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 5,
      sampleCount: 10,
    });
    await h.tick();
    h.land('720p', { bandwidthBps: 700_000 });
    await h.tick({ sampleCount: 10 });
    expect(h.switches()).toEqual(['720p', '360p']);
  });
});

describe('min arm: (b) a one-group hole right after landing', () => {
  it('a buffer dip that stays above 0.5 s and a missing sample produce no switch (time-shifted and live-edge shapes)', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 9,
      sampleCount: 10,
    });
    await h.tick();
    h.land('720p');
    // Time-shifted: the group after the seam is missing; contiguous buffer
    // reads 9 -> 8 -> 9 while no sample completes.
    for (const bufferContigSeconds of [9, 8, 8, 9]) {
      await h.tick({ bufferContigSeconds, sampleCount: 10 });
    }
    // Live-edge: 1.0 -> 0.75 -> 0.55 -> 1.0.
    for (const bufferContigSeconds of [1.0, 0.75, 0.55, 1.0]) {
      await h.tick({ bufferContigSeconds, sampleCount: 11 });
    }
    expect(h.switches()).toEqual(['720p']);
    expect(h.controller.getHistory()).toHaveLength(1);
  });

  it('a seam hole that empties the live-edge buffer is a stamped emergency, not a history drop: the client climbs back after the dwell with no veto', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 1,
      sampleCount: 10,
    });
    await h.tick();
    h.land('720p');
    // One group after landing the hole reaches the playhead.
    await h.tick({ bufferContigSeconds: 0, sampleCount: 11 });
    expect(h.switches()).toEqual(['720p', '360p']);
    h.land('360p', { bufferContigSeconds: 1 });
    const drop = h.controller.getHistory()[1]!;
    expect(drop.reason).toBe('auto-emergency');
    expect(drop.groupsSinceLanding).toBe(1);
    // Dwell: 3 groups on 360p, then the throughput rule may climb again and
    // SwitchHistoryRule does not hold 720p against the seam drop.
    for (const sampleCount of [11, 12, 13]) {
      await h.tick({ sampleCount });
      expect(h.switches()).toEqual(['720p', '360p']);
    }
    await h.tick({ sampleCount: 14 });
    expect(h.switches()).toEqual(['720p', '360p', '720p']);
  });
});

describe('min arm: (c) emergency on the instantaneous contiguous buffer', () => {
  it('buffer empty -> rung 0 at STRONG, recorded as auto-emergency', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 0,
      sampleCount: 10,
    });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
    h.land('360p');
    expect(h.controller.getHistory()[0]!.reason).toBe('auto-emergency');
  });

  it('buffer below 0.5 s -> highest rung under 0.7 x SWMA', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 2_000_000, // 0.7 x 2 = 1.4 Mbps: only 360p fits
      bufferContigSeconds: 0.3,
      sampleCount: 10,
    });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
  });

  it('buffer below 0.5 s never climbs, whatever the throughput rule wants', async () => {
    const h = harness({
      activeTrack: '720p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 0.3,
      sampleCount: 10,
    });
    h.land('720p');
    await h.tick({ sampleCount: 20 });
    expect(h.switches()).toEqual([]);
  });

  it('uses the instantaneous value: an envelope of 1 s does not mask an empty buffer', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 1.0,
      sampleCount: 10,
    });
    await h.tick();
    await h.tick({ bufferContigSeconds: 0 });
    expect(h.switches()).toEqual(['360p']);
  });

  it('the total buffer across holes is not the signal: a hole ahead of the playhead with 10 s behind it still reads empty', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 0,
      bufferSeconds: 10,
      sampleCount: 10,
    });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
  });

  it('abstains before the first frame is presented (startup, nothing to stall)', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 0,
      sampleCount: 10,
      totalFrames: 0,
    });
    await h.tick();
    expect(h.switches()).toEqual([]);
  });
});

describe('min arm: (d) A->B->A under an oscillating SWMA', () => {
  // The SWMA alternates per group between a value that fits 1080p and one
  // that fits only 360p. Without a dwell every group flips the rung; with the
  // dwell an up-switch needs 3 completed groups on the current rung after the
  // last landing, so the loop runs at most once per 4 groups.
  const run = async (settings: AbrSettings) => {
    const h = harness(
      { activeTrack: '360p', bandwidthBps: 1_000_000, bufferContigSeconds: 5, sampleCount: 10 },
      settings,
    );
    h.land('360p'); // startup landing at sample 10
    for (let g = 1; g <= 24; g++) {
      await h.tickAndLand({ sampleCount: 10 + g, bandwidthBps: g % 2 ? 10_000_000 : 1_000_000 });
    }
    return h;
  };

  it('the dwell halves the switch rate and every up-switch is at least 3 groups after a landing', async () => {
    const withDwell = await run(minSettings());
    const noDwell = await run(minSettings({ upDwellGroups: 0 }));
    expect(noDwell.switches().length).toBeGreaterThanOrEqual(20);
    expect(withDwell.switches().length).toBeLessThanOrEqual(12);
    const ups = withDwell.controller.getHistory().filter(e => e.reason === 'auto-upgrade');
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups) expect(up.groupsSinceLanding).toBeGreaterThanOrEqual(3);
  });
});

describe('min arm: (e) client-type neutrality', () => {
  it('a 0.1 s and a 10 s shift client take identical decisions on identical throughput and contiguous-buffer inputs', async () => {
    const steps: Array<Pick<Inputs, 'bandwidthBps' | 'bufferContigSeconds' | 'sampleCount'>> = [];
    let sc = 10;
    const push = (bandwidthBps: number, bufferContigSeconds: number, n: number) => {
      for (let i = 0; i < n; i++)
        steps.push({ bandwidthBps, bufferContigSeconds, sampleCount: ++sc });
    };
    push(10_000_000, 5, 5); // climb
    push(1_200_000, 5, 3); // link drops: 0.9 x 1.2 fits only 360p
    push(1_200_000, 0.2, 2); // and the buffer runs low
    push(1_200_000, 0, 1); // empty
    push(10_000_000, 5, 8); // link restored: climb after the dwell
    push(2_000_000, 5, 4); // settle on 720p

    const clients = {
      liveEdge: {
        targetShiftMs: 100,
        latencyTrendRatio: 1.45,
        latencyOlderMeanMs: 100,
        latencyRecentMeanMs: 145,
        lastLatencyMs: 150,
        playbackRate: 1.05,
      },
      shifted: {
        targetShiftMs: 10_000,
        latencyTrendRatio: 1.0,
        latencyOlderMeanMs: 10_100,
        latencyRecentMeanMs: 10_100,
        lastLatencyMs: 10_100,
        playbackRate: 0.95,
      },
    };
    const traces: Record<string, string[]> = {};
    for (const [name, client] of Object.entries(clients)) {
      const h = harness({
        activeTrack: '360p',
        bandwidthBps: 1_000_000,
        bufferContigSeconds: 5,
        sampleCount: 10,
        // A time-shifted client has more total buffer than contiguous when a
        // hole exists; the rules must not see it.
        bufferSeconds: name === 'shifted' ? 10 : undefined,
        ...client,
      });
      h.land('360p');
      const trace: string[] = [];
      for (const [i, step] of steps.entries()) {
        const before = h.switches().length;
        await h.tickAndLand(step);
        if (h.switches().length > before) trace.push(`${i}:${h.switches().at(-1)}`);
      }
      traces[name] = trace;
    }
    expect(traces.liveEdge).toEqual(traces.shifted);
    expect(traces.liveEdge!.length).toBeGreaterThanOrEqual(3);
    expect(traces.liveEdge!.some(s => s.endsWith('1080p'))).toBe(true);
    expect(traces.liveEdge!.some(s => s.endsWith('360p'))).toBe(true);
  });
});

describe('min arm: (f) a phantom switch is not history', () => {
  afterEach(() => vi.restoreAllMocks());

  it('SWITCH_SKIPPED / SWITCH_ERROR (callback with the old track) leaves history and ABR_DECISION untouched', async () => {
    const emit = vi.spyOn(events, 'emit');
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 5,
      sampleCount: 10,
    });
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    h.controller.onTrackSwitched('360p');
    expect(h.controller.getHistory()).toHaveLength(0);
    expect(emit.mock.calls.filter(c => c[0] === 'ABR_DECISION')).toHaveLength(0);
    expect(emit.mock.calls.filter(c => c[0] === 'ABR_SWITCH_PHANTOM')).toHaveLength(1);
  });
});
