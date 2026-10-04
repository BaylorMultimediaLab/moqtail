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

import {
  FullTrackName,
  Location,
  MessageParameter,
  MoqtObject,
  Subscribe,
  RequestError,
  SubscribeOk,
  RequestUpdate,
  applyMessageParameterUpdate,
} from '@/model'
import type { EarlyDiscardPolicyConfig } from '../types'
import { logger } from '../../util/logger'

// TODO: Add timeout mechanism for unsubscribing
export class SubscribeRequest implements PromiseLike<SubscribeOk | RequestError> {
  requestId: bigint
  fullTrackName: FullTrackName
  isCanceled: boolean = false
  startLocation: Location | undefined
  endGroup: bigint | undefined
  priority: number
  forward: boolean
  subscribeParameters: MessageParameter[]
  earlyDiscardPolicy: EarlyDiscardPolicyConfig | undefined
  largestLocation: Location | undefined // Updated on each received object
  streamsAccepted: bigint = 0n
  expectedStreams: bigint | undefined // Defined upon SUBSCRIBE_DONE
  readonly controller!: ReadableStreamDefaultController<MoqtObject>
  readonly stream: ReadableStream<MoqtObject>
  /**
   * The SWITCH in flight on this subscription, if any (M16). Its answer arrives on
   * the SUBSCRIBE's own request stream, so it is resolved here rather than through
   * the subscription's own promise: a refusal must leave the live subscription
   * untouched, and only an OK applies the new track name and parameters.
   */
  pendingSwitch:
    | {
        fullTrackName: FullTrackName
        parameters: MessageParameter[]
        promise: Promise<SubscribeOk | RequestError>
        resolve: (value: SubscribeOk | RequestError) => void
      }
    | undefined
  #promise: Promise<SubscribeOk | RequestError>
  #resolve!: (value: SubscribeOk | RequestError | PromiseLike<SubscribeOk | RequestError>) => void
  #reject!: (reason?: any) => void

  constructor(msg: Subscribe) {
    this.requestId = msg.requestId
    this.fullTrackName = msg.fullTrackName
    const filter = msg.parameters.find(MessageParameter.isSubscriptionFilter)
    this.startLocation = filter?.startLocation
    this.endGroup = filter?.endGroup
    const subPriority = msg.parameters.find(MessageParameter.isSubscriberPriority)
    this.priority = subPriority?.priority ?? 128
    const fwd = msg.parameters.find(MessageParameter.isForward)
    this.forward = fwd?.forward ?? true
    this.subscribeParameters = msg.parameters
    this.stream = new ReadableStream<MoqtObject>({
      start: (controller) => {
        ;(this.controller as any) = controller
      },
    })
    this.#promise = new Promise<SubscribeOk | RequestError>((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
    logger.debug(
      'request/subscribe',
      `created requestId=${this.requestId} ftn="${this.fullTrackName}" priority=${this.priority} forward=${this.forward}`,
    )
  }
  update(msg: RequestUpdate): void {
    const filter = msg.parameters.find(MessageParameter.isSubscriptionFilter)
    if (filter?.startLocation !== undefined) this.startLocation = filter.startLocation
    if (filter?.endGroup !== undefined) this.endGroup = filter.endGroup

    for (const param of msg.parameters) {
      if (MessageParameter.isSubscriberPriority?.(param)) {
        this.priority = (param as any).priority
      } else if (MessageParameter.isForward?.(param)) {
        this.forward = (param as any).forward
      }
    }

    if (typeof applyMessageParameterUpdate === 'function') {
      applyMessageParameterUpdate(this.subscribeParameters, msg.parameters)
    }
  }
  /**
   * Arms a SWITCH to `newTrackName`: the returned promise settles with the relay's
   * answer. The subscription keeps its current name until that answer is an OK.
   */
  beginSwitch(newTrackName: FullTrackName, newParameters: MessageParameter[]): Promise<SubscribeOk | RequestError> {
    let resolve!: (value: SubscribeOk | RequestError) => void
    const promise = new Promise<SubscribeOk | RequestError>((r) => {
      resolve = r
    })
    this.pendingSwitch = { fullTrackName: newTrackName, parameters: newParameters, promise, resolve }
    return promise
  }

  /**
   * Hands a response arriving on this subscription's stream to the SWITCH in flight.
   * Returns false when no SWITCH is pending, in which case the response is the
   * SUBSCRIBE's own and the caller resolves the request itself.
   */
  resolveSwitch(response: SubscribeOk | RequestError): boolean {
    const pending = this.pendingSwitch
    if (!pending) return false
    this.pendingSwitch = undefined
    if (response instanceof SubscribeOk) {
      this.fullTrackName = pending.fullTrackName
      this.subscribeParameters = pending.parameters
      logger.debug('request/subscribe', `switch OK requestId=${this.requestId} -> "${this.fullTrackName}"`)
    } else {
      logger.warn(
        'request/subscribe',
        `switch refused requestId=${this.requestId} code=${response.errorCode}; subscription stays on "${this.fullTrackName}"`,
      )
    }
    pending.resolve(response)
    return true
  }
  unsubscribe(): void {
    this.isCanceled = true
  }
  resolve(value: SubscribeOk | RequestError | PromiseLike<SubscribeOk | RequestError>): void {
    if (value instanceof RequestError) {
      logger.error(
        'request/subscribe',
        `resolved with error requestId=${this.requestId} code=${value.errorCode} reason="${value.reasonPhrase.phrase}"`,
      )
    } else if (value instanceof SubscribeOk) {
      logger.debug('request/subscribe', `resolved with OK requestId=${this.requestId} trackAlias=${value.trackAlias}`)
    }
    this.#resolve(value)
  }

  reject(reason?: any): void {
    logger.error('request/subscribe', `rejected requestId=${this.requestId}`, reason)
    this.#reject(reason)
  }

  then<TResult1 = SubscribeOk | RequestError, TResult2 = never>(
    onfulfilled?: ((value: SubscribeOk | RequestError) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null,
  ): Promise<SubscribeOk | RequestError | TResult> {
    return this.#promise.catch(onrejected)
  }

  finally(onfinally?: (() => void) | undefined | null): Promise<SubscribeOk | RequestError> {
    return this.#promise.finally(onfinally)
  }
}
