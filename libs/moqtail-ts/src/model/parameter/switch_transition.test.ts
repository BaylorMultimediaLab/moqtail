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

import { describe, expect, test } from 'vitest'
import { SwitchTransition } from './switch_transition'
import { VersionSpecificParameterType } from './constant'
import { KeyValuePair } from '../common/pair'

describe('SwitchTransition', () => {
  test('roundtrip via KeyValuePair', () => {
    const st = new SwitchTransition(42n, 100n)
    const kvp = st.toKeyValuePair()

    // Type is the odd SWITCH_TRANSITION code, carried as a bytes pair.
    expect(kvp.typeValue).toBe(BigInt(VersionSpecificParameterType.SwitchTransition))

    const decoded = SwitchTransition.fromParameters([kvp])
    expect(decoded).not.toBeNull()
    expect(decoded!.switchingGroupId).toBe(42n)
    expect(decoded!.liveEdgeGroupId).toBe(100n)
  })

  test('serializes through KeyValuePair wire form', () => {
    // Full KeyValuePair serialize/deserialize cycle, as it would travel on a
    // PUBLISH parameter list.
    const st = new SwitchTransition(7n, 9n)
    const buf = st.toKeyValuePair().serialize()
    const parsed = KeyValuePair.deserialize(buf)
    const decoded = SwitchTransition.fromParameters([parsed])
    expect(decoded).not.toBeNull()
    expect(decoded!.switchingGroupId).toBe(7n)
    expect(decoded!.liveEdgeGroupId).toBe(9n)
  })

  test('fromParameters ignores other params', () => {
    const other = KeyValuePair.tryNewVarInt(VersionSpecificParameterType.DelayGroups, 5n)
    expect(SwitchTransition.fromParameters([other])).toBeNull()
  })

  test('fromParameters absent is null', () => {
    expect(SwitchTransition.fromParameters([])).toBeNull()
  })

  test('fromParameters returns null on malformed payload', () => {
    // A single truncated varint byte cannot decode two group ids.
    const malformed = KeyValuePair.tryNewBytes(
      VersionSpecificParameterType.SwitchTransition,
      new Uint8Array([0xc0]),
    )
    expect(SwitchTransition.fromParameters([malformed])).toBeNull()
  })

  test('large group ids roundtrip', () => {
    // Exercise multi-byte varints near the QUIC varint ceiling.
    const st = new SwitchTransition(1_000_000n, 2n ** 30n)
    const decoded = SwitchTransition.fromParameters([st.toKeyValuePair()])
    expect(decoded).not.toBeNull()
    expect(decoded!.switchingGroupId).toBe(1_000_000n)
    expect(decoded!.liveEdgeGroupId).toBe(2n ** 30n)
  })

  test('failure-publish placeholder {0,0} decodes', () => {
    // The relay's failure PUBLISH carries SWITCH_TRANSITION {0, 0} purely as a
    // switch-related marker; the values must still decode cleanly.
    const decoded = SwitchTransition.fromParameters([new SwitchTransition(0n, 0n).toKeyValuePair()])
    expect(decoded).not.toBeNull()
    expect(decoded!.switchingGroupId).toBe(0n)
    expect(decoded!.liveEdgeGroupId).toBe(0n)
  })
})
