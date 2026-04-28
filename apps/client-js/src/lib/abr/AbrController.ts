import type { Player } from '@/lib/player';
import type { AbrRulesCollection } from './AbrRulesCollection';
import { ProbeManager } from './ProbeManager';
import {
  type AbrSettings,
  type RulesContext,
  type SwitchEvent,
  type SwitchReason,
  type Track,
} from './types';

export interface AbrMetrics {
  bandwidthBps: number;
  fastEmaBps: number;
  slowEmaBps: number;
  bufferSeconds: number;
  activeTrack: string | null;
  activeTrackIndex: number;
  droppedFrames: number;
  totalFrames: number;
  playbackRate: number;
  deliveryTimeMs: number;
  lastObjectBytes: number;
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

const MAX_HISTORY = 60;

export class AbrController {
  #player: Pick<
    Player,
    'getMetrics' | 'switchTrack' | 'setEmaHalfLives' | 'probeTrackBandwidth' | 'abortPendingSwitch'
  >;
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
  static readonly SWITCH_TIMEOUT_MS = 3000;
  // After a switch times out (init segment never arrived — typical under severe
  // packet loss or a fleeting bandwidth spike), hold off this long before
  // running rules again. Without the cooldown the ABR re-fires the same
  // switch every SWITCH_TIMEOUT_MS, generating unbounded downswitch events
  // while activeTrack never changes.
  static readonly SWITCH_COOLDOWN_MS = 5_000;
  // Carry-over bitrate delta from the most recent switch. Used in the
  // thesis Algorithm 1 probe_size formula: probe_size = t · (b[i+1] - b[i]
  // + tracksize). Initialized to 0; updated whenever a switch fires.
  #tracksize = 0;
  // Probe time horizon (seconds). Thesis uses t=2s and sizes the probe
  // payload to match. Our relay sends the synthesized payload as fast as
  // the link allows, so this is "the bitrate window the probe is supposed
  // to test", not the actual on-wire duration.
  #probeHorizonSec = 2;

  constructor(
    player: Pick<
      Player,
      | 'getMetrics'
      | 'switchTrack'
      | 'setEmaHalfLives'
      | 'probeTrackBandwidth'
      | 'abortPendingSwitch'
    >,
    rulesCollection: AbrRulesCollection,
    tracks: Track[],
    settings: AbrSettings,
    onMetricsUpdate: (m: AbrMetrics) => void,
  ) {
    this.#player = player;
    this.#rulesCollection = rulesCollection;
    // Sort ascending by bitrate — index 0 = lowest quality, last = highest
    this.#tracks = [...tracks].sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
    this.#settings = settings;
    this.#onMetricsUpdate = onMetricsUpdate;
    this.#probeManager = new ProbeManager(this.#player);
    this.#player.setEmaHalfLives(
      settings.ewma.throughputFastHalfLifeSeconds,
      settings.ewma.throughputSlowHalfLifeSeconds,
    );
  }

  start(): void {
    if (this.#intervalId !== null) return;
    this.#intervalId = setInterval(() => void this._tick(), 250);
  }

  stop(): void {
    if (this.#intervalId !== null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  updateSettings(settings: AbrSettings): void {
    this.#settings = settings;
    this.#player.setEmaHalfLives(
      settings.ewma.throughputFastHalfLifeSeconds,
      settings.ewma.throughputSlowHalfLifeSeconds,
    );
  }

  releaseSwitchingGuard(): void {
    // Player fires this when the new track's init segment has been applied.
    // Defer actually clearing #switching until totalVideoFrames advances past
    // the snapshot — that's when MSE has decoded an actual frame from the new
    // track. Prevents rapid switches from shredding the MSE timeline.
    this.#pendingFrameAdvance = true;
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
    this.#recordHistory(m.activeTrack ?? '', trackName, 'manual', 0, 0);
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
      activeTrack,
      droppedFrames,
      totalFrames,
      playbackRate,
      deliveryTimeMs,
      lastObjectBytes,
      readyState,
      paused,
      currentTime,
      bufferedRanges,
      mseReadyState,
      videoErrorCode,
      latencyTrendRatio,
      lastLatencyMs,
    } = raw;

    // Find the active track index in the sorted tracks array
    const activeTrackIndex = activeTrack ? this.#tracks.findIndex(t => t.name === activeTrack) : -1;

    const mode: 'auto' | 'manual' = this.#settings.videoAutoSwitch ? 'auto' : 'manual';

    const metrics: AbrMetrics = {
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      bufferSeconds,
      activeTrack,
      activeTrackIndex,
      droppedFrames,
      totalFrames,
      playbackRate,
      deliveryTimeMs,
      lastObjectBytes,
      switchHistory: [...this.#switchHistory],
      mode,
      switching: this.#switching,
      readyState,
      paused,
      currentTime,
      bufferedRanges,
      mseReadyState,
      videoErrorCode,
      latencyTrendRatio,
      lastLatencyMs,
    };

    this.#onMetricsUpdate(metrics);

    // Once the player signals the init segment landed, hold #switching until
    // a real new-track frame is decoded (totalVideoFrames moved past the
    // snapshot). Only then is it safe to consider another switch.
    if (this.#pendingFrameAdvance && totalFrames > this.#framesAtSwitch) {
      this.#switching = false;
      this.#pendingFrameAdvance = false;
    }

    // Switching guard timeout: if #switching has been held longer than
    // SWITCH_TIMEOUT_MS without releasing, the chosen target is unfulfillable
    // (typical case: upswitch fired right before a regime change drops the
    // link below the new target's source rate). Force-release so ABR can
    // re-evaluate; abort the dead pendingSwitch in the player so stale data
    // arriving on the wedged track doesn't accidentally land later.
    //
    // Relay state on timeout: we only clear client-side state. The relay's
    // `switch_context` (apps/relay/src/server/client/switch_context.rs) is
    // a HashMap<track, Current|Next|None> with uniqueness enforced on each
    // update. The next SWITCH ABR fires uses the same subscription_request_id
    // and gets handled by handle_switch_message — the relay treats the
    // abandoned target as the new switch-from track and overwrites the
    // HashMap entries cleanly. Stale data still queued at the relay arrives
    // after the new pendingSwitch is set; the write-handler's
    // `objectTrackName !== struct.pendingSwitch?.trackName` filter drops it.
    if (this.#switching && Date.now() - this.#switchingStartTs > AbrController.SWITCH_TIMEOUT_MS) {
      this.#switching = false;
      this.#pendingFrameAdvance = false;
      this.#player.abortPendingSwitch?.();
      this.#switchBackoffUntil = Date.now() + AbrController.SWITCH_COOLDOWN_MS;
    }

    // Manual mode — don't make automatic decisions
    if (!this.#settings.videoAutoSwitch) return;

    // Switching guard — wait for previous switch to complete
    if (this.#switching) return;

    // Post-timeout cooldown — don't re-fire rules immediately after a failed switch
    if (Date.now() < this.#switchBackoffUntil) return;

    // Update DYNAMIC strategy based on buffer level
    this.#updateDynamicStrategy(bufferSeconds);

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
    if (currentIdx < this.#tracks.length - 1) {
      const bI = this.#tracks[currentIdx]?.bitrate ?? 0;
      const bIPlus1 = this.#tracks[currentIdx + 1]?.bitrate ?? 0;
      const gapBits = Math.max(0, bIPlus1 - bI);
      const probeSizeBits = this.#probeHorizonSec * (gapBits + this.#tracksize);
      const probeSizeBytes = Math.max(1024, Math.floor(probeSizeBits / 8));
      this.#probeManager.maybeProbe(`.probe:${probeSizeBytes}:0`);
    }

    // Build context for rules
    const context: RulesContext = {
      tracks: this.#tracks,
      activeTrackIndex: currentIdx,
      bufferSeconds,
      bandwidthBps,
      fastEmaBps,
      slowEmaBps,
      droppedFrames,
      totalFrames,
      segmentDurationS: 1,
      isLowLatency: false,
      playbackRate,
      switchHistory: [...this.#switchHistory],
      abrSettings: this.#settings,
      probeBandwidthBps: this.#probeManager.getFreshBandwidthBps(),
      latencyTrendRatio,
    };

    const switchRequest = this.#rulesCollection.getBestPossibleSwitchRequest(context);
    if (switchRequest === null) return;

    const targetIndex = switchRequest.representationIndex;

    // Only switch if the target differs from current
    if (targetIndex === currentIdx) return;

    const targetTrack = this.#tracks[targetIndex];
    if (!targetTrack) return;

    // Determine switch reason
    const currentBitrate =
      activeTrackIndex >= 0 ? (this.#tracks[activeTrackIndex]?.bitrate ?? 0) : 0;
    const targetBitrate = targetTrack.bitrate ?? 0;
    let reason: SwitchReason;
    if (targetBitrate < currentBitrate) {
      reason = switchRequest.reason.toLowerCase().includes('emergency')
        ? 'auto-emergency'
        : 'auto-downgrade';
    } else {
      reason = 'auto-upgrade';
    }

    // Activate switching guard, record history, and switch
    this.#switching = true;
    this.#switchingStartTs = Date.now();
    this.#framesAtSwitch = totalFrames;
    this.#pendingFrameAdvance = false;
    this.#recordHistory(activeTrack ?? '', targetTrack.name, reason, bufferSeconds, fastEmaBps);
    // Update tracksize (Algorithm 1 lines 13/16): after upswitch, carry
    // forward the gap from new current to next-up; after downswitch,
    // carry forward the gap from previous tier to new current. Either
    // way the value is the bitrate delta of the tier that's currently
    // adjacent to the new position in the SAME direction as the switch.
    if (targetIndex > currentIdx) {
      // upswitch: tracksize = b[newIdx+1] - b[newIdx]
      const next = this.#tracks[targetIndex + 1]?.bitrate ?? targetBitrate;
      this.#tracksize = Math.max(0, next - targetBitrate);
    } else if (targetIndex < currentIdx) {
      // downswitch: tracksize = b[newIdx] - b[newIdx-1]
      const prev = this.#tracks[targetIndex - 1]?.bitrate ?? targetBitrate;
      this.#tracksize = Math.max(0, targetBitrate - prev);
    }
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

    const switchOnThreshold = this.#settings.bufferTimeDefault; // 18s by default
    const switchOffThreshold = 0.5 * this.#settings.bufferTimeDefault; // 9s by default

    // Hysteresis: use the current state to pick which threshold to compare against
    this.#usingBolaRule =
      bufferLevel >= (this.#usingBolaRule ? switchOffThreshold : switchOnThreshold);

    this.#rulesCollection.setShouldUseBolaRule(this.#usingBolaRule);
  }

  #recordHistory(
    fromTrack: string,
    toTrack: string,
    reason: SwitchReason,
    bufferAtSwitch: number,
    emaBwAtSwitch: number,
  ): void {
    const event: SwitchEvent = {
      ts: Date.now(),
      fromTrack,
      toTrack,
      reason,
      bufferAtSwitch,
      emaBwAtSwitch,
    };

    this.#switchHistory.push(event);

    if (this.#switchHistory.length > MAX_HISTORY) {
      this.#switchHistory.shift();
    }
  }
}
