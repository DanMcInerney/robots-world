import test from 'node:test';
import assert from 'node:assert/strict';
import {
  N_SECTORS, SECTOR_WIDTH_DEG, CAMERA_HFOV_DEG, coveredSectors, sectorCenterDeg, sectorIndexForHeading,
  scoutOracle, rangeOracle, RANGE_TOLERANCE_M, circularDistanceDeg, overlapDeg, wrap360,
  type SectorFact, type ScoutFacts, type Clearance,
} from '../experiments/jev-scout-encodings/oracle.ts';
import {mirrorScoutFacts} from '../experiments/jev-scout-encodings/scout.ts';

const UNKNOWN: Clearance = {status: 'unknown'};
function blankSectors(): SectorFact[] {
  return Array.from({length: N_SECTORS}, (_, i) => ({index: i, centerHeadingDeg: sectorCenterDeg(i), inspectedAgeMs: 'never', clearance: UNKNOWN, candidate: null}));
}
function baseFacts(overrides: Partial<ScoutFacts> = {}): ScoutFacts {
  return {headingDeg: 0, cameraHfovDeg: CAMERA_HFOV_DEG, moveDistanceM: 2, targetDescription: 'blue car', targetCurrentlyVisible: false, sectors: blankSectors(), receipts: [], ...overrides};
}
function withAge0AtHeading(sectors: SectorFact[], headingDeg: number): SectorFact[] {
  const copy = sectors.map(s => ({...s}));
  for (const i of coveredSectors(headingDeg)) copy[i]!.inspectedAgeMs = 0;
  return copy;
}

test('geometry: 10 sectors of 36 degrees; a sector counts as covered iff its centre is within half the FOV', () => {
  assert.equal(N_SECTORS, 10); assert.equal(SECTOR_WIDTH_DEG, 36); assert.equal(CAMERA_HFOV_DEG, 36);
  assert.equal(sectorIndexForHeading(0), 0); assert.equal(sectorIndexForHeading(35), 1); assert.equal(sectorIndexForHeading(-19), 9);
  assert.deepEqual(coveredSectors(0, 36), [0]); // aligned: exactly one sector (distance 0 <= 18)
  assert.deepEqual(coveredSectors(19, 36), [1]); // distance to sector0 is 19 > half(18): only sector1 (distance 17) covered
  assert.deepEqual(coveredSectors(18, 36), [0, 1]); // exact boundary: inclusive on both sides
  assert.equal(circularDistanceDeg(350, 10), 20);
  assert.equal(wrap360(-10), 350);
});
test('overlapDeg: full 36 degrees when aligned, 0 at 36 degrees apart, linear between, symmetric for equal widths', () => {
  assert.equal(overlapDeg(0, 0, 36, 36), 36);
  assert.equal(overlapDeg(0, 36, 36, 36), 0);
  assert.equal(overlapDeg(0, 18, 36, 36), 18);
  assert.equal(overlapDeg(10, -8, 36, 36), overlapDeg(-8, 10, 36, 36));
});

test('scoutOracle hand-check: target currently visible -> hold is the only useful action, everything else harmful', () => {
  const sectors = withAge0AtHeading(blankSectors(), 0);
  sectors[3]!.inspectedAgeMs = 0; // a real temptation exists elsewhere too
  const oracle = scoutOracle(baseFacts({headingDeg: 0, targetCurrentlyVisible: true, sectors}));
  assert.deepEqual(oracle.useful, ['hold']);
  assert.equal(oracle.harmful.length, 11);
  assert(!oracle.harmful.includes('hold'));
});

test('buildFacts invariant: a currently-covered sector is never "never" -- prevents the F52-style contradiction where a hold/consequence entry claims coverage of a sector the memory still calls unseen', async () => {
  const {generateScoutCases} = await import('../experiments/jev-scout-encodings/scout.ts');
  for (const c of generateScoutCases().filter(c => c.arm === 'sector-consequences')) {
    const state = c.request.state as any;
    const holdEntry = state.action_consequences.per_option.find((o: any) => o.action === 'hold');
    for (const covered of holdEntry.camera_covers_sectors) assert.notEqual(covered.never_or_age, 'never', `${c.id}: hold claims coverage of a sector the memory still calls never-inspected`);
  }
});

test('scoutOracle hand-check: trustworthy last-seen candidate pulls toward its exact recorded BEARING (not merely "same sector"); a stale one does not', () => {
  const sectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) sectors[i]!.inspectedAgeMs = 5000; // remove sector-novelty as a competing driver
  sectors[sectorIndexForHeading(30)]!.candidate = {description: 'blue car', bearingDeg: 30, rangeM: 12, lastSeenAgeMs: 29_999};
  const facts = baseFacts({headingDeg: 0, sectors: withAge0AtHeading(sectors, 0)});
  const trustworthy = scoutOracle(facts);
  assert(trustworthy.useful.includes('yaw_left_30'));
  assert(!trustworthy.useful.includes('yaw_right_30'));
  assert(trustworthy.harmful.includes('yaw_right_90')); // turns away from the known lead

  // A candidate whose recorded bearing is just past the FOV half-width (18 degrees) of any offered
  // action's resulting heading must NOT be useful merely because it shares a nominal sector.
  const farSectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) farSectors[i]!.inspectedAgeMs = 5000;
  farSectors[sectorIndexForHeading(33)]!.candidate = {description: 'blue car', bearingDeg: 33, rangeM: 12, lastSeenAgeMs: 8000}; // yaw_right_90 lands at -90; distance to 33 is 123, far
  const farFacts = baseFacts({headingDeg: 0, sectors: withAge0AtHeading(farSectors, 0)});
  const far = scoutOracle(farFacts);
  assert(far.useful.includes('yaw_left_30')); // resulting heading 30, distance to bearing 33 is 3 <= 18: useful
  assert(!far.useful.includes('yaw_right_90'));

  const staleSectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) staleSectors[i]!.inspectedAgeMs = 5000;
  staleSectors[sectorIndexForHeading(30)]!.candidate = {description: 'blue car', bearingDeg: 30, rangeM: 12, lastSeenAgeMs: 90_001};
  staleSectors[sectorIndexForHeading(60)]!.inspectedAgeMs = 'never'; // sector nearest yaw_left_60's resulting heading (60), the unique max-overlap action
  const stale = scoutOracle(baseFacts({headingDeg: 0, sectors: withAge0AtHeading(staleSectors, 0)}));
  assert(!stale.useful.includes('yaw_left_30'), 'a stale candidate must not pull the useful action toward it');
  assert.deepEqual(stale.useful, ['yaw_left_60']);
});

test('scoutOracle hand-check: degree-based discovery scoring gives equal credit for equal never-inspected coverage regardless of how many sectors it spans', () => {
  // Never-inspected sectors: 2 and 3 (centres 72, 108) and 5 (centre 180, directly opposite heading 0).
  // yaw_left_90 (heading 90) straddles sectors 2 and 3 -- 18 degrees of each, 36 total, split across TWO
  // sectors. turn_180 (heading 180) lands exactly on sector 5's centre -- 36 degrees from ONE sector.
  // Both bring exactly 36 never-inspected degrees into view and must tie for useful; a sector-COUNT
  // metric would wrongly prefer the 2-sector split (this reproduces and repairs the reviewer's finding).
  const sectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) if (![2, 3, 5].includes(i)) sectors[i]!.inspectedAgeMs = 9000;
  const facts = baseFacts({headingDeg: 0, sectors: withAge0AtHeading(sectors, 0)});
  const oracle = scoutOracle(facts);
  const left90 = oracle.perAction.yaw_left_90!.newlyNeverDeg, turn180 = oracle.perAction.turn_180!.newlyNeverDeg;
  assert.equal(left90, 36); assert.equal(turn180, 36);
  assert(oracle.useful.includes('yaw_left_90')); assert(oracle.useful.includes('turn_180'));
  assert.deepEqual(new Set(oracle.useful), new Set(['yaw_left_90', 'turn_180']));
});

test('scoutOracle hand-check: all sectors inspected -> useful is the one open corridor, blocked/unknown are harmful in every branch', () => {
  const sectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) sectors[i] = {...sectors[i]!, inspectedAgeMs: 1000, clearance: {status: 'blocked', atM: 1, ageMs: 500}};
  sectors[sectorIndexForHeading(0)]!.clearance = {status: 'open', toM: 6, ageMs: 500};
  const oracle = scoutOracle(baseFacts({headingDeg: 0, sectors: withAge0AtHeading(sectors, 0), moveDistanceM: 2}));
  assert.deepEqual(oracle.useful, ['advance']);
  assert(oracle.harmful.includes('retreat')); assert(oracle.harmful.includes('strafe_left')); assert(oracle.harmful.includes('strafe_right'));

  // Same clearance layout, but the discovery branch is active (a never sector exists elsewhere): blocked
  // translation must STILL be harmful (rule 5 applies uniformly across branches, not only the fallback).
  const discoverySectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) if (i !== sectorIndexForHeading(150)) discoverySectors[i] = {...discoverySectors[i]!, inspectedAgeMs: 1000, clearance: {status: 'blocked', atM: 1, ageMs: 500}};
  const withDiscovery = scoutOracle(baseFacts({headingDeg: 0, sectors: withAge0AtHeading(discoverySectors, 0)}));
  assert(withDiscovery.harmful.includes('advance'), 'translating into blocked clearance must be harmful even while the discovery branch is active');
});

test('scoutOracle hand-check: all sectors inspected and every clearance unknown -> hold is useful, no unsupported commitment', () => {
  const sectors = blankSectors();
  for (let i = 0; i < N_SECTORS; i++) sectors[i]!.inspectedAgeMs = 2000;
  const oracle = scoutOracle(baseFacts({headingDeg: 0, sectors: withAge0AtHeading(sectors, 0)}));
  assert.deepEqual(oracle.useful, ['hold']);
  assert(oracle.harmful.includes('advance')); assert(oracle.harmful.includes('retreat'));
});

test('rangeOracle hand-check: invalid range -> hold is useful, every movement is harmful (unsupported commitment)', () => {
  for (const rangeStatus of ['unavailable', 'ambiguous'] as const) {
    const oracle = rangeOracle({rangeStatus, measuredRangeM: null, goalM: 10, targetDescription: 'blue car'});
    assert.deepEqual(oracle.useful, ['hold']);
    assert.equal(oracle.harmful.length, 4);
    assert.equal(oracle.signedErrorM, null);
  }
});

test('rangeOracle hand-check: hold outside tolerance is NEUTRAL, never harmful merely for failing to be optimal', () => {
  // Measured 11.5001 vs goal 11: 0.5001 m outside tolerance by 0.1 mm -- deliberately not used by the
  // generator (B2 fix requires >=0.3 m realistic margins), but the oracle rule itself must still treat a
  // hold that neither improves nor worsens as neutral, not harmful, at any margin.
  const oracle = rangeOracle({rangeStatus: 'valid', measuredRangeM: 11.5001, goalM: 11, targetDescription: 'blue car'});
  assert(!oracle.harmful.includes('hold'), 'hold must not be harmful merely for not being optimal outside tolerance');
  assert(!oracle.useful.includes('hold'));
});

test('rangeOracle hand-check: inside tolerance -> hold is useful; outside tolerance -> the true optimum wins even over the largest step, and only genuine worsening is harmful', () => {
  const inside = rangeOracle({rangeStatus: 'valid', measuredRangeM: 10.3, goalM: 10, targetDescription: 'blue car'});
  assert.deepEqual(inside.useful, ['hold']);
  assert(Math.abs(inside.signedErrorM!) <= RANGE_TOLERANCE_M);

  // Measured 9.2, goal 8: approach_2m overshoots to -0.8 (worse than doing nothing is not true, it still
  // reduces |error| from 1.2 to 0.8, so it is "acceptable" not "harmful"); approach_1m lands at +0.2, the optimum.
  const trap = rangeOracle({rangeStatus: 'valid', measuredRangeM: 9.2, goalM: 8, targetDescription: 'blue car'});
  assert.deepEqual(trap.useful, ['approach_1m']);
  assert(!trap.useful.includes('approach_2m'));
  assert(trap.harmful.includes('retreat_1m')); assert(trap.harmful.includes('retreat_2m')); // these increase |error| beyond the current 1.2 m
  assert(!trap.harmful.includes('approach_2m'), 'a genuine (if suboptimal) improvement must not be harmful');
});

test('mirroring the oracle facts mirrors the useful action set left<->right (S) and reflects signed error (R)', () => {
  const sectors = blankSectors();
  sectors[sectorIndexForHeading(30)]!.inspectedAgeMs = 4000; // simple, deterministic S1-style scenario
  const facts = baseFacts({headingDeg: 0, sectors: withAge0AtHeading(sectors, 0)});
  const original = scoutOracle(facts).useful;
  assert(original.length > 0);

  const mirrored = mirrorScoutFacts(facts);
  assert.equal(mirrored.headingDeg, 0);
  assert.equal(mirrored.sectors.length, N_SECTORS);
  const mirroredUseful = scoutOracle(mirrored).useful;
  const swapLeftRight = (id: string) => id.replace('left', 'TEMP').replace('right', 'left').replace('TEMP', 'right');
  assert.deepEqual(new Set(mirroredUseful), new Set(original.map(swapLeftRight)));
  assert(original.some(a => a.includes('right')), 'the scenario should be asymmetric enough to actually exercise the swap');
});
