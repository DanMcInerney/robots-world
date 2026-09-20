import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BENCH_ARMS, BENCH_PATTERNS, runBench, type BenchSummary, type BenchResponse } from './bench.ts';
import { ROOT, createMeter, freezeStage, summarizeUsage, digest, durable, ledger, readCompleted, verifyFrozenStage } from './transport.ts';

export const GENERATION = process.argv.includes('--generation=1') ? 1 : 2;
export const BENCH_STAGE = GENERATION === 1 ? 'yaw-bench' : 'yaw-bench-v2';
export const BENCH_DIRECTORY = GENERATION === 1 ? 'bench' : 'bench-v2';
export const PLAN = BENCH_PATTERNS.flatMap((pattern, p) => [0, 1].flatMap(mirror => {
  const arms = [...BENCH_ARMS], offset = (p + mirror) % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)].map(arm => ({
    id: `${GENERATION === 1 ? 'yaw' : 'yaw-v2'}-${p}-${mirror}-${arm}`, arm, seed: 6100 + p * 10 + mirror, pattern, seconds: 20,
  }));
}));
async function evidenceEntries(directory: string) {
  const files = (await readdir(directory, { recursive: true })).filter(f => /\.(json|jsonl|png)$/.test(f) && f !== 'finalization.json').sort();
  return Promise.all(files.map(async path => ({ path, sha256: digest(await readFile(resolve(directory, path))) })));
}
async function verifyBench(trial: typeof PLAN[number], frozen: any) {
  const directory = resolve(ROOT, BENCH_DIRECTORY, trial.id), final = JSON.parse(await readFile(resolve(directory, 'finalization.json'), 'utf8'));
  assert.equal(final.status, 'completed', 'Bench not validly finalized'); assert.deepEqual(final.trial, trial);
  assert.equal(final.sourceSha256, frozen.sourceSha256);
  assert.deepEqual(await evidenceEntries(directory), final.files, 'Bench evidence changed');
  const calls = new Map(ledger().map(r => [r.id, r]));
  for (const id of final.requestIds) {
    const request = JSON.parse(await readFile(resolve(ROOT, 'requests', id + '.json'), 'utf8'));
    await readCompleted(request, id, calls.get(id));
  }
  return JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8')) as BenchSummary;
}
export async function benchResults() {
  const frozen = await verifyFrozenStage(BENCH_STAGE); assert.deepEqual(frozen.manifest.plan, PLAN);
  const results: BenchSummary[] = [];
  const incomplete: any[] = [];
  for (const trial of PLAN) {
    const file = resolve(ROOT, BENCH_DIRECTORY, trial.id, 'summary.json');
    if (existsSync(file) && existsSync(resolve(ROOT, BENCH_DIRECTORY, trial.id, 'finalization.json'))) {
      const final = JSON.parse(await readFile(resolve(ROOT, BENCH_DIRECTORY, trial.id, 'finalization.json'), 'utf8'));
      if (final.status === 'completed') results.push(await verifyBench(trial, frozen));
      else incomplete.push({ id: trial.id, status: final.status, errors: final.errors });
    } else incomplete.push({ id: trial.id, status: existsSync(file) ? 'unfinalized' : 'not-completed' });
  }
  const valid = results.filter(r => r.status === 'completed');
  const byArm = BENCH_ARMS.map(arm => {
    const rows = valid.filter(r => r.arm === arm);
    const sum = (f: (r: BenchSummary) => number) => rows.reduce((n, r) => n + f(r), 0);
    return { arm, completed: rows.length, framedSeconds: sum(r => r.score.framedMs) / 1000,
      visibleSeconds: sum(r => r.score.visibleMs) / 1000, passiveFramedSeconds: sum(r => r.passiveFixedObserver.framedMs) / 1000,
      deltaFramedSeconds: sum(r => r.deltaFramedMs) / 1000,
      calls: sum(r => r.calls), scorableForecasts: sum(r => r.forecast.scorable), committedForecasts: sum(r => r.forecast.committed),
      correctForecasts: sum(r => r.forecast.correct),
      blocks: rows.map(r => ({ seed: r.seed, pattern: r.pattern, framedFraction: r.score.framedFraction })) };
  });
  const comparisons = BENCH_ARMS.slice(1).map(arm => {
    const differences = valid.filter(r => r.arm === arm).flatMap(r => {
      const baseline = valid.find(b => b.arm === 'receipt' && b.seed === r.seed && b.pattern === r.pattern);
      return baseline ? [{ seed: r.seed, pattern: r.pattern, deltaFramedSeconds: (r.score.framedMs - baseline.score.framedMs) / 1000 }] : [];
    });
    return { arm, baseline: 'receipt', pairedBlocks: differences.length, wins: differences.filter(d => d.deltaFramedSeconds > 0).length,
      losses: differences.filter(d => d.deltaFramedSeconds < 0).length, ties: differences.filter(d => d.deltaFramedSeconds === 0).length, differences };
  });
  const result = { generation: GENERATION, comparisonQualified: GENERATION === 2,
    exclusionReason: GENERATION === 1 ? 'Retained timing/task-specification pilot; excluded by bench-timing-amendment.md' : null,
    plan: PLAN, results, incomplete, byArm, comparisons, usage: summarizeUsage(),
    scope: '40 planned 20-second yaw components, 8 paired scene/seed blocks. No full flights or mission pass score. Two mirror seeds per pattern are a small exploratory paired test, not independent scene families.',
    exposure: 'All arms keep the exact mission. Receipt vs richer history changes information. Linked vs chronological retains the same episode facts. Prediction/reflection adds questions and payload; latency/token changes are part of the measured package.' };
  await writeFile(resolve(ROOT, `${BENCH_DIRECTORY}-results.json`), JSON.stringify(result, null, 2));
  return { completed: valid.length, invalid: results.length - valid.length, byArm, comparisons, usage: result.usage };
}
async function main() {
  if (process.argv.includes('analyze')) { console.log(JSON.stringify(await benchResults())); return; }
  assert(process.argv.includes('--real'), 'Explicit --real required');
  assert.equal(GENERATION, 2, 'Generation 1 is retained for audit only; never resume or redispatch it');
  const frozen = await freezeStage(BENCH_STAGE, { plan: PLAN, amendment: 'bench-timing-amendment.md',
    analysis: 'Exploratory paired 20s wall-paced yaw centering with common explicit +/-0.3 normalized center-band goal, acquisition-weighted coverage and secondary passive zero-yaw observer. Task/timing correction after excluded V1; no full mission flights.' });
  const meter = createMeter({ key: process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '' });
  const outstanding = new Set<Promise<unknown>>();
  const abort = new AbortController();
  const stop = () => abort.abort('Operator interrupted the benchmark');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const trial of PLAN) {
      abort.signal.throwIfAborted();
      const directory = resolve(ROOT, BENCH_DIRECTORY, trial.id);
      if (existsSync(directory)) {
        await verifyBench(trial, frozen);
        continue;
      }
      console.log(JSON.stringify({ event: 'bench-start', ...trial }));
      const errors: string[] = [], requestIds: string[] = [];
      const summary = await runBench({ ...trial, outputDir: resolve(ROOT, BENCH_DIRECTORY), signal: abort.signal, judge: (request, id) => {
        requestIds.push(id);
        const promise = meter.judge(request, id, abort.signal);
        outstanding.add(promise); void promise.then(() => outstanding.delete(promise), error => { errors.push(String(error)); outstanding.delete(promise); });
        return promise as Promise<BenchResponse>;
      } });
      // An answer already in flight at the stop boundary may be logged, never applied.
      await Promise.allSettled([...outstanding]);
      durable(resolve(directory, 'finalization.json'), { status: errors.length || summary.status !== 'completed' ? 'infrastructure-invalid' : 'completed',
        trial, sourceSha256: frozen.sourceSha256, errors, requestIds, files: await evidenceEntries(directory) }, true);
      console.log(JSON.stringify({ event: 'bench-finish', ...summary }));
      assert.equal(errors.length, 0, 'Late request failed; original bench preserved, finalization invalid, campaign stopped');
      assert.equal(summary.status, 'completed', 'Stop on invalid bench; preserve evidence');
    }
  } finally { await Promise.allSettled([...outstanding]); meter.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  console.log(JSON.stringify(await benchResults()));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
