import type { Command, Json, Observation, RobotDescription, RobotPort, Vec3 } from '../src/contracts.ts';

export interface DemoPolicyOptions { index: number; swarm?: boolean; leaderId?: string; decisionDelayMs?: number }
type Beacon = { position: Vec3; acquiredSimMs: number };
const finitePosition = (value: unknown): value is Vec3 => !!value && typeof value === 'object' && ['x','y','z'].every(key => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, number>)[key]));
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);

/** A deliberately ordinary port-only controller: no simulator, inspector or shared robot state. */
export class DemoPolicy {
  private description?: RobotDescription;
  private nextAt = 0;
  private sequence = 0;
  private routeIndex = 0;
  private origin?: Vec3;
  private lastBeacon?: Beacon;
  private pending?: { due: number; command: Command };
  private lastCommandAt = -Infinity;
  private lastCommandId?: string;
  private holding = false;
  private busy = false;
  readonly stats = { observations: 0, commands: 0, rejected: 0, broadcasts: 0, receivedBeacons: 0, holds: 0 };
  private readonly port: RobotPort;
  private readonly options: DemoPolicyOptions;

  constructor(port: RobotPort, options: DemoPolicyOptions) {
    if (!Number.isInteger(options.index) || options.index < 0 || !Number.isFinite(options.decisionDelayMs ?? 0) || (options.decisionDelayMs ?? 0) < 0 || (options.decisionDelayMs ?? 0) > 60000) throw new Error('invalid demo policy options');
    this.port = port; this.options = options;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.description ??= await this.port.describe();
      const observation = await this.port.observe();
      this.stats.observations++;
      this.receive(observation);
      await this.port.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.slice(0, 256).map(packet => packet.id));
      if (this.pending && this.options.swarm && this.options.index > 0 && (!this.lastBeacon || observation.simMs-this.lastBeacon.acquiredSimMs > 1200)) {
        this.pending = undefined;
        this.nextAt = 0;
      }
      if (this.pending && observation.simMs >= this.pending.due) {
        await this.apply(this.pending.command, observation.simMs);
        this.pending = undefined;
      }
      if (observation.simMs+1e-7 < this.nextAt) return;
      this.nextAt = observation.simMs+500;
      const position = this.position(observation);
      if (this.options.swarm && this.options.index === 0 && position) {
        const reading = observation.sensors.odom ?? Object.values(observation.sensors).find(item => item.valid && finitePosition((item.value as Record<string, Json> | null)?.position));
        const result = await this.port.send({ id: `beacon-${++this.sequence}`, to: '*', ttlMs: 1200,
          data: JSON.stringify({ kind: 'leader-position', version: 1, position, acquiredSimMs: reading?.acquiredSimMs ?? observation.simMs }) });
        if (result.accepted) this.stats.broadcasts++;
      }
      if (this.pending) return;
      const planned = this.plan(observation, position);
      if (!planned) return;
      const command: Command = { id: `demo-${++this.sequence}`, ...planned, validForMs: 2000, basedOn: { observation: observation.sequence, maxAgeMs: 1000 } };
      const delay = this.options.decisionDelayMs ?? 0;
      if (delay && command.action !== 'hold') this.pending = { due: observation.simMs+delay, command };
      else await this.apply(command, observation.simMs);
    } finally { this.busy = false; }
  }

  private position(observation: Observation): Vec3 | undefined {
    for (const reading of Object.values(observation.sensors)) {
      const value = reading.value as Record<string, Json> | null;
      const position: unknown = value?.position;
      if (reading.valid && value?.frame === 'world-ENU' && finitePosition(position)) return { ...position };
    }
    return undefined;
  }

  private receive(observation: Observation): void {
    for (const packet of observation.inbox) {
      if (packet.from !== (this.options.leaderId ?? 'drone-1') || packet.expiresSimMs <= observation.simMs) continue;
      try {
        const beacon = JSON.parse(packet.data);
        if (beacon.kind !== 'leader-position' || beacon.version !== 1 || !finitePosition(beacon.position) || !Number.isFinite(beacon.acquiredSimMs) || beacon.acquiredSimMs > observation.simMs || observation.simMs-beacon.acquiredSimMs > 1200) continue;
        if (!this.lastBeacon || beacon.acquiredSimMs > this.lastBeacon.acquiredSimMs) {
          this.lastBeacon = { position: { ...beacon.position }, acquiredSimMs: beacon.acquiredSimMs };
          this.stats.receivedBeacons++;
        }
      } catch { /* Invalid peer packets are acknowledged but never become movement instructions. */ }
    }
  }

  private hold(): { action: string; args: Record<string, Json> } | undefined {
    if (this.holding || !this.description!.commands.hold) return;
    return { action: 'hold', args: {} };
  }

  private plan(observation: Observation, position?: Vec3): { action: string; args: Record<string, Json> } | undefined {
    if (this.description!.commands.joints) {
      const schema = this.description!.commands.joints.schema as { properties?: { positions?: { properties?: Record<string, { minimum?: number; maximum?: number }> } } };
      const properties = schema.properties?.positions?.properties ?? {};
      const positions: Record<string, Json> = {};
      Object.entries(properties).forEach(([name, limit], index) => { positions[name] = Math.max(limit.minimum ?? -1, Math.min(limit.maximum ?? 1, Math.sin(observation.simMs/1800+index)*0.45)); });
      return Object.keys(positions).length ? { action: 'joints', args: { positions } } : undefined;
    }
    if (!this.description!.commands.goto) return;
    if (!position) return this.hold();
    this.origin ??= { ...position };
    if (this.options.swarm && this.options.index > 0) {
      if (!this.lastBeacon || observation.simMs-this.lastBeacon.acquiredSimMs > 1200) return this.hold();
      const offset = this.options.index;
      return { action: 'goto', args: { x: this.lastBeacon.position.x+(offset%2)*1.5,
        y: this.lastBeacon.position.y+Math.floor(offset/2)*1.5, z: this.lastBeacon.position.z+offset*0.6 } };
    }
    const route = [[2,0], [2,2], [0,2], [0,0]];
    let [x,y] = route[this.routeIndex];
    let target = { x: this.origin.x+x, y: this.origin.y+y, z: this.origin.z };
    const previous = observation.jobs.find(job => job.commandId === this.lastCommandId);
    if (previous?.status === 'completed' && distance(position, target) < 0.25) {
      this.routeIndex = (this.routeIndex+1)%route.length;
      [x,y] = route[this.routeIndex]; target = { x: this.origin.x+x, y: this.origin.y+y, z: this.origin.z };
    } else if (previous?.status === 'running' && observation.simMs-this.lastCommandAt < 1500) return;
    return { action: 'goto', args: { ...target } };
  }

  private async apply(command: Command, simMs: number): Promise<void> {
    const receipt = await this.port.command(command);
    this.stats.commands++;
    if (receipt.status === 'rejected') { this.stats.rejected++; return; }
    this.lastCommandAt = simMs; this.lastCommandId = command.id;
    this.holding = command.action === 'hold';
    if (this.holding) this.stats.holds++;
  }
}
