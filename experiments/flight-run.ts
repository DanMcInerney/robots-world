import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { askFlightJev, ClaudeFlightSession, CodexFlightSession, type FlightDecision, type NativeFlightSession } from './flight-providers.ts';
import { FlightWorld, type FlightEmit } from './flight-world.ts';
import type { FlightAction, FlightArm, FlightEncoding, FlightState } from './flight-contract.ts';

const files = ['experiments/flight-contract.ts', 'experiments/flight-world.ts', 'experiments/flight-providers.ts', 'experiments/flight-run.ts', 'src/devices/aim-camera.ts', 'src/models/mobile.ts', 'src/protocols/mavlink.ts', 'controllers/app-server.ts', 'controllers/codex.ts', 'src/world.ts', 'src/math.ts', 'src/contracts.ts', 'src/network.ts', 'src/recorder.ts', 'src/sensors/index.ts', 'src/sensors/builtins.ts', 'src/physics/rapier.ts'];
export async function flightSourceHash() { const hash = createHash('sha256'); for (const file of files) hash.update(file).update(await readFile(file)); return hash.digest('hex'); }
const percentile = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]! : null;
class Trace {
  private fd: number; private records = 0; private bytes = 0; private closed = false;
  constructor(path: string) { this.fd = openSync(path, 'wx'); }
  emit: FlightEmit = (kind, data) => {
    if (this.closed) return;
    let line = JSON.stringify({ wallMs: Date.now(), monoMs: performance.now(), kind, data }, (key, value) => /^(authorization|api[_-]?key|access[_-]?token|password|secret)$/i.test(key) ? '[redacted]' : value);
    for (const secret of [process.env.TYPESAFE_API_KEY, process.env.JEV_API_KEY]) if (secret) line = line.split(secret).join('[redacted]');
    if (Buffer.byteLength(line) > 262144 || ++this.records > 100000 || this.bytes + Buffer.byteLength(line) > 75_000_000) throw new Error('Evidence capacity exceeded');
    this.bytes += writeSync(this.fd, line + '\n');
  };
  close() { if (!this.closed) { this.emit('trace.complete', { records: this.records, bytes: this.bytes, dropped: 0 }); this.closed = true; closeSync(this.fd); } }
}
export async function runFlightTrial(options: { arm: FlightArm; seed: number; encoding: FlightEncoding; directory: string; seconds: number; key: string; phase: string }) {
  const { arm, seed, encoding, directory, seconds, key, phase } = options, id = `${arm}-${encoding}-${seed}`;
  mkdirSync(directory, { recursive: true }); const trace = new Trace(resolve(directory, `${id}.jsonl`));
  const lifetime = new AbortController(), setupStart = performance.now();
  let native: NativeFlightSession | undefined, runtime: FlightWorld | undefined;
  let decisionTask: Promise<void> | undefined, plannerTask: Promise<void> | undefined;
  let ready: { source: FlightState; answer?: FlightDecision; error?: string } | undefined;
  let proposals: { sourceSimMs: number; expiresSimMs: number; actions: FlightAction[] } | undefined;
  let nextDecision = 0, nextPlan = 0;
  const stats = { calls: 0, plannerCalls: 0, errors: 0, staleActions: 0, stalePlans: 0, cancelledDecisions: 0, cancelledPlans: 0, proposalsOffered: 0, proposalsUsed: 0, latencyMs: [] as number[], planLatencyMs: [] as number[], sourceAgeMs: [] as number[], decisionModels: [] as string[], usage: [] as unknown[], nativeReportedCostUsd: 0 };
  try {
    if (arm === 'claude') native = await ClaudeFlightSession.create(resolve(directory, 'native', id), trace.emit);
    if (arm === 'codex' || arm === 'hybrid') native = await CodexFlightSession.create(resolve(directory, 'native', id), trace.emit);
    runtime = await FlightWorld.create(seed, trace.emit);
    const world = runtime, started = performance.now() - world.world.simMs, setupMs = performance.now() - setupStart;
    trace.emit('flight.manifest', { id, phase, arm, seed, encoding, seconds, sourceHash: await flightSourceHash(), setupMs, scenario: world.world.scenario, refreshMs: 750, maximumCalls: 180, maximumPlans: 8, staleAfterMs: 30000, proposalLifetimeMs: 12000,
      caveats: 'Ideal geometric perception and cooperative radio beacon; simplified acceleration/attitude servo; actual in-process MAVLink movement, local JSON camera. Structured native harness, no authored code/routines. Jev discretized values versus native free numeric arguments.' });
    let maxLagMs = 0;
    while (world.world.simMs < seconds * 1000) {
      const state = world.state();
      if (ready) {
        if (ready.answer) {
          const receipt = await world.apply(ready.answer.action, ready.source);
          stats.sourceAgeMs.push(state.simMs - ready.source.observation.sensors.odometry!.acquiredSimMs);
          if (!receipt.accepted) stats.staleActions++;
          trace.emit('flight.decision.applied', { simMs: state.simMs, sourceSimMs: ready.source.simMs, answer: ready.answer, receipt });
        } else { stats.errors++; trace.emit('flight.decision.error', { simMs: state.simMs, error: ready.error, fallback: 'Existing setpoint continues until expiry; no substituted goal policy.' }); }
        ready = undefined;
      }
      if (proposals && state.simMs > proposals.expiresSimMs) { trace.emit('flight.proposals.expired', { simMs: state.simMs, sourceSimMs: proposals.sourceSimMs }); proposals = undefined; }
      if (arm === 'hybrid' && !plannerTask && state.simMs >= nextPlan && stats.plannerCalls < 8) {
        const source = world.state(); nextPlan = source.simMs + 6000; stats.plannerCalls++;
        plannerTask = native!.ask(source, 'propose', lifetime.signal).then(answer => {
          if (lifetime.signal.aborted) return; stats.planLatencyMs.push(answer.latencyMs);
          const expiresSimMs = source.simMs + 12000;
          if (world.world.simMs > expiresSimMs) stats.stalePlans++;
          else proposals = { sourceSimMs: source.simMs, expiresSimMs, actions: answer.actions };
          trace.emit('flight.proposals', { currentSimMs: world.world.simMs, sourceSimMs: source.simMs, expiresSimMs, answer, accepted: world.world.simMs <= expiresSimMs });
        }).catch(error => { if (!lifetime.signal.aborted) { stats.errors++; trace.emit('flight.planner.error', { error: String(error) }); } }).finally(() => { plannerTask = undefined; });
      }
      if (!decisionTask && !ready && state.simMs >= nextDecision && stats.calls < 180) {
        const source = world.state(), candidates = proposals?.actions ?? []; nextDecision = source.simMs + 750; stats.calls++;
        if (candidates.length) { stats.proposalsOffered++; trace.emit('flight.proposals.offered', { simMs: source.simMs, proposals }); }
        const answer: Promise<FlightDecision> = arm === 'claude' || arm === 'codex'
          ? native!.ask(source, 'act', lifetime.signal).then(result => ({ action: result.actions[0]!, latencyMs: result.latencyMs, model: result.model, costUsd: result.costUsd }))
          : askFlightJev(source, encoding, key, trace.emit, lifetime.signal, candidates);
        decisionTask = answer.then(result => {
          if (lifetime.signal.aborted) return; stats.latencyMs.push(result.latencyMs); stats.decisionModels.push(result.model);
          if (result.usage) stats.usage.push(result.usage); if (result.costUsd !== undefined) stats.nativeReportedCostUsd = result.costUsd;
          if (result.usedProposal) stats.proposalsUsed++; ready = { source, answer: result };
        }).catch(error => { if (!lifetime.signal.aborted) ready = { source, error: String(error) }; }).finally(() => { decisionTask = undefined; });
      }
      await world.tick();
      const lag = performance.now() - started - world.world.simMs; maxLagMs = Math.max(maxLagMs, lag);
      if (lag > 1000) throw new Error('World wall pacing lag exceeded 1 second; trial invalid');
      if (lag < 0) await sleep(-lag);
    }
    if (decisionTask) stats.cancelledDecisions++; if (plannerTask) stats.cancelledPlans++; lifetime.abort();
    const evaluation = world.evaluate();
    const result = { id, phase, arm, encoding, seed, seconds, setupMs, maxLagMs, wallMs: performance.now() - started, sourceHash: await flightSourceHash(), stats, latencyP50Ms: percentile(stats.latencyMs, .5), latencyP95Ms: percentile(stats.latencyMs, .95), sourceAgeP50Ms: percentile(stats.sourceAgeMs, .5), evaluation };
    trace.emit('flight.result', result); await writeFile(resolve(directory, `${id}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ phase: 'trial-complete', id, success: evaluation.success, visible: evaluation.visibleFraction, inspected: evaluation.inspectionAtMs, collisions: evaluation.collisionTicks, bounds: evaluation.boundsTicks, p50: result.latencyP50Ms, errors: stats.errors, proposalsUsed: stats.proposalsUsed }));
    return result;
  } catch (error) { trace.emit('flight.invalid', { error: String(error) }); throw error; }
  finally { lifetime.abort(); await runtime?.close(); await native?.close(); await Promise.allSettled([decisionTask, plannerTask].filter((p): p is Promise<void> => !!p)); trace.close(); }
}

export async function runFlights(args = process.argv.slice(2)) {
  const options = new Map<string, string>(); for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Use --name value'); options.set(args[i]!.slice(2), args[i + 1]!); }
  const phase = options.get('phase') ?? 'held-out', directory = resolve(options.get('output') ?? `.runtime/experiments/flight-${Date.now()}`);
  if (!['development', 'held-out', 'smoke'].includes(phase)) throw new Error('Invalid phase');
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY; if (!key) throw new Error('Explicitly load a Jev key; this is paid inference');
  const seeds = (options.get('seeds') ?? (phase === 'development' ? '11,12' : '101,202,303')).split(',').map(Number);
  if (seeds.length > 20 || seeds.some(s => !Number.isInteger(s) || s < 1 || s > 1000000 || phase === 'held-out' && s < 100 || phase === 'development' && s >= 100)) throw new Error('Invalid seeds/split');
  const seconds = Number(options.get('seconds') ?? (phase === 'development' ? 25 : 45)); if (!Number.isFinite(seconds) || seconds < 8 || seconds > 90) throw new Error('seconds must be 8..90');
  const arms = (options.get('arms') ?? (phase === 'development' ? 'jev' : 'jev,claude,codex,hybrid')).split(',') as FlightArm[];
  if (arms.some(a => !['jev', 'claude', 'codex', 'hybrid'].includes(a)) || new Set(arms).size !== arms.length) throw new Error('Invalid arms');
  let encodings: FlightEncoding[] = phase === 'development' ? ['axes', 'vectors'] : [options.get('encoding') as FlightEncoding ?? 'axes'];
  let tuning: unknown;
  if (phase === 'held-out') {
    if (!options.get('tuning')) throw new Error('Freeze development tuning before held-out trials');
    const value = JSON.parse(await readFile(resolve(options.get('tuning')!), 'utf8')) as { winner: FlightEncoding; sourceHash: string };
    if (value.sourceHash !== await flightSourceHash()) throw new Error('Source changed after tuning; rerun development');
    encodings = [value.winner]; tuning = value;
  }
  if (encodings.some(e => !['axes', 'vectors'].includes(e))) throw new Error('Invalid encoding');
  mkdirSync(directory, { recursive: true });
  const manifest = { recordedAt: new Date().toISOString(), phase, sourceHash: await flightSourceHash(), seeds, arms, encodings, seconds, tuning,
    selectionRule: 'Development only: most successful trials, then most completed side inspections, then highest mean camera visibility, then lowest collision ticks, then lowest p95 request latency. No held-out tuning.' };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const results: Awaited<ReturnType<typeof runFlightTrial>>[] = [];
  for (const [i, seed] of seeds.entries()) for (let n = 0; n < arms.length; n++) for (let j = 0; j < encodings.length; j++) {
    const arm = arms[(i + n) % arms.length]!, encoding = encodings[(i + j) % encodings.length]!;
    console.log(JSON.stringify({ phase: 'trial-start', arm, encoding, seed }));
    results.push(await runFlightTrial({ arm, seed, encoding, directory, seconds, key, phase }));
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results }, null, 2));
  }
  if (phase === 'development') {
    const summary = encodings.map(encoding => { const rs = results.filter(r => r.encoding === encoding); return { encoding, passed: rs.filter(r => r.evaluation.success).length, inspected: rs.filter(r => r.evaluation.inspectionAtMs !== null).length, visibility: rs.reduce((s, r) => s + r.evaluation.visibleFraction, 0) / rs.length, collisions: rs.reduce((s, r) => s + r.evaluation.collisionTicks, 0), p95: percentile(rs.flatMap(r => r.stats.latencyMs), .95) ?? Infinity }; });
    summary.sort((a, b) => b.passed - a.passed || b.inspected - a.inspected || b.visibility - a.visibility || a.collisions - b.collisions || a.p95 - b.p95);
    await writeFile(resolve(directory, 'tuning.json'), JSON.stringify({ sourceHash: manifest.sourceHash, winner: summary[0]!.encoding, summary, manifest }, null, 2));
    console.log(JSON.stringify({ phase: 'tuning-frozen', summary }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runFlights();
