import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Command, Controller, Observation, Receipt, RobotPort, Vec3 } from '../../src/contracts.ts';
import { degrees, radians, wrapDegrees } from '../../src/devices/aim-camera.ts';
import { CAPABILITIES } from '../reactive/config.ts';
import type { Emit } from '../reactive/world.ts';
import { MODEL, choice, type Request, type Response } from '../jev-strategies/strategies.ts';

export const AXES = {
  'axes-raw': { label: 'Six controls / measured sensors', seconds: 3, description: 'Six parallel Choices. Fixed full options; no candidate forecasts, goal ranking or automatic camera aim.' },
  'axes-geometry': { label: 'Six controls / derived geometry', seconds: 3, description: 'Identical options and sensors, plus current rover-relative displacement and target bearing computed from delivered measurements. No candidate forecasts or ranking.' },
} as const;
export type AxesArm = keyof typeof AXES;
export type CommandFeedback = { command: Command; receipt: Receipt };
const VELOCITIES = [-1.1, -.6, -.2, 0, .2, .6, 1.1];
const YAW = [-90, -45, -15, -5, 0, 5, 15, 45, 90];
const PITCH = [-30, -10, -3, 0, 3, 10, 30];
export const COMBINATIONS = 7 ** 3 * 9 * 7 * 2;
const INSTRUCTIONS = `Control a stabilized camera drone to carry out state.goal in a changing world. You choose all six control channels in parallel; no question sees another answer. ENU: x east, y north, z up, metres and seconds. Each velocity is an absolute world-axis speed, NOT an acceleration or displacement. The three velocities combine directly without normalization (maximum combined speed 1.91 m/s). Camera heading is degrees, zero east, +90 north; pitch negative looks down. Camera deltas add once to the delivered camera angles, not to a future camera reading. The local servo stabilizes the supplied setpoints only. It does not follow the rover, aim the camera, choose paths, or avoid obstacles. Commands expire after 3 seconds into idealized local hold; a later answer replaces them. World, sensors, obstacles and radio continue during inference. Left/right/ahead/behind in the English goal refer to the rover heading, not world axes. Target data is a delayed cooperative broadcast, not perfect vision. Sparse range returns are not free-space certificates. Respect measurement validity and age. All offered options are fixed; code does not prune or rank them. An invalid or out-of-envelope composed command is rejected whole, with no replacement chosen by code. Unknown future motion is unavailable.`;
function options(values: number[], description: (value: number) => string) {
  return Object.fromEntries(values.map((value, index) => [`v${index}`, description(value)]));
}
function values(observation: Observation) {
  return { odometry: observation.sensors.odometry!.value as any, camera: observation.sensors.camera!.value as any, target: observation.sensors.target?.value as any };
}
/** Static coordinate conversion only. No action utility, target waypoint or optimal command. */
export function geometry(observation: Observation) {
  const { odometry, target } = values(observation);
  if (!observation.sensors.odometry!.valid || !observation.sensors.target?.valid || !target)
    return { available: false, reason: 'Valid delivered odometry and cooperative target measurement required' };
  const d: Vec3 = { x: odometry.position.x - target.position.x, y: odometry.position.y - target.position.y, z: odometry.position.z - target.position.z };
  const h = radians(target.headingDeg), planar = Math.hypot(d.x, d.y);
  return { available: true, basis: 'Current dated measurements only; no extrapolation. Positive left/ahead are relative to measured rover heading.',
    droneFromRover: { aheadM: d.x * Math.cos(h) + d.y * Math.sin(h), leftM: -d.x * Math.sin(h) + d.y * Math.cos(h), aboveM: d.z },
    separationM: Math.hypot(d.x, d.y, d.z),
    measuredTargetBearing: { headingDeg: degrees(Math.atan2(-d.y, -d.x)), pitchDeg: degrees(Math.atan2(-d.z, planar)) } };
}
export function axesRequest(observation: Observation, arm: AxesArm, feedback: CommandFeedback[] = []): Request {
  const questions: Request['questions'] = {};
  for (const [axis, name, negative, positive] of [['x', 'east/west', 'west', 'east'], ['y', 'north/south', 'south', 'north'], ['z', 'up/down', 'down', 'up']])
    questions[`velocity_${axis}`] = { type: 'choice', instructions: `${INSTRUCTIONS} Select ONLY the ${name} velocity to reach and maintain the requested rover-relative viewing position, avoiding collisions and altitude violations. Other questions set the other two velocities and camera.`, criteria: options(VELOCITIES, n => `${n === 0 ? 'Hold this axis: zero commanded speed' : `Move ${n < 0 ? negative : positive} ${Math.abs(n) === 1.1 ? 'briskly' : Math.abs(n) === .6 ? 'moderately' : 'slowly'} at ${Math.abs(n)} m/s`}. Exact world ${axis} velocity: ${n} m/s.`) };
  questions.camera_heading = { type: 'choice', instructions: `${INSTRUCTIONS} Select the camera heading change to acquire or keep the rover in the central half of the image. Other questions independently control translation and camera pitch/zoom.`, criteria: options(YAW, n => `${n === 0 ? 'Keep heading' : `Turn camera ${n < 0 ? 'clockwise' : 'counterclockwise'} by ${Math.abs(n)} degrees`}. Add ${n} degrees once to delivered camera heading, wrapping into [-180,180).`) };
  questions.camera_pitch = { type: 'choice', instructions: `${INSTRUCTIONS} Select the camera pitch change to acquire or keep the rover in the central half of the image. Other questions independently control translation and heading/zoom.`, criteria: options(PITCH, n => `${n === 0 ? 'Keep pitch' : `Tilt camera ${n < 0 ? 'down' : 'up'} by ${Math.abs(n)} degrees`}. Add ${n} degrees once to delivered camera pitch; actuator clips to [-85,45] degrees.`) };
  questions.camera_zoom = { type: 'choice', instructions: `${INSTRUCTIONS} Select camera horizontal field of view to acquire or keep the rover in the central half of the image. Other questions control translation and camera angles.`, criteria: { wide: '70 degrees horizontal field of view.', narrow: '35 degrees horizontal field of view.' } };
  const sensors = Object.fromEntries(['odometry', 'target', 'camera', 'ranges', 'contact'].map(id => [id, observation.sensors[id] ?? null]));
  const state = { goal: observation.goal, simMs: observation.simMs, observationSequence: observation.sequence, sensors,
    commandFeedback: feedback.slice(-3), feedbackMeaning: 'Last three exact submitted commands and tool receipts. Accepted means admitted, not necessarily applied or completed. A rejected command did not replace the previous admitted command.',
    capabilities: CAPABILITIES, representation: { channels: 6, jointTuples: COMBINATIONS, commandSeconds: 3, fullFixedOptions: true, note: 'Distinct tuples can map to identical physical angles at pitch limits. No raw motor or attitude control.' },
    ...(arm === 'axes-geometry' ? { derivedGeometry: geometry(observation) } : {}) };
  // Same precision and complete point clouds in both treatments. Original is separately recorded.
  return { model: MODEL, state: JSON.parse(JSON.stringify(state, (_k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)), questions };
}
export function compose(observation: Observation, request: Request, body: Response) {
  if (body.model !== MODEL) throw new Error('Unexpected Jev model');
  if (Object.keys(body.answers).sort().join() !== Object.keys(request.questions).sort().join()) throw new Error('Unexpected answer keys');
  const selections = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(body, id, Object.keys(q.criteria))]));
  const selectedNumber = (key: string, choices: number[]) => choices[Number(selections[key]!.slice(1))]!;
  // Map against the exact rounded angles supplied to Jev, never a fresh observation.
  const camera = (request.state as any).sensors.camera.value;
  const action = { mode: 'velocity' as const, x: selectedNumber('velocity_x', VELOCITIES), y: selectedNumber('velocity_y', VELOCITIES), z: selectedNumber('velocity_z', VELOCITIES),
    heading: wrapDegrees(camera.headingDeg + selectedNumber('camera_heading', YAW)), pitch: Math.max(-85, Math.min(45, camera.pitchDeg + selectedNumber('camera_pitch', PITCH))),
    hfov: selections.camera_zoom === 'wide' ? 70 : 35, duration: 3 };
  if (observation.sequence !== (request.state as any).observationSequence) throw new Error('Observation mismatch');
  return { selections, candidate: { id: Object.values(selections).join('-'), action, motion: 'Direct independent XYZ setpoints', camera: 'Direct heading/pitch increments and zoom', facts: {} } };
}

export function axesController(arm: string, key: string, emit: Emit, transport?: (request: Request, signal: AbortSignal) => Promise<Response>, profile?: { request(observation: Observation, feedback: CommandFeedback[]): Request; sourceSensor: string }) {
  if (!profile && !Object.hasOwn(AXES, arm)) throw new Error('Unknown controller representation');
  const stats = { started: 0, completed: 0, admitted: 0, rejected: 0, errors: 0, cancelled: 0, latencyMs: [] as number[], sourceAgeMs: [] as number[], usage: [] as any[], selectedIds: [] as string[], menuCounts: [] as number[] };
  const controller: Controller = { id: arm, async run(ports: readonly RobotPort[], signal: AbortSignal) {
    if (ports.length !== 1) throw new Error('This experiment requires one robot');
    const port = ports[0]!;
    const feedback: CommandFeedback[] = [];
    let goal: string | undefined, goalVersion = 0;
    try {
      while (!signal.aborted && stats.started < 300) {
        const observation = await port.observe();
        if (observation.goal !== goal) { goal = observation.goal; goalVersion++; }
        await port.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(p => p.id));
        const source = { simMs: observation.simMs, odometryMs: observation.sensors[profile?.sourceSensor ?? 'odometry']!.acquiredSimMs, goalVersion };
        const request = profile ? profile.request(observation, feedback) : axesRequest(observation, arm as AxesArm, feedback), decisionId = randomUUID(), started = performance.now();
        stats.started++; stats.menuCounts.push(COMBINATIONS);
        emit('axes.request', { id: decisionId, decisionId, strategy: arm, stage: 'initial', source, rawObservation: observation, rawFeedback: structuredClone(feedback), request });
        let body: Response;
        if (transport) body = await transport(request, signal);
        else {
          const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');
          const chunks: Uint8Array[] = []; let bytes = 0;
          for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 524288) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(part.value); }
          const raw = Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]');
          if (!response.ok) { emit('strategy.http-error', { id: decisionId, decisionId, stage: 'initial', status: response.status, raw, latencyMs: performance.now() - started }); throw new Error(`Jev HTTP ${response.status}`); }
          body = JSON.parse(raw);
        }
        const latencyMs = performance.now() - started;
        emit('strategy.response', { id: decisionId, decisionId, strategy: arm, stage: 'initial', body, latencyMs });
        if (body.usage) stats.usage.push(body.usage);
        signal.throwIfAborted();
        const mapping = compose(observation, request, body);
        stats.completed++; stats.latencyMs.push(latencyMs); stats.selectedIds.push(mapping.candidate.id);
        emit('axes.mapping', { decisionId, ...mapping });
        emit('strategy.selection', { decisionId, strategy: arm, source, choice: mapping.candidate.id, calls: 1, latencyMs, usage: body.usage, selections: mapping.selections });
        const { duration, ...args } = mapping.candidate.action;
        const command: Command = { id: decisionId, action: 'control', args, validForMs: duration * 1000, basedOn: { observation: observation.sequence, maxAgeMs: 5000 } };
        const receipt = await port.command(command);
        feedback.push({ command, receipt }); if (feedback.length > 3) feedback.shift();
        if (receipt.status === 'accepted' || receipt.status === 'completed') stats.admitted++; else stats.rejected++;
        await sleep(Math.max(0, 200 - (performance.now() - started)), undefined, { signal });
      }
      if (!signal.aborted) throw new Error('Decision capacity exhausted');
    } catch (error) { if (signal.aborted) { if (stats.started > stats.completed) stats.cancelled++; } else { stats.errors++; throw error; } }
  }};
  return { controller, stats };
}
