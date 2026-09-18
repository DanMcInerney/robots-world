import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { connectCodex, isObject, type NativeClient } from '../../controllers/app-server.ts';
import { verifyCodexModel } from '../../controllers/codex.ts';
import { CHOICE_SCHEMA, CONTRACT, selected, type Menu } from './contract.ts';
import type { Emit } from './world.ts';

export type Answer = { value: unknown; latencyMs: number; model: string; usage?: unknown; cumulativeCostUsd?: number };
export const decisionInput = (menu: Menu, brief?: string) => ({ contract: CONTRACT, instructions: 'Select the offered maneuver that best advances the current English goal from the current measurements. Return its exact choice ID. If the required viewing position is not yet reached, compare changes toward that position; progress may take several decisions. Camera centering alone does not satisfy a goal about viewing position. The estimates describe possible effects; they do not rank actions. Choose anew as circumstances change.',
  ...(brief ? { modelAuthoredAdvice: brief, adviceAuthority: 'Advice may be wrong or stale; the exact current goal and current observations take precedence.' } : {}), state: menu.state, candidates: menu.criteria });

export async function jev(menu: Menu, key: string, emit: Emit, signal: AbortSignal, brief?: string): Promise<Answer> {
  const input = decisionInput(menu, brief), id = randomUUID(), started = performance.now();
  const groups = [0, 1, 2, 3].map(i => menu.candidates.filter(c => c.id.endsWith(`c${i}`)));
  const questions: Record<string, unknown> = { camera: { type: 'choice', instructions: `${input.contract} Choose the camera configuration for the next maneuver using the current goal and observed framing. Movement questions independently recommend one maneuver assuming each camera configuration; only the branch you select executes. ${brief ? input.adviceAuthority : ''}`, criteria: Object.fromEntries(groups.map((group, i) => [`c${i}`, group[0]!.camera])) } };
  groups.forEach((group, i) => { questions[`maneuver_c${i}`] = { type: 'choice', instructions: `${input.contract} ${input.instructions} Assume the camera configuration is: ${group[0]!.camera}. Choose the best COMPLETE maneuver within this branch. Another independent question selects whether this branch executes. ${brief ? input.adviceAuthority : ''}`, criteria: Object.fromEntries(group.map(c => [c.id, menu.criteria[c.id]])) }; });
  const request = { model: 'jev-1.13.0', state: { ...input.state, ...(brief ? { modelAuthoredAdvice: brief } : {}) }, questions };
  emit('jev.request', { id, source: menu.source, menuHash: menu.hash, request });
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]) });
  const reader = response.body?.getReader(); if (!reader) throw new Error('No response'); let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) { await reader.cancel(); throw new Error('Jev response too large'); } chunks.push(next.value); }
  const raw = Buffer.concat(chunks).toString('utf8').split(key).join('[redacted]'); const latencyMs = performance.now() - started;
  if (!response.ok) { emit('jev.http-error', { id, status: response.status, raw, latencyMs }); throw new Error(`Jev HTTP ${response.status}`); }
  const body = JSON.parse(raw); emit('jev.response', { id, body, latencyMs });
  if (body.model !== 'jev-1.13.0') throw new Error('Jev model changed');
  function validate(name: string, ids: string[]): string {
    const answer = body.answers?.[name], probabilities = answer?.probabilities;
    if (answer?.type !== 'choice' || !ids.includes(answer.choice) || !probabilities || Object.keys(probabilities).length !== ids.length || ids.some(c => !(c in probabilities))) throw new Error(`Invalid Jev choice ${name}`);
    const values = Object.values(probabilities) as number[], sum = values.reduce((a, b) => a + b, 0);
    if (values.some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) || probabilities[answer.choice] < Math.max(...values) - 1e-8) throw new Error(`Invalid Jev probabilities ${name}`);
    const roundingTolerance = Math.min(.06, values.filter(p => p > 0).length * .005 + 1e-6);
    if (Math.abs(sum - 1) > 1e-6) {
      if (!values.every(p => Math.abs(p * 100 - Math.round(p * 100)) < 1e-6) || Math.abs(sum - 1) > roundingTolerance) throw new Error(`Invalid Jev probability sum ${name}`);
      emit('jev.rounding', { id, question: name, sum, preserved: true });
    }
    return answer.choice;
  }
  const camera = validate('camera', ['c0', 'c1', 'c2', 'c3']), choice = validate(`maneuver_${camera}`, groups[Number(camera.slice(1))]!.map(c => c.id));
  const candidate = selected({ choice }, menu);
  return { value: { choice: candidate.id }, latencyMs, model: body.model, usage: body.usage };
}

/** The native harness owns its persistent inference session. This arm exposes only schema output. */
export class CodexJson {
  private client: NativeClient; private threadId: string; private emit: Emit; private busy = false;
  private constructor(client: NativeClient, threadId: string, emit: Emit) { this.client = client; this.threadId = threadId; this.emit = emit; }
  static async create(cwd: string, emit: Emit, role: 'controller' | 'advisor' = 'controller') {
    const exe = process.env.ROBOTS_CODEX_EXECUTABLE; if (!exe) throw new Error('ROBOTS_CODEX_EXECUTABLE required'); await mkdir(cwd, { recursive: true });
    const client = await connectCodex(exe, cwd);
    try {
      await verifyCodexModel(client, 'gpt-5.6-luna', 'xhigh');
      const result = await client.request('thread/start', { cwd, model: 'gpt-5.6-luna', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
        config: { 'features.shell_tool': false, 'features.apply_patch_freeform': false, 'features.multi_agent': false, web_search: 'disabled' },
        baseInstructions: 'Use only supplied observations, goal and allowed options. No tools, files or external information. Return required JSON.',
        developerInstructions: role === 'controller' ? CONTRACT : 'You write reusable natural-language decision guidance for a separate fast controller. You do not select or execute the current drone action. The supplied control contract describes the other controller. Follow the requested guidance-output schema. Advice must refer to the exact current goal supplied at decision time, not hardcode a representative goal or a fixed viewing side.' });
      if (!isObject(result) || !isObject(result.thread) || typeof result.thread.id !== 'string' || result.model !== 'gpt-5.6-luna') throw new Error('Unexpected Codex model/session');
      emit('native.session', { harness: 'codex', model: result.model, effort: 'xhigh', threadId: result.thread.id, role, tools: [] });
      return new CodexJson(client, result.thread.id, emit);
    } catch (e) { await client.close(); throw e; }
  }
  async ask(prompt: unknown, signal: AbortSignal, schema: Record<string, unknown> = CHOICE_SCHEMA): Promise<Answer> {
    if (this.busy) throw new Error('Codex busy'); signal.throwIfAborted(); this.busy = true;
    const start = performance.now(); let turnId: string | undefined, text = '', usage: unknown;
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((a, b) => { resolve = a; reject = b; }); void done.catch(() => {});
    const unsubscribe = this.client.subscribe(event => {
      if (event.method === 'transport/closed') { reject(new Error('Codex transport closed')); return; }
      if (event.params.threadId !== this.threadId) return;
      if (event.method === 'model/rerouted') reject(new Error('Codex model rerouted'));
      if (event.method === 'item/completed' && isObject(event.params.item)) {
        const item = event.params.item;
        if (item.type === 'agentMessage') { text = String(item.text); this.emit('codex.message', { text }); }
        else if (!['reasoning', 'userMessage'].includes(String(item.type))) reject(new Error(`Unexpected tool ${String(item.type)}`));
      }
      if (event.method === 'thread/tokenUsage/updated') { usage = event.params; this.emit('codex.usage', usage); }
      if (event.method === 'turn/completed' && isObject(event.params.turn)) {
        if (turnId && event.params.turn.id !== turnId) { reject(new Error('Wrong Codex turn')); return; }
        this.emit('codex.result', event.params); if (event.params.turn.status === 'completed') resolve(); else reject(new Error(`Codex ${String(event.params.turn.status)}`));
      }
    });
    const abort = () => { reject(new Error('Codex cancelled')); if (turnId) void this.client.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      this.emit('codex.request', { prompt, schema });
      const result = await this.client.request('turn/start', { threadId: this.threadId, model: 'gpt-5.6-luna', effort: 'xhigh', summary: 'none', outputSchema: schema, input: [{ type: 'text', text: JSON.stringify(prompt) }] });
      if (!isObject(result) || !isObject(result.turn) || typeof result.turn.id !== 'string') throw new Error('Missing turn'); turnId = result.turn.id;
      if (signal.aborted) abort(); await done; signal.throwIfAborted();
      return { value: JSON.parse(text), latencyMs: performance.now() - start, model: 'gpt-5.6-luna', usage };
    } finally { unsubscribe(); signal.removeEventListener('abort', abort); this.busy = false; }
  }
  async close() { await this.client.close(); }
}

export class ClaudeJson {
  private stream!: Query; private messages: SDKUserMessage[] = []; private wake?: () => void; private closed = false; private pump!: Promise<void>;
  private pending?: { id: string; resolve(value: Omit<Answer, 'latencyMs'>): void; reject(error: Error): void };
  private models = new Set<string>(); private emit: Emit;
  private constructor(emit: Emit) { this.emit = emit; }
  static async create(cwd: string, emit: Emit) {
    await mkdir(cwd, { recursive: true }); const session = new ClaudeJson(emit);
    async function* input(): AsyncGenerator<SDKUserMessage> { while (!session.closed) { if (session.messages.length) yield session.messages.shift()!; else await new Promise<void>(r => { session.wake = r; }); } }
    session.stream = query({ prompt: input(), options: { cwd, model: 'claude-opus-5', effort: 'low', tools: [], settingSources: [], permissionMode: 'default',
      pathToClaudeCodeExecutable: process.env.ROBOTS_CLAUDE_EXECUTABLE, env: { ...process.env, JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined }, systemPrompt: CONTRACT,
      outputFormat: { type: 'json_schema', schema: CHOICE_SCHEMA }, maxTurns: 4, maxBudgetUsd: 12 } });
    const models = await session.stream.supportedModels();
    if (!models.some(m => (m.value === 'claude-opus-5' || m.resolvedModel?.replace('[1m]', '') === 'claude-opus-5') && m.supportedEffortLevels?.includes('low'))) { session.stream.close(); throw new Error('Claude Opus 5 low unavailable'); }
    emit('native.session', { harness: 'claude', model: 'claude-opus-5', effort: 'low', tools: [] }); session.pump = session.read(); void session.pump.catch(e => session.pending?.reject(e)); return session;
  }
  private async read() {
    for await (const event of this.stream) {
      if (event.type === 'assistant') { this.models.add(event.message.model); this.emit('claude.assistant', { model: event.message.model, usage: event.message.usage, content: event.message.content.filter(b => b.type === 'text' || b.type === 'tool_use') }); }
      if (event.type === 'system' && event.subtype === 'model_refusal_fallback') throw new Error('Claude rerouted');
      if (event.type !== 'result') continue;
      this.emit('claude.result', { subtype: event.subtype, usage: event.usage, modelUsage: event.modelUsage, cumulativeCostUsd: event.total_cost_usd, output: event.subtype === 'success' ? event.structured_output : undefined });
      const pending = this.pending; if (!pending) continue; this.pending = undefined;
      if (event.is_error || event.subtype !== 'success' || event.permission_denials.length || event.user_message_uuid && event.user_message_uuid !== pending.id || !this.models.size || [...this.models].some(m => !m.startsWith('claude-opus-5'))) pending.reject(new Error('Claude result/model failed'));
      else pending.resolve({ value: event.structured_output, model: 'claude-opus-5', usage: event.usage, cumulativeCostUsd: event.total_cost_usd });
    }
    if (!this.closed) this.pending?.reject(new Error('Claude stream ended'));
  }
  async ask(prompt: unknown, signal: AbortSignal): Promise<Answer> {
    if (this.closed || this.pending) throw new Error('Claude busy/closed'); signal.throwIfAborted(); const started = performance.now(), id = randomUUID(); this.models.clear();
    const done = new Promise<Omit<Answer, 'latencyMs'>>((resolve, reject) => { this.pending = { id, resolve, reject }; });
    const abort = () => { if (this.pending?.id === id) { this.pending.reject(new Error('Claude cancelled')); this.pending = undefined; } void this.stream.interrupt().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.emit('claude.request', { id, prompt }); this.messages.push({ type: 'user', uuid: id, parent_tool_use_id: null, message: { role: 'user', content: JSON.stringify(prompt) } }); this.wake?.(); this.wake = undefined;
    try { const result = await done; signal.throwIfAborted(); return { ...result, latencyMs: performance.now() - started }; } finally { signal.removeEventListener('abort', abort); }
  }
  async close() { this.closed = true; this.pending?.reject(new Error('Claude closed')); this.pending = undefined; this.wake?.(); this.stream.close(); await this.pump.catch(() => {}); }
}

export const BRIEF_SCHEMA = { type: 'object', additionalProperties: false, required: ['instructions'], properties: { instructions: { type: 'string', maxLength: 5000 } } };
export function parseBrief(answer: Answer) {
  const text = (answer.value as { instructions?: unknown })?.instructions; if (typeof text !== 'string' || text.length < 20 || text.length > 5000) throw new Error('Invalid model-authored brief'); return text;
}
