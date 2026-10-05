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
import { ProtocolViolationError } from '../../error/error'

/**
 * SWITCH_TRANSITION message parameter (moq-transport PR #1378, "SWITCH for
 * Client-side ABR"). TS mirror of the Rust `MessageParameter::SwitchTransition`.
 *
 * The relay attaches this parameter to the target Track's PUBLISH so the
 * subscriber knows exactly where the seam is after a SWITCH:
 *
 * ```text
 * SWITCH_TRANSITION {
 *   Switching Group ID (i),     // G_switch — first group on the new track
 *   Live Edge Group ID (i),     // target's live edge when PUBLISH was opened
 *   [Below-Seam Streams (i)]    // project-local, optional
 * }
 * ```
 *
 * The third field is a project-local extension (deliberate deviation, audit R6
 * D2): the number of data streams the relay opened on the replaced subscription
 * for Groups below G_switch, finished ones included. The subscriber knows the
 * replaced subscription has delivered everything below the seam once that many
 * of its streams below G_switch have ended. The PR's two-field payload still
 * decodes, with `belowSeamStreams` undefined.
 *
 * Everything in `[switchingGroupId, liveEdgeGroupId)` arrives on the catch-up
 * FETCH_HEADER stream; everything from the live edge onward arrives on the
 * normal SUBGROUP_HEADER streams. A subscriber can also use `switchingGroupId`
 * to discard buffered old-track content at or above the seam.
 *
 * Wire-wise this is an odd-typed (`0x73`) bytes-valued parameter whose value is
 * the varints back to back. On a *failure* PUBLISH (Forward State 0,
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
    /**
     * Project-local: data streams the relay opened on the replaced subscription for
     * Groups below G_switch (finished ones included). Undefined when not carried.
     */
    public readonly belowSeamStreams?: bigint,
  ) {}

  toKeyValuePair(): KeyValuePair {
    const payload = new ByteBuffer()
    payload.putVI(this.switchingGroupId)
    payload.putVI(this.liveEdgeGroupId)
    if (this.belowSeamStreams !== undefined) payload.putVI(this.belowSeamStreams)
    return KeyValuePair.tryNewBytes(SwitchTransition.TYPE, payload.toUint8Array())
  }

  /**
   * The parameter carried by `pair`, or undefined when `pair` is another type.
   *
   * @throws :{@link ProtocolViolationError} When the value does not decode (R7-D4):
   * like every known parameter with an invalid value, and like the Rust library. It
   * used to be swallowed, which dropped the parameter: the switch's PUBLISH then
   * looked like an ordinary peer publish and the SWITCH hung to its response
   * deadline.
   */
  static fromKeyValuePair(pair: KeyValuePair): SwitchTransition | undefined {
    if (Number(pair.typeValue) !== SwitchTransition.TYPE) return undefined
    if (!(pair.value instanceof Uint8Array)) {
      throw new ProtocolViolationError('SwitchTransition.fromKeyValuePair', 'SWITCH_TRANSITION must be bytes-valued')
    }
    try {
      return SwitchTransition.fromBytes(pair.value)
    } catch (error) {
      throw new ProtocolViolationError(
        'SwitchTransition.fromKeyValuePair',
        `malformed SWITCH_TRANSITION: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Decode a SWITCH_TRANSITION value: two varints, optionally a third (the
   * below-seam stream count). Throws on malformed input, including bytes after the
   * third varint.
   */
  static fromBytes(value: Uint8Array): SwitchTransition {
    const buf = new FrozenByteBuffer(value)
    const switchingGroupId = buf.getVI()
    const liveEdgeGroupId = buf.getVI()
    if (buf.remaining === 0) return new SwitchTransition(switchingGroupId, liveEdgeGroupId)
    const belowSeamStreams = buf.getVI()
    if (buf.remaining !== 0) throw new Error('SWITCH_TRANSITION: trailing bytes after the below-seam stream count')
    return new SwitchTransition(switchingGroupId, liveEdgeGroupId, belowSeamStreams)
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
    // R7-D4: a value that does not decode is a protocol violation, as in the Rust
    // library; it used to be dropped as if the parameter were absent.
    test('a malformed value is a protocol violation, not an absent parameter', () => {
      const one = new ByteBuffer()
      one.putVI(6n)
      const four = new ByteBuffer()
      for (const v of [1n, 2n, 3n, 4n]) four.putVI(v)
      for (const value of [one, four]) {
        const pair = KeyValuePair.tryNewBytes(SwitchTransition.TYPE, value.toUint8Array())
        expect(() => SwitchTransition.fromKeyValuePair(pair)).toThrow(ProtocolViolationError)
      }
    })
    test('fromKeyValuePair returns undefined for wrong type', () => {
      const pair = KeyValuePair.tryNewVarInt(MessageParameterType.NewGroupRequest, 1n)
      expect(SwitchTransition.fromKeyValuePair(pair)).toBeUndefined()
    })
    test('the project-local below-seam stream count roundtrips; the two-field form still decodes (R6 D2)', () => {
      const st = new SwitchTransition(42n, 100n, 3n)
      expect(SwitchTransition.fromKeyValuePair(st.toKeyValuePair())).toEqual(st)
      const zero = new SwitchTransition(5n, 6n, 0n)
      expect(SwitchTransition.fromKeyValuePair(zero.toKeyValuePair())?.belowSeamStreams).toBe(0n)
      const old = SwitchTransition.fromKeyValuePair(new SwitchTransition(42n, 100n).toKeyValuePair())
      expect(old?.switchingGroupId).toBe(42n)
      expect(old?.belowSeamStreams).toBeUndefined()
      const four = new ByteBuffer()
      for (const v of [1n, 2n, 3n, 4n]) four.putVI(v)
      expect(() => SwitchTransition.fromBytes(four.toUint8Array())).toThrow()
    })
    test('large group ids roundtrip', () => {
      const st = new SwitchTransition(1_000_000n, 2n ** 30n)
      expect(SwitchTransition.fromKeyValuePair(st.toKeyValuePair())).toEqual(st)
    })
  })
}
