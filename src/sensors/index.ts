import type { Json, PhysicsBackend, Recorder, RobotPlant, RobotSpec, SensorPlugin, SensorReading, SensorSpec } from '../contracts.ts';
import { compose, pose, randomStream } from '../math.ts';
import { validateBuiltin } from './builtins.ts';
export { builtinSensors } from './builtins.ts';

const MAX_PENDING = 256;
interface Slot {
  spec: SensorSpec; plugin: SensorPlugin; link: string; nextAt: number; sequence: number;
  sampleRandom: () => number; dropRandom: () => number;
  pending: { due: number; reading: SensorReading }[];
  latest?: SensorReading; fault?: string;
}
export interface SensorBankOptions {
  robot: RobotSpec; plant: RobotPlant; physics: PhysicsBackend; plugins: Map<string, SensorPlugin>;
  seed: number; record: Recorder;
}

function bounded(value: unknown, fallback: number, low: number, high: number, label: string): number {
  const number = value ?? fallback;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < low || number > high) throw new Error(`${label} must be from ${low} to ${high}`);
  return number;
}

function validateJson(value: unknown, budget = { left: 4096 }, depth = 0): asserts value is Json {
  if (--budget.left < 0 || depth > 16) throw new Error('sensor output exceeds JSON size/depth limit');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 8192) return;
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error('sensor array exceeds 1024 entries');
    for (const item of value) validateJson(item, budget, depth+1);
    return;
  }
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) validateJson(item, budget, depth+1);
    return;
  }
  throw new Error('sensor output must be bounded finite JSON');
}

/** Acquisition and delivery proceed on simulation ticks, independently of readers and controllers. */
export class SensorBank {
  private readonly options: SensorBankOptions;
  private readonly slots: Slot[];
  private lastTick = -Infinity;

  constructor(options: SensorBankOptions) {
    this.options = options;
    const { robot, plant, physics, plugins, seed } = options;
    if (robot.sensors.length > 64) throw new Error('a robot supports at most 64 sensors');
    const ids = new Set<string>();
    this.slots = robot.sensors.map(input => {
      const spec = structuredClone(input);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.id) || ids.has(spec.id)) throw new Error(`invalid or duplicate sensor id: ${spec.id}`);
      ids.add(spec.id);
      const plugin = plugins.get(spec.type);
      if (!plugin) throw new Error(`unknown sensor type: ${spec.type}`);
      for (const capability of plugin.requires) if (!physics.capabilities.includes(capability)) throw new Error(`${spec.id}: backend lacks ${capability}`);
      spec.hz = bounded(spec.hz, NaN, 0.01, 1000, `${spec.id}.hz`);
      spec.latencyMs = bounded(spec.latencyMs, 0, 0, 60000, `${spec.id}.latencyMs`);
      spec.noise = bounded(spec.noise, 0, 0, 10000, `${spec.id}.noise`);
      spec.dropout = bounded(spec.dropout, 0, 0, 1, `${spec.id}.dropout`);
      spec.maxAgeMs = bounded(spec.maxAgeMs, Math.max(1000, 3000/spec.hz), 0, 600000, `${spec.id}.maxAgeMs`);
      const link = !spec.link ? plant.root : spec.link.includes('/') ? spec.link : `${robot.id}/${spec.link}`;
      if (!plant.bodyIds.includes(link)) throw new Error(`${spec.id}: link is not owned by ${robot.id}: ${link}`);
      physics.body(link);
      spec.mount ??= pose();
      const { position, rotation } = spec.mount;
      if (!position || !rotation || ![position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite)) {
        throw new Error(`${spec.id}: mount must have a finite position and quaternion`);
      }
      if (Math.abs(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w)-1) > 1e-5) throw new Error(`${spec.id}: mount quaternion must be normalized`);
      if (spec.type === 'joints') {
        const requested = spec.config?.joints ?? plant.jointIds;
        if (!Array.isArray(requested) || requested.some(name => typeof name !== 'string')) throw new Error(`${spec.id}: joints must be a list of names`);
        const jointIds = (requested as string[]).map(name => name.includes('/') ? name : `${robot.id}/${name}`);
        for (const joint of jointIds) if (!plant.jointIds.includes(joint)) throw new Error(`${spec.id}: joint is not owned by ${robot.id}: ${joint}`);
        spec.config = { ...spec.config, joints: jointIds };
      }
      validateBuiltin(spec);
      return { spec, plugin, link, nextAt: 0, sequence: 0, pending: [],
        sampleRandom: randomStream(seed, `${robot.id}/${spec.id}/sample`), dropRandom: randomStream(seed, `${robot.id}/${spec.id}/dropout`) };
    });
  }

  private record(slot: Slot, simMs: number, kind: string, data: unknown): void {
    this.options.record({ robotId: this.options.robot.id, simMs, channel: 'sensor', kind, data: { sensorId: slot.spec.id, ...data as object } });
  }

  private deliver(slot: Slot, simMs: number): void {
    while (slot.pending.length && slot.pending[0].due <= simMs+1e-7) {
      const reading = slot.pending.shift()!.reading;
      reading.receivedSimMs = simMs;
      slot.latest = reading;
      slot.fault = undefined;
      this.record(slot, simMs, 'delivered', { reading });
    }
  }

  tick(simMs: number): void {
    if (!Number.isFinite(simMs) || simMs < 0 || simMs < this.lastTick) throw new Error('sensor time must be finite and monotonic');
    this.lastTick = simMs;
    for (const slot of this.slots) {
      this.deliver(slot, simMs);
      if (simMs+1e-7 < slot.nextAt) continue;
      const period = 1000/slot.spec.hz;
      const missed = Math.max(0, Math.floor((simMs-slot.nextAt+1e-7)/period));
      if (missed) this.record(slot, simMs, 'cadence-skipped', { count: missed });
      // Never fabricate samples of earlier physical states after a large tick jump.
      slot.nextAt += (missed+1)*period;
      slot.sequence++;
      if (slot.dropRandom() < slot.spec.dropout!) {
        this.record(slot, simMs, 'dropped', { sequence: slot.sequence, reason: 'configured-dropout' });
        continue;
      }
      try {
        const mount = compose(this.options.physics.body(slot.link).pose, slot.spec.mount!);
        const value = slot.plugin.sample({ robotId: this.options.robot.id, bodyIds: this.options.plant.bodyIds,
          link: slot.link, mount, physics: this.options.physics, simMs, random: slot.sampleRandom }, slot.spec);
        validateJson(value);
        const reading: SensorReading = { value: structuredClone(value), sequence: slot.sequence, acquiredSimMs: simMs, receivedSimMs: simMs, valid: true };
        if (slot.pending.length === MAX_PENDING) {
          const dropped = slot.pending.shift()!;
          this.record(slot, simMs, 'dropped', { sequence: dropped.reading.sequence, reason: 'latency-queue-overflow' });
        }
        slot.pending.push({ due: simMs+slot.spec.latencyMs!, reading });
        this.record(slot, simMs, 'acquired', { sequence: reading.sequence, acquiredSimMs: simMs, dueSimMs: simMs+slot.spec.latencyMs! });
        this.deliver(slot, simMs);
      } catch (error) {
        slot.fault = String(error).slice(0, 256);
        this.record(slot, simMs, 'error', { sequence: slot.sequence, error: slot.fault });
      }
    }
  }

  snapshot(simMs: number): Record<string, SensorReading> {
    if (!Number.isFinite(simMs) || simMs < 0 || (this.lastTick !== -Infinity && simMs < this.lastTick)) throw new Error('snapshot time cannot precede the latest sensor tick');
    return Object.fromEntries(this.slots.map(slot => {
      const reading = slot.latest ? structuredClone(slot.latest) : { value: null, sequence: 0, acquiredSimMs: 0, receivedSimMs: 0, valid: false, reason: 'unavailable' };
      if (slot.fault) { reading.valid = false; reading.reason = `sensor-error: ${slot.fault}`; }
      else if (slot.latest && simMs-reading.acquiredSimMs > slot.spec.maxAgeMs!) { reading.valid = false; reading.reason = 'stale'; }
      return [slot.spec.id, reading];
    }));
  }
}
