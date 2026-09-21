/** Unit E4b / B3: the multi-seed reference-ceiling sweep the E4/E4b assignment asks for — >=5 seeds
 * per cell (assignment's own "8 preferred", reduced and declared given this unit's wall-time
 * budget — see the CLI caller for the exact seed count used), finer speed steps
 * (`sweep.ts`'s `b3SpeedAxisSteps`), the ladder's own bearing-rate grid on the EXACT-rate `orbit`
 * path (`bearingRateOrbitCell`, fixing engine-review-e3 finding 2's "L2 needs a constant-rate path"
 * — `reference-ceiling.ts`'s original `speedBearingRateCell`-based joint grid is kept, unmodified,
 * for backward compatibility with its own existing CLI command/tests), all three consequence models
 * (`stationary`/`measured-rate`/`explicitly-unknown-prediction` — the ladder's own third,
 * degraded-fallback arm, not previously swept), and a per-axis STRONGEST-constant selection from an
 * exhaustive check (every yaw menu option, every speed-hold menu option) at one representative cell
 * per axis, reused as the grid's own `constant` baseline (matching the ladder document's own "run
 * exhaustive ONCE, here, reuse the single best-scoring constant everywhere else" economy).
 *
 * Reports MEAN, MIN and COUNT-CLEARING-FLOOR per cell (a joint metric across seeds), not a single
 * seed's number and not "max of each metric separately" (this unit's own explicit instruction) —
 * `cellStats` below.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEpisode, type EpisodeScenario } from './episode.ts';
import { createPassiveController } from './controllers/passive.ts';
import { createReferenceController } from './controllers/reference.ts';
import { createConstantController } from './controllers/constant.ts';
import { createFirstOptionController } from './controllers/first-option.ts';
import { createSeededRandomController } from './controllers/seeded-random.ts';
import { TRACK_YAW_MENU, buildSpeedHoldMenu } from './maneuver.ts';
import {
  speedBearingRateCell, bearingRateOrbitCell, makeSyntheticFakesV2, b3SpeedAxisSteps, b3BearingRateAxisSteps,
  ROUND3_RIG, type RigConfig, type ReferenceCeilingCellConfig,
} from './sweep.ts';
import type { EngineController } from './controllers/types.ts';
import type { ConsequenceModel } from './encoders/track.ts';
import type { EpisodeScore } from './scoring.ts';

const CONSEQUENCE_MODELS: ConsequenceModel[] = ['stationary', 'measured-rate', 'explicitly-unknown-prediction'];

export interface B3SweepOptions {
  outRoot: string;
  real: boolean;
  env?: { rendererPython: string; rendererScript: string; sensorPython: string; sensorCwd: string; checkpointPath: string; detectorRuntimeRoot: string };
  rig?: RigConfig;
  requestedRangeM?: number;
  durationMs?: number;
  seeds: number[];
  speedSteps?: number[];
  rateSteps?: number[];
  exhaustiveConstantsSeeds?: number[];
  exhaustiveSpeedCellMps?: number;
  exhaustiveRateCellDegS?: number;
  /** Unit E4b / B3: for a REAL-GPU confirmation pass (a handful of named cells, not the full
   * fake-mode grid), skip the exhaustive-constants selection (already done in fake mode; redoing it
   * on real hardware would cost dozens of extra real-GPU episodes for no new information) and use
   * this fixed constant instead. Also lets the confirmation pass skip the first-option/seeded-random
   * arms (a stated economy — passive+reference is what the assignment's own "confirm the largest
   * clearing cells" wording is about) via `policies`. */
  skipExhaustive?: boolean;
  fixedConstant?: { yaw: string; range: string };
  policies?: ('reference' | 'passive' | 'constant' | 'first-option' | 'seeded-random')[];
  /** Which consequence models the `reference` arm runs (default: all three). A real-GPU
   * confirmation pass typically restricts this to `['measured-rate']` (the realistic arm) — the
   * cheap fake-mode grid already covers all three, so re-running `stationary`/`explicitly-unknown-
   * prediction` on real hardware would only add cost without new information for a confirmation
   * pass whose job is to check the fake sweep's own prediction, not re-run the whole design space. */
  consequenceModels?: ConsequenceModel[];
}

interface RunRow {
  axis: 'speed' | 'rate'; value: number; seed: number; consequenceModel: ConsequenceModel | null; policy: string; role: 'reference' | 'baseline' | 'constant';
  truthCentredFraction: number; truthInRangeBandFraction: number; decisions: number; pass: boolean | null; validity: boolean; outDir: string;
}
interface ConstantRunRow { menuFamily: 'yaw' | 'speed-hold'; optionId: string; seed: number; truthCentredFraction: number; truthInRangeBandFraction: number }

async function runOneCell(scenario: EpisodeScenario, controller: EngineController, outDir: string, opts: B3SweepOptions): Promise<EpisodeScore> {
  await mkdir(outDir, { recursive: true });
  if (opts.real) {
    if (!opts.env) throw new Error('B3 sweep --real requires renderer/sensor env paths');
    const report = await runEpisode(scenario, {
      controller, outputRoot: outDir, seed: scenario.world.seed,
      renderer: { pythonExecutable: opts.env.rendererPython, rendererScriptPath: opts.env.rendererScript },
      sensor: { pythonExecutable: opts.env.sensorPython, sensorCwd: opts.env.sensorCwd, checkpointPath: opts.env.checkpointPath, detectorRuntimeRoot: opts.env.detectorRuntimeRoot },
    });
    return report.score;
  }
  const fakes = makeSyntheticFakesV2(opts.rig ?? ROUND3_RIG, scenario.world.seed);
  const report = await runEpisode(scenario, {
    controller, outputRoot: outDir, seed: scenario.world.seed,
    renderer: { pythonExecutable: 'unused', rendererScriptPath: 'unused' },
    sensor: { pythonExecutable: 'unused', sensorCwd: 'unused', checkpointPath: 'unused', detectorRuntimeRoot: 'unused' },
    deps: fakes,
    // No real API/rate-limit exists to respect in fake mode — skip the ARTIFICIAL real-wall pacing
    // wait (scheduler.ts's `wallPacingFloorMs`, decoupled from `pacingFloorMs` specifically for
    // this purpose) so a multi-hundred-run sweep finishes in a practical wall-clock time. The
    // SIMULATED dispatch cadence (`pacingFloorMs`, left at its default 505ms) is UNCHANGED — every
    // scored outcome (decision count/timing/consequences) is identical to running with the real
    // wait, only wall-clock speed differs. Never set for `opts.real` (real-GPU/real-Jev runs keep
    // the genuine coupled pacing).
    scheduler: { wallPacingFloorMs: 0 },
  });
  return report.score;
}

function baseCellCfg(opts: B3SweepOptions, seed: number): Omit<ReferenceCeilingCellConfig, 'targetSpeedMps' | 'bearingRateDegS' | 'rangeMenuKind' | 'consequenceModel'> {
  const rig = opts.rig ?? ROUND3_RIG;
  return {
    rig, requestedRangeM: opts.requestedRangeM ?? 8, durationMs: opts.durationMs ?? 20_000, seed,
    rangeToleranceM: 1, centralBandFraction: 0.3, envelope: { minAltitudeM: 0.5, maxAltitudeM: rig.droneAltitudeM + 4, maxRadiusFromOriginM: 60 },
  };
}

/** Runs every menu option in `menu` as its own `constant` policy, once per seed in `seeds`, on the
 * ONE representative cell `buildScenario(seed)` produces — the ladder's own "exhaustive check runs
 * ONCE, here" economy. Returns the winner (by mean of `metric` across seeds) plus the full table. */
async function exhaustiveConstants(
  menu: Record<string, { kind: string }>, questionId: 'yaw' | 'range', menuFamily: 'yaw' | 'speed-hold',
  buildScenario: (seed: number) => EpisodeScenario, metric: (score: EpisodeScore) => number,
  seeds: number[], outRoot: string, opts: B3SweepOptions,
): Promise<{ winnerId: string; table: ConstantRunRow[] }> {
  const rows: ConstantRunRow[] = [];
  for (const [id, def] of Object.entries(menu)) {
    if (def.kind === 'hold' || (def as any).speedMps === 0) continue;
    for (const seed of seeds) {
      const scenario = buildScenario(seed);
      const choices: Record<string, string> = questionId === 'yaw' ? { yaw: id, range: 'hold' } : { yaw: 'hold', range: id };
      const outDir = resolve(outRoot, `exhaustive-${menuFamily}-${id}-seed${seed}`);
      const score = await runOneCell(scenario, createConstantController(choices), outDir, opts);
      rows.push({ menuFamily, optionId: id, seed, truthCentredFraction: score.truth.centredFraction, truthInRangeBandFraction: score.truth.inRangeBandFraction });
    }
  }
  const byOption = new Map<string, number[]>();
  for (const r of rows) { const arr = byOption.get(r.optionId) ?? []; arr.push(menuFamily === 'yaw' ? r.truthCentredFraction : r.truthInRangeBandFraction); byOption.set(r.optionId, arr); }
  let winnerId = 'hold', bestMean = -Infinity;
  for (const [id, vals] of byOption) { const mean = vals.reduce((a, b) => a + b, 0) / vals.length; if (mean > bestMean) { bestMean = mean; winnerId = id; } }
  void metric;
  return { winnerId, table: rows };
}

function cellStats(rows: RunRow[], metricKey: 'truthCentredFraction' | 'truthInRangeBandFraction'): { meanClearing: number; minClearing: number; countClearing: number; n: number } {
  const vals = rows.map(r => r[metricKey]);
  const n = vals.length;
  const mean = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
  const min = n ? Math.min(...vals) : 0;
  const countClearing = vals.filter(v => v >= 0.8).length;
  return { meanClearing: Number(mean.toFixed(3)), minClearing: Number(min.toFixed(3)), countClearing, n };
}

export async function runB3Sweep(opts: B3SweepOptions) {
  await mkdir(opts.outRoot, { recursive: true });
  const speedSteps = opts.speedSteps ?? b3SpeedAxisSteps();
  const rateSteps = opts.rateSteps ?? b3BearingRateAxisSteps();
  const policies = new Set(opts.policies ?? ['reference', 'passive', 'constant', 'first-option', 'seeded-random']);
  const consequenceModels = opts.consequenceModels ?? CONSEQUENCE_MODELS;

  let yawExhaustive: { winnerId: string; table: ConstantRunRow[] };
  let speedExhaustive: { winnerId: string; table: ConstantRunRow[] };
  if (opts.skipExhaustive) {
    if (!opts.fixedConstant) throw new Error('skipExhaustive requires fixedConstant');
    yawExhaustive = { winnerId: opts.fixedConstant.yaw, table: [] };
    speedExhaustive = { winnerId: opts.fixedConstant.range, table: [] };
  } else {
    const exhaustiveSeeds = opts.exhaustiveConstantsSeeds ?? opts.seeds.slice(0, Math.min(3, opts.seeds.length));
    // Exhaustive cells chosen INSIDE (or just at the edge of) the fake-sweep's own measured
    // all-clear envelope (not far beyond it), so the "strongest constant" pick reflects a genuine
    // near-competent approximation, not noise among uniformly-failing options far past the ceiling.
    const exhaustiveSpeedCellMps = opts.exhaustiveSpeedCellMps ?? 1.5;
    const exhaustiveRateCellDegS = opts.exhaustiveRateCellDegS ?? 10;
    const speedHoldMenu = buildSpeedHoldMenu(Math.max(3, exhaustiveSpeedCellMps));
    // Strongest-constant selection (ladder's own "run exhaustive ONCE, here, reuse everywhere else").
    yawExhaustive = await exhaustiveConstants(
      TRACK_YAW_MENU, 'yaw', 'yaw',
      seed => bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: exhaustiveRateCellDegS, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }),
      s => s.truth.centredFraction, exhaustiveSeeds, opts.outRoot, opts,
    );
    speedExhaustive = await exhaustiveConstants(
      speedHoldMenu, 'range', 'speed-hold',
      seed => speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: exhaustiveSpeedCellMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }),
      s => s.truth.inRangeBandFraction, exhaustiveSeeds, opts.outRoot, opts,
    );
  }
  const constantController = () => createConstantController({ yaw: yawExhaustive.winnerId, range: speedExhaustive.winnerId });

  const rows: RunRow[] = [];
  let runIndex = 0;
  async function runEntry(axis: 'speed' | 'rate', value: number, seed: number, scenario: EpisodeScenario, policy: string, controller: EngineController, role: RunRow['role'], consequenceModel: ConsequenceModel | null) {
    runIndex++;
    const outDir = resolve(opts.outRoot, `run${String(runIndex).padStart(4, '0')}-${axis}${value}-seed${seed}-${policy}${consequenceModel ? `-${consequenceModel}` : ''}`);
    const score = await runOneCell(scenario, controller, outDir, opts);
    rows.push({
      axis, value, seed, consequenceModel, policy, role,
      truthCentredFraction: score.truth.centredFraction, truthInRangeBandFraction: score.truth.inRangeBandFraction,
      decisions: score.decisionCount, pass: score.pass?.decided ?? null, validity: score.validity.valid, outDir,
    });
  }

  // Speed axis (rate = 0): speed-hold menu throughout; the speed=0 cell ALSO runs fixed-distance
  // (B3's own "both menus" requirement) since a stationary target is exactly L3a's own config.
  for (const speedMps of speedSteps) {
    for (const seed of opts.seeds) {
      if (policies.has('reference')) {
        for (const consequenceModel of consequenceModels) {
          await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: speedMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel }), 'reference', createReferenceController(), 'reference', consequenceModel);
        }
        if (speedMps === 0) {
          await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: 0, bearingRateDegS: 0, rangeMenuKind: 'fixed-distance', consequenceModel: 'stationary' }), 'reference-fixed-distance', createReferenceController(), 'reference', 'stationary');
        }
      }
      if (policies.has('passive')) await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: speedMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'passive', createPassiveController(), 'baseline', null);
      if (policies.has('first-option')) await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: speedMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'first-option', createFirstOptionController(), 'baseline', null);
      if (policies.has('seeded-random')) await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: speedMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'seeded-random', createSeededRandomController(seed), 'baseline', null);
      if (policies.has('constant')) await runEntry('speed', speedMps, seed, speedBearingRateCell({ ...baseCellCfg(opts, seed), targetSpeedMps: speedMps, bearingRateDegS: 0, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'constant', constantController(), 'constant', null);
    }
  }
  // Bearing-rate axis (radial speed = 0): the EXACT-rate orbit path.
  for (const rateDegS of rateSteps) {
    for (const seed of opts.seeds) {
      if (policies.has('reference')) {
        for (const consequenceModel of consequenceModels) {
          await runEntry('rate', rateDegS, seed, bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: rateDegS, rangeMenuKind: 'speed-hold', consequenceModel }), 'reference', createReferenceController(), 'reference', consequenceModel);
        }
      }
      if (policies.has('passive')) await runEntry('rate', rateDegS, seed, bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: rateDegS, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'passive', createPassiveController(), 'baseline', null);
      if (policies.has('first-option')) await runEntry('rate', rateDegS, seed, bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: rateDegS, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'first-option', createFirstOptionController(), 'baseline', null);
      if (policies.has('seeded-random')) await runEntry('rate', rateDegS, seed, bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: rateDegS, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'seeded-random', createSeededRandomController(seed), 'baseline', null);
      if (policies.has('constant')) await runEntry('rate', rateDegS, seed, bearingRateOrbitCell({ ...baseCellCfg(opts, seed), bearingRateDegS: rateDegS, rangeMenuKind: 'speed-hold', consequenceModel: 'measured-rate' }), 'constant', constantController(), 'constant', null);
    }
  }

  // Per-cell joint stats: mean/min/count-clearing-floor across seeds, best-of-arms reference (the
  // best consequence model per seed, THEN aggregated across seeds — never the max across seeds,
  // which would hide unreliability).
  function bestOfArmsPerSeed(axis: 'speed' | 'rate', value: number, metricKey: 'truthCentredFraction' | 'truthInRangeBandFraction'): RunRow[] {
    const bySeed = new Map<number, RunRow[]>();
    for (const r of rows) if (r.axis === axis && r.value === value && r.role === 'reference' && r.policy === 'reference') { const arr = bySeed.get(r.seed) ?? []; arr.push(r); bySeed.set(r.seed, arr); }
    const best: RunRow[] = [];
    for (const [, arr] of bySeed) best.push(arr.reduce((a, b) => (b[metricKey] > a[metricKey] ? b : a)));
    return best;
  }
  const speedTable = speedSteps.map(value => {
    const bestRows = bestOfArmsPerSeed('speed', value, 'truthInRangeBandFraction');
    const stats = cellStats(bestRows, 'truthInRangeBandFraction');
    const baselineStats = (policy: string) => cellStats(rows.filter(r => r.axis === 'speed' && r.value === value && r.policy === policy), 'truthInRangeBandFraction');
    return { targetSpeedMps: value, bestReference: stats, passive: baselineStats('passive'), constant: baselineStats('constant'), firstOption: baselineStats('first-option'), seededRandom: baselineStats('seeded-random') };
  });
  const rateTable = rateSteps.map(value => {
    const bestRows = bestOfArmsPerSeed('rate', value, 'truthCentredFraction');
    const stats = cellStats(bestRows, 'truthCentredFraction');
    const baselineStats = (policy: string) => cellStats(rows.filter(r => r.axis === 'rate' && r.value === value && r.policy === policy), 'truthCentredFraction');
    return { bearingRateDegS: value, bestReference: stats, passive: baselineStats('passive'), constant: baselineStats('constant'), firstOption: baselineStats('first-option'), seededRandom: baselineStats('seeded-random') };
  });
  const speedEnvelope = speedTable.filter(c => c.bestReference.countClearing === c.bestReference.n && c.bestReference.n > 0).map(c => c.targetSpeedMps).sort((a, b) => a - b).at(-1) ?? null;
  const rateEnvelope = rateTable.filter(c => c.bestReference.countClearing === c.bestReference.n && c.bestReference.n > 0).map(c => c.bearingRateDegS).sort((a, b) => a - b).at(-1) ?? null;

  const summary = {
    generatedAtIso: new Date().toISOString(), real: opts.real, rig: opts.rig ?? ROUND3_RIG,
    requestedRangeM: opts.requestedRangeM ?? 8, durationMs: opts.durationMs ?? 20_000, seeds: opts.seeds,
    sensorModel: opts.real ? 'real renderer + real GPU sensor' : 'SYNTHETIC v2, fitted to engine-review-e3\'s own measured aspect/rig table',
    strongestConstant: { yaw: yawExhaustive.winnerId, rangeSpeedHold: speedExhaustive.winnerId },
    exhaustiveConstantsTables: { yaw: yawExhaustive.table, speedHold: speedExhaustive.table },
    speedTable, rateTable,
    envelope: {
      targetSpeedMpsAllSeedsClear80PctInRangeBand: speedEnvelope, bearingRateDegSAllSeedsClear80PctCentred: rateEnvelope,
    },
    rows,
  };
  await writeFile(resolve(opts.outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
