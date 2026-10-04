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

export const handlerPublishDone: RequestStreamMessageHandler<PublishDone> = async (
  client,
  msg,
  _stream,
  openingRequestId,
) => {
  if (client.onPeerPublishDone) {
    client.onPeerPublishDone(msg)
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
  // Every stream may already have arrived; otherwise the last one to end completes it.
  client.completeIfDone(holder)
}
