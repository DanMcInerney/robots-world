/** engine-review-e1 finding 6 (determinism): "launch the renderer with a fixed PYTHONHASHSEED,
 * verify >=15 process starts give byte-identical images (else find cause or quantify)."
 *
 * Gated real-GPU check, same skip pattern as test/jev-find-follow-real-integration.test.ts: skips
 * cleanly (not a failure) when the pinned renderer environment is absent. Each of the 15 renders
 * spawns a genuinely FRESH renderer PROCESS (not 15 calls against one warm client) — PYTHONHASHSEED
 * only matters across separate process starts (CPython randomises hash seed per-process by
 * default), so reusing one process would not exercise what this finding is actually about.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startRendererClient } from '../experiments/jev-find-follow/renderer-client.ts';

const MAIN_CHECKOUT = 'C:/Users/danhm/tools/robots-world';
const rendererPython = process.env.JEV_FIND_FOLLOW_RENDERER_PYTHON
  ?? resolve(MAIN_CHECKOUT, '.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe');
const rendererScript = resolve(MAIN_CHECKOUT, 'experiments/jev-round3/camera/renderer.py');
const rendererAvailable = existsSync(rendererPython) && existsSync(rendererScript);
const skipReason = 'Optional local renderer environment unavailable (set JEV_FIND_FOLLOW_RENDERER_PYTHON to override); no installs, no held network access';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const REQUEST = {
  seq: 1,
  camera_pose: { position: [0, 0, 1.8] as [number, number, number], yaw_rad: 0, pitch_rad: -5 * Math.PI / 180, roll_rad: 0 },
  target_pose: { position: [8, 0, 0] as [number, number, number], yaw_rad: 0, pitch_rad: 0, roll_rad: 0 },
  scene_config: { seed: 4242, obstacles: [], lookalikes: [] },
};

// MEASURED (2026-09-21, this machine, PYTHONHASHSEED=0, 15 fresh process starts, seed 4242):
// left.png was byte-identical across all 15 starts; right.png was NOT — 2 distinct hashes among
// 15. Root cause not fully identified: scene construction is fully seeded (renderer.py's own
// np.random.default_rng(seed) for ground/building textures — verified by reading the source, see
// FAILURES.md), so the variance is downstream of scene setup, inside pyrender/OpenGL's own
// rendering of the SECOND (right) stereo camera specifically. Not chased further within this
// unit's scope (renderer.py's rendering internals, not an additive request-field change this
// permission covers) — declared and quantified here rather than silently ignored or force-passed.
// This test therefore holds LEFT to the achieved bar (byte-identical: a real regression guard) and
// only QUANTIFIES right.png's variance (fails only on a materially worse regression), per the
// finding's own "verify ... (else find cause or quantify)" — quantifying, not hiding, the gap.
const MAX_ACCEPTABLE_DISTINCT_RIGHT_HASHES = 4; // measured 2/15; a margin above that, not a re-run-until-green threshold

test('renderer determinism: >=15 FRESH process starts of the identical request produce a byte-identical left.png; right.png variance is quantified, not silently ignored', { skip: !rendererAvailable ? skipReason : false, timeout: 180_000 }, async () => {
  const N = 15;
  const hashes: { left: string; right: string }[] = [];
  const dirs: string[] = [];
  try {
    for (let i = 0; i < N; i++) {
      const outputRoot = await mkdtemp(join(tmpdir(), `ff-det-${i}-`));
      dirs.push(outputRoot);
      const client = await startRendererClient({ pythonExecutable: rendererPython, rendererScriptPath: rendererScript, outputRoot });
      try {
        const result = await client.render(REQUEST);
        hashes.push({ left: sha256File(result.leftPath), right: sha256File(result.rightPath) });
      } finally {
        await client.close();
      }
    }
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
  const distinctLeft = new Set(hashes.map(h => h.left));
  const distinctRight = new Set(hashes.map(h => h.right));
  console.error(`[determinism] left.png: ${distinctLeft.size} distinct hash(es) among ${N}; right.png: ${distinctRight.size} distinct hash(es) among ${N}`);
  if (distinctRight.size > 1) console.error(`[determinism] right.png hashes: ${[...distinctRight].join(', ')} (quantified non-determinism, not a fatal failure below ${MAX_ACCEPTABLE_DISTINCT_RIGHT_HASHES})`);
  assert.equal(distinctLeft.size, 1, `left.png must be byte-identical across ${N} fresh process starts of the identical request`);
  assert.ok(distinctRight.size <= MAX_ACCEPTABLE_DISTINCT_RIGHT_HASHES, `right.png variance grew materially beyond the measured baseline: ${distinctRight.size} distinct hashes among ${N} (baseline: 2/15)`);
});
