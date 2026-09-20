import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { choice } from '../jev-strategies/strategies.ts';
import { createMeter, digest, ledger, readCompleted, summarizeUsage, validateRequest } from '../jev-spatial-text/transport.ts';
import { callRecorded } from '../jev-round2/http.ts';
import { bestRangeOptions, gradeRangeProbe, rangeProbes, type RangeProbe } from './decisions.ts';

const ROOT = resolve('.runtime/experiments/jev-round3-v1');
const OUT = resolve(ROOT, 'decisions');
const LIMITS = { requests: 160, inputTokens: 750_000, requestsPerSecond: 2 };
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const exact = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

async function verifySource() {
  for (const file of ['analysis-seal.json', 'source-freeze.json', 'input-freeze.json', 'development-seal.json', 'prediction-seal.json']) {
    const frozen = await json(resolve(ROOT, file));
    for (const entry of frozen.files) assert.equal(digest(await readFile(entry.path)), entry.sha256, `Changed frozen bytes: ${entry.path}`);
  }
}

export async function buildCases() {
  await verifySource();
  const summary = await json(resolve(ROOT, 'summary.json'));
  const arm = summary.selectedForNextStage;
  assert(['bbox', 'mask'].includes(arm), 'Neither perception arm qualified; paid interpretation stage remains blocked');
  const replay = await json(resolve(ROOT, 'perception-handoff.json'));
  const cases: (RangeProbe & { referenceMedianRangeM: number | null })[] = [];
  for (const route of replay.routes) for (const frame of route.frames) if ([19, 49, 79].includes(frame.frameIndex)) {
    const sensor = frame.perception, measurement = sensor.arms[arm];
    const evidence = { id: frame.id, routeId: route.id, split: route.split, targetStatus: sensor.targetStatus,
      medianRangeM: measurement.estimateM, bearingDeg: sensor.bearingDeg,
      validFraction: measurement.validFraction, unknownReason: measurement.unknownReason };
    for (const probe of rangeProbes(evidence)) {
      validateRequest(probe.request);
      cases.push({ ...probe, referenceMedianRangeM: frame.evaluator.medianVisibleRangeM });
    }
  }
  assert.equal(cases.length, 144);
  assert.equal(new Set(cases.map(p => p.id)).size, cases.length);
  assert.equal(cases.filter(p => p.split === 'development').length, 96);
  return cases.sort((a, b) => a.split.localeCompare(b.split) || digest(a.id).localeCompare(digest(b.id)));
}

async function freeze() {
  await verifySource();
  await mkdir(OUT, { recursive: true });
  const cases = await buildCases();
  await exact(resolve(OUT, 'cases.json'), cases);
  const paths = [resolve(OUT, 'cases.json'), resolve(ROOT, 'summary.json'), resolve(ROOT, 'source-freeze.json'), resolve(ROOT, 'input-freeze.json'),
    resolve(ROOT, 'analysis-seal.json'), resolve(ROOT, 'perception-handoff.json'), resolve(ROOT, 'prediction-seal.json'),
    resolve('experiments/jev-spatial-text/transport.ts'), resolve('experiments/jev-round2/http.ts'),
    resolve('experiments/jev-strategies/strategies.ts'), resolve('experiments/jev-pixels/controller.ts')];
  const files = await Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(path)) })));
  await exact(resolve(OUT, 'freeze.json'), { at: new Date().toISOString(), files, limits: LIMITS,
    policy: 'All cases and treatments fixed before paid inference. No retries, replacements or tuning.' });
}

async function verify() {
  const frozen = await json(resolve(OUT, 'freeze.json'));
  for (const file of frozen.files) assert.equal(digest(await readFile(file.path)), file.sha256);
  await verifySource();
  return await json(resolve(OUT, 'cases.json')) as (RangeProbe & { referenceMedianRangeM: number | null })[];
}

async function phase(split: string) {
  assert(process.argv.includes('--real'), 'Paid inference requires --real');
  const cases = await verify();
  if (split === 'confirmation') {
    const seal = await json(resolve(OUT, 'development-seal.json'));
    const bytes = await readFile(resolve(OUT, 'requests.jsonl'));
    assert.equal(digest(bytes.subarray(0, seal.bytes)), seal.sha256);
  }
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '';
  assert(key, 'Missing saved API credential');
  let dispatchId = '';
  const abort = new AbortController();
  const stop = () => abort.abort('Operator stopped Round3');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const meter = createMeter({ root: OUT, key, limits: LIMITS,
    send: (request, secret, signal) => callRecorded(request, secret, signal, OUT, dispatchId) });
  try {
    let count = 0;
    for (const probe of cases.filter(p => p.split === split)) {
      dispatchId = probe.id;
      await meter.judge(probe.request, probe.id, abort.signal);
      if (++count % 12 === 0) console.log(JSON.stringify({ split, completed: count }));
    }
  } finally { meter.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (split === 'development') {
    const rows = ledger(OUT);
    assert.equal(rows.length, 96); assert(rows.every(r => r.status === 'completed'));
    const bytes = await readFile(resolve(OUT, 'requests.jsonl'));
    await exact(resolve(OUT, 'development-seal.json'), { at: new Date().toISOString(), bytes: bytes.length, sha256: digest(bytes) });
  }
}

async function analyze() {
  const cases = await verify();
  const logs = new Map(ledger(OUT).map(r => [r.id, r]));
  const results: (RangeProbe & { referenceMedianRangeM: number | null; response: Awaited<ReturnType<typeof readCompleted>> | null;
    answer: string | undefined; status: string; score: ReturnType<typeof gradeRangeProbe>;
    idealReferenceProxyAgreement: boolean; timing: { latencyMs: number; inputTokens: number } | null })[] = [];
  for (const p of cases) {
    const row = logs.get(p.id);
    const response = row?.status === 'completed' ? await readCompleted(p.request, p.id, row, OUT) : null;
    const answer = response ? choice(response, 'action', Object.keys(p.options)) : undefined;
    const expectedReference = bestRangeOptions(p.options, p.referenceMedianRangeM, p.goalM);
    results.push({ ...p, response, answer, status: row?.status ?? 'not-started', score: gradeRangeProbe(p, answer),
      idealReferenceProxyAgreement: answer !== undefined && p.referenceMedianRangeM !== null && expectedReference.includes(answer),
      timing: row ? { latencyMs: row.latencyMs, inputTokens: row.inputTokens } : null });
  }
  const groups = ['development', 'confirmation'].flatMap(split => ['measured', 'signed-error'].map(arm => {
    const rows = results.filter(r => r.split === split && r.arm === arm);
    const correct = rows.filter(r => r.score.correct).length;
    return { split, arm, planned: rows.length, completed: rows.filter(r => r.score.completed).length,
      correct, accuracy: correct / rows.length, unsupported: rows.filter(r => r.score.unsupported).length,
      wrongDirection: rows.filter(r => r.score.wrongDirection).length,
      usefulMovement: rows.filter(r => r.score.usefulMovement).length, correctHold: rows.filter(r => r.score.correctHold).length,
      correctObserve: rows.filter(r => r.score.correctObserve).length,
      idealReferenceProxyAgreement: rows.filter(r => r.idealReferenceProxyAgreement).length };
  }));
  const measured = groups.find(g => g.split === 'confirmation' && g.arm === 'measured')!;
  const signed = groups.find(g => g.split === 'confirmation' && g.arm === 'signed-error')!;
  const gate = { complete: signed.completed === signed.planned && measured.completed === measured.planned,
    accuracyAtLeast90Percent: signed.accuracy >= .9, noUnsupported: signed.unsupported === 0,
    noWrongDirection: signed.wrongDirection === 0, noAccuracyRegression: signed.accuracy >= measured.accuracy };
  const { reportedCostUsd: _unverified, ...usage } = summarizeUsage(OUT);
  const summary = { groups, gate, pass: Object.values(gate).every(Boolean), usage,
    scope: 'One-step stipulated point-range approximation; no flight was executed. Reference-proxy agreement is not physical flight success.' };
  await writeFile(resolve(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const replay = await json(resolve(ROOT, 'replay.json'));
  replay.probes = results; replay.summary.decisions = summary; replay.status = 'perception-and-wording-completed';
  await writeFile(resolve(ROOT, 'replay.json'), JSON.stringify(replay, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cmd = process.argv[2];
  if (cmd === 'freeze') await freeze();
  else if (cmd === 'analyze') await analyze();
  else if (['development', 'confirmation'].includes(cmd!)) await phase(cmd!);
  else throw new Error('Use freeze | development --real | confirmation --real | analyze');
}
