/** CLI: run one find-follow episode against the real renderer + real GPU sensor, or list scenarios.
 *
 * Examples (see the coordinator report for the full list, including the real-Jev invocation):
 *   node experiments/jev-find-follow/run.ts episode --scenario visible-track --controller passive
 *   node experiments/jev-find-follow/run.ts episode --scenario visible-track --controller reference
 *   node --env-file=<path to .env.jev.local> experiments/jev-find-follow/run.ts episode \
 *     --scenario visible-track --controller jev --real
 *
 * Default paths point at the main checkout's `.runtime` (this worktree's own `.runtime` is empty
 * by design; see the coordinator report for why) and at THIS worktree's own
 * `experiments/jev-library` for the sensor's cwd (so the on-demand mode added by this assignment
 * is what actually runs). Every path is resolved to an absolute path before use (the same fix
 * applied to integrations/measure-stereo-objects-latency.ts, item 11).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SMOKE_SCENARIOS } from './scenarios.ts';
import { runEpisode, type EpisodeScenario } from './episode.ts';
import { createPassiveController } from './controllers/passive.ts';
import { createSyntheticController } from './controllers/synthetic.ts';
import { createReferenceController } from './controllers/reference.ts';
import { createConstantController } from './controllers/constant.ts';
import { createFirstOptionController } from './controllers/first-option.ts';
import { createSeededRandomController } from './controllers/seeded-random.ts';
import { createJevController } from './controllers/jev.ts';
import { PESSIMISTIC_PERCEPTION_LATENCY_MS, type SchedulerConfig } from './scheduler.ts';
import type { EngineController } from './controllers/types.ts';
import { runReferenceCeiling } from './reference-ceiling.ts';
import { runB3Sweep } from './b3-sweep.ts';
import { buildProvisionalLadder, ROUND3_RIG, CANDIDATE_HIGHER_RIG, ROUND3_RIG_D0_M, CANDIDATE_HIGHER_RIG_D0_M } from './ladder-scenarios.ts';

const MAIN_CHECKOUT = 'C:/Users/danhm/tools/robots-world';

// Increment B3: the provisional L1-L4 scenarios, registered here (ids `l1-round3`, `l1-higher`,
// etc.) so `episode`/`batch` can address them by name exactly like the two frozen smoke scenarios —
// this is what makes "the exact real-Jev CLI for each provisional rung" (the assignment's own
// Return requirement) a genuinely runnable command, not a description of one. Uses the ladder's own
// provisional fallback envelope (10 deg/s, 2 m/s) unless a measured reference-ceiling summary is
// merged in later — see WORKLOG.md for the measured envelope this unit's own sweep produced.
const NO_MEASURED_ENVELOPE = { bearingRateDegSAt80PctCentred: null, targetSpeedMpsAt80PctInRangeBand: null };
const PROVISIONAL_LADDER_SCENARIOS: Record<string, EpisodeScenario> = {
  ...Object.fromEntries(Object.entries(buildProvisionalLadder(ROUND3_RIG, ROUND3_RIG_D0_M, NO_MEASURED_ENVELOPE)).map(([rung, s]) => [`${rung}-round3`, s])),
  ...Object.fromEntries(Object.entries(buildProvisionalLadder(CANDIDATE_HIGHER_RIG, CANDIDATE_HIGHER_RIG_D0_M, NO_MEASURED_ENVELOPE)).map(([rung, s]) => [`${rung}-higher`, s])),
};

function parseFlags(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) { const value = argv[i + 1]; map.set(token.slice(2), value && !value.startsWith('--') ? value : 'true'); if (value && !value.startsWith('--')) i++; }
  }
  return map;
}

function buildController(name: string, outputRoot: string, flags: Map<string, string>): EngineController {
  if (name === 'passive') return createPassiveController();
  if (name === 'synthetic') return createSyntheticController();
  if (name === 'reference') return createReferenceController();
  // engine-review-e2 finding 5: the range axis previously defaulted to 'hold', identical to what
  // `passive` always chooses there too — not a genuinely distinct constant policy on that axis.
  // 'speed_0_5' is a real, non-hold speed-hold choice (falls back to the first offered option via
  // createConstantController's own fallback if a scenario's range menu is fixed-distance instead).
  if (name === 'constant') return createConstantController({ yaw: 'yaw_left_10', range: 'speed_0_5', action: 'yaw_left_30' });
  if (name === 'first-option') return createFirstOptionController();
  if (name === 'seeded-random') return createSeededRandomController(Number(flags.get('controller-seed') ?? 1));
  if (name === 'jev') {
    const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '';
    if (!key) throw new Error('jev controller requires TYPESAFE_API_KEY/JEV_API_KEY (load with --env-file=<path>); never hard-code or print it');
    return createJevController({ root: resolve(outputRoot, 'jev-ledger'), key });
  }
  throw new Error(`Unknown controller: ${name}`);
}

/** Increment B1: the strict-detector arm (0.25 score threshold / ['car'] only), kept available
 * but not the default (the PROVISIONAL default is vehicle-family + 0.15 — see scenarios.ts). */
function applyStrictDetector(scenario: EpisodeScenario): EpisodeScenario {
  return { ...scenario, goal: { ...scenario.goal, classes: ['car'] }, perception: { scoreThreshold: 0.25 } };
}

function resolveScenario(scenarioId: string, flags: Map<string, string>): EpisodeScenario {
  const scenario = SMOKE_SCENARIOS[scenarioId] ?? PROVISIONAL_LADDER_SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}. Known: ${[...Object.keys(SMOKE_SCENARIOS), ...Object.keys(PROVISIONAL_LADDER_SCENARIOS)].join(', ')}`);
  return flags.has('strict-detector') ? applyStrictDetector(scenario) : scenario;
}

interface EnvPaths { rendererPython: string; rendererScript: string; sensorPython: string; sensorCwd: string; checkpointPath: string; detectorRuntimeRoot: string }

async function resolveEnvPaths(flags: Map<string, string>): Promise<EnvPaths> {
  // FAILURES.md #1: the assignment's own path hint (perception/.venv) is a DIFFERENT venv (used
  // for the Round 3 stereo/detector comparison, no trimesh/pyrender/DracoPy); renderer.py's actual
  // dependencies live in camera/env, confirmed by a standalone renderer-client.ts smoke test.
  const rendererPython = flags.get('renderer-python') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe');
  const rendererScript = flags.get('renderer-script') ?? resolve(MAIN_CHECKOUT, 'experiments/jev-round3/camera/renderer.py');
  const sensorPython = flags.get('sensor-python') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe');
  const sensorCwd = flags.get('sensor-cwd') ?? resolve('experiments/jev-library');
  const checkpointPath = flags.get('checkpoint') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-library-v1/detector/models/yolo11s-seg.pt');
  const detectorRuntimeRoot = flags.get('detector-runtime-root') ?? resolve('.runtime/experiments/jev-find-follow-v1/detector-runtime');
  await mkdir(detectorRuntimeRoot, { recursive: true });
  return { rendererPython, rendererScript, sensorPython, sensorCwd, checkpointPath, detectorRuntimeRoot };
}

/** Increment B2: `batch --seeds`/per-entry overrides. `overrides.seed` replaces BOTH the scenario's
 * own `world.seed` (so the physics/render scene itself reseeds, not merely the episode's `seed`
 * bookkeeping field) and the `runEpisode` `seed` option, so "same scenario, different seed" is a
 * genuine reseed, not a no-op. `overrides.scheduler` merges on top of the camera-period-ms/
 * pessimistic-perception flags below (a per-entry override wins over the batch-wide flag). */
async function runOne(
  scenarioId: string, controllerId: string, flags: Map<string, string>, outDir: string, env: EnvPaths, cameraPeriodMs: number,
  overrides: { seed?: number; scheduler?: Partial<SchedulerConfig> } = {},
) {
  await mkdir(outDir, { recursive: true });
  let scenario = resolveScenario(scenarioId, flags);
  if (overrides.seed !== undefined) scenario = { ...scenario, world: { ...scenario.world, seed: overrides.seed } };
  if (controllerId === 'jev' && !flags.has('real')) throw new Error('The jev controller makes real, billed API calls. Pass --real to confirm.');
  const controller = buildController(controllerId, outDir, flags);
  // Increment B1: the pessimistic perception-latency arm (scheduler.ts's
  // PESSIMISTIC_PERCEPTION_LATENCY_MS, the quiet-machine's own measured p95 across rates), exposed
  // as a CLI flag rather than only existing as an unused constant — the ladder's clock/latency
  // qualification section requires "a pessimistic perception-latency arm ... used for at least one
  // confirmation pass per track/search rung" (honouring the "as if on a real drone" framing, since
  // the 140ms default is declared as an RTX 5090 laptop GPU figure, not an onboard-computer one).
  const perceptionLatencyMs = flags.has('pessimistic-perception') ? PESSIMISTIC_PERCEPTION_LATENCY_MS : undefined;
  const scheduler: Partial<SchedulerConfig> = { cameraPeriodMs, ...(perceptionLatencyMs !== undefined ? { perceptionLatencyMs } : {}), ...overrides.scheduler };
  console.error(JSON.stringify({ starting: scenarioId, controller: controllerId, outDir, seed: scenario.world.seed, scheduler }));
  try {
    const report = await runEpisode(scenario, {
      controller, outputRoot: outDir, seed: scenario.world.seed, scheduler,
      renderer: { pythonExecutable: env.rendererPython, rendererScriptPath: env.rendererScript },
      sensor: { pythonExecutable: env.sensorPython, sensorCwd: env.sensorCwd, checkpointPath: env.checkpointPath, detectorRuntimeRoot: env.detectorRuntimeRoot },
    });
    return { scenario: scenarioId, controller: controllerId, outDir, seed: scenario.world.seed, score: report.score, wallTimeBudget: report.wallTimeBudget };
  } finally {
    controller.close?.();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === 'list') { console.log(JSON.stringify({ smoke: Object.keys(SMOKE_SCENARIOS), provisionalLadder: Object.keys(PROVISIONAL_LADDER_SCENARIOS) })); return; }

  // Decision cadence is always gated by the pacing floor (>=505ms by default) regardless of the
  // camera period; the camera period itself now genuinely decouples from it (engine-review-e1
  // finding 3). The DEFAULT here matches the scheduler's own declared 5 Hz default so a plain
  // `episode`/`batch` run exercises the real camera cadence, not merely the decision cadence — a
  // materially higher real-wall cost per episode than the old 1-acquisition-per-decision approach
  // (roughly 2-3x more render+sense round trips at the default 505ms pacing floor / 200ms camera
  // period), declared and reported per run in `wallTimeBudget`. Override with --camera-period-ms
  // for a cheaper smoke pass.
  const cameraPeriodMs = Number(flags.get('camera-period-ms') ?? 200);
  const env = await resolveEnvPaths(flags);

  if (command === 'episode') {
    const scenarioId = flags.get('scenario') ?? 'visible-track';
    const controllerId = flags.get('controller') ?? 'passive';
    const outDir = resolve(flags.get('out-dir') ?? `.runtime/experiments/jev-find-follow-v1/${scenarioId}-${controllerId}`);
    const result = await runOne(scenarioId, controllerId, flags, outDir, env, cameraPeriodMs);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'batch') {
    // Increment B6: a list of (scenario, controller) pairs run SEQUENTIALLY (GPU jobs must never
    // overlap — see WORKLOG.md), writing one summary table. --scenarios/--controllers are
    // comma-separated; every scenario x controller combination is run (the cross product), matching
    // this unit's required acceptance runs (2 scenarios x 4 controllers).
    // Increment B2: --seeds (comma-separated) additionally crosses every seed (each a genuine
    // reseed of the scenario's own `world.seed`, not just the episode-record's `seed` field) — the
    // full cross product is scenarios x controllers x seeds. --manifest <path.json> is a SEPARATE,
    // more general mode: a JSON array of `{scenario, controller, seed?, cameraPeriodMs?,
    // schedulerOverrides?}` entries, each run with its own explicit per-entry overrides (declared
    // "per-entry overrides" requirement) instead of the combinatorial cross product.
    const outRoot = resolve(flags.get('out-root') ?? '.runtime/experiments/jev-find-follow-v1/batch');
    type Entry = { scenarioId: string; controllerId: string; seed?: number; cameraPeriodMs: number; schedulerOverrides?: Partial<SchedulerConfig> };
    let entries: Entry[];
    if (flags.has('manifest')) {
      const manifest = JSON.parse(await readFile(resolve(flags.get('manifest')!), 'utf8')) as Array<{ scenario: string; controller: string; seed?: number; cameraPeriodMs?: number; schedulerOverrides?: Partial<SchedulerConfig> }>;
      entries = manifest.map(m => ({ scenarioId: m.scenario, controllerId: m.controller, seed: m.seed, cameraPeriodMs: m.cameraPeriodMs ?? cameraPeriodMs, schedulerOverrides: m.schedulerOverrides }));
    } else {
      const scenarioIds = (flags.get('scenarios') ?? Object.keys(SMOKE_SCENARIOS).join(',')).split(',').map(s => s.trim()).filter(Boolean);
      const controllerIds = (flags.get('controllers') ?? 'reference,passive').split(',').map(s => s.trim()).filter(Boolean);
      const seeds = flags.has('seeds') ? flags.get('seeds')!.split(',').map(s => Number(s.trim())) : [undefined];
      entries = [];
      for (const scenarioId of scenarioIds) for (const controllerId of controllerIds) for (const seed of seeds) entries.push({ scenarioId, controllerId, seed, cameraPeriodMs });
    }
    const results: Array<Awaited<ReturnType<typeof runOne>> | { scenario: string; controller: string; seed?: number; error: string }> = [];
    for (const entry of entries) {
      const seedTag = entry.seed !== undefined ? `-seed${entry.seed}` : '';
      const outDir = resolve(outRoot, `${entry.scenarioId}-${entry.controllerId}${seedTag}`);
      try {
        results.push(await runOne(entry.scenarioId, entry.controllerId, flags, outDir, env, entry.cameraPeriodMs, { seed: entry.seed, scheduler: entry.schedulerOverrides }));
      } catch (error) {
        console.error(JSON.stringify({ scenario: entry.scenarioId, controller: entry.controllerId, seed: entry.seed, failed: String(error) }));
        results.push({ scenario: entry.scenarioId, controller: entry.controllerId, seed: entry.seed, error: String(error) });
      }
    }
    const table = results.map(r => 'error' in r
      ? { scenario: r.scenario, controller: r.controller, seed: r.seed, error: r.error }
      : {
          scenario: r.scenario, controller: r.controller, seed: r.seed, pass: r.score.pass?.decided ?? null,
          truthCentred: Number(r.score.truth.centredFraction.toFixed(3)), truthInRangeBand: Number(r.score.truth.inRangeBandFraction.toFixed(3)),
          validity: r.score.validity.valid, decisions: r.score.decisionCount, skipped: r.score.skippedAcquisitions,
          wallMsPerSimSecond: Number(r.wallTimeBudget.wallMsPerSimulatedSecond.toFixed(1)),
        });
    console.log(JSON.stringify(table, null, 2));
    await mkdir(outRoot, { recursive: true });
    await writeFile(resolve(outRoot, 'summary.json'), JSON.stringify({ generatedAtIso: new Date().toISOString(), results, table }, null, 2));
    return;
  }

  if (command === 'reference-ceiling') {
    // Increment B2/B3: the ladder's own L0 reference-ceiling sweep. Fast fake-sensor mode by
    // default (a declared, labelled-synthetic sensor model fitted to measured figures — see
    // sweep.ts); --real switches to the real renderer + real GPU sensor for the cells named by
    // --cells (comma-separated "speed:rate", e.g. "2:10,3:20" — confirmation is deliberately never
    // "every cell", per this unit's own wall-time budget).
    const real = flags.has('real');
    const outRoot = resolve(flags.get('out-root') ?? `.runtime/experiments/jev-find-follow-v1/e3b-reference-ceiling${real ? '-real' : ''}`);
    const cellsFlag = flags.get('cells');
    const summary = await runReferenceCeiling({
      outRoot, real, env: real ? { rendererPython: env.rendererPython, rendererScript: env.rendererScript, sensorPython: env.sensorPython, sensorCwd: env.sensorCwd, checkpointPath: env.checkpointPath, detectorRuntimeRoot: env.detectorRuntimeRoot } : undefined,
      cells: cellsFlag ? cellsFlag.split(',').map(c => { const [s, r] = c.split(':').map(Number); return { targetSpeedMps: s!, bearingRateDegS: r! }; }) : undefined,
      exhaustiveConstantsAt: flags.has('skip-exhaustive-constants') ? undefined : { targetSpeedMps: Number(flags.get('exhaustive-speed') ?? 2), bearingRateDegS: Number(flags.get('exhaustive-rate') ?? 10) },
      durationMs: flags.has('duration-ms') ? Number(flags.get('duration-ms')) : undefined,
      requestedRangeM: flags.has('requested-range-m') ? Number(flags.get('requested-range-m')) : undefined,
    });
    console.log(JSON.stringify(summary.table, null, 2));
    return;
  }

  if (command === 'b3-sweep') {
    // Unit E4b / B3: the multi-seed reference-ceiling sweep (see b3-sweep.ts's own module
    // docstring). Fake mode (default) is fast/CPU-only; --real confirms a NAMED subset via
    // --real-speeds/--real-rates (never "every cell" — this unit's own declared wall-time economy).
    const real = flags.has('real');
    const outRoot = resolve(flags.get('out-root') ?? `.runtime/experiments/jev-find-follow-v1/e4b-b3-sweep${real ? '-real' : ''}`);
    const seeds = (flags.get('seeds') ?? '9401,9402,9403,9404,9405').split(',').map(Number);
    const summary = await runB3Sweep({
      outRoot, real, env: real ? { rendererPython: env.rendererPython, rendererScript: env.rendererScript, sensorPython: env.sensorPython, sensorCwd: env.sensorCwd, checkpointPath: env.checkpointPath, detectorRuntimeRoot: env.detectorRuntimeRoot } : undefined,
      rig: flags.get('rig') === 'higher' ? CANDIDATE_HIGHER_RIG : ROUND3_RIG,
      requestedRangeM: flags.has('requested-range-m') ? Number(flags.get('requested-range-m')) : undefined,
      durationMs: flags.has('duration-ms') ? Number(flags.get('duration-ms')) : undefined,
      seeds,
      speedSteps: flags.has('real-speeds') ? flags.get('real-speeds')!.split(',').map(Number) : undefined,
      rateSteps: flags.has('real-rates') ? flags.get('real-rates')!.split(',').map(Number) : undefined,
      skipExhaustive: flags.has('skip-exhaustive'),
      fixedConstant: flags.has('fixed-constant-yaw') ? { yaw: flags.get('fixed-constant-yaw')!, range: flags.get('fixed-constant-range') ?? 'speed_0_5' } : undefined,
      policies: flags.has('policies') ? flags.get('policies')!.split(',') as any : undefined,
      consequenceModels: flags.has('consequence-models') ? flags.get('consequence-models')!.split(',') as any : undefined,
    });
    console.log(JSON.stringify({ envelope: summary.envelope, strongestConstant: summary.strongestConstant, speedTable: summary.speedTable, rateTable: summary.rateTable }, null, 2));
    return;
  }

  console.log([
    'Usage:',
    '  node experiments/jev-find-follow/run.ts episode --scenario <id> --controller <passive|synthetic|reference|constant|first-option|seeded-random|jev> [--out-dir PATH] [--strict-detector]',
    '  node experiments/jev-find-follow/run.ts batch --scenarios visible-track,turn-to-find --controllers reference,passive,constant,seeded-random [--seeds 1,2,3] [--out-root PATH] [--strict-detector]',
    '  node experiments/jev-find-follow/run.ts batch --manifest PATH.json [--out-root PATH]',
    '  node experiments/jev-find-follow/run.ts reference-ceiling [--real --cells 2:10,3:20] [--out-root PATH]',
    '  node experiments/jev-find-follow/run.ts b3-sweep [--seeds 9401,9402,9403,9404,9405] [--rig round3|higher] [--real --real-speeds 1,2 --real-rates 10,20] [--out-root PATH]',
    '  node experiments/jev-find-follow/run.ts list',
  ].join('\n'));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
