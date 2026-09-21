/** first-option controller: always the first offered option, on every question — a distinct
 * baseline from `passive` (always hold) and `constant` (a configured non-hold option), catching a
 * design where the FIRST-LISTED option happens to look good regardless of menu order (an
 * independent design review: baselines must include "the first-option policy").
 */
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { syntheticResponse, type ControllerContext, type EngineController } from './types.ts';

export function createFirstOptionController(): EngineController {
  return {
    id: 'first-option',
    async answer(request: DecisionRequest, _context: ControllerContext): Promise<DecisionResponse> {
      return syntheticResponse(request, (_id, criteria) => Object.keys(criteria)[0]!);
    },
  };
}
