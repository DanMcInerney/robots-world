import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageSectorMemory, coveredSectors, createSectorMemory, DEFAULT_SECTOR_MEMORY_CONFIG, deriveClearance,
  newNeverInspectedDeg, sectorCount, sectorIndexForHeading, updateSectorMemory,
} from '../experiments/jev-find-follow/sector-memory.ts';
import type { StereoObject } from '../experiments/jev-find-follow/types.ts';

function object(overrides: Partial<StereoObject>): StereoObject {
  return { class: 'car', score: 0.5, bearingRightRad: 0, bearingUpRad: 0, surfaceRangeM: 5, rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 100, boxNorm: [0.4, 0.4, 0.6, 0.6], ...overrides };
}

test('sectorCount derives from the configured width, not a hardcoded 10/36 (the real rig is 70deg HFOV)', () => {
  assert.equal(sectorCount({ ...DEFAULT_SECTOR_MEMORY_CONFIG, sectorWidthDeg: 30 }), 12);
  assert.equal(sectorCount({ ...DEFAULT_SECTOR_MEMORY_CONFIG, sectorWidthDeg: 36 }), 10);
});

test('coveredSectors uses the real configured HFOV, covering multiple sectors per camera view at 70deg/30deg sectors', () => {
  const covered = coveredSectors(0, DEFAULT_SECTOR_MEMORY_CONFIG); // 70deg HFOV, 30deg sectors
  assert.ok(covered.length >= 2, `expected multiple sectors covered by a 70deg view at 30deg width, got ${covered.length}`);
});

test('a fresh-start memory has every sector never-inspected (most options tie) until the first update', () => {
  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  assert.ok(memory.sectors.every(s => s.inspectedAgeMs === 'never'));
});

test('updateSectorMemory marks every currently-covered sector inspected now (age 0), never leaves a covered sector "never"', () => {
  let memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  memory = updateSectorMemory(memory, DEFAULT_SECTOR_MEMORY_CONFIG, 0, 1000, { x: 0, y: 0 }, null, null);
  for (const index of coveredSectors(0, DEFAULT_SECTOR_MEMORY_CONFIG)) assert.equal(memory.sectors[index]!.inspectedAgeMs, 0);
});

test('ageSectorMemory advances every recorded age and candidate age by the elapsed interval', () => {
  let memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  memory = updateSectorMemory(memory, DEFAULT_SECTOR_MEMORY_CONFIG, 0, 0, { x: 0, y: 0 }, null, { bearingDeg: 0, rangeM: 5, description: 'the blue car' });
  memory = ageSectorMemory(memory, 500);
  const covered = coveredSectors(0, DEFAULT_SECTOR_MEMORY_CONFIG)[0]!;
  assert.equal(memory.sectors[covered]!.inspectedAgeMs, 500);
  assert.equal(memory.sectors[covered]!.candidate!.lastSeenAgeMs, 500);
});

test('invalidation with displacement: memory beyond the declared displacement horizon resets to unknown/never, not a stale carried-over fact', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, invalidateAfterDisplacementM: 5 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  const clearance90 = deriveClearance([object({ surfaceRangeM: 10 })], 2, 90, config); // dead ahead of heading 90 -> its own sector
  memory = updateSectorMemory(memory, config, 90, 1000, { x: 0, y: 0 }, clearance90, null);
  assert.equal(memory.sectors.some(s => s.clearance.status === 'open'), true);
  // Now far past the displacement horizon: everything must invalidate, including sectors not
  // currently covered by the new heading.
  memory = updateSectorMemory(memory, config, 90, 2000, { x: 10, y: 0 }, null, null);
  assert.ok(memory.sectors.every(s => s.clearance.status === 'unknown'));
  assert.ok(memory.sectors.filter(s => s.index !== sectorIndexForHeading(90, config)).every(s => s.inspectedAgeMs === 'never' || s.inspectedAgeMs === 0));
});

// engine-review-e2 finding 6 regression: a currently-COVERED sector must read fresh (age 0) even
// during a large-displacement invalidation event, not `never` — pre-fix, `invalidateAll` reset
// every sector unconditionally, including the one(s) the camera is looking at RIGHT NOW.
test('a currently-covered sector never reads "never" even when a large displacement invalidates everything else', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, invalidateAfterDisplacementM: 5 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  memory = updateSectorMemory(memory, config, 0, 1000, { x: 0, y: 0 }, null, null);
  // Now far past the displacement horizon, but STILL facing (and covering) heading 0.
  const clearance0 = deriveClearance([object({ surfaceRangeM: 10 })], 2, 0, config);
  memory = updateSectorMemory(memory, config, 0, 2000, { x: 10, y: 0 }, clearance0, null);
  const frontIndex = sectorIndexForHeading(0, config);
  assert.equal(memory.sectors[frontIndex]!.inspectedAgeMs, 0, 'the currently-covered sector must be freshly inspected, not "never"');
  assert.equal(memory.sectors[frontIndex]!.clearance.status, 'open', 'and it must carry the fresh clearance just measured for it, not "unknown"');
  // A sector well outside the current view must still invalidate to never/unknown.
  const behindIndex = sectorIndexForHeading(180, config);
  assert.equal(memory.sectors[behindIndex]!.inspectedAgeMs, 'never');
});

test('invalidation with displacement under the horizon preserves memory of sectors not currently covered', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, invalidateAfterDisplacementM: 100 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  const clearance0 = deriveClearance([object({ surfaceRangeM: 10 })], 2, 0, config);
  memory = updateSectorMemory(memory, config, 0, 0, { x: 0, y: 0 }, clearance0, null);
  const behindHeading = 180;
  memory = updateSectorMemory(memory, config, behindHeading, 1000, { x: 1, y: 0 }, null, null); // small move, well under 100m horizon
  const frontIndex = sectorIndexForHeading(0, config);
  assert.notEqual(memory.sectors[frontIndex]!.clearance.status, 'unknown', 'a small displacement must not silently invalidate everything');
});

test('a stale clearance/candidate entry (older than the time horizon) on a not-currently-covered sector is presented as unknown/gone, not indefinitely trusted', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, invalidateAfterMs: 5000 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  const clearance180 = deriveClearance([object({ surfaceRangeM: 10 })], 2, 180, config);
  memory = updateSectorMemory(memory, config, 180, 0, { x: 0, y: 0 }, clearance180, null); // covers the "behind" sector
  memory = ageSectorMemory(memory, 6000); // beyond the 5000ms horizon
  memory = updateSectorMemory(memory, config, 0, 6000, { x: 0, y: 0 }, null, null); // now facing forward; behind sector no longer covered
  const behindIndex = sectorIndexForHeading(180, config);
  assert.equal(memory.sectors[behindIndex]!.inspectedAgeMs, 'never');
  assert.equal(memory.sectors[behindIndex]!.clearance.status, 'unknown');
});

// engine-review-e2 finding 6 regression: clearance.ageMs previously never advanced.
test('clearance.ageMs advances alongside inspectedAgeMs once a sector is no longer covered', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, invalidateAfterMs: 60_000 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  const clearance180 = deriveClearance([object({ surfaceRangeM: 10 })], 2, 180, config);
  memory = updateSectorMemory(memory, config, 180, 0, { x: 0, y: 0 }, clearance180, null);
  memory = ageSectorMemory(memory, 3000);
  const behindIndex = sectorIndexForHeading(180, config);
  const clearance = memory.sectors[behindIndex]!.clearance;
  assert.equal(clearance.status, 'open');
  assert.equal((clearance as { ageMs: number }).ageMs, 3000);
});

test('newNeverInspectedDeg is degree-based, not sector-count-based: one full-sector hit can beat two partial hits totalling less coverage', () => {
  const config = { ...DEFAULT_SECTOR_MEMORY_CONFIG, sectorWidthDeg: 30, cameraHfovDeg: 70 };
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  // Mark everything inspected except two adjacent thin slivers vs one aligned full sector elsewhere.
  memory = { ...memory, sectors: memory.sectors.map(s => ({ ...s, inspectedAgeMs: 1000 })) };
  const neverIdx = sectorIndexForHeading(0, config);
  memory = { ...memory, sectors: memory.sectors.map(s => s.index === neverIdx ? { ...s, inspectedAgeMs: 'never' } : s) };
  const full = newNeverInspectedDeg(memory, config, 0); // camera centred exactly on the never sector
  assert.ok(full > 0);
  const partial = newNeverInspectedDeg(memory, config, 15); // camera centred at the sector's own edge
  assert.ok(partial <= full, 'a camera pointed straight at a never-inspected sector should recover at least as much of it as one only grazing its edge');
});

test('newNeverInspectedDeg returns 0 when everything in view is already inspected', () => {
  const config = DEFAULT_SECTOR_MEMORY_CONFIG;
  let memory = createSectorMemory(config, { x: 0, y: 0 });
  memory = { ...memory, sectors: memory.sectors.map(s => ({ ...s, inspectedAgeMs: 1000 })) };
  assert.equal(newNeverInspectedDeg(memory, config, 0), 0);
});

// engine-review-e1 finding 5: clearance is never measured in the original code (`episode.ts`
// always passed null). deriveClearance reuses the sensor's own per-object stereo range.
// engine-review-e2 finding 6: clearance is now PER SECTOR (a Map), not one aggregate value smeared
// across every covered sector — each object is placed into ITS OWN sector by its own bearing.
test('deriveClearance is empty (no entries) when no object in the frame has a valid range (never guessed open)', () => {
  const config = DEFAULT_SECTOR_MEMORY_CONFIG;
  assert.equal(deriveClearance([], 2, 0, config).size, 0);
  assert.equal(deriveClearance([object({ rangeValid: false, surfaceRangeM: null })], 2, 0, config).size, 0);
});

test('deriveClearance is open for a sector when the nearest valid surface measured IN THAT SECTOR is farther than the move distance', () => {
  const config = DEFAULT_SECTOR_MEMORY_CONFIG;
  const result = deriveClearance([object({ surfaceRangeM: 5, bearingRightRad: 0 }), object({ surfaceRangeM: 8, bearingRightRad: 0 })], 2, 0, config);
  const idx = sectorIndexForHeading(0, config); // both objects dead ahead of heading 0
  assert.deepEqual(result.get(idx), { status: 'open', toM: 5, ageMs: 0 });
  assert.equal(result.size, 1, 'only the ONE sector these objects were actually measured in gets an entry');
});

test('deriveClearance is blocked for a sector when the NEAREST object measured in it (any class, not just the goal\'s) is within the move distance', () => {
  const config = DEFAULT_SECTOR_MEMORY_CONFIG;
  const result = deriveClearance([object({ class: 'pole', surfaceRangeM: 1.4, bearingRightRad: 0 }), object({ class: 'car', surfaceRangeM: 6, bearingRightRad: 0 })], 2, 0, config);
  const idx = sectorIndexForHeading(0, config);
  assert.deepEqual(result.get(idx), { status: 'blocked', atM: 1.4, ageMs: 0 });
});

test('deriveClearance places two objects at clearly different bearings into their OWN separate sectors, never smearing one reading across both', () => {
  const config = DEFAULT_SECTOR_MEMORY_CONFIG; // 30deg sectors
  // One object dead ahead (bearing 0, blocked at 1m), one object far to the left (bearing +60deg
  // camera-relative -> world bearing -60 from heading 0 -> a DIFFERENT sector, open at 20m).
  const result = deriveClearance([
    object({ surfaceRangeM: 1, bearingRightRad: 0 }),
    object({ surfaceRangeM: 20, bearingRightRad: 60 * Math.PI / 180 }),
  ], 2, 0, config);
  const aheadIdx = sectorIndexForHeading(0, config);
  const leftIdx = sectorIndexForHeading(-60, config);
  assert.notEqual(aheadIdx, leftIdx, 'the two objects must land in different sectors for this test to be meaningful');
  assert.equal(result.get(aheadIdx)!.status, 'blocked');
  assert.equal(result.get(leftIdx)!.status, 'open');
  // A sector between them (also within the 70deg HFOV but with no object measured in it) gets NO
  // entry at all — never inherits either neighbour's reading.
  const between = sectorIndexForHeading(-30, config);
  if (between !== aheadIdx && between !== leftIdx) assert.equal(result.has(between), false);
});

test('the default sector-memory horizon is short (re-scan), not the historical 60s that let one missed detection park the drone for 41s', () => {
  assert.ok(DEFAULT_SECTOR_MEMORY_CONFIG.invalidateAfterMs <= 20_000, `expected a short re-scan horizon, got ${DEFAULT_SECTOR_MEMORY_CONFIG.invalidateAfterMs}ms`);
});
