import assert from 'node:assert/strict';
import test from 'node:test';
import { ARMS, generateCases, scoreCase, summarize } from '../experiments/jev-round2/decisions.ts';
import type { Probe, SensorRecord } from '../experiments/jev-round2/protocol.ts';
import { validateRequest } from '../experiments/jev-spatial-text/transport.ts';

function record(overrides: Partial<SensorRecord> = {}): SensorRecord {
  return { id: 'synthetic-stereo', sceneId: 'synthetic-scene', split: 'development', method: 'stereo',
    leftPath: 'synthetic-left.png', rightPath: 'synthetic-right.png',
    observation: { source: 'rendered_rgb', targetStatus: 'single', axialDepthIntervalM: [9.8, 10.2],
      axialDepthM: 10, validFraction: .9, bearingDeg: 0, intervalMeaning: 'Synthetic test interval; no acquired evidence.' },
    evaluation: { referenceAxialDepthM: 10, family: 'synthetic' }, ...overrides };
}
function fixtures(): SensorRecord[] {
  return (['development', 'confirmation'] as const).flatMap(split => Array.from({ length: 12 }, (_, scene) =>
    (['stereo', 'monocular'] as const).map(method => {
      const r = record({ id: `synthetic-${split}-${scene}-${method}`, sceneId: `synthetic-${split}-${scene}`, split, method });
      if (scene >= 9) { r.observation.targetStatus = scene === 9 ? 'missing' : scene === 10 ? 'ambiguous' : 'single';
        r.observation.axialDepthIntervalM = null; r.observation.axialDepthM = null; r.evaluation.referenceAxialDepthM = null; }
      return r;
    }))).flat();
}
const cases = generateCases(fixtures());
const key = (probe: Probe, action: string): string => Object.entries(probe.meta.options)
  .find(([, option]) => (option as any).action === action)![0];
const actions = (probe: Probe) => probe.expected.map(id => probe.meta.options[id].action).sort();
const choose = (probe: Probe, action: string) => scoreCase(probe, key(probe, action));

test('48 sensor records yield exactly 192 deterministic probes with 96 per split and six complete actions', () => {
  assert.equal(fixtures().length, 48);
  assert.equal(cases.length, 192);
  assert.equal(new Set(cases.map(probe => probe.id)).size, 192);
  assert.deepEqual(generateCases(fixtures()), cases);
  assert.deepEqual(ARMS, ['measured', 'consequences']);
  for (const split of ['development', 'confirmation']) assert.equal(cases.filter(probe => probe.split === split).length, 96);
  for (const probe of cases) {
    validateRequest(probe.request);
    assert.deepEqual(Object.keys(probe.request.questions), ['action']);
    assert.equal(Object.keys(probe.request.questions.action.criteria).length, 6);
    assert(Object.keys(probe.request.questions.action.criteria).length <= 255);
    assert.deepEqual(Object.values(probe.meta.options).map((option: any) => option.action).sort(),
      ['advance1m', 'advance2m', 'hold', 'observe', 'retreat1m', 'retreat2m']);
    assert.deepEqual(Object.values(probe.meta.options).map((option: any) => option.deltaM).filter(value => value !== null).sort((a: any, b: any) => a - b), [-2, -1, 0, 1, 2]);
    assert.match(probe.request.state.goal, new RegExp(`exactly ${probe.goalM} m`));
    assert.match(probe.request.questions.action.instructions.join(' '), /worst-case absolute difference/);
  }
});

test('truth and unrecognized data injection cannot change any request or interpretation key', () => {
  const originals = fixtures(), injected = structuredClone(originals);
  for (const r of injected) {
    r.evaluation = { referenceAxialDepthM: 99999, family: 'PRIVATE_GROUND_TRUTH_SENTINEL', recommendedAction: 'retreat2m' };
    Object.assign(r.observation, { privateTruth: 'PRIVATE_GROUND_TRUTH_SENTINEL', recommendedAction: 'retreat2m' });
    r.leftPath = 'PRIVATE_GROUND_TRUTH_SENTINEL'; r.rightPath = 'PRIVATE_GROUND_TRUTH_SENTINEL';
  }
  const a = generateCases(originals), b = generateCases(injected);
  a.forEach((probe, index) => {
    assert.deepEqual(b[index].request, probe.request);
    assert.deepEqual(b[index].expected, probe.expected);
    assert(!JSON.stringify(probe.request).includes('PRIVATE_GROUND_TRUTH_SENTINEL'));
  });
});

test('matched arms differ only by all five unranked sensor-derived predicted intervals', () => {
  for (const measured of cases.filter(probe => probe.arm === 'measured')) {
    const consequences = cases.find(probe => probe.recordId === measured.recordId && probe.goalM === measured.goalM && probe.arm === 'consequences')!;
    const stripped = structuredClone(consequences.request);
    const predictions = stripped.state.predictedAfterAxialDepthIntervalM;
    delete stripped.state.predictedAfterAxialDepthIntervalM;
    assert.deepEqual(stripped, measured.request);
    assert.deepEqual(measured.expected, consequences.expected);
    assert.deepEqual(measured.meta.options, consequences.meta.options);
    assert.equal(Object.keys(predictions).length, 5);
    for (const [id, option] of Object.entries(consequences.meta.options) as [string, any][]) {
      if (option.deltaM === null) assert(!Object.hasOwn(predictions, id));
      else assert.deepEqual(predictions[id], measured.meta.usableDepth
        ? measured.request.state.sensorObservation.axialDepthIntervalM.map((z: number) => z - option.deltaM) : null);
    }
    assert(!/recommend|rank|expectedAction|referenceAxial|goalError|reward/i.test(JSON.stringify(measured.request)));
    assert(!/recommend|rank|expectedAction|referenceAxial|goalError|reward/i.test(JSON.stringify(consequences.request)));
  }
});

test('same sensor facts require opposite displacements for the two exact goals; opaque mappings vary', () => {
  const probes = generateCases([record()]);
  assert.deepEqual(actions(probes[0]), ['advance2m']);
  assert.deepEqual(actions(probes[2]), ['retreat2m']);
  assert.deepEqual(probes[0].request.state.sensorObservation, probes[2].request.state.sensorObservation);
  assert.deepEqual(probes[0].meta.options, probes[2].meta.options);
  for (const arm of ARMS) {
    const goals = probes.filter(probe => probe.arm === arm).map(probe => {
      const request = structuredClone(probe.request);
      delete request.state.goal; delete request.state.goalAxialDepthM;
      return request;
    });
    assert.deepEqual(goals[0], goals[1], 'goal pair changes only the two exact goal fields');
  }
  const methods = generateCases([record(), record({ id: 'synthetic-monocular', method: 'monocular' })]);
  assert(methods.every(probe => JSON.stringify(probe.meta.options) === JSON.stringify(methods[0].meta.options)));
  assert(new Set(cases.map(probe => JSON.stringify(probe.meta.options))).size > 10);
  const rows = probes.map(probe => scoreCase(probe, probe.expected[0]));
  for (const group of summarize(rows).groups) {
    assert.equal(group.goalResponsiveness.changeRequiredPairs, 1);
    assert.equal(group.goalResponsiveness.correctlyResponsivePairs, 1);
  }
  const alwaysAdvance = summarize(probes.map(probe => choose(probe, 'advance2m')));
  assert(alwaysAdvance.groups.every(group => group.goalResponsiveness.correctlyResponsivePairs === 0));
});

test('ambiguous, missing and absent or malformed depths require observe despite tempting numbers', () => {
  const observations = [
    { targetStatus: 'ambiguous' as const }, { targetStatus: 'missing' as const }, { axialDepthIntervalM: null },
    ...[[12, 8], [0, 10], [-1, 5], [NaN, 10], [9, Infinity]].map(values => ({ axialDepthIntervalM: values as [number, number] })),
  ];
  for (const overrides of observations) {
    const r = record(); Object.assign(r.observation, overrides);
    for (const probe of generateCases([r])) {
      assert.deepEqual(actions(probe), ['observe']);
      assert.equal(choose(probe, 'observe').interpretationCorrect, true);
      assert.equal(choose(probe, 'advance1m').unsupportedMotion, true);
      assert.equal(choose(probe, 'hold').unsupportedMotion, false);
      assert.equal(choose(probe, 'hold').unsupportedCommitment, true);
      assert.equal(choose(probe, 'hold').interpretationCorrect, false);
    }
  }
});

test('interpretation recomputes minimax from delivered interval independently and accepts numeric ties', () => {
  for (const interval of [[8.5, 8.5], [7, 10], [10.5, 10.5], [5, 20], [8.4999999999, 8.5000000001]] as [number, number][]) {
    const r = record(); r.observation.axialDepthIntervalM = interval;
    for (const probe of generateCases([r])) {
      const goal = probe.request.state.goalAxialDepthM, values = probe.request.state.sensorObservation.axialDepthIntervalM;
      const errors = Object.entries(probe.request.state.actions).filter(([, option]) => (option as any).deltaM !== null)
        .map(([id, option]) => ({ id, value: Math.max(Math.abs(values[0] - (option as any).deltaM - goal), Math.abs(values[1] - (option as any).deltaM - goal)) }));
      const best = Math.min(...errors.map(row => row.value));
      assert.deepEqual(probe.expected, errors.filter(row => row.value <= best + 1e-9).map(row => row.id));
      assert.equal(choose(probe, 'observe').interpretationCorrect, false);
      for (const id of probe.expected) assert.equal(scoreCase(probe, id).interpretationCorrect, true);
    }
  }
  const r = record(); r.observation.axialDepthIntervalM = [8.5, 8.5];
  assert.deepEqual(actions(generateCases([r])[0]), ['advance1m', 'hold']);
});

test('wrong perception can give correct interpretation and wrong physical action; abstention is not rescued', () => {
  const r = record({ evaluation: { referenceAxialDepthM: 6, family: 'synthetic-wrong-depth' } });
  const probe = generateCases([r])[0];
  const row = choose(probe, 'advance2m');
  assert.equal(row.interpretationCorrect, true);
  assert.equal(row.physicalCorrect, false);
  assert.equal(row.finalReferenceDepthM, 4);
  assert.equal(row.usefulCorrect, true);
  assert.deepEqual(row.physicalExpectedActions, ['retreat2m']);
  assert.equal(choose(probe, 'retreat2m').physicalCorrect, true);
  assert.equal(choose(probe, 'retreat2m').interpretationCorrect, false);
  assert.equal(choose(probe, 'observe').interpretationCorrect, false);
  assert.equal(choose(probe, 'observe').physicalCorrect, false);
});

test('unknown reference preserves null physical scores and is excluded from the physical denominator', () => {
  const r = record({ evaluation: { referenceAxialDepthM: null, family: 'synthetic' } });
  const probes = generateCases([r]);
  for (const probe of probes) for (const answer of [...Object.keys(probe.meta.options), undefined, 'unoffered']) {
    const score = scoreCase(probe, answer);
    assert.equal(score.physicalCorrect, null);
    assert.equal(score.usefulPhysicalCorrect, null);
    assert.equal(score.finalReferenceDepthM, null);
    assert.equal(score.physicalExpectedActions, null);
  }
  const report = summarize(probes.map(probe => scoreCase(probe, probe.expected[0])));
  assert.equal(report.totals.physicalDenominator, 0);
  assert.equal(report.totals.physicalRate, null);
  assert.equal(scoreCase(probes[0], undefined).completed, false);
  assert.equal(scoreCase(probes[0], 'unoffered').interpretationCorrect, false);
});

test('summary preserves denominators and separates useful performance from all-observe and all-hold policies', () => {
  const oracle = cases.map(probe => scoreCase(probe, probe.expected[0]));
  const report = summarize(oracle);
  assert.equal(report.groups.length, 8);
  assert.equal(report.totals.completed, 192);
  assert.equal(report.totals.interpretationCorrect, 192);
  assert.equal(report.totals.unknown, 48);
  assert.equal(report.totals.supportDenom, 144);
  assert.equal(report.totals.physicalDenominator, 144);
  assert.equal(report.totals.useful, 144);
  assert.equal(report.totals.usefulRate, 1);
  assert.equal(report.gates.pooled.pass, false, 'equal perfect arms do not show a gain');
  for (const action of ['observe', 'hold', 'advance2m']) {
    const failed = summarize(cases.map(probe => choose(probe, action)));
    assert.equal(failed.gates.pooled.pass, false);
    assert(failed.gates.byMethod.every(gate => !gate.pass));
  }
  const improved = summarize(cases.map(probe => probe.arm === 'measured' ? choose(probe, 'observe') : scoreCase(probe, probe.expected[0])));
  assert.equal(improved.gates.pooled.pass, true);
  assert(improved.gates.byMethod.every(gate => gate.pass));
  assert.deepEqual(summarize(cases.map((probe, index) => ({ probe, score: oracle[index] }))), report);
  assert.deepEqual(summarize(cases.map(probe => ({ probe, answer: probe.expected[0] }))), report);
  assert.equal(summarize([]).gates.pooled.pass, false);
});

test('one unsupported hold fails the gate even when overall interpretation remains above 90 percent', () => {
  let inserted = false;
  const rows = cases.map(probe => {
    if (probe.arm === 'measured') return choose(probe, 'observe');
    if (!inserted && probe.split === 'confirmation' && !probe.meta.usableDepth) {
      inserted = true;
      return choose(probe, 'hold');
    }
    return scoreCase(probe, probe.expected[0]);
  });
  const gate = summarize(rows).gates.pooled;
  assert.equal(gate.primary.unsupported, 0, 'hold is not a nonzero displacement');
  assert.equal(gate.primary.unsupportedCommitments, 1);
  assert.equal(gate.interpretationPass, true);
  assert.equal(gate.usefulPass, true);
  assert.equal(gate.gainPass, true);
  assert.equal(gate.unsupportedPass, false);
  assert.equal(gate.pass, false);
});

test('hold is useful only as a correct zero action, while tied hold/motion cases are outside useful gate denominator', () => {
  const r = record(); r.observation.axialDepthIntervalM = [7.9, 8.1]; r.evaluation.referenceAxialDepthM = 8;
  const hold = generateCases([r])[0];
  assert.deepEqual(actions(hold), ['hold']);
  assert.equal(choose(hold, 'hold').interpretationCorrect, true);
  assert.equal(choose(hold, 'hold').physicalCorrect, true);
  assert.equal(choose(hold, 'hold').usefulCorrect, false);
  assert.equal(choose(hold, 'hold').usefulEligible, false);
  r.observation.axialDepthIntervalM = [8.5, 8.5];
  const tied = generateCases([r])[0], row = choose(tied, 'advance1m');
  assert.equal(row.usefulCorrect, true);
  assert.equal(row.usefulEligible, false);
  assert.equal(row.usefulEligibleCorrect, false);
});
