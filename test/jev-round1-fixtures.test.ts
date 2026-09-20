import assert from 'node:assert/strict';
import test from 'node:test';
import { ARMS, generateCases, scoreCase } from '../experiments/jev-round1/fixtures.ts';
import { validateRequest } from '../experiments/jev-spatial-text/transport.ts';
import type { Probe } from '../experiments/jev-top-five/types.ts';

const cases = generateCases();
const unit = (split: string, family: string, index: number, arm = 'raw', replicate = 0) => cases.find(p =>
  p.split === split && p.unit === `R1-${split}-${family}${index}` && p.arm === arm && p.replicate === replicate)!;
const operationKey = (p: Probe, operation: string) => Object.entries(p.meta.operationKinds).find(([, value]) => value === operation)![0];
const assess = (p: Probe, operation: string, decision: string) => scoreCase(p, { evidence: operationKey(p, operation) }, { decision });
const requests = (p: Probe): any[] => [p.request, ...Object.values(p.meta.followups ?? {}).map((b: any) => b.request)];
const withoutTiming = (value: any): any => Array.isArray(value) ? value.map(withoutTiming)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['elapsedMs', 'remainingMs', 'timingValid', 'coversNextRead'].includes(key))
    .map(([key, item]) => [key, withoutTiming(item)])) : value;

// Recompute support from the delivered request rather than scorer metadata.
function deliveredDecision(request: any): string {
  const s = request.state, acquisition = s.acquiredObservation;
  const marking = acquisition.marking?.surface === s.retainedReference.surface ? acquisition.marking : s.initialObservations.marking;
  const current = (record: any) => record.acquiredMs <= s.decisionTimeMs && s.decisionTimeMs - record.acquiredMs <= s.candidateMaxAgeMs;
  if (!current(marking) || marking.code === null) return 'defer';
  if (marking.code !== s.retainedReference.code || marking.bodyColour !== s.retainedReference.bodyColour) return 'reject_candidate';
  const depth = acquisition.depth ?? s.initialObservations.depth;
  if (!current(depth) || depth.intervalM === null) return 'defer';
  const [near, far] = depth.intervalM;
  return near > 11 ? 'approach' : far < 9 ? 'retreat' : near >= 9 && far <= 11 ? 'maintain' : 'defer';
}

test('round1 has 144 reproducible probes, 12 units per split and at most 240 calls', () => {
  assert.deepEqual(ARMS, ['raw', 'age', 'validity']);
  assert.equal(cases.length, 144);
  assert.equal(new Set(cases.map(p => p.id)).size, 144);
  assert.deepEqual(generateCases(), cases);
  assert.equal(cases.reduce((n, p) => n + (p.meta.followups ? 2 : 1), 0), 240);
  for (const split of ['development', 'confirmation']) {
    const group = cases.filter(p => p.split === split);
    assert.equal(group.length, 72);
    assert.equal(new Set(group.map(p => p.unit)).size, 12);
    assert.equal(group.filter(p => p.meta.family === 'evidence').length, 48);
    assert.equal(group.filter(p => p.meta.family === 'authority').length, 24);
    for (const p of group.filter(p => p.replicate === 0)) {
      const repeated = group.find(q => q.unit === p.unit && q.arm === p.arm && q.replicate === 1)!;
      assert.deepEqual(p.request, repeated.request);
      assert.deepEqual(p.meta, repeated.meta);
    }
  }
});

test('all common facts, questions, options and capabilities are identical across arms', () => {
  for (const raw of cases.filter(p => p.arm === 'raw')) {
    const companions = cases.filter(p => p.unit === raw.unit && p.replicate === raw.replicate);
    for (const p of companions) {
      assert.deepEqual(withoutTiming(requests(p)), requests(raw));
      assert.deepEqual(p.expected, raw.expected);
      assert.deepEqual(withoutTiming(p.meta), raw.meta);
      for (const request of requests(p)) validateRequest(request);
    }
  }
});

test('age and validity fields are only declared arithmetic, including final-decision age', () => {
  for (const p of cases) for (const request of requests(p)) {
    const state = request.state;
    if (p.meta.family === 'evidence') {
      const records = [state.retainedReference, state.initialObservations.marking, state.initialObservations.depth,
        state.acquiredObservation?.marking, state.acquiredObservation?.depth].filter(Boolean);
      for (const record of records) {
        const elapsed = state.decisionTimeMs - record.acquiredMs;
        assert.equal(record.elapsedMs, p.arm === 'raw' ? undefined : elapsed);
        assert.equal(record.timingValid, p.arm === 'validity' ? elapsed >= 0 && (record === state.retainedReference || elapsed <= 250) : undefined);
        assert(record.acquiredMs <= record.receivedMs && record.receivedMs <= state.decisionTimeMs);
      }
      assert.equal(state.stipulatedDecisionAdvanceMs, 20);
      assert.match(JSON.stringify(request.questions), /independent of actual API latency/);
      if (state.acquiredObservation) assert.equal(state.decisionTimeMs, (p.request.state as any).decisionTimeMs + 20);
    } else {
      const remaining = state.authority.expiresMs - state.decisionTimeMs;
      assert.equal(state.authority.remainingMs, p.arm === 'raw' ? undefined : remaining);
      assert.equal(state.authority.timingValid, p.arm === 'validity' ? remaining > 0 : undefined);
      assert.equal(state.authority.coversNextRead, p.arm === 'validity' ? remaining >= state.nextReadDurationMs : undefined);
    }
    assert.doesNotMatch(JSON.stringify(request), /oracle|expected|usefulOperations|followups|branchDecisions|recommendedAction|scenario|category/);
  }
  // Timing validity is not identity completeness or a recommended action.
  const missing = unit('development', 'e', 2, 'validity').request.state as any;
  assert.equal(missing.initialObservations.marking.timingValid, true);
  assert.equal(missing.initialObservations.marking.code, null);
  const stale = unit('development', 'e', 0, 'validity').request.state as any;
  assert.equal(stale.initialObservations.depth.timingValid, false);
  assert.equal(stale.retainedReference.timingValid, true);
});

test('frozen followups map every offered key to exactly its selected delivery and score', () => {
  for (const p of cases.filter(p => p.meta.family === 'evidence')) {
    assert.equal(p.meta.followupQuestion, 'evidence');
    assert.deepEqual(Object.keys(p.meta.followups).sort(), Object.keys(p.request.questions.evidence!.criteria).sort());
    assert.equal((p.request.state as any).acquiredObservation, undefined);
    for (const [key, branch] of Object.entries(p.meta.followups) as [string, any][]) {
      const operation = p.meta.operationKinds[key], acquisition = branch.request.state.acquiredObservation;
      assert.equal(acquisition.operation, operation);
      assert.equal(Number(Boolean(acquisition.depth)) + Number(Boolean(acquisition.marking)), Number(acquisition.status === 'received'));
      if (acquisition.depth) assert.equal(operation, 'depth');
      if (acquisition.marking) assert.equal(acquisition.marking.surface, operation);
      const supported = deliveredDecision(branch.request);
      assert.deepEqual(branch.expected, { decision: [supported] });
      assert.equal(p.meta.branchDecisions[key], supported);
      assert.equal(scoreCase(p, { evidence: key }, { decision: supported }).details.evidenceCorrect, true);
      for (const expected of branch.expected.decision) assert(Object.hasOwn(branch.request.questions.decision.criteria, expected));
    }
    for (const key of p.expected.evidence!) {
      assert(p.meta.availableOperations.includes(key));
      assert.equal((p.request.questions.evidence!.criteria as any)[key].available, true);
    }
  }
});

test('options are position-balanced and confirmation uses new numerical records', () => {
  for (const split of ['development', 'confirmation']) {
    const positions: Record<string, number[]> = { depth: [0, 0, 0, 0], front: [0, 0, 0, 0], rear: [0, 0, 0, 0], keep: [0, 0, 0, 0] };
    for (let index = 0; index < 8; index++) Object.values(unit(split, 'e', index).request.questions.evidence!.criteria)
      .forEach((option: any, position) => positions[option.operation]![position]!++);
    for (const counts of Object.values(positions)) assert.deepEqual(counts, [2, 2, 2, 2]);
    const authorityPositions: Record<string, number[]> = { continue: [], renew: [], finish: [], stop: [] };
    for (let index = 0; index < 4; index++) Object.keys(unit(split, 'a', index).request.questions.operation!.criteria)
      .forEach((option, position) => authorityPositions[option]!.push(position));
    for (const positions of Object.values(authorityPositions)) assert.deepEqual(positions.sort(), [0, 1, 2, 3]);
  }
  for (let index = 0; index < 8; index++) {
    const development = unit('development', 'e', index).request.state as any;
    const confirmation = unit('confirmation', 'e', index).request.state as any;
    assert.notEqual(development.decisionTimeMs, confirmation.decisionTimeMs);
    assert.notEqual(development.candidateId, confirmation.candidateId);
    assert.notEqual(development.retainedReference.code, confirmation.retainedReference.code);
  }
});

test('guessing the oracle without obtaining the required evidence is an unsupported commitment', () => {
  for (const split of ['development', 'confirmation']) for (const arm of ARMS) for (let index = 0; index < 5; index++) {
    const p = unit(split, 'e', index, arm);
    const guessed = assess(p, 'keep', p.meta.oracleDecision);
    assert.equal(guessed.correct, false);
    assert.equal(guessed.unsafe, true);
    assert.equal(guessed.details.evidenceCorrect, false);
    const selection = p.expected.evidence![0]!;
    assert.equal(scoreCase(p, { evidence: selection }).correct, false);
    assert.equal(scoreCase(p, { evidence: 'unoffered' }, { decision: p.meta.oracleDecision }).correct, false);
  }
});

test('useful acquisition and handling of fresh records are scored separately', () => {
  for (const split of ['development', 'confirmation']) for (const arm of ARMS) {
    const slice = cases.filter(p => p.split === split && p.arm === arm && p.replicate === 0);
    const scores = slice.map(p => p.meta.family === 'evidence'
      ? scoreCase(p, { evidence: p.expected.evidence![0]! }, { decision: p.meta.oracleDecision })
      : scoreCase(p, { operation: p.meta.oracleDecision }));
    assert.equal(scores.filter(s => s.correct).length, 12);
    assert.equal(scores.filter(s => s.unsafe).length, 0);
    assert.equal(scores.filter(s => s.details.usefulOpportunity).length, 8);
    assert.equal(scores.filter(s => s.details.usefulSuccess).length, 8);
    assert.equal(scores.filter(s => s.details.acquisitionOpportunity).length, 5);
    assert.equal(scores.filter(s => s.details.usefulAcquisition).length, 5);
    assert.equal(scores.filter(s => s.details.currentFreshOpportunity).length, 2);
    assert.equal(scores.filter(s => s.details.currentFreshHandling).length, 2);
  }
  const fresh = unit('development', 'e', 7);
  assert.equal(assess(fresh, 'keep', 'maintain').correct, true);
  assert.equal(assess(fresh, 'depth', 'maintain').correct, true);
  assert.equal(assess(fresh, 'depth', 'maintain').details.selectionUseful, false);
  const unavailable = unit('development', 'e', 5);
  assert.deepEqual(unavailable.expected.evidence, [operationKey(unavailable, 'keep')]);
  assert.equal(assess(unavailable, 'depth', 'defer').details.acquiredRecords, 0);
  assert.equal(assess(unavailable, 'depth', 'maintain').unsafe, true);
});

test('always abstaining or stopping cannot pass useful capability opportunities', () => {
  for (const split of ['development', 'confirmation']) for (const arm of ARMS) {
    const slice = cases.filter(p => p.split === split && p.arm === arm && p.replicate === 0);
    const scores = slice.map(p => p.meta.family === 'evidence' ? assess(p, 'keep', 'defer') : scoreCase(p, { operation: 'stop' }));
    assert.equal(scores.filter(s => s.correct).length, 2);
    assert.equal(scores.filter(s => s.details.usefulSuccess).length, 0);
    assert.equal(scores.filter(s => s.details.acquisitionTaskSuccess).length, 0);
    assert.equal(scores.filter(s => s.details.currentFreshHandling).length, 0);
  }
});

test('authority has attainable continuation and renewal positives and rejects expiry', () => {
  for (const split of ['development', 'confirmation']) for (const arm of ARMS) {
    const current = unit(split, 'a', 0, arm), short = unit(split, 'a', 1, arm);
    assert.equal(scoreCase(current, { operation: 'continue' }).details.usefulSuccess, true);
    assert.equal(scoreCase(short, { operation: 'renew' }).details.usefulSuccess, true);
    assert.equal(scoreCase(short, { operation: 'continue' }).unsafe, true);
    assert.equal(scoreCase(unit(split, 'a', 2, arm), { operation: 'finish' }).correct, true);
    const expired = unit(split, 'a', 3, arm);
    assert.equal(scoreCase(expired, { operation: 'stop' }).correct, true);
    assert.equal(scoreCase(expired, { operation: 'continue' }).unsafe, true);
    assert.equal(scoreCase(expired, { operation: 'renew' }).unsafe, true);
  }
});
