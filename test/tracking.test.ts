import assert from 'node:assert/strict';
import test from 'node:test';
import type { Observation, SensorReading, Vec3 } from '../src/contracts.ts';
import { add, distance, pose, scale, sub, vec } from '../src/math.ts';
import { World } from '../src/world.ts';
import { createTrackingExperiment, type TrackingExperiment } from '../experiments/tracking.ts';

type TrackerValue = { visible: boolean; relative: Vec3 | null; origin?: Vec3; frame?: string };
const tracker = (observation: Observation): TrackerValue => observation.sensors.target.value as unknown as TrackerValue;
const value = (reading: SensorReading): TrackerValue => reading.value as unknown as TrackerValue;
async function advance(experiment: TrackingExperiment, world: World, untilMs: number) {
  while (world.simMs < untilMs-1e-7) { experiment.update(world); await world.advance(); }
}

test('tracking trajectories repeat by seed, vary across seeds and stay continuous at abrupt turns', () => {
  const first = createTrackingExperiment({ seed: 42 });
  const second = createTrackingExperiment({ seed: 42 });
  const other = createTrackingExperiment({ seed: 43 });
  const times = [0, 1000, 7999, 8000, 8001, 14000, 19999, 20000, 20001, 30000];
  assert.deepEqual(times.map(first.target), times.map(second.target));
  assert.notDeepEqual(times.map(first.target), times.map(other.target));
  for (const turn of [8000, 20000]) {
    const before = first.target(turn-1), at = first.target(turn), after = first.target(turn+1);
    assert.ok(distance(before, at) < 0.002 && distance(at, after) < 0.002, 'no target teleport at reversal');
    assert.ok((at.y-before.y)*(after.y-at.y) < 0, 'lateral velocity reverses');
    assert.ok(before.x < at.x && at.x < after.x, 'forward motion continues through the turn');
  }
  assert.deepEqual(first.events.map(event => [event.kind, event.simMs]), [['lateral-reversal', 8000], ['occlusion-start', 14000], ['occlusion-end', 16000], ['lateral-reversal', 20000]]);
  assert.throws(() => createTrackingExperiment({ seed: NaN }), /seed/);
  assert.throws(() => createTrackingExperiment({ seed: 1, sensorLatencyMs: -1 }), /latency/);
  assert.throws(() => createTrackingExperiment({ seed: 1, sensorDropout: 2 }), /dropout/);
});

test('tracking physics and sampled target positions agree after every independently advanced tick', async () => {
  const experiment = createTrackingExperiment({ seed: 7, occlusion: false });
  const world = await World.create(experiment.scenario, experiment.registry);
  const port = world.claim('drone', 'tracking-test');
  try {
    for (let index = 0; index < 30; index++) {
      experiment.update(world); await world.advance();
      assert.ok(distance(world.physics.body('tracking-target').pose.position, experiment.target(world.simMs)) < 1e-6);
      const observation = await port.observe();
      const reading = observation.sensors.target;
      const sensed = tracker(observation);
      assert.equal(sensed.visible, true);
      assert.ok(distance(add(sensed.origin!, sensed.relative!), experiment.target(reading.acquiredSimMs)) < 1e-6);
      assert.equal(sensed.frame, 'world-ENU');
      assert.deepEqual(Object.keys(sensed).sort(), ['frame', 'origin', 'relative', 'visible']);
      assert.equal(Object.hasOwn(observation, 'target'), false);
      assert.equal(Object.hasOwn(observation, 'bodies'), false);
      assert.equal(Object.hasOwn(observation, 'scenario'), false);
      assert.equal(Object.hasOwn(port, 'physics'), false);
    }
    const description = await port.describe();
    assert.equal(Object.hasOwn(description, 'trajectory'), false);
    assert.deepEqual(description.sensors.map(sensor => [sensor.id, sensor.hz]), [['odometry',50], ['lidar',20], ['target',10]]);
  } finally { world.close(); }
});

test('tracking latency retains acquisition timestamps while dropout withholds target data only', async () => {
  const experiment = createTrackingExperiment({ seed: 10, sensorLatencyMs: 250, occlusion: false });
  const world = await World.create(experiment.scenario, experiment.registry);
  const port = world.claim('drone', 'latency-test');
  try {
    assert.equal((await port.observe()).sensors.target.reason, 'unavailable');
    await port.command({id:'move-during-sensor-latency',action:'velocity',args:{x:2,y:0,z:0},validForMs:1000});
    await advance(experiment, world, 240);
    assert.equal((await port.observe()).sensors.target.reason, 'unavailable');
    await advance(experiment, world, 260);
    const reading = (await port.observe()).sensors.target;
    assert.equal(reading.acquiredSimMs, 0); assert.equal(reading.receivedSimMs, 260);
    assert.deepEqual(value(reading).origin,vec(0,0,1.5));
    assert.ok(distance(add(value(reading).origin!, value(reading).relative!), experiment.target(0)) < 1e-6);
    assert.ok(distance(world.physics.body('drone/base').pose.position,value(reading).origin!)>.05,'robot moved while the old frame was in flight');
    assert.ok(distance(add(value(reading).origin!, value(reading).relative!), experiment.target(260)) > 0.05);
  } finally { world.close(); }
  const dropped = createTrackingExperiment({ seed: 10, sensorDropout: 1 });
  const lostWorld = await World.create(dropped.scenario, dropped.registry);
  const lostPort = lostWorld.claim('drone', 'dropout-test');
  try {
    await advance(dropped, lostWorld, 400);
    const observation = await lostPort.observe();
    assert.equal(observation.sensors.target.valid, false);
    assert.equal(observation.sensors.odometry.valid, true);
    assert.equal(observation.sensors.lidar.valid, true);
  } finally { lostWorld.close(); }
});

test('tracking noise is bounded in metres and repeats independently of the world epoch', async () => {
  const samples: TrackerValue[][] = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const experiment = createTrackingExperiment({ seed: 123, occlusion: false });
    experiment.scenario.robots[0].sensors.find(sensor => sensor.id === 'target')!.noise = 0.2;
    const world = await World.create(experiment.scenario, experiment.registry);
    const port = world.claim('drone', 'noise-test');
    const readings: TrackerValue[] = [];
    try {
      for (let time = 0; time <= 500; time += 100) {
        await advance(experiment, world, time);
        const reading = (await port.observe()).sensors.target;
        const actual = value(reading); readings.push(actual);
        const expected = sub(experiment.target(reading.acquiredSimMs), actual.origin!);
        assert.equal(actual.visible, true);
        for (const axis of ['x','y','z'] as const) assert.ok(Math.abs(actual.relative![axis]-expected[axis]) <= 0.200001);
        assert.ok(distance(actual.relative!, expected) > 1e-5, 'configured noise actually changes measurements');
      }
    } finally { world.close(); }
    samples.push(readings);
  }
  assert.deepEqual(samples[0], samples[1]);
});

test('tracking visibility obeys real ray obstruction, range, and timed forced occlusion', async () => {
  const occluded = createTrackingExperiment({ seed: 42, occlusion: false });
  const target = occluded.target(0);
  occluded.scenario.obstacles.push({ id: 'test-screen', mode: 'fixed', pose: { ...pose(), position: scale(add(vec(0,0,1.5), target), 0.5) },
    shape: { kind: 'box', size: vec(0.2, 1, 1) } });
  const blockedWorld = await World.create(occluded.scenario, occluded.registry);
  try { assert.deepEqual(tracker(await blockedWorld.claim('drone', 'blocked').observe()), { visible: false, relative: null }); }
  finally { blockedWorld.close(); }

  const limited = createTrackingExperiment({ seed: 42, occlusion: false });
  limited.scenario.robots[0].sensors.find(sensor => sensor.id === 'target')!.config = { rangeM: 1 };
  const farWorld = await World.create(limited.scenario, limited.registry);
  try { assert.deepEqual(tracker(await farWorld.claim('drone', 'range').observe()), { visible: false, relative: null }); }
  finally { farWorld.close(); }

  const experiment = createTrackingExperiment({ seed: 42 });
  const world = await World.create(experiment.scenario, experiment.registry);
  const port = world.claim('drone', 'occlusion-test');
  try {
    await advance(experiment, world, 13900); assert.equal(tracker(await port.observe()).visible, true);
    await advance(experiment, world, 14000); assert.deepEqual(tracker(await port.observe()), { visible: false, relative: null });
    await advance(experiment, world, 15900); assert.equal(tracker(await port.observe()).visible, false);
    await advance(experiment, world, 16000); assert.equal(tracker(await port.observe()).visible, true);
    const transitions = world.journal.after().filter(event => event.kind === 'tracking.event');
    assert.equal(transitions.filter(event => (event.data as { id: string }).id === 'occlusion-start').length, 1);
    assert.equal(transitions.filter(event => (event.data as { id: string }).id === 'occlusion-end').length, 1);
  } finally { world.close(); }
});
