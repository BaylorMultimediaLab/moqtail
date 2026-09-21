/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Live-edge and time-shift estimation from Producer Reference Time.
 *
 * The publisher stamps every CMAF chunk with a `prft` box carrying the wall
 * clock at which the chunk was produced (`captureMs`, UNIX ms) and that
 * chunk's media time (`mediaMs`, on the same timeline as MSE playback). At
 * wall-clock `nowMs`, the publisher has produced media up to roughly
 * `mediaMs + (nowMs - captureMs)`; that is the live-edge estimate.
 *
 *   liveEdgeDistanceMs = liveEdgePtsMs - playheadMs
 *   timeShiftErrorMs   = liveEdgeDistanceMs - targetShiftMs  (signed; positive
 *                        means the client is further behind than requested)
 *
 * The estimate is exact up to the publisher-to-client clock offset, which is
 * zero when all processes share a host, and to PRFT pacing jitter.
 */

export interface PrftAnchor {
  /** Publisher wall clock (UNIX ms) when the anchoring chunk was produced. */
  captureMs: number;
  /** Media time (ms, MSE timeline) of the anchoring chunk. */
  mediaMs: number;
}

export interface LiveEdgeEstimate {
  liveEdgePtsMs: number;
  liveEdgeDistanceMs: number;
  timeShiftErrorMs: number;
  /** Age of the anchor in ms; large values mean the estimate is extrapolated far. */
  anchorAgeMs: number;
}

export function estimateLiveEdge(opts: {
  anchor: PrftAnchor;
  nowMs: number;
  playheadMs: number;
  targetShiftMs: number;
}): LiveEdgeEstimate {
  const anchorAgeMs = opts.nowMs - opts.anchor.captureMs;
  const liveEdgePtsMs = opts.anchor.mediaMs + anchorAgeMs;
  const liveEdgeDistanceMs = liveEdgePtsMs - opts.playheadMs;
  return {
    liveEdgePtsMs,
    liveEdgeDistanceMs,
    timeShiftErrorMs: liveEdgeDistanceMs - opts.targetShiftMs,
    anchorAgeMs,
  };
}

/**
 * The time shift a client is asked to hold, in ms of media. A time-shifted client
 * requests `delayGroups` whole groups (the wire quantises the seconds value),
 * so the target is stated in groups times GOP duration rather than in the
 * seconds the user typed. An live-edge client targets the player's own
 * live-edge delay.
 */
export function targetShiftMs(opts: {
  clientMode: 'time-shifted' | 'live-edge';
  timeShiftSeconds: number;
  gopDurationMs: number;
  liveEdgeDelaySeconds: number;
}): { targetShiftMs: number; delayGroups: number } {
  if (opts.clientMode === 'time-shifted' && opts.timeShiftSeconds > 0 && opts.gopDurationMs > 0) {
    const delayGroups = Math.round((opts.timeShiftSeconds * 1000) / opts.gopDurationMs);
    return { targetShiftMs: delayGroups * opts.gopDurationMs, delayGroups };
  }
  return { targetShiftMs: opts.liveEdgeDelaySeconds * 1000, delayGroups: 0 };
}

const NTP_UNIX_DELTA_SECONDS = 2_208_988_800;

/**
 * Parse the `prft` box at the head of a CMAF chunk (ISO/IEC 14496-12 §8.16.5,
 * version 1). Returns the producer wall clock in UNIX ms and the raw
 * `media_time` in track timescale units, or null if the chunk does not start
 * with a prft box.
 */
export function readPrft(buf: Uint8Array): { captureMs: number; mediaTime: number } | null {
  if (buf.byteLength < 32) return null;
  // 'p'=0x70, 'r'=0x72, 'f'=0x66, 't'=0x74
  if (buf[4] !== 0x70 || buf[5] !== 0x72 || buf[6] !== 0x66 || buf[7] !== 0x74) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ntpSeconds = view.getUint32(16, false);
  const ntpFraction = view.getUint32(20, false);
  const captureMs =
    (ntpSeconds - NTP_UNIX_DELTA_SECONDS) * 1000 + (ntpFraction / 0x1_0000_0000) * 1000;
  // media_time is a u64; the media timeline never approaches 2^53 units.
  const mediaTime = Number(view.getBigUint64(24, false));
  return { captureMs, mediaTime };
}
