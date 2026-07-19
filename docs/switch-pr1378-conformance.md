# SWITCH (moq-transport PR #1378) — conformance notes

The relay (`apps/relay`) and the TypeScript client (`libs/moqtail-ts`) implement
[SWITCH for Client-side ABR (moq-wg/moq-transport#1378)](https://github.com/moq-wg/moq-transport/pull/1378):
the SWITCH control message (`0x1B`), relay-local switch processing (G_switch
selection, drain-before-PUBLISH, catch-up FETCH_HEADER stream, Close-After-Switch),
the SWITCH_TRANSITION parameter (`0x73`), and the PR's failure discipline.

This file records the places where the implementation deliberately departs from
— or fills gaps in — the letter of the PR text, so reviewers don't rediscover
them as bugs and the rationale survives the people who made the calls.

## Deviation: a late relay answer is declined, not a PROTOCOL_VIOLATION

**Spec text.** "If a PUBLISH contains a SWITCH_TRANSITION parameter but no
pending SWITCH exists for that target Track, the receiver MUST close the
session with PROTOCOL_VIOLATION."

**Why the client has a response deadline the spec doesn't mention.** The PR
defines exactly one SWITCH outcome that produces _no_ PUBLISH at all: the
pre-validation gate (the Current Subscribe Request ID does not identify an
Established subscription — the relay must stay silent). A subscriber therefore
cannot distinguish "my SWITCH was dropped at the gate; no answer will ever
come" from "the answer is still in flight" except by a local deadline.
`MOQtailClient.switch()` resolves as a `SwitchFailure(Timeout)` after
`SWITCH_RESPONSE_TIMEOUT_MS` (6000 ms, 2x the relay's `DEFAULT_T_SWITCH` of
3000 ms, so a relay operating within its own budget always wins the race).

**The deviation.** A relay answer that arrives _after_ that local deadline is,
from the spec's viewpoint, still answering a pending SWITCH (the spec has no
client-timeout concept); from the client's bookkeeping, no pending SWITCH
exists any more. Read literally, the spec's sentence would require closing the
session — punishing a relay that behaved correctly, and tearing down every
other subscription on the session, because of network delay. Instead, the
client records a **tombstone** per timed-out SWITCH (keyed by target track,
TTL `SWITCH_TOMBSTONE_TTL_MS` = 30 s) and treats a SWITCH*TRANSITION PUBLISH
that matches a live tombstone as a \_late* answer, not an _unsolicited_ one
(`libs/moqtail-ts/src/client/handler/publish.ts`):

- **Late failure PUBLISH** (`content_exists = 0`): dropped; the trailing
  PUBLISH_DONE resolves to a no-op. Nothing was established on either side.
- **Late success PUBLISH**: receiver routing is registered first — the relay
  has already opened the catch-up FETCH_HEADER stream and the target's
  SUBGROUP streams, and failing their route lookup would itself escalate to a
  protocol violation — then the track is unsubscribed after the route-wait
  window (`LATE_SWITCH_UNSUBSCRIBE_DELAY_MS`). The pushed stream is never
  exposed to the application.

A SWITCH_TRANSITION PUBLISH with **no** live tombstone remains a
PROTOCOL_VIOLATION exactly as the spec requires: liberal acceptance is
deferred by the TTL, never disabled.

**Consequence applications must know (late success).** The relay _completed_
the switch: Close-After-Switch already terminated the current subscription on
the relay side. The application, however, was told the switch failed
(`SwitchFailure` with status `Timeout`) and kept its current-subscription
state — state that now refers to a torn-down track. It learns the truth only
when the old request id's PUBLISH_DONE(`SUBSCRIPTION_ENDED`) arrives.
Applications should therefore treat a `Timeout` SwitchFailure as "the source
subscription may be gone" and handle a subsequent PUBLISH_DONE for the old
request id (e.g. by re-subscribing) rather than assuming the pre-switch world
is intact.

## Minor notes (gap-filling, not conflicts)

- **Failure PUBLISH carries SWITCH_TRANSITION `{0, 0}`.** The spec requires
  SWITCH*TRANSITION in "a PUBLISH opened by a Relay in response to a SWITCH
  message" and the failure PUBLISH is such a PUBLISH — but no seam was
  selected, so the relay sends placeholder zeros. The parameter's \_presence*
  is what lets the subscriber classify the PUBLISH as switch-related; the
  outcome is keyed off the immediately following PUBLISH_DONE status code,
  never off these values.
- **Group-availability granularity.** The spec counts a group available "as
  soon as [the relay] has received sufficient bytes to parse an Object header
  identifying GroupID g"; the relay's cache marks a group available at its
  first fully ingested object. Availability is thus recognized strictly no
  earlier than the spec allows, never wrongly.
- **T_switch reclamation.** The spec caps a Current Subscribe Request ID at
  one in-flight SWITCH but does not say when the slot frees if a switch
  wedges. The relay self-expires the in-flight guard at `T_switch`
  (`apps/relay/src/server/switch_guard.rs`); a superseded task answers with
  the draft's TIMEOUT and provably never touches the source subscription
  (generation-token ownership).
