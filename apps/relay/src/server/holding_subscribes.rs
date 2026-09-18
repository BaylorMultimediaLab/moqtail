use moqtail::model::common::location::Location;

/// A SUBSCRIBE that the relay accepted but cannot yet serve because the
/// publisher's live edge has not advanced past `delay_groups`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct PendingSubscribe {
  pub request_id: u64,
  pub delay_groups: u64,
}

/// A holding SUBSCRIBE that has now been resolved: the live edge advanced
/// enough that we can compute a concrete `start_location`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct ResolvedPending {
  pub request_id: u64,
  pub start_location: Location,
}

/// Container for SUBSCRIBEs in the "holding" state. Owned by `Track`.
///
/// The state is intentionally synchronous and self-contained: it operates on
/// a Vec without any locking or async, so unit tests can exercise it without
/// constructing a Track or AppConfig. The Track wraps it in `Arc<RwLock<_>>`
/// for cross-task access.
#[derive(Default, Debug)]
#[allow(dead_code)]
pub(crate) struct HoldingSubscribes {
  inner: Vec<PendingSubscribe>,
}

impl HoldingSubscribes {
  /// Register a SUBSCRIBE that cannot be served yet.
  pub fn register(&mut self, request_id: u64, delay_groups: u64) {
    self.inner.push(PendingSubscribe {
      request_id,
      delay_groups,
    });
  }

  /// Drain all holding subscribes whose `delay_groups <= largest.group` and
  /// return them as `ResolvedPending` records (with `start_location` set to
  /// `Location { group: largest.group - delay_groups, object: 0 }`).
  /// Subscribes that are still too young remain in the holding state.
  pub fn try_resolve(&mut self, largest: Location) -> Vec<ResolvedPending> {
    let mut resolved = Vec::new();
    self.inner.retain(|p| {
      if largest.group >= p.delay_groups {
        resolved.push(ResolvedPending {
          request_id: p.request_id,
          start_location: Location {
            group: largest.group - p.delay_groups,
            object: 0,
          },
        });
        false // remove from holding
      } else {
        true // keep in holding
      }
    });
    resolved
  }

  /// Number of subscribes currently in the holding state. Test/observability only.
  #[cfg(test)]
  pub fn len(&self) -> usize {
    self.inner.len()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn loc(group: u64, object: u64) -> Location {
    Location { group, object }
  }

  #[test]
  fn try_resolve_returns_empty_when_no_holding() {
    let mut holding = HoldingSubscribes::default();
    let resolved = holding.try_resolve(loc(100, 0));
    assert!(resolved.is_empty());
    assert_eq!(holding.len(), 0);
  }

  #[test]
  fn try_resolve_releases_subscribe_when_largest_meets_delay_exactly() {
    // delay=3, advance largest to 3 → target_group = 0, resolved.
    let mut holding = HoldingSubscribes::default();
    holding.register(/* request_id */ 1, /* delay_groups */ 3);
    let resolved = holding.try_resolve(loc(3, 0));
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].request_id, 1);
    assert_eq!(resolved[0].start_location, loc(0, 0));
    assert_eq!(holding.len(), 0); // drained
  }

  #[test]
  fn try_resolve_releases_subscribe_when_largest_exceeds_delay() {
    // delay=3, advance largest to 5 → target_group = 2, resolved.
    let mut holding = HoldingSubscribes::default();
    holding.register(1, 3);
    let resolved = holding.try_resolve(loc(5, 0));
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].start_location, loc(2, 0));
  }

  #[test]
  fn try_resolve_keeps_subscribe_when_largest_below_delay() {
    // delay=5, advance largest to only 2 → still holding.
    let mut holding = HoldingSubscribes::default();
    holding.register(1, 5);
    let resolved = holding.try_resolve(loc(2, 0));
    assert!(resolved.is_empty());
    assert_eq!(holding.len(), 1);
  }

  #[test]
  fn try_resolve_partitions_correctly() {
    // Mix: req 1 (delay=2), req 2 (delay=10), req 3 (delay=4). Largest=5.
    // → req 1 and req 3 resolve; req 2 stays.
    let mut holding = HoldingSubscribes::default();
    holding.register(1, 2);
    holding.register(2, 10);
    holding.register(3, 4);
    let resolved = holding.try_resolve(loc(5, 0));
    assert_eq!(resolved.len(), 2);
    assert_eq!(holding.len(), 1);
    let resolved_ids: Vec<u64> = resolved.iter().map(|r| r.request_id).collect();
    assert!(resolved_ids.contains(&1));
    assert!(resolved_ids.contains(&3));
    // req 1 → start at 5-2=3; req 3 → start at 5-4=1
    let start_for = |id: u64| -> Location {
      resolved
        .iter()
        .find(|r| r.request_id == id)
        .unwrap()
        .start_location
        .clone()
    };
    assert_eq!(start_for(1), loc(3, 0));
    assert_eq!(start_for(3), loc(1, 0));
  }

  #[test]
  fn register_then_resolve_then_register_reuses_capacity() {
    // Sanity: holding can be reused across resolution cycles.
    let mut holding = HoldingSubscribes::default();
    holding.register(1, 2);
    let _ = holding.try_resolve(loc(2, 0));
    holding.register(2, 3);
    assert_eq!(holding.len(), 1);
    let resolved = holding.try_resolve(loc(3, 0));
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].request_id, 2);
    assert_eq!(holding.len(), 0);
  }
}
