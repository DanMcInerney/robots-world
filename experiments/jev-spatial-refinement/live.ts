import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH_PATTERNS, runBench, type BenchSummary, type BenchResponse, type BenchRequest } from '../jev-spatial-text/bench.ts';
import { createMeter, digest, durable, freezeStage, ledger, readCompleted, summarizeUsage, verifyFrozenStage } from '../jev-spatial-text/transport.ts';
import { ROOT, LIMITS, cases, verify, analyze, validateSelection, gates } from './run.ts';
import { adaptLiveRequest, createLiveJudge, LIVE_HYPOTHESIS, LIVE_TRANSFER, mapLiveResponse, parseLiveSelection, type LiveCondition, type LiveSelection } from './live-adapter.ts';

export const LIVE_STAGE = 'measured-geometry-live-v1';
export const LIVE_DIRECTORY = 'live';
export const LIVE_PLAN = BENCH_PATTERNS.flatMap((pattern, p) => [0, 1].flatMap(mirror => {
  const order: LiveCondition[] = (p + mirror) % 2 === 0 ? ['receipt-baseline', 'selected-representation'] : ['selected-representation', 'receipt-baseline'];
  return order.map(condition => ({ id: `refine-live-p${p}-m${mirror}-${condition}`, condition, pattern, seed: 7100 + 10 * p + mirror, seconds: 20 as const }));
}));
export type LiveTrial = typeof LIVE_PLAN[number];
export const LIVE_PROTOCOL = {
  scope: 'Optional sixteen fresh20-second yaw component episodes: receipt baseline versus development-selected representation, four patterns with two mirrored sides and reversed within-pair order. Eight paired blocks are not eight independent scene families.',
  freshness: 'Fresh attempt IDs and7100-series seeds. Stationary/interrupted magnitudes change; the immutable moving-car and occlusion profiles depend only on seed parity, so those episodes reuse the prior mirrored route family. This is not an unseen-route or topology confirmation.',
  gate: 'Development selection is sealed before confirmation. All1200 fixed requests must complete and verify; selected geometry must achieve at least95% exact-optimum confirmation actions with zero wrong-direction and zero unnecessary-out-of-view choices. A failure forbids this timed stage.',
  limits: LIMITS, engine: 'Reuse immutable jev-spatial-text/bench.ts with arm=receipt in both conditions. Same mission, explicit framing objective, complete yaw menu, routes, sensing, attitude assistance, servo, leases and scoring.',
  transfer: LIVE_TRANSFER, hypothesis: LIVE_HYPOTHESIS,
  representation: 'Only the candidate wire adds the selected representation. Raw/current-relations do not supply per-action future geometry; after-bearing/after-relations give every action symmetrically. Absent, ambiguous, clipped or unqualified inputs produce unknown conditional data. Raw RGB stays with engine evidence; no simulator scene is read by the adapter.',
  heads: 'Optional seven independent full-settling geometry questions only when action-and-forecasts was preselected. The action question stays the original framing question. Unknown is added to hypothetical live heads because measurements can be unavailable; this differs from fully stipulated synthetic fixtures. Extra answers never alter yaw, and are not graded against200ms realized outcomes.',
  wire: 'Actual adapted wire requests/responses are globally metered and hash-verified in the refinement root. Engine base requests are separately identified. answers.yaw is copied verbatim into the engine response; all other heads remain recorded. Callback starts and HTTP starts are distinct.',
  termination: 'No automatic retry or replacement on invalid/uncertain attempts. Drain transport, then setImmediate, require each exact normal or late engine sink, and only then seal the full evidence inventory. Operator abort reaches engine and global meter. An already queued call can dispatch after nominal episode end under the inherited meter; never claim a strict HTTP-start cutoff.',
  analysis: 'Report every planned attempt, infrastructure-invalid/incomplete status, and completed-only paired framing/visibility contrasts. Passive fixed observer is evaluator-only; visibility or passive reappearance alone is not active recovery. No prompt tuning after these outcomes. No physical flight, stereo, navigation, semantic recognition or full-mission qualification.',
};

/** Recompute selection and gate from hash-verified actual component responses, never gates.json. */
export async function qualifiedLiveSelection() {
  const all = await cases(); await verify(all, true, ROOT);
  const summary = await analyze(all), selected = await validateSelection(all, summary, ROOT);
  assert.equal(summary.details.length, 1200, 'All fixed development/regression/confirmation calls must finish before live qualification');
  const gate = gates(summary, selected).geometry;
  assert.equal(gate.pass, true, 'Selected geometry failed confirmation; no live stage is authorized');
  const selection = parseLiveSelection(selected.geometry);
  return { selection, gate, evidence: { selectionSha256: digest(await readFile(resolve(ROOT, 'selection.json'))), selectionSealSha256: digest(await readFile(resolve(ROOT, 'selection-seal.json'))), casesSha256: selected.casesSha256,
    developmentLedgerSha256: selected.developmentLedgerSha256, confirmationGate: { arm: gate.arm, pass: gate.pass, calls: gate.metrics.calls, exactOptimumCorrect: gate.metrics.questions.action.correct, wrongDirection: gate.metrics.wrongDirection, unnecessaryOutOfView: gate.metrics.unnecessaryOutOfView } } };
}
const liveTestPath = 'test/jev-spatial-refinement-live.test.ts';
export async function freezeLive() {
  const qualification = await qualifiedLiveSelection();
  return freezeStage(LIVE_STAGE, { plan: LIVE_PLAN, protocol: LIVE_PROTOCOL, selection: qualification.selection, gateEvidence: qualification.evidence, qualificationTest: { path: liveTestPath, sha256: digest(await readFile(liveTestPath)) } }, ROOT);
}
export async function verifyLiveStage() {
  const frozen = await verifyFrozenStage(LIVE_STAGE, ROOT), qualified = await qualifiedLiveSelection();
  assert.deepEqual(frozen.manifest.plan, LIVE_PLAN); assert.deepEqual(frozen.manifest.protocol, LIVE_PROTOCOL);
  assert.deepEqual(frozen.manifest.selection, qualified.selection); assert.deepEqual(frozen.manifest.gateEvidence, qualified.evidence);
  assert.equal(digest(await readFile(frozen.manifest.qualificationTest.path)), frozen.manifest.qualificationTest.sha256);
  // Existing freeze comparison also catches newly added source, not merely changed archived files.
  await freezeStage(LIVE_STAGE, frozen.manifest, ROOT); return frozen;
}
export async function liveEvidenceEntries(directory: string) {
  const paths = (await readdir(directory, { recursive: true })).filter(f => /\.(json|jsonl|png)$/.test(f) && f !== 'finalization.json').sort();
  return Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(resolve(directory, path))) })));
}
export async function verifyLiveTrial(trial: LiveTrial, frozen: any) {
  const directory = resolve(ROOT, LIVE_DIRECTORY, trial.id), final = JSON.parse(await readFile(resolve(directory, 'finalization.json'), 'utf8'));
  assert.equal(final.status, 'completed', 'Invalid or unfinalized trial is never resumed'); assert.deepEqual(final.trial, trial); assert.equal(final.sourceSha256, frozen.sourceSha256);
  assert.deepEqual(await liveEvidenceEntries(directory), final.files, 'Trial evidence inventory changed');
  const globalRows = new Map(ledger(ROOT).map(r => [r.id, r]));
  for (const id of final.requestIds as string[]) {
    const engine = JSON.parse(await readFile(resolve(directory, `${id}.request.json`), 'utf8')) as BenchRequest;
    const wire = adaptLiveRequest(engine, trial.condition, frozen.manifest.selection);
    const response = await readCompleted(wire, id, globalRows.get(id), ROOT) as BenchResponse;
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, `${id}.wire-request.json`), 'utf8')), wire);
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, `${id}.wire-response.json`), 'utf8')), response);
    const mapped = mapLiveResponse(engine, wire, response), mapping = JSON.parse(await readFile(resolve(directory, `${id}.adapter-mapping.json`), 'utf8'));
    assert.equal(mapping.engineRequestSha256, digest(JSON.stringify(engine))); assert.equal(mapping.wireRequestSha256, digest(JSON.stringify(wire)));
    assert.equal(mapping.wireResponseSha256, digest(JSON.stringify(response))); assert.equal(mapping.engineResponseSha256, digest(JSON.stringify(mapped)));
    const normal = existsSync(resolve(directory, `${id}.response.json`)), late = existsSync(resolve(directory, `${id}.late.json`)); assert.notEqual(normal, late, 'One engine normal/late sink required');
    const sink = JSON.parse(await readFile(resolve(directory, `${id}.${normal ? 'response' : 'late'}.json`), 'utf8'));
    assert.equal(sink.error, null); assert.deepEqual(sink.answer, mapped); if (late) assert.equal(sink.discarded, true);
  }
  const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8')) as BenchSummary;
  assert.equal(summary.id, trial.id); assert.equal(summary.seed, trial.seed); assert.equal(summary.pattern, trial.pattern); assert.equal(summary.status, 'completed');
  assert.equal(summary.calls, final.requestIds.length); assert.equal(summary.simulatedMs, trial.seconds * 1000); return summary;
}
export async function liveResults() {
  const frozen = await verifyLiveStage(), results: { trial: LiveTrial; summary: BenchSummary }[] = [], incomplete: { id: string; status: string; errors?: unknown }[] = [];
  for (const trial of LIVE_PLAN) {
    const directory = resolve(ROOT, LIVE_DIRECTORY, trial.id), file = resolve(directory, 'finalization.json');
    if (!existsSync(file)) { incomplete.push({ id: trial.id, status: existsSync(directory) ? 'unfinalized' : 'not-started' }); continue; }
    const final = JSON.parse(await readFile(file, 'utf8'));
    if (final.status !== 'completed') { incomplete.push({ id: trial.id, status: final.status, errors: final.errors }); continue; }
    results.push({ trial, summary: await verifyLiveTrial(trial, frozen) });
  }
  const paired = results.filter(r => r.trial.condition === 'selected-representation').flatMap(r => {
    const base = results.find(b => b.trial.condition === 'receipt-baseline' && b.trial.seed === r.trial.seed && b.trial.pattern === r.trial.pattern);
    return base ? [{ seed: r.trial.seed, pattern: r.trial.pattern, baselineFramedMs: base.summary.score.framedMs, selectedFramedMs: r.summary.score.framedMs, deltaFramedMs: r.summary.score.framedMs - base.summary.score.framedMs,
      baselineVisibleMs: base.summary.score.visibleMs, selectedVisibleMs: r.summary.score.visibleMs }] : [];
  });
  const result = { protocol: LIVE_PROTOCOL, selection: frozen.manifest.selection, plan: LIVE_PLAN, results, incomplete, paired, usage: summarizeUsage(ROOT) };
  await writeFile(resolve(ROOT, 'live-results.json'), JSON.stringify(result, null, 2) + '\n'); return result;
}
export async function runLive() {
  const frozen = await verifyLiveStage(), meter = createMeter({ root: ROOT, key: process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '', limits: LIMITS });
  const abort = new AbortController(), stop = () => abort.abort('Operator stopped refinement live stage');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let active: ReturnType<typeof createLiveJudge> | undefined;
  try {
    for (const trial of LIVE_PLAN) {
      abort.signal.throwIfAborted(); const directory = resolve(ROOT, LIVE_DIRECTORY, trial.id);
      if (existsSync(directory)) { await verifyLiveTrial(trial, frozen); continue; }
      console.log(JSON.stringify({ event: 'refinement-live-start', ...trial, selectedArm: frozen.manifest.selection.arm }));
      active = createLiveJudge({ condition: trial.condition, selection: frozen.manifest.selection, directory, send: (request, id) => meter.judge(request, id, abort.signal) as Promise<BenchResponse> });
      let summary: BenchSummary | null = null, thrown: string | null = null;
      try { summary = await runBench({ id: trial.id, arm: 'receipt', seed: trial.seed, pattern: trial.pattern, seconds: trial.seconds, outputDir: resolve(ROOT, LIVE_DIRECTORY), signal: abort.signal, judge: active.judge }); }
      catch (error) { thrown = String(error); }
      const settled = await active.drain(), errors = [...settled.errors, ...(thrown ? [thrown] : [])];
      const valid = summary?.status === 'completed' && errors.length === 0;
      durable(resolve(directory, 'finalization.json'), { status: valid ? 'completed' : 'infrastructure-invalid', trial, sourceSha256: frozen.sourceSha256, selectedArm: frozen.manifest.selection.arm, errors,
        requestIds: settled.requestIds, sinks: settled.sinks, files: await liveEvidenceEntries(directory) }, true);
      console.log(JSON.stringify({ event: 'refinement-live-finish', trial, summary, errors })); active = undefined;
      assert(valid, 'Invalid live attempt preserved; stop, never retry or silently replace'); await verifyLiveTrial(trial, frozen);
    }
  } finally { if (active) await active.drain(); meter.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  return liveResults();
}
async function main() {
  const command = process.argv[2] ?? 'plan';
  if (command === 'plan') { console.log(JSON.stringify({ plan: LIVE_PLAN, protocol: LIVE_PROTOCOL, selection: 'Not read until sealed development and completed confirmation gates verify' }, null, 2)); return; }
  if (command === 'freeze') { console.log(JSON.stringify(await freezeLive())); return; }
  if (command === 'analyze') { console.log(JSON.stringify(await liveResults())); return; }
  assert.equal(command, 'run'); assert(process.argv.includes('--real'), 'Paid execution requires explicit --real and a previously qualified live freeze'); console.log(JSON.stringify(await runLive()));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
