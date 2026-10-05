import { describe, it, expect, vi, afterEach } from 'vitest';
import { events } from '@/lib/events/EventLog';
import { AbrController } from '../AbrController';
import { AbrRulesCollection } from '../AbrRulesCollection';
import {
  DEFAULT_ABR_SETTINGS,
  MIN_ARM_RULES,
  RULE_ORDER,
  SwitchRequestPriority,
  describeController,
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

/** What the player reports at a tick, apart from the sample counters. */
interface Inputs {
  activeTrack: string;
  bandwidthBps: number;
  bufferContigSeconds: number;
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
  /** Playhead (ms) and the seam whose region it has entered (player.getMetrics, F2). */
  playheadMs?: number;
  latestSeamPtsMs?: number | null;
}

interface HarnessOptions {
  settings?: AbrSettings;
  /** The player exposes samplesByTrack (default true). */
  byTrack?: boolean;
  /**
   * The landing object finalises the source's last group *after* the player
   * called back (the harness player's order, default true): the first sample
   * after a landing belongs to the old track.
   */
  finalizeAfterLanding?: boolean;
  /** Groups completed on the startup track before the first tick (past slow start). */
  startupGroups?: number;
}

function minSettings(overrides: Partial<ControllerSettings> = {}): AbrSettings {
  return {
    ...DEFAULT_ABR_SETTINGS,
    rules: { ...DEFAULT_ABR_SETTINGS.rules },
    controller: { ...DEFAULT_ABR_SETTINGS.controller, arm: 'min', ...overrides },
  };
}

function harness(initial: Inputs, opts: HarnessOptions = {}) {
  const settings = opts.settings ?? minSettings();
  const exposeByTrack = opts.byTrack ?? true;
  const finalizeAfterLanding = opts.finalizeAfterLanding ?? true;
  let current: Inputs = initial;
  let frames = 1000;
  let sampleCount = 0;
  const byTrack: Record<string, number> = {};
  /** n groups of `track` (default: the active one) complete. */
  const complete = (n = 1, track = current.activeTrack) => {
    sampleCount += n;
    byTrack[track] = (byTrack[track] ?? 0) + n;
  };
  complete(opts.startupGroups ?? 10);

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
        sampleCount,
        samplesByTrack: exposeByTrack ? { ...byTrack } : undefined,
        latencyTrendRatio: current.latencyTrendRatio ?? 1,
        lastLatencyMs: current.lastLatencyMs ?? 0,
        latencyRecentMeanMs: current.latencyRecentMeanMs,
        latencyOlderMeanMs: current.latencyOlderMeanMs,
        targetShiftMs: current.targetShiftMs,
        playheadMs: current.playheadMs,
        latestSeamPtsMs: current.latestSeamPtsMs,
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
  /**
   * The player lands the switch: activeTrack flips, onTrackSwitched(track),
   * then the landing object closes the source's last group.
   */
  const land = (track: string, i: Partial<Inputs> = {}) => {
    const source = current.activeTrack;
    if (!finalizeAfterLanding) complete(1, source);
    set({ ...i, activeTrack: track });
    controller.onTrackSwitched(track);
    if (finalizeAfterLanding) complete(1, source);
  };
  const switches = () => player.switchTrack.mock.calls.map(c => c[0] as string);
  /** Tick, and if a switch was sent, land it at once. */
  const tickAndLand = async (i: Partial<Inputs> = {}) => {
    const before = player.switchTrack.mock.calls.length;
    await tick(i);
    const calls = player.switchTrack.mock.calls;
    if (calls.length > before) land(calls[calls.length - 1]![0] as string);
  };
  return { controller, player, collection, set, tick, land, complete, switches, tickAndLand };
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
    expect(r.rules.ThroughputRule!.parameters.downToLowest).toBe(1);
    expect(r.rules.SwitchHistoryRule!.priority).toBe(SwitchRequestPriority.DEFAULT);
  });

  it('pins the probe off, the envelope buffer signal and the 60 s veto history; the dwell is its own gate', () => {
    const c = resolveControllerSettings(minSettings()).controller;
    expect(c.arm).toBe('min');
    expect(c.probeMode).toBe('off');
    expect(c.bufferSignal).toBe('envelope');
    expect(c.bufferEnvelopeMs).toBe(1250);
    expect(c.switchHistoryMode).toBe('veto');
    expect(c.switchHistoryWindowS).toBe(60);
    expect(c.upDwellGroups).toBe(3);
    expect(c.upGuardSamples).toBe(0);
    expect(c.historyIgnoreGroupsAfterLanding).toBe(2);
    expect(c.latencyResetOnLanding).toBe(false);
    // Pinned whatever the caller passes.
    const forced = resolveControllerSettings(
      minSettings({ probeMode: 'on', bufferSignal: 'instant', upGuardSamples: 4 }),
    ).controller;
    expect(forced.probeMode).toBe('off');
    expect(forced.bufferSignal).toBe('envelope');
    expect(forced.upGuardSamples).toBe(0);
  });

  it("the min arm's own constants stay tunable", () => {
    const c = resolveControllerSettings(
      minSettings({
        upDwellGroups: 5,
        historyIgnoreGroupsAfterLanding: 1,
        switchHistoryWindowS: 30,
      }),
    ).controller;
    expect(c.upDwellGroups).toBe(5);
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
    const h = harness({ activeTrack: '360p', bandwidthBps: 10_000_000, bufferContigSeconds: 20 });
    await h.tick();
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

describe('min arm: ThroughputRule goes down to rung 0 when nothing fits', () => {
  it('a SWMA below the lowest rung is a down-switch, not an abstention that waits for the buffer', async () => {
    const h = harness({ activeTrack: '1080p', bandwidthBps: 300_000, bufferContigSeconds: 8 });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
    h.land('360p');
    expect(h.controller.getHistory()[0]!.reason).toBe('auto-downgrade');
  });
});

describe('min arm: (a) up-switch dwell', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no up-switch before 3 completed groups of the landed track after landing', async () => {
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    // Landed on 720p; the link now reads 10 Mbps.
    h.land('720p', { bandwidthBps: 10_000_000 });
    for (let groups = 0; groups < 3; groups++) {
      await h.tick();
      expect(h.switches(), `${groups} groups`).toEqual(['720p']);
      h.complete();
    }
    await h.tick();
    expect(h.switches()).toEqual(['720p', '1080p']);
    const gated = emit.mock.calls
      .filter(c => c[0] === 'ABR_GATED')
      .map(c => c[1] as Record<string, unknown>);
    expect(gated.map(g => g.why)).toEqual(['up-dwell', 'up-dwell', 'up-dwell']);
    expect(gated.map(g => g.groups_since_landing)).toEqual([0, 1, 2]);
  });

  it("the source's last group, closed by the landing object, is not a group of the new rung", async () => {
    // After the landing the total sample count has moved by 1 (the old
    // track's group) + 2 (the new track's): three samples, two groups of 720p.
    for (const byTrack of [true, false]) {
      const h = harness(
        { activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 },
        { byTrack },
      );
      await h.tick();
      h.land('720p', { bandwidthBps: 10_000_000 });
      h.complete(2);
      await h.tick();
      expect(h.switches(), `byTrack=${byTrack}`).toEqual(['720p']);
      h.complete();
      await h.tick();
      expect(h.switches(), `byTrack=${byTrack}`).toEqual(['720p', '1080p']);
    }
  });

  it('without samplesByTrack, on a player that closes the source group before calling back, the dwell errs by one group too many, never too few', async () => {
    const h = harness(
      { activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 },
      { byTrack: false, finalizeAfterLanding: false },
    );
    await h.tick();
    h.land('720p', { bandwidthBps: 10_000_000 });
    h.complete(3);
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    h.complete();
    await h.tick();
    expect(h.switches()).toEqual(['720p', '1080p']);
  });

  it('a down-switch is never held by the dwell', async () => {
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    h.land('720p', { bandwidthBps: 700_000 });
    await h.tick();
    expect(h.switches()).toEqual(['720p', '360p']);
  });
});

describe('min arm: (b) a one-group hole right after landing', () => {
  it('produces no down-switch: the contiguous buffer dips but stays above 0.5 s and no sample completes (time-shifted and live-edge shapes)', async () => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 9,
      bufferSeconds: 9,
    });
    await h.tick();
    h.land('720p');
    // Time-shifted: the group after the seam is missing; the contiguous
    // buffer reads 9 -> 8 -> 9 while the total keeps the data behind the hole.
    for (const bufferContigSeconds of [9, 8.5, 8, 8, 9]) {
      await h.tick({ bufferContigSeconds, bufferSeconds: 10 });
    }
    // Live-edge: 1.0 -> 0.75 -> 0.55 -> 1.0 with 2 s in total behind the hole.
    for (const bufferContigSeconds of [1.0, 0.75, 0.55, 1.0]) {
      await h.tick({ bufferContigSeconds, bufferSeconds: 2 });
    }
    expect(h.switches()).toEqual(['720p']);
    expect(h.controller.getHistory()).toHaveLength(1);
  });

  it('without seam metrics (legacy player) a seam drop within 2 groups of the landing is not a history drop: repeated seam emergencies never let the veto cap the rung', async () => {
    // Each cycle: climb to 720p after the dwell, then one group after the
    // landing the seam hole empties a live-edge buffer and the emergency
    // sends the client to 360p. With the seam window (2 groups) the history
    // never holds 720p; counting those drops (window 0) the veto caps it once
    // 8 events are on record (4 ups, 4 drops).
    const cycles = async (historyIgnoreGroupsAfterLanding: number) => {
      const h = harness(
        { activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 1 },
        { settings: minSettings({ historyIgnoreGroupsAfterLanding }) },
      );
      for (let c = 0; c < 6; c++) {
        await h.tickAndLand({ bufferContigSeconds: 1 }); // up to 720p if allowed
        h.complete();
        await h.tickAndLand({ bufferContigSeconds: 0 }); // seam hole: emergency
        await h.tick({ bufferContigSeconds: 1 });
        h.complete(3); // dwell on whatever rung we are on
      }
      return h;
    };
    const ignored = await cycles(2);
    const counted = await cycles(0);
    const ups = (h: Awaited<ReturnType<typeof cycles>>) =>
      h.controller.getHistory().filter(e => e.reason === 'auto-upgrade').length;
    expect(ups(ignored)).toBe(6);
    const drops = ignored.controller.getHistory().filter(e => e.reason === 'auto-emergency');
    expect(drops).toHaveLength(6);
    for (const d of drops) expect(d.groupsSinceLanding).toBe(1);
    expect(ups(counted)).toBe(4);
  });
});

describe('min arm: (c) emergency on the instantaneous contiguous buffer', () => {
  it('buffer empty -> rung 0 at STRONG, recorded as auto-emergency', async () => {
    const h = harness({ activeTrack: '1080p', bandwidthBps: 10_000_000, bufferContigSeconds: 0 });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
    h.land('360p');
    expect(h.controller.getHistory()[0]!.reason).toBe('auto-emergency');
  });

  it('buffer below 0.5 s -> highest rung under 0.7 x SWMA, over the throughput rule', async () => {
    // ThroughputRule: 0.9 x 2 Mbps = 1.8 -> 720p; the emergency: 0.7 x 2 =
    // 1.4 -> 360p at STRONG.
    const h = harness({ activeTrack: '1080p', bandwidthBps: 2_000_000, bufferContigSeconds: 0.3 });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
  });

  it('a low buffer is not an up-switch gate: with a healthy SWMA the throughput rule still climbs after the dwell', async () => {
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    h.land('720p', { bandwidthBps: 10_000_000 });
    h.complete(3);
    // Live-edge sawtooth at its low point.
    await h.tick({ bufferContigSeconds: 0.3 });
    expect(h.switches()).toEqual(['720p', '1080p']);
  });

  it('uses the instantaneous value: an envelope of 1 s does not mask an empty buffer', async () => {
    const h = harness({ activeTrack: '1080p', bandwidthBps: 10_000_000, bufferContigSeconds: 1.0 });
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
    });
    await h.tick();
    expect(h.switches()).toEqual(['360p']);
  });

  it('abstains before the first frame is presented (startup, nothing to stall)', async () => {
    const h = harness({
      activeTrack: '1080p',
      bandwidthBps: 10_000_000,
      bufferContigSeconds: 0,
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
  // last landing.
  const run = async (settings: AbrSettings) => {
    const h = harness(
      { activeTrack: '360p', bandwidthBps: 1_000_000, bufferContigSeconds: 5 },
      { settings },
    );
    for (let g = 1; g <= 24; g++) {
      h.complete();
      await h.tickAndLand({ bandwidthBps: g % 2 ? 10_000_000 : 1_000_000 });
    }
    return h;
  };

  it('the dwell suppresses the reversals and every up-switch is at least 3 groups after a landing', async () => {
    const withDwell = await run(minSettings());
    const noDwell = await run(minSettings({ upDwellGroups: 0 }));
    expect(noDwell.switches().length).toBeGreaterThanOrEqual(20);
    expect(withDwell.switches().length).toBeLessThanOrEqual(12);
    const ups = withDwell.controller.getHistory().filter(e => e.reason === 'auto-upgrade');
    expect(ups.length).toBeGreaterThan(0);
    for (const up of ups.slice(1)) expect(up.groupsSinceLanding).toBeGreaterThanOrEqual(3);
  });
});

describe('min arm: (e) client-type neutrality', () => {
  it('a 0.1 s and a 10 s shift client take identical decisions on identical throughput and contiguous-buffer inputs', async () => {
    const steps: Array<Pick<Inputs, 'bandwidthBps' | 'bufferContigSeconds'>> = [];
    const push = (bandwidthBps: number, bufferContigSeconds: number, n: number) => {
      for (let i = 0; i < n; i++) steps.push({ bandwidthBps, bufferContigSeconds });
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
        // A time-shifted client has more total buffer than contiguous when a
        // hole exists; the rules must not see it.
        bufferSeconds: name === 'shifted' ? 10 : undefined,
        ...client,
      });
      const trace: string[] = [];
      for (const [i, step] of steps.entries()) {
        const before = h.switches().length;
        h.complete();
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

  it('SWITCH_SKIPPED / SWITCH_ERROR (callback with the old track) leaves history, ABR_DECISION and the dwell clock untouched', async () => {
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    h.controller.onTrackSwitched('360p');
    expect(h.controller.getHistory()).toHaveLength(0);
    expect(emit.mock.calls.filter(c => c[0] === 'ABR_DECISION')).toHaveLength(0);
    expect(emit.mock.calls.filter(c => c[0] === 'ABR_SWITCH_PHANTOM')).toHaveLength(1);
    // Not a landing: no dwell started, the next tick may send the switch again.
    await h.tick();
    expect(h.switches()).toEqual(['720p', '720p']);
  });
});

function gridSettings(): AbrSettings {
  return {
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
}

describe('(g) probe veto (grid arm, M18)', () => {
  // 10 Mbps SWMA: ThroughputRule and InsufficientBufferRule want 1080p from
  // 360p. The probe fires on the first tick (slow start holds the decision),
  // its reading lands before the next one.
  const climb = async (probeBps: number) => {
    const h = harness(
      { activeTrack: '360p', bandwidthBps: 10_000_000, bufferContigSeconds: 5 },
      { settings: gridSettings(), startupGroups: 1 },
    );
    h.player.probeTrackBandwidth.mockResolvedValue({ bps: probeBps, dtMs: 400 });
    await h.tick(); // slow start (1 sample); probe sent
    await Promise.resolve();
    await Promise.resolve();
    expect(h.player.probeTrackBandwidth).toHaveBeenCalledTimes(1);
    expect(h.player.probeTrackBandwidth.mock.calls[0]![0]).toMatch(/^\.probe:\d+:0$/);
    h.complete(5);
    for (let i = 0; i < 3; i++) await h.tick(); // past InsufficientBufferRule's warm-up
    return h.switches();
  };

  it('a fresh probe without headroom for the next rung (0.8 x 1 Mbps < 1.5 Mbps) holds the active rung', async () => {
    expect(await climb(1_000_000)).toEqual([]);
  });

  it('a fresh probe with headroom abstains and lets the throughput rule climb several rungs', async () => {
    expect(await climb(10_000_000)).toEqual(['1080p']);
  });

  it('no reading (failed probe) is no veto', async () => {
    expect(await climb(0)).toEqual(['1080p']);
  });

  it('the min arm never probes', async () => {
    const h = harness({ activeTrack: '360p', bandwidthBps: 10_000_000, bufferContigSeconds: 5 });
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.player.probeTrackBandwidth).not.toHaveBeenCalled();
  });
});

describe('(h) describeController for the min arm', () => {
  it('describes what the controller and the collection built from the same settings run', () => {
    const h = harness({ activeTrack: '360p', bandwidthBps: 1_000_000, bufferContigSeconds: 5 });
    const d = describeController(minSettings());
    // Idempotent over the resolved settings the controller runs.
    expect(describeController(h.controller.settings)).toEqual(d);
    expect(d.activeRules).toEqual(RULE_ORDER.filter(n => h.collection.isRuleActive(n)));
    expect(d).toMatchObject({
      arm: 'min',
      tickMs: 250,
      upDwellGroups: 3,
      historyIgnoreGroupsAfterLanding: 2,
      switchHistoryMode: 'veto',
      switchHistoryWindowS: 60,
      bufferSource: 'contiguous',
      bufferSignal: 'envelope',
      bufferEnvelopeMs: 1250,
      bandwidthSafetyFactor: 0.9,
      throughputDownToLowest: true,
      emergencyLowBufferS: 0.5,
      emergencyThroughputSafetyFactor: 0.7,
      probeMode: 'off',
      upGuardSamples: 0,
      latencyResetOnLanding: false,
    });
  });
});

describe('grid and baseline keep the total buffer (only min reads the contiguous one)', () => {
  it('grid: a hole ahead of the playhead with 5 s behind it is still 5 s of buffer to its rules', async () => {
    const h = harness(
      { activeTrack: '1080p', bandwidthBps: 10_000_000, bufferContigSeconds: 0, bufferSeconds: 5 },
      { settings: gridSettings() },
    );
    // InsufficientBufferRule's two warm-up calls, then it would read 0 as
    // "empty" (STRONG rung 0) if it saw the contiguous buffer.
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.switches()).toEqual([]);
  });
});

describe('min arm: (i) the live-edge sawtooth is not an emergency (F1)', () => {
  // A live-edge client's contiguous buffer is a per-group sawtooth: each group
  // lands as a burst (1.1 s ahead) and drains to its trough (0.35 s or 0.2 s)
  // before the next one. A time-shifted client sees the same sawtooth 9 s
  // higher. With a SWMA that fits the active rung by 0.9 but not by 0.7, the
  // low-buffer branch fired at every trough on the live-edge client only.
  const sim = async (saw: number[], swma: number, seconds: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const h = harness(
        { activeTrack: '720p', bandwidthBps: swma, bufferContigSeconds: saw[0]! },
        { startupGroups: 10 },
      );
      for (let k = 0; k < seconds * 4; k++) {
        if (k % 4 === 0) {
          // A group completes on the group boundary; a pending switch lands on it.
          const calls = h.player.switchTrack.mock.calls;
          const target = calls.length > 0 ? (calls[calls.length - 1]![0] as string) : null;
          if (target !== null && h.controller.isSwitching()) h.land(target);
          h.complete();
        }
        await h.tick({ bufferContigSeconds: saw[k % 4]! });
        vi.advanceTimersByTime(250);
      }
      return h.switches().length;
    } finally {
      vi.useRealTimers();
    }
  };

  it('SWMA 2.0 Mbps (720p fits by 0.9, not by 0.7): at most 2 switches in 120 s on either client type', async () => {
    const live = await sim([1.1, 0.85, 0.6, 0.35], 2_000_000, 120);
    const shifted = await sim([10.1, 9.85, 9.6, 9.35], 2_000_000, 120);
    expect(live).toBeLessThanOrEqual(2);
    expect(shifted).toBeLessThanOrEqual(2);
    expect(live).toBe(shifted);
  });

  it('trough 0.2 s, SWMA 1.9 Mbps: at most 2 switches in 120 s on either client type', async () => {
    const live = await sim([1.0, 0.75, 0.45, 0.2], 1_900_000, 120);
    const shifted = await sim([10.0, 9.75, 9.45, 9.2], 1_900_000, 120);
    expect(live).toBeLessThanOrEqual(2);
    expect(shifted).toBeLessThanOrEqual(2);
  });

  it('a real drain (below 0.5 s for the whole 1250 ms envelope) still drops to the 0.7 x SWMA rung', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const h = harness({ activeTrack: '720p', bandwidthBps: 2_000_000, bufferContigSeconds: 1.0 });
      await h.tick();
      vi.advanceTimersByTime(250);
      for (const b of [0.48, 0.45, 0.42, 0.39, 0.36]) {
        await h.tick({ bufferContigSeconds: b });
        vi.advanceTimersByTime(250);
      }
      // 1.0 s left the 1250 ms window only on the last tick.
      expect(h.switches()).toEqual([]);
      await h.tick({ bufferContigSeconds: 0.33 });
      expect(h.switches()).toEqual(['360p']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('min arm: (j) the history exemption is anchored at the presented seam (F2)', () => {
  // A seam hole reaches the playhead about one group after the landing on a
  // live-edge client and about shift / GOP groups after it on a time-shifted
  // one. The exemption must cover the drop the hole causes on both, and no
  // drop anywhere else on either.
  const cycles = async (shiftGroups: number, dropAt: 'hole' | 'elsewhere') => {
    const h = harness({
      activeTrack: '360p',
      bandwidthBps: 2_000_000,
      bufferContigSeconds: 1 + shiftGroups,
      playheadMs: 100_000,
      latestSeamPtsMs: null,
    });
    let playhead = 100_000;
    let presentedSeam: number | null = null;
    for (let c = 0; c < 6; c++) {
      // Up to 720p; its seam lies one shift ahead of the playhead.
      await h.tickAndLand({ playheadMs: playhead, latestSeamPtsMs: presentedSeam });
      const seam = playhead + shiftGroups * 1000;
      // The playhead plays the source media up to the seam.
      for (let g = 0; g < shiftGroups; g++) {
        h.complete();
        playhead += 1000;
      }
      if (dropAt === 'hole') {
        // The playhead sits at the hole in front of the seam: empty buffer.
        presentedSeam = seam;
        await h.tickAndLand({
          bufferContigSeconds: 0,
          playheadMs: seam - 20,
          latestSeamPtsMs: presentedSeam,
        });
      } else {
        // An ordinary drop, 5 s of media away from any seam.
        await h.tickAndLand({
          bufferContigSeconds: 0,
          playheadMs: seam - 5_000,
          latestSeamPtsMs: presentedSeam,
        });
      }
      playhead = seam + 5_000;
      await h.tick({ bufferContigSeconds: 1 + shiftGroups, playheadMs: playhead });
      h.complete(3); // dwell
    }
    return h;
  };
  const ups = (h: Awaited<ReturnType<typeof cycles>>) =>
    h.controller.getHistory().filter(e => e.reason === 'auto-upgrade').length;

  it('a hole-induced drop is exempt on both client types (the veto never caps 720p)', async () => {
    const live = await cycles(1, 'hole');
    const shifted = await cycles(10, 'hole');
    expect(ups(live)).toBe(6);
    expect(ups(shifted)).toBe(6);
    for (const h of [live, shifted]) {
      const drops = h.controller.getHistory().filter(e => e.reason === 'auto-emergency');
      expect(drops).toHaveLength(6);
      for (const d of drops) expect(d.msPastSeam).toBe(-20);
    }
  });

  it('an ordinary drop is counted on both client types (the veto caps 720p after 8 events)', async () => {
    const live = await cycles(1, 'elsewhere');
    const shifted = await cycles(10, 'elsewhere');
    expect(ups(live)).toBe(4);
    expect(ups(shifted)).toBe(4);
  });
});

describe('min arm: (k) a switch that lands after its guard timed out (F7)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes history and ABR_DECISION when it lands, even after a later decision was refused', async () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    expect(h.switches()).toEqual(['720p']);
    // The guard times out (3 s) and the cool-down (5 s) passes without a landing.
    vi.advanceTimersByTime(3_100);
    await h.tick();
    vi.advanceTimersByTime(5_100);
    // A new decision (the link rose) while 720p is still in flight ...
    await h.tick({ bandwidthBps: 10_000_000 });
    expect(h.switches()).toEqual(['720p', '1080p']);
    // ... which the player skips (previous switch not landed): a phantom.
    h.controller.onTrackSwitched('360p');
    // Then the first switch lands.
    h.land('720p');
    const history = h.controller.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromTrack: '360p', toTrack: '720p' });
    const decisions = emit.mock.calls.filter(c => c[0] === 'ABR_DECISION');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]![1]).toMatchObject({ from: '360p', to: '720p' });
    const phantoms = emit.mock.calls.filter(c => c[0] === 'ABR_SWITCH_PHANTOM');
    expect(phantoms.map(c => (c[1] as Record<string, unknown>).to)).toEqual(['1080p']);
  });
});

describe('min arm: (l) ABR_DECISION and ABR_SWITCH_PHANTOM carry the switch_seq (F14)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A player that numbers its switches like Player.switchTrack (lastSwitchSeq, resolved seq). */
  const numbered = (h: ReturnType<typeof harness>, first = 41) => {
    let n = first;
    const p = h.player as unknown as { lastSwitchSeq: number | null };
    p.lastSwitchSeq = null;
    h.player.switchTrack.mockImplementation(async () => {
      p.lastSwitchSeq = ++n;
      return n;
    });
  };

  it('the landing decision and the phantom name the seq of the switch they decided', async () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    numbered(h);
    await h.tick(); // seq 42: 360p -> 720p
    vi.advanceTimersByTime(3_100);
    await h.tick(); // guard timeout
    vi.advanceTimersByTime(5_100);
    await h.tick({ bandwidthBps: 10_000_000 }); // seq 43: 360p -> 1080p
    expect(h.switches()).toEqual(['720p', '1080p']);
    // The player resolves each callback with the switch's seq.
    h.controller.onTrackSwitched('360p', 43);
    h.set({ activeTrack: '720p' });
    h.controller.onTrackSwitched('720p', 42);
    const phantom = emit.mock.calls.find(c => c[0] === 'ABR_SWITCH_PHANTOM')![1];
    const decision = emit.mock.calls.find(c => c[0] === 'ABR_DECISION')![1];
    expect(phantom).toMatchObject({ switch_seq: 43, to: '1080p' });
    expect(typeof (phantom as Record<string, unknown>).decided_ts).toBe('number');
    expect(decision).toMatchObject({ switch_seq: 42, to: '720p' });
    expect(typeof (decision as Record<string, unknown>).decided_ts).toBe('number');
  });

  it('matches by seq, not by track: a callback for an older switch to the same target resolves that one', async () => {
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    numbered(h);
    await h.tick(); // seq 42 -> 720p
    h.controller.onTrackSwitched('360p', 42); // refused
    await h.tick(); // seq 43 -> 720p again
    h.set({ activeTrack: '720p' });
    h.controller.onTrackSwitched('720p', 43);
    const seqs = (name: string) =>
      emit.mock.calls
        .filter(c => c[0] === name)
        .map(c => (c[1] as Record<string, unknown>).switch_seq);
    expect(seqs('ABR_SWITCH_PHANTOM')).toEqual([42]);
    expect(seqs('ABR_DECISION')).toEqual([43]);
  });

  it('without a numbering player the fields are null', async () => {
    const emit = vi.spyOn(events, 'emit');
    const h = harness({ activeTrack: '360p', bandwidthBps: 2_000_000, bufferContigSeconds: 5 });
    await h.tick();
    h.land('720p');
    const decision = emit.mock.calls.find(c => c[0] === 'ABR_DECISION')![1];
    expect(decision).toMatchObject({ switch_seq: null });
  });
});
