/**
 * Independent geometric/logical oracle for the S (scouting) and R (range-following) probes.
 * `label`/`useful`/`acceptable`/`harmful` are oracle-only outputs: renderers (scout.ts/range.ts) read
 * only the pure geometry helpers in this file (wrap360, circularDistanceDeg, overlapDeg, coveredSectors,
 * sectorIndexForHeading/CenterDeg, SCOUT_ACTIONS, RANGE_ACTIONS) to build request text; scoutOracle/
 * rangeOracle and their Label outputs are called only from case generators to populate `expected`/`meta`,
 * never copied into a rendered `request`. Tests assert that no oracle-only key leaks into a request and
 * that a key independently re-derived from the rendered text matches this oracle exactly (F52 repair).
 * All geometry is stipulated fixture arithmetic, not a sensor or a model call.
 */

// ---------- shared geometry ----------
export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;
const clean = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e9) / 1e9);
export function circularDistanceDeg(a: number, b: number): number {
  const d = Math.abs(wrap360(a) - wrap360(b));
  return clean(Math.min(d, 360 - d));
}
/** Overlap, in degrees, of two angular intervals of width wA/wB centred distance d apart on a circle. */
export function overlapDeg(centerA: number, centerB: number, widthA: number, widthB: number): number {
  const d = circularDistanceDeg(centerA, centerB);
  return clean(Math.max(0, Math.min(widthA, widthB, (widthA + widthB) / 2 - d)));
}

// ---------- S: sector-memory scouting oracle ----------
export const N_SECTORS = 10;
export const SECTOR_WIDTH_DEG = 360 / N_SECTORS; // 36 degrees
export const CAMERA_HFOV_DEG = 36; // == sector width, so "covers sector k" stays unambiguous
export const MOVE_DISTANCE_M = 2;
export const LAST_SEEN_TRUSTWORTHY_MS = 30_000;
export const LAST_SEEN_STALE_MS = 90_000;
/** A sector's centre counts as "in view" iff within half the camera FOV of the heading. This ONE
 * definition is used for: which sectors are currently inspected (age 0) when facts are built, which
 * sectors a `sector-consequences` entry reports as covered, and the last-seen-candidate FOV check. */
export function coveredSectors(headingDeg: number, hfovDeg = CAMERA_HFOV_DEG): number[] {
  const half = hfovDeg / 2, out: number[] = [];
  for (let i = 0; i < N_SECTORS; i++) if (circularDistanceDeg(headingDeg, sectorCenterDeg(i)) <= half + 1e-9) out.push(i);
  return out;
}
export function sectorIndexForHeading(headingDeg: number): number {
  return Math.floor(wrap360(headingDeg + SECTOR_WIDTH_DEG / 2) / SECTOR_WIDTH_DEG) % N_SECTORS;
}
export function sectorCenterDeg(index: number): number {
  return wrap360(index * SECTOR_WIDTH_DEG);
}

export const SCOUT_ACTIONS: Record<string, {kind: 'yaw' | 'hold' | 'translate'; yawDeg?: number; directionOffsetDeg?: number}> = {
  yaw_left_30: {kind: 'yaw', yawDeg: 30}, yaw_left_60: {kind: 'yaw', yawDeg: 60}, yaw_left_90: {kind: 'yaw', yawDeg: 90},
  turn_180: {kind: 'yaw', yawDeg: 180},
  yaw_right_30: {kind: 'yaw', yawDeg: -30}, yaw_right_60: {kind: 'yaw', yawDeg: -60}, yaw_right_90: {kind: 'yaw', yawDeg: -90},
  hold: {kind: 'hold'},
  advance: {kind: 'translate', directionOffsetDeg: 0}, retreat: {kind: 'translate', directionOffsetDeg: 180},
  strafe_left: {kind: 'translate', directionOffsetDeg: 90}, strafe_right: {kind: 'translate', directionOffsetDeg: -90},
};
export const SCOUT_ACTION_IDS = Object.keys(SCOUT_ACTIONS);

export type Clearance =
  | {status: 'open'; toM: number; ageMs: number}
  | {status: 'blocked'; atM: number; ageMs: number}
  | {status: 'unknown'};
export type SectorFact = {
  index: number; centerHeadingDeg: number;
  inspectedAgeMs: number | 'never';
  clearance: Clearance;
  candidate: {description: string; bearingDeg: number; rangeM: number; lastSeenAgeMs: number} | null;
};
export type ScoutFacts = {
  headingDeg: number; cameraHfovDeg: number; moveDistanceM: number;
  targetDescription: string; targetCurrentlyVisible: boolean;
  sectors: SectorFact[]; // length N_SECTORS, index i centered at sectorCenterDeg(i)
  receipts: {command: string; accepted: boolean; appliedMsAgo: number}[];
};
export type Label = 'useful' | 'acceptable' | 'harmful' | 'neutral';
type ScoutActionOutcome = {
  resultingHeadingDeg: number; newlyNeverDeg: number;
  movementSector: number | null; movementClearance: Clearance | null; label: Label;
};

function scoutActionOutcome(facts: ScoutFacts, actionId: string, neverSectors: SectorFact[]): ScoutActionOutcome {
  const def = SCOUT_ACTIONS[actionId]!;
  if (def.kind === 'translate') {
    const dirHeading = wrap360(facts.headingDeg + def.directionOffsetDeg!);
    const movementSector = sectorIndexForHeading(dirHeading);
    return {resultingHeadingDeg: facts.headingDeg, newlyNeverDeg: 0, movementSector, movementClearance: facts.sectors[movementSector]!.clearance, label: 'neutral'};
  }
  const resultingHeadingDeg = def.kind === 'hold' ? facts.headingDeg : wrap360(facts.headingDeg + def.yawDeg!);
  // Never-inspected sectors have, by the buildFacts invariant, zero overlap with the ORIGINAL heading, so
  // every degree of overlap with the RESULTING heading is newly brought into view; no separate exclusion set is needed.
  const newlyNeverDeg = neverSectors.reduce((sum, s) => sum + overlapDeg(resultingHeadingDeg, s.centerHeadingDeg, facts.cameraHfovDeg, SECTOR_WIDTH_DEG), 0);
  return {resultingHeadingDeg, newlyNeverDeg: clean(newlyNeverDeg), movementSector: null, movementClearance: null, label: 'neutral'};
}

/**
 * Single predeclared rule set, applied identically across every S case family (see SCOUT_COMPONENT_GOAL
 * in scout.ts for the plain-language statement of this same policy, rendered identically in every arm):
 *  1. Target currently visible -> hold is useful, every other action is harmful (hand off, do not search).
 *  2. Else a trustworthy (<=30s) last-seen candidate exists -> useful = yaw actions whose resulting heading
 *     brings the candidate's recorded BEARING inside the camera FOV (not merely "same sector"). A stale
 *     (>90s) candidate is never "trustworthy" and is ignored, falling through to rule 3.
 *  3. Else, if some action would newly bring never-inspected HEADING (in degrees, not sector count) into
 *     view, useful = the action(s) maximising that degree total (ties allowed); positive-but-not-maximal
 *     coverage is "acceptable".
 *  4. Else every reachable sector is already inspected: useful = a translation into OPEN clearance beyond
 *     the fixed move distance; if no direction is open, useful = hold (advancing is unsupported).
 *  5. In EVERY branch, a translation into blocked-or-unknown clearance is harmful, uniformly (final pass).
 */
export function scoutOracle(facts: ScoutFacts) {
  if (facts.sectors.length !== N_SECTORS) throw new Error(`Expected ${N_SECTORS} sectors, got ${facts.sectors.length}`);
  const neverSectors = facts.sectors.filter(s => s.inspectedAgeMs === 'never');
  const perAction: Record<string, ScoutActionOutcome> = {};
  for (const id of SCOUT_ACTION_IDS) perAction[id] = scoutActionOutcome(facts, id, neverSectors);

  if (facts.targetCurrentlyVisible) {
    for (const id of SCOUT_ACTION_IDS) perAction[id]!.label = id === 'hold' ? 'useful' : 'harmful';
  } else {
    const half = facts.cameraHfovDeg / 2;
    const trustworthy = facts.sectors.find(s => s.candidate && s.candidate.lastSeenAgeMs <= LAST_SEEN_TRUSTWORTHY_MS);
    if (trustworthy) {
      const bearing = trustworthy.candidate!.bearingDeg;
      for (const id of SCOUT_ACTION_IDS) {
        const def = SCOUT_ACTIONS[id]!, v = perAction[id]!;
        if (def.kind === 'translate') { v.label = 'neutral'; continue; }
        v.label = circularDistanceDeg(v.resultingHeadingDeg, bearing) <= half + 1e-9 ? 'useful' : id === 'hold' ? 'neutral' : 'harmful';
      }
    } else {
      const maxNeverDeg = Math.max(0, ...Object.values(perAction).map(v => v.newlyNeverDeg));
      if (maxNeverDeg > 1e-6) {
        for (const id of SCOUT_ACTION_IDS) {
          const v = perAction[id]!;
          v.label = v.newlyNeverDeg >= maxNeverDeg - 1e-6 ? 'useful' : v.newlyNeverDeg > 1e-6 ? 'acceptable' : 'neutral';
        }
      } else {
        for (const id of SCOUT_ACTION_IDS) {
          const def = SCOUT_ACTIONS[id]!, v = perAction[id]!;
          v.label = def.kind === 'translate'
            ? (v.movementClearance?.status === 'open' && v.movementClearance.toM > facts.moveDistanceM ? 'useful' : 'neutral')
            : (id === 'hold' ? 'acceptable' : 'neutral');
        }
        if (!Object.values(perAction).some(v => v.label === 'useful')) perAction.hold!.label = 'useful';
      }
    }
  }
  // Uniform final pass (rule 5): moving into blocked/unknown clearance is harmful, in every branch, with no exception.
  for (const id of SCOUT_ACTION_IDS) {
    const def = SCOUT_ACTIONS[id]!, v = perAction[id]!;
    if (def.kind === 'translate' && v.movementClearance && v.movementClearance.status !== 'open') v.label = 'harmful';
  }
  const byLabel = (label: Label) => Object.entries(perAction).filter(([, v]) => v.label === label).map(([id]) => id);
  return {perAction, useful: byLabel('useful'), acceptable: [...byLabel('useful'), ...byLabel('acceptable')], harmful: byLabel('harmful')};
}

// ---------- R: range-following oracle ----------
export const RANGE_ACTIONS: Record<string, number> = {approach_2m: -2, approach_1m: -1, hold: 0, retreat_1m: 1, retreat_2m: 2};
export const RANGE_ACTION_IDS = Object.keys(RANGE_ACTIONS);
export const RANGE_TOLERANCE_M = 0.5;

export type RangeFacts = {
  rangeStatus: 'valid' | 'unavailable' | 'ambiguous'; measuredRangeM: number | null; goalM: number; targetDescription: string;
};
/**
 * Predeclared rule (matches the plan exactly): invalid/unavailable range -> useful = hold, every
 * movement harmful (unsupported commitment). Otherwise: useful = the action(s) minimising |resulting
 * error| (ties allowed); harmful = an action that INCREASES |resulting error| beyond the current value;
 * an action (including hold) that neither improves nor worsens it is neutral, never harmful — holding
 * outside tolerance is not penalised merely for failing to be optimal.
 */
export function rangeOracle(facts: RangeFacts) {
  const perAction: Record<string, {resultingRangeM: number | null; resultingErrorM: number | null; label: Label}> = {};
  if (facts.rangeStatus !== 'valid' || facts.measuredRangeM == null) {
    for (const id of RANGE_ACTION_IDS) perAction[id] = {resultingRangeM: null, resultingErrorM: null, label: id === 'hold' ? 'useful' : 'harmful'};
  } else {
    const measured = facts.measuredRangeM, signedErrorM = clean(measured - facts.goalM), currentAbs = Math.abs(signedErrorM);
    for (const [id, delta] of Object.entries(RANGE_ACTIONS)) {
      const resultingRangeM = clean(measured + delta), resultingErrorM = clean(resultingRangeM - facts.goalM);
      perAction[id] = {resultingRangeM, resultingErrorM, label: 'neutral'};
    }
    const best = Math.min(...Object.values(perAction).map(v => Math.abs(v.resultingErrorM!)));
    for (const id of RANGE_ACTION_IDS) {
      const v = perAction[id]!, abs = Math.abs(v.resultingErrorM!);
      v.label = abs <= best + 1e-9 ? 'useful' : abs < currentAbs - 1e-9 ? 'acceptable' : abs > currentAbs + 1e-9 ? 'harmful' : 'neutral';
    }
  }
  const byLabel = (label: Label) => Object.entries(perAction).filter(([, v]) => v.label === label).map(([id]) => id);
  return {
    perAction, useful: byLabel('useful'), acceptable: [...byLabel('useful'), ...byLabel('acceptable')], harmful: byLabel('harmful'),
    signedErrorM: facts.rangeStatus === 'valid' && facts.measuredRangeM != null ? clean(facts.measuredRangeM - facts.goalM) : null,
  };
}
