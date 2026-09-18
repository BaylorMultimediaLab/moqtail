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

import { KeyValuePair } from '../../common/pair'
import { MessageParameterType } from '../constant'
import { Parameter } from '../parameter'

/**
 * Project-local extension (non-MoQT-standard, type 0x70). A filtered
 * (delay-mode) subscriber asks the relay to start delivery this many groups
 * behind the live edge.
 */
export class DelayGroups implements Parameter {
  static readonly TYPE = MessageParameterType.DelayGroups

  constructor(public readonly groups: bigint) {}

  toKeyValuePair(): KeyValuePair {
    return KeyValuePair.tryNewVarInt(DelayGroups.TYPE, this.groups)
  }

  static fromKeyValuePair(pair: KeyValuePair): DelayGroups | undefined {
    if (Number(pair.typeValue) !== DelayGroups.TYPE || typeof pair.value !== 'bigint') return undefined
    return new DelayGroups(pair.value)
  }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest

  describe('DelayGroups', () => {
    test('roundtrips correctly', () => {
      const orig = new DelayGroups(5n)
      const pair = orig.toKeyValuePair()
      expect(pair.typeValue).toBe(0x70n)
      const parsed = DelayGroups.fromKeyValuePair(pair)
      expect(parsed?.groups).toBe(5n)
    })
    test('fromKeyValuePair returns undefined for wrong type', () => {
      const pair = KeyValuePair.tryNewVarInt(MessageParameterType.ObjectDeliveryTimeout, 100n)
      expect(DelayGroups.fromKeyValuePair(pair)).toBeUndefined()
    })
  })
}
