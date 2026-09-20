import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCases, STAGES, type Case} from '../experiments/jev-spatial-text/fixtures.ts';
import {canonicalManifest, decodeFacts, encodeFacts, FORMATS, rotateOldPoint, YAW, yawOutcomes, plausibleYawActions, type Facts} from '../experiments/jev-spatial-text/encodings.ts';

const all = STAGES.flatMap(generateCases);
const one = (stage: string, split: string, index: number, arm: string) => all.find(c => c.id === `${stage}-${split}-${String(index).padStart(2, '0')}-${arm}`)!;
const groups = (cases: Case[], key: (c: Case) => string): Map<string, Case[]> => {
  const out = new Map<string, Case[]>();
  for (const c of cases) {const k = key(c); out.set(k, [...(out.get(k) ?? []), c]);}
  return out;
};

test('frozen component allocation is deterministic, bounded and split by whole paired units', () => {
  assert.equal(all.length, 1440);
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
  assert.deepEqual(all, STAGES.flatMap(generateCases));
  assert.throws(() => generateCases('unknown'), /Unknown component stage/);
  const counts = Object.fromEntries(STAGES.map(stage => [stage, all.filter(c => c.stage === stage).length]));
  assert.deepEqual(counts, {encoding: 288, temporal: 288, execution: 288, forecast: 144, reflection: 144, controls: 288});
  for (const split of ['development', 'selection', 'confirmation']) assert.equal(all.filter(c => c.split === split).length, 480);
  for (const unit of groups(all, c => c.unit).values()) {
    assert.equal(new Set(unit.map(c => c.split)).size, 1);
    assert.equal(new Set(unit.map(c => c.family)).size, 1);
    assert.deepEqual(new Set(unit.map(c => c.meta.mirror)), new Set([false, true]));
  }
  for (const family of groups(all, c => `${c.stage}:${c.family}`).values()) assert.equal(new Set(family.map(c => c.split)).size, 1);
});

test('all requests are legal independently worded Choice fixtures with evaluator keys excluded', () => {
  for (const c of all) {
    assert.equal(c.provenance, 'synthetic-component');
    assert.equal(c.request.model, 'jev-1.13.0');
    assert.match(c.request.state.evidence_notice, /synthetic COMPONENT/);
    assert.match(c.request.state.evidence_notice, /No rendered images/);
    const questions = Object.entries(c.request.questions);
    assert(questions.length >= 4 && questions.length <= 8, c.id);
    assert.deepEqual(Object.keys(c.expected).sort(), Object.keys(c.request.questions).sort());
    assert(JSON.stringify(c.request).length < 18000, c.id);
    for (const [id, q] of questions) {
      assert.equal(q.type, 'choice'); assert(q.instructions.length > 30);
      assert(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255);
      assert(c.expected[id]!.length > 0);
      for (const answer of c.expected[id]!) assert(answer in q.criteria, `${c.id}/${id}/${answer}`);
    }
    for (const hidden of ['factManifest', 'expected', 'physicalOutcomes', 'independentUnit', 'comparison_label', 'recommended_action']) assert(!(hidden in c.request.state), `${c.id} leaks ${hidden}`);
  }
});

test('four serialization dialects reversibly retain precisely the same facts and questions', () => {
  for (const batch of groups(all.filter(c => c.stage === 'encoding'), c => c.meta.sameFactsGroup).values()) {
    assert.equal(batch.length, 4);
    const manifests = batch.map(c => canonicalManifest(decodeFacts(c.request.state.representation, c.meta.format)));
    assert.equal(new Set(manifests).size, 1);
    for (const c of batch) {
      assert.equal(c.meta.factManifest, manifests[0]);
      assert.deepEqual(c.expected, batch[0]!.expected);
      assert.deepEqual(c.request.questions, batch[0]!.request.questions);
    }
  }
  const edgeFacts: Facts = {quote: 'value "quoted" | dotted.', nil: null, array: ['one', 'two'], negative: -0.125, bool: false};
  for (const format of FORMATS) assert.deepEqual(decodeFacts(encodeFacts(edgeFacts, format), format), edgeFacts);
});

test('encoding answer keys follow interval evidence, not object order, unknown-space guesses or mirrors', () => {
  for (const c of all.filter(c => c.stage === 'encoding' && c.arm === 'numeric')) {
    const f = decodeFacts(c.request.state.representation, 'numeric');
    const [lo, hi] = f['obj-k_body_right_interval_m'] as number[];
    const correctSide = hi! < 0 ? 'left' : lo! > 0 ? 'right' : lo === 0 && hi === 0 ? 'center' : 'unknown';
    assert.deepEqual(c.expected.side, [correctSide]);
    const pole = f.pole_radial_range_interval_m as number[], wall = f.wall_radial_range_interval_m as number[];
    assert.deepEqual(c.expected.nearest, [pole[1]! < wall[0]! ? 'pole' : wall[1]! < pole[0]! ? 'wall' : 'unknown']);
    assert.deepEqual(c.expected.sector, ['unknown']);
  }
  for (const split of ['development', 'selection', 'confirmation']) {
    const cases = all.filter(c => c.stage === 'encoding' && c.split === split && c.arm === 'numeric');
    assert.deepEqual(new Set(cases.flatMap(c => c.expected.side!)), new Set(['left', 'right', 'center', 'unknown']));
  }
});

test('historical transforms independently conserve world position through rotation and translation', () => {
  assert.deepEqual(rotateOldPoint(4, 2, 90), [-2, 4]);
  assert.deepEqual(rotateOldPoint(4, 2, -90), [2, -4]);
  assert.deepEqual(rotateOldPoint(4, 2, 180), [-4, -2]);
  for (const c of all.filter(c => c.stage === 'temporal' && c.arm === 'aligned_history')) {
    const {oldPoint: old, transformedOldPoint: current, measuredYaw: yaw, translationOldBody: t} = c.meta;
    const a = yaw * Math.PI / 180;
    // Independent inverse: express the current-frame point back in the original frame.
    const reconstructedForward = Math.cos(a) * current[0] + Math.sin(a) * current[1] + t[0];
    const reconstructedRight = -Math.sin(a) * current[0] + Math.cos(a) * current[1] + t[1];
    assert(Math.abs(reconstructedForward - old[0]) < 1e-7);
    assert(Math.abs(reconstructedRight - old[1]) < 1e-7);
    if (!c.meta.validFrame) {
      assert.equal(c.request.state.declared_derived_features.old_point_current_body_forward_right_m, null);
      assert.deepEqual(c.expected.old_side, ['unknown']);
    }
  }
});

test('identical presents retain opposite histories and no-history answers respect unavailable evidence', () => {
  for (const batch of groups(all.filter(c => c.stage === 'temporal'), c => c.meta.sameCurrentGroup).values()) {
    assert.equal(new Set(batch.map(c => JSON.stringify(c.request.state.current))).size, 1);
    const historyPair = batch.filter(c => c.arm === 'dated_raw');
    if (historyPair[0]!.meta.validFrame) assert.notDeepEqual(historyPair[0]!.expected.old_side, historyPair[1]!.expected.old_side);
    for (const c of batch) {
      assert.deepEqual(c.expected.present, ['unknown']);
      if (c.arm === 'current_only') {assert(!c.request.state.history); assert.deepEqual(c.expected.old_side, ['unknown']); assert.deepEqual(c.expected.prior, ['no_evidence']);}
      if (c.arm === 'predicted_history') assert.match(c.request.state.motion_hypothesis.source, /not a measurement/);
    }
  }
});

test('linked, loose and shuffled histories preserve exact records while unlinked evidence requires abstention', () => {
  const normalize = (c: Case) => {
    const entries: any[] = c.arm === 'linked' ? Object.values(c.request.state.diary).flat() : c.request.state.diary;
    return JSON.stringify([...entries].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  };
  for (const batch of groups(all.filter(c => c.stage === 'execution' && c.arm !== 'unlinked'), c => c.meta.sameFactsGroup).values()) {
    assert.equal(batch.length, 3); assert.equal(new Set(batch.map(normalize)).size, 1);
    for (const c of batch) assert.deepEqual(c.expected, batch[0]!.expected);
  }
  const statuses = new Set(all.filter(c => c.stage === 'execution' && c.arm === 'linked').flatMap(c => c.expected.application!));
  assert.deepEqual(statuses, new Set(['requested', 'admitted', 'applied', 'rejected', 'partial', 'expired']));
  for (const c of all.filter(c => c.stage === 'execution' && c.arm === 'unlinked')) {
    assert.deepEqual(c.expected.application, ['unknown']); assert.deepEqual(c.expected.completion, ['unknown']);
    for (const event of c.request.state.diary.events) assert(!('command_id' in event));
  }
  assert.deepEqual(one('execution', 'development', 6, 'linked').expected.application, ['rejected']);
  assert.deepEqual(one('execution', 'development', 8, 'linked').expected.application, ['partial']);
  assert.deepEqual(one('execution', 'development', 8, 'linked').expected.completion, ['no']);
});

test('stationary yaw geometry respects turn sign, complete FOV rectangle, category boundaries and ties', () => {
  assert.deepEqual(yawOutcomes([12, 12], -10, [0, 0]), ['center']);
  assert.deepEqual(yawOutcomes([12, 12], 30, [0, 0]), ['absent']);
  assert.deepEqual(yawOutcomes([34, 34], 0, [0, 0]), ['right']);
  assert.deepEqual(yawOutcomes([34.001, 34.001], 0, [0, 0]), ['absent']);
  assert.deepEqual(yawOutcomes([-5, 5], 0, [0, 0]), ['center']);
  assert.deepEqual(yawOutcomes([-5.001, 5.001], 0, [0, 0]), ['left', 'center', 'right']);
  assert.deepEqual(new Set(plausibleYawActions(20, [0, 0])), new Set(['right_10', 'right_30']));
  for (const c of all.filter(c => c.stage === 'forecast' && c.arm === 'stationary')) {
    for (const [action, yaw] of Object.entries(YAW)) {
      const result = c.meta.bearing + yaw;
      const answer = Math.abs(result) > 34 ? 'absent' : result < -5 ? 'left' : result > 5 ? 'right' : 'center';
      assert.deepEqual(c.expected[`forecast_${action}`], [answer], c.id);
    }
  }
});

test('all seven forecast branches have explicit conditions and ambiguity is epistemic abstention', () => {
  for (const c of all.filter(c => c.stage === 'forecast')) {
    assert.equal(Object.keys(c.request.questions).length, 8);
    assert.equal(Object.keys(c.meta.forecastBranchByAction).length, 7);
    assert.equal(c.meta.forecastPhysicalCategories.includes('abstain'), false);
    for (const [action, id] of Object.entries(c.meta.forecastBranchByAction) as [string, string][]) {
      assert.match(c.request.questions[id]!.instructions, new RegExp(`command ${action} applies completely`));
      const outcomes = c.meta.physicalOutcomes[id];
      assert.deepEqual(c.expected[id], outcomes.length === 1 ? outcomes : ['abstain']);
    }
  }
  const c = one('forecast', 'development', 0, 'uncertain_motion');
  assert(c.expected.action!.length > 1);
  assert(Object.values(c.expected).some(answers => answers.includes('abstain')));
  // Dense independent minimization check for all integer endpoint/half-degree boundaries.
  for (const fixture of all.filter(c => c.stage === 'forecast' && c.arm === 'uncertain_motion')) {
    const winners = new Set<string>();
    for (let drift = -12; drift <= 12; drift += 0.5) {
      const errors = Object.entries(YAW).map(([id, yaw]) => [id, Math.abs(fixture.meta.bearing + drift + yaw)] as const);
      const best = Math.min(...errors.map(([, error]) => error));
      for (const [id, error] of errors) if (error === best) winners.add(id);
    }
    assert.deepEqual(new Set(fixture.expected.action), winners);
  }
});

test('reflection distinguishes mismatch, prior abstention, untested and unscorable evidence', () => {
  const cases = all.filter(c => c.stage === 'reflection');
  assert.deepEqual(new Set(cases.flatMap(c => c.expected.assessment!)), new Set(['match', 'mismatch', 'not_tested', 'abstained', 'unknown']));
  for (const c of cases) {
    const state = c.request.state;
    if (c.meta.scenario === 3) assert.deepEqual(c.expected.assessment, ['abstained']);
    if ([4, 5, 6, 7].includes(c.meta.scenario)) assert.deepEqual(c.expected.assessment, ['unknown']);
    if (c.arm === 'raw_episode') assert(!state.declared_derived_features);
    else {
      const elapsed = state.command.completed_ms === null ? null : state.after_observation.acquired_ms - state.command.completed_ms;
      assert.equal(state.declared_derived_features.acquisition_after_completion_ms, elapsed);
      assert.equal(state.declared_derived_features.delivery_age_ms, 40);
    }
  }
});

test('ID, row-order and goal controls preserve meaning and explicitly condition target/action questions', () => {
  for (const original of all.filter(c => c.stage === 'controls' && c.arm === 'original')) {
    const index = original.meta.pairedIndex, split = original.split;
    const renamed = one('controls', split, index, 'renamed'), reordered = one('controls', split, index, 'reordered'), swapped = one('controls', split, index, 'goal_swap');
    assert.deepEqual(original.expected, reordered.expected);
    for (const [oldId, newId] of Object.entries(renamed.meta.questionAliases) as [string, string][]) {
      if (oldId !== 'target') assert.deepEqual(original.expected[oldId], renamed.expected[newId]);
      assert(renamed.request.questions[newId]!.instructions.length > 30);
    }
    assert.deepEqual(original.request.state.objects, swapped.request.state.objects);
    assert.notDeepEqual(original.expected.action, swapped.expected.action);
    assert.deepEqual(original.expected.conditional, swapped.expected.conditional);
    assert.match(original.request.questions.conditional!.instructions, /CONDITIONAL branch for the BLUE marker/);
    assert.notDeepEqual(original.expected.retain, ['none']);
  }
});
