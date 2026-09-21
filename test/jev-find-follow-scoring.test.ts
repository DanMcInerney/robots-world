import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreEpisode, type ContactEvent } from '../experiments/jev-find-follow/scoring.ts';
import type { DecisionRecord, Mode } from '../experiments/jev-find-follow/types.ts';
import type { EvaluatorSnapshot } from '../experiments/jev-find-follow/evaluator.ts';

const emptyRequest = { model: 'jev-1.13.0' as const, state: {}, questions: {} };
const emptyResponse = { model: 'jev-1.13.0', answers: {}, synthetic: true };

function decision(overrides: Partial<DecisionRecord & { mode: Mode }>): DecisionRecord & { mode: Mode } {
  return {
    index: 0, mode: 'track', modeReason: 'target bound', acquiredSimMs: 0, observationAvailableSimMs: 140, dispatchedSimMs: 140, returnedSimMs: 390, appliedSimMs: 410,
    acquireWallMs: 450, perceptionWallMs: 140, controllerWallMs: 5, cycleWallMs: 900, skippedAcquisitions: 0, acquisitionsThisCycle: 1,
    request: emptyRequest as any, response: emptyResponse as any, chosenManeuver: 'hold', chosenYawId: 'hold', chosenRangeId: 'hold', maneuverOutcome: 'accepted', maneuverVeto: null,
    unexpectedRejection: false, observedFault: null, controllerLatencyTimedOut: false,
    ownState: { headingDeg: 0, altitudeM: 1.8, odometryDisplacementM: { x: 0, y: 0 }, acquiredSimMs: 0 },
    acquisitionPose: { position: { x: 0, y: 0, z: 1.8 }, headingDeg: 0 }, predictedApplicationPose: { position: { x: 0, y: 0, z: 1.8 }, headingDeg: 0 },
    bind: { status: 'none', candidates: [], boundIndex: null }, boundBearingRightRad: null, boundRangeM: null, evidenceSource: 'none',
    frameRef: null,
    ...overrides,
  };
}

function evaluatorSnapshot(acquiredSimMs: number, overrides: Partial<EvaluatorSnapshot> = {}): EvaluatorSnapshot {
  return {
    acquiredSimMs, cameraPosition: { x: 0, y: 0, z: 1.8 }, cameraHeadingDeg: 0,
    target: { id: 't', kind: 'target', pose: { position: { x: 8, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } },
    lookalikes: [], trueNearestSurfaceRangeM: 5.75, trueBearingRightRad: 0, targetWithinFov: true,
    ...overrides,
  };
}

const baseInput = {
  durationMs: 2000, requestedRangeM: 8, rangeToleranceM: 1, hfovDeg: 70, centralBandFraction: 0.3,
  cameraPeriodMs: 200, identityBearingToleranceRad: 10 * Math.PI / 180, identityRangeToleranceM: 2,
  envelope: { minAltitudeM: 0.5, maxAltitudeM: 6, maxRadiusFromOriginM: 60 }, originPosition: { x: 0, y: 0 },
};

test('an all-passive (never-bound) episode scores zero bound/framed fraction and reports the whole duration as visible-but-not-detected coverage, never as success', () => {
  const decisions = [0, 200, 400, 600, 800].map(t => decision({ acquiredSimMs: t }));
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs)]));
  const score = scoreEpisode({ ...baseInput, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.boundFraction, 0);
  assert.equal(score.framedFraction, 0);
  assert.equal(score.timeToFirstControllerVisibleDetectionMs, null);
  assert.ok(score.visibleFraction > 0, 'evaluator truth says the target was in FOV the whole time');
});

test('a fully bound, centred, in-tolerance episode scores near-1.0 bound/framed fractions and a follow-lock time', () => {
  const decisions = [0, 200, 400].map(t => decision({
    acquiredSimMs: t, observationAvailableSimMs: t + 140,
    bind: { status: 'bound', candidates: [{ objectIndex: 0, class: 'car', colour: 'blue', score: 0.9, bearingRightRad: 0.01, bearingUpRad: 0, rangeM: 8.1 }], boundIndex: 0 },
    boundBearingRightRad: 0.01, boundRangeM: 8.1,
  }));
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs, { trueBearingRightRad: 0.01, trueNearestSurfaceRangeM: 8.1 })]));
  const score = scoreEpisode({ ...baseInput, durationMs: 600, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.boundFraction, 1);
  assert.equal(score.framedFraction, 1);
  assert.equal(score.timeToFirstControllerVisibleDetectionMs, 140);
  assert.equal(score.timeToFollowLockMs, 0);
  assert.equal(score.correctIdentityFraction, 1);
  assert.ok(score.rangeErrorM.medianAbs !== null && score.rangeErrorM.medianAbs < 0.2);
});

// A5 (engine-review-e3 finding 6, "report per-run sensor-minus-truth bias"): SIGNED, positive when
// the sensor reads FARTHER than truth (matching the review's own sign convention). Distinct from
// rangeErrorM (sensor vs the GOAL) and truth.rangeErrorM (truth vs the GOAL) -- this isolates the
// sensor's own bias against evaluator truth, at matching acquisitions only.
test('sensorRangeBiasM reports the signed median/mean sensor-minus-truth range bias across bound acquisitions with known truth', () => {
  const decisions = [
    decision({ acquiredSimMs: 0, bind: { status: 'bound', candidates: [{ objectIndex: 0, class: 'car', colour: 'blue', score: 0.9, bearingRightRad: 0, bearingUpRad: 0, rangeM: 8.3 }], boundIndex: 0 }, boundBearingRightRad: 0, boundRangeM: 8.3 }),
    decision({ acquiredSimMs: 200, bind: { status: 'bound', candidates: [{ objectIndex: 0, class: 'car', colour: 'blue', score: 0.9, bearingRightRad: 0, bearingUpRad: 0, rangeM: 8.5 }], boundIndex: 0 }, boundBearingRightRad: 0, boundRangeM: 8.5 }),
    // An UNBOUND acquisition (no sensor range delivered) must not contribute a bias sample.
    decision({ acquiredSimMs: 400, bind: { status: 'none', candidates: [], boundIndex: null } }),
  ];
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs, { trueNearestSurfaceRangeM: 8.0 })]));
  const score = scoreEpisode({ ...baseInput, durationMs: 600, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.sensorRangeBiasM.n, 2, 'only the 2 BOUND acquisitions with a delivered range contribute a bias sample');
  assert.ok(score.sensorRangeBiasM.meanM !== null && Math.abs(score.sensorRangeBiasM.meanM - 0.4) < 1e-9, `expected mean bias (8.3-8.0 + 8.5-8.0)/2 = 0.4, got ${score.sensorRangeBiasM.meanM}`);
  assert.ok(score.sensorRangeBiasM.medianM !== null && score.sensorRangeBiasM.medianM > 0, 'positive bias: the sensor read FARTHER than truth here, matching the review\'s own sign convention');
});

test('sensorRangeBiasM is null/zero-n, never a fabricated 0, when no acquisition has both a bound range and known truth', () => {
  const decisions = [decision({ acquiredSimMs: 0 })]; // never bound
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs)]));
  const score = scoreEpisode({ ...baseInput, durationMs: 200, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.sensorRangeBiasM.n, 0);
  assert.equal(score.sensorRangeBiasM.medianM, null);
  assert.equal(score.sensorRangeBiasM.meanM, null);
});

test('loss and reacquisition: the longest loss and a recorded reacquisition delay reflect a bound -> lost -> bound sequence', () => {
  const bound = { status: 'bound' as const, candidates: [{ objectIndex: 0, class: 'car', colour: 'blue', score: 0.9, bearingRightRad: 0, bearingUpRad: 0, rangeM: 8 }], boundIndex: 0 };
  const lost = { status: 'none' as const, candidates: [], boundIndex: null };
  const decisions = [
    decision({ acquiredSimMs: 0, bind: bound, boundBearingRightRad: 0, boundRangeM: 8 }),
    decision({ acquiredSimMs: 200, bind: lost }),
    decision({ acquiredSimMs: 400, bind: lost }),
    decision({ acquiredSimMs: 600, bind: lost }),
    decision({ acquiredSimMs: 800, bind: bound, boundBearingRightRad: 0, boundRangeM: 8 }),
  ];
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs)]));
  const score = scoreEpisode({ ...baseInput, durationMs: 1000, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.ok(score.longestLossMs >= 600, `expected a loss of at least 600ms, got ${score.longestLossMs}`);
  assert.equal(score.reacquisitions.count, 1);
  assert.ok(score.reacquisitions.delaysMs[0]! >= 600);
});

test('contacts and envelope violations are counted, never silently dropped', () => {
  const decisions = [decision({ acquiredSimMs: 0 }), decision({ acquiredSimMs: 200 })];
  const contacts: ContactEvent[] = [{ simMs: 150, a: 'drone', b: 'wall' }];
  const evaluatorByAcquiredSimMs = new Map([
    [0, evaluatorSnapshot(0, { cameraPosition: { x: 0, y: 0, z: 1.8 } })],
    [200, evaluatorSnapshot(200, { cameraPosition: { x: 0, y: 0, z: 10 } })], // outside the declared envelope
  ]);
  const score = scoreEpisode({ ...baseInput, durationMs: 400, decisions, evaluatorByAcquiredSimMs, contacts });
  assert.equal(score.contacts, 1);
  assert.equal(score.envelopeViolations, 1);
});

test('pass criteria are supplied per call, not hard-coded: the same score can pass one criteria set and fail a stricter one', () => {
  const decisions = [decision({
    acquiredSimMs: 0, bind: { status: 'bound', candidates: [{ objectIndex: 0, class: 'car', colour: 'blue', score: 0.9, bearingRightRad: 0, bearingUpRad: 0, rangeM: 8 }], boundIndex: 0 },
    boundBearingRightRad: 0, boundRangeM: 8,
  })];
  const evaluatorByAcquiredSimMs = new Map([[0, evaluatorSnapshot(0)]]);
  const input = { ...baseInput, durationMs: 200, decisions, evaluatorByAcquiredSimMs, contacts: [] };
  const lenient = scoreEpisode(input, { minFollowLockFraction: 0.5, maxLongestLossMs: 999999, maxContacts: 5, requireFirstDetectionByMs: null, maxVetoedManeuvers: 5 });
  assert.equal(lenient.pass!.decided, true);
  const strict = scoreEpisode(input, { minFollowLockFraction: 0.99, maxLongestLossMs: 0, maxContacts: 0, requireFirstDetectionByMs: 1, maxVetoedManeuvers: 0 });
  assert.equal(strict.pass!.decided, false);
  assert.ok(strict.pass!.reasons.length > 0);
});

test('with no criteria supplied, pass is null (unknown), never a fabricated verdict', () => {
  const decisions = [decision({ acquiredSimMs: 0 })];
  const evaluatorByAcquiredSimMs = new Map([[0, evaluatorSnapshot(0)]]);
  const score = scoreEpisode({ ...baseInput, durationMs: 200, decisions, evaluatorByAcquiredSimMs, contacts: [] }, null);
  assert.equal(score.pass, null);
});

test('an episode with a large gap between decisions reports the gap as unknown coverage, not visible/detected time', () => {
  const decisions = [decision({ acquiredSimMs: 0 })]; // only one decision across a 2000ms duration
  const evaluatorByAcquiredSimMs = new Map([[0, evaluatorSnapshot(0)]]);
  const score = scoreEpisode({ ...baseInput, durationMs: 2000, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.ok(score.coverageUnknownMs > 1000, `expected most of the 2000ms duration to be unknown coverage, got ${score.coverageUnknownMs}`);
});

test('skipped acquisitions and wall-time totals are summed across decisions for budget reporting', () => {
  const decisions = [decision({ acquiredSimMs: 0, skippedAcquisitions: 2, cycleWallMs: 900 }), decision({ acquiredSimMs: 200, skippedAcquisitions: 1, cycleWallMs: 950 })];
  const evaluatorByAcquiredSimMs = new Map(decisions.map(d => [d.acquiredSimMs, evaluatorSnapshot(d.acquiredSimMs)]));
  const score = scoreEpisode({ ...baseInput, durationMs: 400, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.skippedAcquisitions, 3);
  assert.equal(score.wallTime.totalCycleWallMs, 1850);
  assert.equal(score.wallTime.perDecisionMeanWallMs, 925);
});

// engine-review-e2 finding 2: consequence-fidelity must cover EVERY option family with n reported,
// not just yaw and fixed-distance — this covers speed-hold, whose declared outcome is a RATE, not a
// fixed printed step, so it is compared as (range delta / elapsed time) against the declared speed.
// engine-review-e3 finding 3: fidelity is now measured from EVALUATOR TRUTH camera position/
// heading (never the sensor-delivered boundRangeM, which conflates the drone's own motion with the
// target's — see scoring.ts's own updated docstring), so these fixtures set DIFFERING true camera
// positions/headings between the two decisions to represent the realised motion, independent of
// whatever boundRangeM happens to be.
test('consequence fidelity covers yaw, fixed-distance range, and speed-hold range as three separate families, each with its own n', () => {
  const decisions = [
    decision({ acquiredSimMs: 0, chosenYawId: 'yaw_left_30', chosenRangeId: 'speed_1_0' }),
    decision({ acquiredSimMs: 1000, chosenYawId: 'yaw_left_30', chosenRangeId: 'speed_1_0' }),
  ];
  const evaluatorByAcquiredSimMs = new Map([
    [0, evaluatorSnapshot(0, { cameraPosition: { x: 0, y: 0, z: 1.8 }, cameraHeadingDeg: 0 })],
    // 1s later: heading turned exactly 30 deg (perfect yaw fidelity, error 0); TRUE ground distance
    // covered is exactly 1.0m over 1.0s (perfect speed-hold fidelity at the declared 1.0 m/s, error 0).
    [1000, evaluatorSnapshot(1000, { cameraPosition: { x: 1, y: 0, z: 1.8 }, cameraHeadingDeg: 30 })],
  ]);
  const score = scoreEpisode({ ...baseInput, durationMs: 1200, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.ok(score.consequenceFidelity, 'expected a non-null consequenceFidelity summary');
  assert.equal(score.consequenceFidelity!.yawAbsErrorDeg.n, 1);
  assert.equal(score.consequenceFidelity!.yawAbsErrorDeg.medianAbs, 0);
  assert.equal(score.consequenceFidelity!.rangeAbsErrorM.n, 0, 'no fixed-distance option was chosen, so that family must report n=0, not fold speed-hold samples into it');
  assert.equal(score.consequenceFidelity!.speedHoldAbsErrorMps.n, 1);
  assert.ok(Math.abs(score.consequenceFidelity!.speedHoldAbsErrorMps.medianAbs!) < 1e-9);
});

test('speed-hold fidelity reports a nonzero error when the realised GROUND SPEED misses the declared setpoint (never conflated with target motion)', () => {
  const decisions = [
    decision({ acquiredSimMs: 0, chosenYawId: 'hold', chosenRangeId: 'speed_2_0' }),
    decision({ acquiredSimMs: 1000, chosenYawId: 'hold', chosenRangeId: 'speed_2_0' }),
  ];
  const evaluatorByAcquiredSimMs = new Map([
    [0, evaluatorSnapshot(0, { cameraPosition: { x: 0, y: 0, z: 1.8 } })],
    // Declared 2.0 m/s; the drone's own TRUE ground displacement is only 1.0m over 1.0s (1.0 m/s
    // realised) -> 1.0 m/s error, regardless of what the (unset, sensor-side) target motion was.
    [1000, evaluatorSnapshot(1000, { cameraPosition: { x: 1, y: 0, z: 1.8 } })],
  ]);
  const score = scoreEpisode({ ...baseInput, durationMs: 1200, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.equal(score.consequenceFidelity!.speedHoldAbsErrorMps.n, 1);
  assert.ok(Math.abs(score.consequenceFidelity!.speedHoldAbsErrorMps.medianAbs! - 1.0) < 1e-9);
});

test('speed-hold fidelity is UNAFFECTED by target motion (the old broken metric would have conflated it via the sensor-delivered range)', () => {
  // The drone's own true motion is 2.0 m/s (matches the declared setpoint exactly -> error 0), but
  // the "sensor-delivered" boundRangeM closes much faster (as if the target were also approaching
  // fast) — the OLD metric (range-closing-rate) would have reported this as a large speed error;
  // the NEW one, reading only true camera position, must not.
  const decisions = [
    decision({ acquiredSimMs: 0, chosenYawId: 'hold', chosenRangeId: 'speed_2_0', boundRangeM: 10 }),
    decision({ acquiredSimMs: 1000, chosenYawId: 'hold', chosenRangeId: 'speed_2_0', boundRangeM: 3 }), // huge sensor-side range closure
  ];
  const evaluatorByAcquiredSimMs = new Map([
    [0, evaluatorSnapshot(0, { cameraPosition: { x: 0, y: 0, z: 1.8 } })],
    [1000, evaluatorSnapshot(1000, { cameraPosition: { x: 2, y: 0, z: 1.8 } })], // TRUE: exactly 2.0 m/s
  ]);
  const score = scoreEpisode({ ...baseInput, durationMs: 1200, decisions, evaluatorByAcquiredSimMs, contacts: [] });
  assert.ok(Math.abs(score.consequenceFidelity!.speedHoldAbsErrorMps.medianAbs!) < 1e-9, `expected ~0 error (drone truly hit 2.0 m/s) despite a huge sensor-side range closure, got ${score.consequenceFidelity!.speedHoldAbsErrorMps.medianAbs}`);
});
