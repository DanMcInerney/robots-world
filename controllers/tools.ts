import type { Command, Json, RobotPort } from '../src/contracts.ts';

export type ControllerLog = (kind: string, data: unknown) => void;
export interface RobotTools {
  list(): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(name: string, args: unknown): Promise<unknown>;
  stopAll(): Promise<void>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The tool surface is scoped by supplied ports, never by a simulator reference. */
export function createRobotTools(ports: readonly RobotPort[], options: { signal?: AbortSignal; maxCalls?: number; log?: ControllerLog } = {}): RobotTools {
  const robots = new Map(ports.map(port => [port.robotId, port]));
  if (!ports.length || robots.size !== ports.length) throw new Error('Supply distinct robot ports.');
  let calls = 0, active = true, stopping: Promise<void> | undefined;
  const properties = { robotId: { type: 'string', enum: [...robots.keys()] } };
  const schema = (extra: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: { ...properties, ...extra }, required: ['robotId', ...required] });
  const definitions = [
    { name: 'robot_describe', description: 'Read this robot’s command schemas, installed sensors and communication capabilities.', inputSchema: schema() },
    { name: 'robot_observe', description: 'Read only the robot’s sensed data, jobs, events and delivered radio messages. Simulation continues during reasoning.', inputSchema: schema() },
    { name: 'robot_command', description: 'Submit a robot-specific command. An accepted receipt is admission; observe jobs to determine completion. Use a unique command ID and observation provenance.', inputSchema: schema({ command: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' }, validForMs: { type: 'number' }, basedOn: { type: 'object' } }, required: ['id', 'action', 'args'], additionalProperties: false } }, ['command']) },
    { name: 'robot_send', description: 'Enqueue a radio message; acceptance does not establish delivery. The world models radio loss, bandwidth, range, expiry and latency.', inputSchema: schema({ packet: { type: 'object', properties: { id: { type: 'string' }, to: { type: 'string' }, data: { type: 'string' }, ttlMs: { type: 'number' } }, required: ['id', 'to', 'data'], additionalProperties: false } }, ['packet']) },
    { name: 'robot_acknowledge', description: 'Acknowledge events and packet IDs only after observing and handling them.', inputSchema: schema({ throughEvent: { type: 'integer', minimum: 0 }, packetIds: { type: 'array', items: { type: 'string' }, maxItems: 256 } }, ['throughEvent']) },
    { name: 'robot_stop', description: 'Stop and revoke this robot port. This port cannot command again after stopping.', inputSchema: schema() },
  ];
  const stopped = new Set<string>();
  const check = () => { if (!active || options.signal?.aborted) throw new Error('Controller authority ended.'); };
  const result: RobotTools = {
    list: () => structuredClone(definitions),
    async call(name, raw) {
      check();
      if (++calls > (options.maxCalls ?? 128)) { await result.stopAll(); throw new Error('Controller tool budget exhausted.'); }
      if (!definitions.some(item => item.name === name) || !object(raw) || typeof raw.robotId !== 'string') throw new Error('Invalid robot tool request.');
      const port = robots.get(raw.robotId);
      if (!port) throw new Error('Robot is outside this controller’s scope.');
      if (stopped.has(port.robotId) && !['robot_observe', 'robot_describe', 'robot_stop'].includes(name)) throw new Error('Robot authority was revoked.');
      options.log?.('tool_call', { name, args: raw });
      let value: unknown;
      if (name === 'robot_describe') value = await port.describe();
      else if (name === 'robot_observe') value = await port.observe();
      else if (name === 'robot_command') {
        if (!object(raw.command) || typeof raw.command.id !== 'string' || typeof raw.command.action !== 'string' || !object(raw.command.args)) throw new Error('Invalid command.');
        check(); value = await port.command(raw.command as unknown as Command);
      } else if (name === 'robot_send') {
        if (!object(raw.packet) || !['id', 'to', 'data'].every(key => typeof raw.packet === 'object' && raw.packet !== null && typeof (raw.packet as Record<string, unknown>)[key] === 'string')) throw new Error('Invalid packet.');
        check(); value = await port.send(raw.packet as unknown as { id: string; to: string; data: string; ttlMs?: number });
      } else if (name === 'robot_acknowledge') {
        if (!Number.isSafeInteger(raw.throughEvent) || Number(raw.throughEvent) < 0 || (raw.packetIds !== undefined && (!Array.isArray(raw.packetIds) || raw.packetIds.some(id => typeof id !== 'string') || raw.packetIds.length > 256))) throw new Error('Invalid acknowledgement.');
        value = await port.acknowledge(Number(raw.throughEvent), raw.packetIds as string[] | undefined);
      } else { stopped.add(port.robotId); value = await port.stop(); }
      check(); options.log?.('tool_result', { name, robotId: port.robotId, value: value ?? null });
      return value ?? { ok: true } satisfies Json;
    },
    stopAll() {
      active = false;
      return stopping ??= Promise.allSettled(ports.map(port => port.stop())).then(results => {
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'Some robot stops were not confirmed.');
      });
    },
  };
  return result;
}

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
