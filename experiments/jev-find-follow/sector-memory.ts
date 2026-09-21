/** Egocentric sector memory, matching experiments/jev-scout-encodings/oracle.ts's S-study
 * semantics (per sector: last-inspected age/never, nearest-surface clearance where measured else
 * unknown, candidates last seen) but reimplemented here — not imported — because the real sensor's
 * HFOV is 70 degrees, not that static probe's assumed 36 (an independent review of the existing
 * designs found this transfer gap: "the probe assumes 36 deg HFOV and ten 36 deg sectors; the real
 * sensor has 70"). Sector count/width are configuration here, defaulting to 30 degrees per sector
 * (matching integrations/stereo-objects.ts's AppearanceTracker default bearing bucket, for one
 * consistent spatial granularity across this engine), giving multiple sectors per camera view
 * rather than one sector == one FOV-width as the static probe assumed.
 *
 * Memory is anchored to the episode's start position and invalidated/aged with own displacement:
 * a sector's inspected age keeps counting even while covered (own-motion changes which sectors are
 * currently covered), and clearance/candidate entries older than a declared horizon are treated as
 * unknown rather than trusted indefinitely, since this memory is not re-projected for lateral
 * displacement (the oracle's own declared limitation, preserved here rather than silently fixed).
 */
import type { ClearanceStatus, SectorCandidate, SectorFact, StereoObject } from './types.ts';

export interface SectorMemoryConfig {
  sectorWidthDeg: number;
  cameraHfovDeg: number;
  /** A sector's clearance/candidate entry older than this many sim-ms (or measured before more
   * than this much own-displacement has since occurred) is presented as unknown/never rather than
   * a stale-but-still-asserted fact. */
  invalidateAfterMs: number;
  invalidateAfterDisplacementM: number;
}
// engine-review-e1 finding 5: at the original 60s horizon, one missed detection in a sector could
// "park" the search policy for tens of seconds (measured: 41s) — a sector marked inspected stayed
// trusted long after it stopped being a reliable fact. 12s (a short re-scan horizon, comfortably
// above one decision period so it does not thrash, comfortably below the old 60s) means a sector
// the reference/Jev is not actively re-covering ages back out to "never" within a few search
// cycles, forcing periodic re-scanning instead of a one-shot inspection being trusted indefinitely.
export const DEFAULT_SECTOR_MEMORY_CONFIG: SectorMemoryConfig = Object.freeze({
  sectorWidthDeg: 30, cameraHfovDeg: 70, invalidateAfterMs: 12_000, invalidateAfterDisplacementM: 8,
});

export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

export function sectorCount(config: SectorMemoryConfig): number {
  const n = Math.round(360 / config.sectorWidthDeg);
  if (n < 3 || n > 72) throw new Error('sectorWidthDeg must yield between 3 and 72 sectors');
  return n;
}
export function sectorCenterDeg(index: number, config: SectorMemoryConfig): number {
  return wrap360(index * (360 / sectorCount(config)));
}
export function sectorIndexForHeading(headingDeg: number, config: SectorMemoryConfig): number {
  const n = sectorCount(config), width = 360 / n;
  return Math.round(wrap360(headingDeg) / width) % n;
}
/** Sectors whose centre falls within half the camera FOV of `headingDeg` — the one shared
 * definition used by fact construction and by every rendered consequence (oracle.ts's F52-repair
 * convention: define coverage once, use it everywhere, so a covered sector can never simultaneously
 * render "never inspected"). */
export function coveredSectors(headingDeg: number, config: SectorMemoryConfig): number[] {
  const n = sectorCount(config), half = config.cameraHfovDeg / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const delta = Math.abs(((sectorCenterDeg(i, config) - headingDeg + 540) % 360) - 180);
    if (delta <= half) out.push(i);
  }
  return out;
}

/** engine-review-e1 finding 5: "clearance is never measured." Derives a clearance measurement PER
 * SECTOR from the SAME sensor objects the binder already reads: each object is placed into the
 * sector its OWN bearing falls in (own heading + camera-relative bearing -> absolute heading ->
 * `sectorIndexForHeading`), and that sector's clearance is the nearest valid stereo surface range
 * AMONG OBJECTS ACTUALLY MEASURED IN IT (any class, not just the goal's — a real obstacle/surface
 * does not have to match the goal to be a clearance hazard). `moveDistanceM` is the fixed
 * translate-menu step this clearance decides against (an "open" reading requires the nearest
 * surface to be farther than that step).
 *
 * engine-review-e2 finding 6: previously ONE aggregate "nearest object anywhere in the frame"
 * value was applied to EVERY currently-covered sector — a sector at the edge of the camera's view
 * could read "blocked" because of an object measured only in a DIFFERENT sector near the centre.
 * Sectors covered by the camera but with no object actually measured in their own angular range
 * report `unknown` here (the caller — `updateSectorMemory` — still marks them freshly INSPECTED,
 * age 0, since the camera genuinely looked there; it simply has no clearance evidence for that
 * specific direction this acquisition).
 *
 * Declared limits (stated, not silently assumed): this reuses the sensor's own per-object
 * mask-median surface range, which is a DETECTED-OBJECT measurement, not a dense depth scan of the
 * whole sector — a real hazard with no detectable class label (e.g. a bare wall/pole outside the
 * detector's known classes) is invisible to this clearance signal, exactly as F45/F56/F58 found
 * for thin/unlabelled hazards; thin hazards remain explicitly out of scope. When no object is
 * measured in a sector's own bearing range, that sector's clearance is `unknown`, never guessed. */
export function deriveClearance(objects: readonly StereoObject[], moveDistanceM: number, ownHeadingDeg: number, config: SectorMemoryConfig): Map<number, ClearanceStatus> {
  const bySector = new Map<number, number[]>();
  for (const o of objects) {
    if (!o.rangeValid || o.surfaceRangeM === null) continue;
    const absoluteBearingDeg = wrap360(ownHeadingDeg - o.bearingRightRad * 180 / Math.PI);
    const idx = sectorIndexForHeading(absoluteBearingDeg, config);
    const list = bySector.get(idx) ?? [];
    list.push(o.surfaceRangeM);
    bySector.set(idx, list);
  }
  const result = new Map<number, ClearanceStatus>();
  for (const [idx, ranges] of bySector) {
    const nearestM = Math.min(...ranges);
    result.set(idx, nearestM > moveDistanceM ? { status: 'open', toM: Math.round(nearestM * 10) / 10, ageMs: 0 } : { status: 'blocked', atM: Math.round(nearestM * 10) / 10, ageMs: 0 });
  }
  return result;
}

export interface SectorMemoryState { sectors: SectorFact[]; originPosition: { x: number; y: number } }

export function createSectorMemory(config: SectorMemoryConfig = DEFAULT_SECTOR_MEMORY_CONFIG, originPosition = { x: 0, y: 0 }): SectorMemoryState {
  const n = sectorCount(config);
  return {
    originPosition,
    sectors: Array.from({ length: n }, (_, index) => ({
      index, centerHeadingDeg: sectorCenterDeg(index, config), inspectedAgeMs: 'never', clearance: { status: 'unknown' }, candidate: null,
    })),
  };
}

/** Updates the sector memory after one decision's acquisition: marks every currently-covered
 * sector inspected now (age 0), attaches each covered sector's OWN measured clearance where one was
 * derived for it (`measuredClearanceBySector` — see `deriveClearance`; a covered sector with no
 * entry there stays/returns to `unknown`, never inherits a neighbour's reading), and
 * records/refreshes a candidate sighting. `nowSimMs`/`displacementM` age every OTHER sector's
 * recorded age and invalidate (to unknown/never) anything older than the declared horizon — the
 * memory is not re-projected for lateral motion, so a large enough displacement invalidates
 * everything rather than silently keeping a now-geometrically-wrong fact (the oracle's own
 * declared limitation; this engine makes the invalidation explicit instead of ignoring it).
 *
 * engine-review-e2 finding 6 regression: a currently-COVERED sector must never read `never` even
 * during a large-displacement invalidation event — the camera is looking at it RIGHT NOW, which is
 * fresher information than the stale pre-displacement memory being invalidated. Pre-fix, the
 * `invalidateAll` branch reset every sector unconditionally, including covered ones. */
export function updateSectorMemory(
  state: SectorMemoryState, config: SectorMemoryConfig, headingDeg: number, nowSimMs: number,
  currentPosition: { x: number; y: number }, measuredClearanceBySector: ReadonlyMap<number, ClearanceStatus> | null,
  sighting: { bearingDeg: number; rangeM: number | null; description: string } | null,
): SectorMemoryState {
  const displaced = Math.hypot(currentPosition.x - state.originPosition.x, currentPosition.y - state.originPosition.y);
  const invalidateAll = displaced > config.invalidateAfterDisplacementM;
  const covered = new Set(coveredSectors(headingDeg, config));
  const sectors: SectorFact[] = state.sectors.map(sector => {
    const isCovered = covered.has(sector.index);
    if (invalidateAll && !isCovered) return { ...sector, inspectedAgeMs: 'never', clearance: { status: 'unknown' }, candidate: null };
    let next = invalidateAll
      ? { ...sector, inspectedAgeMs: 'never' as const, clearance: { status: 'unknown' } as ClearanceStatus, candidate: null as SectorFact['candidate'] }
      : { ...sector };
    if (isCovered) {
      next.inspectedAgeMs = 0;
      next.clearance = measuredClearanceBySector?.get(sector.index) ?? { status: 'unknown' };
    } else if (!invalidateAll && typeof next.inspectedAgeMs === 'number' && next.inspectedAgeMs > config.invalidateAfterMs) {
      next = { ...next, inspectedAgeMs: 'never', clearance: { status: 'unknown' } };
    }
    if (next.candidate && next.candidate.lastSeenAgeMs > config.invalidateAfterMs) next = { ...next, candidate: null };
    return next;
  });
  if (sighting) {
    const idx = sectorIndexForHeading(sighting.bearingDeg, config);
    const candidate: SectorCandidate = { description: sighting.description, bearingDeg: sighting.bearingDeg, rangeM: sighting.rangeM, lastSeenAgeMs: 0 };
    sectors[idx] = { ...sectors[idx]!, candidate };
  }
  return { originPosition: invalidateAll ? currentPosition : state.originPosition, sectors };
}

/** Advances every sector's inspected age, candidate age, AND clearance age by `elapsedMs` (called
 * once per decision cycle, before `updateSectorMemory` marks the currently-covered sectors back to
 * 0). engine-review-e2 finding 6: `clearance.ageMs` previously never advanced (every reading stayed
 * printed as `ageMs: 0` forever, even sectors not currently covered) — now aged the same way
 * `inspectedAgeMs`/`candidate.lastSeenAgeMs` already were. */
export function ageSectorMemory(state: SectorMemoryState, elapsedMs: number): SectorMemoryState {
  if (!(elapsedMs >= 0)) throw new Error('elapsedMs must be non-negative');
  return {
    originPosition: state.originPosition,
    sectors: state.sectors.map(sector => ({
      ...sector,
      inspectedAgeMs: sector.inspectedAgeMs === 'never' ? 'never' : sector.inspectedAgeMs + elapsedMs,
      clearance: sector.clearance.status === 'unknown' ? sector.clearance : { ...sector.clearance, ageMs: sector.clearance.ageMs + elapsedMs },
      candidate: sector.candidate ? { ...sector.candidate, lastSeenAgeMs: sector.candidate.lastSeenAgeMs + elapsedMs } : null,
    })),
  };
}

/** Sum of never-inspected degrees that would newly enter view if the camera pointed at
 * `resultingHeadingDeg` — the per-option field a follow-up test (proposed in the scout-encodings
 * results, never run there) adds to search consequences. Degree-based, not sector-count-based
 * (F75's `s3` diagnosis: sector-count credit let one full-sector hit lose to two partial hits
 * totalling less coverage). */
export function newNeverInspectedDeg(state: SectorMemoryState, config: SectorMemoryConfig, resultingHeadingDeg: number): number {
  const half = config.cameraHfovDeg / 2, n = sectorCount(config), sectorWidth = 360 / n;
  let total = 0;
  for (const sector of state.sectors) {
    if (sector.inspectedAgeMs !== 'never') continue;
    const delta = Math.abs(((sector.centerHeadingDeg - resultingHeadingDeg + 540) % 360) - 180);
    if (delta > half) continue;
    // Degrees of this sector's own angular width that fall inside the FOV window.
    const sectorHalf = sectorWidth / 2;
    const overlap = Math.max(0, Math.min(half, delta + sectorHalf) - Math.max(-half, delta - sectorHalf));
    total += Math.min(sectorWidth, overlap);
  }
  return Math.round(total * 10) / 10;
}
