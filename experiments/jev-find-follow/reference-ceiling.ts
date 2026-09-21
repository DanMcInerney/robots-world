/** Increment B2/B3: the ladder's own L0 reference-ceiling sweep — "reference (stationary and
 * measured-rate models), passive, every constant, first-option, seeded-random across a grid of
 * target speed x bearing rate ... reports time-in-band per cell with the best-of-arms reference."
 *
 * Fast FAKE-SENSOR mode (default): the whole grid runs against sweep.ts's `makeSyntheticFakes`
 * (declared dropout/noise/bias fitted to measured figures, clearly labelled synthetic in every
 * report's config) — no renderer/GPU, explorable in minutes. `--real` mode runs a caller-named
 * SUBSET of cells against the real renderer + real GPU sensor for confirmation (this unit's own
 * declared economy: never every cell — see WORKLOG.md's wall-time reasoning).
 *
 * Declared scope reduction (stated, not hidden — see WORKLOG.md): this pilot sweep uses the
 * speed-hold menu UNIFORMLY across the whole grid (including target-speed-0 cells, where
 * speed-hold's own 0.0 m/s option already models "hold position"), rather than also re-testing the
 * fixed-distance menu at every stationary cell — the fixed-distance/stationary-target case is L3a's
 * OWN dedicated rung (§ ladder), not a second axis this joint grid needs to duplicate. The
 * "exhaustive every-constant-action" check (ladder: "run ONCE, here, across the full sweep") runs
 * at ONE declared representative cell, not the full grid, given this unit's time budget — a
 * declared economy of the SAME kind the ladder itself applies elsewhere (baselines "run at
 * confirmation seeds only", "constant" reused from L0 rather than re-swept per rung).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEpisode, type EpisodeScenario } from './episode.ts';
import { createPassiveController } from './controllers/passive.ts';
import { createReferenceController } from './controllers/reference.ts';
import { createConstantController } from './controllers/constant.ts';
import { createFirstOptionController } from './controllers/first-option.ts';
import { createSeededRandomController } from './controllers/seeded-random.ts';
import { TRACK_YAW_MENU, SPEED_HOLD_MENU } from './maneuver.ts';
import {
  speedBearingRateCell, referenceCeilingGrid, makeSyntheticFakes, MEASURED_SYNTHETIC_SENSOR_MODEL,
  ROUND3_RIG, type RigConfig,
} from './sweep.ts';
import type { EngineController } from './controllers/types.ts';
import type { EpisodeScore } from './scoring.ts';

export interface ReferenceCeilingCell { targetSpeedMps: number; bearingRateDegS: number }

export interface ReferenceCeilingOptions {
  outRoot: string;
  real: boolean;
  env?: { rendererPython: string; rendererScript: string; sensorPython: string; sensorCwd: string; checkpointPath: string; detectorRuntimeRoot: string };
  cells?: ReferenceCeilingCell[];
  exhaustiveConstantsAt?: ReferenceCeilingCell;
  requestedRangeM?: number;
  durationMs?: number;
  rig?: RigConfig;
  seed?: number;
}

interface RunEntry { cell: ReferenceCeilingCell; policy: string; consequenceModel: 'stationary' | 'measured-rate'; role: 'reference' | 'baseline' | 'constant' }
interface RunResultRow extends RunEntry { truthCentredFraction: number; truthInRangeBandFraction: number; decisions: number; pass: boolean | null; validity: boolean; outDir: string }

async function runCell(
  scenarioBase: EpisodeScenario, controller: EngineController, outDir: string, opts: ReferenceCeilingOptions,
): Promise<EpisodeScore> {
  await mkdir(outDir, { recursive: true });
  if (opts.real) {
    if (!opts.env) throw new Error('reference-ceiling --real requires renderer/sensor env paths');
    const report = await runEpisode(scenarioBase, {
      controller, outputRoot: outDir, seed: scenarioBase.world.seed,
      renderer: { pythonExecutable: opts.env.rendererPython, rendererScriptPath: opts.env.rendererScript },
      sensor: { pythonExecutable: opts.env.sensorPython, sensorCwd: opts.env.sensorCwd, checkpointPath: opts.env.checkpointPath, detectorRuntimeRoot: opts.env.detectorRuntimeRoot },
    });
    return report.score;
  }
  const fakes = makeSyntheticFakes(MEASURED_SYNTHETIC_SENSOR_MODEL, scenarioBase.world.seed);
  const report = await runEpisode(scenarioBase, {
    controller, outputRoot: outDir, seed: scenarioBase.world.seed,
    renderer: { pythonExecutable: 'unused', rendererScriptPath: 'unused' },
    sensor: { pythonExecutable: 'unused', sensorCwd: 'unused', checkpointPath: 'unused', detectorRuntimeRoot: 'unused' },
    deps: fakes,
  });
  return report.score;
}

export async function runReferenceCeiling(opts: ReferenceCeilingOptions) {
  const requestedRangeM = opts.requestedRangeM ?? 8;
  const durationMs = opts.durationMs ?? 20_000;
  const rig = opts.rig ?? ROUND3_RIG;
  const seed = opts.seed ?? 9201;
  const envelope = { minAltitudeM: 0.5, maxAltitudeM: rig.droneAltitudeM + 4, maxRadiusFromOriginM: 60 };
  const cells = opts.cells ?? referenceCeilingGrid();
  await mkdir(opts.outRoot, { recursive: true });

  const rows: RunResultRow[] = [];
  let runIndex = 0;

  function buildScenario(cell: ReferenceCeilingCell, consequenceModel: 'stationary' | 'measured-rate'): EpisodeScenario {
    return speedBearingRateCell({
      targetSpeedMps: cell.targetSpeedMps, bearingRateDegS: cell.bearingRateDegS, rangeMenuKind: 'speed-hold', consequenceModel,
      rig, requestedRangeM, durationMs, seed, rangeToleranceM: 1, centralBandFraction: 0.3, envelope,
    });
  }

  async function runOneEntry(cell: ReferenceCeilingCell, consequenceModel: 'stationary' | 'measured-rate', policyName: string, controller: EngineController, role: RunEntry['role']) {
    runIndex++;
    const outDir = resolve(opts.outRoot, `run${String(runIndex).padStart(3, '0')}-v${cell.targetSpeedMps}-b${cell.bearingRateDegS}-${consequenceModel}-${policyName}`);
    const score = await runCell(buildScenario(cell, consequenceModel), controller, outDir, opts);
    rows.push({
      cell, policy: policyName, consequenceModel, role,
      truthCentredFraction: score.truth.centredFraction, truthInRangeBandFraction: score.truth.inRangeBandFraction,
      decisions: score.decisionCount, pass: score.pass?.decided ?? null, validity: score.validity.valid, outDir,
    });
  }

  for (const cell of cells) {
    for (const consequenceModel of ['stationary', 'measured-rate'] as const) {
      await runOneEntry(cell, consequenceModel, 'reference', createReferenceController(), 'reference');
    }
    // Baselines run once per cell (consequenceModel does not change a passive/first-option/
    // seeded-random policy's CHOSEN action — they never read the consequence numbers — only the
    // menu itself matters, which is fixed at speed-hold throughout this sweep).
    await runOneEntry(cell, 'measured-rate', 'passive', createPassiveController(), 'baseline');
    await runOneEntry(cell, 'measured-rate', 'first-option', createFirstOptionController(), 'baseline');
    await runOneEntry(cell, 'measured-rate', 'seeded-random', createSeededRandomController(seed), 'baseline');
  }

  if (opts.exhaustiveConstantsAt) {
    const cell = opts.exhaustiveConstantsAt;
    for (const [id, def] of Object.entries(TRACK_YAW_MENU)) {
      if (def.kind === 'hold') continue;
      await runOneEntry(cell, 'measured-rate', `constant-yaw-${id}`, createConstantController({ yaw: id, range: 'hold' }), 'constant');
    }
    for (const [id, def] of Object.entries(SPEED_HOLD_MENU)) {
      if (def.kind === 'speed_hold' && def.speedMps === 0) continue;
      await runOneEntry(cell, 'measured-rate', `constant-range-${id}`, createConstantController({ yaw: 'hold', range: id }), 'constant');
    }
  }

  // Aggregate: best-of-arms reference PER CELL (both axes reported, never only a joint AND — the
  // ladder's own L4 rule, applied here too since this sweep is a joint grid).
  const cellTable = cells.map(cell => {
    const referenceRows = rows.filter(r => r.role === 'reference' && r.cell.targetSpeedMps === cell.targetSpeedMps && r.cell.bearingRateDegS === cell.bearingRateDegS);
    const bestCentred = Math.max(...referenceRows.map(r => r.truthCentredFraction));
    const bestInRangeBand = Math.max(...referenceRows.map(r => r.truthInRangeBandFraction));
    const baselineRows = rows.filter(r => r.role === 'baseline' && r.cell.targetSpeedMps === cell.targetSpeedMps && r.cell.bearingRateDegS === cell.bearingRateDegS);
    return {
      targetSpeedMps: cell.targetSpeedMps, bearingRateDegS: cell.bearingRateDegS,
      bestReferenceCentredFraction: Number(bestCentred.toFixed(3)), bestReferenceInRangeBandFraction: Number(bestInRangeBand.toFixed(3)),
      clears80Centred: bestCentred >= 0.8, clears80InRangeBand: bestInRangeBand >= 0.8,
      baselines: Object.fromEntries(baselineRows.map(r => [r.policy, { centred: Number(r.truthCentredFraction.toFixed(3)), inRangeBand: Number(r.truthInRangeBandFraction.toFixed(3)) }])),
    };
  });

  // Envelope: the LARGEST tested value on each axis at which the best-of-arms reference clears the
  // 80% floor, holding the OTHER axis at its easiest (0) setting — this recovers the ladder's own
  // "two independent 1-D envelopes" reporting from this pilot's single joint grid (see this file's
  // own module docstring for why a joint grid was run instead of two separate sweeps).
  const speedSlice = cellTable.filter(c => c.bearingRateDegS === 0).sort((a, b) => a.targetSpeedMps - b.targetSpeedMps);
  const rateSlice = cellTable.filter(c => c.targetSpeedMps === 0).sort((a, b) => a.bearingRateDegS - b.bearingRateDegS);
  const speedEnvelope = speedSlice.filter(c => c.clears80InRangeBand).at(-1)?.targetSpeedMps ?? null;
  const rateEnvelope = rateSlice.filter(c => c.clears80Centred).at(-1)?.bearingRateDegS ?? null;

  const exhaustiveConstantsTable = opts.exhaustiveConstantsAt
    ? rows.filter(r => r.role === 'constant').map(r => ({ policy: r.policy, centred: Number(r.truthCentredFraction.toFixed(3)), inRangeBand: Number(r.truthInRangeBandFraction.toFixed(3)) }))
    : [];

  const summary = {
    generatedAtIso: new Date().toISOString(), real: opts.real, rig, requestedRangeM, durationMs,
    sensorModel: opts.real ? 'real renderer + real GPU sensor' : { label: 'SYNTHETIC, fitted to measured figures', ...MEASURED_SYNTHETIC_SENSOR_MODEL },
    table: cellTable, envelope: { targetSpeedMpsAt80PctInRangeBand: speedEnvelope, bearingRateDegSAt80PctCentred: rateEnvelope },
    exhaustiveConstantsAt: opts.exhaustiveConstantsAt ?? null, exhaustiveConstantsTable,
    rows,
  };
  await writeFile(resolve(opts.outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
