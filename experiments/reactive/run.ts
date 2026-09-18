import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CONTRACT, goalFor, makeMenu, selected, type Arm, type Menu, type ReactiveState, type Relation } from './contract.ts';
import { BRIEF_SCHEMA, ClaudeJson, CodexJson, decisionInput, jev, parseBrief, type Answer } from './providers.ts';
import { ReactiveWorld, type Emit, type SensorExperiment } from './world.ts';
import type { Controller, RobotPort } from '../../src/contracts.ts';
import { CAPABILITIES, DEFAULT_CONFIG, experimentConfig, type ExperimentConfig } from './config.ts';
import { judge, STRATEGIES, type Strategy } from '../jev-strategies/strategies.ts';

/** Hash complete local source trees so new adapters cannot silently escape a freeze. */
export async function sourceHash() {
  const files = ['package.json', 'package-lock.json'];
  for (const root of ['src', 'controllers', 'integrations', 'experiments', 'scenarios']) {
    for (const file of await readdir(root, { recursive: true })) if (file.endsWith('.ts') || file.endsWith('.json')) files.push(`${root}/${file.replaceAll('\\', '/')}`);
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update(await readFile(file));
  return hash.digest('hex');
}
export class Trace {
  private fd: number; private count = 0; private bytes = 0; private closed = false;
  constructor(file: string) { this.fd = openSync(file, 'wx'); }
  emit: Emit = (kind, data) => {
    if (this.closed) return;
    let line = JSON.stringify({ kind, wallMs: Date.now(), monoMs: performance.now(), data }, (k, v) => /^(authorization|api[_-]?key|password|secret)$/i.test(k) ? '[redacted]' : v);
    for (const key of [process.env.TYPESAFE_API_KEY, process.env.JEV_API_KEY]) if (key) line = line.split(key).join('[redacted]');
    if (++this.count > 180000 || Buffer.byteLength(line) > 800000 || this.bytes + Buffer.byteLength(line) > 150_000_000) throw new Error('Trace capacity exceeded');
    this.bytes += writeSync(this.fd, line + '\n');
  };
  close() { if (this.closed) return; try { this.emit('trace.complete', { count: this.count, bytes: this.bytes, dropped: 0 }); } finally { this.closed = true; closeSync(this.fd); } }
}
const percentile = (a: number[], p: number) => a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1]! : null;

async function prepareBrief(directory: string) {
  const trace = new Trace(resolve(directory, 'brief.jsonl')); let native: CodexJson | undefined;
  try {
    native = await CodexJson.create(resolve(directory, 'native', 'brief'), trace.emit, 'advisor');
    const answer = await native.ask({ task: 'Write a short reusable decision brief for a fast judgment model piloting a camera drone. Translate this English mission into immediate semantic comparisons among offered candidate consequences. No numeric waypoint, fixed route, scenario assumptions, future events or executable code. Ground all guidance in the latest measurements and exact CURRENT goal; future operator goals can differ. Do not rank or remove candidates in software. Return instructions only.',
      representativeGoalFamily: (['left', 'right', 'ahead', 'behind'] as Relation[]).map(relation => goalFor(relation)), contract: CONTRACT,
      candidateFacts: ['predicted end position', 'offset ahead/behind, left/right, above/below the rover', 'distance to rover', 'nearest sparse range return along estimated movement', 'projected image centre'],
    }, AbortSignal.timeout(180000), BRIEF_SCHEMA);
    const result = { instructions: parseBrief(answer), origin: 'actual Codex gpt-5.6-luna xhigh before flight', answer, sourceHash: await sourceHash() };
    await writeFile(resolve(directory, 'brief.json'), JSON.stringify(result, null, 2)); return result;
  } finally { await native?.close(); trace.close(); }
}

export async function trial(options: { arm: string; seed: number; seconds: number; directory: string; key?: string; phase: string; brief?: string; config?: ExperimentConfig; strategy?: Strategy; maxDecisions?: number; controller?: Controller; controllerSource?: { files: string[] }; connectControllerTrace?: (emit: Emit) => void; fixtureDecision?: (menu: Menu, signal: AbortSignal) => Promise<Answer>; realtime?: boolean; sensorExperiment?: SensorExperiment }) {
  if (!/^[\w-]+$/.test(options.arm) || !Number.isInteger(options.seed) || !Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 90) throw new Error('Invalid trial identity/duration');
  if ((options.fixtureDecision || options.realtime === false) && options.phase !== 'fixture') throw new Error('Synthetic controls or accelerated time require fixture phase');
  if (options.controller && options.phase !== 'fixture' && !options.controllerSource?.files.length) throw new Error('Controller source files required for provenance');
  const config = experimentConfig(options.config);
  const maxDecisions = options.maxDecisions ?? 150;
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 500) throw new Error('Invalid decision bound');
  if (options.strategy && (options.controller || options.fixtureDecision || !Object.hasOwn(STRATEGIES, options.strategy))) throw new Error('Ambiguous strategy controller');
  const { arm, seed, seconds, directory, key = '', phase } = options, id = `${arm}-${seed}`, trace = new Trace(resolve(directory, `${id}.jsonl`)), lifetime = new AbortController();
  let world: ReactiveWorld | undefined, native: ClaudeJson | CodexJson | undefined, repair: CodexJson | undefined;
  let pending: Promise<void> | undefined, pendingRepair: Promise<void> | undefined, ready: { menu: Menu; answer?: Answer; error?: string } | undefined;
  let controllerPort: RobotPort | undefined;
  let controllerTask: Promise<void> | undefined, controllerError: string | undefined, controllerFinished = false, controllerFailed = false;
  let advice = options.brief, repairStarted = false, nextAt = 0, maxLagMs = 0, setupStart = performance.now();
  const stats = { started: 0, completed: 0, admitted: 0, rejected: 0, errors: 0, cancelled: 0, repairsStarted: 0, repairsCompleted: 0, repairsInstalled: 0, repairsStale: 0, cancelledRepairs: 0, latencyMs: [] as number[], sourceAgeMs: [] as number[], repairLatencyMs: [] as number[], usage: [] as unknown[], cumulativeCostUsd: null as number | null, selectedIds: [] as string[], menuCounts: [] as number[] };
  try {
    options.connectControllerTrace?.(trace.emit);
    if (options.sensorExperiment && !options.controller) throw new Error('Sensor experiment requires an explicit sensor-only controller');
    world = await ReactiveWorld.create(seed, trace.emit, seconds * 500, config, options.sensorExperiment); const runtime = world;
    if (!options.controller && !options.fixtureDecision) {
      try {
        if (arm === 'claude-facts') native = await ClaudeJson.create(resolve(directory, 'native', id), trace.emit);
        if (arm === 'codex-facts') native = await CodexJson.create(resolve(directory, 'native', id), trace.emit);
        if (arm === 'jev-repair') repair = await CodexJson.create(resolve(directory, 'native', id), trace.emit, 'advisor');
        if (!native && !key) throw new Error('Real Jev credential required');
      } catch (error) { controllerError = String(error); }
    }
    const controllerSources = await Promise.all((options.controllerSource?.files ?? []).map(async file => ({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })));
    const hash = await sourceHash();
    const start = performance.now() - world.world.simMs, setupMs = performance.now() - setupStart;
    trace.emit('reactive.manifest', { id, phase, arm, seed, seconds, runtime: { node: process.version, platform: process.platform, arch: process.arch }, sourceHash: hash, config, capabilities: CAPABILITIES, controllerSources, controllerArrangement: options.controller ? { id: options.controller.id, interface: 'RobotPort: continuous controls and native tools' } : options.fixtureDecision ? 'synthetic mechanics fixture' : 'restricted menu choice', scenario: world.world.scenario, setupMs, initialBrief: advice ?? null,
      strategy: options.strategy ? STRATEGIES[options.strategy] : null, maxDecisions, sensorExperiment: options.sensorExperiment ? { id: options.sensorExperiment.id, sourceSensor: options.sensorExperiment.sourceSensor, envelopeGuard: 'disabled; no global position supplied', sourceAgeField: 'odometryMs legacy trace key contains camera acquisition time' } : null,
      interpretation: phase === 'fixture' ? 'OFFLINE MECHANICS FIXTURE. No AI performance evidence.' : 'Real inference in simplified simulation. Capabilities and controller representation are separate. No evaluator data in decision input.', sourceAgeLimitMs: config.sourceAgeLimitMs, minimumRefreshMs: config.minimumRefreshMs });
    if (options.controller) {
      const port = world.controllerPort(); controllerPort = port;
      controllerTask = Promise.resolve().then(() => options.controller!.run([port], lifetime.signal)).then(() => { if (!lifetime.signal.aborted) controllerFinished = true; }).catch(error => { if (!lifetime.signal.aborted) controllerError = String(error); });
    }
    while (world.world.simMs < seconds * 1000) {
      if (controllerError && !controllerFailed) { controllerFailed = true; stats.errors++; lifetime.abort(); await world.failController(controllerError); }
      if (controllerFinished) { controllerFinished = false; await controllerPort!.stop(); }
      if (ready && !controllerFailed) {
        if (ready.answer) {
          const candidate = selected(ready.answer.value, ready.menu), receipt = await world.apply(candidate.action, ready.menu.source);
          if (receipt.accepted) stats.admitted++; else stats.rejected++;
          stats.sourceAgeMs.push(world.world.simMs - ready.menu.source.odometryMs); stats.selectedIds.push(candidate.id);
          trace.emit('reactive.decision', { simMs: world.world.simMs, source: ready.menu.source, menuHash: ready.menu.hash, candidate, answer: ready.answer, receipt });
        } else {
          stats.errors++; trace.emit('reactive.error', { simMs: world.world.simMs, error: ready.error, fallback: 'Explicit local hold; world continues. No retry of the failed controller attempt.' });
          controllerFailed = true; lifetime.abort(); await world.failController(ready.error ?? 'invalid-controller-response');
        }
        ready = undefined;
      }
      // One bounded repair in the second goal phase. It receives only the same public state/menu.
      if (!controllerFailed && repair && !repairStarted && world.world.simMs >= seconds * 500 + 2000) {
        repairStarted = true; stats.repairsStarted++; const menu = makeMenu(world.state(), true, config);
        pendingRepair = repair.ask({ instruction: 'Revise the reusable decision brief based on this latest English goal and observed behavior. No fixed coordinates or future assumptions. Produce brief instructions for choosing from fresh candidate descriptions; never select or execute the present action. Refer to the current goal at decision time rather than hardcoding one side.', currentAdvice: advice, controlContract: CONTRACT, publicState: menu.state, availableCandidates: menu.criteria }, lifetime.signal, BRIEF_SCHEMA).then(answer => {
          if (lifetime.signal.aborted) return; stats.repairsCompleted++; stats.repairLatencyMs.push(answer.latencyMs);
          const current = runtime.state(), valid = current.goalVersion === menu.source.goalVersion;
          if (valid) { advice = parseBrief(answer); stats.repairsInstalled++; } else stats.repairsStale++;
          trace.emit('reactive.repair', { simMs: runtime.world.simMs, source: menu.source, accepted: valid, answer, instructions: valid ? advice : null });
        }).catch(error => { if (!lifetime.signal.aborted) trace.emit('reactive.repair.error', { simMs: runtime.world.simMs, error: String(error) }); }).finally(() => { pendingRepair = undefined; });
      }
      if (!options.controller && !controllerFailed && !pending && !ready && world.world.simMs >= nextAt && stats.started < maxDecisions) {
        const state = world.state(), menu = makeMenu(state, arm !== 'jev-bare', config); stats.menuCounts.push(menu.candidates.length); nextAt = state.simMs + config.minimumRefreshMs;
        trace.emit('reactive.menu', { simMs: state.simMs, source: menu.source, menuHash: menu.hash, candidates: menu.candidates, ...(options.strategy ? { rawSensors: state } : {}) });
        if (!menu.candidates.length) { controllerFailed = true; lifetime.abort(); await world.failController('empty-action-menu'); }
        else {
        stats.started++;
        const request = Promise.resolve().then(() => options.fixtureDecision ? options.fixtureDecision(menu, lifetime.signal) : options.strategy ? judge(menu, options.strategy, key, trace.emit, lifetime.signal) : native ? native.ask(decisionInput(menu), lifetime.signal) : jev(menu, key, trace.emit, lifetime.signal, advice));
        pending = request.then(answer => {
          if (lifetime.signal.aborted) return; selected(answer.value, menu); stats.completed++; stats.latencyMs.push(answer.latencyMs); if (answer.usage) stats.usage.push(answer.usage); if (answer.cumulativeCostUsd !== undefined) stats.cumulativeCostUsd = answer.cumulativeCostUsd;
          ready = { menu, answer };
        }).catch(error => { if (!lifetime.signal.aborted) ready = { menu, error: String(error) }; }).finally(() => { pending = undefined; });
      }
      }
      await world.tick(); const lag = performance.now() - start - world.world.simMs; maxLagMs = Math.max(maxLagMs, lag);
      if (options.realtime !== false) { if (lag > 1000) throw new Error('Pacing exceeded 1 second; invalid trial'); if (lag < 0) await sleep(-lag); }
    }
    if (pending) stats.cancelled++; if (pendingRepair) stats.cancelledRepairs++; lifetime.abort();
    if (await sourceHash() !== hash) throw new Error('Source changed during trial');
    const result = { id, phase, arm, seed, seconds, setupMs, wallMs: performance.now() - start, maxLagMs, sourceHash: hash, config, controllerSources, controllerStatus: controllerFailed ? 'failed-world-continued' : 'finished', stats, latencyP50Ms: percentile(stats.latencyMs, .5), latencyP95Ms: percentile(stats.latencyMs, .95), evaluation: world.evaluate() };
    trace.emit('reactive.result', result); await writeFile(resolve(directory, `${id}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ event: 'complete', id, success: result.evaluation.success, phasesInspected: result.evaluation.phases.filter(p => p.inspectedAt !== null).length, visible: result.evaluation.visibleFraction, contacts: result.evaluation.collisionTicks, p50: result.latencyP50Ms, admitted: stats.admitted, rejected: stats.rejected, errors: stats.errors, repairs: stats.repairsInstalled }));
    return result;
  } catch (error) { trace.emit('reactive.invalid', { error: String(error) }); throw error; }
  finally {
    lifetime.abort(); await world?.close();
    const cleanup = Promise.allSettled([native?.close(), repair?.close(), pending, pendingRepair, controllerTask]);
    const timeout = new AbortController();
    const settled = await Promise.race([cleanup.then(() => true), sleep(2000, false, { signal: timeout.signal })]); timeout.abort();
    if (!settled) trace.emit('reactive.cleanup.timeout', { authorityRevoked: true, reason: 'Controller did not settle within 2 seconds; in-process JavaScript cannot be forcibly terminated. Use a process boundary for untrusted controllers.' });
    trace.close();
  }
}

/** Actual model probe: identical delivered observation and actions, different English goals. */
async function probe(directory: string, key: string) {
  const trace = new Trace(resolve(directory, 'goal-probe.jsonl')); const world = await ReactiveWorld.create(17);
  try {
    for (let i = 0; i < 200; i++) await world.tick(); const snapshot = world.state();
    const results = [];
    for (const relation of ['left', 'right', 'ahead', 'behind'] as Relation[]) {
      const state: ReactiveState = { ...snapshot, goal: goalFor(relation) }, menu = makeMenu(state);
      const answer = await jev(menu, key, trace.emit, AbortSignal.timeout(10000)), candidate = selected(answer.value, menu);
      results.push({ relation, menuHash: menu.hash, choice: candidate.id, candidate, answer });
    }
    const result = { purpose: 'Goal sensitivity probe; frozen observation, not a continuous flight or success test.', identicalMenus: new Set(results.map(r => r.menuHash)).size === 1, distinctChoices: new Set(results.map(r => r.choice)).size, state: snapshot, results };
    await writeFile(resolve(directory, 'goal-probe.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ event: 'probe', identicalMenus: result.identicalMenus, distinctChoices: result.distinctChoices }));
  } finally { await world.close(); trace.close(); }
}

export async function run(args = process.argv.slice(2)) {
  const opts = new Map<string, string>(); for (let i = 0; i < args.length; i += 2) { if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('--name value pairs required'); opts.set(args[i]!.slice(2), args[i + 1]!); }
  const phase = opts.get('phase') ?? 'development', directory = resolve(opts.get('output') ?? `.runtime/experiments/reactive-${Date.now()}`), key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!key) throw new Error('Explicit real Jev credential required'); if (!['development', 'held-out', 'probe', 'prepare'].includes(phase)) throw new Error('Unknown phase'); mkdirSync(directory, { recursive: true });
  if (phase === 'probe') { await probe(directory, key); return; }
  if (phase === 'prepare') { await prepareBrief(directory); return; }
  const seeds = (opts.get('seeds') ?? (phase === 'development' ? '11,12' : '401,402,403')).split(',').map(Number), seconds = Number(opts.get('seconds') ?? (phase === 'development' ? 30 : 60));
  if (!Number.isFinite(seconds) || seconds < 15 || seconds > 90 || seeds.some(s => !Number.isInteger(s) || s < 1 || s > 100000 || phase === 'development' && s >= 100 || phase === 'held-out' && s < 100) || seeds.length > 8) throw new Error('Invalid split or duration');
  const allowed: Arm[] = ['jev-bare', 'jev-facts', 'claude-facts', 'codex-facts', 'jev-brief', 'jev-repair'];
  const arms = (opts.get('arms') ?? (phase === 'development' ? 'jev-bare,jev-facts' : allowed.join(','))).split(',') as Arm[];
  if (!arms.length || new Set(arms).size !== arms.length || arms.some(a => !allowed.includes(a))) throw new Error('Invalid arms');
  let brief: { instructions: string; sourceHash: string } | undefined;
  if (arms.some(a => a === 'jev-brief' || a === 'jev-repair')) { if (!opts.get('brief')) throw new Error('Preflight brief file required'); brief = JSON.parse(await readFile(resolve(opts.get('brief')!), 'utf8')); if (brief?.sourceHash !== await sourceHash()) throw new Error('Brief source differs'); }
  const hash = await sourceHash(), config = experimentConfig(opts.has('config') ? JSON.parse(await readFile(resolve(opts.get('config')!), 'utf8')) : DEFAULT_CONFIG);
  if (phase === 'held-out') { if (!opts.get('freeze')) throw new Error('Development freeze required'); const frozen = JSON.parse(await readFile(resolve(opts.get('freeze')!), 'utf8')); if (frozen.sourceHash !== hash || JSON.stringify(frozen.manifest.config) !== JSON.stringify(config)) throw new Error('Source or configuration changed after development'); }
  const manifest = { recordedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, phase, sourceHash: hash, arms, seeds, seconds, briefFile: opts.get('brief') ?? null, config, evaluation: 'Predeclared sustained framing in both phases, plus continuous dwell, no collisions/bounds/controller failures/delivery guard interventions. Original one-second attainment is a secondary metric. No held-out tuning.' };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' }); const results = [], invalidTrials = [];
  for (const [index, seed] of seeds.entries()) for (let offset = 0; offset < arms.length; offset++) {
    const arm = arms[(index + offset) % arms.length]!; console.log(JSON.stringify({ event: 'start', arm, seed }));
    try { results.push(await trial({ arm, seed, seconds, directory, phase, key, config, brief: arm === 'jev-brief' || arm === 'jev-repair' ? brief!.instructions : undefined })); }
    catch (error) { const invalid = { id: `${arm}-${seed}`, arm, seed, plannedSeconds: seconds, error: String(error), status: 'invalid-infrastructure' }; invalidTrials.push(invalid); await writeFile(resolve(directory, `${invalid.id}.invalid.json`), JSON.stringify(invalid, null, 2), { flag: 'wx' }); }
    await writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results, invalidTrials }, null, 2));
  }
  if (phase === 'development' && !invalidTrials.length) await writeFile(resolve(directory, 'freeze.json'), JSON.stringify({ sourceHash: hash, manifest, note: 'All predeclared representations are retained; do not tune against held-out results.' }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
