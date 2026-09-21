import assert from 'node:assert/strict';
import test from 'node:test';
import { createPassiveController } from '../experiments/jev-find-follow/controllers/passive.ts';
import { createSyntheticController } from '../experiments/jev-find-follow/controllers/synthetic.ts';
import { createReferenceController } from '../experiments/jev-find-follow/controllers/reference.ts';
import { createConstantController } from '../experiments/jev-find-follow/controllers/constant.ts';
import { createFirstOptionController } from '../experiments/jev-find-follow/controllers/first-option.ts';
import { createSeededRandomController } from '../experiments/jev-find-follow/controllers/seeded-random.ts';
import { buildTrackRequest } from '../experiments/jev-find-follow/encoders/track.ts';
import { buildSearchRequest } from '../experiments/jev-find-follow/encoders/search.ts';
import { createSectorMemory, DEFAULT_SECTOR_MEMORY_CONFIG, updateSectorMemory } from '../experiments/jev-find-follow/sector-memory.ts';
import type { Goal, OwnState } from '../experiments/jev-find-follow/types.ts';

const goal: Goal = { classes: ['car'], colour: 'blue', description: 'the blue car', requestedRangeM: 8 };
const ownState: OwnState = { headingDeg: 0, altitudeM: 1.8, odometryDisplacementM: { x: 0, y: 0 }, acquiredSimMs: 0 };
const ctx = { mode: 'track' as const, decisionIndex: 0, requestId: 'test-0' };
const signal = new AbortController().signal;

test('passive controller always holds, on every question, for both track and search requests', async () => {
  const controller = createPassiveController();
  const trackRequest = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.3, boundBearingUpRad: 0, boundRangeM: 12, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const trackResponse = await controller.answer(trackRequest, ctx, signal);
  assert.equal(trackResponse.answers.yaw!.choice, 'hold');
  assert.equal(trackResponse.answers.range!.choice, 'hold');
  assert.equal(trackResponse.synthetic, true);

  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const searchRequest = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const searchResponse = await controller.answer(searchRequest, { ...ctx, mode: 'search' }, signal);
  assert.equal(searchResponse.answers.action!.choice, 'hold');
});

test('synthetic controller answers deterministically given the decision index, cycling through offered options', async () => {
  const controller = createSyntheticController();
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0, boundBearingUpRad: 0, boundRangeM: 8, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const first = await controller.answer(request, { ...ctx, decisionIndex: 0 }, signal);
  const second = await controller.answer(request, { ...ctx, decisionIndex: 0 }, signal);
  assert.deepEqual(first.answers, second.answers, 'deterministic given the same decision index');
  const third = await controller.answer(request, { ...ctx, decisionIndex: 1 }, signal);
  assert.notDeepEqual(first.answers.yaw, third.answers.yaw, 'cycles rather than repeating the same option forever');
});

test('reference controller picks the yaw option minimising |resulting bearing| and the range option minimising |resulting signed error|', async () => {
  const controller = createReferenceController();
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 25 * Math.PI / 180, boundBearingUpRad: 0, boundRangeM: 9.3, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const response = await controller.answer(request, ctx, signal);
  // Bearing 25deg right: yaw_left_30 gives resulting 25+30=55 (worse), yaw_right_30 gives 25-30=-5 (best magnitude among the offered steps).
  assert.equal(response.answers.yaw!.choice, 'yaw_right_30');
  // Range 9.3 vs goal 8: signed error +1.3; approach_1m -> 8.3 (error +0.3, best).
  assert.equal(response.answers.range!.choice, 'approach_1m');
  assert.equal(response.synthetic, true);
});

test('reference controller holds when the range is unknown, rather than committing to an unsupported movement', async () => {
  const controller = createReferenceController();
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0, boundBearingUpRad: 0, boundRangeM: null, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const response = await controller.answer(request, ctx, signal);
  assert.equal(response.answers.range!.choice, 'hold');
});

test('reference controller holds when the target is currently visible (search mode)', async () => {
  const controller = createReferenceController();
  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const request = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: true, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const response = await controller.answer(request, { ...ctx, mode: 'search' }, signal);
  assert.equal(response.answers.action!.choice, 'hold');
});

test('reference controller turns toward a fresh last-seen bearing when nothing is currently visible', async () => {
  const controller = createReferenceController();
  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const request = buildSearchRequest({
    goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    lastSeen: { bearingDeg: 100, rangeM: 10, ownHeadingDegAtSighting: 0, acquiredSimMs: 0, ageMs: 500, ownPositionAtSightingM: { x: 0, y: 0, z: 1.8 } },
    lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences',
  });
  const response = await controller.answer(request, { ...ctx, mode: 'search' }, signal);
  assert.match(response.answers.action!.choice, /^yaw_left/, 'a last-seen bearing to the left of heading 0 should turn left');
});

// engine-review-e1 finding 4 regression: the pre-repair engine stored a last-seen sighting's raw
// CAMERA-RELATIVE bearing and consumers (this same reference-controller code path) read it as if
// it were an absolute world heading — harmless only when own heading happens to be unchanged since
// the sighting (every PRIOR test here has that coincidence and therefore could not catch the bug).
// Here own heading has rotated 90 degrees since the sighting, so the camera-relative and
// world-frame readings diverge and only the correct (world-frame) one steers toward the actual
// remembered world direction of the target.
test('reference controller turns toward the last-seen sighting\'s WORLD bearing, not its stale camera-relative value, once own heading has since changed', async () => {
  const controller = createReferenceController();
  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const rotatedOwnState: OwnState = { ...ownState, headingDeg: 90 }; // turned 90deg left since the sighting
  const request = buildSearchRequest({
    goal, ownState: rotatedOwnState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG,
    // Sighting recorded when own heading was 0: world bearing 170 (LastSeenRecord.bearingDeg is
    // ALWAYS world-frame per its own type contract — see camera-geometry.ts's worldBearingDeg).
    lastSeen: { bearingDeg: 170, rangeM: 10, ownHeadingDegAtSighting: 0, acquiredSimMs: 0, ageMs: 500, ownPositionAtSightingM: { x: 0, y: 0, z: 1.8 } },
    lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences',
  });
  const response = await controller.answer(request, { ...ctx, mode: 'search' }, signal);
  // From current heading 90, closing on world bearing 170 needs a further LEFT turn of 80deg; the
  // closest offered magnitude is yaw_left_90 (resulting heading 180, offset 10deg) — closer than
  // yaw_left_60 (resulting 150, offset -20deg) or any right/hold/180 option. A camera-relative
  // misreading (bearingDeg=170 read as still-camera-relative-to-NOW) would instead aim near 170deg
  // right of the CURRENT heading and pick a materially different (wrong) action.
  assert.equal(response.answers.action!.choice, 'yaw_left_90');
});

test('reference controller prefers the direction that recovers the most never-inspected heading when nothing is visible or recently seen', async () => {
  const controller = createReferenceController();
  let memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  memory = { ...memory, sectors: memory.sectors.map(s => ({ ...s, inspectedAgeMs: 5000 })) };
  const neverIdx = memory.sectors.findIndex(s => Math.abs(s.centerHeadingDeg - 180) < 1);
  memory = { ...memory, sectors: memory.sectors.map((s, i) => i === neverIdx ? { ...s, inspectedAgeMs: 'never' } : s) };
  const request = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const response = await controller.answer(request, { ...ctx, mode: 'search' }, signal);
  assert.equal(response.answers.action!.choice, 'turn_180');
});

test('constant controller always answers the same configured choice, and falls back to the first option when a question lacks it', async () => {
  const controller = createConstantController({ yaw: 'yaw_left_10', range: 'hold' });
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: -0.4, boundBearingUpRad: 0, boundRangeM: 20, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const first = await controller.answer(request, ctx, signal);
  assert.equal(first.answers.yaw!.choice, 'yaw_left_10');
  assert.equal(first.answers.range!.choice, 'hold');
  const memory = createSectorMemory(DEFAULT_SECTOR_MEMORY_CONFIG, { x: 0, y: 0 });
  const searchRequest = buildSearchRequest({ goal, ownState, targetCurrentlyVisible: false, memory, memoryConfig: DEFAULT_SECTOR_MEMORY_CONFIG, lastSeen: null, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000, receipts: [], variant: 'sector-consequences' });
  const searchResponse = await controller.answer(searchRequest, { ...ctx, mode: 'search' }, signal);
  assert.equal(searchResponse.answers.action!.choice, Object.keys(searchRequest.questions.action!.criteria)[0]);
});

test('first-option controller always answers the first offered option', async () => {
  const controller = createFirstOptionController();
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.2, boundBearingUpRad: 0, boundRangeM: 8.5, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const response = await controller.answer(request, ctx, signal);
  assert.equal(response.answers.yaw!.choice, Object.keys(request.questions.yaw!.criteria)[0]);
  assert.equal(response.answers.range!.choice, Object.keys(request.questions.range!.criteria)[0]);
});

test('seeded-random controller is deterministic given the same seed, and varies with a different seed', async () => {
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.2, boundBearingUpRad: 0, boundRangeM: 8.5, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  const a1 = await createSeededRandomController(7).answer(request, ctx, signal);
  const a2 = await createSeededRandomController(7).answer(request, ctx, signal);
  assert.deepEqual(a1.answers, a2.answers, 'same seed must reproduce the same answers');
  const results = await Promise.all([11, 12, 13, 14, 15].map(seed => createSeededRandomController(seed).answer(request, ctx, signal)));
  assert.ok(results.some(r => r.answers.yaw!.choice !== a1.answers.yaw!.choice), 'different seeds should not all coincide with seed 7 on this small menu');
});

test('every controller response validates: choice is an offered option, probabilities sum to 1 and cover every option', async () => {
  const request = buildTrackRequest({ goal, targetBound: true, boundBearingRightRad: 0.2, boundBearingUpRad: 0, boundRangeM: 8.5, ownState, mountPitchRad: 0, receipts: [], evidenceSource: 'bound', consequenceModel: 'stationary', rate: null, rangeMenuKind: 'fixed-distance' });
  for (const controller of [createPassiveController(), createSyntheticController(), createReferenceController(), createConstantController({}), createFirstOptionController(), createSeededRandomController(3)]) {
    const response = await controller.answer(request, ctx, signal);
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = response.answers[id]!;
      assert.ok(Object.keys(question.criteria).includes(answer.choice), `${controller.id}: ${answer.choice} not offered for ${id}`);
      const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - 1) < 1e-9);
      assert.deepEqual(Object.keys(answer.probabilities).sort(), Object.keys(question.criteria).sort());
    }
  }
});
