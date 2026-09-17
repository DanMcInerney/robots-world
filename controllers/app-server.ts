import { spawn } from 'node:child_process';

export interface NativeEvent { method: string; params: Record<string, unknown> }
export interface NativeClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: NativeEvent) => void): () => void;
  close(): Promise<void>;
}
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Owns an opt-in native process; never opens a model session until explicitly run. */
export async function connectCodex(command: string, cwd: string): Promise<NativeClient> {
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const listeners = new Set<(event: NativeEvent) => void>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let next = 0, ended = false, buffer = Buffer.alloc(0);
  const send = (data: unknown) => { const line = JSON.stringify(data) + '\n'; if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Native request too large.'); child.stdin.write(line); };
  const end = (error: Error) => {
    if (ended) return; ended = true;
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); } pending.clear();
    for (const listener of listeners) listener({ method: 'transport/closed', params: { error: error.message } });
    child.kill();
  };
  child.once('error', end); child.once('exit', () => end(new Error('Native process exited.'))); child.stdin.on('error', end); child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8 * 1024 * 1024) { end(new Error('Native framing capacity exceeded.')); return; }
    let index: number;
    while ((index = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, index).toString(); buffer = buffer.subarray(index + 1);
      try {
        const message: unknown = JSON.parse(line); if (!isObject(message)) throw new Error('Invalid native frame.');
        if (typeof message.method === 'string') {
          // An unattended test never grants new host permissions or approves arbitrary requests.
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Interactive native requests are unavailable in this bounded test.' } });
          else if (isObject(message.params)) for (const listener of listeners) listener({ method: message.method, params: message.params });
        } else if (typeof message.id === 'number') {
          const wait = pending.get(message.id); if (!wait) continue;
          clearTimeout(wait.timer); pending.delete(message.id);
          if (message.error) wait.reject(new Error(JSON.stringify(message.error))); else wait.resolve(message.result);
        }
      } catch (error) { end(new Error(`Native framing error: ${String(error)}`)); }
    }
  });
  const client: NativeClient = {
    request(method, params) { return new Promise((resolve, reject) => {
      if (ended || pending.size >= 32) { reject(new Error('Native connection closed or full.')); return; }
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native ${method} timeout; outcome unknown.`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    }); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { end(new Error('Native controller closed.')); },
  };
  try { await client.request('initialize', { clientInfo: { name: 'robots_world', version: '0.1.0' } }); send({ method: 'initialized', params: {} }); return client; }
  catch (error) { await client.close(); throw error; }
}
