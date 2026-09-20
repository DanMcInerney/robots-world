import { createHash } from 'node:crypto';
import type { Request } from '../jev-strategies/strategies.ts';

export type RangeEvidence = {
  id: string; routeId: string; split: 'development' | 'confirmation';
  targetStatus: 'single' | 'missing' | 'ambiguous';
  medianRangeM: number | null; bearingDeg: number | null;
  validFraction: number; unknownReason: string | null;
};
export type WordingArm = 'measured' | 'signed-error';
export type RangeProbe = {
  id: string; sceneId: string; split: RangeEvidence['split']; arm: WordingArm; goalM: number;
  request: Request; expected: string[]; options: Record<string, number | null>;
  usable: boolean; expectedDirection: 'approach' | 'retreat' | 'hold' | 'observe';
};
const ACTIONS = [2, 1, 0, -1, -2, null] as const;
const usable = (e: RangeEvidence) => e.targetStatus === 'single' && e.medianRangeM !== null
  && Number.isFinite(e.medianRangeM) && e.medianRangeM > 0;

export function bestRangeOptions(options: Record<string, number | null>, rangeM: number | null, goalM: number): string[] {
  if (rangeM === null) return Object.keys(options).filter(id => options[id] === null);
  const errors = Object.entries(options).filter(([, d]) => d !== null)
    .map(([id, d]) => ({ id, error: Math.abs(rangeM - d! - goalM) }));
  const best = Math.min(...errors.map(x => x.error));
  return errors.filter(x => x.error <= best + 1e-9).map(x => x.id);
}

/** Copies only the measured schema; arbitrary evaluator fields cannot enter model state. */
export function rangeProbes(e: RangeEvidence): RangeProbe[] {
  const permitted = usable(e), rangeM = permitted ? e.medianRangeM : null;
  const ordered = ACTIONS.map(delta => ({ delta,
    order: createHash('sha256').update(e.id + ':' + delta).digest('hex') }))
    .sort((a, b) => a.order.localeCompare(b.order));
  const options = Object.fromEntries(ordered.map((o, i) => [`a${i + 1}`, o.delta]));
  const criteria = Object.fromEntries(Object.entries(options).map(([id, d]) => [id,
    d === null ? 'Observe again without moving.' : d === 0 ? 'Hold: no displacement.'
      : `${d > 0 ? 'Approach' : 'Retreat'} ${Math.abs(d)} m along the stipulated target ray.`]));
  return [8, 12].flatMap(goalM => (['measured', 'signed-error'] as const).map(arm => {
    const measured = { targetStatus: e.targetStatus, medianVisibleSurfaceRangeM: rangeM,
      bearingDeg: e.bearingDeg, validFraction: e.validFraction, unknownReason: e.unknownReason };
    const state: Record<string, unknown> = {
      goal: `Reach a median visible-surface range of ${goalM} m in this ideal one-step diagnostic.`,
      requestedRangeM: goalM, measured,
      geometry: 'This is a point-range approximation of a static observed surface in a stipulated clear corridor. Approach decreases range, retreat increases range, and hold leaves range unchanged. Each offered displacement completes exactly. This is not an executed flight or a collision-clearance assertion.',
      actions: options,
    };
    if (arm === 'signed-error') state.goalRelativeRange = { signedErrorM: rangeM === null ? null : rangeM - goalM,
      definition: 'Measured range minus requested range. Positive means farther than requested; negative means nearer than requested; zero means at the requested range.' };
    const expected = bestRangeOptions(options, rangeM, goalM);
    const direction = rangeM === null ? 'observe' : rangeM - goalM > .5 ? 'approach' : rangeM - goalM < -.5 ? 'retreat' : 'hold';
    return { id: `${e.id}-goal${goalM}-${arm}`, sceneId: e.id, split: e.split, arm, goalM, options,
      expected, usable: permitted, expectedDirection: direction,
      request: { model: 'jev-1.13.0', state, questions: { action: { type: 'choice', criteria,
        instructions: [
          'Choose one offered action for the exact goal. Approach has positive signed displacement and retreat has negative signed displacement. Final range = measured range minus signed displacement.',
          'When a single target has a finite positive measured range, minimize the absolute difference between final range and requested range. Hold and all displacements compete on that same objective; tied minima are equally acceptable. Do not substitute observe for a usable measurement.',
          'When the target is missing or ambiguous, or the measured range is null, choose observe. Do not infer a missing range from bearing, confidence, appearance or a previous frame.',
        ] } } } as Request };
  }));
}

export function gradeRangeProbe(p: RangeProbe, answer: string | undefined) {
  const completed = answer !== undefined && Object.hasOwn(p.options, answer);
  const delta = completed ? p.options[answer!] : undefined;
  return { completed, correct: completed && p.expected.includes(answer!),
    unsupported: completed && !p.usable && delta !== null,
    wrongDirection: completed && p.usable && typeof delta === 'number'
      && ((p.expectedDirection === 'approach' && delta < 0) || (p.expectedDirection === 'retreat' && delta > 0)),
    usefulMovement: completed && p.expected.includes(answer!) && typeof delta === 'number' && delta !== 0,
    correctHold: completed && p.expected.includes(answer!) && delta === 0,
    correctObserve: completed && p.expected.includes(answer!) && delta === null };
}
