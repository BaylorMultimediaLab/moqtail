import { describe, it, expect } from 'vitest';
import { FullTrackName, GroupOrder, Tuple } from 'moqtail';
import { GroupOrderParam, SubscriberPriority } from 'moqtail/model';
import {
  MEDIA_SCHEDULING,
  buildSubscribeParameters,
  buildSwitchParameters,
  computeStartupTarget,
  computeSwitchMinimumGroup,
  highestCompleteBufferedGroup,
  switchFailureKind,
  unroutedDropFields,
} from './player';
import { TimeMap } from './abr/TimeMap';

describe('buildSubscribeParameters', () => {
  it('returns undefined for live-edge mode', () => {
    const params = buildSubscribeParameters({
      clientMode: 'live-edge',
      timeShiftSeconds: 2,
      gopDurationMs: 1000,
    });
    expect(params).toBeUndefined();
  });

  it('returns undefined for time-shifted with zero delay', () => {
    const params = buildSubscribeParameters({
      clientMode: 'time-shifted',
      timeShiftSeconds: 0,
      gopDurationMs: 1000,
    });
    expect(params).toBeUndefined();
  });

  it('builds a parameter list with DELAY_GROUPS for time-shifted + 2s delay + 1000ms GOP', () => {
    const params = buildSubscribeParameters({
      clientMode: 'time-shifted',
      timeShiftSeconds: 2,
      gopDurationMs: 1000,
    });
    expect(params).toBeDefined();
    const kvps = params!.map(p => p.toKeyValuePair());
    expect(kvps).toHaveLength(1);
    expect(kvps[0]!.typeValue).toBe(0x70n);
    expect(kvps[0]!.value).toBe(2n);
  });

  it('rounds 1.7s delay with 1000ms GOP to 2 groups', () => {
    const params = buildSubscribeParameters({
      clientMode: 'time-shifted',
      timeShiftSeconds: 1.7,
      gopDurationMs: 1000,
    });
    expect(params![0]!.toKeyValuePair().value).toBe(2n);
  });

  it('handles 500ms GOP correctly: 2s delay → 4 groups', () => {
    const params = buildSubscribeParameters({
      clientMode: 'time-shifted',
      timeShiftSeconds: 2,
      gopDurationMs: 500,
    });
    expect(params![0]!.toKeyValuePair().value).toBe(4n);
  });
});

describe('computeSwitchMinimumGroup', () => {
  it('next-group floor lands at the next boundary after the latest received group', () => {
    // latestGroup + 1: the relay identifies G_switch within T_switch, waiting
    // for a not-yet-started group, so naming the NEXT boundary is safe and
    // lands the switch with no redelivery and no catch-up.
    const r = computeSwitchMinimumGroup({
      switchFloor: 'next-group',
      targetGroup: 42,
      latestGroup: 17n,
    });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(false);
  });

  it('next-group floor before any object arrives sends the spec floor 0', () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'next-group',
      targetGroup: undefined,
      latestGroup: -1n,
    });
    expect(r.minimumSwitchingGroupId).toBe(0);
    expect(r.timeMapMiss).toBe(false);
  });

  it('uses the target group as the floor for the playhead floor with a target', () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'playhead',
      targetGroup: 42,
      latestGroup: 17n,
    });
    expect(r.minimumSwitchingGroupId).toBe(42);
    expect(r.timeMapMiss).toBe(false);
  });

  it('flags timeMapMiss when playhead floor has no target, falling through to next-group', () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'playhead',
      targetGroup: undefined,
      latestGroup: 17n,
    });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(true);
  });

  it("does NOT flag miss when next-group + no target (next-group doesn't need TimeMap)", () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'next-group',
      targetGroup: undefined,
      latestGroup: 17n,
    });
    expect(r.minimumSwitchingGroupId).toBe(18);
    expect(r.timeMapMiss).toBe(false);
  });

  it('playhead miss before any object arrives falls all the way to 0', () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'playhead',
      targetGroup: undefined,
      latestGroup: -1n,
    });
    expect(r.minimumSwitchingGroupId).toBe(0);
    expect(r.timeMapMiss).toBe(true);
  });
});

describe('computeSwitchMinimumGroup (buffer-aware next-group)', () => {
  it('takes 1 + max(latest received, highest complete buffered group)', () => {
    const r = computeSwitchMinimumGroup({
      switchFloor: 'next-group',
      targetGroup: undefined,
      latestGroup: 105n,
      bufferedGroup: 108,
    });
    expect(r.minimumSwitchingGroupId).toBe(109);
    expect(r.recvFloorGroup).toBe(106);
    expect(r.bufferFloorGroup).toBe(109);
  });

  it('keeps the transport floor when the buffer is behind or unknown', () => {
    expect(
      computeSwitchMinimumGroup({
        switchFloor: 'next-group',
        targetGroup: undefined,
        latestGroup: 105n,
        bufferedGroup: 100,
      }).minimumSwitchingGroupId,
    ).toBe(106);
    const r = computeSwitchMinimumGroup({
      switchFloor: 'next-group',
      targetGroup: undefined,
      latestGroup: 105n,
    });
    expect(r.minimumSwitchingGroupId).toBe(106);
    expect(r.bufferFloorGroup).toBeNull();
  });

  it('does not change the playhead floor', () => {
    expect(
      computeSwitchMinimumGroup({
        switchFloor: 'playhead',
        targetGroup: 103,
        latestGroup: 105n,
        bufferedGroup: 108,
      }).minimumSwitchingGroupId,
    ).toBe(103);
  });
});

describe('highestCompleteBufferedGroup', () => {
  const tm = new TimeMap(1000);
  tm.recordGroupBoundary(100, 100000);

  it('counts only groups whose whole span is inside one range ahead of the playhead', () => {
    // 109 is partially present (ends at 109.6): the highest complete group is 108.
    expect(
      highestCompleteBufferedGroup({ ranges: [[94, 109.6]], timeMap: tm, playheadMs: 108600 }),
    ).toBe(108);
    // Range end exactly on a boundary: 109 is complete.
    expect(
      highestCompleteBufferedGroup({ ranges: [[94, 110.0]], timeMap: tm, playheadMs: 108600 }),
    ).toBe(109);
    // Frame-boundary rounding within the tolerance still counts.
    expect(
      highestCompleteBufferedGroup({
        ranges: [[94, 109.99]],
        timeMap: tm,
        playheadMs: 108600,
        tolMs: 25,
      }),
    ).toBe(109);
  });

  it('uses the whole buffered horizon, ignoring ranges behind the playhead', () => {
    expect(
      highestCompleteBufferedGroup({
        ranges: [
          [13, 22.67],
          [94, 109.6],
          [111, 112],
        ],
        timeMap: tm,
        playheadMs: 108600,
      }),
    ).toBe(111);
    expect(
      highestCompleteBufferedGroup({ ranges: [[13, 22.67]], timeMap: tm, playheadMs: 108600 }),
    ).toBeUndefined();
  });

  it('is undefined when a range holds no complete group or the TimeMap has no anchor', () => {
    expect(
      highestCompleteBufferedGroup({ ranges: [[108.5, 109.6]], timeMap: tm, playheadMs: 108600 }),
    ).toBeUndefined();
    expect(
      highestCompleteBufferedGroup({
        ranges: [[94, 110]],
        timeMap: new TimeMap(1000),
        playheadMs: 100,
      }),
    ).toBeUndefined();
  });
});

describe('computeStartupTarget', () => {
  it('subtracts 1.0s from end for live-edge mode', () => {
    const t = computeStartupTarget({ end: 10, baseTarget: 0, clientMode: 'live-edge' });
    expect(t).toBeCloseTo(9.0);
  });

  it('does not subtract anything for time-shifted mode (already behind live)', () => {
    const t = computeStartupTarget({ end: 10, baseTarget: 0, clientMode: 'time-shifted' });
    expect(t).toBeCloseTo(10.0);
  });

  it('preserves baseTarget when it exceeds the offset-adjusted end (live-edge)', () => {
    // baseTarget 9.5 > end-1 (9.0) -> max wins
    const t = computeStartupTarget({ end: 10, baseTarget: 9.5, clientMode: 'live-edge' });
    expect(t).toBeCloseTo(9.5);
  });

  it('preserves baseTarget when it exceeds end in time-shifted mode', () => {
    // shouldn't happen in practice, but max() semantic is preserved
    const t = computeStartupTarget({ end: 10, baseTarget: 11, clientMode: 'time-shifted' });
    expect(t).toBeCloseTo(11);
  });

  it('subtracts timeShiftSeconds for time-shifted mode when provided', () => {
    // bufferEdge=30, delay=30 → target=0 (player starts already 30s behind buffer end)
    expect(
      computeStartupTarget({
        end: 30,
        baseTarget: 0,
        clientMode: 'time-shifted',
        timeShiftSeconds: 30,
      }),
    ).toBeCloseTo(0);
  });

  it('subtracts smaller timeShiftSeconds correctly', () => {
    // bufferEdge=10, delay=2 → target=8 (player 2s behind buffer end)
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'time-shifted',
        timeShiftSeconds: 2,
      }),
    ).toBeCloseTo(8);
  });

  it('preserves baseTarget when it exceeds end - timeShiftSeconds', () => {
    // baseTarget 5 > end-delay (30-30=0) → max wins
    expect(
      computeStartupTarget({
        end: 30,
        baseTarget: 5,
        clientMode: 'time-shifted',
        timeShiftSeconds: 30,
      }),
    ).toBeCloseTo(5);
  });

  it('falls back to 0 offset when time-shifted + timeShiftSeconds undefined', () => {
    // Backward-compat: existing behavior when caller forgets to pass it.
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'time-shifted',
      }),
    ).toBeCloseTo(10);
  });

  it('ignores timeShiftSeconds in live-edge mode', () => {
    // Even if caller passes timeShiftSeconds, live-edge uses LIVE_EDGE_STARTUP_OFFSET_SECONDS.
    expect(
      computeStartupTarget({
        end: 10,
        baseTarget: 0,
        clientMode: 'live-edge',
        timeShiftSeconds: 5,
      }),
    ).toBeCloseTo(9);
  });
});

// M15: a data stream the library cancelled because no subscription claimed its
// alias becomes DROP_STALE{reason:'unrouted'} with the bytes it cost.
describe('unroutedDropFields', () => {
  it('names the track the alias last mapped to, the group and the bytes', () => {
    const ftn = FullTrackName.tryNew(
      Tuple.fromUtf8Path('/moqtail'),
      new TextEncoder().encode('720p'),
    );
    expect(
      unroutedDropFields(
        {
          reason: 'unrouted',
          trackAlias: 7n,
          groupId: 42n,
          subgroupId: 0n,
          fullTrackName: ftn,
          bytes: 1234,
        },
        { current: '480p', pending: null },
      ),
    ).toEqual({
      reason: 'unrouted',
      track: '720p',
      current: '480p',
      pending: null,
      group: 42,
      subgroup: 0,
      track_alias: 7,
      bytes: 1234,
    });
  });

  it('reports a null track when the alias is no longer known', () => {
    expect(
      unroutedDropFields(
        {
          reason: 'unrouted',
          trackAlias: 9n,
          groupId: 1n,
          subgroupId: undefined,
          fullTrackName: undefined,
          bytes: 10,
        },
        { current: '480p', pending: '720p' },
      ),
    ).toMatchObject({ track: null, subgroup: null, pending: '720p', bytes: 10 });
  });
});

// Transport fairness: the relay schedules by subscriber priority, then group
// order. A SWITCH without them fell back to priority 128 on the relay (C3 on
// pr1378, and the native promoted subscription on harness), below the old
// subscription's leftovers and the probe.
describe('media scheduling parameters (transport fairness)', () => {
  it('SUBSCRIBE: subscriber priority 0, ascending group order', () => {
    expect(MEDIA_SCHEDULING).toEqual({ priority: 0, groupOrder: GroupOrder.Ascending });
  });

  it('SWITCH carries SubscriberPriority(0) and GroupOrder(Ascending) explicitly', () => {
    expect(buildSwitchParameters().map(p => p.toKeyValuePair())).toEqual([
      new SubscriberPriority(0).toKeyValuePair(),
      new GroupOrderParam(GroupOrder.Ascending).toKeyValuePair(),
    ]);
  });
});

describe('switchFailureKind (P6)', () => {
  it('names the relay failure from its reason phrase', () => {
    expect(switchFailureKind('switch: NoCommonBoundary')).toBe('NoCommonBoundary');
    expect(switchFailureKind('switch: DrainTimeout')).toBe('DrainTimeout');
    expect(switchFailureKind('switch: Superseded')).toBe('Superseded');
    expect(switchFailureKind('switch: AlreadyInFlight')).toBe('AlreadyInFlight');
  });

  it('tells the client-side response deadline apart from every relay answer', () => {
    expect(switchFailureKind('no relay response to SWITCH within 6000 ms')).toBe('ClientTimeout');
  });

  it('keeps anything else as unknown', () => {
    expect(switchFailureKind('')).toBe('unknown');
  });
});
