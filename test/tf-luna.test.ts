import test from 'node:test';
import assert from 'node:assert/strict';
import { common } from 'node-mavlink';
import { tfLuna, encodeLuna, decodeLuna, LunaParser } from '../src/devices/tf-luna.ts';
import { lunaMavlink } from '../src/protocols/tf-luna.ts';
import { MavlinkCodec, MavlinkAdapter } from '../src/protocols/mavlink.ts';
import { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { pose, vec } from '../src/math.ts';
import type { Scenario } from '../src/contracts.ts';

test('TF-Luna real UART parser handles fragments, checksum corruption and invalid signals', () => {
  const frame = encodeLuna(342, 1000, 25), parser = new LunaParser();
  assert.deepEqual(decodeLuna(frame), { distanceM: 3.42, strength: 1000, temperatureC: 25, valid: true, reason: null });
  assert.deepEqual(parser.push(Uint8Array.of(7, 0x59, 2)), []);
  assert.deepEqual(parser.push(frame.subarray(0, 4)), []);
  assert.equal(parser.push(frame.subarray(4))[0]!.measurement.distanceM, 3.42);
  const bad = frame.slice(); bad[4] ^= 1;
  const recovered = parser.push(Uint8Array.from([...bad, ...frame]));
  assert.equal(recovered.length, 1); assert(parser.corruptFrames > 0);
  for (const [distance, strength, reason] of [[342, 99, 'weak-or-no-return'], [342, 65535, 'saturated'], [10, 1000, 'too-close'], [850, 1000, 'out-of-range']] as const) {
    const reading = decodeLuna(encodeLuna(distance, strength)); assert.equal(reading.distanceM, null); assert.equal(reading.reason, reason);
  }
});

async function setup(reflectance = .9) {
  const registry = defaultRegistry(); registry.sensors.set('tf-luna', tfLuna(() => reflectance));
  const scenario: Scenario = { id: 'luna-test', seed: 15, dt: .02, gravity: vec(), bounds: vec(20, 20, 20),
    obstacles: [{ id: 'wall', mode: 'fixed', pose: pose(4, 0, 2), shape: { kind: 'box', size: vec(.2, 4, 4) } }],
    robots: [{ id: 'robot', model: 'kinematic', pose: pose(0, 0, 2), sensors: [{ id: 'front', type: 'tf-luna', hz: 50, latencyMs: 40, maxAgeMs: 100 }] }] };
  const world = await World.create(scenario, registry, 'kinematic'), port = world.claim('robot', 'test');
  return { world, port };
}
test('Optional mounted rangefinder sees one cone, applies reflectivity limits and has no hit identity', async () => {
  const { world, port } = await setup();
  try {
    assert.equal((await port.observe()).sensors.front!.valid, false);
    await world.advance(3);
    const reading = (await port.observe()).sensors.front!, value = reading.value as any;
    assert.equal(reading.receivedSimMs - reading.acquiredSimMs, 40);
    assert(value.distanceM > 3.75 && value.distanceM < 4.05);
    assert.equal(value.kind, 'tf-luna'); assert.equal('body' in value, false); assert.equal('point' in value, false); assert.equal('position' in value, false);
    // Move the wall outside the sensor cone: a missing return is unknown, not an 8m-clear ray.
    world.physics.move('wall', pose(4, 6, 2)); await world.advance(3);
    assert.equal(((await port.observe()).sensors.front!.value as any).distanceM, null);
  } finally { world.close(); }
  const dark = await setup(.1);
  try { await dark.world.advance(3); const value = (await dark.port.observe()).sensors.front!.value as any; assert.equal(value.valid, false); assert.equal(value.distanceM, null); }
  finally { dark.world.close(); }
});
test('Range telemetry works without global odometry and retains invalid quality', async () => {
  const { world, port } = await setup(), codec = new MavlinkCodec();
  const adapter = new MavlinkAdapter({ ports: [{ port, systemId: 1 }] });
  try {
    await world.advance(3);
    const frames = await adapter.telemetry(), frame = frames.find(b => codec.packets(b)[0]!.header.msgid === 132)!;
    assert(frame); const decoded = codec.decode(frame, common.DistanceSensor);
    assert(decoded.currentDistance > 375 && decoded.currentDistance < 405); assert.equal(decoded.timeBootMs, 20);
    const observation = await port.observe(), reading = observation.sensors.front!; reading.valid = false;
    const invalid = lunaMavlink(reading, (await port.describe()).sensors[0]!, 0)!;
    assert.equal(invalid.signalQuality, 1); assert.equal(invalid.currentDistance, 0);
  } finally { adapter.close(); world.close(); }
});
test('Mixed surfaces do not gain a perfect-invalidity oracle; beam can return a blended distance', () => {
  let ray = 0;
  const sensor = tfLuna(() => .9);
  const value = sensor.sample({ robotId: 'test', bodyIds: ['test/base'], link: 'test/base', mount: pose(), simMs: 0, random: () => .5,
    physics: { ray: () => ({ body: ++ray % 2 ? 'near' : 'far', distance: ray % 2 ? 3 : 6, point: vec() }) } as any }, { id: 'range', type: 'tf-luna', hz: 50 }) as any;
  assert(value.valid); assert(value.distanceM > 3 && value.distanceM < 6);
  assert.equal('mixed' in value, false); assert.equal('body' in value, false);
});
test('A uniform oblique ground plane returns distance instead of being rejected as mixed surfaces', async () => {
  const registry = defaultRegistry(); registry.sensors.set('tf-luna', tfLuna(() => .9));
  const world = await World.create({ id: 'ground-beam', seed: 1, dt: .02, gravity: vec(), bounds: vec(20, 20, 20),
    obstacles: [{ id: 'ground', mode: 'fixed', pose: pose(0, 0, -.1), shape: { kind: 'box', size: vec(30, 30, .2) } }],
    robots: [{ id: 'drone', model: 'kinematic', pose: pose(0, 0, 2.5), sensors: [{ id: 'luna', type: 'tf-luna', hz: 50, mount: { ...pose(), rotation: { x: 0, y: Math.sin(Math.PI / 12), z: 0, w: Math.cos(Math.PI / 12) } } }] }] }, registry, 'kinematic');
  try { const value = (await world.claim('drone', 'test').observe()).sensors.luna!.value as any; assert(value.valid); assert(Math.abs(value.distanceM - 5) < .2); }
  finally { world.close(); }
});
