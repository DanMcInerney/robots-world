import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { colorTracker } from '../../src/perception/color-tracks.ts';
import { readFramePng } from '../../src/devices/pixel-camera.ts';
import { mapPixelAnswer, pixelRequest, type PixelArm, type PixelControlDesign } from './controller.ts';

export const percentile = (a: number[], p: number) => a.length ? [...a].sort((a, b) => a - b)[Math.ceil(p * a.length) - 1]! : null;
// Evidence is JSON. Preserve that representation for every reconstructed value.
const wireValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export async function pixelReport(directory: string, result: any, stats: any, design?: PixelControlDesign) {
  const decisions: any[] = [], byId = new Map<string, any>(), events: any[] = [], wire: any[] = [], commands: any[] = [];
  let manifest: any; const portRequests = new Map<string, any>();
  const source = createInterface({ input: createReadStream(resolve(directory, `${result.id}.jsonl`)), crlfDelay: Infinity });
  for await (const line of source) {
    const { kind, data, monoMs } = JSON.parse(line);
    if (kind === 'reactive.manifest') manifest = data;
    if (kind === 'pixels.request') { const d = { ...data, requestMonoMs: monoMs }; decisions.push(d); byId.set(data.decisionId, d); }
    if (kind === 'pixels.response') Object.assign(byId.get(data.decisionId) ?? {}, data);
    if (kind === 'pixels.mapping') Object.assign(byId.get(data.decisionId) ?? {}, { mapping: data });
    if (kind === 'reactive.port.request') portRequests.set(data.command.id, data.command);
    if (kind === 'reactive.command.admitted') commands.push(data);
    if (kind === 'reactive.camera.command') wire.push({ kind, ...data });
    if (kind === 'world.event' && data.channel === 'protocol') wire.push(data);
    if (['reactive.goal', 'reactive.expired', 'reactive.controller.failed', 'pixels.error', 'pixels.unavailable', 'reactive.command.rejected', 'reactive.command-link.drop', 'reactive.stimulus.turn'].includes(kind)) events.push({ kind, ...data });
  }
  // Replay EVERY recorded acquisition, not just frames a controller happened to consume.
  const frameDirectory = resolve(directory, 'frames', result.id), track = colorTracker(), replay = new Map<number, any>();
  const metadata = (await readdir(frameDirectory)).filter(f => f.endsWith('.json'));
  const ordered = await Promise.all(metadata.map(async f => ({ f, data: JSON.parse(await readFile(resolve(frameDirectory, f), 'utf8')) })));
  for (const { f, data } of ordered.sort((a, b) => a.data.acquiredMs - b.data.acquiredMs)) {
    const png = await readFile(resolve(frameDirectory, f.replace('.json', '.png')));
    assert.equal(createHash('sha256').update(png).digest('hex'), data.sha256);
    replay.set(data.acquiredMs, wireValue(track(readFramePng(png), data.calibration, data.acquiredMs)));
  }
  const feedback: unknown[] = [];
  for (const d of decisions) {
    const camera = d.observation.sensors.camera;
    assert.deepEqual(camera.value.objects, replay.get(camera.acquiredSimMs).objects, 'Pixel tracker evidence mismatch');
    assert.deepEqual(wireValue(design ? design.request(d.observation, result.arm, feedback) : pixelRequest(d.observation, result.arm as PixelArm, feedback)), d.request, 'Presented request mismatch');
    if (d.mapping) {
      // Compare the JSON wire representation: serialization turns -0 into 0.
      const expected = wireValue((design?.map ?? mapPixelAnswer)(d.request, d.response));
      assert.deepEqual(expected.action, d.mapping.action); assert.deepEqual(expected.selections, d.mapping.selections);
      const command = portRequests.get(d.decisionId); assert(command, 'Missing actual port command');
      const { duration, ...args } = expected.action; assert.deepEqual(command.args, args); assert.equal(command.validForMs, duration * 1000);
      assert.equal(command.basedOn.observation, d.observation.sequence);
      d.admission = commands.find(c => c.source.simMs === d.observation.simMs && isDeepStrictEqual(c.action, expected.action)) ?? null;
      const applied = d.admission ? wire.find(w => w.kind === 'reactive.camera.command' && w.commandId === d.admission.commandId) : null;
      d.firstApplication = applied ?? null;
      d.acquisitionToApplicationMs = applied ? applied.simMs - camera.acquiredSimMs : null;
      feedback.push({ selectedBodyVelocity: expected.bodyVelocity, heading: args.heading, pitch: args.pitch, receipt: d.mapping.receipt });
      if (feedback.length > 2) feedback.shift();
    }
  }
  const trajectory = result.evaluation.trajectory, start = trajectory[0]?.drone;
  const distance = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const unique = new Map<number, any>(); for (const d of decisions) unique.set(d.observation.sensors.camera.acquiredSimMs, d.observation.sensors.camera.value);
  const cameras = [...unique.values()], appliedAges = decisions.map(d => d.acquisitionToApplicationMs).filter(v => v !== null && v !== undefined);
  const metrics = { success: result.evaluation.success, framesAudited: replay.size, requestsAudited: decisions.length,
    pathM: trajectory.slice(1).reduce((n: number, f: any, i: number) => n + distance(f.drone, trajectory[i].drone), 0),
    maxDisplacementM: Math.max(0, ...trajectory.map((f: any) => distance(f.drone, start))),
    cameraBlueFraction: cameras.length ? cameras.filter(c => c.objects.some((o: any) => o.color === 'blue')).length / cameras.length : 0,
    movementFraction: stats.completed ? stats.moving / stats.completed : 0,
    perceptionP50Ms: percentile(cameras.map(c => c.perceptionMs), .5), perceptionP95Ms: percentile(cameras.map(c => c.perceptionMs), .95),
    apiP50Ms: percentile(stats.latencyMs, .5), apiP95Ms: percentile(stats.latencyMs, .95), appliedAgeP95Ms: percentile(appliedAges, .95),
    framingFraction: result.evaluation.phases.reduce((n: number, p: any) => n + p.framingFraction, 0) / result.evaluation.phases.length,
    collisionTicks: result.evaluation.collisionTicks, boundsTicks: result.evaluation.boundsTicks, tokens: stats.tokens,
    completed: stats.completed, errors: stats.errors, admitted: stats.admitted, rejected: stats.rejected };
  const run = { ...result, manifest, stats, metrics, decisions, wire, events, audit: { pixelReplay: true, exactRequests: true, exactMapping: true, note: 'Actual pixel replay and request/mapping reconstruction. No claim of semantic recognition or hardware accuracy.' } };
  await writeFile(resolve(directory, `${result.id}.report.json`), JSON.stringify(run));
  return { id: result.id, arm: result.arm, seed: result.seed, file: `${result.id}.report.json`, metrics };
}
