/** seeded-random controller: a uniformly random offered option per question, deterministic given a
 * seed (repeatable across runs, never true nondeterminism) — a baseline an independent design
 * review specifically asked for alongside passive/constant/first-option, e.g. to show that a
 * degenerate open-field search rung (where any constant sweep is optimal) does not also let random
 * chance pass.
 */
import { randomStream } from '../../../src/math.ts';
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { syntheticResponse, type ControllerContext, type EngineController } from './types.ts';

export function createSeededRandomController(seed: number): EngineController {
  const random = randomStream(seed, 'find-follow-seeded-random-controller');
  return {
    id: 'seeded-random',
    async answer(request: DecisionRequest, _context: ControllerContext): Promise<DecisionResponse> {
      return syntheticResponse(request, (_id, criteria) => {
        const keys = Object.keys(criteria);
        return keys[Math.floor(random() * keys.length) % keys.length]!;
      });
    },
  };
}
