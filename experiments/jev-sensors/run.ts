import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sourceHash, trial } from '../reactive/run.ts';
import { DEFAULT_CONFIG, experimentConfig } from '../reactive/config.ts';
import { MODEL } from '../jev-strategies/strategies.ts';
import { billingFailure, percentile, report } from '../jev-strategies/report.ts';
import { SENSOR_ARMS, sensorProfile, type SensorArm } from './profile.ts';
import { sensorController } from './controller.ts';
import { MARKER, markerSvg } from '../../src/perception/fiducial.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--phase', '--seeds', '--seconds', '--output', '--freeze'].includes(process.argv[i]!) || !process.argv[i + 1]) throw new Error('Unknown or incomplete --name value option');
  args.set(process.argv[i]!.slice(2), process.argv[i + 1]!);
}
const phase = args.get('phase') ?? 'development', seconds = Number(args.get('seconds') ?? (phase === 'development' ? 20 : 60));
const seeds = (args.get('seeds') ?? (phase === 'development' ? '91' : '1101,1102,1103')).split(',').map(Number);
assert(['development', 'held-out'].includes(phase)); assert(Number.isFinite(seconds) && seconds >= 15 && seconds <= 90);
assert(seeds.length > 0 && seeds.length <= 8 && new Set(seeds).size === seeds.length && seeds.every(s => Number.isInteger(s) && s > 0 && s < 100000 && (phase === 'development' ? s < 100 : s >= 100)));
const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
if (!key) throw new Error('Real Jev credential required; no mock CLI');
const config = experimentConfig({ ...DEFAULT_CONFIG, minimumRefreshMs: 200, sensors: { ...DEFAULT_CONFIG.sensors, cooperativeBeacon: false } });
// Keep the optional rangefinder profile for archived-run audits; new runs are camera-only.
const strategies: SensorArm[] = ['sensor-camera'];
const hash = await sourceHash(), directory = resolve(args.get('output') ?? `.runtime/experiments/jev-sensors-${Date.now()}`);
if (phase === 'held-out') {
  if (!args.get('freeze')) throw new Error('Development freeze required');
  const frozen = JSON.parse(await readFile(resolve(args.get('freeze')!), 'utf8')); assert.equal(frozen.sourceHash, hash); assert.deepEqual(frozen.config, config);
}
await mkdir(directory);
const manifest = { phase, recordedAt: new Date().toISOString(), model: MODEL, sourceHash: hash, strategies, definitions: Object.fromEntries(strategies.map(s => [s, SENSOR_ARMS[s]])), seeds, seconds,
  configs: Object.fromEntries(strategies.map(s => [s, config])), marker: MARKER, scoring: config.scoring,
  design: 'Camera-only legacy baseline: rectified camera pixels processed with js-aruco2 detection and POSIT. TF-Luna is not installed or supplied. Same six fixed control menus and English goals as the original sensor experiment; the proposed object/track representation is not implemented by this runner. No target broadcast, global odometry, point cloud, simulated camera depth, contact oracle, future route or evaluator feedback. No scene-based command guard. World continues at 50 Hz; camera acquires at 5 Hz.',
  order: 'Run the camera-only arm for each seed. Keep every outcome. Development qualifies interfaces, not selection of a winning policy.',
  limitations: ['The target carries a known printed 0.4 m ARUCO_MIP_36h12 marker on its roof. This is an explicit instrumented-target experiment, not general object recognition. The pattern and mounting knowledge would also be required on hardware.',
    'Images are rendered from boxes and a printed plane with z-buffer occlusion, finite resolution and pixel noise. No photorealistic lighting, lens distortion, rolling shutter or motion blur. The detector itself receives only RGBA pixels and calibrated intrinsics.',
    'Both possible planar pose solutions are exposed. Lost detections produce no target pose; this version does not predict through occlusion.',
    'The drone supplies a simulated noisy onboard heading estimate and gimbal encoder. No global position or velocity is exposed. The local stabilized velocity/hold plant assumes an onboard flight-stack estimator; that estimator, motor dynamics, wind and GPS/VIO failures are NOT implemented or qualified.',
    'Only schema, ownership, source age, actuator speed and command expiry are enforced. The former global-position envelope guard is disabled. Collisions and boundary violations fail the flight and are never silently corrected.',
    'Legacy trace field source.odometryMs means camera acquisition time in these runs. Receipt and application clocks remain separate.',
    'Marker detection is reusable sensor processing, not a mission policy. Jev chooses all six controls. No automatic follow, aiming, obstacle avoidance, candidate ranking or output substitution.',
    'Legacy goals retain metric/global constraints that the camera-only observations cannot always establish. This baseline is retained for diagnosis; see docs/jev-camera-representation.md for the proposed observable tasks and perception redesign.',
    'This tests software interfaces and sensor access in a simplified simulation. It does not demonstrate drop-in hardware readiness or compare fairly against the older, more informative sensor suite.'],
  sources: ['https://github.com/damianofalcioni/js-aruco2', 'https://docs.typesafe.ai/concepts/state', 'https://docs.typesafe.ai/cookbooks/function_calling'] };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(resolve(directory, 'marker.svg'), markerSvg());
const files = ['package.json', 'package-lock.json'];
for (const root of ['src', 'controllers', 'integrations', 'experiments', 'scenarios']) for (const file of await readdir(root, { recursive: true })) if (file.endsWith('.ts') || file.endsWith('.json')) files.push(`${root}/${file.replaceAll('\\', '/')}`);
for (const file of files) { const dest = resolve(directory, 'source', file); await mkdir(dirname(dest), { recursive: true }); await copyFile(file, dest); }
await writeFile(resolve(directory, 'source/SNAPSHOT.json'), JSON.stringify({ sourceHash: hash, files }, null, 2));
const results: any[] = [], invalidTrials: any[] = []; let stopped = false;
const save = () => writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results, invalidTrials }));
await save();
outer: for (const [index, seed] of seeds.entries()) for (let offset = 0; offset < strategies.length; offset++) {
  const arm = strategies[(index + offset) % strategies.length]!, id = `${arm}-${seed}`;
  console.log(JSON.stringify({ event: 'start', id }));
  let record = (_kind: string, _data: unknown): void => { throw new Error('Trace not connected'); };
  const { controller, stats } = sensorController(arm, key, (kind, data) => record(kind, data));
  try {
    const result = await trial({ arm, seed, seconds, directory, phase, config, controller, sensorExperiment: sensorProfile(arm, resolve(directory, 'frames', id)),
      controllerSource: { files: [resolve('experiments/jev-sensors/controller.ts'), resolve('src/perception/fiducial.ts')] }, connectControllerTrace: emit => { record = emit; } });
    const saved = { ...result, hostStats: result.stats, stats, latencyP50Ms: percentile(stats.latencyMs, .5), latencyP95Ms: percentile(stats.latencyMs, .95) };
    results.push(saved); await writeFile(resolve(directory, `${id}.json`), JSON.stringify(saved));
  } catch (error) { invalidTrials.push({ id, arm, seed, error: String(error) }); }
  await save();
  const evidence = await report(directory), billing = await billingFailure(resolve(directory, `${id}.jsonl`));
  console.log(JSON.stringify({ event: 'progress', id, summary: evidence.summary, invalidTrials }));
  if (billing || invalidTrials.length || results.some(r => r.stats.errors) || evidence.summary.reduce((n: number, r: any) => n + r.tokens, 0) > 15000000) {
    stopped = true; await writeFile(resolve(directory, 'STOPPED.json'), JSON.stringify({ reason: billing ? 'billing-exhausted' : 'execution-or-budget', message: 'All evidence retained; no automatic retry.' })); await report(directory); break outer;
  }
}
if (phase === 'development' && !stopped) await writeFile(resolve(directory, 'freeze.json'), JSON.stringify({ sourceHash: hash, config }));
