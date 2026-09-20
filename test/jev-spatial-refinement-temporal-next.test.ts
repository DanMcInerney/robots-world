import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {generateTemporalNextCases, projectTemporalNextFacts, classifyTemporalNextAnswers, temporalNextManifest, loadTemporalNextRegressionCase, TEMPORAL_NEXT_REGRESSION, type TemporalNextFacts} from '../experiments/jev-spatial-refinement/temporal-next.ts';
import type {RefineCase} from '../experiments/jev-spatial-refinement/types.ts';

const all = generateTemporalNextCases();
function groups(key: (c: RefineCase) => string) {
  const out = new Map<string, RefineCase[]>();
  for (const c of all) out.set(key(c), [...(out.get(key(c)) ?? []), c]);
  return out;
}
const correct = (c: RefineCase) => Object.fromEntries(Object.entries(c.expected).map(([k, v]) => [k, v[0]!]));

test('proposed allocation has 192 fresh requests with separate regression and fixed question intents', () => {
  assert.equal(all.length, 192); assert.equal(new Set(all.map(c => c.id)).size, 192);
  assert.equal(new Set(all.map(c => c.meta.scenario)).size, 32);
  assert.equal(new Set(all.map(c => c.unit)).size, 16);
  assert(all.every(c => c.split !== 'regression' && c.replicate === 0));
  assert.deepEqual(all, generateTemporalNextCases());
  for (const split of ['development', 'confirmation']) {
    const rows = all.filter(c => c.split === split); assert.equal(rows.length, 96);
    assert.equal(new Set(rows.map(c => c.unit)).size, 8);
    for (const arm of new Set(rows.map(c => c.arm))) assert.equal(rows.filter(c => c.arm === arm).length, 16);
  }
  for (const batch of groups(c => c.unit).values()) {
    assert.equal(new Set(batch.map(c => c.split)).size, 1);
    assert.deepEqual(new Set(batch.map(c => c.meta.mirror)), new Set([false, true]));
    const a = batch.find(c => !c.meta.mirror)!.meta.groundFacts as TemporalNextFacts;
    const b = batch.find(c => c.meta.mirror)!.meta.groundFacts as TemporalNextFacts;
    assert.equal(a.motion.leftYaw, -b.motion.leftYaw);
    assert.equal(a.old.forward_right_m[0], b.old.forward_right_m[0]);
    assert.equal(a.old.forward_right_m[1], -b.old.forward_right_m[1]);
  }
  const dev = new Set(all.filter(c => c.split === 'development').map(c => JSON.stringify(c.meta.groundFacts)));
  for (const c of all.filter(c => c.split === 'confirmation')) assert(!dev.has(JSON.stringify(c.meta.groundFacts)));
});

test('three schemas and both question packs preserve precisely the same atomic facts', () => {
  for (const batch of groups(c => c.meta.sameFactsGroup).values()) {
    assert.equal(batch.length, 6);
    const facts = batch.map(c => projectTemporalNextFacts(c.request.state));
    for (let i = 0; i < batch.length; i++) {
      assert.deepEqual(facts[i], facts[0], batch[i]!.id);
      assert.deepEqual(facts[i], batch[i]!.meta.groundFacts);
      const heads = batch[i]!.meta.commonHeads as string[];
      for (const q of heads) {
        assert.deepEqual(batch[i]!.request.questions[q], batch[0]!.request.questions[q]);
        assert.deepEqual(batch[i]!.expected[q], batch[0]!.expected[q]);
      }
    }
    for (const schema of ['typed_null', 'valid_only', 'provenance_usability']) {
      const pair = batch.filter(c => c.meta.schema === schema);
      assert.equal(JSON.stringify(pair[0]!.request.state), JSON.stringify(pair[1]!.request.state));
    }
  }
  const invalid = all.find(c => c.meta.schema === 'typed_null' && !c.meta.epochValid)!;
  const corrupt = structuredClone(invalid.request.state); corrupt.aligned_old_point.observed_at = corrupt.decision_time_ms;
  assert.throws(() => projectTemporalNextFacts(corrupt));
});

test('independent world-coordinate oracle verifies transforms and rejected reset joins', () => {
  for (const c of all.filter(c => c.arm === 'typed_null__fused')) {
    const f = c.meta.groundFacts as TemporalNextFacts;
    const valid = f.old.map_epoch === f.epoch;
    const heading = f.motion.leftYaw * Math.PI / 180;
    // Old heading is East. Convert old [forward,right] into world [East,North].
    const targetWorld = [f.old.forward_right_m[0], -f.old.forward_right_m[1]];
    const observerWorld = [f.motion.translation[0], -f.motion.translation[1]];
    const dE = targetWorld[0]! - observerWorld[0]!, dN = targetWorld[1]! - observerWorld[1]!;
    const forward = dE * Math.cos(heading) + dN * Math.sin(heading);
    const right = dE * Math.sin(heading) - dN * Math.cos(heading);
    if (valid) {
      assert(f.transform.point); assert(Math.abs(f.transform.point[0] - forward) < 1e-6);
      assert(Math.abs(f.transform.point[1] - right) < 1e-6);
      assert.deepEqual(c.expected.old_side, [right < 0 ? 'left' : right > 0 ? 'right' : 'center']);
      assert.equal(f.transform.status, 'available');
    } else {
      assert.equal(f.motion.interEpochTransform, null); assert.equal(f.transform.point, null);
      assert.equal(f.transform.status, 'failed_epoch_join'); assert.equal(f.transform.failure, 'missing_inter_epoch_transform');
      assert.deepEqual(c.expected.old_side, ['unknown']); assert.deepEqual(c.expected.historical_kind, ['unknown']);
    }
    assert.equal(f.transform.observedAt, f.old.observed_at); assert(f.transform.observedAt < f.now);
    assert.equal(f.transform.requestedFrameAt, f.now);
    assert.deepEqual(c.expected.historical_age, [f.now - f.old.observed_at! <= f.maximumHistoryAge ? 'within_limit' : 'beyond_limit']);
    const p = f.hypothesis;
    assert.deepEqual(c.expected.hypothesis_validity, [!p ? 'absent' : p.map_epoch !== f.epoch ? 'invalid_epoch' : p.valid_until! < f.now ? 'expired' : 'active']);
    if (p) assert.equal(p.observed_at, null);
  }
});

test('each schema visibly represents failure without refreshing or manufacturing coordinates', () => {
  for (const c of all) {
    const s = c.request.state, f = projectTemporalNextFacts(s), valid = c.meta.epochValid;
    if (c.meta.schema === 'typed_null') {
      assert.equal(s.aligned_old_point.evidence_kind, 'transformed_old_observation');
      assert.equal(s.transform_result.status, valid ? 'available' : 'failed_epoch_join');
      if (!valid) assert.equal(s.aligned_old_point.forward_right_m, null);
    } else if (c.meta.schema === 'valid_only') {
      assert.equal(s.transformed_records.length, valid ? 1 : 0);
      if (!valid) assert.equal(s.transform_result.forward_right_m, null);
    } else {
      assert.equal(s.historical_source.evidence_origin, 'historical_observation');
      assert.equal(s.coordinate_result.usability, valid ? 'usable' : 'unavailable');
      if (!valid) assert.equal(s.coordinate_result.forward_right_m, null);
    }
    if (!f.present) assert.deepEqual(c.expected.present_location, ['unknown']);
    else assert.equal(f.present.observed_at, f.now);
    assert.deepEqual(c.expected.observation_clock, ['original_acquisition']);
    if (c.meta.questionPack === 'separate') {
      assert.deepEqual(c.expected.historical_origin, ['historical_observation']);
      assert.deepEqual(c.expected.historical_position_usable, [valid ? 'usable' : 'unavailable']);
    }
  }
});

test('scoring separates a label/usability conflict from false-current and invalid-coordinate assertions', () => {
  const fused = all.find(c => !c.meta.epochValid && c.meta.questionPack === 'fused' && !c.meta.groundFacts.present)!;
  const answers = {...correct(fused), historical_kind: 'transformed_old_observation'};
  assert.deepEqual(classifyTemporalNextAnswers(fused, answers), {physicalAssertions: [], questionErrors: ['historical_kind'], labelUsabilityDisagreement: true});
  const wrongSide = classifyTemporalNextAnswers(fused, {...answers, old_side: 'right'});
  assert.deepEqual(wrongSide.physicalAssertions, ['old_side:invalid-coordinate']); assert.equal(wrongSide.labelUsabilityDisagreement, false);
  assert.deepEqual(classifyTemporalNextAnswers(fused, {...correct(fused), historical_kind: 'current_observation'}).physicalAssertions, ['historical_kind:false-current']);
  assert.deepEqual(classifyTemporalNextAnswers(fused, {...correct(fused), present_location: 'right'}).physicalAssertions, ['present_location:false-current']);
  const separate = all.find(c => !c.meta.epochValid && c.meta.questionPack === 'separate')!;
  assert.deepEqual(classifyTemporalNextAnswers(separate, {...correct(separate), historical_position_usable: 'usable'}).physicalAssertions, ['historical_position_usable:invalid-coordinate']);
  assert.deepEqual(classifyTemporalNextAnswers(separate, {...correct(separate), observation_clock: 'current_frame'}).physicalAssertions, ['observation_clock:reset-acquisition']);
  for (const c of all) assert.deepEqual(classifyTemporalNextAnswers(c, correct(c)), {physicalAssertions: [], questionErrors: [], labelUsabilityDisagreement: false});
  assert.throws(() => classifyTemporalNextAnswers(fused, {}));
});

test('legal independent Choice requests keep grading data outside payload and unlike totals separate', () => {
  const perPack = new Map<string, Set<string>>();
  for (const c of all) {
    assert.equal(c.request.model, 'jev-1.13.0');
    assert.match(c.request.state.evidence_notice, /synthetic COMPONENT/); assert.match(c.request.state.assistance, /same code-computed/);
    const heads = Object.keys(c.request.questions);
    assert.equal(heads.length, c.meta.questionPack === 'fused' ? 9 : 10);
    assert.deepEqual(Object.keys(c.expected), heads);
    for (const [id, q] of Object.entries(c.request.questions)) {
      assert.equal(q.type, 'choice'); assert(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255);
      for (const expected of c.expected[id]!) assert(Object.hasOwn(q.criteria, expected));
      assert(!/answer to|selected answer|previous question/i.test(q.instructions));
    }
    const stateBytes = Buffer.byteLength(JSON.stringify(c.request.state));
    assert(stateBytes + Math.max(...Object.values(c.request.questions).map(q => Buffer.byteLength(JSON.stringify(q)))) + 512 <= 32768);
    assert(Buffer.byteLength(JSON.stringify(c.request)) + 512 + 64 * heads.length <= 65536);
    for (const hidden of ['expected', 'groundFacts', 'meta', 'arm', 'split', 'unit', 'sameFactsGroup']) assert(!(hidden in c.request.state));
    const variants = perPack.get(c.meta.questionPack) ?? new Set(); variants.add(JSON.stringify(c.request.questions)); perPack.set(c.meta.questionPack, variants);
  }
  for (const variants of perPack.values()) assert.equal(variants.size, 1);
  const manifest = temporalNextManifest(); assert.equal(manifest.requests, 192);
  assert.match(manifest.plan.status, /^NOT RUN/); assert.equal(manifest.casesSha256.length, 64);
  assert.equal(manifest.plan.primaryCandidate, 'valid_only__separate');
  const primary = all.filter(c => c.arm === manifest.plan.primaryGate.arm && c.split === manifest.plan.primaryGate.split);
  assert.equal(primary.length, manifest.plan.primaryGate.expectedCalls);
  assert.equal(primary.filter(c => c.meta.epochValid).length, manifest.plan.primaryGate.validEpochOldSide.eligible);
  assert.equal(primary.filter(c => c.meta.groundFacts.present !== null).length, manifest.plan.primaryGate.observedCurrentLocation.eligible);
  assert.deepEqual(manifest, temporalNextManifest());
});

const regressionAvailable = existsSync(resolve(TEMPORAL_NEXT_REGRESSION.root, 'responses', TEMPORAL_NEXT_REGRESSION.id + '.json'));
test('exact archived failure remains a separately hashed regression, with original scoring untouched', {skip: !regressionAvailable && 'Archived ignored runtime evidence is unavailable in this checkout.'}, async () => {
  const c = await loadTemporalNextRegressionCase();
  assert.equal(c.split, 'regression'); assert.equal(c.meta.advancementEligible, false); assert.equal(c.meta.alreadyExecuted, true);
  assert(!all.some(fresh => fresh.id === c.id));
  assert.deepEqual(c.request.questions.historical_kind, all.find(c => c.meta.questionPack === 'fused')!.request.questions.historical_kind);
  assert.deepEqual(c.expected.historical_kind, ['unknown']);
  const answers = c.meta.recordedResponse.answers;
  assert.equal(answers.historical_kind.choice, 'transformed_old_observation');
  assert.equal(answers.old_side.choice, 'unknown'); assert.equal(answers.epoch_join.choice, 'invalid');
  assert.equal(answers.present_location.choice, 'unknown'); assert.equal(answers.observation_clock.choice, 'original_acquisition');
  assert.equal(c.request.state.aligned_old_point.forward_right_m, null);
  assert.equal(c.request.state.aligned_old_point.evidence_kind, 'transformed_old_observation');
});
