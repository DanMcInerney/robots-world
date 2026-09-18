import { createHash } from 'node:crypto';
import type { Vec3 } from '../../src/contracts.ts';
import { add, clamp, distance, norm, scale, sub, vec } from '../../src/math.ts';
import { degrees, projectPoint, radians, wrapDegrees } from '../../src/devices/aim-camera.ts';
import type { FlightAction } from '../flight-contract.ts';
import { CAPABILITIES, DEFAULT_CONFIG, type ExperimentConfig } from './config.ts';

export type Relation = 'left' | 'right' | 'ahead' | 'behind';
export type Arm = 'jev-bare' | 'jev-facts' | 'claude-facts' | 'codex-facts' | 'jev-brief' | 'jev-repair';
export type Timed<T> = { acquiredMs: number; receivedMs: number; valid: boolean; value: T };
export type Target = { position: Vec3; velocity: Vec3; headingDeg: number };
export interface ReactiveState {
  goal: string; goalVersion: number; goalReceivedMs: number; simMs: number;
  odometry: Timed<{ position: Vec3; velocity: Vec3 }>;
  target: Timed<Target> | null;
  camera: Timed<{ headingDeg: number; pitchDeg: number; hfovDeg: number; detections: unknown[] }>;
  ranges: Timed<{ points: Vec3[]; origin: Vec3; maxRange: number; rayCount: number }>;
  touching: boolean;
  lastActions: { admittedMs: number; action: FlightAction; goalVersion: number }[];
}
export const CONTRACT = `ENU coordinates in metres, x east, y north, z up; angles in degrees, heading 0 east and +90 north, camera pitch negative down. Choose exactly one offered complete maneuver. It sets a constant world velocity for the declared command lifetime, and absolute camera heading/pitch/zoom. A later decision can replace it. The local servo only stabilizes and approaches setpoints; it never follows, aims, chooses routes, or avoids obstacles by itself. Commands expire into hover. All physics, obstacles, sensing and radio continue while inference runs. The rover may change speed and heading at any time. Only dated delivered measurements are supplied. The declared sensor configuration states whether cooperative rover broadcasts are available. Missing beacons mean unknown pose; detections are simulated noisy geometric points, not RGB perception. Range returns are sparse noisy points, not a complete map; no hit does not establish safe passage. Candidate camera angles toward a target are calculated once from this observation and a short constant-velocity extrapolation, not continuously updated tracking. Predictions are estimates: unknown obstacles, acceleration, delayed commands and target turns can invalidate them. Camera projection is geometric, not a promise of visibility or unoccluded line of sight. Directions left/right/ahead/behind in the goal are relative to the rover's current heading. English goal updates supersede prior instructions. In menu-choice arms, no tools or external information. Representation settings describe a discretization of the robot capabilities, not the full control space.`;
export function goalFor(relation: Relation, config: ExperimentConfig = DEFAULT_CONFIG) {
  const view = { left: 'left-hand side', right: 'right-hand side', ahead: 'front (ahead of its heading)', behind: 'rear (behind its heading)' }[relation];
  return `Film the blue survey rover from its ${view} as it moves unpredictably. Reach that viewing position, 2.5 to 6 metres from its centre, keep its centre within the central half of the camera image, and continue filming from that position as it turns. Maintain the requested side, distance and central framing together for at least ${config.scoring.minimumFramingFraction * 100}% of each goal phase after the initial ${config.scoring.warmupMs / 1000} seconds, including at least ${config.scoring.minimumDwellMs / 1000} continuous seconds. Avoid every collision. Stay inside x,y +/-18 metres and altitude 0.7 to 6 metres. The environment does not pause. Choose your next maneuver using the newest received measurements. There is no automatic follow or inspection action.`;
}
export type Candidate = { id: string; action: FlightAction; motion: string; camera: string; facts: Record<string, unknown> };
export type Menu = { state: Record<string, unknown>; candidates: Candidate[]; criteria: Record<string, unknown>; hash: string; config: ExperimentConfig; source: { simMs: number; odometryMs: number; goalVersion: number } };
const round = (n: number) => Math.round(n * 100) / 100;
const rounded = (p: Vec3) => ({ x: round(p.x), y: round(p.y), z: round(p.z) });
const angle = (a: number) => round(wrapDegrees(a));

/** Same servo gains and integration interval as the simplified plant. Still an estimate. */
export function predict(position: Vec3, velocity: Vec3, command: Vec3, seconds = 1.5, mode: 'velocity' | 'position' = 'velocity') {
  let p = { ...position }, v = { ...velocity };
  const path = [p];
  for (let t = 0; t < seconds - 1e-6; t += .02) {
    const dt = Math.min(.02, seconds - t);
    let desired = mode === 'position' ? scale(sub(command, p), CAPABILITIES.positionGain) : command;
    if (norm(desired) > CAPABILITIES.maxSpeedMps) desired = scale(desired, CAPABILITIES.maxSpeedMps / norm(desired));
    let a = scale(sub(desired, v), CAPABILITIES.velocityGain);
    if (norm(a) > CAPABILITIES.maxAccelerationMps2) a = scale(a, CAPABILITIES.maxAccelerationMps2 / norm(a));
    v = add(v, scale(a, dt)); p = add(p, scale(v, dt)); path.push(p);
  }
  return path;
}
export function forecast(s: ReactiveState, action: FlightAction, config = DEFAULT_CONFIG, seconds = action.duration, delayMs = 100 + config.link.latencyMs + config.link.jitterMs + 20) {
  const ageMs = s.simMs - s.odometry.acquiredMs;
  const ageValid = s.odometry.valid && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 120;
  // Unknown motion during sample age / stream wait / transport is bounded by maximum speed.
  // Include body extent and measurement error. This is an envelope check, never a route planner.
  const marginM = .2 + config.sensors.odometryNoiseM + CAPABILITIES.maxSpeedMps * (Math.max(0, ageMs) + delayMs) / 1000;
  const path = predict(s.odometry.value.position, s.odometry.value.velocity, action, seconds, action.mode === 'position' ? 'position' : 'velocity');
  const e = CAPABILITIES.envelope;
  const safe = ageValid && path.every(p => [p.x, p.y, p.z].every(Number.isFinite) && p.z >= e.minZM + marginM && p.z <= e.maxZM - marginM && Math.abs(p.x) <= e.xyM - marginM && Math.abs(p.y) <= e.xyM - marginM);
  return { path, marginM, delayMs, ageMs, safe };
}
const signedDescription = (forward: number, left: number, up: number) => `${Math.abs(round(forward))}m ${forward >= 0 ? 'ahead' : 'behind'}; ${Math.abs(round(left))}m ${left >= 0 ? 'left' : 'right'}; ${Math.abs(round(up))}m ${up >= 0 ? 'above' : 'below'} rover`;

/** Enumeration/measurement only. Changing the goal cannot change, sort or rank candidates. */
export function makeMenu(s: ReactiveState, facts = true, config: ExperimentConfig = DEFAULT_CONFIG): Menu {
  const p = s.odometry.value.position, v = s.odometry.value.velocity;
  const freshTarget = s.target?.valid && s.simMs - s.target.acquiredMs <= 1000 ? s.target : null;
  const targetNow = freshTarget ? add(freshTarget.value.position, scale(freshTarget.value.velocity, (s.simMs - freshTarget.acquiredMs) / 1000)) : null;
  const futureTarget = targetNow ? add(targetNow, scale(freshTarget!.value.velocity, config.commandSeconds)) : null;
  const thetaNow = freshTarget ? radians(freshTarget.value.headingDeg) : 0, currentOffset = targetNow ? sub(p, targetNow) : null;
  const currentForward = currentOffset ? currentOffset.x * Math.cos(thetaNow) + currentOffset.y * Math.sin(thetaNow) : 0;
  const currentLeft = currentOffset ? -currentOffset.x * Math.sin(thetaNow) + currentOffset.y * Math.cos(thetaNow) : 0;
  const cloud = s.ranges.valid && s.simMs - s.ranges.acquiredMs <= 500 ? s.ranges.value.points : [];
  const velocities = [vec()];
  for (const speed of config.representation.speeds) for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    const d = vec(x, y, z); if (norm(d)) velocities.push(scale(d, speed / norm(d)));
  }
  const candidates: Candidate[] = [];
  velocities.forEach((velocity, index) => {
    const preview = forecast(s, { mode: 'velocity', ...rounded(velocity), heading: 0, pitch: 0, hfov: 70, duration: config.commandSeconds }, config);
    const path = preview.path, end = path.at(-1)!;
    // No obstacle/goal filtering. Commands must respect the same declared flight envelope.
    if (!preview.safe) return;
    const proximity = cloud.length ? Math.min(...path.map(p => Math.min(...cloud.map(hit => distance(p, hit))))) : null;
    const offset = futureTarget ? sub(end, futureTarget) : null, theta = freshTarget ? radians(freshTarget.value.headingDeg) : 0;
    const forward = offset ? offset.x * Math.cos(theta) + offset.y * Math.sin(theta) : null;
    const left = offset ? -offset.x * Math.sin(theta) + offset.y * Math.cos(theta) : null;
    const cameraOptions = [
      { name: 'keep current camera angles, wide', heading: s.camera.value.headingDeg, pitch: s.camera.value.pitchDeg, hfov: 70 },
      { name: 'keep current camera angles, zoom', heading: s.camera.value.headingDeg, pitch: s.camera.value.pitchDeg, hfov: 35 },
    ];
    if (futureTarget) {
      const d = sub(futureTarget, end);
      for (const hfov of [70, 35]) cameraOptions.push({ name: `point toward measured/extrapolated rover once, ${hfov === 70 ? 'wide' : 'zoom'}`, heading: degrees(Math.atan2(d.y, d.x)), pitch: Math.max(-85, Math.min(45, degrees(Math.atan2(d.z, Math.hypot(d.x, d.y))))), hfov });
    } else {
      for (const delta of [-45, 45]) cameraOptions.push({ name: `rotate camera ${delta} degrees to search`, heading: s.camera.value.headingDeg + delta, pitch: -25, hfov: 70 });
    }
    cameraOptions.forEach((camera, c) => {
      const action: FlightAction = { mode: 'velocity', ...rounded(velocity), heading: angle(camera.heading), pitch: round(camera.pitch), hfov: camera.hfov, duration: config.commandSeconds };
      const projection = futureTarget ? projectPoint(end, futureTarget, action.heading, action.pitch, action.hfov) : null;
      const motion = norm(velocity) === 0 ? 'hover' : `${round(norm(velocity))}m/s: ${[velocity.x === 0 ? '' : velocity.x > 0 ? 'east' : 'west', velocity.y === 0 ? '' : velocity.y > 0 ? 'north' : 'south', velocity.z === 0 ? '' : velocity.z > 0 ? 'up' : 'down'].filter(Boolean).join(', ')}`;
      const fact = { horizonS: config.commandSeconds, marginM: preview.marginM, maximumDispatchDelayMs: preview.delayMs, endENU: rounded(end), roverRelative: offset ? signedDescription(forward!, left!, offset.z) : 'unknown', rangeM: offset ? round(norm(offset)) : null,
        relativeChange: offset ? `${Math.abs(round(forward! - currentForward))}m ${forward! >= currentForward ? 'forward' : 'rearward'}; ${Math.abs(round(left! - currentLeft))}m ${left! >= currentLeft ? 'leftward' : 'rightward'} in rover frame` : 'unknown',
        nearestObservedReturnM: proximity === null ? null : round(proximity), projectedCentre: projection ? { u: round(clamp(projection.u, 99)), v: round(clamp(projection.v, 99)), inFrame: projection.inFrame } : null };
      candidates.push({ id: `m${index}c${c}`, action, motion, camera: camera.name, facts: fact });
    });
  });
  if (candidates.length > 255) throw new Error('Menu too large');
  const criteria = Object.fromEntries(candidates.map(c => [c.id, {
    do: `${c.motion}; ${c.camera}`,
    velocityENU: [c.action.x, c.action.y, c.action.z], cameraHeadingPitchFov: [c.action.heading, c.action.pitch, c.action.hfov],
    ...(facts ? { estimate: { horizonS: c.facts.horizonS, afterCommandLifetime: c.facts.roverRelative, envelopeMarginM: c.facts.marginM, maximumDispatchDelayMs: c.facts.maximumDispatchDelayMs, change: c.facts.relativeChange, roverRangeM: c.facts.rangeM, nearestObservedReturnM: c.facts.nearestObservedReturnM, imageCentre: c.facts.projectedCentre } } : {}),
  }]));
  // Whitelist public data. No accidental serialization of future scenario/evaluator fields.
  const state = { capabilities: structuredClone(CAPABILITIES), representation: { directions: '26 normalized XYZ directions plus hover', speedsMps: config.representation.speeds, cameraOptionsPerMotion: 4, commandSeconds: config.commandSeconds }, sensorAssumptions: config.sensors, goal: s.goal, goalVersion: s.goalVersion, goalReceivedMs: s.goalReceivedMs, simMs: s.simMs, odometry: s.odometry, target: freshTarget, camera: s.camera, ranges: s.ranges, touching: s.touching, lastActions: s.lastActions,
    ...(facts ? { measuredCurrentGeometry: { source: 'delivered odometry and beacon only', roverRelative: currentOffset ? signedDescription(currentForward, currentLeft, currentOffset.z) : 'unknown', rangeM: currentOffset ? round(norm(currentOffset)) : null } } : {}) };
  return { state, candidates, criteria, config, hash: createHash('sha256').update(JSON.stringify(criteria)).digest('hex'), source: { simMs: s.simMs, odometryMs: s.odometry.acquiredMs, goalVersion: s.goalVersion } };
}
export const CHOICE_SCHEMA = { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string' } } };
export function selected(value: unknown, menu: Menu) {
  const choice = (value as { choice?: unknown })?.choice;
  const candidate = menu.candidates.find(c => c.id === choice); if (!candidate) throw new Error('Unoffered candidate'); return candidate;
}
