import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Produce a portable replay from completed evidence, without changing scored results. */
export async function buildFlightReplay(directory: string) {
  const report = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
  for (const result of report.results) {
    if (!/^[\w-]+$/.test(result.id)) throw new Error('Invalid trace identity');
    const trace = (await readFile(resolve(directory, `${result.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    if (trace.at(-1)?.kind !== 'trace.complete') throw new Error(`Incomplete trace ${result.id}`);
    result.scenario = trace.find(row => row.kind === 'flight.manifest')?.data.scenario;
    result.replayEvents = trace.flatMap(row => {
      if (row.kind === 'flight.decision.applied' || row.kind === 'flight.decision.error' || row.kind === 'flight.proposals') return [{ simMs: row.data.simMs ?? row.data.currentSimMs, channel: 'decision', data: row.data }];
      if (row.kind !== 'world.event') return [];
      const event = row.data;
      if (event.robotId !== 'drone') return [];
      if (event.channel === 'protocol' && event.kind === 'rx' || event.channel === 'sensor' && JSON.stringify(event.data).includes('ideal-geometric-detections') || event.channel === 'network' && event.kind.includes('deliver')) return [{ simMs: event.simMs, channel: event.channel, data: event.data }];
      return [];
    });
    result.traceFile = `${result.id}.jsonl`;
  }
  const path = resolve(directory, 'replay.json'); await writeFile(path, JSON.stringify(report));
  console.log(JSON.stringify({ replay: path, trials: report.results.length })); return path;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildFlightReplay(resolve(process.argv[2] ?? '.runtime/experiments/flight-held-out-v1'));
