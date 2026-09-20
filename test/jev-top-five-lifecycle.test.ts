import assert from 'node:assert/strict';
import test from 'node:test';
import { executeLifecycle, FRESHNESS_ARMS, generateLifecycleCases, LIFECYCLE_ACTIONS, runFreshnessExperiment, scoreLifecycle } from '../experiments/jev-top-five/lifecycle.ts';

test('freshness dispatch applies supported effects and rejects changed dependencies', () => {
  const report = runFreshnessExperiment();
  const dependency = report.summary.find(s => s.arm === 'action-dependencies')!;
  assert.deepEqual(dependency, { arm: 'action-dependencies', cases: 18, supportedOpportunities: 4,
    applied: 4, usefulApplied: 4, unsafeApplied: 0, missedUseful: 0, gatePassed: true });
  for (const c of report.cases) for (const outcome of c.outcomes) {
    assert.equal(outcome.applied, outcome.trace.some(t => t.event === 'effect-applied'));
    assert.equal(outcome.positionM, outcome.applied ? 0.1 : 0);
  }
  assert.ok(report.summary.find(s => s.arm === 'age-only')!.unsafeApplied > 0);
  assert.ok(report.summary.find(s => s.arm === 'whole-observation')!.missedUseful > 0);
  const reuse = report.cases.find(c => c.id === 'target-id-reused')!;
  assert.equal(reuse.outcomes.find(o => o.arm === 'action-dependencies')!.reason, 'target-binding');
});

test('all freshness arms share Stop, goal, owner and command deadline checks', () => {
  const report = runFreshnessExperiment();
  for (const id of ['stop', 'goal-changed', 'owner-revoked', 'command-expired', 'command-expires-before-braking-finishes']) {
    const c = report.cases.find(c => c.id === id)!;
    assert.equal(c.outcomes.length, FRESHNESS_ARMS.length);
    assert.ok(c.outcomes.every(o => !o.applied && o.reason !== null));
  }
  assert.deepEqual(runFreshnessExperiment(), report);
});

test('forecast and command validity cover execution plus braking, not only application', () => {
  const report = runFreshnessExperiment();
  const forecast = report.cases.find(c => c.id === 'forecast-expires-before-braking-finishes')!;
  assert.ok(forecast.latest.predictedUntil > forecast.at);
  for (const outcome of forecast.outcomes) {
    assert.ok(outcome.horizon.executionEndsAt < forecast.latest.predictedUntil);
    assert.ok(outcome.horizon.brakingEndsAt > forecast.latest.predictedUntil);
    assert.equal(outcome.evaluation.requirements.forecastLifetime, false);
  }
  assert.equal(forecast.outcomes.find(o => o.arm === 'action-dependencies')!.applied, false);
  assert.ok(forecast.outcomes.filter(o => o.arm !== 'action-dependencies').every(o => o.unsafeApplied));
  const deadline = report.cases.find(c => c.id === 'command-expires-before-braking-finishes')!;
  assert.ok(deadline.proposal.expiresAt > deadline.at);
  assert.ok(deadline.outcomes.every(o => o.reason === 'command-horizon-expired' && !o.applied));
  const supported = report.cases.find(c => c.id === 'unchanged-delayed-answer')!;
  for (const outcome of supported.outcomes) {
    assert.equal(outcome.trace.find(t => t.event === 'effect-applied')!.at, outcome.horizon.executionEndsAt);
    assert.equal(outcome.trace.find(t => t.event === 'braking-interval-ended')!.at, outcome.horizon.brakingEndsAt);
    assert.ok(outcome.horizon.brakingEndsAt > outcome.horizon.executionEndsAt);
  }
});

test('lifecycle freezes 64 paired requests with identical facts and executable menus', () => {
  const probes = generateLifecycleCases();
  assert.equal(probes.length, 64);
  assert.equal(new Set(probes.map(p => p.id)).size, 64);
  assert.equal(new Set(probes.map(p => p.unit)).size, 16);
  for (let i = 0; i < probes.length; i += 2) {
    const a = probes[i]!; const b = probes[i + 1]!;
    assert.deepEqual(a.request.state, b.request.state);
    assert.deepEqual(a.meta.fixture, b.meta.fixture);
    assert.deepEqual(Object.keys((a.request.questions.action as any).criteria), LIFECYCLE_ACTIONS);
    for (const action of LIFECYCLE_ACTIONS) assert.deepEqual(executeLifecycle(a, action), executeLifecycle(b, action));
    assert.ok(!JSON.stringify(a.request).includes('"family"'));
    assert.ok(!JSON.stringify(a.request).includes('expected'));
  }
});

const probe = (family: string) => generateLifecycleCases().find(p => p.meta.family === family)!;

test('quiet productive jobs preserve measured progress; repeated reconstruction loses it', () => {
  const p = probe('quiet-progress');
  const continued = executeLifecycle(p, 'm0');
  const restarted = executeLifecycle(p, 'm2');
  assert.equal(continued.completed, true);
  assert.equal(continued.progress, 2);
  assert.equal(continued.resetCount, 0);
  assert.equal(restarted.completed, false);
  assert.equal(restarted.needlessReset, true);
  assert.equal(restarted.progress, 0);
  assert.equal(restarted.discardedReadings, 2);
  assert.equal(continued.after.id, continued.before.id);
});

test('repairing real failures accepts either equivalent reconstruction capability', () => {
  const p = probe('worker-failure');
  assert.equal(executeLifecycle(p, 'm0').addedReadings, 0);
  for (const action of ['m1', 'm2']) {
    const score = scoreLifecycle(p, { action });
    assert.equal(score.correct, true);
    assert.equal(score.details.recoveredFailure, true);
    assert.equal(score.details.needlessReset, false);
  }
});

test('target and goal changes require replacement; old job never acquires for a stale request', () => {
  for (const family of ['changed-target', 'changed-goal']) {
    const p = probe(family);
    assert.equal(executeLifecycle(p, 'm0').addedReadings, 0);
    assert.equal(executeLifecycle(p, 'm2').addedReadings, 0);
    const changed = executeLifecycle(p, 'm1');
    assert.equal(changed.addedReadings, 2);
    assert.equal(changed.progress, 2);
    assert.equal(changed.needlessReset, false);
    assert.equal(changed.unsafeApplied, false);
  }
});

test('blocked and temporarily absent observations preserve buffers without invented readings', () => {
  const blocked = executeLifecycle(probe('blocked-resource'), 'm0');
  assert.equal(blocked.addedReadings, 0);
  assert.equal(blocked.after.samples.length, 2);
  const missing = executeLifecycle(probe('missing-observation'), 'm0');
  assert.equal(missing.addedReadings, 1);
  assert.equal(missing.after.samples.length, 3);
  assert.ok(missing.trace.some(t => t.reason === 'missing-observation'));
  assert.ok(missing.trace.some(t => t.reason === 'demand-expired'));
  assert.equal(missing.resetCount, 0);
});

test('refresh cannot extend revoked authority; completion needs no repeated acquisition', () => {
  for (const action of LIFECYCLE_ACTIONS) {
    const result = executeLifecycle(probe('expired-authority'), action);
    assert.equal(result.addedReadings, 0);
    assert.equal(result.unsafeApplied, false);
  }
  for (const action of ['m0', 'm3']) {
    const result = scoreLifecycle(probe('completed'), { action });
    assert.equal(result.correct, true);
    assert.equal(result.details.addedReadings, 0);
  }
  assert.equal(scoreLifecycle(probe('quiet-progress'), { action: 'invalid' }).correct, false);
});
