import type { Controller, RobotPort, Vec3 } from '../src/contracts.ts';
import { delay } from './tools.ts';

/** A controller imports only RobotPort: the same loop can bind a hardware implementation. */
export function waypointController(routes: Record<string, Vec3[]>, options: { pollMs?: number; commandLifetimeMs?: number } = {}): Controller {
  return { id: 'waypoints', async run(ports, signal) {
    await Promise.all(ports.map(async port => {
      try {
        const description = await port.describe();
        if (!description.commands.goto) throw new Error(`${port.robotId} does not advertise goto.`);
        for (const [index, point] of (routes[port.robotId] ?? []).entries()) {
          signal.throwIfAborted();
          const observed = await port.observe();
          signal.throwIfAborted();
          const receipt = await port.command({ id: `route-${observed.epoch}-${index}`, action: 'goto', args: { ...point }, validForMs: options.commandLifetimeMs ?? 30000, basedOn: { observation: observed.sequence, maxAgeMs: 1000 } });
          if (!['accepted', 'completed', 'duplicate'].includes(receipt.status)) throw new Error(receipt.reason ?? 'Route command rejected.');
          if (receipt.status === 'completed') continue;
          for (;;) {
            signal.throwIfAborted(); const next = await port.observe();
            const job = next.jobs.find(job => job.id === receipt.jobId);
            if (job?.status === 'completed') break;
            if (job && job.status !== 'running') throw new Error(`Route job ${job.status}.`);
            if (next.fault) throw new Error(next.fault);
            await delay(options.pollMs ?? 50, signal);
          }
        }
      } finally { await port.stop(); }
    }));
  } };
}

/** Radio-only beacon: each robot publishes its own sensor data, with no shared pose access. */
export function swarmBeaconController(options: { sensorId?: string; intervalMs?: number } = {}): Controller {
  return { id: 'radio-beacons', async run(ports: readonly RobotPort[], signal) {
    await Promise.all(ports.map(async port => {
      let sequence = 0;
      const sensorId = options.sensorId ?? (await port.describe()).sensors.find(sensor => sensor.type === 'odometry')?.id;
      try { while (!signal.aborted) {
        const observation = await port.observe(); signal.throwIfAborted();
        const sample = sensorId ? observation.sensors[sensorId] : undefined;
        if (sample?.valid) await port.send({ id: `${observation.epoch}-beacon-${++sequence}`, to: '*', data: JSON.stringify({ acquiredSimMs: sample.acquiredSimMs, value: sample.value }), ttlMs: 1000 });
        await port.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(packet => packet.id));
        await delay(options.intervalMs ?? 250, signal);
      } } finally { await port.stop(); }
    }));
  } };
}
