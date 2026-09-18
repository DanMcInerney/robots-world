import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { developmentCases, missionDefinition, type MenuFormat, type MissionArm, type MissionState } from './mission-contract.ts';
import { askJev, ClaudeMissionSession, type DecisionResult, type Emit } from './mission-providers.ts';
import { MissionWorld } from './mission-world.ts';

const FORMATS: MenuFormat[] = ['plain', 'structured', 'factorized', 'interrupt'];
const sourceFiles = ['experiments/mission-contract.ts', 'experiments/mission-world.ts', 'experiments/mission-providers.ts', 'experiments/mission-run.ts'];
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : null; };
async function sourceHash() { const hash = createHash('sha256'); for (const path of sourceFiles) hash.update(path).update(await readFile(path)); return hash.digest('hex'); }

class Trace {
  private fd: number; private records = 0; private bytes = 0; private closed = false;
  private readonly secrets: string[];
  constructor(path: string) { this.fd = openSync(path, 'wx'); this.secrets = [process.env.TYPESAFE_API_KEY, process.env.JEV_API_KEY].filter((v): v is string => !!v); }
  emit: Emit = (kind, data) => {
    if (this.closed) return;
    let line = JSON.stringify({ wallMs: Date.now(), monoMs: performance.now(), kind, data }, (key, value) => /^(authorization|api[_-]?key|access[_-]?token|password|secret)$/i.test(key) ? '[redacted]' : value);
    for (const secret of this.secrets) line = line.split(secret).join('[redacted]');
    if (Buffer.byteLength(line) > 131072 || ++this.records > 100000 || this.bytes + Buffer.byteLength(line) > 50_000_000) throw new Error('Evidence capacity exceeded; trial invalid');
    this.bytes += writeSync(this.fd, line + '\n');
  };
  close() { if (!this.closed) { this.emit('trace.complete', { records: this.records, bytes: this.bytes, dropped: 0 }); this.closed = true; closeSync(this.fd); } }
}

export async function optimizeMenus(directory: string, apiKey: string) {
  mkdirSync(directory, { recursive: true });
  const trace = new Trace(resolve(directory, 'optimization.jsonl'));
  const rows: { format: MenuFormat; id: string; correct: boolean; latencyMs: number; actionId?: string; error?: string }[] = [];
  try {
    const cases = developmentCases();
    trace.emit('optimization.manifest', { sourceHash: await sourceHash(), cases: cases.map(c => ({ id: c.id, acceptable: c.acceptable })), selectionRule: 'Highest development accuracy; ties use lower p95 latency. No held-out results used.' });
    for (const [index, example] of cases.entries()) {
      // Rotate order to reduce a consistent warm-cache/network advantage for any format.
      for (let k = 0; k < FORMATS.length; k++) {
        const format = FORMATS[(index + k) % FORMATS.length]!;
        const started = performance.now();
        try {
          const answer = await askJev(example.state, format, apiKey, trace.emit, AbortSignal.timeout(3000));
          rows.push({ format, id: example.id, actionId: answer.actionId, correct: example.acceptable.includes(answer.actionId), latencyMs: answer.latencyMs });
        } catch (error) { rows.push({ format, id: example.id, correct: false, latencyMs: performance.now() - started, error: String(error) }); }
        trace.emit('optimization.scored', rows.at(-1));
      }
      console.log(JSON.stringify({ phase: 'optimize', casesDone: index + 1, casesTotal: cases.length }));
    }
    const summary = FORMATS.map(format => { const selected = rows.filter(r => r.format === format); return { format, correct: selected.filter(r => r.correct).length, total: selected.length, errors: selected.filter(r => r.error).length, p50Ms: percentile(selected.map(r => r.latencyMs), .5), p95Ms: percentile(selected.map(r => r.latencyMs), .95) }; });
    summary.sort((a, b) => b.correct - a.correct || a.p95Ms! - b.p95Ms!);
    const result = { recordedAt: new Date().toISOString(), sourceHash: await sourceHash(), status: 'development-only', winner: summary[0]!.format, summary, rows };
    await writeFile(resolve(directory, 'optimization.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ phase: 'optimized', winner: result.winner, summary })); return result;
  } finally { trace.close(); }
}

async function runFlight(arm: MissionArm, seed: number, format: MenuFormat, directory: string, apiKey: string, model: string, effort: 'low' | 'high', seconds: number) {
  const id = `${arm}-${seed}-${effort}`, tracePath = resolve(directory, `${id}.jsonl`), trace = new Trace(tracePath);
  let native: ClaudeMissionSession | undefined, world: MissionWorld | undefined;
  const lifetime = new AbortController(), wallStart = performance.now();
  let decisionTask: Promise<void> | undefined, planTask: Promise<void> | undefined;
  const stats = { calls: 0, planCalls: 0, errors: 0, discarded: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, jevUsageComplete: true, lastReportedClaudeCostUsd: null as number | null,
    latencies: [] as number[], plannerLatencies: [] as number[], busyAtReports: [] as { simMs: number; reports: number; nativeBusy: boolean }[] };
  let ready: { result?: DecisionResult; source: MissionState; error?: string } | undefined;
  let advice: MissionState['plannerAdvice'];
  let selectedPlanReportVersion = -1, nextAsk = 0, previousRevision = '', previousReports = 0;
  const definition = missionDefinition(seed, 'held-out');
  try {
    if (arm !== 'jev') native = await ClaudeMissionSession.create(resolve(directory, 'native', id), trace.emit, model, effort);
    world = await MissionWorld.create(definition, trace.emit);
    const runtime = world, started = performance.now(), setupMs = started - wallStart;
    trace.emit('mission.manifest', { id, arm, seed, format, model: arm === 'jev' ? 'jev-1.13.0' : model, effort: arm === 'jev' ? null : effort,
      sourceHash: await sourceHash(), definition, setupMs, seconds, tickMs: 20, decisionRefreshMs: 1000, jevDeadlineMs: 2500,
      capabilities: 'Shared inspect-at-station, return, hold, continue; same ideal site directory and odometry. Actual MAVLink encoding/CRC; no autopilot or hardware.',
      nativeContract: 'Persistent Claude Code structured selector; no filesystem/tools/code authoring. Hybrid adds asynchronous advice, never a second actuator owner.' });
    for (;;) {
      if (runtime.world.simMs >= seconds * 1000) break;
      const state = runtime.state();
      if (state.reports.length !== previousReports) { stats.busyAtReports.push({ simMs: state.simMs, reports: state.reports.length, nativeBusy: arm === 'claude' ? !!decisionTask : arm === 'hybrid' && !!planTask }); previousReports = state.reports.length; }
      if (ready) {
        if (ready.result) {
          const receipt = runtime.apply(ready.result.actionId, ready.source);
          trace.emit('mission.decision.applied', { simMs: state.simMs, sourceSimMs: ready.source.simMs, result: ready.result, receipt });
          if (!receipt.accepted) stats.discarded++;
        } else { stats.errors++; trace.emit('mission.decision.error', { simMs: state.simMs, sourceSimMs: ready.source.simMs, error: ready.error, fallback: 'existing job continues; no substituted mission choice' }); }
        ready = undefined;
      }
      if (arm === 'hybrid' && !planTask && stats.planCalls < 4 && selectedPlanReportVersion !== state.reports.length) {
        const planState = structuredClone(state); selectedPlanReportVersion = state.reports.length; stats.planCalls++;
        planTask = native!.ask(planState, 'plan', lifetime.signal).then(answer => {
          if (!lifetime.signal.aborted) { advice = { text: answer.guidance, basedOnSimMs: planState.simMs }; stats.plannerLatencies.push(answer.latencyMs); stats.lastReportedClaudeCostUsd = answer.costUsd; trace.emit('mission.plan', { advice, currentSimMs: runtime.world.simMs, sourceReports: planState.reports.map(r => r.id), model: answer.model }); }
        }).catch(error => { if (!lifetime.signal.aborted) { stats.errors++; trace.emit('mission.plan.error', { error: String(error) }); } }).finally(() => { planTask = undefined; });
      }
      const revision = runtime.revision();
      if (!decisionTask && !ready && stats.calls < 80 && (state.simMs >= nextAsk || revision !== previousRevision)) {
        previousRevision = revision; nextAsk = state.simMs + 1000; stats.calls++;
        const source = runtime.state(); if (advice) source.plannerAdvice = advice;
        const decide: Promise<DecisionResult> = arm === 'claude' ? native!.ask(source, 'act', lifetime.signal) : askJev(source, format, apiKey, trace.emit, lifetime.signal);
        decisionTask = decide.then(result => {
          if (lifetime.signal.aborted) return;
          stats.latencies.push(result.latencyMs);
          if (arm !== 'claude') { if (result.inputTokens === undefined || result.outputTokens === undefined) stats.jevUsageComplete = false; stats.inputTokens += result.inputTokens ?? 0; stats.outputTokens += result.outputTokens ?? 0; }
          else stats.lastReportedClaudeCostUsd = result.costUsd ?? null;
          ready = { source, result };
        }).catch(error => {
          if (!lifetime.signal.aborted) { ready = { source, error: String(error) }; if (arm !== 'claude') stats.jevUsageComplete = false; }
        }).finally(() => { decisionTask = undefined; });
      }
      await runtime.tick();
      const waitMs = started + runtime.world.simMs - performance.now();
      if (waitMs > 0) await sleep(waitMs);
      if (performance.now() - started > seconds * 1000 + 5000) throw new Error('World wall pacing overrun; trial invalid');
    }
    if (decisionTask) { stats.cancelled++; if (arm !== 'claude') stats.jevUsageComplete = false; }
    lifetime.abort();
    const evaluation = runtime.evaluate();
    const result = { id, arm, seed, family: definition.family, format, claudeModel: arm === 'jev' ? null : model, effort: arm === 'jev' ? null : effort,
      setupMs, wallMs: performance.now() - started, simMs: runtime.world.simMs, tracePath, stats,
      latencyP50Ms: percentile(stats.latencies, .5), latencyP95Ms: percentile(stats.latencies, .95), evaluation };
    trace.emit('mission.result', result); await writeFile(resolve(directory, `${id}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ phase: 'flight-complete', id, success: evaluation.success, responseMs: evaluation.responseMs, urgentCompletionMs: evaluation.urgentCompletionMs,
      completedMission: evaluation.completedMission, p50Ms: result.latencyP50Ms, calls: stats.calls, errors: stats.errors, discarded: stats.discarded, inspections: evaluation.inspections }));
    return result;
  } catch (error) { trace.emit('mission.invalid', { reason: String(error) }); throw error; }
  finally {
    lifetime.abort(); await world?.close(); await native?.close(); await Promise.allSettled([decisionTask, planTask].filter((p): p is Promise<void> => !!p)); trace.close();
  }
}

export async function runMissions(args = process.argv.slice(2)) {
  const options = new Map<string, string>(); for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Arguments must be --name value'); options.set(args[i]!.slice(2), args[i + 1]!); }
  const phase = options.get('phase') ?? 'flights';
  if (!['optimize', 'flights'].includes(phase)) throw new Error('phase must be optimize or flights');
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!key) throw new Error('Load TYPESAFE_API_KEY explicitly; this runner performs paid inference.');
  const directory = resolve(options.get('output') ?? `.runtime/experiments/missions-${Date.now()}`); mkdirSync(directory, { recursive: true });
  if (phase === 'optimize') { await optimizeMenus(directory, key); return; }
  const tuningPath = options.get('tuning');
  if (!tuningPath) throw new Error('Pass --tuning development-optimization.json; freeze before held-out flights.');
  const tuning = JSON.parse(await readFile(tuningPath, 'utf8')) as { winner: MenuFormat; sourceHash: string };
  if (!FORMATS.includes(tuning.winner)) throw new Error('Invalid frozen menu format');
  const seeds = (options.get('seeds') ?? '101,202,303').split(',').map(Number);
  if (seeds.some(s => !Number.isInteger(s) || s < 100 || s > 1000000) || seeds.length > 20) throw new Error('Held-out seeds must be 100..1000000, at most 20');
  const arms = (options.get('arms') ?? 'jev,claude,hybrid').split(',') as MissionArm[];
  if (arms.some(a => !['jev', 'claude', 'hybrid'].includes(a)) || new Set(arms).size !== arms.length) throw new Error('Invalid arms');
  const seconds = Number(options.get('seconds') ?? 40);
  if (!Number.isFinite(seconds) || seconds < 20 || seconds > 120) throw new Error('seconds must be 20..120');
  const model = options.get('claude-model') ?? 'claude-opus-5', effort = options.get('effort') ?? 'high';
  if (effort !== 'low' && effort !== 'high') throw new Error('effort must be low or high');
  const results = [];
  const manifest = { version: 1, createdAt: new Date().toISOString(), sourceHash: await sourceHash(), tuningPath: resolve(tuningPath), tuning,
    scope: 'live Jev vs native Claude structured selection vs asynchronous Claude advice plus Jev, all using the same executable drone controls', model, effort, seeds, arms, seconds };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [index, seed] of seeds.entries()) for (let i = 0; i < arms.length; i++) {
    const arm = arms[(index + i) % arms.length]!;
    console.log(JSON.stringify({ phase: 'flight-start', arm, seed, format: tuning.winner, model, effort }));
    results.push(await runFlight(arm, seed, tuning.winner, directory, key, model, effort, seconds));
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runMissions();
