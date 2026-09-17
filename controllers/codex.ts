import type { RobotPort } from '../src/contracts.ts';
import { connectCodex, isObject, type NativeClient, type NativeEvent } from './app-server.ts';
import { createRobotTools, type ControllerLog } from './tools.ts';
import { serveRobotMcp } from './mcp.ts';

export const codexPreset = { model: 'gpt-5.6-luna', effort: 'xhigh' } as const;
export interface CodexOptions {
  goal: string; cwd: string; command?: string; model?: string; effort?: string;
  maxWallMs?: number; maxCalls?: number; log?: ControllerLog;
  /** Borrowed client for embedding and protocol fixtures; no hidden model substitutions. */
  client?: NativeClient;
}
export async function verifyCodexModel(client: NativeClient, model: string, effort: string): Promise<void> {
  let cursor: string | undefined; const seen = new Set<string>();
  for (let page = 0; page < 32; page++) {
    const result = await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!isObject(result) || !Array.isArray(result.data)) throw new Error('Invalid model capability response.');
    if (result.data.some(item => isObject(item) && item.model === model && Array.isArray(item.supportedReasoningEfforts) && item.supportedReasoningEfforts.some(option => isObject(option) && option.reasoningEffort === effort))) return;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor) break;
    if (seen.has(result.nextCursor)) throw new Error('Repeated model-list cursor.');
    cursor = result.nextCursor; seen.add(cursor);
  }
  throw new Error(`Requested ${model} / ${effort} is unavailable; no fallback.`);
}
const bound = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** One native agent turn with any number of scoped robot tools, bounded by time and tool count. */
export async function runCodex(ports: readonly RobotPort[], options: CodexOptions, signal?: AbortSignal): Promise<void> {
  const lifetime = new AbortController();
  const externalAbort = () => lifetime.abort(signal?.reason ?? new Error('Controller stopped.'));
  signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
  const timer = setTimeout(() => lifetime.abort(new Error('Native controller wall deadline.')), options.maxWallMs ?? 120000);
  const tools = createRobotTools(ports, { signal: lifetime.signal, maxCalls: options.maxCalls, log: options.log });
  let client: NativeClient | undefined, endpoint: Awaited<ReturnType<typeof serveRobotMcp>> | undefined, unsubscribe: (() => void) | undefined;
  let threadId: string | undefined, turnId: string | undefined, terminal = false, starting: Promise<unknown> | undefined;
  const early = new Map<string, NativeEvent>();
  let resolveTurn!: () => void, rejectTurn!: (error: unknown) => void;
  const turn = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  void turn.catch(() => {});
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    // Revoke robot I/O before joining a slow native start/interrupt.
    let stopError: unknown;
    try { await tools.stopAll(); } catch (error) { stopError = error; }
    try {
      await bound(starting ?? Promise.resolve(), 3000, 'Native turn-start outcome unknown during stop.');
      if (client && threadId && turnId && !terminal) {
        await bound(client.request('turn/interrupt', { threadId, turnId }), 3000, 'Native interrupt request not confirmed.');
        await bound(turn, 3000, 'Native interrupt terminal event was not confirmed.');
      }
    } finally { if (stopError) throw stopError; }
  })();
  const abort = () => { void stop().catch(error => options.log?.('stop_error', { error: String(error) })); };
  lifetime.signal.addEventListener('abort', abort, { once: true });
  try {
    lifetime.signal.throwIfAborted();
    if (!options.client && !options.command) throw new Error('Set ROBOTS_CODEX_EXECUTABLE for an opt-in native Codex run.');
    client = options.client ?? await connectCodex(options.command!, options.cwd);
    const model = options.model ?? codexPreset.model, effort = options.effort ?? codexPreset.effort;
    await bound(verifyCodexModel(client, model, effort), 10000, 'Native model discovery deadline.'); lifetime.signal.throwIfAborted();
    endpoint = await serveRobotMcp(tools);
    const handle = (event: NativeEvent) => {
      if (event.method === 'transport/closed') { rejectTurn(new Error('Native transport closed; no replay.')); return; }
      if (event.params.threadId !== threadId) return;
      if (event.method === 'item/reasoning/textDelta') return; // Render supplied summaries, not unsupported claims about hidden reasoning.
      options.log?.('native_event', event);
      if (event.method === 'model/rerouted') { lifetime.abort(new Error('Native model rerouted.')); rejectTurn(new Error('Native model rerouted; no fallback.')); }
      if (event.method !== 'turn/completed' || !isObject(event.params.turn) || typeof event.params.turn.id !== 'string') return;
      if (!turnId) { if (early.size >= 16) rejectTurn(new Error('Too many unmatched terminal events.')); else early.set(event.params.turn.id, event); return; }
      if (event.params.turn.id !== turnId) return;
      terminal = true;
      if (['completed', 'interrupted'].includes(String(event.params.turn.status))) resolveTurn();
      else rejectTurn(new Error(`Native turn failed: ${JSON.stringify(event.params.turn.error ?? event.params.turn.status)}`));
    };
    unsubscribe = client.subscribe(handle);
    const thread = await bound(client.request('thread/start', { model, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      config: { mcp_servers: { robots: { url: endpoint.url, http_headers: { Authorization: `Bearer ${endpoint.token}` }, required: true } } },
      developerInstructions: 'Control only the robots exposed by the robots MCP tools. Describe each robot, then observe before acting. Commands may remain running: check jobs for completion. Never infer sensor readings from spectator or filesystem data. Radio send acceptance is not delivery. Stop robots after the task. Do not issue shell commands to bypass robot ports.' }), 10000, 'Native thread-start outcome unknown.');
    if (!isObject(thread) || !isObject(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Missing native thread identity.');
    if (typeof thread.model === 'string' && thread.model !== model) throw new Error('Native model substitution.');
    threadId = thread.thread.id; lifetime.signal.throwIfAborted();
    options.log?.('native_started', { driver: 'codex', threadId, model, effort, robots: ports.map(port => port.robotId) });
    starting = client.request('turn/start', { threadId, model, effort, input: [{ type: 'text', text: options.goal }] }).then(response => {
      if (!isObject(response) || !isObject(response.turn) || typeof response.turn.id !== 'string') throw new Error('Missing native turn identity.');
      turnId = response.turn.id; const event = early.get(turnId); early.clear(); if (event) handle(event);
    });
    await bound(starting, 10000, 'Native turn-start outcome unknown.');
    if (lifetime.signal.aborted) await stop();
    await Promise.race([turn, new Promise<never>((_, reject) => {
      if (lifetime.signal.aborted) reject(lifetime.signal.reason);
      else lifetime.signal.addEventListener('abort', () => reject(lifetime.signal.reason), { once: true });
    })]);
    lifetime.signal.throwIfAborted();
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); lifetime.signal.removeEventListener('abort', abort);
    try { await stop(); } finally { unsubscribe?.(); await endpoint?.close(); if (!options.client) await client?.close(); }
  }
}
