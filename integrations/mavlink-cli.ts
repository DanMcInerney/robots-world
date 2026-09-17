import { readFile } from 'node:fs/promises';
import { HttpRobotPort } from '../src/client.ts';
import { MavlinkAdapter } from '../src/protocols/mavlink.ts';
import { MavlinkUdpEndpoint } from '../src/protocols/udp.ts';
import type { Diagnostic, Recorder } from '../src/contracts.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run mavlink -- --robots drone-1[,drone-2] --listen 14550 --peer 14551\nExplicit local UDP bridge. Vehicles get system IDs 1..N, component ID1. No live hardware or autopilot.');
} else {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --name value pairs');
    options.set(args[i]!.slice(2), args[i + 1]!);
  }
  const robots = options.get('robots')?.split(',');
  const listen = Number(options.get('listen')), peer = Number(options.get('peer'));
  if (!robots?.length || ![listen, peer].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) throw new Error('Required --robots, --listen and --peer; use --help');
  const session = JSON.parse(await readFile('.runtime/session.json', 'utf8')) as { url: string; adminToken: string };
  async function admin(path: string, body: unknown) {
    const response = await fetch(`${session.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${session.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data;
  }
  const claimed = await admin('/api/claim', { robotIds: robots, owner: 'MAVLink UDP' }) as { ports: { robotId: string; token: string }[] };
  const ports = claimed.ports.map(port => new HttpRobotPort({ url: session.url, ...port }));
  const logs: Omit<Diagnostic, 'id' | 'wallMs'>[] = [];
  let dropped = 0;
  const record: Recorder = event => { if (logs.length < 128) logs.push(event); else dropped++; };
  let endpoint: MavlinkUdpEndpoint | undefined;
  let adapter: MavlinkAdapter | undefined;
  let closed = false, pending = false;
  let timer: NodeJS.Timeout | undefined;
  async function close() {
    if (closed) return; closed = true; if (timer) clearInterval(timer);
    await Promise.allSettled(ports.map(port => port.stop()));
    adapter?.close(); await endpoint?.close(); await Promise.allSettled(ports.map(port => port.close()));
  }
  try {
    for (const port of ports) { const description = await port.describe(); if (description.model !== 'drone') throw new Error(`MAVLink drone facade requires model drone; ${port.robotId} is ${description.model}`); }
    adapter = new MavlinkAdapter({ ports: ports.map((port, i) => ({ port, systemId: i + 1 })), record });
    endpoint = await MavlinkUdpEndpoint.open({ adapter, port: listen, peer: { address: '127.0.0.1', port: peer }, onError: error => record({ simMs: 0, channel: 'protocol', kind: 'udp.error', data: { error: String(error) } }) });
    timer = setInterval(() => {
      if (pending || closed) return; pending = true;
      void (async () => {
        await endpoint!.telemetry();
        for (const event of logs.splice(0, 32)) await admin('/api/log', event);
        if (dropped) { await admin('/api/log', { channel: 'protocol', kind: 'diagnostic.backpressure', data: { dropped } }); dropped = 0; }
      })().catch(error => { console.error(String(error)); void close(); }).finally(() => { pending = false; });
    }, 100);
    console.log(`MAVLink UDP127.0.0.1:${listen} to127.0.0.1:${peer}; ${robots.map((id, i) => `${id}=system${i + 1}/component1`).join(', ')}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close());
  } catch (error) { await close(); throw error; }
}
