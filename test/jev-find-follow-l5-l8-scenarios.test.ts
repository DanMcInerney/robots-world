/** S1 (search-encoding experiment): sanity tests for the l5-wrongway/l8-far scenario builders — no
 * GPU/render needed, these check the CONSTRUCTED scenario shape (the car starts outside the initial
 * FOV / beyond detection range, the car path/menu/variant wiring, envelope, pass criteria) matches
 * `experiments/jev-find-follow/SEARCH-RESULTS.md`'s own declared design, mirroring
 * jev-find-follow-ladder-scenarios.test.ts's method for L1-L4.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildL5Wrongway, buildL8Far } from '../experiments/jev-find-follow/ladder-scenarios.ts';
import { ROUND3_RIG } from '../experiments/jev-find-follow/sweep.ts';
import { SEARCH_MENU_WIDE } from '../experiments/jev-find-follow/maneuver.ts';

function offsetFromHeadingDeg(s: ReturnType<typeof buildL5Wrongway>): number {
  const dx = s.world.carInitialPosition.x - s.world.droneInitialPosition.x;
  const dy = s.world.carInitialPosition.y - s.world.droneInitialPosition.y;
  const worldBearingDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  return Math.abs(((s.world.droneInitialHeadingDeg - worldBearingDeg + 540) % 360) - 180);
}

test('buildL5Wrongway: the car starts OUTSIDE the camera\'s initial 70deg HFOV (half-width 35deg) for every declared offset', () => {
  for (const offsetDeg of [60, 100, 140, 180, -60, -100, -140]) {
    const s = buildL5Wrongway(ROUND3_RIG, { offsetDeg });
    assert.ok(offsetFromHeadingDeg(s) > 35, `offsetDeg=${offsetDeg}: camera-relative offset ${offsetFromHeadingDeg(s).toFixed(1)}deg must exceed the 35deg half-HFOV`);
  }
});

test('buildL5Wrongway: within normal detection range (well inside ~21.6m), stationary 10s then driving slowly, wide search menu, both-axis track question mode', () => {
  const s = buildL5Wrongway(ROUND3_RIG, { offsetDeg: 100 });
  assert.ok(s.goal.requestedRangeM! < 21.6);
  assert.equal(s.world.carPath.kind, 'stationary-then-forward');
  if (s.world.carPath.kind === 'stationary-then-forward') {
    assert.equal(s.world.carPath.startMovingAtMs, 10_000);
    assert.ok(s.world.carPath.forwardSpeedMps > 0, 'must actually start driving after the stationary period');
  }
  assert.deepEqual(s.searchMenu, SEARCH_MENU_WIDE);
  assert.equal(s.searchVariant, 'coverage-consequences'); // default arm
  assert.equal(s.consequenceModel, 'measured-rate');
  assert.equal(s.questionMode, 'both');
  assert.equal(s.passCriteria.maxContacts, 0);
});

test('buildL5Wrongway: searchVariant is overridable, e.g. to the sector-consequences comparison arm', () => {
  const s = buildL5Wrongway(ROUND3_RIG, { offsetDeg: 100, searchVariant: 'sector-consequences' });
  assert.equal(s.searchVariant, 'sector-consequences');
  // Comparison arm still gets the SAME wide menu (S1's "same menus... across arms" requirement).
  assert.deepEqual(s.searchMenu, SEARCH_MENU_WIDE);
});

test('buildL8Far: the car starts BEYOND the fake-sensor-v2\'s own measured ~21.6m detection-range cutoff', () => {
  const s = buildL8Far(ROUND3_RIG, { offsetDeg: 90 });
  const dx = s.world.carInitialPosition.x - s.world.droneInitialPosition.x;
  const dy = s.world.carInitialPosition.y - s.world.droneInitialPosition.y;
  const initialRangeM = Math.hypot(dx, dy);
  assert.ok(initialRangeM > 21.6, `initial range ${initialRangeM.toFixed(1)}m must exceed the ~21.6m detection cutoff`);
  assert.ok(initialRangeM >= 30 && initialRangeM <= 46, `default rangeM should land in the assignment's declared 30-45m band, got ${initialRangeM.toFixed(1)}m`);
});

test('buildL8Far: larger envelope radius than the ladder default (needs to close 20-30m of open ground), wide search menu, longer detection deadline than L5', () => {
  const l8 = buildL8Far(ROUND3_RIG, { offsetDeg: 90 });
  const l5 = buildL5Wrongway(ROUND3_RIG, { offsetDeg: 90 });
  assert.ok(l8.envelope.maxRadiusFromOriginM > 60, 'L8 must widen the envelope beyond the ladder\'s own 60m default');
  assert.deepEqual(l8.searchMenu, SEARCH_MENU_WIDE);
  assert.ok(l8.passCriteria.requireFirstDetectionByMs! > l5.passCriteria.requireFirstDetectionByMs!, 'L8 (far) needs a longer declared detection deadline than L5 (wrong-way, close range)');
  assert.equal(l8.goal.requestedRangeM, 10, 'the FOLLOW distance is independent of the much larger initial separation');
});

test('buildL5Wrongway/buildL8Far: distinct scenario ids across offset/variant so a batch run never collides', () => {
  const ids = new Set<string>();
  for (const offsetDeg of [60, 100, 180]) {
    for (const searchVariant of ['sector-consequences', 'coverage-consequences', 'coverage-only'] as const) {
      ids.add(buildL5Wrongway(ROUND3_RIG, { offsetDeg, searchVariant }).id);
      ids.add(buildL8Far(ROUND3_RIG, { offsetDeg, searchVariant }).id);
    }
  }
  assert.equal(ids.size, 3 * 3 * 2, 'every offset x variant x rung combination must produce a unique id');
});
