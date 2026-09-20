import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceHash, trial } from '../reactive/run.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../reactive/config.ts';
import { PIXEL_ARMS, pixelController, type PixelControlDesign } from './controller.ts';
import { PIXEL_TASK, pixelProfile } from './profile.ts';
import { pixelReport } from './report.ts';
import { MODEL } from '../jev-strategies/strategies.ts';

export type PixelSuite = {
  id: string;
  definitions: Record<string, { label: string; description: string }>;
  questionDesign: string;
  design: string;
  makeDesign?: (arm: string) => PixelControlDesign;
};
export async function runPixelBatch(suite?: PixelSuite) {
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) { assert(['--phase', '--seeds', '--seconds', '--output', '--freeze'].includes(process.argv[i]!) && process.argv[i + 1], 'Unknown/incomplete option'); args.set(process.argv[i]!.slice(2), process.argv[i + 1]!); }
const phase = args.get('phase') ?? 'development', seconds = Number(args.get('seconds') ?? (phase === 'development' ? 20 : 40));
const seeds = (args.get('seeds') ?? (phase === 'development' ? '81' : '1201,1202,1203')).split(',').map(Number);
assert(['development', 'held-out'].includes(phase)); assert(seconds >= 15 && seconds <= 60 && Number.isFinite(seconds));
assert(seeds.length > 0 && seeds.length <= 6 && new Set(seeds).size === seeds.length && seeds.every(s => Number.isInteger(s) && s > 0 && s < 100000 && (phase === 'development' ? s < 100 : s >= 100)));
const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
assert(key, 'Real Jev credential required; no mock CLI');
const config = experimentConfig({ ...DEFAULT_CONFIG, minimumRefreshMs: 250, sourceAgeLimitMs: 1000, commandSeconds: 1, sensors: { ...DEFAULT_CONFIG.sensors, cooperativeBeacon: false } });
const arms = Object.keys(suite?.definitions ?? PIXEL_ARMS), hash = await sourceHash();
if (phase === 'held-out') { const freeze = JSON.parse(await readFile(resolve(args.get('freeze') ?? 'MISSING-FREEZE'), 'utf8')); assert.equal(freeze.sourceHash, hash); assert.deepEqual(freeze.config, config); assert.deepEqual(freeze.arms, arms); }
const directory = resolve(args.get('output') ?? `.runtime/experiments/${suite?.id ?? 'jev-pixels'}-${phase}-${Date.now()}`);
await mkdir(directory);
const manifest = { version: 'jev-pixels-v1', suite: suite?.id ?? 'jev-pixels', recordedAt: new Date().toISOString(), phase, model: MODEL, sourceHash: hash, arms, definitions: suite?.definitions ?? PIXEL_ARMS, seeds, seconds, config,
  goals: [PIXEL_TASK.goal(1), PIXEL_TASK.goal(2)], questionDesign: suite?.questionDesign ?? '6 independent questions; 5 with 49-option joint XY; conditional: 1 context plus 6 questions for search and each region. 43,218 control tuples per branch. Fixed full options, no ranking.',
  sensorDesign: '320x180 RGB, 5 Hz, 100 ms latency, 2% dropout; broad HSV connected components and tentative nearest-neighbour tracking. Bright chromatic regions only. No rangefinder, depth, marker, odometry, target radio, object semantics or world map. All perception inputs saved as PNG.',
  design: suite?.design ?? 'Five predeclared arms on each seed, rotated order. Numeric/words change expression of current bearings; history adds previous image measurements. Joint XY changes factorization only. Conditional adds object/context selection. No scripted mission competitor or hidden aiming.',
  scoring: 'Both phases need at least 50% framed time after 5 s warmup and one continuous second framed, with no collisions, bounds or controller failures. Framed means target centre in central 30%, projected box width in requested band, and wide FOV. Evaluator uses target geometry and centre-ray occlusion, never available to controller. Partial silhouette visibility is not fully scored.',
  limitations: ['Simple boxes, a unique blue target, cyan/orange/magenta distractors; controlled colour task, not general vehicle recognition.', 'Lighting gain and pixel noise are simulated; no textures, rolling shutter or motion blur. Dark/grey objects can be missed. Missing pixels are unknown.', 'No monocular-depth model is installed in this round; this isolates compact camera information first.', 'The local flight plant assumes stabilized velocity control, with ideal hold. Estimator, motors, wind and real onboard performance are unqualified.', 'Initial heading has a fixed 45-degree scenario-relative offset, shared by all arms; this is a tracking/acquisition pilot, not a random-heading search benchmark.', 'Three held-out seeds are exploratory evidence, not a statistically strong generalization claim. Network and inference timings may differ across arms.'],
  budget: { perFlightInputTokens: 1200000, batchInputTokens: 15000000, retries: 0 } };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const files = ['package.json', 'package-lock.json'];
for (const root of ['src', 'controllers', 'integrations', 'experiments', 'scenarios']) for (const file of await readdir(root, { recursive: true })) if (/\.(ts|json)$/.test(file)) files.push(`${root}/${file.replaceAll('\\', '/')}`);
for (const file of files) { const dest = resolve(directory, 'source', file); await mkdir(dirname(dest), { recursive: true }); await copyFile(file, dest); }
await writeFile(resolve(directory, 'source/SNAPSHOT.json'), JSON.stringify({ sourceHash: hash, files }, null, 2));
const runs: any[] = [], invalid: any[] = []; let stopped = false;
const save = () => writeFile(resolve(directory, 'report.json'), JSON.stringify({ manifest, runs, invalid, stopped }, null, 2));
await save();
outer: for (const [index, seed] of seeds.entries()) for (let offset = 0; offset < arms.length; offset++) {
  const arm = arms[(index + offset) % arms.length]!, id = `${arm}-${seed}`;
  console.log(JSON.stringify({ event: 'start', id, phase }));
  let emit = (_kind: string, _data: unknown): void => { throw new Error('Trace not connected'); };
  const { controller, stats } = pixelController(arm, key, (kind, data) => emit(kind, data), undefined, suite?.makeDesign?.(arm));
  try {
    const result = await trial({ arm, seed, seconds, directory, phase, config, task: PIXEL_TASK, sensorExperiment: pixelProfile(resolve(directory, 'frames', id)), controller,
      controllerSource: { files: [resolve('experiments/jev-pixels/controller.ts'), resolve('src/perception/color-tracks.ts')] }, connectControllerTrace: fn => { emit = fn; } });
    const row = await pixelReport(directory, result, stats, suite?.makeDesign?.(arm)); runs.push(row); console.log(JSON.stringify({ event: 'measured', ...row }));
    if (stats.errors) stopped = true;
  } catch (error) { invalid.push({ id, error: String(error) }); stopped = true; }
  if (runs.reduce((n, r) => n + r.metrics.tokens, 0) >= manifest.budget.batchInputTokens) stopped = true;
  await save(); if (stopped) break outer;
}
if (phase === 'development' && !stopped) await writeFile(resolve(directory, 'freeze.json'), JSON.stringify({ sourceHash: hash, arms, config }, null, 2));
if (stopped) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runPixelBatch();
