import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, experimentConfig } from './config.ts';
import { sourceHash, trial } from './run.ts';
import { report } from './report.ts';
import { audit } from './audit.ts';

// Deliberately simple injected controls test plumbing, not mission-solving ability.
const directory = resolve(process.argv[2] ?? `.runtime/experiments/reactive-mechanics-${Date.now()}`);
await mkdir(directory, { recursive: true });
const config = experimentConfig({ ...DEFAULT_CONFIG, scoring: { ...DEFAULT_CONFIG.scoring, warmupMs: 0 } });
const manifest = { phase: 'fixture', sourceHash: await sourceHash(), arms: ['fixture-provider-failure', 'fixture-continuous'], seeds: [901], seconds: 6, config,
  purpose: 'OFFLINE MECHANICS FIXTURE. Synthetic failures and arbitrary movements; never AI performance evidence.' };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
const results = [];
results.push(await trial({ arm: manifest.arms[0]!, seed: 901, seconds: 6, directory, phase: 'fixture', config, realtime: false,
  fixtureDecision: async () => { throw new Error('Deliberate provider exception'); } }));
results.push(await trial({ arm: manifest.arms[1]!, seed: 901, seconds: 6, directory, phase: 'fixture', config, realtime: false,
  controller: { id: 'fixture-continuous', async run([port], signal) {
    let counter = 0, lastCommandMs = -Infinity;
    while (!signal.aborted) {
      const observation = await port!.observe();
      await port!.acknowledge(observation.events.at(-1)?.id ?? 0, observation.inbox.map(p => p.id));
      if (observation.simMs - lastCommandMs >= 500) {
        lastCommandMs = observation.simMs;
        await port!.command({ id: `fixture-${++counter}`, action: 'control', args: { mode: 'velocity', x: .137, y: -.231, z: 0, heading: 17.23, pitch: -28.91, hfov: 70 }, validForMs: 700, basedOn: { observation: observation.sequence, maxAgeMs: 200 } });
      }
    }
  } } }));
await writeFile(resolve(directory, 'results.json'), JSON.stringify({ manifest, results }, null, 2));
await audit(directory); await report(directory);
console.log(`Offline fixture replay: ${directory}/replay.json`);
