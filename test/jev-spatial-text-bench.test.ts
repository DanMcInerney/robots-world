import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BENCH_ARMS, BENCH_CONFIG, BENCH_MISSION, BENCH_PATTERNS, YAW_ACTIONS, YawBenchPlant, benchScene, benchTickPlan, benchDispatchBlock, buildBenchRequest, componentObjective, coverage, deriveOutcome, headingTarget, historyFacts, observedCategory, runBench, scoreCoverage, validateBenchResponse, yawStep, type Acquisition, type BenchCommand, type BenchRequest, type BenchResponse, type HistoryFact } from '../experiments/jev-spatial-text/bench.ts';
import { framePng, readFramePng, renderCamera } from '../src/devices/pixel-camera.ts';
import { colorRegions, colorTracker } from '../src/perception/color-tracks.ts';

const k = { fx: 228.50368, fy: 228.50368, cx: 160, cy: 90 };
const frame = (acquiredMs: number, rightDeg = 10, headingDeg = 0, id = 'blue-track'): Acquisition => ({ id: `a${acquiredMs}`, acquiredMs, acquiredWallMs: acquiredMs, deliveredWallMs: acquiredMs, headingDeg, attitudeErrorBoundDeg: .05, frame: 'fixture.png', sha256: 'fixture', calibration: k, overflow: 0, objects: [{ id, color: 'blue', box: [180, 80, 205, 100], pixels: 500, rightDeg, upDeg: 0, widthPercent: 8, clipped: false, history: [] }] });
const command = (id = 'c1', source = frame(0), action: keyof typeof YAW_ACTIONS = 'right_10') => ({ id, requestId: `${id}-request`, action, sourceId: source.id, sourceAcquiredMs: source.acquiredMs, sourceHeadingDeg: source.headingDeg, sourceBlueId: source.objects[0]?.id ?? null, requestedMs: source.acquiredMs, receivedMs: source.acquiredMs });
// All synthetic policy choices live in these offline fixtures, never in the real bench module.
function fixtureAnswer(request: BenchRequest, yaw = 'right_10'): BenchResponse {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => { const choice = id === 'yaw' ? yaw : id.startsWith('forecast_if_') ? 'unknown' : 'cause_unknown'; return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }]; })) };
}
function tempFixture(t: { after(fn: () => void): void }) {
  const root = resolve(tmpdir()), dir = mkdtempSync(join(root, 'robots-world-yaw-bench-'));
  t.after(() => { const target = resolve(dir); assert(target.startsWith(root + sep)); assert(target.split(sep).at(-1)?.startsWith('robots-world-yaw-bench-')); rmSync(target, { recursive: true, force: true }); }); return dir;
}

test('all seven yaw actions preserve acquired-heading semantics, signs, wrap, and retain', () => {
  assert.equal(Object.keys(YAW_ACTIONS).length, 7);
  for (const [action, increment] of Object.entries(YAW_ACTIONS)) assert.equal(headingTarget(action as keyof typeof YAW_ACTIONS, 40, 90), increment === 0 ? 90 : 40 + increment);
  assert.equal(headingTarget('left_30', 170, 0), -160);
  assert.equal(yawStep(0, 30, 100), 9); assert.equal(yawStep(0, -30, 100), -9);
  assert.equal(yawStep(179, -179, 100), -179);
  assert.throws(() => headingTarget('stop' as never, 0, 0));
});

test('acceptance is separate from application; retained setpoint continues unfinished yaw', () => {
  const p = new YawBenchPlant(); const first = p.accept(command('a', frame(0), 'left_30'), 0);
  assert.equal(first.appliedMs, null); assert.equal(p.headingDeg, 0);
  p.tick(20, 20); assert.equal(first.appliedMs, 20); assert.equal(p.headingDeg, 0);
  p.tick(120, 100); assert.equal(p.headingDeg, 9);
  const second = p.accept(command('b', frame(120, 10, 9), 'retain'), 120);
  assert.equal(second.targetHeadingDeg, 30); p.tick(140, 20); p.tick(240, 100);
  assert(p.headingDeg > 9); assert.equal(first.events.at(-1)!.stage, 'superseded');
  assert.equal(first.events.at(-1)!.atMs, second.appliedMs);
});

test('rejected command leaves old authority running; stale and expired queued commands cannot apply', () => {
  const p = new YawBenchPlant(); p.accept(command('old', frame(0), 'left_30'), 0); p.tick(20, 20); p.tick(120, 100);
  const rejected = p.accept(command('bad', frame(120, 0, 9), 'right_30'), 120, 'instrumented-rejection');
  p.tick(220, 100); assert.equal(p.headingDeg, 18); assert.equal(rejected.appliedMs, null); assert.equal(p.lastAcceptedHeadingDeg, 30);
  const delayed = p.accept(command('delay', frame(220)), 220, undefined, 1200);
  p.tick(1220, 1000); p.tick(1440, 220); assert.equal(delayed.appliedMs, null); assert(delayed.events.some(e => e.reason === 'expired-before-application'));
  const stale = p.accept(command('stale', frame(0)), 1500); assert.equal(stale.events[0]!.reason, 'source-acquisition-stale');
  assert.throws(() => p.accept(command('stale'), 1600));
});

test('stop and scheduled interruption revoke active and queued authority', () => {
  for (const stage of ['interrupted', 'cancelled'] as const) {
    const p = new YawBenchPlant(); const c = p.accept(command(), 0); p.tick(20, 20); p.tick(120, 100); p.stop(120, stage);
    const prior = p.headingDeg; p.tick(500, 380); assert.equal(p.headingDeg, prior); assert(c.events.some(e => e.stage === stage));
  }
});

test('outcomes join actual application and acquired attitude; replacements and uncertain identity are unscorable', () => {
  const p = new YawBenchPlant(), c = p.accept({ ...command(), prediction: 'center' }, 0); p.tick(20, 20);
  const samples = [frame(0), frame(200, 2, -8), frame(400, 0, -10)];
  const outcome = deriveOutcome(c, samples, p.commands);
  assert.equal(outcome.after!.acquiredMs, 400); assert.equal(outcome.before!.acquiredMs, 0); assert.equal(outcome.measuredYawDeltaDeg, -10); assert.equal(outcome.comparison, 'match');
  c.prediction = 'unknown'; assert.equal(deriveOutcome(c, samples, p.commands).comparison, 'abstained');
  c.prediction = 'center'; const swapped = samples.map(s => structuredClone(s)); swapped[2]!.objects[0]!.id = 'other';
  assert.equal(deriveOutcome(c, swapped, p.commands).reason, 'target-association-ambiguous');
  const next = p.accept(command('next', frame(200)), 200); p.tick(220, 200); assert.equal(next.appliedMs, 220);
  assert.equal(deriveOutcome(c, samples, p.commands).comparison, 'not_tested');
  assert.match(deriveOutcome(c, samples, p.commands).reason, /ended|another-command/);
});

test('rejected and missing samples never become forecast outcomes; category boundaries abstain from scoring', () => {
  const p = new YawBenchPlant(), c = p.accept({ ...command(), prediction: 'center' }, 0, 'rejected');
  assert.equal(deriveOutcome(c, [frame(0), frame(200)], p.commands).reason, 'command-rejected-not-applied');
  const p2 = new YawBenchPlant(), c2 = p2.accept({ ...command(), prediction: 'center' }, 0); p2.tick(20, 20);
  assert.equal(deriveOutcome(c2, [frame(0)], p2.commands).reason, 'missing-or-late-acquisition');
  assert.equal(observedCategory(frame(400, 5)), null); assert.equal(observedCategory(frame(400, 0)), 'center');
  const absent = frame(400); absent.objects = []; assert.equal(observedCategory(absent), 'not_detected');
  absent.overflow = 25; assert.equal(observedCategory(absent), null);
});

test('linked and chronological histories have exactly the same atomic facts and identical current state/action choices', () => {
  const p = new YawBenchPlant(), samples = [frame(0), frame(200, 0, -10), frame(400, 0, -10)];
  p.accept(command(), 0); p.tick(20, 20);
  const linked = buildBenchRequest('linked', samples[2]!, 410, 500, p, samples), chronological = buildBenchRequest('chronological', samples[2]!, 410, 500, p, samples);
  const linkedFacts = (linked.state.history as { facts: HistoryFact[] }[]).flatMap(c => c.facts), timeline = chronological.state.history as HistoryFact[];
  const sort = (facts: HistoryFact[]) => [...facts].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sort(linkedFacts), sort(timeline)); assert.deepEqual(sort(timeline), sort(historyFacts(p.commands, samples)));
  const { history: _a, ...ls } = linked.state, { history: _b, ...cs } = chronological.state;
  assert.deepEqual(ls, cs); assert.deepEqual(linked.questions, chronological.questions);
  for (const arm of BENCH_ARMS) {
    const r = buildBenchRequest(arm, samples[2]!, 410, 500, p, samples);
    assert.equal(r.state.goal, BENCH_MISSION); assert.deepEqual(r.questions.yaw, linked.questions.yaw);
    assert(!/render-only|radial_range|targetPosition|recommended_action|faultSchedule|passiveFixedObserver/.test(JSON.stringify(r)));
  }
});

test('conditional forecasts cover every action, validate all distributions, and reflections remain finite dated hypotheses', () => {
  const p = new YawBenchPlant(), samples = [frame(0), frame(400, 0, -10)]; p.accept(command(), 0); p.tick(20, 20);
  const r = buildBenchRequest('prediction', samples[1]!, 400, 450, p, samples);
  assert.equal(Object.keys(r.questions).length, 8);
  for (const action of Object.keys(YAW_ACTIONS)) assert(r.questions[`forecast_if_${action}`]!.instructions.includes('200 ms after application'));
  const good = fixtureAnswer(r); validateBenchResponse(r, good);
  const bad = structuredClone(good); delete bad.answers.forecast_if_retain; assert.throws(() => validateBenchResponse(r, bad));
  const badProb = structuredClone(good); badProb.answers.yaw!.probabilities = { wrong: 1 }; assert.throws(() => validateBenchResponse(r, badProb));
  const wrongModel = structuredClone(good); wrongModel.model = 'jev-latest'; assert.throws(() => validateBenchResponse(r, wrongModel));
  const h = { requestId: 'old', episodeId: 'c1', selectedMs: 100, expiresMs: 1000, model_hypothesis: 'not_applied' };
  const reflection = buildBenchRequest('reflection', samples[1]!, 400, 450, p, samples, [h]);
  assert.deepEqual(reflection.state.modelHypotheses, []); assert(reflection.questions.prior_episode_assessment);
});

test('acquired coverage counts gaps unknown/loss and preserves contiguous framing', () => {
  const score = scoreCoverage([{ acquiredMs: 0, visible: true, framed: true }, { acquiredMs: 200, visible: true, framed: true }, { acquiredMs: 800, visible: false, framed: false }], 1200);
  assert.equal(score.coveredMs, 700); assert.equal(score.unknownMs, 500); assert.equal(score.visibleMs, 450); assert.equal(score.framedMs, 450); assert.equal(score.longestFramedMs, 450); assert.equal(score.longestLossMs, 750);
  assert.equal(scoreCoverage([], 1000).longestLossMs, 1000);
  assert.throws(() => scoreCoverage([{ acquiredMs: 2, visible: true, framed: true }, { acquiredMs: 2, visible: true, framed: true }], 10));
});

test('every arm states the same exact pixel framing objective and calibrated bearing band used by scoring', () => {
  const p = new YawBenchPlant();
  for (const fx of [k.fx, k.fx * 1.5]) for (const u of [-.301, -.3, -.299, 0, .299, .3, .301]) {
    const a = frame(0); a.calibration = { ...k, fx }; const center = k.cx * (1 + u);
    a.objects[0]!.box = [center - 10, 80, center + 10, 100];
    a.objects[0]!.rightDeg = Math.atan(u * k.cx / fx) * 180 / Math.PI;
    const objective = componentObjective(a.calibration), limit = objective.allowedUnroundedRightDegInterval[1]!;
    assert.deepEqual(objective.allowedNormalizedInterval, [-.3, .3]);
    assert(Math.abs(limit - Math.atan(.3 * k.cx / fx) * 180 / Math.PI) < 1e-12);
    assert.equal(coverage(a).framed, Math.abs(u) <= .3);
    assert.equal(Math.abs(a.objects[0]!.rightDeg) <= limit + 1e-12, coverage(a).framed);
    for (const arm of BENCH_ARMS) {
      const request = buildBenchRequest(arm, a, 0, 0, p, [a]);
      assert.deepEqual(request.state.componentObjective, objective); assert.equal(request.state.goal, BENCH_MISSION);
    }
    if (u === 0) {
      a.objects[0]!.clipped = true; assert.equal(coverage(a).framed, false); a.objects[0]!.clipped = false;
      a.overflow = 1; assert.equal(coverage(a).framed, false); a.overflow = 0;
      a.objects.push(structuredClone(a.objects[0]!)); assert.equal(coverage(a).framed, false);
    }
  }
});

test('rendered RGB generates mirror bearings, physical occlusion, and exactly replayable region pixels', () => {
  const observe = (seed: number, at: number, pattern: 'stationary-offset' | 'transient-occlusion') => {
    const result = renderCamera(benchScene(seed, pattern, at), [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
    const regions = colorRegions(result.image, result.calibration); const decoded = readFramePng(framePng(result.image));
    assert.deepEqual(colorRegions(decoded, result.calibration), regions); return regions;
  };
  assert(observe(11, 0, 'stationary-offset').find(r => r.color === 'blue')!.rightDeg < 0);
  assert(observe(12, 0, 'stationary-offset').find(r => r.color === 'blue')!.rightDeg > 0);
  assert(observe(11, 0, 'transient-occlusion').some(r => r.color === 'blue'));
  assert(!observe(11, Math.PI / 2 / .65 * 1000, 'transient-occlusion').some(r => r.color === 'blue'));
});

test('paired seeds mirror the entire scene and rendered pixels under opposite measured headings', () => {
  for (const [p, pattern] of BENCH_PATTERNS.entries()) for (const atMs of [0, 2400, 5000]) for (const headingDeg of [0, 15, -25]) {
    const seed = 6100 + p * 10, left = benchScene(seed, pattern, atMs), right = benchScene(seed + 1, pattern, atMs);
    assert.equal(left.length, right.length);
    for (const [i, body] of left.entries()) {
      assert.deepEqual(body.shape, right[i]!.shape);
      assert.equal(body.pose.position.x, right[i]!.pose.position.x);
      assert(Math.abs(body.pose.position.y + right[i]!.pose.position.y) < 1e-12);
      assert.equal(body.pose.position.z, right[i]!.pose.position.z);
    }
    const render = (bodies: typeof left, headingDeg: number) => renderCamera(bodies, [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg, pitchDeg: 0, hfovDeg: 70 }, 320, 180).image;
    const a = render(left, headingDeg), b = render(right, -headingDeg);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) for (let c = 0; c < 4; c++) assert.equal(a.data[(y * a.width + x) * 4 + c], b.data[(y * b.width + b.width - 1 - x) * 4 + c]);
  }
});

test('continuous run acquires during slow synthetic inference, saves raw evidence and never applies a late answer', async t => {
  const outputDir = tempFixture(t), starts: number[] = []; let finish!: (r: BenchResponse) => void; let captured!: BenchRequest;
  const summary = await runBench({ id: 'slow', arm: 'linked', seed: 12, seconds: 1.2, outputDir, pattern: 'stationary-offset', judge: async request => {
    starts.push(performance.now());
    if (starts.length === 1) {
      const deadline = performance.now() + 5000;
      for (;;) {
        const events = readFileSync(join(outputDir, 'slow', 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        if (events.filter(e => e.kind === 'acquisition').length >= 3) break;
        assert(performance.now() < deadline, 'Independent camera acquisition did not advance while judgment was pending');
        await new Promise(r => setTimeout(r, 10));
      }
      return fixtureAnswer(request);
    }
    captured = request; return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(summary.status, 'completed'); assert.equal(summary.simulatedMs, 1200); assert.equal(summary.acquisitions, 7); assert.equal(summary.calls, 2); assert(summary.pendingAtStop); assert.equal(summary.commandCounts.accepted! + summary.commandCounts.rejected!, 1); assert.equal(summary.missionSuccess, null);
  assert(starts[1]! - starts[0]! >= 500);
  const events = readFileSync(join(summary.outputDir, 'trace.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const responseTime = events.find(e => e.kind === 'response').simMs;
  assert(events.filter(e => e.kind === 'acquisition' && e.simMs > 0 && e.simMs <= responseTime).length >= 2);
  assert.equal(readdirSync(join(summary.outputDir, 'frames')).length, 14);
  const acquisitions = events.filter(e => e.kind === 'acquisition').map(e => e.data as Acquisition), tracker = colorTracker();
  for (const a of acquisitions) assert.deepEqual(tracker(readFramePng(readFileSync(join(summary.outputDir, a.frame))), a.calibration, a.acquiredMs).objects, a.objects);
  finish(fixtureAnswer(captured)); await new Promise(r => setTimeout(r, 30));
  assert(readdirSync(summary.outputDir).some(f => f.endsWith('.late.json')));
  const commands = JSON.parse(readFileSync(join(summary.outputDir, 'commands.json'), 'utf8')) as BenchCommand[]; assert.equal(commands.length, 1);
  assert(!JSON.stringify(events.filter(e => e.kind === 'request')).includes('render-only'));
});

test('cancellation revokes authority promptly while callback remains pending', async t => {
  const outputDir = tempFixture(t), abort = new AbortController(); let finish!: (r: BenchResponse) => void; let captured!: BenchRequest;
  const promise = runBench({ id: 'cancel', arm: 'receipt', seed: 14, seconds: 3, outputDir, signal: abort.signal, judge: async r => { captured = r; return new Promise(resolve => { finish = resolve; }); } });
  await new Promise(r => setTimeout(r, 90)); abort.abort('offline cancellation fixture');
  const summary = await promise; assert.equal(summary.status, 'cancelled'); assert(summary.simulatedMs < 300); assert.equal(summary.commandCounts.accepted, 0); assert(summary.pendingAtStop);
  finish(fixtureAnswer(captured)); await new Promise(r => setTimeout(r, 30));
  assert.equal(JSON.parse(readFileSync(join(summary.outputDir, 'commands.json'), 'utf8')).length, 0);
});

test('immediate synthetic judgments still start at least 500 monotonic milliseconds apart', async t => {
  const outputDir = tempFixture(t), starts: number[] = [];
  const summary = await runBench({ id: 'paced', arm: 'receipt', seed: 12, pattern: 'stationary-offset', seconds: .8, outputDir, judge: async request => { starts.push(performance.now()); return fixtureAnswer(request, 'retain'); } });
  assert.equal(summary.status, 'completed'); assert(starts.length >= 2);
  for (let i = 1; i < starts.length; i++) assert(starts[i]! - starts[i - 1]! >= 500, `Start interval was ${starts[i]! - starts[i - 1]!}ms`);
});

test('absolute deadlines cancel timer quantization drift and bound catch-up without early or skipped steps', () => {
  let simMs = 0, wallMs = 0, maxLag = 0, frames = 1;
  while (simMs < 20_000) {
    const delay = benchTickPlan(wallMs, simMs, 20_000).nextDelayMs;
    wallMs += Math.ceil(delay / 16) * 16; // Deterministic coarse host timer, not inference latency.
    const plan = benchTickPlan(wallMs, simMs, 20_000); assert(!plan.invalid); maxLag = Math.max(maxLag, plan.lagMs);
    for (let i = 0; i < plan.ticks; i++) { simMs += 20; if (simMs % 200 === 0) frames++; }
  }
  assert.equal(simMs, 20_000); assert.equal(frames, 101); assert(wallMs <= 20_016); assert(maxLag <= 36);
  assert.equal(benchTickPlan(19, 0, 1000).ticks, 0);
  assert.equal(benchTickPlan(180, 0, 1000).ticks, 5);
  assert.equal(benchTickPlan(180, 100, 1000).ticks, 4);
  assert.equal(benchTickPlan(251, 0, 1000).invalid, true);
  assert.equal(benchTickPlan(251, 0, 1000).ticks, 0);
});

test('the final dispatch boundary rejects preparation crossing stop, lag or nominal end', () => {
  assert.equal(benchDispatchBlock(true, false, 19_990, 19_980, 20_000), null);
  // The same prepared request must be refused after10ms of serialization or filesystem work.
  assert.equal(benchDispatchBlock(true, false, 20_000, 19_980, 20_000), 'deadline');
  assert.equal(benchDispatchBlock(true, false, 20_010, 19_980, 20_000), 'deadline');
  assert.equal(benchDispatchBlock(true, false, 19_990, 19_700, 20_000), 'lag');
  assert.equal(benchDispatchBlock(false, false, 19_990, 19_980, 20_000), 'stopped');
  assert.equal(benchDispatchBlock(true, true, 19_990, 19_980, 20_000), 'cancelled');
});

test('event-loop overload invalidates the clock before a settled answer can reach the actuator', async t => {
  const outputDir = tempFixture(t);
  const summary = await runBench({ id: 'overloaded', arm: 'receipt', seed: 12, seconds: 2, outputDir, judge: async request => {
    const until = performance.now() + BENCH_CONFIG.maxSchedulerLagMs + 60;
    while (performance.now() < until) { /* Deliberate test-only CPU stall. */ }
    return fixtureAnswer(request);
  } });
  assert.equal(summary.status, 'invalid'); assert.match(summary.error!, /Scheduler lag/);
  assert.equal(summary.commandCounts.accepted, 0); assert.equal(summary.commandCounts.applied, 0);
  assert(summary.maxPacingLagMs > BENCH_CONFIG.maxSchedulerLagMs); assert(summary.simulatedMs < 2000);
});

test('a response arriving during bounded backlog cannot actuate in catch-up ticks before its arrival', async t => {
  const outputDir = tempFixture(t);
  const summary = await runBench({ id: 'catchup-response', arm: 'receipt', seed: 12, seconds: .4, outputDir, judge: async request => {
    const until = performance.now() + 125;
    while (performance.now() < until) { /* Test a late event-loop turn within the250ms gate. */ }
    return fixtureAnswer(request, 'left_30');
  } });
  assert.equal(summary.status, 'completed', summary.error ?? '');
  const events = readFileSync(join(summary.outputDir, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const initial = events.find(e => e.kind === 'acquisition').wallMs, response = events.find(e => e.kind === 'response');
  const applied = events.find(e => e.kind === 'command-stage' && e.data.event.stage === 'applied');
  assert(applied.data.event.atMs >= response.wallMs - initial, `Application at${applied.data.event.atMs} preceded response wall elapsed${response.wallMs - initial}`);
  assert(applied.data.event.atMs >= 120); assert(summary.commandCounts.applied! > 0);
});

test('twenty-second wall-clock qualification retains101 acquisitions and at most40 starts', { skip: process.env.JEV_BENCH_20S_QUALIFY !== '1' }, async t => {
  const outputDir = process.env.JEV_BENCH_QUALIFY_OUTPUT ?? tempFixture(t), id = `clock-20s-${Date.now()}`, starts: number[] = [];
  const summary = await runBench({ id, arm: 'prediction', seed: 6130, pattern: 'interrupted-command', seconds: 20, outputDir, judge: async request => {
    starts.push(performance.now()); await new Promise(r => setTimeout(r, 70)); return fixtureAnswer(request, starts.length === 1 ? 'left_30' : 'retain');
  } });
  assert.equal(summary.status, 'completed', summary.error ?? ''); assert.equal(summary.simulatedMs, 20_000); assert.equal(summary.acquisitions, 101);
  assert(summary.wallMs >= 20_000 && summary.wallMs < 20_000 + BENCH_CONFIG.terminalGraceMs);
  assert(summary.calls <= 40 && summary.calls >= 37); assert(summary.maxPacingLagMs <= BENCH_CONFIG.maxSchedulerLagMs);
  for (let i = 1; i < starts.length; i++) assert(starts[i]! - starts[i - 1]! >= 500);
  const events = readFileSync(join(summary.outputDir, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const frames = events.filter(e => e.kind === 'acquisition').map(e => e.data as Acquisition);
  assert.equal(frames.at(-1)!.acquiredMs, 20_000); assert(frames.some(f => Math.abs(f.headingDeg) > 1));
  assert(summary.commandCounts.applied! > 0); assert(summary.commandCounts.rejected! > 0); assert(summary.commandCounts.expired! > 0); assert(summary.commandCounts.interrupted! > 0);
  assert.equal(readdirSync(join(summary.outputDir, 'frames')).length, 202);
  console.log(JSON.stringify({ qualification: 'actual20s offline synthetic judge; no inference/hardware', outputDir: summary.outputDir, wallMs: summary.wallMs, simMs: summary.simulatedMs, acquisitions: summary.acquisitions, calls: summary.calls, maxPacingLagMs: summary.maxPacingLagMs, commandCounts: summary.commandCounts }));
});
