/** passive controller: always hold — the do-nothing baseline (item 7). */
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { syntheticResponse, type ControllerContext, type EngineController } from './types.ts';

function chooseHold(_id: string, criteria: Record<string, string>): string {
  if ('hold' in criteria) return 'hold';
  return Object.keys(criteria)[0]!;
}

export function createPassiveController(): EngineController {
  return {
    id: 'passive',
    async answer(request: DecisionRequest, _context: ControllerContext): Promise<DecisionResponse> {
      return syntheticResponse(request, chooseHold);
    },
  };
}
