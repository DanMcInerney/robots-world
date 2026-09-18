import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { billingFailure, report } from './report.ts';

export async function continuationPlan(original: string, batch: any) {
  const billing: any[] = [], retained: any[] = [];
  for (const result of batch.results) {
    assert(/^[\w-]+$/.test(result.id), 'Invalid trial id');
    const failure = await billingFailure(resolve(original, `${result.id}.jsonl`));
    if (failure) billing.push({ id: result.id, status: 'billing-blocked', providerError: failure });
    else retained.push(result); // Includes every non-billing result, even poor performance.
  }
  for (const invalid of batch.invalidTrials) {
    assert(/^[\w-]+$/.test(invalid.id), 'Invalid trial id');
    assert(await billingFailure(resolve(original, `${invalid.id}.jsonl`)), 'Only documented billing interruptions can be retried');
    billing.push(invalid);
  }
  return { billing, retained };
}

/** Explicit continuation after funding. Never overwrite or silently retry an attempt. */
export async function resume(original: string, destination: string) {
  original = resolve(original); destination = resolve(destination);
  assert.notEqual(original, destination);
  const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
  if (!key) throw new Error('Real Jev credential required');
  const batch = JSON.parse(await readFile(resolve(original, 'results.json'), 'utf8'));
  const stopped = JSON.parse(await readFile(resolve(original, 'STOPPED.json'), 'utf8'));
  assert.equal(stopped.reason, 'billing-exhausted');
  const { billing, retained } = await continuationPlan(original, batch);
  await mkdir(destination); // Existing outputs are never reused.
  await cp(resolve(original, 'source'), resolve(destination, 'source'), { recursive: true, errorOnExist: true, force: false });
  await copyFile(new URL(import.meta.url), resolve(destination, 'continuation-source.ts'));
  for (const result of retained)
    for (const suffix of ['json', 'jsonl'])
      await copyFile(resolve(original, `${result.id}.${suffix}`), resolve(destination, `${result.id}.${suffix}`));
  const manifest = { ...batch.manifest, continuation: {
    recordedAt: new Date().toISOString(), originalDirectory: original,
    originalReport: `/.runtime/experiments/${original.split(/[\\/]/).at(-1)}/report.json`,
    retainedTrials: retained.map((r: any) => r.id), priorBillingAttempts: billing,
    rule: 'Continue the original frozen matrix after explicit funding. Retain all non-billing outcomes; retry only documented billing blocks. Original attempts remain in the linked original report, outside this conditional-on-service comparison. No prompt/configuration changes.',
  }};
  const output = { manifest, results: retained, invalidTrials: [] as any[] };
  const save = async () => writeFile(resolve(destination, 'results.json'), JSON.stringify(output));
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await save();
  // Execute the archived controller AND physics, not today's checkout. Hashes include raw bytes.
  const previous = process.cwd(), frozen = resolve(destination, 'source');
  const archived = await import(pathToFileURL(resolve(frozen, 'experiments/reactive/run.ts')).href);
  process.chdir(frozen);
  try {
    assert.equal(await archived.sourceHash(), manifest.sourceHash, 'Archived source differs from original freeze');
    await report(destination);
    for (const [index, seed] of manifest.seeds.entries()) {
      for (let offset = 0; offset < manifest.strategies.length; offset++) {
        const strategy = manifest.strategies[(index + offset) % manifest.strategies.length];
        const id = `${strategy}-${seed}`;
        if (retained.some((r: any) => r.id === id)) continue;
        console.log(JSON.stringify({ event: 'start', id, seconds: manifest.seconds }));
        try {
          output.results.push(await archived.trial({ arm: strategy, strategy, seed, seconds: manifest.seconds,
            directory: destination, key, phase: manifest.phase, config: manifest.configs[strategy], maxDecisions: manifest.maxDecisions }));
        } catch (error) {
          const invalid = { id, arm: strategy, seed, error: String(error) };
          output.invalidTrials.push(invalid);
          await writeFile(resolve(destination, `${id}.invalid.json`), JSON.stringify(invalid));
        }
        await save();
        const failure = await billingFailure(resolve(destination, `${id}.jsonl`));
        const tokens = output.results.reduce((n: number, r: any) => n + r.stats.usage.reduce((s: number, u: any) => s + (u.input_tokens ?? 0), 0), 0);
        console.log(JSON.stringify({ event: 'progress', id, complete: output.results.length, invalid: output.invalidTrials.length, tokens }));
        if (failure || tokens >= manifest.limits.maxReportedInputTokens || output.invalidTrials.length) {
          await writeFile(resolve(destination, 'STOPPED.json'), JSON.stringify({ reason: failure ? 'billing-exhausted' : output.invalidTrials.length ? 'infrastructure' : 'token-budget',
            message: 'Continuation stopped. All outcomes retained; no automatic retry.', trial: id, providerError: failure, tokens }));
          await report(destination);
          return;
        }
      }
      await report(destination);
    }
    await report(destination);
  } finally { process.chdir(previous); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: resume.ts <billing-stopped-original> <new-output-directory>');
  await resume(process.argv[2]!, process.argv[3]!);
}
