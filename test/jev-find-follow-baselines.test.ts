/** engine-review-e2 finding 5 (and its own required acceptance test): "add the required test that
 * every constant, first-option and seeded-random policy FAILS each scenario's pass rule on a
 * perfect fake sensor." Uses the REAL two smoke scenarios (SMOKE_SCENARIOS, the actual scenario
 * pass criteria) with a fake renderer + an ALL-SEEING fake sensor (computes the TRUE bearing/range
 * analytically from the render request's own camera/target poses — camera-geometry.ts's exact
 * world-position round trip — and always reports the target, at full score, regardless of FOV) so
 * a failure can only be attributed to the BASELINE POLICY itself, never to perception. `passive` is
 * included too (not one of the three the finding names, but the same claim applies and it is cheap
 * to also prove).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEpisode } from '../experiments/jev-find-follow/episode.ts';
import { SMOKE_SCENARIOS } from '../experiments/jev-find-follow/scenarios.ts';
import { createPassiveController } from '../experiments/jev-find-follow/controllers/passive.ts';
import { createConstantController } from '../experiments/jev-find-follow/controllers/constant.ts';
import { createFirstOptionController } from '../experiments/jev-find-follow/controllers/first-option.ts';
import { createSeededRandomController } from '../experiments/jev-find-follow/controllers/seeded-random.ts';
import { bearingAndRangeFromWorldPosition } from '../experiments/jev-find-follow/camera-geometry.ts';
import type { EngineController } from '../experiments/jev-find-follow/controllers/types.ts';
import type { RendererClient, RenderRequest } from '../experiments/jev-find-follow/renderer-client.ts';
import type { SensorClient } from '../experiments/jev-find-follow/sensor-client.ts';

/** Shared between the fake renderer and the fake sensor: the renderer sees the true camera/target
 * poses (as the real renderer legitimately does, to draw pixels — PRINCIPLES.md #10); the "sensor"
 * here is a stand-in for a perfect detector reading those same poses analytically, never a
 * shortcut the REAL sensor pipeline takes. */
function makeAllSeeingFakes(): { createRenderer: () => Promise<RendererClient>; createSensor: () => Promise<SensorClient> } {
  let lastRequest: RenderRequest | null = null;
  let renderSeq = 0;
  const createRenderer = async (): Promise<RendererClient> => ({
    async render(request: RenderRequest) {
      lastRequest = request;
      renderSeq++;
      return { leftPath: `fake-left-${renderSeq}.png`, rightPath: `fake-right-${renderSeq}.png`, calibrationPath: 'fake-calib.json', outDir: 'fake-dir', wallMs: 1, metadata: {} };
    },
    async close() {},
  });
  const createSensor = async (): Promise<SensorClient> => {
    let seq = 0;
    return {
      hello: { type: 'hello', clock: { acquiredClock: 'engine-simulated-ms' } },
      async process(request) {
        seq++;
        const objects = [];
        if (lastRequest) {
          const cam = lastRequest.camera_pose, tgt = lastRequest.target_pose;
          const { bearing, rangeM } = bearingAndRangeFromWorldPosition(
            { x: cam.position[0], y: cam.position[1], z: cam.position[2] }, cam.yaw_rad, cam.pitch_rad,
            { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] },
          );
          objects.push({
            class: 'car', score: 0.95, bearingRightRad: bearing.bearingRightRad, bearingUpRad: bearing.bearingUpRad,
            surfaceRangeM: rangeM, rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 1000,
            boxNorm: [0.4, 0.4, 0.6, 0.6] as [number, number, number, number], dominantColor: 'blue',
          });
        }
        return {
          record: { schema: 'stereo-objects/2', seq, acquired: { clock: 'engine-simulated-ms', ms: request.acquiredSimMs }, emittedMs: request.acquiredSimMs, skippedSinceLast: 0, objects, objectsTotal: objects.length, valid: true },
          wallMs: 1,
        };
      },
      async close() {},
    };
  };
  return { createRenderer, createSensor };
}

const UNUSED_RENDERER = { pythonExecutable: 'unused', rendererScriptPath: 'unused' };
const UNUSED_SENSOR = { pythonExecutable: 'unused', sensorCwd: 'unused', checkpointPath: 'unused', detectorRuntimeRoot: 'unused' };

async function runBaseline(scenarioId: string, controller: EngineController) {
  const outputRoot = await mkdtemp(join(tmpdir(), `ff-baseline-${scenarioId}-${controller.id}-`));
  try {
    const fakes = makeAllSeeingFakes();
    return await runEpisode(SMOKE_SCENARIOS[scenarioId]!, {
      controller, outputRoot, renderer: UNUSED_RENDERER, sensor: UNUSED_SENSOR, seed: SMOKE_SCENARIOS[scenarioId]!.world.seed,
      deps: fakes,
      // A fast but not-absurd camera/decision cadence keeps this CPU-only test's wall time
      // reasonable while still exercising the real scenario durations (45-60s simulated) at the
      // real cameraPeriodMs (200ms/5Hz) default from DEFAULT_SCHEDULER_CONFIG.
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

for (const scenarioId of Object.keys(SMOKE_SCENARIOS)) {
  test(`baselines cannot pass ${scenarioId}'s pass rule, even with an all-seeing fake sensor: passive`, async () => {
    const report = await runBaseline(scenarioId, createPassiveController());
    assert.equal(report.score.pass?.decided, false, `passive must FAIL ${scenarioId}; reasons: ${report.score.pass?.reasons.join('; ')}`);
  });
  test(`baselines cannot pass ${scenarioId}'s pass rule, even with an all-seeing fake sensor: constant`, async () => {
    const report = await runBaseline(scenarioId, createConstantController({ yaw: 'yaw_left_10', range: 'speed_0_5', action: 'yaw_left_30' }));
    assert.equal(report.score.pass?.decided, false, `constant must FAIL ${scenarioId}; reasons: ${report.score.pass?.reasons.join('; ')}`);
  });
  test(`baselines cannot pass ${scenarioId}'s pass rule, even with an all-seeing fake sensor: first-option`, async () => {
    const report = await runBaseline(scenarioId, createFirstOptionController());
    assert.equal(report.score.pass?.decided, false, `first-option must FAIL ${scenarioId}; reasons: ${report.score.pass?.reasons.join('; ')}`);
  });
  test(`baselines cannot pass ${scenarioId}'s pass rule, even with an all-seeing fake sensor: seeded-random`, async () => {
    const report = await runBaseline(scenarioId, createSeededRandomController(7));
    assert.equal(report.score.pass?.decided, false, `seeded-random must FAIL ${scenarioId}; reasons: ${report.score.pass?.reasons.join('; ')}`);
  });
}
