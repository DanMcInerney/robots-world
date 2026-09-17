import type { Json, RobotPort } from '../src/contracts.ts';
import { randomUUID } from 'node:crypto';
import { delay } from '../controllers/tools.ts';

/** Structural implementation of Nervelet 0.2 Environment; no Nervelet import in the world. */
export async function createNerveletEnvironment(port: RobotPort) {
  const description = await port.describe();
  let acknowledgement = Promise.resolve();
  const received = new Map<string, { sequence: number; wallMs: number }>();
  const hold = async () => {
    if (!description.commands.hold) { await port.stop(); return { status: 'confirmed' as const, reason: 'No hold action; robot port revoked. Reclaim before a new goal.' }; }
    let receipt;
    try { receipt = await port.command({ id: `hold-${randomUUID()}`, action: 'hold', args: {}, validForMs: 1000 }); }
    catch { await port.stop(); return { status: 'confirmed' as const, reason: 'Hold unavailable; robot port stopped and revoked.' }; }
    return { status: receipt.status === 'completed' ? 'confirmed' as const : receipt.status === 'accepted' ? 'stopping' as const : 'unknown' as const, reason: receipt.reason };
  };
  const commands = Object.fromEntries(Object.entries(description.commands).map(([name, command]) => [name, { ...command, resource: 'actuators' }]));
  return {
    profile: { id: `robots-world-${port.robotId}`, version: '1', instructions: 'Use only this robot’s sensors. Accepted commands require observing jobs for completion. Radio inbox is a sample: radio_ack explicitly acknowledges handled packet IDs. radio_send completion means queue admission, not delivery. Cancelling a job holds this entire robot; there is one actuator resource.', commands: {
      ...commands,
      radio_send: { description: 'Enqueue a radio packet; not delivery.', schema: { type: 'object', properties: { id: { type: 'string' }, to: { type: 'string' }, data: { type: 'string' }, ttlMs: { type: 'number' } }, required: ['id', 'to', 'data'], additionalProperties: false } },
      radio_ack: { description: 'Acknowledge previously observed packet IDs.', schema: { type: 'object', properties: { packetIds: { type: 'array', items: { type: 'string' }, maxItems: 256 } }, required: ['packetIds'], additionalProperties: false } },
    } },
    async start(signal: AbortSignal) { signal.throwIfAborted(); },
    async snapshot(after: number, signal: AbortSignal) {
      signal.throwIfAborted(); await acknowledgement;
      const observation = await port.observe(); signal.throwIfAborted();
      const receivedMs = performance.now();
      const samples = Object.fromEntries(Object.entries(observation.sensors).map(([id, reading]) => {
        if (received.get(id)?.sequence !== reading.sequence) received.set(id, { sequence: reading.sequence, wallMs: receivedMs });
        return [id, { value: reading.value, receivedMs: received.get(id)!.wallMs, acquired: { clock: `sim:${observation.epoch}`, ms: reading.acquiredSimMs }, valid: reading.valid, reason: reading.reason }];
      }));
      samples.radio_inbox = { value: observation.inbox as unknown as Json, receivedMs, acquired: { clock: `sim:${observation.epoch}`, ms: observation.simMs }, valid: true, reason: undefined };
      return {
        state: { value: { robotId: port.robotId, simMs: observation.simMs }, receivedMs, valid: true }, samples,
        jobs: observation.jobs.map(job => ({ id: job.id, status: job.status === 'expired' ? 'failed' as const : job.status, commandId: job.commandId, kind: job.action, args: job.args, startedMs: job.startedSimMs, updatedMs: job.updatedSimMs })),
        events: observation.events.filter(event => event.id > after).map(event => ({ seq: event.id, kind: event.kind, atMs: observation.wallMs, data: event.data })),
        hasMore: false, fault: observation.fault,
      };
    },
    acknowledge(through: number) { acknowledgement = acknowledgement.then(() => port.acknowledge(through)); void acknowledgement.catch(() => {}); },
    async wait(signal: AbortSignal) { await delay(25, signal); },
    async execute(command: { id: string; kind: string; args: Record<string, Json> }, context: { signal: AbortSignal; assertCurrent?(): void }) {
      context.signal.throwIfAborted(); context.assertCurrent?.();
      if (command.kind === 'radio_send') {
        const result = await port.send(command.args as unknown as { id: string; to: string; data: string; ttlMs?: number });
        return { id: command.id, status: result.accepted ? 'completed' as const : 'rejected' as const, reason: result.reason ?? (result.accepted ? 'radio_queue_admission_only' : 'radio_rejected') };
      }
      if (command.kind === 'radio_ack') {
        await port.acknowledge(0, command.args.packetIds as string[]); return { id: command.id, status: 'completed' as const };
      }
      const receipt = await port.command({ id: command.id, action: command.kind, args: command.args, validForMs: 30000 });
      return { id: receipt.id, status: receipt.status === 'duplicate' ? (receipt.jobId ? 'accepted' as const : 'completed' as const) : receipt.status, jobId: receipt.jobId, reason: receipt.reason };
    },
    async cancel(_id: string, signal: AbortSignal) { signal.throwIfAborted(); return hold(); },
    async stop(_signal: AbortSignal) { return hold(); },
    async close() { try { await port.stop(); } finally { await port.close(); } },
  };
}

/** The caller loads its chosen Nervelet version; this adapter owns no agent or continuation logic. */
export async function createNerveletBridge(port: RobotPort, nervelet: { Bridge: new (...args: any[]) => any }, goal: string) {
  const environment = await createNerveletEnvironment(port);
  const bridge = new nervelet.Bridge(environment, goal);
  await bridge.start();
  return bridge;
}
