/** F2: near-tie resolution. The two best options' |resulting error| differ by an exact declared margin
 * (0.1, 0.25, 0.5, 1, 2, 5), crossed with domain (yaw degrees / range metres), plus a deadband arm
 * where the policy text adds "if hold is within X of the best, choose hold instead." Every non-tested
 * option is placed comfortably far away so only the top two are ever competitive. */
import {yawLadder, rangeLadder, ladderOracle, applyDeadband, seededFloat, type Domain, type LadderOption} from './oracle.ts';
import {NOTICE, FRAME_YAW, FRAME_RANGE, CONSEQUENCE_SOURCE, goalText, policyText, yawActionCriteria, rangeActionCriteria, renderConsequence} from './render.ts';
import type {RuleCase} from './types.ts';

export const MARGINS = [0.1, 0.25, 0.5, 1, 2, 5] as const;
export const CASES_PER_ARM = 32;
const YAW_LADDER = yawLadder(7); // step 20 deg, margins up to 5 stay far from the next-nearest option
const RANGE_LADDER = rangeLadder(7, 8); // step 8 m
const DEADBAND_YAW = 1.5; // degrees

function ladderFor(domain: Domain): LadderOption[] { return domain === 'yaw' ? YAW_LADDER : RANGE_LADDER; }
function frameFor(domain: Domain) { return domain === 'yaw' ? FRAME_YAW : FRAME_RANGE; }
function criteriaFor(domain: Domain, ladder: LadderOption[]) { return domain === 'yaw' ? yawActionCriteria(ladder) : rangeActionCriteria(ladder); }

/** Constructs `current` so ladder[j] is the unique best and its margin to the true runner-up is exactly
 * `margin`. Tries both signs of the pivot's own resulting value since which neighbour straddles zero
 * depends on domain (yaw subtracts delta, range adds it) and on which side of the ladder j sits. */
function tuneMargin(domain: Domain, ladder: LadderOption[], j: number, margin: number): number {
  const step = ladder[1]!.delta - ladder[0]!.delta, v = (step - margin) / 2;
  for (const x of [v, -v]) {
    const current = domain === 'yaw' ? x + ladder[j]!.delta : x - ladder[j]!.delta;
    const oracle = ladderOracle(domain, ladder, current, 0);
    const sorted = [...oracle.rows].sort((a, b) => a.absError - b.absError);
    const achieved = sorted[1]!.absError - sorted[0]!.absError;
    // Tolerance above 1e-6: the oracle's own `clean()` rounds resulting values to 1e-6, which can put a
    // true match right at that boundary (observed: diff === 1.0000000...e-6, failing a strict < 1e-6).
    if (oracle.useful.length === 1 && oracle.useful[0] === ladder[j]!.id && Math.abs(achieved - margin) < 1e-4) return Math.round(current * 1000) / 1000;
  }
  throw new Error(`Could not construct margin ${margin} at pivot ${j} for ${domain}`);
}
/** +-5% relative jitter around a nominal margin, seeded by the case key. `ladder[j]` repeats every
 * `n` values of k (only n distinct pivots exist), so without this every k with the same (j mod n)
 * would build the byte-identical request; the jitter keeps the arm's NOMINAL margin (used for bucketing
 * and reporting) while making each case's real, code-computed margin distinct. */
function jitteredMargin(margin: number, ...key: (string | number | boolean)[]): number {
  // Relative +-5% plus a small absolute +-0.006 floor, so the smallest margin (0.1) still moves enough
  // to survive rounding `current` to 3 decimals (pure relative jitter on 0.1 is too small to do that).
  const relative = margin * (1 + (seededFloat(...key, 'rel') - 0.5) * 0.1);
  const absolute = (seededFloat(...key, 'abs') - 0.5) * 0.012;
  return Math.max(0.001, Math.round((relative + absolute) * 1e6) / 1e6);
}

function marginCase(domain: Domain, margin: number, k: number, mirror: boolean): RuleCase {
  const ladder = ladderFor(domain), n = ladder.length, j = k % n;
  const actualMargin = jitteredMargin(margin, 'f2-margin', domain, margin, k);
  let current = tuneMargin(domain, ladder, j, actualMargin);
  if (mirror) current = -current;
  const oracle = ladderOracle(domain, ladder, current, 0);
  const perOption = oracle.rows.map(r => renderConsequence(domain, r, 0, 'value'));
  const state = {
    notice: NOTICE, frame: frameFor(domain), goal: `Find and follow the target class at the goal. ${goalText(domain, 0)}`,
    current_view: domain === 'yaw' ? {target_bound: true, bearing_deg: current} : {target_bound: true, range_m: current},
    action_consequences: {source: CONSEQUENCE_SOURCE, per_option: perOption},
  };
  const questions = {action: {type: 'choice' as const, instructions: `${policyText(domain)} Use only the facts in this state; decide independently of any other question.`, criteria: criteriaFor(domain, ladder)}};
  const arm = `${domain}-margin-${margin}`, id = `f2-${arm}-k${k}-${mirror ? 'm' : 'o'}`;
  return {
    id, factor: 'F2', arm, family: 'near-tie-margin', seed: k, mirror,
    request: {model: 'jev-1.13.0', state, questions}, expected: oracle.useful, harmfulIds: [],
    meta: {domain, margin, actualMargin, current, pivot: j, rows: oracle.rows},
  };
}

const HOLD_INDEX = 3; // centre of a 7-option ladder
const WITHIN = [0.2, 0.5, 0.8, 1.1, 1.4];
const OUTSIDE = [1.8, 2.5, 3.5, 5, 7];
/** Unlike `tuneMargin` (which only needs SOME option exactly `margin` from the pivot, and does not care
 * which one), the deadband arm specifically needs HOLD to be the pivot's runner-up. `tuneMargin`'s
 * brute-force x=+-v trial can instead land on the ladder's OTHER neighbour (same achieved margin value,
 * by the ladder's uniform spacing, but the wrong option) -- observed directly: j=hold+1 with x=+v put
 * the far-side ladder neighbour 0.5 away and hold 20+ away. Picking x's sign from -sign(deltaJ) always
 * pushes the pivot's own resulting value back toward hold's side, so hold is the one exactly `margin` away. */
function tuneMarginAgainstHold(ladder: LadderOption[], j: number, margin: number): number {
  const deltaJ = ladder[j]!.delta, step = ladder[1]!.delta - ladder[0]!.delta, v = (step - margin) / 2;
  const current = -Math.sign(deltaJ) * v + deltaJ;
  const oracle = ladderOracle('yaw', ladder, current, 0);
  const sorted = [...oracle.rows].sort((a, b) => a.absError - b.absError);
  const achieved = sorted[1]!.absError - sorted[0]!.absError;
  if (oracle.useful.length !== 1 || oracle.useful[0] !== ladder[j]!.id || sorted[1]!.id !== 'hold' || Math.abs(achieved - margin) >= 1e-4) {
    throw new Error(`Could not construct a hold-runner-up margin ${margin} at pivot ${j}`);
  }
  return Math.round(current * 1000) / 1000;
}
function deadbandCase(k: number, within: boolean): RuleCase {
  const ladder = YAW_LADDER, group = within ? WITHIN : OUTSIDE, margin = group[k % group.length]!;
  const j = k % 2 === 0 ? HOLD_INDEX - 1 : HOLD_INDEX + 1, mirror = Math.floor(k / group.length) % 2 === 1;
  // Smaller jitter than the margin arms (+-2%): must not cross the WITHIN/OUTSIDE boundary at 1.4 vs 1.8.
  const actualMargin = Math.round(margin * (1 + (seededFloat('f2-deadband', k, within) - 0.5) * 0.04) * 1e6) / 1e6;
  let current = tuneMarginAgainstHold(ladder, j, actualMargin);
  if (mirror) current = -current;
  const raw = ladderOracle('yaw', ladder, current, 0);
  const withDeadband = applyDeadband(raw, DEADBAND_YAW);
  const perOption = raw.rows.map(r => renderConsequence('yaw', r, 0, 'value'));
  const state = {
    notice: NOTICE, frame: FRAME_YAW, goal: `Find and follow the target class at the goal. ${goalText('yaw', 0)}`,
    current_view: {target_bound: true, bearing_deg: current},
    action_consequences: {source: CONSEQUENCE_SOURCE, per_option: perOption},
  };
  const questions = {action: {type: 'choice' as const, instructions: `${policyText('yaw', DEADBAND_YAW)} Use only the facts in this state; decide independently of any other question.`, criteria: yawActionCriteria(ladder)}};
  const id = `f2-yaw-deadband-k${k}-${within ? 'within' : 'outside'}`;
  return {
    id, factor: 'F2', arm: 'yaw-deadband', family: 'deadband', seed: k, mirror,
    request: {model: 'jev-1.13.0', state, questions}, expected: withDeadband.useful, harmfulIds: [],
    meta: {domain: 'yaw', margin, actualMargin, deadband: DEADBAND_YAW, within, rawBest: raw.useful, pivot: j, rows: raw.rows},
  };
}

export function generateF2Cases(): RuleCase[] {
  const out: RuleCase[] = [];
  for (const domain of ['yaw', 'range'] as const) {
    for (const margin of MARGINS) {
      for (let k = 0; k < CASES_PER_ARM / 2; k++) { out.push(marginCase(domain, margin, k, false)); out.push(marginCase(domain, margin, k, true)); }
    }
  }
  for (let k = 0; k < 18; k++) out.push(deadbandCase(k, true));
  for (let k = 0; k < 18; k++) out.push(deadbandCase(k, false));
  return out;
}
