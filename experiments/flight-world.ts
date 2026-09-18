import { common } from 'node-mavlink';
import type { Json, Observation, RobotPort, Scenario } from '../src/contracts.ts';
import { aimedDroneKit, degrees, projectPoint, radians, wrapDegrees, yawDegrees } from '../src/devices/aim-camera.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { distance, pose, sub, vec } from '../src/math.ts';
import { MavlinkAdapter, MavlinkCodec, enuToNed } from '../src/protocols/mavlink.ts';
import { Journal } from '../src/recorder.ts';
import { World } from '../src/world.ts';
import { validateAction, type FlightAction, type FlightState } from './flight-contract.ts';

export type FlightEmit = (kind: string, data: unknown) => void;
export function flightScenario(seed: number): Scenario {
  const turn = seed % 3 * Math.PI / 2, side = seed % 2 ? 'left' : 'right';
  const placed = (x: number, y: number, z: number, heading = 0) => ({ position: vec(x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn), z), rotation: { x: 0, y: 0, z: Math.sin((heading + turn) / 2), w: Math.cos((heading + turn) / 2) } });
  const goal = `Follow the blue survey rover as it drives and turns. Keep it in the camera while maneuvering around obstacles. Inspect its ${side} side for at least one continuous second: be on that side relative to its current heading, 2.5 to 6 metres from its centre, with its centre in the central half of the camera image. Keep the rover visible at least 50 percent of the time after the first 5 seconds, and remain within 10 metres at least 70 percent of that time. Do not collide. Stay between altitude 0.7 and 6 metres and inside x,y +/-18 metres. Continue following for the entire trial. The cooperative rover transmits measured pose and velocity, but its future route is unknown. You must choose movement and camera controls; no automatic following or aiming is available.`;
  return { id: 'maneuver-camera', seed, dt: .02, gravity: vec(0, 0, -9.81), bounds: vec(40, 40, 10),
    obstacles: [
      { id: 'ground', mode: 'fixed', pose: pose(0, 0, -.2), shape: { kind: 'box', size: vec(40, 40, .4), color: '#1a2533' } },
      { id: 'screen', mode: 'fixed', pose: placed(-.5, 2.1, 1.5), shape: { kind: 'box', size: vec(1.2, 2, 3), color: '#718096' } },
      { id: 'crate', mode: 'fixed', pose: placed(2.5, -1.8, .9), shape: { kind: 'box', size: vec(1.8, 1.6, 1.8), color: '#ad876c' } },
    ], robots: [
      { id: 'drone', model: 'aimed-drone', pose: placed(-4, side === 'left' ? -3.5 : 3.5, 2.4, side === 'left' ? Math.PI / 2 : -Math.PI / 2), config: { maxSpeed: 2, maxAcceleration: 4 }, goal,
        sensors: [{ id: 'odometry', type: 'odometry', hz: 50, maxAgeMs: 100 }, { id: 'camera', type: 'aim-camera', hz: 10, latencyMs: 60, maxAgeMs: 250, config: { targets: ['target/base'], maxRange: 20 } },
          { id: 'lidar', type: 'lidar', hz: 10, latencyMs: 40, maxAgeMs: 250, config: { rays: 16, maxRange: 10 } }, { id: 'contact', type: 'contact', hz: 50 }],
        radio: { latencyMs: 100, jitterMs: 20, loss: .02, rangeM: 50 } },
      { id: 'target', model: 'kinematic', pose: placed(-4, 0, .5), config: { maxSpeed: .6, maxAcceleration: 2, color: '#478bff' }, sensors: [{ id: 'odometry', type: 'odometry', hz: 10 }],
        radio: { latencyMs: 100, jitterMs: 20, loss: .02, rangeM: 50 } },
    ] };
}

/** Experiment owns the target stimulus/evaluator. Controller inputs come only from its RobotPort. */
export class FlightWorld {
  readonly world: World;
  private port: RobotPort;
  private targetPort: RobotPort;
  private wire: MavlinkAdapter;
  private codec = new MavlinkCodec();
  private observation!: Observation;
  private beacon: unknown = null;
  private active: FlightState['active'] = null;
  private desired: FlightAction = { mode: 'position', x: 0, y: 0, z: 2.4, heading: 0, pitch: -30, hfov: 70, duration: 8 };
  private live = true;
  private cursor = 0;
  private serial = 0;
  private emit: FlightEmit;
  private cameraTruth: () => { pitchDeg: number; hfovDeg: number };
  private side: number;
  private counted = 0;
  private visible = 0;
  private near = 0;
  private currentDwell = 0;
  private longestDwell = 0;
  private inspectionAt: number | null = null;
  private collisionTicks = 0;
  private boundsTicks = 0;
  readonly trajectory: unknown[] = [];
  private constructor(world: World, emit: FlightEmit, cameraTruth: () => { pitchDeg: number; hfovDeg: number }) {
    this.cameraTruth = cameraTruth;
    this.world = world; this.emit = emit; this.side = world.scenario.seed % 2 ? 1 : -1;
    this.port = world.claim('drone', 'flight-controller'); this.targetPort = world.claim('target', 'scenario-stimulus');
    const initial = world.scenario.robots[0]!.pose;
    Object.assign(this.desired, initial.position, { heading: yawDegrees(initial.rotation) });
    // Movement is parsed from genuine MAVLink bytes, then combined with the independently
    // selected camera setpoint into one leased actuator command. Camera fields are local JSON,
    // not mislabeled as implemented MAVLink gimbal messages.
    const coupledPort: RobotPort = { ...this.port, command: async command => {
      const receipt = await this.port.command({ ...command, action: 'control', args: { ...command.args, mode: command.action === 'goto' ? 'position' : 'velocity', heading: this.desired.heading, pitch: this.desired.pitch, hfov: this.desired.hfov } });
      if (receipt.status === 'rejected') throw new Error(`Actuator rejected: ${receipt.reason}`);
      return receipt;
    } };
    this.wire = new MavlinkAdapter({ ports: [{ port: coupledPort, systemId: 1 }], record: world.journal.record, simMs: () => world.simMs });
  }
  static async create(seed: number, emit: FlightEmit = () => {}) {
    const registry = defaultRegistry(), kit = aimedDroneKit(); registry.models.set(kit.model.id, kit.model); registry.sensors.set(kit.camera.id, kit.camera);
    const instance = new FlightWorld(await World.create(flightScenario(seed), registry, 'rapier', new Journal(3000)), emit, () => kit.inspectCamera('drone'));
    for (let i = 0; i < 10; i++) await instance.tick();
    return instance;
  }
  private async acquire() {
    const observation = await this.port.observe();
    for (const packet of observation.inbox) this.beacon = { ...JSON.parse(packet.data), receivedSimMs: packet.receivedSimMs };
    if (observation.events.length || observation.inbox.length) await this.port.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(p => p.id));
    if (observation.fault) throw new Error(`Robot fault: ${observation.fault}`);
    this.observation = observation;
  }
  state(): FlightState {
    const odometry = this.observation.sensors.odometry!;
    if (!odometry.valid) throw new Error('Invalid odometry');
    const position = (odometry.value as unknown as { position: FlightState['position'] }).position;
    const camera = this.observation.sensors.camera!.value as unknown as FlightState['camera'];
    // Completed transport jobs are diagnostic history, not thousands of model tokens per step.
    const observation = structuredClone(this.observation); observation.jobs = observation.jobs.filter(j => j.status === 'running');
    let measuredGeometry: unknown = null;
    const beacon = this.beacon as { position: FlightState['position']; headingDeg: number; acquiredSimMs: number } | null;
    if (beacon && this.world.simMs - beacon.acquiredSimMs <= 1000) {
      const delta = sub(beacon.position, position), horizontal = Math.hypot(delta.x, delta.y), heading = radians(beacon.headingDeg);
      const bearingDeg = degrees(Math.atan2(delta.y, delta.x)), elevationDeg = degrees(Math.atan2(delta.z, horizontal));
      measuredGeometry = { derivedOnlyFromDeliveredSamples: true, odometryAcquiredSimMs: odometry.acquiredSimMs, beaconAcquiredSimMs: beacon.acquiredSimMs, beaconAgeMs: this.world.simMs - beacon.acquiredSimMs,
        roverMinusDroneENU: delta, rangeM: distance(position, beacon.position), bearingDeg, elevationDeg,
        cameraHeadingErrorDeg: wrapDegrees(bearingDeg - camera.headingDeg), cameraPitchErrorDeg: elevationDeg - camera.pitchDeg,
        droneOffsetInRoverFrame: { forwardM: -delta.x * Math.cos(heading) - delta.y * Math.sin(heading), leftM: delta.x * Math.sin(heading) - delta.y * Math.cos(heading), upM: -delta.z },
      };
    }
    return structuredClone({ goal: observation.goal, simMs: this.world.simMs, observation, position, camera, beacon: this.beacon, measuredGeometry, active: this.active });
  }
  async apply(value: unknown, source: FlightState) {
    if (!this.live) return { accepted: false, reason: 'stopped' };
    if (this.world.simMs - source.observation.sensors.odometry!.acquiredSimMs > 30000) return { accepted: false, reason: 'stale-observation' };
    const action = validateAction(value);
    const xyz = action.mode === 'hold' ? this.state().position : action;
    if (action.mode !== 'continue') {
      this.desired = { ...action, x: xyz.x, y: xyz.y, z: xyz.z, mode: action.mode === 'hold' ? 'position' : action.mode };
      this.active = { action, expiresSimMs: this.world.simMs + action.duration * 1000 };
    } else Object.assign(this.desired, { heading: action.heading, pitch: action.pitch, hfov: action.hfov });
    this.emit('flight.camera.command', { simMs: this.world.simMs, transport: 'local RobotPort JSON', heading: action.heading, pitch: action.pitch, hfov: action.hfov });
    await this.transmit();
    return { accepted: true, appliedSimMs: this.world.simMs };
  }
  private async transmit() {
    const message = new common.SetPositionTargetLocalNed();
    Object.assign(message, { targetSystem: 1, targetComponent: 1, coordinateFrame: 1, timeBootMs: Math.round(this.world.simMs) });
    if (this.desired.mode === 'velocity') { const v = enuToNed(this.desired); Object.assign(message, { typeMask: 3527, vx: v.x, vy: v.y, vz: v.z }); }
    else Object.assign(message, { typeMask: 3576, ...enuToNed(this.desired) });
    await this.wire.receive(this.codec.encode(message)); await this.wire.telemetry();
  }
  async tick() {
    if (!this.live) throw new Error('World stopped');
    const t = this.world.simMs;
    if (Math.round(t) % 100 === 0) {
      // Only environment stimulus owns this route. Controllers learn it through sensors/radio.
      const heading = this.world.scenario.seed % 3 * Math.PI / 2 + (t < 14000 ? 0 : t < 28000 ? Math.PI / 2 : t < 38000 ? Math.PI : -Math.PI / 2);
      const body = this.world.physics.body('target/base');
      const delta = Math.atan2(Math.sin(heading - radians(yawDegrees(body.pose.rotation))), Math.cos(heading - radians(yawDegrees(body.pose.rotation))));
      await this.targetPort.command({ id: `target-${++this.serial}`, action: 'velocity', args: { x: .45 * Math.cos(heading), y: .45 * Math.sin(heading), z: 0, yawRate: Math.max(-1.5, Math.min(1.5, delta * 4)) }, validForMs: 500 });
      const targetObservation = await this.targetPort.observe();
      const odom = targetObservation.sensors.odometry;
      if (odom?.valid) {
        const sample = odom.value as unknown as { position: FlightState['position']; linearVelocity: FlightState['position']; rotation: { x: number; y: number; z: number; w: number } };
        await this.targetPort.send({ id: `beacon-${this.serial}`, to: 'drone', data: JSON.stringify({ acquiredSimMs: odom.acquiredSimMs, id: 'target/base', position: sample.position, velocity: sample.linearVelocity, headingDeg: yawDegrees(sample.rotation) }), ttlMs: 500 });
      }
      if (targetObservation.events.length) await this.targetPort.acknowledge(targetObservation.events.at(-1)!.id);
      if (this.active && t >= this.active.expiresSimMs) {
        const position = (this.observation.sensors.odometry!.value as unknown as { position: FlightState['position'] }).position;
        this.desired = { ...this.desired, ...position, mode: 'position' }; this.active = null;
        this.emit('flight.command.expired', { simMs: t });
      }
      await this.transmit();
    }
    await this.world.advance(); await this.acquire(); this.measure();
    const records = this.world.journal.after(this.cursor);
    if (records.length && records[0]!.id !== this.cursor + 1) throw new Error('Journal evidence gap');
    for (const event of records) { if (event.truncated) throw new Error('Journal evidence truncated'); this.emit('world.event', event); this.cursor = event.id; }
  }
  private measure() {
    const drone = this.world.physics.body('drone/base'), target = this.world.physics.body('target/base'), p = drone.pose.position;
    // Only the evaluator gets actual current camera state; model inputs retain acquisition latency.
    const currentCamera = this.cameraTruth();
    const projection = projectPoint(p, target.pose.position, yawDegrees(drone.pose.rotation), currentCamera.pitchDeg, currentCamera.hfovDeg);
    const hit = this.world.physics.ray(p, sub(target.pose.position, p), projection.range, ['drone/base']);
    const visible = projection.inFrame && projection.range <= 20 && hit?.body === 'target/base';
    const heading = radians(yawDegrees(target.pose.rotation)), relative = sub(p, target.pose.position), horizontal = Math.hypot(relative.x, relative.y);
    const sideDot = horizontal > 0 ? this.side * (-Math.sin(heading) * relative.x + Math.cos(heading) * relative.y) / horizontal : 0;
    const inspectable = visible && Math.abs(projection.u) <= .5 && Math.abs(projection.v) <= .5 && projection.range >= 2.5 && projection.range <= 6 && sideDot >= .7;
    this.currentDwell = inspectable ? this.currentDwell + 20 : 0; this.longestDwell = Math.max(this.longestDwell, this.currentDwell);
    if (this.currentDwell >= 1000 && this.inspectionAt === null) { this.inspectionAt = this.world.simMs; this.emit('flight.evaluation.inspected', { simMs: this.world.simMs }); }
    if (this.world.simMs > 5000) { this.counted++; if (visible) this.visible++; if (distance(p, target.pose.position) <= 10) this.near++; }
    if (this.world.physics.contacts().some(c => c.a === 'drone/base' || c.b === 'drone/base')) this.collisionTicks++;
    if (Math.abs(p.x) > 18 || Math.abs(p.y) > 18 || p.z < .7 || p.z > 6) this.boundsTicks++;
    if (Math.round(this.world.simMs) % 100 === 0) {
      const frame = { simMs: this.world.simMs, drone: p, target: target.pose.position, heading: yawDegrees(drone.pose.rotation), pitch: currentCamera?.pitchDeg, hfov: currentCamera?.hfovDeg, visible, inspectable, sideDot, projection };
      this.trajectory.push(frame); this.emit('flight.evaluation.frame', frame);
    }
  }
  evaluate() {
    const visibleFraction = this.counted ? this.visible / this.counted : 0, nearFraction = this.counted ? this.near / this.counted : 0;
    return { success: this.inspectionAt !== null && visibleFraction >= .5 && nearFraction >= .7 && this.collisionTicks === 0 && this.boundsTicks === 0, visibleFraction, nearFraction, inspectionAtMs: this.inspectionAt, longestInspectionMs: this.longestDwell, collisionTicks: this.collisionTicks, boundsTicks: this.boundsTicks, trajectory: this.trajectory };
  }
  async close() { if (!this.live) return; this.live = false; this.wire.close(); try { await this.port.stop(); await this.targetPort.stop(); } finally { this.world.close(); } }
}
