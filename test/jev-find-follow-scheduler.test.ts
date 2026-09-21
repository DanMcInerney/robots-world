import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceToSimMs, commandAppliedSimMs, controllerReturnSimMs, DEFAULT_SCHEDULER_CONFIG,
  nextDispatchSimMs, observationAvailableSimMs, pacingWaitMs, planNextAcquisition, readyToDispatch, type TickWorld,
} from '../experiments/jev-find-follow/scheduler.ts';

test('planNextAcquisition: passing -cameraPeriodMs as the "after" time (the episode\'s very first call) acquires immediately at simulated time 0', () => {
  const plan = planNextAcquisition(-200, 0, 200);
  assert.equal(plan.acquireAtSimMs, 0);
  assert.deepEqual(plan.skippedBoundaries, []);
});

test('planNextAcquisition returns the very next boundary strictly after the last acquisition, never the same instant again', () => {
  const plan = planNextAcquisition(200, 0, 200);
  assert.equal(plan.acquireAtSimMs, 400);
});

test('planNextAcquisition skips (and counts) every camera boundary that falls while perception is busy: latest-wins', () => {
  // Last acquisition at t=0; perception then busy until 465ms (a real render+sensor round trip):
  // the camera's own next boundaries at 200/400 fall inside (0, 465) and must be skipped; the
  // acquisition lands on the first boundary at or after 465, i.e. 600.
  const plan = planNextAcquisition(0, 465, 200);
  assert.deepEqual(plan.skippedBoundaries, [200, 400]);
  assert.equal(plan.acquireAtSimMs, 600);
});

test('planNextAcquisition never skips when perception keeps pace with the camera period (5 Hz, 140ms latency)', () => {
  const plan = planNextAcquisition(200, 340, 200); // observationAvailable = acquiredAt(200) + 140 = 340 < next boundary 400
  assert.deepEqual(plan.skippedBoundaries, []);
  assert.equal(plan.acquireAtSimMs, 400);
});

test('planNextAcquisition DOES skip at 10 Hz when perception latency exceeds the camera period, matching the quiet-machine measurement (~3% skipped at 10 Hz)', () => {
  const plan = planNextAcquisition(0, 140, 100); // 10 Hz period=100ms, perception busy until 140ms
  assert.deepEqual(plan.skippedBoundaries, [100]);
  assert.equal(plan.acquireAtSimMs, 200);
});

test('planNextAcquisition rejects a non-positive period and a non-finite time', () => {
  assert.throws(() => planNextAcquisition(0, 0, 0));
  assert.throws(() => planNextAcquisition(NaN, 0, 200));
  assert.throws(() => planNextAcquisition(0, -1, 200));
});

test('observationAvailableSimMs / controllerReturnSimMs / commandAppliedSimMs are simple additive offsets', () => {
  assert.equal(observationAvailableSimMs(1000, 140), 1140);
  assert.equal(controllerReturnSimMs(1140, 250), 1390);
  assert.equal(commandAppliedSimMs(1390, 20), 1410);
});
test('the latency offsets reject a negative declared latency', () => {
  assert.throws(() => observationAvailableSimMs(0, -1));
  assert.throws(() => controllerReturnSimMs(0, -1));
  assert.throws(() => commandAppliedSimMs(0, -1));
});

test('pacingWaitMs enforces the floor between real wall-clock request starts', () => {
  assert.equal(pacingWaitMs(null, 505, 1000), 0, 'no prior request: no wait');
  assert.equal(pacingWaitMs(1000, 505, 1200), 305, 'only 200ms elapsed of the 505ms floor');
  assert.equal(pacingWaitMs(1000, 505, 1600), 0, 'floor already satisfied');
});

// "The world keeps moving during every delay": a fake world that simply counts elapsed ticks.
// advanceToSimMs must move it through EVERY gap in the cycle plan (acquire -> observation
// available -> controller return -> applied), never skip a gap silently.
function createFakeWorld(physicsDtMs: number): TickWorld & { ticksAdvanced: number } {
  let simMs = 0, ticksAdvanced = 0;
  return {
    get simMs() { return simMs; },
    get ticksAdvanced() { return ticksAdvanced; },
    advance(ticks: number) { simMs += ticks * physicsDtMs; ticksAdvanced += ticks; },
  };
}

test('advanceToSimMs steps the fake world through the exact simulated span, in fixed-size ticks', async () => {
  const world = createFakeWorld(20);
  await advanceToSimMs(world, 200, 20);
  assert.equal(world.simMs, 200);
  assert.equal(world.ticksAdvanced, 10);
});

test('advanceToSimMs is a no-op when already at the target time', async () => {
  const world = createFakeWorld(20);
  await advanceToSimMs(world, 200, 20);
  const ticksBefore = world.ticksAdvanced;
  await advanceToSimMs(world, 200, 20);
  assert.equal(world.ticksAdvanced, ticksBefore);
});

test('advanceToSimMs refuses to move the world backward', async () => {
  const world = createFakeWorld(20);
  await advanceToSimMs(world, 200, 20);
  await assert.rejects(() => advanceToSimMs(world, 100, 20));
});

test('advanceToSimMs rounds UP to the next tick for a target that falls between two ticks, so it never covers less than requested', async () => {
  const world = createFakeWorld(20);
  await advanceToSimMs(world, 205, 20);
  assert.equal(world.simMs, 220); // ceil(205/20) = 11 ticks = 220ms, never 200 (which would be short)
});

// engine-review-e2 finding 7: `planCycle` (a single-acquisition-per-decision composer) was removed
// as genuinely unused dead code once episode.ts's decoupled loop stopped matching its 1:1 shape —
// this test now composes the same pure pieces directly, the way episode.ts itself does, to keep
// the "world keeps moving during every stage" property covered.
test('the pure per-stage timestamps, driven through advanceToSimMs, advance the fake world through EVERY delay (acquire, perception, controller, admission) with no gap skipped', async () => {
  const world = createFakeWorld(20);
  const config = DEFAULT_SCHEDULER_CONFIG;
  const acquisition = planNextAcquisition(-config.cameraPeriodMs, 0, config.cameraPeriodMs);
  const observationAvailable = observationAvailableSimMs(acquisition.acquireAtSimMs, config.perceptionLatencyMs);
  const returnedSimMs = controllerReturnSimMs(observationAvailable, config.controllerLatencyMs);
  const appliedSimMs = commandAppliedSimMs(returnedSimMs, config.admissionDelayMs);
  await advanceToSimMs(world, acquisition.acquireAtSimMs, 20);
  const atAcquire = world.simMs;
  await advanceToSimMs(world, observationAvailable, 20); // world moves during perception latency
  const atObservation = world.simMs;
  await advanceToSimMs(world, returnedSimMs, 20); // world moves during controller latency
  const atReturn = world.simMs;
  await advanceToSimMs(world, appliedSimMs, 20); // world moves during admission delay
  assert.ok(atAcquire < atObservation && atObservation < atReturn && atReturn < world.simMs, 'the world must keep advancing through every stage, never freeze while "waiting" for perception/the controller');
  assert.ok(world.simMs >= appliedSimMs, 'the world must cover at least the declared applied time (tick rounding may round up, never down)');
});

// engine-review-e1 finding 3: decoupling acquisition (its own cameraPeriodMs grid) from decision
// dispatch (gated by the pacing floor in SIMULATED time, not only wall time) needs its own pure,
// tested arithmetic rather than a hand re-implementation inline in the episode loop.
test('nextDispatchSimMs: the first decision may dispatch as soon as its observation is available', () => {
  assert.equal(nextDispatchSimMs(340, null, 505), 340);
});
test('nextDispatchSimMs: a later decision waits for the LARGER of observation-availability and the simulated pacing floor', () => {
  assert.equal(nextDispatchSimMs(600, 0, 505), 600, 'observation availability dominates when it is later than the floor');
  assert.equal(nextDispatchSimMs(300, 0, 505), 505, 'the floor dominates when the observation was ready early (fast camera, slow floor)');
});
test('readyToDispatch: false while the pacing floor has not yet elapsed in SIMULATED time, true once it has', () => {
  assert.equal(readyToDispatch(300, 0, 505), false, '300ms sim-time observation, but the floor needs 505ms');
  assert.equal(readyToDispatch(505, 0, 505), true);
  assert.equal(readyToDispatch(0, null, 505), true, 'the very first decision is always ready');
});

test('scheduler config exposes the coordinator-measured quiet-machine defaults', () => {
  assert.equal(DEFAULT_SCHEDULER_CONFIG.perceptionLatencyMs, 140);
  assert.equal(DEFAULT_SCHEDULER_CONFIG.cameraPeriodMs, 200); // 5 Hz default
  assert.equal(DEFAULT_SCHEDULER_CONFIG.pacingFloorMs, 505);
});
