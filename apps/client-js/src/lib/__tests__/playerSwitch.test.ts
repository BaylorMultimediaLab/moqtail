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

async function makePlayer(opts: { switchResult?: () => Promise<unknown> } = {}) {
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
