import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateCases, STAGES, type Case } from './fixtures.ts';
import { createMeter, ROOT, CEILINGS, digest, freezeStage, ledger, summarizeUsage, validateRequest, readCompleted, verifyFrozenStage } from './transport.ts';

export function orderedCases(stages = STAGES): Case[] {
  // Rotate arms within the matched fixture; preserve a declared reproducible order.
  const result: Case[] = [];
  for (const stage of stages) {
    const groups = new Map<string, Case[]>();
    for (const item of generateCases(stage)) {
      const key = `${item.split}-${item.meta?.pairedIndex}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    let n = 0;
    for (const group of groups.values()) {
      const offset = n++ % group.length;
      result.push(...group.slice(offset), ...group.slice(0, offset));
    }
  }
  return result;
}
export function qualify(cases = orderedCases()) {
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  const ids = new Set<string>();
  for (const item of cases) {
    validateRequest(item.request);
    assert.deepEqual(Object.keys(item.expected).sort(), Object.keys(item.request.questions).sort());
    for (const [q, allowed] of Object.entries(item.expected)) {
      assert(allowed.length > 0 && allowed.every(id => Object.hasOwn(item.request.questions[q]!.criteria, id)));
    }
    assert(!JSON.stringify(item.request).includes('factManifest'), 'Evaluator manifest leaked');
    ids.add(item.unit + ':' + item.split);
  }
  return { cases: cases.length, questions: cases.reduce((n, c) => n + Object.keys(c.expected).length, 0),
    unitSplitGroups: ids.size, stages: Object.fromEntries(STAGES.map(s => [s, cases.filter(c => c.stage === s).length])),
    notice: 'Synthetic component fixtures; no camera accuracy, actual self-experience or mission success claim.' };
}
export async function analyze(cases = orderedCases(), root = ROOT) {
  const selected = new Set(cases.map(c => c.stage));
  const frozen = await verifyFrozenStage(existsSync(resolve(root, 'freezes/components-all/freeze.json')) ? 'components-all' : 'components-' + [...selected][0], root);
  assert.deepEqual(frozen.manifest.cases.filter((c: Case) => selected.has(c.stage)), JSON.parse(JSON.stringify(cases)), 'Frozen evaluator or order differs');
  const calls = new Map(ledger(root).map(r => [r.id, r]));
  const rows: any[] = [], examples: any[] = [];
  for (const c of cases) {
    if (calls.get(c.id)?.status !== 'completed') continue;
    const response = await readCompleted(c.request, c.id, calls.get(c.id), root);
    for (const [question, accepted] of Object.entries(c.expected)) {
      const answer = response.answers[question], correct = accepted.includes(answer.choice);
      const canonicalQuestion = Object.entries(c.meta?.questionAliases ?? {}).find(([, alias]) => alias === question)?.[0] ?? question;
      const row = { id: c.id, stage: c.stage, split: c.split, family: c.family, unit: c.unit, arm: c.arm, question: canonicalQuestion, actualQuestion: question,
        questionKind: c.meta?.questionKinds?.[question] ?? 'factual', correct: +correct, choice: answer.choice, accepted,
        confidence: answer.confidence, requestFile: `requests/${c.id}.json`, responseFile: `responses/${c.id}.json` };
      rows.push(row);
      if (!correct) examples.push(row);
    }
  }
  const aggregate = (key: (row: any) => string) => {
    const groups = new Map<string, any[]>();
    for (const row of rows) { const k = key(row); groups.set(k, [...(groups.get(k) ?? []), row]); }
    return [...groups].map(([group, values]) => ({ group, correct: values.reduce((n, r) => n + r.correct, 0), n: values.length,
      accuracy: values.reduce((n, r) => n + r.correct, 0) / values.length, units: new Set(values.map(r => r.unit)).size,
      highConfidenceErrors: values.filter(r => !r.correct && r.confidence >= .9).length }));
  };
  // Unit means keep repeated questions/mirrors from becoming independent observations.
  const unitGroups = new Map<string, any[]>();
  for (const row of rows) { const k = [row.stage, row.split, row.unit, row.arm].join('|'); unitGroups.set(k, [...(unitGroups.get(k) ?? []), row]); }
  const units = [...unitGroups].map(([key, values]) => ({ key, stage: values[0].stage, split: values[0].split,
    unit: values[0].unit, arm: values[0].arm, score: values.reduce((n, r) => n + r.correct, 0) / values.length }));
  const comparisons: any[] = [];
  for (const stage of STAGES) for (const split of ['development', 'selection', 'confirmation']) {
    const data = units.filter(u => u.stage === stage && u.split === split), arms = [...new Set(data.map(u => u.arm))];
    const baseline = arms[0];
    for (const arm of arms.slice(1)) {
      const differences = data.filter(u => u.arm === arm).flatMap(u => {
        const b = data.find(b => b.arm === baseline && b.unit === u.unit); return b ? [u.score - b.score] : [];
      });
      if (!differences.length) continue;
      let random = 17441;
      const sample = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
      const bootstrap = Array.from({ length: 2000 }, () => differences.reduce(sum => sum + differences[Math.floor(sample() * differences.length)]!, 0) / differences.length).sort((a, b) => a - b);
      comparisons.push({ stage, split, arm, baseline, pairedUnits: differences.length,
        meanDifference: differences.reduce((a, b) => a + b, 0) / differences.length,
        descriptiveBootstrap95: [bootstrap[50], bootstrap[1949]], wins: differences.filter(d => d > 0).length,
        losses: differences.filter(d => d < 0).length, ties: differences.filter(d => d === 0).length,
        caveat: 'Exploratory unit bootstrap; one structural generator per split, no multiple-comparison correction or population-generalization claim.' });
    }
  }
  const result = { generatedAt: new Date().toISOString(), qualification: qualify(cases), usage: summarizeUsage(root),
    completedFixtures: new Set(rows.map(r => r.id)).size, totalScoredAnswers: rows.length,
    incompleteFixtures: cases.filter(c => calls.get(c.id)?.status !== 'completed').map(c => ({ id: c.id, status: calls.get(c.id)?.status ?? 'not-started' })),
    scoreNote: 'Multiple accepted physical controls are scored by membership. Forecast abstention is a choice and excluded from any physical-outcome Brier claim. All intervals are exploratory.',
    byArm: aggregate(r => `${r.stage}/${r.split}/${r.arm}`), byQuestion: aggregate(r => `${r.stage}/${r.split}/${r.arm}/${r.question}`),
    comparisons, errorExamples: examples, rows };
  await writeFile(resolve(root, 'component-results.json'), JSON.stringify(result, null, 2));
  const lines = ['# Jev spatial text component results', '', result.scoreNote, '', `Completed ${result.completedFixtures}/${cases.length} synthetic fixtures; ${rows.length} scored answers.`, '',
    '| Stage / split / arm | Correct | Accuracy | Units | Errors at confidence ≥0.9 |', '|---|---:|---:|---:|---:|',
    ...result.byArm.map(r => `| ${r.group} | ${r.correct}/${r.n} | ${(r.accuracy * 100).toFixed(1)}% | ${r.units} | ${r.highConfidenceErrors} |`)];
  await writeFile(resolve(root, 'component-results.md'), lines.join('\n') + '\n');
  return { completedFixtures: result.completedFixtures, totalScoredAnswers: rows.length, usage: result.usage, byArm: result.byArm };
}
async function main() {
  const [command = 'qualify', selected = 'all'] = process.argv.slice(2), stages = selected === 'all' ? STAGES : [selected];
  assert(stages.every(s => STAGES.includes(s)));
  const cases = orderedCases(stages);
  if (command === 'qualify') { console.log(JSON.stringify(qualify(cases), null, 2)); return; }
  await mkdir(ROOT, { recursive: true });
  if (command === 'analyze') { console.log(JSON.stringify(await analyze(cases), null, 2)); return; }
  assert.equal(command, 'run'); assert(process.argv.includes('--real'), 'Explicit --real required');
  const qualification = qualify(cases), stage = 'components-' + selected;
  await freezeStage(stage, { qualification, ceilings: CEILINGS, cases, orderSha256: digest(JSON.stringify(cases.map(c => c.id))),
    analysis: 'Run all splits without prompt adaptation; report confirmation separately. Evaluate unit-paired contrasts; no inference retries.' });
  const meter = createMeter({ key: process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '' });
  try {
    let n = 0;
    for (const c of cases) {
      await meter.judge(c.request, c.id); n++;
      if (n % 24 === 0 || n === cases.length) console.log(JSON.stringify({ event: 'component-progress', fixtureCompleted: n, total: cases.length, stage: c.stage, split: c.split, ...summarizeUsage() }));
    }
  } finally { meter.close(); }
  console.log(JSON.stringify(await analyze(cases)));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
