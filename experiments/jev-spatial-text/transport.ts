import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { callJev } from '../jev-pixels/controller.ts';
import { choice, MODEL, type Request, type Response } from '../jev-strategies/strategies.ts';

export const ROOT = resolve('.runtime/experiments/jev-spatial-text-v1');
export const CEILINGS = { requests: 25000, inputTokens: 250000000, requestsPerSecond: 2 };
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function durable(file: string, data: unknown, exclusive = false) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, exclusive ? 'wx' : 'a');
  try { writeSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
export function validateRequest(request: Request) {
  assert.equal(request.model, MODEL);
  assert(Object.keys(request.questions).length > 0);
  const state = Buffer.byteLength(JSON.stringify(request.state));
  let longest = 0;
  for (const q of Object.values(request.questions)) {
    assert.equal(q.type, 'choice');
    assert(!Array.isArray(q.criteria));
    const count = Object.keys(q.criteria).length;
    assert(count >= 2 && count <= 255, 'Choice requires 2–255 options');
    longest = Math.max(longest, Buffer.byteLength(JSON.stringify(q)));
  }
  // Conservative UTF-8-byte bounds plus serialization overhead, not an exact tokenizer.
  assert(state + longest + 512 <= 32768, 'State + longest question exceeds conservative bound');
  assert(Buffer.byteLength(JSON.stringify(request)) + 512 + 64 * Object.keys(request.questions).length <= 65536,
    'Complete request exceeds conservative bound');
}
export function validateResponse(request: Request, response: Response) {
  assert.equal(response.model, MODEL);
  assert.deepEqual(Object.keys(response.answers).sort(), Object.keys(request.questions).sort());
  for (const [id, q] of Object.entries(request.questions)) choice(response, id, Object.keys(q.criteria));
  if (response.usage?.input_tokens !== undefined) assert(Number.isSafeInteger(response.usage.input_tokens) && response.usage.input_tokens >= 0);
}
export function ledger(root = ROOT): any[] {
  const file = resolve(root, 'requests.jsonl');
  if (!existsSync(file)) return [];
  const calls = new Map<string, any>();
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    calls.set(row.id, { ...calls.get(row.id), ...row });
  }
  return [...calls.values()];
}
export function summarizeUsage(root = ROOT) {
  const rows = ledger(root);
  const reportedTokens = rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  const uncertainReservedTokens = rows.reduce((n, r) => n + (r.inputTokens == null ? r.reserve : 0), 0);
  return { requests: rows.length, completed: rows.filter(r => r.status === 'completed').length,
    errors: rows.filter(r => r.status !== 'completed').length, reportedTokens, uncertainReservedTokens,
    accountedTokens: reportedTokens + uncertainReservedTokens, reportedCostUsd: reportedTokens / 1000000 * .042 };
}
export async function readCompleted(request: Request, id: string, row: any, root = ROOT): Promise<Response> {
  assert.equal(row?.status, 'completed', `Missing completed record: ${id}`);
  const serialized = JSON.stringify(request);
  assert.equal(row.requestSha256, digest(serialized), 'Frozen request differs from dispatched payload');
  assert.equal(digest(await readFile(resolve(root, 'requests', id + '.json'))), digest(serialized + '\n'), 'Stored request bytes changed');
  const bytes = await readFile(resolve(root, 'responses', id + '.json'), 'utf8');
  assert.equal(digest(bytes), row.responseSha256, 'Stored response bytes changed');
  const response = JSON.parse(bytes); validateResponse(request, response); return response;
}
export async function verifyFrozenStage(stage: string, root = ROOT) {
  const directory = resolve(root, 'freezes', stage);
  const frozen = JSON.parse(await readFile(resolve(directory, 'freeze.json'), 'utf8'));
  assert.equal(frozen.model, MODEL);
  assert.equal(digest(JSON.stringify(frozen.entries)), frozen.sourceSha256);
  for (const entry of frozen.entries) assert.equal(digest(await readFile(resolve(directory, 'source', entry.path))), entry.sha256, `Frozen source changed: ${entry.path}`);
  return frozen;
}
export type MeterOptions = { root?: string; key: string; minStartIntervalMs?: number; limits?: typeof CEILINGS;
  send?: (request: Request, key: string, signal: AbortSignal) => Promise<Response> };
export function createMeter(options: MeterOptions) {
  const root = options.root ?? ROOT, limits = options.limits ?? CEILINGS;
  mkdirSync(root, { recursive: true });
  const lock = resolve(root, 'dispatch.lock');
  durable(lock, { pid: process.pid, started: new Date().toISOString() }, true);
  let closed = false, busy = false;
  const rows = new Map(ledger(root).map(row => [row.id, row]));
  let lastStart = Math.max(0, ...[...rows.values()].map(r => r.dispatchedAtMs ?? 0));
  const unresolved = [...rows.values()].filter(r => r.status !== 'completed' && !r.recovery);
  if (unresolved.length) { unlinkSync(lock); throw new Error(`Unresolved calls; preserve and explicitly reconcile: ${unresolved.map(r => r.id).join(', ')}`); }
  const journal = (row: any) => {
    const data = { ...row, at: new Date().toISOString() };
    durable(resolve(root, 'requests.jsonl'), data);
    rows.set(row.id, { ...rows.get(row.id), ...data });
  };
  return {
    async judge(request: Request, id: string, signal = new AbortController().signal): Promise<Response> {
      assert(!closed && !busy, 'One serial dispatcher required');
      assert(/^[a-zA-Z0-9_.-]+$/.test(id), 'Unsafe request ID');
      validateRequest(request);
      const serialized = JSON.stringify(request), hash = digest(serialized), prior = rows.get(id);
      if (prior) {
        assert.equal(prior.requestSha256, hash, 'Cannot reuse request ID for changed payload');
        assert.equal(prior.status, 'completed', 'An uncertain/error request is never replayed');
        return readCompleted(request, id, prior, root);
      }
      assert(![...rows.values()].some(r => r.status !== 'completed' && !r.recovery), 'Dispatcher stopped after unresolved failure');
      assert(options.key || options.send, 'Saved Jev key required');
      const accounted = [...rows.values()].reduce((n, r) => n + (r.inputTokens ?? r.reserve), 0);
      const reserve = 65536;
      assert(rows.size < limits.requests && accounted + reserve <= limits.inputTokens, 'Campaign ceiling reached');
      busy = true;
      try {
        const interval = Math.max(505, options.minStartIntervalMs ?? 505);
        while (Date.now() - lastStart < interval) await sleep(Math.ceil(interval - (Date.now() - lastStart)), undefined, { signal });
        signal.throwIfAborted();
        await mkdir(resolve(root, 'requests'), { recursive: true });
        await mkdir(resolve(root, 'responses'), { recursive: true });
        durable(resolve(root, 'requests', id + '.json'), request, true);
        lastStart = Date.now();
        journal({ id, status: 'dispatched', requestSha256: hash, reserve, dispatchedAtMs: lastStart });
        try {
          const response = await (options.send ?? callJev)(request, options.key, signal);
          const bytes = JSON.stringify(response) + '\n';
          durable(resolve(root, 'responses', id + '.json'), response, true);
          journal({ id, status: 'returned', responseSha256: digest(bytes), latencyMs: Date.now() - lastStart,
            inputTokens: response.usage?.input_tokens ?? null, actualModel: response.model });
          validateResponse(request, response);
          journal({ id, status: 'completed' });
          return response;
        } catch (error) {
          journal({ id, status: 'error', error: String(error).split(options.key || '__NO_KEY__').join('[redacted]') });
          throw error;
        }
      } finally { busy = false; }
    },
    close() { if (!closed) { assert(!busy); unlinkSync(lock); closed = true; } },
  };
}

export async function freezeStage(stage: string, manifest: unknown, root = ROOT) {
  assert(/^[a-zA-Z0-9_.-]+$/.test(stage));
  const directory = resolve(root, 'freezes', stage);
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json'];
  for (const base of ['src', 'experiments']) {
    for (const file of await readdir(base, { recursive: true })) {
      const path = `${base}/${file.replaceAll('\\', '/')}`;
      // Independent motion diagnostics have their own freeze and are never imported by these runners.
      if (/\.(ts|py|json)$/.test(file) && !file.includes('__pycache__') && !path.startsWith('experiments/jev-spatial-text/motion/')) paths.push(path);
    }
  }
  const entries = [];
  for (const path of paths.sort()) { const bytes = await readFile(path); entries.push({ path, sha256: digest(bytes), bytes: bytes.length }); }
  const content = JSON.parse(JSON.stringify({ model: MODEL, manifest, entries, sourceSha256: digest(JSON.stringify(entries)) }));
  if (existsSync(resolve(directory, 'freeze.json'))) {
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, 'freeze.json'), 'utf8')), content, 'Frozen stage source or plan changed');
    return content;
  }
  for (const entry of entries) {
    const dest = resolve(directory, 'source', entry.path); await mkdir(dirname(dest), { recursive: true });
    const bytes = await readFile(entry.path); assert.equal(digest(bytes), entry.sha256);
    await writeFile(dest, bytes, { flag: 'wx' });
  }
  durable(resolve(directory, 'freeze.json'), content, true);
  return content;
}
