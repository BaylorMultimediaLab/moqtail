# Experiment branches (BaylorMultimediaLab/moqtail)

This fork compares how a **time-shifted** client (deliberately behind the live
edge) and a **live-edge** client behave under ABR switching, for three track
switching mechanisms. Each mechanism has its own branch; everything they share
lives on `harness`.

| Branch          | Base                               | Switching mechanism                                                   |
| --------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `main`          | mirror of `moqtail/moqtail:main`   | none; kept in sync with upstream (`git pull --ff-only upstream main`) |
| `harness`       | `main` at tag `base/2026-09-03`    | none; the shared experiment layer (below)                             |
| `switch/native` | `harness`                          | upstream moqtail's own SWITCH                                         |
| `switch/pr1378` | `harness`                          | moq-transport PR #1378 (SWITCH message, G_switch, catch-up FETCH)     |
| `switch/pr1674` | `harness` + upstream `switch-from` | moq-transport PR #1674 SWITCH_FROM (hard) and PR #1675 (soft)         |

Pinned tags never move: `base/2026-09-03` (upstream main this layout was cut
from), `upstream-switch-from/2026-09-12` (the switch-from snapshot merged into
`switch/pr1674`), `fork-main/2026-09-18` and `fork-switch-pr1378/2026-09-18`
(the draft-14 history this stack was ported from; also backed up in
`BaylorMultimediaLab/moqtail-abr-mmsp`).

## What `harness` adds to upstream

- `apps/publisher`: a live publisher that encodes an ABR ladder with FFmpeg,
  packages CMAF and publishes it over MOQT (draft-18); can cache encoded GOPs and
  replay them.
- Relay **delay mode**: a SUBSCRIBE carrying the project-local `DELAY_GROUPS`
  parameter is started `delay_groups` behind the live edge (held until the edge
  is far enough ahead), which is what makes a time-shifted client. Also the
  `.probe:<size>:<priority>` synthetic track for bandwidth probing.
- `apps/client-js`: the ABR player (rules, metrics, TimeMap, goodput and latency
  trackers) with `clientMode` (`filtered` = time-shifted, `unfiltered` =
  live-edge). The player never tells the relay *how* to switch; each
  `switch/*` branch supplies that.
- Library support for the two project-local parameters, `SubscribeResult.largestLocation`,
  and `gopDurationMs` in the catalog.
- `scripts/run-stack.sh` (relay + publisher + player) and the `data` submodule
  with test video.

## Working rules

- Shared changes go to `harness` and are merged **down** into the three
  `switch/*` branches; never the reverse.
- Syncing with upstream: fast-forward `main`, create a new dated `base/` tag,
  merge it into `harness`, then merge `harness` into each `switch/*` branch.
  Before merging a newer `switch-from` into `switch/pr1674`, check that its
  merge base with upstream `main` is inside the pinned base.
- `harness` carries no switching mechanism of its own (the old relay-side
  `START_LOCATION_GROUP` promotion was removed on 2026-09-19). Client *types*
  are `live-edge` and `time-shifted`; those words are never used for switch
  modes, so they cannot be confused with SWITCH_FROM's hard/soft.
