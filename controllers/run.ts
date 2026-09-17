import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpRobotPort } from '../src/client.ts';
import { runCodex } from './codex.ts';
import { runClaude } from './claude.ts';
import { runNervelet } from '../integrations/run-nervelet.ts';
import type { ControllerLog } from './tools.ts';

export async function runAgent(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    console.log('npm run agent -- --driver codex|claude|nervelet|jev --robots drone-1[,drone-2] --goal "Task" [--max-ms 120000]\nCodex: ROBOTS_CODEX_EXECUTABLE; exact gpt-5.6-luna / xhigh.\nClaude: --model or ROBOTS_CLAUDE_MODEL. Nervelet: ROBOTS_NERVELET_MODULE plus Codex executable.\nJev: TYPESAFE_API_KEY, JEV_MODEL, --waypoints JSON.\nAll inference is opt-in. Start npm run dev first; see controllers/README.md.');
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined) throw new Error('Arguments are --name value pairs.');
    options.set(args[i]!.slice(2), args[i + 1]!);
  }
  const driver = options.get('driver'), goal = options.get('goal'), robotIds = options.get('robots')?.split(',').filter(Boolean);
  if (!driver || !goal || !robotIds?.length || !['codex', 'claude', 'nervelet', 'jev'].includes(driver)) throw new Error('Usage: npm run agent -- --driver codex|claude|nervelet|jev --robots drone-1[,drone-2] --goal "Task" [--url URL] [--max-ms 120000]');
  const session = JSON.parse(await readFile(resolve('.runtime/session.json'), 'utf8')) as { url: string; adminToken: string };
  const url = options.get('url') ?? session.url;
  const maxWallMs = Number(options.get('max-ms') ?? 120000);
  if (!Number.isSafeInteger(maxWallMs) || maxWallMs < 100 || maxWallMs > 600000) throw new Error('--max-ms must be 100..600000.');
  const request = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, url), { method: 'POST', headers: { authorization: `Bearer ${session.adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const claim = await request('/api/claim', { robotIds, owner: `${driver}-${process.pid}` }) as { ports: { robotId: string; token: string }[] };
  const ports = claim.ports.map(port => new HttpRobotPort({ url, ...port }));
  const controller = new AbortController(); const abort = () => controller.abort(new Error('Operator interruption.'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let logTail = Promise.resolve(), pendingLogs = 0, droppedLogs = 0;
  const log: ControllerLog = (kind, data) => {
    if (pendingLogs >= 32) { droppedLogs++; return; }
    let text = JSON.stringify(data); if (Buffer.byteLength(text) > 12000) text = JSON.stringify({ truncated: true, preview: text.slice(0,2500) });
    pendingLogs++;
    logTail = logTail.then(async () => { await request('/api/log', { channel: 'control', kind, data: JSON.parse(text) }); }).catch(error => { console.error(`Diagnostic delivery failed: ${String(error)}`); }).finally(() => { pendingLogs--; });
  };
  const cwd = resolve('.runtime/controllers', `${driver}-${process.pid}`);
  try {
    await mkdir(cwd, { recursive: true });
    const common = { goal, cwd, maxWallMs, maxCalls: 128, log };
    if (driver === 'codex') await runCodex(ports, { ...common, command: process.env.ROBOTS_CODEX_EXECUTABLE }, controller.signal);
    else if (driver === 'claude') await runClaude(ports, { ...common, model: options.get('model') ?? process.env.ROBOTS_CLAUDE_MODEL ?? '', command: process.env.ROBOTS_CLAUDE_EXECUTABLE }, controller.signal);
    else if (driver === 'nervelet') {
      if (!process.env.ROBOTS_NERVELET_MODULE || !process.env.ROBOTS_CODEX_EXECUTABLE) throw new Error('Set ROBOTS_NERVELET_MODULE to dist/index.js and ROBOTS_CODEX_EXECUTABLE.');
      await runNervelet(ports, { ...common, module: process.env.ROBOTS_NERVELET_MODULE, command: process.env.ROBOTS_CODEX_EXECUTABLE }, controller.signal);
    } else {
      if (!process.env.TYPESAFE_API_KEY || !process.env.JEV_MODEL || !options.get('waypoints')) throw new Error('Set TYPESAFE_API_KEY, exact JEV_MODEL and --waypoints JSON for an opt-in Jev run.');
      const { createJevController } = await import('./jev.ts');
      const waypoints = JSON.parse(options.get('waypoints')!);
      if (!Array.isArray(waypoints) || !waypoints.length || waypoints.length > 32 || waypoints.some(point => !point || !['x', 'y', 'z'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key])))) throw new Error('--waypoints must contain 1..32 finite {x,y,z} points.');
      await createJevController({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.JEV_MODEL, waypoints, goal, maxDurationMs: maxWallMs, maxCalls: 30, record: log }).run(ports, controller.signal);
    }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    await Promise.allSettled(ports.map(async port => { try { await port.stop(); } finally { await port.close(); } }));
    if (droppedLogs) log('diagnostics_dropped', { count: droppedLogs }); await logTail;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runAgent();
