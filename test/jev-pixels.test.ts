import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { colorRegions, colorTracker } from '../src/perception/color-tracks.ts';
import { renderCamera } from '../src/devices/pixel-camera.ts';
import { pose, vec } from '../src/math.ts';
import { PIXEL_ARMS, pixelRequest, mapPixelAnswer, pixelController, type PixelArm } from '../experiments/jev-pixels/controller.ts';
import { PIXEL_TASK, pixelProfile } from '../experiments/jev-pixels/profile.ts';
import { pixelReport } from '../experiments/jev-pixels/report.ts';
import { ReactiveWorld } from '../experiments/reactive/world.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../experiments/reactive/config.ts';
import { trial } from '../experiments/reactive/run.ts';
import type { Request, Response } from '../experiments/jev-strategies/strategies.ts';

const config = experimentConfig({ ...DEFAULT_CONFIG, sensors: { ...DEFAULT_CONFIG.sensors, cooperativeBeacon: false } });
function response(request: Request, overrides: Record<string, string> = {}): Response {
  return { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const ids = Object.keys(q.criteria), selected = overrides[id] ?? (id.endsWith('yaw') ? 'v4' : id.endsWith('zoom') ? 'wide' : id === 'xy' ? 'v3_3' : id === 'context' ? 'hold' : 'v3');
    assert(ids.includes(selected)); return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(ids.map(v => [v, v === selected ? 1 : 0])) }];
  })) };
}
test('Color perception depends on pixels, preserves distractors, reverses bearing and loses hidden objects', () => {
  const camera = { position: vec(0, 0, 1), headingDeg: 0, pitchDeg: 0, hfovDeg: 70 };
  const body = (id: string, y: number, color: string) => ({ id, mode: 'fixed' as const, pose: pose(3, y, 1), shape: { kind: 'box' as const, size: vec(.5, .5, .5), color } });
  const frame = renderCamera([body('hidden-simulator-name', .7, '#407aee'), body('distractor', -.7, '#dd8844')], [], camera, 320, 180);
  const objects = colorRegions(frame.image, frame.calibration); assert.equal(objects.length, 2);
  const blue = objects.find(o => o.color === 'blue')!; assert(blue.rightDeg < 0); assert(!JSON.stringify(objects).includes('hidden-simulator-name'));
  const mirror = renderCamera([body('renamed', -.7, '#407aee')], [], camera, 320, 180);
  assert(colorRegions(mirror.image, mirror.calibration)[0]!.rightDeg > 0);
  const alteredMetadata = { ...frame.image, simulatorTarget: vec(100, 100, 100), goal: 'ignore blue' };
  assert.deepEqual(colorRegions(alteredMetadata, frame.calibration), objects);
  const track = colorTracker(); assert(track(frame.image, frame.calibration, 0).objects.length);
  const second = track(frame.image, frame.calibration, 200).objects; assert(second.every(o => o.history.length === 1));
  const blank = renderCamera([], [], camera, 320, 180); assert.deepEqual(track(blank.image, blank.calibration, 400).objects, []);
});
test('Pixel-only task exposes no oracle, changes goal, preserves full controls and maps body coordinates', async () => {
  const world = await ReactiveWorld.create(81, () => {}, 600, config, pixelProfile(), PIXEL_TASK);
  try {
    const port = world.controllerPort(), observation = await port.observe();
    assert.deepEqual(Object.keys(observation.sensors), ['camera']); assert.equal(observation.goal, PIXEL_TASK.goal(1));
    const camera = observation.sensors.camera!.value as any; assert(camera.objects.some((o: any) => o.color === 'blue'));
    const numeric = pixelRequest(observation, 'pixels-numeric'), words = pixelRequest(observation, 'pixels-words'), joint = pixelRequest(observation, 'pixels-joint');
    assert.equal(Object.keys(numeric.questions).length, 6); assert.equal(Object.keys(joint.questions).length, 5); assert.equal(Object.keys(joint.questions.xy!.criteria).length, 49);
    assert.deepEqual(numeric.questions, words.questions);
    const a = mapPixelAnswer(numeric, response(numeric, { forward: 'v5', right: 'v2' })), b = mapPixelAnswer(joint, response(joint, { xy: 'v5_2' }));
    assert.deepEqual(a.action, b.action); assert.deepEqual(a.bodyVelocity, [.6, -.2, 0]);
    assert(Math.abs(Math.hypot(a.action.x, a.action.y) - Math.hypot(.6, .2)) < 1e-9);
    const h = (numeric.state as any).camera.headingDeg * Math.PI / 180;
    assert(Math.abs(a.action.x - (.6 * Math.cos(h) - .2 * Math.sin(h))) < 1e-10);
    const conditional = pixelRequest(observation, 'pixels-conditional');
    assert.equal(Object.keys(conditional.questions).length, 1 + 6 * (camera.objects.length + 1));
    const object = camera.objects[0].id;
    const conditionalAnswer = response(conditional, { context: `track_${object}`, [`${object}_forward`]: 'v6', search_forward: 'v0' });
    assert.equal(mapPixelAnswer(conditional, conditionalAnswer).bodyVelocity[0], 1.1);
    assert.throws(() => mapPixelAnswer(conditional, { ...conditionalAnswer, model: 'substitute' }), /model/);
    const serialized = JSON.stringify(numeric.state); assert(!serialized.includes('target/base')); assert(!serialized.includes('rangeM'));
    for (let i = 0; i < 20; i++) await world.tick();
    assert.equal((await port.observe()).goal, PIXEL_TASK.goal(2));
    for (const arm of Object.keys(PIXEL_ARMS) as PixelArm[]) assert.deepEqual(pixelRequest({ ...observation, goal: 'Different English goal' }, arm).questions, pixelRequest(observation, arm).questions);
  } finally { await world.close(); }
});
test('Pixel report independently replays saved acquisitions and exact model-to-command mapping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-audit-'));
  try {
    let emit = (_kind: string, _data: unknown) => {};
    let calls = 0;
    // This heading produces a -0 component on hold; JSON must preserve its meaning.
    const { controller, stats } = pixelController('pixels-history', 'offline-fixture', (kind, data) => emit(kind, data), async request => response(request, { forward: calls++ % 2 ? 'v3' : 'v4' }));
    const result = await trial({ arm: 'pixels-history', seed: 1201, seconds: 3, directory, phase: 'fixture', config, controller, task: PIXEL_TASK,
      sensorExperiment: pixelProfile(join(directory, 'frames', 'pixels-history-1201')), connectControllerTrace: fn => { emit = fn; }, controllerSource: { files: [resolve('experiments/jev-pixels/controller.ts')] } });
    const row = await pixelReport(directory, result, stats);
    assert(row.metrics.framesAudited >= 10); assert(row.metrics.requestsAudited > 3); assert(row.metrics.pathM > .1); assert(row.metrics.movementFraction > .2 && row.metrics.movementFraction < .8); assert(row.metrics.appliedAgeP95Ms !== null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
