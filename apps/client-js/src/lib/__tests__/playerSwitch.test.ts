import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Tuple } from 'moqtail';
import { SwitchFailure } from 'moqtail/client';
import { SwitchTransition } from 'moqtail/model';
import { Player } from '@/lib/player';
import { events } from '@/lib/events/EventLog';
import { SwitchHold } from '@/lib/switchSources';
import { GoodputTracker } from '@/lib/goodput';

/**
 * Player.switchTrack against a fake MOQtail client and catalog: no relay, no
 * MSE. Covers what the player tells the controller about a switch.
 *
 * pr1378: the fake's switch() answers like the library does under SWITCH PR
 * #1378, with a SwitchSuccess (relay-allocated request id, the PUBLISH's object
 * stream, SWITCH_TRANSITION) or a SwitchFailure (PUBLISH_DONE status).
 */

/** What MOQtailClient.switch resolves with on success (pr1378). */
function switchSuccess(requestId: bigint, switchingGroup = 5n, liveEdge = 6n) {
  return {
    requestId,
    stream: new ReadableStream(),
    largestLocation: undefined,
    switchTransition: new SwitchTransition(switchingGroup, liveEdge),
  };
}

const refusal = () => new SwitchFailure(0xa as never, 'switch: NoCommonBoundary');

type Emitted = Array<[string, Record<string, unknown>]>;

function fakeCatalog() {
  return {
    getRole: (name: string) => (name === 'catalog' ? undefined : 'video'),
    getInitData: () => new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]),
    getCodecString: () => 'hvc1.1.6.L93.B0',
    getTimescale: () => 90_000,
    getGopDurationMs: () => 1000,
  };
}

async function makePlayer(
  opts: { switchResult?: (req: { subscriptionRequestId: bigint }) => Promise<unknown> } = {},
) {
  const player = new Player({ namespace: Tuple.fromUtf8Path('/test') });
  const aliasMap = new Map<bigint, bigint>();
  let nextId = 10n;
  const client = {
    subscriptionAliasMap: aliasMap,
    allocateNextRequestId: () => nextId++,
    subscribe: vi.fn(async () => ({
      requestId: 1n,
      stream: new ReadableStream(),
      largestLocation: undefined,
    })),
    switch: vi.fn(opts.switchResult ?? (async () => switchSuccess(nextId++))),
    unsubscribe: vi.fn(async () => {}),
  };
  player.client = client as unknown as Player['client'];
  player.catalog = fakeCatalog() as unknown as Player['catalog'];
  await (player as unknown as { subscribe(p: { trackName: string }): Promise<unknown> }).subscribe({
    trackName: '360p',
  });
  aliasMap.set(1n, 7n); // the startup subscription is routed
  const callbacks: Array<[string, number | undefined]> = [];
  player.setOnTrackSwitched((track, seq) => callbacks.push([track, seq]));
  return { player, client, aliasMap, callbacks };
}

describe('Player.switchTrack: the switch_seq it allocated (F14)', () => {
  let emitted: Emitted;
  beforeEach(() => {
    emitted = [];
    vi.spyOn(events, 'emit').mockImplementation((e, f) => {
      emitted.push([e, (f ?? {}) as Record<string, unknown>]);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('exposes the seq synchronously, resolves to it, and SWITCH_SENT carries it', async () => {
    const { player } = await makePlayer();
    const p = player.switchTrack('720p');
    const seq = player.lastSwitchSeq;
    expect(typeof seq).toBe('number');
    expect(await p).toBe(seq);
    const sent = emitted.find(([e]) => e === 'SWITCH_SENT')![1];
    expect(sent.switch_seq).toBe(seq);
  });

  it('a skipped switch calls back with the old track and the seq it was given', async () => {
    const { player, aliasMap, callbacks } = await makePlayer();
    aliasMap.clear(); // previous switch not landed
    const p = player.switchTrack('720p');
    const seq = player.lastSwitchSeq;
    expect(await p).toBe(seq);
    expect(callbacks).toEqual([['360p', seq]]);
    expect(emitted.find(([e]) => e === 'SWITCH_SKIPPED')![1].switch_seq).toBe(seq);
  });

  it('a switch while one is in flight is skipped with its own seq and calls back (pr1378)', async () => {
    let release!: () => void;
    const { player, callbacks } = await makePlayer({
      switchResult: () =>
        new Promise(resolve => {
          release = () => resolve(switchSuccess(42n));
        }),
    });
    const first = player.switchTrack('720p');
    const firstSeq = player.lastSwitchSeq;
    const second = player.switchTrack('1080p');
    const secondSeq = player.lastSwitchSeq;
    expect(await second).toBe(secondSeq);
    expect(secondSeq).not.toBe(firstSeq);
    const skipped = emitted.find(([e]) => e === 'SWITCH_SKIPPED')![1];
    expect(skipped).toMatchObject({
      switch_seq: secondSeq,
      reason: 'switch in flight',
      to: '1080p',
    });
    expect(callbacks).toEqual([['360p', secondSeq]]);
    release();
    expect(await first).toBe(firstSeq);
  });

  it('SWITCH_FLOOR precedes SWITCH_SENT and carries the same switch_seq; the SWITCH carries the floor and the transport parameters', async () => {
    const { player, client } = await makePlayer();
    await player.switchTrack('720p');
    const names = emitted.map(([e]) => e);
    const floorAt = names.indexOf('SWITCH_FLOOR');
    const sentAt = names.indexOf('SWITCH_SENT');
    expect(floorAt).toBeGreaterThanOrEqual(0);
    expect(floorAt).toBeLessThan(sentAt);
    const floor = emitted[floorAt]![1];
    const sent = emitted[sentAt]![1];
    expect(floor.switch_seq).toBe(sent.switch_seq);
    expect(sent.request_id).toBeNull();
    expect(sent.minimum_switching_group).toBe(floor.selected_min_group);
    const args = client.switch.mock.calls[0]![0] as unknown as {
      minimumSwitchingGroupId: bigint;
      parameters: unknown[];
    };
    expect(typeof args.minimumSwitchingGroupId).toBe('bigint');
    expect(args.parameters).toHaveLength(2);
    const ok = emitted.find(([e]) => e === 'SWITCH_OK')![1];
    expect(ok).toMatchObject({
      switch_seq: sent.switch_seq,
      switching_group: 5,
      live_edge_group: 6,
    });
  });

  it('a refused switch calls back with the old track and its seq', async () => {
    const { player, callbacks } = await makePlayer({ switchResult: async () => refusal() });
    const p = player.switchTrack('720p');
    const seq = player.lastSwitchSeq;
    await p;
    expect(typeof seq).toBe('number');
    expect(callbacks).toEqual([['360p', seq]]);
  });
});

describe('Player.switchTrack: a target object that arrives before switch() resolves (F12)', () => {
  beforeEach(() => {
    vi.spyOn(events, 'emit').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('lands the switch instead of being dropped as stale', async () => {
    let routed: string | null = null;
    const env: { player?: Player } = {};
    const made = await makePlayer({
      switchResult: async () => {
        // pr1378: the old subscription stays mapped until its PUBLISH_DONE, so an
        // object of the target name reaching the write handler during the await
        // is the landing (the pump only reads the target's stream after this).
        routed = env.player!.routeVideoObject('720p');
        return switchSuccess(42n);
      },
    });
    env.player = made.player;
    await made.player.switchTrack('720p');
    expect(routed).toBe('land');
    expect(made.player.hasSwitchInFlight()).toBe(true);
  });

  it('a refused switch rolls the provisional arming back', async () => {
    const { player } = await makePlayer({ switchResult: async () => refusal() });
    await player.switchTrack('720p');
    expect(player.routeVideoObject('720p')).toBe('stale');
    expect(player.hasSwitchInFlight()).toBe(false);
  });

  it('a switch that throws rolls the provisional arming back', async () => {
    const { player } = await makePlayer({
      switchResult: async () => {
        throw new Error('boom');
      },
    });
    await player.switchTrack('720p');
    expect(player.routeVideoObject('720p')).toBe('stale');
    expect(player.hasSwitchInFlight()).toBe(false);
  });
});

describe('Player.switchTrack: the replaced subscription keeps being read (P1, audit M5)', () => {
  beforeEach(() => {
    vi.spyOn(events, 'emit').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("queues the PUBLISH's stream behind the replaced subscription instead of abandoning it", async () => {
    const { player } = await makePlayer({ switchResult: async () => switchSuccess(42n, 5n, 6n) });
    await player.switchTrack('720p');
    expect(player.videoRoutes()).toEqual([
      { requestId: 1n, trackName: '360p', seamGroup: 5n, publishDone: false },
      { requestId: 42n, trackName: '720p', seamGroup: null, publishDone: false },
    ]);
  });

  it('a refused switch queues nothing', async () => {
    const { player } = await makePlayer({ switchResult: async () => refusal() });
    await player.switchTrack('720p');
    expect(player.videoRoutes()).toEqual([
      { requestId: 1n, trackName: '360p', seamGroup: null, publishDone: false },
    ]);
  });
});

describe('Player.switchTrack: the hold of the replaced route ends when the switch resolves (R7-D2)', () => {
  beforeEach(() => {
    vi.spyOn(events, 'emit').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The relay may answer up to T_switch (3 s, counted from its own admission)
  // plus a round trip after SWITCH_SENT, and the library waits 6 s. A 3 s hold
  // bound from SWITCH_SENT released the hold before such a late success
  // ('bound-time': everything held appended, the post-seam duplicate included).
  it('a success 3.1 s after SWITCH_SENT still releases the hold with its seam', async () => {
    const release = vi.spyOn(SwitchHold.prototype, 'release');
    vi.useFakeTimers();
    const { player } = await makePlayer({
      switchResult: () =>
        new Promise(resolve => setTimeout(() => resolve(switchSuccess(42n, 5n, 6n)), 3100)),
    });
    const switching = player.switchTrack('720p');
    await vi.advanceTimersByTimeAsync(3050);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await switching;
    expect(release.mock.calls).toEqual([[5n]]);
  });

  it('a switch the library times out releases the hold at that resolution, as failed', async () => {
    const release = vi.spyOn(SwitchHold.prototype, 'release');
    vi.useFakeTimers();
    const { player } = await makePlayer({
      switchResult: () =>
        new Promise(resolve =>
          setTimeout(() => resolve(new SwitchFailure(0xa as never, 'ClientTimeout')), 6000),
        ),
    });
    const switching = player.switchTrack('720p');
    await vi.advanceTimersByTimeAsync(5990);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await switching;
    expect(release.mock.calls).toEqual([[undefined]]);
  });
});

describe("Player.handlePublishDone: the replaced subscription's PUBLISH_DONE (P5, audit M6)", () => {
  let emitted: Emitted;
  beforeEach(() => {
    emitted = [];
    vi.spyOn(events, 'emit').mockImplementation((e, f) => {
      emitted.push([e, (f ?? {}) as Record<string, unknown>]);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const done = { statusCode: 0x5, streamCount: 3n };

  it('arriving while the SWITCH is pending, it marks the subscription the switch replaces', async () => {
    let release!: () => void;
    const { player } = await makePlayer({
      switchResult: () =>
        new Promise(resolve => {
          release = () => resolve(switchSuccess(42n, 5n, 6n));
        }),
    });
    const switching = player.switchTrack('720p');
    // Close-After-Switch: the relay ends the source before it opens the target PUBLISH.
    player.handlePublishDone(done, 1n);
    const rec = emitted.find(([e]) => e === 'PUBLISH_DONE_RECV')![1];
    expect(rec).toMatchObject({
      request_id: 1n,
      role: 'current',
      switch_in_flight: true,
      pending_switch_seq: player.lastSwitchSeq,
      stream_count: 3,
    });
    release();
    await switching;
    expect(player.videoRoutes()[0]).toMatchObject({ requestId: 1n, publishDone: true });
  });

  it('arriving after SWITCH_OK, it is the replaced subscription', async () => {
    const { player } = await makePlayer({ switchResult: async () => switchSuccess(42n, 5n, 6n) });
    await player.switchTrack('720p');
    player.handlePublishDone(done, 1n);
    expect(emitted.find(([e]) => e === 'PUBLISH_DONE_RECV')![1]).toMatchObject({
      request_id: 1n,
      role: 'replaced',
      switch_in_flight: false,
    });
    expect(player.videoRoutes()[0]).toMatchObject({ requestId: 1n, publishDone: true });
  });

  it('for the current subscription with no switch pending, the source is gone', async () => {
    const { player } = await makePlayer();
    player.handlePublishDone(done, 1n);
    expect(emitted.find(([e]) => e === 'PUBLISH_DONE_RECV')![1]).toMatchObject({
      role: 'current',
      switch_in_flight: false,
      pending_switch_seq: null,
    });
  });
});

describe('Player.probeTrackBandwidth: PROBE object timestamps (F13)', () => {
  let probes: Array<Record<string, unknown>>;
  beforeEach(() => {
    probes = [];
    vi.spyOn(events, 'emit').mockImplementation((e, f) => {
      if (e === 'PROBE') probes.push((f ?? {}) as Record<string, unknown>);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const probeStream = (objects: number, gapMs: number) =>
    new ReadableStream({
      async start(c) {
        for (let i = 0; i < objects; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, gapMs));
          c.enqueue({ isEndOfGroup: () => false, payload: new Uint8Array(1000) });
        }
        c.close();
      },
    });

  it('carries first_object_ms and last_object_ms (epoch ms) of the probe objects; dt_ms keeps its meaning', async () => {
    const { player, client } = await makePlayer();
    client.subscribe.mockResolvedValueOnce({
      requestId: 99n,
      stream: probeStream(3, 30),
      largestLocation: undefined,
    });
    const before = Date.now();
    await player.probeTrackBandwidth('.probe:3000:0', 500);
    const after = Date.now();
    expect(probes).toHaveLength(1);
    const p = probes[0]!;
    const first = p.first_object_ms as number;
    const last = p.last_object_ms as number;
    expect(typeof first).toBe('number');
    expect(first).toBeGreaterThanOrEqual(before);
    expect(last).toBeLessThanOrEqual(after);
    expect(last - first).toBeGreaterThanOrEqual(50);
    expect(p.dt_ms as number).toBeGreaterThanOrEqual(last - first);
  });

  it('null timestamps when no probe object arrived', async () => {
    const { player, client } = await makePlayer();
    client.subscribe.mockResolvedValueOnce({
      requestId: 99n,
      stream: probeStream(0, 0),
      largestLocation: undefined,
    });
    await player.probeTrackBandwidth('.probe:3000:0', 500);
    expect(probes[0]).toMatchObject({ first_object_ms: null, last_object_ms: null });
  });
});

/**
 * Preflight 2026-10-05 (pr1378 live-edge r2): the relay reuses a track's alias for
 * every subscription to it (draft-18 11.1 allows this for the same track), so a
 * late object of an earlier subscription to the target track was mapped to the
 * switched subscription, landed the switch one group below its start and was
 * appended over the buffered source group; the decoder failed (MEDIA_ERR_DECODE).
 * A target object below the source's last received group cannot be the switched
 * subscription's: native starts at or after what the relay sent of the source.
 */
describe('Player.switchTrack: late objects of an earlier subscription to the target track', () => {
  beforeEach(() => {
    vi.spyOn(events, 'emit').mockImplementation(() => {});
    vi.spyOn(GoodputTracker.prototype, 'getMaxGroup').mockReturnValue(60n);
  });
  afterEach(() => vi.restoreAllMocks());

  // pr1378: the bound is the Minimum Switching Group the SWITCH carried. With the
  // source's last received group at 60 the next-group floor is 61, so G60 (the
  // object that landed switch 8 in the preflight run) cannot be the target's.
  it('a target object below the Minimum Switching Group does not land the switch', async () => {
    const routed: Record<string, string | null> = {};
    const env: { player?: Player } = {};
    const made = await makePlayer({
      switchResult: async () => {
        routed.below = env.player!.routeVideoObject('720p', 59n);
        routed.lastReceived = env.player!.routeVideoObject('720p', 60n);
        routed.floor = env.player!.routeVideoObject('720p', 61n);
        return switchSuccess(42n, 61n, 66n);
      },
    });
    env.player = made.player;
    await made.player.switchTrack('720p');
    expect(routed).toEqual({
      below: 'earlier-subscription',
      lastReceived: 'earlier-subscription',
      floor: 'land',
    });
  });

  // Once SWITCH_OK names G_switch the bound rises to it: an earlier subscription's
  // object between the floor and G_switch cannot land the switch either.
  it('after SWITCH_OK the bound is G_switch', async () => {
    const made = await makePlayer({ switchResult: async () => switchSuccess(42n, 63n, 66n) });
    await made.player.switchTrack('720p');
    made.aliasMap.set(42n, 8n); // the library mapped the PUBLISH's alias
    expect(made.player.routeVideoObject('720p', 61n)).toBe('earlier-subscription');
    expect(made.player.routeVideoObject('720p', 62n)).toBe('earlier-subscription');
    expect(made.player.routeVideoObject('720p', 63n)).toBe('land');
  });

  it('the initial subscription has no lower bound', async () => {
    const { player } = await makePlayer();
    expect(player.routeVideoObject('360p', 0n)).toBe('current');
  });
});

/**
 * Grid 2 (2026-10-06, native time-shifted r0/r1): after the capacity drop the
 * controller's guard timed out and re-decided the pending target every tick; the
 * library mapped the pending request's alias at the header of the first target
 * stream, about half a second before its first object, so the "previous switch
 * not landed" skip let a second SWITCH to the same track through. On native the
 * relay answered it without a new subscription and every target object was
 * dropped as pre-landing until the run ended. The same rule runs on this branch:
 * once SWITCH_OK has cleared `switchInFlight` and the relay-allocated id has its
 * alias, a repeat SWITCH to the still-pending target is skipped; a different
 * target still goes out.
 */
describe('Player.switchTrack: a repeat SWITCH to the pending target (2026-10-07)', () => {
  let emitted: Emitted;
  beforeEach(() => {
    emitted = [];
    vi.spyOn(events, 'emit').mockImplementation((e, f) => {
      emitted.push([e, (f ?? {}) as Record<string, unknown>]);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('is skipped even once the alias is mapped, while a different target still goes out', async () => {
    const env: { aliasMap?: Map<bigint, bigint> } = {};
    const made = await makePlayer({
      switchResult: async () => {
        // SWITCH_OK processed and the first target stream's header seen: the
        // relay-allocated id has its alias, but no object has landed the switch.
        env.aliasMap!.set(42n, 8n);
        return switchSuccess(42n);
      },
    });
    env.aliasMap = made.aliasMap;
    await made.player.switchTrack('720p');
    expect(made.client.switch).toHaveBeenCalledTimes(1);
    expect(made.player.hasSwitchInFlight()).toBe(true);

    const seq = await made.player.switchTrack('720p');
    expect(made.client.switch).toHaveBeenCalledTimes(1);
    const skipped = emitted.filter(([e]) => e === 'SWITCH_SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![1]).toMatchObject({ switch_seq: seq, to: '720p', reason: 'same target pending' });
    expect(made.callbacks.at(-1)).toEqual(['360p', seq]);

    await made.player.switchTrack('480p');
    expect(made.client.switch).toHaveBeenCalledTimes(2);
  });
});
