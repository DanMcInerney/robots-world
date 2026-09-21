/** Unit E4b / B3: tests for the multi-seed reference-ceiling sweep tool (b3-sweep.ts). Fake-mode
 * only (CPU, no GPU/renderer needed) with a deliberately TINY grid (1-2 steps per axis, 2 seeds) so
 * this file runs in a few seconds while still exercising the real aggregation logic (mean/min/
 * count-clearing, envelope = ALL seeds clearing, strongest-constant selection) end to end against
 * real (if trivial) episode runs — not a mock of the aggregation math.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runB3Sweep } from '../experiments/jev-find-follow/b3-sweep.ts';
import { ROUND3_RIG } from '../experiments/jev-find-follow/sweep.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(resolve(tmpdir(), 'ff-b3-sweep-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('runB3Sweep: mean/min/count-clearing are computed across seeds (not a single seed, not max-of-each-metric)', async () => {
  await withTempDir(async outRoot => {
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1, 2], durationMs: 2000,
      speedSteps: [0], rateSteps: [0], skipExhaustive: true, fixedConstant: { yaw: 'yaw_left_10', range: 'speed_0_5' },
    });
    assert.equal(summary.speedTable.length, 1);
    const cell = summary.speedTable[0]!;
    assert.equal(cell.bestReference.n, 2, 'n must equal the seed count');
    assert.ok(cell.bestReference.meanClearing >= cell.bestReference.minClearing, 'mean must be >= min');
    // A trivial 2s stationary (speed=0) cell: reference should clear comfortably on both seeds.
    assert.equal(cell.bestReference.countClearing, 2);
  });
});

test('runB3Sweep: the envelope requires ALL seeds to clear the floor, not just the mean', async () => {
  await withTempDir(async outRoot => {
    // speed=3 (well beyond any measured ceiling) should NOT appear in the envelope even if some
    // seed happens to clear by luck; speed=0 (trivial) should.
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1, 2, 3], durationMs: 2000,
      speedSteps: [0, 3], rateSteps: [0], skipExhaustive: true, fixedConstant: { yaw: 'yaw_left_10', range: 'speed_0_5' },
    });
    const speedZero = summary.speedTable.find(c => c.targetSpeedMps === 0)!;
    const speedThree = summary.speedTable.find(c => c.targetSpeedMps === 3)!;
    assert.equal(speedZero.bestReference.countClearing, speedZero.bestReference.n);
    assert.ok(speedThree.bestReference.countClearing < speedThree.bestReference.n || speedThree.bestReference.countClearing === 0, 'a 3 m/s cell should not have every seed clearing the floor');
    assert.equal(summary.envelope.targetSpeedMpsAllSeedsClear80PctInRangeBand, 0, 'the envelope must be the LARGEST value where EVERY seed clears, not just any value that clears on average');
  });
});

test('runB3Sweep: passive/constant baselines are reported per cell and structurally cannot clear a nonzero-motion cell', async () => {
  await withTempDir(async outRoot => {
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1, 2], durationMs: 3000,
      speedSteps: [], rateSteps: [10], skipExhaustive: true, fixedConstant: { yaw: 'hold', range: 'speed_0_5' },
    });
    const cell = summary.rateTable[0]!;
    assert.equal(cell.passive.countClearing, 0, 'passive (never yaws) cannot stay centred against a nonzero bearing rate');
  });
});

test('runB3Sweep: skipExhaustive uses the fixed constant verbatim (never runs the exhaustive search)', async () => {
  await withTempDir(async outRoot => {
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1], durationMs: 2000,
      speedSteps: [0], rateSteps: [], skipExhaustive: true, fixedConstant: { yaw: 'yaw_right_30', range: 'speed_1_5' },
    });
    assert.deepEqual(summary.strongestConstant, { yaw: 'yaw_right_30', rangeSpeedHold: 'speed_1_5' });
    assert.equal(summary.exhaustiveConstantsTables.yaw.length, 0);
    assert.equal(summary.exhaustiveConstantsTables.speedHold.length, 0);
  });
});

test('runB3Sweep: exhaustive constant selection picks a real winner from actual per-option runs (not a hardcoded default)', async () => {
  await withTempDir(async outRoot => {
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1, 2], durationMs: 3000,
      speedSteps: [], rateSteps: [], exhaustiveSpeedCellMps: 1, exhaustiveRateCellDegS: 10,
    });
    assert.ok(summary.exhaustiveConstantsTables.yaw.length > 0, 'must have actually run per-option yaw constants');
    assert.ok(summary.exhaustiveConstantsTables.speedHold.length > 0, 'must have actually run per-option speed-hold constants');
    const winnerRows = summary.exhaustiveConstantsTables.yaw.filter((r: any) => r.optionId === summary.strongestConstant.yaw);
    assert.ok(winnerRows.length > 0, 'the selected winner must appear among the actually-run options');
  });
});

test('runB3Sweep: policies filter limits which controller arms actually run', async () => {
  await withTempDir(async outRoot => {
    const summary = await runB3Sweep({
      outRoot, real: false, rig: ROUND3_RIG, seeds: [1], durationMs: 2000,
      speedSteps: [0.5], rateSteps: [], skipExhaustive: true, fixedConstant: { yaw: 'yaw_left_10', range: 'speed_0_5' },
      policies: ['reference'], consequenceModels: ['measured-rate'],
    });
    // speedMps=0.5 (not 0) deliberately avoids the speed=0 cell's own EXTRA fixed-distance
    // reference row (B3's own "both menus" requirement, unconditional on `policies`/
    // `consequenceModels`) so this assertion isolates the policies/consequenceModels filter alone.
    const rows = summary.rows.filter((r: any) => r.axis === 'speed' && r.value === 0.5);
    assert.ok(rows.every((r: any) => r.role === 'reference'), 'only the reference arm should have run');
    assert.equal(rows.length, 1, 'exactly one consequence model (measured-rate) x one seed');
  });
});
