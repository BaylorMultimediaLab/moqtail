import { events } from '@/lib/events/EventLog';
import type { AbrRulesCollection } from './AbrRulesCollection';
import { ProbeManager, type ProbeResult } from './ProbeManager';
import {
  type AbrSettings,
  type RulesContext,
  type SwitchEvent,
  type SwitchReason,
  type Track,
  CONTROLLER_CONSTANTS,
  bufferEnvelope,
  effectiveSegmentDurationS,
  resolveControllerSettings,
} from './types';

export interface AbrMetrics {
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  bufferSeconds: number;
  /** Contiguous buffer (= bufferSeconds when the player does not expose it); the min arm's buffer signal. */
  bufferContigSeconds: number;
  activeTrack: string | null;
  activeTrackIndex: number;
  droppedFrames: number;
  totalFrames: number;
  playbackRate: number;
  deliveryTimeMs: number;
  lastObjectBytes: number;
  sampleCount: number;
  switchHistory: SwitchEvent[];
  mode: 'auto' | 'manual';
  switching: boolean;
  // MSE / video element state — populated to diagnose playback wedges
  // where total_frames stops advancing but buffer keeps growing.
  readyState: number;
  paused: boolean;
  currentTime: number;
  bufferedRanges: string;
  mseReadyState: string;
  videoErrorCode: number;
  // Per-frame end-to-end latency (PRFT-derived) and its 100-frame trend
  // ratio. LatencyTrendRule fires a downswitch when ratio > 1.20.
  latencyTrendRatio: number;
  lastLatencyMs: number;
}

const MAX_HISTORY = CONTROLLER_CONSTANTS.maxHistory;

/**
 * The player metrics the controller consumes (`player.getMetrics()`), listed so
 * the player (W3) and the controller (W5) agree on names. Required fields are
 * the shipped ones; optional fields are the rebuild additions and fall back as
 * documented when absent.
 */
export interface AbrPlayerMetrics {
  /** SWMA of the last 5 arrival-spaced group throughput samples, bps. */
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  /** Total buffered-ahead: last buffered range end minus playhead, s. */
  bufferSeconds: number;
  /**
   * Contiguous buffer: end of the buffered range containing the playhead minus
   * the playhead, 0 if none (M12). The rules' buffer signal in the `min` arm
   * (falls back to bufferSeconds when absent); `grid` and `baseline` keep
   * bufferSeconds.
   */
  bufferContigSeconds?: number;
  activeTrack: string | null;
  droppedFrames: number;
  totalFrames: number;
  playbackRate: number;
  deliveryTimeMs: number;
  lastObjectBytes: number;
  /** Completed-group throughput samples so far, all tracks. */
  sampleCount: number;
  /**
   * Completed-group throughput samples per track, keyed by the track the
   * group belonged to (THROUGHPUT_SAMPLE.track), cumulative over the session.
   * The dwell and the history's seam window count groups *of the landed
   * track* since the landing from it. Without it the controller uses
   * `sampleCount` and discounts one group per landing (see
   * AbrController.groupsSinceLanding).
   */
  samplesByTrack?: Readonly<Record<string, number>>;
  /** Raw capture-to-receipt trend ratio (legacy; see RulesContext.latencyTrendRatio). */
  latencyTrendRatio: number;
  lastLatencyMs: number;
  /** Half-window means of the latency tracker, ms (C6). */
  latencyRecentMeanMs?: number;
  latencyOlderMeanMs?: number;
  /** The client's target shift behind live, ms: 0 live-edge, delayGroups × GOP time-shifted (C6). */
  targetShiftMs?: number;
  /** Playhead (media time), ms. */
  playheadMs?: number;
  /**
   * PTS (ms) of the latest applied switch seam whose region the playhead has
   * entered (the region begins at the hole in front of the seam), null when
   * it has entered none. SwitchHistoryRule's seam exemption (F2). Absent on
   * players that do not track seams.
   */
  latestSeamPtsMs?: number | null;
  // Diagnostics copied into AbrMetrics for the UI / SAMPLE log.
  readyState?: number;
  paused?: boolean;
  currentTime?: number;
  bufferedRanges?: string;
  mseReadyState?: string;
  videoErrorCode?: number;
}

/** What the controller needs from the player. `Player` satisfies it structurally. */
export interface AbrPlayer {
  getMetrics(): AbrPlayerMetrics;
  switchTrack(trackName: string): Promise<void>;
  setEmaHalfLives(fastHalfLifeSeconds: number, slowHalfLifeSeconds: number): void;
  probeTrackBandwidth(trackName: string, durationMs: number): Promise<number | ProbeResult>;
}

/** A switch that has been sent and not yet confirmed by the player (see onTrackSwitched). */
interface PendingSwitch {
  fromTrack: string;
  toTrack: string;
  fromIndex: number;
  toIndex: number;
  fromBitrate: number;
  toBitrate: number;
  reason: SwitchReason;
  ruleReason: string;
  /** The rule whose request was chosen (null for a manual switch). */
  rule: string | null;
  /** Rules that asked for the same index at the same priority (see AbrRulesCollection arbitrate). */
  tiedRules: string[];
  priority: number | null;
  bufferSeconds: number;
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  probeBps: number;
  latencyTrend: number;
  /** Completed groups since the last landing when the decision was taken; null before the first landing. */
  groupsSinceLanding: number | null;
  /** Playhead minus the seam it was at when the decision was taken (SwitchEvent.msPastSeam). */
  msPastSeam: number | null | undefined;
  decidedTs: number;
}

/** SwitchEvent.msPastSeam from the player's metrics at decision time (F2). */
function msPastSeamOf(
  m: Pick<AbrPlayerMetrics, 'playheadMs' | 'latestSeamPtsMs'>,
): number | null | undefined {
  if (m.latestSeamPtsMs === undefined || typeof m.playheadMs !== 'number') return undefined;
  if (m.latestSeamPtsMs === null) return null;
  return m.playheadMs - m.latestSeamPtsMs;
}

export class AbrController {
  #player: AbrPlayer;
  #rulesCollection: AbrRulesCollection;
  #tracks: Track[];
  #settings: AbrSettings;
  #onMetricsUpdate: (m: AbrMetrics) => void;
  #probeManager: ProbeManager;

  #intervalId: ReturnType<typeof setInterval> | null = null;
  #switching = false;
  #usingBolaRule = false;
  #switchHistory: SwitchEvent[] = [];
  // Snapshot of totalVideoFrames at the moment of the last switch; the guard
  // is held until this counter has actually advanced (i.e. a new-track frame
  // has been decoded), not just until the init segment was appended. Without
  // this, rapid back-to-back switches leave MSE with a fragmented timeline
  // (gaps between groups) and playback wedges with ready_state=2.
  #framesAtSwitch = 0;
  #pendingFrameAdvance = false;
  // Wall-clock timestamp when #switching was last set. Used to release the
  // guard if a switch never lands — happens when a regime change leaves the
  // chosen target infeasible (e.g., upswitch to 1080p just before the link
  // drops to 0.6 Mbps; the relay can't deliver any 1080p data and
  // onTrackSwitched never fires). Without a timeout, the guard locks ABR
  // out of running rules indefinitely.
  #switchingStartTs = 0;
  // Wall-clock time after which ABR rules may fire again following a switch
  // timeout. Set to Date.now() + SWITCH_COOLDOWN_MS when SWITCH_TIMEOUT_MS
  // expires so the same infeasible switch isn't re-triggered immediately.
  #switchBackoffUntil = 0;
  // Maximum time #switching may be held before being force-released. Long
  // enough to cover normal switch landing under healthy conditions
  // (typically < 1 GOP duration), short enough that ABR can re-evaluate
  // before buffer fully drains.
  static readonly SWITCH_TIMEOUT_MS = CONTROLLER_CONSTANTS.switchTimeoutMs;
  // After a switch times out (init segment never arrived — typical under severe
  // packet loss or a fleeting bandwidth spike), hold off this long before
  // running rules again. Without the cooldown the ABR re-fires the same
  // switch every SWITCH_TIMEOUT_MS, generating unbounded downswitch events
  // while activeTrack never changes.
  static readonly SWITCH_COOLDOWN_MS = CONTROLLER_CONSTANTS.switchCooldownMs;
  // Minimum number of real per-group throughput samples before an *upswitch*
  // is allowed. The startup throughput signal (handshake burst, first backlog
  // GOP, or a not-yet-shaped link) over-reads the sustainable rate; gating
  // upswitches on a few sustained samples is a config-agnostic slow-start that
  // stops a single startup burst from green-lighting a multi-tier climb.
  // Downswitches are never gated — an emergency drop must always be allowed.
  static readonly MIN_STARTUP_SAMPLES = CONTROLLER_CONSTANTS.minStartupSamples;
  // Carry-over bitrate delta from the most recent switch. Used in the
  // thesis Algorithm 1 probe_size formula: probe_size = t · (b[i+1] - b[i]
  // + tracksize). Initialized to 0; updated whenever a switch fires.
  #tracksize = 0;
  // Probe time horizon (seconds). Thesis uses t=2s and sizes the probe
  // payload to match. Our relay sends the synthesized payload as fast as
  // the link allows, so this is "the bitrate window the probe is supposed
  // to test", not the actual on-wire duration.
  #probeHorizonSec = CONTROLLER_CONSTANTS.probeHorizonS;
  // Post-switch up-guard (settings.controller.upGuardSamples > 0). Armed by
  // every switch; an up-switch is held until the switch has been released
  // (landed or visible, per settings.controller.upGuardRelease) and
  // upGuardSamples fresh throughput samples have arrived since the release.
  // Down-switches are never held. Mechanism- and client-type-neutral by
  // construction: it counts completed groups, not seconds of buffer.
  #upGuardArmed = false;
  #upGuardReleasedAtSamples: number | null = null;
  #lastSampleCount = 0;
  // Recent instantaneous buffer levels for settings.controller.bufferSignal =
  // 'envelope' (see ControllerSettings).
  #bufferSamples: { ts: number; bufferSeconds: number }[] = [];
  // The switch that has been sent but not confirmed (M17). History, ABR_DECISION,
  // the up-guard arm and the probe's tracksize are written only when the player
  // reports (onTrackSwitched) that the landed track is this record's target. A
  // refused, skipped or failed switch calls back with the old track and leaves
  // no trace other than ABR_SWITCH_PHANTOM.
  #pendingSwitch: PendingSwitch | null = null;
  // activeTrack as of the last tick; a callback with a different track is a
  // landing even when no decision is pending (a switch that landed after its
  // guard timed out).
  #activeTrackAtTick: string | null = null;
  // The last confirmed landing: the landed track and the sample counters at
  // that moment, or null before the first one. groupsSinceLanding() derives the
  // completed groups of the landed track since then from it; that is the
  // min arm's dwell clock and is stamped on every history entry.
  #landing: { track: string; sampleCount: number; trackSamples: number | null } | null = null;

  constructor(
    player: AbrPlayer,
    rulesCollection: AbrRulesCollection,
    tracks: Track[],
    settings: AbrSettings,
    onMetricsUpdate: (m: AbrMetrics) => void,
  ) {
    this.#player = player;
    this.#rulesCollection = rulesCollection;
    // Sort ascending by bitrate — index 0 = lowest quality, last = highest
    this.#tracks = [...tracks].sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
    // The arm decides the effective settings (types.ts resolveControllerSettings).
    this.#settings = resolveControllerSettings(settings);
    this.#onMetricsUpdate = onMetricsUpdate;
    this.#probeManager = new ProbeManager(this.#player, {
      intervalMs: CONTROLLER_CONSTANTS.probeIntervalMs,
      durationMs: CONTROLLER_CONSTANTS.probeDurationMs,
      freshnessMs: CONTROLLER_CONSTANTS.probeFreshnessMs,
      minDurationMs: this.#settings.controller.probeMinDurationMs,
    });
    this.#player.setEmaHalfLives(
      settings.ewma.throughputFastHalfLifeSeconds,
      settings.ewma.throughputSlowHalfLifeSeconds,
    );
  }

  /** The settings the controller runs (arm resolved). */
  get settings(): AbrSettings {
    return this.#settings;
  }

  start(): void {
    if (this.#intervalId !== null) return;
    this.#intervalId = setInterval(() => void this._tick(), CONTROLLER_CONSTANTS.tickMs);
  }

  stop(): void {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  updateSettings(settings: AbrSettings): void {
    this.#settings = resolveControllerSettings(settings);
    this.#probeManager.setMinDurationMs(this.#settings.controller.probeMinDurationMs);
    this.#player.setEmaHalfLives(
      settings.ewma.throughputFastHalfLifeSeconds,
      settings.ewma.throughputSlowHalfLifeSeconds,
    );
  }

  /**
   * Player callback for every terminal outcome of a switchTrack call: the
   * target's first object was applied (landed, `trackName` = target), or the
   * switch was refused / skipped / failed (`trackName` = the track the player is
   * still on). Only a landing on the pending target is a switch: it is then
   * written to the history, logged as ABR_DECISION, arms the post-switch
   * up-guard and starts the dwell clock. Anything else releases the switching
   * guard and is logged as ABR_SWITCH_PHANTOM (M17).
   *
   * Without an argument (legacy wiring) the landed track is read from
   * `player.getMetrics().activeTrack`, which the player updates before it calls
   * back.
   */
  onTrackSwitched(landedTrack?: string): void {
    const m = this.#player.getMetrics();
    const landed = landedTrack ?? m.activeTrack ?? null;
    const pending = this.#pendingSwitch;
    this.#pendingSwitch = null;
    this.#lastSampleCount = m.sampleCount;
    // Defer actually clearing #switching until totalVideoFrames advances past
    // the snapshot — that's when MSE has decoded an actual frame from the new
    // track. Prevents rapid switches from shredding the MSE timeline.
    this.#pendingFrameAdvance = true;

    const isLanding = pending
      ? landed === pending.toTrack
      : landed !== null && landed !== this.#activeTrackAtTick;
    if (!isLanding) {
      if (pending) {
        events.emit('ABR_SWITCH_PHANTOM', {
          from: pending.fromTrack,
          to: pending.toTrack,
          landed,
          reason: pending.reason,
          rule_reason: pending.ruleReason,
          decided_ms_ago: Date.now() - pending.decidedTs,
        });
      }
      return;
    }

    this.#landing = {
      track: landed!,
      sampleCount: m.sampleCount,
      trackSamples: m.samplesByTrack ? (m.samplesByTrack[landed!] ?? 0) : null,
    };
    this.#activeTrackAtTick = landed;
    if (pending) {
      this.#recordHistory(pending);
      events.emit('ABR_DECISION', {
        from: pending.fromTrack,
        to: pending.toTrack,
        from_index: pending.fromIndex,
        to_index: pending.toIndex,
        from_bitrate: pending.fromBitrate,
        to_bitrate: pending.toBitrate,
        reason: pending.reason,
        rule_reason: pending.ruleReason,
        rule: pending.rule,
        tied_rules: pending.tiedRules,
        priority: pending.priority,
        buffer_s: pending.bufferSeconds,
        bandwidth_bps: pending.bandwidthBps,
        fast_ema_bps: pending.fastEmaBps,
        slow_ema_bps: pending.slowEmaBps,
        probe_bps: pending.probeBps,
        latency_trend: pending.latencyTrend,
        groups_since_landing: pending.groupsSinceLanding,
        ms_past_seam: pending.msPastSeam ?? null,
        decided_ts: pending.decidedTs,
        landed_after_ms: Date.now() - pending.decidedTs,
      });
      // Update tracksize (Algorithm 1 lines 13/16): after upswitch, carry
      // forward the gap from new current to next-up; after downswitch,
      // carry forward the gap from previous tier to new current. Either
      // way the value is the bitrate delta of the tier that's currently
      // adjacent to the new position in the SAME direction as the switch.
      const targetBitrate = pending.toBitrate;
      if (pending.toIndex > pending.fromIndex) {
        const next = this.#tracks[pending.toIndex + 1]?.bitrate ?? targetBitrate;
        this.#tracksize = Math.max(0, next - targetBitrate);
      } else if (pending.toIndex < pending.fromIndex) {
        const prev = this.#tracks[pending.toIndex - 1]?.bitrate ?? targetBitrate;
        this.#tracksize = Math.max(0, targetBitrate - prev);
      }
    }
    this.#armUpGuard();
    if (this.#settings.controller?.upGuardRelease !== 'visible') this.#releaseUpGuard('landed');
  }

  /** @deprecated Use onTrackSwitched(trackName); kept for the existing app.tsx wiring. */
  releaseSwitchingGuard(): void {
    this.onTrackSwitched();
  }

  /**
   * Completed groups of the landed track since the last confirmed landing, or
   * null before the first landing.
   *
   * With `samplesByTrack` this is exact: the landed track's samples now minus
   * at the landing. Without it, the total sample count minus one: the player
   * calls back on the landing object *before* recording it, and recording it
   * finalises the source's last group (the tracker closes a group when the
   * next group's first object arrives), so the first sample after a landing is
   * the old track's. Discounting it keeps "N groups of the new track" true on
   * that player and errs by one group too many (never too few) on a player
   * that finalises before calling back.
   */
  groupsSinceLanding(m: Pick<AbrPlayerMetrics, 'sampleCount' | 'samplesByTrack'>): number | null {
    const landing = this.#landing;
    if (landing === null) return null;
    if (landing.trackSamples !== null && m.samplesByTrack) {
      return Math.max(0, (m.samplesByTrack[landing.track] ?? 0) - landing.trackSamples);
    }
    return Math.max(0, m.sampleCount - landing.sampleCount - 1);
  }

  /** Player fires this when the first frame of the switched-to track is presented (t5). */
  notifySwitchVisible(): void {
    if (this.#settings.controller?.upGuardRelease === 'visible') this.#releaseUpGuard('visible');
  }

  #armUpGuard(): void {
    if ((this.#settings.controller?.upGuardSamples ?? 0) <= 0) return;
    this.#upGuardArmed = true;
    this.#upGuardReleasedAtSamples = null;
  }

  #releaseUpGuard(how: 'landed' | 'visible' | 'timeout'): void {
    if (!this.#upGuardArmed || this.#upGuardReleasedAtSamples !== null) return;
    this.#upGuardReleasedAtSamples = this.#lastSampleCount;
    events.emit('ABR_UP_GUARD_RELEASED', {
      how,
      sample_count: this.#lastSampleCount,
      fresh_samples_needed: this.#settings.controller?.upGuardSamples ?? 0,
    });
  }

  /** Fresh completed-group samples since the guard was released, or null while unreleased. */
  #upGuardFreshSamples(sampleCount: number): number | null {
    return this.#upGuardReleasedAtSamples === null
      ? null
      : sampleCount - this.#upGuardReleasedAtSamples;
  }

  isSwitching(): boolean {
    return this.#switching;
  }

  manualSwitch(trackName: string): void {
    if (this.#switching) return; // switch already in-flight
    this.#switching = true;
    this.#switchingStartTs = Date.now();
    const m = this.#player.getMetrics();
    this.#framesAtSwitch = m.totalFrames;
    this.#pendingFrameAdvance = false;
    const fromTrack = m.activeTrack ?? '';
    const fromIndex = this.#tracks.findIndex(t => t.name === fromTrack);
    const toIndex = this.#tracks.findIndex(t => t.name === trackName);
    this.#pendingSwitch = {
      fromTrack,
      toTrack: trackName,
      fromIndex,
      toIndex,
      fromBitrate: this.#tracks[fromIndex]?.bitrate ?? 0,
      toBitrate: this.#tracks[toIndex]?.bitrate ?? 0,
      reason: 'manual',
      ruleReason: 'manual',
      rule: null,
      tiedRules: [],
      priority: null,
      bufferSeconds: m.bufferSeconds,
      bandwidthBps: m.bandwidthBps,
      fastEmaBps: m.fastEmaBps,
      slowEmaBps: m.slowEmaBps,
      probeBps: 0,
      latencyTrend: m.latencyTrendRatio,
      groupsSinceLanding: this.groupsSinceLanding(m),
      msPastSeam: msPastSeamOf(m),
      decidedTs: Date.now(),
    };
    void this.#player.switchTrack(trackName);
  }

  getHistory(): SwitchEvent[] {
    return [...this.#switchHistory];
  }

  async _tick(): Promise<void> {
    const raw = this.#player.getMetrics();
    const {
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      bufferSeconds,
      bufferContigSeconds: rawContig,
      activeTrack,
      droppedFrames,
      totalFrames,
      playbackRate,
      deliveryTimeMs,
      lastObjectBytes,
      sampleCount,
      readyState,
      paused,
      currentTime,
      bufferedRanges,
      mseReadyState,
      videoErrorCode,
      latencyTrendRatio,
      lastLatencyMs,
      latencyRecentMeanMs,
      latencyOlderMeanMs,
      targetShiftMs,
    } = raw;

    // Find the active track index in the sorted tracks array
    const activeTrackIndex = activeTrack ? this.#tracks.findIndex(t => t.name === activeTrack) : -1;

    const mode: 'auto' | 'manual' = this.#settings.videoAutoSwitch ? 'auto' : 'manual';
    const isMin = this.#settings.controller.arm === 'min';

    // The min arm's rules see the contiguous buffer (M12): a hole ahead of the
    // playhead is not playable buffer. grid and baseline keep the total
    // buffered-ahead they were run with. Players without the field report the
    // total as both.
    const bufferContigSeconds =
      typeof rawContig === 'number' && Number.isFinite(rawContig) ? rawContig : bufferSeconds;
    const bufferInstantSeconds = isMin ? bufferContigSeconds : bufferSeconds;

    const metrics: AbrMetrics = {
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      bufferSeconds,
      bufferContigSeconds,
      activeTrack,
      activeTrackIndex,
      droppedFrames,
      totalFrames,
      playbackRate,
      deliveryTimeMs,
      lastObjectBytes,
      sampleCount,
      switchHistory: [...this.#switchHistory],
      mode,
      switching: this.#switching,
      readyState: readyState ?? 0,
      paused: paused ?? false,
      currentTime: currentTime ?? 0,
      bufferedRanges: bufferedRanges ?? '',
      mseReadyState: mseReadyState ?? '',
      videoErrorCode: videoErrorCode ?? 0,
      latencyTrendRatio,
      lastLatencyMs,
    };

    this.#onMetricsUpdate(metrics);
    this.#lastSampleCount = sampleCount;
    this.#activeTrackAtTick = activeTrack;

    // Buffer level for the rules: instantaneous or the maximum over the last
    // group (the level after each burst landed).
    const envelopeMs = this.#settings.controller.bufferEnvelopeMs;
    const nowTs = Date.now();
    this.#bufferSamples.push({ ts: nowTs, bufferSeconds: bufferInstantSeconds });
    while (this.#bufferSamples.length > 0 && nowTs - this.#bufferSamples[0]!.ts > envelopeMs) {
      this.#bufferSamples.shift();
    }
    const bufferEnvelopeSeconds = bufferEnvelope(this.#bufferSamples, nowTs, envelopeMs);
    const ruleBufferSeconds =
      this.#settings.controller.bufferSignal === 'envelope'
        ? bufferEnvelopeSeconds
        : bufferInstantSeconds;

    // Once the player signals the init segment landed, hold #switching until
    // a real new-track frame is decoded (totalVideoFrames moved past the
    // snapshot). Only then is it safe to consider another switch.
    if (this.#pendingFrameAdvance && totalFrames > this.#framesAtSwitch) {
      this.#switching = false;
      this.#pendingFrameAdvance = false;
    }

    // Switching guard timeout: if #switching has been held longer than
    // SWITCH_TIMEOUT_MS without releasing, the chosen target may be unfulfillable
    // (typical case: upswitch fired right before a regime change drops the
    // link below the new target's source rate). Release the ABR guard so rules
    // can re-evaluate.
    //
    // Do NOT abort pendingSwitch here. dc82f32 ("remove switch timeout failsafe
    // that corrupts track transitions") established that clearing pendingSwitch
    // on timeout *is* the bug it's claimed to fix: when relay delivery is
    // merely delayed (e.g. bandwidth-saturated joining-state replay still in
    // flight), the new track's frames eventually arrive but the cleared
    // pendingSwitch makes the writer drop them as stale, permanently breaking
    // the transition. The "stale data lands on wrong track" worry the abort
    // claimed to address is already handled: if ABR fires another switch in
    // the cooldown, switchTrack overwrites pendingSwitch implicitly. If no new
    // switch fires and the original target's frames eventually arrive,
    // applying them is the correct outcome — the user did request that track.
    if (this.#switching && Date.now() - this.#switchingStartTs > AbrController.SWITCH_TIMEOUT_MS) {
      this.#switching = false;
      this.#pendingFrameAdvance = false;
      this.#switchBackoffUntil = Date.now() + AbrController.SWITCH_COOLDOWN_MS;
      events.emit('ABR_GUARD_TIMEOUT', {
        track: activeTrack,
        held_ms: Date.now() - this.#switchingStartTs,
        cooldown_ms: AbrController.SWITCH_COOLDOWN_MS,
        pending_to: this.#pendingSwitch?.toTrack ?? null,
      });
      // The switch never confirmed: it is not history (M17). If the target
      // lands later, onTrackSwitched still sees a landing and starts the dwell.
      this.#pendingSwitch = null;
      // A switch that never lands must not hold up-switches forever: start the
      // fresh-sample count now.
      this.#releaseUpGuard('timeout');
    }

    // Manual mode — don't make automatic decisions
    if (!this.#settings.videoAutoSwitch) return;

    // Switching guard — wait for previous switch to complete
    if (this.#switching) return;

    // Post-timeout cooldown — don't re-fire rules immediately after a failed switch
    if (Date.now() < this.#switchBackoffUntil) return;

    // Update DYNAMIC strategy based on buffer level
    this.#updateDynamicStrategy(ruleBufferSeconds);

    // Active probe via the relay's synthetic `.probe:<size>:<priority>`
    // track (IETF 119 MoQ bandwidth-measurement slides + Kuo §3.4.3.1
    // Algorithm 1). Probe size is computed adaptively from the catalog:
    //
    //   probe_size = t · (b[i+1] - b[i] + tracksize)        bits
    //
    // where t is the probe horizon (2 s by default), b[i+1] - b[i] is the
    // gap to the next-higher track, and tracksize is the carry-over from
    // the most recent switch. Convert to bytes for the track-name string.
    const currentIdx = activeTrackIndex >= 0 ? activeTrackIndex : 0;
    // settings.maxBitrate caps the ladder for every rule (ThroughputRule honours
    // it on its own; ProbeRule and the buffer rules do not), and the probe does
    // not probe above the cap. -1 = uncapped.
    const maxBitrate = this.#settings.maxBitrate;
    let capIdx = this.#tracks.length - 1;
    if (maxBitrate !== -1) {
      capIdx = 0;
      for (let i = 0; i < this.#tracks.length; i++) {
        if ((this.#tracks[i]?.bitrate ?? 0) <= maxBitrate) capIdx = i;
      }
    }
    if (currentIdx < capIdx && this.#settings.controller?.probeMode !== 'off') {
      const bI = this.#tracks[currentIdx]?.bitrate ?? 0;
      const bIPlus1 = this.#tracks[currentIdx + 1]?.bitrate ?? 0;
      const gapBits = Math.max(0, bIPlus1 - bI);
      const probeSizeBits = this.#probeHorizonSec * (gapBits + this.#tracksize);
      // settings.controller.probeMinBytes floors the payload so a small rung
      // gap cannot produce a probe that completes inside one burst.
      let probeSizeBytes = Math.max(
        1024,
        Math.floor(probeSizeBits / 8),
        this.#settings.controller?.probeMinBytes ?? 0,
      );
      const cap = this.#settings.controller?.probeMaxBytes ?? 0;
      if (cap > 0) probeSizeBytes = Math.min(probeSizeBytes, cap);
      this.#probeManager.maybeProbe(`.probe:${probeSizeBytes}:0`);
    }

    // Build context for rules
    const context: RulesContext = {
      tracks: this.#tracks,
      activeTrackIndex: currentIdx,
      bufferSeconds: ruleBufferSeconds,
      bufferInstantSeconds,
      bufferEnvelopeSeconds,
      bufferTotalSeconds: bufferSeconds,
      groupsSinceLanding: this.groupsSinceLanding(raw),
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      droppedFrames,
      totalFrames,
      segmentDurationS: effectiveSegmentDurationS(this.#settings.controller),
      isLowLatency: false,
      playbackRate,
      switchHistory: [...this.#switchHistory],
      abrSettings: this.#settings,
      probeBandwidthBps: this.#probeManager.getFreshBandwidthBps(),
      latencyTrendRatio,
      latencyRecentMeanMs,
      latencyOlderMeanMs,
      targetShiftMs,
    };

    const evaluation = this.#rulesCollection.evaluate(context);
    const switchRequest = evaluation.chosen;
    // Every rule's output on every tick: a switch is attributed to the rule
    // and the signal that produced it, and a *missing* switch to the rules
    // that vetoed it.
    if (events.active) {
      const rules: Record<string, unknown> = {};
      for (const [name, req] of Object.entries(evaluation.byRule)) {
        rules[name] =
          req === null
            ? null
            : { index: req.representationIndex, priority: req.priority, reason: req.reason };
      }
      events.emit('ABR_TICK', {
        arm: this.#settings.controller.arm,
        track: activeTrack,
        active_index: currentIdx,
        buffer_s: bufferSeconds,
        buffer_contig_s: bufferContigSeconds,
        buffer_rule_s: ruleBufferSeconds,
        groups_since_landing: context.groupsSinceLanding,
        bandwidth_bps: bandwidthBps,
        fast_ema_bps: fastEmaBps,
        slow_ema_bps: slowEmaBps,
        probe_bps: context.probeBandwidthBps,
        latency_trend: latencyTrendRatio,
        sample_count: sampleCount,
        using_bola: this.#usingBolaRule,
        up_guard: this.#upGuardArmed
          ? {
              released: this.#upGuardReleasedAtSamples !== null,
              fresh_samples: this.#upGuardFreshSamples(sampleCount),
            }
          : null,
        rules,
        skipped: evaluation.skipped,
        chosen:
          switchRequest === null
            ? null
            : {
                index: switchRequest.representationIndex,
                priority: switchRequest.priority,
                reason: switchRequest.reason,
                rule: evaluation.chosenBy,
                tied: evaluation.tied,
              },
      });
    }
    if (switchRequest === null) return;

    const targetIndex = Math.min(switchRequest.representationIndex, capIdx);

    // Only switch if the target differs from current
    if (targetIndex === currentIdx) return;

    // Startup slow-start: gate *upswitches* until enough real per-group
    // throughput samples have accumulated. The startup signal over-reads the
    // sustainable rate, so an early burst must not trigger a climb above the
    // conservatively-chosen startup tier. Downswitches are always permitted
    // (an emergency drop on a starved link can't wait for samples).
    if (targetIndex > currentIdx && sampleCount < AbrController.MIN_STARTUP_SAMPLES) {
      events.emit('ABR_GATED', {
        why: 'slow-start',
        from_index: currentIdx,
        to_index: targetIndex,
        sample_count: sampleCount,
        min_samples: AbrController.MIN_STARTUP_SAMPLES,
      });
      return;
    }

    // Post-switch up-guard: an up-switch waits until the previous switch has
    // been released and upGuardSamples fresh throughput samples describe the
    // link as it is after that switch. Down-switches pass.
    if (targetIndex > currentIdx && this.#upGuardArmed) {
      const needed = this.#settings.controller?.upGuardSamples ?? 0;
      const fresh = this.#upGuardFreshSamples(sampleCount);
      if (fresh === null || fresh < needed) {
        events.emit('ABR_GATED', {
          why: 'post-switch-up-guard',
          from_index: currentIdx,
          to_index: targetIndex,
          released: fresh !== null,
          fresh_samples: fresh,
          min_samples: needed,
          rule_reason: switchRequest.reason,
        });
        return;
      }
      this.#upGuardArmed = false;
    }

    // min arm: up-switch dwell. No up-switch until upDwellGroups completed
    // groups of the landed track have arrived since the last landing (before
    // the first landing: since startup). Down-switches pass.
    if (targetIndex > currentIdx && isMin) {
      const needed = this.#settings.controller.upDwellGroups;
      const groups =
        context.groupsSinceLanding ??
        (activeTrack !== null ? raw.samplesByTrack?.[activeTrack] : undefined) ??
        sampleCount;
      if (groups < needed) {
        events.emit('ABR_GATED', {
          why: 'up-dwell',
          from_index: currentIdx,
          to_index: targetIndex,
          groups_since_landing: groups,
          min_groups: needed,
          rule_reason: switchRequest.reason,
        });
        return;
      }
    }

    const targetTrack = this.#tracks[targetIndex];
    if (!targetTrack) return;

    // Determine switch reason
    const currentBitrate =
      activeTrackIndex >= 0 ? (this.#tracks[activeTrackIndex]?.bitrate ?? 0) : 0;
    const targetBitrate = targetTrack.bitrate ?? 0;
    // auto-emergency is the label of a down-switch chosen from
    // EmergencyBufferRule's request (by rule identity, not by reason text; no
    // other rule produces it). SwitchHistoryRule counts it as a drop like
    // auto-downgrade.
    let reason: SwitchReason;
    if (targetBitrate < currentBitrate) {
      reason = evaluation.chosenBy === 'EmergencyBufferRule' ? 'auto-emergency' : 'auto-downgrade';
    } else {
      reason = 'auto-upgrade';
    }

    // Activate the switching guard and send the switch. History, ABR_DECISION,
    // the up-guard arm and tracksize wait for the landing (onTrackSwitched).
    this.#switching = true;
    this.#switchingStartTs = Date.now();
    this.#framesAtSwitch = totalFrames;
    this.#pendingFrameAdvance = false;
    this.#pendingSwitch = {
      fromTrack: activeTrack ?? '',
      toTrack: targetTrack.name,
      fromIndex: currentIdx,
      toIndex: targetIndex,
      fromBitrate: currentBitrate,
      toBitrate: targetBitrate,
      reason,
      ruleReason: switchRequest.reason,
      rule: evaluation.chosenBy,
      tiedRules: evaluation.tied,
      priority: switchRequest.priority,
      bufferSeconds: bufferInstantSeconds,
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      probeBps: context.probeBandwidthBps,
      latencyTrend: latencyTrendRatio,
      groupsSinceLanding: context.groupsSinceLanding ?? null,
      msPastSeam: msPastSeamOf(raw),
      decidedTs: Date.now(),
    };
    void this.#player.switchTrack(targetTrack.name);
  }

  #updateDynamicStrategy(bufferLevel: number): void {
    // Skip if L2A or LoLP is active — they manage strategy themselves
    if (
      this.#rulesCollection.isRuleActive('L2ARule') ||
      this.#rulesCollection.isRuleActive('LoLPRule')
    ) {
      return;
    }
    // No BOLA, no DYNAMIC toggle: with BolaRule inactive (the min arm) the
    // toggle would only silence ThroughputRule above bufferTimeDefault.
    if (!this.#rulesCollection.isRuleActive('BolaRule')) {
      if (this.#usingBolaRule) {
        this.#usingBolaRule = false;
        events.emit('ABR_STRATEGY', { using_bola: false, buffer_s: bufferLevel });
      }
      this.#rulesCollection.setShouldUseBolaRule(false);
      return;
    }

    const switchOnThreshold = this.#settings.bufferTimeDefault; // 18s by default
    const switchOffThreshold = 0.5 * this.#settings.bufferTimeDefault; // 9s by default

    // Hysteresis: use the current state to pick which threshold to compare against
    const wasUsingBola = this.#usingBolaRule;
    this.#usingBolaRule =
      bufferLevel >= (this.#usingBolaRule ? switchOffThreshold : switchOnThreshold);
    if (wasUsingBola !== this.#usingBolaRule) {
      events.emit('ABR_STRATEGY', { using_bola: this.#usingBolaRule, buffer_s: bufferLevel });
    }

    this.#rulesCollection.setShouldUseBolaRule(this.#usingBolaRule);
  }

  #recordHistory(p: PendingSwitch): void {
    const event: SwitchEvent = {
      ts: Date.now(),
      fromTrack: p.fromTrack,
      toTrack: p.toTrack,
      reason: p.reason,
      bufferAtSwitch: p.bufferSeconds,
      emaBwAtSwitch: p.fastEmaBps,
      groupsSinceLanding: p.groupsSinceLanding ?? undefined,
      ...(p.msPastSeam !== undefined ? { msPastSeam: p.msPastSeam } : {}),
    };

    this.#switchHistory.push(event);

    if (this.#switchHistory.length > MAX_HISTORY) {
      this.#switchHistory.shift();
    }
  }
}
