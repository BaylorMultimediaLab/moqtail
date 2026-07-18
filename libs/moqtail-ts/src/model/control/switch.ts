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

import { BaseByteBuffer, ByteBuffer, FrozenByteBuffer } from '../common/byte_buffer'
import { KeyValuePair } from '../common/pair'
import { ControlMessageType } from './constant'
import { FullTrackName } from '../data'

/**
 * SWITCH control message (SWITCH PR #1378).
 *
 * The subscriber does NOT allocate a Request ID for the SWITCH; the relay
 * allocates the Request ID of the target PUBLISH it opens in response.
 * `minimumSwitchingGroupId` is a lower bound, not an exact transition point —
 * the relay selects the smallest feasible common, gap-free boundary at or
 * above it.
 */
export class Switch {
  constructor(
    /** The Established subscription being replaced ("Current Subscribe Request ID"). */
    public currentSubscribeRequestId: bigint,
    public fullTrackName: FullTrackName,
    /**
     * Lower bound on the transition group ("Minimum Switching Group ID").
     * An ordinary floor — the draft has NO live-edge sentinel: `0n` means
     * "any group is acceptable" and resolves to the OLDEST common gap-free
     * boundary, i.e. full buffer replacement with a maximal catch-up range.
     * To switch near live, pass the latest group id received on the current
     * subscription.
     */
    public minimumSwitchingGroupId: bigint,
    public parameters: KeyValuePair[],
  ) {}

  serialize(): FrozenByteBuffer {
    const buf = new ByteBuffer()
    buf.putVI(ControlMessageType.Switch)

    const payload = new ByteBuffer()
    payload.putVI(this.currentSubscribeRequestId)
    payload.putBytes(this.fullTrackName.serialize().toUint8Array())
    payload.putVI(this.minimumSwitchingGroupId)

    payload.putVI(this.parameters.length)
    for (const param of this.parameters) {
      payload.putBytes(param.serialize().toUint8Array())
    }

    const payloadBytes = payload.toUint8Array()
    buf.putU16(payloadBytes.length)
    buf.putBytes(payloadBytes)

    return buf.freeze()
  }

  static parsePayload(buf: BaseByteBuffer): Switch {
    const currentSubscribeRequestId = buf.getVI()
    const fullTrackName = buf.getFullTrackName()
    const minimumSwitchingGroupId = buf.getVI()

    const paramCount = Number(buf.getVI())
    const parameters: KeyValuePair[] = []
    for (let i = 0; i < paramCount; i++) {
      parameters.push(KeyValuePair.deserialize(buf))
    }

    return new Switch(currentSubscribeRequestId, fullTrackName, minimumSwitchingGroupId, parameters)
  }
}
