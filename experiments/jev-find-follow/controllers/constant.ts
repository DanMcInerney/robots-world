/** constant controller: always the SAME single, configured non-hold option per question,
 * regardless of state — a stronger baseline than passive, catching a design where any fixed action
 * "wins" by luck (an independent design review recommended this as a first-class controller
 * alongside passive; not one of the assignment's four required controllers, so it is additive and
 * not part of the required smoke-run acceptance criteria, but available and tested). Falls back to
 * the first offered option for any question that lacks the configured choice.
 */
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { syntheticResponse, type ControllerContext, type EngineController } from './types.ts';

export function createConstantController(choices: Record<string, string>): EngineController {
  return {
    id: 'constant',
    async answer(request: DecisionRequest, _context: ControllerContext): Promise<DecisionResponse> {
      return syntheticResponse(request, (id, criteria) => {
        const preferred = choices[id];
        return preferred && preferred in criteria ? preferred : Object.keys(criteria)[0]!;
      });
    },
  };
}
