# ABR — dash.js parallels and divergences

Living record of which dash.js techniques the MoQtail ABR controller copies
verbatim, and where it intentionally diverges (with the reason).

When you change ABR behavior, update the relevant section here so future
sessions can see why the code looks the way it does.

dash.js source pinned at commit `ac9e3d18818f3ba9b99a87151b887d66aed12c56`
(v5.2.0 development branch). All dash.js permalinks use that SHA.

---

## Adopted from dash.js

### Time-weighted EMA with seconds-scale half-life

dash.js: EWMA weight is `downloadTimeInMs * 0.0015`; alpha = `0.5^(weight/halfLife)`.
Defaults `halfLife.fast = 3 s`, `halfLife.slow = 8 s`.

Ours: [`goodput.ts:#updateEma`](goodput.ts) takes a `weightMs`, computes
`alpha = 0.5^((weightMs/1000)/halfLifeSec)`. Settings live in
`AbrSettings.ewma.{throughputFastHalfLifeSeconds, throughputSlowHalfLifeSeconds}`
and are pushed into the tracker by `AbrController` constructor + `updateSettings`.
Defaults match dash.js (3 s / 8 s). The EMA now consumes one sample per
finalized GOP (~1 s) — see SWMA divergence below.

### Lower-bitrate-wins arbiter

dash.js: `getMinSwitchRequest` walks priority tiers and within each tier
picks the lowest bitrate (`ABRRulesCollection.js#L192-L231`).

Ours: [`AbrRulesCollection.ts:getMinSwitchRequest`](AbrRulesCollection.ts)
walks STRONG → DEFAULT → WEAK and within the highest non-empty tier picks
the lowest `representationIndex`. Asymmetric by construction — any rule can
veto an upswitch but no rule alone can keep us _up_ if another rule wants
_down_.

### SwitchHistoryRule drop-ratio guard

dash.js: tracks `drops/noDrops` across last `sampleSize=8` decisions; if
`drops/noDrops > 0.075`, propose one rung lower
(`SwitchHistoryRule.js#L26-L46`).

Ours: [`SwitchHistoryRule.ts`](rules/SwitchHistoryRule.ts) implements the
same shape. Defaults match: `sampleSize=8, switchPercentageThreshold=0.075`.

### `bandwidthSafetyFactor` 0.9

dash.js: `getSafeAverageThroughput = average * bandwidthSafetyFactor`,
default 0.9 (`Settings.js#L1437`, applied in
`ThroughputController.js#L425-L429`).

Ours: applied inside `ThroughputRule` (`effectiveBandwidth = bandwidthBps *
bandwidthSafetyFactor`). Same value. Different layering than dash.js
(they apply at the controller, we apply at the rule), but mathematically
equivalent for ThroughputRule's use.

### BOLA ↔ Throughput hysteresis (DYNAMIC strategy)

dash.js: switch BOLA on at buffer ≥ `bufferTimeDefault`, off at half that
(`AbrController.js#L956-L986`, comment: "use hysteresis to avoid oscillating
rules").

Ours: [`AbrController.ts:#updateDynamicStrategy`](AbrController.ts) uses the
same on/off thresholds (`switchOnThreshold = bufferTimeDefault`,
`switchOffThreshold = 0.5 * bufferTimeDefault`).

### InsufficientBufferRule (dash.js formula)

dash.js: `cap = throughput × safetyFactor × bufferLevel / fragmentDuration`
([`InsufficientBufferRule.js`](https://github.com/Dash-Industry-Forum/dash.js/blob/ac9e3d18818f3ba9b99a87151b887d66aed12c56/src/streaming/rules/abr/InsufficientBufferRule.js)).
At healthy buffers (e.g. 15 s buffer, 1 s segments) the multiplier is 15 →
the cap exceeds every track and the rule effectively yields control to
ProbeRule/ThroughputRule. At critical buffers (sub-second) the multiplier
collapses → the rule forces an emergency downswitch.

Ours: [`InsufficientBufferRule.ts`](rules/InsufficientBufferRule.ts) uses
the same formula. Defaults: `throughputSafetyFactor=0.7`,
`segmentIgnoreCount=2` (warm-up). STRONG priority below 0.5 s buffer,
DEFAULT otherwise; immediate forced-360p with STRONG when buffer = 0.

**Why this works for us now (it didn't before):** an earlier divergence
clamped the multiplier to `min(1, buffer/stableBufferTime)` because our
passive `bandwidthBps` was push-rate-pinned (≈ active source bitrate); the
17× multiplier over a push-pinned reading produced phantom upswitches.
ProbeRule (Kuo Algorithm 1) and SWMA-on-burst now read true link rate, so
the dash.js multiplier is safe again — and the previous clamp was the
direct cause of `test_bandwidth_recovery` getting stuck at 720p (the
fillRatio cap excluded 1080p across the entire 6–16 s buffer band).

### AbandonRequestsRule shape

dash.js: mid-flight abandon if `traces ≥ minThroughputSamplesThreshold`,
`elapsed > minSegmentDownloadTimeThresholdInMs`, and estimated finish
exceeds `abandonDurationMultiplier * fragmentDuration`. Defaults
`abandonDurationMultiplier=1.8, minSegmentDownloadTimeThresholdInMs=500,
minThroughputSamplesThreshold=6`.

Ours: [`AbandonRequestsRule.ts`](rules/AbandonRequestsRule.ts) — same
parameter names and defaults (in `DEFAULT_ABR_SETTINGS.rules.AbandonRequestsRule`).

---

## Divergences (read these before re-tuning)

### Bandwidth measurement: SWMA on per-group object timing + active probe

dash.js measures bandwidth as **segment-download rate**: bytes ÷ time-to-fetch
of one segment (`ThroughputModel.js`). For a 1 s segment fetched in 200 ms
over a fast link, dash.js's number reads 5× the encoded bitrate, so it
naturally tracks link headroom — exactly what BOLA-O's throughput cap and
ThroughputRule both need.

In MoQ there is no equivalent: the publisher pushes objects continuously and
the receiver has no "request" to time. A naive EWMA over
`WebTransport.getStats().bytesReceived` averages publisher idle gaps into the
estimate and converges on the _source bitrate_, so it can never confirm
headroom for an upswitch. Confirmed under `test_bandwidth_recovery`: the link
recovered from 1 Mbps to 5 Mbps but the estimator stayed at the active
2 Mbps source rate, BOLA-O's `tpIdx` stayed pinned at the current rep, and
the upswitch never fired.

Two fixes, both directly from the IETF 119 MoQ working-group materials
([slides](https://datatracker.ietf.org/meeting/119/materials/slides-119-moq-bandwidth-measurement-for-quic-00))
and validated by Kuo (KTH MSc 2025, "Evaluating Media over QUIC for
Low-Latency Adaptive Streaming," DiVA `diva2:1998440`).

**1. Passive: SWMA on per-group object timing.** [`goodput.ts`](goodput.ts)

The slides describe SWMA over per-frame fragment timings; in this codebase
one frame = one MoQ object so the same idea applies one level up at the
GOP/group boundary. Crucially, the publisher's [`sender.rs::send_group`](../../../../publisher/src/sender.rs)
writes all N objects of a GOP onto the QUIC stream in a tight loop with no
inter-object pacing, so the receive interval `t_N − t_1` of one group reads
the link's actual delivery rate during the burst — not the source bitrate.

Per-group sample: `groupBps = (bytes(objects 2..N)) / (t_N − t_1)`. First
object's bytes are excluded from the numerator (it only sets `t_1`).

Window of 5 samples (≈ 5 s) averaged for `getBandwidthBps()`. EMAs continue
to consume each per-group sample, weighted by group duration, for callers
that want fast/slow asymmetry.

**2. Active: synthetic-track bandwidth probe (Algorithm 1).**
[`Player.probeTrackBandwidth`](../player.ts) +
[`ProbeManager`](ProbeManager.ts) +
[`ProbeRule`](rules/ProbeRule.ts) +
[relay `subscribe_handler.rs`](../../../../../relay/src/server/message_handlers/subscribe_handler.rs)
`handle_probe_subscribe`

SWMA reads link rate during a GOP burst, which on this codebase exceeds the
active source bitrate (the publisher bursts a whole GOP back-to-back without
inter-frame pacing). When the link is _much_ fatter than the active track,
SWMA can already confirm headroom on its own. The probe is the belt-and-
braces case: when the active source bitrate is so low that one GOP fits in
a few packets, the burst window may be too short to give a reliable rate
sample.

The probe uses the IETF 119 MoQ-WG slide-deck convention exactly:
subscribe to a track named `.probe:<size>:<priority>`. The relay
recognizes the pattern, **bypasses publisher lookup and track_manager
registration**, and synthesizes the payload itself: it allocates a fresh
synthetic `track_alias` in a high range (`2^60+`, kept under
RFC 9000 §16's varint cap of `2^62 − 1` so SubscribeOk serialization
succeeds) that no publisher ever assigns, sends `SUBSCRIBE_OK`, opens a
uni stream with one
`SubgroupHeader`, writes `<size>` bytes split across 4 KB
`SubgroupObject`s, and closes the stream.

`probe_size` is **adaptive** per Kuo Algorithm 1 line 1:

```
probe_size = t × (b[i+1] − b[i] + tracksize)        bits
```

`t` = probe horizon (2 s default), `b[i+1] − b[i]` = bitrate gap to the
next-higher track from the catalog, `tracksize` = bitrate delta carried
over from the most recent switch. `AbrController` computes this each tick
and embeds the byte count in the track name (`.probe:<bytes>:0`).

**Combined v + p estimator** ([`Player.probeTrackBandwidth`](../player.ts)):
matching Algorithm 1 line 9, `BWE = (v + p) / Δt` where `v` is real-track
bytes received concurrently with the probe (cumulative-bytes diff on the
active video tracker) and `p` is probe-stream bytes. Combining v + p
estimates total link throughput rather than just the probe's residual
capacity.

**Decision** ([`ProbeRule`](rules/ProbeRule.ts), Algorithm 1 lines 11-13):
if `BWE × 0.8 ≥ b[i+1]`, return a SwitchRequest for `i+1` at
`SwitchRequestPriority.DEFAULT`. ProbeRule only handles upswitches —
downswitches come from `LatencyTrendRule` (see below).

ProbeRule and BolaRule submit independent SwitchRequests to
[`AbrRulesCollection`](AbrRulesCollection.ts); the existing
lower-bitrate-wins arbiter ensures any rule can veto an upswitch. BolaRule
remains plain dash.js BOLA-O — no probe awareness inside it.

Splitting the payload across multiple objects is the key receiver-side
detail: WebTransport's `read()` returns once per MoQ object, so a single
40 KB object would surface as a single `read()` event and yield no
inter-arrival timing. 4 KB chunks (≈ 3 MTUs each) give the receiver enough
samples to compute a meaningful rate and shed the QUIC-level head-of-stream
queueing time on the first chunk.

Why this beats subscribing to a real higher-quality track for probing
(approach we tried first): real video tracks share a `track_alias` with
SWITCH targets, and the relay's `switch_context` is keyed on `track_alias`.
A brief probe subscribe/unsubscribe on the same alias an imminent SWITCH
will target leaves _"subscriber already exists in track N (switch
subscription)"_ residue that stalls the switch gate — confirmed in
`test_bandwidth_recovery` before this change. Synthetic aliases live in
their own range and can never collide.

`probe_priority` byte in the track name maps to MoQ `publisher_priority` as
`0 → 255` (lowest, drop first under congestion) and `non-zero → 0`
(highest). The default `0` means "give me a conservative reading" — if the
link is congested the probe loses bytes first and the client reads a lower
rate, never an inflated one.

ProbeManager throttles to one probe per `intervalMs` (default 2 s) and
treats results older than `freshnessMs` (default 5 s) as stale. **No
`#switching`-guard or special-case targeting needed** — synthetic probe
traffic is on a separate track alias by construction.

Kuo §4.3.4: probe estimator MAE ≈ 0.6 Mbps / MRE ≈ 11 % vs I-frame
estimator 0.77–1.75 Mbps / 14–33 % across a 7→6→5→4→5→7 Mbps stepped link,
Mann-Whitney U significant on every metric (p < .001). The estimator
slightly underestimates (mean bias ≈ −0.6) which is preferable to
overestimating (no buffer-stall risk).

If a future MoQ draft exposes per-stream cwnd or surfaces `bytesPulled` so
the receiver can compute headroom from a passive read alone, we should
revisit whether the probe is still worth its bandwidth cost.

### Receiver-paced downswitch via buffer drain rate → BufferDrainRateRule

dash.js: not present. dash.js's `InsufficientBufferRule` uses absolute
buffer level multiplied by `throughput / fragmentDuration` as a cap;
buffer-drain _rate_ never appears as a signal. dash.js can get away with
this because its throughput estimator is segment-fetch-paced — it
self-updates at receiver-controlled cadence and stays accurate during
congestion.

In MoQ, the publisher pushes data; the receiver has no fetch primitive.
SWMA's per-group sample cadence is bounded by GOP delivery time, so when
the link chokes, GOPs take seconds to deliver and the estimator goes
silent. ThroughputRule (and BolaRule's `tpIdx`) then fires its first
post-drop decision against a stale-high `bandwidthBps`, picks an
infeasible target track, and wedges the `#switching` guard in
[`AbrController.ts`](AbrController.ts) — locking out the rules that would
otherwise correct it (InsufficientBufferRule, LatencyTrendRule).

Buffer drain rate is the missing receiver-side signal. By conservation of
buffer time:

```
d(bufferSeconds)/dt = (linkRate / sourceRate) − playbackRate
```

so

```
linkRate = sourceRate · (playbackRate − drainRate)
```

where `drainRate = −d(bufferSeconds)/dt` and `sourceRate` is the active
track's bitrate. Pure receiver-side, observed every 250 ms tick, no
`bytes / (t_N − t_1)` ratio anywhere. Reactive within one window
(≈ 1 s) of the regime change — well before InsufficientBufferRule's
buffer threshold or LatencyTrendRule's 100-frame trend window can fire.

[`BufferDrainRateRule.ts`](rules/BufferDrainRateRule.ts) keeps a 1 s
sliding window of `{ts, bufferSeconds}` samples. Once `minSamples=3`
samples are present and `drainRate ≥ drainThreshold` (default 0.3 s/s —
i.e. link delivering < 70 % of source rate), it derives `linkBps` from
the formula above, applies `safetyFactor=0.7`, and walks the catalog to
pick the highest track whose bitrate fits. STRONG priority so the request
preempts any DEFAULT-tier upswitch ProbeRule or BolaRule may fire on the
same tick.

The rule replaces what InsufficientBufferRule was _trying_ to be: a
buffer-driven safety net. InsufficientBufferRule still runs — the
`bufferSeconds === 0` STRONG idx=0 branch handles rebuffer recovery — but
the drain-rate rule fires _before_ the buffer is critically low, while
there's still time to land a feasible switch and avoid the wedge.

### Per-frame latency via PRFT box → LatencyTrendRule (Algorithm 1 downswitch)

dash.js: not present. dash.js downswitches are buffer-driven (BOLA, plus
`InsufficientBufferRule` as the safety net). It has no equivalent of
end-to-end latency-trend tracking because TCP-based HAS doesn't see the
producer's wall-clock — only the time a segment took to download.

Ours: per Kuo Algorithm 1 lines 14-16, downswitch when end-to-end latency
rises ≥ 20 % over the last ~4 s. Implementation:

- **Publisher** ([cmaf.rs](../../../../publisher/src/cmaf.rs) `prft_box`):
  prepends a Producer Reference Time box (ISO/IEC 14496-12 §8.16.5) to
  every CMAF chunk. NTP-format wall clock at the moment the chunk was
  produced. Because PRFT is a top-level ISOBMFF box, MSE skips it cleanly
  — no receiver-side payload mangling needed.
- **Receiver** ([player.ts](../player.ts) `readPrftCaptureMs`): scans the
  first 32 bytes of each incoming chunk, extracts the NTP timestamp,
  converts to UNIX ms, and computes `latency_ms = Date.now() − captureMs`.
- **Window** ([latencyTracker.ts](../latencyTracker.ts)): circular buffer
  of the last 100 latencies (≈ 4 s at 25 fps).
- **Trend** ([latencyTracker.ts](../latencyTracker.ts) `getTrendRatio`):
  `mean(recent 50) / mean(older 50)`. > 1.20 = the thesis trigger. Robust
  to single-frame jitter; doesn't fire until the buffer is full so startup
  latency spikes don't spuriously downswitch.
- **Rule** ([LatencyTrendRule.ts](rules/LatencyTrendRule.ts)): when ratio
  ≥ 1.20 and `currentRepIndex > 0`, returns a SwitchRequest for one rung
  lower at `SwitchRequestPriority.STRONG`. STRONG so the request preempts
  any DEFAULT-tier upswitch ProbeRule or BolaRule might be proposing in
  the same tick.

Why CMAF PRFT and not LOC `CaptureTimestamp` extension headers: catalog
packaging is `cmaf`, so the spec-compliant carrier for producer timing
is the PRFT box defined by ISOBMFF (inherited by CMAF). LOC's
`CaptureTimestamp` (LOCHeaderExtensionId 2) is an extension-header
mechanism specific to LOC packaging and would not be picked up by a
spec-compliant CMAF receiver.

Probe data is consumed and discarded — never appended to MSE. Lowest
priority means the relay drops probe bytes first under congestion, so a
probe that returns < expected throughput is a reliable "don't upswitch"
signal. ProbeManager throttles to one probe per `intervalMs` (default 2 s)
and treats results older than `freshnessMs` (default 5 s) as stale.

Kuo §4.3.4: probe estimator MAE ≈ 0.6 Mbps / MRE ≈ 11 % vs I-frame estimator
0.77–1.75 Mbps / 14–33 % across a 7→6→5→4→5→7 Mbps stepped link, Mann-
Whitney U significant on every metric (p < .001). The estimator slightly
underestimates (mean bias ≈ −0.6) which is preferable to overestimating
(no buffer-stall risk).

If a future MoQ draft exposes per-stream cwnd or surfaces `bytesPulled` so
that we can compute headroom without an active probe, we should revisit
whether the probe is still worth its bandwidth cost.

### Frame-advance switching guard

dash.js: no equivalent. dash.js gates switches via segment download
boundaries — a switch decision applies to the _next_ segment fetch.

Ours: [`AbrController.ts`](AbrController.ts) keeps `#switching = true` until
`totalVideoFrames` advances past the snapshot taken when the switch was
fired. This is needed because the MoQ relay's switch protocol may deliver
the new track's first packet without the decoder actually advancing
(rapid back-to-back switches were shredding the MSE timeline). Different
protocol primitive, so different gate.

### Wedge watchdog (gap recovery)

dash.js: not present. dash.js avoids gaps by appending whole segments
aligned at GOP boundaries.

Ours: [`player.ts:startMedia()`](../player.ts) installs a 500 ms-poll
watchdog that detects `total_frames` freezing while `currentTime` sits at
the end of a buffered range with another range starting ≤ 1.5 s later, and
seeks across the gap. Needed because MoQ's per-group track switch leaves
sub-second gaps in the buffered timeline at the switch boundary.

### Test-only setting overrides via URL params

dash.js: configured via `MediaPlayer.updateSettings()`.

Ours: [`app.tsx`](../../app.tsx) merges numeric overrides from the page's
URL query string into the initial `AbrSettings`. Used by
[`tests/network/conftest.py`](../../../../tests/network/conftest.py) to set
e.g. `?bufferTimeDefault=300` for the gradual-ramp scenario without
touching production defaults.

---

## Source of truth

dash.js: https://github.com/Dash-Industry-Forum/dash.js (commit
`ac9e3d18818f3ba9b99a87151b887d66aed12c56`).

Useful files:

- `src/streaming/controllers/ThroughputController.js`
- `src/streaming/models/ThroughputModel.js`
- `src/streaming/controllers/AbrController.js`
- `src/streaming/rules/abr/ABRRulesCollection.js`
- `src/streaming/rules/abr/ThroughputRule.js`
- `src/streaming/rules/abr/InsufficientBufferRule.js`
- `src/streaming/rules/abr/SwitchHistoryRule.js`
- `src/streaming/rules/abr/AbandonRequestsRule.js`
- `src/streaming/rules/SwitchRequestHistory.js`
- `src/core/Settings.js` (defaults at L1372–L1471)
