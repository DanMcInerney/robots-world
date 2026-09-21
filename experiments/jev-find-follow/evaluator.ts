/** Evaluator-only truth. Scoring and the report/replay viewer may read this; perception (the
 * sensor client) and every controller/encoder must never import this module or see its values.
 *
 * PRINCIPLES.md #10 permits a sensor simulator to read truth to synthesize a physical measurement
 * (the renderer legitimately needs true camera/target/obstacle poses to render pixels — that is
 * not this boundary). What this module guards is the SECOND hop: nothing derived from these exact
 * poses/ranges may reach an encoder request or a controller. `checks.ts` enforces this
 * structurally (a source scan: encoders/controllers never import this file) and mechanically (a
 * scan of every dispatched request for evaluator-shaped field names), matching F76's stdout-purity
 * check and jev-scout-encodings/checks.ts's `assertNoOracleLeak`.
 *
 * True range here is computed analytically from the Rapier physics state (exact camera position,
 * exact target/lookalike oriented box) rather than by decoding the renderer's saved depth/mask
 * files. This is a deliberate trade-off (see FAILURES.md): Rapier already gives exact body poses
 * and the target's known box dimensions (experiments/jev-round3/world.ts's
 * `TARGET_CAR_DIMENSIONS`), so a ray-box intersection along the camera's own sightline is exact
 * analytic geometry, not an approximation of the renderer's own depth buffer — but it is still a
 * different computation than "the renderer's evaluator median visible surface range" the
 * assignment names (no bespoke .npy/PNG mask parser), and can disagree with it when the visible
 * surface is partially occluded by a third body this ray-box model does not account for. Declared
 * explicitly, not silently substituted.
 *
 * engine-review-e2 finding 4 ("the evaluator range is not the sensor's range definition"): this
 * previously returned the NEAREST 3D POINT on the box to the camera, which is not necessarily a
 * point the camera can actually SEE (e.g. a point on the box's near-bottom edge directly below an
 * elevated camera, when the camera is actually looking at — and the sensor's mask-median is
 * measuring — the car's front/side face). Fixed to a ray-box (slab method) intersection along the
 * camera's actual sightline to the target's centre, i.e. "where does the line of sight first cross
 * the box's surface" — the same VISIBLE-SURFACE-ALONG-THE-VIEW-DIRECTION concept the sensor's
 * mask-median range is estimating, not merely the closest point in space. The measured residual
 * bias between this and the sensor's own delivered range is reported per run (`score.truth.*` vs
 * the sensor-delivered `rangeErrorM`; see scoring.ts and the E3 return report).
 */
import type { Pose, Vec3 } from '../../src/contracts.ts';
import { add, sub, norm, scale } from '../../src/math.ts';

const crossVec = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dotVec = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const normalizeVec = (v: Vec3): Vec3 => { const n = norm(v); return n < 1e-12 ? { x: 0, y: 0, z: 0 } : scale(v, 1 / n); };

export interface TrueBodyState { id: string; kind: 'target' | 'lookalike' | 'obstacle'; pose: Pose; halfExtents: Vec3 }

/** One evaluator-only snapshot, captured at an acquisition's simulated time. */
export interface EvaluatorSnapshot {
  acquiredSimMs: number;
  cameraPosition: Vec3;
  cameraHeadingDeg: number;
  target: TrueBodyState;
  lookalikes: TrueBodyState[];
  /** Nearest-surface distance from the camera to the target's oriented box, analytic geometry
   * (see module docstring) — the evaluator range this engine's scoring uses. */
  trueNearestSurfaceRangeM: number;
  /** True bearing (radians, positive right) from camera to target centre, ENU/body convention
   * matching the sensor's own bearingRightRad — used only by scoring (e.g. bind correctness),
   * never rendered into a controller request. */
  trueBearingRightRad: number;
  /** Whether the target's centre falls within the camera's declared HFOV (a coarse "should be
   * detectable" evaluator fact; the actual detector may still miss it, and this does not model
   * occlusion by obstacles/lookalikes). */
  targetWithinFov: boolean;
}

function quatToYawDeg(q: Pose['rotation']): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180 / Math.PI;
}

/** Distance from `from` to the point where a ray in direction `dirWorld` (unit vector, world frame)
 * first crosses `box`'s surface, via the box-local slab method (box-frame local axes from yaw only
 * — cars/lookalikes are planar per renderer.py's own constraint: "cars are planar; nonzero car
 * pitch/roll unsupported"). Returns `null` when that ray does not hit the box's forward surface at
 * all (parallel-and-outside a slab, or the box is entirely behind the ray's origin along it) —
 * callers decide their own fallback, never silently substituting a different distance here. */
function rayFirstHitDistanceToBox(from: Vec3, dirWorld: Vec3, box: TrueBodyState): number | null {
  const yaw = quatToYawDeg(box.pose.rotation) * Math.PI / 180;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const toWorldLocal = (v: Vec3) => ({ x: v.x * cos + v.y * sin, y: -v.x * sin + v.y * cos, z: v.z });
  const rel = sub(from, box.pose.position);
  const originLocal = toWorldLocal(rel);
  const dirLocal = toWorldLocal(dirWorld);
  const half = box.halfExtents;
  let tNear = -Infinity, tFar = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = originLocal[axis], d = dirLocal[axis], h = half[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < -h || o > h) return null; // parallel & outside this slab: no intersection
      continue;
    }
    let t1 = (-h - o) / d, t2 = (h - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tNear = Math.max(tNear, t1); tFar = Math.min(tFar, t2);
  }
  if (tNear > tFar || tFar < 0) return null; // no forward intersection
  return Math.max(0, tNear);
}

/** Distance from `from` to the point where the ray from `from` TOWARD the box's own centre first
 * crosses the box's surface — i.e. the near-surface range along a single central line of sight.
 * Falls back to the nearest-point-in-space distance in the (should-not-happen-here) case that
 * single ray does not intersect the box at all — declared, not silently substituted. Kept as the
 * cheap single-ray building block / fallback for `sightlineSurfaceRangeToBox` below; most callers
 * want that function, not this one directly. */
function centreRaySurfaceRangeToBox(from: Vec3, box: TrueBodyState): number {
  const toCentre = sub(box.pose.position, from);
  const toCentreLen = norm(toCentre);
  if (toCentreLen < 1e-9) return 0; // camera at the box's own centre (degenerate; never happens here)
  const hit = rayFirstHitDistanceToBox(from, scale(toCentre, 1 / toCentreLen), box);
  return hit ?? norm(sub(from, box.pose.position));
}

/** engine-review-e3 finding 6 ("evaluator range differs from the sensor's definition by aspect and
 * rig"): a SINGLE central ray systematically under- or over-estimates a real stereo/mask-median
 * sensor's range depending on viewing aspect (rear/side/front/oblique) — the reviewer's static
 * probe measured a sensor-minus-truth bias against the single-ray definition ranging +0.31m (rear)
 * to +0.71m (oblique) at one rig, +0.53 to +1.00m at another, EXCEEDING L3a's own tolerance at the
 * higher rig's rear view. Fix (as the review names it): the evaluator range becomes the MEDIAN of
 * first-hit ranges over a small ray grid spanning the box's own ANGULAR extent as seen from `from`
 * (a pinhole/tangent-plane projection of its 8 corners onto a camera-local right/up basis around
 * the centre direction) — approximating a real depth sensor's mask-median measurement (many rays
 * across the visible silhouette), not just the one ray toward the geometric centre. Declared
 * approximation (not silently substituted): this is NOT occlusion-aware (a nearer third body is not
 * accounted for; every grid ray is tested only against `box` itself) and samples the box's full
 * angular bounding box (not a precise per-pixel mask shape) — a materially closer approximation to
 * a real sensor's behaviour than a single ray, but still not a full renderer/depth-buffer replica
 * (see the module's own top docstring on this general trade-off). Falls back to the single
 * centre-ray distance if, degenerately, no grid ray hits the box at all. */
function silhouetteMedianRangeToBox(from: Vec3, box: TrueBodyState, gridSize = 5): number {
  const toCentre = sub(box.pose.position, from);
  const toCentreLen = norm(toCentre);
  if (toCentreLen < 1e-9) return 0;
  const centreDir = scale(toCentre, 1 / toCentreLen);
  // Camera-local (right, up) basis, orthonormal, perpendicular to centreDir. World "up" (0,0,1) as
  // the reference; degenerates only for a straight-up/down sightline, which this ladder's camera
  // geometry (bounded pitch, ground-level targets) never produces.
  let right = normalizeVec(crossVec(centreDir, { x: 0, y: 0, z: 1 }));
  if (norm(right) < 1e-6) right = { x: 0, y: 1, z: 0 };
  const up = crossVec(right, centreDir); // unit: cross of two orthonormal unit vectors

  // Project the box's 8 corners onto this basis (tangent-plane / pinhole angles around centreDir)
  // to find the box's own angular bounding box — the silhouette's angular EXTENT, not its precise
  // per-pixel shape (declared approximation, see docstring above).
  const yaw = quatToYawDeg(box.pose.rotation) * Math.PI / 180;
  const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
  const half = box.halfExtents;
  let minRight = Infinity, maxRight = -Infinity, minUp = Infinity, maxUp = -Infinity;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const localOffset = { x: sx * half.x, y: sy * half.y, z: sz * half.z };
    const worldOffset = { x: localOffset.x * cosYaw - localOffset.y * sinYaw, y: localOffset.x * sinYaw + localOffset.y * cosYaw, z: localOffset.z };
    const cornerDir = normalizeVec(sub(add(box.pose.position, worldOffset), from));
    const compCentre = dotVec(cornerDir, centreDir);
    if (compCentre <= 1e-9) continue; // behind the camera relative to the centre direction: skip (should not occur for this ladder's geometry)
    const angleRight = Math.atan2(dotVec(cornerDir, right), compCentre);
    const angleUp = Math.atan2(dotVec(cornerDir, up), compCentre);
    minRight = Math.min(minRight, angleRight); maxRight = Math.max(maxRight, angleRight);
    minUp = Math.min(minUp, angleUp); maxUp = Math.max(maxUp, angleUp);
  }
  if (!Number.isFinite(minRight) || !Number.isFinite(minUp)) return centreRaySurfaceRangeToBox(from, box); // degenerate: fall back

  const hits: number[] = [];
  for (let i = 0; i < gridSize; i++) {
    const fr = gridSize === 1 ? 0.5 : i / (gridSize - 1);
    const angleRight = minRight + fr * (maxRight - minRight);
    for (let j = 0; j < gridSize; j++) {
      const fu = gridSize === 1 ? 0.5 : j / (gridSize - 1);
      const angleUp = minUp + fu * (maxUp - minUp);
      const dir = normalizeVec(add(centreDir, add(scale(right, Math.tan(angleRight)), scale(up, Math.tan(angleUp)))));
      const hit = rayFirstHitDistanceToBox(from, dir, box);
      if (hit !== null) hits.push(hit);
    }
  }
  if (hits.length === 0) return centreRaySurfaceRangeToBox(from, box); // degenerate: fall back
  hits.sort((a, b) => a - b);
  const mid = Math.floor(hits.length / 2);
  return hits.length % 2 ? hits[mid]! : (hits[mid - 1]! + hits[mid]!) / 2;
}

/** Exported (E3b, redefined by A5/engine-review-e3 finding 6): sweep.ts's synthetic
 * reference-ceiling sensor model needs the EXACT same evaluator-range definition this module uses
 * for truth, so a fake sensor's "true range" (before it adds declared bias/noise) never silently
 * drifts from what scoring.ts later measures against — PRINCIPLES.md #10 permits a sensor SIMULATOR
 * to read truth to synthesize a physical measurement (this is that case, not the encoder/controller
 * boundary checks.ts guards). Now the silhouette-grid MEDIAN (see `silhouetteMedianRangeToBox`
 * above), not a single central ray — the name and signature are unchanged so every existing caller
 * (this module's own `buildEvaluatorSnapshot`, and sweep.ts) gets the improved definition with zero
 * risk of the two drifting apart. */
export function sightlineSurfaceRangeToBox(from: Vec3, box: TrueBodyState): number {
  return silhouetteMedianRangeToBox(from, box);
}

const wrapDeg = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;

export function buildEvaluatorSnapshot(options: {
  acquiredSimMs: number; cameraPosition: Vec3; cameraHeadingDeg: number; hfovDeg: number;
  target: TrueBodyState; lookalikes: TrueBodyState[];
}): EvaluatorSnapshot {
  const { acquiredSimMs, cameraPosition, cameraHeadingDeg, hfovDeg, target, lookalikes } = options;
  const trueNearestSurfaceRangeM = sightlineSurfaceRangeToBox(cameraPosition, target);
  const toTarget = sub(target.pose.position, cameraPosition);
  const bearingWorldDeg = Math.atan2(toTarget.y, toTarget.x) * 180 / Math.PI;
  // Camera-relative bearing, positive right; camera yaw 0 looks east per world.ts's ENU convention.
  const trueBearingRightRad = -wrapDeg(bearingWorldDeg - cameraHeadingDeg) * Math.PI / 180;
  const targetWithinFov = Math.abs(wrapDeg(bearingWorldDeg - cameraHeadingDeg)) <= hfovDeg / 2;
  return { acquiredSimMs, cameraPosition, cameraHeadingDeg, target, lookalikes, trueNearestSurfaceRangeM, trueBearingRightRad, targetWithinFov };
}
// engine-review-e1 finding 9: this module previously also exported an `EvaluatorSink` bounded-
// history class. Nothing in the engine ever instantiated it — episode.ts has always kept its own
// plain `Map<number, EvaluatorSnapshot>` (evaluatorByAcquiredSimMs) instead — so it was confirmed
// dead code (grep across the repo found only its own dedicated test) and has been removed, along
// with that test.
