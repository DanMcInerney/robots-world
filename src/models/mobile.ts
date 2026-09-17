import type { Json, RobotModel, RobotPlant, Vec3 } from '../contracts.ts';
import { add, clamp, distance, norm, scale, sub, vec } from '../math.ts';
import { requireCapabilities } from './assets.ts';

const xyz = { x: { type: 'number', minimum: -10000, maximum: 10000 }, y: { type: 'number', minimum: -10000, maximum: 10000 }, z: { type: 'number', minimum: -10000, maximum: 10000 } };
const commands = {
  goto: { description: 'Move to an ENU position in metres using the local simplified servo.', schema: { type: 'object', required: ['x','y','z'], properties: xyz, additionalProperties: false } },
  velocity: { description: 'Set ENU velocity in metres/second and optional yaw rate in radians/second until replaced or expired.', schema: { type: 'object', required: ['x','y','z'], properties: { ...Object.fromEntries(['x','y','z'].map(key => [key,{ type: 'number', minimum: -20, maximum: 20 }])), yawRate: { type: 'number', minimum: -6, maximum: 6 } }, additionalProperties: false } },
  hold: { description: 'Stop current motion and hold position with the local servo.', schema: { type: 'object', properties: {}, additionalProperties: false } },
};
function numeric(config: Record<string,Json>, name: string, fallback: number, min: number, max: number): number {
  const value = config[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be in [${min}, ${max}]`);
  return value;
}
const cap = (value: Vec3, limit: number) => norm(value) > limit ? scale(value,limit/norm(value)) : value;
function argsVector(args: Record<string,Json>): Vec3 {
  if (!['x','y','z'].every(key => typeof args[key] === 'number' && Number.isFinite(args[key]))) throw new Error('command requires finite x, y, z');
  return vec(args.x as number,args.y as number,args.z as number);
}

/** These local servos test control boundaries, not aerodynamic or tire models. */
export function mobileModel(kind: 'drone' | 'rover' | 'kinematic'): RobotModel {
  const kinematic = kind === 'kinematic', rover = kind === 'rover';
  const requires = kinematic ? ['bodies','velocity','kinematic'] : ['bodies','rigid-body','forces','velocity'];
  return {
    id: kind, requires,
    commands: { ...commands, ...(rover ? { drive: { description: 'Differential-style body-forward speed and yaw rate; no tire/slip dynamics.', schema: { type: 'object', required: ['forward','yawRate'], properties: { forward: { type: 'number', minimum: -8, maximum: 8 }, yawRate: { type: 'number', minimum: -6, maximum: 6 } }, additionalProperties: false } } } : {}) },
    create({ id, pose, physics, config }): RobotPlant {
      requireCapabilities(physics,requires);
      const mass = numeric(config,'mass',1,.01,1000), speed = numeric(config,'maxSpeed',rover ? 2 : 3,.01,20), acceleration = numeric(config,'maxAcceleration',rover ? 5 : 8,.01,100);
      const root = `${id}/base`, initialZ = pose.position.z;
      const visual = { id: root, pose: structuredClone(pose), shape: { kind: 'box' as const, size: rover ? vec(.7,.45,.36) : vec(.55,.55,.18), color: typeof config.color === 'string' ? config.color : rover ? '#f2ba63' : '#5ce0ca' }, mode: kinematic ? 'kinematic' as const : 'dynamic' as const, mass, friction: rover ? .02 : .3 };
      physics.addBody(visual);
      let target: Vec3 | null = { ...pose.position }, requested = vec(), yawRate = 0, driveForward: number | null = null;
      function stop() { target = { ...physics.body(root).pose.position }; requested = vec(); driveForward = null; yawRate = 0; physics.velocity(root,vec()); if (!kinematic) physics.force(root,vec()); }
      return {
        root, bodyIds: [root], jointIds: [], visuals: [visual],
        apply(action,args) {
          if (action === 'hold') { stop(); return; }
          if (action === 'goto') { const next = argsVector(args); if (rover && Math.abs(next.z-initialZ) > .5) throw new Error('rover goto cannot command altitude'); target = next; requested = vec(); driveForward = null; yawRate = 0; }
          else if (action === 'velocity') { const next = argsVector(args); if (rover && Math.abs(next.z) > 1e-9) throw new Error('rover cannot command vertical velocity'); const rate = args.yawRate ?? 0; if (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 6) throw new Error('invalid yawRate'); target = null; requested = cap(next,speed); driveForward = null; yawRate = rate; }
          else if (action === 'drive' && rover) { const forward = args.forward, turn = args.yawRate; if (typeof forward !== 'number' || typeof turn !== 'number' || !Number.isFinite(forward) || !Number.isFinite(turn) || Math.abs(turn) > 6) throw new Error('invalid drive'); target = null; driveForward = clamp(forward,speed); yawRate = turn; }
          else throw new Error(`unsupported ${kind} action ${action}`);
        },
        tick(dt) {
          const state = physics.body(root), q = state.pose.rotation;
          const yaw = Math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z));
          let desired = target ? cap(scale(sub(target,state.pose.position),1.8),speed) : { ...requested };
          let turn = yawRate;
          if (rover) {
            if (target) {
              const error = sub(target,state.pose.position), heading = Math.atan2(error.y,error.x), delta = Math.atan2(Math.sin(heading-yaw),Math.cos(heading-yaw));
              turn = clamp(delta*3,2.5); const forward = Math.min(speed,Math.hypot(error.x,error.y)*1.8)*Math.max(0,Math.cos(delta));
              desired = vec(Math.cos(yaw)*forward,Math.sin(yaw)*forward,0);
            } else if (driveForward !== null) desired = vec(Math.cos(yaw)*driveForward,Math.sin(yaw)*driveForward,0);
            desired.z = state.linearVelocity.z;
          }
          if (kinematic) { const delta = cap(sub(desired,state.linearVelocity),acceleration*dt); physics.velocity(root,add(state.linearVelocity,delta),vec(0,0,turn)); }
          else {
            const desiredAcceleration = cap(scale(sub(desired,state.linearVelocity),4),acceleration);
            if (rover) desiredAcceleration.z = 0;
            const applied = rover ? scale(desiredAcceleration,mass) : scale(sub(desiredAcceleration,physics.gravity),mass);
            physics.force(root,applied);
            // Idealized attitude/steering servo. Contacts remain physical; motors/rotors are not modelled.
            physics.velocity(root,state.linearVelocity,vec(-q.x*8,-q.y*8,turn));
          }
        },
        stop,
        completed(action,args) {
          if (action === 'hold') return norm(physics.body(root).linearVelocity) < .1;
          if (action !== 'goto') return false;
          const state = physics.body(root), expected = argsVector(args), actual = { ...state.pose.position };
          if (rover) expected.z = actual.z;
          return distance(expected,actual) < .15 && norm(state.linearVelocity) < .2;
        },
      };
    },
  };
}
