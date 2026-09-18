import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReactiveWorld } from '../experiments/reactive/world.ts';
import { axesRequest, compose, AXES, COMBINATIONS, axesController } from '../experiments/jev-axes/controller.ts';
import { MODEL, type Request, type Response } from '../experiments/jev-strategies/strategies.ts';
import { trial } from '../experiments/reactive/run.ts';
import { assertSensorCausality, report } from '../experiments/jev-strategies/report.ts';
import { continuationPlan } from '../experiments/jev-strategies/resume.ts';

test('Causality audit uses unrounded evidence, and still rejects genuinely future receipts', () => {
  const observation = { simMs: 32439.999999999996, sensors: { odometry: { acquiredSimMs: 32420, receivedSimMs: 32439.999999999996 } } };
  assertSensorCausality(observation);
  observation.sensors.odometry.receivedSimMs = 32441;
  assert.throws(() => assertSensorCausality(observation), /Noncausal/);
});

test('Funding continuation retains crashes and model errors; only evidenced billing failures qualify for a new attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-resume-fixture-'));
  try {
    for (const [id, kind, status] of [['collision', 'strategy.response', 200], ['bad-request', 'strategy.http-error', 400], ['unfunded', 'strategy.http-error', 402], ['partial', 'strategy.http-error', 402]] as const)
      await writeFile(join(directory, `${id}.jsonl`), JSON.stringify({ kind, data: { status } }) + '\n');
    const plan = await continuationPlan(directory, { results: [{ id: 'collision', success: false }, { id: 'bad-request', errors: 1 }, { id: 'unfunded' }], invalidTrials: [{ id: 'partial' }] });
    assert.deepEqual(plan.retained.map(r => r.id), ['collision', 'bad-request']);
    assert.deepEqual(plan.billing.map(r => r.id), ['unfunded', 'partial']);
    await assert.rejects(continuationPlan(directory, { results: [], invalidTrials: [{ id: 'collision' }] }), /Only documented billing/);
  } finally {
    assert(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true, force: true });
  }
});

function answer(request: Request): Response {
  const choices: Record<string, string> = { velocity_x: 'v3', velocity_y: 'v3', velocity_z: 'v3', camera_heading: 'v4', camera_pitch: 'v3', camera_zoom: 'wide' };
  return { model: MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, { type: 'choice', choice: choices[id], confidence: 1,
    probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choices[id] ? 1 : 0])) }])), usage: { input_tokens: 100, output_tokens: 1 } };
}
async function observation() {
  const world = await ReactiveWorld.create(29);
  try { return await world.controllerPort().observe(); } finally { await world.close(); }
}
test('The factored information ablation changes only derived geometry; all 43,218 tuples stay offered across goals', async () => {
  const obs = await observation(), before = structuredClone(obs);
  const raw = axesRequest(obs, 'axes-raw'), facts = axesRequest(obs, 'axes-geometry');
  assert.equal(Object.keys(raw.questions).length, 6);
  assert.equal(Object.values(raw.questions).reduce((n, q) => n * Object.keys(q.criteria).length, 1), COMBINATIONS);
  assert.equal(COMBINATIONS, 43218);
  const { derivedGeometry, ...state } = facts.state as any;
  assert(derivedGeometry);
  assert.deepEqual(state, raw.state);
  assert.deepEqual(facts.questions, raw.questions);
  assert.deepEqual(axesRequest({ ...obs, goal: 'A different English instruction' }, 'axes-raw').questions, raw.questions);
  assert.deepEqual(obs, before);
  assert.equal((raw.state as any).sensors.ranges.value.points.length, (obs.sensors.ranges!.value as any).points.length);
});
test('Factor mapping executes exact returned values and uses original camera data; no argmax replacement', async () => {
  const obs = await observation(), request = axesRequest(obs, 'axes-raw'), body = answer(request);
  body.answers.velocity_x = { type: 'choice', choice: 'v6', confidence: .1, probabilities: { v0: 0, v1: 0, v2: 0, v3: .5, v4: .01, v5: 0, v6: .49 } };
  const mapping = compose(obs, request, body);
  assert.equal(mapping.candidate.action.x, 1.1);
  assert.equal(mapping.candidate.action.y, 0);
  assert.equal(mapping.candidate.action.z, 0);
  const fresh = structuredClone(obs); (fresh.sensors.camera!.value as any).headingDeg += 20;
  assert.deepEqual(compose(fresh, request, body), mapping);
  assert.throws(() => compose({ ...obs, sequence: obs.sequence + 1 }, request, body), /Observation mismatch/);
  body.answers.velocity_x.choice = 'invented';
  assert.throws(() => compose(obs, request, body));
});
test('Invalid target measurements do not become geometry evidence', async () => {
  const obs = await observation(); obs.sensors.target!.valid = false;
  assert.equal((axesRequest(obs, 'axes-geometry').state as any).derivedGeometry.available, false);
});
test('Factored controller trace audits sensor provenance, exact model-to-command mapping and actual applications', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-axes-fixture-'));
  try {
    let record = (_kind: string, _data: unknown) => {};
    const { controller, stats } = axesController('axes-raw', 'fixture-no-key', (kind, data) => record(kind, data), async request => answer(request));
    const result = await trial({ arm: 'axes-raw', seed: 31, seconds: 3, directory, phase: 'fixture', controller, connectControllerTrace: emit => { record = emit; } });
    assert(stats.started > 0); assert(stats.admitted > 0);
    const manifest = { phase: 'fixture', sourceHash: result.sourceHash, strategies: ['axes-raw'], definitions: AXES, seeds: [31], seconds: 3 };
    await writeFile(join(directory, 'results.json'), JSON.stringify({ manifest, results: [{ ...result, hostStats: result.stats, stats }], invalidTrials: [] }));
    const audited = await report(directory);
    assert.equal(audited.runs[0].decisions[0].offered, COMBINATIONS);
    assert(audited.runs[0].decisions.some((d: any) => d.appliedMs !== null));
    const file = join(directory, 'axes-raw-31.jsonl');
    const original = await readFile(file, 'utf8');
    const fabricated = original.trim().split('\n').map(line => JSON.parse(line));
    fabricated.find(row => row.kind === 'axes.request').data.rawObservation.goal = 'Fabricated sensor evidence';
    await writeFile(file, fabricated.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(report(directory), /observation actually delivered/);
    const lines = original.trim().split('\n').map(line => JSON.parse(line));
    lines.find(row => row.kind === 'axes.mapping').data.candidate.action.x = .6;
    await writeFile(file, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(report(directory), /Mapped command differs/);
  } finally {
    assert(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true, force: true });
  }
});
