import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Packet, RadioSpec, Recorder, Vec3 } from './contracts.ts';
import { distance, randomStream } from './math.ts';

const DEFAULT_RADIO: RadioSpec = { channel: 'team', rangeM: 30, bitrateBps: 64000,
  latencyMs: 30, jitterMs: 10, loss: 0, maxQueueBytes: 65536, maxPacketBytes: 8192 };
type Outgoing = { id: string; to: string; data: string; ttlMs?: number };
type Radio = { spec: RadioSpec; inbox: Packet[]; inboxBytes: number; nextTxMs: number;
  tx: { until: number; bytes: number }[]; recent: Map<string, string> };
type Delivery = { sequence: number; at: number; packet: Packet; bytes: number };

/** A bounded datagram impairment model. It does not emulate Wi-Fi, DDS or a MAC. */
export class RadioMedium {
  private radios = new Map<string, Radio>();
  private deliveries: Delivery[] = [];
  private streams = new Map<string, () => number>();
  private partitions = new Set<string>();
  private now = 0;
  private sequence = 0;
  private closed = false;
  private counts = { accepted: 0, delivered: 0, dropped: 0, duplicate: 0 };
  private readonly options: { seed: number; position: (robotId: string) => Vec3; record: Recorder };
  constructor(options: { seed: number; position: (robotId: string) => Vec3; record: Recorder; partitions?: [string, string][] }) {
    if (!Number.isFinite(options.seed)) throw new Error('invalid_network_seed');
    this.options = options;
    this.setPartitions(options.partitions ?? []);
  }
  register(robotId: string, config: Partial<RadioSpec> = {}): RadioSpec {
    if (this.closed) throw new Error('network_closed');
    identity(robotId);
    if (this.radios.has(robotId)) throw new Error('duplicate_radio');
    if (this.radios.size >= 256) throw new Error('radio_limit');
    const spec = { ...DEFAULT_RADIO, ...config };
    if (typeof spec.channel !== 'string' || !spec.channel.length || spec.channel.length > 128) throw new Error('invalid_radio_channel');
    for (const [name, min, max] of [['rangeM', 0, 1000000], ['bitrateBps', 1, 1e10],
      ['latencyMs', 0, 60000], ['jitterMs', 0, 60000], ['loss', 0, 1],
      ['maxQueueBytes', 1, 1048576], ['maxPacketBytes', 1, 65536]] as const) {
      if (!Number.isFinite(spec[name]) || spec[name] < min || spec[name] > max) throw new Error(`invalid_radio_${name}`);
    }
    if (!Number.isInteger(spec.maxQueueBytes) || !Number.isInteger(spec.maxPacketBytes) || spec.maxPacketBytes > spec.maxQueueBytes) throw new Error('invalid_radio_buffer');
    this.radios.set(robotId, { spec, inbox: [], inboxBytes: 0, nextTxMs: 0, tx: [], recent: new Map() });
    return structuredClone(spec);
  }
  setPartitions(partitions: [string, string][]) {
    if (!Array.isArray(partitions) || partitions.length > 65536) throw new Error('invalid_partitions');
    this.partitions = new Set(partitions.map(([from, to]) => { identity(from); identity(to); return JSON.stringify([from, to]); }));
  }
  send(from: string, message: Outgoing, simMs: number): { accepted: boolean; reason?: string } {
    this.time(simMs); this.now = simMs;
    const radio = this.radios.get(from);
    if (this.closed || !radio) return { accepted: false, reason: this.closed ? 'network_closed' : 'unknown_sender' };
    if (!message || typeof message.id !== 'string' || !message.id.length || message.id.length > 128 ||
      typeof message.to !== 'string' || !message.to.length || message.to.length > 128 || typeof message.data !== 'string') return { accepted: false, reason: 'invalid_packet' };
    const ttlMs = message.ttlMs ?? 5000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 60000) return { accepted: false, reason: 'invalid_ttl' };
    const bytes = Math.max(1, Buffer.byteLength(message.data, 'utf8'));
    if (bytes > radio.spec.maxPacketBytes) return { accepted: false, reason: 'packet_too_large' };
    const signature = createHash('sha256').update(JSON.stringify([message.to, message.data, ttlMs])).digest('hex');
    const previous = radio.recent.get(message.id);
    if (previous !== undefined) {
      if (previous !== signature) return { accepted: false, reason: 'packet_id_conflict' };
      this.counts.duplicate++;
      return { accepted: true, reason: 'duplicate' };
    }
    radio.tx = radio.tx.filter(item => item.until > simMs);
    if (radio.tx.reduce((sum, item) => sum + item.bytes, 0) + bytes > radio.spec.maxQueueBytes) return { accepted: false, reason: 'tx_queue_full' };
    const recipients = [...this.radios.keys()].filter(id => id !== from && (message.to === '*' || message.to === id));
    if (this.deliveries.length + recipients.length > 65536) return { accepted: false, reason: 'network_queue_full' };
    const until = Math.max(simMs, radio.nextTxMs) + bytes * 8000 / radio.spec.bitrateBps;
    radio.nextTxMs = until;
    radio.tx.push({ until, bytes });
    radio.recent.set(message.id, signature);
    if (radio.recent.size > 512) radio.recent.delete(radio.recent.keys().next().value!);
    this.counts.accepted++;
    this.record(from, 'queued', simMs, { ...message, ttlMs, bytes, transmitDoneSimMs: until });
    for (const to of recipients) {
      const random = this.stream(from, to);
      const delay = Math.max(0, radio.spec.latencyMs + (random() * 2 - 1) * radio.spec.jitterMs);
      this.deliveries.push({ sequence: this.sequence++, at: until + delay, bytes,
        packet: { id: JSON.stringify([from, message.id]), from, to, data: message.data, channel: radio.spec.channel,
          sentSimMs: simMs, receivedSimMs: until + delay, expiresSimMs: simMs + ttlMs } });
    }
    if (!recipients.length) this.drop(from, simMs, message.id, message.to, 'no_recipient');
    return { accepted: true };
  }
  tick(simMs: number) {
    this.time(simMs); this.now = simMs;
    if (this.closed) return;
    this.deliveries.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
    let count = 0;
    while (count < this.deliveries.length && this.deliveries[count]!.at <= simMs) {
      const delivery = this.deliveries[count++]!;
      const p = delivery.packet, source = this.radios.get(p.from)!, target = this.radios.get(p.to)!;
      let reason: string | undefined;
      if (simMs >= p.expiresSimMs) reason = 'expired';
      else if (this.partitions.has(JSON.stringify([p.from, p.to]))) reason = 'partition';
      else if (source.spec.channel !== target.spec.channel) reason = 'channel';
      else if (distance(this.options.position(p.from), this.options.position(p.to)) > Math.min(source.spec.rangeM, target.spec.rangeM)) reason = 'range';
      else if (this.stream(p.from, p.to)() < source.spec.loss) reason = 'loss';
      else if (target.inboxBytes + delivery.bytes > target.spec.maxQueueBytes || target.inbox.length >= 512) reason = 'inbox_full';
      if (reason) this.drop(p.from, simMs, p.id, p.to, reason);
      else {
        // Actual receipt is the host's tick boundary, not the ideal scheduled instant.
        p.receivedSimMs = simMs;
        target.inbox.push(p); target.inboxBytes += delivery.bytes; this.counts.delivered++;
        this.record(p.to, 'delivered', simMs, { ...p, scheduledSimMs: delivery.at, bytes: delivery.bytes });
      }
    }
    this.deliveries.splice(0, count);
    for (const [robotId, radio] of this.radios) {
      radio.tx = radio.tx.filter(item => item.until > simMs);
      radio.inbox = radio.inbox.filter(packet => {
        if (packet.expiresSimMs > simMs) return true;
        radio.inboxBytes -= Math.max(1, Buffer.byteLength(packet.data));
        this.record(robotId, 'inbox_expired', simMs, { id: packet.id, from: packet.from });
        return false;
      });
    }
  }
  inbox(robotId: string): Packet[] { return structuredClone(this.radio(robotId).inbox); }
  acknowledge(robotId: string, ids: readonly string[]) {
    if (!Array.isArray(ids) || ids.length > 512) throw new Error('invalid_packet_ack');
    const radio = this.radio(robotId), selected = new Set(ids);
    radio.inbox = radio.inbox.filter(packet => {
      if (!selected.has(packet.id)) return true;
      radio.inboxBytes -= Math.max(1, Buffer.byteLength(packet.data)); return false;
    });
  }
  stats() { return { ...this.counts, queuedDeliveries: this.deliveries.length, radios: this.radios.size }; }
  reset() {
    this.deliveries = []; this.streams.clear(); this.now = 0; this.sequence = 0;
    this.counts = { accepted: 0, delivered: 0, dropped: 0, duplicate: 0 };
    for (const radio of this.radios.values()) { radio.inbox = []; radio.inboxBytes = 0; radio.nextTxMs = 0; radio.tx = []; radio.recent.clear(); }
  }
  close() { this.reset(); this.radios.clear(); this.closed = true; }
  private time(simMs: number) { if (!Number.isFinite(simMs) || simMs < this.now || simMs < 0) throw new Error('non_monotonic_network_time'); }
  private radio(id: string) { const radio = this.radios.get(id); if (!radio) throw new Error('unknown_radio'); return radio; }
  private stream(from: string, to: string) { const key = JSON.stringify([from, to]); if (!this.streams.has(key)) this.streams.set(key, randomStream(this.options.seed, `radio:${key}`)); return this.streams.get(key)!; }
  private record(robotId: string, kind: string, simMs: number, data: unknown) { this.options.record({ channel: 'network', robotId, simMs, kind, data }); }
  private drop(from: string, simMs: number, id: string, to: string, reason: string) { this.counts.dropped++; this.record(from, 'dropped', simMs, { id, to, reason }); }
}
function identity(id: string) { if (typeof id !== 'string' || !id.length || id.length > 128 || id === '*') throw new Error('invalid_radio_identity'); }
