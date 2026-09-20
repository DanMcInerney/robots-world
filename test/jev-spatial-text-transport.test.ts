import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMeter, ledger, validateRequest, readCompleted } from '../experiments/jev-spatial-text/transport.ts';
const request = { model: 'jev-1.13.0', state: { measured: 'unknown' }, questions: { q: { type: 'choice' as const,
  instructions: 'Select supported status', criteria: { a: 'Known', b: 'Unknown' } } } };
const answer = { model: request.model, answers: { q: { type: 'choice', choice: 'b', confidence: 1, probabilities: { a: 0, b: 1 } } }, usage: { input_tokens: 100 } };
test('meter records once, verifies cache, enforces locking and rejects changed payload IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-meter-')); let sends = 0;
  const meter = createMeter({ root, key: '', send: async () => { sends++; return answer; } });
  try {
    assert.throws(() => createMeter({ root, key: '' }));
    await meter.judge(request, 'a'); await meter.judge(request, 'a'); assert.equal(sends, 1);
    await assert.rejects(() => meter.judge({ ...request, state: {} }, 'a'));
    assert.equal(ledger(root)[0].status, 'completed');
  } finally { meter.close(); await rm(root, { recursive: true, force: true }); }
});
test('uncertain call is charged and never silently replayed after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-meter-'));
  const meter = createMeter({ root, key: '', send: async () => { throw new Error('timeout'); } });
  try { await assert.rejects(() => meter.judge(request, 'uncertain')); await assert.rejects(() => meter.judge(request, 'new-after-error'), /stopped/); }
  finally { meter.close(); }
  assert.equal(ledger(root)[0].reserve, 65536);
  assert.throws(() => createMeter({ root, key: '', send: async () => answer }), /Unresolved/);
  await rm(root, { recursive: true, force: true });
});
test('reopening preserves global start spacing and scoring detects changed evidence bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-meter-')), starts: number[] = [];
  const send = async () => { starts.push(performance.now()); return answer; };
  const first = createMeter({ root, key: '', send }); await first.judge(request, 'first'); first.close();
  const second = createMeter({ root, key: '', send });
  try {
    await second.judge(request, 'second'); assert(starts[1]! - starts[0]! >= 500);
    const row = ledger(root).find(r => r.id === 'first');
    await readCompleted(request, 'first', row, root);
    await writeFile(join(root, 'responses/first.json'), JSON.stringify({ ...answer, usage: { input_tokens: 101 } }) + '\n');
    await assert.rejects(() => readCompleted(request, 'first', row, root), /response bytes/);
    await writeFile(join(root, 'requests/second.json'), JSON.stringify(request));
    await assert.rejects(() => second.judge(request, 'second'), /request bytes/);
  } finally { second.close(); await rm(root, { recursive: true, force: true }); }
});
test('request boundaries reject oversized state and choices before dispatch', () => {
  assert.throws(() => validateRequest({ ...request, state: 'x'.repeat(33000) }));
  assert.throws(() => validateRequest({ ...request, questions: { q: { type: 'choice', instructions: '', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, `${i}`])) } } }));
});
test('operator cancellation during pacing cannot dispatch or charge an unstarted request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-meter-')); let sends = 0;
  const meter = createMeter({ root, key: '', send: async () => { sends++; return answer; } });
  try {
    await meter.judge(request, 'before-stop');
    const abort = new AbortController(), waiting = meter.judge(request, 'after-stop', abort.signal);
    setTimeout(() => abort.abort('operator stop'), 20);
    await assert.rejects(waiting, /abort/i);
    assert.equal(sends, 1); assert.equal(ledger(root).length, 1);
  } finally { meter.close(); await rm(root, { recursive: true, force: true }); }
});
