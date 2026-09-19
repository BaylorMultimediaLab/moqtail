import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventLog } from '../EventLog';

describe('EventLog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is inert until started', () => {
    const log = new EventLog();
    log.emit('X', { a: 1 });
    expect(log.recent()).toHaveLength(0);
    expect(log.active).toBe(false);
  });

  it('records CLOCK_MAP first and posts JSON lines under the run id', () => {
    const log = new EventLog();
    log.start('run-1');
    log.emit('STALL_START', { playhead_ms: 12, group: 3n });
    log.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/__events?run=run-1');
    const lines = String(init.body).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.event).toBe('CLOCK_MAP');
    expect(first.src).toBe('client');
    expect(second.event).toBe('STALL_START');
    expect(second.group).toBe(3); // bigint serialised as number
    expect(second.seq).toBe(1);
    log.stop();
  });

  it('flushes on a timer', () => {
    const log = new EventLog();
    log.start('run-2');
    vi.advanceTimersByTime(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    log.stop();
  });

  it('keeps a ring of recent records', () => {
    const log = new EventLog();
    log.start('run-3');
    for (let i = 0; i < 10; i++) log.emit('T', { i });
    const recent = log.recent();
    expect(recent[recent.length - 1]!.event).toBe('T');
    expect(recent.length).toBe(11);
    log.stop();
  });
});
