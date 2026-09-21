/** Position-aware coverage memory (S1 assignment item 1): a coarse 2-D grid, anchored at the
 * episode origin in the drone's own ODOMETRY frame (never simulator truth — same convention
 * sector-memory.ts already uses for its own origin/displacement bookkeeping), marking cells that
 * have fallen inside the camera FOV AND within the detector's effective range on some delivered
 * frame, with age.
 *
 * Complements sector-memory.ts rather than replacing it: sector memory answers "have I pointed the
 * camera that DIRECTION" (heading-only, no range component); coverage memory answers "have I stood
 * somewhere close enough, pointed the right way, to plausibly have DETECTED something at this
 * PLACE." The known gap this is meant to close (see experiments/jev-find-follow/FAILURES.md and the
 * S1 assignment): sector memory can never show a benefit for a TRANSLATE option (moving does not
 * change which heading-sectors are "inspected"), so a policy built only on it has nothing local to
 * the advance option to justify translating down an open corridor once every heading is already
 * inspected. Coverage memory gives translate options their own first-class consequence
 * (`newAreaSeenM2`): moving forward can bring NEW GROUND within FOV+range even when the heading
 * does not change.
 *
 * Same "define coverage once, use it everywhere" convention sector-memory.ts documents (its own
 * `coveredSectors`): `coveredCells` is the ONE shared definition used both by the state update
 * (what got marked seen this acquisition) and by every per-option predicted consequence (what
 * WOULD get marked seen under a hypothesized resulting pose) — a cell can never simultaneously
 * render "already seen" from the state and "new" from a per-option consequence.
 *
 * Declared limitations (stated, not silently assumed):
 *  - Cell-count based area (`count * cellSizeM^2`), not a sub-cell-accurate swept-area integral —
 *    a coarse-but-cheap approximation, matching sector-memory's own degree-based (not exact solid
 *    angle) area accounting.
 *  - `effectiveRangeM` is a SCENARIO PARAMETER (default 18m), deliberately a little inside the fake
 *    sensor v2's own measured hard detection-range cutoff (~21.6m, see FAILURES.md / WORKLOG.md) —
 *    crediting coverage only up to a conservative margin inside the real cutoff, not up to the
 *    cutoff itself, since detection recall is already falling well before the hard cutoff.
 *  - Like sector memory, this is NOT re-projected for drift correction beyond simple re-aging — a
 *    cell's "seen" fact ages out (removed) after `invalidateAfterMs`, exactly mirroring
 *    sector-memory's own re-scan horizon, for the same reason (a stale "I looked here once" fact
 *    should not be trusted indefinitely against a moving target).
 */
import { wrap360 } from './sector-memory.ts';

export interface CoverageMemoryConfig {
  cellSizeM: number;
  cameraHfovDeg: number;
  /** Scenario parameter — see module docstring. Default 18m. */
  effectiveRangeM: number;
  /** A cell's "seen" fact older than this many sim-ms is dropped (reported as not-yet-seen again),
   * mirroring sector-memory.ts's `invalidateAfterMs` re-scan horizon. */
  invalidateAfterMs: number;
}

export const DEFAULT_COVERAGE_MEMORY_CONFIG: CoverageMemoryConfig = Object.freeze({
  cellSizeM: 2, cameraHfovDeg: 70, effectiveRangeM: 18, invalidateAfterMs: 20_000,
});

export interface CoverageCell { cx: number; cy: number; lastSeenAgeMs: number }
export interface CoverageMemoryState { cells: ReadonlyMap<string, CoverageCell> }

const cellKey = (cx: number, cy: number) => `${cx},${cy}`;

export function cellIndexFor(positionM: { x: number; y: number }, config: CoverageMemoryConfig): { cx: number; cy: number } {
  return { cx: Math.floor(positionM.x / config.cellSizeM), cy: Math.floor(positionM.y / config.cellSizeM) };
}

export function createCoverageMemory(): CoverageMemoryState {
  return { cells: new Map() };
}

/** Cell indices whose CENTRE falls inside the camera wedge from `positionM` at `headingDeg`,
 * within `effectiveRangeM` — see module docstring's "define once, use everywhere" note. Scans only
 * a bounding box out to `effectiveRangeM` around `positionM` (bounded work per call: independent of
 * how large the episode's explored area has grown), not the whole grid. */
export function coveredCells(positionM: { x: number; y: number }, headingDeg: number, config: CoverageMemoryConfig): { cx: number; cy: number }[] {
  const half = config.cameraHfovDeg / 2;
  const rangeCells = Math.ceil(config.effectiveRangeM / config.cellSizeM) + 1;
  const center = cellIndexFor(positionM, config);
  const out: { cx: number; cy: number }[] = [];
  for (let dx = -rangeCells; dx <= rangeCells; dx++) {
    for (let dy = -rangeCells; dy <= rangeCells; dy++) {
      const cx = center.cx + dx, cy = center.cy + dy;
      const cellCenterX = (cx + 0.5) * config.cellSizeM, cellCenterY = (cy + 0.5) * config.cellSizeM;
      const ddx = cellCenterX - positionM.x, ddy = cellCenterY - positionM.y;
      const distM = Math.hypot(ddx, ddy);
      if (distM > config.effectiveRangeM) continue;
      const bearingDeg = wrap360(Math.atan2(ddy, ddx) * 180 / Math.PI);
      const delta = Math.abs(((bearingDeg - headingDeg + 540) % 360) - 180);
      if (delta > half) continue;
      out.push({ cx, cy });
    }
  }
  return out;
}

export function isCellSeen(state: CoverageMemoryState, cx: number, cy: number): boolean {
  return state.cells.has(cellKey(cx, cy));
}

/** Marks every cell currently covered (see `coveredCells`) as seen, age 0 — called once per
 * decision cycle's acquisition, mirroring `updateSectorMemory`. Previously-seen cells not currently
 * covered are left untouched here (their age advances separately, via `ageCoverageMemory`). */
export function updateCoverageMemory(state: CoverageMemoryState, positionM: { x: number; y: number }, headingDeg: number, config: CoverageMemoryConfig): CoverageMemoryState {
  const cells = new Map(state.cells);
  for (const { cx, cy } of coveredCells(positionM, headingDeg, config)) cells.set(cellKey(cx, cy), { cx, cy, lastSeenAgeMs: 0 });
  return { cells };
}

/** Advances every remembered cell's age by `elapsedMs`; drops (invalidates) any cell whose age
 * would exceed `invalidateAfterMs`, mirroring sector-memory.ts's `ageSectorMemory` re-scan horizon.
 * Call BEFORE `updateCoverageMemory` marks the currently-covered cells back to 0, same ordering
 * sector-memory.ts's own caller uses. */
export function ageCoverageMemory(state: CoverageMemoryState, elapsedMs: number, config: CoverageMemoryConfig): CoverageMemoryState {
  if (!(elapsedMs >= 0)) throw new Error('elapsedMs must be non-negative');
  const cells = new Map<string, CoverageCell>();
  for (const [key, cell] of state.cells) {
    const age = cell.lastSeenAgeMs + elapsedMs;
    if (age > config.invalidateAfterMs) continue;
    cells.set(key, { ...cell, lastSeenAgeMs: age });
  }
  return { cells };
}

/** The per-option consequence field the S1 assignment calls `new_area_seen_m2`: how many square
 * metres of CURRENTLY-NOT-SEEN grid would newly fall inside FOV+range if the platform were at
 * `resultPositionM`/`resultHeadingDeg` (a predicted APPLICATION pose — the same "predicted, not
 * observed" convention every other per-option consequence in this engine uses). Cell-count based;
 * see module docstring's declared limitation. */
export function newAreaSeenM2(state: CoverageMemoryState, resultPositionM: { x: number; y: number }, resultHeadingDeg: number, config: CoverageMemoryConfig): number {
  let count = 0;
  for (const { cx, cy } of coveredCells(resultPositionM, resultHeadingDeg, config)) if (!isCellSeen(state, cx, cy)) count++;
  return Math.round(count * config.cellSizeM * config.cellSizeM * 10) / 10;
}

/** Total cells currently remembered as seen (any age) — a compact state-level summary figure, used
 * by the `coverage-only` encoder arm so it can omit a full per-cell dump yet still let the reader
 * see memory is growing, and by the report/tests. */
export function seenCellCount(state: CoverageMemoryState): number {
  return state.cells.size;
}
