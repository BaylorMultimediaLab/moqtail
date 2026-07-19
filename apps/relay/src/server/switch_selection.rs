// Copyright 2025 The MOQtail Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! G_switch selection for the SWITCH message (draft-ietf-moq-transport
//! PR #1378, "SWITCH for Client-side ABR").
//!
//! When a relay receives a SWITCH it must pick the transition group `G_switch`
//! as the *smallest* group `g` satisfying all three of:
//!
//!   (a) `g >= Minimum Switching Group ID` (the client's floor),
//!   (b) `g` is a **common boundary** — present on *both* the current and the
//!       target Track (equivalent tracks must have aligned group IDs;
//!       misaligned ladders fail here, which is the intended behaviour), and
//!   (c) for every `g'` in `[g, live_edge)`, **if** `g'` is available on the
//!       current Track **then** it is also available on the target Track.
//!
//! Note the exact shape of (c): it is *conditional*, not absolute. A hole the
//! two Tracks share does not disqualify a boundary below it — the subscriber
//! was never going to receive those groups from the current Track either, so
//! the switch loses nothing. Only a group the current Track *has* and the
//! target *lacks* blocks the seam (switching below it would silently drop
//! content the subscriber would otherwise have received). The range is also
//! half-open: the live-edge group itself is delivered by the target's live
//! SUBGROUP streams, not the catch-up range, so its cache availability is not
//! a precondition. An earlier revision required the target to be contiguous
//! from g through (and including) the live edge which inflated `G_switch` past
//! the spec's smallest (shrinking the buffer-replacement window) and spuriously
//! failed when only the live-edge group was missing.
//!
//! This module is the pure, side-effect-free core of that decision so it can be
//! exhaustively unit-tested. Group availability is modelled as a `BTreeSet<u64>`
//! of group IDs per Track; Relay Switch Handler wires the relay's per-track caches
//! (`track.rs` / `track_cache.rs`) into these sets (or a cheaper range query)
//! and maps the result onto PUBLISH / PUBLISH_DONE.

use std::collections::BTreeSet;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::server::track::Track;

/// Outcome of `compute_switch_group`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SwitchSelection {
  /// A valid common boundary satisfying (a) to (c) was found; carry out the
  /// switch here.
  Ready(u64),
  /// No group satisfies all three conditions. In the draft this surfaces to
  /// the subscriber as a `PUBLISH_DONE` with `Timeout` / `DoesNotExist`.
  NoCommonBoundary,
}

/// Select `G_switch` per PR #1378. Pure: no I/O, no async, no shared state.
///
/// * `min_switch_group` — the client's Minimum Switching Group ID floor.
/// * `current_available` — group IDs currently available on the source Track.
/// * `target_available` — group IDs currently available on the target Track.
/// * `target_live_edge` — the target Track's live edge group ID.
///
/// Implementation note: condition (c) has a closed form. Call `g'` *blocking*
/// when `g' < live_edge`, the current Track has `g'`, and the target lacks it.
/// A candidate `g` fails (c) exactly when some blocking group sits in
/// `[g, live_edge)` — i.e. when `g <= B`, the *highest* blocking group. So (c)
/// holds precisely for `g > B`, and the spec's smallest valid `g` is the
/// smallest common boundary at or above `max(min, B + 1)`. With no blocking
/// group, (c) holds everywhere (shared holes included) and the floor is just
/// the client's minimum.
pub(crate) fn compute_switch_group(
  min_switch_group: u64,
  current_available: &BTreeSet<u64>,
  target_available: &BTreeSet<u64>,
  target_live_edge: u64,
) -> SwitchSelection {
  // Highest blocking group below the (exclusive) live edge, expressed as the
  // smallest ceiling `B + 1` that clears it; 0 when nothing blocks.
  let blocking_ceiling = current_available
    .range(..target_live_edge)
    .rev()
    .find(|g| !target_available.contains(*g))
    .map(|&b| b + 1)
    .unwrap_or(0);

  // Condition (a) + (c).
  let floor = min_switch_group.max(blocking_ceiling);

  // Condition (b): the smallest group at/above the floor present on BOTH
  // Tracks. Groups at/above the live edge qualify too — (c)'s half-open range
  // is empty there, so a common boundary alone suffices.
  current_available
    .range(floor..)
    .find(|g| target_available.contains(*g))
    .map(|&g| SwitchSelection::Ready(g))
    .unwrap_or(SwitchSelection::NoCommonBoundary)
}

/// Async bridge from the relay's live state to the pure [`compute_switch_group`].
///
/// Reads both Tracks' current cache availability and the target's live edge,
/// then defers to the pure selector. The relay's SWITCH handler calls
/// this after the Current-Subscribe-Request-ID gate passes and before opening
/// the target PUBLISH. Kept thin and side-effect-free beyond the reads so the
/// decision logic stays in the unit-tested core.
pub(crate) async fn select_switch_group(
  current_track: &Arc<RwLock<Track>>,
  target_track: &Arc<RwLock<Track>>,
  min_switch_group: u64,
) -> SwitchSelection {
  let current_available = {
    let t = current_track.read().await;
    t.cache.available_group_ids().await
  };
  let (target_available, target_live_edge) = {
    let t = target_track.read().await;
    let groups = t.cache.available_group_ids().await;
    let live_edge = t.largest_location.read().await.group;
    (groups, live_edge)
  };
  compute_switch_group(
    min_switch_group,
    &current_available,
    &target_available,
    target_live_edge,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Convenience: build a group-availability set from an inclusive range.
  fn range_set(lo: u64, hi: u64) -> BTreeSet<u64> {
    (lo..=hi).collect()
  }

  /// Convenience: build a set from explicit group IDs.
  fn set(ids: &[u64]) -> BTreeSet<u64> {
    ids.iter().copied().collect()
  }

  #[test]
  fn fully_aligned_returns_floor() {
    // Both tracks hold every group 0..=10; floor honours the client's minimum.
    let cur = range_set(0, 10);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(3, &cur, &tgt, 10),
      SwitchSelection::Ready(3)
    );
  }

  #[test]
  fn min_zero_returns_zero() {
    let cur = range_set(0, 10);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::Ready(0)
    );
  }

  #[test]
  fn switch_at_live_edge_is_allowed() {
    // Floor == live edge: a hard/immediate switch with no catch-up range.
    let cur = range_set(0, 10);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(10, &cur, &tgt, 10),
      SwitchSelection::Ready(10)
    );
  }

  #[test]
  fn min_above_all_common_groups_fails() {
    // Nothing above the floor exists on either Track. (The failure is the
    // absence of a common boundary >= 11 — a floor above the live edge is not
    // itself disqualifying, see common_boundary_at_live_edge_or_above.)
    let cur = range_set(0, 10);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(11, &cur, &tgt, 10),
      SwitchSelection::NoCommonBoundary
    );
  }

  #[test]
  fn gap_in_target_skips_past_gap() {
    // The current Track has 3 and 4 but the target lacks them, so they are
    // blocking: switching at any g <= 4 would silently drop content the
    // subscriber would otherwise have received from the current Track.
    // Condition (c) therefore lifts the boundary to 5 despite the floor of 0.
    let cur = range_set(0, 10);
    let tgt = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::Ready(5)
    );
  }

  #[test]
  fn current_missing_boundary_picks_next_common() {
    // Target has everything, but the current track is missing 3 and 4, so the
    // smallest *common* boundary at/above the floor of 3 is 5.
    let cur = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(3, &cur, &tgt, 10),
      SwitchSelection::Ready(5)
    );
  }

  #[test]
  fn misaligned_group_ids_fail() {
    // tobbee's constraint: equivalent tracks must have aligned group IDs.
    // Here the current track has only even groups and the target only odd —
    // condition (b) has no candidate at all: no common boundary exists.
    let cur = set(&[0, 2, 4, 6]);
    let tgt = set(&[1, 3, 5, 7]);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 7),
      SwitchSelection::NoCommonBoundary
    );
  }

  #[test]
  fn live_edge_absent_on_target_is_not_disqualifying() {
    // Condition (c)'s range [g, live_edge) is half-open: the live-edge group
    // is delivered by the target's live subgroup streams, not the catch-up
    // range, so its cache availability is irrelevant. The earlier
    // stricter-than-spec rule failed this case outright.
    let cur = range_set(0, 10);
    let tgt = range_set(0, 9); // missing the live-edge group 10
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::Ready(0)
    );
  }

  #[test]
  fn empty_target_fails() {
    let cur = range_set(0, 10);
    let tgt = BTreeSet::new();
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::NoCommonBoundary
    );
  }

  #[test]
  fn floor_between_cached_groups_picks_first_common_above() {
    // Behind-live client whose floor lands in a hole on the current track.
    let cur = set(&[2, 4, 6, 8, 10]);
    let tgt = range_set(0, 10);
    // Floor 5 -> smallest current group in [5, 10] is 6.
    assert_eq!(
      compute_switch_group(5, &cur, &tgt, 10),
      SwitchSelection::Ready(6)
    );
  }

  #[test]
  fn target_tail_shorter_than_floor_still_ok_when_common() {
    // Target only holds a recent window [8, 12]; client floor is 6. Groups
    // 6 and 7 are blocking (current has them, target doesn't), so the
    // effective floor is 8, and 8 is common.
    let cur = range_set(0, 12);
    let tgt = range_set(8, 12);
    assert_eq!(
      compute_switch_group(6, &cur, &tgt, 12),
      SwitchSelection::Ready(8)
    );
  }

  #[test]
  fn shared_hole_permits_smallest_boundary() {
    // Both Tracks are missing 3 and 4. Condition (c) is conditional — a group
    // absent on the Current Track cannot block,
    // because the subscriber was never going to receive it from the current
    // Track either. The spec's smallest valid boundary is therefore 0 (full
    // buffer replacement); the earlier stricter rule returned 5.
    let cur = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    let tgt = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::Ready(0)
    );
  }

  #[test]
  fn current_hole_alone_never_blocks() {
    // Holes only on the current Track: nothing is blocking (the target can
    // supply everything the current Track would have supplied, and more), so
    // the floor stays at the client's minimum and the smallest common group
    // at/above it wins.
    let cur = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::Ready(0)
    );
  }

  #[test]
  fn blocking_ceiling_lifts_a_lower_minimum() {
    // Client floor 2 sits below the highest blocking group (4): condition (c)
    // lifts the effective floor to 5.
    let cur = range_set(0, 10);
    let tgt = set(&[0, 1, 2, 5, 6, 7, 8, 9, 10]);
    assert_eq!(
      compute_switch_group(2, &cur, &tgt, 10),
      SwitchSelection::Ready(5)
    );
  }

  #[test]
  fn common_boundary_at_live_edge_or_above() {
    // (c)'s half-open range is empty for g >= live_edge, so a common group
    // there qualifies on conditions (a) + (b) alone. (Availability above the
    // live edge is unusual — largest_location can lag the cache briefly — but
    // the selector should follow the spec, not second-guess its inputs.)
    let cur = range_set(0, 12);
    let tgt = range_set(0, 12);
    assert_eq!(
      compute_switch_group(11, &cur, &tgt, 10),
      SwitchSelection::Ready(11)
    );
  }

  #[test]
  fn blocking_group_beyond_live_edge_is_ignored() {
    // Group 10 is current-only, but it is not below the live edge (7), so it
    // is outside condition (c)'s range and must not block.
    let cur = range_set(0, 10);
    let tgt = range_set(0, 7);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 7),
      SwitchSelection::Ready(0)
    );
  }

  /// Literal restatement of the draft's G_switch definition, kept naive on
  /// purpose: iterate candidate common boundaries in ascending order and check
  /// condition (c) by brute force. This is the oracle for the exhaustive
  /// cross-check below.
  fn spec_reference(
    min_switch_group: u64,
    current_available: &BTreeSet<u64>,
    target_available: &BTreeSet<u64>,
    target_live_edge: u64,
  ) -> SwitchSelection {
    for &g in current_available.intersection(target_available) {
      if g < min_switch_group {
        continue;
      }
      let c_holds = (g..target_live_edge)
        .all(|gp| !current_available.contains(&gp) || target_available.contains(&gp));
      if c_holds {
        return SwitchSelection::Ready(g);
      }
    }
    SwitchSelection::NoCommonBoundary
  }

  #[test]
  fn exhaustive_equivalence_with_spec_reference() {
    // Every availability pattern over groups 0..=5 for both Tracks (64 x 64
    // subset pairs), crossed with several live edges and minimums: the closed
    // form must agree with the literal spec restatement everywhere. ~49k
    // cases; runs in well under a second.
    for cur_bits in 0u32..64 {
      let cur: BTreeSet<u64> = (0u64..6).filter(|g| cur_bits & (1u32 << *g) != 0).collect();
      for tgt_bits in 0u32..64 {
        let tgt: BTreeSet<u64> = (0u64..6).filter(|g| tgt_bits & (1u32 << *g) != 0).collect();
        for &live_edge in &[0u64, 3, 5, 7] {
          for &min in &[0u64, 2, 4, 6] {
            assert_eq!(
              compute_switch_group(min, &cur, &tgt, live_edge),
              spec_reference(min, &cur, &tgt, live_edge),
              "divergence: min={min} live_edge={live_edge} cur={cur:?} tgt={tgt:?}"
            );
          }
        }
      }
    }
  }
}
