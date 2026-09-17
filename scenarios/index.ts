import type { Scenario, SensorSpec, RobotSpec, BodySpec } from '../src/contracts.ts';
import { pose, vec } from '../src/math.ts';

const odometry = (): SensorSpec[] => [{ id: 'odom', type: 'odometry', hz: 20, latencyMs: 20, maxAgeMs: 200 },
  { id: 'scan', type: 'lidar', hz: 10, latencyMs: 40, maxAgeMs: 400, config: { rays: 24, fov: Math.PI * 2, maxRange: 10 } }];
const floor: BodySpec = { id: 'ground', mode: 'fixed', pose: pose(0, 0, -0.2), shape: { kind: 'box', size: vec(30, 30, 0.4), color: '#263a45' }, friction: 0.8 };
const pillar = (id: string, x: number, y: number): BodySpec => ({ id, mode: 'fixed', pose: pose(x, y, 1), shape: { kind: 'box', size: vec(0.8, 0.8, 2), color: '#546a77' } });
const base = (id: string, robots: RobotSpec[]): Scenario => ({ id, seed: 42, dt: 0.02, gravity: vec(0, 0, -9.81), bounds: vec(30, 30, 12), obstacles: [floor, pillar('obstacle-a', 3, 3), pillar('obstacle-b', -3, -3)], robots });
export const scenarios: Record<string, { label: string; description: string; create(): Scenario }> = {
  single: { label: 'Single drone', description: 'One drone, mounted odometry and lidar; controller loop experiments.', create: () => base('single', [
    { id: 'drone-1', model: 'drone', pose: pose(0, 0, 1.5), sensors: odometry(), goal: 'Navigate the square route while monitoring sensors.' },
  ]) },
  mixed: { label: 'Robot workbench', description: 'Drone, rover, two-joint arm and supported humanoid articulation fixture.', create: () => base('mixed', [
    { id: 'drone-1', model: 'drone', pose: pose(-3, 0, 1.5), sensors: odometry() },
    { id: 'rover-1', model: 'rover', pose: pose(0, 0, 0.28), sensors: odometry() },
    { id: 'arm-1', model: 'arm', pose: pose(3, 0, 0.3), sensors: [{ id: 'joints', type: 'joints', hz: 25 }, { id: 'odom', type: 'odometry', hz: 10 }] },
    { id: 'humanoid-1', model: 'humanoid', pose: pose(0, 4, 1.6), sensors: [{ id: 'joints', type: 'joints', hz: 25 }, { id: 'contact', type: 'contact', hz: 10 }] },
  ]) },
  swarm: { label: 'Radio swarm', description: 'Four independently controlled drones; impaired radio, no shared observations.', create: () => base('swarm', Array.from({ length: 4 }, (_, i) => ({
    id: `drone-${i + 1}`, model: 'drone', pose: pose(-3 + (i % 2) * 2, -2 + Math.floor(i / 2) * 2, 1.5 + i * 0.3), sensors: odometry(),
    radio: { channel: 'swarm', rangeM: 15, bitrateBps: 9600, latencyMs: 80, jitterMs: 30, loss: 0.08, maxQueueBytes: 2048, maxPacketBytes: 512 },
    goal: i === 0 ? 'Lead and broadcast your acquired position.' : 'Follow received leader beacons; hold when beacons expire.',
  }))) },
  portable: { label: 'Backend portability', description: 'Kinematic fixture runs on both engines; proves controller API portability, not physics equivalence.', create: () => ({ ...base('portable', [
    { id: 'fixture-1', model: 'kinematic', pose: pose(0, 0, 1), sensors: odometry() },
  ]), gravity: vec(0, 0, 0) }) },
};
export function scenario(name: string): Scenario {
  const factory = scenarios[name]; if (!factory) throw new Error(`Unknown scenario ${name}`); return factory.create();
}
