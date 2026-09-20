import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, choice, type Request, type Response } from '../jev-strategies/strategies.ts';
import { createMeter, digest, durable, freezeStage, ledger, readCompleted, summarizeUsage, validateRequest, verifyFrozenStage } from '../jev-spatial-text/transport.ts';
import { generateEvidenceCases, scoreEvidence } from './evidence.ts';
import { generateIdentityCases, scoreIdentity } from './identity.ts';
import { generateLifecycleCases, scoreLifecycle, runFreshnessExperiment } from './lifecycle.ts';
import { generateMenuCases, scoreMenu, menuFrame } from './menu.ts';
import type { Probe, Answers, Score, Split, Judge } from './types.ts';

export const ROOT = resolve('.runtime/experiments/jev-top-five-v1');
export const LIMITS = { requests: 400, inputTokens: 2_000_000, requestsPerSecond: 2 };
export const PLAN = 'docs/jev-top-five-experiments.md';
export const STAGE = 'fixed';
export type ResultRow = { id: string; technique: string; split: Split; unit: string; arm: string; replicate: number;
  status: 'completed' | 'missing' | 'error'; requestIds: string[]; initialAnswers?: Answers; finalAnswers?: Answers;
  selectedEvidence?: string; score?: Score; latencyMs?: number; apiLatencyMs?: number; inputTokens?: number; frame?: string; expected?: unknown; meta?: any };

export function allCases(): Probe[] {
  const all = [...generateEvidenceCases(), ...generateIdentityCases(), ...generateMenuCases(), ...generateLifecycleCases()];
  assert.equal(all.length, 320); assert.equal(new Set(all.map(c => c.id)).size, all.length);
  for (const c of all) {
    assert(/^[a-zA-Z0-9_.-]+$/.test(c.id)); validateRequest(c.request);
    for (const [q, keys] of Object.entries(c.expected)) { assert(c.request.questions[q]); assert(keys.length); for (const key of keys) assert(key in c.request.questions[q]!.criteria); }
    if (c.meta.followups) {
      assert.equal(c.technique, 'T1'); const q = c.meta.followupQuestion;
      assert.deepEqual(Object.keys(c.meta.followups).sort(), Object.keys(c.request.questions[q].criteria).sort());
      for (const branch of Object.values(c.meta.followups) as any[]) {
        validateRequest(branch.request);
        for (const [q, keys] of Object.entries(branch.expected) as [string, string[]][]) for (const key of keys) assert(key in branch.request.questions[q].criteria);
      }
    }
  }
  const calls = all.reduce((n, c) => n + (c.meta.followups ? 2 : 1), 0); assert.equal(calls, 352);
  return all.sort((a, b) => a.split.localeCompare(b.split) || a.replicate - b.replicate || digest(a.id).localeCompare(digest(b.id)));
}
export const answersOf = (request: Request, response: Response): Answers => Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(response, id, Object.keys(q.criteria))]));
export function scoreProbe(c: Probe, initial: Answers, final?: Answers): Score {
  if (c.technique === 'T1') return scoreEvidence(c, initial, final);
  if (c.technique === 'T2') return scoreIdentity(c, initial);
  if (c.technique === 'T4') return scoreMenu(c, initial);
  if (c.technique === 'T5') return scoreLifecycle(c, initial);
  throw new Error('T3 is deterministic and has no model call');
}
export async function executeProbe(c: Probe, judge: Judge) {
  const initialResponse = await judge(c.request, c.id), initialAnswers = answersOf(c.request, initialResponse);
  const requestIds = [c.id]; let finalAnswers: Answers | undefined, selectedEvidence: string | undefined;
  if (c.meta.followups) {
    selectedEvidence = initialAnswers[c.meta.followupQuestion]!;
    const branch = c.meta.followups[selectedEvidence]; assert(branch, 'Unlisted evidence selection');
    const id = `${c.id}--followup`; requestIds.push(id);
    finalAnswers = answersOf(branch.request, await judge(branch.request, id));
  }
  return { requestIds, initialAnswers, finalAnswers, selectedEvidence, score: scoreProbe(c, initialAnswers, finalAnswers) };
}
export function usage(root = ROOT) {
  const { reportedCostUsd: _unverifiedPriceEstimate, ...measured } = summarizeUsage(root);
  return measured;
}
async function exactFile(path: string, bytes: string | Uint8Array) {
  if (existsSync(path)) assert.equal(digest(await readFile(path)), digest(bytes), `Immutable evidence changed: ${path}`);
  else await writeFile(path, bytes, { flag: 'wx' });
}
export async function freeze(all = allCases()) {
  await mkdir(resolve(ROOT, 'frames'), { recursive: true });
  await exactFile(resolve(ROOT, 'cases.json'), JSON.stringify(all) + '\n');
  await exactFile(resolve(ROOT, 'freshness.json'), JSON.stringify(runFreshnessExperiment(), null, 2) + '\n');
  const frames = [];
  for (const split of ['development', 'confirmation'] as const) for (let i = 0; i < 8; i++) {
    const bytes = menuFrame(split, i).png, path = `frames/${split}-u${i}.png`;
    await exactFile(resolve(ROOT, path), bytes); frames.push({ path, sha256: digest(bytes) });
  }
  const tests = (await readdir('test')).filter(p => p.startsWith('jev-top-five-') && p.endsWith('.test.ts')).sort();
  const testEntries = await Promise.all(tests.map(async name => ({ path: `test/${name}`, sha256: digest(await readFile(`test/${name}`)) })));
  const plan = await readFile(PLAN); await exactFile(resolve(ROOT, 'frozen-plan.md'), plan);
  return freezeStage(STAGE, { casesSha256: digest(JSON.stringify(all) + '\n'), planSha256: digest(plan), limits: LIMITS,
    frames, tests: testEntries, freshnessSha256: digest(await readFile(resolve(ROOT, 'freshness.json'))), plannedProbes: 320, maximumCalls: 352,
    selection: 'Every treatment and gate predeclared. No development-driven arm selection or tuning. Seal all development responses before confirmation.' }, ROOT);
}
export async function verify(all = allCases()) {
  const frozen = await verifyFrozenStage(STAGE, ROOT);
  assert.equal(frozen.model, MODEL); assert.equal(frozen.manifest.casesSha256, digest(JSON.stringify(all) + '\n'));
  assert.equal(frozen.manifest.casesSha256, digest(await readFile(resolve(ROOT, 'cases.json'))));
  assert.equal(frozen.manifest.planSha256, digest(await readFile(PLAN)));
  assert.equal(frozen.manifest.planSha256, digest(await readFile(resolve(ROOT, 'frozen-plan.md'))));
  assert.equal(frozen.manifest.freshnessSha256, digest(await readFile(resolve(ROOT, 'freshness.json'))));
  for (const entry of [...frozen.entries, ...frozen.manifest.tests]) assert.equal(digest(await readFile(entry.path)), entry.sha256, `Live source changed after freeze: ${entry.path}`);
  for (const frame of frozen.manifest.frames) assert.equal(digest(await readFile(resolve(ROOT, frame.path))), frame.sha256);
  return frozen;
}
export async function readResults(all = allCases(), root = ROOT): Promise<ResultRow[]> {
  const rows = new Map(ledger(root).map(r => [r.id, r])); const results: ResultRow[] = [];
  for (const c of all) {
    const base = { id: c.id, technique: c.technique, split: c.split, unit: c.unit, arm: c.arm, replicate: c.replicate, requestIds: [c.id], frame: c.meta.frame };
    const first = rows.get(c.id);
    if (first?.status !== 'completed') { results.push({ ...base, status: first ? 'error' : 'missing' }); continue; }
    const requestRows: any[] = [];
    try {
      const result = await executeProbe(c, async (request, id) => {
        const row = rows.get(id); assert.equal(row?.status, 'completed', `Incomplete request ${id}`);
        requestRows.push(row); return readCompleted(request, id, row, root);
      });
      results.push({ ...base, status: 'completed', ...result,
        latencyMs: requestRows.at(-1)!.dispatchedAtMs + requestRows.at(-1)!.latencyMs - requestRows[0].dispatchedAtMs,
        apiLatencyMs: requestRows.reduce((n, r) => n + r.latencyMs, 0), inputTokens: requestRows.reduce((n, r) => n + (r.inputTokens ?? 0), 0), expected: c.expected,
        meta: { ...c.meta, followups: undefined } });
    } catch (error) { results.push({ ...base, status: 'error', meta: { error: String(error) } }); }
  }
  return results;
}
export async function sealDevelopment(all = allCases()) {
  const frozen = await verify(all), results = await readResults(all);
  assert(results.filter(r => r.split === 'development').every(r => r.status === 'completed'), 'Every planned development probe must finish');
  assert(!ledger(ROOT).some(r => r.id.includes('-confirmation-')), 'Seal must precede any confirmation call');
  const bytes = await readFile(resolve(ROOT, 'requests.jsonl'));
  await exactFile(resolve(ROOT, 'development-ledger.jsonl'), bytes);
  await exactFile(resolve(ROOT, 'development-seal.json'), JSON.stringify({ casesSha256: frozen.manifest.casesSha256, ledgerSha256: digest(bytes), bytes: bytes.length, completedProbes: 160, policy: 'No prompts, gates or arms changed using development outcomes.' }) + '\n');
}
export async function verifyDevelopmentSeal() {
  const seal = JSON.parse(await readFile(resolve(ROOT, 'development-seal.json'), 'utf8'));
  const prior = await readFile(resolve(ROOT, 'development-ledger.jsonl')), current = await readFile(resolve(ROOT, 'requests.jsonl'));
  assert.equal(digest(prior), seal.ledgerSha256); assert.equal(prior.length, seal.bytes);
  assert.equal(digest(current.subarray(0, prior.length)), seal.ledgerSha256, 'Development ledger prefix changed');
}
async function main() {
  const command = process.argv[2] ?? 'qualify', all = allCases();
  if (command === 'qualify') {
    const byTechnique = Object.fromEntries(['T1', 'T2', 'T4', 'T5'].map(t => [t, all.filter(c => c.technique === t).length]));
    console.log(JSON.stringify({ probes: all.length, byTechnique, maxRequestBytes: Math.max(...all.map(c => Buffer.byteLength(JSON.stringify(c.request)))), freshness: runFreshnessExperiment() })); return;
  }
  if (command === 'freeze') { const frozen = await freeze(all); console.log(JSON.stringify({ sourceSha256: frozen.sourceSha256, manifest: frozen.manifest })); return; }
  if (command === 'analyze') {
    await verify(all); const { summarize } = await import('./analyze.ts');
    const results = await readResults(all), summary = summarize(results, runFreshnessExperiment());
    await writeFile(resolve(ROOT, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    await writeFile(resolve(ROOT, 'summary.json'), JSON.stringify({ ...summary, usage: usage() }, null, 2) + '\n');
    console.log(JSON.stringify({ ...summary, usage: usage() })); return;
  }
  if (command === 'seal') { await sealDevelopment(all); console.log('Development responses sealed without treatment changes.'); return; }
  assert(command === 'development' || command === 'confirmation'); assert(process.argv.includes('--real'), 'Explicit --real required');
  const frozen = await verify(all);
  const gate = JSON.parse(await readFile(resolve(ROOT, 'pre-inference-status.json'), 'utf8'));
  assert(gate.ready === true && gate.sourceSha256 === frozen.sourceSha256 && gate.casesSha256 === frozen.manifest.casesSha256, 'Review/check gate must identify this exact frozen candidate');
  if (command === 'confirmation') await verifyDevelopmentSeal();
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? ''; assert(key, 'Configured Jev key required');
  const meter = createMeter({ root: ROOT, key, limits: LIMITS }); let done = 0;
  try {
    for (const c of all.filter(c => c.split === command)) {
      await executeProbe(c, (request, id) => meter.judge(request, id));
      if (++done % 16 === 0) console.log(JSON.stringify({ phase: command, probesCompleted: done, usage: usage() }));
    }
  } finally { meter.close(); }
  console.log(JSON.stringify({ phase: command, probesCompleted: done, usage: usage() }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
