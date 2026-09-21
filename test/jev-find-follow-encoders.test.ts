import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTrackRequest } from '../experiments/jev-find-follow/encoders/track.ts';
import { buildSearchRequest } from '../experiments/jev-find-follow/encoders/search.ts';
import { determineMode } from '../experiments/jev-find-follow/encoders/mode.ts';
import { assertNoEvaluatorLeak, assertNoRankingLanguage, assertSymmetricConsequences } from '../experiments/jev-find-follow/checks.ts';
import { coveredSectors, createSectorMemory, DEFAULT_SECTOR_MEMORY_CONFIG, updateSectorMemory } from '../experiments/jev-find-follow/sector-memory.ts';
import type { Goal, OwnState } from '../experiments/jev-find-follow/types.ts';

const goal: Goal = { classes: ['car'], colour: 'blue', description: 'the blue car', requestedRangeM: 8 };
const ownState: OwnState = { headingDeg: 10, altitudeM: 1.8, odometryDisplacementM: { x: 0, y: 0 }, acquiredSimMs: 1000 };
const trackDefaults = { evidenceSource: 'bound' as const, consequenceModel: 'stationary' as const, rate: null, rangeMenuKind: 'fixed-distance' as const };

test('track request: symmetric per-option yaw/range consequences, no evaluator leak, no ranking language', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults,
  });
  assert.doesNotThrow(() => assertNoEvaluatorLeak(request));
  assert.doesNotThrow(() => assertNoRankingLanguage(request));
  assert.ok(request.questions.yaw && request.questions.range, 'two independent questions in one call');
  assertSymmetricConsequences((request.state.yaw_consequences as any).per_option);
  assertSymmetricConsequences((request.state.range_consequences as any).per_option);
});

test('track request: turning left by yawDeg increases the resulting bearing by yawDeg (stationary/full-execution hypothesis)', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0.0, boundBearingUpRad: 0, boundRangeM: 8, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults,
  });
  const perOption = (request.state.yaw_consequences as any).per_option as { action: string; resulting_bearing_deg: number | null }[];
  const left30 = perOption.find(o => o.action === 'yaw_left_30')!;
  const right30 = perOption.find(o => o.action === 'yaw_right_30')!;
  const hold = perOption.find(o => o.action === 'hold')!;
  assert.equal(hold.resulting_bearing_deg, 0);
  assert.equal(left30.resulting_bearing_deg, 30);
  assert.equal(right30.resulting_bearing_deg, -30);
});

test('track request: unknown range is explicit (null) for every range option, not omitted or guessed', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0.1, boundBearingUpRad: 0, boundRangeM: null, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults,
  });
  const perOption = (request.state.range_consequences as any).per_option as { action: string; resulting_range_m: number | null }[];
  assert.ok(perOption.every(o => o.resulting_range_m === null));
  assert.equal((request.state.current_view as any).range_m, null);
});

test('track request: an approach action reduces resulting range and moves the signed error toward zero', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0, boundBearingUpRad: 0, boundRangeM: 10, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults,
  });
  const perOption = (request.state.range_consequences as any).per_option as { action: string; resulting_range_m: number; resulting_signed_error_m: number }[];
  const approach2 = perOption.find(o => o.action === 'approach_2m')!;
  assert.equal(approach2.resulting_range_m, 8);
  assert.equal(approach2.resulting_signed_error_m, 0); // requestedRangeM = 8
});

// engine-review-e2 finding 3's own probes, reproduced exactly at the encoder level (hand-computed
// expectations) — these are the tests the review found missing ("no test covers measured-rate,
// explicitly-unknown-prediction or the speed-hold encoder").
test('track request (measured-rate): the reviewer\'s bearing-rate probe — target at +2deg drifting RIGHT at 5deg/s gives ~+7deg for hold, not -3deg', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 2 * Math.PI / 180, boundBearingUpRad: 0, boundRangeM: 8, ownState, mountPitchRad: 0, receipts: [],
    evidenceSource: 'bound',
    consequenceModel: 'measured-rate',
    // Drifting RIGHT (camera-relative, increasing bearingRightRad) is a NEGATIVE world-frame
    // (ENU/counter-clockwise-positive) rate — see camera-geometry.ts's worldBearingDeg convention.
    rate: { rangeRateMps: 'unknown', bearingRateDegS: -5, sampleCount: 5, windowMs: 1000, rangeRateSource: 'none', bearingRateSource: 'current', rangeRateAgeMs: null, bearingRateAgeMs: null },
    rangeMenuKind: 'fixed-distance',
  });
  const perOption = (request.state.yaw_consequences as any).per_option as { action: string; resulting_bearing_deg: number | null }[];
  const hold = perOption.find(o => o.action === 'hold')!;
  assert.ok(Math.abs(hold.resulting_bearing_deg! - 7) < 0.01, `expected ~+7deg (the pre-fix sign bug reported -3deg), got ${hold.resulting_bearing_deg}`);
});

test('track request (measured-rate): the reviewer\'s range-rate probe — a STATIONARY target (rate already ego-motion-compensated to 0 m/s by rate-estimate.ts) with the drone closing at speed_1_0 predicts 8.6m from a 9.6m start, not 7.6m', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0, boundBearingUpRad: 0, boundRangeM: 9.6, ownState, mountPitchRad: 0, receipts: [],
    evidenceSource: 'bound', consequenceModel: 'measured-rate',
    rate: { rangeRateMps: 0, bearingRateDegS: 'unknown', sampleCount: 5, windowMs: 1000, rangeRateSource: 'current', bearingRateSource: 'none', rangeRateAgeMs: null, bearingRateAgeMs: null }, // 0 = the CORRECTLY compensated target-only rate
    rangeMenuKind: 'speed-hold',
  });
  const perOption = (request.state.range_consequences as any).per_option as { action: string; resulting_range_m: number | null }[];
  const speed1 = perOption.find(o => o.action === 'speed_1_0')!;
  assert.ok(Math.abs(speed1.resulting_range_m! - 8.6) < 0.01, `expected 8.6m (the pre-fix ego-motion-uncompensated bug would have reported 7.6m), got ${speed1.resulting_range_m}`);
});

test('track request (explicitly-unknown-prediction): an unavailable rate renders the literal "unknown" (null), never a silent stationary guess', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 2 * Math.PI / 180, boundBearingUpRad: 0, boundRangeM: 9.6, ownState, mountPitchRad: 0, receipts: [],
    evidenceSource: 'bound', consequenceModel: 'explicitly-unknown-prediction',
    rate: { rangeRateMps: 'unknown', bearingRateDegS: 'unknown', sampleCount: 1, windowMs: 1000, rangeRateSource: 'none', bearingRateSource: 'none', rangeRateAgeMs: null, bearingRateAgeMs: null },
    rangeMenuKind: 'speed-hold',
  });
  const yawPerOption = (request.state.yaw_consequences as any).per_option as { action: string; resulting_bearing_deg: number | null }[];
  const rangePerOption = (request.state.range_consequences as any).per_option as { action: string; resulting_range_m: number | null }[];
  assert.ok(yawPerOption.every(o => o.resulting_bearing_deg === null), 'every yaw option must render unknown, not a stationary fallback');
  assert.ok(rangePerOption.every(o => o.resulting_range_m === null), 'every range option must render unknown, not a stationary fallback');
});

test('track request (measured-rate with an available rate): the speed-hold encoder actually uses the rate, not merely the stationary formula', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0, boundBearingUpRad: 0, boundRangeM: 10, ownState, mountPitchRad: 0, receipts: [],
    evidenceSource: 'bound', consequenceModel: 'measured-rate',
    rate: { rangeRateMps: 1.5, bearingRateDegS: 'unknown', sampleCount: 5, windowMs: 1000, rangeRateSource: 'current', bearingRateSource: 'none', rangeRateAgeMs: null, bearingRateAgeMs: null }, // target itself receding at 1.5 m/s
    rangeMenuKind: 'speed-hold',
  });
  const perOption = (request.state.range_consequences as any).per_option as { action: string; resulting_range_m: number | null }[];
  const hold = perOption.find(o => o.action === 'hold')!; // 0 m/s closing
  const speed2 = perOption.find(o => o.action === 'speed_2_0')!;
  // hold: resulting = 10 + (1.5 - 0)*1.0 = 11.5 (target recedes, drone does nothing)
  assert.ok(Math.abs(hold.resulting_range_m! - 11.5) < 0.01, `expected 11.5m, got ${hold.resulting_range_m}`);
  // speed_2_0: resulting = 10 + (1.5 - 2.0)*1.0 = 9.5 (drone closes faster than the target recedes)
  assert.ok(Math.abs(speed2.resulting_range_m! - 9.5) < 0.01, `expected 9.5m, got ${speed2.resulting_range_m}`);
});

// Increment B1: single-axis question modes (the ladder's L1/L2 rungs).
test('track request (questionMode yaw-only): only the yaw question and yaw_consequences are rendered', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [],
    ...trackDefaults, questionMode: 'yaw-only',
  });
  assert.deepEqual(Object.keys(request.questions), ['yaw']);
  assert.ok('yaw_consequences' in request.state);
  assert.ok(!('range_consequences' in request.state));
  // Every other fact stays identical to the 'both' mode.
  assert.ok('current_view' in request.state && 'rate_estimate' in request.state);
});
test('track request (questionMode range-only): only the range question and range_consequences are rendered', () => {
  const request = buildTrackRequest({
    goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [],
    ...trackDefaults, questionMode: 'range-only',
  });
  assert.deepEqual(Object.keys(request.questions), ['range']);
  assert.ok('range_consequences' in request.state);
  assert.ok(!('yaw_consequences' in request.state));
});
test('track request (questionMode both, the default): both questions are rendered, matching omitting questionMode entirely', () => {
  const explicit = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults, questionMode: 'both' });
  const implicit = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults });
  assert.deepEqual(explicit, implicit);
  assert.deepEqual(Object.keys(explicit.questions).sort(), ['range', 'yaw']);
});

// A7 (engine-review-e3 finding 7): "Decide independently of the range/yaw question" is confusing in
// a single-axis request, where the OTHER question does not exist in the request at all -- it must
// only appear when both questions genuinely coexist.
test('track request: the "decide independently" clause appears ONLY when both questions coexist (questionMode "both"), never in a single-axis request', () => {
  const both = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults, questionMode: 'both' });
  assert.match(both.questions.yaw!.instructions, /independently of the range question/);
  assert.match(both.questions.range!.instructions, /independently of the yaw question/);

  const yawOnly = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults, questionMode: 'yaw-only' });
  assert.doesNotMatch(yawOnly.questions.yaw!.instructions, /independently/, 'yaw-only: no range question exists in this request at all, so nothing to "decide independently of"');

  const rangeOnly = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults, questionMode: 'range-only' });
  assert.doesNotMatch(rangeOnly.questions.range!.instructions, /independently/, 'range-only: no yaw question exists in this request at all, so nothing to "decide independently of"');
});

// A7 (engine-review-e3 finding 7, "goal sentence omits episode length"): stated numerically, in
// both the track and search encoders, when the caller supplies it; omitted (not guessed) otherwise.
test('track and search requests state the episode\'s declared length in the goal sentence when supplied, and omit it (never guess) when not', () => {
  const withDuration = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults, episodeDurationMs: 45000 });
  assert.match(withDuration.state.goal as string, /45 s/);
  const withoutDuration = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.05, boundBearingUpRad: 0, boundRangeM: 9.2, ownState, mountPitchRad: 0, receipts: [], ...trackDefaults });
  assert.doesNotMatch(withoutDuration.state.goal as string, /lasts up to/);

  const memory = buildMemory();
  const searchWithDuration = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 5000, lastSeenStaleMs: 20000, receipts: [], episodeDurationMs: 20000 });
  assert.match(searchWithDuration.state.goal as string, /20 s/);
});

test('determineMode: bound -> track; none with no last-seen -> search; a fresh last-seen (no binding) -> track; ambiguous stays in track (ladder mode-switch spec)', () => {
  assert.equal(determineMode({ status: 'bound', candidates: [], boundIndex: 0 }, null, 3000).mode, 'track');
  assert.equal(determineMode({ status: 'none', candidates: [], boundIndex: null }, null, 3000).mode, 'search');
  assert.equal(determineMode({ status: 'none', candidates: [], boundIndex: null }, 1000, 3000).mode, 'track');
  assert.equal(determineMode({ status: 'none', candidates: [], boundIndex: null }, 5000, 3000).mode, 'search', 'a stale last-seen record must not keep track mode alive');
  // engine-review-e1 finding 9 / ladder L5: "On ambiguous identity ... stays in track mode ...
  // rather than reverting to search." This regresses on pre-repair code, which returned 'search'.
  assert.equal(determineMode({ status: 'ambiguous', candidates: [], boundIndex: null }, null, 3000).mode, 'track');
});

function buildMemory() {
  let memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const clearance = new Map(coveredSectors(90, DEFAULT_SECTOR_MEMORY_CONFIG).map(idx => [idx, { status: 'open' as const, toM: 6, ageMs: 100 }]));
  memory = updateSectorMemory(memory, DEFAULT_SECTOR_MEMORY_CONFIG, 90, 1000, { x: 0, y: 0 }, clearance, null);
  return memory;
}

// engine-review-e1 finding 9: goal.description already carries its own article ("the blue car");
// componentGoal's policy text previously prefixed it with another "the", rendering "reconfirming
// the the blue car" anywhere that text appeared.
test('search request: component_goal never doubles the article ("the the") before the goal description', () => {
  const memory = buildMemory();
  const request = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  assert.doesNotMatch(request.state.component_goal as string, /\bthe the\b/i);
  assert.match(request.state.component_goal as string, /reconfirming the blue car/);
});

test('search request: symmetric per-option consequences, no evaluator leak, no ranking language', () => {
  const memory = buildMemory();
  const request = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences',
  });
  assert.doesNotThrow(() => assertNoEvaluatorLeak(request));
  assert.doesNotThrow(() => assertNoRankingLanguage(request));
  assertSymmetricConsequences((request.state.action_consequences as any).per_option);
  assert.equal(Object.keys(request.questions).length, 1);
});

test('search request variants share IDENTICAL underlying facts (sector_memory, current_view, receipts) and differ ONLY in the declared per-option fields', () => {
  const memory = buildMemory();
  const base = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const withDeg = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences-never-inspected-deg' });
  assert.deepEqual(base.state.sector_memory, withDeg.state.sector_memory);
  assert.deepEqual(base.state.current_view, withDeg.state.current_view);
  assert.deepEqual(base.state.command_receipts, withDeg.state.command_receipts);
  const basePerOption = (base.state.action_consequences as any).per_option;
  const withDegPerOption = (withDeg.state.action_consequences as any).per_option;
  assert.ok(!('new_never_inspected_deg' in basePerOption[0]));
  assert.ok('new_never_inspected_deg' in withDegPerOption[0]);
  assert.ok(!('never_inspected_heading_reachable_by_yaw_deg' in base.state));
  assert.ok('never_inspected_heading_reachable_by_yaw_deg' in withDeg.state);
  // Stripping the declared extra fields must leave byte-identical per-option facts.
  const stripped = withDegPerOption.map(({ new_never_inspected_deg, ...rest }: any) => rest);
  assert.deepEqual(stripped, basePerOption);
});

test('search request: a translate option never carries a resulting_heading_deg different from the current heading (translation does not turn the camera)', () => {
  const memory = buildMemory();
  const request = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const perOption = (request.state.action_consequences as any).per_option as { action: string; resulting_heading_deg: number; movement_direction_clearance: unknown }[];
  const heading = (request.state.current_view as any).heading_deg;
  for (const option of perOption) if (option.movement_direction_clearance !== null) assert.equal(option.resulting_heading_deg, heading);
});

test('search request: target currently visible is stated plainly and the component_goal directs hold in that case', () => {
  const memory = buildMemory();
  const request = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: true, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  assert.equal((request.state.current_view as any).target_visible_now, true);
  assert.match(request.state.component_goal as string, /hold/i);
});
