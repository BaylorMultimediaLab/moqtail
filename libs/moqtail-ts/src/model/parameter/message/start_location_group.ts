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
 * Project-local extension (non-MoQT-standard, type 0x72). The absolute group
 * id where a SWITCH should start delivering the new track (aligned switch).
 */
export class StartLocationGroup implements Parameter {
  static readonly TYPE = MessageParameterType.StartLocationGroup

  constructor(public readonly group: bigint) {}

  toKeyValuePair(): KeyValuePair {
    return KeyValuePair.tryNewVarInt(StartLocationGroup.TYPE, this.group)
  }

  static fromKeyValuePair(pair: KeyValuePair): StartLocationGroup | undefined {
    if (Number(pair.typeValue) !== StartLocationGroup.TYPE || typeof pair.value !== 'bigint') return undefined
    return new StartLocationGroup(pair.value)
  }
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest

  describe('StartLocationGroup', () => {
    test('roundtrips correctly', () => {
      const orig = new StartLocationGroup(42n)
      const pair = orig.toKeyValuePair()
      expect(pair.typeValue).toBe(0x72n)
      const parsed = StartLocationGroup.fromKeyValuePair(pair)
      expect(parsed?.group).toBe(42n)
    })
    test('fromKeyValuePair returns undefined for wrong type', () => {
      const pair = KeyValuePair.tryNewVarInt(MessageParameterType.NewGroupRequest, 1n)
      expect(StartLocationGroup.fromKeyValuePair(pair)).toBeUndefined()
    })
  })
}
