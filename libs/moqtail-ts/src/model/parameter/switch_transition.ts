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

import { ByteBuffer, FrozenByteBuffer } from '../common/byte_buffer'
import { KeyValuePair } from '../common/pair'
import { VersionSpecificParameterType } from './constant'

/**
 * SWITCH_TRANSITION version-specific parameter (draft-ietf-moq-transport
 * PR #1378, "SWITCH for Client-side ABR"). TS mirror of the Rust
 * `parameter::switch_transition::SwitchTransition`.
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
 * to discard buffered old-track content at or above the seam (the draft's
 * buffer-replacement use case).
 *
 * Wire-wise this is an *odd*-typed (`0x73`) bytes-valued {@link KeyValuePair}
 * whose value is the two varints back to back. On a *failure* PUBLISH
 * (content_exists = 0, immediately followed by PUBLISH_DONE) the relay still
 * carries this parameter to mark the PUBLISH as switch-related, with `{0, 0}`
 * as placeholder values — key off the PUBLISH_DONE status code, not these
 * values, in that case.
 */
export class SwitchTransition {
  constructor(
    /** G_switch: the first group_id delivered on the target Track. */
    public readonly switchingGroupId: bigint,
    /** The target Track's live edge group_id at the moment the PUBLISH opened. */
    public readonly liveEdgeGroupId: bigint,
  ) {}

  /** Encode as the `0x73` bytes-valued {@link KeyValuePair} ready to drop into a PUBLISH's parameter list. */
  toKeyValuePair(): KeyValuePair {
    const payload = new ByteBuffer()
    payload.putVI(this.switchingGroupId)
    payload.putVI(this.liveEdgeGroupId)
    return KeyValuePair.tryNewBytes(VersionSpecificParameterType.SwitchTransition, payload.toUint8Array())
  }

  /** Decode the two-varint payload of a SWITCH_TRANSITION value. Throws on malformed input. */
  static fromBytes(value: Uint8Array): SwitchTransition {
    const buf = new FrozenByteBuffer(value)
    const switchingGroupId = buf.getVI()
    const liveEdgeGroupId = buf.getVI()
    return new SwitchTransition(switchingGroupId, liveEdgeGroupId)
  }

  /**
   * Find and decode the first SWITCH_TRANSITION parameter in a list, if any.
   * Returns `null` when the parameter is absent or carries the wrong shape
   * (varint-valued, or a malformed byte payload).
   */
  static fromParameters(params: KeyValuePair[]): SwitchTransition | null {
    for (const p of params) {
      if (p.typeValue === BigInt(VersionSpecificParameterType.SwitchTransition) && p.value instanceof Uint8Array) {
        try {
          return SwitchTransition.fromBytes(p.value)
        } catch {
          return null
        }
      }
    }
    return null
  }
}