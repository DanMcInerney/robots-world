/** S hypothesis: scouting-state encoding case generator. Fresh, entirely stipulated sector facts;
 * no sensor or model call occurs in this module. Facts are built once per (unit, mirror) and then
 * rendered four ways (current-only / view-history / sector-state / sector-consequences), so all four
 * arms share identical underlying facts and an identical 12-action menu; only the declared
 * representation factor differs. `component_goal` states the FULL scored policy identically in every
 * arm (the same text the oracle in oracle.ts implements), so the goal entails the scored criterion
 * instead of leaving it implicit (repair of the F52-style contradiction found in pre-inference review). */
import {digest} from '../jev-spatial-text/transport.ts';
import {
  CAMERA_HFOV_DEG, LAST_SEEN_STALE_MS, LAST_SEEN_TRUSTWORTHY_MS, MOVE_DISTANCE_M, N_SECTORS, SCOUT_ACTIONS,
  SCOUT_ACTION_IDS, scoutOracle, sectorCenterDeg, sectorIndexForHeading, coveredSectors, wrap360,
  type Clearance, type ScoutFacts, type SectorFact,
} from './oracle.ts';
import type {ScoutCase, ScoutQuestion} from './types.ts';

export const SCOUT_ARMS = ['current-only', 'view-history', 'sector-state', 'sector-consequences'] as const;
export type ScoutArm = typeof SCOUT_ARMS[number];
const TARGET_CLASSES = ['blue car', 'red backpack'];

const NOTICE = 'Invented synthetic scouting diagnostic. These values are stipulated fixture facts, not a current camera image, real acquisition, or Jev self-history. All questions are independent; sibling answers are unavailable.';
const FRAME = 'Heading uses the ENU plane: east is 0, north is +90, wrapped into [0,360). Positive yaw turns left. Every action, sector centre and resulting heading uses this same convention.';
const ACTION_QUESTION_INSTRUCTIONS = 'Choose the single action that satisfies the policy stated in state.component_goal, using only the facts in this state. Decide from this state independently of any other question.';
const SECTOR_MEMORY_NOTICE = 'Code-derived egocentric sector memory built only from own heading, camera field of view and stereo-derived nearest-surface clearance. This memory is anchored to the current position: it is not re-projected for own displacement between inspections, so a real implementation must age or invalidate entries as the platform moves. This is state, not a ranking or a recommendation.';
const CONSEQUENCE_SOURCE = 'Code-computed consequences for EVERY offered action under a stated immediate/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking, or a recommendation.';

function componentGoal(targetDescription: string): string {
  return `Choose the single action that satisfies this declared policy for finding or reconfirming the ${targetDescription}: `
    + `(1) If the target is confirmed visible right now, hold; every search or reposition action is wrong once it is already found. `
    + `(2) Otherwise, if a last-seen sighting is recorded and its age is at or below ${LAST_SEEN_TRUSTWORTHY_MS / 1000} s, choose the yaw action whose resulting heading brings that sighting's recorded bearing back inside the camera's field of view. A sighting older than ${LAST_SEEN_STALE_MS / 1000} s is not trustworthy and must be ignored even when no other lead exists. `
    + `(3) Otherwise, prefer the action that brings the most never-inspected heading (measured in degrees, not sector count) into the camera's field of view; do not choose an action that merely re-inspects sectors that are already inspected. `
    + `(4) If every reachable sector is already inspected, move only along a direction with measured OPEN clearance beyond the fixed move distance; moving into blocked or unknown clearance is never acceptable, in any case. `
    + `(5) If no direction is open and no never-inspected heading remains reachable, hold rather than commit to an unsupported move or a redundant re-scan.`;
}

function scoutActionCriteria(): Record<string, string> {
  return Object.fromEntries(Object.entries(SCOUT_ACTIONS).map(([id, def]) => {
    if (id === 'turn_180') return [id, 'Yaw the camera heading 180 degrees to face the opposite direction. Position and camera field of view are unchanged.'];
    if (def.kind === 'hold') return [id, 'Hold the current heading and position. Camera field of view is unchanged.'];
    if (def.kind === 'yaw') return [id, `Yaw the camera heading ${Math.abs(def.yawDeg!)} degrees ${def.yawDeg! > 0 ? 'left' : 'right'} from the current heading. Position and camera field of view are unchanged.`];
    const label = id === 'advance' ? 'forward (current heading direction)' : id === 'retreat' ? 'backward (opposite the current heading)'
      : id === 'strafe_left' ? 'sideways to the left (current heading + 90 degrees)' : 'sideways to the right (current heading - 90 degrees)';
    return [id, `Translate the platform ${MOVE_DISTANCE_M} m ${label}. Heading and camera field of view are unchanged.`];
  }));
}

// ---------- fact construction ----------
function blankSectors(defaultClearance: Clearance = {status: 'unknown'}): SectorFact[] {
  return Array.from({length: N_SECTORS}, (_, i) => ({index: i, centerHeadingDeg: sectorCenterDeg(i), inspectedAgeMs: 'never' as const, clearance: defaultClearance, candidate: null}));
}
function withOverrides(overrides: Record<number, Partial<SectorFact>>, defaultClearance?: Clearance): SectorFact[] {
  const base = blankSectors(defaultClearance);
  for (const [i, patch] of Object.entries(overrides)) base[Number(i)] = {...base[Number(i)]!, ...patch};
  return base;
}
function defaultReceipts(variant: number) {
  // Deliberately far more recent than any sector inspection age below, and never a translation command,
  // so receipts never contradict the sector-memory clock or imply an untracked position change.
  return [{command: 'yaw_left_30', accepted: true, appliedMsAgo: 2400 + variant * 100}, {command: 'hold', accepted: true, appliedMsAgo: 600 + variant * 50}];
}
/** Builds facts and enforces ONE coverage invariant: every sector currently in view (per the single
 * `coveredSectors` definition in oracle.ts) is inspected now (age 0) and is never "never" -- this is
 * what the F52-style contradiction in the pre-inference review violated (a currently-covered sector
 * rendered as "never" while a hold/consequence entry simultaneously claimed the camera covers it). */
function buildFacts(headingDeg: number, sectorsRaw: SectorFact[], targetDescription: string, targetCurrentlyVisible: boolean, receipts: ScoutFacts['receipts']): ScoutFacts {
  const heading = wrap360(headingDeg), sectors = sectorsRaw.map(s => ({...s}));
  for (const i of coveredSectors(heading, CAMERA_HFOV_DEG)) sectors[i] = {...sectors[i]!, inspectedAgeMs: 0};
  return {headingDeg: heading, cameraHfovDeg: CAMERA_HFOV_DEG, moveDistanceM: MOVE_DISTANCE_M, targetDescription, targetCurrentlyVisible, sectors, receipts};
}

// ---------- split-specific parameters: genuinely different draws, not one shifted by a constant ----------
type Direction = 'advance' | 'retreat' | 'strafe_left' | 'strafe_right';
type SplitPlan = {
  headingBase: number; variantStep: number;
  s1Offsets: readonly number[]; s2Offsets: readonly number[]; s3Directions: readonly Direction[];
  s4bNeverOffset: number; s4bStaleOffset: number; s4aInspectedOffset: number; s4cAgeStart: number; s4cAgeStep: number;
  ageStart: number; ageStep: number; targetStart: 0 | 1;
};
const DEV_PLAN: SplitPlan = {
  headingBase: 41, variantStep: 47,
  s1Offsets: [30, -60, 90], s2Offsets: [-30, 60, -90], s3Directions: ['advance', 'strafe_right', 'retreat'],
  s4bNeverOffset: 90, s4bStaleOffset: 30, s4aInspectedOffset: 36, s4cAgeStart: 7000, s4cAgeStep: 400,
  ageStart: 5000, ageStep: 450, targetStart: 0,
};
const CONFIRM_PLAN: SplitPlan = {
  headingBase: 206, variantStep: 71,
  s1Offsets: [180, -30, 60], s2Offsets: [90, -60, 30], s3Directions: ['strafe_left', 'advance', 'retreat'],
  s4bNeverOffset: -60, s4bStaleOffset: -150, s4aInspectedOffset: -36, s4cAgeStart: 9600, s4cAgeStep: -350,
  ageStart: 8200, ageStep: -380, targetStart: 1,
};
const targetFor = (plan: SplitPlan, variant: number) => TARGET_CLASSES[(plan.targetStart + variant) % TARGET_CLASSES.length]!;

// Family S1: never seen; some sectors inspected, others never -> useful = bring the most never-inspected
// degrees into view. Exactly one sector is left "never" (at a rotating, per-variant offset so no single
// yaw action is the universal answer), everything else is already inspected.
function familyS1(plan: SplitPlan, variant: number): ScoutFacts {
  const heading = wrap360(plan.headingBase + variant * plan.variantStep);
  const targetIdx = sectorIndexForHeading(heading + plan.s1Offsets[variant % plan.s1Offsets.length]!);
  const overrides: Record<number, Partial<SectorFact>> = {};
  for (let i = 0; i < N_SECTORS; i++) if (i !== targetIdx) overrides[i] = {inspectedAgeMs: plan.ageStart + i * plan.ageStep};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, variant), false, defaultReceipts(variant));
}
// Family S2: target seen earlier then lost, a trustworthy last-seen bearing+range is known -> useful =
// turn toward it. Every sector is already inspected, so sector novelty cannot also explain the answer.
function familyS2(plan: SplitPlan, variant: number): ScoutFacts {
  const heading = wrap360(plan.headingBase + variant * plan.variantStep);
  const bearingDeg = wrap360(heading + plan.s2Offsets[variant % plan.s2Offsets.length]!);
  const targetIdx = sectorIndexForHeading(bearingDeg);
  const overrides: Record<number, Partial<SectorFact>> = {};
  for (let i = 0; i < N_SECTORS; i++) overrides[i] = {inspectedAgeMs: 20000 + i * 1000};
  overrides[targetIdx] = {inspectedAgeMs: 12000, candidate: {description: targetFor(plan, variant), bearingDeg, rangeM: 11 + variant * 1.5, lastSeenAgeMs: 8000 + variant * 3000}};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, variant), false, defaultReceipts(variant));
}
// Family S3: all nearby sectors recently inspected, exactly one direction has open clearance beyond the
// fixed move distance -> useful = translate along the measured-open direction, not into blocked/unknown.
function familyS3(plan: SplitPlan, variant: number): ScoutFacts {
  const heading = wrap360(plan.headingBase + variant * plan.variantStep);
  const overrides: Record<number, Partial<SectorFact>> = {};
  for (let i = 0; i < N_SECTORS; i++) overrides[i] = {inspectedAgeMs: 5000 + i * 500, clearance: {status: 'blocked', atM: 1 + (i % 3) * 0.3, ageMs: 3000 + i * 200}};
  const chosen = plan.s3Directions[variant % plan.s3Directions.length]!;
  const offset = chosen === 'advance' ? 0 : chosen === 'retreat' ? 180 : chosen === 'strafe_left' ? 90 : -90;
  const openIdx = sectorIndexForHeading(wrap360(heading + offset));
  overrides[openIdx] = {...overrides[openIdx], clearance: {status: 'open', toM: 6, ageMs: 1800}};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, variant), false, defaultReceipts(variant));
}
// Family S4a (abstention trap): target already confirmed visible -> search actions are wrong; useful = hold.
function familyS4Visible(plan: SplitPlan): ScoutFacts {
  const heading = wrap360(plan.headingBase);
  const overrides: Record<number, Partial<SectorFact>> = {[sectorIndexForHeading(heading + plan.s4aInspectedOffset)]: {inspectedAgeMs: 6000}};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, 0), true, defaultReceipts(0));
}
// Family S4b (abstention trap): last-seen candidate is stale beyond the declared trustworthy age, and a
// never-inspected sector exists -> useful = the never-inspected sector, not the stale lead's bearing.
// The never sector's offset differs by split, so it is not always the 180-degree turn.
function familyS4Stale(plan: SplitPlan): ScoutFacts {
  const heading = wrap360(plan.headingBase);
  const neverIdx = sectorIndexForHeading(heading + plan.s4bNeverOffset), staleBearing = wrap360(heading + plan.s4bStaleOffset);
  const overrides: Record<number, Partial<SectorFact>> = {};
  for (let i = 0; i < N_SECTORS; i++) if (i !== neverIdx) overrides[i] = {inspectedAgeMs: 9000 + i * 300};
  overrides[sectorIndexForHeading(staleBearing)] = {...overrides[sectorIndexForHeading(staleBearing)], candidate: {description: targetFor(plan, 0), bearingDeg: staleBearing, rangeM: 14, lastSeenAgeMs: 120000}};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, 0), false, defaultReceipts(0));
}
// Family S4c (abstention trap): every sector already inspected and every clearance unknown -> advancing is
// unsupported; useful = hold.
function familyS4Unknown(plan: SplitPlan): ScoutFacts {
  const heading = wrap360(plan.headingBase);
  const overrides: Record<number, Partial<SectorFact>> = {};
  for (let i = 0; i < N_SECTORS; i++) overrides[i] = {inspectedAgeMs: plan.s4cAgeStart + i * plan.s4cAgeStep};
  return buildFacts(heading, withOverrides(overrides), targetFor(plan, 1), false, defaultReceipts(1));
}

const mirrorSectorIndex = (i: number) => (N_SECTORS - i) % N_SECTORS;
function mirrorCommandId(id: string) { return id.replace('left', 'TEMP').replace('right', 'left').replace('TEMP', 'right'); }
export function mirrorScoutFacts(facts: ScoutFacts): ScoutFacts {
  const mirrored: SectorFact[] = new Array(N_SECTORS);
  for (let i = 0; i < N_SECTORS; i++) {
    const j = mirrorSectorIndex(i), s = facts.sectors[i]!;
    mirrored[j] = {...s, index: j, centerHeadingDeg: sectorCenterDeg(j), candidate: s.candidate ? {...s.candidate, bearingDeg: wrap360(-s.candidate.bearingDeg)} : null};
  }
  return {...facts, headingDeg: wrap360(-facts.headingDeg), sectors: mirrored, receipts: facts.receipts.map(r => ({...r, command: mirrorCommandId(r.command)}))};
}

// ---------- rendering (declared factor only; oracle labels never appear here) ----------
function sectorStatus(s: SectorFact) { return s.inspectedAgeMs === 'never' ? ('never' as const) : {age_ms: s.inspectedAgeMs}; }
function consequenceEntry(facts: ScoutFacts, id: string) {
  const def = SCOUT_ACTIONS[id]!;
  if (def.kind === 'translate') {
    const dirHeading = wrap360(facts.headingDeg + def.directionOffsetDeg!), sectorIdx = sectorIndexForHeading(dirHeading);
    return {action: id, resulting_heading_deg: facts.headingDeg,
      camera_covers_sectors: coveredSectors(facts.headingDeg, facts.cameraHfovDeg).map(i => ({sector_index: i, never_or_age: sectorStatus(facts.sectors[i]!)})),
      movement_direction_clearance: facts.sectors[sectorIdx]!.clearance};
  }
  const resultingHeading = def.kind === 'hold' ? facts.headingDeg : wrap360(facts.headingDeg + def.yawDeg!);
  return {action: id, resulting_heading_deg: resultingHeading,
    camera_covers_sectors: coveredSectors(resultingHeading, facts.cameraHfovDeg).map(i => ({sector_index: i, never_or_age: sectorStatus(facts.sectors[i]!)})),
    movement_direction_clearance: null};
}
export function renderScoutState(facts: ScoutFacts, arm: ScoutArm) {
  const currentIdxs = new Set(coveredSectors(facts.headingDeg, facts.cameraHfovDeg));
  const state: any = {
    evidence_notice: NOTICE, frame: FRAME, component_goal: componentGoal(facts.targetDescription),
    current_view: {heading_deg: facts.headingDeg, camera_hfov_deg: facts.cameraHfovDeg, target_description: facts.targetDescription, target_visible_now: facts.targetCurrentlyVisible},
    command_receipts: facts.receipts,
  };
  if (arm === 'current-only') return state;
  if (arm === 'view-history') {
    state.declared_computation_notice = 'Chronological log of past inspected views only; sectors never yet inspected have no entry here. Each entry includes what stereo measured in that view (nearest-surface clearance) and any candidate seen there.';
    state.inspected_view_log = facts.sectors
      .filter(s => s.inspectedAgeMs !== 'never' && !currentIdxs.has(s.index))
      .sort((a, b) => (a.inspectedAgeMs as number) - (b.inspectedAgeMs as number))
      .map(s => ({heading_deg: s.centerHeadingDeg, camera_hfov_deg: facts.cameraHfovDeg, age_ms: s.inspectedAgeMs, measured_clearance: s.clearance,
        seen: s.candidate ? [{description: s.candidate.description, bearing_deg: s.candidate.bearingDeg, range_m: s.candidate.rangeM, age_ms: s.candidate.lastSeenAgeMs}] : 'no match for the target description'}));
    return state;
  }
  state.sector_memory_notice = SECTOR_MEMORY_NOTICE;
  state.sector_memory = facts.sectors.map(s => ({
    sector_index: s.index, center_heading_deg: s.centerHeadingDeg, inspected: sectorStatus(s), clearance: s.clearance,
    candidates: s.candidate ? [{description: s.candidate.description, bearing_deg: s.candidate.bearingDeg, range_m: s.candidate.rangeM, last_seen_age_ms: s.candidate.lastSeenAgeMs}] : [],
  }));
  if (arm === 'sector-state') return state;
  state.action_consequences = {source: CONSEQUENCE_SOURCE, per_option: SCOUT_ACTION_IDS.map(id => consequenceEntry(facts, id))};
  return state;
}

/** 'positive': a genuinely useful search/move action exists and is not merely holding/abstaining.
 * 'abstention': the family is an abstention/trap control (S4a/b/c). Used for separated gating. */
function caseKindFor(family: string): 'positive' | 'abstention' {
  return family === 's4-abstention-controls' ? 'abstention' : 'positive';
}

export function generateScoutCases(): ScoutCase[] {
  const out: ScoutCase[] = [];
  const questionTemplate: Record<string, ScoutQuestion> = {action: {type: 'choice', instructions: ACTION_QUESTION_INSTRUCTIONS, criteria: scoutActionCriteria()}};
  for (const split of ['development', 'confirmation'] as const) {
    const plan = split === 'development' ? DEV_PLAN : CONFIRM_PLAN;
    const unitDefs: {family: string; unit: string; build: () => ScoutFacts}[] = [
      ...[0, 1, 2].map(v => ({family: 's1-never-seen-partial', unit: `s1-${split}-${v}`, build: () => familyS1(plan, v)})),
      ...[0, 1, 2].map(v => ({family: 's2-seen-then-lost', unit: `s2-${split}-${v}`, build: () => familyS2(plan, v)})),
      ...[0, 1, 2].map(v => ({family: 's3-open-corridor', unit: `s3-${split}-${v}`, build: () => familyS3(plan, v)})),
      {family: 's4-abstention-controls', unit: `s4a-${split}`, build: () => familyS4Visible(plan)},
      {family: 's4-abstention-controls', unit: `s4b-${split}`, build: () => familyS4Stale(plan)},
      {family: 's4-abstention-controls', unit: `s4c-${split}`, build: () => familyS4Unknown(plan)},
    ];
    for (const def of unitDefs) for (const mirror of [false, true]) {
      const built = def.build(), facts = mirror ? mirrorScoutFacts(built) : built;
      const oracle = scoutOracle(facts);
      for (const arm of SCOUT_ARMS) {
        const state = renderScoutState(facts, arm);
        for (const replicate of [0, 1]) out.push({
          id: `${def.unit}-${mirror ? 'mirror' : 'orig'}-${arm}-r${replicate}`, hypothesis: 'S', split, family: def.family, unit: def.unit, mirror, arm, replicate,
          request: {model: 'jev-1.13.0', state: structuredClone(state), questions: structuredClone(questionTemplate)},
          expected: {action: [...oracle.useful]},
          meta: {
            caseKind: caseKindFor(def.family),
            headingDeg: facts.headingDeg, targetCurrentlyVisible: facts.targetCurrentlyVisible, targetDescription: facts.targetDescription,
            oracleUseful: oracle.useful, oracleAcceptable: oracle.acceptable, oracleHarmful: oracle.harmful,
            factsSha256: digest(JSON.stringify(facts)), sameFactsGroup: `${def.unit}-${mirror ? 'mirror' : 'orig'}`,
            source: 'Fresh stipulated sector-memory scenario; no prior campaign or held-out result reused.',
          },
        });
      }
    }
  }
  return out;
}
