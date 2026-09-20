import assert from 'node:assert/strict';
import test from 'node:test';
import { allCases, executeProbe, scoreProbe, type ResultRow } from '../experiments/jev-top-five/run.ts';
import { summarize } from '../experiments/jev-top-five/analyze.ts';
import { runFreshnessExperiment } from '../experiments/jev-top-five/lifecycle.ts';
import type { Request, Response } from '../experiments/jev-strategies/strategies.ts';

function response(request: Request, chosen: Record<string, string>): Response {
  return { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id,
    { type: 'choice', choice: chosen[id]!, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === chosen[id] ? 1 : 0])) }])) } as Response;
}
test('campaign has exact bounds and repetitions remain distinct', () => {
  const cases = allCases(); assert.equal(cases.length, 320);
  assert.equal(cases.reduce((n, c) => n + (c.meta.followups ? 2 : 1), 0), 352);
  for (const split of ['development', 'confirmation']) assert.equal(cases.filter(c => c.split === split).length, 160);
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
});

test('adaptive evidence dispatches only the actual selected frozen branch', async () => {
  const probe = allCases().find(c => c.technique === 'T1' && c.meta.followups)!;
  for (const selected of Object.keys(probe.meta.followups)) {
    const calls: { request: Request; id: string }[] = [];
    const branch = probe.meta.followups[selected];
    const result = await executeProbe(probe, async (request, id) => {
      calls.push({ request, id });
      return response(request, calls.length === 1 ? { evidence: selected } : { decision: branch.expected.decision[0] });
    });
    assert.equal(calls.length, 2); assert.deepEqual(calls[1]!.request, branch.request);
    assert.equal(result.selectedEvidence, selected); assert.equal(calls[1]!.id, `${probe.id}--followup`);
    assert(!JSON.stringify(calls.map(c => c.request)).includes('oracleDecision'));
  }
});

test('missing evidence cannot pass inference gates', () => {
  const rows: ResultRow[] = allCases().map(c => ({ id: c.id, technique: c.technique, split: c.split, unit: c.unit, arm: c.arm, replicate: c.replicate, status: 'missing', requestIds: [c.id] }));
  const summary = summarize(rows, runFreshnessExperiment());
  for (const gate of summary.gates.filter(g => g.technique !== 'T3')) assert.equal(gate.pass, false);
  assert.equal(summary.errorRows.length, 320);
});

test('completed always-abstain, always-hold and always-close policies cannot pass advance gates', () => {
  for (const technique of ['T2', 'T4', 'T5']) {
    const rows: ResultRow[] = allCases().filter(c => c.technique === technique).map(c => {
      let answers: Record<string, string>;
      if (technique === 'T2') answers = c.arm === 'independent_adequacy'
        ? { target: 'none', adequacy: 'no_supported_unique_match' }
        : { target: (c.request.state as any).observation.candidates.find((x: any) => x.id !== c.expected.target![0]).id };
      else if (technique === 'T4') answers = c.arm === 'conditional'
        ? { mode: 'hold', maneuver: 'v0_0' }
        : { action: c.unit === 'u0' && c.meta.copies === 8 ? 'v0_0' : c.expected.action![0]! };
      else answers = c.arm === 'explicit-lifecycle' ? { action: 'm3' }
        : { action: Object.keys(c.request.questions.action!.criteria).find(k => !c.expected.action!.includes(k))! };
      return { id: c.id, technique: c.technique, split: c.split, unit: c.unit, arm: c.arm, replicate: c.replicate,
        status: 'completed', requestIds: [c.id], initialAnswers: answers, score: scoreProbe(c, answers), latencyMs: 10, inputTokens: 100 };
    });
    const summary = summarize(rows, runFreshnessExperiment());
    const gate = summary.gates.find(g => g.technique === technique)!;
    assert.equal(gate.complete, true); assert.equal(gate.pass, false, technique);
    if (technique === 'T4') {
      const groups = summary.groups.filter(g => g.split === 'confirmation');
      assert.equal(groups.find(g => g.arm === 'flat')!.correct, 30);
      assert.equal(groups.find(g => g.arm === 'conditional')!.correct, 16);
      assert.equal(groups.find(g => g.arm === 'conditional')!.usefulRequiredTurns, 0);
    }
  }
});

test('oracle decisions can complete every capable arm without manufacturing an incremental win', async () => {
  const rows: ResultRow[] = [];
  for (const c of allCases()) {
    const initial = Object.fromEntries(Object.entries(c.expected).map(([q, values]) => [q, values[0]!]));
    const result = await executeProbe(c, async (request, id) => id === c.id ? response(request, initial)
      : response(request, Object.fromEntries(Object.entries(c.meta.followups[initial.evidence!].expected as Record<string,string[]>).map(([q, values]) => [q, values[0]!]))));
    rows.push({ id: c.id, technique: c.technique, split: c.split, unit: c.unit, arm: c.arm, replicate: c.replicate, status: 'completed', ...result, latencyMs: 10, inputTokens: 100 });
  }
  const summary = summarize(rows, runFreshnessExperiment());
  for (const id of ['T2', 'T4', 'T5']) assert.equal(summary.gates.find(g => g.technique === id)!.pass, false, `${id}: identical perfect outcomes do not establish a treatment gain`);
  for (const group of summary.groups.filter(g => g.technique !== 'T1')) assert.equal(group.correct, group.planned);
});
