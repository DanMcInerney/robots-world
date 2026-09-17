import type { Command, Observation, Receipt, RobotDescription, RobotPort } from './contracts.ts';

/** Controller-side remote port. Mutating requests are never retried automatically. */
export class HttpRobotPort implements RobotPort {
  readonly robotId: string;
  #url: string;
  #token: string;
  constructor(options: { url: string; robotId: string; token: string }) {
    this.robotId = options.robotId; this.#url = options.url.replace(/\/$/, ''); this.#token = options.token;
  }
  async #request<T>(method: string, payload?: unknown): Promise<T> {
    const response = await fetch(`${this.#url}/api/robots/${encodeURIComponent(this.robotId)}/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Robot request failed (${response.status}); effect may be uncertain`);
    return data;
  }
  describe(): Promise<RobotDescription> { return this.#request('describe'); }
  observe(): Promise<Observation> { return this.#request('observe'); }
  command(command: Command): Promise<Receipt> { return this.#request('command', command); }
  async acknowledge(throughEvent: number, packetIds: string[] = []): Promise<void> { await this.#request('acknowledge', { throughEvent, packetIds }); }
  send(packet: { id: string; to: string; data: string; ttlMs?: number }): Promise<{ accepted: boolean; reason?: string }> { return this.#request('send', packet); }
  async stop(): Promise<void> { await this.#request('stop'); }
  async close(): Promise<void> { await this.#request('close'); }
}
