import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, readCompleted } from '../jev-spatial-text/transport.ts';
import type { Request, Response } from '../jev-strategies/strategies.ts';

/** Failed calls retain available exact bytes without becoming successful or retryable calls. */
export async function readRecordedCall(request: Request, id: string, row: any, root: string) {
  if (row?.status === 'completed') return { status: 'completed', response: await readCompleted(request, id, row, root), error: null };
  if (!row) return { status: 'not-dispatched', response: null, error: 'No dispatch record' };
  assert.equal(row.requestSha256, digest(JSON.stringify(request)), 'Dispatched request differs from frozen request');
  assert.equal(digest(await readFile(resolve(root, 'requests', id + '.json'))), digest(JSON.stringify(request) + '\n'), 'Stored request bytes changed');
  const path = resolve(root, 'responses', id + '.json'); let response: Response | null = null;
  if (existsSync(path)) {
    const bytes = await readFile(path, 'utf8');
    if (row.responseSha256) assert.equal(digest(bytes), row.responseSha256, 'Stored failed response changed');
    response = JSON.parse(bytes);
  }
  return { status: row.status, response, error: row.error ?? 'Unresolved call; never retried' };
}
