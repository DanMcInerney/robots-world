import type { BodySpec, Pose, Quat, Vec3 } from '../contracts.ts';
import { identity, multiply, norm, scale, vec } from '../math.ts';

export function finiteVector(value: Vec3, name: string): void {
  if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error(`${name} must be finite`);
}
export function validatePose(value: Pose): void {
  finiteVector(value.position, 'position');
  const { x, y, z, w } = value.rotation;
  if (![x, y, z, w].every(Number.isFinite) || Math.abs(Math.hypot(x, y, z, w) - 1) > 1e-4) throw new Error('rotation must be a unit quaternion');
}
export function validateBody(spec: BodySpec): void {
  if (!spec.id) throw new Error('body id is required');
  if (!['fixed','dynamic','kinematic'].includes(spec.mode)) throw new Error('unsupported body mode');
  if (!['box','sphere','capsule'].includes(spec.shape.kind)) throw new Error('unsupported shape');
  validatePose(spec.pose); finiteVector(spec.shape.size, 'shape size');
  if (Object.values(spec.shape.size).some(n => n <= 0)) throw new Error('shape dimensions must be positive');
  if (spec.shape.kind === 'sphere' && (spec.shape.size.x !== spec.shape.size.y || spec.shape.size.x !== spec.shape.size.z)) throw new Error('sphere dimensions must be equal diameters');
  if (spec.shape.kind === 'capsule' && (spec.shape.size.x !== spec.shape.size.y || spec.shape.size.z < spec.shape.size.x)) throw new Error('capsule requires equal x/y diameters and total z height at least its diameter');
  if (spec.mass !== undefined && (!Number.isFinite(spec.mass) || spec.mass <= 0)) throw new Error('mass must be positive');
  if (spec.friction !== undefined && (!Number.isFinite(spec.friction) || spec.friction < 0)) throw new Error('friction must be nonnegative');
}
export function inverse(q: Quat): Quat { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
export function angularStep(rotation: Quat, velocity: Vec3, dt: number): Quat {
  const speed = norm(velocity); if (speed === 0) return { ...rotation };
  const axis = scale(velocity, 1 / speed), angle = speed * dt / 2;
  return multiply({ x: axis.x * Math.sin(angle), y: axis.y * Math.sin(angle), z: axis.z * Math.sin(angle), w: Math.cos(angle) }, rotation);
}
export function axisAngle(axis: Vec3, angle: number): Quat {
  const length = norm(axis); if (!length) return identity();
  const s = Math.sin(angle / 2) / length;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}
export const zero = () => vec();
