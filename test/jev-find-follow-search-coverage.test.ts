import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchRequest } from '../experiments/jev-find-follow/encoders/search.ts';
import { assertNoEvaluatorLeak, assertNoRankingLanguage, assertSymmetricConsequences } from '../experiments/jev-find-follow/checks.ts';
import { createSectorMemory, DEFAULT_SECTOR_MEMORY_CONFIG } from '../experiments/jev-find-follow/sector-memory.ts';
import { createCoverageMemory, DEFAULT_COVERAGE_MEMORY_CONFIG, updateCoverageMemory } from '../experiments/jev-find-follow/coverage-memory.ts';
import { SEARCH_MENU, SEARCH_MENU_WIDE } from '../experiments/jev-find-follow/maneuver.ts';
import type { Goal, OwnState } from '../experiments/jev-find-follow/types.ts';

const goal: Goal = { classes: ['car'], colour: 'blue', description: 'the blue car', requestedRangeM: 8 };
const ownState: OwnState = { headingDeg: 0, altitudeM: 1.8, odometryDisplacementM: { x: 0, y: 0 }, acquiredSimMs: 1000 };
const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
const coverageConfig = DEFAULT_COVERAGE_MEMORY_CONFIG;

function coverageRequest(variant: 'coverage-consequences' | 'coverage-only', coverageMemory = createCoverageMemory()) {
  return buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [],
    variant, menu: SEARCH_MENU_WIDE, coverageMemory, coverageMemoryConfig: coverageConfig,
  });
}

test('coverage-consequences request: no evaluator leak, no ranking language, symmetric per-option fields', () => {
  const request = coverageRequest('coverage-consequences');
  assert.doesNotThrow(() => assertNoEvaluatorLeak(request));
  assert.doesNotThrow(() => assertNoRankingLanguage(request));
  assertSymmetricConsequences((request.state.action_consequences as any).per_option);
});

test('coverage-only request: no evaluator leak, no ranking language, symmetric per-option fields', () => {
  const request = coverageRequest('coverage-only');
  assert.doesNotThrow(() => assertNoEvaluatorLeak(request));
  assert.doesNotThrow(() => assertNoRankingLanguage(request));
  assertSymmetricConsequences((request.state.action_consequences as any).per_option);
});

test('menu override: SEARCH_MENU_WIDE offers advance_8m/advance_15m; the default SEARCH_MENU does not (backward compatible)', () => {
  const wide = coverageRequest('coverage-consequences');
  assert.ok('advance_8m' in wide.questions.action!.criteria);
  assert.ok('advance_15m' in wide.questions.action!.criteria);

  const original = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences',
  });
  assert.ok(!('advance_8m' in original.questions.action!.criteria));
  assert.equal(Object.keys(original.questions.action!.criteria).length, Object.keys(SEARCH_MENU).length);
});

test('sector-consequences renders sector_memory but never coverage_memory; coverage-consequences renders coverage_memory but never sector_memory; coverage-only renders neither', () => {
  const sector = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences',
  });
  assert.ok('sector_memory' in sector.state);
  assert.ok(!('coverage_memory' in sector.state));

  const full = coverageRequest('coverage-consequences');
  assert.ok('coverage_memory' in full.state);
  assert.ok(!('sector_memory' in full.state));

  const minimal = coverageRequest('coverage-only');
  assert.ok(!('coverage_memory' in minimal.state));
  assert.ok(!('sector_memory' in minimal.state));
});

test('clearance is null for every yaw/hold option and a ClearanceStatus for every translate option (never conflated)', () => {
  const request = coverageRequest('coverage-consequences');
  const perOption = (request.state.action_consequences as any).per_option as { action: string; clearance: unknown }[];
  for (const [id, def] of Object.entries(SEARCH_MENU_WIDE)) {
    const entry = perOption.find(o => o.action === id)!;
    if (def.kind === 'translate') assert.ok(entry.clearance !== null, `${id} (translate) should carry a clearance reading`);
    else assert.equal(entry.clearance, null, `${id} (${def.kind}) should have no clearance concept`);
  }
});

test('last_seen_offset_deg/last_seen_age_ms are still present per option under coverage-only (never require cross-field arithmetic)', () => {
  const memoryWithLastSeen = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const request = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory: memoryWithLastSeen, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: { bearingDeg: 90, rangeM: 12, ownHeadingDegAtSighting: 0, acquiredSimMs: 0, ageMs: 2000, ownPositionAtSightingM: { x: 0, y: 0, z: 1.8 } },
    lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'coverage-only', menu: SEARCH_MENU_WIDE,
    coverageMemory: createCoverageMemory(), coverageMemoryConfig: coverageConfig,
  });
  const perOption = (request.state.action_consequences as any).per_option as { action: string; last_seen_offset_deg: number | null; last_seen_age_ms: number | null }[];
  assert.ok(perOption.every(o => o.last_seen_age_ms === 2000));
  const hold = perOption.find(o => o.action === 'hold')!;
  assert.equal(hold.last_seen_offset_deg, -90); // resulting heading 0, sighting bearing 90 -> wrap180(0-90) = -90
});

// The property the S1 assignment's whole coverage-encoder design is FOR (FAILURES.md's "6/24"
// translate-along-open-corridor finding: sector-consequences has nothing local to a translate
// option, since translating never changes which heading-sectors are covered). Confirms
// coverage-consequences' advance options DO differentiate once nearby ground is already seen, while
// sector-consequences' translate entries are identical regardless of coverage (unchanged behaviour).
test('once nearby ground is already covered, advance_15m shows more new_area_seen_m2 than hold under coverage-consequences', () => {
  let seenNearby = createCoverageMemory();
  seenNearby = updateCoverageMemory(seenNearby, { x: 0, y: 0 }, 0, coverageConfig); // already looked east from the origin
  const request = coverageRequest('coverage-consequences', seenNearby);
  const perOption = (request.state.action_consequences as any).per_option as { action: string; new_area_seen_m2: number }[];
  const hold = perOption.find(o => o.action === 'hold')!;
  const advance15 = perOption.find(o => o.action === 'advance_15m')!;
  assert.equal(hold.new_area_seen_m2, 0, 'holding at an already-covered spot adds nothing');
  assert.ok(advance15.new_area_seen_m2 > 0, 'advancing 15m must reveal new ground ahead, closing the sector-memory gap');

  // sector-consequences (unchanged, comparison arm): translate entries never depend on coverage at
  // all — approach_2m (from SEARCH_MENU_WIDE, still a valid id there) and hold render the SAME
  // camera_covers_sectors as each other, by construction (see encoders/search.ts).
  const sectorRequest = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences', menu: SEARCH_MENU_WIDE,
  });
  const sectorPerOption = (sectorRequest.state.action_consequences as any).per_option as { action: string; camera_covers_sectors: unknown }[];
  const sectorHold = sectorPerOption.find(o => o.action === 'hold')!;
  const sectorAdvance15 = sectorPerOption.find(o => o.action === 'advance_15m')!;
  assert.deepEqual(sectorAdvance15.camera_covers_sectors, sectorHold.camera_covers_sectors, 'sector-consequences has no signal for a translate option (the known gap this design closes)');
});
