import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cameraFromBody, createScene, generateRoutes, recordRoute, routeSpecs, TARGET_CAR_DIMENSIONS } from '../experiments/jev-round3/world.ts';
import type { RouteFamily, RouteRecording, RouteSpec } from '../experiments/jev-round3/world.ts';
import { pose, vec } from '../src/math.ts';

const fixture = (family: RouteFamily = 'nominal-range'): RouteSpec => ({
  id: `unit-fixture-${family}`, family, seed: 42, split: 'development', duration_ms: 10000, camera_hz: 10, physics_dt_s: 0.02,
});

test('Round 3 matrix is bounded with deterministic development/confirmation membership', () => {
  const first = routeSpecs();
  assert.deepEqual(first, routeSpecs());
  assert.equal(first.length, 12);
  assert.equal(new Set(first.map(route => route.seed)).size, 12);
  assert.equal(new Set(first.map(route => route.id)).size, 12);
  for (const family of new Set(first.map(route => route.family))) {
    const routes = first.filter(route => route.family === family);
    assert.equal(routes.filter(route => route.split === 'development').length, 2);
    assert.equal(routes.filter(route => route.split === 'confirmation').length, 1);
    assert(routes.every(route => route.duration_ms === 10000 && route.camera_hz === 10 && route.physics_dt_s === 0.02));
  }
  first[0]!.seed = 0;
  assert.notEqual(routeSpecs()[0]!.seed, 0);
});

test('Round 3 scenes use one drone and explicit full-size environment car collision geometry', () => {
  for (const spec of routeSpecs()) {
    const scene = createScene(spec);
    assert.deepEqual(scene, createScene(spec));
    assert.equal(scene.scenario.robots.length, 1);
    assert.equal(scene.scenario.robots[0]!.model, 'drone');
    assert.deepEqual(scene.scenario.robots[0]!.sensors, []);
    const target = scene.scenario.obstacles.find(body => body.id === 'environment-target-car')!;
    assert.equal(target.mode, 'kinematic');
    assert.deepEqual(target.shape.size, vec(...TARGET_CAR_DIMENSIONS));
    assert.equal(target.pose.position.z, TARGET_CAR_DIMENSIONS[2] / 2);
    assert.deepEqual(scene.scene_config.car_dimensions_m, TARGET_CAR_DIMENSIONS);
    for (const box of scene.scene_config.obstacles) {
      const body = scene.scenario.obstacles.find(candidate => candidate.id === box.id)!;
      assert.deepEqual(Object.values(body.pose.position), box.position);
      assert.deepEqual(Object.values(body.shape.size), box.size);
    }
    assert.equal(scene.scene_config.lookalikes.length, spec.family === 'occlusion-lookalike' ? 1 : 0);
  }
  assert.throws(() => createScene({ ...fixture(), id: '../escape' }), /safe ID/);
  assert.throws(() => createScene({ ...fixture(), duration_ms: 20000 } as unknown as RouteSpec), /fixed/);
});

test('Round 3 camera transform uses actual ENU body yaw and fixed downward rig pitch', () => {
  const yaw = 0.4;
  const body = { id: 'fixture', pose: { ...pose(2, 3, 1.8), rotation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) } },
    linearVelocity: vec(), angularVelocity: vec() };
  const actual = cameraFromBody(body, { position: [0.2, 0, 0], yaw_rad: 0, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 });
  assert(Math.abs(actual.position[0] - (2 + 0.2 * Math.cos(yaw))) < 1e-12);
  assert(Math.abs(actual.position[1] - (3 + 0.2 * Math.sin(yaw))) < 1e-12);
  assert(Math.abs(actual.yaw_rad - yaw) < 1e-12);
  assert(Math.abs(actual.pitch_rad + 5 * Math.PI / 180) < 1e-12);
  assert(Math.abs(actual.roll_rad) < 1e-12);
});

test('Round 3 acquisition records actual servo poses and complete Stop authority evidence', async () => {
  const spec = fixture();
  const scene = createScene(spec);
  const first = await recordRoute(spec);
  assert.equal(first.frames.length, 100);
  assert.deepEqual(first.frames.map(frame => frame.acquired_sim_ms), Array.from({ length: 100 }, (_, i) => (i + 1) * 100));
  assert.equal(first.frames[0]!.frame_index, 0);
  assert.equal(first.frames.at(-1)!.frame_index, 99);
  const startX = scene.scenario.robots[0]!.pose.position.x;
  const earlyX = first.frames[0]!.camera_pose.position[0];
  assert(earlyX > startX);
  // The acceleration servo has not reached the intended 2 m/s path at 100 ms.
  assert(earlyX < startX + 0.2 - 0.02);
  assert(first.frames[49]!.camera_pose.position[0] > startX + 8);
  for (const frame of first.frames) {
    assert.deepEqual(frame.camera_pose.position, Object.values(frame.evaluator.drone.pose.position));
    assert(Math.abs(frame.target_pose.position[2]) < 1e-6);
    assert.equal(frame.evaluator.contacts.filter(contact => contact.a.includes('drone') || contact.b.includes('drone')).length, 0);
  }
  assert.equal(first.command_receipts.length, 2);
  assert(first.command_receipts.every(record => record.receipt.status === 'accepted' && record.receipt.appliedSimMs === record.requested_sim_ms));
  assert.equal(first.stop_receipt.owner_after_stop, null);
  assert.equal(first.stop_receipt.stale_command.rejected, true);
  assert.equal(first.stop_receipt.command_applications_after_stop, 0);
  assert.equal(first.stop_receipt.post_stop_sim_ms, 10100);
  assert(first.stop_receipt.jobs_after_stop.every(job => job.status !== 'running'));
  assert.equal(first.trace_coverage.lost, 0);
  assert.equal(first.trace_coverage.truncated, 0);
  assert.equal(first.diagnostics.filter(event => event.kind === 'lease.claimed').length, 1);
  assert.equal(first.audience, 'evaluator-and-sensor-simulator-only');
  assert.match(first.timing, /not-continuous-latency/);
  const second = await recordRoute(spec);
  assert.deepEqual(first.frames, second.frames);
});

test('Round 3 all family unit fixtures move through Rapier with bounded camera and target motion', async () => {
  for (const family of ['wall-pole', 'occlusion-lookalike', 'moving-target-ego'] as const) {
    const route = await recordRoute(fixture(family));
    assert(route.frames.every(frame => Math.abs(frame.camera_pose.position[2] - 1.8) < 1e-4));
    assert(route.frames.every(frame => frame.evaluator.contacts.every(contact => !contact.a.includes('drone') && !contact.b.includes('drone'))));
    const first = route.frames[0]!, last = route.frames.at(-1)!;
    assert(Math.abs(last.camera_pose.position[0] - first.camera_pose.position[0]) > 1);
    if (family === 'moving-target-ego') {
      assert(last.target_pose.position[0] - first.target_pose.position[0] > 3.8);
      assert(Math.max(...route.frames.map(frame => frame.camera_pose.yaw_rad)) - Math.min(...route.frames.map(frame => frame.camera_pose.yaw_rad)) > 0.2);
    } else assert.deepEqual(first.target_pose, last.target_pose);
  }
});

test('Round 3 output is explicit, evaluator-only, and refuses to replace prior evidence', async t => {
  const prefix = resolve(tmpdir(), 'jev-round3-world-');
  const root = await mkdtemp(prefix);
  assert(root.startsWith(prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = join(root, 'world');
  const manifest = await generateRoutes({ outDir, specs: [fixture('moving-target-ego')] });
  assert.equal(manifest.frame_count, 100);
  assert.equal(manifest.route_count, 1);
  assert.equal(manifest.routes[0]!.sha256.length, 64);
  const route: RouteRecording = JSON.parse(await readFile(join(outDir, manifest.routes[0]!.path), 'utf8'));
  assert.equal(route.audience, 'evaluator-and-sensor-simulator-only');
  await assert.rejects(generateRoutes({ outDir, specs: [fixture()] }), /EEXIST/);
  await assert.rejects(generateRoutes({ outDir, specs: [fixture(), fixture()] }), /distinct/);
});
