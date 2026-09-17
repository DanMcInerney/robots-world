import test from 'node:test';
import assert from 'node:assert/strict';
import type { RobotPort, Observation } from '../src/contracts.ts';
import { createRobotTools } from '../controllers/tools.ts';
import { runCodex, codexPreset, verifyCodexModel } from '../controllers/codex.ts';
import type { NativeClient, NativeEvent } from '../controllers/app-server.ts';
import { runClaude } from '../controllers/claude.ts';
import { createNerveletBridge, createNerveletEnvironment } from '../integrations/nervelet.ts';

function portFixture(id = 'drone-1') {
  const calls: string[] = [];
  let resolveObservation: ((value: Observation) => void) | undefined;
  const observation: Observation = { epoch: 'run-1', robotId: id, sequence: 1, simMs: 100, wallMs: 200, goal: 'Test',
    sensors: { odometry: { value: { x: 1, y: 2, z: 3 }, sequence: 1, acquiredSimMs: 90, receivedSimMs: 100, valid: true } }, jobs: [], inbox: [], events: [] };
  const port: RobotPort = { robotId: id,
    async describe() { return { id, model: 'drone', commands: { goto: { description: 'Move', schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } } }, sensors: [], radio: { channel: 'radio', rangeM: 10, bitrateBps: 1000, latencyMs: 0, jitterMs: 0, loss: 0, maxQueueBytes: 1024, maxPacketBytes: 256 }, units: 'ENU SI' }; },
    async observe() { calls.push('observe'); return observation; },
    async command(command) { calls.push('command'); return { id: command.id, status: 'accepted', jobId: 'job-1' }; },
    async acknowledge() { calls.push('ack'); }, async send() { calls.push('send'); return { accepted: true }; },
    async stop() { calls.push('stop'); }, async close() { calls.push('close'); },
  };
  return { port, calls, observation, blockObservation() { port.observe = () => new Promise(resolve => { resolveObservation = resolve; }); }, releaseObservation() { resolveObservation?.(observation); } };
}

test('tools expose only authorized robot IDs and reject foreign actuation', async () => {
  const fixture = portFixture(); const tools = createRobotTools([fixture.port]);
  assert.equal(JSON.stringify(tools.list()).includes('drone-2'), false);
  await assert.rejects(tools.call('robot_command', { robotId: 'drone-2', command: { id: 'one', action: 'goto', args: {} } }), /scope/);
  assert.deepEqual(fixture.calls, []);
  await tools.call('robot_command', { robotId: 'drone-1', command: { id: 'one', action: 'goto', args: { x: 1, y: 2, z: 3 } } });
  assert.deepEqual(fixture.calls, ['command']); await tools.stopAll();
});

test('controller stop revokes pending results and later commands', async () => {
  const fixture = portFixture(); fixture.blockObservation(); const tools = createRobotTools([fixture.port]);
  const pending = tools.call('robot_observe', { robotId: 'drone-1' });
  const rejected = assert.rejects(pending, /authority ended/);
  await tools.stopAll(); fixture.releaseObservation(); await rejected;
  await assert.rejects(tools.call('robot_command', { robotId: 'drone-1', command: { id: 'late', action: 'goto', args: {} } }), /authority ended/);
  assert.deepEqual(fixture.calls, ['stop']);
});

test('tool budgets stop all scoped robots and remain stopped', async () => {
  const first = portFixture(), second = portFixture('drone-2'); const tools = createRobotTools([first.port, second.port], { maxCalls: 1 });
  await tools.call('robot_describe', { robotId: 'drone-1' });
  await assert.rejects(tools.call('robot_observe', { robotId: 'drone-1' }), /budget/);
  assert.deepEqual(first.calls, ['stop']); assert.deepEqual(second.calls, ['stop']);
});

function nativeFixture(options: { onStart?: (emit: (event: NativeEvent) => void) => void; onInterrupt?: () => void; wrongModel?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [], listeners = new Set<(event: NativeEvent) => void>();
  const emit = (event: NativeEvent) => { for (const listener of listeners) listener(event); };
  const client: NativeClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'model/list') return { data: [{ model: options.wrongModel ? 'another-model' : codexPreset.model, supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }] };
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: codexPreset.model };
      if (method === 'turn/start') { options.onStart?.(emit); return { turn: { id: 'turn-1' } }; }
      if (method === 'turn/interrupt') {
        options.onInterrupt?.();
        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'unrelated', status: 'completed' } } });
        setTimeout(() => emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }), 15);
        return {};
      }
      return {};
    }, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, async close() { calls.push({ method: 'close', params: {} }); },
  };
  return { client, calls, emit };
}

test('Codex requires exact Luna xhigh and preserves early terminal identity', async () => {
  const native = nativeFixture({ onStart(emit) {
    emit({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'turn-1', status: 'failed' } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  } });
  const fixture = portFixture();
  await runCodex([fixture.port], { goal: 'fixture', cwd: process.cwd(), client: native.client, maxWallMs: 3000 });
  const start = native.calls.find(call => call.method === 'turn/start')!;
  assert.equal(start.params.model, 'gpt-5.6-luna'); assert.equal(start.params.effort, 'xhigh');
  assert.deepEqual(fixture.calls, ['stop']); assert.equal(native.calls.some(call => call.method === 'close'), false, 'borrowed client remains owned by caller');
  await assert.rejects(verifyCodexModel(nativeFixture({ wrongModel: true }).client, codexPreset.model, codexPreset.effort), /no fallback/);
});

test('Codex stops robot authority before interrupt and joins matching terminal event', async () => {
  const fixture = portFixture(); const abort = new AbortController(); let interruptedAt = 0;
  const native = nativeFixture({ onStart() { setTimeout(() => abort.abort(new Error('fixture stop')), 10); }, onInterrupt() { assert.equal(fixture.calls.at(-1), 'stop'); interruptedAt = performance.now(); } });
  await assert.rejects(runCodex([fixture.port], { goal: 'fixture', cwd: process.cwd(), client: native.client, maxWallMs: 3000 }, abort.signal), /fixture stop/);
  assert.ok(performance.now() - interruptedAt >= 10, 'unrelated terminal event did not settle interruption');
  assert.equal(native.calls.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('Claude SDK is optional, scopes tools, preserves model and joins matching cancellation', async () => {
  const fixture = portFixture(); const abort = new AbortController(); let inputId = '', release!: () => void, interrupted = false;
  let captured: Record<string, unknown> | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const query = ((args: { prompt: AsyncIterable<{ uuid: string }>; options: Record<string, unknown> }) => {
    captured = args.options;
    const stream = (async function* () {
      for await (const input of args.prompt) { inputId = input.uuid; break; }
      setTimeout(() => abort.abort(new Error('fixture Claude stop')), 10);
      await wait;
      yield { type: 'result', subtype: 'success', session_id: 'session-1', user_message_uuid: inputId, is_error: false, permission_denials: [], terminal_reason: 'aborted_tools' };
    })();
    return Object.assign(stream, { async interrupt() { assert.equal(fixture.calls.at(-1), 'stop'); interrupted = true; release(); }, close() { release(); } });
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk')['query'];
  await assert.rejects(runClaude([fixture.port], { goal: 'fixture', cwd: process.cwd(), model: 'fixture-exact-model', query, maxWallMs: 3000 }, abort.signal), /fixture Claude stop/);
  assert.equal(captured?.model, 'fixture-exact-model'); assert.deepEqual(captured?.tools, []);
  assert.ok((captured?.allowedTools as string[]).every(name => name.startsWith('mcp__robots__robot_'))); assert.equal(interrupted, true);
});

test('Nervelet environment preserves sensor acquisition and receipt, maps commands without world access', async () => {
  const fixture = portFixture(); const environment = await createNerveletEnvironment(fixture.port); const signal = new AbortController().signal;
  const first = await environment.snapshot(0, signal), second = await environment.snapshot(0, signal);
  assert.equal(first.samples.odometry.acquired.ms, 90);
  assert.equal(first.samples.odometry.receivedMs, second.samples.odometry.receivedMs, 'repeated snapshots cannot invent a new receipt time');
  await environment.execute({ id: 'c1', kind: 'goto', args: { x: 1, y: 2, z: 3 } }, { signal, assertCurrent() {} });
  assert.equal(fixture.calls.at(-1), 'command');
  let goal: unknown, bound: unknown;
  class FakeBridge { constructor(environment: unknown, receivedGoal: unknown) { bound = environment; goal = receivedGoal; } async start() {} }
  await createNerveletBridge(fixture.port, { Bridge: FakeBridge }, 'exact goal');
  assert.equal(goal, 'exact goal'); assert.ok(bound && typeof bound === 'object');
});

test('Nervelet hold preserves a reusable port and does not turn admission into confirmed completion', async () => {
  const fixture = portFixture(); const describe = fixture.port.describe;
  fixture.port.describe = async () => { const description = await describe(); description.commands.hold = { description: 'Hold', schema: { type: 'object' } }; return description; };
  const environment = await createNerveletEnvironment(fixture.port); const signal = new AbortController().signal;
  assert.equal((await environment.stop(signal)).status, 'stopping');
  assert.deepEqual(fixture.calls, ['command']);
  await environment.execute({ id: 'after-goal-change', kind: 'goto', args: { x: 0, y: 0, z: 2 } }, { signal });
  assert.deepEqual(fixture.calls, ['command', 'command']);
  fixture.port.command = async () => { throw new Error('Port revoked externally'); };
  assert.equal((await environment.stop(signal)).status, 'confirmed');
  assert.equal(fixture.calls.at(-1), 'stop', 'fallback confirms through actual port stop');
});
