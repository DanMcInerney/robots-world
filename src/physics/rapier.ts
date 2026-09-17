import RAPIER from '@dimforge/rapier3d-compat';
import type { BodySpec, BodyState, Contact, JointSpec, PhysicsBackend, PhysicsFactory, Pose, RayHit, Vec3 } from '../contracts.ts';
import { add, identity, multiply, norm, rotate, scale, vec } from '../math.ts';
import { angularStep, finiteVector, inverse, validateBody, validatePose } from './shared.ts';

let initialized: Promise<void> | undefined;
class RapierBackend implements PhysicsBackend {
  readonly id = 'rapier';
  readonly capabilities = ['bodies', 'rigid-body', 'forces', 'velocity', 'kinematic', 'raycast', 'contacts', 'joints', 'joint-motors', 'shape:box', 'shape:sphere', 'shape:capsule'] as const;
  readonly gravity: Vec3;
  private world: RAPIER.World;
  private entries = new Map<string, { body: RAPIER.RigidBody; collider: RAPIER.Collider; spec: BodySpec; kinematicVelocity: Vec3; kinematicAngular: Vec3 }>();
  private colliderIds = new Map<number,string>();
  private joints = new Map<string, { joint: RAPIER.ImpulseJoint; spec: JointSpec }>();
  private closed = false;
  constructor(gravity: Vec3) { finiteVector(gravity, 'gravity'); this.gravity = { ...gravity }; this.world = new RAPIER.World(gravity); this.world.numSolverIterations = 12; }
  private entry(id: string) { if (this.closed) throw new Error('physics backend closed'); const value = this.entries.get(id); if (!value) throw new Error(`unknown body ${id}`); return value; }
  addBody(spec: BodySpec): void {
    if (this.closed) throw new Error('physics backend closed'); validateBody(spec);
    if (this.entries.has(spec.id)) throw new Error(`duplicate body ${spec.id}`);
    const d = spec.mode === 'dynamic' ? RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true) : spec.mode === 'fixed' ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    d.setTranslation(spec.pose.position.x, spec.pose.position.y, spec.pose.position.z).setRotation(spec.pose.rotation);
    const body = this.world.createRigidBody(d), s = spec.shape.size;
    const shape = spec.shape.kind === 'box' ? RAPIER.ColliderDesc.cuboid(s.x/2,s.y/2,s.z/2) : spec.shape.kind === 'sphere' ? RAPIER.ColliderDesc.ball(s.x/2) : RAPIER.ColliderDesc.capsule(Math.max(0,s.z/2-s.x/2),s.x/2).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
    shape.setMass(spec.mass ?? 1).setFriction(spec.friction ?? .5).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    const collider = this.world.createCollider(shape, body);
    this.colliderIds.set(collider.handle,spec.id);
    this.entries.set(spec.id, { body, collider, spec: structuredClone(spec), kinematicVelocity: vec(), kinematicAngular: vec() });
  }
  addJoint(spec: JointSpec): void {
    if (this.joints.has(spec.id)) throw new Error(`duplicate joint ${spec.id}`);
    const parent = this.entry(spec.parent).body, child = this.entry(spec.child).body;
    finiteVector(spec.axis, 'joint axis'); if (norm(spec.axis) < 1e-8) throw new Error('joint axis cannot be zero');
    finiteVector(spec.anchorParent, 'parent anchor'); finiteVector(spec.anchorChild, 'child anchor');
    if (spec.limits && (!spec.limits.every(Number.isFinite) || spec.limits[0] > spec.limits[1])) throw new Error('invalid joint limits');
    const axis = scale(spec.axis,1/norm(spec.axis));
    const data = spec.kind === 'fixed' ? RAPIER.JointData.fixed(spec.anchorParent,multiply(inverse(parent.rotation()),child.rotation()),spec.anchorChild,identity()) : RAPIER.JointData.revoluteWithAxes(spec.anchorParent,spec.anchorChild,axis,rotate(rotate(axis,parent.rotation()),inverse(child.rotation())));
    const joint = this.world.createImpulseJoint(data, parent, child, true); joint.setContactsEnabled(false);
    const normalized = { ...structuredClone(spec), axis };
    this.joints.set(spec.id, { joint, spec: normalized });
    if (joint instanceof RAPIER.RevoluteImpulseJoint) {
      // Preserve the authored relative rest rotation as motor position zero.
      joint.setFrameX2(multiply(inverse(child.rotation()),multiply(parent.rotation(),joint.frameX1())));
      if (spec.limits) joint.setLimits(...spec.limits);
      joint.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
      joint.setMotorMaxForce(200); joint.configureMotorPosition(0, 4000, 126);
    }
  }
  body(id: string): BodyState { const body = this.entry(id).body; return { id, pose: { position: { ...body.translation() }, rotation: { ...body.rotation() } }, linearVelocity: { ...body.linvel() }, angularVelocity: { ...body.angvel() } }; }
  bodies(): BodyState[] { return [...this.entries.keys()].map(id => this.body(id)); }
  /** Replaces next-step force. Forces are cleared after stepping, never latched indefinitely. */
  force(id: string, force: Vec3): void { finiteVector(force, 'force'); const { body, spec } = this.entry(id); if (spec.mode !== 'dynamic') throw new Error('forces require a dynamic body'); body.resetForces(true); body.addForce(force, true); }
  velocity(id: string, linear: Vec3, angular: Vec3 = vec()): void {
    finiteVector(linear, 'velocity'); finiteVector(angular, 'angular velocity'); const entry = this.entry(id);
    if (entry.spec.mode === 'fixed') throw new Error('cannot drive a fixed body');
    if (entry.spec.mode === 'kinematic') { entry.kinematicVelocity = { ...linear }; entry.kinematicAngular = { ...angular }; }
    else { entry.body.setLinvel(linear, true); entry.body.setAngvel(angular, true); }
  }
  /** Administrative reposition, not a controller motion command. Applied immediately on both backends. */
  move(id: string, pose: Pose): void { validatePose(pose); const entry = this.entry(id); entry.body.setTranslation(pose.position,true); entry.body.setRotation(pose.rotation,true); if (entry.spec.mode === 'kinematic') { entry.body.setNextKinematicTranslation(pose.position); entry.body.setNextKinematicRotation(pose.rotation); } }
  jointTarget(id: string, radians: number): void {
    const entry = this.joints.get(id); if (!entry) throw new Error(`unknown joint ${id}`);
    if (!(entry.joint instanceof RAPIER.RevoluteImpulseJoint)) throw new Error('fixed joint has no target');
    if (!Number.isFinite(radians) || entry.spec.limits && (radians < entry.spec.limits[0] || radians > entry.spec.limits[1])) throw new Error(`joint ${id} target outside limits`);
    entry.joint.configureMotorPosition(radians, 4000, 126);
  }
  jointPosition(id: string): number {
    const entry = this.joints.get(id); if (!entry) throw new Error(`unknown joint ${id}`); if (entry.spec.kind === 'fixed') return 0;
    const parent = multiply(this.entry(entry.spec.parent).body.rotation(),entry.joint.frameX1());
    const child = multiply(this.entry(entry.spec.child).body.rotation(),entry.joint.frameX2());
    const relative = multiply(inverse(parent),child), angle = 2*Math.atan2(relative.x,relative.w);
    return Math.atan2(Math.sin(angle),Math.cos(angle));
  }
  ray(origin: Vec3, direction: Vec3, maxDistance: number, exclude: readonly string[] = []): RayHit | null {
    finiteVector(origin, 'ray origin'); finiteVector(direction, 'ray direction');
    if (!Number.isFinite(maxDistance) || maxDistance < 0 || norm(direction) === 0) throw new Error('invalid ray');
    const dir = scale(direction,1/norm(direction)), ray = new RAPIER.Ray(origin,dir); let hit: RayHit | null = null;
    this.world.propagateModifiedBodyPositionsToColliders();
    for (const [id,{ collider }] of this.entries) { if (exclude.includes(id)) continue; const distance = collider.castRay(ray,maxDistance,true); if (distance >= 0 && (!hit || distance < hit.distance)) hit = { body: id, distance, point: add(origin,scale(dir,distance)) }; }
    return hit;
  }
  contacts(): Contact[] {
    const result: Contact[] = [];
    for (const [id,{collider}] of this.entries) this.world.contactPairsWith(collider,other => {
      const otherId=this.colliderIds.get(other.handle); if (!otherId || id>=otherId) return;
      let active=false; this.world.contactPair(collider,other,manifold => { if(manifold.numSolverContacts()>0) active=true; });
      if(active) result.push({a:id,b:otherId});
    });
    result.sort((a,b)=>a.a.localeCompare(b.a)||a.b.localeCompare(b.b));
    return result;
  }
  step(dt: number): void {
    if (this.closed) throw new Error('physics backend closed'); if (!Number.isFinite(dt) || dt <= 0 || dt > .1) throw new Error('physics timestep must be in (0, .1] seconds');
    this.world.timestep = dt;
    for (const { body, spec, kinematicVelocity, kinematicAngular } of this.entries.values()) if (spec.mode === 'kinematic' && (norm(kinematicVelocity) > 0 || norm(kinematicAngular) > 0)) { body.setNextKinematicTranslation(add(body.translation(),scale(kinematicVelocity,dt))); body.setNextKinematicRotation(angularStep(body.rotation(),kinematicAngular,dt)); }
    this.world.step(); for (const { body, spec } of this.entries.values()) if (spec.mode === 'dynamic') body.resetForces(false);
  }
  close(): void { if (this.closed) return; this.closed = true; this.entries.clear(); this.colliderIds.clear(); this.joints.clear(); this.world.free(); }
}
export const rapierFactory: PhysicsFactory = async ({ gravity }) => { await (initialized ??= RAPIER.init()); return new RapierBackend(gravity); };
