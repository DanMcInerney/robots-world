/** Construction-only tests for controllers/jev.ts (A4, engine-review-e3 finding 4): this unit is
 * IMPLEMENTED, NOT RUN — no request to TypeSafe/Jev is made anywhere in this repository at this
 * stage, and these tests must never make one either. `createJevController`'s `answer()` method
 * always calls the REAL transport (`callJev`, hard-coded, no test seam), so it is never invoked
 * here; these tests only check the controller's shape/wiring, which is safe to do without a key or
 * any network access.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevController, DEFAULT_LATENCY_CLAMP_MS } from '../experiments/jev-find-follow/controllers/jev.ts';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ff-jev-ctrl-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('createJevController requires a saved key, never silently proceeds with none', async () => {
  await withTmpDir(async root => {
    assert.throws(() => createJevController({ root, key: '' }), /requires a saved key/);
  });
});

test('createJevController: id, declared latency clamp, and default clamp are wired as expected', async () => {
  await withTmpDir(async root => {
    const controller = createJevController({ root, key: 'not-a-real-key-never-used' });
    assert.equal(controller.id, 'jev');
    assert.deepEqual(controller.realLatencyClampMs, DEFAULT_LATENCY_CLAMP_MS);
    controller.close!();
  });
});

test('createJevController: a caller-supplied latencyClampMs overrides the default', async () => {
  await withTmpDir(async root => {
    const controller = createJevController({ root, key: 'not-a-real-key-never-used', latencyClampMs: [50, 4000] });
    assert.deepEqual(controller.realLatencyClampMs, [50, 4000]);
    controller.close!();
  });
});

// A4 (engine-review-e3 finding 4, part 2): episode.ts now prefers `lastRealLatencyMs()` over its
// own Date.now()-based measurement when a controller implements it. This only checks the getter
// exists and its declared "unknown before any call" state — the ledger-reading logic itself is
// exercised indirectly via jev-spatial-text-transport.test.ts's own coverage of `ledger()`, since
// actually calling `answer()` here would require a real (prohibited) network request.
test('createJevController implements lastRealLatencyMs(), reporting null before any call has completed', async () => {
  await withTmpDir(async root => {
    const controller = createJevController({ root, key: 'not-a-real-key-never-used' });
    assert.equal(typeof controller.lastRealLatencyMs, 'function', 'expected lastRealLatencyMs to be implemented (A4: episode.ts prefers it over its own wall-clock measurement)');
    assert.equal(controller.lastRealLatencyMs!(), null, 'no call has completed yet, so this must be null, never a fabricated 0 or stale value');
    controller.close!();
  });
});
