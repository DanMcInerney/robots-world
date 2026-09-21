import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildEvaluatorSnapshot } from '../experiments/jev-find-follow/evaluator.ts';
import { assertNoEvaluatorLeak, assertNoRankingLanguage, assertSymmetricConsequences, scanForEvaluatorImports } from '../experiments/jev-find-follow/checks.ts';
import type { DecisionRequest } from '../experiments/jev-find-follow/types.ts';

test('buildEvaluatorSnapshot computes nearest-surface range and bearing analytically from an oriented box', () => {
  const snapshot = buildEvaluatorSnapshot({
    acquiredSimMs: 1000,
    cameraPosition: { x: 0, y: 0, z: 0.6 }, // same altitude as the target centre, so the vertical component is zero
    cameraHeadingDeg: 0, // facing east (+X)
    hfovDeg: 70,
    target: { id: 't', kind: 'target', pose: { position: { x: 10, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } },
    lookalikes: [],
  });
  // Nearest surface of the box (centre at x=10, half-extent 2.25) to a camera at x=0 is 10-2.25=7.75
  // ALONG THE SINGLE CENTRAL RAY. A5 (engine-review-e3 finding 6): the evaluator range is now the
  // MEDIAN of a ray GRID spanning the box's angular extent, not one ray — even for this perfectly
  // symmetric head-on view of a flat front face, off-axis grid rays travel a slightly longer
  // EUCLIDEAN path to reach that same flat plane than the perpendicular centre ray does (basic
  // off-axis-to-a-flat-plane geometry), so the grid median reads a small amount ABOVE 7.75 — the
  // same geometric effect that plausibly explains part of a real sensor's own positive range bias
  // (the review measured +0.3 to +1.0m sensor-minus-truth against the OLD single-ray definition).
  // This is intentional, not a regression: still tight (well under the box's own half-length), and
  // never below the single-ray figure.
  // Strictly greater by a non-trivial margin (not merely ">="): this is also a regression guard
  // that the ray-grid mechanism is genuinely active, not silently collapsed back to a single ray
  // (which would read EXACTLY 7.75 here).
  assert.ok(snapshot.trueNearestSurfaceRangeM > 7.75 + 0.01, `grid-median range (${snapshot.trueNearestSurfaceRangeM}) must read measurably ABOVE the single-ray figure (7.75) -- if this is exactly 7.75, the ray-grid has regressed to a single centre ray`);
  assert.ok(snapshot.trueNearestSurfaceRangeM < 7.75 + 0.5, `grid-median range (${snapshot.trueNearestSurfaceRangeM}) should stay close to the single-ray figure (7.75) for this symmetric, head-on, unobstructed view`);
  assert.ok(Math.abs(snapshot.trueBearingRightRad) < 1e-6, 'target directly ahead: bearing should be ~0');
  assert.equal(snapshot.targetWithinFov, true);
});

test('buildEvaluatorSnapshot includes the vertical offset (altitude difference) in the nearest-surface distance, not only the horizontal component', () => {
  const snapshot = buildEvaluatorSnapshot({
    acquiredSimMs: 0, cameraPosition: { x: 0, y: 0, z: 1.8 }, cameraHeadingDeg: 0, hfovDeg: 70,
    target: { id: 't', kind: 'target', pose: { position: { x: 10, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } },
    lookalikes: [],
  });
  const horizontalOnly = 7.75;
  assert.ok(snapshot.trueNearestSurfaceRangeM > horizontalOnly, 'the camera is above the box top, so true 3D distance must exceed the horizontal-only figure');
});

// engine-review-e2 finding 4: the evaluator previously returned the NEAREST 3D POINT on the box,
// which need not be a point the camera can actually see. Here the camera is offset well to the
// SIDE of the target's front face; the nearest 3D point is a point on the box's near side edge
// (short straight-line distance), but the camera's actual SIGHTLINE (aimed at the box centre, the
// same "what the camera is looking at" concept the sensor's mask-median range estimates) crosses
// the box further along, near its front corner — a materially LONGER range than the nearest-point
// figure. This is the regression: pre-fix, `trueNearestSurfaceRangeM` would have reported the
// nearest-point distance instead.
test('buildEvaluatorSnapshot reports the SIGHTLINE surface range (where the camera\'s own line of sight to the target crosses the box), not merely the nearest 3D point on the box', () => {
  const target = { id: 't', kind: 'target' as const, pose: { position: { x: 10, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } };
  // Camera well off to the side (y=8) and roughly level with the box, so the line of sight to the
  // box's centre is a steep diagonal, not a straight shot at the near face.
  const cameraPosition = { x: 0, y: 8, z: 0.6 };
  const snapshot = buildEvaluatorSnapshot({ acquiredSimMs: 0, cameraPosition, cameraHeadingDeg: -45, hfovDeg: 70, target, lookalikes: [] });
  // The nearest 3D POINT on the box to this camera position (for reference, not what this test
  // asserts on directly): clamp camera-relative offset (-10,8,0) into the box's half-extents
  // (2.25,1.1,0.6) -> nearest point offset (-2.25,1.1,0) from box centre -> distance from camera to
  // that point = hypot(10-2.25, 8-1.1) = hypot(7.75, 6.9) ~= 10.37.
  const nearestPointDistance = Math.hypot(10 - 2.25, 8 - 1.1);
  // The sightline range (camera to where the ray toward the box CENTRE first crosses its surface)
  // must be LONGER than the nearest-point distance here, since the sightline does not aim at the
  // nearest point at all.
  assert.ok(snapshot.trueNearestSurfaceRangeM > nearestPointDistance + 0.5,
    `expected the sightline range (${snapshot.trueNearestSurfaceRangeM.toFixed(2)}) to exceed the nearest-point distance (${nearestPointDistance.toFixed(2)}) by a material margin`);
  // And it must still be LESS than the full distance to the box's centre (the ray stops at the
  // surface, not the centre).
  const distanceToCentre = Math.hypot(10, 8);
  assert.ok(snapshot.trueNearestSurfaceRangeM < distanceToCentre, 'the sightline range must stop at the box surface, before reaching its centre');
});

test('buildEvaluatorSnapshot reports the target outside the FOV when it is behind the camera', () => {
  const snapshot = buildEvaluatorSnapshot({
    acquiredSimMs: 0, cameraPosition: { x: 0, y: 0, z: 1.8 }, cameraHeadingDeg: 0, hfovDeg: 70,
    target: { id: 't', kind: 'target', pose: { position: { x: -10, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } },
    lookalikes: [],
  });
  assert.equal(snapshot.targetWithinFov, false);
});

test('a left turn moves the true bearing to the right, matching the ENU "positive yaw turns left" convention', () => {
  const ahead = buildEvaluatorSnapshot({
    acquiredSimMs: 0, cameraPosition: { x: 0, y: 0, z: 0 }, cameraHeadingDeg: 0, hfovDeg: 90,
    target: { id: 't', kind: 'target', pose: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    lookalikes: [],
  });
  const turnedLeft30 = buildEvaluatorSnapshot({
    acquiredSimMs: 0, cameraPosition: { x: 0, y: 0, z: 0 }, cameraHeadingDeg: 30, hfovDeg: 90,
    target: { id: 't', kind: 'target', pose: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 0.1, y: 0.1, z: 0.1 } },
    lookalikes: [],
  });
  assert.ok(ahead.trueBearingRightRad < turnedLeft30.trueBearingRightRad, 'turning left must make a fixed target appear further right');
});

test('assertNoEvaluatorLeak rejects a request carrying evaluator-only field names', () => {
  const clean: DecisionRequest = { model: 'jev-1.13.0', state: { goal: 'find the car', bearing_deg: 3 }, questions: { action: { type: 'choice', instructions: 'x', criteria: { hold: 'y' } } } };
  assert.doesNotThrow(() => assertNoEvaluatorLeak(clean));
  const leaked: DecisionRequest = { model: 'jev-1.13.0', state: { goal: 'find the car', trueBearingRightRad: 0.1 } as any, questions: clean.questions };
  assert.throws(() => assertNoEvaluatorLeak(leaked), /trueBearingRightRad/);
});

test('assertNoRankingLanguage passes disclosed negated language and rejects an affirmative recommendation', () => {
  const disclosed: DecisionRequest = { model: 'jev-1.13.0', state: { note: 'These are conditional calculations, not a ranking or a recommendation.' }, questions: { action: { type: 'choice', instructions: 'choose', criteria: { hold: 'stay' } } } };
  assert.doesNotThrow(() => assertNoRankingLanguage(disclosed));
  const affirmative: DecisionRequest = { model: 'jev-1.13.0', state: { note: 'Option hold is the best choice.' }, questions: disclosed.questions };
  assert.throws(() => assertNoRankingLanguage(affirmative), /best/);
});

test('assertSymmetricConsequences requires an identical field set across every option', () => {
  assert.doesNotThrow(() => assertSymmetricConsequences([{ action: 'a', resulting_bearing_deg: 1 }, { action: 'b', resulting_bearing_deg: 2 }]));
  assert.throws(() => assertSymmetricConsequences([{ action: 'a', resulting_bearing_deg: 1 }, { action: 'b', extra: true }]));
});

test('scanForEvaluatorImports finds no import of evaluator.ts from encoders/ or controllers/', async () => {
  const offenders = await scanForEvaluatorImports(resolve('experiments/jev-find-follow'));
  assert.deepEqual(offenders, []);
});
