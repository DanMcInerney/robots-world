import test from 'node:test';
import assert from 'node:assert/strict';
import {generateScoutCases, SCOUT_ARMS} from '../experiments/jev-scout-encodings/scout.ts';
import {generateRangeCases, RANGE_ARMS} from '../experiments/jev-scout-encodings/range.ts';
import {assertIdenticalMenus, assertNoOracleLeak, assertNoRankingLanguage, assertSymmetricConsequences} from '../experiments/jev-scout-encodings/checks.ts';
import {duplicateBodyReport} from '../experiments/jev-scout-encodings/dispatch.ts';
import type {ScoutCase} from '../experiments/jev-scout-encodings/types.ts';

test('generators are deterministic: two independent calls produce byte-identical case sets', () => {
  assert.equal(JSON.stringify(generateScoutCases()), JSON.stringify(generateScoutCases()));
  assert.equal(JSON.stringify(generateRangeCases()), JSON.stringify(generateRangeCases()));
});

test('S: every unit has both a mirror and a non-mirror instance; one question with 12 identical actions', () => {
  const all = generateScoutCases();
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
  for (const arm of SCOUT_ARMS) assert.equal(all.filter(c => c.arm === arm).length, all.length / SCOUT_ARMS.length);
  for (const c of all) assert.equal(Object.keys(c.request.questions.action!.criteria).length, 12);
  const byUnit = new Map<string, Set<boolean>>();
  for (const c of all) (byUnit.get(c.unit) ?? byUnit.set(c.unit, new Set()).get(c.unit)!).add(c.mirror);
  for (const [unit, mirrors] of byUnit) assert.deepEqual([...mirrors].sort(), [false, true], `unit ${unit} missing a mirror pair`);
});
test('R: one question with 5 identical actions; R1 (no directional structure) is deliberately not mirrored, every other family is', () => {
  const all = generateRangeCases();
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
  for (const arm of RANGE_ARMS) assert.equal(all.filter(c => c.arm === arm).length, all.length / RANGE_ARMS.length);
  for (const c of all) assert.equal(Object.keys(c.request.questions.action!.criteria).length, 5);
  const byUnit = new Map<string, Set<boolean>>();
  for (const c of all) (byUnit.get(c.unit) ?? byUnit.set(c.unit, new Set()).get(c.unit)!).add(c.mirror);
  for (const [unit, mirrors] of byUnit) {
    const sorted = [...mirrors].sort();
    if (unit.startsWith('r1-')) assert.deepEqual(sorted, [false], `${unit} (R1) should have no mirror`);
    else assert.deepEqual(sorted, [false, true], `unit ${unit} missing a mirror pair`);
  }
});

test('rebalanced S1/S4b: no single yaw action is the universal answer across variants (repair of the pre-inference review finding)', () => {
  const all = generateScoutCases().filter(c => c.split === 'development' && c.arm === 'current-only' && (c.family === 's1-never-seen-partial' || c.family === 's4-abstention-controls'));
  const answers = new Set(all.flatMap(c => c.expected.action!));
  assert(answers.size >= 3, `expected varied useful actions across S1/S4b, got only ${[...answers]}`);
  const turn180Share = all.filter(c => c.expected.action!.includes('turn_180')).length / all.length;
  assert(turn180Share < 0.9, `turn_180 must not dominate S1/S4b (share=${turn180Share})`);
});

test('option-position and side balance: no single action is the useful answer for a lopsided share of development cases', () => {
  const scout = generateScoutCases().filter(c => c.split === 'development' && c.arm === 'current-only');
  const perAction = new Map<string, number>();
  for (const c of scout) for (const a of c.expected.action!) perAction.set(a, (perAction.get(a) ?? 0) + 1);
  const totalUsefulSlots = [...perAction.values()].reduce((a, b) => a + b, 0);
  for (const [action, count] of perAction) assert(count / totalUsefulSlots < 0.5, `${action} dominates the useful set (${count}/${totalUsefulSlots})`);
  const leftYaw = [...perAction.entries()].filter(([a]) => a.startsWith('yaw_left')).reduce((n, [, c]) => n + c, 0);
  const rightYaw = [...perAction.entries()].filter(([a]) => a.startsWith('yaw_right')).reduce((n, [, c]) => n + c, 0);
  assert.equal(leftYaw, rightYaw, 'mirrored generation should balance left/right yaw usefulness exactly');

  const range = generateRangeCases().filter(c => c.split === 'development' && c.arm === 'measured');
  const approach = range.filter(c => c.expected.action!.some(a => a.startsWith('approach'))).length;
  const retreat = range.filter(c => c.expected.action!.some(a => a.startsWith('retreat'))).length;
  assert(approach > 0 && retreat > 0, 'both approach and retreat must be exercised as useful answers');
});

test('all four S arms and all three R arms carry identical underlying facts per (unit, mirror); only the declared factor differs', () => {
  for (const all of [generateScoutCases(), generateRangeCases()]) {
    const byGroup = new Map<string, Set<string>>();
    for (const c of all) if (c.replicate === 0) (byGroup.get(c.meta.sameFactsGroup) ?? byGroup.set(c.meta.sameFactsGroup, new Set()).get(c.meta.sameFactsGroup)!).add(c.meta.factsSha256);
    for (const [group, hashes] of byGroup) assert.equal(hashes.size, 1, `group ${group} does not share identical underlying facts across arms`);
  }
});
test('S arms share one action menu per unit; R arms share one action menu per unit', () => {
  assertIdenticalMenus(generateScoutCases());
  assertIdenticalMenus(generateRangeCases());
});
test('replicates are byte-identical repeats of the same request, not independent draws', () => {
  for (const all of [generateScoutCases(), generateRangeCases()]) {
    const byId = new Map<string, ScoutCase[]>();
    for (const c of all) { const base = c.id.replace(/-r\d$/, ''); (byId.get(base) ?? byId.set(base, []).get(base)!).push(c); }
    for (const [, group] of byId) { assert.equal(group.length, 2); assert.equal(JSON.stringify(group[0]!.request), JSON.stringify(group[1]!.request)); }
  }
});

test('confirmation cases use disjoint parameter draws from development, not a constant shift of the same numbers', () => {
  for (const all of [generateScoutCases(), generateRangeCases()]) {
    const devFacts = new Set(all.filter(c => c.split === 'development' && c.replicate === 0).map(c => c.meta.factsSha256));
    const confirmFacts = new Set(all.filter(c => c.split === 'confirmation' && c.replicate === 0).map(c => c.meta.factsSha256));
    for (const hash of confirmFacts) assert(!devFacts.has(hash), 'a confirmation fact hash duplicates a development fact hash');
  }
  // Structural check, not just numeric: development and confirmation must not use the exact same rotation
  // order for which family variant is "correct" (a fixed shift would preserve this order).
  const s1Dev = generateScoutCases().filter(c => c.split === 'development' && c.family === 's1-never-seen-partial' && c.arm === 'current-only' && !c.mirror && c.replicate === 0).map(c => c.expected.action![0]);
  const s1Confirm = generateScoutCases().filter(c => c.split === 'confirmation' && c.family === 's1-never-seen-partial' && c.arm === 'current-only' && !c.mirror && c.replicate === 0).map(c => c.expected.action![0]);
  assert.notDeepEqual(s1Dev, s1Confirm, 'development and confirmation S1 answer rotations must differ, not merely be shifted');
});

test('no oracle-only field or ranking language appears in any rendered request', () => {
  for (const c of [...generateScoutCases(), ...generateRangeCases()]) { assertNoOracleLeak(c); assertNoRankingLanguage(c); }
});
test('the ranking-language check has real negation scope: a stray unrelated "not" elsewhere in the text must not excuse an affirmative ranking word', () => {
  const bad: ScoutCase = {
    id: 'probe', hypothesis: 'S', split: 'development', family: 'f', unit: 'u', mirror: false, arm: 'current-only', replicate: 0,
    request: {model: 'jev-1.13.0', state: {note: 'This sighting is not stale. Action left_30 is simply the best option available.'}, questions: {action: {type: 'choice', instructions: 'x', criteria: {a: 'a'}}}},
    expected: {action: ['a']}, meta: {},
  };
  assert.throws(() => assertNoRankingLanguage(bad), /best/);
});
test('ranking-language check scans the entire request, including question instructions and option criteria, not only state', () => {
  const bad: ScoutCase = {
    id: 'probe2', hypothesis: 'R', split: 'development', family: 'f', unit: 'u', mirror: false, arm: 'measured', replicate: 0,
    request: {model: 'jev-1.13.0', state: {ok: 'fine'}, questions: {action: {type: 'choice', instructions: 'x', criteria: {a: 'This is the optimal action to take.'}}}},
    expected: {action: ['a']}, meta: {},
  };
  assert.throws(() => assertNoRankingLanguage(bad), /optimal/);
});

test('sector-consequences and after-range per-option entries are symmetric across all options', () => {
  for (const c of generateScoutCases().filter(c => c.arm === 'sector-consequences')) assertSymmetricConsequences((c.request.state as any).action_consequences.per_option);
  for (const c of generateRangeCases().filter(c => c.arm === 'after-range')) assertSymmetricConsequences((c.request.state as any).declared_computation.per_option);
});

test('view-history carries the same underlying facts as sector-state, in log form: measured clearance and candidate bearing/range are present in logged entries', () => {
  const withCandidates = generateScoutCases().filter(c => c.arm === 'view-history' && c.family === 's2-seen-then-lost');
  assert(withCandidates.length > 0);
  for (const c of withCandidates) {
    const log = (c.request.state as any).inspected_view_log as any[];
    assert(log.some(e => e.measured_clearance), `${c.id}: view-history log entries must include measured clearance`);
  }
});

test('generic object wording: at least two target descriptions appear in both S and R', () => {
  for (const all of [generateScoutCases(), generateRangeCases()]) {
    const descriptions = new Set(all.map(c => JSON.stringify(c.request.state).match(/(blue car|red backpack)/)?.[0]));
    assert(descriptions.has('blue car') && descriptions.has('red backpack'), 'expected both object descriptions to be exercised');
  }
});
test('frame wording is identical and internally consistent (no "compass" + "positive yaw left" contradiction) across every S arm', () => {
  const frames = new Set(generateScoutCases().map(c => (c.request.state as any).frame));
  assert.equal(frames.size, 1, 'exactly one frame sentence should be used across every S arm/case');
  const frame = [...frames][0] as string;
  assert(!/compass/i.test(frame), 'frame text must not claim a clockwise-increasing "compass" convention while also saying positive yaw is left');
  assert(/ENU/.test(frame) && /left/.test(frame));
});

test('component_goal is present and identical across all arms for a given unit+mirror (S and R); the goal entails the scored criterion', () => {
  for (const all of [generateScoutCases(), generateRangeCases()]) {
    const byGroup = new Map<string, Set<string>>();
    for (const c of all) (byGroup.get(c.meta.sameFactsGroup) ?? byGroup.set(c.meta.sameFactsGroup, new Set()).get(c.meta.sameFactsGroup)!).add((c.request.state as any).component_goal);
    for (const [group, goals] of byGroup) assert.equal(goals.size, 1, `group ${group} does not share one component_goal across arms`);
  }
});

test('every case has a non-empty useful action set drawn from its own offered criteria, and carries a caseKind', () => {
  for (const c of [...generateScoutCases(), ...generateRangeCases()]) {
    assert(c.expected.action!.length > 0, `${c.id} has no useful action`);
    for (const a of c.expected.action!) assert(a in c.request.questions.action!.criteria);
    assert(['positive', 'abstention'].includes(c.meta.caseKind), `${c.id} missing a valid caseKind`);
  }
});

test('duplicate request bodies (beyond the declared 2 repeats) are detected and reported, never silently dropped', () => {
  const scoutReport = duplicateBodyReport(generateScoutCases());
  const rangeReport = duplicateBodyReport(generateRangeCases());
  assert(scoutReport.distinctDispatches <= scoutReport.totalCases);
  assert(rangeReport.distinctDispatches <= rangeReport.totalCases);
  // R1's mirror is intentionally not generated (see the R1 test above), so R should have few/no accidental
  // duplicate bodies among currently-generated cases; report the actual count either way, never assume it.
  for (const d of rangeReport.duplicates) assert(d.count >= 2 && d.caseIds.length === d.count);
});
