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
#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
pub(crate) const DEFAULT_T_SWITCH: Duration = Duration::from_millis(3000);

/// Result of trying to admit a new SWITCH for a subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
pub(crate) enum AdmitResult {
  /// No live switch in flight for this subscription; the new SWITCH proceeds.
  Admitted,
  /// A switch for this Current Subscribe Request ID is already in flight within
  /// `T_switch` — the draft's `EXCESSIVE_LOAD`.
  Rejected,
}

/// Tracks, per Current Subscribe Request ID, the deadline of an in-flight
/// SWITCH. Time is injected (`now`) rather than read from the clock so the
/// logic stays pure and unit-testable; the handler passes `Instant::now()`.
#[derive(Debug, Default)]
#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
pub(crate) struct SwitchInFlight {
  /// Current Subscribe Request ID -> instant at which the in-flight switch
  /// expires and its slot may be reclaimed.
  deadlines: HashMap<u64, Instant>,
}

#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
impl SwitchInFlight {
  pub fn new() -> Self {
    Self {
      deadlines: HashMap::new(),
    }
  }

  /// Try to admit a SWITCH for `sub_request_id`. Admits when there is no
  /// in-flight entry, or the prior entry's deadline has already passed (the
  /// previous switch timed out). On admission a fresh deadline at
  /// `now + t_switch` is recorded.
  pub fn try_admit(
    &mut self,
    sub_request_id: u64,
    now: Instant,
    t_switch: Duration,
  ) -> AdmitResult {
    match self.deadlines.get(&sub_request_id) {
      Some(&deadline) if now < deadline => AdmitResult::Rejected,
      _ => {
        self.deadlines.insert(sub_request_id, now + t_switch);
        AdmitResult::Admitted
      }
    }
  }

  /// Release the in-flight slot once the switch reaches a terminal state
  /// (promoted to Current, or failed with a PUBLISH_DONE status). Idempotent.
  pub fn complete(&mut self, sub_request_id: u64) {
    self.deadlines.remove(&sub_request_id);
  }

  /// Whether a non-expired switch is in flight for this subscription.
  pub fn is_in_flight(&self, sub_request_id: u64, now: Instant) -> bool {
    self
      .deadlines
      .get(&sub_request_id)
      .is_some_and(|&deadline| now < deadline)
  }
}

/// Why a SWITCH could not complete after the Current-Subscribe-Request-ID gate
/// passed. Each variant maps to the draft `PUBLISH_DONE` status reported on the
/// target Track's PUBLISH.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
pub(crate) enum SwitchFailure {
  /// The target Track is unknown / not announced.
  TargetTrackMissing,
  /// No common, gap-free boundary was found within `T_switch`
  /// (`compute_switch_group` -> `NoCommonBoundary`, or the deadline elapsed).
  NoCommonBoundary,
  /// Another SWITCH for the same Current Subscribe Request ID is in flight.
  AlreadyInFlight,
  /// Authorization failed for the target Track.
  Unauthorized,
  /// This relay does not implement the SWITCH message.
  NotSupported,
  /// The subscription being switched from has ended.
  SubscriptionEnded,
}

#[allow(dead_code)] // not yet wired; consumed by the relay's SWITCH handler
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

  #[test]
  fn admits_first_switch() {
    let mut g = SwitchInFlight::new();
    assert_eq!(g.try_admit(1, t0(), T), AdmitResult::Admitted);
  }

  #[test]
  fn rejects_second_switch_within_budget() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Admitted);
    // A second SWITCH for the same subscription, still within T_switch.
    assert_eq!(
      g.try_admit(1, now + Duration::from_millis(500), T),
      AdmitResult::Rejected
    );
  }

  #[test]
  fn readmits_after_deadline_expires() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Admitted);
    // Past the deadline: the prior (stuck) switch is reclaimable.
    assert_eq!(
      g.try_admit(1, now + T + Duration::from_millis(1), T),
      AdmitResult::Admitted
    );
  }

  #[test]
  fn complete_releases_slot_immediately() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Admitted);
    g.complete(1);
    // After completion a fresh switch is admitted even within the old budget.
    assert_eq!(
      g.try_admit(1, now + Duration::from_millis(10), T),
      AdmitResult::Admitted
    );
  }

  #[test]
  fn complete_is_idempotent() {
    let mut g = SwitchInFlight::new();
    g.complete(42); // never admitted; must not panic
    g.complete(42);
  }

  #[test]
  fn distinct_subscriptions_are_independent() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Admitted);
    // A different subscription is unaffected by sub 1's in-flight switch.
    assert_eq!(g.try_admit(2, now, T), AdmitResult::Admitted);
    assert_eq!(g.try_admit(1, now, T), AdmitResult::Rejected);
  }

  #[test]
  fn is_in_flight_reflects_state() {
    let mut g = SwitchInFlight::new();
    let now = t0();
    assert!(!g.is_in_flight(1, now));
    g.try_admit(1, now, T);
    assert!(g.is_in_flight(1, now + Duration::from_millis(100)));
    assert!(!g.is_in_flight(1, now + T + Duration::from_millis(1)));
    g.complete(1);
    assert!(!g.is_in_flight(1, now));
  }

  #[test]
  fn failure_status_code_mapping() {
    use PublishDoneStatusCode as S;
    assert_eq!(SwitchFailure::TargetTrackMissing.status_code(), S::DoesNotExist);
    assert_eq!(SwitchFailure::NoCommonBoundary.status_code(), S::Timeout);
    assert_eq!(SwitchFailure::AlreadyInFlight.status_code(), S::ExcessiveLoad);
    assert_eq!(SwitchFailure::Unauthorized.status_code(), S::Unauthorized);
    assert_eq!(SwitchFailure::NotSupported.status_code(), S::NotSupported);
    assert_eq!(
      SwitchFailure::SubscriptionEnded.status_code(),
      S::SubscriptionEnded
    );
  }
}
