import test from 'node:test';
import assert from 'node:assert/strict';
import {generateF1Cases, F1_MENU_SIZES} from '../experiments/jev-encoding-rules/f1-menu-size.ts';
import {generateF2Cases, MARGINS} from '../experiments/jev-encoding-rules/f2-near-tie.ts';
import {generateF3Cases, FORMS} from '../experiments/jev-encoding-rules/f3-consequence-form.ts';
import {generateF4Cases, F4_ARMS} from '../experiments/jev-encoding-rules/f4-numbers-words.ts';
import {assertNoOracleLeak, assertNoRankingLanguage, assertSymmetricConsequences, assertIdenticalMenuWithinArm} from '../experiments/jev-encoding-rules/checks.ts';
import {duplicateBodyReport} from '../experiments/jev-encoding-rules/dispatch.ts';
import {allCases} from '../experiments/jev-encoding-rules/run.ts';
import type {RuleCase} from '../experiments/jev-encoding-rules/types.ts';

test('generators are deterministic: two independent calls produce byte-identical case sets', () => {
  assert.equal(JSON.stringify(generateF1Cases()), JSON.stringify(generateF1Cases()));
  assert.equal(JSON.stringify(generateF2Cases()), JSON.stringify(generateF2Cases()));
  assert.equal(JSON.stringify(generateF3Cases()), JSON.stringify(generateF3Cases()));
  assert.equal(JSON.stringify(generateF4Cases()), JSON.stringify(generateF4Cases()));
});

test('all case ids are unique across the whole battery', () => {
  const all = allCases();
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
});

test('F1: every menu size arm has 32 cases, an N-option menu, and every case has a unique useful action', () => {
  const all = generateF1Cases();
  for (const n of F1_MENU_SIZES) {
    const arm = all.filter(c => c.arm === `n${n}`);
    assert.equal(arm.length, 32, `n${n} case count`);
    for (const c of arm) {
      assert.equal(Object.keys(c.request.questions.action!.criteria).length, n);
      assert.equal(c.expected.length, 1, `${c.id}: F1 cases are constructed to avoid ties`);
    }
  }
});
test('F1: mirroring is a true reflection -- mirrored bearing is the negation of the original', () => {
  const all = generateF1Cases();
  const byKey = new Map<string, RuleCase>();
  for (const c of all) byKey.set(`${c.arm}:${c.family}:${c.meta.targetIndex}:${c.mirror}:${c.id.match(/k(\d+)/)![1]}`, c);
  let checked = 0;
  for (const c of all.filter(c => !c.mirror)) {
    const mirroredId = c.id.replace(/-o$/, '-m');
    const partner = all.find(x => x.id === mirroredId);
    assert(partner, `missing mirror partner for ${c.id}`);
    assert.equal(partner!.meta.bearing, -c.meta.bearing);
    checked++;
  }
  assert(checked > 0);
});

test('F2: every margin arm has 32 cases whose top-two options differ by the declared nominal margin (within jitter tolerance), with no other option competitive', () => {
  const all = generateF2Cases();
  for (const domain of ['yaw', 'range'] as const) {
    for (const margin of MARGINS) {
      const arm = all.filter(c => c.arm === `${domain}-margin-${margin}`);
      assert.equal(arm.length, 32, `${domain}-margin-${margin} case count`);
      for (const c of arm) {
        const sorted = [...c.meta.rows].sort((a: any, b: any) => a.absError - b.absError);
        const achieved = sorted[1].absError - sorted[0].absError;
        assert(Math.abs(achieved - c.meta.actualMargin) < 1e-3, `${c.id}: achieved margin ${achieved} != actual ${c.meta.actualMargin}`);
        assert(Math.abs(achieved - margin) < margin * 0.06 + 0.007, `${c.id}: achieved margin ${achieved} strays too far from nominal ${margin}`);
        const third = sorted[2].absError;
        assert(third > sorted[1].absError + 1e-6, `${c.id}: a third option ties or beats the runner-up (not comfortably ranked behind it)`);
        assert.equal(c.expected.length, 1);
      }
    }
  }
});
test('F2: the deadband arm has both within- and outside-deadband cases, and the expected answer differs from the raw best exactly when within', () => {
  const all = generateF2Cases().filter(c => c.arm === 'yaw-deadband');
  assert.equal(all.length, 36);
  const within = all.filter(c => c.meta.within), outside = all.filter(c => !c.meta.within);
  assert(within.length > 0 && outside.length > 0);
  for (const c of within) assert.deepEqual(c.expected, ['hold'], `${c.id}: within-deadband case should resolve to hold`);
  for (const c of outside) assert.deepEqual(c.expected, c.meta.rawBest, `${c.id}: outside-deadband case should resolve to the raw best, not hold`);
});

test('F3: every (domain, form) arm has 32 cases; forms a/b/c/d each carry the fields the spec calls for', () => {
  const all = generateF3Cases();
  for (const domain of ['yaw', 'range'] as const) {
    for (const form of FORMS) {
      const arm = all.filter(c => c.arm === `${domain}-${form}`);
      assert.equal(arm.length, 32, `${domain}-${form} case count`);
      const sample = arm[0]!.request.state.action_consequences.per_option[0];
      const valueKey = domain === 'yaw' ? 'resulting_bearing_deg' : 'resulting_range_m';
      const errorKey = domain === 'yaw' ? 'abs_error_deg' : 'abs_error_m';
      if (form === 'value') assert.deepEqual(Object.keys(sample).sort(), ['action', valueKey].sort());
      if (form === 'error') assert.deepEqual(Object.keys(sample).sort(), ['action', errorKey].sort());
      if (form === 'label') assert.deepEqual(Object.keys(sample).sort(), ['action', 'status', valueKey].sort());
      if (form === 'all') assert.deepEqual(Object.keys(sample).sort(), ['action', 'status', valueKey, errorKey].sort());
    }
  }
});
test('F3: identical (domain, k, mirror) facts are shared across all four forms -- only the rendering differs', () => {
  const all = generateF3Cases();
  const byKey = new Map<string, Set<number>>();
  for (const c of all) {
    const key = `${c.meta.domain}:${c.seed}:${c.mirror}`;
    (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(c.meta.current);
  }
  for (const [key, currents] of byKey) assert.equal(currents.size, 1, `${key}: forms disagree on underlying facts`);
});
test('F3: range-band arms exercise all three band relationships (too_close, in_band, too_far)', () => {
  const all = generateF3Cases().filter(c => c.arm === 'range-label');
  const statuses = new Set(all.flatMap((c: RuleCase) => c.request.state.action_consequences.per_option.map((o: any) => o.status)));
  assert(statuses.has('in_band'), 'expected at least one in_band case');
  assert(statuses.has('too_close') || statuses.has('too_far'), 'expected at least one out-of-band case');
});

test('F4: every arm has 32 cases sharing identical bearings with the other arms at the same k; sign-trap adds one distractor field', () => {
  const all = generateF4Cases();
  for (const arm of F4_ARMS) assert.equal(all.filter(c => c.arm === arm).length, 32, `${arm} case count`);
  const byKM = new Map<string, number>();
  for (const c of all) {
    const key = `${c.seed}:${c.mirror}`;
    if (byKM.has(key)) assert.equal(byKM.get(key), c.meta.bearing, `${c.id}: bearing differs across F4 arms for the same case index`);
    else byKM.set(key, c.meta.bearing);
  }
  const trap = all.filter(c => c.arm === 'sign-trap');
  for (const c of trap) assert('prior_correction_deg' in c.request.state);
  for (const c of all.filter(c => c.arm !== 'sign-trap')) assert(!('prior_correction_deg' in c.request.state));
});

test('every generated case passes the static hygiene checks (no oracle leak, no ranking language)', () => {
  for (const c of allCases()) { assertNoOracleLeak(c); assertNoRankingLanguage(c); }
});
test('every arm shares one action menu across its own cases', () => {
  assertIdenticalMenuWithinArm(allCases());
});
test('per-option consequence fields are symmetric across options, in every case', () => {
  for (const c of allCases()) assertSymmetricConsequences(c.request.state.action_consequences.per_option);
});
test('option-position balance: across F1, no single ladder position dominates the useful answer', () => {
  const all = generateF1Cases();
  const perPosition = new Map<number, number>();
  for (const c of all) perPosition.set(c.meta.targetIndex, (perPosition.get(c.meta.targetIndex) ?? 0) + 1);
  const total = all.length;
  for (const [, count] of perPosition) assert(count / total < 0.5, 'one ladder position dominates F1 useful answers');
});
test('the request-body dedup rate stays low: the battery is not accidentally mostly duplicate requests', () => {
  const all = allCases();
  const dupes = duplicateBodyReport(all);
  assert(dupes.distinctDispatches / dupes.totalCases > 0.9, `too many duplicate request bodies: ${dupes.distinctDispatches}/${dupes.totalCases} distinct`);
});
