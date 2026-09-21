/** World + renderer bridge. Builds a commandable Rapier scene (drone + a kinematic scripted car,
 * no obstacles/lookalikes for the two smoke scenarios; obstacles are a later ladder rung) and
 * drives it interactively — issuing RobotPort commands from the chosen controller/maneuver and
 * stepping physics to any requested simulated time, rather than a pre-scripted offline route.
 *
 * Reuses experiments/jev-round3/world.ts's `TARGET_CAR_DIMENSIONS` (the renderer asset's actual
 * normalized bounds) and `cameraFromBody` (mount composition) directly — not its family-specific
 * `createScene`/`RouteSpec`, which is a pre-scripted-route builder that does not fit an
 * interactively commanded episode. World construction here otherwise follows the same pattern
 * (World.create + defaultRegistry + a ground plane + a kinematic target body), proven by that
 * module's own tests.
 *
 * Camera rig: HFOV/resolution/baseline are the renderer's own fixed module constants (a declared
 * gap — see the coordinator report). Altitude and the fixed mount pitch ARE this engine's own
 * scenario parameters (computed here, not inside renderer.py), defaulting to Round 3's own values
 * (1.8 m altitude, -5 degree pitch) so this engine's evidence can be roughly compared against that
 * recorded evidence; a scenario may raise altitude/steepen pitch for more realistic follow
 * geometry (an independent design review's point 5).
 *
 * Rendered background buildings/road decoration (renderer.py's own `_setup`) have no Rapier
 * collider (a pre-existing Round 3 property, not introduced here) — the two smoke scenarios keep
 * the drone within the open road corridor and add no obstacle body that would need one; a future
 * obstacle-scenario rung must add a matching Rapier collider for anything it asks the renderer to
 * draw as blocking (design review point 2).
 */
import type { BodySpec, BodyState, Contact, Pose, RobotPort } from '../../src/contracts.ts';
import { defaultRegistry } from '../../src/defaults.ts';
import { compose, pose as poseAt, randomStream, vec } from '../../src/math.ts';
import { Journal } from '../../src/recorder.ts';
import { World } from '../../src/world.ts';
import { cameraFromBody, TARGET_CAR_DIMENSIONS, type RenderPose } from '../jev-round3/world.ts';
import { buildEvaluatorSnapshot, type EvaluatorSnapshot, type TrueBodyState } from './evaluator.ts';

const DRONE_ID = 'find-follow-drone';
const CAR_ID = 'find-follow-target-car';
const GROUND_ID = 'find-follow-ground';
export const JOURNAL_CAPACITY = 4096;

export type CarPath =
  | { kind: 'gentle-curve'; forwardSpeedMps: number; lateralAmplitudeM: number; lateralPeriodMs: number }
  | { kind: 'stationary-then-forward'; forwardSpeedMps: number; startMovingAtMs: number; headingDeg: number }
  /** engine-review-e2 finding 5 / increment B1: a car path with a DECLARED, constant lateral
   * (bearing-rate-inducing) speed, for a scenario where a passive (never-yaw) policy provably
   * cannot stay centred — unlike `gentle-curve`'s oscillation (which returns to centre twice per
   * period, letting `passive` get lucky), a constant lateral crossing drifts monotonically off
   * to one side, so only an actively-yawing policy can stay centred for long. `forwardSpeedMps`
   * keeps the car roughly in range while `lateralSpeedMps` sets the crossing speed. */
  | { kind: 'lateral-crossing'; forwardSpeedMps: number; lateralSpeedMps: number }
  /** Unit E4b / engine-review-e3 "Question 2/finding 2" (L2's own bearing rate decays as range
   * grows under `lateral-crossing`: a declared 10 deg/s is 7.8 deg/s at t=0 and decays to 1 deg/s
   * as range grows 8->28m over the episode). `orbit` instead drives the car on an EXACT circle of
   * `radiusM` centred at `(centerX, centerY)` at a CONSTANT angular rate `angularRateDegS` — since
   * range from the centre is constant by construction, the bearing rate AS SEEN FROM THE CENTRE is
   * exactly `angularRateDegS` for the whole episode (not a first-order approximation that decays),
   * genuinely isolating "constant bearing rate" the way L2 is meant to. The car's own heading
   * continuously matches its tangential direction of travel (yawRate = angularRateDegS), so from a
   * camera fixed at the centre the car presents a constant SIDE aspect throughout (a car driving
   * past on a circular track) — a real, declared consequence of this path, not an oversight (the
   * review's own static probe found side/rear/oblique all detect reliably; only front is a blind
   * spot, so this path does not stress that specific failure mode by construction). `startAngleDeg`
   * is optional (defaults to the angle implied by the scenario's own `carInitialPosition` relative
   * to the centre, so the two stay consistent without duplicating the geometry at both call sites);
   * an explicit value can force it if a caller does not want to compute `carInitialPosition` itself. */
  | { kind: 'orbit'; centerX: number; centerY: number; radiusM: number; angularRateDegS: number; startAngleDeg?: number }
  /** Unit E4b / B2: a piecewise scripted car — `segments` are consumed IN ORDER, each holding for
   * its own `durationMs` of simulated time before the next begins (the LAST segment holds forever
   * once its own `durationMs` has elapsed, so an episode longer than the sum of declared segments
   * does not run off the end of the script). Within a segment, speed ramps LINEARLY from the
   * previous segment's own `targetSpeedMps` (0 before the first segment) to this segment's own
   * `targetSpeedMps` over the first `rampMs` of the segment (0 = an instant speed change), then
   * holds constant — "accelerate, cruise, stop" (B2's own wording) is a 3+ segment script with
   * `targetSpeedMps` 0 at the episode's start and end. A heading change between consecutive
   * segments is a genuine TURN (declared as instantaneous — the car is a scripted kinematic body,
   * not physically steered — a stated simplification, not a claim about realistic yaw dynamics);
   * `targetSpeedMps` may be any value, deliberately including values that do not coincide with any
   * `SPEED_HOLD_MENU`/`buildSpeedHoldMenu` option (B3's own "speed profiles that are NOT menu
   * speeds" requirement) so a `constant` baseline cannot get lucky by exactly matching one menu
   * choice to a constant target speed for the whole episode. */
  | { kind: 'scripted-segments'; segments: { durationMs: number; headingDeg: number; targetSpeedMps: number; rampMs: number }[] };

/** Unit E4b / A6 ("stationary scenes are a pose lottery"): engine-review-e3's Question 2 found L1's
 * object list empty in 93/100 frames because a static camera + static scene renders BYTE-IDENTICAL
 * frames — the same miss (or hit) repeats deterministically for the whole episode, so a single
 * static-camera episode is really a single-pose lottery draw, not a measured reliability rate.
 * `hoverJitter` adds a small, SEEDED (reproducible given the scenario's own seed), per-acquisition
 * perturbation to the CAMERA pose only (never the drone's own true flight-control state, never the
 * target) — physically motivated as gimbal/mount micro-vibration and residual hover drift on a real
 * platform, not sensor noise. `positionSigmaM` (e.g. 0.03m = 3cm, "a few cm") perturbs camera world
 * position independently on x/y (full sigma) and z (0.3x sigma — vertical hover drift is normally
 * smaller than horizontal on a real multirotor); `yawSigmaDeg` (e.g. 0.2deg, "tenths of a degree")
 * perturbs camera yaw. Applied identically to `renderInput()`'s `camera_pose` AND
 * `evaluatorSnapshot()`'s truth camera pose for the SAME acquisition instant (keyed by simulated
 * time, see `currentHoverJitter()` below) — so the evaluator's truth always matches what was
 * actually rendered, and the jitter is a real (if small) perturbation of "what happened", not an
 * unmodelled discrepancy between the two. Deterministic given `seed`: run-to-run determinism
 * (identical seed + identical controller responses => identical trajectory) is unaffected, since the
 * jitter sequence is itself a pure function of the seeded stream's own call order. Declared
 * limitation: `renderer.py` is outside this engine's edit scope (see renderer-client.ts's own
 * docstring), so this cannot add seeded per-frame IMAGE noise (pixel-level) — pose jitter is the
 * mechanism actually implemented, matching the assignment's own "and/or" wording. */
export interface HoverJitterConfig { positionSigmaM: number; yawSigmaDeg: number }

export interface WorldBridgeConfig {
  seed: number;
  droneAltitudeM: number;
  mountPitchDeg: number;
  droneMaxSpeedMps: number;
  droneInitialPosition: { x: number; y: number };
  droneInitialHeadingDeg: number;
  carInitialPosition: { x: number; y: number };
  carInitialHeadingDeg: number;
  carPath: CarPath;
  hfovDeg: number;
  physicsDtMs: number;
  /** Optional (default: off, byte-for-byte unchanged behaviour for every caller that does not set
   * this — the two smoke scenarios and existing determinism regression tests all rely on this).
   * See {@link HoverJitterConfig}'s own docstring. */
  hoverJitter?: HoverJitterConfig;
}

export const ROUND3_DEFAULTS = Object.freeze({ droneAltitudeM: 1.8, mountPitchDeg: -5, hfovDeg: 70, physicsDtMs: 20 });

function carVelocityAt(config: WorldBridgeConfig, simMs: number): { linear: { x: number; y: number; z: number }; yawRate: number } {
  const path = config.carPath;
  if (path.kind === 'gentle-curve') {
    const t = simMs / 1000, omega = 2 * Math.PI / (path.lateralPeriodMs / 1000);
    const lateral = path.lateralAmplitudeM * omega * Math.cos(omega * t);
    // Forward direction fixed along the car's initial heading; a gentle curve is a small,
    // continuously varying lateral component, not a sharp turn.
    const headingRad = config.carInitialHeadingDeg * Math.PI / 180;
    const forward = vec(Math.cos(headingRad) * path.forwardSpeedMps, Math.sin(headingRad) * path.forwardSpeedMps, 0);
    const lateralDir = vec(-Math.sin(headingRad) * lateral, Math.cos(headingRad) * lateral, 0);
    return { linear: { x: forward.x + lateralDir.x, y: forward.y + lateralDir.y, z: 0 }, yawRate: 0 };
  }
  if (path.kind === 'lateral-crossing') {
    const headingRad = config.carInitialHeadingDeg * Math.PI / 180;
    const forward = vec(Math.cos(headingRad) * path.forwardSpeedMps, Math.sin(headingRad) * path.forwardSpeedMps, 0);
    // Lateral direction perpendicular to the car's own initial heading (a fixed crossing direction,
    // not oscillating), at a CONSTANT declared speed.
    const lateralDir = vec(-Math.sin(headingRad) * path.lateralSpeedMps, Math.cos(headingRad) * path.lateralSpeedMps, 0);
    return { linear: { x: forward.x + lateralDir.x, y: forward.y + lateralDir.y, z: 0 }, yawRate: 0 };
  }
  if (path.kind === 'orbit') {
    const angularRateRadS = path.angularRateDegS * Math.PI / 180;
    const startAngleRad = path.startAngleDeg !== undefined
      ? path.startAngleDeg * Math.PI / 180
      : Math.atan2(config.carInitialPosition.y - path.centerY, config.carInitialPosition.x - path.centerX);
    const angleRad = startAngleRad + angularRateRadS * (simMs / 1000);
    // Exact tangential velocity of a point moving on a circle of radiusM at angularRateRadS — range
    // from (centerX, centerY) is constant by construction, so bearing rate FROM THE CENTRE equals
    // angularRateDegS exactly, not a first-order approximation (see the CarPath docstring above).
    const vx = -path.radiusM * angularRateRadS * Math.sin(angleRad);
    const vy = path.radiusM * angularRateRadS * Math.cos(angleRad);
    return { linear: { x: vx, y: vy, z: 0 }, yawRate: angularRateRadS };
  }
  if (path.kind === 'scripted-segments') {
    let t = simMs;
    let prevSpeedMps = 0;
    for (let i = 0; i < path.segments.length; i++) {
      const seg = path.segments[i]!;
      const isLast = i === path.segments.length - 1;
      if (t < seg.durationMs || isLast) {
        const rampMs = Math.max(0, seg.rampMs);
        const speedMps = rampMs > 0 && t < rampMs
          ? prevSpeedMps + (seg.targetSpeedMps - prevSpeedMps) * (t / rampMs)
          : seg.targetSpeedMps;
        const headingRad = seg.headingDeg * Math.PI / 180;
        return { linear: { x: Math.cos(headingRad) * speedMps, y: Math.sin(headingRad) * speedMps, z: 0 }, yawRate: 0 };
      }
      t -= seg.durationMs;
      prevSpeedMps = seg.targetSpeedMps;
    }
    // Unreachable (the loop's `isLast` branch always returns), kept only so TypeScript sees every
    // path return a value.
    return { linear: { x: 0, y: 0, z: 0 }, yawRate: 0 };
  }
  if (simMs < path.startMovingAtMs) return { linear: { x: 0, y: 0, z: 0 }, yawRate: 0 };
  const headingRad = path.headingDeg * Math.PI / 180;
  return { linear: { x: Math.cos(headingRad) * path.forwardSpeedMps, y: Math.sin(headingRad) * path.forwardSpeedMps, z: 0 }, yawRate: 0 };
}

export interface RenderInput { camera_pose: RenderPose; target_pose: RenderPose; scene_config: Record<string, unknown> }

export interface WorldBridge {
  readonly simMs: number;
  readonly droneId: string; readonly carId: string;
  advance(ticks: number): Promise<void>;
  claimDrone(owner: string): RobotPort;
  updateCarScript(): void;
  renderInput(): RenderInput;
  evaluatorSnapshot(): EvaluatorSnapshot;
  droneBody(): BodyState;
  carBody(): BodyState;
  contacts(): Contact[];
  close(): Promise<void>;
}

function gaussianJitter(uniform: () => number): number {
  let u1 = uniform(); if (u1 <= 0) u1 = 1e-9;
  const u2 = uniform();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export async function createWorldBridge(config: WorldBridgeConfig): Promise<WorldBridge> {
  const random = randomStream(config.seed, 'find-follow-world');
  // A6 (hover jitter): the stream reserved by a prior unit's own comment ("reserved for future
  // per-episode jitter") — now actually used, see HoverJitterConfig's own docstring above.
  const carSize: [number, number, number] = [...TARGET_CAR_DIMENSIONS];
  const carYawQuat = (yawDeg: number) => ({ x: 0, y: 0, z: Math.sin(yawDeg * Math.PI / 360), w: Math.cos(yawDeg * Math.PI / 360) });
  const dronePose: Pose = { position: vec(config.droneInitialPosition.x, config.droneInitialPosition.y, config.droneAltitudeM), rotation: carYawQuat(config.droneInitialHeadingDeg) };
  const carPose: Pose = { position: vec(config.carInitialPosition.x, config.carInitialPosition.y, carSize[2] / 2), rotation: carYawQuat(config.carInitialHeadingDeg) };
  const ground: BodySpec = { id: GROUND_ID, pose: poseAt(config.carInitialPosition.x, 0, -0.1), shape: { kind: 'box', size: vec(80, 60, 0.2), color: '#818078' }, mode: 'fixed' };
  const car: BodySpec = { id: CAR_ID, pose: carPose, shape: { kind: 'box', size: vec(...carSize), color: '#1448bf' }, mode: 'kinematic' };
  const scenario = {
    id: `jev-find-follow-${config.seed}`, seed: config.seed, dt: config.physicsDtMs / 1000,
    gravity: vec(0, 0, -9.81), bounds: vec(120, 80, 20), obstacles: [ground, car],
    robots: [{ id: DRONE_ID, model: 'drone', pose: dronePose, config: { maxSpeed: config.droneMaxSpeedMps, maxAcceleration: 6 }, sensors: [],
      goal: 'Closed-loop find-and-follow episode; no learned controller or navigation evaluation baked into the plant' }],
  };
  const journal = new Journal(JOURNAL_CAPACITY);
  const world = await World.create(scenario, defaultRegistry(), 'rapier', journal);
  const mount: RenderPose = { position: [0, 0, 0], yaw_rad: 0, pitch_rad: config.mountPitchDeg * Math.PI / 180, roll_rad: 0 };

  function droneBody(): BodyState { return world.physics.body(`${DRONE_ID}/base`); }
  function carBody(): BodyState { return world.physics.body(CAR_ID); }
  // E3b residual defect B: the single point every simulated-time read in this bridge goes through —
  // see the `simMs` getter below for why rounding here (not in the shared `src/world.ts`) is both in
  // scope and lossless.
  function roundedSimMs(): number { return Math.round(world.simMs); }

  // A6: one jitter draw per DISTINCT acquisition instant (keyed by simMs), reused by both
  // renderInput() and evaluatorSnapshot() when called for the same acquisition (episode.ts's
  // performAcquisition() always calls evaluatorSnapshot() then renderInput() back to back for one
  // acquisition) — so the evaluator's truth camera pose always matches what was actually rendered.
  let jitterKeyMs: number | null = null;
  let jitterCache = { dx: 0, dy: 0, dz: 0, dYawRad: 0 };
  function currentHoverJitter(): { dx: number; dy: number; dz: number; dYawRad: number } {
    const cfg = config.hoverJitter;
    if (!cfg) return { dx: 0, dy: 0, dz: 0, dYawRad: 0 };
    const t = roundedSimMs();
    if (jitterKeyMs !== t) {
      jitterKeyMs = t;
      const yawSigmaRad = cfg.yawSigmaDeg * Math.PI / 180;
      jitterCache = {
        dx: gaussianJitter(random) * cfg.positionSigmaM,
        dy: gaussianJitter(random) * cfg.positionSigmaM,
        dz: gaussianJitter(random) * cfg.positionSigmaM * 0.3,
        dYawRad: gaussianJitter(random) * yawSigmaRad,
      };
    }
    return jitterCache;
  }
  function jitteredCameraPose(): RenderPose {
    const drone = droneBody();
    const base = cameraFromBody(drone, mount);
    const jitter = currentHoverJitter();
    return {
      position: [base.position[0] + jitter.dx, base.position[1] + jitter.dy, base.position[2] + jitter.dz],
      yaw_rad: base.yaw_rad + jitter.dYawRad, pitch_rad: base.pitch_rad, roll_rad: base.roll_rad,
    };
  }

  const bridge: WorldBridge = {
    // E3b residual defect B: `World.simMs` (src/world.ts) is `#ticks * scenario.dt * 1000`, and
    // `scenario.dt` (`physicsDtMs / 1000`, e.g. 20/1000 = 0.02) is not exactly representable in
    // binary floating point — the product drifts by a few picoseconds-in-milliseconds per tick
    // (observed: `199.99999999999636`, `400.0000000000073`), even though `#ticks * physicsDtMs` is
    // always mathematically an exact integer (both are declared integer milliseconds; `physicsDtMs`
    // is never fractional). This is the ONLY point in the find-and-follow engine that reads the
    // shared core `World`'s clock, so rounding here — rather than in `src/world.ts`, a file shared
    // by every other experiment in this repo and outside this unit's edit scope — makes simulated
    // time exactly integer milliseconds end to end for every downstream consumer (episode.ts's
    // scheduling arithmetic, `evaluatorSnapshot().acquiredSimMs`, every report field): the true tick
    // count times an integer period can never legitimately round to a different integer, so this is
    // lossless, not an approximation.
    get simMs() { return roundedSimMs(); },
    droneId: DRONE_ID, carId: CAR_ID,
    // engine-review-e1 finding 6: the scripted car's velocity was previously only refreshed once
    // per ACQUISITION (whenever episode.ts called updateCarScript()), not per physics tick. For a
    // continuously time-varying script (`gentle-curve`'s cosine lateral velocity), that means the
    // car actually moved at a single acquisition-stale velocity sample across every intervening
    // tick, not the smoothly varying one the script defines, and determinism/accuracy both degrade
    // as the acquisition period grows relative to the physics tick. advance() now recomputes and
    // re-applies the script's velocity before EVERY individual 20ms tick, matching how a real
    // kinematic scripted body would be driven. updateCarScript() stays public (existing tests call
    // it directly before their own advance() calls); calling it is now redundant with what advance()
    // already does per tick, not required, and harmless (the script is a pure function of simMs).
    async advance(ticks: number) {
      for (let i = 0; i < ticks; i++) {
        const { linear, yawRate } = carVelocityAt(config, roundedSimMs());
        world.physics.velocity(CAR_ID, vec(linear.x, linear.y, linear.z), vec(0, 0, yawRate));
        await world.advance(1);
      }
    },
    claimDrone(owner: string) { return world.claim(DRONE_ID, owner); },
    updateCarScript() {
      const { linear, yawRate } = carVelocityAt(config, roundedSimMs());
      world.physics.velocity(CAR_ID, vec(linear.x, linear.y, linear.z), vec(0, 0, yawRate));
    },
    renderInput(): RenderInput {
      const carState = carBody();
      // A6: the jittered (not raw droneBody-derived) camera pose — a static scene + a static
      // camera renders byte-identical frames every acquisition; hoverJitter (when configured) makes
      // consecutive acquisitions at a nominally-static pose genuinely differ (see HoverJitterConfig).
      const cameraRenderPose = jitteredCameraPose();
      const targetYaw = Math.atan2(2 * (carState.pose.rotation.w * carState.pose.rotation.z + carState.pose.rotation.x * carState.pose.rotation.y), 1 - 2 * (carState.pose.rotation.y ** 2 + carState.pose.rotation.z ** 2));
      const targetRenderPose: RenderPose = { position: [carState.pose.position.x, carState.pose.position.y, carState.pose.position.z - carSize[2] / 2], yaw_rad: targetYaw, pitch_rad: 0, roll_rad: 0 };
      return { camera_pose: cameraRenderPose, target_pose: targetRenderPose, scene_config: { seed: config.seed, obstacles: [], lookalikes: [] } };
    },
    evaluatorSnapshot(): EvaluatorSnapshot {
      const carState = carBody();
      // Same jittered pose as renderInput() for the SAME acquisition instant (cached by simMs) —
      // truth must match what was actually rendered, not the drone's un-perturbed true flight pose.
      const cameraRenderPose = jitteredCameraPose();
      const target: TrueBodyState = { id: CAR_ID, kind: 'target', pose: carState.pose, halfExtents: { x: carSize[0] / 2, y: carSize[1] / 2, z: carSize[2] / 2 } };
      return buildEvaluatorSnapshot({
        acquiredSimMs: roundedSimMs(), cameraPosition: { x: cameraRenderPose.position[0], y: cameraRenderPose.position[1], z: cameraRenderPose.position[2] },
        cameraHeadingDeg: cameraRenderPose.yaw_rad * 180 / Math.PI, hfovDeg: config.hfovDeg, target, lookalikes: [],
      });
    },
    droneBody, carBody,
    contacts() { return world.physics.contacts(); },
    async close() { world.close(); },
  };
  return bridge;
}
