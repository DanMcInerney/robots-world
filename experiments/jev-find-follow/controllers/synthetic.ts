/** synthetic controller: scripted/fake responses for exercising mechanics (pacing, leases, report
 * schema, replay) without asserting any behavioural competence (item 7). Deterministic given the
 * decision index: cycles through the offered options in a fixed order, not a policy.
 */
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { syntheticResponse, type ControllerContext, type EngineController } from './types.ts';

export function createSyntheticController(): EngineController {
  return {
    id: 'synthetic',
    async answer(request: DecisionRequest, context: ControllerContext): Promise<DecisionResponse> {
      return syntheticResponse(request, (_id, criteria) => {
        const keys = Object.keys(criteria);
        return keys[context.decisionIndex % keys.length]!;
      });
    },
  };
}
