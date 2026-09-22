# The ABR controller, rule by rule

What the client's adaptive-bitrate logic is made of, what each part is
responsible for, where its numbers come from, and what the defaults do on
our two client types. Everything here is read from the code on `harness`
(`apps/client-js/src/lib/abr`, `goodput.ts`, `latencyTracker.ts`,
`buffer.ts`, `player.ts`); the "observed" columns come from a validated
60 s unshaped run of a 10 s time-shifted client on native SWITCH
(197 controller ticks, 13 switches).

## 1. The loop

```
every 250 ms (AbrController._tick)
  metrics  = player.getMetrics()          # the signals, section 2
  publish AbrMetrics to the UI / SAMPLE log
  release the switching guard once a new-track frame has been presented
  if guard held > 3 s: release it, back off 5 s          (ABR_GUARD_TIMEOUT)
  if manual mode, or guard held, or in back-off: stop here
  DYNAMIC strategy: usingBola = buffer >= 18 s (off again below 9 s)
  maybe fire an active probe (section 2.3)
  context  = signals + settings + switch history
  votes    = every active rule's SwitchRequest or null   (ABR_TICK)
  chosen   = arbiter(votes)                              (section 4)
  if chosen.index == active: stop
  if up-switch and fewer than 3 throughput samples: stop (ABR_GATED slow-start)
  record history, hold the guard, player.switchTrack()   (ABR_DECISION)
```

Responsibilities are split three ways:

| piece                | file                        | responsibility                                                                                           |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `AbrController`      | `abr/AbrController.ts`      | the tick, the guards, the strategy toggle, the probe schedule, the switch history, calling `switchTrack` |
| `AbrRulesCollection` | `abr/AbrRulesCollection.ts` | runs the rules, applies BOLA/throughput exclusivity, arbitrates                                          |
| the rules            | `abr/rules/*.ts`            | each turns the context into "I want index _i_ at priority _p_ because _r_" or abstains                   |
| `Player`             | `lib/player.ts`             | produces the signals and executes the switch (mechanism-specific per branch)                             |

The controller never looks at bitrates itself except to label a decision
`auto-upgrade` / `auto-downgrade` / `auto-emergency` (the last when the
rule's reason contains "emergency") and to size the probe.

## 2. The signals (what the rules see)

`RulesContext` is rebuilt every tick from `player.getMetrics()`. Tracks are
sorted by bitrate ascending, so index 0 is the lowest rung.

### 2.1 Passive throughput: `bandwidthBps`, `fastEmaBps`, `slowEmaBps`

`GoodputTracker` (`goodput.ts`). The publisher sends one GOP (one MoQ
group, 1 s, ~29 objects) as a burst, then idles. Averaging over the idle
gaps would converge on the source bitrate, so the tracker measures the
burst only:

```
one sample per completed group:
  bps = (bytes of objects 2..N) * 8 / (t_N - t_1)
bandwidthBps = mean of the last 5 samples            (SWMA)
fastEmaBps   = time-weighted EMA, half-life 3 s      (settings.ewma)
slowEmaBps   = time-weighted EMA, half-life 8 s
```

The sample is finalised when the next group's first object arrives (that
is when `THROUGHPUT_SAMPLE` is logged). The EMAs are seeded with the
startup track's bitrate at connect so the first burst cannot set them
alone. Only `bandwidthBps` is used by rules; the EMAs are logged and
shown, and `fastEmaBps` is recorded in the switch history.

Two consequences worth knowing: a link far faster than the source reads
as its true delivery rate (11 Mbps on loopback for a 4 Mbps track), and
a relay cache replay (the 10-group backlog a time-shifted client receives
at connect, or the catch-up after a native switch) is a burst that
measures the link, not the publisher.

### 2.2 Buffer: `bufferSeconds`

`buffered.end(last) − currentTime` of the video element. For a time-shifted
client this is bounded by the shift: nothing newer than the live edge
exists, so a 10 s client tops out near 10 s and will never reach 18 s.

### 2.3 Active probe: `probeBandwidthBps`

`ProbeManager` + `player.probeTrackBandwidth`. Whenever the client is not
on the top rung, at most every 2 s, the controller subscribes to the
relay's synthetic `.probe:<bytes>:0` track. Size is

```
probe_bits = 2 s * (b[i+1] - b[i] + tracksize)
```

where `tracksize` is the bitrate gap left by the previous switch (Kuo
Algorithm 1). The relay sends that many zero bytes in 4 KB objects at
lowest priority and ends the subscription; the client reads until the
stream ends and reports `(video bytes + probe bytes) * 8 / elapsed`. The
value is valid for 5 s, then reads as 0. Only `ProbeRule` uses it.

### 2.4 Per-frame latency trend: `latencyTrendRatio`

`LatencyTracker`. Every object starts with a `prft` box carrying the
publisher's wall clock; `latency = now − capture`. The tracker keeps the
last 100 samples and reports `mean(recent 50) / mean(older 50)`, or 1.0
until it has 100 samples. At 29 fps that window is 3.4 s, not the 4 s the
comments assume. A cache replay carries old capture stamps, so the ratio
rises during and after any backlog delivery even though the link is idle.

### 2.5 The rest

- `droppedFrames`, `totalFrames`: `getVideoPlaybackQuality()`.
- `playbackRate`: set by `MSEBuffer` (`buffer.ts`), which nudges the rate to
  1.05 when the playhead is more than 0.1 s further from the buffer end
  than its target (0.6 s for live-edge, the shift for time-shifted) and to
  0.95 when closer; it also seeks across buffer holes.
- `segmentDurationS`: hard-coded 1 (our GOP is 1 s).
- `isLowLatency`: hard-coded false; low-latency mode is instead inferred
  from L2A/LoLP being active.
- `switchHistory`: the last 60 decisions (from, to, reason, buffer, fast EMA).
- `sampleCount`: number of finalised throughput samples (slow-start gate).

### 2.6 Startup rung

Before the controller starts, `app.tsx` measures WebTransport bytes over
200 ms right after the catalog fetch, multiplies by the safety factor
(0.9) and picks the highest rung that fits, else the lowest. That is why a
fast link starts on 1080p and a shaped link on 360p.

## 3. Settings

`AbrSettings` (`abr/types.ts`), tunable in the settings panel, via URL
(`?bufferTimeDefault=&stableBufferTime=&bandwidthSafetyFactor=&initialBitrate=&minBitrate=&maxBitrate=`,
which the runner passes with `--abr`), or via `window.__abrSettingsOverride`
before connect.

| setting                                      | default       | consumed by                                               | effect                                                                            |
| -------------------------------------------- | ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `videoAutoSwitch`                            | true          | controller                                                | false = manual mode, rules never run                                              |
| `bufferTimeDefault`                          | 18 s          | controller, BolaRule                                      | BOLA engages at ≥ 18 s buffer, disengages < 9 s; BOLA's Vp/gp are derived from it |
| `stableBufferTime`                           | 18 s          | InsufficientBuffer, AbandonRequests, LoLP                 | those rules abstain while buffer ≥ 18 s                                           |
| `bandwidthSafetyFactor`                      | 0.9           | Throughput, BOLA startup and cap, L2A, LoLP, startup rung | every "fits within bandwidth" test uses bandwidth × 0.9                           |
| `ewma.throughputFast/SlowHalfLifeSeconds`    | 3 / 8         | GoodputTracker                                            | EMA smoothing (logged, not used by rules)                                         |
| `minBitrate`, `maxBitrate`                   | −1 (off)      | ThroughputRule (L2A: max only)                            | clamp the throughput rule's choice                                                |
| `initialBitrate`                             | −1            | nobody                                                    | present in the type and UI, not read anywhere                                     |
| `fastSwitching`                              | false         | nobody                                                    | present in the type and UI, not read anywhere                                     |
| `rules[name].active / priority / parameters` | see section 5 | each rule                                                 | on/off, tier, per-rule numbers                                                    |

Because a time-shifted client's buffer is capped by its shift, the two
18 s thresholds are unreachable for it. Section 6 shows what that does.

## 4. Arbitration and strategy

`AbrRulesCollection.evaluate` runs every active rule; `getMinSwitchRequest`
then picks, **from the highest priority tier that has any request, the
lowest representation index**. Priorities are STRONG (1), DEFAULT (0.5),
WEAK (0). So one STRONG down-vote beats any number of DEFAULT up-votes, and
among equals the most conservative rung wins; a rule that abstains has no
say. Rules cannot veto a _down_-switch.

Exclusivity: in DYNAMIC mode `BolaRule` runs only while `usingBola` is
true and `ThroughputRule` only while it is false (dash.js hysteresis: on at
`bufferTimeDefault`, off at half of it). If L2A or LoLP is active,
neither BOLA nor Throughput runs.

Guards after a decision: the switching guard blocks further decisions
until the player reports the switch applied _and_ a new frame has been
presented; if that takes over 3 s the guard is released with a 5 s
back-off; an up-switch is refused until 3 throughput samples exist.

## 5. The rules

Defaults from `DEFAULT_ABR_SETTINGS`; "observed" is the reference run.

| rule                   | active | priority         | direction               | fires when                                 | observed (197 ticks)     |
| ---------------------- | ------ | ---------------- | ----------------------- | ------------------------------------------ | ------------------------ |
| ThroughputRule         | yes    | DEFAULT          | up/down                 | not in BOLA mode; bandwidth known          | 7 up-votes, all chosen   |
| BolaRule               | yes    | DEFAULT          | up/down                 | buffer ≥ 18 s (never on a 10 s client)     | skipped every tick       |
| ProbeRule              | yes    | DEFAULT          | up only                 | fresh probe × 0.8 ≥ next rung              | 2 up-votes               |
| InsufficientBufferRule | yes    | DEFAULT / STRONG | either (mostly permits) | buffer < 18 s                              | 6 up-votes               |
| BufferDrainRateRule    | yes    | STRONG           | down                    | buffer < 2 s and draining ≥ 0.3 s/s        | 0                        |
| LatencyTrendRule       | yes    | STRONG           | down one rung           | trend ratio > 1.2                          | 4 down-votes, all chosen |
| SwitchHistoryRule      | yes    | DEFAULT          | down                    | a rung's drop ratio > 0.075 after 8 visits | 2 down-votes, chosen     |
| DroppedFramesRule      | **no** | DEFAULT          | down one rung           | drop ratio > 15 % after 375 frames         | —                        |
| AbandonRequestsRule    | yes    | STRONG           | down                    | projected group delivery > 1.8 × GOP       | 0                        |
| L2ARule                | **no** | DEFAULT          | either                  | low-latency mode                           | —                        |
| LoLpRule               | **no** | DEFAULT / STRONG | either                  | low-latency mode                           | —                        |

### ThroughputRule

Highest rung whose bitrate ≤ `bandwidthBps × 0.9`, within `minBitrate` /
`maxBitrate`. Abstains until the first sample. Stateless. On a fast link
it is the rule that climbs; every up-switch in the reference run came from
it, each time 0.7 s after a latency-trend down-switch, because the SWMA
still said 11 Mbps.

### BolaRule

Spiteri's BOLA with dash.js's BOLA-O cap. Three states: `ONE_BITRATE`,
`STARTUP` (buffer below one GOP: throughput choice plus a decaying
placeholder buffer), `STEADY` (score `(Vp·(utility+gp) − buffer) / bitrate`,
utility `ln(b/b_min)+1`, `gp = (u_max − 1)/(bufferTime/10 − 1)`,
`Vp = 10/gp`, with `bufferTime = bufferTimeDefault`). The cap: if BOLA
wants a rung above both the current one and the throughput rung, take
`max(throughput rung, current)`. Parameters `MINIMUM_BUFFER_S = 10` and
decay 0.99 are constants. It only runs while `usingBola` is on, which
requires 18 s of buffer, so on a 10 s time-shifted client it is dead code;
on a live-edge client it engages only if the buffer ever grows past 18 s.

### ProbeRule

If a probe result is fresh (< 5 s) and `probe × safetyFactor (0.8) ≥`
next rung's bitrate, ask for exactly the next rung. Never down. The
probe measures the link (video + probe bytes), so on a fat link it
permits every step of the climb; on a saturated link it still returns a
number, just a small one.

### InsufficientBufferRule

dash.js's formula. Skips its first 2 calls (`segmentIgnoreCount`, counted
in ticks, not segments). Abstains while buffer ≥ `stableBufferTime`
(18 s). Buffer exactly 0: index 0 at STRONG ("empty"). Otherwise
`cap = bandwidth × 0.7 × buffer / 1 s` and the highest rung under the cap,
STRONG below 0.5 s of buffer else DEFAULT. With 8 s of buffer the
multiplier is 8 × 0.7 = 5.6, so the cap sits far above every rung and the
rule votes for the top rung, which is why its "observed" votes are all
up-votes on a time-shifted client: below 18 s it is effectively a second,
more permissive throughput rule, and only becomes protective under about
1.5 s of buffer.

### BufferDrainRateRule

Receiver-side: `drainRate = −d(buffer)/dt` over a 1 s window of ≥ 3
samples; `link ≈ sourceRate × (playbackRate − drainRate)`. Fires STRONG
only when buffer < 2 s _and_ drain ≥ 0.3 s/s _and_ the capped link
(× 0.7) points below the current rung. Its purpose is to beat
ThroughputRule to a sudden link drop. It cannot fire while the buffer is
above 2 s, which on a time-shifted client with 8 to 10 s of buffer means
never until things are already bad.

### LatencyTrendRule

If `latencyTrendRatio > 1.2` and not on the lowest rung: one rung down,
STRONG. No state. It is the rule the earlier smoke runs' flip-flop came
from: after a native switch the relay replays the target's backlog from
cache, those objects carry capture stamps up to 10 s old, the recent half
of the window jumps, the ratio passes 1.2 for a few ticks, and a
down-switch fires (observed peak 1.36). Nothing in the signal
distinguishes "queueing on the link" from "replayed history".

### SwitchHistoryRule

Rebuilds per-rung `drops` (times we auto-downgraded _from_ it) and
`noDrops` (times we auto-upgraded _to_ it) from the whole history (last 60
decisions). A rung is unsafe once it has 8 visits and
`drops / noDrops > 0.075`; the rule then asks for the highest safe rung
at or below the current one, DEFAULT. Because the ratio uses `noDrops` as
the divisor, three drops against forty successes still exceeds 0.075, so
after enough oscillation a rung is banned for the rest of the session.
Its two votes in the reference run came after the 1080p rung had been left
by latency-trend three times.

### DroppedFramesRule (inactive)

Once 375 frames have been presented, if `dropped / total > 0.15`, one rung
down at DEFAULT. Off by default; the drop counter never resets, so once
tripped it would vote down every tick.

### AbandonRequestsRule

dash.js-shaped but without a mid-flight request to abandon: after 6 ticks,
while buffer < 18 s and not on the bottom rung, if
`currentBitrate × 1 s / bandwidth > 1.8 s` (a group would take longer than
1.8 GOPs to arrive) choose the highest rung with `bitrate / 1.8 ≤ bandwidth`,
STRONG. Needs the SWMA to read below 55 % of the current bitrate, i.e. a
real collapse.

### L2ARule and LoLpRule (inactive)

Low-latency alternatives. L2A: 4 startup ticks of throughput choice, then
online gradient ascent over a weight per rung projected onto the simplex,
with a buffer target of 1.5 s and a reset to the bottom rung if the
current bitrate exceeds twice the safe throughput. LoLP: one neuron per
rung updated by SOM learning on throughput / buffer / rebuffer / switch
counts, picks the neuron closest to an ideal state among rungs that fit
the bandwidth, and forces index 0 at STRONG below 0.5 s of buffer.
Activating either disables BOLA and Throughput. Neither has been tuned
for this stack.

## 6. What the defaults do on our two client types

Live-edge client (target 0.6 s behind the buffer end, buffer typically
0.5 to 1.5 s): InsufficientBufferRule is in its protective regime
(multiplier ≈ buffer), BufferDrainRate can fire, BOLA never engages,
ThroughputRule and ProbeRule drive the climb.

Time-shifted client, 10 s shift (buffer 8 to 10 s, cannot exceed the
shift): BOLA never engages (needs 18 s), so DYNAMIC mode is permanently
"throughput"; InsufficientBufferRule permits everything; BufferDrainRate
cannot fire; the down-switches that occur come from LatencyTrend and, after
enough of them, SwitchHistory. The controller was tuned for an 18 s buffer
it can never have. That is a finding about the default configuration, not
a bug in the harness; the runner's `--abr 'bufferTimeDefault=8&stableBufferTime=8'`
exists to test the same rules in a regime the client can reach.

The observed cycle on the reference run: LatencyTrend fires 0.5 to 2 s
after a switch's catch-up burst (STRONG, down one rung); 0.7 s later
ThroughputRule, still reading the burst as 11 Mbps, climbs back
(DEFAULT, but nobody votes down); the switching guard, 3 s timeout and 5 s
cool-down never engage because each switch lands within a second. Eight
A→B→A reversals in 60 s, most superseded before they were ever visible.

## 7. Hard-coded numbers

| where          | value                | meaning                                             |
| -------------- | -------------------- | --------------------------------------------------- |
| AbrController  | 250 ms               | tick                                                |
| AbrController  | 3000 ms / 5000 ms    | switching-guard timeout / cool-down after it        |
| AbrController  | 3                    | throughput samples before an up-switch (slow start) |
| AbrController  | 60                   | switch-history length                               |
| AbrController  | 2 s                  | probe horizon in the size formula                   |
| ProbeManager   | 2000 / 500 / 5000 ms | min interval / nominal duration / freshness         |
| GoodputTracker | 5                    | SWMA window (groups)                                |
| LatencyTracker | 100                  | samples in the trend window                         |
| BolaRule       | 10 s, 0.99           | MINIMUM_BUFFER_S, placeholder decay                 |
| L2ARule        | 4, 2, 1.5 s          | horizon, REACT, buffer target                       |
| LoLpRule       | 0.5 s, 0.1           | emergency buffer, SOM learning rate                 |
| context        | 1 s, false           | segmentDurationS, isLowLatency                      |

## 8. Things to keep in mind before tuning

- `initialBitrate` and `fastSwitching` are UI-only; changing them does nothing.
- `segmentIgnoreCount` and `minThroughputSamplesThreshold` count controller
  ticks (4 per second), not groups or samples.
- SwitchHistoryRule's ratio has `noDrops` in the denominator; with the
  default threshold a rung is effectively banned after its third drop.
- LatencyTrend cannot tell a cache replay from queueing; on any mechanism
  that back-fills (native catch-up, PR #1378 catch-up, SWITCH_FROM soft
  fill) it will see a rise after each switch.
- BOLA's parameters and the DYNAMIC toggle assume the buffer can reach
  `bufferTimeDefault`; for a time-shifted client the reachable maximum is
  the shift.
- The 100-sample latency window is 3.4 s at 29 fps.
- Every rule's vote is in `ABR_TICK` (`rules`, `skipped`, `chosen`), so any
  of the above can be checked on a run before changing it.
