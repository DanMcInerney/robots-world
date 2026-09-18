import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Command, Observation, RobotDescription, RobotPort } from '../src/contracts.ts';
import { createChoiceController, createDroneRouteCandidates, createJevJudge, type Candidate, type ChoiceAnswer, type ChoiceJudge, type ChoiceRequest } from '../controllers/jev.ts';
import { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { scenario } from '../scenarios/index.ts';

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
    return Response.json({ model: 'jev-test', answers: { action: { ...answer, type: 'choice' } }, usage: { input_tokens: 123, output_tokens: 7 } });
  } });
  const result = await judge({ observation: fixture().observation, candidates: choices, instructions: 'Choose' }, new AbortController().signal);
  assert.equal(result.inputTokens, 123); assert.equal(result.outputTokens, 7); assert.equal(result.model, 'jev-test');
  assert.equal(judge.requestedModel, 'jev-latest'); assert.equal(result.requestedModel, 'jev-latest'); assert.equal(result.choice, 'forward'); assert.equal(calls, 1);
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

test('decision trace correlates the original sensor evidence, returned model, command and admission', async () => {
  const f = fixture(); const original = structuredClone(f.observation);
  const judge = Object.assign(async (request: ChoiceRequest) => {
    assert.ok(request.decisionId);
    f.observation.sequence = 2; f.observation.simMs = 120;
    f.observation.sensors.odometry!.acquiredSimMs = 110;
    return { ...answer, model: 'jev-exact-version', requestedModel: 'jev-alias', inputTokens: 43, outputTokens: 5 };
  }, { requestedModel: 'jev-alias' }) as ChoiceJudge;
  const { events } = await runOnce(judge, f);
  const input = events.find(event => event.kind === 'jev.input')!.data;
  const candidate = events.find(event => event.kind === 'jev.candidates')!.data;
  const result = events.find(event => event.kind === 'jev.answer')!.data;
  const command = events.find(event => event.kind === 'jev.command-submitted')!.data;
  const admission = events.find(event => event.kind === 'jev.admission')!.data;
  assert.deepEqual(input.snapshot, original);
  assert.equal(input.requestedModel, 'jev-alias');
  assert.equal(input.sensorTimes.odometry.acquiredSimMs, 90);
  assert.equal(command.sensorTimes.odometry.acquiredSimMs, 90);
  assert.equal(command.command.basedOn.observation, 2);
  assert.equal(command.observation, 1);
  assert.deepEqual(candidate.candidates, choices);
  assert.equal(result.answer.model, 'jev-exact-version');
  assert.equal(result.answer.inputTokens, 43); assert.equal(result.answer.outputTokens, 5);
  assert.equal(admission.commandId, command.command.id);
  assert.equal(admission.receipt.status, 'accepted');
  assert.ok([candidate, result, command, admission].every(event => event.decisionId === input.decisionId && event.runId === input.runId));
});

test('long runs drain recorded execution events without consuming radio messages', async () => {
  const config = scenario('portable');
  const robot = config.robots[0]!; robot.id = 'r'.repeat(64);
  config.robots.push({ ...structuredClone(robot), id: 'peer', pose: { ...robot.pose, position: { x: 0, y: 3, z: 1 } } });
  const world = await World.create(config, defaultRegistry(), 'kinematic');
  try {
    const raw = world.claim(robot.id, 'jev-long-run'), peer = world.claim('peer', 'sender');
    await peer.send({ id: 'retain-this-packet', to: robot.id, data: 'Unconsumed peer message', ttlMs: 10000 });
    await world.advance(10);
    const packetId = (await raw.observe()).inbox[0]!.id;
    const traces: { kind: string; data: any }[] = [];
    const recordedEventIds = new Set<number>(); let acknowledges = 0;
    const port: RobotPort = { ...raw, acknowledge: async (throughEvent, packetIds) => {
      assert.deepEqual(packetIds, []);
      const unread = await raw.observe();
      for (const event of unread.events.filter(event => event.id <= throughEvent)) assert.ok(recordedEventIds.has(event.id), 'event must be recorded before acknowledgement');
      await raw.acknowledge(throughEvent, packetIds); acknowledges++;
    } };
    const controller = createChoiceController({ judge: async () => answer, candidates: () => choices, intervalMs: 1, deadlineMs: 1000, maxCalls: 180, maxDurationMs: 10000,
      record: (kind, data: any) => { traces.push({ kind, data }); if (kind === 'jev.execution-event') recordedEventIds.add(data.event.id); } });
    await controller.run([port], new AbortController().signal);
    const admissions = traces.filter(event => event.kind === 'jev.admission');
    assert.equal(admissions.length, 180); assert.ok(admissions.every(event => event.data.receipt.status === 'accepted'));
    assert.ok(recordedEventIds.size > 128, 'exercise more events than the world unread-event capacity');
    assert.ok(acknowledges >= 179);
    assert.ok(traces.some(event => event.kind === 'jev.execution-event' && event.data.event.kind === 'job.cancelled' && event.data.correlated));
    const reacquired = world.claim(robot.id, 'inspect-after-run');
    const final = await reacquired.observe();
    assert.equal(final.fault, undefined);
    assert.equal(final.inbox.length, 1); assert.equal(final.inbox[0]!.id, packetId);
    assert.ok(traces.filter(event => event.kind === 'jev.command-submitted').every(event => event.data.command.id.length <= 96));
    await reacquired.close(); await peer.close();
  } finally { world.close(); }
});

test('a failed execution-event recorder prevents acknowledgement', async () => {
  const f = fixture(); f.observation.events = [{ id: 1, kind: 'job.completed', data: { commandId: 'prior' } }];
  let acknowledgements = 0; f.port.acknowledge = async () => { acknowledgements++; };
  const controller = createChoiceController({ judge: async () => answer, candidates: () => choices, record: kind => { if (kind === 'jev.execution-event') throw new Error('storage unavailable'); } });
  await assert.rejects(controller.run([f.port], new AbortController().signal), /storage unavailable/);
  assert.equal(acknowledgements, 0); assert.equal(f.closes, 1);
});

test('late discarded answers retain correlation and usage while never reaching actuators', async () => {
  const f = fixture(); const records: { kind: string; data: any }[] = [];
  let resolve!: (answer: ChoiceAnswer) => void;
  const controller = createChoiceController({ judge: async () => new Promise(done => { resolve = done; }), candidates: () => choices,
    deadlineMs: 5, intervalMs: 1, maxCalls: 1, record: (kind, data) => records.push({ kind, data }) });
  await controller.run([f.port], new AbortController().signal);
  resolve({ ...answer, model: 'late-model', inputTokens: 80, outputTokens: 4 });
  await new Promise(done => setImmediate(done));
  const input = records.find(event => event.kind === 'jev.input')!.data;
  const late = records.find(event => event.kind === 'jev.late-discarded')!.data;
  assert.equal(late.decisionId, input.decisionId); assert.equal(late.reason, 'deadline');
  assert.equal(late.answer.model, 'late-model'); assert.equal(late.answer.inputTokens, 80);
  assert.equal(late.sensorTimes.odometry.acquiredSimMs, 90);
  assert.deepEqual(f.commands.map(command => command.action), ['hold']);
});

test('request errors are classified without recording credentials or arbitrary exception text', async () => {
  const secret = 'credential-never-logged';
  const judge = createJevJudge({ apiKey: secret, model: 'specific-model', fetch: async () => new Response('provider body ' + secret, { status: 429 }) });
  const { events } = await runOnce(judge);
  const failure = events.find(event => event.kind === 'jev.request-error')!.data;
  assert.deepEqual(failure.error, { code: 'http-error', status: 429 });
  assert.ok(!JSON.stringify(events).includes(secret));
  const thrown = await runOnce(async () => { throw new Error('Authorization: Bearer ' + secret); });
  assert.ok(!JSON.stringify(thrown.events).includes(secret));
  assert.deepEqual(thrown.events.find(event => event.kind === 'jev.request-error')!.data.error, { code: 'request-error' });
});

test('large input snapshots are bounded trace parts that reassemble without losing sensor times', async () => {
  const f = fixture(); const payload = 'héllo \\"🌍'.repeat(1300);
  f.observation.sensors.extra = { sequence: 3, acquiredSimMs: 71, receivedSimMs: 86, valid: true, value: { payload } };
  const { events } = await runOnce(async () => answer, f);
  const parts = events.filter(event => event.kind === 'jev.input.part').sort((a, b) => a.data.partIndex - b.data.partIndex);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(event => Buffer.byteLength(JSON.stringify(event.data)) <= 8000));
  assert.equal(parts.length, parts[0]!.data.partCount);
  const encoded = parts.map(event => event.data.json).join('');
  assert.equal(createHash('sha256').update(encoded).digest('hex'), parts[0]!.data.sha256);
  const input = JSON.parse(encoded);
  assert.equal(input.snapshot.sensors.extra.value.payload, payload);
  assert.equal(input.snapshot.sensors.extra.acquiredSimMs, 71);
  assert.equal(input.snapshot.sensors.extra.receivedSimMs, 86);
});

test('trace output redacts credential fields and ignores extra model reasoning fields', async () => {
  const f = fixture(); f.observation.sensors.extra = { sequence: 1, acquiredSimMs: 90, receivedSimMs: 90, valid: true, value: { apiKey: 'never-print-this', message: 'Bearer secret-token' } };
  const { events } = await runOnce(async () => Object.assign({}, answer, { reasoning: 'private-thoughts', authorization: 'another-secret' }), f);
  const encoded = JSON.stringify(events);
  for (const forbidden of ['never-print-this', 'secret-token', 'private-thoughts', 'another-secret']) assert.ok(!encoded.includes(forbidden));
  assert.ok(encoded.includes('[redacted]'));
});

test('execution events continue draining while an expired judge ignores cancellation', async () => {
  const f = fixture(); const abort = new AbortController(); const records: { kind: string; data: any }[] = [];
  const command = f.port.command; let calls = 0;
  f.port.command = async next => {
    const receipt = await command(next);
    f.observation.events.push({ id: 1, kind: 'job.completed', data: { commandId: next.id } });
    return receipt;
  };
  f.port.acknowledge = async (throughEvent, packets) => { assert.deepEqual(packets, []); f.observation.events = f.observation.events.filter(event => event.id > throughEvent); };
  const controller = createChoiceController({ judge: async () => { calls++; return new Promise(() => {}); }, candidates: () => choices, deadlineMs: 5, intervalMs: 1, maxCalls: 3, maxDurationMs: 1000,
    record: (kind, data) => { records.push({ kind, data }); if (kind === 'jev.events-acknowledged') abort.abort(); } });
  await controller.run([f.port], abort.signal);
  assert.equal(calls, 1); assert.equal(f.observation.events.length, 0);
  assert.ok(records.some(event => event.kind === 'jev.execution-event' && event.data.phase === 'waiting-for-discarded-request' && event.data.correlated));
});

test('over-limit diagnostic snapshots explicitly report truncation without emitting oversized records', async () => {
  const f = fixture(); f.observation.sensors.extra = { sequence: 1, acquiredSimMs: 90, receivedSimMs: 90, valid: true, value: 'x'.repeat(70000) };
  const { events } = await runOnce(async () => answer, f);
  const input = events.find(event => event.kind === 'jev.input')!.data;
  assert.equal(input.truncated, true); assert.ok(input.originalBytes > 65536); assert.equal(input.sha256.length, 64);
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event.data)) <= 8000));
});
