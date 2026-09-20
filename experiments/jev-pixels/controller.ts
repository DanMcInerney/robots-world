import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Controller, Observation } from '../../src/contracts.ts';
import type { Region } from '../../src/perception/color-tracks.ts';
import { wrapDegrees } from '../../src/devices/aim-camera.ts';
import { MODEL, choice, type Request, type Response } from '../jev-strategies/strategies.ts';
import type { Emit } from '../reactive/world.ts';

export const PIXEL_ARMS = {
  'pixels-numeric': { label: 'Numeric / six axes', description: 'Image bearings and apparent size as numeric fields. No history.' },
  'pixels-words': { label: 'Words / six axes', description: 'Identical current information expressed as left/right/up/down descriptions. No history.' },
  'pixels-history': { label: 'Words + history', description: 'Adds up to three prior pixel measurements and their ages. Six independent controls.' },
  'pixels-joint': { label: 'History + joint XY', description: 'Identical history; one Choice over all 49 forward/right velocity pairs replaces two independent axes.' },
  'pixels-conditional': { label: 'Conditional object controls', description: 'History; Jev selects search/hold/one observed object and all conditional control questions run in the same request.' },
} as const;
export type PixelArm = keyof typeof PIXEL_ARMS;
export const SPEEDS = [-1.1, -.6, -.2, 0, .2, .6, 1.1], YAW = [-90, -45, -15, -5, 0, 5, 15, 45, 90], PITCH = [-30, -10, -3, 0, 3, 10, 30];
export const CONTRACT = `You pilot a stabilized drone using dated RGB-camera observations. Carry out state.goal. Each region is only a color patch, not a recognized vehicle. Track IDs are tentative image associations. No GPS, position, object size in metres, range, depth, future path or map is supplied. Missing detection means unknown, not empty space. History is image-plane motion, affected by camera motion and zoom. Current heading and pitch are onboard estimates; heading is 0 east, +90 north, pitch negative down. Body forward/right velocities are converted using this delivered heading, then held in world axes until replaced. Vertical positive is up. Heading increments turn the body and camera together; positive turns left. Pitch positive tilts up. Each camera delta is applied once to the delivered angle. Local servos stabilize only; no aiming/following/avoidance script exists. The command lasts at most 1 second and is replaced by the next decision. Camera samples at 5 Hz; the world continues while you decide. Questions are independent; they cannot read other answers from this call. Choose a coherent immediate adjustment toward the goal using the full fixed controls. Camera and translation may operate together. Never infer precise world distances from apparent size. If the desired object is lost, you may choose camera or motion adjustments to look for it; there is no automatic search.`;
const positionWords = (r: { rightDeg: number; upDeg: number; widthPercent: number }) => ({
  horizontal: `${Math.abs(r.rightDeg)} degrees ${r.rightDeg < 0 ? 'left' : r.rightDeg > 0 ? 'right' : 'from centre'}`,
  vertical: `${Math.abs(r.upDeg)} degrees ${r.upDeg < 0 ? 'below' : r.upDeg > 0 ? 'above' : 'from centre'}`,
  width: `${r.widthPercent} percent of image width`,
});
export function pixelRequest(observation: Observation, arm: PixelArm, feedback: unknown[] = []): Request {
  if (!Object.hasOwn(PIXEL_ARMS, arm) || Object.keys(observation.sensors).join() !== 'camera' || observation.inbox.length) throw new Error('Undeclared evidence');
  const reading = observation.sensors.camera!, camera = reading.value as any;
  if (camera.kind !== 'color-regions-v1' || !reading.valid || camera.overflow) throw new Error('Camera unavailable or region overflow');
  const history = !['pixels-numeric', 'pixels-words'].includes(arm), regions = camera.objects as Region[];
  const objects = regions.map(r => ({ id: r.id, appearance: `${r.color} region`, clipped: r.clipped,
    ...(arm === 'pixels-numeric' ? { rightDeg: r.rightDeg, upDeg: r.upDeg, widthPercent: r.widthPercent } : positionWords(r)),
    ...(history ? { history: r.history.map(p => ({ ageMs: p.ageMs, ...positionWords(p) })) } : {}) }));
  const state = { goal: observation.goal, observationSequence: observation.sequence, simMs: observation.simMs,
    camera: { acquiredMs: reading.acquiredSimMs, ageMs: observation.simMs - reading.acquiredSimMs, headingDeg: Math.round(camera.headingDeg * 100) / 100, pitchDeg: Math.round(camera.pitchDeg * 100) / 100, hfovDeg: camera.hfovDeg },
    objects, range: 'unknown', semantics: 'rightDeg positive image-right; upDeg positive image-up; widthPercent is fraction of the full image width times 100. No ego-motion compensation.',
    recentToolReceipts: feedback.slice(-2), contract: CONTRACT };
  const questions: Request['questions'] = {};
  const add = (id: string, instructions: string, criteria: Record<string, string>) => { questions[id] = { type: 'choice', instructions: `Use state.contract and state.goal. ${instructions}`, criteria }; };
  const numbered = (values: number[], text: (n: number) => string) => Object.fromEntries(values.map((n, i) => [`v${i}`, text(n)]));
  const velocity = (axis: string, n: number) => `${axis} velocity ${n} m/s: ${n === 0 ? 'no motion along this axis' : `${Math.abs(n)} m/s ${axis === 'forward' ? n > 0 ? 'forward' : 'backward' : axis === 'right' ? n > 0 ? 'right' : 'left' : n > 0 ? 'up' : 'down'}`}`;
  function controls(prefix: string, context: string, joint = false) {
    if (joint) add(`${prefix}xy`, `${context} Choose the combined forward/right movement for the requested image size and following task.`, Object.fromEntries(SPEEDS.flatMap((x, i) => SPEEDS.map((y, j) => [`v${i}_${j}`, `${velocity('forward', x)}; ${velocity('right', y)}`]))));
    else for (const axis of ['forward', 'right']) add(`${prefix}${axis}`, `${context} Choose only body-${axis} velocity for the requested image size and following task.`, numbered(SPEEDS, n => velocity(axis, n)));
    add(`${prefix}up`, `${context} Choose only vertical velocity for the current visual task.`, numbered(SPEEDS, n => velocity('up', n)));
    add(`${prefix}yaw`, `${context} Choose camera/body heading adjustment to find and frame the intended object.`, numbered(YAW, n => n === 0 ? 'Keep heading' : `Turn ${Math.abs(n)} degrees ${n > 0 ? 'left / counterclockwise' : 'right / clockwise'}`));
    add(`${prefix}pitch`, `${context} Choose camera pitch adjustment to find and frame the intended object.`, numbered(PITCH, n => n === 0 ? 'Keep pitch' : `Tilt ${Math.abs(n)} degrees ${n > 0 ? 'up' : 'down'}`));
    add(`${prefix}zoom`, `${context} Choose camera field of view for the English task.`, { wide: 'Wide: 70 degrees horizontal field of view', narrow: 'Narrow: 35 degrees horizontal field of view' });
  }
  if (arm === 'pixels-conditional') {
    add('context', 'Choose what to do next to pursue the exact goal: search, hold, or control relative to one of the current observed regions. This selects which conditional control answers are applied.', { search: 'Search for the intended object using the independently chosen search controls', hold: 'Hold all motion and current camera settings', ...Object.fromEntries(objects.map(o => [`track_${o.id}`, `Pursue the goal using observed region ${o.id}: ${o.appearance}`])) });
    controls('search_', 'Assume the next action is searching for the intended object.');
    for (const o of objects) controls(`${o.id}_`, `Assume the next action uses observed region ${o.id} (${o.appearance}) as the intended object. Use that region's measurements.`);
  } else controls('', 'Select the intended object from the observed regions using the exact goal.', arm === 'pixels-joint');
  return { model: MODEL, state, questions };
}
export function mapPixelAnswer(request: Request, response: Response) {
  if (response.model !== MODEL || Object.keys(response.answers).sort().join() !== Object.keys(request.questions).sort().join()) throw new Error('Unexpected Jev response schema/model');
  const selections = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(response, id, Object.keys(q.criteria))]));
  const camera = (request.state as any).camera, context = selections.context;
  const prefix = context === 'search' ? 'search_' : context?.startsWith('track_') ? `${context.slice(6)}_` : '';
  const get = (id: string, values: number[]) => values[Number(selections[`${prefix}${id}`]!.slice(1))]!;
  let forward = 0, right = 0, up = 0, yaw = 0, pitch = 0, hfov = camera.hfovDeg;
  if (context !== 'hold') {
    if (selections.xy) { const [i, j] = selections.xy.slice(1).split('_').map(Number); forward = SPEEDS[i!]!; right = SPEEDS[j!]!; }
    else { forward = get('forward', SPEEDS); right = get('right', SPEEDS); }
    up = get('up', SPEEDS); yaw = get('yaw', YAW); pitch = get('pitch', PITCH); hfov = selections[`${prefix}zoom`] === 'wide' ? 70 : 35;
  }
  return { selections, bodyVelocity: [forward, right, up], action: pixelAction(camera, [forward, right, up], yaw, pitch, hfov) };
}
export function pixelAction(camera: { headingDeg: number; pitchDeg: number }, [forward, right, up]: number[], yaw: number, pitch: number, hfov: number) {
  const h = camera.headingDeg * Math.PI / 180;
  return { mode: 'velocity' as const, x: forward! * Math.cos(h) + right! * Math.sin(h), y: forward! * Math.sin(h) - right! * Math.cos(h), z: up!,
    heading: wrapDegrees(camera.headingDeg + yaw), pitch: Math.max(-85, Math.min(45, camera.pitchDeg + pitch)), hfov, duration: 1 };
}
export async function callJev(request: Request, key: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  const reader = response.body?.getReader(); if (!reader) throw new Error('No Jev response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 524288) { await reader.cancel(); throw new Error('Jev response exceeds bound'); } chunks.push(part.value); }
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}; no retry`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]'));
}
/** Experiment-local hooks; the world/port contracts remain controller-neutral. */
export type PixelControlDesign = {
  request(observation: Observation, arm: string, feedback: unknown[]): Request;
  map(request: Request, response: Response): ReturnType<typeof mapPixelAnswer>;
};
export function pixelController(arm: string, key: string, emit: Emit, transport = callJev, design?: PixelControlDesign, limits = {decisions:350,inputTokens:1_200_000}) {
  const stats = { started: 0, completed: 0, admitted: 0, rejected: 0, errors: 0, cancelled: 0, cameraUnavailable: 0, latencyMs: [] as number[], tokens: 0, moving: 0 };
  const controller: Controller = { id: arm, async run(ports, signal) {
    if (ports.length !== 1) throw new Error('One robot required');
    const port = ports[0]!, feedback: unknown[] = [];
    try {
      while (!signal.aborted && stats.started < limits.decisions) {
        const observation = await port.observe(); await port.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(p => p.id));
        if (!observation.sensors.camera?.valid || (observation.sensors.camera.value as any).overflow) { stats.cameraUnavailable++; emit('pixels.unavailable', { observation }); await sleep(100, undefined, { signal }); continue; }
        const request = design ? design.request(observation, arm, feedback) : pixelRequest(observation, arm as PixelArm, feedback), decisionId = randomUUID(), start = performance.now();
        stats.started++; emit('pixels.request', { decisionId, arm, observation, request });
        const response = await transport(request, key, signal), latencyMs = performance.now() - start;
        emit('pixels.response', { decisionId, response, latencyMs }); signal.throwIfAborted();
        const mapped = (design?.map ?? mapPixelAnswer)(request, response); stats.completed++; stats.tokens += response.usage?.input_tokens ?? 0; stats.latencyMs.push(latencyMs);
        if (mapped.bodyVelocity.some(n => n !== 0)) stats.moving++;
        const { duration, ...args } = mapped.action;
        const receipt = await port.command({ id: decisionId, action: 'control', args, validForMs: duration * 1000, basedOn: { observation: observation.sequence, maxAgeMs: 1000 } });
        emit('pixels.mapping', { decisionId, ...mapped, receipt });
        feedback.push({ selectedBodyVelocity: mapped.bodyVelocity, heading: args.heading, pitch: args.pitch, receipt }); if (feedback.length > 2) feedback.shift();
        if (receipt.status === 'accepted' || receipt.status === 'completed') stats.admitted++; else stats.rejected++;
        if (stats.tokens > limits.inputTokens) throw new Error('Per-flight token budget exceeded');
        await sleep(Math.max(0, 250 - (performance.now() - start)), undefined, { signal });
      }
      if (!signal.aborted) throw new Error('Decision capacity exhausted');
    } catch (error) { if (signal.aborted) stats.cancelled += Number(stats.started > stats.completed); else { stats.errors++; emit('pixels.error', { error: String(error) }); throw error; } }
  } };
  return { controller, stats };
}
