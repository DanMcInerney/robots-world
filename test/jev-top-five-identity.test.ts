import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentityCases, scoreIdentity, type IdentityState } from '../experiments/jev-top-five/identity.ts';
import type { Answers, Probe } from '../experiments/jev-top-five/types.ts';

const all = generateIdentityCases();
const answersFor = (probe: Probe): Answers => Object.fromEntries(Object.entries(probe.expected).map(([key, values]) => [key, values[0]!]));
const stateOf = (probe: Probe) => probe.request.state as IdentityState;
function byUnit() {
  return [...new Set(all.map(probe => probe.unit))].map(unit => all.filter(probe => probe.unit === unit));
}

// Independent evidence check: enumerate compatible candidates and require all of their fields.
// This oracle reads only the actual delivered measurements and the public matching contract.
function evidenceOutcome(state: IdentityState): string {
  const { extraction, candidates } = state.observation;
  if (!extraction.acquisitionSucceeded || extraction.processedProposalCount < extraction.detectedProposalCount) return 'incomplete';
  const possible = candidates.filter(candidate => Object.entries(state.targetReference.attributes)
    .every(([field, value]) => candidate.attributes[field as keyof typeof candidate.attributes] === null
      || candidate.attributes[field as keyof typeof candidate.attributes] === value));
  if (possible.length === 0) return 'none';
  if (possible.length > 1 || Object.values(possible[0]!.attributes).includes(null)) return 'ambiguous';
  return possible[0]!.id;
}

test('T2 has the fixed 64-request allocation, useful positives, and balanced IDs and candidate order', () => {
  assert.equal(all.length, 64);
  assert.equal(new Set(all.map(probe => probe.id)).size, 64);
  assert.deepEqual(generateIdentityCases(), all);
  for (const split of ['development', 'confirmation']) {
    const rows = all.filter(probe => probe.split === split);
    assert.equal(rows.length, 32);
    assert.equal(new Set(rows.map(probe => probe.unit)).size, 8);
    for (const arm of ['single_choice', 'independent_adequacy']) assert.equal(rows.filter(probe => probe.arm === arm).length, 16);
    const units = rows.filter(probe => probe.arm === 'single_choice' && probe.replicate === 0);
    const positives = units.filter(probe => probe.meta.oracle.supported);
    assert.equal(positives.length, 4);
    const positions = positives.map(probe => stateOf(probe).observation.candidates.findIndex(candidate => candidate.id === probe.expected.target![0]));
    assert.deepEqual(positions.sort(), [0, 0, 1, 1]);
    for (const id of stateOf(units[0]!).observation.candidates.map(candidate => candidate.id)) {
      assert.equal(positives.filter(probe => probe.expected.target![0] === id).length, 2);
      assert.equal(units.filter(probe => stateOf(probe).observation.candidates[0]!.id === id).length, 4);
    }
    assert.deepEqual(units.filter(probe => !probe.meta.oracle.supported).map(probe => probe.expected.target![0]),
      ['none', 'ambiguous', 'ambiguous', 'incomplete']);
  }
});

test('both arms and repeats receive identical goals, reference, evidence, provenance and complete target Choice', () => {
  for (const group of byUnit()) {
    assert.equal(group.length, 4);
    for (const probe of group) {
      assert.deepEqual(probe.request.state, group[0]!.request.state);
      assert.deepEqual(probe.request.questions.target, group[0]!.request.questions.target);
      const state = stateOf(probe);
      const target = probe.request.questions.target!;
      assert.equal(target.type, 'choice');
      assert.deepEqual(Object.keys(target.criteria), [...state.observation.candidates.map(candidate => candidate.id), 'none', 'ambiguous', 'incomplete']);
      for (const candidate of state.observation.candidates) {
        const option: { candidateId: string; targetReferenceId: string } = (target.criteria as Record<string, any>)[candidate.id];
        assert.equal(option.candidateId, candidate.id);
        assert.equal(option.targetReferenceId, state.targetReference.referenceId);
        assert.deepEqual(Object.keys(candidate.attributes).sort(), [...state.evidenceContract.identityFields].sort());
      }
      assert.equal(state.observation.extraction.processedProposalCount, state.observation.candidates.length);
      assert(state.goal.includes(state.targetReference.referenceId));
      if (probe.arm === 'single_choice') assert.deepEqual(Object.keys(probe.request.questions), ['target']);
      else {
        assert.deepEqual(Object.keys(probe.request.questions), ['target', 'adequacy']);
        assert.deepEqual(Object.keys(probe.request.questions.adequacy!.criteria), ['supported_unique_match', 'no_supported_unique_match']);
        assert.match(String(probe.request.questions.adequacy!.instructions), /Independently/);
      }
    }
  }
});

test('desired labels follow actual presented fields, including missing data and unevaluated proposals', () => {
  for (const probe of all) {
    const state = stateOf(probe);
    const derived = evidenceOutcome(state);
    assert.deepEqual(probe.expected.target, [derived], probe.id);
    const supported = state.observation.candidates.some(candidate => candidate.id === derived);
    assert.equal(probe.meta.oracle.supported, supported);
    if (probe.arm === 'independent_adequacy') assert.deepEqual(probe.expected.adequacy,
      [supported ? 'supported_unique_match' : 'no_supported_unique_match']);
  }
  const incomplete = stateOf(all.find(probe => probe.meta.family === 'incomplete_candidate_coverage')!);
  const completed = structuredClone(incomplete);
  completed.observation.extraction.detectedProposalCount = completed.observation.extraction.processedProposalCount;
  assert.equal(evidenceOutcome(incomplete), 'incomplete');
  assert.equal(evidenceOutcome(completed), 'none');
  const missing = structuredClone(stateOf(all.find(probe => probe.meta.family === 'missing_discriminating_attribute')!));
  const unresolved = missing.observation.candidates.find(candidate => candidate.attributes.rearWindowMark === null)!;
  unresolved.attributes.rearWindowMark = missing.targetReference.attributes.rearWindowMark;
  assert.equal(evidenceOutcome(missing), unresolved.id);
});

test('requests contain stipulated measurement evidence, never evaluator oracle or hidden identity labels', () => {
  const forbidden = new Set(['oracle', 'expected', 'expectedTarget', 'groundTruth', 'ground_truth', 'trueIdentity', 'isTarget', 'family', 'supported', 'noMatchReason']);
  function inspect(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbidden.has(key), `Evaluator field leaked into request: ${key}`);
      inspect(child);
    }
  }
  for (const probe of all) {
    inspect(probe.request);
    assert.match(stateOf(probe).scope, /stipulated appearance measurements/);
    assert.match(stateOf(probe).scope, /no camera pixels/);
    assert(!JSON.stringify(probe.request).includes(probe.meta.family));
  }
  const dev = new Set(all.filter(probe => probe.split === 'development').map(probe => JSON.stringify(probe.request.state)));
  for (const probe of all.filter(probe => probe.split === 'confirmation')) assert(!dev.has(JSON.stringify(probe.request.state)));
});

test('original acquisition ages and requested reference survive scoring, including useful old references', () => {
  for (const probe of all) {
    const before = structuredClone(probe);
    const state = stateOf(probe);
    const score = scoreIdentity(probe, answersFor(probe));
    assert.equal(score.correct, true, probe.id);
    assert.equal(score.unsafe, false);
    assert.equal(score.decision, probe.expected.target![0]);
    assert.equal(score.details.referenceAcquiredAtMs, state.targetReference.acquiredAtMs);
    assert.equal(score.details.observationAcquiredAtMs, state.observation.acquiredAtMs);
    assert.equal(score.details.targetReferenceId, state.targetReference.referenceId);
    assert.equal(score.details.referenceAgeMs, probe.meta.referenceAgeMs);
    assert.equal(score.details.observationAgeMs, probe.meta.observationAgeMs);
    assert(state.targetReference.acquiredAtMs < state.targetReference.deliveredAtMs);
    assert(state.observation.acquiredAtMs < state.observation.deliveredAtMs);
    assert(state.observation.deliveredAtMs <= state.decisionAtMs);
    assert.deepEqual(probe, before);
  }
  assert(all.some(probe => probe.meta.oracle.supported && probe.meta.referenceAgeMs >= 180_000));
});

test('the adequacy gate only declines: it cannot repair a wrong candidate or promote an abstention', () => {
  const positive = all.find(probe => probe.arm === 'independent_adequacy' && probe.meta.oracle.supported)!;
  const target = positive.expected.target![0]!;
  const other = stateOf(positive).observation.candidates.find(candidate => candidate.id !== target)!.id;
  const declined = scoreIdentity(positive, { target, adequacy: 'no_supported_unique_match' });
  assert.equal(declined.decision, 'adequacy_declined');
  assert.equal(declined.correct, false);
  assert.equal(declined.details.overAbstention, true);
  assert.equal(declined.details.gateDisagreement, true);
  const wrong = scoreIdentity(positive, { target: other, adequacy: 'supported_unique_match' });
  assert.equal(wrong.decision, other);
  assert.equal(wrong.correct, false);
  assert.equal(wrong.unsafe, true);
  for (const target of ['none', 'ambiguous', 'incomplete']) {
    const abstained = scoreIdentity(positive, { target, adequacy: 'supported_unique_match' });
    assert.equal(abstained.decision, target);
    assert.equal(abstained.details.gateDisagreement, true);
    assert.equal(abstained.correct, false);
  }
});

test('false-lock prevention remains separate from exact no-match reason and absolute-head accuracy', () => {
  for (const negative of all.filter(probe => probe.arm === 'independent_adequacy' && !probe.meta.oracle.supported)) {
    const candidate = stateOf(negative).observation.candidates[0]!.id;
    const blocked = scoreIdentity(negative, { target: candidate, adequacy: 'no_supported_unique_match' });
    assert.equal(blocked.decision, 'adequacy_declined');
    assert.equal(blocked.correct, true);
    assert.equal(blocked.unsafe, false);
    assert.equal(blocked.details.justifiedAbstention, true);
    assert.equal(blocked.details.abstentionReasonCorrect, false);
    assert.equal(blocked.details.expectedNoMatchReason, negative.meta.oracle.noMatchReason);
    const admitted = scoreIdentity(negative, { target: candidate, adequacy: 'supported_unique_match' });
    assert.equal(admitted.decision, candidate);
    assert.equal(admitted.unsafe, true);
    const inconsistent = scoreIdentity(negative, { target: negative.expected.target![0]!, adequacy: 'supported_unique_match' });
    assert.equal(inconsistent.decision, negative.expected.target![0]);
    assert.equal(inconsistent.correct, true);
    assert.equal(inconsistent.details.adequacyCorrect, false);
    assert.equal(inconsistent.details.gateDisagreement, true);
  }
});

test('categorical resolution rejects missing, invented, probabilistic and malformed answers without fallback selection', () => {
  const probe = all.find(probe => probe.arm === 'independent_adequacy' && probe.meta.oracle.supported)!;
  for (const answers of [
    {}, { target: probe.expected.target![0]! }, { target: 'd-unoffered', adequacy: 'supported_unique_match' },
    { target: probe.expected.target![0]!, adequacy: '0.99' },
    { target: probe.expected.target![0]!, adequacy: 'supported_unique_match: 0.99' },
  ]) {
    const score = scoreIdentity(probe, answers as Answers);
    assert.equal(score.decision, 'invalid_response');
    assert.equal(score.correct, false);
    assert.equal(score.unsafe, false);
    assert.equal(score.details.validResponse, false);
  }
});
