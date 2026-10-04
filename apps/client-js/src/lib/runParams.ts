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

/** The ABR controller arms the runner can select (`?controllerArm=`). */
export const CONTROLLER_ARMS = ['min', 'grid', 'baseline'] as const;
export type ControllerArmParam = (typeof CONTROLLER_ARMS)[number];

/** The arm named by a `controllerArm` URL parameter, or null for anything else. */
export function controllerArmParam(v: string | null): ControllerArmParam | null {
  return CONTROLLER_ARMS.find(a => a === v) ?? null;
}
