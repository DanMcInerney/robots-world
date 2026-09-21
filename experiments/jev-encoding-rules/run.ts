/** Orchestration for the F1-F10 static encoding-rules probes. No development/confirmation split (this
 * is an exploratory one-shot battery, per the plan): generate, dispatch once through the shared meter
 * (ceilings, serial rate limit, journal-before-dispatch, raw request/response storage, single bounded
 * `-a1` amendment on failure -- all identical to experiments/jev-scout-encodings/run.ts), then analyze. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateF1Cases} from './f1-menu-size.ts';
import {generateF2Cases} from './f2-near-tie.ts';
import {generateF3Cases} from './f3-consequence-form.ts';
import {generateF4Cases} from './f4-numbers-words.ts';
import {assertNoOracleLeak, assertNoRankingLanguage} from './checks.ts';
import {groupByDispatchId, duplicateBodyReport} from './dispatch.ts';
import {analyzeCases, formatTable} from './analyze.ts';
import type {RuleCase} from './types.ts';
import {createMeter, digest, durable, ledger, summarizeUsage, validateRequest} from '../jev-spatial-text/transport.ts';

export const ROOT = resolve('.runtime/experiments/jev-encoding-rules-v1');
export const DRY_ROOT = resolve(ROOT, 'dry-run');
/** Hard ceilings from the assignment: <=3000 requests, <=8,000,000 input tokens (~$0.35 at $0.042/M
 * tokens). Rate (<=2 starts/s) is enforced inside createMeter's judge() via its 505ms min-interval
 * default, independent of this object. */
export const LIMITS = {requests: 3000, inputTokens: 8_000_000, requestsPerSecond: 2};

const GENERATORS: Record<string, () => RuleCase[]> = {
  F1: generateF1Cases, F2: generateF2Cases, F3: generateF3Cases, F4: generateF4Cases,
};
export const PRIORITY_FACTORS = ['F1', 'F2', 'F3', 'F4'];

export function allCases(factors: string[] = PRIORITY_FACTORS): RuleCase[] {
  const out: RuleCase[] = [];
  for (const f of factors) {
    const gen = GENERATORS[f];
    assert(gen, `Unknown or unbuilt factor: ${f}`);
    out.push(...gen());
  }
  assert.equal(new Set(out.map(c => c.id)).size, out.length, 'Duplicate case ids');
  for (const c of out) {
    validateRequest(c.request);
    assert(c.expected.length > 0, `${c.id}: oracle produced no useful action`);
    for (const a of c.expected) assert(a in c.request.questions.action!.criteria, `${c.id}: expected action ${a} not offered`);
    for (const a of c.harmfulIds) assert(a in c.request.questions.action!.criteria, `${c.id}: harmful action ${a} not offered`);
    assertNoOracleLeak(c);
    assertNoRankingLanguage(c);
  }
  // Deterministic, reproducible interleaving across factors/arms; independent of generation order.
  return out.sort((a, b) => digest(a.id).localeCompare(digest(b.id)));
}

/** Dispatches one request per distinct request body -- the real dispatch unit (dispatch.ts) -- with a
 * predeclared, bounded recovery rule: a failed dispatch is preserved exactly as it happened (never
 * replayed under its own id), journaled as needing reconciliation, and exactly ONE fresh attempt is
 * made under a new `-a1` id. A second failure on that id propagates and stops the whole run; there is
 * no further amendment and no blanket retry, matching "no silent retries, stop on any error burst". */
export async function dispatchAll(cases: RuleCase[], root: string, key: string, limits = LIMITS, send?: any) {
  const groups = groupByDispatchId(cases);
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

// ---------- synthetic (offline) dry run: validates the whole pipeline with zero network calls ----------
function fakeChoiceResponse(request: RuleCase['request'], answerId: string) {
  const ids = Object.keys(request.questions.action!.criteria);
  const probabilities = Object.fromEntries(ids.map(id => [id, id === answerId ? 1 : 0]));
  const tokens = Math.max(64, Math.round(Buffer.byteLength(JSON.stringify(request)) / 3.5));
  return {model: request.model, usage: {input_tokens: tokens}, answers: {action: {type: 'choice', choice: answerId, confidence: 1, probabilities}}, synthetic: true};
}
export async function dryRun(factors = PRIORITY_FACTORS, root = DRY_ROOT) {
  await mkdir(root, {recursive: true});
  durable(resolve(root, 'SYNTHETIC.json'), {synthetic: true, kind: 'OFFLINE DRY RUN: every response below is fabricated. Zero real API calls were made.', at: new Date().toISOString()}, true);
  const all = allCases(factors);
  const byBody = new Map(all.map(c => [JSON.stringify(c.request), c]));
  const send = async (request: RuleCase['request']) => {
    const representative = byBody.get(JSON.stringify(request))!;
    const answer = representative.expected[0] ?? Object.keys(request.questions.action!.criteria)[0]!;
    return fakeChoiceResponse(request, answer);
  };
  const result = await dispatchAll(all, root, 'synthetic', LIMITS, send);
  const stats = await analyzeCases(all, root);
  return {usage: summarizeUsage(root), dispatches: ledger(root).length, duplicates: duplicateBodyReport(all), result, stats};
}

async function main() {
  const command = process.argv[2] ?? 'qualify';
  const factorsArg = process.argv.find(a => a.startsWith('--factors='));
  const factors = factorsArg ? factorsArg.slice('--factors='.length).split(',') : PRIORITY_FACTORS;
  if (command === 'qualify') {
    const all = allCases(factors);
    const dupes = duplicateBodyReport(all);
    console.log(JSON.stringify({
      cases: all.length, byFactor: Object.fromEntries(factors.map(f => [f, all.filter(c => c.factor === f).length])),
      byArm: Object.fromEntries([...new Set(all.map(c => `${c.factor}::${c.arm}`))].map(k => [k, all.filter(c => `${c.factor}::${c.arm}` === k).length])),
      distinctDispatches: dupes.distinctDispatches, duplicateGroups: dupes.duplicates.length,
      maxBytes: Math.max(...all.map(c => Buffer.byteLength(JSON.stringify(c.request)))),
      estimatedTotalRequestsAllFactorsAtThisRate: null,
    }, null, 2));
    return;
  }
  if (command === 'dry-run') { console.log(JSON.stringify(await dryRun(factors), null, 2)); return; }
  const all = allCases(factors);
  if (command === 'run') {
    assert(process.argv.includes('--real'), 'Paid execution requires --real');
    const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '';
    assert(key, 'Saved key required (load with: node --env-file=<path to .env.jev.local> ...)');
    const result = await dispatchAll(all, ROOT, key);
    console.log(JSON.stringify({...result, usage: summarizeUsage(ROOT)}, null, 2));
    return;
  }
  if (command === 'analyze') {
    const stats = await analyzeCases(all, ROOT);
    await writeFile(resolve(ROOT, 'analysis.json'), JSON.stringify({usage: summarizeUsage(ROOT), stats}, null, 2) + '\n');
    console.log(formatTable(stats));
    console.log(JSON.stringify(summarizeUsage(ROOT)));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
