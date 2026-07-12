// Copyright 2026 The MOQtail Authors
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

//! End-to-end SWITCH scenarios (moq-transport PR #1378) against a real relay
//! over real QUIC. These cover the seam and race properties that cannot be
//! pinned at unit level because they need an `MOQTClient` (a live wtransport
//! `Connection`):
//!
//! 1. `switch_midgroup_seam_delivers_exactly_once` — a switch landing while
//!    the target's live-edge group is mid-flight must deliver every object of
//!    that group exactly once: the already-cached head via the joining
//!    replay (the AbsoluteStart fix), the tail via live-forward, with no
//!    duplicates (the replay-watermark dedup fix) and the catch-up range
//!    `[G_switch, live_edge)` on a FETCH_HEADER stream.
//!
//! 2. `stale_switch_request_id_is_silently_dropped` — a SWITCH naming a
//!    Request ID whose subscription was terminated (by a prior switch, or by
//!    UNSUBSCRIBE) must produce NO PUBLISH and no state change (the
//!    "Established" gate fix). Per the draft the relay stays silent; the
//!    subscriber's own timeout is its only signal.
//!
//! 3. `unsubscribe_during_drain_yields_subscription_ended_failure` — an
//!    UNSUBSCRIBE for the current subscription landing before the target
//!    PUBLISH opens must abandon the switch and answer with a failure
//!    PUBLISH + PUBLISH_DONE(SUBSCRIPTION_ENDED) (the abandon/mark_published
//!    atomic claim).
//!
//! 4. `concurrent_switch_same_request_id_fails_excessive_load` — a second
//!    SWITCH naming the same Current Subscribe Request ID while the first is
//!    in progress must fail with EXCESSIVE_LOAD while the first completes
//!    untouched (the single-in-flight guard).
//!
//! 5. `switch_waits_for_future_boundary_within_t_switch` — a floor naming a
//!    group the target has not produced yet is held, with the current
//!    subscription still forwarding, until the boundary materializes; TIMEOUT
//!    means "could not identify G_switch within T_switch", not a failed
//!    one-shot selection at receipt.
//!
//! 6. `switch_establishes_upstream_subscription_for_unknown_target` — a
//!    target the relay does not yet carry is not DOES_NOT_EXIST: the relay
//!    establishes an upstream subscription (publisher located via the
//!    announced namespace) and completes the switch once the upstream
//!    delivers, with the PUBLISH carrying the upstream-assigned alias.
//!
//! 7. `switch_across_relay_chain` — a two-relay chain (publisher -> R1 -> R2
//!    -> subscriber, R2 running with --upstream-url): both SUBSCRIBE and
//!    SWITCH name tracks R2 has never seen and are resolved by subscribing to
//!    R1 on demand through the upstream link (the publisher-of-last-resort
//!    fallback).
//!
//! 8. `switch_backfills_history_via_upstream_fetch` — a chained switch whose
//!    target history exists only at the upstream relay: the lazy upstream
//!    subscription live-forwards nothing for a static track, so the relay
//!    issues an upstream FETCH bounded by the upstream-advertised live edge
//!    and serves the catch-up range from the backfilled cache (the SWITCH PR 
//   #1378's "and/or FETCH requests").
//!
//! The harness spawns the relay binary (`CARGO_BIN_EXE_relay`) with a
//! self-signed certificate written to a temp dir, then drives a publisher
//! peer and a subscriber peer built from `moqtail::transport`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use moqtail::model::common::location::Location;
use moqtail::model::common::tuple::{Tuple, TupleField};
use moqtail::model::control::client_setup::ClientSetup;
use moqtail::model::control::constant::{self, GroupOrder, PublishDoneStatusCode};
use moqtail::model::control::control_message::ControlMessage;
use moqtail::model::control::fetch::{Fetch, StandAloneFetchProps};
use moqtail::model::control::publish::Publish;
use moqtail::model::control::publish_namespace::PublishNamespace;
use moqtail::model::control::subscribe::Subscribe;
use moqtail::model::control::subscribe_ok::SubscribeOk;
use moqtail::model::control::switch::Switch;
use moqtail::model::control::unsubscribe::Unsubscribe;
use moqtail::model::data::object::Object;
use moqtail::model::data::subgroup_header::SubgroupHeader;
use moqtail::model::data::subgroup_object::SubgroupObject;
use moqtail::model::parameter::setup_parameter::SetupParameter;
use moqtail::model::parameter::switch_transition::SwitchTransition;
use moqtail::transport::control_stream_handler::ControlStreamHandler;
use moqtail::transport::data_stream_handler::{
  FetchRequest, HeaderInfo, RecvDataStream, SendDataStream,
};
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio::time::{sleep, timeout};
use wtransport::{ClientConfig, Endpoint, Identity};

const NS: &str = "/e2e";
const TRACK_A: &str = "trackA";
const TRACK_B: &str = "trackB";
const ALIAS_A: u64 = 100;
const ALIAS_B: u64 = 200;

// ---------------------------------------------------------------------------
// Relay process guard
// ---------------------------------------------------------------------------

struct RelayGuard {
  child: Child,
  _dir: PathBuf,
}

impl Drop for RelayGuard {
  fn drop(&mut self) {
    let _ = self.child.kill();
    let _ = self.child.wait();
  }
}

/// Writes a self-signed identity to a temp dir and spawns the relay binary on
/// `port`. The relay only loads PEM files from disk, so the harness must
/// materialize them.
async fn spawn_relay(port: u16) -> RelayGuard {
  spawn_relay_inner(port, None).await
}

/// Spawns a relay chained to the relay on `upstream_port`: tracks unknown to
/// this relay are resolved by subscribing upstream on demand.
async fn spawn_chained_relay(port: u16, upstream_port: u16) -> RelayGuard {
  spawn_relay_inner(port, Some(upstream_port)).await
}

async fn spawn_relay_inner(port: u16, upstream_port: Option<u16>) -> RelayGuard {
  let dir = std::env::temp_dir().join(format!("moqtail-e2e-{}-{}", std::process::id(), port));
  std::fs::create_dir_all(&dir).expect("create temp cert dir");

  let identity = Identity::self_signed(["localhost"]).expect("self-signed identity");
  let cert_pem = identity.certificate_chain().as_slice()[0].to_pem();
  let key_pem = identity.private_key().to_secret_pem();
  let cert_path = dir.join("cert.pem");
  let key_path = dir.join("key.pem");
  std::fs::write(&cert_path, cert_pem.as_bytes()).expect("write cert");
  std::fs::write(&key_path, key_pem.as_bytes()).expect("write key");

  let mut cmd = Command::new(env!("CARGO_BIN_EXE_relay"));
  cmd
    .arg("--port")
    .arg(port.to_string())
    .arg("--cert-file")
    .arg(&cert_path)
    .arg("--key-file")
    .arg(&key_path);
  if let Some(up) = upstream_port {
    cmd
      .arg("--upstream-url")
      .arg(format!("https://localhost:{up}"))
      .arg("--upstream-no-cert-validation");
  }
  let child = cmd
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .expect("spawn relay binary");

  RelayGuard { child, _dir: dir }
}

// ---------------------------------------------------------------------------
// MoQ peer (publisher or subscriber)
// ---------------------------------------------------------------------------

struct Peer {
  connection: Arc<wtransport::Connection>,
  control: ControlStreamHandler,
}

impl Peer {
  /// Connects with cert validation disabled, performs the SETUP exchange.
  /// Retries the QUIC connect while the relay is still coming up.
  async fn connect(port: u16) -> Peer {
    let url = format!("https://localhost:{port}");
    let mut last_err = String::new();
    for _ in 0..30 {
      let config = ClientConfig::builder()
        .with_bind_default()
        .with_no_cert_validation()
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .max_idle_timeout(Some(Duration::from_secs(120)))
        .unwrap()
        .build();
      match Endpoint::client(config).unwrap().connect(&url).await {
        Ok(connection) => {
          let connection = Arc::new(connection);
          let (send, recv) = connection
            .open_bi()
            .await
            .expect("open control (pre)")
            .await
            .expect("open control");
          let mut control = ControlStreamHandler::new(send, recv);
          let max_request_id = SetupParameter::new_max_request_id(1_000_000)
            .try_into()
            .unwrap();
          let client_setup = ClientSetup::new(vec![constant::DRAFT_14], vec![max_request_id]);
          control.send_impl(&client_setup).await.expect("send setup");
          match control.next_message().await {
            Ok(ControlMessage::ServerSetup(_)) => return Peer { connection, control },
            other => panic!("expected ServerSetup, got {other:?}"),
          }
        }
        Err(e) => {
          last_err = format!("{e:?}");
          sleep(Duration::from_millis(300)).await;
        }
      }
    }
    panic!("relay did not come up: {last_err}");
  }

  /// Waits (skipping unrelated control traffic such as MAX_REQUEST_ID) until
  /// `pick` returns Some, or panics after `wait`.
  async fn expect<T>(
    &mut self,
    wait: Duration,
    what: &str,
    mut pick: impl FnMut(ControlMessage) -> Option<T>,
  ) -> T {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
      let remaining = deadline
        .checked_duration_since(tokio::time::Instant::now())
        .unwrap_or_else(|| panic!("timed out waiting for {what}"));
      let msg = timeout(remaining, self.control.next_message())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
        .unwrap_or_else(|e| panic!("control stream error waiting for {what}: {e:?}"));
      if let Some(t) = pick(msg) {
        return t;
      }
    }
  }

  /// Asserts that no PUBLISH arrives on the control stream within `window`.
  /// This is the draft's contract for a non-Established Current Subscribe
  /// Request ID: the relay MUST NOT open a PUBLISH and MUST NOT modify state
  /// — silence, not an error message.
  async fn assert_no_publish_within(&mut self, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
      let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now()) else {
        return; // window elapsed with no PUBLISH: pass
      };
      match timeout(remaining, self.control.next_message()).await {
        Err(_) => return, // no traffic at all: pass
        Ok(Ok(ControlMessage::Publish(p))) => {
          panic!("stale SWITCH must be silently dropped, but relay opened PUBLISH {p:?}")
        }
        Ok(Ok(_)) => continue, // unrelated traffic is fine
        Ok(Err(e)) => panic!("control stream error during silence window: {e:?}"),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Publisher helpers
// ---------------------------------------------------------------------------

async fn publish_track(peer: &mut Peer, track_name: &str, alias: u64) {
  let publish = Publish::new(
    alias, // request_id (publisher-chosen, mirrors apps/publisher)
    Tuple::from_utf8_path(NS),
    TupleField::from_utf8(track_name),
    alias,
    GroupOrder::Ascending,
    1, // content_exists
    Some(Location::new(0, 0)),
    1, // forward
    vec![],
  );
  peer
    .control
    .send(&ControlMessage::Publish(Box::new(publish)))
    .await
    .expect("send PUBLISH");
  peer
    .expect(Duration::from_secs(5), "PublishOk", |m| match m {
      ControlMessage::PublishOk(ok) => Some(ok),
      _ => None,
    })
    .await;
}

/// Opens one subgroup stream for `group_id` (subgroup 0) and returns it so
/// callers can keep a group mid-flight across a SWITCH.
async fn open_group_stream(
  connection: &Arc<wtransport::Connection>,
  alias: u64,
  group_id: u64,
) -> SendDataStream {
  let stream = connection
    .open_uni()
    .await
    .expect("open uni (pre)")
    .await
    .expect("open uni");
  let header = SubgroupHeader::new_with_explicit_id(alias, group_id, 0, 128, false, true);
  SendDataStream::new(Arc::new(Mutex::new(stream)), HeaderInfo::Subgroup { header })
    .await
    .expect("subgroup stream")
}

/// Sends `object_ids` on an open subgroup stream. `previous` is the id of the
/// last object already written on this stream (`None` on a fresh stream): the
/// subgroup codec delta-encodes every object after the stream's first against
/// its predecessor, so continuation writes on a still-open stream must thread
/// it or the receiver decodes inflated ids (0,1,2 sent absolute parse as
/// 0,2,5).
async fn send_objects(
  stream: &mut SendDataStream,
  alias: u64,
  group_id: u64,
  object_ids: std::ops::RangeInclusive<u64>,
  mut previous: Option<u64>,
) {
  for object_id in object_ids {
    let sub_obj = SubgroupObject {
      object_id,
      extension_headers: None,
      object_status: None,
      payload: Some(Bytes::from(format!("g{group_id}o{object_id}"))),
    };
    let object = Object::try_from_subgroup(sub_obj, alias, group_id, Some(0), 128)
      .expect("build object");
    stream
      .send_object(&object, previous)
      .await
      .expect("send object");
    previous = Some(object_id);
  }
  stream.flush().await.expect("flush");
}

/// Publishes complete groups `groups` x objects `objects` and finishes each
/// group's stream.
async fn publish_complete_groups(
  connection: &Arc<wtransport::Connection>,
  alias: u64,
  groups: std::ops::RangeInclusive<u64>,
  objects: std::ops::RangeInclusive<u64>,
) {
  for group_id in groups {
    let mut stream = open_group_stream(connection, alias, group_id).await;
    send_objects(&mut stream, alias, group_id, objects.clone(), None).await;
    stream.finish().await.expect("finish group stream");
  }
}

// ---------------------------------------------------------------------------
// Subscriber data plane: accept uni streams, drain objects into a channel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Via {
  Catchup, // FETCH_HEADER stream (switch catch-up)
  Subgroup { alias: u64 },
}

/// Spawns an accept loop that drains every incoming unidirectional stream and
/// forwards `(via, group, object)` triples. FETCH_HEADER parsing requires a
/// registered `FetchRequest` for its request id; the relay allocates the
/// switch-PUBLISH request id, unknown ahead of time, so the harness
/// pre-registers a synthetic entry for every small id (mirrors the TS
/// client's route registration; ids come from the session's request-id space
/// and stay tiny in these scenarios).
fn spawn_data_plane(
  connection: Arc<wtransport::Connection>,
) -> mpsc::UnboundedReceiver<(Via, u64, u64)> {
  let (tx, rx) = mpsc::unbounded_channel();
  let pending: Arc<RwLock<BTreeMap<u64, FetchRequest>>> = Arc::new(RwLock::new(BTreeMap::new()));

  let pending_init = pending.clone();
  tokio::spawn(async move {
    let mut map = pending_init.write().await;
    for request_id in 0..=255u64 {
      let fetch = Fetch::new_standalone(
        request_id,
        0,
        GroupOrder::Ascending,
        StandAloneFetchProps {
          track_namespace: Tuple::from_utf8_path(NS),
          track_name: TupleField::from_utf8(TRACK_B),
          start_location: Location::new(0, 0),
          end_location: Location::new(u64::MAX, 0),
        },
        vec![],
      );
      map.insert(request_id, FetchRequest::new(request_id, 0, fetch, ALIAS_B));
    }
  });

  tokio::spawn(async move {
    loop {
      let Ok(stream) = connection.accept_uni().await else {
        return; // connection closed
      };
      let tx = tx.clone();
      let pending = pending.clone();
      tokio::spawn(async move {
        let handler = RecvDataStream::new(stream, pending);
        loop {
          let (h, obj) = handler.next_object().await;
          match obj {
            Some(object) => {
              let via = match h.get_header_info().await {
                Some(HeaderInfo::Fetch { .. }) => Via::Catchup,
                Some(HeaderInfo::Subgroup { header }) => Via::Subgroup {
                  alias: header.track_alias,
                },
                None => continue,
              };
              let _ = tx.send((via, object.location.group, object.location.object));
            }
            None => return, // stream finished or errored
          }
        }
      });
    }
  });

  rx
}

/// Collects everything the data plane yields until it stays quiet for
/// `quiet`, then returns the multiset of (via, group, object).
async fn collect_until_quiet(
  rx: &mut mpsc::UnboundedReceiver<(Via, u64, u64)>,
  quiet: Duration,
) -> HashMap<(Via, u64, u64), u32> {
  let mut seen: HashMap<(Via, u64, u64), u32> = HashMap::new();
  while let Ok(Some(item)) = timeout(quiet, rx.recv()).await {
    *seen.entry(item).or_insert(0) += 1;
  }
  seen
}

// ---------------------------------------------------------------------------
// Scenario 1: mid-group seam, exactly-once
// ---------------------------------------------------------------------------

#[tokio::test]
async fn switch_midgroup_seam_delivers_exactly_once() {
  let port = 44871;
  let _relay = spawn_relay(port).await;

  // Publisher: tracks A and B, complete groups 0..=3 (objects 0..=4) on both.
  let mut publisher = Peer::connect(port).await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_track(&mut publisher, TRACK_B, ALIAS_B).await;
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=3, 0..=4).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=3, 0..=4).await;

  // B's group 4 goes mid-flight: head 0..=2 cached at the relay, stream open.
  let mut b_group4 = open_group_stream(&publisher.connection, ALIAS_B, 4).await;
  send_objects(&mut b_group4, ALIAS_B, 4, 0..=2, None).await;
  sleep(Duration::from_millis(500)).await; // let the relay cache the head

  // Subscriber: subscribe A (request id 1), then SWITCH to B mid-group.
  let mut subscriber = Peer::connect(port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());
  let sub = Subscribe::new_latest_object(
    1,
    Tuple::from_utf8_path(NS),
    TupleField::from_utf8(TRACK_A),
    0,
    GroupOrder::Ascending,
    true,
    vec![],
  );
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(sub)))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk", |m| match m {
      ControlMessage::SubscribeOk(ok) => Some(ok),
      _ => None,
    })
    .await;

  let switch = Switch::new(
    1, // current subscribe request id
    Tuple::from_utf8_path(NS),
    TupleField::from_utf8(TRACK_B),
    0, // minimum switching group id: both tracks share all boundaries -> G_switch = 0
    vec![],
  );
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch)))
    .await
    .expect("send SWITCH");

  // The relay must answer with a PUBLISH carrying SWITCH_TRANSITION.
  let publish = subscriber
    .expect(Duration::from_secs(5), "switch PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("PUBLISH opened for a SWITCH must carry SWITCH_TRANSITION");
  assert_eq!(transition.switching_group_id, 0, "shared boundaries + min 0");
  assert_eq!(
    transition.live_edge_group_id, 4,
    "live edge at PUBLISH-open is B's mid-flight group"
  );

  // The old subscription must be terminated with PUBLISH_DONE for request 1.
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Now the tail of B's group 4 arrives (live path), then a post-edge group.
  // Continuation on the still-open group-4 stream: delta-encode against the
  // last object already written (id 2).
  send_objects(&mut b_group4, ALIAS_B, 4, 3..=5, Some(2)).await;
  b_group4.finish().await.expect("finish B group 4");
  publish_complete_groups(&publisher.connection, ALIAS_B, 5..=5, 0..=1).await;

  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;
  let b_alias = publish.track_alias;

  // (a) Catch-up = exactly [G_switch, live_edge) = groups 0..=3, objects 0..=4.
  for group in 0..=3u64 {
    for object in 0..=4u64 {
      assert_eq!(
        seen.get(&(Via::Catchup, group, object)),
        Some(&1),
        "catch-up must deliver ({group},{object}) exactly once"
      );
    }
  }
  assert!(
    !seen.keys().any(|(via, group, _)| *via == Via::Catchup && *group >= 4),
    "catch-up must stop below the live edge"
  );

  // (b) THE seam pin: the live-edge group's already-cached head (4,0..=2)
  // must arrive on SUBGROUP streams — this is what the AbsoluteStart +
  // joining-replay fix guarantees and what LatestObject silently dropped —
  // and exactly once, which is what the replay-watermark dedup guarantees
  // for objects racing the replay snapshot.
  for object in 0..=5u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: b_alias }, 4, object)),
      Some(&1),
      "live-edge group object (4,{object}) must be delivered exactly once"
    );
  }

  // (c) Post-edge live objects flow normally.
  for object in 0..=1u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: b_alias }, 5, object)),
      Some(&1),
      "post-edge object (5,{object}) must be delivered exactly once"
    );
  }

  // (d) Global exactly-once on the target track: no (group, object) may be
  // duplicated across catch-up and live delivery.
  for ((via, group, object), count) in &seen {
    if matches!(via, Via::Subgroup { alias } if *alias == b_alias) || *via == Via::Catchup {
      assert_eq!(*count, 1, "duplicate delivery of {via:?} ({group},{object})");
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: stale Established gate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stale_switch_request_id_is_silently_dropped() {
  let port = 44873;
  let _relay = spawn_relay(port).await;

  let mut publisher = Peer::connect(port).await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_track(&mut publisher, TRACK_B, ALIAS_B).await;
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=1, 0..=2).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=1, 0..=2).await;

  let mut subscriber = Peer::connect(port).await;
  let mut _data = spawn_data_plane(subscriber.connection.clone());

  let subscribe = |request_id: u64, track: &str| {
    Subscribe::new_latest_object(
      request_id,
      Tuple::from_utf8_path(NS),
      TupleField::from_utf8(track),
      0,
      GroupOrder::Ascending,
      true,
      vec![],
    )
  };
  let switch_to = |current: u64, track: &str| {
    Switch::new(
      current,
      Tuple::from_utf8_path(NS),
      TupleField::from_utf8(track),
      0,
      vec![],
    )
  };

  // Phase 1: SUBSCRIBE A (id 1), successful SWITCH to B terminates id 1.
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe(1, TRACK_A))))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(1)", |m| match m {
      ControlMessage::SubscribeOk(ok) => Some(ok),
      _ => None,
    })
    .await;
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_to(1, TRACK_B))))
    .await
    .expect("send SWITCH");
  subscriber
    .expect(Duration::from_secs(5), "switch PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Phase 2: id 1 is now terminated. A SWITCH naming it must be silently
  // dropped — no PUBLISH, no failure PUBLISH, no state change. Before the
  // gate fix the leftover subscribe_requests entry let this drive a switch
  // off a dead subscription.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_to(1, TRACK_A))))
    .await
    .expect("send stale SWITCH");
  subscriber.assert_no_publish_within(Duration::from_secs(4)).await;

  // Phase 3: same contract for an UNSUBSCRIBE'd id. SUBSCRIBE A again
  // (id 5), UNSUBSCRIBE it, then SWITCH naming id 5.
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe(5, TRACK_A))))
    .await
    .expect("send SUBSCRIBE(5)");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(5)", |m| match m {
      ControlMessage::SubscribeOk(ok) => Some(ok),
      _ => None,
    })
    .await;
  subscriber
    .control
    .send(&ControlMessage::Unsubscribe(Box::new(Unsubscribe::new(5))))
    .await
    .expect("send UNSUBSCRIBE(5)");
  sleep(Duration::from_millis(500)).await; // let the relay tear down id 5
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_to(5, TRACK_B))))
    .await
    .expect("send SWITCH on unsubscribed id");
  subscriber.assert_no_publish_within(Duration::from_secs(4)).await;
}

// ---------------------------------------------------------------------------
// Held-drain scenarios: race a second control message into an in-flight switch
// ---------------------------------------------------------------------------

fn subscribe_msg(request_id: u64, track: &str) -> Subscribe {
  Subscribe::new_latest_object(
    request_id,
    Tuple::from_utf8_path(NS),
    TupleField::from_utf8(track),
    0,
    GroupOrder::Ascending,
    true,
    vec![],
  )
}

fn switch_msg(current: u64, track: &str, minimum_switching_group_id: u64) -> Switch {
  Switch::new(
    current,
    Tuple::from_utf8_path(NS),
    TupleField::from_utf8(track),
    minimum_switching_group_id,
    vec![],
  )
}

/// Spawns the relay, publishes A and B (groups 0..=2, objects 0..=2, all
/// complete), and subscribes A (request id 1, LatestObject) — then publishes
/// NOTHING further on A. That holds any subsequent SWITCH with
/// `minimum_switching_group_id = 1` in its drain phase deterministically:
/// G_switch resolves to 1 (both tracks share every boundary), but the drain
/// completes only once the source has forwarded SOMETHING (`last_sent.group
/// + 1 >= 1`), and a LatestObject subscription with no live traffic has
/// forwarded nothing. The drain polls every 50ms up to T_switch = 3s — a
/// wide-open, deterministic window to race a second control message into.
async fn setup_held_drain(port: u16) -> (RelayGuard, Peer, Peer) {
  let relay = spawn_relay(port).await;

  let mut publisher = Peer::connect(port).await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_track(&mut publisher, TRACK_B, ALIAS_B).await;
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=2, 0..=2).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=2, 0..=2).await;
  sleep(Duration::from_millis(300)).await; // let the relay cache both tracks

  let mut subscriber = Peer::connect(port).await;
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe_msg(1, TRACK_A))))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(1)", |m| match m {
      ControlMessage::SubscribeOk(ok) => Some(ok),
      _ => None,
    })
    .await;

  (relay, publisher, subscriber)
}

/// SWITCH PR #1378: "If the subscriber sends an UNSUBSCRIBE for the current
/// subscription before the Relay has opened the PUBLISH for the target Track,
/// the Relay MUST abandon the SWITCH and MUST open a PUBLISH for the target
/// Track and immediately send PUBLISH_DONE with Status Code
/// SUBSCRIPTION_ENDED."
///
/// This is also the regression pin for the guard's atomic claim:
/// `abandon()` (unsubscribe handler) and `mark_published()` (switch task) are
/// serialized on one mutex, so exactly one side wins — the drain polls
/// `is_abandoned` every 50ms and exits without touching the source.
#[tokio::test]
async fn unsubscribe_during_drain_yields_subscription_ended_failure() {
  let port = 44875;
  let (_relay, _publisher, mut subscriber) = setup_held_drain(port).await;

  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 1))))
    .await
    .expect("send SWITCH");
  // The switch task is now polling its drain (no A object has ever been
  // forwarded). Land the UNSUBSCRIBE inside that window.
  sleep(Duration::from_millis(200)).await;
  subscriber
    .control
    .send(&ControlMessage::Unsubscribe(Box::new(Unsubscribe::new(1))))
    .await
    .expect("send UNSUBSCRIBE mid-drain");

  // The failure signature is a PUBLISH for the target with no content,
  // immediately followed by PUBLISH_DONE(SUBSCRIPTION_ENDED) on the SAME
  // relay-allocated request id.
  let publish = subscriber
    .expect(Duration::from_secs(5), "abandon failure PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(
    publish.content_exists, 0,
    "abandon must be reported as a failure PUBLISH (no content follows)"
  );
  let failure_rid = publish.request_id;
  let done = subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE for the failure", |m| {
      match m {
        ControlMessage::PublishDone(d) if d.request_id == failure_rid => Some(d),
        _ => None,
      }
    })
    .await;
  assert_eq!(
    done.status_code,
    PublishDoneStatusCode::SubscriptionEnded,
    "UNSUBSCRIBE-before-PUBLISH must resolve as SUBSCRIPTION_ENDED"
  );

  // Request id 1 is unsubscribed: a later SWITCH naming it must be silently
  // dropped by the Established gate (which runs BEFORE the in-flight guard,
  // so a lingering abandoned guard entry cannot turn this into a second
  // failure PUBLISH).
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 1))))
    .await
    .expect("send SWITCH on unsubscribed id");
  subscriber.assert_no_publish_within(Duration::from_secs(4)).await;
}

/// SWITCH PR #1378: "If the Relay receives a SWITCH message for a subscription
/// for which a previous SWITCH operation is still in progress, the Relay MUST
/// treat the new SWITCH as a failure with status EXCESSIVE_LOAD" — the
/// failure answers the SECOND switch while the first proceeds untouched.
///
/// This also pins the window the teardown reorder deliberately does
/// NOT cover: a client reacting to the switch PUBLISH (rather than
/// PUBLISH_DONE) with another SWITCH on the same id lands while the guard
/// entry is live, and EXCESSIVE_LOAD — not a second switch — is the mandated
/// outcome. try_admit runs synchronously in the handler before the drain task
/// is spawned, so control-stream ordering makes this deterministic with no
/// sleeps.
#[tokio::test]
async fn concurrent_switch_same_request_id_fails_excessive_load() {
  let port = 44877;
  let (_relay, publisher, mut subscriber) = setup_held_drain(port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());

  // Two SWITCHes back-to-back on the same Current Subscribe Request ID. The
  // first is admitted and parks in its drain; the second must be rejected.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 1))))
    .await
    .expect("send first SWITCH");
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 1))))
    .await
    .expect("send concurrent SWITCH");

  let failure = subscriber
    .expect(Duration::from_secs(5), "EXCESSIVE_LOAD failure PUBLISH", |m| {
      match m {
        ControlMessage::Publish(p) => Some(p),
        _ => None,
      }
    })
    .await;
  assert_eq!(
    failure.content_exists, 0,
    "the concurrent SWITCH must fail; the first PUBLISH on the wire is its failure"
  );
  let failure_rid = failure.request_id;
  let done = subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(EXCESSIVE_LOAD)", |m| {
      match m {
        ControlMessage::PublishDone(d) if d.request_id == failure_rid => Some(d),
        _ => None,
      }
    })
    .await;
  assert_eq!(done.status_code, PublishDoneStatusCode::ExcessiveLoad);

  // Release the FIRST switch's drain: one live A object makes
  // last_sent = (3, 0), and 3 + 1 >= G_switch(=1).
  publish_complete_groups(&publisher.connection, ALIAS_A, 3..=3, 0..=0).await;

  // The first switch must complete untouched by the rejection: a success
  // PUBLISH with the real seam, then PUBLISH_DONE terminating request 1.
  let publish = subscriber
    .expect(Duration::from_secs(5), "success PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(publish.content_exists, 1, "first switch must succeed");
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("success PUBLISH must carry SWITCH_TRANSITION");
  assert_eq!(transition.switching_group_id, 1, "common boundary at min");
  assert_eq!(transition.live_edge_group_id, 2, "B's live edge is untouched");
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Catch-up delivers exactly [G_switch, live_edge) = group 1, once each —
  // proving the rejected SWITCH neither disturbed the seam nor doubled
  // delivery.
  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Catchup, 1, object)),
      Some(&1),
      "catch-up must deliver (1,{object}) exactly once"
    );
  }
  assert!(
    !seen
      .keys()
      .any(|(via, group, _)| *via == Via::Catchup && *group != 1),
    "catch-up must cover exactly [1, 2)"
  );

  // And live coverage from the live edge: the live sub attaches at
  // (max(G_switch, live_edge), 0) = (2, 0) with the joining replay, so B's
  // cached group 2 must arrive on SUBGROUP streams exactly once each even
  // though B publishes nothing after the switch.
  let b_alias = publish.track_alias;
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: b_alias }, 2, object)),
      Some(&1),
      "live-edge group object (2,{object}) must be replayed exactly once"
    );
  }
}

/// SWITCH PR #1378 frames T_switch as the window the relay has to IDENTIFY
/// G_switch — TIMEOUT means "could not identify G_switch within T_switch",
/// not "no boundary existed at SWITCH receipt". A floor naming a group the
/// target has not produced yet (a subscriber at the live edge switching at
/// its next boundary) must be held, with the current subscription still
/// forwarding, until the boundary materializes — not failed on a one-shot
/// selection.
///
/// This also pins the client contract that lets the JS player send
/// `latestGroup + 1` as its naive floor without racing a spurious TIMEOUT.
#[tokio::test]
async fn switch_waits_for_future_boundary_within_t_switch() {
  let port = 44879;
  let (_relay, publisher, mut subscriber) = setup_held_drain(port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());

  // Both tracks hold groups 0..=2; ask to switch no earlier than group 3,
  // which does not exist anywhere yet.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 3))))
    .await
    .expect("send SWITCH with future floor");

  // One-shot selection would fail here instantly. The polling relay must
  // stay silent while it waits for the boundary (well inside T_switch = 3s).
  subscriber
    .assert_no_publish_within(Duration::from_secs(1))
    .await;

  // The boundary materializes on BOTH tracks. Group 3 on the source also
  // releases the drain: its objects forward to the still-live subscription,
  // pushing last_sent past the seam.
  publish_complete_groups(&publisher.connection, ALIAS_B, 3..=3, 0..=2).await;
  publish_complete_groups(&publisher.connection, ALIAS_A, 3..=3, 0..=2).await;

  // The switch must now complete: success PUBLISH with the seam at group 3,
  // whose live edge is that same just-started group (no catch-up range).
  let publish = subscriber
    .expect(Duration::from_secs(5), "success PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(
    publish.content_exists, 1,
    "the held switch must succeed once the boundary exists"
  );
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("success PUBLISH must carry SWITCH_TRANSITION");
  assert_eq!(transition.switching_group_id, 3, "seam at the awaited boundary");
  assert_eq!(
    transition.live_edge_group_id, 3,
    "live edge at PUBLISH-open is the just-started group"
  );
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Seam accounting: G_switch == live edge, so there is NO catch-up stream;
  // the live subscription attaches at (3, 0) and the joining replay delivers
  // the target's group 3 on SUBGROUP streams exactly once each.
  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;
  let b_alias = publish.track_alias;
  assert!(
    !seen.keys().any(|(via, _, _)| *via == Via::Catchup),
    "no catch-up range when G_switch == live edge"
  );
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: b_alias }, 3, object)),
      Some(&1),
      "awaited-boundary group object (3,{object}) must arrive exactly once"
    );
  }
}

/// SWITCH PR #1378: the relay is responsible for "establishing or selecting any
/// upstream subscriptions and/or FETCH requests needed to satisfy the switch".
/// A SWITCH naming a target the relay does not yet carry must NOT fail with
/// DOES_NOT_EXIST (reserved for "not available at the publisher"): the relay
/// locates the publisher via the announced namespace, forwards an upstream
/// SUBSCRIBE, and completes the switch once the upstream delivers.
#[tokio::test]
async fn switch_establishes_upstream_subscription_for_unknown_target() {
  let port = 44881;
  let _relay = spawn_relay(port).await;

  // Publisher announces the namespace and pushes ONLY track A. Track B is
  // never published — the relay has no track entry for it, but the announced
  // namespace marks this publisher as able to supply it on request.
  let mut publisher = Peer::connect(port).await;
  publisher
    .control
    .send(&ControlMessage::PublishNamespace(Box::new(
      PublishNamespace::new(7, Tuple::from_utf8_path(NS), &[]),
    )))
    .await
    .expect("send PUBLISH_NAMESPACE");
  publisher
    .expect(Duration::from_secs(5), "PublishNamespaceOk", |m| match m {
      ControlMessage::PublishNamespaceOk(ok) => Some(ok),
      _ => None,
    })
    .await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=2, 0..=2).await;
  sleep(Duration::from_millis(300)).await;

  let mut subscriber = Peer::connect(port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe_msg(1, TRACK_A))))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(1)", |m| match m {
      ControlMessage::SubscribeOk(ok) => Some(ok),
      _ => None,
    })
    .await;

  // SWITCH to the unknown track B. min = 0: any boundary is acceptable.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 0))))
    .await
    .expect("send SWITCH to unknown target");

  // The relay must reach upstream: expect its SUBSCRIBE for track B, confirm
  // it, and start supplying the track.
  let upstream = publisher
    .expect(Duration::from_secs(5), "relay upstream SUBSCRIBE for B", |m| {
      match m {
        ControlMessage::Subscribe(s)
          if s.track_name == TupleField::from_utf8(TRACK_B) =>
        {
          Some(s)
        }
        _ => None,
      }
    })
    .await;
  publisher
    .control
    .send(&ControlMessage::SubscribeOk(Box::new(
      SubscribeOk::new_ascending_with_content(
        upstream.request_id,
        ALIAS_B,
        0,
        Some(Location::new(0, 0)),
        None,
      ),
    )))
    .await
    .expect("send upstream SubscribeOk");
  // Let the relay register the alias route before data lands on it. Publish a
  // SINGLE group: selection fires on the earliest viable seam, so a
  // multi-group publication would race it (the switch could open with live
  // edge 0, 1, or 2). One group pins the seam deterministically at {0, 0}.
  sleep(Duration::from_millis(300)).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=0, 0..=2).await;

  // The switch must complete against the freshly established upstream: the
  // seam is the only common boundary (group 0), which is also B's live edge —
  // no catch-up range, pure joining replay on the live subscription.
  let publish = subscriber
    .expect(Duration::from_secs(5), "success PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(
    publish.content_exists, 1,
    "switch against an establishable upstream must succeed, not DOES_NOT_EXIST"
  );
  assert_eq!(
    publish.track_alias, ALIAS_B,
    "PUBLISH must carry the upstream-assigned alias, not the Pending placeholder"
  );
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("success PUBLISH must carry SWITCH_TRANSITION");
  assert_eq!(transition.switching_group_id, 0, "the only common boundary");
  assert_eq!(
    transition.live_edge_group_id, 0,
    "target live edge at PUBLISH-open is the single published group"
  );
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Seam accounting over the established upstream: G_switch == live edge, so
  // no catch-up stream; the live subscription's joining replay delivers B's
  // group 0 exactly once each via SUBGROUP.
  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;
  assert!(
    !seen.keys().any(|(via, _, _)| *via == Via::Catchup),
    "no catch-up range when G_switch == live edge"
  );
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: ALIAS_B }, 0, object)),
      Some(&1),
      "established-upstream group object (0,{object}) must arrive exactly once"
    );
  }
}

/// Relay chaining: a two-relay chain (publisher -> R1 -> R2 -> subscriber)
/// where R2 runs with `--upstream-url` pointing at R1. Both the plain
/// SUBSCRIBE and the SWITCH name tracks R2 has never seen; R2 must resolve
/// them by subscribing to R1 on demand (the publisher-of-last-resort
/// fallback) — R1's SubscribeOk confirms R2's Pending track with the
/// publisher-assigned alias and data then flows through the chain.
#[tokio::test]
async fn switch_across_relay_chain() {
  let r1_port = 44883;
  let r2_port = 44885;
  let _r1 = spawn_relay(r1_port).await;

  // Publisher at R1: both tracks registered (PUBLISH), no data yet.
  let mut publisher = Peer::connect(r1_port).await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_track(&mut publisher, TRACK_B, ALIAS_B).await;

  // R2 comes up chained to R1 (R1 is provably up: the publisher connected).
  let _r2 = spawn_chained_relay(r2_port, r1_port).await;

  // Subscriber at R2. Give the R2->R1 upstream link a beat to establish —
  // the fallback returns nothing while the dial is still in flight.
  let mut subscriber = Peer::connect(r2_port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());
  sleep(Duration::from_millis(500)).await;

  // SUBSCRIBE A at R2: unknown there -> resolved through the chain.
  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe_msg(1, TRACK_A))))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(1) across the chain", |m| {
      match m {
        ControlMessage::SubscribeOk(ok) => Some(ok),
        _ => None,
      }
    })
    .await;

  // Live A data flows publisher -> R1 -> R2 -> subscriber.
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=1, 0..=2).await;
  sleep(Duration::from_millis(500)).await; // let delivery settle through both hops

  // SWITCH to B at R2: also unknown there -> R2 establishes the upstream
  // subscription for B on demand, then completes the switch once B's data
  // arrives. A single B group keeps the seam deterministic at {0, 0}.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 0))))
    .await
    .expect("send SWITCH across the chain");
  // Let the R2->R1 SUBSCRIBE(B) handshake land before B's only group is
  // published: R1 forwards live objects only to already-registered
  // subscriptions, so publishing before the handshake would strand the group
  // at R1 and time the selection out. (Well inside T_switch = 3s.)
  sleep(Duration::from_millis(700)).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=0, 0..=2).await;

  let publish = subscriber
    .expect(Duration::from_secs(5), "success PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(publish.content_exists, 1, "chained switch must succeed");
  assert_eq!(
    publish.track_alias, ALIAS_B,
    "PUBLISH must carry the alias confirmed by the upstream relay"
  );
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("success PUBLISH must carry SWITCH_TRANSITION");
  assert_eq!(transition.switching_group_id, 0, "common boundary at group 0");
  assert_eq!(
    transition.live_edge_group_id, 0,
    "B's live edge at R2 is the single published group"
  );
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  // Chained delivery accounting: A's live groups arrived exactly once each
  // pre-switch; B's group 0 arrives exactly once each via the joining replay
  // (G_switch == live edge, so there is no catch-up stream anywhere).
  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;
  for group in 0..=1u64 {
    for object in 0..=2u64 {
      assert_eq!(
        seen.get(&(Via::Subgroup { alias: ALIAS_A }, group, object)),
        Some(&1),
        "chained A object ({group},{object}) must arrive exactly once"
      );
    }
  }
  assert!(
    !seen.keys().any(|(via, _, _)| *via == Via::Catchup),
    "no catch-up range when G_switch == live edge"
  );
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: ALIAS_B }, 0, object)),
      Some(&1),
      "chained B object (0,{object}) must arrive exactly once"
    );
  }
}

/// Relay chaining, SWITCH PR #1378 "and/or FETCH requests": the switch target's
/// history exists ONLY at the upstream relay — B is fully published at R1
/// before R2 ever hears of it, and nothing is published after the SWITCH. The
/// lazy upstream subscription live-forwards nothing for a static track, so
/// the catch-up range can only come from R2's upstream FETCH backfill
/// (bounded by the upstream-advertised live edge seeded at confirmation).
#[tokio::test]
async fn switch_backfills_history_via_upstream_fetch() {
  let r1_port = 44887;
  let r2_port = 44889;
  let _r1 = spawn_relay(r1_port).await;

  // Publisher at R1: A registered (data later, live); B fully published NOW —
  // its three groups are history R2 will never see via live-forwarding.
  let mut publisher = Peer::connect(r1_port).await;
  publish_track(&mut publisher, TRACK_A, ALIAS_A).await;
  publish_track(&mut publisher, TRACK_B, ALIAS_B).await;
  publish_complete_groups(&publisher.connection, ALIAS_B, 0..=2, 0..=2).await;

  let _r2 = spawn_chained_relay(r2_port, r1_port).await;

  let mut subscriber = Peer::connect(r2_port).await;
  let mut data = spawn_data_plane(subscriber.connection.clone());
  sleep(Duration::from_millis(500)).await; // upstream link settle

  subscriber
    .control
    .send(&ControlMessage::Subscribe(Box::new(subscribe_msg(1, TRACK_A))))
    .await
    .expect("send SUBSCRIBE");
  subscriber
    .expect(Duration::from_secs(5), "SubscribeOk(1) across the chain", |m| {
      match m {
        ControlMessage::SubscribeOk(ok) => Some(ok),
        _ => None,
      }
    })
    .await;

  // A flows live through both hops so the seam has a common boundary at R2.
  publish_complete_groups(&publisher.connection, ALIAS_A, 0..=2, 0..=2).await;
  sleep(Duration::from_millis(500)).await;

  // SWITCH to B with floor 0. Everything below B's live edge must be
  // backfilled: the publisher sends NOTHING from here on.
  subscriber
    .control
    .send(&ControlMessage::Switch(Box::new(switch_msg(1, TRACK_B, 0))))
    .await
    .expect("send SWITCH");

  let publish = subscriber
    .expect(Duration::from_secs(5), "success PUBLISH", |m| match m {
      ControlMessage::Publish(p) => Some(p),
      _ => None,
    })
    .await;
  assert_eq!(
    publish.content_exists, 1,
    "backfilled chained switch must succeed"
  );
  assert_eq!(publish.track_alias, ALIAS_B, "upstream-confirmed alias");
  let transition = SwitchTransition::from_parameters(&publish.parameters)
    .expect("success PUBLISH must carry SWITCH_TRANSITION");
  assert_eq!(
    transition.switching_group_id, 0,
    "the floor is honored: backfill supplies the history below the edge"
  );
  assert_eq!(
    transition.live_edge_group_id, 2,
    "live edge = the upstream-advertised largest seeded at confirmation"
  );
  subscriber
    .expect(Duration::from_secs(5), "PUBLISH_DONE(1)", |m| match m {
      ControlMessage::PublishDone(d) if d.request_id == 1 => Some(()),
      _ => None,
    })
    .await;

  let seen = collect_until_quiet(&mut data, Duration::from_secs(3)).await;

  // Pre-switch A delivery (live through the chain), exactly once each.
  for group in 0..=2u64 {
    for object in 0..=2u64 {
      assert_eq!(
        seen.get(&(Via::Subgroup { alias: ALIAS_A }, group, object)),
        Some(&1),
        "chained A object ({group},{object}) must arrive exactly once"
      );
    }
  }
  // The catch-up range [0, 2) — pure backfill product — exactly once each.
  for group in 0..=1u64 {
    for object in 0..=2u64 {
      assert_eq!(
        seen.get(&(Via::Catchup, group, object)),
        Some(&1),
        "backfilled catch-up ({group},{object}) must arrive exactly once"
      );
    }
  }
  assert!(
    !seen
      .keys()
      .any(|(via, group, _)| *via == Via::Catchup && *group >= 2),
    "catch-up must stop below the live edge"
  );
  // The live-edge group, replayed from the backfilled cache, exactly once each.
  for object in 0..=2u64 {
    assert_eq!(
      seen.get(&(Via::Subgroup { alias: ALIAS_B }, 2, object)),
      Some(&1),
      "live-edge group object (2,{object}) must arrive exactly once"
    );
  }
}
