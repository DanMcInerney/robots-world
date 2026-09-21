import type { ControllerId, DecisionRequest, DecisionResponse, Mode } from '../types.ts';

export interface ControllerContext { mode: Mode; decisionIndex: number; requestId: string }
export interface EngineController {
  readonly id: ControllerId | string;
  answer(request: DecisionRequest, context: ControllerContext, signal: AbortSignal): Promise<DecisionResponse>;
  /** Declares that this controller's SIMULATED controllerLatencyMs should come from its own
   * REAL measured wall latency (clamped to this [min, max] envelope), not the scheduler's declared
   * constant — the real jev controller's own established behaviour (controllers/jev.ts), now
   * generalised so any controller (e.g. a slow-controller test double) can opt in the same way.
   * engine-review-e1 finding 3: "any controller latency survivable (declared clamp; out-of-range =
   * logged timeout with a declared safe behaviour)" — episode.ts clamps into this range and logs a
   * timeout note on the decision record when the measured latency exceeds the max, rather than
   * throwing or silently using an out-of-envelope value. Omitted entirely: episode.ts uses the
   * scheduler's declared `controllerLatencyMs` constant, exactly as before (synthetic/reference/
   * passive/constant/first-option/seeded-random, all near-instant in wall time). */
  realLatencyClampMs?: [number, number];
  /** A4 (engine-review-e3 finding 4): when implemented, the controller's own precisely-measured
   * REAL latency for the call `answer()` just completed — excluding any in-flight render/sense time
   * from a straddling concurrent acquisition that happened to still be running when episode.ts
   * noticed the promise had settled, and excluding any post-return journalling/bookkeeping overhead
   * the controller itself performs after the underlying call actually returned (the real jev
   * controller's own ledger records this exact figure — see `controllers/jev.ts`). episode.ts
   * prefers this over its own `Date.now()`-based wall-clock measurement whenever it is present and
   * non-null; every other controller (none of which have journalling/render overhead of their own)
   * is unaffected and falls back to the timestamp-inside-`.then()` measurement. Returns `null`
   * before any call has completed, or if the last call errored before a latency could be recorded. */
  lastRealLatencyMs?(): number | null;
  close?(): void;
}

export function uniformAnswer(criteria: Record<string, string>, choice: string): DecisionResponse['answers'][string] {
  const keys = Object.keys(criteria);
  if (!keys.includes(choice)) throw new Error(`"${choice}" is not an offered option`);
  const probabilities = Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0]));
  return { type: 'choice', choice, confidence: 1, probabilities };
}

function estimateTokens(request: DecisionRequest): number {
  return Math.max(32, Math.round(Buffer.byteLength(JSON.stringify(request)) / 3.5));
}

export function syntheticResponse(request: DecisionRequest, chooser: (id: string, criteria: Record<string, string>) => string, synthetic = true): DecisionResponse {
  const answers: DecisionResponse['answers'] = {};
  for (const [id, question] of Object.entries(request.questions)) answers[id] = uniformAnswer(question.criteria, chooser(id, question.criteria));
  return { model: request.model, answers, usage: { input_tokens: estimateTokens(request) }, ...(synthetic ? { synthetic: true } : {}) };
}
