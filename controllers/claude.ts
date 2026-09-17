import { randomUUID } from 'node:crypto';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RobotPort } from '../src/contracts.ts';
import { createRobotTools, type ControllerLog } from './tools.ts';
import { createRobotMcp } from './mcp.ts';

export interface ClaudeOptions {
  goal: string; cwd: string; model: string; maxWallMs?: number; maxCalls?: number; maxTurns?: number; maxBudgetUsd?: number;
  command?: string; log?: ControllerLog;
  query?: typeof import('@anthropic-ai/claude-agent-sdk')['query'];
}
/** Native Claude Code session, independent of Nervelet and simulator internals. */
export async function runClaude(ports: readonly RobotPort[], options: ClaudeOptions, signal?: AbortSignal): Promise<void> {
  if (!options.model) throw new Error('An explicit Claude model is required.');
  const lifetime = new AbortController();
  const externalAbort = () => lifetime.abort(signal?.reason ?? new Error('Controller stopped.'));
  signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
  const timer = setTimeout(() => lifetime.abort(new Error('Native controller wall deadline.')), options.maxWallMs ?? 120000);
  const tools = createRobotTools(ports, { signal: lifetime.signal, maxCalls: options.maxCalls, log: options.log });
  const server = createRobotMcp(tools);
  let query: Query | undefined, inputDone!: () => void, terminal = false, active = false, sessionId: string | undefined;
  const inputId = randomUUID();
  const inputEnd = new Promise<void>(resolve => { inputDone = resolve; });
  let resolveTurn!: () => void, rejectTurn!: (error: unknown) => void;
  const turn = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; }); void turn.catch(() => {});
  let pump: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    let stopError: unknown; try { await tools.stopAll(); } catch (error) { stopError = error; }
    try {
      if (query && active && !terminal) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([query.interrupt().then(() => turn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude interrupt terminal event unconfirmed.')), 3000); })]); }
        finally { clearTimeout(timer); }
      }
    } finally { if (stopError) throw stopError; }
  })();
  const abort = () => { void stop().catch(error => options.log?.('stop_error', { error: String(error) })); };
  lifetime.signal.addEventListener('abort', abort, { once: true });
  try {
    lifetime.signal.throwIfAborted();
    const execute = options.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
    async function* inputs(): AsyncGenerator<SDKUserMessage> {
      active = true;
      yield { type: 'user', uuid: inputId, message: { role: 'user', content: options.goal }, parent_tool_use_id: null };
      await inputEnd;
    }
    query = execute({ prompt: inputs(), options: {
      model: options.model, cwd: options.cwd, permissionMode: 'default', settingSources: [], tools: [],
      allowedTools: tools.list().map(tool => `mcp__robots__${tool.name}`),
      mcpServers: { robots: { type: 'sdk', name: 'robots', instance: server } },
      maxTurns: options.maxTurns ?? 32, maxBudgetUsd: options.maxBudgetUsd, pathToClaudeCodeExecutable: options.command,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Control only supplied robots using robots MCP tools. Describe first; observe sensor evidence before issuing commands. Accepted commands require observing job completion. Stop robots when done. The world continues while you reason. Radio sends may be lost or delayed.' },
    } });
    pump = (async () => {
      for await (const event of query!) {
        if ('session_id' in event) {
          if (sessionId && event.session_id !== sessionId) throw new Error('Claude session identity changed.');
          sessionId = event.session_id;
        }
        // Preserve native tool/message data. The dashboard labels these SDK events, not inferred internal reasoning.
        options.log?.('native_event', event);
        if (event.type === 'system' && event.subtype === 'model_refusal_fallback') throw new Error('Claude model fallback is not authorized.');
        if (event.type !== 'result') continue;
        if (event.user_message_uuid && event.user_message_uuid !== inputId) continue;
        if (lifetime.signal.aborted && event.user_message_uuid !== inputId) throw new Error('Claude cancellation lacks matching input identity.');
        terminal = true;
        const interrupted = lifetime.signal.aborted && ['aborted_streaming', 'aborted_tools'].includes(event.terminal_reason ?? '');
        if (event.permission_denials.length || (!interrupted && (event.is_error || event.subtype !== 'success'))) throw new Error(`Claude turn failed: ${event.subtype}.`);
        resolveTurn(); return;
      }
      if (!terminal) throw new Error('Claude stream ended without a terminal result.');
    })();
    void pump.catch(rejectTurn);
    options.log?.('native_started', { driver: 'claude', model: options.model, inputId, robots: ports.map(port => port.robotId) });
    await Promise.race([turn, new Promise<never>((_, reject) => {
      if (lifetime.signal.aborted) reject(lifetime.signal.reason);
      else lifetime.signal.addEventListener('abort', () => reject(lifetime.signal.reason), { once: true });
    })]);
    lifetime.signal.throwIfAborted();
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); lifetime.signal.removeEventListener('abort', abort);
    try { await stop(); } finally { inputDone(); query?.close(); await server.close(); void pump?.catch(() => {}); }
  }
}
