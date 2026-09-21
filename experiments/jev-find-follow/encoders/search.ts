/** search encoder: sector memory + per-option consequences for every option
 * (experiments/jev-scout-encodings/scout.ts's `sector-consequences`, the only S representation
 * with material directional competence: 29/36 then 21/36 positive at 36 deg HFOV, F75). Reimplemented
 * here against this engine's real 70 deg HFOV sector memory (sector-memory.ts), not imported,
 * since the static probe's fixed 36 deg assumption does not transfer.
 *
 * Adds the OPTIONAL variant this repo's own results doc proposed but never ran: a per-option
 * `new_never_inspected_deg` field (already computed internally, previously withheld from the
 * render) plus a state-level `never_inspected_heading_reachable_by_yaw_deg` flag, to test F75's
 * own hypothesis for the s3 failure (that `sector-consequences`'s per-option text told the model
 * everything about ONE option in isolation but never "is anything else better"). Selectable per
 * episode via `SEARCH_VARIANT`; the base arm renders neither field, matching the original probe.
 *
 * S1 assignment: two further variants close a DIFFERENT gap than F75's — not "is another option
 * better", but "sector memory has NOTHING local to a translate option at all" (moving does not
 * change which heading-sectors are inspected, so `sector-consequences`'s translate entries always
 * show the SAME `camera_covers_sectors` as staying still — see FAILURES.md's "6/24" translate-
 * along-open-corridor failure). `coverage-consequences` gives every option, translate included, its
 * own `new_area_seen_m2` from the new position-aware `coverage-memory.ts` grid. `coverage-only` is
 * the same underlying facts rendered with materially less text (no state-level memory table at
 * all — see the `isCoverage` block below), to test how little text the policy actually needs.
 * Declared design choice (the assignment text did not fully specify this split): BOTH coverage arms
 * render the SAME per-option fields (`new_area_seen_m2`, `last_seen_offset_deg`, `last_seen_age_ms`,
 * `clearance`) — dropping `last_seen_offset_deg` from `coverage-only` would reintroduce exactly the
 * cross-field-arithmetic bug this file's own NOTICE/history already fixed once (see engine-review-e1
 * finding 4 below). The one thing `coverage-only` cuts is the `coverage_memory` STATE-LEVEL summary
 * block (`coverage-consequences` prints `{cell_size_m, effective_range_m, cells_seen_count}`;
 * `coverage-only` prints nothing memory-shaped at state level) — mirroring `sector-consequences`
 * having a `sector_memory` table that `coverage-consequences`/`coverage-only` both never render (a
 * coverage grid at 18m range/2m cells is not a small fixed table like 12 sectors; a raw per-cell dump
 * was deliberately not added — `cells_seen_count` is the declared-cheap summary instead).
 */
import { SEARCH_MENU } from '../maneuver.ts';
import { coveredSectors, newNeverInspectedDeg, sectorIndexForHeading, type SectorMemoryConfig, type SectorMemoryState } from '../sector-memory.ts';
import { newAreaSeenM2, seenCellCount, type CoverageMemoryConfig, type CoverageMemoryState } from '../coverage-memory.ts';
import type { ChoiceQuestion, ClearanceStatus, DecisionRequest, EnvelopeBounds, Goal, LastSeenRecord, ManeuverDef, ManeuverMenu, OwnState } from '../types.ts';

export type SearchVariant = 'sector-consequences' | 'sector-consequences-never-inspected-deg' | 'coverage-consequences' | 'coverage-only';

// engine-review-e2 finding 6: "last_seen_offset_deg is never defined in the request text" — each
// per-option consequence block already carries `last_seen_offset_deg`/`last_seen_age_ms`
// (code-computed, per option — see the per-option builder below); this notice now states plainly
// what that field means so no consumer has to infer it.
const NOTICE = 'Code-derived egocentric sector memory built only from own heading, camera field of view and stereo-derived nearest-surface clearance. This memory is anchored to the episode origin and invalidated with own displacement (see sector-memory.ts); it is state, not a ranking or a recommendation. Each offered action below also carries a code-computed `last_seen_offset_deg`: how far that action\'s own resulting heading would land from the last-seen sighting\'s recorded WORLD bearing (wrapped to [-180,180]), and `last_seen_age_ms`, the sighting\'s own age at this instant — both null when there is no last-seen sighting at all.';
// S1: coverage variants never render sector_memory, so their notice describes the coverage grid
// instead (never both notices at once, and never a notice describing a table this request does not
// actually include).
const NOTICE_COVERAGE = 'Code-derived position-aware coverage memory (see coverage-memory.ts): a grid over the drone\'s own odometry frame marking ground that has been inside the camera field of view AND within the detector\'s effective range on some past frame. Not a ranking or a recommendation. Each offered action below carries a code-computed `new_area_seen_m2`: square metres of NOT-yet-seen ground that action\'s own predicted resulting position+heading would newly bring into view, and the same `last_seen_offset_deg`/`last_seen_age_ms` fields the sector-based encoder uses (how far that action\'s resulting heading would land from the last-seen sighting\'s recorded WORLD bearing, and that sighting\'s age; both null with no last-seen sighting). Translate actions also carry `clearance`: the measured nearest-surface reading along that action\'s own direction, or null when not applicable (every yaw/hold action) or unknown when no surface has been measured in that direction.';
const FRAME = 'Heading uses the ENU plane: east is 0, north is +90, wrapped into [0,360). Positive yaw turns left. Every action, sector centre and resulting heading uses this same convention.';
const ACTION_INSTRUCTIONS = 'Choose the single action that satisfies the policy stated in state.component_goal, using only the facts in this state.';
const CONSEQUENCE_SOURCE = 'Code-computed consequences for EVERY offered action under a stated immediate/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking, or a recommendation.';

function componentGoal(targetDescription: string, lastSeenTrustworthyMs: number, lastSeenStaleMs: number): string {
  // engine-review-e1 finding 9: `targetDescription` (goal.description, e.g. "the blue car") already
  // carries its own article — "reconfirming the ${targetDescription}" previously rendered "the the
  // blue car". No extra article prefix here.
  return `Choose the single action that satisfies this declared policy for finding or reconfirming ${targetDescription}: `
    + `(1) If the target is confirmed visible right now, hold; every search or reposition action is wrong once it is already found. `
    + `(2) Otherwise, if a last-seen sighting is recorded and its age is at or below ${lastSeenTrustworthyMs / 1000} s, choose the yaw action whose resulting heading brings that sighting's recorded bearing back inside the camera's field of view. A sighting older than ${lastSeenStaleMs / 1000} s is not trustworthy and must be ignored even when no other lead exists. `
    + `(3) Otherwise, prefer the action that brings the most never-inspected heading (measured in degrees, not sector count) into the camera's field of view; do not choose an action that merely re-inspects sectors that are already inspected. `
    + `(4) If every reachable sector is already inspected, move only along a direction with measured OPEN clearance beyond the fixed move distance; moving into blocked or unknown clearance is never acceptable, in any case. `
    + `(5) If no direction is open and no never-inspected heading remains reachable, hold rather than commit to an unsupported move or a redundant re-scan.`;
}

// S1: the coverage-consequences/coverage-only policy text, matching the assignment's own wording
// ("fresh last-seen lead first; otherwise choose the action with the largest new_area_seen_m2 among
// actions whose clearance is not blocked/unknown; hold only if nothing adds new area").
function componentGoalCoverage(targetDescription: string, lastSeenTrustworthyMs: number, lastSeenStaleMs: number): string {
  return `Choose the single action that satisfies this declared policy for finding or reconfirming ${targetDescription}: `
    + `(1) If the target is confirmed visible right now, hold; every search or reposition action is wrong once it is already found. `
    + `(2) Otherwise, if a last-seen sighting is recorded and its age is at or below ${lastSeenTrustworthyMs / 1000} s, choose the action whose resulting heading brings that sighting's recorded bearing back inside the camera's field of view (this is the fresh last-seen lead, and takes priority over new_area_seen_m2). A sighting older than ${lastSeenStaleMs / 1000} s is not trustworthy and must be ignored even when no other lead exists. `
    + `(3) Otherwise, among actions whose clearance is not blocked and not unknown (an action with no clearance reading at all — every yaw/hold/turn action — is never excluded by this rule; a translate action IS excluded when its own clearance reads blocked or unknown), choose the action with the largest new_area_seen_m2. `
    + `(4) If every eligible action's new_area_seen_m2 is 0 (nothing left would add new ground), hold rather than commit to a redundant re-scan or an unsupported move.`;
}

function actionCriteria(menu: ManeuverMenu): Record<string, string> {
  return Object.fromEntries(Object.entries(menu).map(([id, def]) => {
    if (id === 'turn_180') return [id, 'Yaw the camera heading 180 degrees to face the opposite direction. Position and camera field of view are unchanged.'];
    if (def.kind === 'hold') return [id, 'Hold the current heading and position. Camera field of view is unchanged.'];
    if (def.kind === 'yaw') return [id, `Yaw the camera heading ${Math.abs(def.yawDeg!)} degrees ${def.yawDeg! > 0 ? 'left' : 'right'} from the current heading. Position and camera field of view are unchanged.`];
    const offset = def.directionOffsetDeg!;
    const label = offset === 0 ? 'forward (current heading direction)' : offset === 180 ? 'backward (opposite the current heading)' : offset > 0 ? 'sideways to the left (current heading + 90 degrees)' : 'sideways to the right (current heading - 90 degrees)';
    return [id, `Translate the platform ${def.distanceM} m ${label}. Heading and camera field of view are unchanged.`];
  }));
}

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;
const wrap180 = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;
function sectorStatus(inspectedAgeMs: number | 'never') { return inspectedAgeMs === 'never' ? ('never' as const) : { age_ms: Math.round(inspectedAgeMs) }; }

export interface SearchEncoderInput {
  goal: Goal;
  ownState: OwnState;
  targetCurrentlyVisible: boolean;
  memory: SectorMemoryState;
  memoryConfig: SectorMemoryConfig;
  lastSeen: LastSeenRecord | null;
  lastSeenTrustworthyMs: number;
  lastSeenStaleMs: number;
  receipts: { command: string; appliedMsAgo: number; result: string }[];
  variant?: SearchVariant;
  /** Increment B1: state the operating envelope numerically in every goal sentence, matching
   * track.ts's own goal-sentence requirement (the ladder's "harmful events" section). Optional so
   * existing callers/tests built before this field existed stay valid (falls back to no envelope
   * clause rather than throwing). */
  envelope?: EnvelopeBounds;
  /** A7 (engine-review-e3 finding 7, "goal sentence omits episode length"): matches track.ts's own
   * addition. Optional; falls back to omitting the sentence, not a guessed duration. */
  episodeDurationMs?: number;
  /** S1: overrides the action menu (default `SEARCH_MENU` — byte-for-byte the original behaviour
   * for every existing caller that omits this). The l5/l8 search-encoding scenarios pass
   * `SEARCH_MENU_WIDE` (maneuver.ts) here, on ALL search-variant arms compared there, so the
   * encoding comparison never differs by action repertoire. */
  menu?: ManeuverMenu;
  /** S1: required when `variant` is `coverage-consequences` or `coverage-only`; unused (may be
   * omitted) for the two sector-based variants. */
  coverageMemory?: CoverageMemoryState;
  coverageMemoryConfig?: CoverageMemoryConfig;
}

function resultingHeadingFor(def: ManeuverDef, headingDeg: number): number {
  // engine-review-e2 finding 6: round every printed number (declare precision) — previously an
  // UNROUNDED predicted heading (episode.ts's predictPoseAt is pure float arithmetic, not rounded
  // like a real sensor reading) could render as e.g. "104.60000000000002".
  return round1(def.kind === 'hold' ? headingDeg : def.kind === 'yaw' ? wrap360(headingDeg + def.yawDeg!) : headingDeg);
}

/** S1: the translate-option analogue of `resultingHeadingFor` — a pure kinematic projection of
 * where this option's OWN predicted move would land the platform (same "predicted application
 * pose" convention episode.ts's `predictPoseAt` uses elsewhere in this engine), in the SAME
 * odometry-displacement frame `coverage-memory.ts`'s grid is anchored to. Non-translate options
 * (yaw/hold/turn_180) do not change position: returned unchanged. */
function resultingPositionFor(def: ManeuverDef, positionM: { x: number; y: number }, headingDeg: number): { x: number; y: number } {
  if (def.kind !== 'translate') return positionM;
  const dirRad = wrap360(headingDeg + (def.directionOffsetDeg ?? 0)) * Math.PI / 180;
  return { x: round1(positionM.x + Math.cos(dirRad) * def.distanceM!), y: round1(positionM.y + Math.sin(dirRad) * def.distanceM!) };
}

/** S1: the translate-option clearance every search variant reads (moved out of the per-option loop
 * below since both the sector-based and coverage-based branches now need it identically — "same
 * underlying facts across arms"). `null` for a non-translate option (no motion, hence no clearance
 * concept — never conflated with `{status:'unknown'}`, which means "translating, but nothing was
 * measured in that direction"). */
function translateClearance(def: ManeuverDef, headingDeg: number, memory: SectorMemoryState, memoryConfig: SectorMemoryConfig): ClearanceStatus | null {
  if (def.kind !== 'translate') return null;
  const dirHeading = wrap360(headingDeg + def.directionOffsetDeg!);
  const sectorIdx = sectorIndexForHeading(dirHeading, memoryConfig);
  return memory.sectors[sectorIdx]!.clearance;
}

export function buildSearchRequest(input: SearchEncoderInput): DecisionRequest {
  const { goal, ownState, memory, memoryConfig, lastSeen, receipts } = input;
  const variant = input.variant ?? 'sector-consequences';
  const isCoverage = variant === 'coverage-consequences' || variant === 'coverage-only';
  const menu = input.menu ?? SEARCH_MENU;
  const headingDeg = round1(wrap360(ownState.headingDeg));
  const currentIdxs = new Set(coveredSectors(headingDeg, memoryConfig));
  const state: Record<string, unknown> = {
    evidence_notice: isCoverage ? NOTICE_COVERAGE : NOTICE, frame: FRAME,
    component_goal: isCoverage ? componentGoalCoverage(goal.description, input.lastSeenTrustworthyMs, input.lastSeenStaleMs) : componentGoal(goal.description, input.lastSeenTrustworthyMs, input.lastSeenStaleMs),
    goal: `Find ${goal.description}.`
      + (input.episodeDurationMs !== undefined ? ` This episode lasts up to ${round1(input.episodeDurationMs / 1000)} s.` : '')
      // A7 (engine-review-e3: "0.30000000000000004m" unrounded-float finding, root-caused to
      // ladder-scenarios.ts's own envelope arithmetic and fixed there; round1 here too, defensively).
      + (input.envelope ? ` Operating envelope: altitude between ${round1(input.envelope.minAltitudeM)} m and ${round1(input.envelope.maxAltitudeM)} m, within ${round1(input.envelope.maxRadiusFromOriginM)} m of the episode's starting point. Do not exit this envelope.` : ''),
    current_view: { heading_deg: headingDeg, camera_hfov_deg: memoryConfig.cameraHfovDeg, target_description: goal.description, target_visible_now: input.targetCurrentlyVisible },
    command_receipts: receipts.slice(-2),
  };
  if (!isCoverage) {
    state.sector_memory = memory.sectors.map(s => ({
      sector_index: s.index, center_heading_deg: s.centerHeadingDeg, inspected: sectorStatus(s.inspectedAgeMs), clearance: s.clearance,
      // A7 (engine-review-e3 finding 7, "unrounded numbers reached Jev... in search sector_memory"):
      // bearing_deg/range_m here previously rendered raw float arithmetic unrounded (e.g.
      // "44.923971306708154", "13.1992") — round to the same declared precision every other printed
      // number in this file uses (round1: one decimal place).
      candidates: s.candidate ? [{ description: s.candidate.description, bearing_deg: round1(s.candidate.bearingDeg), range_m: s.candidate.rangeM === null ? null : round1(s.candidate.rangeM), last_seen_age_ms: Math.round(s.candidate.lastSeenAgeMs) }] : [],
    }));
  } else if (variant === 'coverage-consequences') {
    const coverageMemory = input.coverageMemory ?? { cells: new Map() };
    const coverageConfig = input.coverageMemoryConfig;
    if (!coverageConfig) throw new Error('coverageMemoryConfig is required for coverage-consequences/coverage-only');
    state.coverage_memory = { cell_size_m: coverageConfig.cellSizeM, effective_range_m: coverageConfig.effectiveRangeM, cells_seen_count: seenCellCount(coverageMemory) };
  }
  if (lastSeen) state.last_seen = { bearing_deg: round1(lastSeen.bearingDeg), range_m: lastSeen.rangeM === null ? null : round1(lastSeen.rangeM), age_ms: Math.round(lastSeen.ageMs), own_heading_deg_at_sighting: round1(lastSeen.ownHeadingDegAtSighting) };
  // engine-review-e1 finding 4: previously a reader had to subtract this option's
  // resulting_heading_deg from the separate state.last_seen.bearing_deg itself — cross-field
  // arithmetic Jev/reference should never be asked to do. CODE now computes, per option, how far
  // that option's resulting camera heading would land from the last-seen sighting's own recorded
  // WORLD bearing (wrapped to [-180,180]), plus the sighting's own age — so "does this option bring
  // the last-seen sighting back into view" is a single stated fact per option, not a derivation.
  const lastSeenOffsetDeg = (resultingHeading: number): number | null => lastSeen === null ? null : round1(wrap180(resultingHeading - lastSeen.bearingDeg));

  let perOption: Record<string, unknown>[];
  if (isCoverage) {
    const coverageMemory = input.coverageMemory ?? { cells: new Map() };
    const coverageConfig = input.coverageMemoryConfig;
    if (!coverageConfig) throw new Error('coverageMemoryConfig is required for coverage-consequences/coverage-only');
    const positionM = { x: round1(ownState.odometryDisplacementM.x), y: round1(ownState.odometryDisplacementM.y) };
    perOption = Object.entries(menu).map(([id, def]) => {
      const resultingHeading = resultingHeadingFor(def, headingDeg);
      const resultingPosition = resultingPositionFor(def, positionM, headingDeg);
      return {
        action: id, resulting_heading_deg: resultingHeading,
        new_area_seen_m2: newAreaSeenM2(coverageMemory, resultingPosition, resultingHeading, coverageConfig),
        clearance: translateClearance(def, headingDeg, memory, memoryConfig),
        last_seen_offset_deg: lastSeenOffsetDeg(resultingHeading),
        last_seen_age_ms: lastSeen ? Math.round(lastSeen.ageMs) : null,
      };
    });
  } else {
    perOption = Object.entries(menu).map(([id, def]) => {
      if (def.kind === 'translate') {
        const entry: Record<string, unknown> = {
          action: id, resulting_heading_deg: headingDeg,
          camera_covers_sectors: coveredSectors(headingDeg, memoryConfig).map(i => ({ sector_index: i, never_or_age: sectorStatus(memory.sectors[i]!.inspectedAgeMs) })),
          movement_direction_clearance: translateClearance(def, headingDeg, memory, memoryConfig),
          last_seen_offset_deg: lastSeenOffsetDeg(headingDeg),
          last_seen_age_ms: lastSeen ? Math.round(lastSeen.ageMs) : null,
        };
        if (variant === 'sector-consequences-never-inspected-deg') entry.new_never_inspected_deg = 0; // translation does not change heading/coverage
        return entry;
      }
      const resultingHeading = resultingHeadingFor(def, headingDeg);
      const entry: Record<string, unknown> = {
        action: id, resulting_heading_deg: resultingHeading,
        camera_covers_sectors: coveredSectors(resultingHeading, memoryConfig).map(i => ({ sector_index: i, never_or_age: sectorStatus(memory.sectors[i]!.inspectedAgeMs) })),
        movement_direction_clearance: null,
        last_seen_offset_deg: lastSeenOffsetDeg(resultingHeading),
        last_seen_age_ms: lastSeen ? Math.round(lastSeen.ageMs) : null,
      };
      if (variant === 'sector-consequences-never-inspected-deg') entry.new_never_inspected_deg = newNeverInspectedDeg(memory, memoryConfig, resultingHeading);
      return entry;
    });
  }
  state.action_consequences = { source: CONSEQUENCE_SOURCE, per_option: perOption };
  if (variant === 'sector-consequences-never-inspected-deg') {
    state.never_inspected_heading_reachable_by_yaw_deg = Object.entries(menu).some(([, def]) => def.kind === 'yaw' && newNeverInspectedDeg(memory, memoryConfig, resultingHeadingFor(def, headingDeg)) > 0);
  }
  const questions: Record<string, ChoiceQuestion> = { action: { type: 'choice', instructions: ACTION_INSTRUCTIONS, criteria: actionCriteria(menu) } };
  return { model: 'jev-1.13.0', state, questions };
}
const round1 = (x: number) => Math.round(x * 10) / 10;
