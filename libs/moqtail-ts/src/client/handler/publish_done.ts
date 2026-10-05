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

import { PublishDone } from '../../model/control'
import { RequestStreamMessageHandler } from './handler'
import { SubscribeRequest } from '../request/subscribe'
import { logger } from '../../util/logger'
import { SwitchFailure } from '../types'

export const handlerPublishDone: RequestStreamMessageHandler<PublishDone> = async (
  client,
  msg,
  _stream,
  openingRequestId,
) => {
  // SWITCH PR #1378: a failure PUBLISH (SWITCH_TRANSITION present, Forward State 0)
  // parked its switch resolver keyed by the PUBLISH's request id, which is the id
  // that opened the request stream this PUBLISH_DONE arrives on. It carries the
  // failure status (TIMEOUT, DOES_NOT_EXIST, EXCESSIVE_LOAD, ...). Complete the
  // pending client.switch() promise with a typed SwitchFailure so the caller keeps
  // its current subscription state.
  const parkedSwitchResolver = client.pendingSwitchFailures.get(openingRequestId)
  if (parkedSwitchResolver) {
    client.pendingSwitchFailures.delete(openingRequestId)
    parkedSwitchResolver(new SwitchFailure(msg.statusCode, msg.errorReason.phrase))
    return
  }
  if (client.onPeerPublishDone) {
    client.onPeerPublishDone(msg, openingRequestId)
  }
  // PUBLISH_DONE carries no request id: the stream it arrives on names the request it
  // ends. That is either a SUBSCRIBE this side issued, or a PUBLISH the peer pushed
  // (M16; the latter used to be a no-op, leaving the receiver's stream open and its
  // alias routed forever).
  //
  // TODO(W6, pr1378): the relay's Close-After-Switch PUBLISH_DONE for the old
  // subscription and for the switch-target PUBLISH both land here; nothing
  // mechanism-specific is needed as long as the pr1378 route registers its
  // receivers through client.pushedReceivers / claimTrackAlias.
  const request = client.requests.get(openingRequestId)
  const holder = request instanceof SubscribeRequest ? request : client.pushedReceivers.get(openingRequestId)
  if (holder === undefined) {
    logger.warn(
      'handler/publish_done',
      `requestId=${openingRequestId} — no subscription or pushed receiver for this stream (already completed?)`,
    )
    return
  }
  holder.expectedStreams = msg.streamCount
  // Every stream may already have ended; otherwise the last one to end completes it
  // (D1: a stream counts once it has ended, not once it has been seen).
  client.completeIfDone(holder)
}
