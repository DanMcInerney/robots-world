import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BENCH_CONFIG, BENCH_MISSION, buildBenchRequest, YawBenchPlant, runBench, benchScene, type Acquisition, type BenchRequest, type BenchResponse } from '../experiments/jev-spatial-text/bench.ts';
import { renderCamera, readFramePng } from '../src/devices/pixel-camera.ts';
import { colorRegions, colorTracker } from '../src/perception/color-tracks.ts';
import { createMeter, durable, digest, ledger, readCompleted, validateRequest } from '../experiments/jev-spatial-text/transport.ts';
import { GEOMETRY_HEADS, GEOMETRY_REPRESENTATIONS } from '../experiments/jev-spatial-refinement/geometry.ts';
import { LIVE_PLAN, LIVE_PROTOCOL, liveEvidenceEntries } from '../experiments/jev-spatial-refinement/live.ts';
import { adaptLiveRequest, createLiveJudge, mapLiveResponse, measuredGeometry, parseLiveSelection } from '../experiments/jev-spatial-refinement/live-adapter.ts';

function fixtureRequest(heading = 0, accepted = 0) {
  const k = { fx: 320 / (2 * Math.tan(35 * Math.PI / 180)), fy: 320 / (2 * Math.tan(35 * Math.PI / 180)), cx: 160, cy: 90 };
  const a: Acquisition = { id: 'fixture-image', acquiredMs: 200, acquiredWallMs: 1000, deliveredWallMs: 1001, headingDeg: heading, attitudeErrorBoundDeg: .05, frame: 'fixture.png', sha256: 'fixture-only', calibration: k, overflow: 0,
    objects: [{ id: 'blue1', color: 'blue', box: [190, 78, 212, 101], pixels: 506, rightDeg: 10.17, upDeg: 0, widthPercent: 6.875, clipped: false, history: [] }] };
  const p = new YawBenchPlant(); p.lastAcceptedHeadingDeg = accepted;
  return buildBenchRequest('receipt', a, 220, 1020, p, [a]);
}
function reply(request: BenchRequest, yaw = 'retain'): BenchResponse {
  return { model: request.model, usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const choice = id === 'yaw' ? yaw : 'unknown'; return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }];
  })) };
}
function temporary(t: { after(fn: () => void): void }) {
  const root = resolve(tmpdir()), directory = mkdtempSync(join(root, 'refinement-live-'));
  t.after(() => { assert(resolve(directory).startsWith(root + sep)); assert(directory.split(sep).at(-1)!.startsWith('refinement-live-')); rmSync(directory, { recursive: true, force: true }); }); return directory;
}

test('live plan is16 fresh balanced mirrored episodes, with common frozen task and complete yaw menus', () => {
  assert.equal(LIVE_PLAN.length, 16); assert.equal(new Set(LIVE_PLAN.map(t => t.id)).size, 16);
  assert.equal(new Set(LIVE_PLAN.map(t => t.seed)).size, 8);
  for (const pattern of new Set(LIVE_PLAN.map(t => t.pattern))) {
    const rows = LIVE_PLAN.filter(t => t.pattern === pattern); assert.equal(rows.length, 4); assert.equal(rows[0]!.condition, rows[3]!.condition); assert.equal(rows[1]!.condition, rows[2]!.condition);
    assert.equal(rows[0]!.seed + 1, rows[2]!.seed); assert(rows.every(t => t.seconds === 20));
    for (const seed of new Set(rows.map(t => t.seed))) {
      const r = renderCamera(benchScene(seed, pattern, 0), [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
      const blue = colorRegions(r.image, r.calibration).filter(r => r.color === 'blue'); assert.equal(blue.length, 1); assert.equal(blue[0]!.clipped, false);
    }
  }
  assert.match(LIVE_PROTOCOL.termination, /setImmediate/); assert.match(LIVE_PROTOCOL.transfer, /not verbatim/);
  const base = fixtureRequest(), original = JSON.stringify(base);
  for (const representation of GEOMETRY_REPRESENTATIONS) for (const heads of GEOMETRY_HEADS) {
    const selection = parseLiveSelection(`${representation}__${heads}`), baseline = adaptLiveRequest(base, 'receipt-baseline', selection), selected = adaptLiveRequest(base, 'selected-representation', selection);
    assert.deepEqual(baseline, base); assert.equal(selected.state.goal, BENCH_MISSION); assert.deepEqual(selected.state.componentObjective, base.state.componentObjective);
    assert.deepEqual(selected.questions.yaw, base.questions.yaw); assert.equal(Object.keys(selected.questions).length, heads === 'action-only' ? 1 : 8);
    validateRequest(selected); assert.equal(JSON.stringify(base), original);
  }
});

test('geometry uses measured pixels and attitude only, preserves retain semantics and positive-left yaw sign', () => {
  const base = fixtureRequest(179, -179), measured = measuredGeometry(base); assert(measured.available);
  const left = measured.consequences.find(c => c.action === 'left_10')!, right = measured.consequences.find(c => c.action === 'right_10')!, retain = measured.consequences.find(c => c.action === 'retain')!;
  assert.equal(left.final_absolute_heading_left_deg, -171); assert.equal(left.actual_yaw_left_deg, 10); assert.equal(retain.actual_yaw_left_deg, 2);
  assert(left.after_image_right_bearing_deg! > measured.current!.center_image_right_deg); assert(right.after_image_right_bearing_deg! < measured.current!.center_image_right_deg);
  const changed = structuredClone(base); (changed.state.snapshot as any).objects[0].rightDeg = -999;
  changed.state.goal = 'unrelated goal'; changed.state.evaluator = { futureTargetPosition: [999, 999, 999], bestAction: 'left_30' };
  assert.deepEqual(measuredGeometry(changed), measured);
  const raw = adaptLiveRequest(base, 'selected-representation', parseLiveSelection('raw__action-only'));
  assert.equal((raw.state.liveGeometry as any).declaredComputation, undefined);
  assert.equal((raw.state.liveGeometry as any).current.remaining_accepted_yaw_left_deg, undefined);
  const relations = adaptLiveRequest(base, 'selected-representation', parseLiveSelection('current-relations__action-only'));
  assert.equal((relations.state.liveGeometry as any).declaredComputation.accepted_setpoint_remaining_yaw_left_deg, 2);
});

test('conditional rectangle projections are mirror-equivariant for every action including retained unfinished turns', () => {
  const base = fixtureRequest(175, -178), mirror = fixtureRequest(-175, 178), box = (base.state.snapshot as any).objects[0].box;
  (mirror.state.snapshot as any).objects[0].box = [320 - box[2], box[1], 320 - box[0], box[3]];
  const a = measuredGeometry(base), b = measuredGeometry(mirror);
  for (const value of a.consequences) {
    const action = value.action.replace('left', 'TEMP').replace('right', 'left').replace('TEMP', 'right'), other = b.consequences.find(c => c.action === action)!;
    assert(Math.abs(value.actual_yaw_left_deg + other.actual_yaw_left_deg) < 1e-6);
    assert(Math.abs(value.after_image_right_bearing_deg! + other.after_image_right_bearing_deg!) < 1e-6);
    assert.equal(value.entire_target_rectangle_inside_view, other.entire_target_rectangle_inside_view);
    const p = value.projected_pixel_rectangle!, q = other.projected_pixel_rectangle!;
    assert(Math.abs(p[0]! + q[2]! - 320) < 1e-6); assert(Math.abs(p[2]! + q[0]! - 320) < 1e-6); assert.equal(p[1], q[1]); assert.equal(p[3], q[3]);
  }
});

test('measured pixel reprojection matches a separately rendered stationary scene within raster resolution', () => {
  const track = colorTracker(), scene = benchScene(7100, 'stationary-offset', 0), before = renderCamera(scene, [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
  const measured = track(before.image, before.calibration, 0), a = { ...fixtureRequest().state.snapshot as any, id: 'rendered-acquisition', acquiredMs: 0, objects: measured.objects, headingDeg: 0 };
  const request = fixtureRequest(); request.state.snapshot = a; (request.state.camera as any).calibration = before.calibration;
  for (const value of measuredGeometry(request).consequences.filter(c => c.projected_pixel_rectangle && c.entire_target_rectangle_inside_view)) {
    const after = renderCamera(scene, [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg: value.final_absolute_heading_left_deg, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
    const blue = colorRegions(after.image, after.calibration).find(r => r.color === 'blue')!;
    assert(Math.abs(blue.box[0] - value.projected_pixel_rectangle![0]!) <= 2); assert(Math.abs(blue.box[2] - value.projected_pixel_rectangle![2]!) <= 2);
  }
});

test('missing, ambiguous, clipped, overflowing or invalid sensor geometry stays unknown', () => {
  for (const mutate of [
    (r: any) => { r.state.snapshot.objects = []; },
    (r: any) => { r.state.snapshot.objects.push(structuredClone(r.state.snapshot.objects[0])); },
    (r: any) => { r.state.snapshot.objects[0].clipped = true; },
    (r: any) => { r.state.snapshot.overflow = 25; },
    (r: any) => { r.state.camera.calibration.fx = 0; },
    (r: any) => { r.state.controls.acquiredHeadingDeg = 999; },
  ]) {
    const base = fixtureRequest(); mutate(base); const geometry = measuredGeometry(base); assert.equal(geometry.available, false); assert.deepEqual(geometry.consequences, []);
    const request = adaptLiveRequest(base, 'selected-representation', parseLiveSelection('after-relations__action-and-forecasts'));
    assert((request.state.liveGeometry as any).conditionalData.every((c: any) => c.status === 'unknown'));
    for (const [id, q] of Object.entries(request.questions)) if (id !== 'yaw') assert(q.criteria.unknown);
  }
});

test('forecast answers are independently named and never replace or influence the original yaw choice', () => {
  const base = fixtureRequest(), wire = adaptLiveRequest(base, 'selected-representation', parseLiveSelection('after-bearing__action-and-forecasts')), answer = reply(wire, 'right_3');
  for (const [id, q] of Object.entries(wire.questions)) if (id !== 'yaw') { const action = id.replace('geometry_forecast_', ''); assert(q.instructions.includes(`specifically for action ${action}`)); assert.match(q.instructions, /not a prediction at the engine200ms/); }
  const mapped = mapLiveResponse(base, wire, answer); assert.deepEqual(Object.keys(mapped.answers), ['yaw']); assert.deepEqual(mapped.answers.yaw, answer.answers.yaw);
  const changed = structuredClone(answer); for (const [id, a] of Object.entries(changed.answers)) if (id !== 'yaw') { a.choice = 'left'; a.probabilities = Object.fromEntries(Object.keys(a.probabilities).map(k => [k, k === 'left' ? 1 : 0])); }
  assert.deepEqual(mapLiveResponse(base, wire, changed), mapped);
  delete changed.answers.geometry_forecast_retain; assert.throws(() => mapLiveResponse(base, wire, changed));
});

test('actual adapted wire is metered and late mapped response reaches its sink before the final inventory', async t => {
  const root = temporary(t), id = 'late-live', directory = join(root, 'episodes', id), selection = parseLiveSelection('after-bearing__action-and-forecasts');
  let release!: (r: any) => void, captured!: BenchRequest;
  const meter = createMeter({ root, key: '', limits: { requests: 3000, inputTokens: 25_000_000, requestsPerSecond: 2 }, send: async request => { captured = request as BenchRequest; return new Promise(resolve => { release = resolve; }); } });
  try {
    const adapter = createLiveJudge({ condition: 'selected-representation', selection, directory, send: (request, id) => meter.judge(request, id) as Promise<BenchResponse> });
    const summary = await runBench({ id, arm: 'receipt', seed: 7100, pattern: 'stationary-offset', seconds: .12, outputDir: join(root, 'episodes'), judge: adapter.judge });
    assert.equal(summary.status, 'completed'); assert(summary.pendingAtStop); assert.equal(summary.commandCounts.accepted, 0);
    assert(captured.state.liveGeometry); assert.equal(Object.keys(captured.questions).length, 8);
    release(reply(captured, 'left_30')); const settled = await adapter.drain(); assert.deepEqual(settled.errors, []); assert.equal(settled.sinks.length, 1); assert(settled.sinks[0]!.path.endsWith('.late.json'));
    const requestId = settled.requestIds[0]!, wire = await readCompleted(captured, requestId, ledger(root)[0], root);
    const engine = JSON.parse(readFileSync(join(directory, `${requestId}.request.json`), 'utf8')); assert.equal(Object.keys(engine.questions).length, 1);
    assert.notEqual(digest(JSON.stringify(captured)), digest(JSON.stringify(engine)));
    const late = JSON.parse(readFileSync(join(directory, `${requestId}.late.json`), 'utf8')); assert(late.discarded); assert.deepEqual(late.answer, mapLiveResponse(engine, captured, wire as BenchResponse));
    const files = await liveEvidenceEntries(directory); assert(files.some(f => f.path === `${requestId}.late.json`));
    durable(join(directory, 'finalization.json'), { requestIds: settled.requestIds, files }, true);
    await new Promise(r => setTimeout(r, 40)); assert.deepEqual(await liveEvidenceEntries(directory), files);
    assert.equal(JSON.parse(readFileSync(join(directory, 'commands.json'), 'utf8')).length, 0);
  } finally { meter.close(); }
});

test('missing engine normal/late sink is an explicit finalization failure', async t => {
  const directory = temporary(t), request = fixtureRequest(), adapter = createLiveJudge({ condition: 'selected-representation', selection: parseLiveSelection('raw__action-only'), directory, send: async wire => reply(wire) });
  await adapter.judge(request, 'no-engine-sink'); const result = await adapter.drain(); assert.equal(result.errors.length, 1); assert.match(result.errors[0]!, /settled engine response\/late sink/);
});

test('live adapter20-second realtime qualification retains wire mapping and image provenance', { skip: process.env.JEV_REFINEMENT_LIVE_20S !== '1' }, async t => {
  const root = process.env.JEV_REFINEMENT_LIVE_OUTPUT ?? temporary(t), id = `adapter-clock-${Date.now()}`, directory = join(root, id), selection = parseLiveSelection('after-bearing__action-only');
  let calls = 0;
  const adapter = createLiveJudge({ condition: 'selected-representation', selection, directory, send: async request => { await new Promise(r => setTimeout(r, 70)); return reply(request, ++calls === 1 ? 'left_10' : 'retain'); } });
  const summary = await runBench({ id, arm: 'receipt', seed: 7130, pattern: 'interrupted-command', seconds: 20, outputDir: root, judge: adapter.judge });
  const settled = await adapter.drain(); assert.deepEqual(settled.errors, []); assert.equal(summary.status, 'completed', summary.error ?? '');
  assert.equal(summary.simulatedMs, 20_000); assert.equal(summary.acquisitions, 101); assert(summary.wallMs >= 20_000 && summary.wallMs < 21_000); assert(summary.calls <= 40); assert(summary.maxPacingLagMs <= BENCH_CONFIG.maxSchedulerLagMs);
  assert.equal(settled.requestIds.length, summary.calls); assert.equal(settled.sinks.length, summary.calls);
  const events = readFileSync(join(directory, 'trace.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)), tracker = colorTracker();
  for (const event of events.filter(e => e.kind === 'acquisition')) {
    const a = event.data as Acquisition; assert.deepEqual(tracker(readFramePng(await readFile(join(directory, a.frame))), a.calibration, a.acquiredMs).objects, a.objects);
  }
  assert.equal(readdirSync(join(directory, 'frames')).length, 202);
  const files = await liveEvidenceEntries(directory);
  durable(join(directory, 'qualification.json'), { kind: 'Offline fake judge only; not the global real API meter', selection, summary, settled, files }, true);
  console.log(JSON.stringify({ qualification: '20s measured adapter, synthetic fixture judge only', directory, wallMs: summary.wallMs, acquisitions: summary.acquisitions, calls: summary.calls, maxLagMs: summary.maxPacingLagMs }));
});
