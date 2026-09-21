/** F3: consequence form. Per option, print (a) the resulting value, (b) the resulting absolute error
 * from the goal, (c) a code-computed categorical label with the value, or (d) value + error + label.
 * Crossed with goal kind: yaw against a scalar goal (bearing 0) and range against a band goal (7.5-9.5
 * m), so the "goal is a band, not zero" condition is covered without adding a third domain. */
import {yawLadder, rangeLadder, ladderOracle, seededFloat, type Domain, type Goal, type LadderOption} from './oracle.ts';
import {NOTICE, FRAME_YAW, FRAME_RANGE, CONSEQUENCE_SOURCE, goalText, policyText, yawActionCriteria, rangeActionCriteria, renderConsequence, type Form} from './render.ts';
import type {RuleCase} from './types.ts';

export const FORMS: Form[] = ['value', 'error', 'label', 'all'];
export const CASES_PER_ARM = 32;
const YAW_LADDER = yawLadder(7);
const RANGE_LADDER = rangeLadder(7, 8);
const RANGE_BAND = {lowM: 7.5, highM: 9.5};
const RANGE_ANCHOR = (RANGE_BAND.lowM + RANGE_BAND.highM) / 2;

function ladderFor(domain: Domain): LadderOption[] { return domain === 'yaw' ? YAW_LADDER : RANGE_LADDER; }
function goalFor(domain: Domain): Goal { return domain === 'yaw' ? 0 : RANGE_BAND; }
function anchorFor(domain: Domain): number { return domain === 'yaw' ? 0 : RANGE_ANCHOR; }
function frameFor(domain: Domain) { return domain === 'yaw' ? FRAME_YAW : FRAME_RANGE; }
function criteriaFor(domain: Domain, ladder: LadderOption[]) { return domain === 'yaw' ? yawActionCriteria(ladder) : rangeActionCriteria(ladder); }

function buildCase(domain: Domain, form: Form, k: number, mirror: boolean): RuleCase {
  const ladder = ladderFor(domain), goal = goalFor(domain), anchor = anchorFor(domain);
  const n = ladder.length, j = k % n, step = ladder[1]!.delta - ladder[0]!.delta;
  const jitterFrac = 0.1 + seededFloat('f3', domain, k, 'jitter') * 0.25, sign = seededFloat('f3', domain, k, 'sign') < 0.5 ? -1 : 1;
  const offset = sign * jitterFrac * (step / 2);
  let current = domain === 'yaw' ? anchor + offset + ladder[j]!.delta : anchor + offset - ladder[j]!.delta;
  if (mirror) current = 2 * anchor - current;
  current = Math.round(current * 100) / 100;

  const oracle = ladderOracle(domain, ladder, current, goal);
  const perOption = oracle.rows.map(r => renderConsequence(domain, r, goal, form));
  const state = {
    notice: NOTICE, frame: frameFor(domain), goal: `Find and follow the target class at the goal. ${goalText(domain, goal)}`,
    current_view: domain === 'yaw' ? {target_bound: true, bearing_deg: current} : {target_bound: true, range_m: current},
    action_consequences: {source: CONSEQUENCE_SOURCE, per_option: perOption},
  };
  const questions = {action: {type: 'choice' as const, instructions: `${policyText(domain)} Use only the facts in this state; decide independently of any other question.`, criteria: criteriaFor(domain, ladder)}};
  const arm = `${domain}-${form}`, id = `f3-${arm}-k${k}-${mirror ? 'm' : 'o'}`;
  return {
    id, factor: 'F3', arm, family: 'consequence-form', seed: k, mirror,
    request: {model: 'jev-1.13.0', state, questions}, expected: oracle.useful, harmfulIds: [],
    meta: {domain, form, current, pivot: j, goal, rows: oracle.rows},
  };
}

export function generateF3Cases(): RuleCase[] {
  const out: RuleCase[] = [];
  for (const domain of ['yaw', 'range'] as const) {
    for (const form of FORMS) {
      for (let k = 0; k < CASES_PER_ARM / 2; k++) { out.push(buildCase(domain, form, k, false)); out.push(buildCase(domain, form, k, true)); }
    }
  }
  return out;
}
