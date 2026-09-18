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
    client.onPeerPublishDone(msg)
  }
  //TODO: Check for all kinds of subscriptions, not jus tthe ones initiated with subscribe messages
  const request = client.requests.get(openingRequestId)
  if (request instanceof SubscribeRequest) {
    request.expectedStreams = msg.streamCount
  } else {
    // TODO: Throw this error when the check is fixed. For now it crashes valid cases
    // throw new ProtocolViolationError('handlerPublishDone', 'No publish request was found with the given request id')
  }
}
