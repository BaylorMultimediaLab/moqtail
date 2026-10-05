import { describe, it, expect } from 'vitest';
import type { MoqtObject } from 'moqtail';
import { SourcePump, type PumpSource, type ReleaseReason } from './switchSources';

/** An object as the write handler sees it: only the track and the location matter here. */
function obj(track: string, group: number, object = 0): MoqtObject {
  return {
    track,
    location: { group: BigInt(group), object: BigInt(object) },
  } as unknown as MoqtObject;
}

/** A source the test feeds by hand, as the library's receiver does. */
function feed() {
  let c!: ReadableStreamDefaultController<MoqtObject>;
  const stream = new ReadableStream<MoqtObject>({ start: ctl => void (c = ctl) });
  return { stream, push: (o: MoqtObject) => c.enqueue(o), close: () => c.close() };
}

/** A write handler that applies the pump's verdict, as player.ts does. */
function sink(pump: () => SourcePump) {
  const written: string[] = [];
  const dropped: string[] = [];
  const writable = new WritableStream<MoqtObject>({
    write: o => {
      const t = (o as unknown as { track: string }).track;
      const label = `${t}:${o.location.group}`;
      if (pump().admit(o.location.group) === 'post-seam') dropped.push(label);
      else written.push(label);
    },
  });
  return { writable, written, dropped };
}

const settle = () => new Promise(r => setTimeout(r, 0));

function setup() {
  let t = 0;
  const released: Array<[bigint, ReleaseReason]> = [];
  const a = feed();
  const pump = new SourcePump(
    { stream: a.stream, requestId: 1n, trackName: 'A' },
    {
      now: () => t,
      onRelease: (s: PumpSource, r) => released.push([s.requestId, r]),
    },
  );
  const out = sink(() => pump);
  const ac = new AbortController();
  void pump.run(out.writable, ac.signal);
  return {
    pump,
    a,
    out,
    released,
    ac,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SourcePump (P1, audit M5): the replaced subscription is read until it is done', () => {
  it('keeps writing the old route after SWITCH_OK, before any target object', async () => {
    const { pump, a, out, ac } = setup();
    a.push(obj('A', 3));
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    // below the seam, still in flight at SWITCH_OK
    a.push(obj('A', 4, 0));
    a.push(obj('A', 4, 1));
    a.push(obj('A', 4, 2));
    await settle();
    a.close();
    await settle();
    expect(out.written).toEqual(['A:3', 'A:4', 'A:4', 'A:4', 'B:5']);
    ac.abort();
  });

  it('releases the old route once its PUBLISH_DONE came and it went idle', async () => {
    const { pump, a, out, released, advance, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    a.push(obj('A', 4));
    await settle();
    expect(pump.publishDone(1n)).toBe(true);
    advance(100);
    pump.tick();
    await settle();
    expect(out.written).toEqual(['A:4']); // not idle long enough yet
    advance(500);
    pump.tick();
    await settle();
    expect(released).toEqual([[1n, 'publish-done-idle']]);
    expect(out.written).toEqual(['A:4', 'B:5']);
    expect(pump.current?.requestId).toBe(2n);
    ac.abort();
  });

  it('releases the old route at the cap when no PUBLISH_DONE arrives', async () => {
    const { pump, out, released, advance, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    await settle();
    advance(5000);
    pump.tick();
    await settle();
    expect(released).toEqual([]);
    advance(2000);
    pump.tick();
    await settle();
    expect(released).toEqual([[1n, 'cap']]);
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route that closes is released as closed and the next one starts at once', async () => {
    const { pump, a, out, released, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    a.close();
    await settle();
    expect(released).toEqual([[1n, 'closed']]);
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route queued after the previous one already closed is still picked up', async () => {
    const { pump, a, out, ac } = setup();
    a.close();
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    b.push(obj('B', 5));
    await settle();
    expect(out.written).toEqual(['B:5']);
    ac.abort();
  });

  it('a route that is not replaced is never released by tick', async () => {
    const { pump, released, advance, ac } = setup();
    pump.publishDone(1n);
    advance(60_000);
    pump.tick();
    await settle();
    expect(released).toEqual([]);
    expect(pump.current?.requestId).toBe(1n);
    ac.abort();
  });
});

describe('SourcePump (P2, audit M6): old-track objects at or above G_switch are dropped once it is known', () => {
  it('appends the replaced route below the seam and drops it at and above the seam', async () => {
    const { pump, a, out, ac } = setup();
    a.push(obj('A', 4)); // before SWITCH_OK: G_switch unknown, appended
    await settle();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    a.push(obj('A', 4, 1));
    a.push(obj('A', 5));
    a.push(obj('A', 6));
    a.close();
    b.push(obj('B', 5));
    await settle();
    expect(out.written).toEqual(['A:4', 'A:4', 'B:5']);
    expect(out.dropped).toEqual(['A:5', 'A:6']);
    expect(pump.routes()[0]?.trackName).toBe('B');
    ac.abort();
  });

  it('the target route is never cut by the seam of the route it replaced', async () => {
    const { pump, a, out, ac } = setup();
    const b = feed();
    pump.replace(1n, 5n, { stream: b.stream, requestId: 2n, trackName: 'B' });
    a.close();
    b.push(obj('B', 5));
    b.push(obj('B', 9));
    await settle();
    expect(out.written).toEqual(['B:5', 'B:9']);
    expect(out.dropped).toEqual([]);
    ac.abort();
  });
});
