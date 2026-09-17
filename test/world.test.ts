import assert from 'node:assert/strict';
import test from 'node:test';
import type { RobotModel, RobotPort, Scenario, Vec3 } from '../src/contracts.ts';
import { pose, distance, vec } from '../src/math.ts';
import { kinematicFactory, rapierFactory } from '../src/physics/index.ts';
import { registry } from '../src/registry.ts';
import { builtinSensors } from '../src/sensors/index.ts';
import { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { scenario as createScenario } from '../scenarios/index.ts';
import { DemoPolicy } from '../experiments/policy.ts';

/** A deliberately small custom plant proves the host does not require builtin robot commands. */
const testModel: RobotModel = {
  id: 'test-cart', requires: ['bodies', 'kinematic'],
  commands: {
    move: { description: 'Move a fixture cart along X.', schema: { type: 'object', additionalProperties: false, required: ['x'], properties: { x: { type: 'number', minimum: -20, maximum: 20 } } } },
    hold: { description: 'Hold.', schema: { type: 'object', additionalProperties: false } },
  },
  create({ id, pose: initial, physics }) {
    const root = `${id}/base`;
    const visual = { id: root, pose: initial, shape: { kind: 'box' as const, size: vec(0.2, 0.2, 0.2) }, mode: 'kinematic' as const };
    physics.addBody(visual);
    let target = initial.position.x;
    return { root, bodyIds: [root], jointIds: [], visuals: [visual],
      apply(action, args) { target = action === 'hold' ? physics.body(root).pose.position.x : args.x as number; },
      tick(dt) {
        const current = physics.body(root).pose;
        current.position.x += Math.max(-dt, Math.min(dt, target-current.position.x));
        physics.move(root, current);
      },
      stop() { target = physics.body(root).pose.position.x; },
      completed(_action, _args) { return Math.abs(physics.body(root).pose.position.x-target) < 1e-5; },
    };
  },
};
const plugins = () => registry({ physics: { rapier: rapierFactory, kinematic: kinematicFactory }, models: [testModel], sensors: builtinSensors });
function scenario(sensors = true): Scenario {
  return { id: 'contract-fixture', seed: 42, dt: 0.02, gravity: vec(), bounds: vec(50, 50, 10), obstacles: [], robots: [0, 1].map(index => ({
    id: `robot-${index}`, model: 'test-cart', pose: pose(0, index*3, 1),
    sensors: sensors ? [{ id: 'odom', type: 'odometry', hz: 20, maxAgeMs: 200 }] : [],
  })) };
}
async function useWorld(fn: (world: World) => Promise<void>, config = scenario(), backend = 'kinematic') {
  const world = await World.create(config, plugins(), backend);
  try { await fn(world); } finally { world.close(); }
}

test('robot ports isolate ownership and observations; stop revokes old authority', async () => {
  await useWorld(async world => {
    const a = world.claim('robot-0', 'owner-a'), b = world.claim('robot-1', 'owner-b');
    assert.throws(() => world.claim('robot-0', 'intruder'), /already owned/);
    const observation = await a.observe();
    assert.equal(observation.robotId, 'robot-0');
    assert.deepEqual(Object.keys(observation.sensors), ['odom']);
    assert.equal(Object.hasOwn(observation, 'bodies'), false);
    assert.equal(Object.hasOwn(observation, 'robots'), false);
    await a.command({ id: 'a-go', action: 'move', args: { x: 3 } });
    await b.command({ id: 'b-go', action: 'move', args: { x: 3 } });
    await world.advance(10);
    await a.stop();
    await assert.rejects(a.observe(), /revoked/);
    await assert.rejects(a.command({ id: 'late', action: 'move', args: { x: 10 } }), /revoked/);
    const newA = world.claim('robot-0', 'new-owner');
    const stopped = world.physics.body('robot-0/base').pose.position.x;
    await world.advance(10);
    assert.equal(world.physics.body('robot-0/base').pose.position.x, stopped);
    assert.ok(world.physics.body('robot-1/base').pose.position.x > stopped);
    assert.equal((await newA.observe()).jobs[0].status, 'cancelled');
    await newA.close(); await b.close();
  });
});

test('physics and sensors advance while a controller awaits; stale decisions cannot apply', async () => {
  await useWorld(async world => {
    const slow = world.claim('robot-0', 'slow'), fast = world.claim('robot-1', 'fast');
    const input = await slow.observe();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = (async () => {
      await gate;
      return slow.command({ id: 'slow-result', action: 'move', args: { x: 2 }, basedOn: { observation: input.sequence, maxAgeMs: 100 } });
    })();
    await fast.command({ id: 'fast-go', action: 'move', args: { x: 2 } });
    await world.advance(25);
    const current = await slow.observe();
    assert.ok(current.sensors.odom.sequence > input.sensors.odom.sequence);
    assert.ok(world.physics.body('robot-1/base').pose.position.x > 0.4);
    release();
    assert.equal((await pending).status, 'rejected');
    assert.equal(world.physics.body('robot-0/base').pose.position.x, 0);
  });
});

test('duplicate command IDs do not repeat effects and conflicting IDs do not replace motion', async () => {
  await useWorld(async world => {
    const port = world.claim('robot-0', 'commands');
    const command = { id: 'same', action: 'move', args: { x: 3 } };
    const first = await port.command(command);
    assert.equal(first.status, 'accepted');
    assert.equal((await port.command(command)).status, 'duplicate');
    assert.equal((await port.command({ ...command, args: { x: -3 } })).status, 'rejected');
    await world.advance(20);
    assert.ok(world.physics.body('robot-0/base').pose.position.x > 0);
    assert.equal((await port.observe()).jobs.length, 1);
    assert.equal(world.journal.after().filter(item => item.kind === 'command.applied').length, 1);
  });
});

test('command watchdog expires physical motion and records expiry without revoking a live port', async () => {
  await useWorld(async world => {
    const port = world.claim('robot-0', 'watchdog');
    await port.command({ id: 'brief', action: 'move', args: { x: 10 }, validForMs: 100 });
    await world.advance(10);
    const stopped = world.physics.body('robot-0/base').pose.position.x;
    await world.advance(10);
    assert.equal(world.physics.body('robot-0/base').pose.position.x, stopped);
    const observation = await port.observe();
    assert.equal(observation.jobs[0].status, 'expired');
    assert.ok(observation.events.some(event => event.kind === 'job.expired'));
    assert.equal((await port.command({ id: 'resume', action: 'move', args: { x: 1 } })).status, 'accepted');
  });
});

test('events and radio inbox require explicit acknowledgement; unread event overflow is visible', async () => {
  await useWorld(async world => {
    const a = world.claim('robot-0', 'a'), b = world.claim('robot-1', 'b');
    await a.command({ id: 'hello', action: 'hold', args: {} });
    const first = await a.observe(), second = await a.observe();
    assert.deepEqual(second.events, first.events);
    await a.acknowledge(first.events.at(-1)!.id);
    assert.equal((await a.observe()).events.length, 0);
    await a.send({ id: 'packet-1', to: 'robot-1', data: 'hello', ttlMs: 1000 });
    await world.advance(10);
    const inbox = await b.observe(); assert.equal(inbox.inbox.length, 1);
    assert.deepEqual((await b.observe()).inbox, inbox.inbox);
    await b.acknowledge(0, inbox.inbox.map(packet => packet.id));
    assert.equal((await b.observe()).inbox.length, 0);
    for (let index = 0; index < 130; index++) await a.command({ id: `fill-${index}`, action: 'hold', args: {} });
    const saturated = await a.observe();
    assert.equal(saturated.events.length, 128);
    assert.match(saturated.fault ?? '', /capacity/);
    assert.equal((await a.command({ id: 'blocked', action: 'move', args: { x: 10 } })).status, 'rejected');
    await a.acknowledge(saturated.events.at(-1)!.id);
    assert.equal((await a.observe()).fault, undefined);
  });
});

test('zero sensors is a supported robot; old ports remain invalid after a fresh episode', async () => {
  const config = scenario(false);
  const old = await World.create(config, plugins(), 'kinematic');
  const oldPort = old.claim('robot-0', 'old');
  const oldEpoch = (await oldPort.observe()).epoch;
  assert.deepEqual((await oldPort.observe()).sensors, {});
  old.close();
  await useWorld(async current => {
    const port = current.claim('robot-0', 'new');
    assert.notEqual((await port.observe()).epoch, oldEpoch);
    await assert.rejects(oldPort.command({ id: 'late', action: 'move', args: { x: 10 } }), /revoked/);
    assert.equal(current.physics.body('robot-0/base').pose.position.x, 0);
  }, config);
});

test('the same port-only controller runs on both physics backends with repeatable trajectories', async () => {
  const controller = async (port: RobotPort) => {
    const description = await port.describe();
    assert.ok(description.commands.move);
    const observation = await port.observe();
    return port.command({ id: 'portable', action: 'move', args: { x: 1 }, basedOn: { observation: observation.sequence, maxAgeMs: 100 } });
  };
  const endpoints: Vec3[] = [];
  for (const backend of ['kinematic', 'rapier', 'rapier']) {
    await useWorld(async world => {
      await controller(world.claim('robot-0', 'portable'));
      await world.advance(60);
      const final = world.physics.body('robot-0/base').pose.position;
      endpoints.push(final);
      assert.ok(Math.abs(final.x-1) < 1e-5);
      assert.equal(world.inspect().robots[0].jobs[0].status, 'completed');
    }, scenario(), backend);
  }
  assert.ok(distance(endpoints[0], endpoints[1]) < 1e-5);
  assert.deepEqual(endpoints[1], endpoints[2]);
});

test('decentralized swarm followers stop after previously received leader beacons expire', async () => {
  const config = createScenario('swarm');
  for (const robot of config.robots) robot.radio = { ...robot.radio, loss: 0 };
  const world = await World.create(config, defaultRegistry());
  const policies = world.robotIds.map((id, index) => new DemoPolicy(world.claim(id, `policy-${index}`), { index, swarm: true }));
  try {
    for (let tick = 0; tick < 150; tick++) { if (tick % 3 === 0) await Promise.all(policies.map(policy => policy.tick())); await world.advance(); }
    assert.ok(policies.slice(1).every(policy => policy.stats.receivedBeacons > 0));
    const holds = policies.map(policy => policy.stats.holds);
    world.radio.setPartitions(world.robotIds.slice(1).map(id => [world.robotIds[0], id]));
    for (let tick = 0; tick < 180; tick++) { if (tick % 3 === 0) await Promise.all(policies.map(policy => policy.tick())); await world.advance(); }
    assert.ok(policies.slice(1).every((policy, index) => policy.stats.holds > holds[index+1]), 'each follower switches back to hold');
    for (const id of world.robotIds.slice(1)) {
      const speed = world.physics.body(`${id}/base`).linearVelocity;
      assert.ok(Math.hypot(speed.x, speed.y, speed.z) < 0.05, `${id} finishes stopping`);
    }
  } finally { world.close(); }
});
