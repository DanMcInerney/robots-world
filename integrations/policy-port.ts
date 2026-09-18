import { createHash, randomUUID } from 'node:crypto';
import type { Command, Job, Json, Observation, Receipt, RobotDescription, RobotPort } from '../src/contracts.ts';

export type LocalPolicy = (port: RobotPort, signal: AbortSignal) => Promise<void>;
export interface PolicyPortOptions {
  maxPolicyMs?: number; operationMs?: number; maxCommands?: number; maxJobs?: number;
  maxEvents?: number; maxQueuedEffects?: number;
  record?: (kind: string, data: unknown) => void;
}
interface ActivePolicy { generation: number; job: Job; controller: AbortController; timer: ReturnType<typeof setTimeout>; deliveredPhysicalEvent: number }
interface RetainedCommand { fingerprint: string; result: Promise<Receipt> }
interface RetainedEvent { event: Observation['events'][number]; physicalId?: number }
const copy = <T>(value: T): T => structuredClone(value);
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A local policy is an environment-owned job, never a second physical-port owner. */
export function createPolicyPort(physicalPort: RobotPort, policies: Record<string, LocalPolicy>, options: PolicyPortOptions = {}): RobotPort {
  return new PolicyPort(physicalPort, policies, options);
}

class PolicyPort implements RobotPort {
  readonly robotId: string;
  readonly #physical: RobotPort;
  readonly #policies: Map<string, LocalPolicy>;
  readonly #options: Required<Omit<PolicyPortOptions, 'record'>> & Pick<PolicyPortOptions, 'record'>;
  readonly #prefix = randomUUID().slice(0, 8);
  #description?: RobotDescription;
  #latest?: Observation;
  #active?: ActivePolicy;
  #generation = 0;
  #boundary = 0;
  #closed = false;
  #fault?: string;
  #stopping?: Promise<void>;
  #effects: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #commands = new Map<string, RetainedCommand>();
  #jobs: Job[] = [];
  #events: RetainedEvent[] = [];
  #physicalEvents = new Set<number>();
  #physicalThrough = 0;
  #eventSequence = 0;
  #deliveredThrough = 0;
  #observations = new Map<number, number>();

  constructor(physical: RobotPort, policies: Record<string, LocalPolicy>, options: PolicyPortOptions) {
    this.#physical = physical; this.robotId = physical.robotId; this.#policies = new Map(Object.entries(policies));
    if (!this.#policies.size || this.#policies.size > 64 || [...this.#policies].some(([name, policy]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || typeof policy !== 'function')) throw new Error('Supply 1..64 named local policy functions.');
    this.#options = { maxPolicyMs: 60000, operationMs: 2000, maxCommands: 512, maxJobs: 64, maxEvents: 256, maxQueuedEffects: 16, ...options };
    for (const [key, value] of Object.entries(this.#options)) {
      if (key === 'record') continue;
      if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > (key.endsWith('Ms') ? 600000 : 4096)) throw new Error(`Invalid policy-port limit ${key}.`);
    }
  }
  #log(kind: string, data: unknown) { this.#options.record?.(kind, copy(data)); }
  #check(generation?: number) {
    if (this.#closed) throw new Error(`Policy port is closed${this.#fault ? `: ${this.#fault}` : ''}.`);
    if (generation !== undefined && this.#active?.generation !== generation) throw new Error('Local policy generation revoked.');
  }
  async #bounded<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline; outcome may be unknown.`)), this.#options.operationMs); })]); }
    finally { clearTimeout(timer); }
  }
  #event(kind: string, data: Json) {
    if (this.#events.length >= this.#options.maxEvents) {
      this.#fault ??= 'Unread policy events full; no event was evicted.';
      if (!this.#closed) void this.#fail(this.#fault).catch(() => {});
      return;
    }
    this.#events.push({ event: { id: ++this.#eventSequence, kind, data: copy(data) } }); this.#log(kind, data);
  }
  async #fail(reason: string): Promise<void> {
    this.#fault ??= reason.slice(0, 512); this.#log('policy.port_fault', { reason: this.#fault });
    await this.stop();
  }
  #retire(status: 'completed' | 'cancelled' | 'expired', kind: string, reason?: string) {
    const active = this.#active; if (!active) return;
    this.#active = undefined; clearTimeout(active.timer); active.controller.abort(new Error(reason ?? kind));
    active.job.status = status; active.job.updatedSimMs = this.#latest?.simMs ?? active.job.startedSimMs;
    this.#event(kind, { jobId: active.job.id, generation: active.generation, ...(reason ? { reason: reason.slice(0, 512) } : {}) });
  }
  #enqueue<T>(guard: () => void, work: () => Promise<T>, label: string): Promise<T> {
    if (this.#queued >= this.#options.maxQueuedEffects) return Promise.reject(new Error('Policy effect queue full.'));
    this.#queued++;
    const result = this.#effects.then(async () => {
      guard();
      let value: T;
      try { value = await this.#bounded(work(), label); }
      catch (error) {
        // The physical interface has no abort/reconcile method for a pending mutation.
        // Revoke its lease instead of allowing an uncertain old effect into a later policy.
        await this.#fail(`${label} failed: ${String(error)}`).catch(() => {}); throw error;
      }
      guard(); return value;
    });
    this.#effects = result.catch(() => {}); void result.finally(() => { this.#queued--; }).catch(() => {});
    return result;
  }
  async #physicalDescription(): Promise<RobotDescription> {
    this.#check();
    if (!this.#description) {
      const description = await this.#bounded(this.#physical.describe(), 'Describe'); this.#check();
      if (!description.commands.hold) throw new Error('A policy port requires a nonterminal physical hold command.');
      if (description.commands.run_policy) throw new Error('run_policy is reserved; policy-port wrappers cannot nest.');
      this.#description = copy(description);
    }
    return copy(this.#description);
  }
  async describe(): Promise<RobotDescription> {
    const description = await this.#physicalDescription();
    description.commands.run_policy = { description: 'Start a bounded environment-owned local policy. Admission returns a job promptly. One policy owns actuators; replace:true is required to replace it.', schema: {
      type: 'object', properties: { name: { type: 'string', enum: [...this.#policies.keys()] }, replace: { type: 'boolean' } }, required: ['name'], additionalProperties: false,
    } };
    description.commands.hold = { description: 'Cancel the active local policy and hold through the physical robot. Ownership remains usable when hold is confirmed.', schema: { type: 'object', properties: {}, additionalProperties: false } };
    return description;
  }
  async #observe(generation?: number): Promise<Observation> {
    this.#check(generation);
    const physical = await this.#bounded(this.#physical.observe(), 'Observe'); this.#check(generation);
    const incoming = physical.events.filter(event => event.id > this.#physicalThrough && !this.#physicalEvents.has(event.id));
    if (this.#events.length + incoming.length > this.#options.maxEvents) {
      await this.#fail('Physical events exceed policy event capacity; unread events were not evicted.'); throw new Error(this.#fault);
    }
    for (const event of incoming) { this.#physicalEvents.add(event.id); this.#events.push({ physicalId: event.id, event: { ...copy(event), id: ++this.#eventSequence } }); }
    this.#latest = copy(physical);
    this.#observations.set(physical.sequence, physical.simMs);
    if (this.#observations.size > 64) this.#observations.delete(this.#observations.keys().next().value!);
    if (generation !== undefined) {
      // The child consumes physical execution evidence. It cannot observe or
      // acknowledge the outer supervisor's policy lifecycle journal. Physical
      // events have already been copied above, before the child can consume them.
      const active = this.#active!;
      active.deliveredPhysicalEvent = Math.max(active.deliveredPhysicalEvent, ...physical.events.map(event => event.id), 0);
      return copy(physical);
    }
    const result = { ...copy(physical), jobs: [...copy(physical.jobs), ...copy(this.#jobs)], events: this.#events.map(item => copy(item.event)), ...(this.#fault ? { fault: this.#fault } : {}) };
    this.#deliveredThrough = this.#eventSequence;
    return result;
  }
  observe(): Promise<Observation> { return this.#observe(); }
  async acknowledge(throughEvent: number, packetIds: string[] = []): Promise<void> { return this.#acknowledge(throughEvent, packetIds); }
  async #acknowledge(throughEvent: number, packetIds: string[], generation?: number): Promise<void> {
    this.#check(generation);
    const delivered = generation === undefined ? this.#deliveredThrough : this.#active!.deliveredPhysicalEvent;
    if (!Number.isSafeInteger(throughEvent) || throughEvent < 0 || throughEvent > delivered || packetIds.length > 256 || packetIds.some(id => typeof id !== 'string')) throw new Error('Invalid policy acknowledgement.');
    if (generation !== undefined) {
      await this.#enqueue(() => this.#check(generation), () => this.#physical.acknowledge(throughEvent, packetIds), 'Child acknowledgement');
      return;
    }
    const included = this.#events.filter(item => item.event.id <= throughEvent);
    const physicalThrough = Math.max(this.#physicalThrough, ...included.map(item => item.physicalId ?? 0));
    await this.#enqueue(() => this.#check(generation), () => this.#physical.acknowledge(physicalThrough, packetIds), 'Acknowledge');
    this.#events = this.#events.filter(item => item.event.id > throughEvent);
    for (const item of included) if (item.physicalId !== undefined) this.#physicalEvents.delete(item.physicalId);
    this.#physicalThrough = Math.max(this.#physicalThrough, physicalThrough);
  }
  send(packet: { id: string; to: string; data: string; ttlMs?: number }) { return this.#send(packet); }
  #send(packet: { id: string; to: string; data: string; ttlMs?: number }, generation?: number) {
    this.#check(generation);
    return this.#enqueue(() => this.#check(generation), () => this.#physical.send(copy(packet)), 'Radio send');
  }
  command(command: Command): Promise<Receipt> { return this.#command(command); }
  #command(command: Command, generation?: number): Promise<Receipt> {
    try { this.#check(generation); } catch (error) { return Promise.reject(error); }
    if (!object(command) || typeof command.id !== 'string' || !/^[\w.:-]{1,96}$/.test(command.id) || !object(command.args) || typeof command.action !== 'string' || Buffer.byteLength(JSON.stringify(command)) > 16000) return Promise.resolve({ id: command?.id ?? '', status: 'rejected', reason: 'Invalid policy-port command.' });
    const key = `${generation ?? 'outer'}:${command.id}`, fingerprint = stable(command), prior = this.#commands.get(key);
    if (prior) return prior.fingerprint === fingerprint ? prior.result.then(receipt => receipt.status === 'rejected' ? receipt : { ...receipt, status: 'duplicate' }) : Promise.resolve({ id: command.id, status: 'rejected', reason: 'Command ID reused with different payload.' });
    if (this.#commands.size >= this.#options.maxCommands) {
      // Exhausted bookkeeping must never prevent an emergency stop. A terminal
      // stop is explicit here because no new deduplicated hold can be retained.
      if (generation === undefined && command.action === 'hold' && Object.keys(command.args).length === 0) return this.stop().then(() => ({ id: command.id, status: 'completed', reason: 'Policy command history full; physical lease stopped and revoked.' }));
      return Promise.resolve({ id: command.id, status: 'rejected', reason: 'Policy command history full; stop and create a new wrapper.' });
    }
    const outerHold = generation === undefined && command.action === 'hold';
    if (outerHold && Object.keys(command.args).length) return Promise.resolve({ id: command.id, status: 'rejected', reason: 'hold takes no arguments.' });
    // Hold revokes pending admissions immediately rather than waiting behind their reads.
    if (outerHold) { this.#boundary++; this.#retire('cancelled', 'policy.cancelled', 'outer_hold'); }
    const boundary = this.#boundary;
    const work = Promise.resolve().then(async () => {
      this.#check(generation);
      if (generation === undefined && boundary !== this.#boundary) throw new Error('Command boundary changed.');
      const physicalDescription = await this.#physicalDescription();
      this.#check(generation);
      if (generation === undefined && boundary !== this.#boundary) throw new Error('Command boundary changed.');
      if (command.action === 'run_policy') {
        if (generation !== undefined) return { id: command.id, status: 'rejected' as const, reason: 'Policies cannot start another policy.' };
        return this.#start(command);
      }
      if (outerHold) return this.#hold(command.id, boundary);
      if (!physicalDescription.commands[command.action]) return { id: command.id, status: 'rejected' as const, reason: 'Unknown physical command.' };
      if (generation === undefined && this.#active) return { id: command.id, status: 'rejected' as const, reason: 'A local policy owns the actuator; hold or explicitly replace it.' };
      const guard = () => { this.#check(generation); if (generation === undefined && boundary !== this.#boundary) throw new Error('Command boundary changed.'); };
      const forwarded = { ...copy(command), id: this.#physicalId(command.id, generation) };
      const receipt = await this.#enqueue(guard, () => this.#physical.command(forwarded), 'Physical command');
      return { ...receipt, id: command.id };
    });
    this.#commands.set(key, { fingerprint, result: work }); return work;
  }
  #physicalId(id: string, generation?: number): string {
    return `policy-${this.#prefix}-${generation ?? 'outer'}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
  }
  async #hold(id: string, boundary: number): Promise<Receipt> {
    const guard = () => { this.#check(); if (boundary !== this.#boundary) throw new Error('Hold superseded.'); };
    const result = await this.#enqueue(guard, () => this.#physical.command({ id: this.#physicalId(id), action: 'hold', args: {}, validForMs: 1000 }), 'Physical hold');
    return { ...result, id };
  }
  async #start(command: Command): Promise<Receipt> {
    const args = command.args;
    if (typeof args.name !== 'string' || !this.#policies.has(args.name) || Object.keys(args).some(key => key !== 'name' && key !== 'replace') || (args.replace !== undefined && typeof args.replace !== 'boolean')) return { id: command.id, status: 'rejected', reason: 'run_policy requires a registered name and optional boolean replace.' };
    const admissionBoundary = this.#boundary;
    await this.#observe(); this.#check();
    if (admissionBoundary !== this.#boundary) return { id: command.id, status: 'rejected', reason: 'Policy admission superseded.' };
    if (command.basedOn) {
      const acquired = this.#observations.get(command.basedOn.observation);
      if (acquired === undefined || !Number.isFinite(command.basedOn.maxAgeMs) || command.basedOn.maxAgeMs < 0 || this.#latest!.simMs - acquired > command.basedOn.maxAgeMs) return { id: command.id, status: 'rejected', reason: 'Unknown or stale policy observation.' };
    }
    if (this.#active && args.replace !== true) return { id: command.id, status: 'rejected', reason: 'Policy already running; replace:true is required.' };
    if (this.#jobs.length >= this.#options.maxJobs || this.#events.length + 2 > this.#options.maxEvents) return { id: command.id, status: 'rejected', reason: 'Policy job/event history full; acknowledge events or create a new wrapper.' };
    const boundary = ++this.#boundary;
    const replacing = !!this.#active; this.#retire('cancelled', 'policy.cancelled', 'explicit_replacement');
    // The first policy also replaces any previously issued outer actuator work.
    // Queue ordering settles old mutations before holding and granting a child.
    const held = await this.#hold(`${replacing ? 'replace' : 'start'}-${command.id}`, boundary);
    if (held.status !== 'completed') return { id: command.id, status: 'rejected', reason: 'Policy transition hold was not confirmed; observe before retrying.' };
    this.#check(); if (boundary !== this.#boundary) return { id: command.id, status: 'rejected', reason: 'Policy admission superseded.' };
    const generation = ++this.#generation, controller = new AbortController();
    const job: Job = { id: `policy-${this.#prefix}-${generation}`, commandId: command.id, action: 'run_policy', args: copy(args), status: 'running', startedSimMs: this.#latest!.simMs, updatedSimMs: this.#latest!.simMs };
    const timer = setTimeout(() => {
      if (this.#active?.generation !== generation) return;
      this.#boundary++; this.#retire('expired', 'policy.expired', 'policy_wall_deadline');
      void this.#hold(`deadline-${generation}`, this.#boundary).catch(error => this.#fail(String(error))).catch(() => {});
    }, this.#options.maxPolicyMs);
    this.#jobs.push(job); this.#active = { generation, job, controller, timer, deliveredPhysicalEvent: 0 };
    this.#event('policy.started', { jobId: job.id, name: args.name, generation });
    const policy = this.#policies.get(args.name)!;
    // Admission returns without waiting for policy execution or its first model call.
    setImmediate(() => { void (async () => {
      try {
        this.#check(generation); await policy(this.#child(generation), controller.signal);
        if (this.#active?.generation !== generation) return;
        this.#boundary++; this.#retire('completed', 'policy.completed');
        await this.#hold(`completed-${generation}`, this.#boundary);
      } catch (error) {
        if (this.#active?.generation !== generation) return;
        this.#boundary++; this.#retire('cancelled', 'policy.failed', String(error));
        await this.#hold(`failed-${generation}`, this.#boundary).catch(failure => this.#fail(String(failure)));
      }
    })().catch(error => { void this.#fail(String(error)).catch(() => {}); }); });
    return { id: command.id, status: 'accepted', jobId: job.id };
  }
  #child(generation: number): RobotPort {
    const finish = async () => {
      if (this.#closed || this.#active?.generation !== generation) return;
      this.#boundary++; this.#retire('cancelled', 'policy.cancelled', 'policy_requested_stop');
      await this.#hold(`child-stop-${generation}`, this.#boundary);
    };
    return Object.freeze({ robotId: this.robotId,
      describe: async () => { this.#check(generation); const description = await this.#physicalDescription(); this.#check(generation); return description; },
      observe: () => this.#observe(generation),
      command: (command: Command) => this.#command(command, generation),
      acknowledge: (through: number, packets: string[] = []) => this.#acknowledge(through, packets, generation),
      send: (packet: { id: string; to: string; data: string; ttlMs?: number }) => this.#send(packet, generation), stop: finish, close: finish,
    });
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#closed = true; this.#boundary++; this.#retire('cancelled', 'policy.cancelled', 'outer_stop');
    this.#stopping = this.#bounded(this.#physical.stop(), 'Physical stop'); return this.#stopping;
  }
  async close(): Promise<void> { try { await this.stop(); } finally { await this.#bounded(this.#physical.close(), 'Physical close'); } }
}
