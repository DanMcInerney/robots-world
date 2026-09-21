/**
 * Independent geometric oracle shared by every F1-F4 generator. Two domains only:
 *  - yaw: bearing_deg, positive = target right of the current heading. A yaw action's `delta` is the
 *    turn amount, positive = turn right. resulting_bearing = current_bearing - delta (turning right by
 *    `delta` reduces how far right the target appears).
 *  - range: range_m, distance to the target. A range action's `delta` is signed metres, positive =
 *    retreat (range increases), negative = approach (range decreases). resulting_range = current + delta.
 * Both domains reduce to the same shape: a symmetric ladder of actions around `hold` (delta 0), a
 * continuous current value, and a goal (a scalar, matched by 0 error, or a band, matched by 0 error
 * inside it). Only pure arithmetic; nothing here is a sensor or model call.
 */
import {digest} from '../jev-spatial-text/transport.ts';

const clean = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e6) / 1e6);

/** Deterministic seeded float in [0,1), derived by hashing the join of `parts` (SHA-256, first 8 hex
 * digits). A single step of a linear congruential generator is nearly linear in a linearly-increasing
 * seed (consecutive case indices produce barely-different outputs, which collapsed to duplicate request
 * bodies after rounding -- see docs/jev-encoding-rules-results.md limits); hashing decorrelates fully. */
export function seededFloat(...parts: (string | number | boolean)[]): number {
  const hex = digest(parts.join(':')).slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

export type Domain = 'yaw' | 'range';
export type Goal = number | {lowM: number; highM: number};
export type LadderOption = {id: string; delta: number};

/** Symmetric yaw ladder of `n` (odd) actions spread across a fixed +-60 degree window, so only
 * granularity (step size) changes with `n`, not total coverage. */
export function yawLadder(n: number): LadderOption[] {
  if (n % 2 !== 1 || n < 3) throw new Error('yawLadder requires an odd n >= 3');
  const half = (n - 1) / 2, step = 120 / (n - 1);
  const opts: LadderOption[] = [];
  for (let i = -half; i <= half; i++) {
    const delta = clean(i * step);
    opts.push({id: delta === 0 ? 'hold' : delta > 0 ? `yaw_right_${delta}` : `yaw_left_${-delta}`, delta});
  }
  return opts;
}
/** Symmetric range ladder of `n` (odd) actions spaced `step` metres apart around hold. */
export function rangeLadder(n: number, step: number): LadderOption[] {
  if (n % 2 !== 1 || n < 3) throw new Error('rangeLadder requires an odd n >= 3');
  const half = (n - 1) / 2;
  const opts: LadderOption[] = [];
  for (let i = -half; i <= half; i++) {
    const delta = clean(i * step);
    opts.push({id: delta === 0 ? 'hold' : delta > 0 ? `retreat_${delta}m` : `approach_${-delta}m`, delta});
  }
  return opts;
}
export function ladderFor(domain: Domain, opts: LadderOption[]): LadderOption[] { return opts; }

export function resultingValue(domain: Domain, current: number, delta: number): number {
  return domain === 'yaw' ? clean(current - delta) : clean(current + delta);
}
/** Signed error from the goal: negative means below/left, positive means above/right, 0 means at the
 * goal (or inside the band). Yaw's goal is always the scalar 0 (bearing centred = at the goal). */
export function signedError(resulting: number, goal: Goal): number {
  if (typeof goal === 'number') return clean(resulting - goal);
  if (resulting < goal.lowM) return clean(resulting - goal.lowM);
  if (resulting > goal.highM) return clean(resulting - goal.highM);
  return 0;
}

export type LadderRow = {id: string; delta: number; resulting: number; error: number; absError: number};
export type LadderOracle = {
  rows: LadderRow[];
  bestAbsError: number;
  useful: string[]; // argmin |error|, ties allowed
  harmful: string[]; // for deadband arms only: an action strictly worse than not acting is never produced here (F2/F3 have no unsafe option); kept for shape parity with F5+.
};
/** Core oracle: given the ladder, current value and goal, compute every option's resulting value/error
 * and the useful (argmin |error|) set. No deadband; deadband is layered on top by `applyDeadband`. */
export function ladderOracle(domain: Domain, ladder: LadderOption[], current: number, goal: Goal): LadderOracle {
  const rows: LadderRow[] = ladder.map(({id, delta}) => {
    const resulting = resultingValue(domain, current, delta), error = signedError(resulting, goal);
    return {id, delta, resulting, error, absError: Math.abs(error)};
  });
  const bestAbsError = Math.min(...rows.map(r => r.absError));
  const useful = rows.filter(r => r.absError <= bestAbsError + 1e-9).map(r => r.id);
  return {rows, bestAbsError, useful, harmful: []};
}
/** Declared deadband rule (F2): "if hold is within X of the best, choose hold instead." Only changes
 * `useful`; `rows`/`bestAbsError` (the raw computed facts) are unchanged so the deadband is purely a
 * decision-rule overlay on top of the same printed consequences. */
export function applyDeadband(oracle: LadderOracle, deadband: number): LadderOracle {
  const hold = oracle.rows.find(r => r.id === 'hold')!;
  if (hold.absError <= oracle.bestAbsError + deadband + 1e-9 && !oracle.useful.includes('hold')) {
    return {...oracle, useful: ['hold']};
  }
  return oracle;
}

/** Categorical label for form (c)/(d). Yaw: centred on 0; range: centred on a band (goal must be a band
 * for 'too_close'/'in_band'/'too_far' semantics -- callers pass a band goal even for the scalar-goal
 * arms by widening a point goal to a zero-width band, so the same function serves both). */
export function categoricalLabel(domain: Domain, row: LadderRow, goal: Goal): string {
  if (domain === 'yaw') return row.error === 0 ? 'inside_goal_band' : row.error > 0 ? 'outside_right' : 'outside_left';
  return row.error === 0 ? 'in_band' : row.error > 0 ? 'too_far' : 'too_close';
}
