import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestError, Tuple } from 'moqtail';
import { Player } from '@/lib/player';
import { events } from '@/lib/events/EventLog';

/**
 * Player.switchTrack against a fake MOQtail client and catalog: no relay, no
 * MSE. Covers what the player tells the controller about a switch.
 */

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
  opts: { switchResult?: (req: { requestId: bigint }) => Promise<unknown> } = {},
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
    switch: vi.fn(opts.switchResult ?? (async () => ({ requestId: 0n }))),
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

  it('a refused switch calls back with the old track and its seq', async () => {
    const { player, callbacks } = await makePlayer({
      switchResult: async () =>
        Object.create(RequestError.prototype, {
          reasonPhrase: { value: { phrase: 'no' } },
        }),
    });
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
    const env: { player?: Player; aliasMap?: Map<bigint, bigint> } = {};
    const made = await makePlayer({
      switchResult: async req => {
        // SWITCH_OK processed by the library (alias mapped) and a target data
        // stream delivered its first object before this promise resolves.
        env.aliasMap!.set(req.requestId, 8n);
        routed = env.player!.routeVideoObject('720p');
        return { requestId: req.requestId };
      },
    });
    env.player = made.player;
    env.aliasMap = made.aliasMap;
    await made.player.switchTrack('720p');
    expect(routed).toBe('land');
    expect(made.player.hasSwitchInFlight()).toBe(true);
  });

  it('before SWITCH_OK the target name is still a trailing object of an earlier subscription', async () => {
    let routed: string | null = null;
    const env: { player?: Player } = {};
    const made = await makePlayer({
      switchResult: async req => {
        routed = env.player!.routeVideoObject('720p'); // alias not mapped yet
        return { requestId: req.requestId };
      },
    });
    env.player = made.player;
    await made.player.switchTrack('720p');
    expect(routed).toBe('pre-landing');
  });

  it('a refused switch rolls the provisional arming back', async () => {
    const { player } = await makePlayer({
      switchResult: async () =>
        Object.create(RequestError.prototype, { reasonPhrase: { value: { phrase: 'no' } } }),
    });
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
