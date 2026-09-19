# SWITCH_FROM (moq-transport PR #1674 / #1675) — harness notes

This branch (`switch/pr1674`) runs the experiment harness on upstream moqtail's
`switch-from` work, pinned at the tag `upstream-switch-from/2026-09-12`:

- [Track Switching via the SWITCH_FROM parameter (#1674)](https://github.com/moq-wg/moq-transport/pull/1674):
  a SUBSCRIBE (or REQUEST_UPDATE) carrying `SWITCH_FROM` activates its own
  subscription and suspends the one it names. The SWITCH message is gone.
  A **hard** switch stops the suspended subscription on the first object the
  activating one delivers.
- [SWITCH_FROM Soft Mode (#1675)](https://github.com/moq-wg/moq-transport/pull/1675):
  a **soft** switch lets the suspended subscription drain up to the group
  before the activating subscription's Start Group, so the two are contiguous.
- The fill filter types (`AbsoluteStartFill`, `AbsoluteRangeFill`,
  `RelativeStartFill`) ask for already-published objects, which arrive on a
  fill fetch stream (a unidirectional stream beginning with a FETCH_HEADER that
  names the request that asked for the fill).

The relay, libraries and the switching semantics are upstream's, unmodified.
What this branch adds on top is the harness (ABR client, filtered/delay-mode
playback, publisher, Mininet experiments, paper notebooks) and the mapping
below.

## How the harness player drives a switch

`Player.switchTrack()` (apps/client-js/src/lib/player.ts) calls
`client.switch({ switchFromRequestId, switchMode, newSubscribeOptions })`;
`computeSwitchFromPlan()` decides the mode and filter:

| harness `switchMode` | SWITCH_FROM mode | target filter                                                              | what the subscriber sees                                                                                                                                                                                                     |
| -------------------- | ---------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-edge`          | Hard (#1674)     | `LatestObject`                                                             | The target starts at the live edge; the old track is cut on the target's first object. Old-track media already buffered stays, so a behind-live client jumps to live at the seam (the paper's live-edge discontinuity).      |
| `time-shifted`       | Soft (#1675)     | `AbsoluteStartFill` at the group containing the playhead (via the TimeMap) | The relay delivers `[start, live edge)` on a fill fetch stream and drains the old track up to `start - 1`; the seam lands at the playhead. A TimeMap miss falls back to the live-edge plan and is recorded as `timeMapMiss`. |

Both modes deliver on the **same** output stream as the original SUBSCRIBE
(the client re-routes the target's objects onto it), so the MSE pump and the
write handler survive the seam. The write handler still recognises the seam by
the objects' full track name and re-injects the target's init segment there.
After SUBSCRIBE_OK the player adopts the new SUBSCRIBE's request id: the next
switch names it as `switchFromRequestId`.

## Delay-mode (filtered) playback on this branch

The project-local `DELAY_GROUPS` parameter still puts a filtered client
`delay_groups` behind the live edge. The relay rewrites such a SUBSCRIBE to
`AbsoluteStartFill` at the computed start, so the backlog reaches the client on
a fill fetch stream (upstream removed the joining cache replay the draft-14
harness relied on). The hold-until-the-edge-advances behaviour is unchanged.

## What did not carry over from the other branches

- The SWITCH message, `START_LOCATION_GROUP`, and the relay-side switch
  promotion of the draft-14 harness: superseded by SWITCH_FROM.
- Everything specific to PR #1378 (`switch/pr1378` branch): Minimum Switching
  Group ID, G_switch selection, drain-before-PUBLISH, SWITCH_TRANSITION.
