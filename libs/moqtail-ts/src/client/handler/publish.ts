/**
 * Copyright 2025 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Publish } from '../../model/control'
import { ControlMessageHandler } from './handler'
import { MoqtObject } from '../../model/data'
import { SwitchTransition } from '../../model/parameter/switch_transition'
import { ProtocolViolationError } from '../../model/error/error'

/**
 * Delay before unsubscribing a PUBLISH that answered an already-timed-out
 * SWITCH (see the tombstone branch in {@link handlerPublish}). Must exceed
 * MOQtailClient.DATA_ROUTE_WAIT_TIMEOUT_MS (2000 ms) so in-flight data
 * streams resolve their route before local routing state is removed.
 * It's a module-local constant to avoid a runtime import cycle with client.ts.
 */
const LATE_SWITCH_UNSUBSCRIBE_DELAY_MS = 5000

/**
 * Register the receiver-side plumbing for a PUBLISH-delivered track: the
 * pushed object stream, alias/name routing for incoming data streams, and —
 * per SWITCH PR #1378 — the mapping from the PUBLISH's own request id to the track
 * alias so a relay-initiated catch-up stream (FETCH_HEADER carrying the
 * PUBLISH's request id, not a client-issued FetchRequest) routes into the
 * same receiver as the live SUBGROUP objects.
 */
function registerPublishReceiver(client: Parameters<ControlMessageHandler<Publish>>[0], msg: Publish) {
  let streamController!: ReadableStreamDefaultController<MoqtObject>
  const stream = new ReadableStream<MoqtObject>({
    start(c) {
      streamController = c
    },
  })

  const localPseudoRequestId = client.allocatePseudoRequestId()

  client.requestIdMap.addMapping(localPseudoRequestId, msg.fullTrackName)
  client.subscriptionAliasMap.set(localPseudoRequestId, msg.trackAlias)
  client.aliasFullTrackNameMap.set(msg.trackAlias, msg.fullTrackName)

  client.subscriptionAliasMap.set(msg.requestId, msg.trackAlias)

  // This object mimics a SubscribeRequest so #handleRecvStreams can use it
  // identically. `pseudoRequestId` is kept so unsubscribe() can clean up the
  // pseudo-id mappings alongside the PUBLISH's own request id.
  const receiver = {
    requestId: msg.requestId,
    pseudoRequestId: localPseudoRequestId,
    streamsAccepted: 0,
    largestLocation: undefined,
    controller: streamController,
  }
  client.subscriptions.set(msg.trackAlias, receiver)
  return stream
}

export const handlerPublish: ControlMessageHandler<Publish> = async (client, msg) => {
  const switchKey = msg.fullTrackName.toString()
  const switchTransition = SwitchTransition.fromParameters(msg.parameters)

  // ---------------------------------------------------------------------
  // Not switch-related: an ordinary unsolicited peer publish. Per SWITCH PR #1378
  // only a PUBLISH carrying SWITCH_TRANSITION answers a SWITCH, so a pending
  // switch resolver must NOT be consumed here — this PUBLISH goes to the
  // application untouched, and the switch keeps waiting for its own answer.
  // ---------------------------------------------------------------------
  if (!switchTransition) {
    const stream = registerPublishReceiver(client, msg)
    if (client.onPeerPublish) {
      client.onPeerPublish(msg, stream)
    }
    return
  }

  // ---------------------------------------------------------------------
  // Switch-related (SWITCH PR #1378): a PUBLISH opened by the relay in response to
  // a SWITCH. Resolve the oldest pending switch for this target track (FIFO
  // in send order — the PUBLISH alone cannot identify which source
  // subscription it replaces).
  // ---------------------------------------------------------------------
  const queue = client.pendingSwitches.get(switchKey)
  const resolver = queue?.shift()
  if (queue && queue.length === 0) client.pendingSwitches.delete(switchKey)

  if (!resolver) {
    // No pending SWITCH for this target track: either a late answer to a
    // SWITCH that hit the local response deadline, or an unsolicited
    // SWITCH_TRANSITION. Distinguish via the tombstones recorded at timeout
    // (see MOQtailClient.lateSwitchTombstones); consume one unexpired entry
    // and decline the PUBLISH, otherwise fall through to the protocol
    // violation below.
    //
    // DELIBERATE SPEC DEVIATION (documented in
    // docs/switch-pr1378-conformance.md): read literally, SWITCH PR #1378
    // says ANY SWITCH_TRANSITION PUBLISH without a pending SWITCH closes the
    // session with PROTOCOL_VIOLATION. But the pending switch here expired at
    // a deadline the CLIENT invented (the spec's silent pre-validation
    // failure forces a local timeout; the spec itself has no client-timeout
    // concept, so from its viewpoint this SWITCH is still pending). Killing
    // the session — and every other subscription on it — because a correct
    // relay's answer was slow would punish network delay, so a tombstoned
    // late answer is declined instead. The strict rule still applies whenever
    // no tombstone vouches for the track.
    const tombstones = client.lateSwitchTombstones.get(switchKey)
    if (tombstones) {
      const now = Date.now()
      const live = tombstones.filter((expiry) => expiry > now)
      if (live.length > 0) {
        live.pop()
        if (live.length > 0) client.lateSwitchTombstones.set(switchKey, live)
        else client.lateSwitchTombstones.delete(switchKey)

        if (msg.contentExists === 0) {
          // Failure PUBLISH: no subscription was established and no data
          // streams follow. The trailing PUBLISH_DONE is a no-op for an
          // unknown request id in handlerPublishDone.
          return
        }
        // Success PUBLISH: the relay completed the switch, but switch()
        // already resolved as a failure and the application retained its
        // current-subscription state. Register routing first so data streams
        // the relay has already opened (catch-up FETCH_HEADER, target
        // SUBGROUP) are accepted rather than failing route resolution, then
        // unsubscribe once the route-wait window has passed. The pushed
        // ReadableStream is not exposed to the application.
        //
        // NOTE the application-visible consequence (see
        // docs/switch-pr1378-conformance.md): the relay's Close-After-Switch
        // has ALREADY terminated the current subscription, so the app that
        // was told "switch failed, keep your state" holds state for a
        // torn-down track. It learns via the old request id's
        // PUBLISH_DONE(SUBSCRIPTION_ENDED); a Timeout SwitchFailure must
        // therefore be treated as "the source subscription may be gone",
        // not as proof the pre-switch world is intact.
        registerPublishReceiver(client, msg)
        setTimeout(() => {
          void client.unsubscribe(msg.requestId).catch(() => {
            // Session closed or teardown raced; nothing left to clean up.
          })
        }, LATE_SWITCH_UNSUBSCRIBE_DELAY_MS)
        return
      }
      client.lateSwitchTombstones.delete(switchKey)
    }
    // SWITCH PR #1378: "If a PUBLISH contains a SWITCH_TRANSITION parameter but no
    // pending SWITCH exists for that target Track, the receiver MUST close
    // the session with PROTOCOL_VIOLATION." Throwing propagates to the
    // control-message loop, which disconnects the session.
    throw new ProtocolViolationError(
      'handlerPublish',
      `PUBLISH for ${switchKey} carries SWITCH_TRANSITION but no SWITCH is pending`,
    )
  }

  if (msg.contentExists === 0) {
    // Failure PUBLISH: the relay could not perform the switch, opened this
    // PUBLISH per the always-PUBLISH failure discipline, and will immediately
    // follow with PUBLISH_DONE carrying the status code on the same control
    // stream (ordering guaranteed). Park the resolver keyed by this PUBLISH's
    // request id; handlerPublishDone completes it with a SwitchFailure. No
    // data follows, so no receiver/alias registration — the relay left the
    // CURRENT subscription untouched.
    client.pendingSwitchFailures.set(msg.requestId, resolver)
    return
  }

  // Success PUBLISH: register the receiver BEFORE resolving so that early
  // data streams (SUBGROUP or the catch-up FETCH_HEADER stream) racing the
  // control message find their route, then complete client.switch() with the
  // pushed stream, the relay-allocated request id, and the decoded seam.
  const stream = registerPublishReceiver(client, msg)
  resolver({
    requestId: msg.requestId,
    stream,
    largestLocation: msg.largestLocation,
    switchTransition,
  })
}
