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
  if up-switch and the post-switch up-guard is armed: stop (ABR_GATED post-switch-up-guard, section 9)
  record history, hold the guard, arm the up-guard, player.switchTrack()   (ABR_DECISION)
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

| where          | value                                                             | meaning                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AbrController  | 250 ms                                                            | tick                                                                                                                                                                                              |
| AbrController  | 3000 ms / 5000 ms                                                 | switching-guard timeout / cool-down after it                                                                                                                                                      |
| AbrController  | 3                                                                 | throughput samples before an up-switch (slow start)                                                                                                                                               |
| AbrController  | 60                                                                | switch-history length                                                                                                                                                                             |
| AbrController  | 2 s                                                               | probe horizon in the size formula                                                                                                                                                                 |
| controller     | 0 B / 0 ms / 0 / landed / false / evict / 0 s / instant / 1250 ms | probeMinBytes, probeMinDurationMs, upGuardSamples, upGuardRelease, latencyResetOnLanding, switchHistoryMode, switchHistoryWindowS, bufferSignal, bufferEnvelopeMs (section 9; all off = baseline) |
| ProbeManager   | 2000 / 500 / 5000 ms                                              | min interval / nominal duration / freshness                                                                                                                                                       |
| GoodputTracker | 5                                                                 | SWMA window (groups)                                                                                                                                                                              |
| LatencyTracker | 100                                                               | samples in the trend window                                                                                                                                                                       |
| BolaRule       | 10 s, 0.99                                                        | MINIMUM_BUFFER_S, placeholder decay                                                                                                                                                               |
| L2ARule        | 4, 2, 1.5 s                                                       | horizon, REACT, buffer target                                                                                                                                                                     |
| LoLpRule       | 0.5 s, 0.1                                                        | emergency buffer, SOM learning rate                                                                                                                                                               |
| context        | 1 s, false                                                        | segmentDurationS, isLowLatency                                                                                                                                                                    |

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

## 9. Stabilisation parameters (the ablation knobs)

`settings.controller` (`abr/types.ts`, `ControllerSettings`). Every knob is off
in the defaults, so the shipped controller is the **baseline** arm. The runner's
`--controller probe|guard|both` sets them through URL parameters
(`?probeMinBytes= &probeMinDurationMs= &upGuardSamples= &upGuardRelease=`), and
both `RUN_META.controller` and `identity.controller` record what ran. The two
fixes are separate on purpose: they address different problems, and the 2×2
ablation (baseline / probe / guard / both) attributes the effect of each.

### 9.1 Probe fix: `probeMinBytes`, `probeMinDurationMs`

The Algorithm 1 payload is `2 s × (b[i+1] − b[i] + tracksize)`. On a fine
ladder the gap is 50 kbps and the payload a few tens of KB, which the relay
delivers inside one burst; `(v + p) × 8 / Δt` over a few milliseconds reads
200–300 Mbps on a 6 Mbps link, and `ProbeRule` fires an up-switch on it.

- `probeMinBytes` floors the payload (`max(1024, formula, probeMinBytes)`), so
  every probe has to occupy the link long enough to see its capacity. The
  `probe` arm uses 250 000 bytes (1.3 s at 1.5 Mbps, at lowest priority).
- `probeMinDurationMs` discards a reading whose burst (first to last probe
  object) was shorter than this; `ProbeManager` emits `PROBE_DISCARDED` and
  keeps the previous reading. The `probe` arm uses 300 ms.

### 9.2 Post-switch up-guard: `upGuardSamples`, `upGuardRelease`

Every switch (up or down, automatic or manual) arms the guard. While armed, an
up-switch is refused (`ABR_GATED` with `why = post-switch-up-guard`) until

1. the switch has been **released**: `upGuardRelease = landed` (default) means
   the target's first object was applied (t4, `onTrackSwitched`), `visible`
   means the target's first frame was presented (t5, `onSwitchVisible`); a
   switch that times out (`ABR_GUARD_TIMEOUT`) is released at the timeout so it
   cannot hold up-switches forever (`ABR_UP_GUARD_RELEASED.how`);
2. `upGuardSamples` fresh completed-group throughput samples have arrived
   **since the release** (samples that arrived while the switch was in flight
   describe the old rung and do not count).

Down-switches are never held. The guard counts groups, not seconds of buffer,
so it is the same on every mechanism and both client types. `landed` is the
default because landing takes about one group everywhere (t4 ≈ 0.87 s on
native and PR #1378 next-group, both client types), whereas visibility takes
one group at the live edge and the whole shift on a time-shifted client, which
would make the guard's duration client-type dependent. The guard breaks the
observed loop at its second step: probe up → insufficient-buffer down →
(held) → three fresh samples on the low rung → the probe must prove headroom
again before the next climb. The `guard` arm uses 3 samples, `landed`.

### 9.3 Post-seam triggers: `latencyResetOnLanding`, `switchHistoryMode`

The first 2×2 ablation (2026-09-28, step_down_up, live edge, native and PR
#1378 next-group, 3 reps each) showed what actually closes the loop. The
probe arm changed nothing (on a shaped link the probe already read 2–5 Mbps;
the floor made the readings more accurate and the switch count identical).
The guard arm halved the rate (39 → 27 and 60 → 29 switches/min) and cut
stalls, but every surviving up-switch was still reverted about one second
after landing, and the client never climbed above rung 1 for long (mean
played rung 0.3 in every arm, fit rung 4). The reversal comes from the
switch itself:

- `LatencyTrendRule`: the first group after a seam arrives as a burst, so
  the recent/older latency ratio rises from about 1.0 to 1.25–1.38 (94 → 105
  ms) and the rule fires a STRONG down-switch one tick after landing.
  `latencyResetOnLanding` clears the 100-frame window when the switch lands
  (`LATENCY_WINDOW_RESET`), so the trend compares post-switch frames with
  post-switch frames.
- `SwitchHistoryRule`: a rung with `drops / noDrops > 0.075` in the history
  is "unsafe"; the rule is silent while the client sits on a safe rung and
  evicts it on the first tick after landing on an unsafe one. Its drops are
  the loop's own down-switches, so after one reversal the rung stays banned
  and every later up-switch to it is reverted immediately (the modal next rule
  after an up-switch on PR #1378). `switchHistoryMode: 'off'` disables the
  rule (recorded in `RUN_META.abr_settings.rules` too).

On native the third trigger is `InsufficientBufferRule` after the 1 GOP seam
hole drains the 0.4 s live-edge buffer; that one is the mechanism's cost and
is left alone.

### 9.4 The buffer signal: `bufferSignal`, `bufferEnvelopeMs`

The second ablation (2026-09-28, arms guard-lat, guard-hist, guard-lat-hist)
removed both post-seam triggers exactly as intended (0 latency-trend and 0
switch-history switches) and changed nothing else: 27–30 switches/min, mean
played rung 0.3, every up-switch still reverted about 1.5 s after landing.
The down half had moved to `BufferDrainRateRule` (41 of 45 down-switches on
PR #1378, reason `buffer-drain 1.05 s/s, link ≈ 0 Mbps`) and
`InsufficientBufferRule` (native).

The cause is the shape of the buffer at the live edge. The publisher sends a
group as a burst and idles, so buffered-ahead is a sawtooth: 1.0 → 0.72 →
0.47 → 0.23 → 0.98 s every second (250 ms ticks). Any rule that differences
the buffer over a 1 s window reads the falling edge as a drain of about 1 s/s,
and `bufferTriggerThreshold = 2 s` is unreachable at the live edge, so the
rule is permanently armed on every rung above the lowest (it abstains at
rung 0 because nothing is lower). `InsufficientBufferRule` scales its cap by
the same instantaneous level. Replayed on the recorded ticks of a
guard-lat-hist run, the drain rule fires on 168 of 575 ticks with the
instantaneous buffer and on 22 with a 1.25 s envelope.

`bufferSignal = envelope` gives every rule the maximum buffer level over the
last `bufferEnvelopeMs` (one group plus one tick): the level after each burst
landed, which is what the dash.js rules were written for. The empty-buffer
emergency (`insufficient-buffer-empty`) keeps the instantaneous value
(`RulesContext.bufferInstantSeconds`). A real drain still shows: the peaks
fall. The change is the same on every mechanism and both client types, and
on a time-shifted client with a 10 s buffer it is a no-op.

### 9.5 Third ablation and the last trigger: `switchHistoryMode = veto`

Arms env, lat-env, guard-lat-env (2026-09-29). The envelope removed the
buffer-drain switches on both mechanisms (0 in `env`), and `lat-env` is the
first configuration in which the client climbs: on PR #1378 mean played rung
2.2 (0.3 before), 1276 kbps in the first 6 Mbps phase, 879 kbps over the run.
On native the same arm reaches rung 1.4 in the first phase and 281 kbps; the
1 GOP seam hole at every switch still empties the buffer and
`InsufficientBufferRule` still fires on that real hole, which is the
mechanism's cost and stays.

Two things remain. First, once the client climbs, `SwitchHistoryRule` in its
shipped form becomes the modal down trigger again (40–67 per run): a rung
that dropped is unsafe, the rule waits until the client lands on it and
evicts it, and the probe sends it back. With the guard on top the rule pins
the client (guard-lat-env: rung 0.24 after the capacity restore because every
rung above 240p had drops from the 1.5 Mbps phase). `switchHistoryMode =
veto` keeps the rule's memory but changes what it does with it: cap the
ladder just below the first unsafe rung above the active one, never evict.
That is what the rule is for, a ban on rungs that keep dropping, without the
eviction that turns the ban into a loop.

Second, the live-edge client over-commits. With a 1 s runway, 1080p-4000k on a
6 Mbps link (0.67 s to deliver each group) and 720p-1200k on 1.5 Mbps (0.8 s)
are not sustainable although `throughput × 0.9` says they fit; the buffer
rules then bring it down on a real drain, and the probe sends it up again a
few seconds later. Two of three `lat-env` runs on PR #1378 ended 4–5 s behind
live for that reason. This is a genuine property of a live-edge client with no
runway model, and a genuine difference from the time-shifted client, so it is
reported (`live_edge_mean_ms`, stalls) rather than tuned away; the validator's
live-edge check is now a setup check on the first 5 s only.

### 9.6 Fourth ablation: the veto needs a memory window

Arms lat-env-hist, lat-env-veto, guard-lat-env-veto (2026-09-29).

- **hist (rule off)** climbs highest and pays for it: native mean rung 1.9,
  1045 kbps, 74 s stalled and 19 s of data starvation while switches were in
  flight on a saturated link; PR #1378 rung 2.1 and 1119 kbps with all three
  runs invalid (freezes of 25–75 s, one decode error, and a client that ended
  26 s behind live because a 1080p subscription on a 1.5 Mbps link builds a
  backlog at the relay that a live-edge client never catches up on). With no
  memory of failed rungs the throughput rule re-selects the unsustainable rung
  as soon as the buffer rule has pulled it down.
- **veto** kills the loop: 6–12 A→B→A reversals per run (98–166 before),
  2 s stalled on PR #1378, 15 s on native (its seam holes). But it over-corrects:
  after the 1.5 Mbps phase every rung above 240p has drops on record, and the
  up-visits that would clear the record are exactly what the veto prevents, so
  the client sits at 150 kbps for the rest of the run (phase-3 rung 0.00 on both
  mechanisms). The history is the last 60 switches with no age limit; with 25
  switches per run that is the whole run.
- **guard + veto** is the same pinning from the first minute (native rung
  0.03, 8 switches in 200 s).

`switchHistoryWindowS` bounds the memory: only switches younger than the
window count. With 60 s a failed climb costs one retry per minute, which is
the behaviour the rule was meant to have. Fifth-ablation arms `lat-env-veto60`
and `guard-lat-env-veto60`.

Two failure classes surfaced again and are now handled or counted:

- a playhead parked on a group boundary with readyState 4 while the buffer
  grew for 100 s (Firefox decoder hang); the unwedge seek no longer requires
  readyState < 3, it fires on any 3 s freeze with 1.5 s buffered ahead;
- `MEDIA_ERR_DECODE` (3 so far, all on PR #1378, all on 360p-200k inside a
  burst of switches one second apart). It ends useful playback; the run is
  counted (`media errors`) and excluded.

### 9.7 Fifth ablation and the frozen controller

Arms lat-env-veto60 and guard-lat-env-veto60 (2026-09-29), all twelve runs
valid, no decode errors. The 60 s window does what it was added for: the
phase-3 played rung recovers (PR #1378 1.40, native 0.85, against 0.00 with
the unbounded veto) while reversals stay at 18–20 per run (98–166 on the
baseline). Per mechanism, `lat-env-veto60` plays 603 kbps with 15 s stalled on
PR #1378 and 335 kbps with 26 s stalled on native; adding the guard buys
fewer stalls on PR #1378 (5 s) at 382 kbps, and on native it pins the client
again (173 kbps, phase-3 rung 0.13) because native's seam holes keep feeding
drops into the history faster than the guard lets the client retry.

**Frozen controller = `lat-env-veto60`, runner arm `grid`:**
`latencyResetOnLanding`, `bufferSignal = envelope`, `switchHistoryMode =
veto`, `switchHistoryWindowS = 60`; probe floor off, up-guard off. It is the
smallest set of changes that removes the self-induced loop on both mechanisms
and both client types without a client-type-specific policy. What remains is
real: the live-edge client still climbs to rungs it cannot sustain with a 1 s
runway (about 6 reversals per minute, one retry per rung per minute), and
native still drops on every seam hole. Both are properties of the thing being
measured.

### 9.8 Re-pilot with the frozen controller

Both mechanisms, both client types, step_down_up, three repetitions
(2026-09-29). On the time-shifted client in the stable 6 Mbps phase the
controller does what the experiment needs: played rung 3.94 (3.8 Mbps), 3.6
switches/min, no stalls, shift held at 9.5–10.4 s on both mechanisms. On the
live-edge client it behaves as in the ablations (native 352 kbps, PR #1378
668 kbps, 17–18 reversals per run, against 100–170 on the baseline).

The capacity drop then shows the phenomenon the experiment is about. With a
1080p subscription on a 1.5 Mbps link the relay accumulates a backlog of
undelivered groups; the down-switch starts the target at the relay's delayed
cursor, which has moved on, and the backlog is abandoned: media seam gaps of
4–8 s (`seam buffer hole max` 7.9 s on both mechanisms), one range-jump per
hole, and the 10 s shift is consumed within the drop (time to half shift
63–66 s, i.e. right after the change) and never restored; both clients then
sit 1.5–2 s behind live. Neither mechanism has a way to re-grow a behind-live
client's shift once it has been spent. This is a measurement, not a
controller problem, and the comparison the grid is for.

Two PR #1378 defects on the time-shifted client after the drop need the
object-level diagnostic (`docs/pilot-linux.md` 9a) before its time-shifted
condition is run in the grid: groups delivered as 2-frame slivers followed by
one range-jump per second (13–44 per run, native 2–7), and a promoted switch
whose first object arrived 33 s later (`DATA_STARVED`, group 89 promoted at
the delayed edge, first object at group 120). A fourth `MEDIA_ERR_DECODE`
also occurred, again on 360p-200k inside a burst of switches with a seam
`remove()` before each `changeType()`; the branch now removes only with the
playhead floor.

### 9.9 Probe load on a FIFO bottleneck: `probeMode`, `probeMaxBytes`

The delivery diagnostics with relay `OBJECT_SENT` records (2026-09-30)
showed the relay writing every group in full within 20 ms and the client
seeing the first one or two objects about 0.9 s later, just before the next
switch reset that stream. Relay-to-client object latency was 280–415 ms at
the median even in the stable 6 Mbps phase and 0.9–3.4 s during the 1.5 Mbps
phase, on a link with 40 ms RTT. The load is the probe: 1.49 MB of probe
payload in one 10 s bucket of the drop is 1.2 Mbps of a 1.5 Mbps link. The
probe is "lowest priority" only inside the relay's QUIC scheduler; the
shaper's 100-packet FIFO queue does not know that, so every media packet
waits behind a full queue (100 × 1350 B at 1.5 Mbps ≈ 0.7 s). With switches
once a second and PR #1378 resetting the old subscription's streams at each
switch, a group's stream was reset before its packets got through, the
buffer never grew, and the controller kept switching.

- `probeMode = off`: no probe subscriptions, `ProbeRule` inactive. The
  group-burst SWMA already reads the link rate on this relay (5.7 Mbps on
  the 6 Mbps link, 1.45 on 1.5 Mbps), so `ThroughputRule` still climbs.
- `probeMaxBytes`: cap the payload (arm `grid-probe64k` = 64 KB, 85 ms on
  6 Mbps, 350 ms on 1.5 Mbps).

Arms `grid-noprobe` and `grid-probe64k`; the analyzer reports
`probe load Mbps` and `relay->client latency p50 ms` so the effect is
measured on both mechanisms (`docs/pilot-linux.md` 9a).

The four-run test (2026-09-30, time-shifted, one run per arm and mechanism)
decided it. `grid-probe64k` cut the probe to 0.06 Mbps, brought the
relay-to-client median latency to 92 ms on native and 370 ms on PR #1378,
and on PR #1378 turned 27 s of stalls into 4.8 s, played 2.9 Mbps against
1.6, and kept the shift for 81 s instead of 65. `grid-noprobe` was worse on
PR #1378 (22 s stalled, 42 groups cut, median latency 219 ms but p95 12 s
from the 1080p backlog) and its native run died of a decode error at 30 s.
**`grid` now includes `probeMaxBytes = 65536`**; the probe's readings still
drive up-switches, but a probe no longer occupies the bottleneck.

### 9.10 What to compare between arms

`experiments/compare.py` on the ablation runs: switches/min, A→B→A reversals,
superseded switches and up-guard vetoes should fall; `down-reaction s` and
`up-recovery s` (played rung held 5 s, see `docs/measurement-schema.md`)
should not rise materially; stalls and seam metrics tell whether the remaining
switches are cheaper. Pick the smallest change that removes the pathological
switching, then freeze the controller for the grid.
