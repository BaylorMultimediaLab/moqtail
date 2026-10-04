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
    get buffered() {
      const r = v.ranges;
      return { length: r.length, start: (i: number) => r[i]![0], end: (i: number) => r[i]![1] };
    },
    addEventListener: () => {},
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
});
