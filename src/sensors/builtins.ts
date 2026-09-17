import type { Json, Quat, SensorContext, SensorPlugin, SensorSpec, Vec3 } from '../contracts.ts';
import { add, rotate, sub, vec } from '../math.ts';

const vector = (v: Vec3) => ({ x: v.x, y: v.y, z: v.z });
const quaternion = (q: Quat) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const inverse = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const cross = (a: Vec3, b: Vec3): Vec3 => vec(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x);
const noise = (context: SensorContext, spec: SensorSpec) => (2*context.random()-1)*(spec.noise ?? 0);

function number(spec: SensorSpec, name: string, fallback: number, low: number, high: number, integer = false): number {
  const value = spec.config?.[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) {
    throw new Error(`${spec.id}: config.${name} must be ${integer ? 'an integer' : 'a number'} from ${low} to ${high}`);
  }
  return value;
}

/** Builtin configuration is checked before a world starts, including ray output limits. */
export function validateBuiltin(spec: SensorSpec): void {
  if (spec.type === 'lidar' || spec.type === 'range') {
    number(spec, 'rays', 24, 1, 256, true);
    number(spec, 'fov', Math.PI*2, 0.001, Math.PI*2);
    number(spec, 'maxRange', 20, 0.01, 10000);
  }
  if (spec.type === 'depth') {
    number(spec, 'width', 12, 1, 32, true);
    number(spec, 'height', 6, 1, 16, true);
    number(spec, 'hfov', Math.PI/2, 0.001, Math.PI*0.99);
    number(spec, 'vfov', Math.PI/3, 0.001, Math.PI*0.99);
    number(spec, 'maxRange', 20, 0.01, 10000);
  }
  if (spec.type === 'joints') {
    const joints = spec.config?.joints;
    if (!Array.isArray(joints) || joints.length > 128 || joints.some(joint => typeof joint !== 'string')) {
      throw new Error(`${spec.id}: config.joints must be a list of joint names`);
    }
  }
}

const odometry: SensorPlugin = {
  id: 'odometry', requires: ['bodies'],
  sample(context, spec) {
    const body = context.physics.body(context.link);
    const pointVelocity = add(body.linearVelocity, cross(body.angularVelocity, sub(context.mount.position, body.pose.position)));
    return {
      frame: 'world-ENU', position: {
        x: context.mount.position.x + noise(context, spec),
        y: context.mount.position.y + noise(context, spec),
        z: context.mount.position.z + noise(context, spec),
      },
      rotation: quaternion(context.mount.rotation),
      linearVelocity: vector(pointVelocity), angularVelocity: vector(body.angularVelocity),
    };
  },
};

const gyro: SensorPlugin = {
  id: 'gyro', requires: ['bodies'],
  sample(context, spec) {
    const local = rotate(context.physics.body(context.link).angularVelocity, inverse(context.mount.rotation));
    return { frame: 'sensor', units: 'rad/s', angularVelocity: {
      x: local.x + noise(context, spec), y: local.y + noise(context, spec), z: local.z + noise(context, spec),
    } };
  },
};

function ray(context: SensorContext, spec: SensorSpec, direction: Vec3, range: number): number | null {
  const hit = context.physics.ray(context.mount.position, rotate(direction, context.mount.rotation), range, context.bodyIds);
  return hit ? Math.max(0, Math.min(range, hit.distance + noise(context, spec))) : null;
}

const lidar: SensorPlugin = {
  id: 'lidar', requires: ['bodies', 'raycast'],
  sample(context, spec) {
    const count = number(spec, 'rays', 24, 1, 256, true);
    const fov = number(spec, 'fov', Math.PI*2, 0.001, Math.PI*2);
    const maxRange = number(spec, 'maxRange', 20, 0.01, 10000);
    const fullCircle = Math.abs(fov-Math.PI*2) < 1e-9;
    const start = count === 1 ? 0 : -fov/2;
    const increment = count === 1 ? 0 : fov/(fullCircle ? count : count-1);
    return {
      frame: 'sensor', units: 'm', angleMinRad: start, angleIncrementRad: increment, maxRange,
      distances: Array.from({ length: count }, (_, index) => {
        const angle = start+index*increment;
        return ray(context, spec, vec(Math.cos(angle), Math.sin(angle), 0), maxRange);
      }),
    };
  },
};

const depth: SensorPlugin = {
  id: 'depth', requires: ['bodies', 'raycast'],
  sample(context, spec) {
    const width = number(spec, 'width', 12, 1, 32, true);
    const height = number(spec, 'height', 6, 1, 16, true);
    const hfov = number(spec, 'hfov', Math.PI/2, 0.001, Math.PI*0.99);
    const vfov = number(spec, 'vfov', Math.PI/3, 0.001, Math.PI*0.99);
    const maxRange = number(spec, 'maxRange', 20, 0.01, 10000);
    const distances: Json[] = [];
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const y = (1-2*(column+0.5)/width)*Math.tan(hfov/2);
      const z = (1-2*(row+0.5)/height)*Math.tan(vfov/2);
      const length = Math.hypot(1, y, z);
      distances.push(ray(context, spec, vec(1/length, y/length, z/length), maxRange));
    }
    return { frame: 'sensor', units: 'm', kind: 'ray-distance-grid', width, height, hfov, vfov, maxRange, distances };
  },
};

const contact: SensorPlugin = {
  id: 'contact', requires: ['contacts'],
  sample(context) {
    const own = new Set(context.bodyIds);
    const contacts = context.physics.contacts().filter(item => own.has(item.a) !== own.has(item.b));
    return { touching: contacts.length > 0, count: contacts.length,
      links: [...new Set(contacts.map(item => own.has(item.a) ? item.a : item.b))] };
  },
};

const joints: SensorPlugin = {
  id: 'joints', requires: ['joints'],
  sample(context, spec) {
    const names = spec.config?.joints as string[];
    return { units: 'rad', joints: names.map(name => ({ name, position: context.physics.jointPosition(name) + noise(context, spec) })) };
  },
};

export const builtinSensors: SensorPlugin[] = [odometry, gyro, lidar, { ...lidar, id: 'range' }, depth, contact, joints];
