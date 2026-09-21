/** F1: yaw decision with 3, 5, 7, 11, 21 options, per-option resulting bearing (form 'value', the
 * established working encoding -- see docs/jev-scout-encodings-results.md). Only menu size/granularity
 * changes across arms; the underlying bearing draw and rule are identical in shape. */
import {yawLadder, ladderOracle, seededFloat} from './oracle.ts';
import {NOTICE, FRAME_YAW, CONSEQUENCE_SOURCE, goalText, policyText, yawActionCriteria, renderConsequence} from './render.ts';
import type {RuleCase} from './types.ts';

export const F1_MENU_SIZES = [3, 5, 7, 11, 21] as const;
export const CASES_PER_ARM = 32;

function buildCase(n: number, k: number, mirror: boolean): RuleCase {
  const ladder = yawLadder(n), step = 120 / (n - 1);
  const j = k % n;
  const jitterFrac = 0.15 + seededFloat('f1', n, k, 'jitter') * 0.2; // 0.15..0.35 of half-step: stays argmin==j, never near-tie
  const sign = seededFloat('f1', n, k, 'sign') < 0.5 ? -1 : 1;
  let bearing = Math.round((ladder[j]!.delta + sign * jitterFrac * (step / 2)) * 10) / 10;
  if (mirror) bearing = -bearing;

  const oracle = ladderOracle('yaw', ladder, bearing, 0);
  const perOption = oracle.rows.map(r => renderConsequence('yaw', r, 0, 'value'));
  const state = {
    notice: NOTICE, frame: FRAME_YAW, goal: `Find and follow the target class at bearing 0. ${goalText('yaw', 0)}`,
    current_view: {target_bound: true, bearing_deg: bearing},
    action_consequences: {source: CONSEQUENCE_SOURCE, per_option: perOption},
  };
  const questions = {action: {type: 'choice' as const, instructions: `${policyText('yaw')} Use only the facts in this state; decide independently of any other question.`, criteria: yawActionCriteria(ladder)}};
  const id = `f1-n${n}-k${k}-${mirror ? 'm' : 'o'}`;
  return {
    id, factor: 'F1', arm: `n${n}`, family: 'menu-size', seed: k, mirror,
    request: {model: 'jev-1.13.0', state, questions}, expected: oracle.useful, harmfulIds: [],
    meta: {n, step, targetIndex: j, bearing, rows: oracle.rows},
  };
}

export function generateF1Cases(): RuleCase[] {
  const out: RuleCase[] = [];
  for (const n of F1_MENU_SIZES) {
    for (let k = 0; k < CASES_PER_ARM / 2; k++) { out.push(buildCase(n, k, false)); out.push(buildCase(n, k, true)); }
  }
  return out;
}
