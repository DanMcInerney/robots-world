import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateScoutCases} from './scout.ts';
import {generateRangeCases} from './range.ts';
import {analyze, choose, gates, GATES, resultsSkeleton} from './analyze.ts';
import {assertNoOracleLeak, assertNoRankingLanguage} from './checks.ts';
import {dispatchIdFor, groupByDispatchId, duplicateBodyReport} from './dispatch.ts';
import type {ScoutCase} from './types.ts';
import {
  createMeter, digest, durable, freezeStage, ledger, summarizeUsage, validateRequest, verifyFrozenStage,
} from '../jev-spatial-text/transport.ts';

export const ROOT = resolve('.runtime/experiments/jev-scout-encodings-v1');
export const DRY_ROOT = resolve(ROOT, 'dry-run');
/** Hard ceilings from the predeclared plan; the meter stops dispatch, never retries silently. */
export const LIMITS = {requests: 1200, inputTokens: 6_000_000, requestsPerSecond: 2};
const PLAN = 'docs/jev-scout-encodings-plan.md';

export async function cases(): Promise<ScoutCase[]> {
  const all = [...generateScoutCases(), ...generateRangeCases()];
  assert.equal(new Set(all.map(c => c.id)).size, all.length, 'Duplicate case ids');
  for (const c of all) {
    validateRequest(c.request);
    assert(c.expected.action && c.expected.action.length > 0, `${c.id}: oracle produced no useful action`);
    for (const a of c.expected.action) assert(a in c.request.questions.action!.criteria, `${c.id}: expected action ${a} not offered`);
    assertNoOracleLeak(c);
    assertNoRankingLanguage(c);
  }
  // Hash-sort within replicate rounds interleaves hypotheses/arms/families reproducibly; repeats never collapse into cached IDs.
  return all.sort((a, b) => a.replicate - b.replicate || digest(a.id).localeCompare(digest(b.id)));
}

export async function freeze(all: ScoutCase[], root = ROOT) {
  const bytes = JSON.stringify(all) + '\n', file = resolve(root, 'cases.json');
  await mkdir(root, {recursive: true});
  if (existsSync(file)) assert.equal(await readFile(file, 'utf8'), bytes); else await writeFile(file, bytes, {flag: 'wx'});
  const plan = await readFile(PLAN, 'utf8');
  const dupes = duplicateBodyReport(all);
  const result = await freezeStage('fixed', {
    casesSha256: digest(bytes), planSha256: digest(plan), limits: LIMITS, gates: GATES,
    caseCount: all.length, distinctDispatchCount: dupes.distinctDispatches,
    selection: 'Critical-error-first (minimum harmful-labelled-action count), then the arm(s) meeting the development positive-rate/abstention-rate/family-floor gate, then the smallest mean request payload among those tied.',
  }, root);
  const planFile = resolve(root, 'freezes/fixed/plan.md');
  if (existsSync(planFile)) assert.equal(await readFile(planFile, 'utf8'), plan); else await writeFile(planFile, plan, {flag: 'wx'});
  return result;
}

export async function verify(all: ScoutCase[], live = true, root = ROOT) {
  const frozen = await verifyFrozenStage('fixed', root);
  assert.equal(digest(await readFile(resolve(root, 'cases.json'))), frozen.manifest.casesSha256);
  assert.equal(digest(JSON.stringify(all) + '\n'), frozen.manifest.casesSha256);
  assert.equal(digest(await readFile(resolve(root, 'freezes/fixed/plan.md'))), frozen.manifest.planSha256);
  if (live) for (const entry of frozen.entries) assert.equal(digest(await readFile(entry.path)), entry.sha256, `Live frozen source changed: ${entry.path}`);
  return frozen;
}

export function assertUnchangedPrefix(current: Uint8Array, preserved: Uint8Array, expectedHash: string) {
  assert.equal(digest(preserved), expectedHash, 'Preserved development ledger changed');
  assert.equal(digest(current.subarray(0, preserved.length)), expectedHash, 'Development ledger prefix changed');
}

function isResolved(rowsById: Map<string, any>, dispatchId: string): boolean {
  return rowsById.get(dispatchId)?.status === 'completed' || rowsById.get(`${dispatchId}-a1`)?.status === 'completed';
}
function confirmationCallCounts(all: ScoutCase[], arms: {S: string; R: string}) {
  return {
    S: all.filter(c => c.hypothesis === 'S' && c.split === 'confirmation' && c.arm === arms.S).length,
    R: all.filter(c => c.hypothesis === 'R' && c.split === 'confirmation' && c.arm === arms.R).length,
  };
}

/** Confirmation cases must be unreadable by the development stage: `select` requires every distinct
 * development dispatch id resolved (completed, or resolved through exactly one -a1 amendment) and
 * asserts zero confirmation dispatch ids were ever seen in the ledger. */
export async function select(all: ScoutCase[], root = ROOT) {
  const rowsById = new Map(ledger(root).map(r => [r.id, r]));
  const developmentIds = [...groupByDispatchId(all.filter(c => c.split === 'development')).keys()];
  const confirmationIds = new Set(groupByDispatchId(all.filter(c => c.split === 'confirmation')).keys());
  assert(![...rowsById.keys()].some(id => confirmationIds.has(id)), 'Selection must precede any confirmation dispatch');
  const unresolved = developmentIds.filter(id => !isResolved(rowsById, id));
  assert.equal(unresolved.length, 0, `Expected all ${developmentIds.length} development dispatch ids resolved; missing ${unresolved.length}: ${unresolved.slice(0, 5).join(', ')}`);
  const summary = await analyze(all, root), chosen = choose(summary), prefix = await readFile(resolve(root, 'requests.jsonl'));
  const selection = {...chosen, selectedAt: new Date().toISOString(), developmentLedgerSha256: digest(prefix), developmentLedgerBytes: prefix.length, casesSha256: digest(JSON.stringify(all) + '\n')};
  await writeFile(resolve(root, 'development-ledger.jsonl'), prefix, {flag: 'wx'});
  durable(resolve(root, 'selection.json'), selection, true);
  durable(resolve(root, 'selection-seal.json'), {selectionSha256: digest(await readFile(resolve(root, 'selection.json')))}, true);
  return selection;
}
/** Re-derives the selection from the immutable development-ledger snapshot and asserts it matches
 * selection.json exactly: a swapped-and-resealed selection.json (matching its own stored hash but not
 * the ledger) is rejected, not merely a bytes-changed check against itself. */
export async function validateSelection(all: ScoutCase[], root = ROOT) {
  const bytes = await readFile(resolve(root, 'selection.json')), selection = JSON.parse(bytes.toString());
  const seal = JSON.parse(await readFile(resolve(root, 'selection-seal.json'), 'utf8'));
  assert.equal(digest(bytes), seal.selectionSha256, 'Selection bytes changed');
  assert.equal(selection.casesSha256, digest(JSON.stringify(all) + '\n'));
  const prefix = await readFile(resolve(root, 'development-ledger.jsonl'));
  assertUnchangedPrefix(await readFile(resolve(root, 'requests.jsonl')), prefix, selection.developmentLedgerSha256);
  const chosen = choose(await analyze(all, root));
  assert.deepEqual(selection.S, chosen.S, 'Selection re-derivation mismatch (S): selection.json does not match the ledger');
  assert.deepEqual(selection.R, chosen.R, 'Selection re-derivation mismatch (R): selection.json does not match the ledger');
  assert.deepEqual(selection.development, chosen.development, 'Development scoring changed since selection');
  return selection;
}

/** Seals analysis.json/gates.json after confirmation completes so neither can be silently overwritten;
 * asserts confirmation is complete (every distinct dispatch id for the selected arms resolved) first. */
export async function complete(all: ScoutCase[], root = ROOT, synthetic = false) {
  const selection = await validateSelection(all, root);
  const summary = await analyze(all, root);
  const verdicts = gates(summary, selection, confirmationCallCounts(all, {S: selection.S.arm, R: selection.R.arm}));
  assert(verdicts.S.complete && verdicts.R.complete, `Confirmation dispatch is incomplete for the selected arm(s): S complete=${verdicts.S.complete}, R complete=${verdicts.R.complete}`);
  const analysisBytes = JSON.stringify({...summary, synthetic}, null, 2) + '\n', gatesBytes = JSON.stringify(verdicts, null, 2) + '\n';
  const sealFile = resolve(root, 'completion-seal.json');
  if (existsSync(sealFile)) {
    const seal = JSON.parse(await readFile(sealFile, 'utf8'));
    assert.equal(digest(analysisBytes), seal.analysisSha256, 'analysis.json would change after completion; refusing to overwrite');
    assert.equal(digest(gatesBytes), seal.gatesSha256, 'gates.json would change after completion; refusing to overwrite');
  } else {
    await writeFile(resolve(root, 'analysis.json'), analysisBytes);
    await writeFile(resolve(root, 'gates.json'), gatesBytes);
    await writeFile(resolve(root, 'results-skeleton.md'), resultsSkeleton(summary, selection, verdicts, synthetic) + '\n');
    durable(sealFile, {analysisSha256: digest(analysisBytes), gatesSha256: digest(gatesBytes), completedAt: new Date().toISOString(), synthetic}, true);
  }
  return {selection, verdicts};
}

/** Dispatches one request per distinct (arm, request body, replicate) -- the real dispatch unit (see
 * dispatch.ts) -- with a predeclared, bounded recovery rule: a failed dispatch is preserved exactly as
 * it happened (never replayed under its own id), the ledger row is marked resolved-by-amendment, and
 * exactly ONE fresh attempt is made under a new `-a1` id. A second failure on that same id propagates
 * and stops the whole run; there is no further amendment and no blanket retry. */
export async function dispatchAllWithAmendment(members: ScoutCase[], root: string, key: string, limits = LIMITS, send?: any) {
  const groups = groupByDispatchId(members);
  let meter = createMeter({root, key, limits, ...(send ? {send} : {})});
  let done = 0, amended = 0;
  try {
    for (const [dispatchId, group] of groups) {
      const request = group[0]!.request;
      try {
        await meter.judge(request, dispatchId);
      } catch (originalError) {
        durable(resolve(root, 'requests.jsonl'), {id: dispatchId, recovery: true});
        const amendId = `${dispatchId}-a1`;
        durable(resolve(root, 'amendments.jsonl'), {originalId: dispatchId, amendedId: amendId, reason: String(originalError), at: new Date().toISOString()});
        meter.close();
        meter = createMeter({root, key, limits, ...(send ? {send} : {})});
        await meter.judge(request, amendId); // a second failure here propagates and stops the run
        amended++;
      }
      if (++done % 25 === 0) console.log(JSON.stringify({done, dispatched: groups.size, usage: summarizeUsage(root)}));
    }
  } finally { meter.close(); }
  return {dispatched: groups.size, amended};
}

async function main() {
  const command = process.argv[2] ?? 'qualify', all = await cases();
  if (command === 'qualify') {
    const dupes = duplicateBodyReport(all);
    console.log(JSON.stringify({
      cases: all.length, S: all.filter(c => c.hypothesis === 'S').length, R: all.filter(c => c.hypothesis === 'R').length,
      development: all.filter(c => c.split === 'development').length, confirmation: all.filter(c => c.split === 'confirmation').length,
      distinctDispatches: dupes.distinctDispatches, duplicateGroups: dupes.duplicates.length,
      maxBytes: Math.max(...all.map(c => Buffer.byteLength(JSON.stringify(c.request)))),
    }));
    return;
  }
  if (command === 'freeze') { console.log(JSON.stringify(await freeze(all))); return; }
  if (command === 'dry-run') { console.log(JSON.stringify(await dryRun())); return; }
  await verify(all);
  if (command === 'analyze') {
    const summary = await analyze(all, ROOT);
    const selectionFile = resolve(ROOT, 'selection.json'), sealFile = resolve(ROOT, 'completion-seal.json');
    let selection: any = null, verdicts: any = null;
    if (existsSync(selectionFile)) {
      selection = await validateSelection(all, ROOT);
      verdicts = gates(summary, selection, confirmationCallCounts(all, {S: selection.S.arm, R: selection.R.arm}));
    }
    if (!existsSync(sealFile)) {
      await writeFile(resolve(ROOT, 'analysis.json'), JSON.stringify(summary, null, 2) + '\n');
      if (verdicts) await writeFile(resolve(ROOT, 'gates.json'), JSON.stringify(verdicts, null, 2) + '\n');
      await writeFile(resolve(ROOT, 'results-skeleton.md'), resultsSkeleton(summary, selection, verdicts, false) + '\n');
    }
    console.log(JSON.stringify({usage: summary.usage, groups: summary.groups}));
    return;
  }
  if (command === 'select') { console.log(JSON.stringify(await select(all))); return; }
  if (command === 'complete') { console.log(JSON.stringify(await complete(all, ROOT, false))); return; }
  assert(['development', 'confirmation'].includes(command), `Unknown command: ${command}`);
  assert(process.argv.includes('--real'), 'Paid execution requires --real');
  if (command === 'confirmation') await validateSelection(all, ROOT);
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '';
  assert(key, 'Saved key required (load with: node --env-file=<path to .env.jev.local> ...)');
  const result = await dispatchAllWithAmendment(all.filter(c => c.split === command), ROOT, key);
  console.log(JSON.stringify({phase: command, ...result, usage: summarizeUsage(ROOT)}));
}

// ---------- synthetic (offline) dry run: exercises journal, both ceilings, stop-on-error, the -a1
// amendment path, select(), validateSelection(), complete() and gates() end to end ----------
function fakeChoiceResponse(request: ScoutCase['request'], answerId: string) {
  const ids = Object.keys(request.questions.action!.criteria);
  const probabilities = Object.fromEntries(ids.map(id => [id, id === answerId ? 1 : 0]));
  const tokens = Math.max(64, Math.round(Buffer.byteLength(JSON.stringify(request)) / 3.5)); // synthetic estimate, not measured usage
  return {model: request.model, usage: {input_tokens: tokens}, answers: {action: {type: 'choice', choice: answerId, confidence: 1, probabilities}}, synthetic: true};
}
export async function dryRun(root = DRY_ROOT) {
  await mkdir(root, {recursive: true});
  durable(resolve(root, 'SYNTHETIC.json'), {synthetic: true, kind: 'OFFLINE DRY RUN: every response below is fabricated. Zero real API calls were made.', at: new Date().toISOString()}, true);
  const all = await cases();
  const byBody = new Map(all.map(c => [JSON.stringify(c.request), c]));
  const send = async (request: ScoutCase['request']) => {
    // The synthetic responder answers with the oracle's own first useful action for whichever case(s)
    // share this exact request body (a fabricated stand-in for "what Jev would answer", not a behavioural signal).
    const representative = byBody.get(JSON.stringify(request))!;
    const answer = representative.expected.action![0] ?? Object.keys(request.questions.action!.criteria)[0]!;
    return fakeChoiceResponse(request, answer);
  };
  await dispatchAllWithAmendment(all.filter(c => c.split === 'development'), root, 'synthetic', LIMITS, send);
  await select(all, root);
  await validateSelection(all, root);
  await dispatchAllWithAmendment(all.filter(c => c.split === 'confirmation'), root, 'synthetic', LIMITS, send);
  const {selection, verdicts} = await complete(all, root, true);
  const usage = summarizeUsage(root);
  return {usage, selection, gates: verdicts, dispatches: ledger(root).length, duplicates: duplicateBodyReport(all)};
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
