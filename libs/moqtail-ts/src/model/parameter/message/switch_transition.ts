/**
 * Copyright 2026 The MOQtail Authors
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

import { ByteBuffer, FrozenByteBuffer } from '../../common/byte_buffer'
import { KeyValuePair } from '../../common/pair'
import { MessageParameterType } from '../constant'
import { Parameter } from '../parameter'

/**
 * SWITCH_TRANSITION message parameter (moq-transport PR #1378, "SWITCH for
 * Client-side ABR"). TS mirror of the Rust `MessageParameter::SwitchTransition`.
 *
 * The relay attaches this parameter to the target Track's PUBLISH so the
 * subscriber knows exactly where the seam is after a SWITCH:
 *
 * ```text
 * SWITCH_TRANSITION {
 *   Switching Group ID (i),   // G_switch — first group on the new track
 *   Live Edge Group ID (i)    // target's live edge when PUBLISH was opened
 * }
 * ```
 *
 * Everything in `[switchingGroupId, liveEdgeGroupId)` arrives on the catch-up
 * FETCH_HEADER stream; everything from the live edge onward arrives on the
 * normal SUBGROUP_HEADER streams. A subscriber can also use `switchingGroupId`
 * to discard buffered old-track content at or above the seam.
 *
 * Wire-wise this is an odd-typed (`0x73`) bytes-valued parameter whose value is
 * the two varints back to back. On a *failure* PUBLISH (Forward State 0,
 * immediately followed by PUBLISH_DONE) the relay still carries this parameter
 * to mark the PUBLISH as switch-related, with `{0, 0}` as placeholder values —
 * key off the PUBLISH_DONE status code, not these values, in that case.
 */
export class SwitchTransition implements Parameter {
  static readonly TYPE = MessageParameterType.SwitchTransition

  constructor(
    /** G_switch: the first group_id delivered on the target Track. */
    public readonly switchingGroupId: bigint,
    /** The target Track's live edge group_id at the moment the PUBLISH opened. */
    public readonly liveEdgeGroupId: bigint,
  ) {}

  toKeyValuePair(): KeyValuePair {
    const payload = new ByteBuffer()
    payload.putVI(this.switchingGroupId)
    payload.putVI(this.liveEdgeGroupId)
    return KeyValuePair.tryNewBytes(SwitchTransition.TYPE, payload.toUint8Array())
  }

  static fromKeyValuePair(pair: KeyValuePair): SwitchTransition | undefined {
    if (Number(pair.typeValue) !== SwitchTransition.TYPE || !(pair.value instanceof Uint8Array)) return undefined
    try {
      return SwitchTransition.fromBytes(pair.value)
    } catch {
      return undefined
    }
  }

  /** Decode the two-varint payload of a SWITCH_TRANSITION value. Throws on malformed input. */
  static fromBytes(value: Uint8Array): SwitchTransition {
    const buf = new FrozenByteBuffer(value)
    const switchingGroupId = buf.getVI()
    const liveEdgeGroupId = buf.getVI()
    return new SwitchTransition(switchingGroupId, liveEdgeGroupId)
  }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest

  describe('SwitchTransition', () => {
    test('roundtrips via key-value pair', () => {
      const st = new SwitchTransition(42n, 100n)
      const pair = st.toKeyValuePair()
      expect(pair.typeValue).toBe(0x73n)
      const parsed = SwitchTransition.fromKeyValuePair(pair)
      expect(parsed?.switchingGroupId).toBe(42n)
      expect(parsed?.liveEdgeGroupId).toBe(100n)
    })
    test('roundtrips through the wire form', () => {
      const st = new SwitchTransition(7n, 9n)
      const buf = new ByteBuffer()
      buf.putBytes(st.toKeyValuePair().serialize().toUint8Array())
      const parsed = KeyValuePair.deserialize(buf.freeze())
      expect(SwitchTransition.fromKeyValuePair(parsed)).toEqual(st)
    })
    test('fromKeyValuePair returns undefined for wrong type', () => {
      const pair = KeyValuePair.tryNewVarInt(MessageParameterType.NewGroupRequest, 1n)
      expect(SwitchTransition.fromKeyValuePair(pair)).toBeUndefined()
    })
    test('large group ids roundtrip', () => {
      const st = new SwitchTransition(1_000_000n, 2n ** 30n)
      expect(SwitchTransition.fromKeyValuePair(st.toKeyValuePair())).toEqual(st)
    })
  })
}
