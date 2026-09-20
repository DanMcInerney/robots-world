import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { choice, type Request, type Response } from '../jev-strategies/strategies.ts';
import { createMeter, digest, freezeStage, verifyFrozenStage, ledger, readCompleted, summarizeUsage, validateRequest } from '../jev-spatial-text/transport.ts';
import type { Probe, Answers } from '../jev-top-five/types.ts';
import { generateCases, scoreCase } from './fixtures.ts';
import { readLive, runLive } from './live.ts';
import { ROOT, LIMITS, STAGE, PLAN_PATH, LIVE_PLAN, SCOPE } from './protocol.ts';
import { summarize } from './summary.ts';
import { readRecordedCall } from './evidence.ts';

const HTML = 'experiments/jev-round1/replay.html';
export function cases() {
  const all = generateCases(); assert.equal(all.length, 144); assert.equal(new Set(all.map(c => c.id)).size, 144);
  assert.equal(all.reduce((n, c) => n + (c.meta.followups ? 2 : 1), 0), 240);
  for (const c of all) {
    validateRequest(c.request);
    for (const [q, keys] of Object.entries(c.expected)) for (const key of keys) assert(key in c.request.questions[q]!.criteria);
    if (c.meta.followups) {
      assert.deepEqual(Object.keys(c.meta.followups).sort(), Object.keys(c.request.questions[c.meta.followupQuestion]!.criteria).sort());
      for (const branch of Object.values(c.meta.followups) as any[]) validateRequest(branch.request);
    }
  }
  return all.sort((a, b) => a.split.localeCompare(b.split) || a.replicate - b.replicate || digest(a.id).localeCompare(digest(b.id)));
}
const answers = (request: Request, response: Response): Answers => Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(response, id, Object.keys(q.criteria))]));
export async function execute(c: Probe, send: (request: Request, id: string) => Promise<Response>) {
  const initialResponse = await send(c.request, c.id), initialAnswers = answers(c.request, initialResponse);
  let followupRequest: Request | undefined, followupResponse: Response | undefined, finalAnswers: Answers | undefined;
  const requestIds = [c.id];
  if (c.meta.followups) {
    const branch = c.meta.followups[initialAnswers[c.meta.followupQuestion]!]; assert(branch);
    followupRequest = branch.request; requestIds.push(c.id + '--followup');
    followupResponse = await send(followupRequest!, requestIds[1]!); finalAnswers = answers(followupRequest!, followupResponse);
  }
  return { requestIds, initialRequest: c.request, initialResponse, initialAnswers, followupRequest, followupResponse, finalAnswers, score: scoreCase(c, initialAnswers, finalAnswers) };
}
async function exact(path: string, bytes: string | Uint8Array) {
  if (existsSync(path)) assert.equal(digest(await readFile(path)), digest(bytes), `Immutable artifact differs: ${path}`);
  else await writeFile(path, bytes, { flag: 'wx' });
}
export async function freeze() {
  await mkdir(ROOT, { recursive: true }); const all = cases();
  await exact(resolve(ROOT, 'cases.json'), JSON.stringify(all) + '\n');
  const plan = await readFile(PLAN_PATH); await exact(resolve(ROOT, 'frozen-plan.md'), plan);
  const html = await readFile(HTML); await exact(resolve(ROOT, 'frozen-replay.html'), html);
  const paths = (await readdir('test')).filter(p => p.startsWith('jev-round1-') && p.endsWith('.test.ts')).sort();
  const tests = await Promise.all(paths.map(async name => ({ path: `test/${name}`, sha256: digest(await readFile(`test/${name}`)) })));
  return freezeStage(STAGE, { casesSha256: digest(JSON.stringify(all) + '\n'), planSha256: digest(plan), replaySha256: digest(html), tests,
    livePlan: LIVE_PLAN, limits: LIMITS, scope: SCOPE, primary: 'validity', fixedProbes: 144, fixedCalls: 240 }, ROOT);
}
export async function verify() {
  const frozen = await verifyFrozenStage(STAGE, ROOT);
  assert.equal(digest(JSON.stringify(cases()) + '\n'), frozen.manifest.casesSha256);
  assert.equal(digest(await readFile(resolve(ROOT, 'cases.json'))), frozen.manifest.casesSha256);
  assert.equal(digest(await readFile(PLAN_PATH)), frozen.manifest.planSha256);
  assert.equal(digest(await readFile(resolve(ROOT, 'frozen-plan.md'))), frozen.manifest.planSha256);
  assert.equal(digest(await readFile(HTML)), frozen.manifest.replaySha256);
  assert.equal(digest(await readFile(resolve(ROOT, 'frozen-replay.html'))), frozen.manifest.replaySha256);
  for (const entry of [...frozen.entries, ...frozen.manifest.tests]) assert.equal(digest(await readFile(entry.path)), entry.sha256, `Source changed after freeze: ${entry.path}`);
  assert.deepEqual(frozen.manifest.livePlan, LIVE_PLAN); return frozen;
}
export async function readFixed(root = ROOT) {
  const rows = new Map(ledger(root).map(r => [r.id, r])); const results: any[] = [];
  for (const c of cases()) {
    const base = { id: c.id, split: c.split, arm: c.arm, unit: c.unit, replicate: c.replicate, task: c.meta.family, expected: c.expected };
    if (!rows.has(c.id)) { results.push({ ...base, status: 'missing' }); continue; }
    const calls: any[] = [], available: any = { callStatuses: [] };
    try {
      const result = await execute(c, async (request, id) => {
        const row = rows.get(id); calls.push(row); const call = await readRecordedCall(request, id, row, root);
        if (id === c.id) { available.initialRequest = request; available.initialResponse = call.response; }
        else { available.followupRequest = request; available.followupResponse = call.response; }
        available.callStatuses.push({ id, status: call.status, error: call.error });
        assert.equal(call.status, 'completed', call.error ?? 'Incomplete call'); return call.response!;
      });
      results.push({ ...base, status: 'completed', ...result, correct: result.score.correct, unsafe: result.score.unsafe, details: result.score.details,
        timing: { latencyMs: calls.at(-1).dispatchedAtMs + calls.at(-1).latencyMs - calls[0].dispatchedAtMs,
          apiLatencyMs: calls.reduce((n, r) => n + r.latencyMs, 0), inputTokens: calls.reduce((n, r) => n + (r.inputTokens ?? 0), 0) } });
    } catch (error) { results.push({ ...base, ...available, status: 'error', error: String(error) }); }
  }
  return results;
}
export function usage() {
  const { reportedCostUsd: _unverifiedPrice, ...measured } = summarizeUsage(ROOT); return measured;
}
async function seal() {
  await verify(); const rows = await readFixed();
  assert(rows.filter(r => r.split === 'development').every(r => r.status === 'completed'));
  assert(!ledger(ROOT).some(r => r.id.includes('confirmation') || r.id.startsWith('r1-live')));
  const bytes = await readFile(resolve(ROOT, 'requests.jsonl'));
  await exact(resolve(ROOT, 'development-ledger.jsonl'), bytes);
  await exact(resolve(ROOT, 'development-seal.json'), JSON.stringify({ sha256: digest(bytes), bytes: bytes.length, probes: 72, policy: 'All cases/arms/gates fixed before inference; no development-driven prompt changes.' }) + '\n');
}
export async function verifySeal() {
  const seal = JSON.parse(await readFile(resolve(ROOT, 'development-seal.json'), 'utf8'));
  const prior = await readFile(resolve(ROOT, 'development-ledger.jsonl')), now = await readFile(resolve(ROOT, 'requests.jsonl'));
  assert.equal(prior.length, seal.bytes); assert.equal(digest(prior), seal.sha256); assert.equal(digest(now.subarray(0, prior.length)), seal.sha256);
}
export async function analyze() {
  const frozen = await verify(), probes = await readFixed(), live = await readLive(frozen.sourceSha256);
  const summary = summarize(probes, live.episodes, live.pending, usage());
  await writeFile(resolve(ROOT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(resolve(ROOT, 'replay.json'), JSON.stringify({ scope: SCOPE, summary, probes, episodes: live.episodes,
    evidence: { sourceSha256: frozen.sourceSha256, casesSha256: frozen.manifest.casesSha256, pendingEpisodes: live.pending, originalRequestDirectory: 'requests/', originalResponseDirectory: 'responses/' } }) + '\n');
  await copyFile(resolve(ROOT, 'frozen-replay.html'), resolve(ROOT, 'index.html')); return summary;
}
async function main() {
  const command = process.argv[2] ?? 'qualify';
  if (command === 'qualify') { console.log(JSON.stringify({ fixedProbes: cases().length, livePlan: LIVE_PLAN, limits: LIMITS })); return; }
  if (command === 'freeze') { const f = await freeze(); console.log(JSON.stringify({ sourceSha256: f.sourceSha256, manifest: f.manifest })); return; }
  if (command === 'seal') { await seal(); console.log('Development sealed'); return; }
  if (command === 'analyze') { console.log(JSON.stringify(await analyze())); return; }
  assert(['development', 'confirmation', 'live'].includes(command)); assert(process.argv.includes('--real'));
  const frozen = await verify(), gate = JSON.parse(await readFile(resolve(ROOT, 'pre-inference-status.json'), 'utf8'));
  assert(gate.ready === true && gate.sourceSha256 === frozen.sourceSha256 && gate.casesSha256 === frozen.manifest.casesSha256);
  if (command !== 'development') await verifySeal();
  if (command === 'live') assert((await readFixed()).every(r => r.status === 'completed'));
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? ''; assert(key);
  const meter = createMeter({ root: ROOT, key, limits: LIMITS }), abort = new AbortController();
  const stop = () => abort.abort('Operator stopped round1'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'live') await runLive((request, id, signal) => meter.judge(request, id, signal), frozen.sourceSha256, abort.signal);
    else { let done = 0; for (const c of cases().filter(c => c.split === command)) {
      abort.signal.throwIfAborted(); await execute(c, (request, id) => meter.judge(request, id, abort.signal));
      if (++done % 12 === 0) console.log(JSON.stringify({ phase: command, completedProbes: done, usage: usage() }));
    } }
  } finally { meter.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  console.log(JSON.stringify({ phase: command, usage: usage() }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
