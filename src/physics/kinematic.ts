import type { BodySpec, BodyState, JointSpec, PhysicsBackend, PhysicsFactory, Pose, RayHit, Vec3 } from '../contracts.ts';
import { add, norm, rotate, scale, sub, vec } from '../math.ts';
import { angularStep, finiteVector, inverse, validateBody, validatePose } from './shared.ts';

/** Deliberately non-dynamic reference backend: no gravity, forces, joints, or contacts. */
class KinematicBackend implements PhysicsBackend {
  readonly id = 'kinematic';
  readonly capabilities = ['bodies', 'velocity', 'kinematic', 'raycast', 'shape:box', 'shape:sphere'] as const;
  readonly gravity: Vec3;
  private entries = new Map<string, { spec: BodySpec; state: BodyState }>();
  private closed = false;
  constructor(gravity: Vec3) { finiteVector(gravity, 'gravity'); this.gravity = { ...gravity }; }
  private entry(id: string) {
    if (this.closed) throw new Error('physics backend closed');
    const value = this.entries.get(id); if (!value) throw new Error(`unknown body ${id}`); return value;
  }
  addBody(spec: BodySpec): void {
    if (this.closed) throw new Error('physics backend closed');
    validateBody(spec);
    if (spec.mode === 'dynamic') throw new Error('kinematic backend does not support dynamic bodies');
    if (spec.shape.kind === 'capsule') throw new Error('kinematic backend supports only box and sphere shapes');
    if (this.entries.has(spec.id)) throw new Error(`duplicate body ${spec.id}`);
    this.entries.set(spec.id, { spec: structuredClone(spec), state: { id: spec.id, pose: structuredClone(spec.pose), linearVelocity: vec(), angularVelocity: vec() } });
  }
  addJoint(_spec: JointSpec): never { throw new Error('kinematic backend does not support joints'); }
  body(id: string): BodyState { return structuredClone(this.entry(id).state); }
  bodies(): BodyState[] { return [...this.entries.keys()].map(id => this.body(id)); }
  force(_id: string, _force: Vec3): never { throw new Error('kinematic backend does not support forces'); }
  velocity(id: string, linear: Vec3, angular: Vec3 = vec()): void {
    finiteVector(linear, 'velocity'); finiteVector(angular, 'angular velocity');
    const entry = this.entry(id); if (entry.spec.mode === 'fixed') throw new Error('cannot drive a fixed body');
    entry.state.linearVelocity = { ...linear }; entry.state.angularVelocity = { ...angular };
  }
  move(id: string, pose: Pose): void { validatePose(pose); this.entry(id).state.pose = structuredClone(pose); }
  jointTarget(_id: string, _radians: number): never { throw new Error('kinematic backend does not support joint motors'); }
  jointPosition(_id: string): never { throw new Error('kinematic backend does not support joints'); }
  ray(origin: Vec3, direction: Vec3, maxDistance: number, exclude: readonly string[] = []): RayHit | null {
    finiteVector(origin, 'ray origin'); finiteVector(direction, 'ray direction');
    if (!(maxDistance >= 0) || !Number.isFinite(maxDistance) || norm(direction) === 0) throw new Error('invalid ray');
    const worldDirection = scale(direction, 1 / norm(direction)); let hit: RayHit | null = null;
    for (const { spec, state } of this.entries.values()) {
      if (exclude.includes(spec.id)) continue;
      const inv = inverse(state.pose.rotation), o = rotate(sub(origin, state.pose.position), inv), d = rotate(worldDirection, inv);
      let distance: number | null;
      if (spec.shape.kind === 'sphere') {
        const radius = spec.shape.size.x / 2, b = o.x*d.x+o.y*d.y+o.z*d.z, c = o.x*o.x+o.y*o.y+o.z*o.z-radius*radius;
        const disc = b*b-c; distance = c <= 0 ? 0 : disc < 0 || -b-Math.sqrt(disc) < 0 ? null : -b-Math.sqrt(disc);
      } else {
        let near = 0, far = maxDistance;
        for (const axis of ['x', 'y', 'z'] as const) {
          const half = spec.shape.size[axis] / 2;
          if (Math.abs(d[axis]) < 1e-12) { if (Math.abs(o[axis]) > half) far = -1; }
          else { const a = (-half-o[axis])/d[axis], b = (half-o[axis])/d[axis]; near = Math.max(near, Math.min(a,b)); far = Math.min(far, Math.max(a,b)); }
        }
        distance = near <= far ? near : null;
      }
      if (distance !== null && distance <= maxDistance && (!hit || distance < hit.distance)) hit = { body: spec.id, distance, point: add(origin, scale(worldDirection, distance)) };
    }
    return hit;
  }
  contacts(): [] { return []; }
  step(dt: number): void {
    if (this.closed) throw new Error('physics backend closed');
    if (!Number.isFinite(dt) || dt <= 0 || dt > .1) throw new Error('physics timestep must be in (0, .1] seconds');
    for (const { spec, state } of this.entries.values()) if (spec.mode === 'kinematic') {
      state.pose.position = add(state.pose.position, scale(state.linearVelocity, dt));
      state.pose.rotation = angularStep(state.pose.rotation, state.angularVelocity, dt);
    }
  }
  close(): void { this.entries.clear(); this.closed = true; }
}
export const kinematicFactory: PhysicsFactory = async ({ gravity }) => new KinematicBackend(gravity);
