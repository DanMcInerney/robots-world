/** Evaluator-side scripted acquisition. No route truth is a perception input. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BodySpec, BodyState, Command, Contact, Diagnostic, Job, Pose, Receipt, Scenario } from '../../src/contracts.ts';
import { defaultRegistry } from '../../src/defaults.ts';
import { compose, pose, randomStream, vec } from '../../src/math.ts';
import { Journal } from '../../src/recorder.ts';
import { World } from '../../src/world.ts';

export type XYZ = [number, number, number];
export interface RenderPose { position: XYZ; yaw_rad: number; pitch_rad: number; roll_rad: number }
export type RouteFamily = 'nominal-range' | 'wall-pole' | 'occlusion-lookalike' | 'moving-target-ego';
export interface RouteSpec {
  id: string; family: RouteFamily; seed: number; split: 'development' | 'confirmation';
  duration_ms: 10000; camera_hz: 10; physics_dt_s: 0.02;
}
export interface ObstacleBox { id: string; position: XYZ; size: XYZ; color: XYZ }
export interface LookalikeCar { id: string; pose: RenderPose; color: XYZ }
export interface SceneConfig {
  seed: number; obstacles: ObstacleBox[]; lookalikes: LookalikeCar[];
  car_dimensions_m: XYZ;
}
interface VelocitySegment { at_ms: number; velocity_enu_m_s: XYZ; yaw_rate_rad_s: number }
export interface SceneDefinition {
  scenario: Scenario; scene_config: SceneConfig; camera_mount: RenderPose;
  drone_script: VelocitySegment[]; target_script: VelocitySegment[];
}
export interface RouteFrame {
  frame_index: number; acquired_sim_ms: number;
  camera_pose: RenderPose; target_pose: RenderPose;
  evaluator: { drone: BodyState; target: BodyState; contacts: Contact[] };
}
export interface CommandRecord { requested_sim_ms: number; command: Command; receipt: Receipt }
export interface StopRecord {
  requested_sim_ms: number; completed_sim_ms: number; status: 'completed';
  lease_revoked_event_ids: number[]; owner_after_stop: null;
  jobs_after_stop: Job[]; stale_command: { rejected: true; error: string };
  post_stop_sim_ms: number; command_applications_after_stop: number; drone_after_stop: BodyState;
}
export interface RouteRecording {
  schema: 'jev-round3-world-v1'; audience: 'evaluator-and-sensor-simulator-only';
  qualification: 'scripted-camera-acquisition-not-controller-evaluation';
  timing: 'offline-physics-trajectory-replayed-by-renderer-not-continuous-latency';
  spec: RouteSpec; physics: 'rapier'; scene_config: SceneConfig;
  camera_mount: RenderPose; drone_script: VelocitySegment[]; target_script: VelocitySegment[];
  frames: RouteFrame[]; command_receipts: CommandRecord[]; stop_receipt: StopRecord;
  diagnostics: Diagnostic[]; trace_coverage: { first_id: number; last_id: number; count: number; lost: number; truncated: number };
}

const DRONE_ID = 'round3-drone';
const TARGET_ID = 'environment-target-car';
// Actual uniformly normalized renderer mesh bounds, including mirrors.
export const TARGET_CAR_DIMENSIONS: Readonly<XYZ> = [4.5, 2.2404008033433596, 1.2267351453772577];
const CAR_SIZE: XYZ = [...TARGET_CAR_DIMENSIONS];
const FRAMES = 100;
const JOURNAL_CAPACITY = 1024;
const FAMILY_SEEDS: [RouteFamily, number][] = [
  ['nominal-range', 7300], ['wall-pole', 7400], ['occlusion-lookalike', 7500], ['moving-target-ego', 7600],
];
const xyz = (v: { x: number; y: number; z: number }): XYZ => [v.x, v.y, v.z];
const vector = (p: XYZ) => vec(...p);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const yawPose = (position: XYZ, yaw = 0): Pose => ({ position: vector(position), rotation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) } });
const renderPose = (position: XYZ, yaw_rad = 0): RenderPose => ({ position, yaw_rad, pitch_rad: 0, roll_rad: 0 });
const segment = (at_ms: number, velocity_enu_m_s: XYZ, yaw_rate_rad_s = 0): VelocitySegment => ({ at_ms, velocity_enu_m_s, yaw_rate_rad_s });

/** Fresh objects on every call; fixed development/confirmation membership. */
export function routeSpecs(): RouteSpec[] {
  return FAMILY_SEEDS.flatMap(([family, base]) => [1, 2, 3].map(n => ({
    id: `${family}-${n === 3 ? 'confirmation-1' : `development-${n}`}`,
    family, seed: base + n, split: n === 3 ? 'confirmation' : 'development',
    duration_ms: 10000, camera_hz: 10, physics_dt_s: 0.02,
  })));
}

function validateSpec(spec: RouteSpec) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(spec.id) || !Number.isInteger(spec.seed)
    || !FAMILY_SEEDS.some(([family]) => family === spec.family)
    || !['development', 'confirmation'].includes(spec.split)
    || spec.duration_ms !== 10000 || spec.camera_hz !== 10 || spec.physics_dt_s !== 0.02) {
    throw new Error('Route must have a safe ID, integer seed, known family/split and fixed 10-second/10-Hz/20-ms bounds');
  }
}

function boxBody(box: ObstacleBox): BodySpec {
  return { id: box.id, pose: yawPose(box.position), shape: { kind: 'box', size: vector(box.size),
    color: '#' + box.color.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('') }, mode: 'fixed' };
}

/** Pure scene construction. The target and lookalikes are environment bodies, never robots. */
export function createScene(spec: RouteSpec): SceneDefinition {
  validateSpec(spec);
  const random = randomStream(spec.seed, 'round3-world-scene');
  const sign = random() < 0.5 ? -1 : 1;
  const jitter = (random() - 0.5) * 0.4;
  const targetYaw = (random() - 0.5) * 0.10;
  const obstacles: ObstacleBox[] = [];
  const lookalikes: LookalikeCar[] = [];
  let dronePosition: XYZ = [-1, sign * 0.25 + jitter, 1.8];
  let droneYaw = 0;
  let droneScript = [segment(0, [0.45, 0, 0]), segment(5000, [-0.3, 0, 0])];
  let targetScript = [segment(0, [0, 0, 0])];
  if (spec.family === 'nominal-range') {
    dronePosition = [-5 + jitter, sign * 0.2, 1.8];
    droneScript = [segment(0, [2.0, 0, 0]), segment(5000, [-1.3, 0, 0])];
  } else if (spec.family === 'wall-pole') {
    obstacles.push(
      { id: 'hazard-wall', position: [6.8, sign * 3.0, 1.35], size: [0.35, 3.4, 2.7], color: [0.52, 0.52, 0.50] },
      { id: 'hazard-pole', position: [5.8, -sign * 1.3 + jitter, 1.25], size: [0.12, 0.12, 2.5], color: [0.32, 0.33, 0.34] },
    );
    droneScript = [segment(0, [0.45, sign * 0.18, 0]), segment(5000, [0.35, -sign * 0.18, 0])];
  } else if (spec.family === 'occlusion-lookalike') {
    dronePosition = [-1, -sign * 1.0 + jitter, 1.8];
    obstacles.push({ id: 'partial-occluder', position: [6.5, sign * 0.35, 1.1], size: [0.4, 0.55, 2.2], color: [0.54, 0.51, 0.48] });
    lookalikes.push({ id: 'lookalike-car', pose: renderPose([13.5, -sign * 3.2, 0], -targetYaw), color: [0.08, 0.28, 0.75] });
    droneScript = [segment(0, [0.2, sign * 0.4, 0]), segment(5000, [0.2, -sign * 0.4, 0])];
  } else {
    dronePosition = [-1, -sign * 0.5 + jitter, 1.8];
    droneYaw = sign * 0.04;
    droneScript = [segment(0, [0.35, sign * 0.15, 0], sign * 0.05),
      segment(3000, [0.35, -sign * 0.12, 0], -sign * 0.065),
      segment(7000, [0.2, sign * 0.1, 0], sign * 0.04)];
    targetScript = [segment(0, [0.4, sign * 0.22, 0]), segment(5000, [0.4, -sign * 0.22, 0])];
  }
  const target: BodySpec = { id: TARGET_ID, pose: yawPose([12, jitter, CAR_SIZE[2] / 2], targetYaw),
    shape: { kind: 'box', size: vector(CAR_SIZE), color: '#1448bf' }, mode: 'kinematic' };
  const ground: BodySpec = { id: 'ground', pose: pose(5, 0, -0.1),
    shape: { kind: 'box', size: vec(60, 40, 0.2), color: '#818078' }, mode: 'fixed' };
  const otherCars = lookalikes.map(car => ({ id: car.id,
    pose: yawPose([car.pose.position[0], car.pose.position[1], CAR_SIZE[2] / 2], car.pose.yaw_rad),
    shape: { kind: 'box' as const, size: vector(CAR_SIZE), color: '#1448bf' }, mode: 'fixed' as const }));
  return {
    scenario: { id: `jev-round3-${spec.id}`, seed: spec.seed, dt: spec.physics_dt_s,
      gravity: vec(0, 0, -9.81), bounds: vec(60, 40, 12), obstacles: [ground, target, ...obstacles.map(boxBody), ...otherCars],
      robots: [{ id: DRONE_ID, model: 'drone', pose: yawPose(dronePosition, droneYaw),
        config: { maxSpeed: 2.5, maxAcceleration: 8 }, sensors: [],
        goal: 'Scripted camera acquisition qualification; no learned controller or navigation evaluation' }] },
    scene_config: { seed: spec.seed, obstacles, lookalikes, car_dimensions_m: [...CAR_SIZE] },
    camera_mount: { position: [0, 0, 0], yaw_rad: 0, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 },
    drone_script: droneScript, target_script: targetScript,
  };
}

/** Positive rendered pitch looks up; body +X is forward and camera right is -Y. */
export function cameraFromBody(body: BodyState, mount: RenderPose): RenderPose {
  if (mount.yaw_rad !== 0 || mount.roll_rad !== 0) throw new Error('This fixed rig permits pitch only');
  const rotation = { x: 0, y: Math.sin(-mount.pitch_rad / 2), z: 0, w: Math.cos(mount.pitch_rad / 2) };
  const mounted = compose(body.pose, { position: vector(mount.position), rotation });
  const q = mounted.rotation;
  return { position: xyz(mounted.position),
    yaw_rad: Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)),
    pitch_rad: -Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x)))),
    roll_rad: Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) };
}

function targetFromBody(body: BodyState): RenderPose {
  const q = body.pose.rotation;
  return renderPose([body.pose.position.x, body.pose.position.y, body.pose.position.z - CAR_SIZE[2] / 2],
    Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)));
}

/** Bounded in-memory qualification primitive, also usable by tests without recording a scored route. */
export async function recordRoute(spec: RouteSpec): Promise<RouteRecording> {
  const scene = createScene(spec);
  const journal = new Journal(JOURNAL_CAPACITY);
  const world = await World.create(scene.scenario, defaultRegistry(), 'rapier', journal);
  const port = world.claim(DRONE_ID, 'round3-scripted-acquisition');
  const frames: RouteFrame[] = [];
  const commandReceipts: CommandRecord[] = [];
  let stopReceipt: StopRecord | undefined;
  try {
    for (let tick = 0; tick < 500; tick++) {
      const atMs = Math.round(world.simMs);
      const droneSegment = scene.drone_script.find(s => s.at_ms === atMs);
      if (droneSegment) {
        const [x, y, z] = droneSegment.velocity_enu_m_s;
        const command: Command = { id: `${spec.id}:${atMs}`, action: 'velocity',
          args: { x, y, z, yawRate: droneSegment.yaw_rate_rad_s }, validForMs: spec.duration_ms - atMs + 100 };
        const receipt = await port.command(command);
        commandReceipts.push({ requested_sim_ms: world.simMs, command, receipt });
        if (!['accepted', 'completed'].includes(receipt.status)) throw new Error(`Script command rejected: ${receipt.reason}`);
      }
      const targetSegment = scene.target_script.find(s => s.at_ms === atMs);
      if (targetSegment) world.physics.velocity(TARGET_ID, vector(targetSegment.velocity_enu_m_s), vec(0, 0, targetSegment.yaw_rate_rad_s));
      await world.advance();
      if ((tick + 1) % 5 === 0) {
        const drone = world.physics.body(`${DRONE_ID}/base`), target = world.physics.body(TARGET_ID);
        // Fixed 20 ms physics ticks make these exact integer-millisecond boundaries.
        frames.push({ frame_index: frames.length, acquired_sim_ms: Math.round(world.simMs),
          camera_pose: cameraFromBody(drone, scene.camera_mount), target_pose: targetFromBody(target),
          evaluator: { drone, target, contacts: world.physics.contacts() } });
        // Preserve lifecycle events in the journal while draining the bounded port queue.
        const observation = await port.observe();
        if (observation.fault) throw new Error(observation.fault);
        await port.acknowledge(observation.events.at(-1)?.id ?? 0);
      }
    }
    const stopAt = world.simMs, stopCursor = journal.cursor;
    await port.stop();
    const stopped = world.inspect().robots[0]!;
    if (stopped.owner !== null) throw new Error('Stop did not revoke ownership');
    let staleError = '';
    try { await port.command({ id: `${spec.id}:post-stop`, action: 'velocity', args: { x: 1, y: 0, z: 0 } }); }
    catch (error) { staleError = String(error); }
    if (!staleError.includes('revoked')) throw new Error('Stopped lease accepted a late command');
    const revokedIds = journal.after(stopCursor).filter(event => event.kind === 'lease.revoked').map(event => event.id);
    if (!revokedIds.length) throw new Error('Missing lease revocation evidence');
    world.physics.velocity(TARGET_ID, vec());
    await world.advance(5);
    const lateApplications = journal.after(stopCursor).filter(event => event.kind === 'command.applied').length;
    stopReceipt = { requested_sim_ms: stopAt, completed_sim_ms: stopAt, status: 'completed',
      lease_revoked_event_ids: revokedIds, owner_after_stop: null, jobs_after_stop: stopped.jobs,
      stale_command: { rejected: true, error: staleError }, post_stop_sim_ms: world.simMs,
      command_applications_after_stop: lateApplications, drone_after_stop: world.physics.body(`${DRONE_ID}/base`) };
    if (frames.length !== FRAMES || lateApplications !== 0) throw new Error('Acquisition/Stop invariant failed');
  } finally {
    try { await port.stop(); } finally { world.close(); }
  }
  const diagnostics = journal.after();
  const lost = journal.cursor - diagnostics.length, truncated = diagnostics.filter(event => event.truncated).length;
  if (lost || truncated || !stopReceipt) throw new Error('World evidence incomplete or truncated');
  return { schema: 'jev-round3-world-v1', audience: 'evaluator-and-sensor-simulator-only',
    qualification: 'scripted-camera-acquisition-not-controller-evaluation',
    timing: 'offline-physics-trajectory-replayed-by-renderer-not-continuous-latency',
    spec: structuredClone(spec), physics: 'rapier', scene_config: scene.scene_config,
    camera_mount: scene.camera_mount, drone_script: scene.drone_script, target_script: scene.target_script,
    frames, command_receipts: commandReceipts, stop_receipt: stopReceipt, diagnostics,
    trace_coverage: { first_id: diagnostics[0]?.id ?? 0, last_id: journal.cursor, count: diagnostics.length, lost, truncated } };
}

/** Writes privileged trajectory inputs only; RGB/masks/depth are owned by the external renderer. */
export async function generateRoutes(options: { outDir: string; specs?: RouteSpec[] }) {
  const specs = structuredClone(options.specs ?? routeSpecs());
  if (!specs.length || specs.length > 12 || new Set(specs.map(s => s.id)).size !== specs.length) throw new Error('Expected 1–12 distinct bounded routes');
  specs.forEach(validateSpec);
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  // A retained start marker prevents silent reruns or replacement of interrupted evidence.
  await writeFile(join(outDir, 'started.json'), json({ schema: 'jev-round3-world-v1', specs, audience: 'evaluator-only', started_wall_iso: new Date().toISOString() }), { flag: 'wx' });
  const routes: { id: string; seed: number; split: string; family: string; frames: number; path: string; sha256: string }[] = [];
  for (const spec of specs) {
    const recording = await recordRoute(spec);
    const routeDir = join(outDir, spec.id);
    await mkdir(routeDir, { recursive: false });
    const contents = json(recording), path = `${spec.id}/trajectory.json`;
    await writeFile(join(outDir, path), contents, { flag: 'wx' });
    routes.push({ id: spec.id, seed: spec.seed, split: spec.split, family: spec.family, frames: recording.frames.length, path, sha256: sha256(contents) });
  }
  const manifest = { schema: 'jev-round3-world-manifest-v1', audience: 'evaluator-and-sensor-simulator-only',
    route_count: routes.length, frame_count: routes.reduce((n, route) => n + route.frames, 0), routes };
  await writeFile(join(outDir, 'manifest.json'), json(manifest), { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!args.includes('--run')) {
    console.log('Opt-in only: node experiments/jev-round3/world.ts --run [--out PATH]');
    console.log(json({ routes: routeSpecs(), note: 'Freeze the matrix before collecting scored routes. This command makes no predictions or paid inference.' }));
  } else {
    const outIndex = args.indexOf('--out');
    const outDir = outIndex < 0 ? '.runtime/experiments/jev-round3-v1/world' : args[outIndex + 1];
    if (!outDir || args.some((arg, index) => !['--run', '--out'].includes(arg) && index !== outIndex + 1)) throw new Error('Usage: --run [--out PATH]');
    const manifest = await generateRoutes({ outDir });
    console.log(json({ ...manifest, source_sha256: sha256(await readFile(new URL(import.meta.url))) }));
  }
}
