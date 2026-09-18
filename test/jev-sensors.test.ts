import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { renderCamera, framePng, readFramePng } from '../src/devices/pixel-camera.ts';
import { markerDetector } from '../src/perception/fiducial.ts';
import { pose, vec } from '../src/math.ts';
import { ReactiveWorld } from '../experiments/reactive/world.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../experiments/reactive/config.ts';
import { SENSOR_ARMS, sensorProfile } from '../experiments/jev-sensors/profile.ts';
import { sensorRequest, sensorController } from '../experiments/jev-sensors/controller.ts';
import { trial } from '../experiments/reactive/run.ts';
import { report } from '../experiments/jev-strategies/report.ts';
import type { Response } from '../experiments/jev-strategies/strategies.ts';
import { measuredGeometry } from '../experiments/jev-sensors/geometry.ts';

const config = experimentConfig({ ...DEFAULT_CONFIG, sensors: { ...DEFAULT_CONFIG.sensors, cooperativeBeacon: false } });
test('Metric marker perception uses pixels and calibration; occluded/unknown markers yield no pose', () => {
  const detect = markerDetector(), camera = { position: vec(0, 0, 4), headingDeg: 0, pitchDeg: -90, hfovDeg: 70 };
  const marker = { bodyId: 'rover', pose: pose(), sizeM: .4, markerId: 0 };
  const frame = renderCamera([], [marker], camera), measured = detect(frame.image, frame.calibration);
  assert(measured.length > 0); assert(Math.abs(measured[0].rangeM - 4) < .2);
  const restored = readFramePng(framePng(frame.image)); assert.deepEqual(restored, frame.image); assert.deepEqual(detect(restored, frame.calibration), measured);
  const closer = renderCamera([], [marker], { ...camera, position: vec(0, 0, 2) });
  assert(Math.abs(detect(closer.image, closer.calibration)[0].rangeM - 2) < .1);
  const wrong = renderCamera([], [{ ...marker, markerId: 1 }], camera); assert.deepEqual(detect(wrong.image, wrong.calibration), []);
  const blocked = renderCamera([{ id: 'screen', mode: 'fixed', pose: pose(0, 0, 2), shape: { kind: 'box', size: vec(2, 2, .2) } }], [marker], camera);
  assert.deepEqual(detect(blocked.image, blocked.calibration), []);
  const blank = renderCamera([], [], camera); assert.deepEqual(detect(blank.image, blank.calibration), []);
  // Incorrect calibration changes inferred metres: no hidden geometric-distance shortcut.
  assert(Math.abs(detect(frame.image, { ...frame.calibration, fx: frame.calibration.fx * 2, fy: frame.calibration.fy * 2 })[0].rangeM - 8) < .4);
});
test('Sensor-only port physically omits odometry, range cloud, target radio and contact oracle', async () => {
  const world = await ReactiveWorld.create(91, () => {}, 30000, config, sensorProfile('sensor-tfluna'));
  try {
    const port = world.controllerPort(), observation = await port.observe();
    assert.deepEqual(Object.keys(observation.sensors).sort(), ['camera', 'rangefinder']); assert.deepEqual(observation.inbox, []);
    assert.throws(() => world.state(), /no legacy/);
    const request = sensorRequest(observation, 'sensor-tfluna'); assert.equal(Object.keys(request.questions).length, 6);
    const changedGoal = { ...observation, goal: 'A different task' }; assert.deepEqual(sensorRequest(changedGoal, 'sensor-tfluna').questions, request.questions);
    const forged = structuredClone(observation); forged.sensors.odometry = observation.sensors.camera!;
    assert.throws(() => sensorRequest(forged, 'sensor-tfluna'), /Undeclared/);
    const captured = JSON.stringify((request.state as any).sensors);
    assert(!captured.includes('world-ENU')); assert(!captured.includes('target/base'));
  } finally { await world.close(); }
});
test('Rover-relative preprocessing derives directions from pixel pose, including rotated camera views', () => {
  const marker = { bodyId: 'test', pose: { ...pose(0, 0, .092), rotation: { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 } }, sizeM: .4, markerId: 0 };
  const detect = markerDetector();
  for (const [x, y] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
    const headingDeg = Math.atan2(-y!, -x!) * 180 / Math.PI, pitchDeg = -45;
    const frame = renderCamera([], [marker], { position: vec(x, y, 3), headingDeg, pitchDeg, hfovDeg: 70 });
    const geometry = measuredGeometry({ detections: detect(frame.image, frame.calibration), headingDeg, pitchDeg })[0].best;
    assert(Math.abs(geometry.droneAheadOfRoverM - x!) < .2); assert(Math.abs(geometry.droneLeftOfRoverM - y!) < .2);
    assert(Math.abs(geometry.droneAboveRoverM - 3) < .2); assert(Math.abs(geometry.roverHeadingDeg) < 1);
  }
  assert.deepEqual(measuredGeometry({ detections: [] }), []);
});
test('Printed roof marker remains detectable on the rendered rover, not just an isolated plane', () => {
  const body = { id: 'rover', mode: 'kinematic' as const, pose: pose(0, 0, .5), shape: { kind: 'box' as const, size: vec(.55, .55, .18), color: '#478bff' } };
  const marker = { bodyId: 'rover', pose: { ...pose(0, 0, .592), rotation: { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 } }, sizeM: .4, markerId: 0 };
  const detect = markerDetector();
  const frame = renderCamera([body], [marker], { position: vec(-3, 0, 3.5), headingDeg: 0, pitchDeg: -45, hfovDeg: 70 });
  const detections = detect(frame.image, frame.calibration);
  assert.equal(detections.length, 1); assert(Math.abs(detections[0].rangeM - Math.hypot(3, 3.5 - .592)) < .2);
  // A distant grazing view really loses the eight-cell pattern at this resolution.
  // It must stay unknown rather than borrowing the renderer's pose.
  const grazing = renderCamera([body], [marker], { position: vec(-7, 0, 1.5), headingDeg: 0, pitchDeg: -8, hfovDeg: 70 });
  assert.deepEqual(detect(grazing.image, grazing.calibration), []);
});
test('Sensor experiment audits actual PNG perception, UART and exact model-selected commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-sensors-fixture-')), arm = 'sensor-tfluna', seed = 91;
  try {
    let record = (_kind: string, _data: unknown) => {};
    const { controller, stats } = sensorController(arm, 'fixture', (kind, data) => record(kind, data), async request => ({ model: request.model,
      answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
        const selected = key === 'camera_heading' ? 'v4' : key === 'camera_zoom' ? 'wide' : 'v3';
        return [key, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(id => [id, id === selected ? 1 : 0])) }];
      })), usage: { input_tokens: 0 } } as Response));
    const result = await trial({ arm, seed, seconds: 3, directory, phase: 'fixture', config, controller, sensorExperiment: sensorProfile(arm, join(directory, 'frames', `${arm}-${seed}`)), connectControllerTrace: emit => { record = emit; } });
    assert.equal(stats.errors, 0); assert(stats.admitted > 0);
    await writeFile(join(directory, 'results.json'), JSON.stringify({ manifest: { phase: 'fixture', sourceHash: result.sourceHash, strategies: [arm], definitions: SENSOR_ARMS, seeds: [seed], seconds: 3 }, results: [{ ...result, stats }], invalidTrials: [] }));
    const evidence = await report(directory); assert(evidence.runs[0].checks.some((s: string) => s.includes('reproduced from pixels')));
    assert(evidence.runs[0].sensorCoverage.uniqueImages > 0);
    assert.equal(evidence.runs[0].sensorCoverage.observations, stats.started);
    assert.equal(evidence.runs[0].sensorCoverage.rangeObservations, stats.started);
    const decision = JSON.parse(await readFile(join(directory, evidence.runs[0].decisions[0].file), 'utf8'));
    const frameFile = join(directory, decision.rawObservation.sensors.camera.value.frame);
    const image = await readFile(frameFile); image[image.length - 10] ^= 1; await writeFile(frameFile, image);
    await assert.rejects(report(directory), /Camera frame hash differs/);
  } finally { assert(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
