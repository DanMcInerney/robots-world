/** Increment B1/B2: pure generator functions for ladder scenario parametrisation and sweep tooling.
 * Kept separate from scenarios.ts (the two frozen smoke scenarios) and run.ts (CLI glue) so every
 * piece here is independently unit-testable without spinning up a process or the real renderer.
 */
import { randomStream } from '../../src/math.ts';
import { TARGET_CAR_DIMENSIONS } from '../jev-round3/world.ts';
import { bearingAndRangeFromWorldPosition } from './camera-geometry.ts';
import { sightlineSurfaceRangeToBox } from './evaluator.ts';
import { DEFAULT_SECTOR_MEMORY_CONFIG } from './sector-memory.ts';
import { DEFAULT_YAW_RATE_DEG_S } from './maneuver.ts';
import { DEFAULT_RATE_WINDOW_MS } from './rate-estimate.ts';
import type { EpisodeScenario } from './episode.ts';
import type { ConsequenceModel, RangeMenuKind } from './encoders/track.ts';
import type { RendererClient, RenderRequest } from './renderer-client.ts';
import type { SensorClient } from './sensor-client.ts';
import type { EngineController, ControllerContext } from './controllers/types.ts';
import type { DecisionRequest, DecisionResponse, EnvelopeBounds } from './types.ts';
import type { WorldBridgeConfig } from './world-bridge.ts';

const CAR_HALF_LENGTH_M = TARGET_CAR_DIMENSIONS[0] / 2;

// ---------------------------------------------------------------------------------------------
// Start-offset / start-range sweep generator (L1's offset x range sweep; § B1)
// ---------------------------------------------------------------------------------------------

/** Unit E4b / A6 ("make target aspect a declared scenario factor"): engine-review-e3's Question 2
 * found `offsetRangeStart` always pointed the car's FRONT at the drone (`aspectDeg` defaulting to
 * 180 below, this function's pre-E4b-unit-only behaviour) — every OTHER moving scenario in this
 * engine happens to show the car's rear/side instead, so L1 (the only rung built from this
 * generator) was silently exercising the one aspect the review's own static probe found the
 * detector struggles with (Round 3 rig: front bound 3/8 poses vs 8/8 for rear/side/oblique) — a
 * pose-lottery, not a measured reliability rate. `aspect` selects which face of the car the camera
 * sees, in the SAME `Aspect` vocabulary the review itself used: `'front'` (car's front toward the
 * drone — the previously-hardcoded default, kept as this function's own default for backward
 * compatibility with any existing caller), `'rear'` (car's rear toward the drone — what the two
 * smoke scenarios and most of this engine's other fixtures already show), `'side'` (car broadside
 * to the drone, heading rotated 90deg off the sightline) and `'oblique'` (45deg off-sightline, the
 * declared middle case). `aspectDeg` remains available for a caller that wants a literal degree
 * offset instead of one of the four named cases (`aspect` is the named convenience; `aspectDeg`
 * always wins if both are supplied). */
export type Aspect = 'front' | 'rear' | 'side' | 'oblique';
const ASPECT_HEADING_OFFSET_DEG: Record<Aspect, number> = { front: 180, rear: 0, side: 90, oblique: 45 };

/** Increment B1: places the car at a declared camera-relative bearing OFFSET (degrees, positive =
 * right of the drone's forward heading, matching the encoder's own `bearingRightRad` convention)
 * and a declared slant/surface RANGE (metres) from the drone's start pose, with the drone held at
 * a fixed reference heading. Declared approximation (stated, not hidden): the car is always placed
 * so the sightline runs along the car's OWN length axis (matching the existing two smoke
 * scenarios' own `CAR_HALF_LENGTH_M` convention) — an exact nearest-surface-at-an-arbitrary-angle
 * calculation would need the car's actual box geometry at that angle, which is a materially bigger
 * scope this pilot generator does not attempt; this matches the fidelity level already established
 * by scenarios.ts's own two frozen scenarios, not a new approximation invented for this generator.
 * The car's own heading is set by `aspect`/`aspectDeg` (see {@link Aspect}'s own docstring),
 * defaulting to `'front'` (facing back toward the drone) — this function's original, pre-A6
 * behaviour, kept as the default so an existing caller that does not pass `aspect` is unaffected. */
export function offsetRangeStart(config: {
  offsetDeg: number; rangeM: number; droneHeadingDeg?: number; droneInitialPosition?: { x: number; y: number };
  aspect?: Aspect; aspectDeg?: number;
}): { droneInitialPosition: { x: number; y: number }; droneInitialHeadingDeg: number; carInitialPosition: { x: number; y: number }; carInitialHeadingDeg: number } {
  const droneHeadingDeg = config.droneHeadingDeg ?? 0;
  const droneInitialPosition = config.droneInitialPosition ?? { x: 0, y: 0 };
  // Matches camera-geometry.ts's `worldBearingDeg` convention exactly (`wrap(ownHeading -
  // bearingRight)`), inverted here: the WORLD bearing from drone to car for a desired
  // camera-relative offset is `droneHeadingDeg - offsetDeg`.
  const worldBearingDeg = ((droneHeadingDeg - config.offsetDeg) % 360 + 360) % 360;
  const worldBearingRad = worldBearingDeg * Math.PI / 180;
  const centreRangeM = config.rangeM + CAR_HALF_LENGTH_M;
  const carInitialPosition = {
    x: droneInitialPosition.x + Math.cos(worldBearingRad) * centreRangeM,
    y: droneInitialPosition.y + Math.sin(worldBearingRad) * centreRangeM,
  };
  const aspectOffsetDeg = config.aspectDeg ?? ASPECT_HEADING_OFFSET_DEG[config.aspect ?? 'front'];
  const carInitialHeadingDeg = ((worldBearingDeg + aspectOffsetDeg) % 360 + 360) % 360;
  return { droneInitialPosition, droneInitialHeadingDeg: droneHeadingDeg, carInitialPosition, carInitialHeadingDeg };
}

// ---------------------------------------------------------------------------------------------
// Seeded controller-latency DISTRIBUTIONS (declared, recorded) — B1
// ---------------------------------------------------------------------------------------------

/** A declared, seeded (reproducible, never true nondeterminism) real-wall-latency distribution for
 * a controller, on top of the scheduler's existing single-constant `controllerLatencyMs` model.
 * Log-normal: parameterised by a target median and p95 (matches how this repo's own measured
 * figures are always reported — see scheduler.ts's own docstring), converted to the underlying
 * normal's (mu, sigma) via `sigma = ln(p95/median) / 1.645` (z_0.95 = 1.645), `mu = ln(median)`. */
export interface LatencyDistribution { kind: 'lognormal'; medianMs: number; p95Ms: number; minMs: number }

/** The ladder's own declared figure (`docs/jev-find-follow-ladder.md`'s clock/latency
 * qualification section): "controller ≈220 ms median/≈306 ms p95, F59's measured after-bearing
 * dispatch time" — an RTX 5090 laptop GPU figure replaying recorded frames, declared there as NOT
 * a real onboard/companion-computer figure. Distinct from (not a replacement for) this engine's own
 * `DEFAULT_CONTROLLER_LATENCY_MS` (250 ms flat) scheduler default. */
export const MEASURED_CONTROLLER_LATENCY_DISTRIBUTION: LatencyDistribution = Object.freeze({ kind: 'lognormal', medianMs: 220, p95Ms: 306, minMs: 20 });
/** A pessimistic controller-latency arm (2x the measured figures — same declared multiplier the
 * ladder applies to perception, see `PESSIMISTIC_PERCEPTION_LATENCY_MS`, scheduler.ts). */
export const PESSIMISTIC_CONTROLLER_LATENCY_DISTRIBUTION: LatencyDistribution = Object.freeze({ kind: 'lognormal', medianMs: 440, p95Ms: 612, minMs: 20 });

const Z95 = 1.6448536269514722;

/** Pure: one sample from `dist`, given a caller-owned uniform-[0,1) generator (this module never
 * calls `Math.random()` directly — determinism given a seed is a hard requirement throughout this
 * engine, see world-bridge.ts's own `randomStream` usage). Box-Muller for the underlying normal. */
export function sampleLatencyMs(dist: LatencyDistribution, uniform: () => number): number {
  const mu = Math.log(dist.medianMs);
  const sigma = Math.log(dist.p95Ms / dist.medianMs) / Z95;
  let u1 = uniform(); if (u1 <= 0) u1 = 1e-9;
  const u2 = uniform();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(dist.minMs, Math.exp(mu + sigma * z));
}

/** Wraps any EngineController so its REAL wall-clock latency (not the scheduler's flat constant) is
 * drawn from `dist` each call, seeded and reproducible. Implemented as a real wall-time delay plus
 * `realLatencyClampMs` (the same declared, already-tested mechanism the real jev controller and the
 * `fake-slow-controller` test double use — see controllers/types.ts) rather than new scheduling
 * machinery in episode.ts: episode.ts's own concurrent-acquisition loop already handles a
 * clamp-declaring controller correctly (proven by test/jev-find-follow-loop.test.ts's existing
 * 450-900ms fake-slow-controller regression test), so this reuses that path exactly rather than
 * duplicating it. The clamp ceiling is generously set (p95 + 3x(p95-median), floored at 2x p95) so
 * an unlucky sample is not spuriously flagged as a timeout. */
export function withSeededLatency(base: EngineController, dist: LatencyDistribution, seed: number): EngineController {
  const uniform = randomStream(seed, `find-follow-latency-${base.id}`);
  const clampMaxMs = Math.max(dist.p95Ms * 2, dist.p95Ms + 3 * (dist.p95Ms - dist.medianMs));
  return {
    id: `${base.id}+seeded-latency`,
    realLatencyClampMs: [dist.minMs, clampMaxMs],
    async answer(request: DecisionRequest, context: ControllerContext, signal: AbortSignal): Promise<DecisionResponse> {
      // A4 (engine-review-e3 finding 4, "fix MY OWN withSeededLatency degenerate-in-fake-mode
      // bug"): the REAL wall delay actually awaited here must itself never exceed the declared
      // clamp envelope this controller advertises via `realLatencyClampMs` — the whole stated
      // PURPOSE of that field ("one abnormally slow/fast real call cannot distort the simulated
      // clock outside a declared envelope", controllers/jev.ts's own docstring). Pre-fix, only the
      // LOGGED/bookkept simulated latency was clamped after the fact (episode.ts); the real
      // `setTimeout` wait itself was never bounded, so any upper-tail sample above `clampMaxMs`
      // (an ordinary draw, not necessarily an extreme one — see `test/jev-find-follow-
      // sweep.test.ts`'s regression test, which finds one within a few thousand seeds, not millions)
      // made the real wait longer than the declared envelope promised. With this suite's fake
      // (near-zero real cost per acquisition) sensor/renderer, even a single such over-long real
      // wait lets the concurrent camera-grid loop advance a disproportionate amount of SIMULATED
      // time within it (each ~1ms-real fake acquisition still advances a full `cameraPeriodMs` of
      // sim time) — measured as "1 decision in 10s, 50 frames consumed in one call" against a short
      // declared episode duration. Clamping the real wait to the declared envelope bounds the worst
      // case to what that envelope promises; choosing `durationMs` generously relative to the
      // camera period and the clamp ceiling (as the existing 450-900ms slow-controller regression
      // test already does) remains necessary on top of this for a fake-mode episode to realise
      // many decisions, since fake acquisitions racing ahead of real time is a general property of
      // this suite's fakes, not specific to this wrapper (see that test's own comment).
      const sampledMs = sampleLatencyMs(dist, uniform);
      const delayMs = Math.max(dist.minMs, Math.min(clampMaxMs, sampledMs));
      const [response] = await Promise.all([
        base.answer(request, context, signal),
        new Promise<void>(resolve => setTimeout(resolve, delayMs)),
      ]);
      return response;
    },
    close: base.close,
  };
}

// ---------------------------------------------------------------------------------------------
// Fast fake-sensor mode: a SYNTHETIC (not perfect) sensor fitted to measured figures — B2
// ---------------------------------------------------------------------------------------------

/** The fake sensor's dropout/latency/noise model, fitted to the coordinator's own stated measured
 * figures (engine-assignment-e3b.md's B3 point): ~86% recall (`scenarios.ts`'s own cited vehicle-
 * family/0.15-threshold figure, "86%/94% recall under 12m"), 140 ms perception latency (already the
 * scheduler's own `DEFAULT_PERCEPTION_LATENCY_MS` — modelled uniformly for every acquisition
 * regardless of sensor accuracy, nothing additional to do here), range noise sigma ~=0.2 m at
 * 8-12m (F67-family stereo noise), sensor range bias +0.3-0.5 m vs truth (midpoint +0.4 m used).
 * CLEARLY LABELLED SYNTHETIC throughout (report.ts's config records `syntheticSensorModel`, never
 * conflated with a real sensor-hello record). */
export interface SyntheticSensorModel { recall: number; rangeNoiseSigmaM: number; rangeBiasM: number }
export const MEASURED_SYNTHETIC_SENSOR_MODEL: SyntheticSensorModel = Object.freeze({ recall: 0.86, rangeNoiseSigmaM: 0.2, rangeBiasM: 0.4 });
/** A "perfect" sensor (100% recall, zero noise/bias) — isolates POLICY failure from perception,
 * matching test/jev-find-follow-baselines.test.ts's own all-seeing fake exactly (reused here so the
 * sweep tool and that test's fixture never drift apart). */
export const PERFECT_SYNTHETIC_SENSOR_MODEL: SyntheticSensorModel = Object.freeze({ recall: 1, rangeNoiseSigmaM: 0, rangeBiasM: 0 });

function gaussian(uniform: () => number): number {
  let u1 = uniform(); if (u1 <= 0) u1 = 1e-9;
  const u2 = uniform();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Builds an all-seeing-but-declared-imperfect fake renderer+sensor pair: the "renderer" sees true
 * camera/target poses (as the real renderer legitimately does, to draw pixels — PRINCIPLES.md #10;
 * reused verbatim from test/jev-find-follow-baselines.test.ts's own `makeAllSeeingFakes`), and the
 * "sensor" reads those same poses analytically (never the real perception pipeline) but applies
 * `model`'s declared dropout/noise/bias — a synthetic stand-in for the real sensor's measured
 * imperfection, not a shortcut the real pipeline takes. */
export function makeSyntheticFakes(model: SyntheticSensorModel, seed: number): { createRenderer: () => Promise<RendererClient>; createSensor: () => Promise<SensorClient> } {
  const uniform = randomStream(seed, 'find-follow-synthetic-sensor');
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
      hello: { type: 'hello', clock: { acquiredClock: 'engine-simulated-ms' }, synthetic: true, syntheticSensorModel: model } as any,
      async process(request) {
        seq++;
        const objects: any[] = [];
        if (lastRequest && uniform() < model.recall) {
          const cam = lastRequest.camera_pose, tgt = lastRequest.target_pose;
          // Bearing to the target's CENTRE (matches evaluator.ts's own `trueBearingRightRad`
          // convention exactly — both computed to the centre point, never the surface).
          const { bearing } = bearingAndRangeFromWorldPosition(
            { x: cam.position[0], y: cam.position[1], z: cam.position[2] }, cam.yaw_rad, cam.pitch_rad,
            { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] },
          );
          // Range to the near SURFACE along the actual sightline (matches the real sensor's own
          // mask-median convention and evaluator.ts's `trueNearestSurfaceRangeM` EXACTLY — using
          // centre-point range here instead would systematically over-report by roughly the car's
          // own half-length whenever viewed rear/front-on, which is what this synthetic sensor
          // originally did before this fix; see WORKLOG.md). `target_pose.position.z` is the car's
          // BASE (renderer convention, world-bridge.ts's `renderInput()`), so the box centre is
          // reconstructed by adding back half the known car height.
          const carHalfHeightM = TARGET_CAR_DIMENSIONS[2] / 2;
          const boxCentre = { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] + carHalfHeightM };
          const rotation = { x: 0, y: 0, z: Math.sin(tgt.yaw_rad / 2), w: Math.cos(tgt.yaw_rad / 2) };
          const halfExtents = { x: TARGET_CAR_DIMENSIONS[0] / 2, y: TARGET_CAR_DIMENSIONS[1] / 2, z: carHalfHeightM };
          const trueSurfaceRangeM = sightlineSurfaceRangeToBox(
            { x: cam.position[0], y: cam.position[1], z: cam.position[2] },
            { id: 'synthetic-target', kind: 'target', pose: { position: boxCentre, rotation }, halfExtents },
          );
          const noisyRangeM = Math.max(0.1, trueSurfaceRangeM + model.rangeBiasM + gaussian(uniform) * model.rangeNoiseSigmaM);
          objects.push({
            class: 'car', score: 0.95, bearingRightRad: bearing.bearingRightRad, bearingUpRad: bearing.bearingUpRad,
            surfaceRangeM: noisyRangeM, rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 1000,
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

// ---------------------------------------------------------------------------------------------
// Fake sensor v2 — Unit E4b / B1: fitted to what engine-review-e3 actually MEASURED on the real
// sensor (Question 2 and finding 6), not just the earlier coordinator-provided recall/noise/bias
// midpoints `makeSyntheticFakes` above uses. Kept as a SEPARATE function (not a v1 rewrite) so
// every existing caller of `makeSyntheticFakes`/`MEASURED_SYNTHETIC_SENSOR_MODEL` (this file's own
// `speedBearingRateCell`-era callers, and test/jev-find-follow-baselines.test.ts's fixture) keeps
// compiling and behaving byte-for-byte unchanged. Declared, not yet done (A7 remainder): unifying
// this with `makeAllSeeingFakes` (test/jev-find-follow-baselines.test.ts) into one shared factory —
// left for a follow-up, noted in WORKLOG.md/FAILURES.md.
// ---------------------------------------------------------------------------------------------

export interface RigConfig { droneAltitudeM: number; mountPitchDeg: number; hfovDeg: number }
export const ROUND3_RIG: RigConfig = Object.freeze({ droneAltitudeM: 1.8, mountPitchDeg: -5, hfovDeg: 70 });

/** engine-review-e3's own static-probe table (finding 6 / Question 2), the two rigs this engine
 * actually qualified (`ladder-scenarios.ts`'s `ROUND3_RIG`/`CANDIDATE_HIGHER_RIG`). Recall figures
 * for rear/side/oblique are the review's own STATIC 8/8 result read down slightly (0.92/0.90) since
 * this synthetic model is fitted for a DYNAMIC (moving-target) episode, where the coordinator's own
 * "recall 0.72-1.00 by scenario" range is the declared target band, not a literal 1.0 claim; front
 * recall is the review's own literal fraction (3/8, 6/8). Bias figures are the review's own literal
 * sensor-minus-truth numbers, verbatim. */
const RIG_ASPECT_TABLE = {
  round3: { altitudeM: 1.8, recall: { front: 0.375, oblique: 0.85, side: 0.92, rear: 0.92 }, biasM: { front: 0.46, oblique: 0.71, side: 0.37, rear: 0.31 } },
  higher: { altitudeM: 3.0, recall: { front: 0.75, oblique: 0.85, side: 0.92, rear: 0.92 }, biasM: { front: 1.00, oblique: 0.88, side: 0.53, rear: 0.57 } },
};
/** Detection range limit: engine-review-e3's own Q1 finding ("the detector loses the car at
 * 21.6m"). Declared: an aspect/rig-independent hard cutoff, the simplest reading of one measured
 * data point, not a claim that the real limit is exactly aspect/rig-invariant. */
const DETECTION_RANGE_LIMIT_M = 21;
/** Pose-correlated miss-run continuation probability boost (declared, fitted so the RESULTING mean
 * run length lands inside the review's own measured 1-7 frame band across the recall range this
 * table covers — see the module-level comment below `pickMissRun` for the arithmetic worked through
 * at both table extremes). Not derived from raw per-frame detector logs (none were available to
 * this unit) — a declared, stated approximation. */
const MISS_RUN_CONTINUATION_BOOST = 0.5;

function piecewiseLerp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]!) {
      const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[ys.length - 1]!;
}

/** Aspect angle theta in [0,180] degrees between the car's OWN forward heading and the direction
 * FROM the car TO the camera: 0 = the car's front points at the camera (FRONT aspect, the review's
 * own measured blind spot); 90 = broadside (SIDE); 180 = the car's rear points at the camera (REAR,
 * what the two smoke scenarios and most of this engine's other fixtures already show); ~45/135 =
 * OBLIQUE. Computed from the actual render request's own poses every acquisition (not a static
 * per-scenario label), so a MOVING/TURNING car (L2's orbit, L4's turns) gets the aspect its actual
 * geometry implies at each instant, not a fixed assumption. */
function aspectThetaDeg(camPos: { x: number; y: number; z: number }, carPos: { x: number; y: number; z: number }, carYawRad: number): number {
  const toCameraRad = Math.atan2(camPos.y - carPos.y, camPos.x - carPos.x);
  const diffRad = ((toCameraRad - carYawRad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(diffRad) * 180 / Math.PI;
}

function recallAndBiasAt(thetaDeg: number, droneAltitudeM: number): { recall: number; biasM: number } {
  const xs = [0, 45, 90, 180];
  const lo = RIG_ASPECT_TABLE.round3, hi = RIG_ASPECT_TABLE.higher;
  const t = Math.max(0, Math.min(1.5, (droneAltitudeM - lo.altitudeM) / (hi.altitudeM - lo.altitudeM))); // clamped extrapolation, generous but bounded
  const recallYsLo = [lo.recall.front, lo.recall.oblique, lo.recall.side, lo.recall.rear];
  const recallYsHi = [hi.recall.front, hi.recall.oblique, hi.recall.side, hi.recall.rear];
  const biasYsLo = [lo.biasM.front, lo.biasM.oblique, lo.biasM.side, lo.biasM.rear];
  const biasYsHi = [hi.biasM.front, hi.biasM.oblique, hi.biasM.side, hi.biasM.rear];
  const recallLo = piecewiseLerp(thetaDeg, xs, recallYsLo), recallHi = piecewiseLerp(thetaDeg, xs, recallYsHi);
  const biasLo = piecewiseLerp(thetaDeg, xs, biasYsLo), biasHi = piecewiseLerp(thetaDeg, xs, biasYsHi);
  return { recall: recallLo + t * (recallHi - recallLo), biasM: biasLo + t * (biasHi - biasLo) };
}

export interface SyntheticSensorModelV2Options {
  /** Slowly-varying range-noise sigma band (metres) — engine-review-e3's own measured "std
   * 0.04-0.18m, slowly varying" (Q5). Modelled as a smooth sinusoid over a seeded random period/
   * phase (declared, not a literal reproduction of the real sensor's own noise-source mechanism). */
  rangeNoiseSigmaLowM?: number; rangeNoiseSigmaHighM?: number;
  /** engine-review-e3's own measured "detector loses the car at 21.6m" (Q1). */
  detectionRangeLimitM?: number;
}

/** Fake sensor v2 (Unit E4b / B1): builds an all-seeing-but-declared-imperfect fake renderer+sensor
 * pair fitted DIRECTLY to engine-review-e3's own measured figures (not the earlier coordinator
 * midpoints `makeSyntheticFakes` uses): misses occur in POSE-CORRELATED RUNS (not i.i.d. per frame)
 * whose underlying per-frame miss probability comes from the ACTUAL aspect angle + rig altitude at
 * that acquisition (`recallAndBiasAt`, above) — so a scenario that happens to hold a front-ish
 * aspect for a while (L1's own pre-A6 default) gets a long, realistic run of misses, while a
 * rear/side view gets short, occasional ones, exactly the review's own "recall is a deterministic
 * function of pose" finding; a 70deg HFOV limit and a `detectionRangeLimitM` (default 21m, Q1) each
 * force a hard miss outside their own bound; range noise sigma varies slowly (a seeded sinusoid
 * between `rangeNoiseSigmaLowM`/`rangeNoiseSigmaHighM`) instead of one fixed constant; range bias is
 * aspect/rig-dependent (`recallAndBiasAt`). CLEARLY LABELLED SYNTHETIC (same `synthetic: true`/
 * `syntheticSensorModel` hello-record convention as v1). */
export function makeSyntheticFakesV2(rig: RigConfig, seed: number, options: SyntheticSensorModelV2Options = {}): { createRenderer: () => Promise<RendererClient>; createSensor: () => Promise<SensorClient> } {
  const uniform = randomStream(seed, 'find-follow-synthetic-sensor-v2');
  const sigmaLowM = options.rangeNoiseSigmaLowM ?? 0.04, sigmaHighM = options.rangeNoiseSigmaHighM ?? 0.18;
  const detectionRangeLimitM = options.detectionRangeLimitM ?? DETECTION_RANGE_LIMIT_M;
  const noisePeriodS = 8 + uniform() * 12; // "slowly varying": one full cycle every 8-20s, seeded
  const noisePhase = uniform() * 2 * Math.PI;
  let lastRequest: RenderRequest | null = null;
  let renderSeq = 0;
  let wasMissLastFrame = false;
  const createRenderer = async (): Promise<RendererClient> => ({
    async render(request: RenderRequest) {
      lastRequest = request;
      renderSeq++;
      return { leftPath: `fake-left-v2-${renderSeq}.png`, rightPath: `fake-right-v2-${renderSeq}.png`, calibrationPath: 'fake-calib.json', outDir: 'fake-dir', wallMs: 1, metadata: {} };
    },
    async close() {},
  });
  const createSensor = async (): Promise<SensorClient> => {
    let seq = 0;
    return {
      hello: { type: 'hello', clock: { acquiredClock: 'engine-simulated-ms' }, synthetic: true, syntheticSensorModel: { version: 2, rig, detectionRangeLimitM, hfovDeg: rig.hfovDeg } } as any,
      async process(request) {
        seq++;
        const objects: any[] = [];
        if (lastRequest) {
          const cam = lastRequest.camera_pose, tgt = lastRequest.target_pose;
          const { bearing } = bearingAndRangeFromWorldPosition(
            { x: cam.position[0], y: cam.position[1], z: cam.position[2] }, cam.yaw_rad, cam.pitch_rad,
            { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] },
          );
          const carHalfHeightM = TARGET_CAR_DIMENSIONS[2] / 2;
          const boxCentre = { x: tgt.position[0], y: tgt.position[1], z: tgt.position[2] + carHalfHeightM };
          const rotation = { x: 0, y: 0, z: Math.sin(tgt.yaw_rad / 2), w: Math.cos(tgt.yaw_rad / 2) };
          const halfExtents = { x: TARGET_CAR_DIMENSIONS[0] / 2, y: TARGET_CAR_DIMENSIONS[1] / 2, z: carHalfHeightM };
          const trueSurfaceRangeM = sightlineSurfaceRangeToBox(
            { x: cam.position[0], y: cam.position[1], z: cam.position[2] },
            { id: 'synthetic-target-v2', kind: 'target', pose: { position: boxCentre, rotation }, halfExtents },
          );
          const thetaDeg = aspectThetaDeg({ x: cam.position[0], y: cam.position[1], z: cam.position[2] }, boxCentre, tgt.yaw_rad);
          const { recall, biasM } = recallAndBiasAt(thetaDeg, rig.droneAltitudeM);
          const inFov = Math.abs(bearing.bearingRightRad) <= rig.hfovDeg / 2 * Math.PI / 180;
          const inRange = trueSurfaceRangeM <= detectionRangeLimitM;
          // Pose-correlated miss RUNS (not i.i.d.): once missing, the continuation probability is
          // boosted above the raw per-frame miss probability (MISS_RUN_CONTINUATION_BOOST) — see
          // this function's own module-level comment for why this keeps mean run length inside the
          // review's own measured 1-7 frame band across this table's whole recall range.
          const rawMissProb = 1 - recall;
          const missProb = wasMissLastFrame ? rawMissProb + (1 - rawMissProb) * MISS_RUN_CONTINUATION_BOOST : rawMissProb;
          const missedThisFrame = !inFov || !inRange || uniform() < missProb;
          wasMissLastFrame = missedThisFrame;
          if (!missedThisFrame) {
            const t = request.acquiredSimMs / 1000;
            const sigmaM = sigmaLowM + (sigmaHighM - sigmaLowM) * (0.5 + 0.5 * Math.sin(2 * Math.PI * t / noisePeriodS + noisePhase));
            const noisyRangeM = Math.max(0.1, trueSurfaceRangeM + biasM + gaussian(uniform) * sigmaM);
            objects.push({
              class: 'car', score: 0.95, bearingRightRad: bearing.bearingRightRad, bearingUpRad: bearing.bearingUpRad,
              surfaceRangeM: noisyRangeM, rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 1000,
              boxNorm: [0.4, 0.4, 0.6, 0.6] as [number, number, number, number], dominantColor: 'blue',
            });
          }
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

export interface ReferenceCeilingCellConfig {
  targetSpeedMps: number; bearingRateDegS: number;
  rangeMenuKind: RangeMenuKind; consequenceModel: ConsequenceModel;
  rig: RigConfig; requestedRangeM: number; durationMs: number; seed: number;
  rangeToleranceM: number; centralBandFraction: number; envelope: EnvelopeBounds;
}

/** Increment B2: converts one (targetSpeedMps, bearingRateDegS) reference-ceiling grid cell into a
 * full `EpisodeScenario`, reusing `lateral-crossing`'s existing two independent velocity components
 * — the previous maker's own design sketch (WORKLOG.md/FAILURES.md), verified still sound: a car
 * spawned directly ahead of the drone has its OWN local "forward" axis running along the drone's
 * sightline (radial) and its "lateral" axis running perpendicular to it (bearing-rate-inducing), so
 * `lateral-crossing`'s `forwardSpeedMps`/`lateralSpeedMps` map directly onto (radial speed,
 * bearing-rate-inducing speed) with no new CarPath kind needed. `lateralSpeedMps =
 * bearingRateDegS * (pi/180) * requestedRangeM` linearises the declared bearing rate into a
 * tangential speed at the requested range (a first-order approximation, stated: exact only at the
 * instant range equals `requestedRangeM`, matching how `rate-estimate.ts`'s own linear window fit
 * treats short-horizon motion elsewhere in this engine). `forwardSpeedMps = +targetSpeedMps` (the
 * car RETREATS, opening range) — deliberately the direction `SPEED_HOLD_MENU` can actually correct
 * for (0 to 2.5 m/s CLOSING only, no retreat option; see maneuver.ts) — an APPROACHING target the
 * menu cannot correct for at all beyond `hold` is a separate, real finding, not this sweep's
 * primary swept direction (declared, not silently narrowed). */
export function speedBearingRateCell(cfg: ReferenceCeilingCellConfig): EpisodeScenario {
  const world: WorldBridgeConfig = {
    seed: cfg.seed, droneAltitudeM: cfg.rig.droneAltitudeM, mountPitchDeg: cfg.rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
    droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    // carInitialHeadingDeg MUST be 0 here (matching scenarios.ts's own VISIBLE_TRACK, car ahead,
    // heading 0) — 'lateral-crossing"'s `forwardSpeedMps` is defined along the CAR's OWN initial
    // heading (world-bridge.ts's `carVelocityAt`); with heading 0 (car facing the SAME direction as
    // the drone, i.e. away from it), a positive forwardSpeedMps moves the car further in +x, i.e.
    // RETREATING (opening range) — the direction this module's own docstring declares and
    // SPEED_HOLD_MENU can actually correct for. Using 180 here (as an earlier revision of this
    // function did, copying TURN_TO_FIND's convention for a car spawned BEHIND the drone) would
    // silently flip the meaning to APPROACHING instead, a real bug caught via a real reference-
    // ceiling run showing truth.rangeErrorM far outside tolerance at supposedly-easy cells.
    carInitialPosition: { x: cfg.requestedRangeM + CAR_HALF_LENGTH_M, y: 0 }, carInitialHeadingDeg: 0,
    carPath: { kind: 'lateral-crossing', forwardSpeedMps: cfg.targetSpeedMps, lateralSpeedMps: cfg.bearingRateDegS * Math.PI / 180 * cfg.requestedRangeM },
    hfovDeg: cfg.rig.hfovDeg, physicsDtMs: 20,
  };
  return {
    id: `ref-ceiling-v${cfg.targetSpeedMps}-b${cfg.bearingRateDegS}-${cfg.rangeMenuKind}-${cfg.consequenceModel}`,
    goal: { classes: ['car', 'truck', 'bus'], colour: 'blue', description: 'the blue car', requestedRangeM: cfg.requestedRangeM },
    durationMs: cfg.durationMs, world,
    sectorMemory: DEFAULT_SECTOR_MEMORY_CONFIG, searchVariant: 'sector-consequences',
    freshWithinMs: 3000, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000,
    rangeToleranceM: cfg.rangeToleranceM, identityBearingToleranceRad: 10 * Math.PI / 180, identityRangeToleranceM: 2.0,
    centralBandFraction: cfg.centralBandFraction, envelope: cfg.envelope,
    passCriteria: {
      minFollowLockFraction: 0, maxLongestLossMs: cfg.durationMs, maxContacts: 0, requireFirstDetectionByMs: null, maxVetoedManeuvers: 999,
      minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: Math.min(4000, Math.floor(cfg.durationMs / 4)),
    },
    perception: { scoreThreshold: 0.15 },
    consequenceModel: cfg.consequenceModel, rangeMenuKind: cfg.rangeMenuKind,
    yawRateDegS: DEFAULT_YAW_RATE_DEG_S, rateWindowMs: DEFAULT_RATE_WINDOW_MS,
  };
}

/** Pure: the reference-ceiling sweep's own declared grid — see WORKLOG.md for why this pilot uses a
 * coarser grid than a literal 0-3m/0.5-step x 0-20deg/5-step Cartesian product (a stated, declared
 * economy given this unit's time budget: {0,1,2,3} m/s x {0,10,20} deg/s = 12 cells, spanning the
 * full requested envelope's corners/edges/midpoint rather than every intermediate value). */
export function referenceCeilingGrid(): { targetSpeedMps: number; bearingRateDegS: number }[] {
  const speeds = [0, 1, 2, 3];
  const rates = [0, 10, 20];
  const cells: { targetSpeedMps: number; bearingRateDegS: number }[] = [];
  for (const targetSpeedMps of speeds) for (const bearingRateDegS of rates) cells.push({ targetSpeedMps, bearingRateDegS });
  return cells;
}

/** Unit E4b / B2: the exact-constant-bearing-rate analogue of `speedBearingRateCell`, for the
 * ladder's own "L2's bearing rate ... needs a constant-rate path" instruction (engine-review-e3
 * finding 2) — uses `orbit` (world-bridge.ts) instead of `lateral-crossing`'s decaying
 * approximation, so the DECLARED bearing rate holds exactly for the whole episode (range from the
 * drone's own fixed start position never changes, by construction), not just at t=0. The drone is
 * held at a fixed heading/position here (matching L2's own "isolate yaw-only, hold the drone's own
 * position fixed" rule, ladder doc's own L2 section) — a caller that wants the drone free to chase
 * (e.g. reusing this cell generator for a moving-drone rung) is out of this function's declared
 * scope. `targetSpeedMps` (radial) is always 0 here — this generator is for the BEARING-RATE axis
 * specifically; use `speedBearingRateCell` for the target-speed axis. */
export function bearingRateOrbitCell(cfg: Omit<ReferenceCeilingCellConfig, 'targetSpeedMps'>): EpisodeScenario {
  const radiusM = cfg.requestedRangeM + CAR_HALF_LENGTH_M;
  const angularRateRadS = cfg.bearingRateDegS * Math.PI / 180;
  // startAngleDeg=0 places the car directly ahead of the drone (matching every other scenario's own
  // "car ahead, drone facing +x" convention); the car's own initial heading is set to the exact
  // tangent direction at t=0 so orbit's own yawRate (world-bridge.ts) keeps it aligned from the
  // first tick, not just eventually converging.
  const tangentHeadingDeg = (0 + (angularRateRadS >= 0 ? 90 : -90) + 360) % 360;
  const world: WorldBridgeConfig = {
    seed: cfg.seed, droneAltitudeM: cfg.rig.droneAltitudeM, mountPitchDeg: cfg.rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
    droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    carInitialPosition: { x: radiusM, y: 0 }, carInitialHeadingDeg: tangentHeadingDeg,
    carPath: { kind: 'orbit', centerX: 0, centerY: 0, radiusM, angularRateDegS: cfg.bearingRateDegS, startAngleDeg: 0 },
    hfovDeg: cfg.rig.hfovDeg, physicsDtMs: 20,
  };
  return {
    id: `ref-ceiling-orbit-b${cfg.bearingRateDegS}-${cfg.rangeMenuKind}-${cfg.consequenceModel}`,
    goal: { classes: ['car', 'truck', 'bus'], colour: 'blue', description: 'the blue car', requestedRangeM: cfg.requestedRangeM },
    durationMs: cfg.durationMs, world,
    sectorMemory: DEFAULT_SECTOR_MEMORY_CONFIG, searchVariant: 'sector-consequences',
    freshWithinMs: 3000, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000,
    rangeToleranceM: cfg.rangeToleranceM, identityBearingToleranceRad: 10 * Math.PI / 180, identityRangeToleranceM: 2.0,
    centralBandFraction: cfg.centralBandFraction, envelope: cfg.envelope,
    passCriteria: {
      minFollowLockFraction: 0, maxLongestLossMs: cfg.durationMs, maxContacts: 0, requireFirstDetectionByMs: null, maxVetoedManeuvers: 999,
      minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: Math.min(4000, Math.floor(cfg.durationMs / 4)),
    },
    perception: { scoreThreshold: 0.15 },
    consequenceModel: cfg.consequenceModel, rangeMenuKind: cfg.rangeMenuKind,
    yawRateDegS: DEFAULT_YAW_RATE_DEG_S, rateWindowMs: DEFAULT_RATE_WINDOW_MS,
  };
}

/** Unit E4b / B3: the finer speed-axis step list the assignment asks for (0-3 m/s in 0.25-0.5m/s
 * steps) — declared as 0.5m/s below 2 (matching the menu's own 0.5m/s granularity) and 0.25m/s from
 * 2-3 (the region the E4a review's own Q1 found the ceiling actually sits in, so this sweep spends
 * its finer resolution where the real transition is, a stated economy rather than a uniform
 * 0.25-step Cartesian product over the whole 0-3 range). */
export function b3SpeedAxisSteps(): number[] {
  return [0, 0.5, 1.0, 1.5, 2.0, 2.25, 2.5, 2.75, 3.0];
}
/** The ladder's own declared bearing-rate grid (§ Reference-ceiling sweep). */
export function b3BearingRateAxisSteps(): number[] {
  return [0, 5, 10, 15, 20];
}
