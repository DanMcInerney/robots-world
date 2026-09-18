import { common } from 'node-mavlink';
import type { Observation, RobotPort, Scenario, SensorReading, Vec3, Command, Receipt, Json } from '../../src/contracts.ts';
import { aimedDroneKit, projectPoint, radians, yawDegrees } from '../../src/devices/aim-camera.ts';
import { rangeCloud } from '../../src/devices/range-cloud.ts';
import { defaultRegistry } from '../../src/defaults.ts';
import { distance, pose, randomStream, sub, vec } from '../../src/math.ts';
import { MavlinkAdapter, MavlinkCodec, enuToNed } from '../../src/protocols/mavlink.ts';
import { Journal } from '../../src/recorder.ts';
import { World } from '../../src/world.ts';
import { validateAction, type FlightAction } from '../flight-contract.ts';
import { forecast, goalFor, type Menu, type ReactiveState, type Relation, type Target, type Timed } from './contract.ts';
import { DEFAULT_CONFIG, experimentConfig, type ExperimentConfig } from './config.ts';

export type Emit = (kind: string, data: unknown) => void;
export interface SensorExperiment {
  id: string;
  sourceSensor: string;
  configure(scenario: Scenario, registry: ReturnType<typeof defaultRegistry>, kit: ReturnType<typeof aimedDroneKit>): void;
}
const relations: Relation[] = ['left', 'right', 'ahead', 'behind'];
const opposite: Record<Relation, Relation> = { left: 'right', right: 'left', ahead: 'behind', behind: 'ahead' };
export function scenarioFor(seed: number, config: ExperimentConfig = DEFAULT_CONFIG): Scenario {
  const theta = seed % 4 * Math.PI / 2, rng = randomStream(seed, 'layout');
  const placed = (x: number, y: number, z: number) => ({ position: vec(x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta), z), rotation: { x: 0, y: 0, z: Math.sin(theta / 2), w: Math.cos(theta / 2) } });
  return { id: 'changing-survey', seed, dt: .02, gravity: vec(0, 0, -9.81), bounds: vec(40, 40, 10), obstacles: [
    { id: 'ground', mode: 'fixed', pose: pose(0, 0, -.2), shape: { kind: 'box', size: vec(40, 40, .4), color: '#1a2533' } },
    { id: 'screen', mode: 'fixed', pose: placed(1 + rng(), 1.8, 1.5), shape: { kind: 'box', size: vec(1, 2, 3), color: '#718096' } },
    { id: 'crate', mode: 'fixed', pose: placed(-1.5, -2, .8), shape: { kind: 'box', size: vec(1.3, 1.3, 1.6), color: '#ad876c' } },
    { id: 'crossing', mode: 'kinematic', pose: placed(3, -4, 1.4), shape: { kind: 'box', size: vec(.8, 1.2, 2.8), color: '#c77399' } },
  ], robots: [
    { id: 'drone', model: 'aimed-drone', pose: placed(-4, -3, 2.5), config: { maxSpeed: 2, maxAcceleration: 4 }, goal: goalFor(relations[seed % 4]!, config),
      sensors: [{ id: 'odometry', type: 'odometry', hz: 50, latencyMs: 20, noise: config.sensors.odometryNoiseM, maxAgeMs: 120 },
        { id: 'camera', type: 'aim-camera', hz: 10, latencyMs: 80, dropout: .02, maxAgeMs: 350, noise: config.sensors.cameraNoiseUv, config: { targets: ['target/base'], maxRange: 20, rangeNoiseM: config.sensors.cameraRangeNoiseM, detectionDropout: config.sensors.detectionDropout } },
        { id: 'ranges', type: 'range-cloud', hz: 10, latencyMs: 60, noise: .03, dropout: .03, maxAgeMs: 350, config: { azimuths: 24, maxRange: 12, registrationNoiseM: config.sensors.rangeRegistrationNoiseM } },
        { id: 'contact', type: 'contact', hz: 50 }], radio: { latencyMs: 120, jitterMs: 40, loss: .05, rangeM: 40 } },
    { id: 'target', model: 'kinematic', pose: placed(-3, 0, .5), config: { maxSpeed: .7, maxAcceleration: 1.5, color: '#478bff' }, sensors: [{ id: 'odometry', type: 'odometry', hz: 10, noise: .02 }], radio: { latencyMs: 120, jitterMs: 40, loss: .05, rangeM: 40 } },
  ] };
}

/** Only this environment/evaluator can access truth. Decision code receives state() DTOs. */
export class ReactiveWorld {
  readonly world: World;
  private drone: RobotPort; private targetPort: RobotPort; private wire: MavlinkAdapter; private codec = new MavlinkCodec();
  private obs!: Observation; private target: ReactiveState['target'] = null; private live = true; private sequence = 0; private cursor = 0;
  private requested: FlightAction | null = null; private expiresMs = 0; private wireCamera: FlightAction | null = null;
  private commandId = 0; private wireDeadline = 0; private appliedDeadline = 0;
  private controllerStopped = false; private externalController = false;
  private fallbackReason: string | null = 'awaiting-controller'; private fallbackMs = 0; private failures = 0; private guardInterventions = 0; private staleResponses = 0; private rejections = 0; private admissions = 0; private applications = 0;
  private pending: { due: number; bytes: Buffer; camera: FlightAction; goalVersion: number; commandId: number; expiresMs: number }[] = [];
  private routeRandom: () => number; private radioRandom: () => number; private nextTurn = 0; private heading = 0; private speed = .3;
  private relation: Relation; private goalVersion = 1; private goalReceivedMs = 0; private switched = false;
  private phase = { startMs: 0, goal: '', counted: 0, visible: 0, framing: 0, dwell: 0, longestDwellMs: 0, inspectedAt: null as number | null };
  private phases: typeof this.phase[] = []; private contacts = 0; private bounds = 0;
  private history: ReactiveState['lastActions'] = []; readonly trajectory: unknown[] = [];
  private emit: Emit; private cameraTruth: () => { pitchDeg: number; hfovDeg: number }; readonly switchAtMs: number; readonly config: ExperimentConfig;
  private constructor(world: World, emit: Emit, cameraTruth: () => { pitchDeg: number; hfovDeg: number }, switchAtMs: number, config: ExperimentConfig) {
    this.config = config; this.world = world; this.emit = emit; this.cameraTruth = cameraTruth; this.switchAtMs = switchAtMs;
    this.relation = relations[world.scenario.seed % 4]!; this.phase.goal = goalFor(this.relation, this.config);
    this.routeRandom = randomStream(world.scenario.seed, 'unseen-target-motion'); this.radioRandom = randomStream(world.scenario.seed, 'command-link'); this.heading = world.scenario.seed % 4 * Math.PI / 2;
    this.drone = world.claim('drone', 'reactive-controller'); this.targetPort = world.claim('target', 'environment');
    const proxy: RobotPort = { ...this.drone, command: async command => {
      if (!this.wireCamera) throw new Error('Missing dated camera command');
      const receipt = await this.drone.command({ ...command, validForMs: Math.max(1, Math.min(1000, this.wireDeadline - this.world.simMs)), action: 'control', args: { ...command.args, mode: command.action === 'goto' ? 'position' : 'velocity', heading: this.wireCamera.heading, pitch: this.wireCamera.pitch, hfov: this.wireCamera.hfov } });
      if (receipt.status === 'accepted' || receipt.status === 'completed') { this.applications++; this.appliedDeadline = Math.min(this.wireDeadline, this.world.simMs + 1000); this.setFallback(null); }
      return receipt;
    } };
    this.wire = new MavlinkAdapter({ ports: [{ port: proxy, systemId: 1 }], record: world.journal.record, simMs: () => world.simMs });
  }
  private sensorExperiment?: SensorExperiment;
  static async create(seed: number, emit: Emit = () => {}, switchAtMs = 30000, settings: ExperimentConfig = DEFAULT_CONFIG, sensors?: SensorExperiment) {
    const config = experimentConfig(settings);
    const registry = defaultRegistry(), kit = aimedDroneKit(); registry.models.set(kit.model.id, kit.model); registry.sensors.set(kit.camera.id, kit.camera); registry.sensors.set(rangeCloud.id, rangeCloud);
    const scenario = scenarioFor(seed, config);
    sensors?.configure(scenario, registry, kit);
    if (sensors && config.sensors.cooperativeBeacon) throw new Error('Sensor-only experiment cannot enable cooperative target broadcast');
    const instance = new ReactiveWorld(await World.create(scenario, registry, 'rapier', new Journal(4000)), emit, () => kit.inspectCamera('drone'), switchAtMs, config);
    instance.sensorExperiment = sensors;
    for (let i = 0; i < 15; i++) await instance.tick();
    return instance;
  }
  private async acquire() {
    const observation = await this.drone.observe(); if (observation.fault) throw new Error(`Observation fault: ${observation.fault}`);
    for (const packet of observation.inbox) {
      const data = JSON.parse(packet.data) as { acquiredMs: number; value: Target };
      if (!this.target || data.acquiredMs >= this.target.acquiredMs) this.target = { ...data, receivedMs: packet.receivedSimMs, valid: true };
    }
    if ((!this.externalController || this.controllerStopped) && (observation.events.length || observation.inbox.length)) await this.drone.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(p => p.id));
    this.obs = observation;
  }
  state(): ReactiveState {
    if (this.sensorExperiment) throw new Error('Sensor-only experiment has no legacy odometry/target state');
    const timed = <T>(r: SensorReading, value: T): Timed<T> => ({ acquiredMs: r.acquiredSimMs, receivedMs: r.receivedSimMs, valid: r.valid, value });
    const odom = this.obs.sensors.odometry!, camera = this.obs.sensors.camera!, ranges = this.obs.sensors.ranges!;
    const o = odom.value as unknown as { position: Vec3; linearVelocity: Vec3 };
    return structuredClone({ goal: goalFor(this.relation, this.config), goalVersion: this.goalVersion, goalReceivedMs: this.goalReceivedMs, simMs: this.world.simMs,
      odometry: timed(odom, { position: o.position, velocity: o.linearVelocity }), target: this.target,
      camera: timed(camera, camera.value as unknown as ReactiveState['camera']['value']), ranges: timed(ranges, ranges.value as unknown as ReactiveState['ranges']['value']),
      touching: Boolean((this.obs.sensors.contact!.value as { touching: boolean }).touching), lastActions: this.history });
  }
  private setFallback(reason: string | null) {
    if (this.fallbackReason === reason) return;
    this.emit(reason ? 'reactive.fallback' : 'reactive.fallback.end', { simMs: this.world.simMs, reason: reason ?? this.fallbackReason, behavior: 'local hold' });
    this.fallbackReason = reason;
  }
  /** Nonterminal, task-neutral fallback. World acquisition and physics keep running. */
  async hold(reason: string) {
    this.requested = null; this.pending = []; this.commandId++;
    this.appliedDeadline = 0; this.setFallback(reason);
    return this.drone.command({ id: `hold-${++this.sequence}`, action: 'hold', args: {} });
  }
  async failController(reason: string) {
    if (this.failures) return;
    this.controllerStopped = true; this.failures++;
    this.emit('reactive.controller.failed', { simMs: this.world.simMs, reason });
    await this.hold('controller-failed');
  }
  async apply(action: FlightAction, source: Menu['source']) {
    const reject = (reason: string) => { this.rejections++; if (reason === 'stale-observation' || reason === 'superseded-goal') this.staleResponses++; this.emit('reactive.command.rejected', { simMs: this.world.simMs, reason, source }); return { accepted: false, reason }; };
    if (!this.live || this.controllerStopped) return reject('stopped');
    if (source.goalVersion !== this.goalVersion) return reject('superseded-goal');
    if (![source.simMs, source.odometryMs].every(Number.isFinite) || source.simMs > this.world.simMs || source.odometryMs > source.simMs) return reject('invalid-observation-time');
    if (this.world.simMs - source.odometryMs > this.config.sourceAgeLimitMs) return reject('stale-observation');
    let value: FlightAction;
    try { value = validateAction(action); } catch { return reject('invalid-action'); }
    if (!['position', 'velocity'].includes(value.mode)) return reject('unsupported-mode');
    if (this.sensorExperiment) {
      if (value.mode !== 'velocity' || Math.hypot(value.x, value.y, value.z) > 2) return reject('actuator-limits');
    } else if (!forecast(this.state(), value, this.config).safe) return reject('envelope-or-odometry');
    this.admissions++; this.requested = value; this.expiresMs = this.world.simMs + value.duration * 1000;
    this.pending = []; this.commandId++;
    if (this.fallbackReason) this.setFallback('awaiting-delivery');
    this.history.push({ admittedMs: this.world.simMs, action: value, goalVersion: this.goalVersion }); this.history = this.history.slice(-4);
    this.emit('reactive.command.admitted', { simMs: this.world.simMs, commandId: this.commandId, expiresMs: this.expiresMs, source, action: value });
    return { accepted: true, admittedMs: this.world.simMs, meaning: 'admitted to lossy delayed setpoint stream; inspect protocol/model receipts for application' };
  }
  /** Existing RobotPort boundary, with this experiment's admission/transport policy. */
  controllerPort(): RobotPort {
    if (this.externalController) throw new Error('Controller port already claimed');
    this.externalController = true;
    const sources = new Map<number, Menu['source']>(), receipts = new Map<string, { fingerprint: string; receipt: Promise<Receipt> }>();
    return Object.freeze({ robotId: 'drone',
      describe: async () => {
        const description = await this.drone.describe();
        description.commands.control!.description += ' Movement lifetime is validForMs (default experiment lifetime, maximum 8000 ms). Supply basedOn.observation or args.observation from an observation actually delivered through this port. Neither background sensing nor a later tool call refreshes an old decision. Admission is not application.';
        const schema = description.commands.control!.schema; schema.properties = { ...(schema.properties as object), observation: { type: 'integer', minimum: 1, description: 'Source observation.sequence (alternative to command.basedOn).' } };
        if (!this.sensorExperiment) description.sensors.push({ id: 'target', type: 'received-cooperative-beacon', hz: 10 });
        return description;
      },
      observe: async () => {
        if (!this.live || this.controllerStopped) throw new Error('Controller stopped');
        const observation = await this.drone.observe();
        observation.goal = goalFor(this.relation, this.config);
        const target = this.target;
        if (!this.sensorExperiment) observation.sensors.target = { value: target?.value as unknown as Json ?? null, acquiredSimMs: target?.acquiredMs ?? 0, receivedSimMs: target?.receivedMs ?? 0, valid: !!target && observation.simMs - target.acquiredMs <= 1000, sequence: target?.acquiredMs ?? 0 };
        sources.set(observation.sequence, { simMs: observation.simMs, odometryMs: observation.sensors[this.sensorExperiment?.sourceSensor ?? 'odometry']!.acquiredSimMs, goalVersion: this.goalVersion });
        if (sources.size > 64) sources.delete(sources.keys().next().value!);
        this.emit('reactive.port.observation', observation);
        return observation;
      },
      command: async (command: Command): Promise<Receipt> => {
        const deny = (reason: string): Receipt => ({ id: command.id, status: 'rejected', reason });
        if (!this.live || this.controllerStopped) return deny('stopped');
        const fingerprint = JSON.stringify(command), prior = receipts.get(command.id);
        if (!/^[A-Za-z0-9_.:-]{1,96}$/.test(command.id) || Buffer.byteLength(fingerprint) > 16384) return deny('invalid-command');
        if (prior) { const receipt = await prior.receipt; return prior.fingerprint === fingerprint ? { ...receipt, status: receipt.status === 'rejected' ? 'rejected' : 'duplicate' } : deny('id-conflict'); }
        if (receipts.size >= 10000) return deny('command-capacity');
        this.emit('reactive.port.request', { simMs: this.world.simMs, command });
        const source = sources.get(command.basedOn?.observation ?? Number(command.args.observation ?? -1));
        const pending = Promise.resolve().then(async () => {
        if (!this.live || this.controllerStopped) return deny('stopped');
        let receipt: Receipt;
        if (command.action === 'hold' && Object.keys(command.args).length === 0) { await this.hold('controller-hold'); receipt = { id: command.id, status: 'completed', appliedSimMs: this.world.simMs }; }
        else if (!source) receipt = deny('observation-required');
        else if (command.basedOn && (!Number.isFinite(command.basedOn.maxAgeMs) || command.basedOn.maxAgeMs < 0 || this.world.simMs - source.simMs > command.basedOn.maxAgeMs)) receipt = deny('stale-observation');
        else if (command.action !== 'control') receipt = deny('unsupported-command');
        else {
          const { observation: _source, ...args } = command.args;
          const result = await this.apply({ ...args, duration: (command.validForMs ?? this.config.commandSeconds * 1000) / 1000 } as FlightAction, source);
          receipt = result.accepted ? { id: command.id, status: 'accepted' } : deny('reason' in result ? result.reason : 'rejected');
        }
        this.emit('reactive.port.command', { simMs: this.world.simMs, command, source, receipt });
        return receipt;
        });
        receipts.set(command.id, { fingerprint, receipt: pending });
        return pending;
      },
      acknowledge: async (throughEvent: number, packets?: string[]) => { if (!this.live || this.controllerStopped) throw new Error('Controller stopped'); await this.drone.acknowledge(throughEvent, packets); },
      send: (packet: Parameters<RobotPort['send']>[0]) => this.live && !this.controllerStopped ? this.drone.send(packet) : Promise.resolve({ accepted: false, reason: 'stopped' }),
      stop: async () => { if (!this.controllerStopped) { this.controllerStopped = true; await this.hold('controller-stop'); } },
      close: async () => { if (!this.controllerStopped) { this.controllerStopped = true; await this.hold('controller-close'); } },
    });
  }
  private async stream() {
    if (!this.requested) return;
    const message = new common.SetPositionTargetLocalNed(), a = this.requested;
    Object.assign(message, { targetSystem: 1, targetComponent: 1, coordinateFrame: 1, typeMask: a.mode === 'position' ? 3576 : 3527, timeBootMs: Math.round(this.world.simMs), ...Object.fromEntries(Object.entries(enuToNed(a)).map(([k, v]) => [a.mode === 'position' ? k : `v${k}`, v])) });
    const bytes = this.codec.encode(message);
    if (this.radioRandom() < this.config.link.loss) { this.emit('reactive.command-link.drop', { simMs: this.world.simMs, hex: bytes.toString('hex') }); return; }
    if (this.pending.length >= 16) throw new Error('Command link backpressure');
    this.pending.push({ due: this.world.simMs + this.config.link.latencyMs + this.radioRandom() * this.config.link.jitterMs, bytes, camera: a, goalVersion: this.goalVersion, commandId: this.commandId, expiresMs: this.expiresMs });
  }
  async tick() {
    if (!this.live) throw new Error('World closed');
    const t = this.world.simMs, seed = this.world.scenario.seed;
    if (!this.switched && t >= this.switchAtMs) {
      this.phases.push({ ...this.phase }); this.relation = opposite[this.relation]; this.goalVersion++; this.goalReceivedMs = t; this.switched = true;
      this.phase = { startMs: t, goal: goalFor(this.relation, this.config), counted: 0, visible: 0, framing: 0, dwell: 0, longestDwellMs: 0, inspectedAt: null };
      await this.hold(this.controllerStopped ? 'controller-failed-or-stopped' : 'goal-change');
      this.emit('reactive.goal', { simMs: t, goalVersion: this.goalVersion, goal: this.phase.goal });
    }
    if (this.requested && t >= this.expiresMs) { this.emit('reactive.expired', { simMs: t }); await this.hold('command-expired'); }
    if (t >= this.nextTurn) {
      this.heading += (this.routeRandom() * 2 - 1) * 1.5; this.speed = .2 + this.routeRandom() * .45; this.nextTurn = t + 4500 + Math.floor(this.routeRandom() * 5000);
      // This private event goes only to the evaluator trace, never to a model request.
      this.emit('reactive.stimulus.turn', { simMs: t, heading: this.heading, speed: this.speed });
    }
    if (Math.round(t) % 100 === 0) {
      const body = this.world.physics.body('target/base');
      if (Math.abs(body.pose.position.x) > 10 || Math.abs(body.pose.position.y) > 10) this.heading = Math.atan2(-body.pose.position.y, -body.pose.position.x);
      const delta = Math.atan2(Math.sin(this.heading - radians(yawDegrees(body.pose.rotation))), Math.cos(this.heading - radians(yawDegrees(body.pose.rotation))));
      await this.targetPort.command({ id: `target-${++this.sequence}`, action: 'velocity', args: { x: this.speed * Math.cos(this.heading), y: this.speed * Math.sin(this.heading), z: 0, yawRate: Math.max(-1.5, Math.min(1.5, delta * 3)) }, validForMs: 500 });
      const observation = await this.targetPort.observe(), odom = observation.sensors.odometry!;
      if (odom.valid) { const sample = odom.value as unknown as { position: Vec3; linearVelocity: Vec3; rotation: { x: number; y: number; z: number; w: number } };
        // A bounded radio blackout is an environmental impairment, unknown in advance to models.
        if (this.config.sensors.cooperativeBeacon && !(t > 18000 && t < 20200)) await this.targetPort.send({ id: `beacon-${this.sequence}`, to: 'drone', ttlMs: 500, data: JSON.stringify({ acquiredMs: odom.acquiredSimMs, value: { position: sample.position, velocity: sample.linearVelocity, headingDeg: yawDegrees(sample.rotation) } }) }); }
      if (observation.events.length) await this.targetPort.acknowledge(observation.events.at(-1)!.id);
      await this.stream();
    }
    const theta = seed % 4 * Math.PI / 2, crossing = this.world.physics.body('crossing').pose.position;
    const localY = -crossing.x * Math.sin(theta) + crossing.y * Math.cos(theta), desiredY = 4 * Math.sin(t / 7000 + seed % 7);
    this.world.physics.velocity('crossing', vec(-Math.sin(theta) * (desiredY - localY), Math.cos(theta) * (desiredY - localY), 0));
    for (const packet of this.pending.filter(p => p.due <= t)) {
      if (packet.goalVersion !== this.goalVersion || packet.commandId !== this.commandId || packet.expiresMs <= t) continue;
      if (!this.sensorExperiment && !forecast(this.state(), packet.camera, this.config, (packet.expiresMs - t) / 1000, 0).safe) { this.guardInterventions++; await this.hold('delivery-envelope-or-odometry'); break; }
      this.wireCamera = packet.camera; this.wireDeadline = packet.expiresMs; await this.wire.receive(packet.bytes);
      this.emit('reactive.camera.command', { simMs: t, transport: 'local JSON attached to dated MAVLink setpoint', commandId: packet.commandId, expiresMs: packet.expiresMs, remainingMs: packet.expiresMs - t, ...packet.camera });
    }
    this.pending = this.pending.filter(p => p.due > t);
    await this.world.advance(); await this.acquire();
    if (this.appliedDeadline && this.world.simMs >= this.appliedDeadline) { this.appliedDeadline = 0; this.setFallback('setpoint-deadman'); }
    this.measure();
    const events = this.world.journal.after(this.cursor);
    if (events.length && events[0]!.id !== this.cursor + 1) throw new Error('Evidence gap');
    for (const event of events) { if (event.truncated) throw new Error('Truncated evidence'); this.emit('world.event', event); this.cursor = event.id; }
  }
  private measure() {
    const drone = this.world.physics.body('drone/base'), target = this.world.physics.body('target/base'), camera = this.cameraTruth(), p = drone.pose.position;
    const projection = projectPoint(p, target.pose.position, yawDegrees(drone.pose.rotation), camera.pitchDeg, camera.hfovDeg);
    const hit = this.world.physics.ray(p, sub(target.pose.position, p), projection.range, ['drone/base']);
    const visible = projection.inFrame && projection.range <= 20 && hit?.body === 'target/base';
    const d = sub(p, target.pose.position), theta = radians(yawDegrees(target.pose.rotation)), horizontal = Math.hypot(d.x, d.y);
    const forward = d.x * Math.cos(theta) + d.y * Math.sin(theta), left = -d.x * Math.sin(theta) + d.y * Math.cos(theta);
    const dot = ({ ahead: forward, behind: -forward, left, right: -left }[this.relation]) / Math.max(.001, horizontal);
    const framed = visible && Math.abs(projection.u) <= .5 && Math.abs(projection.v) <= .5 && dot >= .7 && projection.range >= 2.5 && projection.range <= 6;
    this.phase.dwell = framed ? this.phase.dwell + 20 : 0; this.phase.longestDwellMs = Math.max(this.phase.longestDwellMs, this.phase.dwell);
    if (this.phase.dwell >= this.config.scoring.minimumDwellMs && this.phase.inspectedAt === null) this.phase.inspectedAt = this.world.simMs;
    if (this.world.simMs > this.phase.startMs + this.config.scoring.warmupMs) { this.phase.counted++; if (visible) this.phase.visible++; if (framed) this.phase.framing++; }
    if (this.world.physics.contacts().some(c => c.a === 'drone/base' || c.b === 'drone/base')) this.contacts++;
    if (Math.abs(p.x) > 18 || Math.abs(p.y) > 18 || p.z < .7 || p.z > 6) this.bounds++;
    if (this.fallbackReason) this.fallbackMs += 20;
    if (Math.round(this.world.simMs) % 100 === 0) {
      const frame = { fallback: this.fallbackReason, controllerStopped: this.controllerStopped, simMs: this.world.simMs, drone: p, target: target.pose.position, heading: yawDegrees(drone.pose.rotation), pitch: camera.pitchDeg, hfov: camera.hfovDeg, visible, inspectable: framed, goalVersion: this.goalVersion, crossing: this.world.physics.body('crossing').pose.position };
      this.trajectory.push(frame); this.emit('reactive.evaluation.frame', frame);
    }
  }
  evaluate() {
    const phases = [...this.phases, this.phase].map(p => ({ goal: p.goal, startMs: p.startMs, scoredMs: p.counted * 20, visibleFraction: p.counted ? p.visible / p.counted : 0, framingFraction: p.counted ? p.framing / p.counted : 0, longestDwellMs: p.longestDwellMs, inspectedAt: p.inspectedAt, firstAttainmentMs: p.inspectedAt === null ? null : p.inspectedAt - p.startMs }));
    const legacySuccess = phases.length === 2 && phases.every(p => p.longestDwellMs >= 1000 && p.visibleFraction >= .5) && !this.contacts && !this.bounds;
    return { metric: this.config.scoring, success: phases.length === 2 && phases.every(p => p.inspectedAt !== null && p.framingFraction >= this.config.scoring.minimumFramingFraction) && !this.contacts && !this.bounds && !this.failures && !this.guardInterventions, legacySuccess, phases,
      controlAdmissions: this.admissions, appliedSetpoints: this.applications, controllerFailures: this.failures, guardInterventions: this.guardInterventions, staleResponses: this.staleResponses, rejectedCommands: this.rejections, fallbackMs: this.fallbackMs, fallbackAtEnd: this.fallbackReason,
      visibleFraction: phases.reduce((s, p) => s + p.visibleFraction, 0) / phases.length, inspectionAtMs: phases.every(p => p.inspectedAt !== null) ? phases.at(-1)!.inspectedAt : null,
      collisionTicks: this.contacts, boundsTicks: this.bounds, trajectory: this.trajectory };
  }
  async close() { if (!this.live) return; this.live = false; this.requested = null; this.pending = []; this.wire.close(); try { await this.drone.stop(); await this.targetPort.stop(); } finally { this.world.close(); } }
}
