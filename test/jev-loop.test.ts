import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { imageMotion } from '../src/perception/image-motion.ts';
import { renderCamera } from '../src/devices/pixel-camera.ts';
import { colorRegions } from '../src/perception/color-tracks.ts';
import { pose, vec } from '../src/math.ts';
import { LOOP_ARMS, loopDesign, names, type LoopArm } from '../experiments/jev-loop/controller.ts';
import { pixelRequest, pixelController, SPEEDS, YAW, PITCH } from '../experiments/jev-pixels/controller.ts';
import { pixelReport } from '../experiments/jev-pixels/report.ts';
import { PIXEL_TASK, pixelProfile } from '../experiments/jev-pixels/profile.ts';
import { ReactiveWorld } from '../experiments/reactive/world.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../experiments/reactive/config.ts';
import { trial } from '../experiments/reactive/run.ts';
import type { Request, Response } from '../experiments/jev-strategies/strategies.ts';

const config = experimentConfig({ ...DEFAULT_CONFIG, sensors: { ...DEFAULT_CONFIG.sensors, cooperativeBeacon: false } });
test('Question effect descriptions agree with the pixel camera coordinate conventions', () => {
  const bodies = [{ id: 'unlabeled', mode: 'fixed' as const, pose: pose(5, 0, 1.5), shape: { kind: 'box' as const, size: vec(.5, .5, .5), color: '#407aee' } }];
  const camera = { position: vec(0, 0, 1.5), headingDeg: 0, pitchDeg: 0, hfovDeg: 70 };
  const image = (options = {}) => { const f = renderCamera(bodies, [], { ...camera, ...options }, 320, 180); return colorRegions(f.image, f.calibration)[0]!; };
  const initial = image();
  assert(image({ headingDeg: 15 }).rightDeg > initial.rightDeg, 'Turning left shifts a fixed scene right');
  assert(image({ pitchDeg: 10 }).upDeg < initial.upDeg, 'Tilting up shifts a fixed scene down');
  assert(image({ position: vec(.6, 0, 1.5) }).widthPercent > initial.widthPercent, 'Moving toward object enlarges it');
  assert(image({ position: vec(0, -.6, 1.5) }).rightDeg < initial.rightDeg, 'Moving body right shifts scene left');
  assert(image({ position: vec(0, 0, 2.1) }).upDeg < initial.upDeg, 'Climbing shifts scene down');
});
function response(request: Request, overrides: Record<string, string> = {}): Response {
  const defaults: Record<string, string> = { forward: names.forward(0), right: names.right(0), up: names.up(0), yaw: names.yaw(0), pitch: names.pitch(0), zoom: 'wide', xy: `${names.forward(0)}__${names.right(0)}`, angles: `${names.yaw(0)}__${names.pitch(0)}` };
  return { model: request.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const keys = Object.keys(q.criteria), selected = overrides[id] ?? defaults[id]; assert(keys.includes(selected!));
    return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? 1 : 0])) }];
  })) };
}
test('Image summaries are measured, bounded, zoom-aware and do not turn missing tracks into predictions', () => {
  const region = { id: 'o1', color: 'blue', box: [10, 10, 20, 20] as [number, number, number, number], pixels: 100, rightDeg: 10, upDeg: 5, widthPercent: 10, clipped: false, history: [] };
  const motion = imageMotion();
  const frame = (acquiredMs: number, objects = [region], hfovDeg = 70) => ({ acquiredMs, objects, headingDeg: 359, pitchDeg: 0, hfovDeg });
  assert.deepEqual(motion(frame(0), 100).imageRates.o1, { unknown: 'new_or_stale_track' });
  const second = motion({ ...frame(200, [{ ...region, rightDeg: 12, widthPercent: 11 }]), headingDeg: 1 }, 300);
  assert.deepEqual(second.imageRates.o1, { intervalMs: 200, rightDegPerS: 10, upDegPerS: 0, widthPercentagePointsPerS: 5 });
  assert.equal((second.cameraAngleRates as any).headingLeftDegPerS, 10);
  const duplicate = motion({ ...frame(200, [{ ...region, rightDeg: 12, widthPercent: 11 }]), headingDeg: 1 }, 350);
  assert.deepEqual(duplicate.imageRates, second.imageRates);
  assert.deepEqual(motion(frame(400, [region], 35), 500).imageRates.o1, { unknown: 'zoom_changed' });
  const lost = motion(frame(600, []), 700); assert.equal(lost.lastSeen[0]!.ageMs, 300); assert.equal(lost.lastSeen[0]!.rightDeg, 10); assert.match(lost.lastSeen[0]!.status, /unknown/);
  assert.deepEqual(motion(frame(2600, []), 2700).lastSeen, []);
  assert.throws(() => motion(frame(2500), 2800), /time/);
  const bounded = imageMotion()(frame(0, Array.from({ length: 25 }, (_, i) => ({ ...region, id: `o${i}` }))), 0);
  assert.equal(bounded.memoryOverflow, 25); assert.deepEqual(bounded.lastSeen, []);
});
test('Loop ablations preserve observations and every control tuple, with no goal-dependent menus', async () => {
  const world = await ReactiveWorld.create(82, () => {}, 2000, config, pixelProfile(), PIXEL_TASK);
  try {
    const observation = await world.controllerPort().observe();
    assert.deepEqual(loopDesign('loop-baseline').request(observation, '', []), pixelRequest(observation, 'pixels-words'));
    const semantic = loopDesign('loop-semantic'), paired = loopDesign('loop-paired');
    const b = semantic.request(observation, '', []), c = loopDesign('loop-temporal').request(observation, '', []), d = paired.request(observation, '', []);
    assert.deepEqual(b.state, pixelRequest(observation, 'pixels-words').state); assert.deepEqual(b.questions, c.questions); assert.deepEqual(c.state, d.state);
    for (const arm of Object.keys(LOOP_ARMS) as LoopArm[]) {
      const request = loopDesign(arm).request(observation, '', []);
      assert.equal(Object.values(request.questions).reduce((n, q) => n * Object.keys(q.criteria).length, 1), 43218);
      assert(Object.values(request.questions).every(q => Object.keys(q.criteria).length <= 255));
      assert.deepEqual(request.questions, loopDesign(arm).request({ ...observation, goal: 'Different user goal' }, '', []).questions);
    }
    assert.deepEqual(Object.values(d.questions).map(q => Object.keys(q.criteria).length).sort((a, b) => a - b), [2, 7, 49, 63]);
    for (const f of SPEEDS) for (const r of SPEEDS) {
      const independent = semantic.map(b, response(b, { forward: names.forward(f), right: names.right(r) }));
      const joint = paired.map(d, response(d, { xy: `${names.forward(f)}__${names.right(r)}` }));
      assert.deepEqual(independent.action, joint.action); assert.deepEqual(joint.bodyVelocity, [f, r, 0]);
    }
    for (const y of YAW) for (const p of PITCH) assert.deepEqual(semantic.map(b, response(b, { yaw: names.yaw(y), pitch: names.pitch(p) })).action, paired.map(d, response(d, { angles: `${names.yaw(y)}__${names.pitch(p)}` })).action);
    assert.throws(() => paired.map(d, { ...response(d), model: 'different' }), /model/);
  } finally { await world.close(); }
});
test('Stateful loop evidence independently reconstructs requests, feedback, zero controls and commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loop-audit-'));
  try {
    let emit = (_kind: string, _data: unknown) => {}, calls = 0;
    const arm = 'loop-paired', id = `${arm}-91`;
    const { controller, stats } = pixelController(arm, 'offline-fixture', (kind, data) => emit(kind, data), async request => response(request, { xy: `${names.forward(calls++ % 2 ? 0 : .2)}__${names.right(0)}` }), loopDesign(arm));
    const result = await trial({ arm, seed: 91, seconds: 3, directory, phase: 'fixture', config, controller, task: PIXEL_TASK,
      sensorExperiment: pixelProfile(join(directory, 'frames', id)), connectControllerTrace: fn => { emit = fn; }, controllerSource: { files: [resolve('experiments/jev-loop/controller.ts')] } });
    const row = await pixelReport(directory, result, stats, loopDesign(arm));
    assert(row.metrics.framesAudited >= 10); assert(row.metrics.requestsAudited > 3); assert(row.metrics.pathM > .1); assert(row.metrics.appliedAgeP95Ms !== null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
