import type { Json, Scenario, SensorPlugin, Vec3 } from '../src/contracts.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { norm, pose, randomStream, scale, sub, vec } from '../src/math.ts';
import type { Registry } from '../src/registry.ts';
import type { World } from '../src/world.ts';

export interface TrackingOptions {
  seed: number;
  /** Impair the target tracker only; other sensor timing stays independently configurable. */
  sensorLatencyMs?: number;
  sensorDropout?: number;
  /** Force tracker occlusion over [14,16) seconds. Defaults to true. */
  occlusion?: boolean;
}
export interface TrackingEvent { id: string; simMs: number; kind: string }
export interface TrackingExperiment {
  scenario: Scenario;
  registry: Registry;
  /** Call immediately before each advance(1), placing the target for the upcoming physics tick. */
  update(world: World): void;
  /** Privileged evaluator truth. Never hand this function to a controller. */
  target(simMs: number): Vec3;
  events: TrackingEvent[];
}

const TARGET_ID = 'tracking-target';
const OCCLUSION_START_MS = 14000;
const OCCLUSION_END_MS = 16000;

/** A seeded moving-target task, with idealized preprocessed tracking rather than visual recognition. */
export function createTrackingExperiment(options: TrackingOptions): TrackingExperiment {
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new Error('tracking seed must be an unsigned 32-bit integer');
  const latencyMs = options.sensorLatencyMs ?? 0;
  const dropout = options.sensorDropout ?? 0;
  const occlusion = options.occlusion ?? true;
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60000) throw new Error('tracking sensor latency must be 0–60000 ms');
  if (!Number.isFinite(dropout) || dropout < 0 || dropout > 1) throw new Error('tracking sensor dropout must be 0–1');
  if (typeof occlusion !== 'boolean') throw new Error('tracking occlusion must be boolean');

  const random = randomStream(options.seed, 'tracking/trajectory');
  const phase = random()*Math.PI*2;
  const direction = random() < 0.5 ? -1 : 1;
  const lateralSpeed = 0.25+random()*0.2;
  const forwardSpeed = 0.35+random()*0.2;
  const target = (simMs: number): Vec3 => {
    if (!Number.isFinite(simMs) || simMs < 0) throw new Error('tracking time must be finite and nonnegative');
    const seconds = simMs/1000;
    // Integral of +1, -1, +1 lateral velocity: position is continuous at both turns.
    const lateral = seconds <= 8 ? seconds : seconds <= 20 ? 16-seconds : seconds-24;
    return vec(2+0.25*Math.cos(phase)+forwardSpeed*seconds,
      0.4*Math.sin(phase)+direction*lateralSpeed*lateral,
      1.8+0.12*Math.sin(phase+seconds*0.35));
  };
  const events: TrackingEvent[] = [
    { id: 'turn-1', simMs: 8000, kind: 'lateral-reversal' },
    ...(occlusion ? [
      { id: 'occlusion-start', simMs: OCCLUSION_START_MS, kind: 'occlusion-start' },
      { id: 'occlusion-end', simMs: OCCLUSION_END_MS, kind: 'occlusion-end' },
    ] : []),
    { id: 'turn-2', simMs: 20000, kind: 'lateral-reversal' },
  ];

  const tracker: SensorPlugin = {
    id: 'target-tracker', requires: ['bodies', 'raycast'],
    sample(context, spec): Json {
      const rangeM = spec.config?.rangeM ?? 25;
      if (typeof rangeM !== 'number' || !Number.isFinite(rangeM) || rangeM <= 0 || rangeM > 1000) throw new Error('target tracker rangeM must be within (0,1000]');
      const relative = sub(context.physics.body(TARGET_ID).pose.position, context.mount.position);
      const distance = norm(relative);
      const forced = occlusion && context.simMs >= OCCLUSION_START_MS && context.simMs < OCCLUSION_END_MS;
      if (forced || distance > rangeM) return { visible: false, relative: null };
      // The known target is excluded; any other collider between sensor and target occludes it.
      const blocked = distance > 1e-8 && context.physics.ray(context.mount.position, scale(relative, 1/distance), distance,
        [...context.bodyIds, TARGET_ID]) !== null;
      if (blocked) return { visible: false, relative: null };
      const noise = () => (2*context.random()-1)*(spec.noise ?? 0);
      // Ideal fused localization at acquisition. Consumers must not translate a delayed
      // relative sample using a newer odometry position from a different physical time.
      return { visible: true, frame: 'world-ENU', origin: { ...context.mount.position },
        relative: { x: relative.x+noise(), y: relative.y+noise(), z: relative.z+noise() } };
    },
  };

  const initialTarget = target(0);
  const scenario: Scenario = {
    id: 'tracking', seed: options.seed, dt: 0.02, gravity: vec(0, 0, -9.81), bounds: vec(200, 120, 12),
    obstacles: [
      { id: 'ground', mode: 'fixed', pose: pose(30, 0, -0.2), shape: { kind: 'box', size: vec(200, 120, 0.4), color: '#243847' }, friction: 0.7 },
      { id: TARGET_ID, mode: 'kinematic', pose: { ...pose(), position: initialTarget },
        shape: { kind: 'sphere', size: vec(0.3, 0.3, 0.3), color: '#ffbb63' } },
    ],
    robots: [{
      id: 'drone', model: 'drone', pose: pose(0, 0, 1.5), config: { maxSpeed: 2, maxAcceleration: 4 },
      goal: 'Track the moving target using your own mounted sensors. The target sensor reports an idealized ENU relative position and fused sensor origin at acquisition when visible; it is not a camera image. Handle missing or stale readings explicitly.',
      sensors: [
        { id: 'odometry', type: 'odometry', hz: 50, maxAgeMs: 100 },
        { id: 'lidar', type: 'lidar', hz: 20, maxAgeMs: 150, config: { rays: 32, fov: Math.PI*2, maxRange: 15 } },
        { id: 'target', type: 'target-tracker', hz: 10, latencyMs, dropout, noise: 0, maxAgeMs: 1000,
          mount: pose(), config: { rangeM: 25 } },
      ],
    }],
  };
  const registry = defaultRegistry();
  registry.sensors.set(tracker.id, tracker);
  const emitted = new WeakMap<World, Set<string>>();
  return {
    scenario, registry, target, events,
    update(world) {
      if (world.scenario.id !== scenario.id || world.scenario.seed !== options.seed) throw new Error('tracking updater received a different experiment world');
      const nextMs = world.simMs+world.scenario.dt*1000;
      world.physics.move(TARGET_ID, { ...pose(), position: target(nextMs) });
      let seen = emitted.get(world);
      if (!seen) { seen = new Set(); emitted.set(world, seen); }
      for (const event of events) if (event.simMs <= nextMs+1e-7 && !seen.has(event.id)) {
        seen.add(event.id);
        world.journal.record({ simMs: event.simMs, channel: 'world', kind: 'tracking.event', data: event });
      }
    },
  };
}
