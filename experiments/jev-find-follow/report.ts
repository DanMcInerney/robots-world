/** One self-contained report JSON per episode, and the schema the viewer page reads. Synthetic /
 * reference runs are unmistakably labelled (`controller.synthetic: true` at the top level and on
 * every decision's `response.synthetic`).
 *
 * The evaluator section (`evaluatorOnly`) is clearly labelled as NOT shown to the controller — it
 * exists for scoring and for the replay's top-down map only. Every decision's `request`/`response`
 * is the exact text the controller received/returned; nothing in that object is ever backfilled
 * from `evaluatorOnly`.
 */
import type { DecisionRecord, Goal, Mode, StereoObject } from './types.ts';
import type { EvaluatorSnapshot } from './evaluator.ts';
import type { EpisodeScore } from './scoring.ts';

export interface ReportMeta {
  schema: 'jev-find-follow-report/1';
  scenarioId: string;
  controllerId: string;
  synthetic: boolean;
  seed: number;
  generatedAtIso: string;
  durationMs: number;
  goal: Goal;
  config: Record<string, unknown>;
  /** engine-review-e2 finding 7 (provenance): a hash of `episode.ts`'s own source, the main
   * orchestrator — a declared, PARTIAL proxy for "the engine that produced this report" (it does
   * not cover every module the episode transitively imports); `null` when unavailable (e.g. a
   * loop-level test using injected fakes has no reason to read the file). */
  sourceSha256: string | null;
  /** engine-review-e2 finding 7: true when the episode did not complete cleanly — the report is
   * still written (never a success-shaped empty file) but must not be treated as a real result. */
  partial: boolean;
  failureReason: string | null;
}

export interface EvaluatorFrame {
  acquiredSimMs: number;
  cameraPosition: { x: number; y: number; z: number };
  cameraHeadingDeg: number;
  cameraHfovDeg: number;
  target: { id: string; position: { x: number; y: number; z: number }; yawDeg: number; halfExtents: { x: number; y: number; z: number } };
  lookalikes: { id: string; position: { x: number; y: number; z: number }; yawDeg: number }[];
  trueNearestSurfaceRangeM: number;
  trueBearingRightRad: number;
  targetWithinFov: boolean;
}

export interface EpisodeReport {
  meta: ReportMeta;
  decisions: (DecisionRecord & { mode: Mode })[];
  score: EpisodeScore;
  evaluatorOnly: { label: 'NOT shown to the controller — evaluator/scoring truth only'; frames: EvaluatorFrame[] };
  wallTimeBudget: { totalWallMs: number; simulatedDurationMs: number; wallMsPerSimulatedSecond: number; wallMsPerDecision: number };
  /** engine-review-e1 finding 1: appearance events (integrations/stereo-objects.ts's
   * AppearanceTracker) fired across every acquisition this episode, not only decision-cadence ones. */
  appearanceEvents: { simMs: number; kind: string; data: unknown }[];
  /** engine-review-e1 finding 7: the sensor's own reported objects for EVERY delivered
   * observation (every acquisition, not only decisions), keyed by acquisition simulated time —
   * lets a reviewer separate a perception failure from a binder/scoring failure without a GPU
   * re-run. */
  sensorObjectsByAcquiredSimMs: Record<string, StereoObject[]>;
}

function quatToYawDeg(rotation: { x: number; y: number; z: number; w: number }): number {
  const q = rotation;
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180 / Math.PI;
}

export function evaluatorFrameFromSnapshot(snapshot: EvaluatorSnapshot, cameraHfovDeg: number): EvaluatorFrame {
  return {
    acquiredSimMs: snapshot.acquiredSimMs, cameraPosition: snapshot.cameraPosition, cameraHeadingDeg: snapshot.cameraHeadingDeg, cameraHfovDeg,
    target: { id: snapshot.target.id, position: snapshot.target.pose.position, yawDeg: quatToYawDeg(snapshot.target.pose.rotation), halfExtents: snapshot.target.halfExtents },
    lookalikes: snapshot.lookalikes.map(l => ({ id: l.id, position: l.pose.position, yawDeg: quatToYawDeg(l.pose.rotation) })),
    trueNearestSurfaceRangeM: snapshot.trueNearestSurfaceRangeM, trueBearingRightRad: snapshot.trueBearingRightRad, targetWithinFov: snapshot.targetWithinFov,
  };
}

export function buildReport(options: {
  meta: Omit<ReportMeta, 'schema'>;
  decisions: (DecisionRecord & { mode: Mode })[];
  score: EpisodeScore;
  evaluatorFrames: EvaluatorFrame[];
  totalWallMs: number;
  appearanceEvents?: { simMs: number; kind: string; data: unknown }[];
  sensorObjectsBySimMs?: ReadonlyMap<number, StereoObject[]>;
}): EpisodeReport {
  const { meta, decisions, score, evaluatorFrames, totalWallMs } = options;
  const wallMsPerSimulatedSecond = meta.durationMs > 0 ? totalWallMs / (meta.durationMs / 1000) : 0;
  return {
    meta: { schema: 'jev-find-follow-report/1', ...meta },
    decisions, score,
    evaluatorOnly: { label: 'NOT shown to the controller — evaluator/scoring truth only', frames: evaluatorFrames },
    wallTimeBudget: { totalWallMs, simulatedDurationMs: meta.durationMs, wallMsPerSimulatedSecond, wallMsPerDecision: decisions.length ? totalWallMs / decisions.length : 0 },
    appearanceEvents: options.appearanceEvents ?? [],
    sensorObjectsByAcquiredSimMs: Object.fromEntries([...(options.sensorObjectsBySimMs ?? new Map())].map(([simMs, objects]) => [String(simMs), objects])),
  };
}
