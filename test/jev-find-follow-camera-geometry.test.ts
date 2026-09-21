import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bearingAndRangeFromWorldPosition, cameraRelativeBearingRad, reprojectBearingAfterYaw,
  worldBearingDeg, worldPositionFromBearing,
} from '../experiments/jev-find-follow/camera-geometry.ts';

const deg = (r: number) => r * 180 / Math.PI;
const rad = (d: number) => d * Math.PI / 180;

test('at zero mount pitch and zero elevation, a yaw delta simply adds to the bearing (matches the F57/F61-established simple arithmetic)', () => {
  const result = reprojectBearingAfterYaw({ bearingRightRad: rad(10), bearingUpRad: 0 }, rad(30), 0, rad(20));
  assert.ok(Math.abs(deg(result.bearingRightRad) - 30) < 1e-6, `expected 30, got ${deg(result.bearingRightRad)}`);
  assert.ok(Math.abs(result.bearingUpRad) < 1e-9);
});

test('zero yaw delta (hold) never changes the bearing, at any pitch', () => {
  for (const pitchDeg of [0, -5, -20]) {
    const result = reprojectBearingAfterYaw({ bearingRightRad: rad(15), bearingUpRad: rad(-8) }, rad(0), rad(pitchDeg), 0);
    assert.ok(Math.abs(deg(result.bearingRightRad) - 15) < 1e-6, `pitch ${pitchDeg}: expected bearingRight 15, got ${deg(result.bearingRightRad)}`);
    assert.ok(Math.abs(deg(result.bearingUpRad) + 8) < 1e-6, `pitch ${pitchDeg}: expected bearingUp -8, got ${deg(result.bearingUpRad)}`);
  }
});

test('at nonzero mount pitch, a large yaw turn on a low off-axis target diverges measurably from the naive "just add yawDeg" approximation', () => {
  // A target well below the optical axis (elevation -25deg, matching a follow-distance car under a
  // steep downward mount) and off-axis (bearingRight 20deg): the naive model would predict
  // resulting bearing = 20+40=60deg after a 40deg left turn; the pitch-aware reprojection differs.
  const naive = 20 + 40;
  const result = reprojectBearingAfterYaw({ bearingRightRad: rad(20), bearingUpRad: rad(-25) }, rad(0), rad(-20), rad(40));
  assert.notEqual(Math.round(deg(result.bearingRightRad)), naive);
});

test('reprojection is invertible: applying +delta then -delta returns the original bearing', () => {
  const start: { bearingRightRad: number; bearingUpRad: number } = { bearingRightRad: rad(12), bearingUpRad: rad(-15) };
  const forward = reprojectBearingAfterYaw(start, rad(50), rad(-18), rad(35));
  const back = reprojectBearingAfterYaw(forward, rad(85), rad(-18), rad(-35)); // heading is now 50+35=85
  assert.ok(Math.abs(deg(back.bearingRightRad) - deg(start.bearingRightRad)) < 1e-6);
  assert.ok(Math.abs(deg(back.bearingUpRad) - deg(start.bearingUpRad)) < 1e-6);
});

test('a target dead ahead (bearing 0,0) stays dead ahead only for a hold; any yaw moves it off-centre', () => {
  const result = reprojectBearingAfterYaw({ bearingRightRad: 0, bearingUpRad: 0 }, rad(0), rad(-10), rad(15));
  assert.ok(Math.abs(deg(result.bearingRightRad) - 15) < 1, `expected close to (not exactly) 15deg — matches the review's point that pitch coupling causes a small deviation even for a modest 15deg yaw, got ${deg(result.bearingRightRad)}`);
});

// --- world-position round trip (finding 2: predicted state at application) ---

test('worldPositionFromBearing / bearingAndRangeFromWorldPosition round-trip from the SAME camera pose', () => {
  const cameraPos = { x: 3, y: -2, z: 1.8 };
  const bearing: { bearingRightRad: number; bearingUpRad: number } = { bearingRightRad: rad(12), bearingUpRad: rad(-6) };
  const worldPos = worldPositionFromBearing(cameraPos, rad(40), rad(-5), bearing, 9.5);
  const back = bearingAndRangeFromWorldPosition(cameraPos, rad(40), rad(-5), worldPos);
  assert.ok(Math.abs(deg(back.bearing.bearingRightRad) - 12) < 1e-6);
  assert.ok(Math.abs(deg(back.bearing.bearingUpRad) + 6) < 1e-6);
  assert.ok(Math.abs(back.rangeM - 9.5) < 1e-6);
});

test('worldPositionFromBearing + a DIFFERENT (predicted) camera pose reprojects correctly for BOTH yaw and translation, unlike a yaw-only model', () => {
  // Target measured dead ahead at 10m from (0,0,1.8) heading 0. If the drone then (between
  // acquisition and predicted application) both turns 30deg left AND moves 1m toward where the
  // target was, the target should appear at bearing ~-30deg-ish and a SHORTER range than 10m —
  // a yaw-only reprojection would get the bearing right but never the range.
  const acquiredPos = { x: 0, y: 0, z: 1.8 };
  const bearing = { bearingRightRad: 0, bearingUpRad: 0 };
  const worldPos = worldPositionFromBearing(acquiredPos, rad(0), 0, bearing, 10);
  assert.ok(Math.abs(worldPos.x - 10) < 1e-6 && Math.abs(worldPos.y) < 1e-6);
  const predictedPos = { x: 1, y: 0, z: 1.8 }; // moved 1m forward (toward the target)
  const predicted = bearingAndRangeFromWorldPosition(predictedPos, rad(30), 0, worldPos);
  assert.ok(Math.abs(predicted.rangeM - 9) < 1e-6, `expected range to shrink to ~9m after moving 1m closer, got ${predicted.rangeM}`);
  assert.ok(deg(predicted.bearing.bearingRightRad) > 20, 'a 30deg left turn should move a dead-ahead target well to the right of centre');
});

// --- world bearing storage (finding 4) ---

test('worldBearingDeg matches evaluator.ts\'s own convention: heading - bearingRight, wrapped to [0,360)', () => {
  assert.ok(Math.abs(worldBearingDeg(0, 0)) < 1e-9);
  assert.ok(Math.abs(worldBearingDeg(90, 0) - 90) < 1e-9);
  assert.ok(Math.abs(worldBearingDeg(0, rad(30)) - 330) < 1e-6, 'a target 30deg right of heading 0 has world bearing -30 = 330');
  assert.ok(Math.abs(worldBearingDeg(350, rad(-20)) - 10) < 1e-6, 'wraps past 360');
});

test('worldBearingDeg / cameraRelativeBearingRad round-trip', () => {
  const world = worldBearingDeg(217, rad(-42));
  const back = cameraRelativeBearingRad(217, world);
  assert.ok(Math.abs(deg(back) + 42) < 1e-6);
});

test('regression for finding 4: a sighting at world bearing 180deg from own heading -170.6deg is NOT sector 0 (heading 0) — the historical bug treated the raw camera-relative bearing as if it were the world heading', () => {
  // The review's own concrete numbers: own heading -170.6deg, target sighted camera-relative
  // bearing ~+9.6deg right of centre (i.e. true world bearing ~180deg, behind-ish). The buggy
  // code stored the raw camera-relative bearing (~9.6, rounds toward 0) as "bearingDeg" and used
  // it directly as a world heading, filing the sighting near sector 0 instead of near 180.
  const ownHeadingDeg = -170.6, bearingRightRad = rad(9.6);
  const world = worldBearingDeg(ownHeadingDeg, bearingRightRad);
  assert.ok(Math.abs(world - 180) < 2, `expected the sighting's world bearing near 180deg, got ${world}`);
  assert.ok(Math.abs(world) > 20, 'must NOT be near sector 0 (the historical bug)');
});
