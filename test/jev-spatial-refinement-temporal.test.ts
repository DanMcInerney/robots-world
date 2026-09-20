import test from 'node:test';
import assert from 'node:assert/strict';
import {generateTemporalCases, transformHistoricalPoint, historicalPointInCurrentFrame, projectTemporalFacts, type TemporalCase} from '../experiments/jev-spatial-refinement/temporal.ts';

const cases = generateTemporalCases();
function groupBy(key: (c: TemporalCase) => string) {
  const groups = new Map<string, TemporalCase[]>();
  for (const c of cases) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  return groups;
}

test('temporal refinement contains 32 fresh scenarios in 16 mirrored units and 256 independently identified calls', () => {
  assert.equal(cases.length, 256);
  assert.equal(new Set(cases.map(c => c.id)).size, 256);
  assert.equal(new Set(cases.map(c => c.meta.scenario)).size, 32);
  assert.equal(new Set(cases.map(c => c.unit)).size, 16);
  assert.deepEqual(cases, generateTemporalCases());
  for (const split of ['development', 'confirmation']) {
    assert.equal(cases.filter(c => c.split === split).length, 128);
    assert.equal(new Set(cases.filter(c => c.split === split).map(c => c.unit)).size, 8);
  }
  for (const unit of groupBy(c => c.unit).values()) {
    assert.equal(unit.length, 16);
    assert.equal(new Set(unit.map(c => c.split)).size, 1);
    assert.deepEqual(new Set(unit.map(c => c.meta.mirror)), new Set([false, true]));
    const pair = unit.filter(c => c.arm === 'raw_mixed' && c.replicate === 0);
    const a = pair[0]!.meta.groundFacts, b = pair[1]!.meta.groundFacts;
    assert.equal(a.leftYawDeg, -b.leftYawDeg);
    assert.equal(a.translation[0], b.translation[0]);
    assert.equal(a.translation[1], -b.translation[1]);
    assert.equal(a.old.point[0], b.old.point[0]);
    assert.equal(a.old.point[1], -b.old.point[1]);
  }
  const development = new Set(cases.filter(c => c.split === 'development').map(c => JSON.stringify(c.meta.groundFacts)));
  for (const c of cases.filter(c => c.split === 'confirmation')) assert(!development.has(JSON.stringify(c.meta.groundFacts)));
});

test('SE2 transformation handles independent known translations and left/right rotations', () => {
  assert.deepEqual(transformHistoricalPoint([7, 5], [2, 1], 0), [5, 4]);
  assert.deepEqual(transformHistoricalPoint([7, 5], [2, 1], 90), [-4, 5]);
  assert.deepEqual(transformHistoricalPoint([7, 5], [2, 1], -90), [4, -5]);
  assert.deepEqual(transformHistoricalPoint([7, 5], [2, 1], 180), [-5, -4]);
  assert.deepEqual(transformHistoricalPoint([3, -2], [3, -2], 127), [0, 0]);
  assert.deepEqual(transformHistoricalPoint([2 + Math.SQRT1_2, -1 - Math.SQRT1_2], [2, -1], 45), [1, 0]);
  for (const c of cases.filter(c => c.arm === 'computed_explicit' && c.replicate === 0)) {
    const f = projectTemporalFacts(c.request.state);
    if (f.old.epoch !== f.epoch) continue;
    const [forward, right] = f.aligned!.point!, angle = f.leftYawDeg * Math.PI / 180;
    // Independent inverse/world reconstruction, not a second call to the implementation.
    assert(Math.abs(Math.cos(angle) * forward + Math.sin(angle) * right + f.translation[0] - f.old.point[0]) <= 1e-6, c.id);
    assert(Math.abs(-Math.sin(angle) * forward + Math.cos(angle) * right + f.translation[1] - f.old.point[1]) <= 1e-6, c.id);
  }
});

test('same-facts schema projection preserves every source, timestamp, epoch, hypothesis and coordinate', () => {
  for (const group of groupBy(c => c.meta.sameFactsGroup).values()) {
    assert.equal(group.length, 4);
    const projections = group.map(c => projectTemporalFacts(c.request.state));
    for (let i = 0; i < group.length; i++) {
      assert.deepEqual(projections[i], projections[0], group[i]!.id);
      assert.deepEqual(projections[i], group[i]!.meta.payloadFacts);
      assert.deepEqual(group[i]!.expected, group[0]!.expected);
      assert.deepEqual(group[i]!.request.questions, group[0]!.request.questions);
    }
  }
  for (const group of groupBy(c => c.meta.baseFactsGroup).values()) {
    const raw = group.find(c => c.arm === 'raw_explicit')!, computed = group.find(c => c.arm === 'computed_explicit')!;
    const rawFacts = projectTemporalFacts(raw.request.state), computedFacts = projectTemporalFacts(computed.request.state);
    assert.equal(rawFacts.aligned, null);
    assert.deepEqual({...computedFacts, aligned: null}, rawFacts);
    assert.match(computed.request.state.assistance, /Code supplies the rigid transform/);
    assert.match(raw.request.state.assistance, /no aligned old-point coordinates/);
  }
  const corrupt = structuredClone(cases.find(c => c.arm === 'computed_explicit')!.request.state);
  corrupt.aligned_old_point.evidence_kind = 'current_observation';
  assert.throws(() => projectTemporalFacts(corrupt), /Unknown aligned temporal record source/);
});

test('byte-identical repeats and common independent Choice vocabulary have no evaluator metadata in payload', () => {
  for (const group of groupBy(c => `${c.meta.scenario}-${c.arm}`).values()) {
    assert.equal(group.length, 2);
    assert.deepEqual(group.map(c => c.replicate), [0, 1]);
    assert.equal(JSON.stringify(group[0]!.request), JSON.stringify(group[1]!.request));
    assert.notEqual(group[0]!.id, group[1]!.id);
  }
  assert.equal(new Set(cases.map(c => JSON.stringify(c.request.questions))).size, 1);
  for (const c of cases) {
    assert.equal(c.request.model, 'jev-1.13.0');
    assert.match(c.request.state.evidence_notice, /synthetic COMPONENT/);
    assert.match(c.request.state.evidence_notice, /sibling answers are unavailable/);
    assert(Buffer.byteLength(JSON.stringify(c.request)) < 16000, c.id);
    assert.deepEqual(Object.keys(c.expected), Object.keys(c.request.questions));
    for (const [id, question] of Object.entries(c.request.questions)) {
      assert.equal(question.type, 'choice');
      assert(Object.keys(question.criteria).length >= 2 && Object.keys(question.criteria).length <= 255);
      for (const answer of c.expected[id]!) assert(answer in question.criteria, `${c.id}/${id}/${answer}`);
      assert(!/answer to|selected answer|previous question/i.test(question.instructions));
    }
    for (const key of ['expected', 'groundFacts', 'allowedAnswers', 'meta', 'arm', 'replicate', 'split', 'unit']) assert(!(key in c.request.state));
    for (const id of ['historical_kind', 'current_kind', 'hypothesis_kind']) assert.deepEqual(Object.keys(c.request.questions[id]!.criteria), ['current_observation', 'transformed_old_observation', 'motion_extrapolation', 'unknown']);
  }
});

test('invalid resets cannot be joined or gain valid coordinates merely because transform numbers exist', () => {
  let invalid = 0, valid = 0;
  for (const c of cases) {
    const f = projectTemporalFacts(c.request.state);
    assert.equal(f.interEpochTransform, null);
    if (f.old.epoch === f.epoch) {valid++; assert.notEqual(historicalPointInCurrentFrame(f), null); continue;}
    invalid++;
    assert.notEqual(f.translation[0], 0);
    assert.notEqual(f.leftYawDeg, 0);
    assert.equal(historicalPointInCurrentFrame(f), null);
    assert.deepEqual(c.expected.old_side, ['unknown']);
    assert.deepEqual(c.expected.historical_kind, ['unknown']);
    assert.deepEqual(c.expected.epoch_join, ['invalid']);
    if (f.aligned) assert.equal(f.aligned.point, null);
    if (f.prediction) assert.deepEqual(c.expected.hypothesis_validity, ['invalid_epoch']);
    // A new-epoch observation remains a valid current acquisition despite the invalid history join.
    if (f.present) assert.deepEqual(c.expected.present_location, ['center']);
  }
  assert.equal(invalid, 96); assert.equal(valid, 160);
});

test('alignment preserves original acquisition and stale history never becomes present evidence', () => {
  for (const c of cases) {
    const f = projectTemporalFacts(c.request.state), observedAt = f.old.observedAt!;
    assert(observedAt < f.now);
    if (f.aligned) {
      assert.equal(f.aligned.observedAt, observedAt);
      assert.equal(f.aligned.frameAt, f.now);
      assert.notEqual(f.aligned.observedAt, f.aligned.frameAt);
    }
    assert.deepEqual(c.expected.historical_age, [f.now - observedAt <= f.historyAgeLimitMs ? 'within_limit' : 'beyond_limit']);
    assert.deepEqual(c.expected.observation_clock, ['original_acquisition']);
    if (f.present === null) {
      assert.deepEqual(c.expected.present_location, ['unknown']);
      assert.deepEqual(c.expected.current_kind, ['unknown']);
    } else {
      assert.equal(f.present.observedAt, f.now);
      assert.deepEqual(c.expected.current_kind, ['current_observation']);
      const right = f.present.point[1];
      assert.deepEqual(c.expected.present_location, [right === 0 ? 'center' : right < 0 ? 'left' : 'right']);
    }
  }
  for (const split of ['development', 'confirmation']) {
    const rows = cases.filter(c => c.split === split && c.arm === 'computed_explicit' && c.replicate === 0);
    assert.deepEqual(new Set(rows.flatMap(c => c.expected.present_location!)), new Set(['unknown', 'left', 'right', 'center']));
    assert.deepEqual(new Set(rows.flatMap(c => c.expected.historical_age!)), new Set(['within_limit', 'beyond_limit']));
    assert(rows.some(c => c.expected.historical_age![0] === 'within_limit' && c.expected.epoch_join![0] === 'invalid'));
    assert(rows.some(c => c.expected.historical_age![0] === 'beyond_limit' && c.expected.epoch_join![0] === 'valid'));
  }
});

test('motion extrapolation origin and eligibility remain separate from transformed observations', () => {
  for (const split of ['development', 'confirmation']) {
    const rows = cases.filter(c => c.split === split && c.arm === 'raw_mixed' && c.replicate === 0);
    assert.deepEqual(new Set(rows.flatMap(c => c.expected.hypothesis_validity!)), new Set(['absent', 'active', 'expired', 'invalid_epoch']));
    for (const c of rows) {
      const f = projectTemporalFacts(c.request.state);
      if (f.prediction === null) {assert.deepEqual(c.expected.hypothesis_kind, ['unknown']); continue;}
      assert.equal(f.prediction.observedAt, null);
      assert.equal(f.prediction.forecastFor, f.now);
      assert.equal(f.prediction.source, 'p7');
      assert.deepEqual(c.expected.hypothesis_kind, ['motion_extrapolation']);
      if (!f.present) assert.deepEqual(c.expected.present_location, ['unknown']);
      if (f.prediction.epoch === f.epoch) {
        const p = historicalPointInCurrentFrame(f)!;
        const seconds = (f.now - f.old.observedAt!) / 1000;
        assert(Math.abs(f.prediction.point[0] - p[0] - f.prediction.velocity![0] * seconds) < 1e-6);
        assert(Math.abs(f.prediction.point[1] - p[1] - f.prediction.velocity![1] * seconds) < 1e-6);
        assert.notDeepEqual(f.prediction.point, p);
        assert.deepEqual(c.expected.historical_kind, ['transformed_old_observation']);
      }
    }
  }
});
