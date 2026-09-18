import type { Json, RobotModel, SensorPlugin, Vec3 } from '../contracts.ts';
import { clamp, norm, sub, vec } from '../math.ts';
import { mobileModel } from '../models/mobile.ts';

export const radians = (degrees: number) => degrees * Math.PI / 180;
export const degrees = (angle: number) => angle * 180 / Math.PI;
export const wrapDegrees = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;
export function yawDegrees(q: { x: number; y: number; z: number; w: number }) {
  return degrees(Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)));
}

/** Pinhole projection. Heading is ENU: 0 east, +90 north; pitch positive up. */
export function projectPoint(origin: Vec3, point: Vec3, heading: number, pitch: number, hfov: number, aspect = 16 / 9) {
  const d = sub(point, origin), y = radians(heading), p = radians(pitch);
  const forward = d.x * Math.cos(y) * Math.cos(p) + d.y * Math.sin(y) * Math.cos(p) + d.z * Math.sin(p);
  const right = d.x * Math.sin(y) - d.y * Math.cos(y);
  const up = -d.x * Math.cos(y) * Math.sin(p) - d.y * Math.sin(y) * Math.sin(p) + d.z * Math.cos(p);
  const half = Math.tan(radians(hfov) / 2), u = right / (forward * half), v = up / (forward * half / aspect);
  return { u, v, range: norm(d), inFrame: forward > 0 && Math.abs(u) <= 1 && Math.abs(v) <= 1 };
}

/** Optional robot/device kit. No mission, target-following controller or evaluator lives here.
 * A camera detection is an ideal geometric point detection, never an RGB image.
 */
export function aimedDroneKit() {
  const cameras = new Map<string, { heading: number; pitch: number; requestedPitch: number; hfov: number }>();
  const base = mobileModel('drone');
  const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
  const model: RobotModel = {
    id: 'aimed-drone', requires: base.requires,
    commands: { hold: { description: 'Brake and hold position; freeze camera. Does not revoke the port.', schema: { type: 'object', additionalProperties: false, properties: {} } }, control: { description: 'Atomic movement and camera setpoints; no target tracking or route planning.', schema: {
      type: 'object', additionalProperties: false, required: ['mode', 'x', 'y', 'z', 'heading', 'pitch', 'hfov'],
      properties: { mode: { enum: ['position', 'velocity'] }, x: number(-100, 100), y: number(-100, 100), z: number(-100, 100), heading: number(-180, 180), pitch: number(-85, 45), hfov: { enum: [35, 70] } },
    } } },
    create(context) {
      const plant = base.create(context), camera = { heading: yawDegrees(context.pose.rotation), pitch: -30, requestedPitch: -30, hfov: 70 };
      cameras.set(context.id, camera);
      return { ...plant,
        apply(action, args) {
          if (action === 'hold') { plant.stop(); camera.heading = yawDegrees(context.physics.body(plant.root).pose.rotation); camera.requestedPitch = camera.pitch; return; }
          if (action !== 'control' || !['position', 'velocity'].includes(String(args.mode))) throw new Error('Unsupported camera drone command');
          if (args.mode === 'velocity' && ['x', 'y', 'z'].some(k => Math.abs(args[k] as number) > 2)) throw new Error('Velocity component exceeds 2 m/s');
          plant.apply(args.mode === 'position' ? 'goto' : 'velocity', { x: args.x!, y: args.y!, z: args.z! });
          camera.heading = args.heading as number; camera.requestedPitch = args.pitch as number; camera.hfov = args.hfov as number;
        },
        tick(dt) {
          plant.tick(dt);
          const body = context.physics.body(plant.root), error = wrapDegrees(camera.heading - yawDegrees(body.pose.rotation));
          context.physics.velocity(plant.root, body.linearVelocity, vec(body.angularVelocity.x, body.angularVelocity.y, radians(clamp(error * 4, 120))));
          camera.pitch += clamp(camera.requestedPitch - camera.pitch, 90 * dt);
        },
        stop() { plant.stop(); camera.heading = yawDegrees(context.physics.body(plant.root).pose.rotation); camera.requestedPitch = camera.pitch; },
        // A camera/motion setpoint is active until replaced or expired, even after a position is reached.
        completed() { return false; },
      };
    },
  };
  const camera: SensorPlugin = { id: 'aim-camera', requires: ['bodies', 'raycast'], sample(context, spec) {
    const device = cameras.get(context.robotId); if (!device) throw new Error('aim-camera requires aimed-drone');
    const targets = spec.config?.targets;
    if (!Array.isArray(targets) || targets.length > 32 || targets.some(t => typeof t !== 'string')) throw new Error('camera targets must be up to 32 body IDs');
    const maxRange = spec.config?.maxRange ?? 20;
    if (typeof maxRange !== 'number' || maxRange <= 0 || maxRange > 1000) throw new Error('camera maxRange invalid');
    const noise = Number(spec.noise ?? 0), rangeNoise = Number(spec.config?.rangeNoiseM ?? 0), dropout = Number(spec.config?.detectionDropout ?? 0);
    if (![noise, rangeNoise, dropout].every(Number.isFinite) || noise < 0 || noise > .5 || rangeNoise < 0 || rangeNoise > 2 || dropout < 0 || dropout > 1) throw new Error('Invalid camera measurement noise');
    const noisy = (value: number, amount: number) => amount ? value + (context.random() * 2 - 1) * amount : value;
    const body = context.physics.body(context.link), heading = yawDegrees(body.pose.rotation);
    const detections: Json[] = [];
    for (const id of targets as string[]) {
      const target = context.physics.body(id), projected = projectPoint(context.mount.position, target.pose.position, heading, device.pitch, device.hfov);
      if (!projected.inFrame || projected.range > maxRange) continue;
      const hit = context.physics.ray(context.mount.position, sub(target.pose.position, context.mount.position), projected.range, context.bodyIds);
      if (hit?.body === id && (!dropout || context.random() >= dropout)) detections.push({ id, u: noisy(projected.u, noise), v: noisy(projected.v, noise), rangeM: Math.max(0, noisy(projected.range, rangeNoise)) });
    }
    return { kind: noise || rangeNoise || dropout ? 'noisy-geometric-detections' : 'ideal-geometric-detections', headingDeg: heading, pitchDeg: device.pitch, hfovDeg: device.hfov, aspect: 16 / 9, detections };
  } };
  return { model, camera, inspectCamera: (robotId: string) => { const state = cameras.get(robotId); if (!state) throw new Error('Unknown camera'); return { pitchDeg: state.pitch, hfovDeg: state.hfov }; } };
}
