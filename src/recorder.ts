import type { Diagnostic, Recorder } from './contracts.ts';

/** Inspector-only ring buffer; never part of a robot observation. */
export class Journal {
  #id = 0;
  #events: Diagnostic[] = [];
  readonly capacity: number;
  constructor(capacity = 2000) { this.capacity = capacity; }
  record: Recorder = event => {
    let data: unknown;
    let truncated = false;
    try {
      const encoded = JSON.stringify(event.data);
      truncated = encoded.length > 12000;
      data = truncated ? { preview: encoded.slice(0, 12000), originalBytes: Buffer.byteLength(encoded) } : JSON.parse(encoded);
    } catch { data = { error: 'Unserializable diagnostic' }; }
    this.#events.push({ ...event, data, truncated, id: ++this.#id, wallMs: Date.now() });
    if (this.#events.length > this.capacity) this.#events.shift();
  };
  after(id = 0): Diagnostic[] { return structuredClone(this.#events.filter(event => event.id > id)); }
  get cursor(): number { return this.#id; }
}
