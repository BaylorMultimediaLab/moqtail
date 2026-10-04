import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import MSEBuffer from '@/lib/buffer';
import { events } from '@/lib/events/EventLog';

/**
 * M14: one gap-crossing policy. The buffer's range-jump deferral (wait while
 * a fill is landing inside the gap, bounded by 3 s without append-front
 * progress) and the player's wedge watchdog (seek across any gap < 1.5 s
 * after 1 s frozen) disagreed; the watchdog overrode the deferral after 1 s.
 * Now MSEBuffer owns both paths and SEEK.reason is startup | gap | wedge.
 */

type Range = [number, number];

function fakeVideo(ranges: Range[], currentTime: number) {
  const v = {
    currentTime,
    paused: false,
    ended: false,
    readyState: 2,
    duration: Infinity,
    playbackRate: 1,
    ranges,
    listeners: {} as Record<string, Array<() => void>>,
    fire(type: string) {
      for (const cb of v.listeners[type] ?? []) cb();
    },
    get buffered() {
      const r = v.ranges;
      return { length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] };
    },
    addEventListener: (type: string, cb: () => void) => {
      (v.listeners[type] ??= []).push(cb);
    },
    removeEventListener: () => {},
    play: () => Promise.resolve(),
  };
  return v;
}

describe('gap-crossing policy (M14)', () => {
  let seeks: Array<Record<string, unknown>>;
  let buffers: MSEBuffer[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    seeks = [];
    buffers = [];
    vi.spyOn(events, 'emit').mockImplementation((event, fields) => {
      if (event === 'SEEK') seeks.push(fields ?? {});
    });
  });

  afterEach(() => {
    for (const b of buffers) b.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const start = (video: ReturnType<typeof fakeVideo>, front: { s?: number }) => {
    const b = new MSEBuffer(video as unknown as HTMLVideoElement, {
      liveEdgeDelay: 10,
      gapFillProbe: () => ({ appendFrontS: front.s }),
      gopDurationMs: 1000,
    });
    buffers.push(b);
    return b;
  };

  it('waits while a fill lands inside the gap, past the old 1 s watchdog override', () => {
    // Playhead parked at the end of [0, 16.2]; the next range starts at 17.0;
    // a refetch is appending inside the hole and its front keeps moving.
    const video = fakeVideo(
      [
        [0, 16.2],
        [17.0, 30],
      ],
      16.2,
    );
    const front = { s: 16.3 };
    start(video, front);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(250);
      front.s += 0.02; // still filling
    }
    expect(seeks).toEqual([]);

    // The fill stops; 3 s without progress later the gap is crossed.
    vi.advanceTimersByTime(3_250);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ reason: 'gap', from_ms: 16_200, to_ms: 17_000 });
    expect(seeks[0]!.gap_ms).toBeCloseTo(800);
    expect(seeks[0]!.deferred_ms as number).toBeGreaterThanOrEqual(5_000);
  });

  it('crosses an old hole nobody is filling at once, with reason gap', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [17.0, 30],
      ],
      16.2,
    );
    start(video, { s: 29.9 }); // new media lands beyond the hole
    vi.advanceTimersByTime(250);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ reason: 'gap', to_ms: 17_000, deferred_ms: 0 });
    expect(seeks[0]!.gap_ms).toBeCloseTo(800);
  });

  it('crosses from a hole to the next range (playhead in no range)', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [17.0, 30],
      ],
      16.5,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(250);
    expect(seeks[0]).toMatchObject({ reason: 'gap', from_ms: 16_500, to_ms: 17_000 });
  });

  it('unwedges a playhead frozen inside a range for 3 s as reason wedge', () => {
    // Decoder wedge: data buffered 5 s ahead, playhead not moving.
    const video = fakeVideo([[10, 20]], 14.3);
    start(video, { s: 19.9 });
    vi.advanceTimersByTime(2_750);
    expect(seeks).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ reason: 'wedge', from_ms: 14_300 });
    expect(seeks[0]!.to_ms as number).toBeCloseTo(15_001);
  });

  it('does not cross anything before playback has started (paused element)', () => {
    const video = fakeVideo([[100, 130]], 0);
    video.paused = true;
    start(video, { s: 129 });
    vi.advanceTimersByTime(5_000);
    expect(seeks).toEqual([]);
  });

  it('only ever uses the three reasons', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [17.0, 30],
      ],
      16.2,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(1_000);
    for (const s of seeks) expect(['startup', 'gap', 'wedge']).toContain(s.reason);
  });

  it('G1: plays the current range to its end before crossing a gap (no buffered media thrown away)', () => {
    // 0.45 s of playable media before a 40 ms hole.
    const video = fakeVideo(
      [
        [0, 16.2],
        [16.24, 30],
      ],
      15.75,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(250);
    expect(seeks).toEqual([]);
    video.currentTime = 15.95; // still playing
    vi.advanceTimersByTime(250);
    expect(seeks).toEqual([]);
    video.currentTime = 16.2; // at the end of the range
    vi.advanceTimersByTime(250);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ reason: 'gap', from_ms: 16_200 });
    expect(seeks[0]!.to_ms as number).toBeCloseTo(16_240);
    expect(seeks[0]!.gap_ms as number).toBeCloseTo(40);
    expect(seeks[0]!.skipped_buffered_ms as number).toBeCloseTo(0);
  });

  it('crosses within one frame of the range end, and reports what it skipped separately from the gap', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [16.24, 30],
      ],
      16.18,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(250);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.skipped_buffered_ms as number).toBeCloseTo(20);
    expect(seeks[0]!.gap_ms as number).toBeCloseTo(40);
  });

  it('on `waiting` (the element cannot play what is left) crosses with up to 0.5 s still buffered', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [16.24, 30],
      ],
      15.9,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(100);
    expect(seeks).toEqual([]);
    video.fire('waiting');
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.skipped_buffered_ms as number).toBeCloseTo(300);
    expect(seeks[0]!.gap_ms as number).toBeCloseTo(40);
  });

  it('a playhead frozen short of the range end for 0.5 s is stuck too (no `waiting` needed)', () => {
    const video = fakeVideo(
      [
        [0, 16.2],
        [16.24, 30],
      ],
      15.9,
    );
    start(video, { s: 29.9 });
    vi.advanceTimersByTime(500);
    expect(seeks).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(seeks).toHaveLength(1);
    expect(seeks[0]!.skipped_buffered_ms as number).toBeCloseTo(300);
  });
});
