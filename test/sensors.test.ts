import assert from 'node:assert/strict';
import test from 'node:test';
import type { BodySpec, BodyState, Contact, Diagnostic, PhysicsBackend, Pose, RobotPlant, RobotSpec, SensorSpec, Vec3 } from '../src/contracts.ts';
import { pose, vec } from '../src/math.ts';
import { builtinSensors, SensorBank } from '../src/sensors/index.ts';

class PhysicsFixture implements PhysicsBackend {
  id = 'fixture';
  gravity = vec(0, 0, -9.81);
  capabilities = ['bodies', 'raycast', 'contacts', 'joints'];
  state: BodyState = { id: 'robot/base', pose: pose(), linearVelocity: vec(), angularVelocity: vec() };
  lastRay?: { origin: Vec3; direction: Vec3; exclude?: readonly string[] };
  body(id: string) { assert.equal(id, this.state.id); return structuredClone(this.state); }
  bodies() { return [this.body(this.state.id)]; }
  addBody(_spec: BodySpec) {} addJoint() {} force() {} velocity() {} move(_id: string, _pose: Pose) {}
  jointTarget() {} jointPosition() { return 0.4; }
  contacts(): Contact[] { return [{ a: 'robot/base', b: 'wall' }, { a: 'other/base', b: 'floor' }]; }
  ray(origin: Vec3, direction: Vec3, maxDistance: number, exclude?: readonly string[]) {
    this.lastRay = { origin, direction, exclude };
    // A real geometric intersection with an infinite fixture wall at x=-3.
    const distance = (-3-origin.x)/direction.x;
    return distance >= 0 && distance <= maxDistance ? { body: 'wall', distance, point: vec(-3, origin.y+distance*direction.y, origin.z+distance*direction.z) } : null;
  }
  step() {} close() {}
}
const plant: RobotPlant = { root: 'robot/base', bodyIds: ['robot/base'], jointIds: ['robot/shoulder'], visuals: [], apply() {}, tick() {}, stop() {}, completed: () => true };
function setup(sensors: SensorSpec[], physics = new PhysicsFixture()) {
  const robot: RobotSpec = { id: 'robot', model: 'fixture', pose: pose(), sensors };
  const events: Omit<Diagnostic, 'id' | 'wallMs'>[] = [];
  const bank = new SensorBank({ robot, plant, physics, plugins: new Map(builtinSensors.map(plugin => [plugin.id, plugin])), seed: 17, record: event => events.push(event) });
  return { bank, events, physics };
}
const close = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-9, `${a} != ${b}`);

test('mounted lidar composes link translation and both rotations, excluding its own robot', () => {
  const physics = new PhysicsFixture();
  const half = Math.sqrt(0.5);
  physics.state.pose = { position: vec(2, 3, 1), rotation: { x: 0, y: 0, z: half, w: half } };
  const { bank } = setup([{ id: 'scan', type: 'lidar', hz: 10, link: 'base',
    mount: { position: vec(1, 0, 0), rotation: { x: 0, y: 0, z: half, w: half } }, config: { rays: 1, maxRange: 20 } }], physics);
  bank.tick(0);
  const beam = physics.lastRay!;
  close(beam.origin.x, 2); close(beam.origin.y, 4); close(beam.origin.z, 1);
  close(beam.direction.x, -1); close(beam.direction.y, 0);
  assert.deepEqual(beam.exclude, ['robot/base']);
  close((bank.snapshot(0).scan.value as { distances: number[] }).distances[0], 5);
});

test('gyro rotates angular velocity into the mounted sensor frame', () => {
  const physics = new PhysicsFixture();
  physics.state.angularVelocity = vec(1, 0, 0);
  const half = Math.sqrt(0.5);
  const { bank } = setup([{ id: 'angular', type: 'gyro', hz: 10,
    mount: { position: vec(), rotation: { x: 0, y: 0, z: half, w: half } } }], physics);
  bank.tick(0);
  const value = bank.snapshot(0).angular.value as unknown as { angularVelocity: Vec3 };
  close(value.angularVelocity.x, 0); close(value.angularVelocity.y, -1);
});

test('sensor cadence, delivery latency and staleness are independent of observation calls', () => {
  const { bank, events, physics } = setup([{ id: 'odom', type: 'odometry', hz: 10, latencyMs: 150, maxAgeMs: 220 }]);
  bank.tick(0);
  assert.equal(bank.snapshot(0).odom.reason, 'unavailable');
  physics.state.pose.position.x = 9;
  bank.tick(100);
  assert.equal(bank.snapshot(100).odom.valid, false);
  bank.tick(150);
  const first = bank.snapshot(150).odom;
  assert.equal(first.acquiredSimMs, 0); assert.equal(first.receivedSimMs, 150);
  assert.equal((first.value as unknown as { position: Vec3 }).position.x, 0);
  assert.equal(bank.snapshot(230).odom.reason, 'stale');
  bank.tick(250);
  assert.equal(bank.snapshot(250).odom.acquiredSimMs, 100);
  assert.equal(bank.snapshot(250).odom.receivedSimMs, 250);
  assert.equal((bank.snapshot(250).odom.value as unknown as { position: Vec3 }).position.x, 9);
  assert.equal(events.filter(event => event.kind === 'acquired').length, 3);
  const copy = bank.snapshot(250); (copy.odom.value as unknown as { position: Vec3 }).position.x = -20;
  assert.equal((bank.snapshot(250).odom.value as unknown as { position: Vec3 }).position.x, 9);
});

test('coarse physics ticks do not fabricate historical samples and queue overflow is visible', () => {
  const { bank, events } = setup([{ id: 'odom', type: 'odometry', hz: 1000, latencyMs: 10000 }]);
  bank.tick(0); bank.tick(100);
  assert.equal(events.filter(event => event.kind === 'acquired').length, 2);
  assert.equal((events.find(event => event.kind === 'cadence-skipped')!.data as { count: number }).count, 99);
  for (let time = 101; time <= 400; time++) bank.tick(time);
  assert.ok(events.some(event => event.kind === 'dropped' && (event.data as { reason: string }).reason === 'latency-queue-overflow'));
  assert.equal(bank.snapshot(400).odom.reason, 'unavailable');
});

test('noise streams are unaffected by adding or reordering unrelated sensors', () => {
  const odom: SensorSpec = { id: 'odom', type: 'odometry', hz: 20, noise: 0.1 };
  const extra: SensorSpec = { id: 'other', type: 'gyro', hz: 30, noise: 2, dropout: 0.5 };
  const first = setup([odom]).bank;
  const second = setup([extra, odom]).bank;
  for (let tick = 0; tick < 20; tick++) {
    first.tick(tick*50); second.tick(tick*50);
    assert.deepEqual(first.snapshot(tick*50).odom, second.snapshot(tick*50).odom);
  }
  const lost = setup([{ ...odom, dropout: 1 }]); lost.bank.tick(0); lost.bank.tick(50);
  assert.equal(lost.bank.snapshot(50).odom.valid, false);
  assert.equal(lost.events.filter(event => event.kind === 'dropped').length, 2);
});

test('configuration rejects invalid cadence, mounts, capabilities, links and excessive outputs', () => {
  const spec: SensorSpec = { id: 'odom', type: 'odometry', hz: 10 };
  for (const patch of [{ hz: 0 }, { hz: NaN }, { latencyMs: -1 }, { noise: Infinity }, { dropout: 2 }, { maxAgeMs: -1 }, { type: 'unknown' }, { link: 'other/base' }]) {
    assert.throws(() => setup([{ ...spec, ...patch }]));
  }
  assert.throws(() => setup([spec, spec]), /duplicate/);
  assert.throws(() => setup([{ ...spec, mount: { position: vec(), rotation: { x: 0, y: 0, z: 0, w: 0 } } }]), /normalized/);
  assert.throws(() => setup([{ ...spec, type: 'depth', config: { width: 1000 } }]), /width/);
  const physics = new PhysicsFixture(); physics.capabilities = ['bodies'];
  assert.throws(() => setup([{ ...spec, type: 'lidar' }], physics), /raycast/);
  assert.throws(() => setup([{ ...spec, type: 'joints', config: { joints: ['other/shoulder'] } }]), /not owned/);
});

test('contact and joint sensors report only the selected robot and no sensors is valid', () => {
  const { bank } = setup([{ id: 'touch', type: 'contact', hz: 10 }, { id: 'angles', type: 'joints', hz: 10 }]);
  bank.tick(0);
  assert.deepEqual(bank.snapshot(0).touch.value, { touching: true, count: 1, links: ['robot/base'] });
  assert.deepEqual(bank.snapshot(0).angles.value, { units: 'rad', joints: [{ name: 'robot/shoulder', position: 0.4 }] });
  assert.deepEqual(setup([]).bank.snapshot(0), {});
});
