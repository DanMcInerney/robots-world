import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { choice } from '../jev-strategies/strategies.ts';
import { createMeter, digest, freezeStage, verifyFrozenStage, ledger, summarizeUsage, validateRequest } from '../jev-spatial-text/transport.ts';
import { readRecordedCall } from '../jev-round1/evidence.ts';
import { generateCases, scoreCase, summarize } from './decisions.ts';
import { ROOT, LIMITS, PLAN_PATH, SCOPE, type SensorRecord, type Probe } from './protocol.ts';
import { callRecorded } from './http.ts';

const STAGE = 'round2-final', HTML = 'experiments/jev-round2/replay.html';
const PERCEPTION = resolve(ROOT, 'perception');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function exact(path: string, bytes: string | Uint8Array) {
  if (existsSync(path)) assert.equal(digest(await readFile(path)), digest(bytes), `Immutable artifact differs: ${path}`);
  else await writeFile(path, bytes, { flag: 'wx' });
}
export async function records(): Promise<SensorRecord[]> {
  const rows: SensorRecord[] = await json(resolve(PERCEPTION, 'sensor-records.json'));
  assert.equal(rows.length, 48); assert.equal(new Set(rows.map(r => r.id)).size, 48);
  for (const split of ['development', 'confirmation']) for (const method of ['stereo', 'monocular']) {
    const subset = rows.filter(r => r.split === split && r.method === method);
    assert.equal(subset.length, 12); assert.equal(subset.filter(r => r.evaluation.family === 'nominal').length, 6);
  }
  for (const row of rows) {
    const interval = row.observation.axialDepthIntervalM;
    if (interval) assert(interval.every(Number.isFinite) && interval[0] > 0 && interval[1] >= interval[0]);
    if (row.observation.targetStatus !== 'single') assert.equal(interval, null);
    for (const path of [row.leftPath, row.rightPath, row.depthPath].filter(Boolean)) {
      assert(path!.replaceAll('\\', '/').startsWith('.runtime/experiments/jev-round2-v1/perception/'));
      assert(existsSync(resolve(path!)), `Missing image ${path}`);
    }
  }
  return rows;
}
export async function cases(): Promise<Probe[]> {
  const all = generateCases(await records());
  assert.equal(all.length, 192); assert.equal(new Set(all.map(c => c.id)).size, 192);
  for (const c of all) {
    validateRequest(c.request);
    assert(c.expected.length > 0);
    for (const key of c.expected) assert(key in c.request.questions.action!.criteria);
  }
  // Identical deterministic interleaving in both phases; the statistical unit stays the scene.
  return all.sort((a, b) => a.split.localeCompare(b.split) || digest(a.id).localeCompare(digest(b.id)));
}
export function perceptionSummary(rows: SensorRecord[]) {
  const groups: any[] = [];
  for (const split of ['development', 'confirmation']) for (const method of ['stereo', 'monocular']) {
    const subset = rows.filter(r => r.split === split && r.method === method);
    const nominal = subset.filter(r => r.evaluation.family === 'nominal');
    const usable = nominal.filter(r => r.observation.axialDepthIntervalM !== null && r.observation.axialDepthM !== null);
    const errors = usable.map(r => r.observation.axialDepthM! - r.evaluation.referenceAxialDepthM!).sort((a, b) => a - b);
    const abs = errors.map(Math.abs).sort((a, b) => a - b);
    const p95 = abs.length ? abs[Math.min(abs.length - 1, Math.ceil(.95 * abs.length) - 1)]! : null;
    const noTarget = subset.filter(r => r.observation.targetStatus !== 'single');
    const unknownRequired = subset.filter(r => ['ambiguous', 'missing', 'dark'].includes(r.evaluation.family));
    const unknownCorrect = unknownRequired.filter(r => r.observation.axialDepthIntervalM === null).length;
    const underestimatedOver2M = errors.filter(e => e < -2).length;
    groups.push({ split, method, nominal: nominal.length, nominalUsable: usable.length, nominalAbsErrorsM: abs,
      p95AbsErrorM: p95, nominalSignedErrorsM: errors, underestimatedOver2M,
      unknownRequiredCases: unknownRequired.length, unknownCorrect, detectedMissingOrAmbiguous: noTarget.length,
      gate: usable.length >= 5 && p95 !== null && p95 <= 1 && underestimatedOver2M === 0 && unknownRequired.length === 3 && unknownCorrect === 3,
      challenges: subset.filter(r => r.evaluation.family !== 'nominal').map(r => ({ id: r.id, family: r.evaluation.family,
        targetStatus: r.observation.targetStatus, estimatedM: r.observation.axialDepthM, referenceM: r.evaluation.referenceAxialDepthM,
        intervalM: r.observation.axialDepthIntervalM, validFraction: r.observation.validFraction })) });
  }
  return { groups, scope: 'Synthetic surface-depth component only; no real 10 m qualification. Quantiles are nearest-rank.' };
}
export async function freeze() {
  await mkdir(ROOT, { recursive: true }); const all = await cases();
  await exact(resolve(ROOT, 'cases.json'), JSON.stringify(all) + '\n');
  await exact(resolve(ROOT, 'frozen-plan.md'), await readFile(PLAN_PATH));
  await exact(resolve(ROOT, 'frozen-replay.html'), await readFile(HTML));
  const artifactIndex = resolve(PERCEPTION, 'artifact-files.json');
  const artifacts: Array<{path: string; sha256: string; bytes: number}> = await json(artifactIndex);
  const extras = [PLAN_PATH, HTML, '.runtime/experiments/jev-round2-v1/perception/artifact-files.json',
    ...artifacts.map(e => e.path), ...(await readdir('test')).filter(p => p.startsWith('jev-round2-') && p.endsWith('.test.ts')).map(p => 'test/' + p)];
  for (const e of artifacts) {
    assert.equal(digest(await readFile(e.path)), e.sha256, `Offline artifact differs: ${e.path}`);
  }
  assert(artifacts.some(e => e.path.endsWith('/sensor-records.json')), 'Perception artifact index must include sensor records');
  const evidence = [];
  for (const path of [...new Set(extras)].sort()) evidence.push({path, sha256: digest(await readFile(path))});
  return freezeStage(STAGE, { casesSha256: digest(JSON.stringify(all) + '\n'), evidence, limits: LIMITS, scope: SCOPE,
    plannedRequests: 192, pairedSceneUnits: 24, primaryDecisionArm: 'consequences' }, ROOT);
}
export async function verify() {
  const f = await verifyFrozenStage(STAGE, ROOT);
  for (const e of [...f.entries, ...f.manifest.evidence]) assert.equal(digest(await readFile(e.path)), e.sha256, `Frozen source/evidence changed: ${e.path}`);
  assert.equal(digest(JSON.stringify(await cases()) + '\n'), f.manifest.casesSha256);
  assert.equal(digest(await readFile(resolve(ROOT, 'cases.json'))), f.manifest.casesSha256);
  assert.equal(digest(await readFile(resolve(ROOT, 'frozen-plan.md'))), digest(await readFile(PLAN_PATH)));
  assert.equal(digest(await readFile(resolve(ROOT, 'frozen-replay.html'))), digest(await readFile(HTML)));
  return f;
}
export async function readResults(root = ROOT, probes?: Probe[]) {
  const logged = new Map(ledger(root).map(r => [r.id, r])); const results = [];
  for (const probe of probes ?? await cases()) {
    const row = logged.get(probe.id);
    const call = await readRecordedCall(probe.request, probe.id, row, root);
    const answer = call.status === 'completed' ? choice(call.response!, 'action', Object.keys(probe.request.questions.action!.criteria)) : undefined;
    const httpPath = resolve(root, 'http', probe.id + '.json');
    const httpEvidence = existsSync(httpPath) ? await json(httpPath) : null;
    if (httpEvidence) {
      assert.equal(httpEvidence.id, probe.id); assert.equal(httpEvidence.requestSha256, digest(JSON.stringify(probe.request)));
      assert.equal(digest(Buffer.from(httpEvidence.bodyBase64, 'base64')), httpEvidence.retainedBodySha256);
      if (call.status === 'completed') {
        assert(httpEvidence.complete && !httpEvidence.truncated && httpEvidence.status >= 200 && httpEvidence.status < 300);
        assert.deepEqual(JSON.parse(Buffer.from(httpEvidence.bodyBase64, 'base64').toString('utf8')), call.response);
      }
    } else assert(call.status !== 'completed', 'Completed request lacks HTTP receipt');
    results.push({ ...probe, status: call.status === 'not-dispatched' ? 'missing' : call.status === 'completed' ? 'completed' : 'error',
      answer, response: call.response, error: call.error, score: scoreCase(probe, answer),
      httpEvidence,
      timing: row ? {apiLatencyMs: row.latencyMs, dispatchedAtMs: row.dispatchedAtMs, inputTokens: row.inputTokens} : null });
  }
  return results;
}
export function usage() { const {reportedCostUsd: _unverifiedPrice, ...actual} = summarizeUsage(ROOT); return actual; }
async function seal() {
  await verify(); const results = await readResults();
  assert(results.filter(r => r.split === 'development').every(r => r.status === 'completed'));
  assert(results.filter(r => r.split === 'confirmation').every(r => r.status === 'missing'));
  const bytes = await readFile(resolve(ROOT, 'requests.jsonl'));
  await exact(resolve(ROOT, 'development-ledger.jsonl'), bytes);
  await exact(resolve(ROOT, 'development-seal.json'), JSON.stringify({sha256: digest(bytes), bytes: bytes.length, probes: 96,
    policy: 'All cases, predictions, representations and gates fixed before paid inference; no development-driven changes.'}) + '\n');
}
async function verifySeal() {
  const sealed = await json(resolve(ROOT, 'development-seal.json'));
  const prior = await readFile(resolve(ROOT, 'development-ledger.jsonl')), current = await readFile(resolve(ROOT, 'requests.jsonl'));
  assert.equal(prior.length, sealed.bytes); assert.equal(digest(prior), sealed.sha256);
  assert.equal(digest(current.subarray(0, prior.length)), sealed.sha256);
}
export async function analyze() {
  const frozen = await verify(), sensorRecords = await records(), probes = await readResults();
  if (probes.some(r => r.split === 'confirmation' && r.status !== 'missing')) await verifySeal();
  const summary = {scope: SCOPE, decision: summarize(probes.map(r => r.score)), perception: perceptionSummary(sensorRecords), usage: usage(),
    completeness: {planned: probes.length, completed: probes.filter(p => p.status === 'completed').length,
      missing: probes.filter(p => p.status === 'missing').length, errors: probes.filter(p => p.status === 'error').length}};
  await writeFile(resolve(ROOT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(resolve(ROOT, 'replay.json'), JSON.stringify({scope: SCOPE, summary, records: sensorRecords, probes,
    realSummary: await json(resolve(PERCEPTION, 'real-summary.json')),
    evidence: {sourceSha256: frozen.sourceSha256, casesSha256: frozen.manifest.casesSha256,
      requests: 'requests/', responses: 'responses/', perceptionManifest: 'perception/manifest.json'}}) + '\n');
  await copyFile(resolve(ROOT, 'frozen-replay.html'), resolve(ROOT, 'index.html')); return summary;
}
async function main() {
  const command = process.argv[2] ?? 'qualify';
  if (command === 'qualify') { console.log(JSON.stringify({probes: (await cases()).length, perception: perceptionSummary(await records()), limits: LIMITS})); return; }
  if (command === 'freeze') { const f = await freeze(); console.log(JSON.stringify({sourceSha256: f.sourceSha256, casesSha256: f.manifest.casesSha256})); return; }
  if (command === 'verify') { const f = await verify(); console.log(JSON.stringify({sourceSha256: f.sourceSha256, verified: true})); return; }
  if (command === 'seal') { await seal(); console.log('Development sealed'); return; }
  if (command === 'analyze') { console.log(JSON.stringify(await analyze())); return; }
  assert(['development', 'confirmation'].includes(command)); assert(process.argv.includes('--real'));
  const frozen = await verify(), status = await json(resolve(ROOT, 'pre-inference-status.json'));
  assert(status.ready === true && status.sourceSha256 === frozen.sourceSha256 && status.casesSha256 === frozen.manifest.casesSha256);
  if (command === 'confirmation') await verifySeal();
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? ''; assert(key);
  let dispatchId = '';
  const meter = createMeter({root: ROOT, key, limits: LIMITS, send: (request, secret, signal) => callRecorded(request, secret, signal, ROOT, dispatchId)}), abort = new AbortController();
  const stop = () => abort.abort('Operator stopped Round 2'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let done = 0;
    for (const probe of (await cases()).filter(c => c.split === command)) {
      abort.signal.throwIfAborted(); dispatchId = probe.id; await meter.judge(probe.request, probe.id, abort.signal);
      if (++done % 12 === 0) console.log(JSON.stringify({phase: command, completed: done, usage: usage()}));
    }
  } finally { meter.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  console.log(JSON.stringify({phase: command, usage: usage()}));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
