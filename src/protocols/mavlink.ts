import { randomUUID } from 'node:crypto';
import { common, minimal, MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser } from 'node-mavlink';
import type { MavLinkData, MavLinkDataConstructor, MavLinkPacket } from 'node-mavlink';
import type { Json, Recorder, RobotPort, Vec3 } from '../contracts.ts';

export const enuToNed = (v: Vec3): Vec3 => ({ x: v.y, y: v.x, z: -v.z });
export const nedToEnu = enuToNed;
const noRecord: Recorder = () => {};

/** Strict unsigned MAVLink v2 codec. Packet parsing verifies dialect CRCs. */
export class MavlinkCodec {
  private protocol: MavLinkProtocolV2;
  private sequence = 0;
  constructor(systemId = 255, componentId = 190) {
    validId(systemId); validId(componentId);
    this.protocol = new MavLinkProtocolV2(systemId, componentId);
  }
  encode(message: MavLinkData): Buffer { return this.protocol.serialize(message, this.sequence++ % 256); }
  packets(bytes: Buffer): MavLinkPacket[] {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536) throw new Error('invalid_mavlink_datagram');
    const packets: MavLinkPacket[] = [];
    const splitter = new MavLinkPacketSplitter(), parser = new MavLinkPacketParser();
    splitter.pipe(parser);
    parser.on('data', (packet: MavLinkPacket) => packets.push(packet));
    try {
      for (let offset = 0; offset < bytes.length;) {
        // Signed frames require a signing/key policy; do not silently accept them unverified.
        if (bytes[offset] !== 0xfd || bytes.length - offset < 12 || bytes[offset + 2] !== 0) throw new Error('unsupported_mavlink_framing');
        const length = bytes[offset + 1]! + 12;
        if (offset + length > bytes.length) throw new Error('truncated_mavlink_frame');
        const count = packets.length;
        splitter.write(bytes.subarray(offset, offset + length));
        if (packets.length !== count + 1) throw new Error('invalid_mavlink_crc');
        offset += length;
      }
      return packets;
    } finally { splitter.destroy(); parser.destroy(); }
  }
  decode<T extends MavLinkData>(bytes: Buffer, type: MavLinkDataConstructor<T>): T {
    const packets = this.packets(bytes);
    if (packets.length !== 1 || packets[0]!.header.msgid !== type.MSG_ID) throw new Error('unexpected_mavlink_message');
    return packets[0]!.protocol.data(packets[0]!.payload, type);
  }
}

export interface MavlinkVehicle { port: RobotPort; systemId: number; componentId?: number }
/** Controller-facing setpoints over real wire bytes; this is not an autopilot. */
export class MavlinkAdapter {
  private decoder = new MavlinkCodec();
  private vehicles = new Map<number, MavlinkVehicle & { codec: MavlinkCodec; lastHeartbeat: number }>();
  private record: Recorder;
  private now: () => number;
  private closed = false;
  private readonly ingressSession = randomUUID();
  private ingressSequence = 0;
  constructor(options: { ports: readonly MavlinkVehicle[]; record?: Recorder; simMs?: () => number }) {
    this.record = options.record ?? noRecord; this.now = options.simMs ?? (() => 0);
    if (!options.ports.length || options.ports.length > 254) throw new Error('invalid_mavlink_vehicles');
    const robotIds = new Set<string>();
    for (const vehicle of options.ports) {
      validId(vehicle.systemId); validId(vehicle.componentId ?? 1);
      if (this.vehicles.has(vehicle.systemId) || robotIds.has(vehicle.port.robotId)) throw new Error('duplicate_mavlink_identity');
      robotIds.add(vehicle.port.robotId);
      this.vehicles.set(vehicle.systemId, { ...vehicle, componentId: vehicle.componentId ?? 1,
        codec: new MavlinkCodec(vehicle.systemId, vehicle.componentId ?? 1), lastHeartbeat: -Infinity });
    }
  }
  async receive(bytes: Buffer): Promise<Buffer[]> {
    if (this.closed) throw new Error('mavlink_closed');
    let packets: MavLinkPacket[];
    try { packets = this.decoder.packets(bytes); }
    catch (error) { this.trace(undefined, 'rejected', { reason: String(error), bytes: bytes.length, hex: bytes.subarray(0, 512).toString('hex') }); throw error; }
    const replies: Buffer[] = [];
    for (const packet of packets) {
      const header = packet.header;
      if (header.msgid === minimal.Heartbeat.MSG_ID) { this.trace(undefined, 'rx', { message: 'HEARTBEAT', header, hex: packet.buffer.toString('hex') }); continue; }
      if (header.msgid === common.SetPositionTargetLocalNed.MSG_ID) {
        const data = packet.protocol.data(packet.payload, common.SetPositionTargetLocalNed);
        const vehicle = this.target(data.targetSystem, data.targetComponent);
        this.trace(vehicle?.port.robotId, 'rx', { message: 'SET_POSITION_TARGET_LOCAL_NED', header, decoded: data, hex: packet.buffer.toString('hex') });
        if (!vehicle) { this.trace(undefined, 'rejected', { reason: 'target_mismatch', targetSystem: data.targetSystem, targetComponent: data.targetComponent }); continue; }
        let action: string, args: Record<string, Json>;
        if (data.coordinateFrame !== 1) { this.trace(vehicle.port.robotId, 'rejected', { reason: 'unsupported_coordinate_frame' }); continue; }
        if (Number(data.typeMask) === 3576) { action = 'goto'; args = { ...nedToEnu(data) }; }
        else if (Number(data.typeMask) === 3527) { action = 'velocity'; args = { ...nedToEnu({ x: data.vx, y: data.vy, z: data.vz }) }; }
        else { this.trace(vehicle.port.robotId, 'rejected', { reason: 'unsupported_setpoint_mask', typeMask: data.typeMask }); continue; }
        if (Object.values(args).some(value => typeof value !== 'number' || !Number.isFinite(value))) { this.trace(vehicle.port.robotId, 'rejected', { reason: 'non_finite_setpoint' }); continue; }
        // A setpoint is a streaming update. Identical bytes after 8-bit sequence
        // wrap must still refresh the watchdog. The transport never retries.
        const id = `mavlink:${this.ingressSession}:${++this.ingressSequence}`;
        const receipt = await vehicle.port.command({ id, action, args, validForMs: 1000 });
        this.trace(vehicle.port.robotId, 'command_receipt', { sourceSystem: header.sysid, sourceComponent: header.compid, receipt });
        // This MAVLink setpoint message has no COMMAND_ACK transaction. Never fabricate one.
      } else if (header.msgid === common.CommandLong.MSG_ID) {
        const data = packet.protocol.data(packet.payload, common.CommandLong);
        const vehicle = this.target(data.targetSystem, data.targetComponent);
        this.trace(vehicle?.port.robotId, 'rx', { message: 'COMMAND_LONG', header, decoded: data, hex: packet.buffer.toString('hex') });
        if (!vehicle) continue;
        const ack = new common.CommandAck();
        Object.assign(ack, { command: data.command, result: 3, targetSystem: header.sysid, targetComponent: header.compid });
        const reply = vehicle.codec.encode(ack); replies.push(reply);
        this.trace(vehicle.port.robotId, 'tx', { message: 'COMMAND_ACK', decoded: ack, hex: reply.toString('hex'), reason: 'unsupported_command' });
      } else this.trace(undefined, 'rejected', { reason: 'unsupported_message', messageId: header.msgid });
    }
    return replies;
  }
  async telemetry(): Promise<Buffer[]> {
    if (this.closed) return [];
    const frames: Buffer[] = [];
    for (const vehicle of this.vehicles.values()) {
      const observation = await vehicle.port.observe();
      if (observation.events.length) {
        this.trace(vehicle.port.robotId, 'execution_observed', {
          observation: observation.sequence,
          jobs: observation.jobs.map(({ id, commandId, status, updatedSimMs }) => ({ id, commandId, status, updatedSimMs })),
          events: observation.events,
        });
        // This adapter owns event consumption for its port. Radio messages are
        // a different consumer's data and are deliberately left in the inbox.
        await vehicle.port.acknowledge(observation.events.at(-1)!.id, []);
      }
      if (observation.simMs - vehicle.lastHeartbeat >= 1000) {
        const heartbeat = new minimal.Heartbeat();
        // MAV_AUTOPILOT_INVALID: a simulator endpoint, not PX4/ArduPilot.
        Object.assign(heartbeat, { type: 2, autopilot: 8, baseMode: 0, systemStatus: 3, mavlinkVersion: 3 });
        const bytes = vehicle.codec.encode(heartbeat); frames.push(bytes); vehicle.lastHeartbeat = observation.simMs;
        this.trace(vehicle.port.robotId, 'tx', { message: 'HEARTBEAT', decoded: heartbeat, hex: bytes.toString('hex') });
      }
      const description = await vehicle.port.describe();
      const odometry = description.sensors.find(sensor => sensor.type === 'odometry');
      const reading = odometry ? observation.sensors[odometry.id] : undefined;
      if (!reading?.valid || !reading.value || typeof reading.value !== 'object' || Array.isArray(reading.value)) continue;
      const position = vector(reading.value.position), velocity = vector(reading.value.velocity ?? reading.value.linearVelocity);
      if (!position || !velocity) continue;
      const p = enuToNed(position), v = enuToNed(velocity), message = new common.LocalPositionNed();
      Object.assign(message, { timeBootMs: Math.round(reading.acquiredSimMs) >>> 0, ...p, vx: v.x, vy: v.y, vz: v.z });
      const bytes = vehicle.codec.encode(message); frames.push(bytes);
      this.trace(vehicle.port.robotId, 'tx', { message: 'LOCAL_POSITION_NED', decoded: message, hex: bytes.toString('hex'), acquiredSimMs: reading.acquiredSimMs });
    }
    return frames;
  }
  close() { this.closed = true; }
  private target(system: number, component: number) {
    const vehicle = this.vehicles.get(system);
    // Require explicit vehicle and component addressing; no broadcast actuation.
    return vehicle && component === vehicle.componentId ? vehicle : undefined;
  }
  private trace(robotId: string | undefined, kind: string, data: unknown) { this.record({ channel: 'protocol', robotId, simMs: this.now(), kind, data }); }
}
function validId(value: number) { if (!Number.isInteger(value) || value < 1 || value > 255) throw new Error('invalid_mavlink_identity'); }
function vector(value: Json | undefined): Vec3 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { x, y, z } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || ![x,y,z].every(Number.isFinite)) return;
  return { x, y, z };
}
