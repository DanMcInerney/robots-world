import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { connectCodex, isObject, type NativeClient } from '../controllers/app-server.ts';
import { verifyCodexModel } from '../controllers/codex.ts';
import { actionSchema, decodeFlight, flightMenu, FLIGHT_CONTRACT, validateAction, type FlightAction, type FlightEncoding, type FlightState } from './flight-contract.ts';
import type { FlightEmit } from './flight-world.ts';

const responseSchema = { type: 'object', additionalProperties: false, required: ['actions'], properties: { actions: { type: 'array', minItems: 1, maxItems: 4, items: actionSchema } } };
function parse(value: unknown) {
  const result = value as { actions?: unknown[] };
  if (!result || !Array.isArray(result.actions) || result.actions.length < 1 || result.actions.length > 4) throw new Error('Invalid native flight result');
  return result.actions.map(validateAction);
}
export interface FlightDecision { action: FlightAction; latencyMs: number; model: string; usedProposal?: boolean; usage?: unknown; costUsd?: number }
export interface NativeFlightResult { actions: FlightAction[]; latencyMs: number; model: string; costUsd?: number }
export interface NativeFlightSession { ask(state: FlightState, role: 'act' | 'propose', signal: AbortSignal): Promise<NativeFlightResult>; close(): Promise<void> }
const input = (state: FlightState, role: 'act' | 'propose') => ({ contract: FLIGHT_CONTRACT, role,
  instruction: role === 'act' ? 'Return exactly one complete action with freely chosen numeric arguments. Use the latest observation. Select movement AND heading AND camera pitch; no prose or tools.'
    : 'Propose 2 to 4 different useful complete maneuvers with numeric arguments, for a fast controller to select using later observations. You never actuate. Your proposals expire 12 seconds after THIS observation, not 12 seconds after your answer. Consider moving-target motion, camera pointing, obstacles and the original goal. Include alternative maneuvers, not four copies. Return JSON only; no tools.', state });

export async function askFlightJev(state: FlightState, encoding: FlightEncoding, key: string, emit: FlightEmit, signal: AbortSignal, proposals: FlightAction[] = []): Promise<FlightDecision> {
  const menu = flightMenu(state, encoding, proposals), id = randomUUID(), start = performance.now();
  emit('jev.request', { id, request: menu.request });
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(menu.request), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty Jev response');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) { await reader.cancel(); throw new Error('Oversize Jev response'); } chunks.push(next.value); }
  const raw = Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]');
  if (!response.ok) { emit('jev.http-error', { id, status: response.status, raw }); throw new Error(`Jev HTTP ${response.status}`); }
  const body = JSON.parse(raw) as { model: string; usage?: unknown };
  emit('jev.response', { id, latencyMs: performance.now() - start, body });
  const result = decodeFlight(body, menu, encoding);
  if (result.rounding.length) emit('jev.probability-rounding', { id, valuesPreserved: true, deviations: result.rounding });
  return { action: result.action, usedProposal: result.usedProposal, latencyMs: performance.now() - start, model: body.model, usage: body.usage };
}

/** Native harness with explicit structured actuation output. No repo, filesystem or private evaluator tools. */
export class ClaudeFlightSession implements NativeFlightSession {
  private stream!: Query;
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private pump!: Promise<void>;
  private pending?: { id: string; resolve(value: { actions: FlightAction[]; costUsd: number }): void; reject(error: Error): void };
  private models = new Set<string>();
  private emit: FlightEmit;
  private constructor(emit: FlightEmit) { this.emit = emit; }
  static async create(cwd: string, emit: FlightEmit) {
    await mkdir(cwd, { recursive: true }); const session = new ClaudeFlightSession(emit);
    async function* messages(): AsyncGenerator<SDKUserMessage> {
      while (!session.closed) { if (session.queue.length) yield session.queue.shift()!; else await new Promise<void>(r => { session.wake = r; }); }
    }
    session.stream = query({ prompt: messages(), options: { cwd, model: 'claude-opus-5', effort: 'low', tools: [], settingSources: [], permissionMode: 'default',
      pathToClaudeCodeExecutable: process.env.ROBOTS_CLAUDE_EXECUTABLE, env: { ...process.env, JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined },
      systemPrompt: `You control a simulated drone through the supplied action schema. ${FLIGHT_CONTRACT}`, outputFormat: { type: 'json_schema', schema: responseSchema }, maxTurns: 6, maxBudgetUsd: 8 } });
    const available = await session.stream.supportedModels();
    if (!available.some(m => (m.value === 'claude-opus-5' || m.resolvedModel?.replace('[1m]', '') === 'claude-opus-5') && m.supportedEffortLevels?.includes('low'))) { session.stream.close(); session.closed = true; session.wake?.(); throw new Error('Claude Opus 5 low unavailable'); }
    emit('native.session', { harness: 'claude', model: 'claude-opus-5', effort: 'low', persistent: true, tools: [] });
    session.pump = session.read(); void session.pump.catch(error => { session.pending?.reject(error); }); return session;
  }
  private async read() {
    for await (const event of this.stream) {
      if (event.type === 'assistant') {
        this.models.add(event.message.model);
        this.emit('claude.assistant', { model: event.message.model, usage: event.message.usage, content: event.message.content.filter(b => b.type === 'text' || b.type === 'tool_use') });
      }
      if (event.type === 'system' && event.subtype === 'model_refusal_fallback') throw new Error('Claude rerouted');
      if (event.type !== 'result') continue;
      this.emit('claude.result', { subtype: event.subtype, durationMs: event.duration_ms, durationApiMs: event.duration_api_ms, modelUsage: event.modelUsage, costUsd: event.total_cost_usd, output: event.subtype === 'success' ? event.structured_output : undefined });
      const pending = this.pending; if (!pending) continue; this.pending = undefined;
      try {
        if (event.is_error || event.subtype !== 'success' || event.permission_denials.length || event.user_message_uuid && event.user_message_uuid !== pending.id) throw new Error('Claude result failed');
        if (!this.models.size || [...this.models].some(m => !m.startsWith('claude-opus-5'))) throw new Error('Unexpected Claude model');
        pending.resolve({ actions: parse(event.structured_output), costUsd: event.total_cost_usd });
      } catch (e) { pending.reject(e as Error); }
    }
    if (!this.closed) this.pending?.reject(new Error('Claude stream ended'));
  }
  async ask(state: FlightState, role: 'act' | 'propose', signal: AbortSignal) {
    if (this.closed || this.pending) throw new Error('Native session closed or busy'); signal.throwIfAborted();
    const id = randomUUID(), start = performance.now(), prompt = input(state, role); this.models.clear();
    this.emit('claude.request', { id, prompt });
    const result = new Promise<{ actions: FlightAction[]; costUsd: number }>((resolve, reject) => { this.pending = { id, resolve, reject }; });
    const abort = () => { if (this.pending?.id === id) { this.pending.reject(new Error('Claude aborted')); this.pending = undefined; } void this.stream.interrupt().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.queue.push({ type: 'user', uuid: id, parent_tool_use_id: null, message: { role: 'user', content: JSON.stringify(prompt) } }); this.wake?.(); this.wake = undefined;
    try { const answer = await result; signal.throwIfAborted(); if (role === 'act' && answer.actions.length !== 1) throw new Error('Expected one action'); return { ...answer, model: 'claude-opus-5', latencyMs: performance.now() - start }; }
    finally { signal.removeEventListener('abort', abort); }
  }
  async close() { if (this.closed) return; this.closed = true; this.pending?.reject(new Error('Closed')); this.pending = undefined; this.wake?.(); this.stream.close(); await this.pump.catch(() => {}); }
}

export class CodexFlightSession implements NativeFlightSession {
  private client: NativeClient;
  private threadId: string;
  private emit: FlightEmit;
  private closed = false;
  private busy = false;
  private constructor(client: NativeClient, threadId: string, emit: FlightEmit) { this.client = client; this.threadId = threadId; this.emit = emit; }
  static async create(cwd: string, emit: FlightEmit) {
    const executable = process.env.ROBOTS_CODEX_EXECUTABLE; if (!executable) throw new Error('Set ROBOTS_CODEX_EXECUTABLE for Codex experiment');
    await mkdir(cwd, { recursive: true }); const client = await connectCodex(executable, cwd);
    try {
      await verifyCodexModel(client, 'gpt-5.6-luna', 'xhigh');
      const thread = await client.request('thread/start', { cwd, model: 'gpt-5.6-luna', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        config: { 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'features.multi_agent': false, web_search: 'disabled' },
        baseInstructions: 'You are a robotics controller. Answer solely from supplied observations. No tools, shell, browsing, filesystem access or external communication. Return the required JSON.', developerInstructions: FLIGHT_CONTRACT });
      if (!isObject(thread) || !isObject(thread.thread) || typeof thread.thread.id !== 'string' || thread.model !== 'gpt-5.6-luna') throw new Error('Invalid Codex model/thread');
      emit('native.session', { harness: 'codex', model: thread.model, effort: 'xhigh', persistent: true, threadId: thread.thread.id });
      return new CodexFlightSession(client, thread.thread.id, emit);
    } catch (e) { await client.close(); throw e; }
  }
  async ask(state: FlightState, role: 'act' | 'propose', signal: AbortSignal) {
    if (this.closed || this.busy) throw new Error('Codex closed or busy'); signal.throwIfAborted(); this.busy = true;
    const started = performance.now(), prompt = input(state, role); let turnId: string | undefined; let text = '';
    let resolve!: () => void, reject!: (e: Error) => void;
    const done = new Promise<void>((a, b) => { resolve = a; reject = b; }); void done.catch(() => {});
    const unsubscribe = this.client.subscribe(event => {
      if (event.method === 'transport/closed') { reject(new Error('Codex transport ended')); return; }
      if (event.params.threadId !== this.threadId) return;
      if (event.method === 'model/rerouted') reject(new Error('Codex model rerouted'));
      if (event.method === 'item/completed' && isObject(event.params.item)) {
        const item = event.params.item;
        if (item.type === 'agentMessage') { text = String(item.text); this.emit('codex.message', { text }); }
        else if (item.type !== 'reasoning' && item.type !== 'userMessage') reject(new Error(`Unexpected native tool ${String(item.type)}`));
      }
      if (event.method === 'thread/tokenUsage/updated') this.emit('codex.usage', event.params);
      if (event.method === 'turn/completed' && isObject(event.params.turn)) {
        if (turnId && turnId !== event.params.turn.id) { reject(new Error('Turn identity mismatch')); return; }
        this.emit('codex.result', event.params); if (event.params.turn.status === 'completed') resolve(); else reject(new Error(`Codex ${String(event.params.turn.status)}`));
      }
    });
    const abort = () => { reject(new Error('Codex aborted')); if (turnId) void this.client.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      this.emit('codex.request', { prompt });
      const result = await this.client.request('turn/start', { threadId: this.threadId, model: 'gpt-5.6-luna', effort: 'xhigh', summary: 'none', outputSchema: responseSchema, input: [{ type: 'text', text: JSON.stringify(prompt) }] });
      if (!isObject(result) || !isObject(result.turn) || typeof result.turn.id !== 'string') throw new Error('Missing Codex turn'); turnId = result.turn.id;
      if (signal.aborted) abort(); await done; signal.throwIfAborted();
      const actions = parse(JSON.parse(text)); if (role === 'act' && actions.length !== 1) throw new Error('Expected one action');
      return { actions, latencyMs: performance.now() - started, model: 'gpt-5.6-luna' };
    } finally { signal.removeEventListener('abort', abort); unsubscribe(); this.busy = false; }
  }
  async close() { if (this.closed) return; this.closed = true; await this.client.close(); }
}
