import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { BodySpec, Command, Job, Json, Observation, PhysicsBackend, Receipt, RobotDescription, RobotModel, RobotPlant, RobotPort, RobotSpec, Scenario } from './contracts.ts';
import type { Registry } from './registry.ts';
import { Journal } from './recorder.ts';
import { RadioMedium } from './network.ts';
import { SensorBank } from './sensors/index.ts';

const MAX_EVENTS = 128;
const MAX_COMMANDS = 4096;
const copy = <T>(value: T): T => structuredClone(value);
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
type Lease = { id: string; owner: string; live: boolean; receipts: Map<string, { fingerprint: string; receipt: Receipt }> };
type Robot = {
  spec: RobotSpec; model: RobotModel; plant: RobotPlant; sensors: SensorBank; description: RobotDescription;
  validators: Map<string, ValidateFunction>; lease?: Lease; jobs: Job[]; deadline: number;
  observation: number; observations: Map<number, number>; events: Observation['events']; eventId: number; fault?: string;
};

/** Continuous environment. Policies receive RobotPort, never this object. */
export class World {
  readonly epoch = randomUUID();
  readonly scenario: Scenario;
  readonly physics: PhysicsBackend;
  readonly journal: Journal;
  readonly radio: RadioMedium;
  #robots = new Map<string, Robot>();
  #ticks = 0;
  #closed = false;
  #disposed = false;
  #advancing = false;
  private constructor(scenario: Scenario, physics: PhysicsBackend, journal: Journal) {
    this.scenario = copy(scenario); this.physics = physics; this.journal = journal;
    this.radio = new RadioMedium({ seed: scenario.seed, partitions: scenario.partitions,
      position: id => physics.body(this.#robot(id).plant.root).pose.position, record: journal.record });
  }
  static async create(scenario: Scenario, registry: Registry, physicsId = 'rapier', journal = new Journal()): Promise<World> {
    if (!scenario.id || !Number.isInteger(scenario.seed) || !Number.isFinite(scenario.dt) || scenario.dt < 0.001 || scenario.dt > 0.1) throw new Error('Scenario needs ID, integer seed, and dt in [0.001, 0.1] seconds');
    if (!scenario.robots.length || scenario.robots.length > 128) throw new Error('Scenario must contain 1–128 robots');
    if (new Set(scenario.robots.map(robot => robot.id)).size !== scenario.robots.length) throw new Error('Duplicate robot ID');
    const factory = registry.physics.get(physicsId);
    if (!factory) throw new Error(`Unknown physics backend: ${physicsId}`);
    const physics = await factory({ gravity: scenario.gravity });
    const world = new World(scenario, physics, journal);
    try {
      const ajv = new Ajv({ strict: false, allErrors: true });
      for (const obstacle of scenario.obstacles) physics.addBody(copy(obstacle));
      for (const spec of world.scenario.robots) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.id)) throw new Error(`Invalid robot ID: ${spec.id}`);
        const model = registry.models.get(spec.model);
        if (!model) throw new Error(`Unknown robot model: ${spec.model}`);
        for (const feature of model.requires) if (!physics.capabilities.includes(feature)) throw new Error(`${physics.id} cannot run ${model.id}: requires ${feature}`);
        const plant = model.create({ id: spec.id, pose: copy(spec.pose), physics, config: copy(spec.config ?? {}) });
        const sensors = new SensorBank({ robot: spec, plant, physics, plugins: registry.sensors, seed: scenario.seed, record: journal.record });
        const radio = world.radio.register(spec.id, spec.radio ?? {});
        const robot: Robot = { spec, model, plant, sensors,
          description: { id: spec.id, model: spec.model, commands: copy(model.commands), sensors: copy(spec.sensors), radio, units: 'right-handed ENU; metres, seconds, radians' },
          validators: new Map(Object.entries(model.commands).map(([name, command]) => [name, ajv.compile(command.schema)])),
          jobs: [], deadline: Infinity, observation: 0, observations: new Map(), events: [], eventId: 0 };
        world.#robots.set(spec.id, robot);
        sensors.tick(0);
      }
      journal.record({ simMs: 0, channel: 'world', kind: 'created', data: { epoch: world.epoch, scenario: scenario.id, seed: scenario.seed, physics: physics.id, robots: scenario.robots.map(robot => robot.id) } });
      return world;
    } catch (error) { physics.close(); throw error; }
  }
  get simMs(): number { return this.#ticks * this.scenario.dt * 1000; }
  get robotIds(): string[] { return [...this.#robots.keys()]; }
  #robot(id: string): Robot { const robot = this.#robots.get(id); if (!robot) throw new Error(`Unknown robot: ${id}`); return robot; }
  #check(robot: Robot, lease: Lease): void {
    if (this.#closed || !lease.live || robot.lease !== lease) throw new Error('Controller lease revoked');
  }
  #event(robot: Robot, kind: string, data: Json): void {
    if (robot.events.length >= MAX_EVENTS) {
      robot.fault = 'Unread event capacity reached; acknowledge events before resuming';
      robot.plant.stop();
      this.journal.record({ simMs: this.simMs, robotId: robot.spec.id, channel: 'world', kind: 'backpressure', data: { queue: 'events', capacity: MAX_EVENTS } });
      return;
    }
    robot.events.push({ id: ++robot.eventId, kind, data });
  }
  #halt(robot: Robot, status: 'cancelled' | 'expired', revoke: boolean): void {
    if (revoke && robot.lease) { robot.lease.live = false; robot.lease = undefined; }
    robot.plant.stop(); robot.deadline = Infinity;
    for (const job of robot.jobs) if (job.status === 'running') {
      job.status = status; job.updatedSimMs = this.simMs;
      this.#event(robot, `job.${status}`, { jobId: job.id, commandId: job.commandId });
    }
    this.journal.record({ simMs: this.simMs, robotId: robot.spec.id, channel: 'control', kind: revoke ? 'lease.revoked' : status, data: { status } });
  }
  claim(robotId: string, owner: string): RobotPort {
    if (this.#closed) throw new Error('World closed');
    const robot = this.#robot(robotId);
    if (!owner || owner.length > 128) throw new Error('Owner must be 1–128 characters');
    if (robot.lease?.live) throw new Error(`Robot ${robotId} already owned by ${robot.lease.owner}`);
    const lease: Lease = { id: randomUUID(), owner, live: true, receipts: new Map() };
    robot.lease = lease;
    this.journal.record({ simMs: this.simMs, robotId, channel: 'control', kind: 'lease.claimed', data: { owner } });
    return Object.freeze({ robotId,
      describe: async () => { this.#check(robot, lease); return copy(robot.description); },
      observe: async () => {
        this.#check(robot, lease);
        const sequence = ++robot.observation;
        robot.observations.set(sequence, this.simMs);
        if (robot.observations.size > 64) robot.observations.delete(robot.observations.keys().next().value!);
        const result: Observation = { epoch: this.epoch, robotId, sequence, simMs: this.simMs, wallMs: Date.now(), goal: robot.spec.goal ?? '',
          sensors: robot.sensors.snapshot(this.simMs), jobs: copy(robot.jobs), inbox: this.radio.inbox(robotId), events: copy(robot.events), ...(robot.fault ? { fault: robot.fault } : {}) };
        this.journal.record({ simMs: this.simMs, robotId, channel: 'control', kind: 'observation.delivered', data: { sequence, sensorSequences: Object.fromEntries(Object.entries(result.sensors).map(([id, reading]) => [id, reading.sequence])), events: result.events.map(event => event.id) } });
        return result;
      },
      command: async (command: Command) => {
        this.#check(robot, lease);
        return this.#command(robot, lease, command);
      },
      acknowledge: async (throughEvent: number, packetIds: string[] = []) => {
        this.#check(robot, lease);
        if (!Number.isInteger(throughEvent) || throughEvent < 0 || throughEvent > robot.eventId || !Array.isArray(packetIds) || packetIds.length > 256 || packetIds.some(id => typeof id !== 'string')) throw new Error('Invalid acknowledgement');
        robot.events = robot.events.filter(event => event.id > throughEvent);
        this.radio.acknowledge(robotId, packetIds);
        if (robot.events.length < MAX_EVENTS) robot.fault = undefined;
      },
      send: async (packet: { id: string; to: string; data: string; ttlMs?: number }) => { this.#check(robot, lease); return this.radio.send(robotId, packet, this.simMs); },
      stop: async () => { if (lease.live) { this.#check(robot, lease); this.#halt(robot, 'cancelled', true); } },
      close: async () => { if (lease.live) { this.#check(robot, lease); this.#halt(robot, 'cancelled', true); } },
    });
  }
  #command(robot: Robot, lease: Lease, incoming: Command): Receipt {
    const reject = (reason: string): Receipt => {
      const receipt: Receipt = { id: incoming?.id ?? '', status: 'rejected', reason };
      this.journal.record({ simMs: this.simMs, robotId: robot.spec.id, channel: 'control', kind: 'command.rejected', data: receipt });
      return receipt;
    };
    if (!incoming || typeof incoming.id !== 'string' || !/^[\w.:-]{1,96}$/.test(incoming.id)) return reject('Command ID must be 1–96 simple characters');
    if (JSON.stringify(incoming).length > 16000) return reject('Command exceeds 16 kB');
    const command = copy(incoming);
    const fingerprint = stable(command);
    const prior = lease.receipts.get(command.id);
    if (prior) return prior.fingerprint === fingerprint ? { ...copy(prior.receipt), status: 'duplicate' } : reject('Command ID reused with different payload');
    if (lease.receipts.size >= MAX_COMMANDS) return reject('Command history full; release and explicitly claim a new session');
    if (robot.fault) return reject(robot.fault);
    if (robot.events.length + 1 + robot.jobs.filter(job => job.status === 'running').length > MAX_EVENTS) {
      robot.fault = 'Unread event capacity reached; acknowledge events before resuming';
      this.#halt(robot, 'cancelled', false);
      return reject(robot.fault);
    }
    const validate = robot.validators.get(command.action);
    if (!validate || !validate(command.args)) return reject(validate ? `Invalid command arguments: ${JSON.stringify(validate.errors)}` : `Unknown action: ${command.action}`);
    const ttl = command.validForMs ?? 3000;
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 60000) return reject('validForMs must be within 1–60000');
    if (command.basedOn) {
      const sampled = robot.observations.get(command.basedOn.observation);
      if (sampled === undefined || !Number.isFinite(command.basedOn.maxAgeMs) || command.basedOn.maxAgeMs < 0 || this.simMs - sampled > command.basedOn.maxAgeMs) return reject('Unknown or stale observation');
    }
    // One actuator writer: a new admitted operation replaces its predecessor.
    // Validate before replacing. Plant apply must reject without side effects on invalid domain inputs.
    try { robot.plant.apply(command.action, command.args); } catch (error) { return reject(String(error)); }
    for (const old of robot.jobs) if (old.status === 'running') { old.status = 'cancelled'; old.updatedSimMs = this.simMs; this.#event(robot, 'job.cancelled', { jobId: old.id, replacedBy: command.id }); }
    const job: Job = { id: `${lease.id.slice(0, 8)}:${command.id}`, commandId: command.id, action: command.action, args: command.args, status: 'running', startedSimMs: this.simMs, updatedSimMs: this.simMs };
    if (robot.plant.completed(command.action, command.args)) job.status = 'completed';
    robot.jobs.push(job); if (robot.jobs.length > 128) robot.jobs.shift();
    robot.deadline = this.simMs + ttl;
    const receipt: Receipt = { id: command.id, status: job.status === 'completed' ? 'completed' : 'accepted', jobId: job.id, appliedSimMs: this.simMs };
    lease.receipts.set(command.id, { fingerprint, receipt });
    this.#event(robot, `job.${job.status}`, { jobId: job.id, commandId: command.id });
    this.journal.record({ simMs: this.simMs, robotId: robot.spec.id, channel: 'control', kind: 'command.applied', data: { command, receipt, owner: lease.owner } });
    return copy(receipt);
  }
  async advance(ticks = 1): Promise<void> {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10000) throw new Error('advance expects 1–10000 ticks');
    if (this.#closed || this.#advancing) throw new Error(this.#closed ? 'World closed' : 'World already advancing');
    this.#advancing = true;
    try {
      for (let n = 0; n < ticks; n++) {
        for (const robot of this.#robots.values()) {
          if (this.simMs >= robot.deadline) this.#halt(robot, 'expired', false);
          robot.plant.tick(this.scenario.dt);
        }
        await this.physics.step(this.scenario.dt);
        this.#ticks++;
        if (this.#closed) break;
        for (const robot of this.#robots.values()) {
          robot.sensors.tick(this.simMs);
          for (const job of robot.jobs) if (job.status === 'running' && robot.plant.completed(job.action, job.args)) {
            job.status = 'completed'; job.updatedSimMs = this.simMs;
            this.#event(robot, 'job.completed', { jobId: job.id, commandId: job.commandId });
            this.journal.record({ simMs: this.simMs, robotId: robot.spec.id, channel: 'control', kind: 'job.completed', data: job });
          }
        }
        this.radio.tick(this.simMs);
        if (n % 100 === 99) await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { this.#advancing = false; if (this.#closed) this.#dispose(); }
  }
  stop(robotId?: string): void {
    for (const robot of robotId ? [this.#robot(robotId)] : this.#robots.values()) this.#halt(robot, 'cancelled', true);
  }
  inspect(after = 0) {
    const visuals = new Map<string, BodySpec>(this.scenario.obstacles.map(body => [body.id, body]));
    for (const robot of this.#robots.values()) for (const visual of robot.plant.visuals) visuals.set(visual.id, visual);
    return {
      epoch: this.epoch, simMs: this.simMs, physics: this.physics.id, scenario: copy(this.scenario),
      robots: [...this.#robots.values()].map(robot => ({ id: robot.spec.id, model: robot.spec.model, owner: robot.lease?.owner ?? null,
        description: copy(robot.description), sensors: robot.sensors.snapshot(this.simMs), jobs: copy(robot.jobs), fault: robot.fault })),
      bodies: this.physics.bodies().map(body => ({ ...copy(visuals.get(body.id)), ...body })),
      diagnostics: this.journal.after(after), cursor: this.journal.cursor,
    };
  }
  #dispose(): void { if (this.#disposed) return; this.#disposed = true; this.radio.close(); this.physics.close(); }
  close(): void { if (this.#closed) return; this.stop(); this.#closed = true; if (!this.#advancing) this.#dispose(); }
}
