import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { durable, digest } from '../jev-spatial-text/transport.ts';
import type { Request, Response as JevResponse } from '../jev-strategies/strategies.ts';

const MAX_BODY_BYTES = 524288;
/** Preserve received evidence, including bounded prefixes from interrupted/oversized bodies. */
export async function callRecorded(request: Request, key: string, signal: AbortSignal,
  root: string, id: string, fetcher: typeof fetch = fetch): Promise<JevResponse> {
  assert(/^[a-zA-Z0-9_.-]+$/.test(id));
  const chunks: Uint8Array[] = []; let receivedBytes = 0, storedBytes = 0, complete = false;
  let response: globalThis.Response | undefined, streamError: unknown;
  try {
    response = await fetcher('https://api.typesafe.ai/v1/systemone', {method: 'POST',
      headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'}, body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])});
    const reader = response.body?.getReader(); if (!reader) throw new Error('No Jev response body');
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      receivedBytes += part.value.length;
      const take = Math.min(MAX_BODY_BYTES - storedBytes, part.value.length);
      if (take) { chunks.push(part.value.subarray(0, take)); storedBytes += take; }
      if (receivedBytes > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('Jev response exceeds bound; retained prefix'); }
    }
  } catch (error) { streamError = error; }
  const raw = Buffer.concat(chunks);
  // Latin-1 roundtrip preserves non-UTF8 response bytes while removing any echoed credential bytes.
  const secretBytes = Buffer.from(key).toString('latin1');
  const body = key ? Buffer.from(raw.toString('latin1').split(secretBytes).join('[redacted]'), 'latin1') : raw;
  const errorText = streamError ? String(streamError).split(key || '__NO_KEY__').join('[redacted]') : null;
  durable(resolve(root, 'http', id + '.json'), {id, requestSha256: digest(JSON.stringify(request)), status: response?.status ?? null,
    contentType: response?.headers.get('content-type') ?? null, complete, receivedBytes, retainedBytes: raw.length,
    truncated: receivedBytes > MAX_BODY_BYTES, credentialRedacted: !body.equals(raw), bodyBase64: body.toString('base64'),
    retainedBodySha256: digest(body), streamError: errorText}, true);
  if (streamError) throw new Error(errorText!);
  if (!response?.ok) throw new Error(`Jev HTTP ${response?.status}; response retained; no retry`);
  return JSON.parse(body.toString('utf8'));
}
