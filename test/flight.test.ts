import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoint, aimedDroneKit } from '../src/devices/aim-camera.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { World } from '../src/world.ts';
import { pose, vec } from '../src/math.ts';
import { decodeFlight, flightMenu, validateAction } from '../experiments/flight-contract.ts';
import { FlightWorld, flightScenario } from '../experiments/flight-world.ts';

test('camera projection requires correct heading/pitch and narrows with zoom', () => {
  assert.equal(projectPoint(vec(0, 0, 3), vec(3, 0, 0), 0, -45, 35).inFrame, true);
  assert.equal(projectPoint(vec(0, 0, 3), vec(3, 0, 0), 180, -45, 70).inFrame, false);
  assert.equal(projectPoint(vec(), vec(5, 2, 0), 0, 0, 70).inFrame, true);
  assert.equal(projectPoint(vec(), vec(5, 2, 0), 0, 0, 35).inFrame, false);
});

test('camera sensor hides occluded and out-of-frame objects; slewing occurs over time', async () => {
  const registry = defaultRegistry(), kit = aimedDroneKit(); registry.models.set(kit.model.id, kit.model); registry.sensors.set(kit.camera.id, kit.camera);
  const world = await World.create({ id: 'camera-test', seed: 1, dt: .02, gravity: vec(), bounds: vec(20, 20, 10), obstacles: [
    { id: 'hidden', mode: 'fixed', pose: pose(5, 0, 2), shape: { kind: 'box', size: vec(1, 1, 1) } },
    { id: 'occluder', mode: 'fixed', pose: pose(2, 0, 2), shape: { kind: 'box', size: vec(.2, 2, 2) } },
    { id: 'visible', mode: 'fixed', pose: pose(0, 5, 2), shape: { kind: 'box', size: vec(1, 1, 1) } },
  ], robots: [{ id: 'd', model: kit.model.id, pose: pose(0, 0, 2), sensors: [{ id: 'camera', type: kit.camera.id, hz: 50, config: { targets: ['hidden', 'visible'] } }] }] }, registry);
  const port = world.claim('d', 'test');
  try {
    await port.command({ id: 'a', action: 'control', args: { mode: 'position', x: 0, y: 0, z: 2, heading: 0, pitch: 0, hfov: 70 }, validForMs: 5000 });
    await world.advance(30);
    assert.deepEqual((await port.observe()).sensors.camera!.value && ((await port.observe()).sensors.camera!.value as any).detections, []);
    await port.command({ id: 'b', action: 'control', args: { mode: 'position', x: 0, y: 0, z: 2, heading: 90, pitch: 0, hfov: 70 }, validForMs: 5000 });
    await world.advance(); assert.ok(Math.abs(((await port.observe()).sensors.camera!.value as any).headingDeg) < 10);
    await world.advance(75); assert.equal(((await port.observe()).sensors.camera!.value as any).detections[0].id, 'visible');
  } finally { await port.close(); world.close(); }
});

test('Jev grids expose the same coordinates regardless of goal or hidden target; encodings decode full controls', async () => {
  const world = await FlightWorld.create(11);
  try {
    const state = world.state();
    for (const encoding of ['axes', 'vectors'] as const) {
      const menu = flightMenu(state, encoding), other = flightMenu({ ...state, goal: 'a different task', beacon: null }, encoding);
      assert.deepEqual(menu.values, other.values);
      assert.ok(Object.values(menu.values).every(v => Object.keys(v).length <= 255));
      assert.ok(Object.values(menu.request.questions).every(q => Object.values(q.criteria).every(v => typeof v === 'string' || typeof v === 'object')));
      const answers = Object.fromEntries(Object.entries(menu.values).map(([id, options]) => {
        const keys = Object.keys(options), choice = keys[0]!;
        return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }];
      }));
      const decoded = decodeFlight({ model: 'jev-1.13.0', answers }, menu, encoding);
      assert.equal(decoded.action.mode, 'position'); assert.equal(decoded.action.hfov, 35);
      assert.throws(() => decodeFlight({ model: 'other', answers }, menu, encoding));
    }
    assert.throws(() => validateAction({ mode: 'velocity', x: 3, y: 0, z: 0, heading: 0, pitch: 0, hfov: 70, duration: 1 }));
  } finally { await world.close(); }
});

test('MAVLink moves drone while target/radio/camera continue; expiry and stop reject late work', async () => {
  const events: { kind: string; data: any }[] = [], world = await FlightWorld.create(11, (kind, data) => events.push({ kind, data }));
  const start = world.state();
  try {
    await world.apply({ mode: 'velocity', x: .4, y: .4, z: .4, heading: 15, pitch: -45, hfov: 35, duration: 1 }, start);
    for (let i = 0; i < 110; i++) await world.tick();
    const state = world.state(); assert.ok(state.position.z > start.position.z + .15); assert.equal(state.active, null);
    assert.ok(state.observation.sensors.camera!.acquiredSimMs > start.observation.sensors.camera!.acquiredSimMs);
    assert.ok(state.beacon); assert.ok(events.some(e => e.kind === 'world.event' && e.data.channel === 'protocol' && e.data.data?.message === 'SET_POSITION_TARGET_LOCAL_NED'));
    assert.equal(world.evaluate().success, false); await world.close();
    assert.equal((await world.apply({ mode: 'hold', x: 0, y: 0, z: 0, heading: 0, pitch: 0, hfov: 70, duration: 1 }, state)).accepted, false);
  } finally { await world.close(); }
});

test('side and orientation vary across paired seeds, with no route in controller observations', async () => {
  assert.match(flightScenario(101).robots[0]!.goal!, /left side/);
  assert.match(flightScenario(202).robots[0]!.goal!, /right side/);
  const world = await FlightWorld.create(101);
  try { assert.doesNotMatch(JSON.stringify(world.state()), /"obstacles"|"waypoints"|"evaluation"|"scenario"/); }
  finally { await world.close(); }
});

test('inspection requires the requested physical side and a continuous centered dwell', async () => {
  const world = await FlightWorld.create(303);
  try {
    for (let i = 0; i < 100; i++) await world.tick();
    assert.equal(world.evaluate().inspectionAtMs, null, 'initial camera visibility on wrong side is not inspection');
    const target = world.world.physics.body('target/base').pose.position;
    const location = { x: target.x, y: target.y + 3.5, z: 2.4 };
    world.world.physics.move('drone/base', { position: location, rotation: { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 } });
    await world.tick();
    await world.apply({ mode: 'position', ...location, heading: -90, pitch: -30, hfov: 70, duration: 8 }, world.state());
    for (let i = 0; i < 85; i++) await world.tick();
    assert.notEqual(world.evaluate().inspectionAtMs, null);
    assert.ok(world.evaluate().longestInspectionMs >= 1000);
  } finally { await world.close(); }
});
