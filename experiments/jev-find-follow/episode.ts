/** Episode orchestration: ties the simulated-time scheduler (scheduler.ts), the world/renderer/
 * sensor bridges, derived state (target-binder.ts, sector-memory.ts, own-state.ts), the encoders
 * (encoders/track.ts, encoders/search.ts) and one plugged-in controller together into one closed
 * loop, then scores and reports the result. See scheduler.ts's module docstring for the simulated-
 * time model this loop implements.
 *
 * engine-review-e2 repair pass (finding 1, the most severe): the E2 loop advanced the REAL world to
 * the decision's predicted application time BEFORE building the request, and then treated
 * "wherever the world ended up" as the new acquisition floor — which silently re-coupled
 * acquisition to decision cadence (measured: 1.67 Hz, not the declared 5 Hz) and meant a slow
 * controller call took zero frames. This version never advances the world for prediction:
 *   - The acquisition loop (`performAcquisition`) is the ONLY thing that advances the real world,
 *     strictly on the camera's own `cameraPeriodMs` grid, via `advanceRealWorld` (which also checks
 *     for a due follow-up command — see below).
 *   - Predicted-application-pose consequences come from `predictPoseAt`, a pure kinematic
 *     projection of the CURRENTLY in-flight command (yaw rate + world-frame velocity, held constant
 *     for its own declared duration, then holding at rest — exactly what `src/world.ts`'s
 *     `plant.stop()` on expiry actually does), never from touching `world`.
 *   - The controller call runs CONCURRENTLY with continued acquisition on the camera grid (a slow
 *     controller now genuinely yields frames during its own wait), not sequentially after it.
 *   - Sensor metrics (detected/bound/framed) are now computed per ACQUISITION (`bindByAcquiredSimMs`,
 *     scoring.ts), not per decision.
 * engine-review-e2 finding 2: yaw and range/speed axes execute independently (maneuver.ts's
 * `PlannedTrackCommand.followUp`, auto-issued by `advanceRealWorld` at its own due simulated
 * instant); a bounded (non-speed-hold) maneuver's own completion time now gates the NEXT decision's
 * dispatch (`pendingBoundedUntilSimMs`) so it is not routinely superseded mid-turn/mid-step.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoEvaluatorLeak, assertNoRankingLanguage } from './checks.ts';
import { AppearanceTracker } from '../../integrations/stereo-objects.ts';
import { bearingAndRangeFromWorldPosition, cameraRelativeBearingRad, reprojectBearingAfterYaw, worldBearingDeg, worldPositionFromBearing, type Vec3World } from './camera-geometry.ts';
import { buildTrackRequest, type ConsequenceModel, type RangeMenuKind } from './encoders/track.ts';
import { buildSearchRequest, type SearchVariant } from './encoders/search.ts';
import { determineMode } from './encoders/mode.ts';
import { evaluatorFrameFromSnapshot, buildReport, type EvaluatorFrame } from './report.ts';
import {
  boundedCompletionMs, planTrackManeuver, planManeuver, SEARCH_MENU, SPEED_HOLD_MENU, TRACK_RANGE_MENU,
  DEFAULT_YAW_RATE_DEG_S, type PlannedCommand,
} from './maneuver.ts';
import type { ContactEvent } from './scoring.ts';
import { scoreEpisode, type EnvelopeBounds, type PassCriteria } from './scoring.ts';
import {
  DEFAULT_SCHEDULER_CONFIG, advanceToSimMs, commandAppliedSimMs, controllerReturnSimMs,
  nextDispatchSimMs, observationAvailableSimMs, pacingWaitMs, planNextAcquisition, readyToDispatch, type SchedulerConfig,
} from './scheduler.ts';
import { estimateRate, type RateSample } from './rate-estimate.ts';
import { createOwnStateTracker } from './own-state.ts';
import { createSectorMemory, updateSectorMemory, ageSectorMemory, deriveClearance, sectorIndexForHeading, DEFAULT_SECTOR_MEMORY_CONFIG, type SectorMemoryConfig } from './sector-memory.ts';
import { createTargetBinder } from './target-binder.ts';
import { createWorldBridge, type WorldBridge, type WorldBridgeConfig } from './world-bridge.ts';
import { startRendererClient, type RendererClient, type RendererClientOptions } from './renderer-client.ts';
import { startSensorClient, type SensorClient, type SensorClientOptions } from './sensor-client.ts';
import type { EngineController } from './controllers/types.ts';
import type { BindResult, ClearanceStatus, DecisionRecord, Goal, LastSeenRecord, Mode, OwnState, StereoObject } from './types.ts';

export interface EpisodeScenario {
  id: string;
  goal: Goal;
  durationMs: number;
  world: WorldBridgeConfig;
  sectorMemory: SectorMemoryConfig;
  searchVariant: SearchVariant;
  freshWithinMs: number;
  lastSeenTrustworthyMs: number;
  lastSeenStaleMs: number;
  rangeToleranceM: number;
  identityBearingToleranceRad: number;
  identityRangeToleranceM: number;
  centralBandFraction: number;
  envelope: EnvelopeBounds;
  passCriteria: PassCriteria;
  perception: { scoreThreshold: number };
  consequenceModel: ConsequenceModel;
  rangeMenuKind: RangeMenuKind;
  /** engine-review-e2 finding 8: the flight-controller's yaw rate is now a declared, scenario-level
   * parameter (see maneuver.ts's `DEFAULT_YAW_RATE_DEG_S` for the justification), not a hard-coded
   * module constant — so a scenario can raise/lower it without an engine code change, and so it
   * shows up explicitly in the report's recorded config (finding 7). */
  yawRateDegS: number;
  /** engine-review-e2 finding 3: the rate-estimate window W (rate-estimate.ts), a declared scenario
   * parameter (default 1.0s, `DEFAULT_RATE_WINDOW_MS`) resolving the ladder's own window ambiguity. */
  rateWindowMs: number;
  /** Increment B1: single-axis question modes (`docs/jev-find-follow-ladder.md`'s L1/L2 rungs ask
   * ONLY the yaw question, L3a/L3b ONLY the range question; L4 asks both). Default 'both' (the two
   * existing smoke scenarios' behaviour, unchanged). When an axis is NOT asked this decision, its
   * in-flight command defaults to 'hold' on that axis (a deliberate engine decision made by this
   * unit, not deferred further — see the dispatch block below for the reasoning: a rung that never
   * asks about an axis has no Jev-controlled outcome to execute on it, so holding is the only
   * declared-safe default that never silently moves the platform on a criterion nobody was asked
   * about). */
  questionMode?: 'both' | 'yaw-only' | 'range-only';
}

export interface EpisodeDeps {
  createWorld: (config: WorldBridgeConfig) => Promise<WorldBridge>;
  createRenderer: (options: RendererClientOptions) => Promise<RendererClient>;
  createSensor: (options: SensorClientOptions) => Promise<SensorClient>;
}
const DEFAULT_DEPS: EpisodeDeps = { createWorld: createWorldBridge, createRenderer: startRendererClient, createSensor: startSensorClient };

export interface EpisodeRunOptions {
  scheduler?: Partial<SchedulerConfig>;
  controller: EngineController;
  outputRoot: string;
  renderer: { pythonExecutable: string; rendererScriptPath: string };
  sensor: { pythonExecutable: string; sensorCwd: string; checkpointPath: string; detectorRuntimeRoot: string; device?: string };
  seed: number;
  signal?: AbortSignal;
  deps?: Partial<EpisodeDeps>;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function ownWorldPosition(ownState: OwnState, droneInitialPosition: { x: number; y: number }): Vec3World {
  return { x: droneInitialPosition.x + ownState.odometryDisplacementM.x, y: droneInitialPosition.y + ownState.odometryDisplacementM.y, z: ownState.altitudeM };
}

/** A7 (engine-review-e3 finding 7, "report config... carries an absolute checkpoint path"): the
 * real sensor subprocess's own `hello` record (an opaque `Record<string, unknown>` from external
 * Python) is not under this module's schema control and may carry local-machine absolute filesystem
 * paths (e.g. `manifestPath`, or whatever its loaded model's own metadata reports) — meaningless,
 * and potentially identifying, to a reviewer reading a saved report elsewhere. Recursively replaces
 * any string value that LOOKS like an absolute path (POSIX `/...` or a Windows drive-letter path
 * `C:\...`/`C:/...`) with just its basename, leaving every other value (including relative paths,
 * which carry no local-machine information) untouched. */
function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
function redactAbsolutePaths(value: unknown): unknown {
  if (typeof value === 'string') return looksLikeAbsolutePath(value) ? `[redacted local path, basename: ${basename(value)}]` : value;
  if (Array.isArray(value)) return value.map(redactAbsolutePaths);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAbsolutePaths(v)]));
  return value;
}

/** A plain top-level function (not inline in the loop): TS's control-flow narrowing for a `let`
 * mutated inside a nested closure (here, `lastSeen`, mutated by `performAcquisition`) does not
 * reliably apply to inline reads/ternaries in the OUTER function, even from a locally re-typed
 * `const` snapshot — narrowing works correctly through an ordinary function PARAMETER instead (see
 * `computeTrackBaseline` below, which has the same shape and never hits this). */
function ageOf(record: LastSeenRecord | null): number | null { return record ? record.ageMs : null; }

/** Same TS-narrowing workaround as `ageOf` above (plain top-level function, not inlined): the
 * simulated instant the track baseline's evidence was actually observed at — the acquisition time
 * for a fresh bind, or the sighting's own acquisition time for a last-seen baseline — used by the
 * finding-1 latency-compensation fix below to know how much already-elapsed time the target's own
 * measured rate must be projected across. */
function evidenceReferenceSimMs(evidenceSource: 'bound' | 'last-seen' | 'none', freshAcquireAtSimMs: number, lastSeen: LastSeenRecord | null): number {
  return evidenceSource === 'last-seen' && lastSeen ? lastSeen.acquiredSimMs : freshAcquireAtSimMs;
}

interface TrackBaseline {
  boundBearingRightRad: number | null; boundBearingUpRad: number | null; boundRangeM: number | null;
  evidenceSource: 'bound' | 'last-seen' | 'none'; evidenceAgeMs: number;
}

/** Findings 2/4/5 (engine-review-e1) + engine-review-e2 finding 1's prediction requirement, as a
 * standalone pure function: given the freshest acquisition's bound candidate (if any) or the
 * current last-seen record (if any), reprojects it onto the PREDICTED application pose (itself now
 * a pure kinematic projection — see `predictPoseAt` — never a real-physics advance) via the
 * world-position round trip (camera-geometry.ts). */
function computeTrackBaseline(
  boundCandidate: { bearingRightRad: number; bearingUpRad: number; rangeM: number | null } | null,
  acquisitionOwnState: OwnState, lastSeen: LastSeenRecord | null,
  droneInitialPosition: { x: number; y: number }, mountPitchRad: number, predictedOwnState: OwnState,
): TrackBaseline {
  const cameraWorldPositionAtApplication = ownWorldPosition(predictedOwnState, droneInitialPosition);
  const predictedHeadingRad = predictedOwnState.headingDeg * Math.PI / 180;
  if (boundCandidate) {
    const acqHeadingRad = acquisitionOwnState.headingDeg * Math.PI / 180;
    const cameraWorldPositionAtAcquisition = ownWorldPosition(acquisitionOwnState, droneInitialPosition);
    if (boundCandidate.rangeM !== null) {
      const targetWorldPos = worldPositionFromBearing(cameraWorldPositionAtAcquisition, acqHeadingRad, mountPitchRad,
        { bearingRightRad: boundCandidate.bearingRightRad, bearingUpRad: boundCandidate.bearingUpRad }, boundCandidate.rangeM);
      const projected = bearingAndRangeFromWorldPosition(cameraWorldPositionAtApplication, predictedHeadingRad, mountPitchRad, targetWorldPos);
      return { boundBearingRightRad: projected.bearing.bearingRightRad, boundBearingUpRad: projected.bearing.bearingUpRad, boundRangeM: round1(projected.rangeM), evidenceSource: 'bound', evidenceAgeMs: 0 };
    }
    const reproj = reprojectBearingAfterYaw({ bearingRightRad: boundCandidate.bearingRightRad, bearingUpRad: boundCandidate.bearingUpRad }, acqHeadingRad, mountPitchRad, predictedHeadingRad - acqHeadingRad);
    return { boundBearingRightRad: reproj.bearingRightRad, boundBearingUpRad: reproj.bearingUpRad, boundRangeM: null, evidenceSource: 'bound', evidenceAgeMs: 0 };
  }
  if (lastSeen) {
    const evidenceAgeMs = predictedOwnState.acquiredSimMs - lastSeen.acquiredSimMs;
    if (lastSeen.rangeM !== null) {
      const worldBearingRad = lastSeen.bearingDeg * Math.PI / 180;
      const targetWorldPos: Vec3World = {
        x: lastSeen.ownPositionAtSightingM.x + lastSeen.rangeM * Math.cos(worldBearingRad),
        y: lastSeen.ownPositionAtSightingM.y + lastSeen.rangeM * Math.sin(worldBearingRad),
        z: lastSeen.ownPositionAtSightingM.z,
      };
      const projected = bearingAndRangeFromWorldPosition(cameraWorldPositionAtApplication, predictedHeadingRad, mountPitchRad, targetWorldPos);
      return { boundBearingRightRad: projected.bearing.bearingRightRad, boundBearingUpRad: projected.bearing.bearingUpRad, boundRangeM: round1(projected.rangeM), evidenceSource: 'last-seen', evidenceAgeMs };
    }
    return { boundBearingRightRad: cameraRelativeBearingRad(predictedOwnState.headingDeg, lastSeen.bearingDeg), boundBearingUpRad: 0, boundRangeM: null, evidenceSource: 'last-seen', evidenceAgeMs };
  }
  return { boundBearingRightRad: null, boundBearingUpRad: null, boundRangeM: null, evidenceSource: 'none', evidenceAgeMs: 0 };
}

/** One segment of a `velocity` command's own kinematics: constant world-frame linear velocity and
 * yaw rate, active on [fromSimMs, toSimMs). Built directly from an issued `PlannedCommand` — this
 * is EXACTLY the model `src/models/mobile.ts`'s drone plant itself integrates for a `velocity`
 * action, so the prediction should track the real physics closely (mild tick-rounding aside). A
 * `goto`/`hold` action contributes no segment (declared simplification: position is not predicted
 * to change under those actions — search's own request text does not depend on predicted position,
 * only heading, and `hold`/`goto` do not change heading either). */
interface KinematicSegment { fromSimMs: number; toSimMs: number; headingRateRadS: number; velocityWorld: Vec3World }
interface PendingKinematics { baseHeadingDeg: number; basePosition: Vec3World; segments: KinematicSegment[] }

function segmentsForCommand(appliedSimMs: number, cmd: PlannedCommand): KinematicSegment[] {
  if (cmd.action !== 'velocity') return [];
  return [{ fromSimMs: appliedSimMs, toSimMs: appliedSimMs + cmd.validForMs, headingRateRadS: (cmd.args.yawRate as number) ?? 0, velocityWorld: { x: (cmd.args.x as number) ?? 0, y: (cmd.args.y as number) ?? 0, z: 0 } }];
}

/** Pure: predicts own pose at `targetSimMs` by integrating through `pending`'s segments (holding
 * position/heading at whatever they reached once every segment has ended, matching
 * `plant.stop()`'s declared safe behaviour on lease expiry) — never touches the real world. This
 * IS the "prediction, not moving the world" the assignment requires. */
function predictPoseAt(pending: PendingKinematics | null, targetSimMs: number): { headingDeg: number; position: Vec3World } {
  if (!pending) return { headingDeg: 0, position: { x: 0, y: 0, z: 0 } };
  let headingDeg = pending.baseHeadingDeg;
  const position = { ...pending.basePosition };
  for (const seg of pending.segments) {
    if (targetSimMs <= seg.fromSimMs) break; // target falls before this segment even starts
    const activeS = (Math.min(targetSimMs, seg.toSimMs) - seg.fromSimMs) / 1000;
    headingDeg += seg.headingRateRadS * activeS * 180 / Math.PI;
    position.x += seg.velocityWorld.x * activeS; position.y += seg.velocityWorld.y * activeS; position.z += seg.velocityWorld.z * activeS;
    if (targetSimMs <= seg.toSimMs) break; // target falls within (or exactly at the end of) this segment
  }
  return { headingDeg, position };
}

export async function runEpisode(scenario: EpisodeScenario, options: EpisodeRunOptions) {
  const deps: EpisodeDeps = { ...DEFAULT_DEPS, ...options.deps };
  const config: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...options.scheduler };
  // Unit E4b / B3: preserve the pre-existing "paced >=X ms apart in BOTH clocks" coupling by
  // default — a caller that overrides `pacingFloorMs` (e.g. every pre-A6/B3 test in this suite)
  // without separately mentioning `wallPacingFloorMs` gets the SAME value mirrored onto the real
  // wall-clock wait, exactly as before this field existed. Only an override that EXPLICITLY sets
  // `wallPacingFloorMs` (see b3-sweep.ts's fake-mode runs) decouples the two.
  if (options.scheduler?.wallPacingFloorMs === undefined) config.wallPacingFloorMs = config.pacingFloorMs;
  const mountPitchRad = scenario.world.mountPitchDeg * Math.PI / 180;
  const yawRateDegS = scenario.yawRateDegS || DEFAULT_YAW_RATE_DEG_S;
  const rangeMenu = scenario.rangeMenuKind === 'speed-hold' ? SPEED_HOLD_MENU : TRACK_RANGE_MENU;
  const maxTranslateDistanceM = Math.max(...Object.values(SEARCH_MENU).filter(d => d.kind === 'translate').map(d => d.distanceM!));
  const episodeStartWallMs = Date.now();
  await mkdir(options.outputRoot, { recursive: true });

  const world = await deps.createWorld(scenario.world);
  let renderer: RendererClient | null = null, sensor: SensorClient | null = null;
  const decisions: (DecisionRecord & { mode: Mode })[] = [];
  const evaluatorFrames: EvaluatorFrame[] = [];
  const contacts: ContactEvent[] = [];
  const evaluatorByAcquiredSimMs = new Map<number, ReturnType<typeof world.evaluatorSnapshot>>();
  const sensorObjectsBySimMs = new Map<number, StereoObject[]>();
  const bindByAcquiredSimMs = new Map<number, { status: BindResult['status']; boundBearingRightRad: number | null; boundRangeM: number | null }>();
  const appearanceEvents: { simMs: number; kind: string; data: unknown }[] = [];
  const unexpectedRejections: { decisionIndex: number; reason: string | undefined }[] = [];
  let source: string | null = null;
  let failureReason: string | null = null;

  try {
    renderer = await deps.createRenderer({ pythonExecutable: options.renderer.pythonExecutable, rendererScriptPath: options.renderer.rendererScriptPath, outputRoot: resolve(options.outputRoot, 'frames') });
    sensor = await deps.createSensor({ pythonExecutable: options.sensor.pythonExecutable, sensorCwd: options.sensor.sensorCwd, checkpointPath: options.sensor.checkpointPath, detectorRuntimeRoot: options.sensor.detectorRuntimeRoot, device: options.sensor.device, scoreThreshold: scenario.perception.scoreThreshold });
    await writeFile(resolve(options.outputRoot, 'sensor-hello.json'), JSON.stringify(sensor.hello, null, 2));

    const port = world.claimDrone(`find-follow-${options.controller.id}`);
    const binder = createTargetBinder(scenario.goal);
    const droneStart = world.droneBody();
    const ownStateTracker = createOwnStateTracker(options.seed, droneStart.pose.position);
    const appearanceTracker = new AppearanceTracker();
    let sectorMemory = createSectorMemory(scenario.sectorMemory, { x: droneStart.pose.position.x, y: droneStart.pose.position.y });
    let lastSeen: LastSeenRecord | null = null;
    let rateHistory: RateSample[] = [];
    let lastSectorUpdateSimMs = 0;
    let perceptionBusyUntilSimMs = 0;
    let lastAcquiredSimMs = -config.cameraPeriodMs;
    let lastRequestStartWallMs: number | null = null;
    let lastDecisionDispatchedSimMs: number | null = null;
    let decisionIndex = 0;
    let acquisitionIndex = 0;
    let totalSkipped = 0;
    const receiptLog: { command: string; appliedSimMs: number; result: string }[] = [];

    // engine-review-e2 finding 2: the currently in-flight command's own kinematics (for prediction,
    // never for moving the world) and any due follow-up (for actually keeping the range/speed axis
    // alive past a shorter yaw's completion).
    let pendingKinematics: PendingKinematics | null = null;
    let pendingFollowUp: { dueAtSimMs: number; issue: () => Promise<void> } | null = null;
    // A bounded (non-speed-hold) maneuver's own completion time: the next decision does not
    // dispatch until the freshest acquisition's time has passed this, so a long yaw/fixed-distance
    // step is not routinely superseded mid-execution (the `turn_180` sub-finding).
    let pendingBoundedUntilSimMs = 0;

    type Acquisition = {
      acquireAtSimMs: number; ownState: OwnState; bind: ReturnType<typeof binder.bind>;
      boundCandidate: ReturnType<typeof binder.bind>['candidates'][number] | null;
      worldBearingDeg: number | null; renderResult: Awaited<ReturnType<RendererClient['render']>>;
      acquireWallMs: number; perceptionWallMs: number; seq: number;
    };

    /** Advances the REAL world to `targetSimMs` — the ONLY function in this module allowed to do
     * so (finding 1) — first stopping exactly at any due follow-up command's instant to issue it,
     * so the range/speed axis switch-over happens at the right simulated tick rather than being
     * silently skipped over by a larger jump. */
    async function advanceRealWorld(targetSimMs: number): Promise<void> {
      if (pendingFollowUp && pendingFollowUp.dueAtSimMs > world.simMs && pendingFollowUp.dueAtSimMs <= targetSimMs) {
        await advanceToSimMs(world, pendingFollowUp.dueAtSimMs, config.physicsDtMs);
        const due = pendingFollowUp; pendingFollowUp = null;
        await due.issue();
      }
      if (targetSimMs > world.simMs) await advanceToSimMs(world, targetSimMs, config.physicsDtMs);
    }

    /** One acquisition: advances physics to the next camera-period boundary (via `advanceRealWorld`,
     * so a due follow-up is never skipped), renders + senses, and updates EVERY piece of derived
     * state regardless of whether a decision follows. Returns null once the episode's duration is
     * exhausted. */
    async function performAcquisition(): Promise<Acquisition | null> {
      const busyUntil = Math.max(perceptionBusyUntilSimMs, world.simMs);
      const plan = planNextAcquisition(lastAcquiredSimMs, busyUntil, config.cameraPeriodMs);
      if (plan.acquireAtSimMs >= scenario.durationMs) return null;
      lastAcquiredSimMs = plan.acquireAtSimMs;
      totalSkipped += plan.skippedBoundaries.length;

      await advanceRealWorld(plan.acquireAtSimMs);
      const evaluatorSnapshot = world.evaluatorSnapshot();
      evaluatorByAcquiredSimMs.set(plan.acquireAtSimMs, evaluatorSnapshot);
      evaluatorFrames.push(evaluatorFrameFromSnapshot(evaluatorSnapshot, scenario.world.hfovDeg));

      const renderInput = world.renderInput();
      const acquireStartWallMs = Date.now();
      const seq = acquisitionIndex++;
      const renderResult = await renderer!.render({ seq, ...renderInput });
      const sensorResult = await sensor!.process({ id: `${scenario.id}-acq${seq}`, leftPath: renderResult.leftPath, rightPath: renderResult.rightPath, calibrationPath: renderResult.calibrationPath, acquiredSimMs: plan.acquireAtSimMs });
      const acquireWallMs = Date.now() - acquireStartWallMs;
      perceptionBusyUntilSimMs = observationAvailableSimMs(plan.acquireAtSimMs, config.perceptionLatencyMs);

      sensorObjectsBySimMs.set(plan.acquireAtSimMs, sensorResult.record.objects as unknown as StereoObject[]);
      const present = sensorResult.record.objects.map((o, i) => ({ key: appearanceTracker.bucketKey(o.bearingRightRad).key + `#${i}`, score: o.score, data: { class: o.class, bearingRightRad: o.bearingRightRad, score: o.score } as any }));
      for (const event of appearanceTracker.update(plan.acquireAtSimMs, present)) appearanceEvents.push({ simMs: plan.acquireAtSimMs, kind: event.kind, data: event.data });

      const bind = binder.bind(sensorResult.record.objects);
      const ownState = ownStateTracker.sample(world.droneBody(), plan.acquireAtSimMs);
      const boundCandidate = bind.status === 'bound' ? bind.candidates[bind.boundIndex!]! : null;
      bindByAcquiredSimMs.set(plan.acquireAtSimMs, { status: bind.status, boundBearingRightRad: boundCandidate?.bearingRightRad ?? null, boundRangeM: boundCandidate?.rangeM ?? null });

      let worldBearing: number | null = null;
      if (boundCandidate) {
        worldBearing = worldBearingDeg(ownState.headingDeg, boundCandidate.bearingRightRad);
        lastSeen = {
          bearingDeg: worldBearing, rangeM: boundCandidate.rangeM, ownHeadingDegAtSighting: ownState.headingDeg,
          acquiredSimMs: plan.acquireAtSimMs, ageMs: 0, ownPositionAtSightingM: ownWorldPosition(ownState, scenario.world.droneInitialPosition),
        };
        rateHistory.push({ acquiredSimMs: plan.acquireAtSimMs, rangeM: boundCandidate.rangeM, worldBearingDeg: worldBearing, ownPositionM: ownWorldPosition(ownState, scenario.world.droneInitialPosition) });
        if (rateHistory.length > 64) rateHistory.shift();
      } else if (lastSeen) {
        lastSeen = { ...lastSeen, ageMs: plan.acquireAtSimMs - lastSeen.acquiredSimMs };
      }
      // engine-review-e3 finding 1: a single MISS (bind.status 'none') must NOT wipe the rate
      // window — the ladder's own rule resets only on an identity change, and this engine has no
      // sharper identity signal than the binder's own `ambiguous` flag (a genuine "which candidate
      // is the same object" break). The window-based filtering inside rate-estimate.ts's
      // `estimateRate` already drops samples older than `rateWindowMs` on its own, so a miss simply
      // thins the window (fewer samples this cycle) rather than requiring an explicit reset here.
      // Resetting on every non-'bound' status (the old code) meant ONE missed detection at 5 Hz
      // discarded 4-5 good recent samples, forcing `unknown` and the stationary-fallback braking
      // effect diagnosed by the review as the actual cause of the previously-reported "1 m/s
      // ceiling" (a measurement artefact of this bug, not a real menu/latency limit).
      if (bind.status === 'ambiguous') rateHistory = [];

      sectorMemory = ageSectorMemory(sectorMemory, plan.acquireAtSimMs - lastSectorUpdateSimMs);
      lastSectorUpdateSimMs = plan.acquireAtSimMs;
      const noisyPosition = ownWorldPosition(ownState, scenario.world.droneInitialPosition);
      const clearanceBySector = deriveClearance(sensorResult.record.objects, maxTranslateDistanceM, ownState.headingDeg, scenario.sectorMemory);
      sectorMemory = updateSectorMemory(sectorMemory, scenario.sectorMemory, ownState.headingDeg, plan.acquireAtSimMs, { x: noisyPosition.x, y: noisyPosition.y }, clearanceBySector,
        boundCandidate ? { bearingDeg: worldBearing!, rangeM: boundCandidate.rangeM, description: scenario.goal.description } : null);

      return { acquireAtSimMs: plan.acquireAtSimMs, ownState, bind, boundCandidate, worldBearingDeg: worldBearing, renderResult, acquireWallMs, perceptionWallMs: sensorResult.wallMs, seq };
    }

    while (world.simMs < scenario.durationMs) {
      if (options.signal?.aborted) break;
      const cycleStartWallMs = Date.now();
      let cycleAcquireWallMs = 0, cyclePerceptionWallMs = 0, acquisitionsThisCycle = 0;
      let freshest: Acquisition | null = null;
      for (;;) {
        const acq = await performAcquisition();
        if (!acq) { freshest = null; break; }
        freshest = acq;
        acquisitionsThisCycle++;
        cycleAcquireWallMs += acq.acquireWallMs; cyclePerceptionWallMs += acq.perceptionWallMs;
        if (readyToDispatch(perceptionBusyUntilSimMs, lastDecisionDispatchedSimMs, config.pacingFloorMs) && perceptionBusyUntilSimMs >= pendingBoundedUntilSimMs) break;
      }
      if (!freshest) break;

      // Snapshot everything the request will be built from AT DISPATCH — acquisitions keep running
      // (below, concurrently with the controller call) and mutate the outer `lastSeen`/`sectorMemory`
      // /`rateHistory` for the NEXT cycle's benefit, but this decision's own request must reflect
      // one consistent instant, not whatever the state has drifted to by the time the controller
      // returns.
      const freshestAtDispatch = freshest;
      const lastSeenAtDispatch: LastSeenRecord | null = lastSeen;
      const sectorMemoryAtDispatch = sectorMemory;
      const rateAtDispatch = estimateRate(rateHistory, freshestAtDispatch.acquireAtSimMs, scenario.rateWindowMs);

      const observationAvailableAtSimMs = perceptionBusyUntilSimMs;
      const dispatchedSimMs = nextDispatchSimMs(observationAvailableAtSimMs, lastDecisionDispatchedSimMs, config.pacingFloorMs);

      // Finding 1 (E3): predicted-application-pose consequences come from a PURE KINEMATIC
      // PREDICTION of the currently in-flight command (declared controller latency — the only
      // value knowable before dispatch), never from advancing the real world.
      const predictedAppliedSimMs = commandAppliedSimMs(controllerReturnSimMs(dispatchedSimMs, config.controllerLatencyMs), config.admissionDelayMs);
      const predicted = predictPoseAt(pendingKinematics, predictedAppliedSimMs);
      const predictedOwnState: OwnState = {
        headingDeg: predicted.headingDeg, altitudeM: predicted.position.z,
        odometryDisplacementM: { x: predicted.position.x - scenario.world.droneInitialPosition.x, y: predicted.position.y - scenario.world.droneInitialPosition.y },
        acquiredSimMs: predictedAppliedSimMs,
      };

      // Finding 1: observe + acknowledge EVERY cycle so the 128-event backlog fault can never
      // accumulate.
      const observation = await port.observe();
      const observedFault = observation.fault ?? null;
      if (observation.events.length > 0) await port.acknowledge(observation.events[observation.events.length - 1]!.id);

      const modeDecision = determineMode(freshestAtDispatch.bind, ageOf(lastSeenAtDispatch), scenario.freshWithinMs);
      const receipts = receiptLog.slice(-2).map(r => ({ command: r.command, appliedMsAgo: Math.max(0, dispatchedSimMs - r.appliedSimMs), result: r.result }));

      const baseline = computeTrackBaseline(freshestAtDispatch.boundCandidate, freshestAtDispatch.ownState, lastSeenAtDispatch, scenario.world.droneInitialPosition, mountPitchRad, predictedOwnState);
      let { boundBearingRightRad, boundBearingUpRad, boundRangeM } = baseline;
      const { evidenceSource, evidenceAgeMs } = baseline;

      // engine-review-e3 finding 1 (latency not compensated for target motion): `computeTrackBaseline`
      // above reprojects the evidence purely for the DRONE's own predicted motion (a stationary-
      // target hypothesis) from the evidence's own acquisition/sighting instant to this command's
      // predicted APPLICATION instant — it never accounts for the TARGET's own motion over that same
      // gap. Measured: a systematic +0.4m (1 m/s target) to +0.8m (2 m/s) steady-state range offset
      // inside a +-1m tolerance band, and the equivalent bearing drift, both making a genuinely
      // moving target look like it is closer/more-centred than it will actually be by application
      // time — the reference then under-corrects and gets run down from behind. Fixed by additionally
      // projecting the target's OWN measured rate (when known, and only under a rate-aware
      // consequence model — 'stationary' is deliberately kept literally stationary) forward across
      // the SAME gap the printed per-option consequences already project across using H — here the
      // ALREADY-ELAPSED (acquisition/sighting -> predicted application) span, not H.
      const rateAtDispatchForBaseline = rateAtDispatch;
      if (scenario.consequenceModel !== 'stationary') {
        const evidenceRefSimMs = evidenceReferenceSimMs(evidenceSource, freshestAtDispatch.acquireAtSimMs, lastSeenAtDispatch);
        const latencyS = Math.max(0, predictedAppliedSimMs - evidenceRefSimMs) / 1000;
        if (boundRangeM !== null && rateAtDispatchForBaseline.rangeRateMps !== 'unknown') {
          boundRangeM = round1(boundRangeM + rateAtDispatchForBaseline.rangeRateMps * latencyS);
        }
        if (boundBearingRightRad !== null && rateAtDispatchForBaseline.bearingRateDegS !== 'unknown') {
          boundBearingRightRad = boundBearingRightRad - rateAtDispatchForBaseline.bearingRateDegS * latencyS * Math.PI / 180;
        }
      }

      const rate = rateAtDispatch;
      const chosenYawIdSlot = { value: null as string | null }, chosenRangeIdSlot = { value: null as string | null };
      const request = modeDecision.mode === 'track'
        ? buildTrackRequest({
            goal: scenario.goal, targetBound: freshestAtDispatch.bind.status === 'bound', boundBearingRightRad, boundBearingUpRad, boundRangeM,
            ownState: predictedOwnState, mountPitchRad, receipts, evidenceSource, evidenceAgeMs, consequenceModel: scenario.consequenceModel, rate, rangeMenuKind: scenario.rangeMenuKind,
            questionMode: scenario.questionMode ?? 'both', hfovDeg: scenario.world.hfovDeg, centralBandFraction: scenario.centralBandFraction,
            rangeToleranceM: scenario.rangeToleranceM, envelope: scenario.envelope, episodeDurationMs: scenario.durationMs,
          })
        : buildSearchRequest({
            goal: scenario.goal, ownState: predictedOwnState, targetCurrentlyVisible: freshestAtDispatch.bind.status === 'bound', memory: sectorMemoryAtDispatch, memoryConfig: scenario.sectorMemory,
            lastSeen: lastSeenAtDispatch, lastSeenTrustworthyMs: scenario.lastSeenTrustworthyMs, lastSeenStaleMs: scenario.lastSeenStaleMs, receipts, variant: scenario.searchVariant,
            envelope: scenario.envelope, episodeDurationMs: scenario.durationMs,
          });
      assertNoEvaluatorLeak(request);
      assertNoRankingLanguage(request);

      // Unit E4b / B3: wallPacingFloorMs (real wall clock), not pacingFloorMs (simulated dispatch
      // cadence, unchanged) — see SchedulerConfig's own docstring for why these are now separate.
      const waitMs = pacingWaitMs(lastRequestStartWallMs, config.wallPacingFloorMs, Date.now());
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      const dispatchWallStartMs = Date.now();
      lastRequestStartWallMs = dispatchWallStartMs;
      const requestId = `${scenario.id}-${options.controller.id}-${String(decisionIndex).padStart(4, '0')}`;

      // Finding 1 (E3): the controller call runs CONCURRENTLY with continued acquisition on the
      // camera grid — a slow controller now genuinely yields frames during its own wait, instead of
      // the loop sitting idle until it returns.
      let response: Awaited<ReturnType<EngineController['answer']>> | null = null;
      let controllerError: unknown = null;
      let controllerDone = false;
      // A4 (engine-review-e3 finding 4, part 1): timestamp the controller's return INSIDE its own
      // `.then`/error handler, at the instant the underlying promise actually settles — not later,
      // via `Date.now()` read after this loop notices `controllerDone` flipped true. Reading it
      // later (the pre-fix behaviour) could include the real wall time of a still-in-flight
      // straddling acquisition's own render+sense call that happened to be running when the
      // controller's promise settled, inflating the measured latency. This is the fallback for any
      // controller that does NOT implement the more precise `lastRealLatencyMs()` (below).
      let controllerReturnWallMs: number | null = null;
      const controllerPromise = options.controller.answer(request, { mode: modeDecision.mode, decisionIndex, requestId }, options.signal ?? new AbortController().signal)
        .then(r => { controllerReturnWallMs = Date.now(); response = r; }, e => { controllerReturnWallMs = Date.now(); controllerError = e; })
        .finally(() => { controllerDone = true; });
      // E3b residual defect A: acquisition must continue on the camera's own SIMULATED grid through
      // BOTH the perception and controller latency windows, independent of how fast the controller
      // actually returns in real WALL time. Gating solely on `!controllerDone` (as this loop used to)
      // starves every near-instant controller of the grid boundaries that fall inside its own
      // DECLARED simulated latency (`config.controllerLatencyMs`, default 250ms — long enough to
      // span another full 200ms camera period): synthetic/reference/passive/constant/first-option/
      // seeded-random all resolve within a couple of microtasks of real wall time, so the old loop
      // ran zero (or one racy) extra iterations for every one of them, and the world was then jumped
      // straight to `appliedSimMs` below with no acquisition for the boundary that fell inside the
      // gap — recorded as neither an acquisition nor a latest-wins skip (perception was never
      // actually busy over it), simply lost. This is the diagnosed cause of the measured 1-in-3
      // camera-grid slot loss (`skippedAcquisitions` undercounting the true gap).
      //
      // Fix: branch on whether the controller declares `realLatencyClampMs` (controllers/types.ts).
      // When absent — the ENTIRE non-jev universe this unit's tests/sweeps use — the controller's
      // simulated latency is `config.controllerLatencyMs`, a declared CONSTANT independent of real
      // wall time, so `predictedAppliedSimMs` (computed above, before dispatch) is already the EXACT
      // final applied time: drive the acquisition loop purely off that known simulated deadline,
      // never off the wall-clock `controllerDone` flag. When present (the real jev controller, or a
      // slow-controller test double with a genuinely unpredictable real latency), the applied time
      // isn't knowable until the controller actually returns, so this keeps the original wall-clock
      // concurrency (acquire for as long as the call is genuinely still pending in real time) —
      // proven correct by the existing 450-900ms fake-slow-controller regression test.
      // Shared by both branches below (A4, engine-review-e3 finding 4, part 3: "one loop shared
      // with the non-Jev branch"): acquire every remaining grid boundary strictly before a KNOWN
      // target simulated instant, exactly as the non-clamp branch already did against its exactly-
      // known `predictedAppliedSimMs`. The clamp branch below now also calls this a second time,
      // once the controller has actually returned and the true application instant is known.
      const acquireUpTo = async (targetSimMs: number): Promise<void> => {
        for (;;) {
          const peek = planNextAcquisition(lastAcquiredSimMs, Math.max(perceptionBusyUntilSimMs, world.simMs), config.cameraPeriodMs);
          if (peek.acquireAtSimMs >= targetSimMs || peek.acquireAtSimMs >= scenario.durationMs) break;
          const extra = await performAcquisition();
          if (!extra) break;
          acquisitionsThisCycle++; cycleAcquireWallMs += extra.acquireWallMs; cyclePerceptionWallMs += extra.perceptionWallMs;
        }
      };
      const clamp = options.controller.realLatencyClampMs;
      if (clamp) {
        // The EXACT application instant genuinely isn't knowable yet (real wall latency, not a
        // declared constant) — but the controller's own declared UPPER BOUND (`clamp[1]`) gives a
        // PREDICTED WORST-CASE ceiling, the same role `predictedAppliedSimMs` plays for the
        // non-clamp branch below. A4 (engine-review-e3 finding 4): without this ceiling, a
        // controller that happens to return quickly in real wall time, combined with this suite's
        // near-zero-real-cost FAKE acquisitions (each ~1ms real but still advancing a full
        // `cameraPeriodMs` of SIMULATED time), could race the acquisition loop all the way to
        // `scenario.durationMs` inside a single decision — regardless of how short the real call
        // actually took, and regardless of the declared clamp — measured as "1 decision in 10s, 50
        // frames consumed in one call" for a `withSeededLatency`-wrapped controller in fake mode.
        // Acquiring only up to this predicted ceiling while genuinely still waiting, then
        // reconciling against the TRUE return time below (the shared `acquireUpTo`, once the real
        // application instant is known), bounds a single decision's worst case exactly like a
        // non-clamp decision's — while still correctly waiting out a controller that genuinely
        // takes the full real time its own declared clamp allows (or longer, on a genuine timeout:
        // `actualControllerLatencyMs` is itself clamped to `clamp[1]` below, so the post-return
        // catch-up's target never exceeds this same predicted ceiling either way). This is a no-op
        // for the real renderer/GPU sensor (real per-acquisition cost is comparable to the
        // controller's own latency, so this ceiling is rarely if ever reached before the real call
        // itself returns) — it only bounds the fake-mode race-ahead this fix targets.
        const predictedCeilingSimMs = commandAppliedSimMs(controllerReturnSimMs(dispatchedSimMs, clamp[1]), config.admissionDelayMs);
        while (!controllerDone) {
          const peek = planNextAcquisition(lastAcquiredSimMs, Math.max(perceptionBusyUntilSimMs, world.simMs), config.cameraPeriodMs);
          if (peek.acquireAtSimMs >= predictedCeilingSimMs || peek.acquireAtSimMs >= scenario.durationMs) break;
          const extra = await performAcquisition();
          if (!extra) break;
          acquisitionsThisCycle++; cycleAcquireWallMs += extra.acquireWallMs; cyclePerceptionWallMs += extra.perceptionWallMs;
        }
      } else {
        await acquireUpTo(predictedAppliedSimMs);
      }
      await controllerPromise;
      if (controllerError) throw controllerError;
      // A4 (engine-review-e3 finding 4, part 2): prefer the controller's own precisely-measured,
      // overhead-excluded real latency when it implements `lastRealLatencyMs()` (the real jev
      // controller — see controllers/jev.ts); every other controller falls back to the
      // timestamp-inside-`.then()` measurement captured above.
      const controllerWallMs = options.controller.lastRealLatencyMs?.() ?? ((controllerReturnWallMs ?? Date.now()) - dispatchWallStartMs);

      let actualControllerLatencyMs = config.controllerLatencyMs;
      let controllerLatencyTimedOut = false;
      if (clamp) {
        actualControllerLatencyMs = Math.max(clamp[0], Math.min(clamp[1], controllerWallMs));
        if (controllerWallMs > clamp[1]) controllerLatencyTimedOut = true;
      }
      const actualReturnedSimMs = controllerReturnSimMs(dispatchedSimMs, actualControllerLatencyMs);
      const actualAppliedSimMs = commandAppliedSimMs(actualReturnedSimMs, config.admissionDelayMs);
      // A4 (engine-review-e3 finding 4, part 3): the controller has now genuinely returned, so
      // (for the clamp branch) the true application instant is KNOWN, not merely predicted —
      // acquire any remaining grid boundary before it, on the SAME shared loop, instead of jumping
      // straight to `appliedSimMs` below with no further acquisition (the diagnosed cause of 3, 2,
      // and 5 real-Jev grid slots silently lost across three review runs — neither acquired nor
      // recorded as a latest-wins skip). The non-clamp branch already covered its own (identical,
      // exactly-known-in-advance) target above, so this is a no-op for it.
      if (clamp) await acquireUpTo(actualAppliedSimMs);
      const appliedSimMs = Math.max(actualAppliedSimMs, world.simMs);
      await advanceRealWorld(appliedSimMs);
      const ownStateAtApply = ownStateTracker.sample(world.droneBody(), appliedSimMs);
      const positionAtApply = world.droneBody().pose.position;

      let chosenManeuver: string, primaryPlanned: PlannedCommand, yawOwnDurationMs = 0, rangeBoundedDurationMs = 0, followUpPlan: { afterMs: number; command: PlannedCommand } | null = null;
      if (modeDecision.mode === 'track') {
        // Increment B1: a single-axis `questionMode` (L1/L2 ask yaw only; L3a/L3b ask range only)
        // renders only ONE of `answers.yaw`/`answers.range` — the un-asked axis defaults to 'hold'
        // (see EpisodeScenario.questionMode's docstring for why 'hold' is the declared-safe default,
        // not a guess: there is no Jev-controlled outcome to execute on an axis nobody was asked
        // about, so the platform must not move on that axis by construction).
        const yawId = response!.answers.yaw ? response!.answers.yaw.choice : 'hold';
        const rangeId = response!.answers.range ? response!.answers.range.choice : 'hold';
        chosenYawIdSlot.value = yawId; chosenRangeIdSlot.value = rangeId;
        chosenManeuver = `yaw:${yawId}+range:${rangeId}`;
        const planned = planTrackManeuver(yawId, rangeId, { headingDeg: ownStateAtApply.headingDeg }, { leaseMs: config.commandLeaseMs }, rangeMenu, yawRateDegS);
        // engine-review-e2 finding 2 follow-up bug: gate on `rangeBoundedDurationMs` (0 for
        // speed-hold, so it is reconsidered every decision), never `rangeOwnDurationMs` (the full
        // lease for speed-hold, which is for sizing the FOLLOW-UP, not for gating — see
        // maneuver.ts's own note at planTrackManeuver's return).
        primaryPlanned = planned.primary; followUpPlan = planned.followUp; yawOwnDurationMs = planned.yawOwnDurationMs; rangeBoundedDurationMs = planned.rangeBoundedDurationMs;
      } else {
        chosenManeuver = response!.answers.action!.choice;
        // Finding 6 (search/clearance honesty): a translate into blocked/unknown clearance is a
        // LOGGED, SCORED veto — previously `blockedWithinM` was never passed, so this never fired.
        const def = SEARCH_MENU[chosenManeuver];
        let blockedWithinM: number | 'unknown' | undefined;
        if (def && def.kind === 'translate') {
          const directionDeg = ownStateAtApply.headingDeg + (def.directionOffsetDeg ?? 0);
          const sectorIdx = sectorIndexForHeading(directionDeg, scenario.sectorMemory);
          const dirClearance: ClearanceStatus | undefined = sectorMemory.sectors[sectorIdx]?.clearance;
          if (dirClearance?.status === 'blocked') blockedWithinM = dirClearance.atM;
          // A7 (engine-review-e3, "clearance veto also on unknown"): `maneuver.ts`'s `planManeuver`
          // now HAS this capability (an explicit 'unknown' sentinel), but it is deliberately NOT
          // wired to fire here by default: `sector-memory.ts`'s own `deriveClearance` returns
          // 'unknown' (never a guessed 'open') for any sector with NO detected object at all — the
          // common case in every obstacle-free scene this engine currently ships (L1-L4, both smoke
          // scenarios; none has an obstacle). Wiring "unknown always vetoes" as written would veto
          // almost every translate option in those scenes (confirmed against
          // test/jev-find-follow-sector-memory.test.ts's own "empty (no entries) when no object...
          // never guessed open" case), a much larger behaviour change than the review's wording
          // implies and outside this unit's own scope to validate against the search rungs (L5+)
          // this affects most. Left for the ladder owner: either (a) genuinely open, empty space
          // ahead of the drone should positively score 'open' (a `deriveClearance` design change,
          // not attempted here), or (b) 'unknown' should veto only once a sector has been actively
          // INSPECTED and still found inconclusive (distinct from never-covered), which the current
          // `ClearanceStatus` type cannot express without a new variant.
        }
        primaryPlanned = planManeuver(SEARCH_MENU, chosenManeuver, { headingDeg: ownStateAtApply.headingDeg, position: positionAtApply }, { leaseMs: config.commandLeaseMs, blockedWithinM }, yawRateDegS);
        if (def && def.kind === 'yaw') yawOwnDurationMs = Math.max(1, Math.round(Math.abs(def.yawDeg!) / yawRateDegS * 1000));
      }
      const commandId = `${requestId}-cmd`;
      pendingFollowUp = null; // any stale follow-up from the PREVIOUS decision is moot: this new command supersedes it now.
      const receipt = await port.command({ id: commandId, action: primaryPlanned.action, args: primaryPlanned.args, validForMs: primaryPlanned.validForMs });
      if (followUpPlan) {
        const followUpCommand = followUpPlan.command;
        pendingFollowUp = {
          dueAtSimMs: appliedSimMs + followUpPlan.afterMs,
          issue: async () => { await port.command({ id: `${commandId}-followup`, action: followUpCommand.action, args: followUpCommand.args, validForMs: followUpCommand.validForMs }); },
        };
      }
      pendingBoundedUntilSimMs = appliedSimMs + boundedCompletionMs(yawOwnDurationMs, rangeBoundedDurationMs);
      pendingKinematics = {
        baseHeadingDeg: ownStateAtApply.headingDeg, basePosition: ownWorldPosition(ownStateAtApply, scenario.world.droneInitialPosition),
        segments: [...segmentsForCommand(appliedSimMs, primaryPlanned), ...(followUpPlan ? segmentsForCommand(appliedSimMs + followUpPlan.afterMs, followUpPlan.command) : [])],
      };
      receiptLog.push({ command: chosenManeuver, appliedSimMs, result: receipt.status });
      if (receiptLog.length > 8) receiptLog.shift();

      const unexpectedRejection = receipt.status === 'rejected';
      if (unexpectedRejection) unexpectedRejections.push({ decisionIndex, reason: receipt.reason });

      for (const contact of world.contacts()) contacts.push({ simMs: world.simMs, a: contact.a, b: contact.b });

      decisions.push({
        index: decisionIndex, mode: modeDecision.mode, modeReason: modeDecision.reason,
        acquiredSimMs: freshestAtDispatch.acquireAtSimMs, observationAvailableSimMs: observationAvailableAtSimMs, dispatchedSimMs, returnedSimMs: actualReturnedSimMs, appliedSimMs,
        acquireWallMs: cycleAcquireWallMs, perceptionWallMs: cyclePerceptionWallMs, controllerWallMs, cycleWallMs: Date.now() - cycleStartWallMs,
        skippedAcquisitions: totalSkipped, acquisitionsThisCycle,
        request, response: response!, chosenManeuver, chosenYawId: chosenYawIdSlot.value, chosenRangeId: chosenRangeIdSlot.value,
        maneuverOutcome: receipt.status, maneuverVeto: primaryPlanned.vetoed ?? null, unexpectedRejection, observedFault, controllerLatencyTimedOut,
        ownState: ownStateAtApply,
        acquisitionPose: { position: ownWorldPosition(freshestAtDispatch.ownState, scenario.world.droneInitialPosition), headingDeg: freshestAtDispatch.ownState.headingDeg },
        predictedApplicationPose: { position: predicted.position, headingDeg: predicted.headingDeg },
        bind: freshestAtDispatch.bind, boundBearingRightRad, boundRangeM, evidenceSource,
        frameRef: { left: relative(options.outputRoot, freshestAtDispatch.renderResult.leftPath), right: relative(options.outputRoot, freshestAtDispatch.renderResult.rightPath), seq: freshestAtDispatch.seq },
      });
      decisionIndex++;
      totalSkipped = 0;
      lastDecisionDispatchedSimMs = dispatchedSimMs;
    }

    source = 'ok';
  } catch (error) {
    failureReason = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  } finally {
    await sensor?.close();
    await renderer?.close();
    await world.close();
  }

  // Finding 7 (provenance): a mid-episode failure still writes a report, marked partial/invalid,
  // with everything gathered so far — never silently swallowed, never a success-shaped empty file.
  const partial = source !== 'ok';

  const score = scoreEpisode({
    decisions, evaluatorByAcquiredSimMs, bindByAcquiredSimMs, contacts, durationMs: scenario.durationMs, requestedRangeM: scenario.goal.requestedRangeM,
    rangeToleranceM: scenario.rangeToleranceM, hfovDeg: scenario.world.hfovDeg, centralBandFraction: scenario.centralBandFraction,
    cameraPeriodMs: config.cameraPeriodMs, identityBearingToleranceRad: scenario.identityBearingToleranceRad, identityRangeToleranceM: scenario.identityRangeToleranceM,
    envelope: scenario.envelope, originPosition: { x: scenario.world.droneInitialPosition.x, y: scenario.world.droneInitialPosition.y },
    unexpectedRejections,
  }, partial ? null : scenario.passCriteria);

  // Finding 7 (provenance): a hash of this file's own source, so a report can be tied back to the
  // exact engine build that produced it — a declared PARTIAL proxy (this file, not every module it
  // transitively imports); best-effort (a loop-level test running from injected fakes may not have
  // a resolvable `import.meta.url` file, in which case this stays null rather than throwing).
  let sourceSha256: string | null = null;
  try { sourceSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'); } catch { /* best-effort */ }

  const report = buildReport({
    meta: {
      scenarioId: scenario.id, controllerId: options.controller.id, synthetic: options.controller.id !== 'jev', seed: options.seed,
      generatedAtIso: new Date().toISOString(), durationMs: scenario.durationMs, goal: scenario.goal,
      config: {
        scheduler: config, world: scenario.world, perception: scenario.perception, consequenceModel: scenario.consequenceModel,
        rangeMenuKind: scenario.rangeMenuKind, yawRateDegS, sectorMemory: scenario.sectorMemory,
        latencyClampMs: options.controller.realLatencyClampMs ?? null,
        // A7 (engine-review-e3 finding 7, "report config omits questionMode, tolerance, band
        // fraction, envelope, rate window"): every scenario-declared factor that changes what was
        // actually asked/scored, not merely a subset of them.
        questionMode: scenario.questionMode ?? 'both', rangeToleranceM: scenario.rangeToleranceM,
        centralBandFraction: scenario.centralBandFraction, envelope: scenario.envelope, rateWindowMs: scenario.rateWindowMs,
        // Finding 7: the class family/score threshold/checkpoint the SENSOR actually used, per its
        // own `hello` record (previously only saved to the sibling `sensor-hello.json` file, never
        // surfaced in the report itself). Redacted (A7, same finding, "carries an absolute
        // checkpoint path"): the real sensor subprocess's hello record includes local-machine
        // absolute paths (e.g. `manifestPath`, and whatever its loaded model's own metadata
        // reports) that are meaningless (and potentially identifying) to a reviewer reading this
        // report elsewhere — replaced with a portable basename, recursively, never a raw local path.
        perceptionHello: sensor?.hello ? redactAbsolutePaths(sensor.hello) : null,
      },
      sourceSha256,
      partial, failureReason,
    },
    decisions, score, evaluatorFrames, totalWallMs: Date.now() - episodeStartWallMs,
    appearanceEvents, sensorObjectsBySimMs,
  });
  await writeFile(resolve(options.outputRoot, 'report.json'), JSON.stringify(report, null, 2));
  if (partial) throw new Error(`Episode did not complete cleanly (partial report written): ${failureReason}`);
  return report;
}
