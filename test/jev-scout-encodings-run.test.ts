import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateScoutCases} from '../experiments/jev-scout-encodings/scout.ts';
import {generateRangeCases} from '../experiments/jev-scout-encodings/range.ts';
import {choose, gates, constantPolicyStats, GATES} from '../experiments/jev-scout-encodings/analyze.ts';
import {createMeter, digest} from '../experiments/jev-spatial-text/transport.ts';
import {select, validateSelection, complete, dispatchAllWithAmendment} from '../experiments/jev-scout-encodings/run.ts';

const SCOUT_CASES = generateScoutCases(), RANGE_CASES = generateRangeCases();

// ---------- adversarial regression: constant / positional policies must not pass the gates (F63's evaluation repair) ----------
function failsGate(stats: {usefulRate: number; harmfulCount: number}, gate: typeof GATES['S']) {
  return stats.usefulRate < gate.positiveUsefulRate || stats.harmfulCount > gate.harmfulCount;
}
test('constant policies (hold, first offered option, last offered option) fail the S development gate on every arm', () => {
  for (const arm of ['current-only', 'view-history', 'sector-state', 'sector-consequences']) {
    const sample = SCOUT_CASES.find(c => c.split === 'development' && c.arm === arm)!;
    const ids = Object.keys(sample.request.questions.action!.criteria);
    for (const actionId of ['hold', ids[0]!, ids.at(-1)!]) {
      const stats = constantPolicyStats(SCOUT_CASES, 'S', 'development', arm, actionId);
      assert(failsGate(stats, GATES.S), `constant "${actionId}" should fail the S gate on ${arm} (rate=${stats.usefulRate}, harmful=${stats.harmfulCount})`);
    }
  }
});
test('a per-family constant policy ("always turn_180" restricted to s1/s4b) fails, proving the rebalance removed a universal shortcut', () => {
  for (const family of ['s1-never-seen-partial', 's4-abstention-controls']) {
    const stats = constantPolicyStats(SCOUT_CASES, 'S', 'development', 'current-only', 'turn_180', family);
    assert(stats.usefulRate < 1, `turn_180 should not be universally correct within ${family} after rebalancing`);
  }
});
test('constant policies (hold, approach_1m, retreat_1m) fail the R development gate on every arm', () => {
  for (const arm of ['measured', 'signed-error', 'after-range']) {
    for (const action of ['hold', 'approach_1m', 'retreat_1m']) {
      const stats = constantPolicyStats(RANGE_CASES, 'R', 'development', arm, action);
      assert(failsGate(stats, GATES.R), `constant "${action}" should fail the R gate on ${arm}`);
    }
  }
});
test('the "smallest resulting error" shortcut on after-range IS the intended declared assistance and passes; other shortcuts (largest number, longest option text) fail', () => {
  const afterRange = RANGE_CASES.filter(c => c.split === 'development' && c.arm === 'after-range');
  let smallestErrorHits = 0, largestNumberHits = 0, longestTextHits = 0;
  for (const c of afterRange) {
    const options = (c.request.state as any).declared_computation.per_option as {action: string; resulting_signed_error_m: number | null}[];
    const valid = options.filter(o => o.resulting_signed_error_m != null);
    if (valid.length) {
      const best = valid.reduce((a, b) => (Math.abs(a.resulting_signed_error_m!) <= Math.abs(b.resulting_signed_error_m!) ? a : b));
      if (c.expected.action!.includes(best.action)) smallestErrorHits++;
    } else if (c.expected.action!.includes('hold')) smallestErrorHits++;
    const criteria = c.request.questions.action!.criteria;
    const ids = Object.keys(criteria);
    const largest = ids.reduce((a, b) => (RANGE_ACTIONS_ABS(a) >= RANGE_ACTIONS_ABS(b) ? a : b));
    if (c.expected.action!.includes(largest)) largestNumberHits++;
    const longest = ids.reduce((a, b) => (criteria[a]!.length >= criteria[b]!.length ? a : b));
    if (c.expected.action!.includes(longest)) longestTextHits++;
  }
  assert(smallestErrorHits / afterRange.length >= 0.90, 'the declared "smallest resulting error" shortcut should be (near-)exactly the oracle');
  assert(largestNumberHits / afterRange.length < 0.90, 'a "largest step" shortcut must not pass the gate');
  assert(longestTextHits / afterRange.length < 0.90, 'a "longest option text" shortcut must not pass the gate');
});
function RANGE_ACTIONS_ABS(id: string): number {
  const m = id.match(/(\d+)m/); return m ? Number(m[1]) : 0;
}

// ---------- choose()/gates() selection rule (matches the plan exactly: critical-error-first -> gate -> smallest payload) ----------
function fakeGroup(over: any) {
  return {
    calls: 48, harmfulCount: 0, usefulRate: .95, meanBytes: 100,
    positive: {calls: 40, usefulHits: 38}, abstention: {calls: 8, usefulHits: 8},
    positiveUsefulRate: 38 / 40, abstentionCorrectRate: 1, families: {fam: {calls: 48, usefulHits: 46}},
    ...over,
  };
}
test('choose() narrows by minimum harmful count, then keeps ALL gate-passing arms (not just the best), then picks smallest payload', () => {
  const S = [
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'current-only', harmfulCount: 1, meanBytes: 50}),
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'view-history', harmfulCount: 0, positiveUsefulRate: .70, meanBytes: 80}), // fails the gate
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-state', harmfulCount: 0, positiveUsefulRate: .95, meanBytes: 60}), // passes, higher rate
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-consequences', harmfulCount: 0, positiveUsefulRate: .91, meanBytes: 40}), // passes, lower rate, smaller payload
  ];
  const R = ['measured', 'signed-error', 'after-range'].map(arm => fakeGroup({hypothesis: 'R', split: 'development', arm, calls: 58}));
  const selection = choose({groups: [...S, ...R]});
  // sector-state (rate .95) and sector-consequences (rate .91) BOTH clear the .90 gate; the rule does not
  // narrow further to "the best rate" -- it picks the smallest payload among every arm that clears the gate.
  assert.equal(selection.S.arm, 'sector-consequences');
  assert.equal(selection.S.gatePassed, true);
  assert.deepEqual(selection.S.eligibleArms, ['sector-consequences', 'sector-state']);
});
test('choose() requires the abstention-correct rate and the per-family floor too, not just the positive rate', () => {
  const S = [
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'current-only', harmfulCount: 0, positiveUsefulRate: .95, abstentionCorrectRate: .50, meanBytes: 50}), // fails abstention gate
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'view-history', harmfulCount: 0, positiveUsefulRate: .95, abstentionCorrectRate: .95, families: {a: {calls: 12, usefulHits: 6}}, meanBytes: 80}), // fails family floor
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-state', harmfulCount: 0, positiveUsefulRate: .95, abstentionCorrectRate: .95, meanBytes: 60}),
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-consequences', harmfulCount: 1, meanBytes: 40}),
  ];
  const R = ['measured', 'signed-error', 'after-range'].map(arm => fakeGroup({hypothesis: 'R', split: 'development', arm, calls: 58}));
  const selection = choose({groups: [...S, ...R]});
  assert.equal(selection.S.arm, 'sector-state'); assert.equal(selection.S.gatePassed, true);
});
test('choose() falls back to minimum-harmful arms sorted by SMALLEST PAYLOAD (not by rate) when nothing clears the gate', () => {
  const S = [
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'current-only', harmfulCount: 2, positiveUsefulRate: .99, meanBytes: 30}), // best rate, but not minimum-harmful: excluded
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'view-history', harmfulCount: 0, positiveUsefulRate: .85, meanBytes: 80}), // higher rate, larger payload
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-state', harmfulCount: 0, positiveUsefulRate: .60, meanBytes: 60}), // lower rate, smaller payload
    fakeGroup({hypothesis: 'S', split: 'development', arm: 'sector-consequences', harmfulCount: 1, positiveUsefulRate: .99, meanBytes: 40}), // not minimum-harmful: excluded
  ];
  const R = ['measured', 'signed-error', 'after-range'].map(arm => fakeGroup({hypothesis: 'R', split: 'development', arm, calls: 58}));
  const selection = choose({groups: [...S, ...R]});
  assert.equal(selection.S.gatePassed, false);
  // Minimum-harmful pool is {view-history, sector-state} (harmful=0), neither clears the .90 gate; the
  // fallback is sorted by smallest payload -- sector-state (60 bytes) wins over view-history (80 bytes)
  // even though view-history has the higher rate, because the rule never narrows by rate.
  assert.equal(selection.S.arm, 'sector-state');
  assert.deepEqual(selection.S.eligibleArms, ['sector-state', 'view-history']);
});
test('gates() requires BOTH the numeric threshold and completeness (exact expected confirmation call count)', () => {
  const selection = {S: {arm: 'sector-consequences'}, R: {arm: 'after-range'}} as any;
  const complete48 = {hypothesis: 'S', split: 'confirmation', arm: 'sector-consequences', harmfulCount: 0, calls: 48, positive: {calls: 40, usefulHits: 38}, abstention: {calls: 8, usefulHits: 8}, positiveUsefulRate: .95, abstentionCorrectRate: 1, families: {fam: {calls: 48, usefulHits: 46}}};
  const incomplete = {...complete48, calls: 47};
  const passResult = gates({groups: [complete48, {hypothesis: 'R', split: 'confirmation', arm: 'after-range', harmfulCount: 0, calls: 58, positive: {calls: 58, usefulHits: 56}, abstention: {calls: 0, usefulHits: 0}, positiveUsefulRate: .96, abstentionCorrectRate: null, families: {fam: {calls: 58, usefulHits: 56}}}]}, selection, {S: 48, R: 58});
  assert.equal(passResult.S.pass, true); assert.equal(passResult.S.complete, true);
  const incompleteResult = gates({groups: [incomplete]}, selection, {S: 48, R: 58});
  assert.equal(incompleteResult.S.complete, false); assert.equal(incompleteResult.S.pass, false, 'an incomplete confirmation must never report a pass');
  const missing = gates({groups: []}, selection, {S: 48, R: 58});
  assert.equal(missing.S.pass, false); assert.equal(missing.S.complete, false);
});

// ---------- shared meter: ceilings and stop-on-error, exercised the same way run.ts uses them ----------
async function tempRoot(t: {after(fn: () => void): void}) {
  await mkdir(resolve('.runtime'), {recursive: true}); // absent on a fresh checkout (git-ignored)
  const dir = await mkdtemp(resolve('.runtime', 'scout-encodings-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
function fakeRequest(id: string) {
  return {model: 'jev-1.13.0' as const, state: {probe: id}, questions: {action: {type: 'choice' as const, instructions: 'pick one', criteria: {a: 'a', b: 'b'}}}};
}
function fakeReply(choiceId: string) {
  return {model: 'jev-1.13.0', usage: {input_tokens: 10}, answers: {action: {type: 'choice', choice: choiceId, confidence: 1, probabilities: {a: choiceId === 'a' ? 1 : 0, b: choiceId === 'b' ? 1 : 0}}}};
}
test('the shared meter enforces the request ceiling and refuses to exceed it (no silent retry)', async t => {
  const root = await tempRoot(t);
  const meter = createMeter({root, key: 'x', limits: {requests: 2, inputTokens: 1_000_000, requestsPerSecond: 2}, send: async () => fakeReply('a'), minStartIntervalMs: 1});
  try {
    await meter.judge(fakeRequest('p1') as any, 'p1');
    await meter.judge(fakeRequest('p2') as any, 'p2');
    await assert.rejects(() => meter.judge(fakeRequest('p3') as any, 'p3'), /ceiling/);
  } finally { meter.close(); }
});
test('an error response stops further dispatch under the same meter; no silent replay of the failed id', async t => {
  const root = await tempRoot(t);
  let calls = 0;
  const send = async () => { calls++; if (calls === 1) throw new Error('injected HTTP failure'); return fakeReply('a'); };
  const meter = createMeter({root, key: 'x', limits: {requests: 10, inputTokens: 1_000_000, requestsPerSecond: 2}, send, minStartIntervalMs: 1});
  await assert.rejects(() => meter.judge(fakeRequest('bad') as any, 'bad'), /injected HTTP failure/);
  meter.close();
  assert.throws(() => createMeter({root, key: 'x', limits: {requests: 10, inputTokens: 1_000_000, requestsPerSecond: 2}, send, minStartIntervalMs: 1}), /Unresolved calls/);
  assert.equal(calls, 1, 'the failed call must not be silently retried');
});

// ---------- -a1 amendment path: exactly one fresh attempt, original preserved, second failure stops the run ----------
test('dispatchAllWithAmendment retries a failed dispatch exactly once under a fresh id, preserving the original failure', async t => {
  const root = await tempRoot(t);
  const cases = [{id: 'c1', hypothesis: 'S', split: 'development', arm: 'x', family: 'f', unit: 'u', mirror: false, replicate: 0, request: fakeRequest('c1'), expected: {action: ['a']}, meta: {}}] as any[];
  let calls = 0;
  const send = async () => { calls++; if (calls === 1) throw new Error('flaky'); return fakeReply('a'); };
  const result = await dispatchAllWithAmendment(cases, root, 'x', {requests: 10, inputTokens: 1_000_000, requestsPerSecond: 2}, send);
  assert.equal(result.dispatched, 1); assert.equal(result.amended, 1); assert.equal(calls, 2);
  const {ledger} = await import('../experiments/jev-spatial-text/transport.ts');
  const rows = new Map(ledger(root).map((r: any) => [r.id, r]));
  const dispatchId = [...rows.keys()].find(id => !id.endsWith('-a1'))!;
  assert.equal(rows.get(dispatchId)!.status, 'error'); assert.equal(rows.get(dispatchId)!.recovery, true, 'the original failure must be preserved, not deleted or replayed');
  assert.equal(rows.get(`${dispatchId}-a1`)!.status, 'completed');
});
test('a second failure on the amendment stops the whole run (no further amendment)', async t => {
  const root = await tempRoot(t);
  const cases = [{id: 'c1', hypothesis: 'S', split: 'development', arm: 'x', family: 'f', unit: 'u', mirror: false, replicate: 0, request: fakeRequest('c1'), expected: {action: ['a']}, meta: {}}] as any[];
  const send = async () => { throw new Error('always fails'); };
  await assert.rejects(() => dispatchAllWithAmendment(cases, root, 'x', {requests: 10, inputTokens: 1_000_000, requestsPerSecond: 2}, send), /always fails/);
});

// ---------- confirmation split must not be readable/dispatchable before development completes and selects; selection must re-derive from the ledger ----------
test('select() refuses when confirmation-split requests were already dispatched, or development is incomplete', async t => {
  const root = await tempRoot(t);
  const all = SCOUT_CASES.filter(c => c.split === 'development' || c.split === 'confirmation').slice(0, 4);
  await writeFile(resolve(root, 'requests.jsonl'), '');
  await assert.rejects(() => select(all, root), /Expected all \d+ development dispatch ids resolved/);
});
test('validateSelection rejects a swapped-and-resealed selection.json even though its own hash is self-consistent (re-derivation, not just a hash check)', async t => {
  const root = await tempRoot(t);
  // choose() requires all 4 S arms and all 3 R arms represented; take a couple of cases per arm.
  const scoutByArm = ['current-only', 'view-history', 'sector-state', 'sector-consequences']
    .flatMap(arm => SCOUT_CASES.filter(c => c.split === 'development' && c.arm === arm).slice(0, 2));
  const rangeByArm = ['measured', 'signed-error', 'after-range']
    .flatMap(arm => RANGE_CASES.filter(c => c.split === 'development' && c.arm === arm).slice(0, 2));
  const all = [...scoutByArm, ...rangeByArm];
  // Dispatch every distinct development case synthetically so analyze()/choose() has real data to re-derive from.
  const {createMeter: freshMeter} = await import('../experiments/jev-spatial-text/transport.ts');
  const {groupByDispatchId} = await import('../experiments/jev-scout-encodings/dispatch.ts');
  const meter = freshMeter({root, key: 'x', limits: {requests: 100, inputTokens: 10_000_000, requestsPerSecond: 2}, send: async (req: any) => {
    const ids = Object.keys(req.questions.action.criteria);
    return {model: req.model, usage: {input_tokens: 10}, answers: {action: {type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((id: string, i: number) => [id, i === 0 ? 1 : 0]))}}};
  }, minStartIntervalMs: 1});
  try { for (const [dispatchId, group] of groupByDispatchId(all)) await meter.judge(group[0]!.request, dispatchId); } finally { meter.close(); }
  const selection = await select(all, root);
  await validateSelection(all, root); // sanity: the genuine selection validates
  // Tamper: swap S's chosen arm and re-seal (as an attacker with write access to both files could).
  const {readFile, writeFile: write} = await import('node:fs/promises');
  const {digest: dig} = await import('../experiments/jev-spatial-text/transport.ts');
  const tampered = {...selection, S: {...selection.S, arm: selection.S.arm === 'current-only' ? 'sector-state' : 'current-only'}};
  const tamperedBytes = JSON.stringify(tampered);
  await write(resolve(root, 'selection.json'), tamperedBytes);
  await write(resolve(root, 'selection-seal.json'), JSON.stringify({selectionSha256: dig(tamperedBytes)}));
  await assert.rejects(() => validateSelection(all, root), /Selection re-derivation mismatch/);
});

// ---------- complete(): completeness before sealing, and no silent overwrite of analysis.json/gates.json after ----------
test('complete() requires confirmation dispatch complete for the selected arm(s), then seals analysis/gates so they cannot silently change afterward', async t => {
  const root = await tempRoot(t);
  const scoutByArm = ['current-only', 'view-history', 'sector-state', 'sector-consequences']
    .flatMap(arm => SCOUT_CASES.filter(c => c.split === 'development' && c.arm === arm).slice(0, 2))
    .concat(['current-only', 'view-history', 'sector-state', 'sector-consequences']
      .flatMap(arm => SCOUT_CASES.filter(c => c.split === 'confirmation' && c.arm === arm).slice(0, 2)));
  const rangeByArm = ['measured', 'signed-error', 'after-range']
    .flatMap(arm => RANGE_CASES.filter(c => c.split === 'development' && c.arm === arm).slice(0, 2))
    .concat(['measured', 'signed-error', 'after-range']
      .flatMap(arm => RANGE_CASES.filter(c => c.split === 'confirmation' && c.arm === arm).slice(0, 2)));
  const all = [...scoutByArm, ...rangeByArm];
  const developmentOnly = all.filter(c => c.split === 'development');
  const send = async (req: any) => {
    const ids = Object.keys(req.questions.action.criteria);
    return {model: req.model, usage: {input_tokens: 10}, answers: {action: {type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((id: string, i: number) => [id, i === 0 ? 1 : 0]))}}};
  };
  await dispatchAllWithAmendment(developmentOnly, root, 'x', {requests: 200, inputTokens: 10_000_000, requestsPerSecond: 2}, send);
  await select(all, root);
  // Confirmation is not dispatched at all yet: complete() must refuse, not report a partial pass.
  await assert.rejects(() => complete(all, root, true), /incomplete/);
  const confirmationOnly = all.filter(c => c.split === 'confirmation');
  await dispatchAllWithAmendment(confirmationOnly, root, 'x', {requests: 200, inputTokens: 10_000_000, requestsPerSecond: 2}, send);
  const first = await complete(all, root, true);
  assert.equal(first.verdicts.S.complete, true); assert.equal(first.verdicts.R.complete, true);
  const {readFile} = await import('node:fs/promises');
  const sealed = JSON.parse(await readFile(resolve(root, 'completion-seal.json'), 'utf8'));
  assert.equal(sealed.synthetic, true);
  // Calling complete() again with unchanged data is a harmless no-op (bytes still match the seal).
  const second = await complete(all, root, true);
  assert.deepEqual(second.verdicts, first.verdicts);
  const resealed = JSON.parse(await readFile(resolve(root, 'completion-seal.json'), 'utf8'));
  assert.deepEqual(resealed, sealed, 'completion-seal.json must not be rewritten by a second complete() call');
});
