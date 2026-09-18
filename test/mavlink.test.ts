import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { common, minimal } from 'node-mavlink';
import { MavlinkAdapter, MavlinkCodec, enuToNed, nedToEnu } from '../src/protocols/mavlink.ts';
import { MavlinkUdpEndpoint } from '../src/protocols/udp.ts';
import type { Command, RobotPort } from '../src/contracts.ts';
import { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { scenario } from '../scenarios/index.ts';

function port(robotId: string) {
  const commands: Command[] = [];
  const value: RobotPort = { robotId,
    describe: async () => ({ id: robotId, model: 'drone', units: 'SI ENU', commands: {}, radio: { channel: 'team', rangeM: 1, bitrateBps: 1, latencyMs: 0, jitterMs: 0, loss: 0, maxQueueBytes: 100, maxPacketBytes: 10 }, sensors: [{ id: 'pose', type: 'odometry', hz: 10 }] }),
    observe: async () => ({ robotId, epoch: 'test', sequence: 1, simMs: 200, wallMs: 200, goal: '', jobs: [], inbox: [], events: [], sensors: {
      pose: { value: { position: { x: 1, y: 2, z: 3 }, linearVelocity: { x: 4, y: 5, z: 6 } }, sequence: 1, acquiredSimMs: 100, receivedSimMs: 110, valid: true },
    } }),
    command: async command => { commands.push(command); return { id: command.id, status: 'accepted' }; },
    acknowledge: async () => {}, send: async () => ({ accepted: true }), stop: async () => {}, close: async () => {},
  };
  return { port: value, commands };
}
function setpoint(system = 1, component = 1) {
  const message = new common.SetPositionTargetLocalNed();
  Object.assign(message, { targetSystem: system, targetComponent: component, coordinateFrame: 1, typeMask: 3576, x: 2, y: 1, z: -3 });
  return message;
}

test('MAVLink v2 codec verifies CRC, enforces framing, and converts ENU/NED', () => {
  const codec = new MavlinkCodec(), bytes = codec.encode(setpoint());
  assert.equal(bytes[0], 0xfd); assert.equal(codec.decode(bytes, common.SetPositionTargetLocalNed).z, -3);
  assert.deepEqual(nedToEnu(enuToNed({ x: 3, y: 5, z: 7 })), { x: 3, y: 5, z: 7 });
  const corrupt = Buffer.from(bytes); corrupt[10] = corrupt[10]! ^ 1;
  assert.throws(() => codec.packets(corrupt), /crc/);
  assert.throws(() => codec.packets(bytes.subarray(0, bytes.length - 1)), /truncated/);
  const signed = Buffer.from(bytes); signed[2] = 1; assert.throws(() => codec.packets(signed), /unsupported/);
  assert.equal(codec.packets(Buffer.concat([bytes, bytes])).length, 2);
});

test('MAVLink routes only explicit vehicle and component identities and rejects unsupported masks', async () => {
  const a = port('a'), b = port('b'), codec = new MavlinkCodec();
  const adapter = new MavlinkAdapter({ ports: [{ port: a.port, systemId: 1 }, { port: b.port, systemId: 2 }] });
  const corrupt = codec.encode(setpoint(2)); corrupt[10] = corrupt[10]! ^ 1;
  await assert.rejects(adapter.receive(corrupt), /crc/); assert.equal(b.commands.length, 0);
  await adapter.receive(codec.encode(setpoint(2))); assert.equal(a.commands.length, 0); assert.equal(b.commands.length, 1);
  assert.equal(b.commands[0]!.action, 'goto'); assert.deepEqual(b.commands[0]!.args, { x: 1, y: 2, z: 3 });
  await adapter.receive(codec.encode(setpoint(0))); await adapter.receive(codec.encode(setpoint(2, 0)));
  const invalid = setpoint(2); Object.assign(invalid, { typeMask: 0 }); await adapter.receive(codec.encode(invalid)); assert.equal(b.commands.length, 1);
  const velocity = setpoint(1); Object.assign(velocity, { typeMask: 3527, vx: 7, vy: 8, vz: -9 });
  await adapter.receive(codec.encode(velocity)); assert.deepEqual(a.commands[0]!.args, { x: 8, y: 7, z: 9 }); assert.equal(a.commands[0]!.action, 'velocity');
  assert.throws(() => new MavlinkAdapter({ ports: [{ port: a.port, systemId: 1 }, { port: b.port, systemId: 1 }] }), /duplicate/);
});

test('MAVLink uses installed odometry samples and reports unsupported command transactions', async () => {
  const a = port('a'), codec = new MavlinkCodec();
  const adapter = new MavlinkAdapter({ ports: [{ port: a.port, systemId: 4 }] });
  const frames = await adapter.telemetry();
  assert.equal(frames.length, 2); assert.equal(codec.packets(frames[0]!)[0]!.header.sysid, 4);
  assert.equal(codec.decode(frames[0]!, minimal.Heartbeat).autopilot, 8);
  const position = codec.decode(frames[1]!, common.LocalPositionNed);
  assert.equal(position.timeBootMs, 100); assert.deepEqual({ x: position.x, y: position.y, z: position.z }, { x: 2, y: 1, z: -3 });
  const command = new common.CommandLong(); Object.assign(command, { targetSystem: 4, targetComponent: 1, command: 22 });
  const [reply] = await adapter.receive(codec.encode(command)); assert.equal(codec.decode(reply!, common.CommandAck).result, 3); assert.equal(a.commands.length, 0);
  adapter.close(); await assert.rejects(adapter.receive(codec.encode(setpoint(4))), /closed/);
});

test('explicit UDP endpoint accepts real datagrams only from its pinned loopback peer', async () => {
  const peer = createSocket('udp4'), rogue = createSocket('udp4');
  peer.bind(0, '127.0.0.1'); await once(peer, 'listening');
  rogue.bind(0, '127.0.0.1'); await once(rogue, 'listening');
  const a = port('a'), codec = new MavlinkCodec();
  let received!: () => void; const applied = new Promise<void>(resolve => { received = resolve; });
  const original = a.port.command; a.port.command = async command => { const result = await original(command); received(); return result; };
  const adapter = new MavlinkAdapter({ ports: [{ port: a.port, systemId: 1 }] });
  const endpoint = await MavlinkUdpEndpoint.open({ adapter, peer: { address: '127.0.0.1', port: peer.address().port } });
  try {
    rogue.send(codec.encode(setpoint()), endpoint.address().port, '127.0.0.1');
    const expected = setpoint(); expected.x = 42;
    peer.send(codec.encode(expected), endpoint.address().port, '127.0.0.1');
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([applied, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('UDP test timed out')), 2000); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(a.commands.length, 1); assert.equal(a.commands[0]!.args.y, 42);
    const reply = once(peer, 'message', { signal: AbortSignal.timeout(2000) });
    const unsupported = new common.CommandLong(); Object.assign(unsupported, { targetSystem: 1, targetComponent: 1, command: 22 });
    peer.send(codec.encode(unsupported), endpoint.address().port, '127.0.0.1');
    const [bytes] = await reply;
    const ack = codec.decode(bytes as Buffer, common.CommandAck);
    assert.equal(ack.result, 3); assert.equal(ack.targetSystem, 255); assert.equal(ack.command, 22);
  } finally { await endpoint.close(); adapter.close(); peer.close(); rogue.close(); }
});

test('MAVLink streaming updates survive sequence wrap and telemetry drains execution events without consuming radio', async () => {
  const config = scenario('portable');
  const peer = structuredClone(config.robots[0]!); peer.id = 'peer'; peer.pose.position.y = 1; config.robots.push(peer);
  const world = await World.create(config, defaultRegistry(), 'kinematic');
  const robot = world.claim('fixture-1', 'MAVLink fixture'), sender = world.claim('peer', 'radio fixture');
  const adapter = new MavlinkAdapter({ ports: [{ port: robot, systemId: 1 }], simMs: () => world.simMs, record: world.journal.record });
  const codec = new MavlinkCodec();
  try {
    await sender.send({ id: 'unconsumed', to: 'fixture-1', data: 'keep me', ttlMs: 60000 });
    const message = setpoint(); Object.assign(message, { typeMask: 3527, vx: 0, vy: 0.1, vz: 0, timeBootMs: 0 });
    const ids = new Set<string>();
    let first: Buffer | undefined;
    for (let i = 0; i < 300; i++) {
      const frame = codec.encode(message);
      if (i === 0) first = frame;
      if (i === 256) assert.deepEqual(frame, first, 'wire bytes really repeat after sequence wrap');
      await adapter.receive(frame);
      await world.advance(5);
      await adapter.telemetry();
      const observation = await robot.observe();
      assert.equal(observation.fault, undefined);
      assert.equal(observation.events.length, 0);
      assert.equal(observation.jobs.at(-1)?.status, 'running');
      ids.add(observation.jobs.at(-1)!.commandId);
    }
    assert.equal(ids.size, 300);
    const execution = world.journal.after().filter(event => event.kind === 'execution_observed');
    assert.ok(execution.length > 0 && execution.every(event => !event.truncated), 'transition evidence stays intact after job history fills');
    const final = await robot.observe(); assert.equal(final.inbox.length, 1); assert.equal(final.inbox[0]!.data, 'keep me');
    assert.ok(world.physics.body('fixture-1/base').pose.position.x > 2.9, 'fresh setpoints continue motion after wrap');
    await world.advance(55); assert.equal((await robot.observe()).jobs.at(-1)?.status, 'expired', 'watchdog still stops an interrupted stream');
  } finally { adapter.close(); world.close(); }
});
