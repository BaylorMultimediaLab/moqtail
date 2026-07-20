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

//! Failure discipline for the SWITCH message (draft-ietf-moq-transport
//! PR #1378, "SWITCH for Client-side ABR").
//!
//! Two pure, side-effect-free pieces that the relay's SWITCH handler drops in:
//!
//! 1. [`SwitchInFlight`] — the single-in-flight guard. The draft caps a Current
//!    Subscribe Request ID at one SWITCH being processed at a time; a second
//!    one that arrives within the relay's `T_switch` budget is rejected with
//!    `EXCESSIVE_LOAD`. Entries self-expire at `T_switch` so a stuck switch
//!    can't wedge the subscription forever.
//!
//! 2. [`SwitchFailure`] — classifies *why* a SWITCH could not complete and maps
//!    it onto the draft's `PUBLISH_DONE` status code. Under PR #1378 every
//!    post-validation failure still opens the target PUBLISH and reports the
//!    outcome through `PUBLISH_DONE`, leaving the current subscription
//!    untouched — replacing today's `ProtocolViolation -> disconnect()` path.
//!
//! The one failure that does *not* produce a PUBLISH is the pre-PUBLISH gate:
//! if the Current Subscribe Request ID does not identify an Established
//! subscription, the relay "MUST NOT open a PUBLISH or modify state". That
//! gate is handled in the switch handler before anything here is consulted.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use moqtail::model::control::constant::PublishDoneStatusCode;

/// Default relay-side `T_switch` budget. Kept at/under the client's ABR switch
/// guard (`AbrController.SWITCH_TIMEOUT_MS` = 3000 ms) so the relay reclaims a
/// stuck switch before the subscriber gives up on the transition.
pub(crate) const DEFAULT_T_SWITCH: Duration = Duration::from_millis(3000);

/// Result of trying to admit a new SWITCH for a subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdmitResult {
  /// No live switch in flight for this subscription; the new SWITCH proceeds.
  /// `generation` is the admission's ownership token: the switch task must
  /// pass it back to `is_abandoned` / `mark_published` / `complete` so that a
  /// task whose slot was reclaimed after its T_switch deadline (see
  /// `try_admit`) cannot act on a NEWER switch's entry.
  Admitted { generation: u64 },
  /// A switch for this Current Subscribe Request ID is already in flight within
  /// `T_switch` — the draft's `EXCESSIVE_LOAD`.
  Rejected,
}

/// Result of a switch task's attempt to claim the right to open the target
/// PUBLISH ([`SwitchInFlight::mark_published`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClaimResult {
  /// The task owns the PUBLISH; from here an UNSUBSCRIBE is ordinary teardown
  /// (`abandon()` returns `false`).
  Claimed,
  /// An UNSUBSCRIBE abandoned this switch first — the task must answer with
  /// PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED) and touch nothing else.
  Abandoned,
  /// The slot was reclaimed by a newer SWITCH after this task's T_switch
  /// deadline passed (its generation no longer matches). The task exceeded
  /// its budget — it must answer with the draft's TIMEOUT and MUST NOT touch
  /// the source subscription (the newer switch owns it now).
  Superseded,
}

/// Per-subscription in-flight switch state. One entry = one admitted SWITCH.
#[derive(Debug, Clone, Copy)]
struct InFlightEntry {
  /// Instant at which this switch expires and its slot may be reclaimed.
  deadline: Instant,
  /// Ownership token handed out by `try_admit`; monotonically increasing
  /// across ALL admissions so a reclaimed slot never reuses a live token.
  generation: u64,
  /// Abandoned by an UNSUBSCRIBE for the Current Subscribe Request ID before
  /// the target PUBLISH was opened (SWITCH PR #1378: the relay must answer
  /// with PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED)).
  abandoned: bool,
  /// The target PUBLISH has been claimed; too late to abandon.
  published: bool,
}

/// Tracks, per Current Subscribe Request ID, the in-flight SWITCH entry: its
/// deadline, its ownership generation, and the SWITCH PR #1378
/// UNSUBSCRIBE-race state (abandoned/published). `abandon()` and
/// `mark_published()` are check-and-set on the same struct, so callers that
/// serialize on the surrounding mutex get an atomic race decision: exactly one
/// side wins. The generation token closes the T_switch-expiry race: a slot
/// reclaimed by a newer SWITCH invalidates the older task's token, so the
/// older task's `mark_published` / `complete` become a `Superseded` signal /
/// no-op instead of corrupting the newer switch's entry. Time is injected
/// (`now`) rather than read from the clock so the logic stays pure and
/// unit-testable; the handler passes `Instant::now()`.
#[derive(Debug, Default)]
pub(crate) struct SwitchInFlight {
  /// Current Subscribe Request ID -> the in-flight switch's entry.
  entries: HashMap<u64, InFlightEntry>,
  /// Source of `InFlightEntry::generation` tokens.
  next_generation: u64,
}

impl SwitchInFlight {
  pub fn new() -> Self {
    Self {
      entries: HashMap::new(),
      next_generation: 0,
    }
  }

  /// Try to admit a SWITCH for `sub_request_id`. Admits when there is no
  /// in-flight entry, or the prior entry's deadline has already passed (the
  /// previous switch timed out). On admission a fresh entry with deadline
  /// `now + t_switch` and a new generation replaces any expired one — which
  /// atomically invalidates the expired task's token. The caller must pass
  /// the SAME `now` it derives its own T_switch deadline from, so that
  /// reclamation here and the task's own timeout checks agree on when the
  /// budget ends.
  pub fn try_admit(
    &mut self,
    sub_request_id: u64,
    now: Instant,
    t_switch: Duration,
  ) -> AdmitResult {
    match self.entries.get(&sub_request_id) {
      Some(entry) if now < entry.deadline => AdmitResult::Rejected,
      _ => {
        self.next_generation += 1;
        let generation = self.next_generation;
        self.entries.insert(
          sub_request_id,
          InFlightEntry {
            deadline: now + t_switch,
            generation,
            abandoned: false,
            published: false,
          },
        );
        AdmitResult::Admitted { generation }
      }
    }
  }

  /// SWITCH PR #1378 UNSUBSCRIBE race, subscriber side of the mutex: mark the
  /// in-flight switch for `sub_request_id` abandoned. Returns `true` iff a
  /// non-expired switch is in flight AND its target PUBLISH has not been
  /// opened yet — i.e. the UNSUBSCRIBE won the race and the switch task must
  /// answer with PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED). Returns `false`
  /// when there is nothing to abandon (no switch in flight, already expired,
  /// or the PUBLISH already opened — ordinary unsubscribe semantics apply).
  /// No generation is taken: an UNSUBSCRIBE abandons whichever switch is
  /// currently in flight for the subscription.
  pub fn abandon(&mut self, sub_request_id: u64, now: Instant) -> bool {
    match self.entries.get_mut(&sub_request_id) {
      Some(entry) if now < entry.deadline && !entry.published => {
        entry.abandoned = true;
        true
      }
      _ => false,
    }
  }

  /// Whether the switch admitted as `generation` has been abandoned by an
  /// UNSUBSCRIBE. Polled by the selection/drain loops for early exit. A stale
  /// generation (slot reclaimed by a newer switch) reads `false` — the newer
  /// switch's abandon state is not the old task's to observe; the old task
  /// learns its fate as `Superseded` at `mark_published`.
  pub fn is_abandoned(&self, sub_request_id: u64, generation: u64) -> bool {
    self
      .entries
      .get(&sub_request_id)
      .is_some_and(|entry| entry.generation == generation && entry.abandoned)
  }

  /// SWITCH PR #1378 UNSUBSCRIBE race, switch-task side of the mutex: atomically
  /// claim the right to open the target PUBLISH for the switch admitted as
  /// `generation`. Returns [`ClaimResult::Abandoned`] if an UNSUBSCRIBE
  /// already abandoned this switch, [`ClaimResult::Superseded`] if the slot
  /// was reclaimed by a newer SWITCH after this task's deadline (the caller
  /// must report TIMEOUT and MUST NOT touch the source subscription), and
  /// [`ClaimResult::Claimed`] otherwise — recording the PUBLISH as opened,
  /// after which `abandon()` returns `false`.
  pub fn mark_published(&mut self, sub_request_id: u64, generation: u64) -> ClaimResult {
    match self.entries.get_mut(&sub_request_id) {
      Some(entry) if entry.generation == generation => {
        if entry.abandoned {
          ClaimResult::Abandoned
        } else {
          entry.published = true;
          ClaimResult::Claimed
        }
      }
      _ => ClaimResult::Superseded,
    }
  }

  /// Release the in-flight slot once the switch admitted as `generation`
  /// reaches a terminal state (promoted to Current, or failed with a
  /// PUBLISH_DONE status). A no-op — idempotent — when the slot is already
  /// released or has been reclaimed by a newer switch (whose entry must
  /// survive this call).
  pub fn complete(&mut self, sub_request_id: u64, generation: u64) {
    if self
      .entries
      .get(&sub_request_id)
      .is_some_and(|entry| entry.generation == generation)
    {
      self.entries.remove(&sub_request_id);
    }
  }

  /// Whether a non-expired switch is in flight for this subscription.
  #[allow(dead_code)] // test/diagnostic accessor
  pub fn is_in_flight(&self, sub_request_id: u64, now: Instant) -> bool {
    self
      .entries
      .get(&sub_request_id)
      .is_some_and(|entry| now < entry.deadline)
  }
}

/// Why a SWITCH could not complete after the Current-Subscribe-Request-ID gate
/// passed. Each variant maps to the draft `PUBLISH_DONE` status reported on the
/// target Track's PUBLISH.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SwitchFailure {
  /// The target Track is unknown / not announced.
  TargetTrackMissing,
  /// No common boundary satisfying the draft's conditions (a)-(c) was found
  /// within `T_switch` (`compute_switch_group` -> `NoCommonBoundary`, or the
  /// deadline elapsed).
  NoCommonBoundary,
  /// Another SWITCH for the same Current Subscribe Request ID is in flight.
  AlreadyInFlight,
  /// Authorization failed for the target Track. This relay has no target-track
  /// authorization subsystem; kept to mirror the recommended status-code set in SWITCH PR #1378.
  #[allow(dead_code)]
  Unauthorized,
  /// This relay does not implement the SWITCH message. Never constructed by
  /// definition here (the handler exists); kept to mirror the recommended status-code set in SWITCH PR #1378.
  #[allow(dead_code)]
  NotSupported,
  /// The subscription being switched from has ended.
  SubscriptionEnded,
  /// The source could not be drained below G_switch within `T_switch` (severe
  /// congestion). The switch is aborted and the current subscription is left
  /// unchanged, rather than terminating it and truncating source Objects below
  /// G_switch.
  DrainTimeout,
  /// The target PUBLISH could not be built/sent after the drain succeeded. The
  /// seam bound applied by the drain is unwound so the current subscription is
  /// left unaltered, and the failure is reported as INTERNAL_ERROR.
  PublishBuildFailed,
  /// The switch's slot was reclaimed by a newer SWITCH after its T_switch
  /// deadline passed (`ClaimResult::Superseded`): the task ran out of budget,
  /// so the draft's TIMEOUT applies, and the newer switch owns the source
  /// subscription.
  Superseded,
}

impl SwitchFailure {
  /// Draft PR #1378 `PUBLISH_DONE` status code for this failure.
  pub fn status_code(self) -> PublishDoneStatusCode {
    match self {
      SwitchFailure::TargetTrackMissing => PublishDoneStatusCode::DoesNotExist,
      SwitchFailure::NoCommonBoundary => PublishDoneStatusCode::Timeout,
      SwitchFailure::AlreadyInFlight => PublishDoneStatusCode::ExcessiveLoad,
      SwitchFailure::Unauthorized => PublishDoneStatusCode::Unauthorized,
      SwitchFailure::NotSupported => PublishDoneStatusCode::NotSupported,
      SwitchFailure::SubscriptionEnded => PublishDoneStatusCode::SubscriptionEnded,
      SwitchFailure::DrainTimeout => PublishDoneStatusCode::Timeout,
      SwitchFailure::PublishBuildFailed => PublishDoneStatusCode::InternalError,
      SwitchFailure::Superseded => PublishDoneStatusCode::Timeout,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A fixed origin instant; tests advance from it explicitly.
  fn t0() -> Instant {
    Instant::now()
  }

  const T: Duration = DEFAULT_T_SWITCH;

  /// Admit and unwrap the generation token, failing the test on rejection.
  fn admit(g: &mut SwitchInFlight, id: u64, now: Instant) -> u64 {
    match g.try_admit(id, now, T) {
      AdmitResult::Admitted { generation } => generation,
      AdmitResult::Rejected => panic!("expected admission for sub {id}"),
    }
  }

  #[test]
  fn admits_first_switch() {
    let mut g = SwitchInFlight::new();
    assert!(matches!(
      g.try_admit(1, t0(), T),
      AdmitResult::Admitted { .. }
    ));
  }

  #[test]
  fn rejects_second_switch_within_budget() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    admit(&mut g, 1, now);
    // A second SWITCH for the same subscription, still within T_switch.
    assert_eq!(
      g.try_admit(1, now + Duration::from_millis(500), T),
      AdmitResult::Rejected
    );
  }

  #[test]
  fn readmits_after_deadline_expires_with_fresh_generation() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    let gen1 = admit(&mut g, 1, now);
    // Past the deadline: the prior (stuck) switch is reclaimable, and the new
    // admission carries a distinct ownership token.
    let gen2 = admit(&mut g, 1, now + T + Duration::from_millis(1));
    assert_ne!(gen1, gen2);
  }

  #[test]
  fn complete_releases_slot_immediately() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    let token = admit(&mut g, 1, now);
    g.complete(1, token);
    // After completion a fresh switch is admitted even within the old budget.
    assert!(matches!(
      g.try_admit(1, now + Duration::from_millis(10), T),
      AdmitResult::Admitted { .. }
    ));
  }

  #[test]
  fn complete_is_idempotent() {
    let mut g = SwitchInFlight::new();
    g.complete(42, 7); // never admitted; must not panic
    g.complete(42, 7);
  }

  #[test]
  fn distinct_subscriptions_are_independent() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    admit(&mut g, 1, now);
    // A different subscription is unaffected by sub 1's in-flight switch.
    assert!(matches!(
      g.try_admit(2, now, T),
      AdmitResult::Admitted { .. }
    ));
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Rejected);
  }

  #[test]
  fn is_in_flight_reflects_state() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert!(!g.is_in_flight(1, now));
    let token = admit(&mut g, 1, now);
    assert!(g.is_in_flight(1, now + Duration::from_millis(100)));
    assert!(!g.is_in_flight(1, now + T + Duration::from_millis(1)));
    g.complete(1, token);
    assert!(!g.is_in_flight(1, now));
  }

  #[test]
  fn abandon_before_publish_wins_race() {
    // UNSUBSCRIBE arrives while the switch task is still draining: abandon
    // succeeds, and the task's later publish claim loses.
    let mut g = SwitchInFlight::new();
    let now = t0();
    let token = admit(&mut g, 1, now);
    assert!(g.abandon(1, now + Duration::from_millis(100)));
    assert!(g.is_abandoned(1, token));
    assert_eq!(g.mark_published(1, token), ClaimResult::Abandoned);
  }

  #[test]
  fn publish_before_abandon_wins_race() {
    // The switch task claims the PUBLISH first: a later UNSUBSCRIBE is
    // ordinary teardown, not a switch abandon.
    let mut g = SwitchInFlight::new();
    let now = t0();
    let token = admit(&mut g, 1, now);
    assert_eq!(g.mark_published(1, token), ClaimResult::Claimed);
    assert!(!g.abandon(1, now + Duration::from_millis(100)));
    assert!(!g.is_abandoned(1, token));
  }

  #[test]
  fn abandon_without_in_flight_switch_is_noop() {
    let mut g = SwitchInFlight::new();
    assert!(!g.abandon(1, t0()));
    assert!(!g.is_abandoned(1, 0));
  }

  #[test]
  fn abandon_after_deadline_expiry_is_noop() {
    // The switch's T_switch budget has lapsed; its slot is reclaimable, so an
    // UNSUBSCRIBE now is not racing anything.
    let mut g = SwitchInFlight::new();
    let now = t0();
    admit(&mut g, 1, now);
    assert!(!g.abandon(1, now + T + Duration::from_millis(1)));
  }

  #[test]
  fn readmission_gets_clean_state() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    let gen1 = admit(&mut g, 1, now);
    g.abandon(1, now);
    g.complete(1, gen1);
    // A brand-new switch for the same subscription starts clean.
    let gen2 = admit(&mut g, 1, now + Duration::from_millis(10));
    assert!(!g.is_abandoned(1, gen2));
    assert_eq!(g.mark_published(1, gen2), ClaimResult::Claimed);
  }

  #[test]
  fn complete_clears_abandon_and_publish_state() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    let gen1 = admit(&mut g, 1, now);
    g.mark_published(1, gen1);
    g.complete(1, gen1);
    assert!(!g.is_abandoned(1, gen1));
    // Next admission (past the cleared entry) starts unpublished.
    admit(&mut g, 1, now + Duration::from_millis(10));
    assert!(g.abandon(1, now + Duration::from_millis(20)));
  }

  // ---- T_switch-expiry supersede race (the generation token's raison d'être) ----

  #[test]
  fn superseded_task_cannot_claim_publish() {
    // THE race this token closes: the old task's deadline passes, a new
    // SWITCH reclaims the slot, and the old task — mid-flight between its
    // last poll and its publish claim — must NOT win the claim (it would
    // open a second PUBLISH and stomp the new switch's seam state).
    let mut g = SwitchInFlight::new();
    let now = t0();
    let old_gen = admit(&mut g, 1, now);
    let new_gen = admit(&mut g, 1, now + T + Duration::from_millis(1));
    assert_eq!(g.mark_published(1, old_gen), ClaimResult::Superseded);
    // The new switch's claim is unaffected.
    assert_eq!(g.mark_published(1, new_gen), ClaimResult::Claimed);
  }

  #[test]
  fn superseded_complete_does_not_release_new_switchs_slot() {
    // Without the generation check, the old task's terminal complete() wiped
    // the NEW admission's entry, so a third SWITCH that should be
    // EXCESSIVE_LOAD was admitted.
    let mut g = SwitchInFlight::new();
    let now = t0();
    let old_gen = admit(&mut g, 1, now);
    let reclaim_at = now + T + Duration::from_millis(1);
    admit(&mut g, 1, reclaim_at);
    g.complete(1, old_gen);
    assert_eq!(
      g.try_admit(1, reclaim_at + Duration::from_millis(10), T),
      AdmitResult::Rejected,
      "the new switch's slot must survive the superseded task's complete()"
    );
  }

  #[test]
  fn stale_generation_does_not_observe_new_switchs_abandon() {
    // An UNSUBSCRIBE abandons the NEW switch; the old task's polls must not
    // see it (it would emit a spurious SUBSCRIPTION_ENDED failure PUBLISH on
    // top of the new task's own answer).
    let mut g = SwitchInFlight::new();
    let now = t0();
    let old_gen = admit(&mut g, 1, now);
    let reclaim_at = now + T + Duration::from_millis(1);
    let new_gen = admit(&mut g, 1, reclaim_at);
    assert!(g.abandon(1, reclaim_at + Duration::from_millis(5)));
    assert!(g.is_abandoned(1, new_gen));
    assert!(!g.is_abandoned(1, old_gen));
  }

  #[test]
  fn failure_status_code_mapping() {
    use PublishDoneStatusCode as S;
    assert_eq!(
      SwitchFailure::TargetTrackMissing.status_code(),
      S::DoesNotExist
    );
    assert_eq!(SwitchFailure::NoCommonBoundary.status_code(), S::Timeout);
    assert_eq!(
      SwitchFailure::AlreadyInFlight.status_code(),
      S::ExcessiveLoad
    );
    assert_eq!(SwitchFailure::Unauthorized.status_code(), S::Unauthorized);
    assert_eq!(SwitchFailure::NotSupported.status_code(), S::NotSupported);
    assert_eq!(
      SwitchFailure::SubscriptionEnded.status_code(),
      S::SubscriptionEnded
    );
    assert_eq!(SwitchFailure::DrainTimeout.status_code(), S::Timeout);
    assert_eq!(
      SwitchFailure::PublishBuildFailed.status_code(),
      S::InternalError
    );
    assert_eq!(SwitchFailure::Superseded.status_code(), S::Timeout);
  }
}
