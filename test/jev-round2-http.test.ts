import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRecorded } from '../experiments/jev-round2/http.ts';

const request = {model: 'jev-1.13.0', state: {}, questions: {}};
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'jev-round2-http-'));
  t.after(() => rm(root, {recursive: true, force: true})); return root;
}
test('Round 2 retains non-2xx and malformed JSON bytes without retry and redacts credentials', async t => {
  const root = await fixture(t); let calls = 0;
  const send = (text: string, status: number) => (async () => {calls++; return new Response(text, {status});}) as typeof fetch;
  await assert.rejects(callRecorded(request, 'test-secret', new AbortController().signal, root, 'http500', send('problem test-secret', 500)), /HTTP 500/);
  const http = JSON.parse(await readFile(join(root, 'http/http500.json'), 'utf8'));
  assert.equal(http.status, 500); assert.equal(http.complete, true);
  assert.equal(Buffer.from(http.bodyBase64, 'base64').toString(), 'problem [redacted]');
  await assert.rejects(callRecorded(request, 'test-secret', new AbortController().signal, root, 'bad-json', send('{ broken', 200)), SyntaxError);
  const invalid = JSON.parse(await readFile(join(root, 'http/bad-json.json'), 'utf8'));
  assert.equal(Buffer.from(invalid.bodyBase64, 'base64').toString(), '{ broken'); assert.equal(calls, 2);
});
test('Round 2 retains a bounded oversized prefix and a received stream-failure prefix', async t => {
  const root = await fixture(t);
  const large = (async () => new Response('x'.repeat(524289))) as typeof fetch;
  await assert.rejects(callRecorded(request, '', new AbortController().signal, root, 'large', large), /exceeds bound/);
  const size = JSON.parse(await readFile(join(root, 'http/large.json'), 'utf8'));
  assert.equal(size.retainedBytes, 524288); assert.equal(size.truncated, true); assert.equal(size.complete, false);
  let pulls = 0;
  const partial = (async () => new Response(new ReadableStream({pull(controller) {
    if (!pulls++) controller.enqueue(new TextEncoder().encode('partial body'));
    else controller.error(new Error('stream interrupted'));
  }}))) as typeof fetch;
  await assert.rejects(callRecorded(request, '', new AbortController().signal, root, 'partial', partial), /stream interrupted/);
  const interrupted = JSON.parse(await readFile(join(root, 'http/partial.json'), 'utf8'));
  assert.equal(Buffer.from(interrupted.bodyBase64, 'base64').toString(), 'partial body'); assert.equal(interrupted.complete, false);
});
test('Round 2 preserves successful raw JSON and records cancelled transport failure without retry', async t => {
  const root = await fixture(t), successful = {model: 'jev-1.13.0', answers: {}};
  const send = (async () => new Response(JSON.stringify(successful))) as typeof fetch;
  assert.deepEqual(await callRecorded(request, '', new AbortController().signal, root, 'ok', send), successful);
  const controller = new AbortController(); controller.abort('stop'); let calls = 0;
  const cancelled = (async (_url: any, options: any) => {calls++; options.signal.throwIfAborted(); throw new Error('unreachable');}) as typeof fetch;
  await assert.rejects(callRecorded(request, '', controller.signal, root, 'cancelled', cancelled), /stop/);
  const cancelledRecord = JSON.parse(await readFile(join(root, 'http/cancelled.json'), 'utf8'));
  assert.equal(cancelledRecord.retainedBytes, 0); assert.equal(cancelledRecord.status, null); assert.equal(calls, 1);
});
