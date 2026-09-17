import type { BodySpec, PhysicsBackend, RobotAsset, RobotModel, RobotPlant } from '../contracts.ts';
import { compose } from '../math.ts';

const hold = { description: 'Hold current actuator positions and cancel motion.', schema: { type: 'object', properties: {}, additionalProperties: false } };
export function requireCapabilities(physics: PhysicsBackend, required: readonly string[]): void {
  const missing = required.filter(value => !physics.capabilities.includes(value));
  if (missing.length) throw new Error(`physics ${physics.id} lacks required capabilities: ${missing.join(', ')}`);
}

/** Primitive assets use link poses relative to the robot origin and joint anchors in link frames. */
export function createAssetModel(id: string, definition: RobotAsset): RobotModel {
  const asset = structuredClone(definition);
  if (!asset.links.length || asset.links.length > 64) throw new Error('asset needs between 1 and 64 links');
  const names = new Set<string>();
  for (const link of asset.links) {
    if (!/^[A-Za-z][\w-]*$/.test(link.name) || names.has(link.name)) throw new Error(`invalid or duplicate link ${link.name}`);
    names.add(link.name);
  }
  const joints = asset.joints ?? [], jointNames = new Set<string>();
  for (const joint of joints) {
    if (!/^[A-Za-z][\w-]*$/.test(joint.name) || jointNames.has(joint.name)) throw new Error(`invalid or duplicate joint ${joint.name}`);
    if (!names.has(joint.parent) || !names.has(joint.child) || joint.parent === joint.child) throw new Error(`invalid endpoints for joint ${joint.name}`);
    jointNames.add(joint.name);
  }
  const actuated = joints.filter(joint => joint.kind === 'revolute');
  const positions = Object.fromEntries(actuated.map(joint => [joint.name, { type: 'number', minimum: joint.limits?.[0] ?? -Math.PI, maximum: joint.limits?.[1] ?? Math.PI }]));
  const requires = ['bodies', ...new Set(asset.links.map(link=>`shape:${link.shape.kind}`)), ...(asset.links.some(link => link.mode === 'dynamic') ? ['rigid-body'] : []), ...(asset.links.some(link => link.mode === 'kinematic') ? ['kinematic'] : []), ...(joints.length ? ['joints'] : []), ...(actuated.length ? ['joint-motors'] : [])];
  return {
    id, requires,
    commands: { hold, ...(actuated.length ? { joints: { description: 'Set selected joint position targets in radians. Unlisted joints retain their targets.', schema: { type: 'object', required: ['positions'], properties: { positions: { type: 'object', minProperties: 1, properties: positions, additionalProperties: false } }, additionalProperties: false } } } : {}) },
    create({ id: robotId, pose, physics }): RobotPlant {
      requireCapabilities(physics, requires);
      const visuals: BodySpec[] = asset.links.map(({ name, ...link }) => ({ ...link, id: `${robotId}/${name}`, pose: compose(pose,link.pose) }));
      for (const link of visuals) physics.addBody(link);
      for (const { name, parent, child, ...joint } of joints) physics.addJoint({ ...joint, id: `${robotId}/${name}`, parent: `${robotId}/${parent}`, child: `${robotId}/${child}` });
      const root = visuals[0].id;
      return {
        root, bodyIds: visuals.map(link => link.id), jointIds: joints.map(joint => `${robotId}/${joint.name}`), visuals,
        apply(action, args) {
          if (action === 'hold') { this.stop(); return; }
          if (action !== 'joints' || !args.positions || typeof args.positions !== 'object' || Array.isArray(args.positions)) throw new Error(`unsupported asset action ${action}`);
          const next = Object.entries(args.positions);
          if (!next.length) throw new Error('positions cannot be empty');
          for (const [name,value] of next) {
            const joint = actuated.find(joint => joint.name === name);
            if (!joint || typeof value !== 'number' || !Number.isFinite(value) || joint.limits && (value < joint.limits[0] || value > joint.limits[1])) throw new Error(`invalid target for joint ${name}`);
          }
          for (const [name,value] of next) physics.jointTarget(`${robotId}/${name}`,value as number);
        },
        tick() {},
        stop() {
          for (const joint of actuated) { const current = physics.jointPosition(`${robotId}/${joint.name}`); const limited = Math.max(joint.limits?.[0] ?? -Math.PI,Math.min(joint.limits?.[1] ?? Math.PI,current)); physics.jointTarget(`${robotId}/${joint.name}`,limited); }
        },
        completed(action,args) {
          if (action === 'hold') return true;
          if (action !== 'joints' || !args.positions || typeof args.positions !== 'object' || Array.isArray(args.positions)) return false;
          return Object.entries(args.positions).every(([name,value]) => typeof value === 'number' && Math.abs(physics.jointPosition(`${robotId}/${name}`)-value) < .08);
        },
      };
    },
  };
}
