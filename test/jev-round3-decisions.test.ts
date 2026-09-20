import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeProbes, gradeRangeProbe, type RangeEvidence } from '../experiments/jev-round3/decisions.ts';

const evidence = (range: number | null): RangeEvidence => ({ id: 'scene20', routeId: 'nominal', split: 'development',
  targetStatus: 'single', medianRangeM: range, bearingDeg: 2, validFraction: .8, unknownReason: range === null ? 'no-stereo-support' : null });
test('goal swap reverses the useful direction; equal-fact arms preserve capabilities', () => {
  const probes = rangeProbes(evidence(10));
  for (const p of probes) {
    const d = p.options[p.expected[0]!];
    assert.equal(d, p.goalM === 8 ? 2 : -2);
    assert.equal(gradeRangeProbe(p, p.expected[0]).correct, true);
    const wrong = Object.keys(p.options).find(id => p.options[id] === -d!)!;
    assert.equal(gradeRangeProbe(p, wrong).wrongDirection, true);
  }
  assert.deepEqual(probes[0]!.request.questions, probes[1]!.request.questions);
  assert.deepEqual(probes[0]!.options, probes[1]!.options);
});
test('missing or ambiguous range cannot be revived by numeric residue or evaluator truth', () => {
  for (const status of ['missing', 'ambiguous'] as const) {
    const input = { ...evidence(10), targetStatus: status, evaluator: { trueRange: 12, objectId: 'secret' } };
    for (const p of rangeProbes(input)) {
      assert.equal(p.usable, false);
      assert.equal(p.options[p.expected[0]!], null);
      assert(!JSON.stringify(p.request).includes('secret'));
      assert.equal((p.request.state as any).measured.medianVisibleSurfaceRangeM, null);
      const hold = Object.keys(p.options).find(id => p.options[id] === 0)!;
      assert.equal(gradeRangeProbe(p, hold).unsupported, true);
    }
  }
});
test('useful holds and tied optimal displacements prevent an always-move grading shortcut', () => {
  for (const p of rangeProbes(evidence(8)).filter(p => p.goalM === 8)) {
    assert.equal(p.options[p.expected[0]!], 0);
    assert.equal(gradeRangeProbe(p, p.expected[0]).correctHold, true);
  }
  for (const p of rangeProbes(evidence(8.5)).filter(p => p.goalM === 8)) assert.equal(p.expected.length, 2);
});
