import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  isKnownSystemCompositor, parseArgs, resolveComputeAppEntryName, runViaPlainReader,
  CONTENTION_CPU_LOAD_PERCENT, CONTENTION_GPU_POWER_W,
} from '../integrations/measure-stereo-objects-latency.ts';

// item 11, path resolution: every path argument must be resolved to an absolute path before the
// sensor is spawned, regardless of the CLI caller's own working directory or a relative --sensor-cwd.
test('parseArgs resolves every path argument to an absolute path', () => {
  const args = parseArgs([
    '--python', 'fake-python.exe', '--sensor-cwd', 'experiments/jev-library', '--manifest', 'm.json',
    '--checkpoint', 'ckpt.pt', '--detector-runtime-root', 'runtime', '--sample-ids-file', 'ids.txt',
    '--rate-hz', '5', '--out-dir', 'out', '--ffs-runtime-root', 'ffs-runtime',
  ]);
  for (const value of [args.pythonExecutable, args.sensorCwd, args.manifestPath, args.checkpointPath, args.detectorRuntimeRoot, args.sampleIdsFile, args.outDir, args.ffsRuntimeRoot!]) {
    assert.equal(value, resolve(value), `expected an already-absolute path, got: ${value}`);
  }
  assert.equal(args.rateHz, 5);
});

test('parseArgs leaves an already-absolute path unchanged', () => {
  const absoluteManifest = resolve('some/manifest.json');
  const args = parseArgs([
    '--python', 'p.exe', '--sensor-cwd', 'c', '--manifest', absoluteManifest, '--checkpoint', 'k.pt',
    '--detector-runtime-root', 'r', '--sample-ids-file', 'i.txt', '--rate-hz', '10', '--out-dir', 'o',
  ]);
  assert.equal(args.manifestPath, absoluteManifest);
  assert.equal(args.ffsRuntimeRoot, undefined);
});

// item 11, contention rule: the Windows compositor must not itself count as contention, but any
// other process still does.
test('isKnownSystemCompositor excludes only dwm.exe, case-insensitively', () => {
  assert.equal(isKnownSystemCompositor('1234, dwm.exe'), true);
  assert.equal(isKnownSystemCompositor('5678, DWM.EXE'), true);
  assert.equal(isKnownSystemCompositor('9012, bf6.exe'), false);
  assert.equal(isKnownSystemCompositor('9012, python.exe'), false);
});

// engine-review-e1 finding 8: reproduces the review's repro directly — a non-elevated
// `nvidia-smi --query-compute-apps` entry for dwm.exe (PID 2576) with the process name withheld
// ("2576, "). Pre-repair, isKnownSystemCompositor never saw "dwm.exe" in that string and the
// machine read as contended purely from the compositor. The PID->name resolver fills the name in
// BEFORE the compositor check, so the enriched entry is recognised.
test('resolveComputeAppEntryName fills in a withheld process name from the PID so dwm.exe is recognised', () => {
  const resolved = resolveComputeAppEntryName('2576, ', pid => (pid === '2576' ? 'dwm.exe' : null));
  assert.equal(resolved, '2576, dwm.exe');
  assert.equal(isKnownSystemCompositor(resolved), true);
  // Pre-repair behaviour, preserved as the regression baseline: the raw withheld-name entry does
  // NOT match, which is exactly the bug.
  assert.equal(isKnownSystemCompositor('2576, '), false);
});
test('resolveComputeAppEntryName also fills in an explicit "N/A" name (nvidia-smi\'s own withheld-name marker on some driver versions)', () => {
  assert.equal(resolveComputeAppEntryName('2576, N/A', pid => (pid === '2576' ? 'dwm.exe' : null)), '2576, dwm.exe');
});
test('resolveComputeAppEntryName leaves an entry with a real process name unchanged, even when the resolver would answer differently', () => {
  assert.equal(resolveComputeAppEntryName('9012, python.exe', () => 'dwm.exe'), '9012, python.exe');
});
test('resolveComputeAppEntryName returns the original entry unchanged when the PID cannot be resolved', () => {
  assert.equal(resolveComputeAppEntryName('4321, ', () => null), '4321, ');
});

test('the GPU contention threshold sits between the measured idle draw (17-23W) and a measured contended run (~149W)', () => {
  assert.ok(CONTENTION_GPU_POWER_W > 23, 'must not flag the machine\'s own idle power draw as contention');
  assert.ok(CONTENTION_GPU_POWER_W < 149, 'must still catch a real contended run');
  assert.ok(CONTENTION_CPU_LOAD_PERCENT > 0 && CONTENTION_CPU_LOAD_PERCENT <= 100);
});

// item 11, early-exit detection: a sensor process that exits before producing hello/bye (e.g. a
// startup crash from a bad path) must fail immediately with the captured stderr, never return a
// success-shaped result built from zero observations.
test('runViaPlainReader fails fast with the stderr tail when the child exits before hello/bye', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-latency-early-exit-'));
  const script = join(dir, 'crash.mjs');
  writeFileSync(script, "process.stderr.write('synthetic startup failure: bad --manifest path\\n'); process.exit(2);\n");
  const built = { command: process.execPath, args: [script], cwd: dir, outputs: [], map: () => null } as any;
  await assert.rejects(
    () => runViaPlainReader({ timeoutMs: 5000 } as any, built, () => {}),
    (error: Error) => {
      assert.match(error.message, /exited early/);
      assert.match(error.message, /before producing a hello record/);
      assert.match(error.message, /synthetic startup failure/);
      return true;
    },
  );
});

test('runViaPlainReader succeeds normally when hello and bye are both produced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-latency-clean-exit-'));
  const script = join(dir, 'clean.mjs');
  writeFileSync(script, [
    "console.log(JSON.stringify({type:'hello', model:{checkpointName:'x'}}));",
    "console.log(JSON.stringify({schema:'stereo-objects/2', seq:1, acquired:{clock:'unix-epoch-ms',ms:1}, emittedMs:2, skippedSinceLast:0, objects:[], objectsTotal:0, valid:true}));",
    "console.log(JSON.stringify({type:'bye', reason:'end_of_replay'}));",
  ].join('\n'));
  const built = { command: process.execPath, args: [script], cwd: dir, outputs: [], map: () => null } as any;
  const result = await runViaPlainReader({ timeoutMs: 5000 } as any, built, () => {});
  assert.equal(result.helloRecord.type, 'hello');
  assert.equal(result.byeRecord.reason, 'end_of_replay');
  assert.equal(result.observations.length, 1);
});
