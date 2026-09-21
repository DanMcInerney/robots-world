/** Shared rendering helpers: notices, frame text, per-option consequence forms and policy text. Every
 * renderer here only ever prints a SYMMETRIC, per-option, unranked, code-computed fact -- the one
 * encoding the prior jev-scout-encodings work found reliable (see docs/jev-scout-encodings-results.md).
 * Nothing here ranks, recommends or leaks an oracle label into the rendered request. */
import type {Domain, Goal, LadderOption, LadderRow} from './oracle.ts';
import {categoricalLabel} from './oracle.ts';

export const NOTICE = 'Invented synthetic encoding-rules diagnostic for a wheeled camera platform. These values are stipulated fixture facts, not a current camera image, real acquisition, or Jev self-history. All questions are independent; sibling answers are unavailable.';
export const FRAME_YAW = 'Bearing is the target class\'s angular offset from the current heading, in degrees: positive = right of centre, negative = left of centre. A yaw_right_N action turns the heading N degrees right; yaw_left_N turns it N degrees left; hold keeps the current heading. This convention applies to every bearing field below unless a field explicitly states its own convention.';
export const FRAME_RANGE = 'Range is straight-line distance to the target class, in metres. A retreat_Nm action increases range by N m; approach_Nm decreases it by N m; hold keeps the current range.';
export const CONSEQUENCE_SOURCE = 'Code-computed consequences for EVERY offered action under a stated immediate/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking, or a recommendation.';

export function yawActionCriteria(ladder: LadderOption[]): Record<string, string> {
  return Object.fromEntries(ladder.map(({id, delta}) => [id,
    delta === 0 ? 'Hold the current heading. Position is unchanged.'
      : `Yaw the heading ${Math.abs(delta)} degrees ${delta > 0 ? 'right' : 'left'} from the current heading. Position is unchanged.`]));
}
export function rangeActionCriteria(ladder: LadderOption[]): Record<string, string> {
  return Object.fromEntries(ladder.map(({id, delta}) => [id,
    delta === 0 ? 'Hold the current range. Heading is unchanged.'
      : `Move directly ${delta > 0 ? 'away from' : 'toward'} the target by ${Math.abs(delta)} m, changing range by ${delta > 0 ? '+' : ''}${delta} m. Heading is unchanged.`]));
}

export function goalText(domain: Domain, goal: Goal): string {
  if (domain === 'yaw') return 'Goal bearing is 0 degrees (target centred on heading).';
  if (typeof goal === 'number') return `Goal range is ${goal} m.`;
  return `Goal range band is ${goal.lowM} m to ${goal.highM} m (any range inside this band counts as at the goal).`;
}
export function policyText(domain: Domain, deadband?: number): string {
  const base = domain === 'yaw'
    ? 'Choose the yaw action whose resulting bearing has the smallest absolute value.'
    : 'Choose the range action whose resulting distance has the smallest absolute error from the goal (an error of 0 means the resulting distance is inside the goal band).';
  return deadband == null ? base : `${base} Exception: if the hold action's resulting error is within ${deadband} of the smallest resulting error among all options, choose hold instead, to avoid chattering on a marginal improvement.`;
}

// ---------- per-option consequence forms (F3) ----------
export type Form = 'value' | 'error' | 'label' | 'all';
const valueField = (domain: Domain) => domain === 'yaw' ? 'resulting_bearing_deg' : 'resulting_range_m';
const errorField = (domain: Domain) => domain === 'yaw' ? 'abs_error_deg' : 'abs_error_m';

export function renderConsequence(domain: Domain, row: LadderRow, goal: Goal, form: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {action: row.id};
  if (form === 'value' || form === 'all') out[valueField(domain)] = row.resulting;
  if (form === 'error' || form === 'all') out[errorField(domain)] = row.absError;
  if (form === 'label' || form === 'all') { out.status = categoricalLabel(domain, row, goal); if (form === 'label') out[valueField(domain)] = row.resulting; }
  return out;
}

// ---------- numbers vs words (F4) ----------
export function signedNumberText(domain: Domain, value: number): string {
  return domain === 'yaw' ? `${value} degrees` : `${value} m`;
}
export function wordedDirectionText(domain: Domain, value: number): string {
  if (domain === 'yaw') return value === 0 ? 'on centre' : `${Math.abs(value)} degrees ${value > 0 ? 'right' : 'left'} of centre`;
  return value === 0 ? 'exactly at goal range' : `${Math.abs(value)} m ${value > 0 ? 'beyond' : 'short of'} goal range`;
}

// ---------- sign-convention trap (F4) ----------
/** Declares the reversed convention explicitly, right next to the normal one, matching the assignment's
 * "stated in the frame text" trap: a distractor field the decision never reads, with the OPPOSITE sign
 * of state.current_view.bearing_deg / the printed per-option consequences. */
export const FRAME_SIGN_TRAP = `${FRAME_YAW} A SEPARATE field, state.prior_correction_deg, uses the OPPOSITE convention from bearing_deg above: there, positive means LEFT and negative means RIGHT. prior_correction_deg is a past correction record only; it is not part of this decision and does not affect bearing_deg, action_consequences or the goal.`;
export function priorCorrectionField(value: number) { return {prior_correction_deg: value, prior_correction_note: 'Logged for reference only; not part of this decision.'}; }
