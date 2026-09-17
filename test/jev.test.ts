import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, Observation, RobotDescription, RobotPort } from '../src/contracts.ts';
import { createChoiceController, createDroneRouteCandidates, createJevJudge, type Candidate, type ChoiceAnswer, type ChoiceJudge } from '../controllers/jev.ts';

const choices: Candidate[] = [
  { id: 'hold', description: 'Wait.', command: null },
  { id: 'forward', description: 'Visit a mission waypoint.', command: { action: 'goto', args: { x: 2, y: 0, z: 1 } } },
];
const answer: ChoiceAnswer = { choice: 'forward', confidence: .9, probabilities: { hold: .05, forward: .95 } };
function fixture() {
  const observation: Observation = { epoch: 'epoch-one', robotId: 'drone-1', sequence: 1, simMs: 100, wallMs: Date.now(), goal: 'Inspect the waypoint',
    sensors: { odometry: { value: { position: { x: 0, y: 0, z: 1 } }, sequence: 1, acquiredSimMs: 90, receivedSimMs: 95, valid: true }, lidar: { value: { distances: [null, 5, 4] }, sequence: 1, acquiredSimMs: 90, receivedSimMs: 95, valid: true } }, jobs: [], inbox: [], events: [] };
  const description: RobotDescription = { id: 'drone-1', model: 'drone', commands: {
    goto: { description: 'goto', schema: { type: 'object', required: ['x', 'y', 'z'], properties: { x: { type: 'number', minimum: -10, maximum: 10 }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false } },
    hold: { description: 'hold', schema: { type: 'object', additionalProperties: false } },
  }, sensors: [], radio: { channel: 'test', rangeM: 1, bitrateBps: 100, latencyMs: 0, jitterMs: 0, loss: 0, maxQueueBytes: 100, maxPacketBytes: 10 }, units: 'SI ENU' };
  const commands: Command[] = [];
  let stops = 0, closes = 0;
  const port: RobotPort = { robotId: 'drone-1', describe: async () => description, observe: async () => structuredClone(observation),
    command: async command => { commands.push(command); return { id: command.id, status: 'accepted' }; },
    acknowledge: async () => {}, send: async () => ({ accepted: true }), stop: async () => { stops++; }, close: async () => { closes++; } };
  return { port, description, observation, commands, get stops() { return stops; }, get closes() { return closes; } };
}
async function runOnce(judge: ChoiceJudge, f = fixture()) {
  const events: { kind: string; data: any }[] = [];
  const controller = createChoiceController({ judge, candidates: () => choices, requiredSensors: ['odometry'], maxCalls: 1, intervalMs: 1, deadlineMs: 200, maxDurationMs: 500, record: (kind, data) => events.push({ kind, data }) });
  await controller.run([f.port], new AbortController().signal);
  return { f, events };
}

test('Jev executes code-owned candidate arguments with fresh observation and watchdog', async () => {
  const { f, events } = await runOnce(async request => {
    assert.equal(request.observation.robotId, 'drone-1');
    assert.deepEqual(Object.keys(request.candidates[1]!), ['id', 'description']);
    return answer;
  });
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0]!.args, { x: 2, y: 0, z: 1 });
  assert.equal(f.commands[0]!.basedOn?.observation, 1);
  assert.equal(f.commands[0]!.validForMs, 1000);
  assert.equal(f.stops, 1); assert.equal(f.closes, 1);
  assert.ok(events.some(event => event.kind === 'jev.decision' && event.data.latencyMs >= 0));
});

test('unknown or malformed choices produce a local hold, never an actuator guess', async () => {
  for (const result of [{ ...answer, choice: 'shell' }, { ...answer, probabilities: { forward: NaN, hold: 0 } }]) {
    const { f, events } = await runOnce(async () => result);
    assert.deepEqual(f.commands.map(command => command.action), ['hold']);
    assert.ok(events.some(event => event.data.reason === 'invalid-or-low-confidence-choice'));
  }
});

test('request deadlines discard late results and prevent overlapping uncooperative calls', async () => {
  const f = fixture(); let calls = 0; let resolve: (value: ChoiceAnswer) => void = () => {};
  const events: string[] = []; const signal = AbortSignal.timeout(60);
  const controller = createChoiceController({ judge: async () => { calls++; return new Promise(done => { resolve = done; }); }, candidates: () => choices,
    deadlineMs: 10, intervalMs: 2, maxCalls: 10, maxDurationMs: 300, record: kind => events.push(kind) });
  await controller.run([f.port], signal);
  assert.equal(calls, 1); assert.equal(f.closes, 1);
  assert.deepEqual(f.commands.map(command => command.action), ['hold']);
  resolve(answer); await new Promise(done => setImmediate(done));
  assert.deepEqual(f.commands.map(command => command.action), ['hold']);
  assert.ok(events.includes('jev.discarded'));
});

test('cancellation closes a lease while judge ignores abort', async () => {
  const f = fixture(); const abort = new AbortController(); let judgeSignal: AbortSignal | undefined;
  const controller = createChoiceController({ judge: async (_request, signal) => { judgeSignal = signal; setTimeout(() => abort.abort(), 5); return new Promise(() => {}); }, candidates: () => choices, deadlineMs: 5000 });
  await controller.run([f.port], abort.signal);
  assert.equal(judgeSignal?.aborted, true); assert.equal(f.commands.length, 0); assert.equal(f.closes, 1);
});

test('stale required sensors suppress inference and use only local hold', async () => {
  const f = fixture(); f.observation.simMs = 5000; let calls = 0;
  const controller = createChoiceController({ judge: async () => { calls++; return answer; }, candidates: () => choices, requiredSensors: ['odometry'], intervalMs: 2, maxDurationMs: 25 });
  await controller.run([f.port], new AbortController().signal);
  assert.equal(calls, 0); assert.ok(f.commands.length > 0); assert.ok(f.commands.every(command => command.action === 'hold'));
});

test('changed epoch or stale observation during inference cannot execute an old choice', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.observation.epoch = 'new-epoch'; }, (f: ReturnType<typeof fixture>) => { f.observation.simMs = 5000; }]) {
    const f = fixture();
    const result = await runOnce(async () => { mutate(f); return answer; }, f);
    assert.deepEqual(f.commands.map(command => command.action), ['hold']);
    assert.ok(result.events.some(event => event.data.reason === 'changed-or-stale-observation'));
  }
});

test('an option removed while inference runs is revalidated before admission', async () => {
  const f = fixture(); let blocked = false;
  const controller = createChoiceController({ judge: async () => { blocked = true; return answer; }, candidates: () => blocked ? [choices[0]!] : choices, maxCalls: 1, intervalMs: 1 });
  await controller.run([f.port], new AbortController().signal);
  assert.deepEqual(f.commands.map(command => command.action), ['hold']);
});

test('new sensor samples cannot refresh the old evidence used by an in-flight decision', async () => {
  const f = fixture(); f.observation.simMs = 900; f.observation.sensors.odometry!.acquiredSimMs = 0;
  const result = await runOnce(async () => {
    f.observation.simMs = 1500; f.observation.sensors.odometry!.acquiredSimMs = 1490;
    return answer;
  }, f);
  assert.deepEqual(f.commands.map(command => command.action), ['hold']);
  assert.ok(result.events.some(event => event.data.reason === 'changed-or-stale-observation'));
});

test('malformed application candidates fail before model calls and close the lease', async () => {
  const f = fixture(); let calls = 0;
  const controller = createChoiceController({ judge: async () => { calls++; return answer; }, candidates: () => [{ id: 'unsafe', description: 'Out of range', command: { action: 'goto', args: { x: 900, y: 0, z: 0 } } }] });
  await assert.rejects(controller.run([f.port], new AbortController().signal), /advertised command schema/);
  assert.equal(calls, 0); assert.equal(f.closes, 1);
});

test('HTTP adapter follows official choice schema, records usage, and never retries', async () => {
  let calls = 0;
  const judge = createJevJudge({ apiKey: 'test-only', fetch: async (url, init) => {
    calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.action.type, 'choice'); assert.equal(body.questions.action.criteria.forward, choices[1]!.description);
    return Response.json({ model: 'jev-test', answers: { action: { ...answer, type: 'choice' } }, usage: { input_tokens: 123 } });
  } });
  const result = await judge({ observation: fixture().observation, candidates: choices, instructions: 'Choose' }, new AbortController().signal);
  assert.equal(result.inputTokens, 123); assert.equal(result.choice, 'forward'); assert.equal(calls, 1);
  const failure = createJevJudge({ apiKey: 'test-only', fetch: async () => { calls++; return new Response('Error', { status: 429 }); } });
  await assert.rejects(failure({ observation: fixture().observation, candidates: choices, instructions: 'Choose' }, new AbortController().signal), /429/);
  assert.equal(calls, 2);
});

test('HTTP adapter bounds response memory and rejects a malformed response', async () => {
  for (const response of [new Response('x'.repeat(65537)), Response.json({ answers: { action: { type: 'choice', ...answer, choice: 'unoffered' } } })]) {
    const judge = createJevJudge({ apiKey: 'test-only', fetch: async () => response });
    await assert.rejects(judge({ observation: fixture().observation, candidates: choices, instructions: 'Choose' }, new AbortController().signal), /64 KiB|Malformed/);
  }
});

test('waypoint palette uses only delivered odometry and lidar, with a proximity hold', () => {
  const f = fixture(); const candidates = createDroneRouteCandidates([{ x: 2, y: 0, z: 1 }]);
  assert.equal(candidates(f.observation).length, 2);
  f.observation.sensors.lidar!.value = { distances: [null, .2, 3] };
  assert.deepEqual(candidates(f.observation).map(candidate => candidate.id), ['hold']);
});
