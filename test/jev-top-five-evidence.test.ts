import assert from 'node:assert/strict';
import test from 'node:test';
import { generateEvidenceCases, scoreEvidence } from '../experiments/jev-top-five/evidence.ts';
import type { Probe } from '../experiments/jev-top-five/types.ts';

const cases = generateEvidenceCases();
const selected = (split: string, index: number, replicate = 0): Probe => cases.find(p =>
  p.split === split && p.unit === `T1-${split}-${index}` && p.arm === 'jev_selected' && p.replicate === replicate)!;
const operationId = (p: Probe, operation: string): string => Object.entries(p.meta.operationKinds)
  .find(([, kind]) => kind === operation)![0];
const assess = (p: Probe, operation: string, decision: string) =>
  scoreEvidence(p, { evidence: operationId(p, operation) }, { decision });

test('T1 is bounded, deterministic, paired and replicated without changing requests', () => {
  assert.equal(cases.length, 64);
  assert.equal(new Set(cases.map(p => p.id)).size, 64);
  assert.deepEqual(generateEvidenceCases(), cases);
  assert.equal(cases.reduce((sum, p) => sum + (p.meta.followupQuestion ? 2 : 1), 0), 96);
  for (const split of ['development', 'confirmation']) {
    const splitCases = cases.filter(p => p.split === split);
    assert.equal(splitCases.length, 32);
    assert.equal(new Set(splitCases.map(p => p.unit)).size, 8);
    for (let i = 0; i < 8; i++) {
      const adaptive = selected(split, i);
      assert.deepEqual(adaptive.request, selected(split, i, 1).request);
      assert.deepEqual(adaptive.meta.followups, selected(split, i, 1).meta.followups);
      const fixed = splitCases.find(p => p.unit === adaptive.unit && p.arm === 'fixed_depth' && p.replicate === 0)!;
      assert.deepEqual(fixed.request, adaptive.meta.followups[operationId(adaptive, 'depth')].request);
      assert.equal(fixed.meta.followupQuestion, undefined);
      assert.equal(Object.keys(adaptive.meta.followups).length, 4);
    }
  }
});

test('T1 freezes only one delivered record per branch and no oracle in requests', () => {
  for (const p of cases.filter(p => p.arm === 'jev_selected')) {
    const requests = [p.request, ...Object.values(p.meta.followups).map((b: any) => b.request)];
    for (const request of requests) {
      const serialized = JSON.stringify(request);
      assert.doesNotMatch(serialized, /oracle|optimalOperations|usefulOperations|branchDecisions|category|expected|fixed_depth|jev_selected/);
      assert.equal(request.state.scope, 'analytic_acquired_records');
      assert.equal(request.state.observationBudget, 1);
      assert.match(JSON.stringify(request.questions), /not extracted camera pixels/);
    }
    assert.equal((p.request.state as any).acquiredObservation, undefined);
    for (const branch of Object.values(p.meta.followups) as any[]) {
      const state = branch.request.state;
      const acquired = state.acquiredObservation;
      assert.ok(Number(Boolean(acquired.marking)) + Number(Boolean(acquired.depth)) <= 1);
      for (const record of [acquired.marking, acquired.depth].filter(Boolean)) {
        assert.equal(record.candidateId, state.candidateId);
        assert.ok(record.acquiredMs <= record.receivedMs);
        assert.ok(record.receivedMs <= state.decisionTimeMs);
      }
    }
  }
});

test('T1 balances source positions and uses fresh confirmation record values', () => {
  for (const split of ['development', 'confirmation']) {
    const positions: Record<string, number[]> = { depth: [0, 0, 0, 0], front: [0, 0, 0, 0], rear: [0, 0, 0, 0], keep: [0, 0, 0, 0] };
    for (let i = 0; i < 8; i++) {
      const p = selected(split, i);
      const question = p.request.questions.evidence!;
      assert.equal(question.type, 'choice');
      Object.values(question.criteria).forEach((op: any, position) => positions[op.operation]![position]!++);
    }
    for (const counts of Object.values(positions)) assert.deepEqual(counts, [2, 2, 2, 2]);
  }
  const developmentIds = new Set(cases.filter(p => p.split === 'development').map(p => (p.request.state as any).candidateId));
  for (const p of cases.filter(p => p.split === 'confirmation')) assert.ok(!developmentIds.has((p.request.state as any).candidateId));
  assert.notDeepEqual(selected('development', 0).request, selected('confirmation', 0).request);
});

test('T1 optimal acquisitions produce the stipulated ultimate decisions in both splits', () => {
  const expected = {
    development: ['approach', 'retreat', 'maintain', 'reject_candidate', 'approach', 'reject_candidate', 'defer', 'maintain'],
    confirmation: ['retreat', 'approach', 'reject_candidate', 'maintain', 'reject_candidate', 'retreat', 'defer', 'maintain'],
  };
  const operations = ['depth', 'depth', 'front', 'front', 'rear', 'rear', 'keep', 'keep'];
  for (const split of ['development', 'confirmation'] as const) {
    for (let i = 0; i < 8; i++) {
      const p = selected(split, i);
      const result = assess(p, operations[i]!, expected[split][i]!);
      assert.equal(result.correct, true, `${split}/${i}`);
      assert.equal(result.unsafe, false);
      assert.equal(result.details.selectionUseful, true);
      assert.equal(result.details.resolutionGained, i < 6);
    }
  }
});

test('T1 grades final decisions and support, not merely the evidence routing label', () => {
  const p = selected('development', 2);
  const correctEvidenceWrongDecision = assess(p, 'front', 'approach');
  assert.equal(correctEvidenceWrongDecision.details.selectionUseful, true);
  assert.equal(correctEvidenceWrongDecision.correct, false);
  assert.equal(correctEvidenceWrongDecision.unsafe, true);
  const honestFailureToResolve = assess(p, 'depth', 'defer');
  assert.equal(honestFailureToResolve.details.evidenceCorrect, true);
  assert.equal(honestFailureToResolve.correct, false);
  assert.equal(honestFailureToResolve.unsafe, false);
  const luckyUnsupportedGuess = assess(p, 'depth', 'maintain');
  assert.equal(luckyUnsupportedGuess.decision, p.meta.oracleDecision);
  assert.equal(luckyUnsupportedGuess.correct, false);
  assert.equal(luckyUnsupportedGuess.details.falseCommitment, true);
  const noFinalAnswer = scoreEvidence(p, { evidence: operationId(p, 'front') });
  assert.equal(noFinalAnswer.correct, false);
  assert.equal(noFinalAnswer.decision, 'missing');
  const invalidSelection = scoreEvidence(p, { evidence: 'not_offered' }, { decision: 'maintain' });
  assert.equal(invalidSelection.correct, false);
  assert.equal(invalidSelection.unsafe, true);
});

test('T1 rejects stale range and preserves unavailable-source and already-sufficient outcomes', () => {
  const stale = selected('development', 0);
  assert.equal(assess(stale, 'keep', 'maintain').unsafe, true);
  assert.equal(assess(stale, 'front', 'defer').details.evidenceCorrect, true);
  const unavailable = selected('development', 6);
  const rearId = operationId(unavailable, 'rear');
  const question = unavailable.request.questions.evidence!;
  assert.equal((question.criteria as Record<string, any>)[rearId].available, false);
  assert.equal(assess(unavailable, 'rear', 'defer').correct, true);
  assert.equal(assess(unavailable, 'rear', 'defer').details.selectionUseful, false);
  assert.equal(assess(unavailable, 'rear', 'defer').details.acquiredRecords, 0);
  assert.equal(assess(unavailable, 'rear', 'maintain').unsafe, true);
  const sufficient = selected('development', 7);
  assert.equal(assess(sufficient, 'keep', 'maintain').correct, true);
  assert.equal(assess(sufficient, 'keep', 'maintain').details.acquiredRecords, 0);
  assert.equal(assess(sufficient, 'depth', 'maintain').correct, true);
  assert.equal(assess(sufficient, 'depth', 'maintain').details.selectionUseful, false);
});

test('T1 fixed acquisition has attainable success and cannot win by always abstaining', () => {
  for (const split of ['development', 'confirmation']) {
    const fixed = cases.filter(p => p.split === split && p.arm === 'fixed_depth' && p.replicate === 0);
    const evidenceFaithful = fixed.map(p => scoreEvidence(p, { decision: p.meta.branchDecisions[p.meta.fixedOperation] }));
    assert.equal(evidenceFaithful.filter(s => s.correct).length, 4);
    assert.equal(evidenceFaithful.filter(s => s.unsafe).length, 0);
    assert.equal(fixed.filter(p => scoreEvidence(p, { decision: 'defer' }).correct).length, 1);
  }
});
