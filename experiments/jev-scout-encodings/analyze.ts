import {choice} from '../jev-strategies/strategies.ts';
import {digest, ledger, readCompleted, summarizeUsage} from '../jev-spatial-text/transport.ts';
import {dispatchIdFor} from './dispatch.ts';
import type {ScoutCase} from './types.ts';

/** Predeclared, numeric development/confirmation advancement gates. Fixed before any inference.
 * Positive and abstention/trap cases are gated separately so pooling cannot hide a family the arm
 * cannot determine (a memory-less baseline structurally failing every trap case, for example), and a
 * per-family floor stops one strong family from carrying an otherwise-weak arm. */
export const GATES = {
  S: {positiveUsefulRate: 0.90, abstentionCorrectRate: 0.90, harmfulCount: 0, familyFloor: 0.75},
  R: {positiveUsefulRate: 0.90, abstentionCorrectRate: 0.90, harmfulCount: 0, familyFloor: 0.75},
} as const;

/** Looks up the ledger row that answers case `c`. The real dispatch unit is the distinct request body
 * (see dispatch.ts): every case is scored from whichever completed row shares its exact body. */
function rowFor(rows: Map<string, any>, c: ScoutCase) {
  return rows.get(dispatchIdFor(c));
}

export async function analyze(all: ScoutCase[], root: string) {
  const rows = new Map(ledger(root).map(r => [r.id, r]));
  const groups: Record<string, any> = {}, details: any[] = [];
  for (const c of all) {
    const row = rowFor(rows, c);
    if (row?.status !== 'completed') continue;
    const response = await readCompleted(c.request, dispatchIdFor(c), row, root);
    const answer = choice(response, 'action', Object.keys(c.request.questions.action!.criteria));
    const key = [c.hypothesis, c.split, c.arm].join('/');
    const g = (groups[key] ??= {
      hypothesis: c.hypothesis, split: c.split, arm: c.arm, calls: 0, usefulHits: 0, acceptableHits: 0, harmfulCount: 0,
      bytes: 0, tokens: 0, latencies: [] as number[], repeatGroups: {} as Record<string, string[]>, families: {} as Record<string, any>,
      positive: {calls: 0, usefulHits: 0}, abstention: {calls: 0, usefulHits: 0},
    });
    g.calls++;
    g.bytes += Buffer.byteLength(JSON.stringify(c.request));
    g.tokens += row.inputTokens ?? 0;
    g.latencies.push(row.latencyMs);
    const useful = c.expected.action!.includes(answer), acceptable = c.meta.oracleAcceptable.includes(answer), harmful = c.meta.oracleHarmful.includes(answer);
    if (useful) g.usefulHits++;
    if (acceptable) g.acceptableHits++;
    if (harmful) g.harmfulCount++;
    const kindBucket = c.meta.caseKind === 'abstention' ? g.abstention : g.positive;
    kindBucket.calls++;
    if (useful) kindBucket.usefulHits++;
    const fam = (g.families[c.family] ??= {calls: 0, usefulHits: 0});
    fam.calls++;
    if (useful) fam.usefulHits++;
    const repeatKey = digest(JSON.stringify(c.request));
    (g.repeatGroups[repeatKey] ??= []).push(answer);
    details.push({
      id: c.id, dispatchId: dispatchIdFor(c), hypothesis: c.hypothesis, split: c.split, family: c.family, unit: c.unit, mirror: c.mirror, arm: c.arm, replicate: c.replicate,
      answer, useful, acceptable, harmful, expected: c.expected.action,
      requestBytes: Buffer.byteLength(JSON.stringify(c.request)), inputTokens: row.inputTokens ?? null, latencyMs: row.latencyMs ?? null,
    });
  }
  for (const g of Object.values(groups) as any[]) {
    g.usefulRate = g.calls ? g.usefulHits / g.calls : 0;
    g.acceptableRate = g.calls ? g.acceptableHits / g.calls : 0;
    g.positiveUsefulRate = g.positive.calls ? g.positive.usefulHits / g.positive.calls : null;
    g.abstentionCorrectRate = g.abstention.calls ? g.abstention.usefulHits / g.abstention.calls : null;
    g.meanBytes = g.calls ? g.bytes / g.calls : 0;
    g.meanTokens = g.calls ? g.tokens / g.calls : 0;
    g.latencies.sort((a: number, b: number) => a - b);
    g.latencyP50Ms = g.latencies[Math.floor(g.latencies.length * .5)];
    g.latencyP95Ms = g.latencies[Math.min(g.latencies.length - 1, Math.floor(g.latencies.length * .95))];
    delete g.latencies;
    const repeatVals = Object.values(g.repeatGroups) as string[][];
    let completeGroups = 0, disagreement = 0;
    for (const vals of repeatVals) { if (vals.length !== 2) continue; completeGroups++; if (new Set(vals).size > 1) disagreement++; }
    g.repeatVariability = {completeGroups, disagreement};
    delete g.repeatGroups;
  }
  return {
    usage: summarizeUsage(root), groups: Object.values(groups), details,
    limitations: 'Mirrors and repeats are correlated instances of the same construction, not independent environments. Useful/acceptable/harmful labels come from the predeclared geometric/logical oracle in oracle.ts, never shown to Jev. Some dispatch ids answer more than one case (identical request bodies); see the duplicate-body report.',
  };
}

function familyFloorOk(g: any, floor: number): boolean {
  return Object.values(g.families).every((f: any) => f.calls === 0 || f.usefulHits / f.calls >= floor);
}
function passesGate(g: any, gate: typeof GATES['S']): boolean {
  return g.harmfulCount <= gate.harmfulCount
    && (g.positive.calls === 0 || g.positiveUsefulRate >= gate.positiveUsefulRate)
    && (g.abstention.calls === 0 || g.abstentionCorrectRate >= gate.abstentionCorrectRate)
    && familyFloorOk(g, gate.familyFloor);
}

/** Predeclared selection rule, implemented exactly as stated in the plan: critical-error-first (the
 * arm(s) with the minimum harmful-action count), then narrowed to the arm(s) that ALSO clear the
 * combined positive/abstention/family-floor gate (not narrowed further to "the best" among them), then
 * the smallest mean request payload among whatever remains, then lexical arm name. */
function chooseFor(groups: any[], hypothesis: 'S' | 'R', expectedArms: number) {
  const dev = groups.filter(g => g.hypothesis === hypothesis && g.split === 'development');
  if (dev.length !== expectedArms) throw new Error(`Expected ${expectedArms} development arms for ${hypothesis}, found ${dev.length}`);
  const minHarmful = Math.min(...dev.map(g => g.harmfulCount));
  const criticalOk = dev.filter(g => g.harmfulCount === minHarmful);
  const passing = criticalOk.filter(g => passesGate(g, GATES[hypothesis]));
  const pool = passing.length ? passing : criticalOk;
  const sorted = [...pool].sort((a, b) => a.meanBytes - b.meanBytes || a.arm.localeCompare(b.arm));
  const chosen = sorted[0];
  return {
    arm: chosen.arm, eligibleArms: sorted.map(g => g.arm), gatePassed: passing.length > 0,
    developmentUsefulRate: chosen.usefulRate, developmentHarmfulCount: chosen.harmfulCount, developmentMeanBytes: chosen.meanBytes,
    developmentPositiveUsefulRate: chosen.positiveUsefulRate, developmentAbstentionCorrectRate: chosen.abstentionCorrectRate,
  };
}
export function choose(summary: {groups: any[]}) {
  return {
    S: chooseFor(summary.groups, 'S', 4), R: chooseFor(summary.groups, 'R', 3),
    development: summary.groups.filter((g: any) => g.split === 'development'),
  };
}
export function gates(summary: {groups: any[]}, selection: {S: {arm: string}; R: {arm: string}}, expectedConfirmationCalls: {S: number; R: number}) {
  const gateFor = (hypothesis: 'S' | 'R') => {
    const arm = selection[hypothesis].arm;
    const g = summary.groups.find((x: any) => x.hypothesis === hypothesis && x.split === 'confirmation' && x.arm === arm);
    const complete = !!g && g.calls === expectedConfirmationCalls[hypothesis];
    return {arm, complete, pass: complete && passesGate(g, GATES[hypothesis]), metrics: g};
  };
  return {S: gateFor('S'), R: gateFor('R')};
}

/** What a constant policy (always the same option, regardless of state) would score against the
 * predeclared oracle. Used by regression tests to prove such policies cannot pass the gates. */
export function constantPolicyStats(all: ScoutCase[], hypothesis: 'S' | 'R', split: 'development' | 'confirmation', arm: string, actionId: string, family?: string) {
  const rows = all.filter(c => c.hypothesis === hypothesis && c.split === split && c.arm === arm && (!family || c.family === family));
  if (!rows.length) throw new Error('No matching cases for constant-policy check');
  const usefulHits = rows.filter(c => c.expected.action!.includes(actionId)).length;
  const harmfulHits = rows.filter(c => c.meta.oracleHarmful.includes(actionId)).length;
  return {calls: rows.length, usefulRate: usefulHits / rows.length, harmfulCount: harmfulHits};
}

/** Renders the analysis into a results-report skeleton: computed tables and gate verdicts filled in,
 * narrative sections left for a human/agent to complete after reading the evidence. */
export function resultsSkeleton(summary: Awaited<ReturnType<typeof analyze>>, selection: ReturnType<typeof choose> | null, verdicts: ReturnType<typeof gates> | null, synthetic: boolean) {
  const groups = [...summary.groups].sort((a: any, b: any) => a.hypothesis.localeCompare(b.hypothesis) || a.split.localeCompare(b.split) || a.arm.localeCompare(b.arm));
  const lines: string[] = [
    '# Scout and range-following encodings: results (skeleton)', '',
    synthetic ? '**SYNTHETIC DRY RUN — every number below is from fabricated responses, not real Jev inference.**' : '',
    '_Generated from analysis.json. Fill in the narrative sections after reading the evidence; do not edit the tables by hand._', '',
    '## Per-arm summary', '',
    '| Hypothesis | Split | Arm | Calls | Useful rate | Positive-case rate | Abstention-correct rate | Harmful count | Mean bytes | Mean tokens | p50 latency ms | p95 latency ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const g of groups as any[]) lines.push(`| ${g.hypothesis} | ${g.split} | ${g.arm} | ${g.calls} | ${(g.usefulRate * 100).toFixed(1)}% | ${g.positiveUsefulRate == null ? 'n/a' : (g.positiveUsefulRate * 100).toFixed(1) + '%'} | ${g.abstentionCorrectRate == null ? 'n/a' : (g.abstentionCorrectRate * 100).toFixed(1) + '%'} | ${g.harmfulCount} | ${g.meanBytes.toFixed(0)} | ${g.meanTokens.toFixed(0)} | ${g.latencyP50Ms ?? 'n/a'} | ${g.latencyP95Ms ?? 'n/a'} |`);
  lines.push('', '## Per-family summary', '', '| Hypothesis | Split | Arm | Family | Calls | Useful hits |', '|---|---|---|---|---|---|');
  for (const g of groups as any[]) for (const [family, fam] of Object.entries(g.families) as [string, any][]) lines.push(`| ${g.hypothesis} | ${g.split} | ${g.arm} | ${family} | ${fam.calls} | ${fam.usefulHits} |`);
  lines.push('', '## Selection and gate verdicts', '');
  lines.push(selection ? `- S selected arm: \`${selection.S.arm}\` (development useful rate ${(selection.S.developmentUsefulRate * 100).toFixed(1)}%, harmful ${selection.S.developmentHarmfulCount}, gate passed on development: ${selection.S.gatePassed})` : '- S selection not yet recorded.');
  lines.push(selection ? `- R selected arm: \`${selection.R.arm}\` (development useful rate ${(selection.R.developmentUsefulRate * 100).toFixed(1)}%, harmful ${selection.R.developmentHarmfulCount}, gate passed on development: ${selection.R.gatePassed})` : '- R selection not yet recorded.');
  lines.push(verdicts ? `- S confirmation gate: **${verdicts.S.pass ? 'PASS' : 'FAIL'}** (complete: ${verdicts.S.complete})` : '- S confirmation gate: not yet evaluated.');
  lines.push(verdicts ? `- R confirmation gate: **${verdicts.R.pass ? 'PASS' : 'FAIL'}** (complete: ${verdicts.R.complete})` : '- R confirmation gate: not yet evaluated.');
  lines.push('', '## Example failures (exact request ids; not useful under the oracle)', '');
  const failures = summary.details.filter((d: any) => !d.useful).slice(0, 25);
  for (const d of failures) lines.push(`- \`${d.id}\` (dispatch \`${d.dispatchId}\`, ${d.hypothesis}/${d.split}/${d.arm}, family ${d.family}): answered \`${d.answer}\`, useful set was \`${JSON.stringify(d.expected)}\`${d.harmful ? ' — **HARMFUL**' : ''}`);
  if (!failures.length) lines.push('_No failing requests recorded yet._');
  lines.push('', '## Limitations', '', summary.limitations, '', '## Narrative (fill in after execution)', '', '- What worked:', '- What failed:', '- Next discriminating test:', '');
  return lines.join('\n');
}
