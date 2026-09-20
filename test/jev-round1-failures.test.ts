import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createMeter, durable, digest } from '../experiments/jev-spatial-text/transport.ts';
import { runBench, type BenchResponse } from '../experiments/jev-spatial-text/bench.ts';
import { liveRequest, readLive } from '../experiments/jev-round1/live.ts';
import { LIVE_PLAN } from '../experiments/jev-round1/protocol.ts';
import { cases, execute, readFixed } from '../experiments/jev-round1/run.ts';

async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const parent = resolve(tmpdir()), root = await mkdtemp(resolve(parent, 'round1-failure-'));
  t.after(async () => { assert(resolve(root).startsWith(parent + sep)); assert(root.split(sep).at(-1)!.startsWith('round1-failure-')); await rm(root, { recursive: true, force: true }); }); return root;
}
test('failed selected followup retains the actual successful first response and selected branch', async t => {
  const root = await temporary(t), c = cases().find(p => p.meta.followups)!;
  const selected = c.expected.evidence![0]!, reply = { model: c.request.model, usage: { input_tokens: 1 }, answers: { evidence: {
    type: 'choice' as const, choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(c.request.questions.evidence!.criteria).map(k => [k, Number(k === selected)])) } } };
  let calls = 0; const meter = createMeter({ root, key: '', send: async () => { if (++calls === 1) return reply; throw new Error('Synthetic followup outage'); } });
  try { await assert.rejects(execute(c, (request, id) => meter.judge(request, id)), /Synthetic followup outage/); }
  finally { meter.close(); }
  const result = (await readFixed(root)).find(p => p.id === c.id)!;
  assert.equal(result.status, 'error'); assert.deepEqual(result.initialResponse, reply);
  assert.deepEqual(result.followupRequest, c.meta.followups[selected].request); assert.equal(result.followupResponse, null);
  assert.deepEqual(result.callStatuses.map((r: any) => r.status), ['completed', 'error']); assert.equal(result.correct, undefined);
});

test('a finalized failed live attempt replays available frames and error without invented response or timing', async t => {
  const root = await temporary(t), trial = LIVE_PLAN[0]!, directory = resolve(root, 'live', trial.id), ids: string[] = [];
  const meter = createMeter({ root, key: '', send: async () => { throw new Error('Synthetic live outage'); } });
  try {
    const summary = await runBench({ ...trial, arm: 'receipt', outputDir: resolve(root, 'live'), judge: async (engine, id) => {
      const wire = liveRequest(engine, trial.arm); ids.push(id); durable(resolve(directory, `${id}.wire-request.json`), wire, true);
      return meter.judge(wire, id) as Promise<BenchResponse>;
    } });
    assert.equal(summary.status, 'invalid');
  } finally { meter.close(); }
  const files = await Promise.all((await readdir(directory, { recursive: true })).filter(p => /\.(json|jsonl|png)$/.test(p)).sort().map(async path => ({ path, sha256: digest(await readFile(resolve(directory, path))) })));
  durable(resolve(directory, 'finalization.json'), { trial, sourceSha256: 'offline-fixture', status: 'infrastructure-invalid', errors: ['Synthetic live outage'], requestIds: ids, files }, true);
  const { episodes, pending } = await readLive('offline-fixture', root, [trial]); assert.equal(pending.length, 0); assert.equal(episodes.length, 1);
  const episode = episodes[0], d = episode.decisions[0]; assert.equal(episode.status, 'infrastructure-invalid'); assert.equal(episode.frames.length, 1);
  assert.equal(d.status, 'error'); assert.match(d.error, /Synthetic live outage/); assert.equal(d.response, null); assert.equal(d.selectedAction, null);
  assert.equal(d.httpLatencyMs, null); assert.equal(d.sourceWallAgeAtResponseMs, null); assert.equal(d.newerFramesDuringRequest, null); assert.equal(d.command, null);
  await writeFile(resolve(directory, 'commands.json'), '[]\n');
  await assert.rejects(readLive('offline-fixture', root, [trial]), /Changed live evidence/);
});
