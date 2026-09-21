/** Increment B3/B4: runs the provisional L1-L4 scenarios (ladder-scenarios.ts) against
 * reference/passive/the strongest constant/seeded-random, at BOTH camera rigs, on the REAL
 * renderer + real GPU sensor, SEQUENTIALLY (GPU jobs never overlap). Writes one report per
 * (rung, rig, controller, seed) plus one aggregate summary table.
 *
 * Usage:
 *   node experiments/jev-find-follow/run-provisional-ladder.ts [--out-root PATH]
 *     [--envelope-from PATH-to-b3-sweep-summary.json] [--strongest-constant-yaw ID]
 *     [--strongest-constant-range ID] [--rungs l1,l2,l3a,l3b,l4] [--rigs round3,higher]
 *     [--controllers reference,passive,constant,seeded-random] [--seeds 1,2,3]
 *
 * Unit E4b / B4: `--seeds` (comma-separated) reseeds EACH rung's own `world.seed` per run (a
 * genuine reseed, matching run.ts batch's own `--seeds` convention) — default 3 seeds derived from
 * each rung's own base seed (`baseSeed, baseSeed+1, baseSeed+2`), since the assignment requires
 * >=3 seeds per rung/rig for a READY verdict. `seeded-random` added as a fourth buildable
 * controller (the assignment's own READY-table baseline set: reference/passive/strongest-constant/
 * seeded-random).
 *
 * NEVER passes --real to the jev controller (jev is not one of the controllers this script knows
 * how to build) — zero paid requests by construction, not merely by omission.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEpisode, type EpisodeScenario } from './episode.ts';
import { createPassiveController } from './controllers/passive.ts';
import { createReferenceController } from './controllers/reference.ts';
import { createConstantController } from './controllers/constant.ts';
import { createSeededRandomController } from './controllers/seeded-random.ts';
import { buildProvisionalLadder, ROUND3_RIG, CANDIDATE_HIGHER_RIG, ROUND3_RIG_D0_M, CANDIDATE_HIGHER_RIG_D0_M, type MeasuredEnvelope } from './ladder-scenarios.ts';
import type { EngineController } from './controllers/types.ts';

const MAIN_CHECKOUT = 'C:/Users/danhm/tools/robots-world';

function parseFlags(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) { const value = argv[i + 1]; map.set(token.slice(2), value && !value.startsWith('--') ? value : 'true'); if (value && !value.startsWith('--')) i++; }
  }
  return map;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const outRoot = resolve(flags.get('out-root') ?? '.runtime/experiments/jev-find-follow-v1/e3b-provisional-ladder');
  await mkdir(outRoot, { recursive: true });

  // Resumable: if a summary.json already exists at outRoot (e.g. a previous invocation covered
  // round3 and this one only asks for --rigs higher), merge into it rather than overwriting —
  // keyed by (rung, rig, controller) so a re-run of the SAME cell replaces its old row instead of
  // duplicating it.
  const priorResults: any[] = [];
  try {
    const prior = JSON.parse(await readFile(resolve(outRoot, 'summary.json'), 'utf8'));
    if (Array.isArray(prior.results)) priorResults.push(...prior.results);
  } catch { /* no prior summary — fresh run */ }
  const resultKey = (r: { rung: string; rig: string; controller: string; seed: number }) => `${r.rung}|${r.rig}|${r.controller}|${r.seed}`;
  const resultsByKey = new Map(priorResults.map(r => [resultKey(r), r]));

  let envelope: MeasuredEnvelope = { bearingRateDegSAt80PctCentred: null, targetSpeedMpsAt80PctInRangeBand: null };
  const envelopeFromPath = flags.get('envelope-from');
  if (envelopeFromPath) {
    const summary = JSON.parse(await readFile(resolve(envelopeFromPath), 'utf8'));
    envelope = summary.envelope;
  }

  const strongestConstantYaw = flags.get('strongest-constant-yaw') ?? 'yaw_left_10';
  const strongestConstantRange = flags.get('strongest-constant-range') ?? 'speed_0_5';

  const rendererPython = flags.get('renderer-python') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe');
  const rendererScript = flags.get('renderer-script') ?? resolve(MAIN_CHECKOUT, 'experiments/jev-round3/camera/renderer.py');
  const sensorPython = flags.get('sensor-python') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe');
  const sensorCwd = flags.get('sensor-cwd') ?? resolve('experiments/jev-library');
  const checkpointPath = flags.get('checkpoint') ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-library-v1/detector/models/yolo11s-seg.pt');
  const detectorRuntimeRoot = flags.get('detector-runtime-root') ?? resolve('.runtime/experiments/jev-find-follow-v1/detector-runtime');
  await mkdir(detectorRuntimeRoot, { recursive: true });

  const rigs: Record<string, { rig: typeof ROUND3_RIG; d0: number; label: string }> = {
    round3: { rig: ROUND3_RIG, d0: ROUND3_RIG_D0_M, label: 'round3-1.8m--5deg' },
    higher: { rig: CANDIDATE_HIGHER_RIG, d0: CANDIDATE_HIGHER_RIG_D0_M, label: 'higher-3m--15deg' },
  };
  const rigIds = (flags.get('rigs') ?? 'round3,higher').split(',').map(s => s.trim());
  const rungIds = (flags.get('rungs') ?? 'l1,l2,l3a,l3b,l4').split(',').map(s => s.trim());
  const controllerIds = (flags.get('controllers') ?? 'reference,passive,constant,seeded-random').split(',').map(s => s.trim());
  const explicitSeeds = flags.has('seeds') ? flags.get('seeds')!.split(',').map(Number) : null;

  function buildController(id: string, seed: number): EngineController {
    if (id === 'reference') return createReferenceController();
    if (id === 'passive') return createPassiveController();
    if (id === 'constant') return createConstantController({ yaw: strongestConstantYaw, range: strongestConstantRange });
    if (id === 'seeded-random') return createSeededRandomController(seed);
    throw new Error(`Unknown controller: ${id} (this script never builds the jev controller — zero paid requests by construction)`);
  }

  for (const rigId of rigIds) {
    const { rig, d0 } = rigs[rigId]!;
    const ladder = buildProvisionalLadder(rig, d0, envelope);
    for (const rungId of rungIds) {
      const baseScenario: EpisodeScenario = (ladder as any)[rungId];
      if (!baseScenario) throw new Error(`Unknown rung: ${rungId}`);
      // Unit E4b / B4: >=3 seeds per rung/rig, default derived from the rung's own declared base
      // seed (baseSeed, baseSeed+1, baseSeed+2) so every rung gets a DISTINCT default seed family
      // (never colliding with another rung's), unless the caller passes an explicit --seeds list
      // (applied identically to every rung/rig in that case).
      const seeds = explicitSeeds ?? [baseScenario.world.seed, baseScenario.world.seed + 1, baseScenario.world.seed + 2];
      for (const controllerId of controllerIds) {
        for (const seed of seeds) {
          const scenario: EpisodeScenario = { ...baseScenario, world: { ...baseScenario.world, seed } };
          const outDir = resolve(outRoot, `${rungId}-${rigId}-${controllerId}-seed${seed}`);
          await mkdir(outDir, { recursive: true });
          console.error(JSON.stringify({ starting: rungId, rig: rigId, controller: controllerId, seed, outDir }));
          const key = resultKey({ rung: rungId, rig: rigId, controller: controllerId, seed });
          try {
            const report = await runEpisode(scenario, {
              controller: buildController(controllerId, seed), outputRoot: outDir, seed,
              renderer: { pythonExecutable: rendererPython, rendererScriptPath: rendererScript },
              sensor: { pythonExecutable: sensorPython, sensorCwd, checkpointPath, detectorRuntimeRoot },
            });
            resultsByKey.set(key, {
              rung: rungId, rig: rigId, controller: controllerId, seed, pass: report.score.pass?.decided ?? null,
              truthCentred: Number(report.score.truth.centredFraction.toFixed(3)), truthInRangeBand: Number(report.score.truth.inRangeBandFraction.toFixed(3)),
              validity: report.score.validity.valid, decisions: report.score.decisionCount, skipped: report.score.skippedAcquisitions,
              envelopeViolations: report.score.envelopeViolations, contacts: report.score.contacts, vetoedManeuvers: report.score.vetoedManeuvers,
              wallMsPerSimSecond: Number(report.wallTimeBudget.wallMsPerSimulatedSecond.toFixed(1)), outDir,
            });
          } catch (error) {
            console.error(JSON.stringify({ rung: rungId, rig: rigId, controller: controllerId, seed, failed: String(error) }));
            resultsByKey.set(key, { rung: rungId, rig: rigId, controller: controllerId, seed, error: String(error) });
          }
          await writeFile(resolve(outRoot, 'summary.json'), JSON.stringify({ generatedAtIso: new Date().toISOString(), envelope, results: [...resultsByKey.values()] }, null, 2));
        }
      }
    }
  }
  console.log(JSON.stringify([...resultsByKey.values()], null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
