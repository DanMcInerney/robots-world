/** F4: numbers vs words and sign conventions. Same yaw facts and rule in every arm; only how the
 * per-option resulting bearing is expressed changes: signed number only, worded direction only, both,
 * or both plus an irrelevant distractor field that explicitly declares the OPPOSITE sign convention
 * (F4's sign-convention trap). */
import {yawLadder, ladderOracle, seededFloat} from './oracle.ts';
import {NOTICE, FRAME_YAW, FRAME_SIGN_TRAP, CONSEQUENCE_SOURCE, goalText, policyText, yawActionCriteria, wordedDirectionText, priorCorrectionField} from './render.ts';
import type {RuleCase} from './types.ts';

export const F4_ARMS = ['numbers', 'words', 'both', 'sign-trap'] as const;
export type F4Arm = typeof F4_ARMS[number];
export const CASES_PER_ARM = 32;
const LADDER = yawLadder(7);

function perOptionFor(arm: F4Arm, rows: ReturnType<typeof ladderOracle>['rows']) {
  return rows.map(r => {
    const out: Record<string, unknown> = {action: r.id};
    if (arm === 'numbers' || arm === 'both' || arm === 'sign-trap') out.resulting_bearing_deg = r.resulting;
    if (arm === 'words' || arm === 'both' || arm === 'sign-trap') out.resulting_bearing_worded = wordedDirectionText('yaw', r.resulting);
    return out;
  });
}

function buildCase(arm: F4Arm, k: number, mirror: boolean): RuleCase {
  const n = LADDER.length, j = k % n, step = 120 / (n - 1);
  // Keyed by k only (not `arm`): every F4 arm shares identical underlying bearing/facts for the same
  // k, so only the declared rendering (numbers/words/both/sign-trap) differs, per the one-factor design.
  const jitterFrac = 0.15 + seededFloat('f4', k, 'jitter') * 0.2, sign = seededFloat('f4', k, 'sign') < 0.5 ? -1 : 1;
  let bearing = Math.round((LADDER[j]!.delta + sign * jitterFrac * (step / 2)) * 10) / 10;
  if (mirror) bearing = -bearing;

  const oracle = ladderOracle('yaw', LADDER, bearing, 0);
  const perOption = perOptionFor(arm, oracle.rows);
  const state: Record<string, unknown> = {
    notice: NOTICE, frame: arm === 'sign-trap' ? FRAME_SIGN_TRAP : FRAME_YAW,
    goal: `Find and follow the target class at bearing 0. ${goalText('yaw', 0)}`,
    current_view: {target_bound: true, bearing_deg: bearing},
    action_consequences: {source: CONSEQUENCE_SOURCE, per_option: perOption},
  };
  if (arm === 'sign-trap') {
    // Distractor magnitude and sign are independent of `bearing`/`j`, so it never correlates with the answer.
    const distractValue = Math.round((seededFloat('f4', 'distractor', k, mirror) * 40 - 20) * 10) / 10;
    Object.assign(state, priorCorrectionField(distractValue));
  }
  const questions = {action: {type: 'choice' as const, instructions: `${policyText('yaw')} Use only the facts in this state; decide independently of any other question.`, criteria: yawActionCriteria(LADDER)}};
  const id = `f4-${arm}-k${k}-${mirror ? 'm' : 'o'}`;
  return {
    id, factor: 'F4', arm, family: 'numbers-words-sign', seed: k, mirror,
    request: {model: 'jev-1.13.0', state, questions}, expected: oracle.useful, harmfulIds: [],
    meta: {bearing, pivot: j, rows: oracle.rows},
  };
}

export function generateF4Cases(): RuleCase[] {
  const out: RuleCase[] = [];
  for (const arm of F4_ARMS) for (let k = 0; k < CASES_PER_ARM / 2; k++) { out.push(buildCase(arm, k, false)); out.push(buildCase(arm, k, true)); }
  return out;
}
