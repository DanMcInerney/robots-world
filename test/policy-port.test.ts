import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Command, Job, Observation, RobotPort } from '../src/contracts.ts';
import { createPolicyPort } from '../integrations/policy-port.ts';
import { createNerveletEnvironment } from '../integrations/nervelet.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => boolean) { for (let n = 0; n < 100; n++) { if (condition()) return; await sleep(2); } throw new Error('Fixture did not settle.'); }
function physicalFixture() {
  const effects: string[] = [], calls: Command[] = [], jobs: Job[] = [];
  let closed = false, simMs = 0, sequence = 0, sample = 0, wait: Promise<void> | undefined;
  const events: Observation['events'] = []; const acknowledged: number[] = [];
  const check = () => { if (closed) throw new Error('Physical lease revoked.'); };
  const port: RobotPort = {
    robotId: 'robot-1',
    async describe() { check(); return { id: 'robot-1', model: 'fixture', commands: {
      goto: { description: 'Move', schema: { type: 'object' } }, hold: { description: 'Hold', schema: { type: 'object' } },
    }, sensors: [{ id: 'odom', type: 'odometry', hz: 20 }], radio: { channel: 'test', rangeM: 10, bitrateBps: 10000, latencyMs: 0, jitterMs: 0, loss: 0, maxQueueBytes: 1000, maxPacketBytes: 100 }, units: 'SI ENU' }; },
    async observe() { check(); return { robotId: 'robot-1', epoch: 'fixture', goal: 'test', simMs, wallMs: Date.now(), sequence: ++sequence, sensors: { odom: { value: { position: { x: sample, y: 0, z: 1 } }, sequence: sample, valid: true, acquiredSimMs: simMs, receivedSimMs: simMs } }, jobs: structuredClone(jobs), events: structuredClone(events), inbox: [] }; },
    async command(command) {
      check(); calls.push(structuredClone(command));
      if (command.action === 'goto' && wait) await wait;
      check(); effects.push(command.action);
      const job: Job = { id: `physical-${calls.length}`, commandId: command.id, action: command.action, args: command.args, status: command.action === 'hold' ? 'completed' : 'running', startedSimMs: simMs, updatedSimMs: simMs };
      jobs.push(job); return { id: command.id, status: command.action === 'hold' ? 'completed' : 'accepted', jobId: job.id };
    },
    async acknowledge(through) { check(); acknowledged.push(through); while (events[0] && events[0].id <= through) events.shift(); },
    async send() { check(); effects.push('send'); return { accepted: true }; },
    async stop() { closed = true; effects.push('stop'); }, async close() { closed = true; effects.push('close'); },
  };
  return { port, effects, calls, events, acknowledged, tick() { simMs += 20; sample++; }, block(promise: Promise<void>) { wait = promise; } };
}

test('policy admission returns promptly, acquisition and local control continue across a blocked judgment', async t => {
  const physical = physicalFixture(), judgment = gate(), started = gate(); let child!: RobotPort;
  const port = createPolicyPort(physical.port, { local: async (robot, signal) => {
    child = robot; await robot.command({ id: 'move', action: 'goto', args: { x: 2, y: 0, z: 1 } }); started.resolve(); await judgment.promise;
    signal.throwIfAborted();
  } });
  t.after(async () => { judgment.resolve(); await port.close(); });
  const admitted = await port.command({ id: 'p1', action: 'run_policy', args: { name: 'local' } });
  assert.equal(admitted.status, 'accepted'); await started.promise;
  physical.tick(); physical.tick(); const observed = await port.observe();
  assert.equal(observed.sensors.odom.sequence, 2); assert.equal(observed.jobs.find(job => job.id === admitted.jobId)?.status, 'running');
  assert.deepEqual(physical.effects, ['hold', 'goto']); assert.equal((await child.describe()).commands.run_policy, undefined);
});

test('hold cancels the policy, rejects late child commands and retains outer physical ownership', async t => {
  const physical = physicalFixture(), judgment = gate(), started = gate(); let child!: RobotPort;
  const port = createPolicyPort(physical.port, { local: async robot => { child = robot; started.resolve(); await judgment.promise; } });
  t.after(async () => { judgment.resolve(); await port.close(); });
  const receipt = await port.command({ id: 'p1', action: 'run_policy', args: { name: 'local' } }); await started.promise;
  assert.equal((await port.command({ id: 'hold', action: 'hold', args: {} })).status, 'completed');
  await assert.rejects(child.command({ id: 'late', action: 'goto', args: {} }), /generation revoked/);
  assert.equal((await port.observe()).jobs.find(job => job.id === receipt.jobId)?.status, 'cancelled');
  assert.equal((await port.command({ id: 'outer-move', action: 'goto', args: {} })).status, 'accepted');
  assert.deepEqual(physical.effects, ['hold', 'hold', 'goto']);
});

test('replacement is explicit and an old child close cannot cancel a new policy', async t => {
  const physical = physicalFixture(), first = gate(), second = gate(); const children: RobotPort[] = [];
  const port = createPolicyPort(physical.port, { local: async robot => { children.push(robot); await (children.length === 1 ? first.promise : second.promise); } });
  t.after(async () => { first.resolve(); second.resolve(); await port.close(); });
  await port.command({ id: 'one', action: 'run_policy', args: { name: 'local' } }); await until(() => children.length === 1);
  assert.equal((await port.command({ id: 'no-replace', action: 'run_policy', args: { name: 'local' } })).status, 'rejected');
  const replacement = await port.command({ id: 'two', action: 'run_policy', args: { name: 'local', replace: true } }); await until(() => children.length === 2);
  const effects = physical.effects.length; await children[0]!.close(); first.resolve(); await sleep(5);
  assert.equal(physical.effects.length, effects); assert.equal((await port.observe()).jobs.find(job => job.id === replacement.jobId)?.status, 'running');
  await children[1]!.command({ id: 'move', action: 'goto', args: {} }); assert.equal(physical.effects.at(-1), 'goto');
});

test('stale replacement evidence is rejected before cancelling the valid running policy', async t => {
  const physical = physicalFixture(), blocked = gate();
  const port = createPolicyPort(physical.port, { local: async () => blocked.promise });
  t.after(async () => { blocked.resolve(); await port.close(); });
  const active = await port.command({ id: 'one', action: 'run_policy', args: { name: 'local' } });
  const old = await port.observe(); physical.tick();
  const rejected = await port.command({ id: 'stale', action: 'run_policy', args: { name: 'local', replace: true }, basedOn: { observation: old.sequence, maxAgeMs: 0 } });
  assert.equal(rejected.status, 'rejected'); assert.match(rejected.reason!, /stale/);
  assert.equal((await port.observe()).jobs.find(job => job.id === active.jobId)?.status, 'running'); assert.deepEqual(physical.effects, ['hold']);
});

test('in-flight mutation settles before a nonterminal hold is confirmed; stale result is rejected', async t => {
  const physical = physicalFixture(), effect = gate(), issued = gate(); physical.block(effect.promise);
  let rejected: unknown;
  const port = createPolicyPort(physical.port, { local: async robot => {
    const result = robot.command({ id: 'slow', action: 'goto', args: {} }); issued.resolve();
    try { await result; } catch (error) { rejected = error; }
  } });
  t.after(async () => { effect.resolve(); await port.close(); });
  await port.command({ id: 'p', action: 'run_policy', args: { name: 'local' } }); await issued.promise; await until(() => physical.calls.some(call => call.action === 'goto'));
  const holding = port.command({ id: 'hold', action: 'hold', args: {} }); await sleep(5);
  assert.deepEqual(physical.effects, ['hold']); effect.resolve(); assert.equal((await holding).status, 'completed');
  assert.deepEqual(physical.effects, ['hold', 'goto', 'hold']); assert.match(String(rejected), /generation revoked/);
});

test('outer Stop revokes a pending physical mutation without waiting for its reply', async () => {
  const physical = physicalFixture(), effect = gate(), issued = gate(); physical.block(effect.promise);
  const port = createPolicyPort(physical.port, { local: async robot => { issued.resolve(); await robot.command({ id: 'late', action: 'goto', args: {} }).catch(() => {}); } });
  await port.command({ id: 'p', action: 'run_policy', args: { name: 'local' } }); await issued.promise; await until(() => physical.calls.some(call => call.action === 'goto'));
  await port.stop(); effect.resolve(); await sleep(5);
  assert.equal(physical.effects.includes('goto'), false); await assert.rejects(port.observe(), /closed/); await port.close();
});

test('first policy admission settles prior outer mutation and confirms hold before granting a child', async t => {
  const physical = physicalFixture(), effect = gate(), finish = gate(); physical.block(effect.promise);
  let entered = false;
  const port = createPolicyPort(physical.port, { local: async () => { entered = true; await finish.promise; } });
  t.after(async () => { effect.resolve(); finish.resolve(); await port.close(); });
  const previous = port.command({ id: 'outer-move', action: 'goto', args: {} });
  const superseded = assert.rejects(previous, /boundary changed/);
  await until(() => physical.calls.some(call => call.action === 'goto'));
  let admitted = false;
  const pending = port.command({ id: 'policy', action: 'run_policy', args: { name: 'local' } }).then(receipt => { admitted = true; return receipt; });
  await sleep(5);
  assert.equal(admitted, false); assert.equal(entered, false); assert.deepEqual(physical.effects, []);
  effect.resolve(); await superseded;
  assert.equal((await pending).status, 'accepted'); await until(() => entered);
  assert.deepEqual(physical.effects, ['goto', 'hold']);
});

test('child event acknowledgement cannot consume supervisor lifecycle or forwarded physical events', async t => {
  const physical = physicalFixture(), finish = gate(), consumed = gate(); let child!: RobotPort;
  physical.events.push({ id: 1, kind: 'physical-arrival', data: {} });
  const port = createPolicyPort(physical.port, { local: async robot => {
    child = robot;
    const observed = await robot.observe();
    assert.deepEqual(observed.events.map(event => event.kind), ['physical-arrival']);
    assert.equal(observed.jobs.some(job => job.action === 'run_policy'), false);
    await robot.acknowledge(observed.events.at(-1)!.id); consumed.resolve(); await finish.promise;
  } });
  t.after(async () => { finish.resolve(); await port.close(); });
  await port.command({ id: 'p', action: 'run_policy', args: { name: 'local' } }); await consumed.promise;
  assert.deepEqual(physical.events, []);
  const started = await port.observe();
  assert.deepEqual(started.events.map(event => event.kind), ['physical-arrival', 'policy.started']);
  finish.resolve(); await until(() => physical.effects.filter(effect => effect === 'hold').length === 2);
  await assert.rejects(child.acknowledge(1), /generation revoked/);
  const completed = await port.observe();
  assert.deepEqual(completed.events.map(event => event.kind), ['physical-arrival', 'policy.started', 'policy.completed']);
  await port.acknowledge(completed.events.at(-1)!.id);
  assert.deepEqual((await port.observe()).events, []);
});

test('unconfirmed physical mutation faults and revokes rather than admitting a replacement writer', async () => {
  const physical = physicalFixture(), never = gate(); physical.block(never.promise);
  const records: string[] = [];
  const port = createPolicyPort(physical.port, { local: async robot => { await robot.command({ id: 'hang', action: 'goto', args: {} }); } }, { operationMs: 15, record: kind => records.push(kind) });
  await port.command({ id: 'p', action: 'run_policy', args: { name: 'local' } }); await until(() => records.includes('policy.port_fault'));
  assert.equal(physical.effects.includes('stop'), true); await assert.rejects(port.command({ id: 'next', action: 'run_policy', args: { name: 'local', replace: true } }), /closed/);
  never.resolve(); await sleep(5); assert.equal(physical.effects.includes('goto'), false); await port.close();
});

test('command deduplication, bounded job/receipt history and acknowledgement remain explicit', async t => {
  const physical = physicalFixture(); const finished = gate(); let runs = 0;
  const port = createPolicyPort(physical.port, { local: async () => { runs++; await finished.promise; } }, { maxJobs: 1, maxCommands: 4 });
  t.after(async () => { finished.resolve(); await port.close(); });
  const command: Command = { id: 'p', action: 'run_policy', args: { name: 'local' } };
  const one = await port.command(command), duplicate = await port.command(command); await until(() => runs === 1);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.jobId, one.jobId);
  assert.equal((await port.command({ ...command, args: { name: 'local', replace: true } })).status, 'rejected');
  physical.events.push({ id: 1, kind: 'physical-arrival', data: {} });
  const observed = await port.observe(); assert.ok(observed.events.some(event => event.kind === 'policy.started')); assert.ok(observed.events.some(event => event.kind === 'physical-arrival'));
  await port.acknowledge(observed.events.at(-1)!.id); assert.equal(physical.acknowledged.at(-1), 1); assert.deepEqual((await port.observe()).events, []);
  await port.command({ id: 'h', action: 'hold', args: {} });
  assert.match((await port.command({ id: 'full-job', action: 'run_policy', args: { name: 'local' } })).reason!, /history full/);
  await port.command({ id: 'last', action: 'goto', args: {} });
  assert.match((await port.command({ id: 'full-receipts', action: 'goto', args: {} })).reason!, /history full/);
  const emergency = await port.command({ id: 'emergency-hold', action: 'hold', args: {} });
  assert.equal(emergency.status, 'completed'); assert.match(emergency.reason!, /revoked/); assert.equal(physical.effects.at(-1), 'stop');
});

test('unread event pressure revokes control explicitly and policy wall deadline expires independently', async () => {
  const physical = physicalFixture(), gate1 = gate(); const logs: string[] = [];
  const port = createPolicyPort(physical.port, { local: async () => gate1.promise }, { maxEvents: 2, record: kind => logs.push(kind) });
  await port.command({ id: 'p', action: 'run_policy', args: { name: 'local' } });
  physical.events.push({ id: 1, kind: 'one', data: {} }, { id: 2, kind: 'two', data: {} });
  await assert.rejects(port.observe(), /capacity/); assert.ok(logs.includes('policy.port_fault')); gate1.resolve(); await port.close();
  const other = physicalFixture(), gate2 = gate();
  const bounded = createPolicyPort(other.port, { local: async () => gate2.promise }, { maxPolicyMs: 15 });
  const receipt = await bounded.command({ id: 'p', action: 'run_policy', args: { name: 'local' } });
  await until(() => other.effects.filter(effect => effect === 'hold').length === 2);
  assert.equal((await bounded.observe()).jobs.find(job => job.id === receipt.jobId)?.status, 'expired'); gate2.resolve(); await bounded.close();
});

test('actual optional Nervelet Bridge admits a local job, waits, changes goal and gates late effects', { skip: !process.env.ROBOTS_NERVELET_MODULE }, async () => {
  const specifier = process.env.ROBOTS_NERVELET_MODULE!;
  const { Bridge } = await import(specifier.startsWith('file:') ? specifier : pathToFileURL(resolve(specifier)).href);
  const physical = physicalFixture(), judgment = gate(), started = gate(); let lateEffects = 0, cycles = 0;
  const port = createPolicyPort(physical.port, { local: async (child, signal) => {
    await child.command({ id: 'move', action: 'goto', args: { x: 2, y: 0, z: 1 } });
    const observed = await child.observe(); await child.acknowledge(observed.events.at(-1)?.id ?? 0); started.resolve();
    await judgment.promise;
    try { await child.command({ id: 'late', action: 'goto', args: { x: 99, y: 0, z: 1 } }); lateEffects++; } catch { /* Revocation is the expected effect boundary. */ }
    signal.throwIfAborted();
  } });
  const bridge = new Bridge(await createNerveletEnvironment(port), 'Run the local policy');
  const acquisition = setInterval(() => { physical.tick(); cycles++; }, 5);
  try {
    await bridge.start();
    const first = await bridge.step({});
    const admitted = await bridge.step({ seen: first.id, goalVersion: first.goal.version, commands: [{ id: first.nextCommandId, kind: 'run_policy', args: { name: 'local' } }] });
    assert.equal(admitted.results[0].status, 'accepted'); await started.promise;
    assert.ok(admitted.events.some((event: { kind: string }) => event.kind === 'policy.started'));
    const before = cycles;
    const waited = await bridge.step({ seen: admitted.id, goalVersion: admitted.goal.version, waitMs: 60 });
    assert.ok(cycles > before, 'independent acquisition continued while the real Bridge waited');
    assert.ok(waited.samples.odom.value.position.x > 0); assert.ok(waited.jobs.some((job: { kind: string; status: string }) => job.kind === 'run_policy' && job.status === 'running'));
    await bridge.updateGoal('Hold and consider another policy');
    judgment.resolve(); await sleep(10); assert.equal(lateEffects, 0); assert.equal(physical.effects.at(-1), 'hold');
    await bridge.stop(); assert.equal(physical.effects.at(-1), 'hold');
  } finally { clearInterval(acquisition); judgment.resolve(); await bridge.close(); }
});

test('actual optional Nervelet Bridge wakes on completion after child has acknowledged physical events', { skip: !process.env.ROBOTS_NERVELET_MODULE }, async () => {
  const specifier = process.env.ROBOTS_NERVELET_MODULE!;
  const { Bridge } = await import(specifier.startsWith('file:') ? specifier : pathToFileURL(resolve(specifier)).href);
  const physical = physicalFixture(), finish = gate(), consumed = gate();
  const port = createPolicyPort(physical.port, { local: async child => {
    physical.events.push({ id: 1, kind: 'physical-arrival', data: {} });
    const observed = await child.observe(); await child.acknowledge(observed.events.at(-1)!.id);
    consumed.resolve(); await finish.promise;
  } });
  const bridge = new Bridge(await createNerveletEnvironment(port), 'Monitor local completion');
  try {
    await bridge.start(); const first = await bridge.step({});
    const admitted = await bridge.step({ seen: first.id, goalVersion: first.goal.version, commands: [{ id: first.nextCommandId, kind: 'run_policy', args: { name: 'local' } }] });
    await consumed.promise;
    const delivered = await bridge.step({ seen: admitted.id, goalVersion: admitted.goal.version });
    const waiting = bridge.step({ seen: delivered.id, goalVersion: delivered.goal.version, waitMs: 1000 });
    await sleep(10); finish.resolve();
    const woke = await waiting;
    assert.equal(woke.wait?.reason, 'event');
    assert.ok(woke.events.some((event: { kind: string }) => event.kind === 'policy.completed'));
    assert.ok(woke.jobs.some((job: { kind: string; status: string }) => job.kind === 'run_policy' && job.status === 'completed'));
  } finally { finish.resolve(); await bridge.close(); }
});
