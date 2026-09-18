import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceHash, trial } from './run.ts';

// Continue untouched remaining trials after an early terminal menu failure.
// Never replay an attempted flight or edit the frozen plant, policy or score.
const directory = resolve(process.argv[2] ?? '.runtime/experiments/reactive-held-out-v2');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (manifest.phase !== 'held-out' || manifest.sourceHash !== await sourceHash()) throw new Error('Frozen source mismatch');
const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY; if (!key) throw new Error('Real Jev credential required');
const brief = JSON.parse(await readFile(resolve(manifest.briefFile), 'utf8')); if (brief.sourceHash !== manifest.sourceHash) throw new Error('Brief mismatch');
const batch = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8')); batch.failures ??= [];
async function preserveFailure(arm: string, seed: number) {
  const id = `${arm}-${seed}`, trace = (await readFile(resolve(directory, `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const failure = trace.find(r => r.kind === 'reactive.invalid'), header = trace.find(r => r.kind === 'reactive.manifest');
  if (trace.at(-1)?.kind !== 'trace.complete' || failure?.data.error !== 'Error: No legal candidates or menu too large' || header?.data.sourceHash !== manifest.sourceHash) throw new Error(`Unclassified interrupted trial ${id}; cannot silently resume`);
  const trajectory = trace.filter(r => r.kind === 'reactive.evaluation.frame').map(r => r.data), last = trajectory.at(-1);
  if (!last || !trajectory.some(f => f.drone.z < .7 || f.drone.z > 6 || Math.abs(f.drone.x) > 18 || Math.abs(f.drone.y) > 18)) throw new Error('Empty menu without observed envelope violation requires separate investigation');
  const decisions = trace.filter(r => r.kind === 'reactive.decision').map(r => r.data);
  const result = { id, arm, seed, sourceHash: manifest.sourceHash, plannedSeconds: manifest.seconds, observedMs: last.simMs,
    termination: 'Flight envelope violated; no candidate remained. Runner terminated early. No retry and no invented remaining trajectory or full-duration metrics.',
    error: failure.data.error, success: false, scenario: header.data.scenario, trajectory,
    admitted: decisions.filter(d => d.receipt.accepted).length, rejected: decisions.filter(d => !d.receipt.accepted).length,
    completedLatencyMs: decisions.map(d => d.answer.latencyMs),
    lastReportedNativeCostUsd: trace.findLast(r => r.kind === 'claude.result')?.data.cumulativeCostUsd ?? null,
    started: trace.filter(r => ['jev.request', 'claude.request'].includes(r.kind) || r.kind === 'codex.request' && r.data.prompt.state).length };
  batch.failures.push(result); console.log(JSON.stringify({ event: 'terminal-failure-preserved', id, observedMs: result.observedMs }));
}
for (const [index, seed] of manifest.seeds.entries()) for (let offset = 0; offset < manifest.arms.length; offset++) {
  const arm = manifest.arms[(index + offset) % manifest.arms.length], id = `${arm}-${seed}`;
  if ([...batch.results, ...batch.failures].some(r => r.id === id)) continue;
  if (existsSync(resolve(directory, `${id}.jsonl`))) await preserveFailure(arm, seed);
  else {
    console.log(JSON.stringify({ event: 'start', arm, seed }));
    try { batch.results.push(await trial({ arm, seed, seconds: manifest.seconds, directory, key, phase: manifest.phase, brief: ['jev-brief', 'jev-repair'].includes(arm) ? brief.instructions : undefined })); }
    catch { await preserveFailure(arm, seed); }
  }
  await writeFile(resolve(directory, 'results.json'), JSON.stringify(batch, null, 2));
}
