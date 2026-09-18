import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RobotPort } from '../src/contracts.ts';
import { createNerveletBridge } from './nervelet.ts';
import { verifyCodexModel, codexPreset } from '../controllers/codex.ts';
import type { ControllerLog } from '../controllers/tools.ts';

/** Optional integration: delegate all native lifecycle and continuation to the selected Nervelet installation. */
export async function runNervelet(ports: readonly RobotPort[], options: {
  module: string; command: string; cwd: string; goal: string; maxWallMs?: number; commandValidForMs?: number; maxCalls?: number; log?: ControllerLog;
}, signal?: AbortSignal): Promise<void> {
  const specifier = options.module.startsWith('file:') ? options.module : pathToFileURL(resolve(options.module)).href;
  const library = await import(specifier);
  const driverLibrary = await import(new URL('./drivers/codex.js', specifier).href);
  if (typeof library.Bridge !== 'function' || typeof library.Supervisor !== 'function' || typeof driverLibrary.CodexDriver !== 'function') throw new Error('Select a built Nervelet 0.2 module with native drivers.');
  const control = new AbortController();
  const stopPorts = async () => { await Promise.allSettled(ports.map(port => port.stop())); control.abort(signal?.reason ?? new Error('Nervelet controller stopped.')); };
  const abort = () => { void stopPorts(); };
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) await stopPorts();
  const timer = setTimeout(abort, options.maxWallMs ?? 120000);
  try {
    const results = await Promise.allSettled(ports.map(async port => {
      let bridge: any, client: any, unsubscribe: (() => void) | undefined;
      try {
        control.signal.throwIfAborted();
        bridge = await createNerveletBridge(port, library, options.goal, { commandValidForMs: options.commandValidForMs });
        client = await driverLibrary.connectAppServer({ command: options.command, cwd: options.cwd });
        await verifyCodexModel(client, codexPreset.model, codexPreset.effort);
        unsubscribe = client.subscribe((event: { method: string }) => { if (event.method !== 'item/reasoning/textDelta') options.log?.('nervelet_native_event', { robotId: port.robotId, event }); });
        const configured = { request(method: string, params: Record<string, unknown>, nativeSignal?: AbortSignal) {
          return client.request(method, method === 'turn/start' ? { ...params, effort: codexPreset.effort } : params, nativeSignal);
        }, subscribe: client.subscribe.bind(client), close: client.close?.bind(client) };
        const driver = new driverLibrary.CodexDriver({ client: configured, clientOwnership: 'borrowed', model: codexPreset.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only' });
        const supervisor = new library.Supervisor(bridge, driver, { bridgeOwnership: 'borrowed', maxTurns: 8, maxStepsPerTurn: options.maxCalls ?? 128, maxActiveMs: options.maxWallMs ?? 120000, turnMs: options.maxWallMs ?? 120000 });
        await supervisor.run(control.signal);
      } catch (error) { await stopPorts(); throw error; }
      finally {
        unsubscribe?.();
        try { await bridge?.close(); }
        finally { try { await port.stop(); } finally { await client?.close?.(); } }
      }
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'Nervelet controller failed.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await stopPorts(); }
}
