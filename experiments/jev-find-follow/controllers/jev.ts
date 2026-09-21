/** jev controller: the real, metered, journalled controller. IMPLEMENTED, NOT RUN this stage (no
 * request to TypeSafe/Jev is made by this assignment). Reuses
 * experiments/jev-spatial-text/transport.ts's meter/ledger EXACTLY as
 * experiments/jev-scout-encodings/run.ts does (`createMeter`, `judge`, the 505 ms pacing floor,
 * durable request/response journalling, stop-on-error, no retries), and
 * experiments/jev-pixels/controller.ts's `callJev` as the transport, model `jev-1.13.0`.
 *
 * The API key is read from an env file path supplied at run time
 * (`node --env-file=<path> experiments/jev-find-follow/run.ts episode --controller jev ...`,
 * matching jev-scout-encodings/run.ts's own documented invocation) via `TYPESAFE_API_KEY` or
 * `JEV_API_KEY`; it is never logged or printed (`createMeter`'s own error redaction already
 * strips the key from any journalled error string — see transport.ts).
 */
import { callJev } from '../../jev-pixels/controller.ts';
import { createMeter, ledger, type MeterOptions } from '../../jev-spatial-text/transport.ts';
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import type { ControllerContext, EngineController } from './types.ts';

export interface JevControllerOptions {
  /** Directory for this episode's request/response journal (ledger.jsonl, requests/, responses/). */
  root: string;
  /** Read from an env file at run time; never printed. */
  key: string;
  /** Real measured wall latency is clamped into this range for the simulated-time bookkeeping
   * (scheduler.ts's controllerLatencyMs), so one abnormally slow/fast real call cannot distort the
   * simulated clock outside a declared envelope. */
  latencyClampMs?: [number, number];
}

export const DEFAULT_LATENCY_CLAMP_MS: [number, number] = [100, 8000];

export function createJevController(options: JevControllerOptions): EngineController {
  if (!options.key) throw new Error('jev controller requires a saved key (load with --env-file=<path>); never hard-code or print it');
  const meterOptions: MeterOptions = { root: options.root, key: options.key, send: callJev };
  const meter = createMeter(meterOptions);
  const clamp = options.latencyClampMs ?? DEFAULT_LATENCY_CLAMP_MS;
  // A4 (engine-review-e3 finding 4): "simulated controller latency = measured API latency,
  // excluding in-flight render/sense time and journalling overhead". `meter.judge()`'s own ledger
  // (transport.ts) already records exactly that figure per call — `latencyMs: Date.now() - lastStart`
  // captured immediately after the raw `send`/API call returns, BEFORE the response file write,
  // `validateResponse`, and the `completed` journal entry that all still run inside `judge()` before
  // ITS promise resolves back to us. Re-reading the ledger row for this call's id after `judge()`
  // settles recovers that precise figure instead of episode.ts having to time the whole (overhead-
  // inclusive) `answer()` call from the outside.
  let lastRealLatencyMs: number | null = null;
  return {
    id: 'jev',
    realLatencyClampMs: clamp,
    async answer(request: DecisionRequest, context: ControllerContext, signal: AbortSignal): Promise<DecisionResponse> {
      const response = await meter.judge(request as any, context.requestId, signal);
      const row = ledger(options.root).find(r => r.id === context.requestId);
      lastRealLatencyMs = typeof row?.latencyMs === 'number' ? row.latencyMs : null;
      return response as unknown as DecisionResponse;
    },
    lastRealLatencyMs: () => lastRealLatencyMs,
    close() { meter.close(); },
  };
}
// engine-review-e2 finding 7 ("remove unused code — clampJevLatencyMs if genuinely unused"): this
// module previously exported a standalone `clampJevLatencyMs` for episode.ts to call directly.
// episode.ts now clamps generically for ANY controller declaring `realLatencyClampMs` (see its own
// inline clamp next to `controllerLatencyTimedOut`), so this function had no remaining callers —
// confirmed by a repo-wide grep — and has been removed rather than left to bit-rot.
