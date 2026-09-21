import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, evaluatorFrameFromSnapshot } from '../experiments/jev-find-follow/report.ts';
import { scoreEpisode } from '../experiments/jev-find-follow/scoring.ts';
import type { DecisionRecord, Mode } from '../experiments/jev-find-follow/types.ts';
import type { EvaluatorSnapshot } from '../experiments/jev-find-follow/evaluator.ts';

function decision(): DecisionRecord & { mode: Mode } {
  return {
    index: 0, mode: 'track', modeReason: 'target bound', acquiredSimMs: 0, observationAvailableSimMs: 140, dispatchedSimMs: 140, returnedSimMs: 390, appliedSimMs: 410,
    acquireWallMs: 450, perceptionWallMs: 140, controllerWallMs: 5, cycleWallMs: 900, skippedAcquisitions: 0, acquisitionsThisCycle: 1,
    request: { model: 'jev-1.13.0', state: {}, questions: {} } as any, response: { model: 'jev-1.13.0', answers: {}, synthetic: true } as any,
    chosenManeuver: 'hold', chosenYawId: 'hold', chosenRangeId: 'hold', maneuverOutcome: 'accepted', maneuverVeto: null,
    unexpectedRejection: false, observedFault: null, controllerLatencyTimedOut: false,
    ownState: { headingDeg: 0, altitudeM: 1.8, odometryDisplacementM: { x: 0, y: 0 }, acquiredSimMs: 0 },
    acquisitionPose: { position: { x: 0, y: 0, z: 1.8 }, headingDeg: 0 }, predictedApplicationPose: { position: { x: 0, y: 0, z: 1.8 }, headingDeg: 0 },
    bind: { status: 'none', candidates: [], boundIndex: null }, boundBearingRightRad: null, boundRangeM: null, evidenceSource: 'none', frameRef: null,
  };
}

function snapshot(): EvaluatorSnapshot {
  return {
    acquiredSimMs: 0, cameraPosition: { x: 0, y: 0, z: 1.8 }, cameraHeadingDeg: 0,
    target: { id: 't', kind: 'target', pose: { position: { x: 8, y: 0, z: 0.6 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, halfExtents: { x: 2.25, y: 1.1, z: 0.6 } },
    lookalikes: [], trueNearestSurfaceRangeM: 5.75, trueBearingRightRad: 0, targetWithinFov: true,
  };
}

test('evaluatorFrameFromSnapshot converts a quaternion to a plain yaw degree, never leaking the quaternion itself', () => {
  const frame = evaluatorFrameFromSnapshot(snapshot(), 70);
  assert.equal(typeof frame.target.yawDeg, 'number');
  assert.ok(!('rotation' in (frame.target as any)));
});

test('buildReport produces the declared schema, with the evaluator section clearly labelled as not shown to the controller', () => {
  const decisions = [decision()];
  const evaluatorByAcquiredSimMs = new Map([[0, snapshot()]]);
  const score = scoreEpisode({
    decisions, evaluatorByAcquiredSimMs, contacts: [], durationMs: 1000, requestedRangeM: 8, rangeToleranceM: 1, hfovDeg: 70,
    centralBandFraction: 0.3, cameraPeriodMs: 200, identityBearingToleranceRad: 0.2, identityRangeToleranceM: 2,
    envelope: { minAltitudeM: 0.5, maxAltitudeM: 6, maxRadiusFromOriginM: 60 }, originPosition: { x: 0, y: 0 },
  });
  const report = buildReport({
    meta: {
      scenarioId: 'visible-track', controllerId: 'passive', synthetic: true, seed: 1, generatedAtIso: new Date().toISOString(),
      durationMs: 1000, goal: { classes: ['car'], colour: 'blue', description: 'the blue car', requestedRangeM: 8 }, config: {}, sourceSha256: null,
      partial: false, failureReason: null,
    },
    decisions, score, evaluatorFrames: [evaluatorFrameFromSnapshot(snapshot(), 70)], totalWallMs: 900,
  });
  assert.equal(report.meta.schema, 'jev-find-follow-report/1');
  assert.equal(report.meta.synthetic, true);
  assert.equal(report.decisions.length, 1);
  assert.equal(report.evaluatorOnly.label, 'NOT shown to the controller — evaluator/scoring truth only');
  assert.equal(report.evaluatorOnly.frames.length, 1);
  assert.equal(report.score, score);
  assert.ok(report.wallTimeBudget.wallMsPerSimulatedSecond > 0);
  assert.equal(report.wallTimeBudget.wallMsPerDecision, 900);
  // Round-trips through JSON (what actually gets written to report.json) without losing shape.
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.equal(roundTripped.meta.schema, 'jev-find-follow-report/1');
  assert.equal(roundTripped.decisions[0].request.model, 'jev-1.13.0');
});

test('a synthetic/reference controller is unmistakably labelled at both the top level and on every decision', () => {
  const decisions = [decision()];
  const report = buildReport({
    meta: { scenarioId: 'turn-to-find', controllerId: 'reference', synthetic: true, seed: 1, generatedAtIso: new Date().toISOString(), durationMs: 1000, goal: { classes: ['car'], description: 'the blue car', requestedRangeM: 8 }, config: {}, sourceSha256: null, partial: false, failureReason: null },
    decisions, score: scoreEpisode({ decisions, evaluatorByAcquiredSimMs: new Map(), contacts: [], durationMs: 1000, requestedRangeM: 8, rangeToleranceM: 1, hfovDeg: 70, centralBandFraction: 0.3, cameraPeriodMs: 200, identityBearingToleranceRad: 0.2, identityRangeToleranceM: 2, envelope: { minAltitudeM: 0.5, maxAltitudeM: 6, maxRadiusFromOriginM: 60 }, originPosition: { x: 0, y: 0 } }),
    evaluatorFrames: [], totalWallMs: 500,
  });
  assert.equal(report.meta.synthetic, true);
  assert.equal(report.decisions[0]!.response.synthetic, true);
});
