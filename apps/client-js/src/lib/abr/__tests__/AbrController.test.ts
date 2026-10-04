import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import { events } from '@/lib/events/EventLog';
import { AbrController } from '../AbrController';
import type { AbrMetrics } from '../AbrController';
import { AbrRulesCollection } from '../AbrRulesCollection';
import { DEFAULT_ABR_SETTINGS } from '../types';
import type { AbrSettings, Track } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;
type MockPlayer = {
  getMetrics: AnyMock;
  switchTrack: AnyMock;
  setEmaHalfLives: AnyMock;
  probeTrackBandwidth: AnyMock;
};

function makeTracks(): Track[] {
  return [
    { name: '360p', bitrate: 500_000 },
    { name: '720p', bitrate: 1_500_000 },
    { name: '1080p', bitrate: 4_000_000 },
  ];
}

function makeSettings(overrides: Partial<AbrSettings> = {}): AbrSettings {
  return {
    ...DEFAULT_ABR_SETTINGS,
    rules: { ...DEFAULT_ABR_SETTINGS.rules },
    ...overrides,
  };
}

function makePlayerMetrics(overrides: Partial<ReturnType<MockPlayer['getMetrics']>> = {}) {
  return {
    bandwidthBps: 10_000_000,
    fastEmaBps: 10_000_000,
    slowEmaBps: 10_000_000,
    bufferSeconds: 5,
    activeTrack: '360p',
    droppedFrames: 0,
    totalFrames: 1000,
    playbackRate: 1,
    deliveryTimeMs: 50,
    lastObjectBytes: 8000,
    // Default above MIN_STARTUP_SAMPLES so existing upswitch tests aren't gated
    // by the startup slow-start guard; startup-specific tests override this.
    sampleCount: 10,
    latencyTrendRatio: 1,
    lastLatencyMs: 0,
    ...overrides,
  };
}

function makeController(
  playerOverrides: Partial<ReturnType<typeof makePlayerMetrics>> = {},
  settingsOverrides: Partial<AbrSettings> = {},
): {
  controller: AbrController;
  player: MockPlayer;
  collection: AbrRulesCollection;
  metrics: AbrMetrics[];
} {
  const tracks = makeTracks();
  const settings = makeSettings(settingsOverrides);
  const collection = new AbrRulesCollection(settings);
  const player: MockPlayer = {
    getMetrics: vi.fn().mockReturnValue(makePlayerMetrics(playerOverrides)),
    switchTrack: vi.fn().mockResolvedValue(undefined),
    setEmaHalfLives: vi.fn(),
    probeTrackBandwidth: vi.fn().mockResolvedValue(0),
  };
  const capturedMetrics: AbrMetrics[] = [];
  const controller = new AbrController(player, collection, tracks, settings, m =>
    capturedMetrics.push(m),
  );
  return { controller, player, collection, metrics: capturedMetrics };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AbrController', () => {
  describe('metrics emission', () => {
    it('emits metrics on every tick regardless of mode', async () => {
      const { controller, metrics } = makeController(
        { bufferSeconds: 5, activeTrack: '360p' },
        { videoAutoSwitch: false },
      );

      await controller._tick();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.bandwidthBps).toBe(10_000_000);
      expect(metrics[0]!.activeTrack).toBe('360p');
      expect(metrics[0]!.activeTrackIndex).toBe(0);
      expect(metrics[0]!.mode).toBe('manual');

      await controller._tick();
      expect(metrics).toHaveLength(2);
    });

    it('emits mode=auto when videoAutoSwitch is true', async () => {
      const { controller, metrics } = makeController(
        { bufferSeconds: 5 },
        { videoAutoSwitch: true },
      );
      await controller._tick();
      expect(metrics[0]!.mode).toBe('auto');
    });

    it('activeTrackIndex is -1 when activeTrack is undefined', async () => {
      const { controller, metrics } = makeController({ activeTrack: undefined });
      await controller._tick();
      expect(metrics[0]!.activeTrackIndex).toBe(-1);
    });

    it('includes a copy of switch history in emitted metrics', async () => {
      const { controller, metrics } = makeController(
        { bufferSeconds: 5, activeTrack: '360p' },
        { videoAutoSwitch: false },
      );
      controller.manualSwitch('720p');
      controller.onTrackSwitched('720p');
      await controller._tick();
      expect(metrics[0]!.switchHistory).toHaveLength(1);
      expect(metrics[0]!.switchHistory[0]!.reason).toBe('manual');
    });
  });

  describe('manual mode (videoAutoSwitch=false)', () => {
    it('does not switch when videoAutoSwitch is false', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: false },
      );

      await controller._tick();

      // switchTrack should NOT have been called by the tick
      expect(player.switchTrack).not.toHaveBeenCalled();
    });

    it('still emits metrics in manual mode', async () => {
      const { controller, metrics } = makeController(
        { bufferSeconds: 5 },
        { videoAutoSwitch: false },
      );
      await controller._tick();
      expect(metrics).toHaveLength(1);
    });
  });

  describe('switching guard', () => {
    it('does not switch when switching guard is active', async () => {
      // High bandwidth, buffer=5s → ThroughputRule would want to upgrade
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      // First tick — should switch (guard not set yet)
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledTimes(1);
      player.switchTrack.mockClear();

      // Guard is now active; second tick should not switch
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();
    });

    it('releaseSwitchingGuard allows the next switch', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      await controller._tick(); // first switch fires
      expect(player.switchTrack).toHaveBeenCalledTimes(1);
      player.switchTrack.mockClear();

      // Guard still active
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();

      // Release guard (player signals new-track init segment landed) + advance
      // totalFrames so the guard's frame-advance condition clears too.
      controller.releaseSwitchingGuard();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '360p', totalFrames: 2000 }),
      );

      // Next tick should be able to switch again
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('DYNAMIC strategy — ThroughputRule at low buffer', () => {
    it('uses ThroughputRule when buffer is below switchOnThreshold', async () => {
      // buffer=5s < switchOnThreshold=18s → shouldUseBolaRule=false → ThroughputRule active
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      // ThroughputRule at 10Mbps with safety factor 0.9 → effectiveBw=9Mbps
      // All tracks fit (max 4Mbps), so it would want index=2 (1080p), which differs from 360p (index=0)
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });
  });

  describe('DYNAMIC strategy — BolaRule at high buffer', () => {
    it('switches to BolaRule when buffer exceeds switchOnThreshold', async () => {
      // buffer=20s >= switchOnThreshold=18s → shouldUseBolaRule=true → BolaRule active
      const { controller, player } = makeController(
        { bufferSeconds: 20, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      // With BolaRule active and high bandwidth/buffer, it should upgrade
      expect(player.switchTrack).toHaveBeenCalled();
      // Verify we didn't call with 360p (current track) — it should upgrade
      const calledWith = (player.switchTrack.mock.calls[0] as string[])[0];
      expect(calledWith).not.toBe('360p');
    });
  });

  describe('startup slow-start guard', () => {
    it('suppresses an upswitch until MIN_STARTUP_SAMPLES real samples exist', async () => {
      // High bandwidth would normally upswitch 360p -> 1080p, but only 1 real
      // throughput sample has arrived, so the startup guard blocks the climb.
      const { controller, player } = makeController(
        {
          bufferSeconds: 5,
          activeTrack: '360p',
          bandwidthBps: 10_000_000,
          sampleCount: 1,
        },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      expect(player.switchTrack).not.toHaveBeenCalled();
    });

    it('allows the upswitch once enough samples have accumulated', async () => {
      const { controller, player } = makeController(
        {
          bufferSeconds: 5,
          activeTrack: '360p',
          bandwidthBps: 10_000_000,
          sampleCount: AbrController.MIN_STARTUP_SAMPLES,
        },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      expect(player.switchTrack).toHaveBeenCalled();
    });

    it('still permits a downswitch during startup (emergency drop not gated)', async () => {
      // Low throughput on a high tier with buffer below threshold: ThroughputRule
      // wants the lowest track. Even with 0 samples the startup guard must NOT
      // block it — the guard only gates upswitches.
      // EMA just above the lowest rung (360p=500k) so ThroughputRule selects
      // index 0 — a genuine downswitch from 1080p (index 2).
      const { controller, player } = makeController(
        {
          bufferSeconds: 5,
          activeTrack: '1080p',
          bandwidthBps: 600_000,
          fastEmaBps: 600_000,
          slowEmaBps: 600_000,
          sampleCount: 0,
        },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      expect(player.switchTrack).toHaveBeenCalled();
      const calledWith = (player.switchTrack.mock.calls[0] as string[])[0];
      expect(calledWith).not.toBe('1080p');
    });
  });

  describe('post-switch up-guard (settings.controller.upGuardSamples)', () => {
    const guarded = (playerOverrides: Partial<ReturnType<typeof makePlayerMetrics>> = {}) =>
      makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 2_000_000, ...playerOverrides },
        {
          videoAutoSwitch: true,
          controller: { ...DEFAULT_ABR_SETTINGS.controller, upGuardSamples: 3 },
        },
      );

    const land = (
      controller: AbrController,
      player: MockPlayer,
      metrics: Partial<ReturnType<typeof makePlayerMetrics>>,
    ) => {
      player.getMetrics.mockReturnValue(makePlayerMetrics({ totalFrames: 2000, ...metrics }));
      controller.onTrackSwitched(metrics.activeTrack ?? undefined);
    };

    it('holds the next up-switch until the previous switch landed and 3 fresh samples arrived', async () => {
      const { controller, player } = guarded();
      await controller._tick(); // 360p -> 720p
      expect(player.switchTrack).toHaveBeenCalledTimes(1);
      player.switchTrack.mockClear();

      // Landed on 720p with sampleCount 10; the throughput rule now wants 1080p.
      land(controller, player, { bufferSeconds: 5, activeTrack: '720p', sampleCount: 10 });
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled(); // 0 fresh samples

      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 12,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled(); // 2 fresh samples

      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 13,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p'); // 3 fresh samples
    });

    it('does not count samples that arrived before the switch landed', async () => {
      const { controller, player } = guarded();
      await controller._tick();
      player.switchTrack.mockClear();
      // Samples keep arriving while the switch is in flight (still on 360p, guard held).
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '360p', sampleCount: 20 }),
      );
      await controller._tick();
      // Lands at sampleCount 20: the count starts here.
      land(controller, player, { bufferSeconds: 5, activeTrack: '720p', sampleCount: 20 });
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 23,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });

    it('never holds a down-switch', async () => {
      const { controller, player } = guarded();
      await controller._tick(); // up to 720p
      player.switchTrack.mockClear();
      // Landed, no fresh samples, and the link collapsed: the throughput rule wants 360p.
      land(controller, player, {
        bufferSeconds: 5,
        activeTrack: '720p',
        sampleCount: 10,
        bandwidthBps: 700_000,
        fastEmaBps: 700_000,
        slowEmaBps: 700_000,
      });
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('360p');
    });

    it('is off when upGuardSamples is 0 (baseline controller)', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );
      await controller._tick();
      player.switchTrack.mockClear();
      controller.releaseSwitchingGuard();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 10,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });

    it("in 'visible' mode counts from notifySwitchVisible, not from landing", async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 2_000_000 },
        {
          videoAutoSwitch: true,
          controller: {
            ...DEFAULT_ABR_SETTINGS.controller,
            upGuardSamples: 1,
            upGuardRelease: 'visible',
          },
        },
      );
      await controller._tick();
      player.switchTrack.mockClear();
      land(controller, player, { bufferSeconds: 5, activeTrack: '720p', sampleCount: 10 });
      await controller._tick();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 15,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled(); // landed, plenty of samples, but not visible
      controller.notifySwitchVisible();
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled(); // visible at 15, needs 1 fresh sample
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          sampleCount: 16,
        }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });
  });

  describe('maxBitrate cap', () => {
    it('clamps every rule to the highest rung under maxBitrate and does not probe above it', async () => {
      // 10 Mbps bandwidth: ThroughputRule alone would go to 1080p (4 Mbps).
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true, maxBitrate: 1_500_000 },
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('720p');
      player.switchTrack.mockClear();
      controller.releaseSwitchingGuard();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({
          bufferSeconds: 5,
          activeTrack: '720p',
          totalFrames: 2000,
          bandwidthBps: 10_000_000,
        }),
      );
      player.probeTrackBandwidth.mockClear();
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();
      expect(player.probeTrackBandwidth).not.toHaveBeenCalled(); // already at the cap
    });
  });

  describe('probe payload floor (settings.controller.probeMinBytes)', () => {
    it('sizes the probe from the rung gap by default', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 100 },
        { videoAutoSwitch: true },
      );
      await controller._tick();
      // 2 s * (1.5 Mbps - 0.5 Mbps) / 8 = 250 000 bytes
      expect(player.probeTrackBandwidth).toHaveBeenCalledWith('.probe:250000:0', 500);
    });

    it('caps the probe at probeMaxBytes', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 100 },
        {
          videoAutoSwitch: true,
          controller: { ...DEFAULT_ABR_SETTINGS.controller, probeMaxBytes: 65_536 },
        },
      );
      await controller._tick();
      expect(player.probeTrackBandwidth).toHaveBeenCalledWith('.probe:65536:0', 500);
    });

    it('sends no probe at all when probeMode is off', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 100 },
        {
          videoAutoSwitch: true,
          controller: { ...DEFAULT_ABR_SETTINGS.controller, probeMode: 'off' },
        },
      );
      await controller._tick();
      expect(player.probeTrackBandwidth).not.toHaveBeenCalled();
    });

    it('never sends a probe smaller than probeMinBytes', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 100 },
        {
          videoAutoSwitch: true,
          controller: { ...DEFAULT_ABR_SETTINGS.controller, probeMinBytes: 400_000 },
        },
      );
      await controller._tick();
      expect(player.probeTrackBandwidth).toHaveBeenCalledWith('.probe:400000:0', 500);
    });
  });

  describe('no switch when already on best track', () => {
    it('does not switch when already on the best track', async () => {
      // Active track is 1080p (index=2) with high bandwidth — ThroughputRule also wants index=2
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '1080p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      await controller._tick();

      expect(player.switchTrack).not.toHaveBeenCalled();
    });
  });

  describe('manualSwitch', () => {
    it('calls switchTrack regardless of videoAutoSwitch setting', () => {
      const { controller, player } = makeController(
        { activeTrack: '360p' },
        { videoAutoSwitch: false },
      );

      controller.manualSwitch('1080p');

      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });

    it('records a manual switch event in history', () => {
      const { controller } = makeController({ activeTrack: '360p' }, { videoAutoSwitch: false });

      controller.manualSwitch('720p');
      controller.onTrackSwitched('720p');

      const history = controller.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.fromTrack).toBe('360p');
      expect(history[0]!.toTrack).toBe('720p');
      expect(history[0]!.reason).toBe('manual');
    });

    it('works even when videoAutoSwitch is true', () => {
      const { controller, player } = makeController(
        { activeTrack: '1080p' },
        { videoAutoSwitch: true },
      );

      controller.manualSwitch('360p');

      expect(player.switchTrack).toHaveBeenCalledWith('360p');
    });
  });

  describe('getHistory', () => {
    it('returns a copy of the switch history', () => {
      const { controller } = makeController({ activeTrack: '360p' }, { videoAutoSwitch: false });

      controller.manualSwitch('720p');
      controller.onTrackSwitched('720p');
      const h1 = controller.getHistory();
      const h2 = controller.getHistory();

      expect(h1).toEqual(h2);
      expect(h1).not.toBe(h2); // different array instances
    });

    it('caps history at 60 entries', async () => {
      const { controller, player } = makeController(
        { activeTrack: '360p' },
        { videoAutoSwitch: false },
      );

      for (let i = 0; i < 65; i++) {
        controller.manualSwitch('720p');
        controller.onTrackSwitched('720p');
        // Simulate a decoded frame from the new track so the guard's
        // frame-advance condition clears, allowing the next manualSwitch
        // through. _tick() polls metrics and applies that condition.
        player.getMetrics.mockReturnValue(
          makePlayerMetrics({ activeTrack: '360p', totalFrames: 1000 + (i + 1) * 10 }),
        );
        await controller._tick();
      }

      expect(controller.getHistory()).toHaveLength(60);
    });
  });

  describe('start/stop', () => {
    it('start begins a 250ms tick interval', async () => {
      vi.useFakeTimers();
      const { controller, metrics } = makeController(
        { bufferSeconds: 5 },
        { videoAutoSwitch: false },
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(500);
      controller.stop();

      // Should have ticked roughly twice (at 250ms and 500ms)
      expect(metrics.length).toBeGreaterThanOrEqual(2);
      vi.useRealTimers();
    });

    it('stop clears the interval', async () => {
      vi.useFakeTimers();
      const { controller, metrics } = makeController(
        { bufferSeconds: 5 },
        { videoAutoSwitch: false },
      );

      controller.start();
      await vi.advanceTimersByTimeAsync(250);
      const countAfterFirst = metrics.length;
      controller.stop();

      await vi.advanceTimersByTimeAsync(500);
      expect(metrics.length).toBe(countAfterFirst); // no more ticks after stop

      vi.useRealTimers();
    });
  });

  describe('updateSettings', () => {
    it('updates the settings reference used by subsequent ticks', async () => {
      const { controller, player, metrics } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );

      // First tick should switch (auto mode)
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledTimes(1);
      player.switchTrack.mockClear();
      controller.releaseSwitchingGuard();

      // Switch to manual mode
      controller.updateSettings(makeSettings({ videoAutoSwitch: false }));

      // Now tick should not switch
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();

      // Mode should be reflected in emitted metrics
      const lastMetrics = metrics[metrics.length - 1]!;
      expect(lastMetrics.mode).toBe('manual');
    });
  });

  describe('M17: history and ABR_DECISION only on a confirmed landing', () => {
    afterEach(() => vi.restoreAllMocks());

    const decisions = (emit: AnyMock) =>
      emit.mock.calls
        .filter(c => c[0] === 'ABR_DECISION')
        .map(c => c[1] as Record<string, unknown>);

    it('a refused or skipped switch (onTrackSwitched with the old track) leaves no history, no ABR_DECISION and no armed up-guard', async () => {
      const emit = vi.spyOn(events, 'emit') as unknown as AnyMock;
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        {
          videoAutoSwitch: true,
          controller: { ...DEFAULT_ABR_SETTINGS.controller, upGuardSamples: 3 },
        },
      );
      await controller._tick(); // decides 360p -> 1080p
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
      // SWITCH_SKIPPED / SWITCH_ERROR / missing-catalog paths all call back with
      // the track the player is still on.
      controller.onTrackSwitched('360p');
      expect(controller.getHistory()).toHaveLength(0);
      expect(decisions(emit)).toHaveLength(0);
      expect(emit.mock.calls.some(c => c[0] === 'ABR_SWITCH_PHANTOM')).toBe(true);

      // The guard is released and nothing is armed: the client never left 360p,
      // so the next decision is not held by a post-switch up-guard.
      player.switchTrack.mockClear();
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '360p', totalFrames: 2000 }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });

    it('a landed switch records history and one ABR_DECISION with the decision-time signals', async () => {
      const emit = vi.spyOn(events, 'emit') as unknown as AnyMock;
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000, sampleCount: 7 },
        { videoAutoSwitch: true },
      );
      await controller._tick();
      expect(decisions(emit)).toHaveLength(0); // not yet: the switch is in flight
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '1080p', totalFrames: 2000 }),
      );
      controller.onTrackSwitched('1080p');
      const history = controller.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.fromTrack).toBe('360p');
      expect(history[0]!.toTrack).toBe('1080p');
      expect(history[0]!.reason).toBe('auto-upgrade');
      const d = decisions(emit);
      expect(d).toHaveLength(1);
      expect(d[0]!.from).toBe('360p');
      expect(d[0]!.to).toBe('1080p');
      expect(d[0]!.bandwidth_bps).toBe(10_000_000);
      expect(d[0]!.rule_reason).toBe('throughput');
    });

    it('a manual switch is history only once it lands', async () => {
      const { controller, player } = makeController(
        { activeTrack: '360p' },
        { videoAutoSwitch: false },
      );
      controller.manualSwitch('720p');
      expect(controller.getHistory()).toHaveLength(0);
      controller.onTrackSwitched('360p'); // refused
      expect(controller.getHistory()).toHaveLength(0);
      // The switching guard clears on the next tick with a frame advance.
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ activeTrack: '360p', totalFrames: 2000 }),
      );
      await controller._tick();
      controller.manualSwitch('720p');
      controller.onTrackSwitched('720p');
      expect(controller.getHistory()).toHaveLength(1);
    });

    it("releaseSwitchingGuard() without a track confirms against the player's active track", async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        { videoAutoSwitch: true },
      );
      await controller._tick(); // 360p -> 1080p
      // The player flips activeTrack before it calls onTrackSwitched.
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '1080p', totalFrames: 2000 }),
      );
      controller.releaseSwitchingGuard();
      expect(controller.getHistory()).toHaveLength(1);
    });

    it('a switch that times out is dropped from the pending record, not written to history', async () => {
      vi.useFakeTimers();
      try {
        const { controller, player } = makeController(
          { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
          { videoAutoSwitch: true },
        );
        await controller._tick();
        expect(player.switchTrack).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(AbrController.SWITCH_TIMEOUT_MS + 1);
        await controller._tick(); // ABR_GUARD_TIMEOUT
        expect(controller.getHistory()).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('M18: the probe is a veto through _tick (grid arm)', () => {
    const gridSettings = () => ({
      videoAutoSwitch: true,
      controller: {
        ...DEFAULT_ABR_SETTINGS.controller,
        latencyResetOnLanding: true,
        bufferSignal: 'envelope' as const,
        switchHistoryMode: 'veto' as const,
        switchHistoryWindowS: 60,
        probeMaxBytes: 65_536,
      },
    });

    it('a fresh probe without headroom holds the throughput rule at the active rung', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        gridSettings(),
      );
      // The probe measured 1 Mbps on the wire: 0.8 Mbps < 1.5 Mbps (720p).
      player.probeTrackBandwidth.mockResolvedValue({ bps: 1_000_000, dtMs: 400 });
      // Tick 1 fires the probe; its result lands asynchronously.
      await controller._tick();
      await Promise.resolve();
      await Promise.resolve();
      // The first tick had no probe reading yet, so the throughput rule may have
      // switched; what matters is the steady state once the reading is fresh.
      player.switchTrack.mockClear();
      controller.onTrackSwitched('360p');
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '360p', totalFrames: 2000 }),
      );
      await controller._tick();
      expect(player.switchTrack).not.toHaveBeenCalled();
    });

    it('a fresh probe with headroom does not limit the climb to one rung', async () => {
      const { controller, player } = makeController(
        { bufferSeconds: 5, activeTrack: '360p', bandwidthBps: 10_000_000 },
        gridSettings(),
      );
      player.probeTrackBandwidth.mockResolvedValue({ bps: 10_000_000, dtMs: 400 });
      await controller._tick();
      await Promise.resolve();
      await Promise.resolve();
      player.switchTrack.mockClear();
      controller.onTrackSwitched('360p');
      player.getMetrics.mockReturnValue(
        makePlayerMetrics({ bufferSeconds: 5, activeTrack: '360p', totalFrames: 2000 }),
      );
      await controller._tick();
      expect(player.switchTrack).toHaveBeenCalledWith('1080p');
    });
  });
});
