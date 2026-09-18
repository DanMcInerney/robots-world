import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sourceHash, trial } from '../reactive/run.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../reactive/config.ts';
import { MODEL } from '../jev-strategies/strategies.ts';
import { billingFailure, report } from '../jev-strategies/report.ts';
import { AXES, axesController, COMBINATIONS, type AxesArm } from './controller.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('--name value pairs required');
  args.set(process.argv[i]!.slice(2), process.argv[i + 1]!);
}
const phase = args.get('phase') ?? 'development';
const seeds = (args.get('seeds') ?? (phase === 'development' ? '85' : '951,952,953')).split(',').map(Number);
const seconds = Number(args.get('seconds') ?? (phase === 'development' ? '20' : '60'));
assert(['development', 'held-out'].includes(phase));
assert(seconds >= 15 && seconds <= 90 && Number.isFinite(seconds));
assert(seeds.length > 0 && seeds.length <= 8 && new Set(seeds).size === seeds.length);
assert(seeds.every(s => Number.isInteger(s) && s > 0 && s < 100000 && (phase === 'development' ? s < 100 : s >= 100)));
const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
if (!key) throw new Error('Real Jev credential required');
const directory = resolve(args.get('output') ?? `.runtime/experiments/jev-axes-${Date.now()}`);
const hash = await sourceHash(), strategies = Object.keys(AXES) as AxesArm[];
const config = experimentConfig({ ...DEFAULT_CONFIG, commandSeconds: 3, minimumRefreshMs: 200 });
if (phase === 'held-out') {
  if (!args.get('freeze')) throw new Error('Development freeze required');
  const frozen = JSON.parse(await readFile(resolve(args.get('freeze')!), 'utf8'));
  assert.equal(frozen.sourceHash, hash, 'Source differs from development freeze');
  assert.deepEqual(frozen.config, config);
}
await mkdir(directory); // No reuse, even for failed experiments.
const manifest = { phase, recordedAt: new Date().toISOString(), model: MODEL, sourceHash: hash, strategies, definitions: AXES, seeds, seconds,
  configs: Object.fromEntries(strategies.map(id => [id, config])), maxDecisions: 300,
  design: `A matched information ablation with six independent Choice questions in one call: XYZ velocities (7 each), camera heading delta (9), pitch delta (7), field of view (2). ${COMBINATIONS} offered joint tuples, with no prefiltering or ranking. Both arms receive identical full sensors and controls; only derived current geometry differs. Jev chooses every setpoint. The shared local plant stabilizes those setpoints. Physics and sensors continue at 50 Hz during inference, with a moving rover/obstacle, beacon blackout, and an English goal reversal halfway through.`,
  order: 'Rotate arm order by seed. Serial flights; the old frozen matrix finishes before this new live experiment starts.',
  scoring: config.scoring, limits: { maxReportedInputTokens: 50000000 },
  limitations: ['This is a new exploratory pilot, not a matched comparison against earlier 212-action controllers on different seeds.',
    '43,218 is the Cartesian tuple count, not an API limit or 43,218 unique achievable states. Pitch clipping creates duplicates at limits; envelope-invalid commands are rejected after model selection.',
    'The geometry treatment computes current relative coordinates and measured target bearing. Bearing strongly assists camera aiming; the ablation measures that assistance. No predicted candidate outcomes or code-written mission reward.',
    'Axes are independent. Their combination can be poorly coordinated; the model does not see other heads\' answers.',
    'Both arms use the same millimetre/0.001-unit rounded full sensor state. Original unrounded delivered observations remain recorded.',
    'Simplified stabilized velocity plant and idealized braking hold. Camera yaw uses gain 4 with a 120 degree/s limit; pitch slews at 90 degree/s; zoom changes immediately. These numerical camera rates were not included in the model input. Not raw motor/attitude control, PX4 SITL or physical drone qualification.',
    'Cooperative target broadcast and geometric detections, not RGB perception. No automatic follow, target-aim macro, obstacle avoidance or native planning agent.',
    'The filming score has no image-detail or energy term, so it does not establish useful zoom trade-offs or endurance planning.',
    'Every outcome is retained, including rejected combinations and provider/controller failures. No hidden correction or automatic retry.'],
  sources: ['https://docs.typesafe.ai/primitives/choice', 'https://docs.typesafe.ai/cookbooks/function_calling', 'https://docs.typesafe.ai/cookbooks/parallel_questions', 'https://docs.typesafe.ai/model-jaggedness/jev-1.13'] };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
const files = ['package.json', 'package-lock.json'];
for (const root of ['src', 'controllers', 'integrations', 'experiments', 'scenarios'])
  for (const file of await readdir(root, { recursive: true }))
    if (file.endsWith('.ts') || file.endsWith('.json')) files.push(`${root}/${file.replaceAll('\\', '/')}`);
for (const file of files) { const to = resolve(directory, 'source', file); await mkdir(dirname(to), { recursive: true }); await copyFile(file, to); }
await writeFile(resolve(directory, 'source/SNAPSHOT.json'), JSON.stringify({ sourceHash: hash, files }, null, 2));
const results: any[] = [], invalidTrials: any[] = [];
const save = () => writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results, invalidTrials }));
await save();
let stopped = false;
outer: for (const [index, seed] of seeds.entries()) for (let offset = 0; offset < strategies.length; offset++) {
  const arm = strategies[(index + offset) % strategies.length]!, id = `${arm}-${seed}`;
  console.log(JSON.stringify({ event: 'start', id }));
  let record: (kind: string, data: unknown) => void = () => { throw new Error('Trace not connected'); };
  const { controller, stats } = axesController(arm, key, (kind, data) => record(kind, data));
  try {
    const result = await trial({ arm, seed, seconds, directory, key, phase, config, controller, maxDecisions: 300,
      controllerSource: { files: [resolve('experiments/jev-axes/controller.ts')] },
      connectControllerTrace: emit => { record = emit; } });
    const saved = { ...result, hostStats: result.stats, stats, latencyP50Ms: percentile(stats.latencyMs, .5), latencyP95Ms: percentile(stats.latencyMs, .95) };
    results.push(saved);
    await writeFile(resolve(directory, `${id}.json`), JSON.stringify(saved));
  } catch (error) { invalidTrials.push({ id, arm, seed, error: String(error) }); }
  await save();
  const failure = await billingFailure(resolve(directory, `${id}.jsonl`));
  const evidence = await report(directory);
  const tokens = evidence.runs.reduce((s: number, r: any) => s + r.tokens, 0);
  console.log(JSON.stringify({ event: 'progress', id, summary: evidence.summary, invalidTrials }));
  if (failure || invalidTrials.length || tokens >= manifest.limits.maxReportedInputTokens) {
    stopped = true;
    await writeFile(resolve(directory, 'STOPPED.json'), JSON.stringify({ reason: failure ? 'billing-exhausted' : invalidTrials.length ? 'infrastructure' : 'token-budget', message: 'The pilot stopped; all outcomes remain recorded, with no automatic retry.', trial: id }));
    await report(directory); break outer;
  }
}
if (phase === 'development' && !stopped && results.every(r => r.stats.errors === 0))
  await writeFile(resolve(directory, 'freeze.json'), JSON.stringify({ sourceHash: hash, config, note: 'Both arms retained regardless of mission performance. No held-out tuning.' }, null, 2));
function percentile(values: number[], p: number) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null; }
