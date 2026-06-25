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
//!   (c) the target Track is **gap-free** from `g` up to its live edge, so the
//!       catch-up stream `[g, live_edge)` can be delivered without holes.
//!
//! This module is the pure, side-effect-free core of that decision so it can be
//! exhaustively unit-tested. Group availability is modelled as a `BTreeSet<u64>`
//! of group IDs per Track; Relay Switch Handler wires the relay's per-track caches
//! (`track.rs` / `track_cache.rs`) into these sets (or a cheaper range query)
//! and maps the result onto PUBLISH / PUBLISH_DONE.

use std::collections::BTreeSet;

/// Outcome of `compute_switch_group`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // consumed by relay switch handler, not yet wired
pub(crate) enum SwitchSelection {
  /// A valid common, gap-free boundary was found; carry out the switch here.
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
#[allow(dead_code)] // consumed by Area 3 (relay switch handler), not yet wired
pub(crate) fn compute_switch_group(
  min_switch_group: u64,
  current_available: &BTreeSet<u64>,
  target_available: &BTreeSet<u64>,
  target_live_edge: u64,
) -> SwitchSelection {
  // Condition (c) anchor: the live edge itself must be present on the target,
  // otherwise no range can be gap-free *up to* it.
  if !target_available.contains(&target_live_edge) {
    return SwitchSelection::NoCommonBoundary;
  }

  // Walk down from the live edge to find the lowest group `tail_start` such
  // that `[tail_start, target_live_edge]` is fully present on the target — the
  // contiguous, gap-free tail that catch-up can serve. Any `g` in this tail
  // satisfies condition (c).
  let mut tail_start = target_live_edge;
  while tail_start > 0 && target_available.contains(&(tail_start - 1)) {
    tail_start -= 1;
  }

  // Condition (a) + (c): the smallest candidate is the higher of the client's
  // floor and the contiguous tail start.
  let floor = min_switch_group.max(tail_start);
  if floor > target_live_edge {
    return SwitchSelection::NoCommonBoundary;
  }

  // Condition (b): the smallest group present on the *current* Track within
  // `[floor, target_live_edge]`. Because that window lies inside the target's
  // gap-free tail, any such group is automatically present on the target too,
  // making it a genuine common boundary.
  match current_available.range(floor..=target_live_edge).next() {
    Some(&g) => SwitchSelection::Ready(g),
    None => SwitchSelection::NoCommonBoundary,
  }
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
  fn min_above_live_edge_fails() {
    let cur = range_set(0, 10);
    let tgt = range_set(0, 10);
    assert_eq!(
      compute_switch_group(11, &cur, &tgt, 10),
      SwitchSelection::NoCommonBoundary
    );
  }

  #[test]
  fn gap_in_target_skips_past_gap() {
    // Target is missing 3 and 4, so the gap-free tail starts at 5. Even though
    // the client would accept group 0, catch-up can only begin at 5.
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
    // the target tail isn't even contiguous, and there is no common boundary.
    let cur = set(&[0, 2, 4, 6]);
    let tgt = set(&[1, 3, 5, 7]);
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 7),
      SwitchSelection::NoCommonBoundary
    );
  }

  #[test]
  fn live_edge_absent_on_target_fails() {
    let cur = range_set(0, 10);
    let tgt = range_set(0, 9); // missing the live-edge group 10
    assert_eq!(
      compute_switch_group(0, &cur, &tgt, 10),
      SwitchSelection::NoCommonBoundary
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
    // Target only holds a recent window [8, 12]; client floor is 6. The tail
    // starts at 8, so the effective floor is 8, and 8 is common.
    let cur = range_set(0, 12);
    let tgt = range_set(8, 12);
    assert_eq!(
      compute_switch_group(6, &cur, &tgt, 12),
      SwitchSelection::Ready(8)
    );
  }
}
