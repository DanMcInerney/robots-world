import test from 'node:test';
import assert from 'node:assert/strict';
import { perceptionSummary, readResults } from '../experiments/jev-round2/run.ts';
import type { SensorRecord } from '../experiments/jev-round2/protocol.ts';
import { generateCases } from '../experiments/jev-round2/decisions.ts';
import { durable, digest } from '../experiments/jev-spatial-text/transport.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function sample(i: number, reference: number | null, measured: number | null): SensorRecord {
  return { id: `test-${i}`, sceneId: `scene-${i}`, split: 'confirmation', method: 'stereo', leftPath: '', rightPath: '',
    observation: {source: 'rendered_rgb', targetStatus: reference === null ? 'missing' : 'single',
      axialDepthIntervalM: measured === null ? null : [measured - .1, measured + .1], axialDepthM: measured,
      validFraction: measured === null ? 0 : 1, bearingDeg: 0, intervalMeaning: 'Fixture only'},
    evaluation: {referenceAxialDepthM: reference, family: reference === null ? 'missing' : 'nominal'}};
}
const grade = (rows: SensorRecord[]) => perceptionSummary(rows).groups.find(g => g.split === 'confirmation' && g.method === 'stereo');
const good = () => [...Array.from({length: 6}, (_, i) => sample(i, 8 + i, 8 + i)), ...Array.from({length: 3}, (_, i) => sample(i + 6, null, null))];
test('Round 2 perception gate rejects always unknown and sparse favorable support', () => {
  assert.equal(grade(good()).gate, true);
  assert.equal(grade(good().map(r => ({...r, observation: {...r.observation, axialDepthIntervalM: null, axialDepthM: null}}))).gate, false);
  const sparse = good(); for (const r of sparse.slice(0, 2)) {r.observation.axialDepthIntervalM = null; r.observation.axialDepthM = null;}
  assert.equal(grade(sparse).gate, false);
});
test('Round 2 perception gate counts severe optimistic depth and false range on missing target', () => {
  const wrong = good(); wrong[0] = sample(0, 8, 5);
  assert.equal(grade(wrong).underestimatedOver2M, 1); assert.equal(grade(wrong).gate, false);
  const falseRange = good(); falseRange[6] = sample(6, null, 10);
  assert.equal(grade(falseRange).unknownCorrect, 2); assert.equal(grade(falseRange).gate, false);
});
test('Round 2 abrupt interruption before HTTP receipt remains an uncertain scored outcome', async t => {
  const prefix = resolve(tmpdir(), 'jev-round2-interrupted-');
  const root = await mkdtemp(prefix); assert(root.startsWith(prefix));
  t.after(() => rm(root, {recursive: true, force: true}));
  const probe = generateCases([sample(0, 10, 10)])[0];
  durable(join(root, 'requests', probe.id + '.json'), probe.request, true);
  durable(join(root, 'requests.jsonl'), {id: probe.id, status: 'dispatched', requestSha256: digest(JSON.stringify(probe.request)), reserve: 65536});
  const result = await readResults(root, [probe]);
  assert.equal(result.length, 1); assert.equal(result[0].status, 'error'); assert.equal(result[0].httpEvidence, null);
  assert.equal(result[0].score.completed, false); assert.equal(result[0].score.interpretationCorrect, false);
  assert.match(result[0].error!, /Unresolved call/);
});
