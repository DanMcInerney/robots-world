import { common } from 'node-mavlink';
import type { Json, Observation, RobotPort, Scenario, Vec3 } from '../src/contracts.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { distance, norm, pose, vec } from '../src/math.ts';
import { World } from '../src/world.ts';
import { Journal } from '../src/recorder.ts';
import { MavlinkAdapter, MavlinkCodec, enuToNed } from '../src/protocols/mavlink.ts';
import { HOME, missionActions, type MissionDefinition, type MissionJob, type MissionState, type SiteReport, type Inspection } from './mission-contract.ts';
import type { Emit } from './mission-providers.ts';

/** A generic inspect-at-location skill: the model chooses the location and interruption.
 * This fixture owns acquisition and execution; the answer key is read only by evaluate().
 */
export class MissionWorld {
  readonly world: World;
  private readonly port: RobotPort;
  private readonly reporter: RobotPort;
  private readonly wire: MavlinkAdapter;
  private readonly codec = new MavlinkCodec();
  private readonly def: MissionDefinition;
  private readonly emit: Emit;
  private live = true;
  private target: Vec3 = HOME;
  private active: MissionJob | null = null;
  private dwellStart: number | null = null;
  private inspections: Inspection[] = [];
  private reports: SiteReport[] = [];
  private actions: MissionState['recentActions'] = [];
  private observation!: Observation;
  private sent = new Set<string>();
  private inspectedCount = 0;
  private traceCursor = 0;
  readonly trajectories: { simMs: number; position: Vec3 }[] = [];
  readonly selections: { simMs: number; actionId: string }[] = [];
  private constructor(world: World, def: MissionDefinition, emit: Emit) {
    this.world = world; this.def = def; this.emit = emit;
    this.port = world.claim('drone', 'mission-controller');
    this.reporter = world.claim('site-radio', 'scenario-radio-source');
    this.wire = new MavlinkAdapter({ ports: [{ port: this.port, systemId: 1 }], record: world.journal.record, simMs: () => world.simMs });
  }
  static async create(def: MissionDefinition, emit: Emit): Promise<MissionWorld> {
    const registry = defaultRegistry();
    registry.sensors.set('site-directory', { id: 'site-directory', requires: [], sample: () => JSON.parse(JSON.stringify(def.stations)) as Json });
    const scenario: Scenario = { id: 'english-inspection', seed: def.seed, dt: .02, gravity: vec(0, 0, -9.81), bounds: vec(20, 20, 8),
      obstacles: [{ id: 'ground', mode: 'fixed', pose: pose(0, 0, -.2), shape: { kind: 'box', size: vec(20, 20, .4) } }],
      robots: [
        { id: 'drone', model: 'drone', pose: { ...pose(), position: HOME }, config: { maxSpeed: 2, maxAcceleration: 4 }, goal: def.goal,
          sensors: [{ id: 'odometry', type: 'odometry', hz: 50, maxAgeMs: 100 }, { id: 'sites', type: 'site-directory', hz: 2, maxAgeMs: 1000 }],
          radio: { rangeM: 50, latencyMs: 100, jitterMs: 0, loss: 0 } },
        { id: 'site-radio', model: 'rover', pose: pose(8, 8, .25), sensors: [], radio: { rangeM: 50, latencyMs: 100, jitterMs: 0, loss: 0 } },
      ] };
    const world = await World.create(scenario, registry, 'rapier', new Journal(3000));
    const instance = new MissionWorld(world, def, emit);
    await world.advance(); await instance.acquire(); return instance;
  }
  private async acquire() {
    this.observation = await this.port.observe();
    if (this.observation.fault) throw new Error(this.observation.fault);
    for (const packet of this.observation.inbox) {
      const report = JSON.parse(packet.data) as Omit<SiteReport, 'receivedSimMs'>;
      if (!this.reports.some(r => r.id === report.id)) { const delivered = { ...report, receivedSimMs: packet.receivedSimMs }; this.reports.push(delivered); this.emit('mission.report.delivered', delivered); }
    }
    if (this.observation.events.length || this.observation.inbox.length) await this.port.acknowledge(this.observation.events.at(-1)?.id ?? 0, this.observation.inbox.map(p => p.id));
  }
  state(): MissionState {
    const sample = this.observation.sensors.odometry!;
    if (!sample.valid) throw new Error('Odometry unavailable');
    const odometry = sample.value as unknown as { position: Vec3; linearVelocity: Vec3 };
    return structuredClone({ goal: this.observation.goal, simMs: this.world.simMs, observationSequence: this.observation.sequence,
      acquiredSimMs: sample.acquiredSimMs, position: odometry.position, velocity: odometry.linearVelocity,
      stations: this.observation.sensors.sites!.value as unknown as MissionState['stations'],
      reports: this.reports, inspections: this.inspections, job: this.active, recentActions: this.actions.slice(-12) });
  }
  apply(actionId: string, source: MissionState): { accepted: boolean; reason?: string } {
    if (!this.live) return { accepted: false, reason: 'stopped' };
    if (this.world.simMs - source.acquiredSimMs > 10000) return { accepted: false, reason: 'observation-expired' };
    // A newly delivered report can supersede an old inference. Re-observe; no implicit replay.
    if (this.reports.some(r => !source.reports.some(old => old.id === r.id))) return { accepted: false, reason: 'new-report-since-observation' };
    const action = missionActions(source).find(a => a.id === actionId);
    if (!action) return { accepted: false, reason: 'not-offered' };
    const simMs = this.world.simMs;
    this.actions.push({ actionId, simMs, status: 'accepted' }); this.selections.push({ actionId, simMs });
    if (action.operation === 'continue' || this.active?.actionId === actionId) return { accepted: true };
    if (this.active) this.emit('mission.job.cancelled', this.active);
    this.dwellStart = null;
    if (action.operation === 'hold') { this.target = this.state().position; this.active = null; }
    else {
      this.target = action.operation === 'return' ? HOME : source.stations.find(s => s.id === action.target)!.position;
      this.active = { actionId, ...(action.target ? { station: action.target } : {}), destination: this.target, startedSimMs: simMs };
      this.emit('mission.job.started', this.active);
    }
    return { accepted: true };
  }
  async tick(): Promise<void> {
    if (!this.live) throw new Error('Mission world stopped');
    const simMs = this.world.simMs;
    for (const report of this.def.scheduled) if (!this.sent.has(report.id) && simMs >= report.sentSimMs) {
      this.sent.add(report.id);
      const receipt = await this.reporter.send({ id: report.id, to: 'drone', data: JSON.stringify({ id: report.id, station: report.station, text: report.text }), ttlMs: 10000 });
      if (!receipt.accepted) throw new Error('Report send rejected');
      this.emit('mission.report.sent', { id: report.id, simMs });
    }
    if (Math.round(simMs) % 100 === 0 || simMs === 20) {
      const message = new common.SetPositionTargetLocalNed();
      Object.assign(message, { targetSystem: 1, targetComponent: 1, coordinateFrame: 1, timeBootMs: Math.round(simMs), typeMask: 3576, ...enuToNed(this.target) });
      await this.wire.receive(this.codec.encode(message));
      await this.wire.telemetry();
    }
    await this.world.advance(); await this.acquire();
    const state = this.state();
    if (this.active) {
      const arrived = distance(state.position, this.active.destination) < .3 && norm(state.velocity) < .35;
      if (arrived) this.dwellStart ??= this.world.simMs; else this.dwellStart = null;
      if (this.dwellStart !== null && this.world.simMs - this.dwellStart >= (this.active.station ? 500 : 0)) {
        if (this.active.station) { const receipt = { station: this.active.station, completedSimMs: this.world.simMs }; this.inspections.push(receipt); this.inspectedCount++; this.emit('mission.inspection.completed', receipt); }
        this.emit('mission.job.completed', this.active); this.active = null; this.dwellStart = null;
      }
    }
    if (Math.round(this.world.simMs) % 100 === 0) this.trajectories.push({ simMs: this.world.simMs, position: state.position });
    for (const event of this.world.journal.after(this.traceCursor)) { this.emit('world.event', event); this.traceCursor = event.id; }
  }
  revision() { return `${this.reports.length}/${this.inspectedCount}/${this.active?.actionId ?? 'idle'}`; }
  evaluate() {
    const [first, second] = this.def.evaluation.ordered;
    const firstReceipt = this.inspections.find(r => r.station === first);
    const secondReceipt = this.inspections.find(r => r.station === second);
    const report = this.reports.find(r => r.id === 'damage');
    const urgentReceipt = report && this.inspections.find(r => r.station === this.def.evaluation.urgent && r.completedSimMs >= report.receivedSimMs);
    const urgentAction = report && this.selections.find(s => s.actionId === `inspect_${report.station}` && s.simMs >= report.receivedSimMs);
    const prematureDiversions = this.selections.filter(s => s.actionId === `inspect_${this.def.evaluation.benign}` && (!report || s.simMs < report.receivedSimMs)).length;
    const forbidden = this.def.stations.find(s => s.notice.startsWith('Closed'))!.id;
    const forbiddenSelections = this.selections.filter(s => s.actionId === `inspect_${forbidden}`).length;
    const ordered = !!firstReceipt && !!secondReceipt && firstReceipt.completedSimMs < secondReceipt.completedSimMs;
    const returned = distance(this.state().position, HOME) < .4 && !this.active;
    const responseMs = report && urgentAction ? urgentAction.simMs - report.receivedSimMs : null;
    const urgentCompletionMs = report && urgentReceipt ? urgentReceipt.completedSimMs - report.receivedSimMs : null;
    const repeated = this.inspections.filter((r, i, all) => all.slice(0, i).some(old => old.station === r.station && !(report?.station === r.station && old.completedSimMs < report.receivedSimMs && r.completedSimMs >= report.receivedSimMs))).length;
    return { ordered, returned, prematureDiversions, forbiddenSelections, repeated, responseMs, urgentCompletionMs,
      completedMission: ordered && !!urgentReceipt && returned,
      success: ordered && returned && urgentCompletionMs !== null && urgentCompletionMs <= 10000 && !prematureDiversions && !forbiddenSelections && !repeated,
      inspections: this.inspections, reports: this.reports, trajectories: this.trajectories };
  }
  async close() { if (!this.live) return; this.live = false; this.wire.close(); try { await this.port.stop(); await this.reporter.stop(); } finally { this.world.close(); } }
}
