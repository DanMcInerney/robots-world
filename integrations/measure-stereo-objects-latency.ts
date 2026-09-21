/**
 * Live-integrated latency measurement CLI for the streaming stereo-object sensor
 * (experiments/jev-library/sensor/) — the missing evidence LATEST_RESULTS.md calls for: a
 * continuously-fed pipeline, not a serial batch benchmark.
 *
 * Consumes the sensor's NDJSON records through nervelet's REAL `processSource` + `SourceGroup` +
 * `ObservationStore` when `ROBOTS_NERVELET_MODULE` resolves a built nervelet entry, otherwise
 * falls back to a plain NDJSON line reader wired directly to the child's stdout. Reports which
 * path was used in the summary. See `docs/jev-live-sensor-results.md` for the exact commands and
 * measured tables this tool produced.
 *
 * Contention recording (repair pass, see docs/jev-live-sensor-results.md "Failures and repairs"):
 * an independent review found the machine running the original measurement had a foreign GPU
 * compute app (a game) at ~98% GPU utilization throughout, inflating every latency figure. This
 * tool now records GPU utilization/power/memory, foreign GPU compute apps and CPU load before and
 * after every run, marks the run `contended` when any of those cross a declared threshold, and
 * `--require-quiet` refuses to even start the sensor when the machine is already contended.
 *
 * Not a test (not under test/*.test.ts, not run by `npm test`) — a standalone measurement tool,
 * run manually or from a small orchestrating shell command; see the docs for exact invocations.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { buildStereoObjectsSourceOptions } from './stereo-objects.ts';
import type { Json } from '../src/contracts.ts';

interface Args {
  pythonExecutable: string;
  sensorCwd: string;
  manifestPath: string;
  checkpointPath: string;
  detectorRuntimeRoot: string;
  sampleIdsFile: string;
  rateHz: number;
  stereo: 'sgbm' | 'ffs';
  ffsRuntimeRoot?: string;
  outDir: string;
  warmupFrames: number; // excluded from timing quantiles per the declared warm-up rule; still counted in processed/skipped
  timeoutMs: number;
  requireQuiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--require-quiet') { flags.add('require-quiet'); continue; }
    if (token.startsWith('--')) { map.set(token.replace(/^--/, ''), argv[++i]!); }
  }
  const required = (key: string): string => {
    const value = map.get(key);
    if (!value) throw new Error(`Missing required --${key}`);
    return value;
  };
  return {
    pythonExecutable: required('python'), sensorCwd: required('sensor-cwd'), manifestPath: required('manifest'),
    checkpointPath: required('checkpoint'), detectorRuntimeRoot: required('detector-runtime-root'),
    sampleIdsFile: required('sample-ids-file'), rateHz: Number(required('rate-hz')),
    stereo: (map.get('stereo') as 'sgbm' | 'ffs') ?? 'sgbm', ffsRuntimeRoot: map.get('ffs-runtime-root'),
    outDir: required('out-dir'), warmupFrames: Number(map.get('warmup-frames') ?? '5'),
    timeoutMs: Number(map.get('timeout-ms') ?? '120000'), requireQuiet: flags.has('require-quiet'),
  };
}

interface RawObservation { nodeReceivedPerfMs: number; record: Record<string, Json>; }

function quantile(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return NaN;
  const idx = Math.min(sortedAscending.length - 1, Math.max(0, Math.round(q * (sortedAscending.length - 1))));
  return sortedAscending[idx]!;
}

function stageSummary(values: number[]): { n: number; medianMs: number; p95Ms: number; maxMs: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, medianMs: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95), maxMs: sorted.at(-1) ?? NaN };
}

function gpuName(): string {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' }).trim().split('\n')[0]!;
  } catch {
    return 'unknown (nvidia-smi unavailable)';
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Declared before any measurement, not tuned to a particular run's numbers.
const CONTENTION_GPU_UTIL_PERCENT = 15;
const CONTENTION_CPU_LOAD_PERCENT = 50;

interface GpuState { utilizationPercent: number | null; powerW: number | null; memoryUsedMiB: number | null; computeApps: string[] }

function queryGpuState(): GpuState {
  let utilizationPercent: number | null = null, powerW: number | null = null, memoryUsedMiB: number | null = null;
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,power.draw,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim();
    const [util, power, mem] = out.split(',').map(s => Number(s.trim()));
    utilizationPercent = Number.isFinite(util) ? util! : null;
    powerW = Number.isFinite(power) ? power! : null;
    memoryUsedMiB = Number.isFinite(mem) ? mem! : null;
  } catch { /* nvidia-smi unavailable */ }
  let computeApps: string[] = [];
  try {
    const out = execFileSync('nvidia-smi', ['--query-compute-apps=pid,process_name', '--format=csv,noheader'], { encoding: 'utf8' }).trim();
    computeApps = out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
  } catch { /* ignore: no compute-apps support or no GPU */ }
  return { utilizationPercent, powerW, memoryUsedMiB, computeApps };
}

function cpuTimesSnapshot(): { idle: number; total: number }[] {
  return os.cpus().map(c => ({ idle: c.times.idle, total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }));
}

/** `os.loadavg()` is always `[0,0,0]` on Windows, so CPU load is sampled directly: two
 * `os.cpus()` snapshots `sampleMs` apart, compared for idle-time fraction. */
async function measureCpuLoadPercent(sampleMs = 200): Promise<number> {
  const before = cpuTimesSnapshot();
  await sleep(sampleMs);
  const after = cpuTimesSnapshot();
  let idleDelta = 0, totalDelta = 0;
  for (let i = 0; i < before.length; i++) { idleDelta += after[i]!.idle - before[i]!.idle; totalDelta += after[i]!.total - before[i]!.total; }
  return totalDelta > 0 ? 100 * (1 - idleDelta / totalDelta) : 0;
}

interface ContentionSnapshot {
  atIso: string;
  gpu: GpuState;
  cpuLoadPercent: number;
  contended: boolean;
  reasons: string[];
}

async function measureContention(): Promise<ContentionSnapshot> {
  const gpu = queryGpuState();
  const cpuLoadPercent = await measureCpuLoadPercent();
  const reasons: string[] = [];
  if (gpu.utilizationPercent !== null && gpu.utilizationPercent > CONTENTION_GPU_UTIL_PERCENT) reasons.push(`gpuUtilization ${gpu.utilizationPercent}% > ${CONTENTION_GPU_UTIL_PERCENT}%`);
  if (gpu.computeApps.length > 0) reasons.push(`foreign GPU compute app(s) present: ${gpu.computeApps.join('; ')}`);
  if (cpuLoadPercent > CONTENTION_CPU_LOAD_PERCENT) reasons.push(`cpuLoad ${cpuLoadPercent.toFixed(1)}% > ${CONTENTION_CPU_LOAD_PERCENT}%`);
  return { atIso: new Date().toISOString(), gpu, cpuLoadPercent, contended: reasons.length > 0, reasons };
}

async function runViaNervelet(args: Args, built: ReturnType<typeof buildStereoObjectsSourceOptions>, rawLog: (line: string) => void) {
  const specifier = process.env.ROBOTS_NERVELET_MODULE!;
  const nervelet = await import(specifier.startsWith('file:') ? specifier : pathToFileURL(resolve(specifier)).href);
  if (typeof nervelet.processSource !== 'function' || typeof nervelet.SourceGroup !== 'function' || typeof nervelet.ObservationStore !== 'function') {
    throw new Error('ROBOTS_NERVELET_MODULE must resolve a build exporting processSource/SourceGroup/ObservationStore.');
  }
  const observations: RawObservation[] = [];
  let helloRecord: any = null;
  let byeRecord: any = null;
  const innerMap = built.map;
  const instrumentedMap = (record: Json) => {
    const nodeReceivedPerfMs = performance.now();
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const r = record as Record<string, Json>;
      if (r.type === 'hello') helloRecord = r;
      else if (r.type === 'bye') byeRecord = r;
      else { observations.push({ nodeReceivedPerfMs, record: r }); rawLog(JSON.stringify({ nodeReceivedPerfMs, record: r })); }
    }
    return innerMap(record);
  };
  const source = nervelet.processSource({ ...built, map: instrumentedMap });
  const store = new nervelet.ObservationStore();
  const group = new nervelet.SourceGroup(store, [source]);
  const controller = new AbortController();
  await group.start(controller.signal);
  const deadline = Date.now() + args.timeoutMs;
  let sawExit = false;
  // Properly paged: `snapshot(after)` only ever returns up to 64 unread events past `after`, so
  // repeatedly calling `snapshot(0)` can get permanently stuck behind the same oldest 64 once a
  // run produces more events than that (observed: a longer replay's own `object_appeared` stream
  // plus lifecycle/diagnostics events can exceed 64 before the exit event arrives, and the loop
  // would then time out waiting for an exit event it could structurally never see). Acknowledging
  // what's been read also keeps the store's own 256-event cap from ever being reached.
  let afterSeq = 0;
  while (Date.now() < deadline) {
    const snap = store.snapshot(afterSeq);
    if (snap.events?.length) {
      afterSeq = snap.events[snap.events.length - 1]!.seq;
      store.acknowledge(afterSeq);
      if (snap.events.some((e: any) => e.kind === 'stereoObjects.lifecycle' && e.data?.kind === 'exit')) { sawExit = true; break; }
    }
    await sleep(20);
  }
  if (!sawExit) throw new Error(`Timed out after ${args.timeoutMs}ms waiting for the sensor process to exit`);
  const finalSnapshot = store.snapshot(afterSeq);
  const diagnostics = finalSnapshot.samples?.['stereoObjects.diagnostics']?.value ?? null;
  await group.stop();
  return { observations, helloRecord, byeRecord, diagnostics, malformedAtConsumer: (diagnostics as any)?.malformed ?? 0, droppedEventsAtConsumer: (diagnostics as any)?.droppedEvents ?? 0 };
}

async function runViaPlainReader(args: Args, built: ReturnType<typeof buildStereoObjectsSourceOptions>, rawLog: (line: string) => void) {
  const observations: RawObservation[] = [];
  let helloRecord: any = null;
  let byeRecord: any = null;
  let malformed = 0;
  const child = spawn(built.command, built.args ?? [], { cwd: built.cwd, windowsHide: true });
  const rl = createInterface({ input: child.stdout });
  const stderrChunks: string[] = [];
  child.stderr.on('data', chunk => stderrChunks.push(chunk.toString('utf8')));
  const done = new Promise<void>((resolveWait, rejectWait) => {
    child.once('close', () => resolveWait());
    child.once('error', rejectWait);
  });
  rl.on('line', line => {
    const nodeReceivedPerfMs = performance.now();
    let record: any;
    try { record = JSON.parse(line); } catch { malformed++; return; }
    if (record?.type === 'hello') helloRecord = record;
    else if (record?.type === 'bye') byeRecord = record;
    else { observations.push({ nodeReceivedPerfMs, record }); rawLog(JSON.stringify({ nodeReceivedPerfMs, record })); }
  });
  const timeout = sleep(args.timeoutMs).then(() => { throw new Error(`Timed out after ${args.timeoutMs}ms (plain reader)`); });
  await Promise.race([done, timeout]);
  return { observations, helloRecord, byeRecord, diagnostics: null, malformedAtConsumer: malformed, droppedEventsAtConsumer: 0, stderrTail: stderrChunks.join('').slice(-2000) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });
  const rawPath = resolve(args.outDir, `raw-${args.rateHz}hz.ndjson`);
  const rawStream = createWriteStream(rawPath, { flags: 'w' });
  const rawLog = (line: string) => rawStream.write(line + '\n');

  const contentionBefore = await measureContention();
  console.error(`[measure] contention check: contended=${contentionBefore.contended} ${contentionBefore.reasons.join('; ')}`);
  if (contentionBefore.contended && args.requireQuiet) {
    writeFileSync(resolve(args.outDir, `contention-refused-${args.rateHz}hz.json`), JSON.stringify(contentionBefore, null, 2), 'utf8');
    throw new Error(`--require-quiet: machine is contended (${contentionBefore.reasons.join('; ')}); refusing to run. See contention-refused-${args.rateHz}hz.json`);
  }

  const built = buildStereoObjectsSourceOptions({
    id: 'stereoObjects', pythonExecutable: args.pythonExecutable, sensorCwd: args.sensorCwd,
    manifestPath: args.manifestPath, rateHz: args.rateHz, checkpointPath: args.checkpointPath,
    detectorRuntimeRoot: args.detectorRuntimeRoot, sampleIdsFile: args.sampleIdsFile,
    stereo: args.stereo, ffsRuntimeRoot: args.ffsRuntimeRoot,
  });
  // A real processSource spawn gives the child a genuine Node-managed pipe for stdin (open, never
  // EOF until this Node process itself ends or explicitly closes it) — unlike a shell-redirected
  // named pipe under Git-Bash/MSYS on Windows (see sensor/main.py's run_sensor() docstring), so
  // --no-stdin-watch is intentionally NOT added here.

  const consumerPath = process.env.ROBOTS_NERVELET_MODULE ? 'nervelet (processSource + SourceGroup + ObservationStore)' : 'plain-ndjson-reader';
  console.error(`[measure] rate=${args.rateHz}Hz stereo=${args.stereo} consumer=${consumerPath}`);
  const started = Date.now();
  const result = process.env.ROBOTS_NERVELET_MODULE ? await runViaNervelet(args, built, rawLog) : await runViaPlainReader(args, built, rawLog);
  const wallMs = Date.now() - started;
  rawStream.end();
  const contentionAfter = await measureContention();

  const observations = result.observations;
  const warm = observations.slice(args.warmupFrames); // declared warm-up rule: first N processed frames excluded from quantiles
  const acquireToEmit = warm.map(o => Number(o.record.emittedMs) - Number((o.record.acquired as any).ms));
  // acquired.ms/emittedMs are already unix epoch ms (see sensor/clock.py) — no hello-based
  // reconciliation needed; the consumer's own receipt time is anchored the same way.
  const nodeEpochAtRef = Date.now();
  const nodePerfAtRef = performance.now();
  const acquireToConsumerAges = warm.map(o => {
    const receivedWallMs = nodeEpochAtRef + (o.nodeReceivedPerfMs - nodePerfAtRef);
    return receivedWallMs - Number((o.record.acquired as any).ms);
  });
  const stageKeys = ['decode', 'detect', 'stereo', 'aggregate', 'total'] as const;
  const perStage: Record<string, ReturnType<typeof stageSummary>> = {};
  for (const key of stageKeys) perStage[key] = stageSummary(warm.map(o => Number((o.record.timingMs as any)?.[key])).filter(Number.isFinite));

  const lineSizesFromBye = result.byeRecord?.maxLineBytesSeen;
  const objectsTruncatedCount = observations.filter(o => o.record.objectsTruncated === true).length;
  const processed = observations.length;
  const totalSeqSpan = observations.length ? Number(observations.at(-1)!.record.seq) : 0;
  const skippedTotalFromBye = result.byeRecord?.skippedTotal ?? null;
  const skippedFraction = totalSeqSpan > 0 ? (Number(skippedTotalFromBye ?? 0)) / totalSeqSpan : null;
  const fpsIncludingStartup = wallMs > 0 ? (processed / (wallMs / 1000)) : NaN;
  // Steady-state fps: excludes model-load/warmup by spanning only the emittedMs of the warm
  // (post-warmupFrames) observations themselves, not this process's own wall clock (which
  // includes the one-time ~5s model load before the first frame).
  let steadyStateFps: number | null = null;
  if (warm.length >= 2) {
    const spanMs = Number(warm.at(-1)!.record.emittedMs) - Number(warm[0]!.record.emittedMs);
    steadyStateFps = spanMs > 0 ? (warm.length - 1) / (spanMs / 1000) : null;
  }

  const summary = {
    rateHz: args.rateHz, stereoBackend: args.stereo, consumerPath, wallMs,
    warmupFramesExcluded: args.warmupFrames,
    contentionBefore, contentionAfter,
    contended: contentionBefore.contended || contentionAfter.contended,
    processed, skippedTotal: skippedTotalFromBye, skippedFraction,
    processedFpsIncludingStartup: fpsIncludingStartup, processedFpsSteadyState: steadyStateFps,
    acquireToEmitAgeMs: stageSummary(acquireToEmit),
    acquireToConsumerReceiptAgeMs: stageSummary(acquireToConsumerAges),
    perStageTimingMs: perStage,
    maxLineBytesSeen: lineSizesFromBye ?? null,
    objectCapTruncations: objectsTruncatedCount,
    malformedOrOversizeAtConsumer: result.malformedAtConsumer,
    droppedEventsAtConsumer: result.droppedEventsAtConsumer,
    byeRecord: result.byeRecord, helloModel: result.helloRecord?.model ?? null,
    gpuName: gpuName(), cpuModel: os.cpus()[0]?.model ?? 'unknown', platform: `${os.platform()} ${os.release()}`,
    rawLogPath: rawPath,
  };
  const summaryPath = resolve(args.outDir, `summary-${args.rateHz}hz.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
