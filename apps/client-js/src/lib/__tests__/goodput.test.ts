import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoodputTracker } from '../goodput';

describe('GoodputTracker (SWMA on per-group object timing)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 before any sample', () => {
    const t = new GoodputTracker();
    expect(t.getBandwidthBps()).toBe(0);
    expect(t.getFastEmaBps()).toBe(0);
    expect(t.getSlowEmaBps()).toBe(0);
  });

  it('returns 0 while a single group is still in progress', () => {
    const t = new GoodputTracker();
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    // Group 0 not finalized yet (still receiving its objects).
    expect(t.getBandwidthBps()).toBe(0);
  });

  it('finalizes the previous group when a new groupId arrives', () => {
    const t = new GoodputTracker();
    // Group 0: first object sets t_1, two more objects of 10_000 bytes spaced
    // 100ms apart → 20_000 bytes / 200ms = 800_000 bps.
    t.recordObject(5_000, 0n); // first object — bytes excluded from numerator
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);

    // Group 1 starts → group 0 is finalized.
    vi.advanceTimersByTime(900);
    t.recordObject(5_000, 1n);

    // (10_000 + 10_000) bytes * 8 bits / 0.2 s = 800_000 bps.
    expect(t.getBandwidthBps()).toBe(800_000);
  });

  it('excludes the first object from the SWMA numerator', () => {
    const t = new GoodputTracker();
    // Group 0: huge first object (would inflate the average if counted) +
    // small back-to-back objects.
    t.recordObject(1_000_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);

    t.recordObject(0, 1n); // trigger finalization

    // (10_000 + 10_000) bytes * 8 / 0.2 s = 800_000 bps.
    // If first-object bytes were counted, this would be much higher.
    expect(t.getBandwidthBps()).toBe(800_000);
  });

  it('averages over a SWMA window of 5 group samples', () => {
    const t = new GoodputTracker();
    let groupId = 0n;
    const throughputs = [1, 2, 3, 4, 5, 6].map(n => n * 1_000_000);
    for (const tput of throughputs) {
      // Each group: first object (1_000 B excluded from numerator), then a
      // payload object 100ms later. payload * 8 / 0.1 = tput.
      const payloadBytes = (tput * 0.1) / 8;
      t.recordObject(1_000, groupId);
      vi.advanceTimersByTime(100);
      t.recordObject(payloadBytes, groupId);
      groupId++;
      vi.advanceTimersByTime(900);
    }
    // Finalize the last group by emitting a stub object on the next groupId.
    t.recordObject(0, groupId);
    // 6 samples produced; window keeps last 5: 2,3,4,5,6 Mbps → mean = 4 Mbps.
    expect(t.getBandwidthBps()).toBeCloseTo(4_000_000, -3);
  });

  it('feeds per-group throughputs into fast/slow EMAs', () => {
    const t = new GoodputTracker(3, 8);
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(125_000, 0n); // 125_000 B * 8 / 0.1 s = 10_000_000 bps
    t.recordObject(0, 1n); // finalize group 0

    expect(t.getFastEmaBps()).toBe(10_000_000);
    expect(t.getSlowEmaBps()).toBe(10_000_000);
  });

  it('seedEma anchors both EMAs so the first real sample blends in', () => {
    const t = new GoodputTracker(3, 8);
    t.seedEma(400_000); // conservative startup anchor (e.g. lowest rung bitrate)
    expect(t.getFastEmaBps()).toBe(400_000);
    expect(t.getSlowEmaBps()).toBe(400_000);

    // First real group bursts at 10 Mbps. Because the EMA is already seeded,
    // updateEma blends rather than replacing — both EMAs stay far below the
    // burst, so a single startup burst can't green-light a multi-tier climb.
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(125_000, 0n); // 125_000 B * 8 / 0.1 s = 10_000_000 bps
    t.recordObject(0, 1n); // finalize group 0

    expect(t.getSlowEmaBps()).toBeLessThan(2_000_000);
    expect(t.getFastEmaBps()).toBeLessThan(10_000_000);
  });

  it('seedEma is a no-op once real EMA data exists', () => {
    const t = new GoodputTracker(3, 8);
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(125_000, 0n);
    t.recordObject(0, 1n); // finalize → EMA = 10 Mbps
    expect(t.getSlowEmaBps()).toBe(10_000_000);

    t.seedEma(400_000); // must not clobber real measurements
    expect(t.getSlowEmaBps()).toBe(10_000_000);
  });

  it('seedEma ignores non-positive seeds', () => {
    const t = new GoodputTracker();
    t.seedEma(0);
    expect(t.getSlowEmaBps()).toBe(0);
    t.seedEma(-100);
    expect(t.getSlowEmaBps()).toBe(0);
  });

  it('reset() clears SWMA, EMAs, and current-group accumulator', () => {
    const t = new GoodputTracker();
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(100);
    t.recordObject(10_000, 0n);
    t.recordObject(0, 1n); // finalize group 0
    expect(t.getBandwidthBps()).toBeGreaterThan(0);

    t.reset();
    expect(t.getBandwidthBps()).toBe(0);
    expect(t.getFastEmaBps()).toBe(0);
    expect(t.getSlowEmaBps()).toBe(0);
    expect(t.getSampleCount()).toBe(0);
  });

  it('getLastObjectBytes returns the most recent object size', () => {
    const t = new GoodputTracker();
    t.recordObject(5_000, 0n);
    expect(t.getLastObjectBytes()).toBe(5_000);
    t.recordObject(12_000, 0n);
    expect(t.getLastObjectBytes()).toBe(12_000);
  });

  it('getSampleCount tracks the number of finalized groups, not raw objects', () => {
    const t = new GoodputTracker();
    expect(t.getSampleCount()).toBe(0);

    // Group 0 with two objects → no finalization yet.
    t.recordObject(1_000, 0n);
    vi.advanceTimersByTime(50);
    t.recordObject(2_000, 0n);
    expect(t.getSampleCount()).toBe(0);

    // Switching to group 1 finalizes group 0 → count = 1.
    t.recordObject(1_000, 1n);
    expect(t.getSampleCount()).toBe(1);
  });

  it('skips groups with only one object (no inter-arrival information)', () => {
    const t = new GoodputTracker();
    t.recordObject(10_000, 0n); // single object in group 0
    t.recordObject(10_000, 1n); // moves to group 1; group 0 should NOT be finalized
    expect(t.getSampleCount()).toBe(0);
    expect(t.getBandwidthBps()).toBe(0);
  });

  // M11: arrival spacing from the library's receive stamps, one accumulator per
  // (track, group) so interleaved groups do not finalise each other.
  describe('receive stamps and per-(track, group) samples (M11)', () => {
    it('times a group by the receive stamps of its first and last object', () => {
      const t = new GoodputTracker();
      // Recorded all at once (a slow consumer), but received 100 ms apart.
      t.recordObject(5_000, 0n, { recvAt: 1_000, track: 'v' });
      t.recordObject(10_000, 0n, { recvAt: 1_100, track: 'v' });
      t.recordObject(10_000, 0n, { recvAt: 1_200, track: 'v' });
      const [sample] = t.recordObject(5_000, 1n, { recvAt: 2_000, track: 'v' });
      expect(sample).toMatchObject({ track: 'v', group: 0n, bytes: 20_000, durationMs: 200 });
      expect(sample!.bps).toBe(800_000);
      expect(t.getBandwidthBps()).toBe(800_000);
    });

    it('finalises a group at its last object, without waiting for the next group', () => {
      const t = new GoodputTracker();
      t.recordObject(1_000, 7n, { recvAt: 0, track: 'v', lastInGroup: false });
      const samples = t.recordObject(1_000, 7n, { recvAt: 10, track: 'v', lastInGroup: true });
      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({ group: 7n, bytes: 1_000, durationMs: 10 });
      expect(t.getSampleCount()).toBe(1);
    });

    it('keeps interleaved groups of one track apart', () => {
      const t = new GoodputTracker();
      // Group 4 (a catch-up) and group 5 (live) arrive interleaved.
      const out = [
        ...t.recordObject(1_000, 4n, { recvAt: 0, track: 'v', lastInGroup: false }),
        ...t.recordObject(1_000, 5n, { recvAt: 5, track: 'v', lastInGroup: false }),
        ...t.recordObject(2_000, 4n, { recvAt: 10, track: 'v', lastInGroup: false }),
        ...t.recordObject(4_000, 5n, { recvAt: 15, track: 'v', lastInGroup: false }),
        ...t.recordObject(2_000, 4n, { recvAt: 20, track: 'v', lastInGroup: true }),
        ...t.recordObject(4_000, 5n, { recvAt: 25, track: 'v', lastInGroup: true }),
      ];
      expect(out.map(s => [s.group, s.bytes, s.durationMs])).toEqual([
        [4n, 4_000, 20],
        [5n, 8_000, 20],
      ]);
    });

    it('keeps two tracks apart and names the track the group belonged to', () => {
      const t = new GoodputTracker();
      // Old track's trailing group 5 overlaps the new track's group 6 after a switch.
      const out = [
        ...t.recordObject(1_000, 5n, { recvAt: 0, track: 'old', lastInGroup: false }),
        ...t.recordObject(1_000, 6n, { recvAt: 2, track: 'new', lastInGroup: false }),
        ...t.recordObject(1_000, 5n, { recvAt: 4, track: 'old', lastInGroup: true }),
        ...t.recordObject(1_000, 6n, { recvAt: 8, track: 'new', lastInGroup: true }),
      ];
      expect(out.map(s => [s.track, s.group, s.durationMs])).toEqual([
        ['old', 5n, 4],
        ['new', 6n, 6],
      ]);
    });

    it('counts dropped objects in the arrival sample and reports them as discarded', () => {
      const t = new GoodputTracker();
      t.recordObject(1_000, 3n, { recvAt: 0, track: 'v', discarded: true });
      t.recordObject(3_000, 3n, { recvAt: 10, track: 'v', discarded: true });
      t.recordDiscardedBytes(500, 3n, 'v'); // library-level discard of the same group
      const [s] = t.recordObject(1_000, 3n, { recvAt: 20, track: 'v', lastInGroup: true });
      expect(s).toMatchObject({ bytes: 4_000, durationMs: 20, discardedBytes: 4_500 });
    });

    it('closes a group nobody finishes once it has been idle for two group times', () => {
      const t = new GoodputTracker();
      t.recordObject(1_000, 5n, { recvAt: 0, track: 'old', lastInGroup: false });
      t.recordObject(1_000, 5n, { recvAt: 10, track: 'old', lastInGroup: false });
      expect(t.recordObject(1_000, 6n, { recvAt: 500, track: 'new', lastInGroup: false })).toEqual(
        [],
      );
      const out = t.recordObject(1_000, 6n, { recvAt: 2_100, track: 'new', lastInGroup: false });
      expect(out.map(s => [s.track, s.group])).toEqual([['old', 5n]]);
    });

    it('counts closed samples per track (the min arm dwell reads the landed track)', () => {
      const t = new GoodputTracker();
      t.recordObject(1_000, 5n, { recvAt: 0, track: 'old', lastInGroup: false });
      t.recordObject(1_000, 5n, { recvAt: 4, track: 'old', lastInGroup: true });
      t.recordObject(1_000, 6n, { recvAt: 10, track: 'new', lastInGroup: false });
      t.recordObject(1_000, 6n, { recvAt: 14, track: 'new', lastInGroup: true });
      t.recordObject(1_000, 7n, { recvAt: 20, track: 'new', lastInGroup: false });
      t.recordObject(1_000, 7n, { recvAt: 24, track: 'new', lastInGroup: true });
      expect(t.getSamplesByTrack()).toEqual({ old: 1, new: 2 });
      expect(t.getSampleCount()).toBe(3);
    });

    // The fresh-grid-v2 case (native-forward-trigger, shift10s r1): after the
    // link is restored to 6 Mbps the time-shifted client's SWMA stayed at
    // 1.6-1.8 Mbps because the sample timed the serialised MSE append path.
    // Objects arrive at 6 Mbps; the write handler takes 100 ms per append.
    it('reads the 6 Mbps arrival rate however slow the appends are', () => {
      const t = new GoodputTracker();
      const objectBytes = 25_000; // 30 per group: a 6 Mbit GOP
      const spacingMs = (objectBytes * 8) / 6_000; // 33.3 ms at 6 Mbps
      const appendMs = 100; // the consumer: 3x slower than the link
      const samples = [];
      for (let group = 0n; group < 6n; group++) {
        const groupStart = Number(group) * 1000;
        for (let i = 0; i < 30; i++) {
          vi.advanceTimersByTime(appendMs); // record time drifts further behind
          samples.push(
            ...t.recordObject(objectBytes, group, {
              recvAt: groupStart + i * spacingMs,
              track: '720p',
              lastInGroup: i === 29,
            }),
          );
        }
      }
      expect(samples).toHaveLength(6);
      for (const s of samples) expect(Math.abs(s.bps - 6_000_000) / 6_000_000).toBeLessThan(0.05);
      expect(Math.abs(t.getBandwidthBps() - 6_000_000) / 6_000_000).toBeLessThan(0.05);
    });

    it('reads the consume pace when no receive stamp is given (the old behaviour)', () => {
      const t = new GoodputTracker();
      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(100);
        t.recordObject(25_000, 0n, { track: '720p', lastInGroup: i === 29 });
      }
      // 29 x 25 kB over 2.9 s of appends = 2 Mbps, a third of the link.
      expect(t.getBandwidthBps()).toBeCloseTo(2_000_000, -3);
    });

    it('times two tracks interleaving on arrival at their own pace', () => {
      const t = new GoodputTracker();
      const out = [];
      // Old track's last group: 10 x 10 kB every 20 ms (4 Mbps); new track's
      // first group: 10 x 5 kB every 20 ms (2 Mbps), offset by 10 ms.
      for (let i = 0; i < 10; i++) {
        out.push(
          ...t.recordObject(10_000, 5n, {
            recvAt: i * 20,
            track: 'old',
            lastInGroup: i === 9,
            discarded: true,
          }),
        );
        out.push(
          ...t.recordObject(5_000, 6n, { recvAt: 10 + i * 20, track: 'new', lastInGroup: i === 9 }),
        );
      }
      expect(out.map(s => [s.track, s.group, Math.round(s.bps)])).toEqual([
        ['old', 5n, 4_000_000],
        ['new', 6n, 2_000_000],
      ]);
      expect(out[0]!.discardedBytes).toBe(100_000);
      expect(out[1]!.discardedBytes).toBe(0);
    });
  });
});
