import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast, goalFor, makeMenu, predict, selected } from '../experiments/reactive/contract.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../experiments/reactive/config.ts';
import { trial } from '../experiments/reactive/run.ts';
import { createNerveletEnvironment } from '../integrations/nervelet.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReactiveWorld } from '../experiments/reactive/world.ts';
import { add, distance, vec } from '../src/math.ts';

test('candidate generation cannot see hidden fields, read a goal, rank or choose a mission action', async () => {
  const world = await ReactiveWorld.create(11);
  try {
    const state = world.state(), left = makeMenu({ ...state, goal: goalFor('left') }), right = makeMenu({ ...state, goal: goalFor('right') });
    assert.equal(left.hash, right.hash); assert.deepEqual(left.candidates, right.candidates); assert.notEqual(left.state.goal, right.state.goal);
    assert.ok(left.candidates.length > 100 && left.candidates.length <= 255);
    const extras = Object.assign({}, state); Object.defineProperty(extras, 'evaluator', { get() { throw new Error('privileged access'); } });
    Object.defineProperty(extras, 'futureRoute', { get() { throw new Error('future access'); } });
    assert.deepEqual(makeMenu(extras), makeMenu(state));
    const bare = makeMenu(state, false); assert.deepEqual(bare.candidates, left.candidates); assert.ok(Object.values(bare.criteria).every(c => !('estimate' in (c as object))));
    assert.equal(JSON.stringify(left.state).includes('unseen-target-motion'), false); assert.throws(() => selected({ choice: 'invented' }, left));
  } finally { await world.close(); }
});

test('full-lifetime forecast rejects a descent the old 1.5-second preview would admit', async () => {
  const world = await ReactiveWorld.create(20);
  try {
    const state = world.state(), action = { mode: 'velocity' as const, x: 0, y: 0, z: -1.2, heading: 0, pitch: -30, hfov: 70, duration: 3 };
    assert.ok(predict(state.odometry.value.position, state.odometry.value.velocity, action, 1.5).every(p => p.z >= .7));
    assert.equal(forecast(state, action).safe, false);
    assert.equal((await world.apply(action, makeMenu(state).source)).accepted, false);
    assert.ok(makeMenu(state).candidates.every(c => c.facts.horizonS === c.action.duration));
    const measured = structuredClone(state); measured.odometry.acquiredMs -= 80;
    assert.ok(forecast(measured, action).marginM > forecast(state, action).marginM);
    for (const invalid of [NaN, Infinity, state.simMs + 1]) assert.equal((await world.apply(action, { simMs: state.simMs, odometryMs: invalid, goalVersion: 1 })).accepted, false);
    measured.odometry.value.position.z = .6;
    assert.equal(makeMenu(measured).candidates.length, 0, 'No legal maneuver is an explicit empty result, not an exception');
  } finally { await world.close(); }
});

test('queued replacement and expiry cannot extend old actuator authority', async () => {
  const events: { kind: string; data: any }[] = [], config = structuredClone(DEFAULT_CONFIG); config.link.loss = 0;
  const world = await ReactiveWorld.create(20, (kind, data) => events.push({ kind, data }), 30000, config);
  try {
    const a = { mode: 'velocity' as const, x: .4, y: 0, z: 0, heading: 0, pitch: -30, hfov: 70, duration: .5 };
    await world.apply(a, makeMenu(world.state()).source); await world.tick();
    await world.apply({ ...a, x: -.4 }, makeMenu(world.state()).source);
    for (let i = 0; i < 50; i++) await world.tick();
    const applications = events.filter(e => e.kind === 'reactive.camera.command');
    assert.ok(applications.length > 0); assert.ok(applications.every(e => e.data.x === -.4));
    assert.ok(applications.every(e => e.data.simMs < e.data.expiresMs && e.data.remainingMs <= 500));
    const held = world.state().odometry.value.position;
    for (let i = 0; i < 50; i++) await world.tick();
    assert.ok(distance(held, world.state().odometry.value.position) < .08);
    assert.equal(world.evaluate().fallbackAtEnd, 'command-expired');
  } finally { await world.close(); }
});

test('delivery rechecks fresh measurements; sensor data never substitutes for decision provenance', async () => {
  const config = structuredClone(DEFAULT_CONFIG); config.link.loss = 0;
  const world = await ReactiveWorld.create(20, () => {}, 30000, config);
  try {
    const state = world.state(); await world.apply(makeMenu(state).candidates[0]!.action, makeMenu(state).source);
    // Privileged fault injection, exclusively to test the transport guard.
    const body = world.world.physics.body('drone/base');
    world.world.physics.move('drone/base', { ...body.pose, position: { ...body.pose.position, z: .72 } });
    for (let i = 0; i < 10; i++) await world.tick();
    assert.equal(world.evaluate().guardInterventions, 1);
    assert.equal(world.evaluate().fallbackAtEnd, 'delivery-envelope-or-odometry');
  } finally { await world.close(); }
});

test('continuous controller port supports unquantized position commands, explicit provenance, duplicates and terminal Stop', async () => {
  const world = await ReactiveWorld.create(21);
  try {
    const port = world.controllerPort(), observation = await port.observe();
    const position = (observation.sensors.odometry!.value as any).position;
    const command = { id: 'continuous', action: 'control', args: { mode: 'position', x: position.x + .137, y: position.y + .231, z: 2.63, heading: 12.345, pitch: -26.789, hfov: 70 }, validForMs: 800 };
    assert.equal((await port.command(command)).reason, 'observation-required');
    const sourced = { ...command, id: 'sourced', basedOn: { observation: observation.sequence, maxAgeMs: 500 } };
    const concurrent = await Promise.all([port.command(sourced), port.command(sourced)]);
    assert.deepEqual(concurrent.map(r => r.status), ['accepted', 'duplicate']);
    assert.equal(world.evaluate().controlAdmissions, 1);
    assert.equal((await port.command({ ...sourced, args: { ...sourced.args, z: 3 } })).reason, 'id-conflict');
    for (let i = 0; i < 35; i++) await world.tick();
    assert.ok(world.evaluate().appliedSetpoints > 0);
    assert.ok(distance(world.state().odometry.value.position, command.args) < distance(position, command.args));
    assert.equal((await port.command({ ...sourced, id: 'stale' })).reason, 'stale-observation');
    await port.stop(); const t = world.world.simMs; await world.tick(); assert.ok(world.world.simMs > t);
    assert.equal((await port.command({ ...sourced, id: 'late' })).reason, 'stopped');
    await assert.rejects(port.observe(), /stopped/);
    await assert.rejects(port.acknowledge(0), /stopped/);
    await world.failController('failure reported after cleanup stopped the port');
    for (let i = 0; i < 3000; i++) await world.tick();
    assert.equal(world.evaluate().controllerFailures, 1, 'An error after controller cleanup still counts');
    assert.equal(world.world.simMs, 61020, 'Unattended sensing and radio do not overflow after controller Stop');
  } finally { await world.close(); }
});

test('Nervelet adapter preserves explicit source observation and declared command lifetime', async () => {
  const world = await ReactiveWorld.create(22);
  try {
    const environment = await createNerveletEnvironment(world.controllerPort(), { commandValidForMs: 700 }), signal = new AbortController().signal;
    const snapshot = await environment.snapshot(0, signal);
    assert.equal(snapshot.state.value.goal, world.state().goal);
    const receipt = await environment.execute({ id: 'nervelet', kind: 'control', args: { mode: 'velocity', x: .137, y: .231, z: 0, heading: 0, pitch: -30, hfov: 70, observation: snapshot.state.value.observation } }, { signal });
    assert.equal(receipt.status, 'accepted');
    assert.equal(world.state().lastActions.at(-1)!.action.duration, .7);
    await environment.stop(signal); assert.equal(world.evaluate().fallbackAtEnd, 'controller-hold');
  } finally { await world.close(); }
});

test('sensor impairment settings are reproducible and beacon absence stays unknown', async () => {
  const config = structuredClone(DEFAULT_CONFIG); config.sensors.cooperativeBeacon = false; config.sensors.cameraNoiseUv = .1; config.sensors.rangeRegistrationNoiseM = .2;
  const a = await ReactiveWorld.create(23, () => {}, 30000, config), b = await ReactiveWorld.create(23, () => {}, 30000, config);
  try {
    config.sensors.cooperativeBeacon = true;
    for (let i = 0; i < 40; i++) { await a.tick(); await b.tick(); }
    assert.deepEqual(a.state(), b.state()); assert.equal(a.state().target, null);
    assert.equal(makeMenu(a.state(), true, a.config).state.target, null);
    assert.equal((a.state().camera.value as any).kind, 'noisy-geometric-detections');
    assert.equal((a.state().ranges.value as any).registration, 'noisy-position-ideal-orientation');
    assert.throws(() => { a.config.sensors.cooperativeBeacon = true; }, TypeError);
    assert.throws(() => experimentConfig({ ...DEFAULT_CONFIG, commandSeconds: Infinity }));
  } finally { await a.close(); await b.close(); }
});

test('controller errors do not truncate a flight, retry inference or leak authority into the next trial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'robots-reactive-'));
  try {
    let calls = 0;
    const failed = await trial({ arm: 'fixture-failure', seed: 24, seconds: 2, directory, phase: 'fixture', realtime: false, fixtureDecision: async () => { calls++; throw new Error('Injected provider failure'); } });
    assert.equal(calls, 1); assert.equal(failed.evaluation.controllerFailures, 1);
    assert.equal(failed.evaluation.trajectory.length, 20); assert.equal(failed.evaluation.phases.length, 2); assert.equal(failed.evaluation.success, false);
    const rows = (await readFile(join(directory, 'fixture-failure-24.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse as any);
    assert.equal((rows.at(-1) as any).kind, 'trace.complete');
    let revokedPort: import('../src/contracts.ts').RobotPort | undefined;
    const next = await trial({ arm: 'fixture-custom', seed: 24, seconds: 2, directory, phase: 'fixture', realtime: false, controller: { id: 'custom', async run([port], signal) {
      revokedPort = port!; const observation = await port!.observe();
      await port!.command({ id: 'free', action: 'control', args: { mode: 'velocity', x: .123, y: .234, z: 0, heading: 17.19, pitch: -30.27, hfov: 70 }, validForMs: 600, basedOn: { observation: observation.sequence, maxAgeMs: 500 } });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    } } });
    assert.equal(next.evaluation.trajectory.length, 20); assert.equal(next.evaluation.controllerFailures, 0);
    assert.equal((await revokedPort!.command({ id: 'late', action: 'hold', args: {} })).reason, 'stopped');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('prediction and range consequences change with delivered measurements; observation mutation does not reach world', async () => {
  const world = await ReactiveWorld.create(12);
  try {
    const state = world.state(), first = makeMenu(state), changed = structuredClone(state);
    assert.ok(changed.target); changed.target!.value.position.x += 4;
    const next = makeMenu(changed); assert.notEqual(next.hash, first.hash);
    assert.deepEqual(world.state(), state);
    const stale = makeMenu({ ...state, target: state.target && { ...state.target, acquiredMs: state.simMs - 1001 } });
    assert.equal(stale.state.target, null); assert.ok(stale.candidates.every(c => c.facts.roverRelative === 'unknown'));
    const path = predict(vec(), vec(), vec(1, 0, 0)); assert.ok(path.at(-1)!.x > 1 && path.at(-1)!.x < 1.5); assert.equal(path.at(-1)!.y, 0);
    changed.ranges.value.points = [changed.odometry.value.position]; assert.equal(makeMenu(changed).candidates[0]!.facts.nearestObservedReturnM, 0);
  } finally { await world.close(); }
});

test('real MAVLink stream is delayed; physics, sensors and moving obstacles continue without inference', async () => {
  const events: { kind: string; data: any }[] = [], world = await ReactiveWorld.create(17, (kind, data) => events.push({ kind, data }));
  try {
    const before = world.state(), menu = makeMenu(before), candidate = menu.candidates.find(c => c.action.x === .4 && c.action.y === 0 && c.action.z === 0)!;
    assert.ok(candidate); const receipt = await world.apply(candidate.action, menu.source); assert.equal(receipt.accepted, true);
    const oldTarget = before.target!.value.position, oldObstacle = world.world.physics.body('crossing').pose.position;
    assert.equal(events.some(e => e.kind === 'world.event' && e.data.channel === 'protocol' && e.data.kind === 'rx'), false);
    for (let i = 0; i < 100; i++) await world.tick();
    const after = world.state(); assert.ok(after.odometry.value.position.x > before.odometry.value.position.x + .4);
    assert.ok(distance(oldTarget, after.target!.value.position) > .1); assert.ok(distance(oldObstacle, world.world.physics.body('crossing').pose.position) > .1);
    assert.ok(after.camera.acquiredMs > before.camera.acquiredMs); assert.ok(after.ranges.receivedMs > after.ranges.acquiredMs);
    assert.ok(events.some(e => e.kind === 'world.event' && e.data.channel === 'protocol' && e.data.data?.message === 'SET_POSITION_TARGET_LOCAL_NED'));
    for (let i = 0; i < 110; i++) await world.tick(); assert.ok(events.some(e => e.kind === 'reactive.expired'));
    assert.equal(world.evaluate().success, false);
  } finally { await world.close(); }
});

test('goal changes cancel old authority and delayed commands; stale samples and Stop reject late choices', async () => {
  const world = await ReactiveWorld.create(13, () => {}, 1000);
  const initial = world.state(), menu = makeMenu(initial);
  try {
    await world.apply(menu.candidates[0]!.action, menu.source);
    for (let i = 0; i < 45; i++) await world.tick();
    const current = world.state(); assert.equal(current.goalVersion, 2); assert.notEqual(current.goal, initial.goal);
    assert.deepEqual(await world.apply(menu.candidates[0]!.action, menu.source), { accepted: false, reason: 'superseded-goal' });
    assert.deepEqual(await world.apply(menu.candidates[0]!.action, { ...menu.source, goalVersion: 2, odometryMs: -5000 }), { accepted: false, reason: 'stale-observation' });
    await world.close(); assert.deepEqual(await world.apply(menu.candidates[0]!.action, menu.source), { accepted: false, reason: 'stopped' });
  } finally { await world.close(); }
});

test('paired environmental motion is independent of chosen drone action; sensor DTO has no world/evaluation fields', async () => {
  const a = await ReactiveWorld.create(19), b = await ReactiveWorld.create(19);
  try {
    const menu = makeMenu(b.state()); await b.apply(menu.candidates.find(c => c.action.y === .4 && c.action.x === 0 && c.action.z === 0)!.action, menu.source);
    for (let i = 0; i < 120; i++) { await a.tick(); await b.tick(); }
    for (const id of ['target/base', 'crossing']) assert.deepEqual(a.world.physics.body(id), b.world.physics.body(id));
    assert.ok(distance(a.state().odometry.value.position, b.state().odometry.value.position) > .2);
    assert.deepEqual(Object.keys(a.state()).sort(), ['camera', 'goal', 'goalReceivedMs', 'goalVersion', 'lastActions', 'odometry', 'ranges', 'simMs', 'target', 'touching'].sort());
    const state = a.state(); assert.ok(state.ranges.value.points.length); assert.ok(state.ranges.value.points.every(p => distance(p, state.ranges.value.origin) <= state.ranges.value.maxRange + .001));
  } finally { await a.close(); await b.close(); }
});

test('goal inspection is evaluated from actual side and optical geometry, not model declarations', async () => {
  const world = await ReactiveWorld.create(16, () => {}, 30000);
  try {
    assert.equal(world.evaluate().phases[0]!.inspectedAt, null);
    // Privileged evaluator fixture only: direct placement tests the scoring mechanics, never competes in live trials.
    for (let i = 0; i < 90; i++) {
      const target = world.world.physics.body('target/base'), q = target.pose.rotation;
      const theta = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
      const offset = vec(-Math.sin(theta) * 3.5, Math.cos(theta) * 3.5, 2);
      const position = add(target.pose.position, offset), heading = Math.atan2(-offset.y, -offset.x) * 180 / Math.PI;
      world.world.physics.move('drone/base', { position, rotation: { x: 0, y: 0, z: Math.sin(heading * Math.PI / 360), w: Math.cos(heading * Math.PI / 360) } });
      const state = world.state();
      await world.apply({ mode: 'velocity', x: 0, y: 0, z: 0, heading, pitch: -29.74, hfov: 70, duration: 3 }, { simMs: state.simMs, odometryMs: state.odometry.acquiredMs, goalVersion: state.goalVersion });
      await world.tick();
    }
    assert.ok(world.evaluate().phases[0]!.inspectedAt !== null); assert.equal(world.evaluate().success, false);
  } finally { await world.close(); }
});

test('brief attainment in both phases cannot pass the predeclared sustained-framing score', async () => {
  const config = structuredClone(DEFAULT_CONFIG); config.scoring.warmupMs = 0;
  const world = await ReactiveWorld.create(16, () => {}, 3000, config);
  try {
    // Evaluator-only placement fixture: visible throughout, correct side for 1.3s per phase.
    // No controller benchmark receives these coordinates or this privileged procedure.
    while (world.world.simMs < 6000) {
      world.world.physics.move('target/base', { ...world.world.physics.body('target/base').pose, position: vec(-8, -8, .5) });
      const target = world.world.physics.body('target/base'), q = target.pose.rotation;
      const theta = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
      const phaseTime = world.world.simMs % 3000, correct = phaseTime > 100 && phaseTime < 1400;
      const sign = (world.world.simMs < 3000 ? 1 : -1) * (correct ? 1 : -1);
      const offset = vec(-Math.sin(theta) * 3.5 * sign, Math.cos(theta) * 3.5 * sign, 2);
      const position = add(target.pose.position, offset), heading = Math.atan2(-offset.y, -offset.x) * 180 / Math.PI;
      world.world.physics.move('drone/base', { position, rotation: { x: 0, y: 0, z: Math.sin(heading * Math.PI / 360), w: Math.cos(heading * Math.PI / 360) } });
      const state = world.state();
      await world.apply({ mode: 'velocity', x: 0, y: 0, z: 0, heading, pitch: -29.74, hfov: 70, duration: 3 }, { simMs: state.simMs, odometryMs: state.odometry.acquiredMs, goalVersion: state.goalVersion });
      await world.tick();
    }
    const result = world.evaluate();
    assert.ok(result.phases.every(p => p.inspectedAt !== null), JSON.stringify(result.phases)); assert.equal(result.legacySuccess, true);
    assert.equal(result.success, false); assert.ok(result.phases.every(p => p.framingFraction < .5));
  } finally { await world.close(); }
});
