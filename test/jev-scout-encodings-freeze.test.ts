import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {digest} from '../experiments/jev-spatial-text/transport.ts';
import {assertUnchangedPrefix, verify} from '../experiments/jev-scout-encodings/run.ts';

async function tempRoot(t: {after(fn: () => void): void}) {
  await mkdir(resolve('.runtime'), {recursive: true}); // absent on a fresh checkout (git-ignored)
  const dir = await mkdtemp(resolve('.runtime', 'scout-encodings-freeze-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('verify() accepts a matching frozen stage and rejects a changed live source file', async t => {
  const root = await tempRoot(t);
  const stage = resolve(root, 'freezes/fixed'), source = resolve(root, 'probe-source.ts');
  const sourcePath = relative(process.cwd(), source).replaceAll('\\', '/');
  const sourceBytes = 'export const marker = 1;\n';
  const copied = resolve(stage, 'source', sourcePath);
  await mkdir(dirname(copied), {recursive: true});
  await writeFile(copied, sourceBytes);
  await writeFile(source, sourceBytes);
  t.after(() => rm(source, {force: true}));

  const entries = [{path: sourcePath, sha256: digest(sourceBytes)}];
  const caseBytes = JSON.stringify([{id: 'x'}]) + '\n', plan = 'frozen plan body';
  await writeFile(resolve(root, 'cases.json'), caseBytes);
  await writeFile(resolve(stage, 'plan.md'), plan);
  await writeFile(resolve(stage, 'freeze.json'), JSON.stringify({
    model: 'jev-1.13.0', entries, sourceSha256: digest(JSON.stringify(entries)),
    manifest: {casesSha256: digest(caseBytes), planSha256: digest(plan)},
  }));

  await verify([{id: 'x'}] as any, true, root);
  await writeFile(source, 'export const marker = 2;\n');
  await assert.rejects(() => verify([{id: 'x'}] as any, true, root), /Live frozen source changed/);
});

test('assertUnchangedPrefix accepts an append-only confirmation suffix and rejects any change to the development prefix', () => {
  const prefix = Buffer.from('{"id":"dev-1","status":"completed"}\n'), hash = digest(prefix);
  assertUnchangedPrefix(Buffer.concat([prefix, Buffer.from('{"id":"confirm-1","status":"completed"}\n')]), prefix, hash);
  assert.throws(() => assertUnchangedPrefix(Buffer.from(''), prefix, hash));
  assert.throws(() => assertUnchangedPrefix(Buffer.from('{"id":"dev-X","status":"completed"}\n'), prefix, hash));
  assert.throws(() => assertUnchangedPrefix(prefix, Buffer.from('{"id":"other"}\n'), hash));
});

// The full validateSelection() round trip -- including its ledger re-derivation, which requires real
// ScoutCase-shaped requests/responses -- is covered in test/jev-scout-encodings-run.test.ts.
