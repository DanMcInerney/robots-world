/** Gated real-GPU integration checks for the renderer/sensor bridges. Skips cleanly (not a
 * failure) when the pinned environments in the main checkout are absent — matching
 * test/jev-library-sensor.test.ts's JEV_DETECTOR_PYTHON pattern, extended here for the renderer's
 * own separate venv. Override with JEV_FIND_FOLLOW_RENDERER_PYTHON / JEV_FIND_FOLLOW_DETECTOR_PYTHON.
 *
 * This is the structural check for the evaluator-leak fix an independent design review flagged:
 * renderer.py's `evaluator` argument defaults to true, which would write true depth/masks/poses
 * beside the controller-visible RGB frames; renderer-client.ts must always request
 * `evaluator: false`, verified here by confirming no `evaluator/` directory is ever created.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startRendererClient } from '../experiments/jev-find-follow/renderer-client.ts';
import { startSensorClient } from '../experiments/jev-find-follow/sensor-client.ts';

// Unit E4b / A7 (coordinator instruction, not the previous hardcoded user-specific absolute path):
// ONE owner, `ROBOTS_WORLD_RUNTIME_ROOT`, defaulting to THIS repo's own (normally empty/missing by
// design in this worktree) `.runtime` directory, resolved from this module's own location — same
// pattern test/jev-library.test.ts already uses — so this file skips cleanly with no local
// environment configured. `MAIN_CHECKOUT_ROOT` (one level up from RUNTIME_ROOT, since `.runtime`
// always sits directly under a checkout root) is where `renderer.py`'s own SOURCE lives — kept
// pointed at the main checkout, not this worktree's own tracked (and confirmed textually
// different) copy, matching every prior unit's own behaviour.
const RUNTIME_ROOT = process.env.ROBOTS_WORLD_RUNTIME_ROOT
  ? resolve(process.env.ROBOTS_WORLD_RUNTIME_ROOT)
  : fileURLToPath(new URL('../.runtime', import.meta.url));
const MAIN_CHECKOUT_ROOT = resolve(RUNTIME_ROOT, '..');
const rendererPython = process.env.JEV_FIND_FOLLOW_RENDERER_PYTHON
  ?? resolve(RUNTIME_ROOT, 'experiments/jev-round3-v1/camera/env/Scripts/python.exe');
const rendererScript = resolve(MAIN_CHECKOUT_ROOT, 'experiments/jev-round3/camera/renderer.py');
const detectorPython = process.env.JEV_FIND_FOLLOW_DETECTOR_PYTHON
  ?? resolve(RUNTIME_ROOT, 'experiments/jev-library-v1/detector/.venv/Scripts/python.exe');
const checkpointPath = resolve(RUNTIME_ROOT, 'experiments/jev-library-v1/detector/models/yolo11s-seg.pt');

const rendererAvailable = existsSync(rendererPython) && existsSync(rendererScript);
const sensorAvailable = existsSync(detectorPython) && existsSync(checkpointPath);
const skipReason = 'Optional local renderer/detector environment unavailable (set JEV_FIND_FOLLOW_RENDERER_PYTHON/JEV_FIND_FOLLOW_DETECTOR_PYTHON to override); no installs, no held network access';

test('renderer-client: --jsonl render-on-demand produces RGB files and NO evaluator directory (evaluator:false)', { skip: !rendererAvailable ? skipReason : false }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'ff-renderer-'));
  const client = await startRendererClient({ pythonExecutable: rendererPython, rendererScriptPath: rendererScript, outputRoot });
  try {
    const result = await client.render({
      seq: 1, camera_pose: { position: [0, 0, 1.8], yaw_rad: 0, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 },
      target_pose: { position: [8, 0, 0], yaw_rad: 0, pitch_rad: 0, roll_rad: 0 }, scene_config: { seed: 1, obstacles: [], lookalikes: [] },
    });
    assert.ok(existsSync(result.leftPath), 'left.png must exist');
    assert.ok(existsSync(result.rightPath), 'right.png must exist');
    assert.ok(existsSync(result.calibrationPath), 'calibration.json must exist');
    const entries = await readdir(result.outDir);
    assert.ok(!entries.includes('evaluator'), `evaluator directory must never be written; found: ${entries.join(', ')}`);
    assert.equal(result.metadata.calibration && (result.metadata.calibration as any).width, 640);
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('renderer-client: a second render with the identical scene_config is much faster (scene setup cached)', { skip: !rendererAvailable ? skipReason : false }, async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'ff-renderer-cache-'));
  const client = await startRendererClient({ pythonExecutable: rendererPython, rendererScriptPath: rendererScript, outputRoot });
  try {
    const scene_config = { seed: 2, obstacles: [], lookalikes: [] };
    const first = await client.render({ seq: 1, camera_pose: { position: [0, 0, 1.8], yaw_rad: 0, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 }, target_pose: { position: [8, 0, 0], yaw_rad: 0, pitch_rad: 0, roll_rad: 0 }, scene_config });
    const second = await client.render({ seq: 2, camera_pose: { position: [0, 0, 1.8], yaw_rad: 0.05, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 }, target_pose: { position: [8, 0.2, 0], yaw_rad: 0, pitch_rad: 0, roll_rad: 0 }, scene_config });
    assert.equal((first.metadata as any).scene_setup_included, true);
    assert.equal((second.metadata as any).scene_setup_included, false);
  } finally {
    await client.close();
    await rm(outputRoot, { recursive: true, force: true });
  }
}, );

test('sensor-client: on-demand mode preserves the caller\'s simulated acquisition stamp verbatim, labelled engine-simulated-ms', { skip: !sensorAvailable ? skipReason : false }, async () => {
  const detectorRuntimeRoot = await mkdtemp(join(tmpdir(), 'ff-detector-runtime-'));
  const fixtureDir = await mkdtemp(join(tmpdir(), 'ff-sensor-fixture-'));
  // A tiny synthetic stereo pair (no real render needed) is enough to exercise the wire contract;
  // detection quality on a blank fixture is irrelevant here, only the clock/schema plumbing is.
  const { writeFixtureFrame } = await importTesting();
  const sample = writeFixtureFrame(fixtureDir, 'f0');
  const client = await startSensorClient({ pythonExecutable: detectorPython, sensorCwd: resolve('experiments/jev-library'), checkpointPath, detectorRuntimeRoot });
  try {
    assert.equal(client.hello.source, 'on-demand');
    assert.equal((client.hello as any).clock.acquiredClock, 'engine-simulated-ms');
    const result = await client.process({ id: 'f0', leftPath: sample.leftPath, rightPath: sample.rightPath, calibrationPath: sample.calibrationPath, acquiredSimMs: 4321.5 });
    assert.deepEqual(result.record.acquired, { clock: 'engine-simulated-ms', ms: 4321.5 });
  } finally {
    await client.close();
    await rm(detectorRuntimeRoot, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

// sensor/testing.py's write_fixture_frame is Python; reimplemented minimally in TS here rather than
// spawning Python to generate a fixture, since this test only needs a file the OpenCV-based sensor
// can decode.
async function importTesting() {
  const cv = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  function writeFixtureFrame(dir: string, name: string) {
    // A minimal valid PNG (1x1 black pixel) is enough for cv2.imread to succeed; detection/stereo
    // will simply find nothing, which is fine — this test only checks the clock/schema contract.
    const onePixelPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077cd6500000010494441545801010500faff00000000000005b1200a2000000000049454e44ae426082', 'hex');
    cv.mkdirSync(dir, { recursive: true });
    const leftPath = joinPath(dir, `${name}-left.png`), rightPath = joinPath(dir, `${name}-right.png`), calibrationPath = joinPath(dir, `${name}-calibration.json`);
    cv.writeFileSync(leftPath, onePixelPng); cv.writeFileSync(rightPath, onePixelPng);
    cv.writeFileSync(calibrationPath, JSON.stringify({ width: 1, height: 1, fx: 60, fy: 60, cx: 0.5, cy: 0.5, baseline_m: 0.2, doffsPx: 0, rectified: true, distortion: [0, 0, 0, 0, 0], pixel_coordinates: 'u=column+0.5,v=row+0.5; top-left origin' }));
    return { id: name, leftPath, rightPath, calibrationPath };
  }
  return { writeFixtureFrame };
}
