import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { World } from './src/world.ts';
import { defaultRegistry } from './src/defaults.ts';
import { Journal } from './src/recorder.ts';
import type { Command, Diagnostic, RobotPort } from './src/contracts.ts';
import { scenarios, scenario } from './scenarios/index.ts';
import { DemoPolicy } from './experiments/policy.ts';

type HostOptions = { port?: number; scenario?: string; physics?: string; web?: boolean; realtime?: boolean; demo?: boolean; saveSession?: boolean };
const secret = () => randomBytes(24).toString('hex');
function equal(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
async function jsonBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > 65536) throw new Error('Request body exceeds 64 kB'); chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, any>;
}
function respond(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value));
}

/** Local host. Admin inspection and robot-scoped control are deliberately separate. */
export async function createHost(options: HostOptions = {}) {
  const adminToken = secret();
  const viewerToken = secret();
  const journal = new Journal(4000);
  let world = await World.create(scenario(options.scenario ?? 'mixed'), defaultRegistry(), options.physics ?? 'rapier', journal);
  let paused = false, demo = false, closed = false;
  let protocolSequence = 0;
  const leases = new Map<string, { robotId: string; port: RobotPort }>();
  const manuals = new Map<string, RobotPort>();
  let policies: DemoPolicy[] = [];
  let demoPorts: RobotPort[] = [];
  let work: Promise<unknown> = Promise.resolve();
  let queued = 0, generation = 0;
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Host closed'));
    if (queued >= 128) return Promise.reject(new Error('Host queue full; explicit backpressure'));
    const admitted = generation; queued++;
    const result = work.then(() => { if (closed || admitted !== generation) throw new Error('Operation invalidated by Stop'); return task(); }).finally(() => { queued--; });
    work = result.catch(() => {}); return result;
  };
  async function stopDemo() { demo = false; policies = []; for (const port of demoPorts) await port.close(); demoPorts = []; }
  async function setDemo(enabled: boolean) {
    const admitted = generation;
    await stopDemo();
    if (!enabled) return;
    if (admitted !== generation) throw new Error('Demo invalidated by Stop');
    // Explicit admin action takes ownership back from all current controllers.
    world.stop(); leases.clear(); manuals.clear();
    demoPorts = world.robotIds.map(id => world.claim(id, 'scripted demo'));
    policies = demoPorts.map((port, index) => new DemoPolicy(port, { index, swarm: world.scenario.id === 'swarm' }));
    demo = true;
  }
  async function advance(ticks: number) {
    for (let n = 0; n < ticks; n++) {
      for (const policy of policies) await policy.tick();
      await world.advance();
    }
  }
  const server = createServer();
  let vite: import('vite').ViteDevServer | undefined;
  if (options.web !== false) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({ root: import.meta.dirname, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  }
  let origin = '';
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    const api = url.pathname.startsWith('/api/');
    if (!api) { if (vite) vite.middlewares(request, response); else respond(response, 404, { error: 'No viewer' }); return; }
    void (async () => {
      const host = request.headers.host;
      const port = (server.address() as { port: number }).port;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { respond(response, 403, { error: 'Invalid local host' }); return; }
      if (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)) { respond(response, 403, { error: 'Cross-origin access denied' }); return; }
      if (request.headers['sec-fetch-site'] === 'cross-site') { respond(response, 403, { error: 'Cross-site access denied' }); return; }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        if (!equal(String(request.headers['x-world-viewer'] ?? ''), viewerToken)) { respond(response, 403, { error: 'Open the viewer URL printed by npm run dev; a viewer bootstrap token is required' }); return; }
        respond(response, 200, { adminToken }); return;
      }
      const match = /^\/api\/robots\/([^/]+)\/(describe|observe|command|acknowledge|send|stop|close)$/.exec(url.pathname);
      if (match) {
        if (request.method !== 'POST') { respond(response, 405, { error: 'POST required' }); return; }
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const lease = leases.get(token);
        if (!lease || lease.robotId !== decodeURIComponent(match[1]!)) { respond(response, 403, { error: 'Invalid robot-scoped lease' }); return; }
        const body = await jsonBody(request);
        const exchange = ++protocolSequence;
        const trace = (direction: 'rx' | 'tx', payload: unknown) => journal.record({ simMs: world.simMs, robotId: lease.robotId, channel: 'protocol', kind: `http.${direction}`, data: { exchange, transport: 'HTTP/JSON', operation: match[2], payload } });
        trace('rx', body);
        // Revocation never waits behind a physics step, model call or queued command.
        if (match[2] === 'stop' || match[2] === 'close') {
          await lease.port.stop();
          if (match[2] === 'close') leases.delete(token);
          trace('tx', { ok: true });
          respond(response, 200, { ok: true }); return;
        }
        const result = await serial(async () => {
          switch (match[2]) {
            case 'describe': return lease.port.describe();
            case 'observe': return lease.port.observe();
            case 'command': return lease.port.command(body as Command);
            case 'acknowledge': await lease.port.acknowledge(body.throughEvent, body.packetIds); return { ok: true };
            case 'send': return lease.port.send(body as { id: string; to: string; data: string; ttlMs?: number });
          }
        });
        trace('tx', result);
        respond(response, 200, result); return;
      }
      const supplied = String(request.headers['x-world-admin'] ?? request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!equal(supplied, adminToken)) { respond(response, 403, { error: 'Admin token required' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/scenarios') { respond(response, 200, Object.entries(scenarios).map(([id, value]) => ({ id, label: value.label, description: value.description }))); return; }
      if (request.method === 'GET' && url.pathname === '/api/inspect') {
        const after = Number(url.searchParams.get('after') ?? 0);
        respond(response, 200, await serial(async () => ({ ...world.inspect(Number.isFinite(after) ? after : 0), paused, demo, network: world.radio.stats() }))); return;
      }
      if (request.method !== 'POST') { respond(response, 405, { error: 'POST required' }); return; }
      const body = await jsonBody(request);
      if (url.pathname === '/api/stop') {
        generation++; world.stop(); leases.clear(); manuals.clear();
        await stopDemo(); respond(response, 200, { ok: true }); return;
      }
      const result = await serial(async () => {
        switch (url.pathname) {
          case '/api/claim': {
            const admitted = generation;
            if (!Array.isArray(body.robotIds) || !body.robotIds.length || body.robotIds.length > 128 || new Set(body.robotIds).size !== body.robotIds.length) throw new Error('robotIds must be a nonempty unique list');
            if (demo) await stopDemo();
            if (admitted !== generation) throw new Error('Claim invalidated by Stop');
            const claimed: { robotId: string; token: string }[] = [];
            try {
              for (const id of body.robotIds) {
                const port = world.claim(id, body.owner ?? 'external controller'), token = secret();
                leases.set(token, { robotId: id, port }); claimed.push({ robotId: id, token });
              }
              return { ports: claimed };
            } catch (error) { for (const entry of claimed) { await leases.get(entry.token)!.port.close(); leases.delete(entry.token); } throw error; }
          }
          case '/api/reset': {
            const admitted = generation;
            // Create first: an invalid configuration does not destroy the current run.
            const next = await World.create(scenario(body.scenario ?? world.scenario.id), defaultRegistry(), body.physics ?? world.physics.id, journal);
            if (admitted !== generation) { next.close(); throw new Error('Reset invalidated by Stop'); }
            await stopDemo();
            if (admitted !== generation) { next.close(); throw new Error('Reset invalidated by Stop'); }
            world.close(); world = next; leases.clear(); manuals.clear(); paused = false;
            return { ok: true, epoch: world.epoch };
          }
          case '/api/pause': if (typeof body.paused !== 'boolean') throw new Error('paused must be boolean'); paused = body.paused; return { ok: true };
          case '/api/step': {
            const ticks = body.ticks ?? 1; if (!Number.isInteger(ticks) || ticks < 1 || ticks > 100) throw new Error('step expects 1–100 ticks');
            paused = true; await advance(ticks); return { ok: true, simMs: world.simMs };
          }
          case '/api/demo': if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean'); await setDemo(body.enabled); return { ok: true };
          case '/api/command': {
            const admitted = generation;
            if (demo) await stopDemo();
            if (admitted !== generation) throw new Error('Command invalidated by Stop');
            let port = manuals.get(body.robotId);
            if (!port) { port = world.claim(body.robotId, 'cockpit manual'); manuals.set(body.robotId, port); }
            return port.command({ id: secret(), action: body.action, args: body.args, validForMs: body.validForMs ?? 5000 });
          }
          case '/api/log': {
            const channels: Diagnostic['channel'][] = ['control', 'protocol', 'sensor', 'network', 'world'];
            if (!channels.includes(body.channel) || typeof body.kind !== 'string') throw new Error('Invalid diagnostic');
            journal.record({ simMs: world.simMs, robotId: body.robotId, channel: body.channel, kind: body.kind.slice(0, 100), data: body.data ?? null }); return { ok: true };
          }
          default: throw new Error('Unknown endpoint');
        }
      });
      respond(response, 200, result);
    })().catch(error => { if (!response.headersSent) respond(response, 400, { error: String(error instanceof Error ? error.message : error) }); else response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8870, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const viewerUrl = `${origin}/#viewer=${viewerToken}`;
  if (options.saveSession !== false) { await mkdir('.runtime', { recursive: true }); await writeFile('.runtime/session.json', JSON.stringify({ url: origin, viewerUrl, adminToken }, null, 2), { mode: 0o600 }); }
  if (options.demo) await setDemo(true);
  let pending = false;
  const timer = options.realtime === false ? undefined : setInterval(() => {
    if (pending || paused || closed) return;
    pending = true;
    void serial(() => advance(1)).catch(error => { paused = true; world.stop(); journal.record({ simMs: world.simMs, channel: 'world', kind: 'fault', data: { error: String(error) } }); }).finally(() => { pending = false; });
  }, world.scenario.dt * 1000);
  return { url: origin, viewerUrl, adminToken, get world() { return world; },
    close: async () => { if (closed) return; closed = true; generation++; world.stop(); if (timer) clearInterval(timer); await work; await stopDemo(); world.close(); await vite?.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = await createHost({ scenario: process.env.WORLD_SCENARIO ?? 'mixed', port: Number(process.env.PORT ?? 8870), demo: true });
  console.log(`Robots World: ${host.viewerUrl}\nScripted demo only. Native agents and external transports require explicit attachment.`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void host.close().then(() => process.exit(0)));
}
