import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const percentile = (a: number[], p: number) => a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * p) - 1]! : null;
/** Read completed immutable evidence. No inferred latency, rescoring, or model requests. */
export async function report(directory: string) {
  const excluded = await access(resolve(directory, 'EXCLUDED.json')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
  if (excluded) throw new Error('Excluded experiment batch; preserve its evidence without publishing a comparison');
  const result = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
  const failures: any[] = result.failures ?? [], invalidTrials: any[] = result.invalidTrials ?? [];
  const expected = result.manifest.arms.flatMap((arm: string) => result.manifest.seeds.map((seed: number) => `${arm}-${seed}`));
  const ids = [...result.results, ...failures, ...invalidTrials].map((run: any) => run.id);
  if (new Set(ids).size !== ids.length || ids.some((id: string) => !expected.includes(id))) throw new Error('Duplicate or unexpected trial');
  result.comparison = { complete: ids.length === expected.length, attempted: ids.length, completed: result.results.length, terminated: failures.length, invalid: invalidTrials.length, expected: expected.length };
  const failureReplays = failures.map(f => ({ ...f, seconds: f.plannedSeconds, latencyP50Ms: percentile(f.completedLatencyMs, .5),
    evaluation: { success: false, visibleFraction: null, inspectionAtMs: null, collisionTicks: null, boundsTicks: null, trajectory: f.trajectory } }));
  const groups: Record<string, any[]> = {};
  for (const run of [...result.results, ...failureReplays]) {
    if (!/^[\w-]+$/.test(run.id)) throw new Error('Invalid trace identity');
    const trace = (await readFile(resolve(directory, `${run.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (trace.at(-1)?.kind !== 'trace.complete' || trace.some(r => r.kind === 'reactive.invalid' && (!run.termination || r.data.error !== run.error))) throw new Error(`Invalid/incomplete trace ${run.id}`);
    const manifest = trace.find(r => r.kind === 'reactive.manifest'); if (!manifest || manifest.data.sourceHash !== result.manifest.sourceHash) throw new Error('Manifest mismatch');
    run.config = manifest.data.config; run.controllerArrangement = manifest.data.controllerArrangement; run.capabilities = manifest.data.capabilities;
    run.scenario = manifest.data.scenario; run.traceFile = `${run.id}.jsonl`; run.replayEvents = [];
    let latestSimMs = 0;
    run.replayEvents.push({ simMs: 0, channel: 'policy', data: { kind: 'initial goal', goalVersion: 1, goal: run.scenario.robots.find((r: any) => r.id === 'drone')?.goal } });
    if (manifest.data.initialBrief) run.replayEvents.push({ simMs: 0, channel: 'policy', data: { kind: 'preflight advice', instructions: manifest.data.initialBrief } });
    for (const row of trace) {
      if (typeof row.data?.simMs === 'number') latestSimMs = Math.max(latestSimMs, row.data.simMs);
      if (row.kind.startsWith('reactive.fallback') || row.kind.startsWith('reactive.controller.') || row.kind.startsWith('reactive.command.') || row.kind.startsWith('reactive.port.') || row.kind === 'reactive.cleanup.timeout') run.replayEvents.push({ simMs: latestSimMs, channel: 'lifecycle', data: { kind: row.kind, ...row.data } });
      if (row.kind === 'reactive.decision' || row.kind === 'reactive.error') run.replayEvents.push({ simMs: latestSimMs, channel: 'decision', data: row.data });
      if (row.kind === 'reactive.goal' || row.kind === 'reactive.repair' || row.kind === 'reactive.repair.error') run.replayEvents.push({ simMs: latestSimMs, channel: 'policy', data: { kind: row.kind, ...row.data } });
      if (row.kind === 'jev.response' || row.kind === 'jev.http-error' || row.kind === 'claude.result' || row.kind === 'codex.message') run.replayEvents.push({ simMs: latestSimMs, channel: 'response', data: { kind: row.kind, ...row.data } });
      if (row.kind !== 'world.event' || row.data.robotId !== 'drone') continue;
      const event = row.data;
      if (event.channel === 'protocol' && event.kind === 'rx' || event.channel === 'sensor' && event.data?.sensorId === 'camera' || event.channel === 'network' && event.kind.includes('deliver')) run.replayEvents.push({ simMs: event.simMs, channel: event.channel, data: event.data });
    }
    groups[run.arm] ??= []; if (!run.termination) groups[run.arm].push(run);
  }
  for (const invalid of invalidTrials) groups[invalid.arm] ??= [];
  const summary = Object.entries(groups).map(([arm, runs]) => {
    const terminated = failures.filter(f => f.arm === arm), invalid = invalidTrials.filter(f => f.arm === arm);
    const primary = !!result.manifest.config;
    const sum = (fn: (r: any) => number) => runs.reduce((s, r) => s + fn(r), 0), latency = runs.flatMap(r => r.stats.latencyMs);
    const allLatency = [...latency, ...terminated.flatMap(f => f.completedLatencyMs)];
    const knownCosts = [...runs.map(r => r.stats.cumulativeCostUsd), ...terminated.map(f => f.lastReportedNativeCostUsd)].filter((n): n is number => typeof n === 'number');
    return { arm, trials: runs.length, attempted: runs.length + terminated.length + invalid.length, terminated: terminated.length, invalid: invalid.length, passed: sum(r => Number(r.evaluation.success)), phasesInspected: sum(r => r.evaluation.phases.filter((p: any) => p.inspectedAt !== null).length),
      sustainedFramingPasses: sum(r => Number(primary ? r.evaluation.success : r.evaluation.success && r.evaluation.phases.every((p: any) => p.framingFraction >= .5))),
      sustainedFramingScope: primary ? 'Predeclared primary score; thresholds recorded in manifest.config.scoring.' : 'Post-hoc stricter interpretation: requested-side/range/centering geometry holds for >=50% of each scored phase. Original score unchanged.',
      continuousMetricsScope: 'Completed full-duration flights only; early terminations remain failed attempts with separate partial evidence.',
      allAttemptP50Ms: percentile(allLatency, .5), allAttemptP95Ms: percentile(allLatency, .95), allAttemptCompletedResponses: allLatency.length,
      allAttemptKnownNativeCostUsd: knownCosts.length ? knownCosts.reduce((a, b) => a + b, 0) : null,
      visibleFraction: runs.length ? sum(r => r.evaluation.visibleFraction) / runs.length : null, framingFraction: runs.length ? sum(r => r.evaluation.phases.reduce((s: number, p: any) => s + p.framingFraction, 0) / r.evaluation.phases.length) / runs.length : null,
      metric: result.manifest.config?.scoring ?? 'legacy-one-second-attainment',
      controlAdmissions: primary ? sum(r => r.evaluation.controlAdmissions) : null, appliedSetpoints: primary ? sum(r => r.evaluation.appliedSetpoints) : null,
      fallbackSeconds: primary ? sum(r => r.evaluation.fallbackMs) / 1000 : null, controllerFailures: primary ? sum(r => r.evaluation.controllerFailures) : null, guardInterventions: primary ? sum(r => r.evaluation.guardInterventions) : null, staleResponses: primary ? sum(r => r.evaluation.staleResponses) : null,
      contactsSeconds: sum(r => r.evaluation.collisionTicks) * .02, boundsSeconds: sum(r => r.evaluation.boundsTicks) * .02,
      started: sum(r => r.stats.started), completed: sum(r => r.stats.completed), admitted: sum(r => r.stats.admitted), rejected: sum(r => r.stats.rejected), errors: sum(r => r.stats.errors), cancelled: sum(r => r.stats.cancelled),
      p50Ms: percentile(latency, .5), p95Ms: percentile(latency, .95), maxLagMs: runs.length ? Math.max(...runs.map(r => r.maxLagMs)) : null, repairsStarted: sum(r => r.stats.repairsStarted), repairsCompleted: sum(r => r.stats.repairsCompleted), repairsInstalled: sum(r => r.stats.repairsInstalled), cancelledRepairs: sum(r => r.stats.cancelledRepairs),
      reportedNativeCostUsd: runs.some(r => r.stats.cumulativeCostUsd !== null) ? sum(r => r.stats.cumulativeCostUsd ?? 0) : null,
      completedJevInputTokens: arm.startsWith('jev-') ? sum(r => r.stats.usage.reduce((s: number, u: any) => s + (u.input_tokens ?? 0), 0)) : null };
  });
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ manifest: result.manifest, comparison: result.comparison, summary, invalidTrials, failures: failures.map(({ trajectory, scenario, ...f }) => f) }, null, 2));
  result.results.push(...failureReplays);
  const serialized = JSON.stringify(result); if (Buffer.byteLength(serialized) > 75_000_000) throw new Error('Replay exceeds viewer size limit');
  await writeFile(resolve(directory, 'replay.json'), serialized); console.log(JSON.stringify({ trials: result.results.length, replayBytes: Buffer.byteLength(serialized), summary }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await report(resolve(process.argv[2] ?? '.runtime/experiments/reactive-held-out-v2'));
