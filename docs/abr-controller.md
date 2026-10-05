# The ABR controller, rule by rule

What the client's adaptive-bitrate logic is made of, what each part is
responsible for, where its numbers come from, and what the defaults do on
our two client types. Everything here is read from the code on `harness`
(`apps/client-js/src/lib/abr`, `goodput.ts`, `latencyTracker.ts`,
`buffer.ts`, `player.ts`); the "observed" columns come from a validated
60 s unshaped run of a 10 s time-shifted client on native SWITCH
(197 controller ticks, 13 switches).

## 0. The paper controller: `min`

`AbrSettings.controller.arm` selects the rule set: `min` (the paper
controller, the runner's default from the 2026-10-04 rebuild), `grid` (the
frozen ablation controller of section 9.7, kept only for the ablation record)
or `baseline` (as shipped, every knob at its default). For `min`,
`resolveControllerSettings` (`abr/types.ts`) derives the whole configuration
from the arm; the caller sets nothing else. Sections 1-9 describe the shipped
rules and the ablation history that led here; this section is the
definition the paper uses.

### 0.1 Inputs

| input                            | source (`player.getMetrics()`)                                                                                                                          | used by                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| throughput SWMA                  | `bandwidthBps`: mean of the last 5 group samples, each the bytes of objects 2..N over the arrival span of the group (`recvAt`, M11)                     | ThroughputRule, EmergencyBufferRule's low-buffer cap                                                              |
| completed groups per track       | `samplesByTrack` (optional; fallback `sampleCount`), one sample per (track, group) (F5)                                                                 | the dwell                                                                                                         |
| contiguous buffer, instantaneous | `bufferContigSeconds` (fallback `bufferSeconds`): end of the buffered range that contains the playhead minus the playhead, 0 if none (M12)              | EmergencyBufferRule, empty branch (`== 0`)                                                                        |
| contiguous buffer, envelope      | its maximum over the last `bufferEnvelopeMs` = one GOP plus one tick (1250 ms at 1 s GOPs) (`RulesContext.bufferEnvelopeSeconds`; also `buffer_rule_s`) | EmergencyBufferRule, low branch (`< 0.5 s`) (F1)                                                                  |
| playhead and presented seam      | `playheadMs`, `latestSeamPtsMs`: the latest applied seam whose region (from the hole in front of it) the playhead has entered, or null                  | SwitchHistoryRule's seam exemption (F2)                                                                           |
| switch history                   | the controller's own record of confirmed landings                                                                                                       | SwitchHistoryRule                                                                                                 |
| presented frames                 | `totalFrames > 0`; buffer samples before the first frame are discarded                                                                                  | EmergencyBufferRule stays silent before the first frame, its low branch until `bufferEnvelopeMs` after it (R4-D3) |
| landing callback                 | `onTrackSwitched(trackName)` on every terminal outcome of a switch                                                                                      | history, `ABR_DECISION`, the dwell clock (M17)                                                                    |

Nothing else is read: no latency (raw or shift-corrected), no
`targetShiftMs`, no `playbackRate`, no probe, no dropped frames, no
visibility (t5).

### 0.2 Rules and the arbiter

| rule                | tier    | decision                                                                                                                                                                                                                                              |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ThroughputRule      | DEFAULT | the highest rung with `bitrate ≤ 0.9 × SWMA`; rung 0 when none fits (`downToLowest`); abstains with no sample yet                                                                                                                                     |
| EmergencyBufferRule | STRONG  | instantaneous contiguous buffer `== 0` → rung 0; contiguous buffer **envelope** (maximum over GOP + tick, 1250 ms at 1 s GOPs) `< 0.5 s` → the highest rung with `bitrate ≤ 0.7 × SWMA` if that is below the active rung, else abstain                |
| SwitchHistoryRule   | DEFAULT | veto: caps the ladder just below the first unsafe rung above the active one; a rung is unsafe with ≥ 8 events in the last 60 s, at least one up-switch to it and `drops / ups > 0.075`; drops decided while the playhead is at a seam are not counted |

The emergency's two branches read two forms of the same contiguous buffer
(F1). Empty is a stall now, so it is judged on the instantaneous value. Low
is judged on the envelope, i.e. it fires only when the buffer stayed below
0.5 s for a whole group plus a tick: a drain, not the trough of the live-edge
per-group sawtooth (each group lands as a burst at ≈1.1 s and drains to
≈0.2-0.35 s before the next). The envelope starts with the first presented
frame (buffer samples from the pre-roll, whose length depends on the client
type, are discarded), and the low branch stays silent until it covers a whole
window, `bufferEnvelopeMs` after that frame: a shorter window can sit entirely
on a trough (R4-D3: one live-edge-only emergency on the first tick in 20-24 of
288 simulated pairs; test `EnvelopeWarmup`).

"At a seam" (F2) is measured in media time around the seam being presented,
not in groups since the landing: the playhead is in the seam's region, which
runs from the hole in front of the seam (the source's append front at landing,
when that lies before the seam) to `historyIgnoreGroupsAfterLanding` (2) group
durations past the seam PTS. Every decision is stamped with
`msPastSeam = playheadMs − latestSeamPtsMs` (`ABR_DECISION.ms_past_seam`); a
drop is exempt when `msPastSeam ≤ 2 × GOP` (negative = in the hole), and
counted when the playhead was in no seam region (`null`) or further past it. A
player that reports no seams falls back to "≤ 2 completed groups since the
landing".

The arbiter is dash.js's: the highest tier that has a request, then the lowest
index. A tie (same index, same tier) is resolved by registration order
(`RULE_ORDER`) and recorded: `ABR_TICK.chosen.rule/tied`,
`ABR_DECISION.rule/tied_rules`. In `min` a tie can only be ThroughputRule and
SwitchHistoryRule's veto at the throughput rung, i.e. a veto that did not bind;
the decision is the same either way.

Before the rules run, the switching guard allows one switch in flight
(released when the landing is confirmed and a frame has been presented, or
after 3 s followed by a 5 s cool-down). After the arbiter, two gates hold
up-switches only: slow start (no up-switch before 3 samples in the session)
and the **dwell** (no up-switch until `upDwellGroups = 3` completed groups of
the landed track since the last confirmed landing, `ABR_GATED why =
up-dwell`; before the first landing, groups of the startup track). The dwell
counts with the player's per-track sample counts; without them it takes the
total count minus the one group the landing object closes (the source's last
group), which errs one group long, never short.

`auto-emergency` labels a down-switch chosen from EmergencyBufferRule's
request (by rule identity); every other automatic down-switch is
`auto-downgrade`. Both count as drops in the history.

History and `ABR_DECISION` are written only when the player confirms a landing
on the decided target (`onTrackSwitched(target, switchSeq)`); a refused, skipped
or failed switch (callback with the old track) leaves only
`ABR_SWITCH_PHANTOM`. Both records carry `switch_seq` (the player's number for
the switch, which `switchTrack` exposes synchronously as `lastSwitchSeq` and
resolves to; the callback names it, so a callback resolves exactly its own
decision) and `decided_ts`; `ABR_DECISION` is emitted at the landing (F14). A
decision's record outlives its switching guard (F7): the guard may time out
and release, but the record stays pending until its target lands (which also
resolves every older record: an older switch cannot land after a newer one
has), its own phantom callback arrives, or it ages out of the 8-entry list, so
a landing later than 3 s is still history. This holds for every arm.

### 0.3 Constants

`describeController(settings)` (`abr/index.ts`) returns these, after the arm
is resolved, as plain JSON; it is what `RUN_META.controller` records.

| constant                                                                               | `min` value                                             | tunable?                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| tick                                                                                   | 250 ms                                                  | no (`CONTROLLER_CONSTANTS`)           |
| slow start                                                                             | 3 samples                                               | no                                    |
| switching guard timeout / cool-down                                                    | 3000 / 5000 ms                                          | no                                    |
| `upDwellGroups`                                                                        | 3                                                       | yes                                   |
| `bandwidthSafetyFactor`                                                                | 0.9                                                     | yes                                   |
| EmergencyBufferRule `lowBufferS`, `throughputSafetyFactor`                             | 0.5 s, 0.7                                              | yes (rule parameters)                 |
| `switchHistoryMode`                                                                    | veto                                                    | pinned                                |
| `switchHistoryWindowS`                                                                 | 60 s                                                    | yes (0 is not accepted, reads as 60)  |
| SwitchHistoryRule `sampleSize`, `switchPercentageThreshold`                            | 8, 0.075                                                | yes (rule parameters)                 |
| `historyIgnoreGroupsAfterLanding` (seam window, GOPs of media past the presented seam) | 2                                                       | yes                                   |
| history length                                                                         | 60 entries                                              | no                                    |
| `bufferSignal`, `bufferEnvelopeMs`                                                     | envelope, GOP + tick (0 = derived; 1250 ms at 1 s GOPs) | signal pinned, window tunable         |
| `segmentDurationS`                                                                     | catalog GOP (default 1 s)                               | from the catalog                      |
| `probeMode`, `upGuardSamples`, `latencyResetOnLanding`                                 | off, 0, false                                           | pinned                                |
| SWMA window                                                                            | 5 groups                                                | the player's (recorded, not set here) |

The full description for the defaults:

```json
{
  "arm": "min",
  "tickMs": 250,
  "segmentDurationS": 1,
  "swmaWindowGroups": 5,
  "bufferSource": "contiguous",
  "bufferSignal": "envelope",
  "bufferEnvelopeMs": 1250,
  "upDwellGroups": 3,
  "minStartupSamples": 3,
  "upGuardSamples": 0,
  "upGuardRelease": "landed",
  "switchTimeoutMs": 3000,
  "switchCooldownMs": 5000,
  "maxHistory": 60,
  "switchHistoryMode": "veto",
  "switchHistoryWindowS": 60,
  "switchHistorySampleSize": 8,
  "switchHistoryDropRatio": 0.075,
  "historyIgnoreGroupsAfterLanding": 2,
  "bandwidthSafetyFactor": 0.9,
  "throughputDownToLowest": true,
  "minBitrate": -1,
  "maxBitrate": -1,
  "emergencyLowBufferS": 0.5,
  "emergencyThroughputSafetyFactor": 0.7,
  "probeMode": "off",
  "probeMinBytes": 0,
  "probeMinDurationMs": 0,
  "probeMaxBytes": 0,
  "probeSafetyFactor": 0.8,
  "probeIntervalMs": 2000,
  "probeDurationMs": 500,
  "probeFreshnessMs": 5000,
  "probeHorizonS": 2,
  "latencyResetOnLanding": false,
  "latencyTrendThreshold": 1.2,
  "latencyTrendDeltaMs": 100,
  "bufferTimeDefault": 18,
  "stableBufferTime": 18,
  "activeRules": ["ThroughputRule", "SwitchHistoryRule", "EmergencyBufferRule"],
  "rules": {
    "ThroughputRule": { "priority": 0.5, "parameters": { "downToLowest": 1 } },
    "SwitchHistoryRule": { "priority": 0.5, "parameters": { "sampleSize": 8, "switchPercentageThreshold": 0.075 } },
    "EmergencyBufferRule": { "priority": 1, "parameters": { "lowBufferS": 0.5, "throughputSafetyFactor": 0.7 } }
  }
}
```

(The probe, latency-trend and BOLA fields describe rules that do not run in
`min`; they are recorded so every arm has the same record.)

### 0.4 What is off, and why

| off                                  | why                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BolaRule and the DYNAMIC toggle      | engage at 18 s of buffer, which neither client type reaches (a time-shifted client is capped by its shift); dead code that would only silence ThroughputRule if it ever fired                               |
| ProbeRule and the probe track        | the probe shares the bottleneck queue with the video it measures (9.9) and the group-burst SWMA already reads the link rate on this relay; with no probe there is no probe load to differ by mechanism      |
| InsufficientBufferRule               | its admission `0.7 × SWMA × buffer` binds on a live-edge client and is no constraint on a 10 s client (M18): a different up-switch policy per client type. Its emergency half is EmergencyBufferRule        |
| BufferDrainRateRule                  | differences the buffer, so the group-burst sawtooth reads as a drain at the live edge and it cannot fire above 2 s on a time-shifted client (9.4); it turned a one-group seam hole into a rung-0 vote (M17) |
| LatencyTrendRule                     | its signal is capture-to-receipt latency, whose baseline is the shift (C6); even shift-corrected it reacts to every mechanism's catch-up burst (9.3). Off rather than corrected                             |
| AbandonRequestsRule                  | fires at SWMA < 0.55 × bitrate, which ThroughputRule already covers at 0.9                                                                                                                                  |
| L2A, LoLP, DroppedFrames             | off in every arm; untuned for this stack                                                                                                                                                                    |
| up-guard, probe floor, latency reset | ablation knobs (section 9); the dwell replaces the up-guard                                                                                                                                                 |

### 0.5 Why `min` is neutral to the client type and the mechanism

The paper compares a live-edge client with time-shifted clients (0.1-10 s
behind live) across switching mechanisms, so the controller must not apply a
different policy to one of them. `min` is built from the inputs below, and
each is either the same quantity on every client or the same function of a
physical quantity whose value the clients legitimately differ in:

1. **Throughput** is a per-group burst rate measured at arrival. The relay
   delivers each group as a burst whether it is the live group or a delayed
   one from cache, so both client types measure the same bottleneck rate from
   the same kind of event; the shift does not enter the sample. Test (e)
   drives a 0.1 s and a 10 s client with identical throughput and contiguous
   buffer inputs (and opposite latency, shift and playback-rate signals) and
   requires identical decisions.
2. **Time is counted in groups**, not seconds of buffer or presentation: the
   dwell is 3 completed groups of the landed track since the landing (one
   sample per (track, group), so a redelivered or split catch-up group does
   not count twice, F5), and the landing is the target's first applied object
   (t4, about one group on every mechanism and both client types). Visibility
   (t5), which takes the whole shift on a time-shifted client, is not used. The
   history window (60 s) is wall-clock time and the same for everyone.
3. **The seam exemption is anchored at the seam the viewer is shown**, in
   media time (the hole before it and 2 GOPs after it), not at the landing. The
   same hole reaches the playhead about one group after the landing at the
   live edge and about one shift after it on a time-shifted client; anchored
   at the landing (≤ 2 groups) it was exempt on the first and counted on the
   second, so a time-shifted client paid a 60 s veto for the hole a live-edge
   client was forgiven. Anchored at the seam it is exempt on both and no
   other drop is exempt on either (F2; test `MinArm (j)`: identical
   hole-induced drops on a 1-group and a 10-group client leave 720p uncapped on
   both, ordinary drops cap it on both).
4. **The only buffer rule is an emergency on playable seconds**, with the same
   thresholds (0 and 0.5 s) for every client, judged on the level after each
   group burst (the envelope) except for the empty test. A stall is a stall on
   either client type; what differs is how much runway each has, which is the
   property being measured, not a policy. This is the line `min` draws against
   InsufficientBufferRule (admission scaled by the buffer, so the same link
   event is judged differently) and LatencyTrendRule (sensitivity inversely
   proportional to the shift).

Mechanism neutrality: no rule reads anything a mechanism produces differently
by design (the probe, the catch-up latency burst, the seam hole as a drain).
A seam hole costs what it costs (a stall if it empties the playable buffer),
and a drop decided while the playhead is at the seam is kept out of the
history, so a mechanism with a bigger hole does not also pay a 60 s ladder cap
for it. Phantom switches are not history on any mechanism, and a late landing
is history on every mechanism.

Two asymmetries of the first `min` version were policy, not physics, and are
fixed (review of 2026-10-04):

- **The live-edge sawtooth (F1).** The low-buffer branch read the
  instantaneous contiguous buffer, whose live-edge trough (0.2-0.35 s) is below
  0.5 s once per group, so with a SWMA in `[bitrate/0.9, bitrate/0.7)` the
  live-edge client alternated between ThroughputRule's rung and the 0.7 × SWMA
  rung while a 10 s client with the same throughput never moved. Reviewer's
  simulation (120 s, 3-rung ladder, one group per 4 ticks, SWMA 2.0 Mbps on
  720p, sawtooth 1.1/0.85/0.6/0.35 s vs the same +9 s): **before 45 switches
  live-edge vs 0 time-shifted; after 0 vs 0** (trough 0.2 s at 1.9 Mbps: 45 vs
  0 before, 0 vs 0 after; test `MinArm (i)`). A real drain (envelope below
  0.5 s) still drops.
- **The seam window anchored at the landing (F2)**, see item 3 above.

What remains asymmetric, and is reported rather than tuned:

- A live-edge client has about 1 s of runway and a 10 s client about 10 s, so
  the same link collapse empties the live-edge buffer first (the empty branch
  and, after one GOP plus one tick below 0.5 s, the low branch fire there first). This is the
  property being measured, not a policy.
- Groups arrive faster than one per second during a catch-up replay or the
  connect backlog of a time-shifted client, so the dwell and slow start elapse
  sooner in wall time there (the minor "slow start is instant" finding). The
  samples are real link-rate samples, so the decision is not wrong, only
  faster.

### 0.6 Wiring (integration contract for app.tsx and the runner)

- URL `?controllerArm=min|grid|baseline` → `AbrSettings.controller.arm`
  (runner `--controller`, default `min`). The controller selects its rule set
  from `arm` alone; the other controller URL parameters keep working for
  `grid`/`baseline` and are overridden where `min` pins them.
- `controller.segmentDurationS = catalog.getGopDurationMs(videoTrack) / 1000`.
- `RUN_META.controller = describeController(effectiveAbrSettings)` (the
  settings actually given to the controller, after any override).
- `player.setOnTrackSwitched((name, seq) => abr.onTrackSwitched(name, seq))`
  for every terminal outcome, with the track the player is now on and the
  switch's `switch_seq` (the deprecated `releaseSwitchingGuard()` reads
  `activeTrack` instead).
- `player.setResetLatencyOnLanding(abr.settings.controller.latencyResetOnLanding)`
  (the resolved value; `min` pins it false).
- Player metrics consumed: `bandwidthBps`, `sampleCount`, `samplesByTrack`
  (recommended: per-track counts keyed by THROUGHPUT_SAMPLE.track),
  `bufferSeconds`, `bufferContigSeconds`, `activeTrack`, `totalFrames`,
  `playheadMs` and `latestSeamPtsMs` (the seam exemption; absent → the
  groups-since-landing fallback), and `player.lastSwitchSeq` after each
  `switchTrack` call; for
  `grid` also `latencyRecentMeanMs`, `latencyOlderMeanMs` (undefined until the
  latency window is full) and `targetShiftMs` (C6; without the means
  LatencyTrendRule falls back to the raw ratio), `playbackRate`,
  `droppedFrames`, and `probeTrackBandwidth` returning `{bps, dtMs}` per the
  M18 contract in `ProbeManager.ts`.

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
chosen request came from EmergencyBufferRule, i.e. only in `min`; it used to
match "emergency" in the reason text, which no active rule produced) and to
size the probe.

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
relay's synthetic `.probe:<bytes>:0` track (`grid` and `baseline` only;
`min` never probes). Size is

```
probe_bits = 2 s * (b[i+1] - b[i] + tracksize)
```

where `tracksize` is the bitrate gap left by the previous switch (Kuo
Algorithm 1). The relay sends that many zero bytes in 4 KB objects at
lowest priority and ends the subscription; the client reads until the
stream ends and reports `bps = probe bytes * 8 / (lastObjectAt −
firstObjectAt)` over the arrival span of the burst (M18; the shipped
`(video + probe bytes) * 8 / elapsed` included the subscribe round trip and
a fixed 250 ms idle in the denominator and capped the reading near 2.7 Mbps
with a 64 KB probe). The value is valid for 5 s, then reads as 0. Only
`ProbeRule` uses it.

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
- `segmentDurationS`: `controller.segmentDurationS`, the catalog GOP in
  seconds (default 1).
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

`settings.controller` (`ControllerSettings`) adds `arm` (`min` | `grid` |
`baseline`, URL `?controllerArm=`), the `min` constants `upDwellGroups` (3)
and `historyIgnoreGroupsAfterLanding` (2), `segmentDurationS` (catalog GOP,
default 1) and the ablation knobs of section 9.

## 4. Arbitration and strategy

`AbrRulesCollection.evaluate` runs every active rule; `getMinSwitchRequest`
then picks, **from the highest priority tier that has any request, the
lowest representation index**. Priorities are STRONG (1), DEFAULT (0.5),
WEAK (0). So one STRONG down-vote beats any number of DEFAULT up-votes, and
among equals the most conservative rung wins; a rule that abstains has no
say. Rules cannot veto a _down_-switch. At equal index and tier the first rule
in registration order supplies the reason and the others are recorded as
tied (`ABR_TICK.chosen.tied`, `ABR_DECISION.tied_rules`).

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

A veto since M18. If a probe result is fresh (< 5 s) and
`probe × safetyFactor (0.8) <` the next rung's bitrate, it asks for the
_active_ rung (DEFAULT), which the arbiter turns into "stay" against any
DEFAULT up-vote; with headroom it abstains and ThroughputRule decides how far
to climb. Never down. The shipped rule proposed exactly the next rung, which
under the min-index arbiter limited a strong probe's climb to one rung and let
a weak probe's multi-rung climb through.

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

If the latency trend is ≥ 1.2 and not on the lowest rung: one rung down,
STRONG. No state. Since C6 the trend is formed on `latency − targetShiftMs`
(the half-window means minus the client's shift) when the player exposes the
means and the shift; with the means but no shift (or a non-positive corrected
base) it fires on an absolute rise of `trendDeltaMs` (100 ms); with neither it
keeps the raw ratio. Off in `min`. It is the rule the earlier smoke runs' flip-flop came
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

| where          | value                                                                | meaning                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AbrController  | 250 ms                                                               | tick                                                                                                                                                                                              |
| AbrController  | 3000 ms / 5000 ms                                                    | switching-guard timeout / cool-down after it                                                                                                                                                      |
| AbrController  | 3                                                                    | throughput samples before an up-switch (slow start)                                                                                                                                               |
| AbrController  | 60                                                                   | switch-history length                                                                                                                                                                             |
| AbrController  | 2 s                                                                  | probe horizon in the size formula                                                                                                                                                                 |
| controller     | 0 B / 0 ms / 0 / landed / false / evict / 0 s / instant / GOP + tick | probeMinBytes, probeMinDurationMs, upGuardSamples, upGuardRelease, latencyResetOnLanding, switchHistoryMode, switchHistoryWindowS, bufferSignal, bufferEnvelopeMs (section 9; all off = baseline) |
| ProbeManager   | 2000 / 500 / 5000 ms                                                 | min interval / nominal duration / freshness                                                                                                                                                       |
| GoodputTracker | 5                                                                    | SWMA window (groups)                                                                                                                                                                              |
| LatencyTracker | 100                                                                  | samples in the trend window                                                                                                                                                                       |
| BolaRule       | 10 s, 0.99                                                           | MINIMUM_BUFFER_S, placeholder decay                                                                                                                                                               |
| L2ARule        | 4, 2, 1.5 s                                                          | horizon, REACT, buffer target                                                                                                                                                                     |
| LoLpRule       | 0.5 s, 0.1                                                           | emergency buffer, SOM learning rate                                                                                                                                                               |
| context        | catalog GOP (default 1 s), false                                     | segmentDurationS (`controller.segmentDurationS`), isLowLatency                                                                                                                                    |

The controller's own fixed numbers (tick, guard timeout and cool-down, slow
start, history length, probe horizon/interval/duration/freshness) live in
`CONTROLLER_CONSTANTS` (`abr/types.ts`) and, with every setting the arm
resolves to, are recorded per run by `describeController` in
`RUN_META.controller` (section 0.3); they are no longer pinned only by the git
sha.

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
last `bufferEnvelopeMs` (one group plus one tick: `segmentDurationS × 1000 +
tickMs` unless set explicitly, 1250 ms at 1 s GOPs and 2250 ms at 2 s; RUN_META
`controller.bufferEnvelopeMs` is the effective value): the level after each
burst landed, which is what the dash.js rules were written for. The empty-buffer
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

**Frozen controller = `lat-env-veto60`, runner arm `grid`** (kept only for the
ablation record since the 2026-10-04 rebuild; the paper controller is `min`,
section 0):
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
