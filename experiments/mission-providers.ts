import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DECISION_INSTRUCTION, decisionState, decodeJev, jevRequest, missionActions, type MenuFormat, type MissionState } from './mission-contract.ts';

export type Emit = (kind: string, data: unknown) => void;
export interface DecisionResult { actionId: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number; costUsd?: number; confidence?: number }

/** No retries: a timeout remains visible and does not create an unbounded request queue. */
export async function askJev(state: MissionState, format: MenuFormat, key: string, emit: Emit, signal: AbortSignal): Promise<DecisionResult> {
  const id = randomUUID(), started = performance.now();
  const request = jevRequest(state, format);
  emit('jev.request', { id, request });
  let raw = '', status: number | undefined;
  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) });
    status = response.status;
    // Read a bounded stream, including malformed responses, without retaining credentials or headers.
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    if (!reader) throw new Error('response:no-body');
    for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 65536) { await reader.cancel(); throw new Error('response:over-64KiB'); } chunks.push(item.value); }
    raw = Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]');
    if (!response.ok) throw new Error(`http:${status}`);
    const body = JSON.parse(raw) as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    emit('jev.response', { id, status, latencyMs: performance.now() - started, body });
    const decoded = decodeJev(body, state, format);
    if (decoded.probabilityRounding.length) emit('jev.probability-rounding', { id, sums: decoded.probabilityRounding, valuesPreserved: true });
    if (body.model !== 'jev-1.13.0') throw new Error('model:unexpected');
    return { ...decoded, model: body.model, latencyMs: performance.now() - started, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(key).join('[redacted]') : 'unknown';
    emit('jev.rejected', { id, status, latencyMs: performance.now() - started, reason, rawBody: raw });
    throw new Error(reason);
  }
}

/** A persistent native Claude Code conversation with a bounded, matching action-selection contract.
 * No filesystem tools, repository instructions or scenario evaluator are exposed to the session.
 * This measures a native harness used as a selector, not unrestricted code-authoring capability.
 */
export class ClaudeMissionSession {
  private query!: Query;
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private pump!: Promise<void>;
  private pending?: { id: string; resolve: (value: NativeResult) => void; reject: (error: Error) => void };
  private readonly emit: Emit;
  private readonly model: string;
  private responseModels = new Set<string>();
  private constructor(emit: Emit, model: string) { this.emit = emit; this.model = model; }
  static async create(cwd: string, emit: Emit, model = 'claude-opus-5', effort: 'low' | 'high' = 'high'): Promise<ClaudeMissionSession> {
    await mkdir(cwd, { recursive: true });
    const session = new ClaudeMissionSession(emit, model);
    async function* inputs(): AsyncGenerator<SDKUserMessage> {
      while (!session.closed) {
        if (session.items.length) yield session.items.shift()!;
        else await new Promise<void>(resolve => { session.wake = resolve; });
      }
    }
    session.query = query({ prompt: inputs(), options: {
      cwd, model, effort, tools: [], settingSources: [], permissionMode: 'default',
      pathToClaudeCodeExecutable: process.env.ROBOTS_CLAUDE_EXECUTABLE,
      env: { ...process.env, TYPESAFE_API_KEY: undefined, JEV_API_KEY: undefined },
      systemPrompt: 'You control a simulated drone from dated observations and a complete menu of executable actions. You have no other source of world state. Follow the exact original English mission. ' + DECISION_INSTRUCTION,
      outputFormat: { type: 'json_schema', schema: { type: 'object', additionalProperties: false,
        properties: { actionId: { type: 'string' }, guidance: { type: 'string' } }, required: ['actionId', 'guidance'] } },
      maxTurns: 6, maxBudgetUsd: 8,
    } });
    const available = await session.query.supportedModels();
    if (!available.some(m => (m.value === model || m.resolvedModel?.replace('[1m]', '') === model) && m.supportedEffortLevels?.includes(effort))) {
      session.query.close(); session.closed = true; session.wake?.(); throw new Error(`Requested Claude model/effort unavailable: ${model}/${effort}`);
    }
    emit('claude.session', { model, effort, tools: [], persistent: true, source: 'native Claude Code Agent SDK' });
    session.pump = session.read();
    void session.pump.catch(error => { session.pending?.reject(error instanceof Error ? error : new Error(String(error))); });
    return session;
  }
  private async read(): Promise<void> {
    for await (const event of this.query) {
      if (event.type === 'assistant') {
        this.responseModels.add(event.message.model);
        this.emit('claude.assistant', { model: event.message.model, usage: event.message.usage,
          // Only supplied final text/tool records; no private reasoning trace is fabricated or stored.
          content: event.message.content.filter(block => block.type === 'text' || block.type === 'tool_use') });
      }
      if (event.type === 'system' && event.subtype === 'model_refusal_fallback') throw new Error('Claude model fallback');
      if (event.type !== 'result') continue;
      this.emit('claude.result', { subtype: event.subtype, isError: event.is_error, durationMs: event.duration_ms,
        durationApiMs: event.duration_api_ms, modelUsage: event.modelUsage, costUsd: event.total_cost_usd,
        structuredOutput: event.subtype === 'success' ? event.structured_output : undefined });
      const pending = this.pending;
      if (!pending) continue;
      this.pending = undefined;
      if (event.user_message_uuid && event.user_message_uuid !== pending.id) { pending.reject(new Error('Claude result input identity mismatch')); continue; }
      if (event.is_error || event.subtype !== 'success' || event.permission_denials.length) { pending.reject(new Error(`Claude result ${event.subtype}`)); continue; }
      const value = event.structured_output as { actionId?: unknown; guidance?: unknown } | undefined;
      if (typeof value?.actionId !== 'string' || typeof value.guidance !== 'string' || value.guidance.length > 4000) { pending.reject(new Error('Claude structured result invalid')); continue; }
      // Native harness usage may include ancillary model calls. Verify the model
      // that produced the assistant decision, and retain all usage separately.
      const models = [...this.responseModels];
      if (!models.length || models.some(model => !model.startsWith(this.model))) { pending.reject(new Error('Claude response model mismatch')); continue; }
      pending.resolve({ actionId: value.actionId, guidance: value.guidance, model: models.join(','), costUsd: event.total_cost_usd });
    }
    if (!this.closed) this.pending?.reject(new Error('Claude stream ended'));
  }
  async ask(state: MissionState, role: 'act' | 'plan', signal: AbortSignal): Promise<NativeResult & { latencyMs: number }> {
    if (this.closed || this.pending) throw new Error('Claude session closed or already busy');
    signal.throwIfAborted();
    const started = performance.now(), id = randomUUID();
    this.responseModels.clear();
    const prompt = { role, instruction: role === 'act'
      ? 'Return the next actionId from the offered menu. Set guidance to an empty string. No prose is needed. Use the freshest provided state; previous states are historical.'
      : 'Provide short mission guidance for a fast controller, resolving the English task into priorities and contingencies using only this observation. Refer to station IDs explicitly where possible. Do not claim current jobs completed without receipts. Guidance must handle later observations and preserve the exact mission. Limit guidance to 1200 characters; set actionId to continue. You advise only; you do not actuate.',
      state: decisionState(state), actions: missionActions(state) };
    this.emit('claude.request', { id, role, prompt });
    const result = new Promise<NativeResult>((resolve, reject) => { this.pending = { id, resolve, reject }; });
    const abort = () => { if (this.pending?.id === id) { this.pending.reject(new Error('Claude request aborted')); this.pending = undefined; } void this.query.interrupt().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.items.push({ type: 'user', uuid: id, message: { role: 'user', content: JSON.stringify(prompt) }, parent_tool_use_id: null }); this.wake?.(); this.wake = undefined;
    try {
      const value = await result;
      signal.throwIfAborted();
      if (role === 'act' && !missionActions(state).some(c => c.id === value.actionId)) throw new Error('Claude action not offered');
      return { ...value, latencyMs: performance.now() - started };
    } finally { signal.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.pending?.reject(new Error('Claude session closed')); this.pending = undefined; this.wake?.();
    this.query.close();
    await this.pump.catch(() => {});
  }
}
interface NativeResult { actionId: string; guidance: string; model: string; costUsd: number }
