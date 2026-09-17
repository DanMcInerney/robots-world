import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createHost } from '../server.ts';
import { HttpRobotPort } from '../src/client.ts';

const hostOptions = { port: 0, web: false, realtime: false, demo: false, saveSession: false, scenario: 'portable', physics: 'kinematic' } as const;
type Host = Awaited<ReturnType<typeof createHost>>;
async function admin(host: Host, path: string, payload: unknown = {}) {
  const response = await fetch(`${host.url}/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-world-admin': host.adminToken }, body: JSON.stringify(payload),
  });
  return { response, data: await response.json() as any };
}
async function claim(host: Host) {
  const { response, data } = await admin(host, 'claim', { robotIds: ['fixture-1'], owner: 'HTTP integration fixture' });
  assert.equal(response.status, 200); assert.equal(data.ports.length, 1);
  const { robotId, token } = data.ports[0] as { robotId: string; token: string };
  return { port: new HttpRobotPort({ url: host.url, robotId, token }), token };
}

test('HTTP robot port runs a controller without spectator state and enforces token/host/origin boundaries', async () => {
  const host = await createHost(hostOptions);
  try {
    const { port, token } = await claim(host);
    const description = await port.describe(); assert.equal(description.id, 'fixture-1'); assert.ok(description.commands.goto);
    await admin(host, 'step', { ticks: 2 });
    const observation = await port.observe(); assert.equal(observation.robotId, 'fixture-1'); assert.ok(observation.sensors.odom?.valid);
    assert.equal(Object.hasOwn(observation, 'bodies'), false); assert.equal(Object.hasOwn(observation, 'scenario'), false);
    const request = { id: 'http-goto', action: 'goto', args: { x: 1, y: 0, z: 1 }, validForMs: 3000 };
    assert.equal((await port.command(request)).status, 'accepted');
    assert.equal((await port.command(request)).status, 'duplicate');
    await admin(host, 'step', { ticks: 100 });
    assert.equal((await port.observe()).jobs.find(job => job.commandId === request.id)?.status, 'completed');
    const direct = (path: string, headers: Record<string, string> = {}) => fetch(`${host.url}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: '{}',
    });
    assert.equal((await direct('/api/robots/other-robot/observe')).status, 403);
    assert.equal((await direct('/api/reset')).status, 403);
    assert.equal((await fetch(`${host.url}/api/inspect`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await direct('/api/robots/fixture-1/observe', { origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await direct('/api/robots/fixture-1/observe', { 'sec-fetch-site': 'cross-site' })).status, 403);
    const invalidHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${host.url}/api/robots/fixture-1/observe`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, host: 'unrelated.example', 'content-type': 'application/json' },
      }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(`${host.url}/api/session`)).status, 403);
    assert.equal((await fetch(`${host.url}/api/session`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
    assert.equal((await fetch(`${host.url}/api/session`, { headers: { 'x-world-viewer': token } })).status, 403);
    const viewerToken = new URLSearchParams(new URL(host.viewerUrl).hash.slice(1)).get('viewer')!;
    const bootstrap = await fetch(`${host.url}/api/session`, { headers: { 'x-world-viewer': viewerToken } });
    assert.equal(bootstrap.status, 200); assert.equal((await bootstrap.json() as { adminToken: string }).adminToken, host.adminToken);
    const conflicting = await admin(host, 'claim', { robotIds: ['fixture-1'], owner: 'another writer' });
    assert.equal(conflicting.response.status, 400);
    await port.close();
    await assert.rejects(port.observe(), /lease/i);
  } finally { await host.close(); }
});

test('HTTP stop invalidates late commands, and reset invalidates every prior remote lease', async () => {
  const host = await createHost(hostOptions);
  try {
    const first = await claim(host);
    const epoch = (await first.port.observe()).epoch;
    await first.port.command({ id: 'moving', action: 'goto', args: { x: 10, y: 0, z: 1 } });
    await first.port.stop();
    await assert.rejects(first.port.command({ id: 'late', action: 'goto', args: { x: 20, y: 0, z: 1 } }), /revoked|lease/i);
    const second = await claim(host);
    await second.port.command({ id: 'after-takeover', action: 'goto', args: { x: 1, y: 0, z: 1 } });
    await assert.rejects(first.port.command({ id: 'very-late', action: 'hold', args: {} }), /revoked|lease/i);
    const reset = await admin(host, 'reset', { scenario: 'portable', physics: 'kinematic' });
    assert.equal(reset.response.status, 200); assert.notEqual(reset.data.epoch, epoch);
    await assert.rejects(second.port.observe(), /lease/i);
    await assert.rejects(second.port.command({ id: 'reset-late', action: 'hold', args: {} }), /lease/i);
    const third = await claim(host); assert.equal((await third.port.observe()).epoch, reset.data.epoch);
    await third.port.close();
  } finally { await host.close(); }
});

test('HTTP host rejects oversized input and failed reset preserves the running world', async () => {
  const host = await createHost(hostOptions);
  try {
    const { port, token } = await claim(host), before = await port.observe();
    const response = await fetch(`${host.url}/api/robots/fixture-1/command`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'oversized', action: 'hold', args: {}, padding: 'x'.repeat(70000) }),
    });
    assert.equal(response.status, 400); await response.text();
    const failed = await admin(host, 'reset', { scenario: 'missing' }); assert.equal(failed.response.status, 400);
    assert.equal((await port.observe()).epoch, before.epoch);
    await port.close();
  } finally { await host.close(); }
});

test('HTTP host close releases its listener and is idempotent', async () => {
  const host = await createHost(hostOptions);
  const { port } = await claim(host), boundPort = Number(new URL(host.url).port);
  await host.close(); await host.close();
  await assert.rejects(port.observe());
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(boundPort, '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
});

test('HTTP robot Stop revokes before an in-flight asynchronous physics step completes', async () => {
  const host = await createHost(hostOptions);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stepEntered = new Promise<void>(resolve => { entered = resolve; });
  const original = host.world.physics.step.bind(host.world.physics);
  host.world.physics.step = async dt => { entered(); await gate; await original(dt); };
  try {
    const { port } = await claim(host);
    const stepping = admin(host, 'step', { ticks: 1 });
    await stepEntered;
    const late = assert.rejects(port.command({ id: 'pending-during-step', action: 'goto', args: { x: 4, y: 0, z: 1 } }), /revoked|lease/i);
    await port.stop(); // Must finish before the physics gate opens.
    release(); await stepping; await late;
    assert.equal(host.world.inspect().robots[0]!.owner, null);
  } finally { release(); await host.close(); }
});

test('HTTP queue saturation reports backpressure while Stop remains responsive', async () => {
  const host = await createHost(hostOptions);
  let release!: () => void, entered!: () => void, overflow!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stepEntered = new Promise<void>(resolve => { entered = resolve; });
  const queueFull = new Promise<void>(resolve => { overflow = resolve; });
  const original = host.world.physics.step.bind(host.world.physics);
  host.world.physics.step = async dt => { entered(); await gate; await original(dt); };
  let requests: Promise<{ status: number; error?: string }[]> | undefined;
  try {
    const { port, token } = await claim(host);
    const stepping = admin(host, 'step', { ticks: 1 }); await stepEntered;
    requests = Promise.all(Array.from({ length: 140 }, async () => {
      const response = await fetch(`${host.url}/api/robots/fixture-1/observe`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      });
      const data = await response.json() as { error?: string };
      if (data.error?.includes('queue full')) overflow();
      return { status: response.status, error: data.error };
    }));
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([queueFull, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Backpressure was not reported')), 3000); })]); }
    finally { clearTimeout(timeout); }
    await port.stop(); release(); await stepping;
    const results = await requests;
    assert.ok(results.some(result => result.error?.includes('queue full')));
    assert.ok(results.every(result => result.status === 400));
  } finally { release(); await requests; await host.close(); }
});
