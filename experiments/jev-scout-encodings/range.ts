/** R hypothesis: range-following encoding case generator. Fresh, entirely stipulated range facts;
 * no sensor or model call occurs in this module. Facts are built once per (unit, mirror) and rendered
 * three ways (measured / signed-error / after-range), so all three arms share identical underlying
 * facts and an identical 5-action menu; only the declared representation factor differs. */
import {digest} from '../jev-spatial-text/transport.ts';
import {RANGE_ACTIONS, RANGE_ACTION_IDS, RANGE_TOLERANCE_M, rangeOracle, type RangeFacts} from './oracle.ts';
import type {ScoutCase, ScoutQuestion} from './types.ts';

export const RANGE_ARMS = ['measured', 'signed-error', 'after-range'] as const;
export type RangeArm = typeof RANGE_ARMS[number];
const TARGET_CLASSES = ['blue car', 'red backpack'];
/** Renders and compares at 0.1 m precision: finer thresholds are below F67's 0.29 m measured stereo MAE
 * and would test rounding noise rather than the declared representation. */
const round1 = (x: number) => Math.round(x * 10) / 10;

const NOTICE = 'Invented synthetic range-following diagnostic. These values are stipulated fixture facts, not a current camera/stereo acquisition or Jev self-history. All questions are independent; sibling answers are unavailable.';
const FRAME = 'Range is the measured stereo surface distance to the target along the current line of sight, in metres, rendered to 0.1 m. Approaching decreases range; retreating increases it.';
const ACTION_QUESTION_INSTRUCTIONS = 'Choose the single action that satisfies the policy stated in state.component_goal, using only the facts in this state. Decide from this state independently of any other question.';
const CONSEQUENCE_SOURCE = 'Code-computed consequences for EVERY offered action under a stated stationary-target/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking, or a recommendation.';

function componentGoal(targetDescription: string): string {
  return `Choose the single action that gets closest to the requested follow distance from the ${targetDescription}, using exactly this declared policy: `
    + `if the measured range is unavailable or ambiguous, hold; do not commit to an unsupported movement. `
    + `Otherwise choose the action, including hold, whose resulting range has the smallest absolute error from the requested distance; any exactly tied smallest is correct. `
    + `An action that increases the absolute error beyond its current value is wrong; holding without improving is acceptable only when no action reduces the error further.`;
}
function rangeActionCriteria(): Record<string, string> {
  return Object.fromEntries(Object.entries(RANGE_ACTIONS).map(([id, delta]) => {
    if (id === 'hold') return [id, 'Hold the current position. Range to the target is unchanged by this action.'];
    const verb = delta < 0 ? 'Approach the target, decreasing range, by' : 'Retreat from the target, increasing range, by';
    return [id, `${verb} ${Math.abs(delta)} m along the measured line of sight, if the movement is otherwise unobstructed.`];
  }));
}
function buildRangeFacts(rangeStatus: RangeFacts['rangeStatus'], measuredRangeM: number | null, goalM: number, targetDescription: string): RangeFacts {
  return {rangeStatus, measuredRangeM: measuredRangeM == null ? null : round1(measuredRangeM), goalM: round1(goalM), targetDescription};
}
export function mirrorRangeFacts(facts: RangeFacts): RangeFacts {
  if (facts.rangeStatus !== 'valid' || facts.measuredRangeM == null) return {...facts};
  return {...facts, measuredRangeM: round1(2 * facts.goalM - facts.measuredRangeM)}; // reflects the signed error around zero
}

// ---------- split-specific parameters: genuinely different draws, not one shifted by a constant ----------
type SplitPlan = {
  r1Goal: readonly number[]; r2Goal: readonly number[]; r2Offset: readonly number[];
  r3Measured: readonly number[]; r4Goal: readonly number[]; r4Outside: readonly number[]; r4InsideOffset: number;
  r5Goal: readonly number[]; r5Overshoot: readonly number[]; targetStart: 0 | 1;
};
// r4Outside margins are >=0.3 m beyond the 0.5 m tolerance (realistic vs F67's 0.29 m stereo MAE), never a
// 0.1 mm boundary shave; r4InsideOffset is comfortably inside tolerance for the paired "just inside" case.
const DEV_PLAN: SplitPlan = {
  r1Goal: [8, 11, 14], r2Goal: [6, 9, 13], r2Offset: [0.2, 0.3, 0.4],
  r3Measured: [10, 15.5], r4Goal: [9, 12, 16], r4Outside: [0.8, 0.9, 1], r4InsideOffset: 0.3,
  r5Goal: [8, 11, 15], r5Overshoot: [1.2, -1.4, 1.8], targetStart: 0,
};
const CONFIRM_PLAN: SplitPlan = {
  r1Goal: [7, 12.5, 17], r2Goal: [10, 5.5, 15], r2Offset: [0.15, 0.35, 0.25],
  r3Measured: [13.25, 21.75], r4Goal: [10.5, 14, 7.5], r4Outside: [1, 0.85, 1.1], r4InsideOffset: 0.35,
  r5Goal: [9.5, 13, 6], r5Overshoot: [-1.6, 1.3, -1.1], targetStart: 1,
};
const targetFor = (plan: SplitPlan, variant: number) => TARGET_CLASSES[(plan.targetStart + variant) % TARGET_CLASSES.length]!;

// R1: unknown/invalid range -> correct is hold/observe. No directional structure to mirror, so a single
// instance per variant is generated (see generateRangeCases); its "mirror" would be content-identical.
function familyR1(plan: SplitPlan, variant: number): RangeFacts {
  const status = variant === 1 ? 'ambiguous' : 'unavailable';
  return buildRangeFacts(status, null, plan.r1Goal[variant]!, targetFor(plan, variant));
}
// R2: measured range already inside tolerance -> correct is hold.
function familyR2(plan: SplitPlan, variant: number): RangeFacts {
  return buildRangeFacts('valid', plan.r2Goal[variant]! + plan.r2Offset[variant]!, plan.r2Goal[variant]!, targetFor(plan, variant));
}
// R3: same measured range, two goal distances on either side of it -> both approach and retreat directions are exercised.
function familyR3(plan: SplitPlan, sceneVariant: number, goalVariant: number): RangeFacts {
  const measuredRangeM = plan.r3Measured[sceneVariant]!, goalM = goalVariant === 0 ? measuredRangeM - 4 : measuredRangeM + 4;
  return buildRangeFacts('valid', measuredRangeM, goalM, targetFor(plan, sceneVariant));
}
// R4: signed error just inside (hold-correct) vs realistically outside (>=0.3 m beyond tolerance) the boundary.
function familyR4(plan: SplitPlan, variant: number): RangeFacts {
  const goalM = plan.r4Goal[variant]!, sign = variant % 2 === 0 ? 1 : -1;
  const delta = variant === 0 ? plan.r4InsideOffset : plan.r4Outside[variant]!;
  return buildRangeFacts('valid', goalM + sign * delta, goalM, targetFor(plan, variant));
}
// R5: wrong-side traps where the larger step overshoots past the goal; the smaller step (or opposite
// direction) is the true optimum, punishing a naive largest-step or fixed-sign policy.
function familyR5(plan: SplitPlan, variant: number): RangeFacts {
  return buildRangeFacts('valid', plan.r5Goal[variant]! + plan.r5Overshoot[variant]!, plan.r5Goal[variant]!, targetFor(plan, variant));
}

function renderRangeState(facts: RangeFacts, arm: RangeArm) {
  const state: any = {
    evidence_notice: NOTICE, frame: FRAME, component_goal: componentGoal(facts.targetDescription),
    measured_range: {status: facts.rangeStatus, range_m: facts.rangeStatus === 'valid' ? facts.measuredRangeM : null},
    requested_distance_m: facts.goalM, tolerance_m: RANGE_TOLERANCE_M,
  };
  if (arm === 'measured') return state;
  const signedErrorM = facts.rangeStatus === 'valid' && facts.measuredRangeM != null ? round1(facts.measuredRangeM - facts.goalM) : null;
  if (arm === 'signed-error') {
    // Purely descriptive: a magnitude and a side, no directive verb ("needs to close/open").
    state.declared_computation = {
      source: 'Code-computed signed range error from the supplied measured range and requested distance; no future measurement, ranking, or recommendation.',
      signed_error_m: signedErrorM,
      description: signedErrorM == null ? 'unknown' : signedErrorM > 0
        ? `Measured range is ${Math.abs(signedErrorM).toFixed(1)} m farther than the requested distance.`
        : signedErrorM < 0 ? `Measured range is ${Math.abs(signedErrorM).toFixed(1)} m closer than the requested distance.`
        : 'Measured range equals the requested distance.',
    };
    return state;
  }
  state.declared_computation = {
    source: CONSEQUENCE_SOURCE,
    per_option: RANGE_ACTION_IDS.map(id => {
      const delta = RANGE_ACTIONS[id]!;
      if (facts.rangeStatus !== 'valid' || facts.measuredRangeM == null) return {action: id, resulting_range_m: null, resulting_signed_error_m: null};
      const resultingRangeM = round1(facts.measuredRangeM + delta);
      return {action: id, resulting_range_m: resultingRangeM, resulting_signed_error_m: round1(resultingRangeM - facts.goalM)};
    }),
  };
  return state;
}

function caseKindFor(family: string): 'positive' | 'abstention' {
  return family === 'r1-unknown-range' || family === 'r2-inside-tolerance' ? 'abstention' : 'positive';
}

export function generateRangeCases(): ScoutCase[] {
  const out: ScoutCase[] = [];
  const questionTemplate: Record<string, ScoutQuestion> = {action: {type: 'choice', instructions: ACTION_QUESTION_INSTRUCTIONS, criteria: rangeActionCriteria()}};
  for (const split of ['development', 'confirmation'] as const) {
    const plan = split === 'development' ? DEV_PLAN : CONFIRM_PLAN;
    const unitDefs: {family: string; unit: string; mirrorable: boolean; build: () => RangeFacts}[] = [
      ...[0, 1, 2].map(v => ({family: 'r1-unknown-range', unit: `r1-${split}-${v}`, mirrorable: false, build: () => familyR1(plan, v)})),
      ...[0, 1, 2].map(v => ({family: 'r2-inside-tolerance', unit: `r2-${split}-${v}`, mirrorable: true, build: () => familyR2(plan, v)})),
      ...[0, 1].flatMap(scene => [0, 1].map(goal => ({family: 'r3-goal-swap', unit: `r3-${split}-${scene}-${goal}`, mirrorable: true, build: () => familyR3(plan, scene, goal)}))),
      ...[0, 1, 2].map(v => ({family: 'r4-near-threshold', unit: `r4-${split}-${v}`, mirrorable: true, build: () => familyR4(plan, v)})),
      ...[0, 1, 2].map(v => ({family: 'r5-wrong-side-trap', unit: `r5-${split}-${v}`, mirrorable: true, build: () => familyR5(plan, v)})),
    ];
    for (const def of unitDefs) for (const mirror of def.mirrorable ? [false, true] : [false]) {
      const built = def.build(), facts = mirror ? mirrorRangeFacts(built) : built;
      const oracle = rangeOracle(facts);
      for (const arm of RANGE_ARMS) {
        const state = renderRangeState(facts, arm);
        for (const replicate of [0, 1]) out.push({
          id: `${def.unit}-${mirror ? 'mirror' : 'orig'}-${arm}-r${replicate}`, hypothesis: 'R', split, family: def.family, unit: def.unit, mirror, arm, replicate,
          request: {model: 'jev-1.13.0', state: structuredClone(state), questions: structuredClone(questionTemplate)},
          expected: {action: [...oracle.useful]},
          meta: {
            caseKind: caseKindFor(def.family), mirrorable: def.mirrorable,
            rangeStatus: facts.rangeStatus, measuredRangeM: facts.measuredRangeM, goalM: facts.goalM, signedErrorM: oracle.signedErrorM,
            oracleUseful: oracle.useful, oracleAcceptable: oracle.acceptable, oracleHarmful: oracle.harmful,
            factsSha256: digest(JSON.stringify(facts)), sameFactsGroup: `${def.unit}-${mirror ? 'mirror' : 'orig'}`,
            source: 'Fresh stipulated range scenario; no prior campaign or held-out result reused.',
          },
        });
      }
    }
  }
  return out;
}
