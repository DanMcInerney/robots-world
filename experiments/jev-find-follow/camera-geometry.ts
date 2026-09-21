/** Pitch-aware camera-frame bearing reprojection. An independent design review flagged that the
 * repo's frozen `after-bearing` adapter (experiments/jev-spatial-refinement/live-adapter.ts:39)
 * refuses any non-zero camera pitch, and that at a fixed downward mount pitch, body-yaw azimuth
 * differs from image bearing by a few degrees for low, off-axis targets — exactly the case for
 * this engine's `track` encoder (fixed mount pitch, real stereo-object bearings). This module
 * reprojects the sensor's own reported (bearingRight, bearingUp) — azimuth/elevation in the
 * CURRENT camera frame, matching experiments/jev-library/geometry.py's `Geometry.bearing()`
 * convention exactly (`azimuthDeg=atan(nx)`, `elevationDeg=atan2(-ny,sqrt(1+nx^2))`) — through a
 * declared yaw-only rotation (mount pitch and roll held fixed, matching this rig: yaw changes body
 * heading, pitch is a fixed mount angle), under the SAME stationary/full-execution hypothesis
 * F57/F61 established. At zero pitch and zero elevation this reduces exactly to the simple
 * `resultingBearing = bearing + yawDeltaDeg` arithmetic those results validated; the general case
 * additionally corrects for the mount pitch coupling, verified by test/jev-find-follow-camera-geometry.test.ts.
 *
 * World-frame camera basis matches experiments/jev-round3/camera/renderer.py's `camera_matrix`
 * convention exactly (right = (sin(yaw), -cos(yaw), 0); forward = (cos(pitch)cos(yaw),
 * cos(pitch)sin(yaw), sin(pitch)); up = right x forward; roll fixed at 0 for this rig), so this
 * reprojection is consistent with how the renderer/sensor actually derive bearings from real
 * rendered images, not an independently invented convention.
 */

export interface CameraBearing { bearingRightRad: number; bearingUpRad: number }

interface Vec3 { x: number; y: number; z: number }
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function cameraBasis(yawRad: number, pitchRad: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward: Vec3 = { x: Math.cos(pitchRad) * Math.cos(yawRad), y: Math.cos(pitchRad) * Math.sin(yawRad), z: Math.sin(pitchRad) };
  const right: Vec3 = { x: Math.sin(yawRad), y: -Math.cos(yawRad), z: 0 };
  const up = cross(right, forward);
  return { right, up, forward };
}

/** Camera-local unit ray from (azimuth, elevation), matching geometry.py's decomposition:
 * azimuth rotates about the "up" axis from forward, elevation then rotates about the resulting
 * "right" axis. Inverse of `Geometry.bearing()`'s atan/atan2 pair. */
function rayFromBearing(bearing: CameraBearing): Vec3 {
  const forward = Math.cos(bearing.bearingUpRad) * Math.cos(bearing.bearingRightRad);
  const right = Math.cos(bearing.bearingUpRad) * Math.sin(bearing.bearingRightRad);
  const up = Math.sin(bearing.bearingUpRad);
  return { x: right, y: up, z: forward }; // {x:right-component, y:up-component, z:forward-component} in camera-local coords
}

function bearingFromRay(rayRight: number, rayUp: number, rayForward: number): CameraBearing {
  return { bearingRightRad: Math.atan2(rayRight, rayForward), bearingUpRad: Math.atan2(rayUp, Math.hypot(rayRight, rayForward)) };
}

function worldRayFrom(local: Vec3, basis: { right: Vec3; up: Vec3; forward: Vec3 }): Vec3 {
  return {
    x: local.x * basis.right.x + local.y * basis.up.x + local.z * basis.forward.x,
    y: local.x * basis.right.y + local.y * basis.up.y + local.z * basis.forward.y,
    z: local.x * basis.right.z + local.y * basis.up.z + local.z * basis.forward.z,
  };
}

/** Reprojects a currently-measured camera-frame bearing to what it would read after a yaw-only
 * change of `yawDeltaRad` (positive = left turn, matching this engine's ENU convention), holding
 * mount pitch fixed and assuming a stationary target and full execution (the same declared
 * hypothesis as every other per-option consequence in this engine). `currentYawRad` is the
 * platform's own heading at the CURRENT acquisition (own-state, never evaluator truth). */
export function reprojectBearingAfterYaw(current: CameraBearing, currentYawRad: number, mountPitchRad: number, yawDeltaRad: number): CameraBearing {
  const currentBasis = cameraBasis(currentYawRad, mountPitchRad);
  const worldRay = worldRayFrom(rayFromBearing(current), currentBasis);
  const newBasis = cameraBasis(currentYawRad + yawDeltaRad, mountPitchRad);
  return bearingFromRay(dot(worldRay, newBasis.right), dot(worldRay, newBasis.up), dot(worldRay, newBasis.forward));
}

export interface Vec3World { x: number; y: number; z: number }

/** Estimates a target's WORLD position from a measured camera-frame bearing + slant range, given
 * the camera's own world position/heading/fixed pitch at the moment of measurement. Used to carry
 * a single acquisition's measurement forward through a PREDICTED future own-pose (see
 * `bearingAndRangeFromWorldPosition`) — the general form of `reprojectBearingAfterYaw` that also
 * accounts for the platform's own PENDING TRANSLATION (an independent engine review's finding 2:
 * "pending in-flight yaw/translation included"), not yaw alone. Assumes the target is
 * instantaneously stationary between the two poses (the same declared hypothesis as every other
 * consequence in this engine) — legitimate for the short (sub-second) prediction gap this is used
 * for, not a claim about the target's real motion. */
export function worldPositionFromBearing(cameraWorldPosition: Vec3World, cameraYawRad: number, mountPitchRad: number, bearing: CameraBearing, rangeM: number): Vec3World {
  const basis = cameraBasis(cameraYawRad, mountPitchRad);
  const worldRay = worldRayFrom(rayFromBearing(bearing), basis);
  return { x: cameraWorldPosition.x + worldRay.x * rangeM, y: cameraWorldPosition.y + worldRay.y * rangeM, z: cameraWorldPosition.z + worldRay.z * rangeM };
}

/** Inverse of `worldPositionFromBearing`: the camera-frame bearing + slant range FROM a (possibly
 * different, e.g. predicted-future) camera pose TO a given world position. Composing
 * `worldPositionFromBearing` then this function is how this engine predicts what an earlier
 * measurement would read from a later, physically-advanced own-pose — reusing the SAME real Rapier
 * physics the world already ran (see episode.ts), not a separate kinematic model. */
export function bearingAndRangeFromWorldPosition(cameraWorldPosition: Vec3World, cameraYawRad: number, mountPitchRad: number, targetWorldPosition: Vec3World): { bearing: CameraBearing; rangeM: number } {
  const delta: Vec3 = { x: targetWorldPosition.x - cameraWorldPosition.x, y: targetWorldPosition.y - cameraWorldPosition.y, z: targetWorldPosition.z - cameraWorldPosition.z };
  const rangeM = Math.hypot(delta.x, delta.y, delta.z);
  if (rangeM < 1e-6) return { bearing: { bearingRightRad: 0, bearingUpRad: 0 }, rangeM: 0 };
  const basis = cameraBasis(cameraYawRad, mountPitchRad);
  const bearing = bearingFromRay(dot(delta, basis.right), dot(delta, basis.up), dot(delta, basis.forward));
  return { bearing, rangeM };
}

/** World-frame bearing (heading FROM the camera TO the target, ENU degrees in [0,360)) of a
 * camera-relative measurement — the fix for an independent review's finding 4: a camera-relative
 * `bearingRightRad` was previously stored and consumed as if it were an absolute world heading
 * (sector indexing, last-seen comparisons). `wrap(ownHeadingDeg - bearingRightDeg)` matches
 * evaluator.ts's own established convention (`trueBearingRightRad = -(worldAngle - heading)`, i.e.
 * `worldAngle = heading - bearingRight`), verified against it by test. */
export function worldBearingDeg(ownHeadingDeg: number, bearingRightRad: number): number {
  const wrapped = ((ownHeadingDeg - bearingRightRad * 180 / Math.PI) % 360 + 360) % 360;
  return wrapped;
}
/** Inverse: the camera-relative bearing (right positive) of a known world bearing, given own
 * current heading. */
export function cameraRelativeBearingRad(ownHeadingDeg: number, targetWorldBearingDeg: number): number {
  const diff = ((ownHeadingDeg - targetWorldBearingDeg + 540) % 360) - 180; // wrapped to (-180,180]
  return diff * Math.PI / 180;
}
