import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FORMATS, encodeFacts, type Facts } from './encodings.ts';
import { ROOT, createMeter, digest, freezeStage, ledger, summarizeUsage, validateRequest, readCompleted, verifyFrozenStage } from './transport.ts';
import type { Request } from '../jev-strategies/strategies.ts';

export async function stereoCases() {
  const source = await readFile(resolve(ROOT, 'stereo/exports/sensor-records.json'), 'utf8');
  const records = JSON.parse(source).records;
  const cases = records.flatMap((record: any, index: number) => {
    const facts: Facts = {};
    for (const r of record.regions) {
      facts[`${r.id}_bearing_deg`] = r.bearingDeg;
      facts[`${r.id}_axial_depth_interval_m`] = r.depthIntervalM;
      facts[`${r.id}_valid_pixel_fraction`] = r.validCoverage;
      facts[`${r.id}_unknown_pixel_fraction`] = r.unknownFraction;
    }
    const expected: Record<string, string[]> = {};
    const questions: Request['questions'] = {};
    for (const r of record.regions) {
      const interval: [number, number] | null = r.depthIntervalM;
      const computed = interval === null ? 'unknown' : interval[1] < 1.5 ? 'near' : interval[0] >= 1.5 && interval[1] < 3 ? 'mid' : interval[0] >= 3 ? 'far' : 'boundary';
      assert.equal(computed, r.depthBin, 'Independent interval binning disagrees with export');
      expected[r.id] = [computed];
      questions[r.id] = { type: 'choice', instructions: `For ${r.id}, which depth bin is supported by the entire REPORTED axial-depth interval? Interpret the estimate as supplied, even though stereo can be wrong. Null means no supported estimate.`,
        criteria: { near: 'Entire interval below 1.5 metres.', mid: 'Entire interval at least 1.5 and below 3 metres.', far: 'Entire interval at least 3 metres.', boundary: 'Interval crosses one or more bin boundaries.', unknown: 'No reported depth interval supports a bin.' } };
    }
    questions.clearance = { type: 'choice', instructions: 'Do the observed depth intervals certify that every part of the frontal flight volume is clear, including unsupported pixels and the space between supported clusters?',
      criteria: { yes: 'The entire flight volume is certified clear.', no: 'No whole-volume clearance is established.' } };
    expected.clearance = ['no'];
    questions.distance = { type: 'choice', instructions: 'What distance convention do these estimates use?', criteria: {
      axial: 'Depth along the camera forward axis.', radial: 'Euclidean range from the camera to the point.', unknown: 'The distance convention is unspecified.' } };
    expected.distance = ['axial'];
    const order = [...FORMATS.slice(index % FORMATS.length), ...FORMATS.slice(0, index % FORMATS.length)];
    return order.map(format => ({ id: `sensor-${record.id}-${format}`, recordId: record.id, split: record.split, format,
      provenance: record.sourceType, sourceSha256: record.acquisition.sourceSha256, expected,
      request: { model: 'jev-1.13.0', state: {
        goal: 'Interpret the supplied stereo measurements and distinguish unknown space from observed depth.',
        evidence: 'Computed from an actual stereo image pair using calibrated OpenCV matching. Text interpretation is graded separately from physical depth accuracy; no reference depth, scene labels or correctness filters are supplied.',
        depthConvention: record.depthConvention, intervalMeaning: record.intervalMeaning,
        timing: { captureTimeKnown: record.acquisition.captureTimeKnown, ageMs: record.acquisition.acquisitionToTextAgeMs },
        frame: 'Camera-relative bearings in degrees: negative left, positive right. These are axial depths, not certified surface-free flight paths.',
        measurements: encodeFacts(facts, format),
      }, questions } satisfies Request }));
  });
  cases.forEach((c: any) => validateRequest(c.request));
  return { cases, sourceSha256: digest(source) };
}
export async function analyzeStereo(cases: any[]) {
  const frozen = await verifyFrozenStage('stereo-interpretation');
  assert.deepEqual(frozen.manifest.cases, cases, 'Frozen sensor/evaluator cases changed');
  const calls = new Map(ledger().map(r => [r.id, r]));
  const rows: any[] = [];
  for (const c of cases) {
    if (calls.get(c.id)?.status !== 'completed') continue;
    const response = await readCompleted(c.request, c.id, calls.get(c.id));
    for (const [question, accepted] of Object.entries(c.expected) as [string, string[]][]) {
      const a = response.answers[question];
      rows.push({ id: c.id, recordId: c.recordId, format: c.format, split: c.split, sourceType: c.provenance,
        question, accepted, choice: a.choice, confidence: a.confidence, correct: accepted.includes(a.choice) });
    }
  }
  const groups = new Map<string, any[]>();
  for (const r of rows) { const key = `${r.split}/${r.sourceType}/${r.format}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const summary = [...groups].map(([group, values]) => ({ group, correct: values.filter(r => r.correct).length, n: values.length,
    imagePairs: new Set(values.map(r => r.recordId)).size, errors: values.filter(r => !r.correct) }));
  const result = { cases: cases.length, completed: new Set(rows.map(r => r.id)).size,
    incomplete: cases.filter(c => calls.get(c.id)?.status !== 'completed').map(c => ({ id: c.id, status: calls.get(c.id)?.status ?? 'not-started' })),
    scope: 'All exported image pairs and all sectors, including sensor errors. Interpreter answers scored against supplied estimates; reference-depth accuracy belongs to the separate stereo report. No correctness-based filtering.', summary, rows };
  await writeFile(resolve(ROOT, 'stereo-interpretation-results.json'), JSON.stringify(result, null, 2));
  return { cases: result.cases, completed: result.completed, summary, usage: summarizeUsage() };
}
async function main() {
  const data = await stereoCases();
  if (process.argv.includes('qualify')) { console.log(JSON.stringify({ cases: data.cases.length, questions: data.cases.reduce((n: number, c: any) => n + Object.keys(c.expected).length, 0), sourceSha256: data.sourceSha256 })); return; }
  if (process.argv.includes('analyze')) { console.log(JSON.stringify(await analyzeStereo(data.cases))); return; }
  assert(process.argv.includes('--real'));
  await mkdir(ROOT, { recursive: true });
  await freezeStage('stereo-interpretation', data);
  const meter = createMeter({ key: process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? '' });
  try {
    let n = 0;
    for (const c of data.cases) { await meter.judge(c.request, c.id); n++; if (n % 20 === 0) console.log(JSON.stringify({ event: 'stereo-progress', n, total: data.cases.length })); }
  } finally { meter.close(); }
  console.log(JSON.stringify(await analyzeStereo(data.cases)));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
