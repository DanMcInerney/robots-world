import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { scenario } from '../scenarios/index.ts';

test('closing a world revokes authority immediately but disposes an asynchronous backend only after its step joins', async () => {
  const plugins = defaultRegistry();
  const factory = plugins.physics.get('kinematic')!;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  let disposed = false;
  plugins.physics.set('delayed', async options => {
    const backend = await factory(options), step = backend.step.bind(backend), close = backend.close.bind(backend);
    backend.step = async dt => { entered(); await wait; assert.equal(disposed, false); await step(dt); };
    backend.close = () => { disposed = true; close(); }; return backend;
  });
  const world = await World.create(scenario('portable'), plugins, 'delayed');
  const port = world.claim('fixture-1', 'fixture');
  const advancing = world.advance(10);
  await started; world.close();
  assert.equal(disposed, false);
  await assert.rejects(port.command({ id: 'late', action: 'velocity', args: { x: 1, y: 0, z: 0 } }), /revoked/);
  release(); await advancing;
  assert.equal(disposed, true); assert.equal(world.simMs, 20);
});

test('invalid packet acknowledgement cannot partially consume unread events', async () => {
  const world = await World.create(scenario('portable'), defaultRegistry(), 'kinematic');
  try {
    const port = world.claim('fixture-1', 'fixture');
    await port.command({ id: 'hold', action: 'hold', args: {} });
    const before = await port.observe();
    assert.ok(before.events.length);
    await assert.rejects(port.acknowledge(before.events.at(-1)!.id, 'invalid' as unknown as string[]), /acknowledgement/);
    assert.deepEqual((await port.observe()).events, before.events);
  } finally { world.close(); }
});
