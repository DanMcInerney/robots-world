import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBenchRequest, YawBenchPlant, type Acquisition } from '../experiments/jev-spatial-text/bench.ts';
import { liveRequest } from '../experiments/jev-round1/live.ts';
import { cases, execute } from '../experiments/jev-round1/run.ts';
import { summarize, timing } from '../experiments/jev-round1/summary.ts';
import type { Request, Response } from '../experiments/jev-strategies/strategies.ts';

function fixture() {
  const a: Acquisition = { id: 'camera1', acquiredMs: 200, acquiredWallMs: 1000, deliveredWallMs: 1001, headingDeg: 0,
    attitudeErrorBoundDeg: .05, frame: 'frame.png', sha256: 'fixture', overflow: 0,
    calibration: { fx: 228.5, fy: 228.5, cx: 160, cy: 90 },
    objects: [{ id: 'blue1', color: 'blue', box: [190, 78, 212, 101], pixels: 506, rightDeg: 10.17, upDeg: 0, widthPercent: 6.875, clipped: false, history: [] }] };
  return buildBenchRequest('receipt', a, 220, 1020, new YawBenchPlant(), [a]);
}
function response(request: Request, key: string): Response {
  return { model: request.model, usage: { input_tokens: 1 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) =>
    [id, { type: 'choice', choice: key, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === key)])) }])) };
}
test('live temporal arms preserve geometry, questions and source; validity is explicitly at assembly', () => {
  const base = fixture(), original = structuredClone(base), raw = liveRequest(base, 'raw'), age = liveRequest(base, 'age'), valid = liveRequest(base, 'validity');
  assert.deepEqual(base, original); assert.deepEqual(raw.questions, base.questions);
  assert.equal(raw.state.temporalFacts, undefined); assert.equal((raw.state.snapshot as any).ageMs, undefined);
  const without = (r: any) => { const c = structuredClone(r); delete c.state.temporalFacts; return c; };
  assert.deepEqual(without(age), raw); assert.deepEqual(without(valid), raw);
  assert.equal((age.state.temporalFacts as any).sourceAgeMs, 20);
  assert.equal((valid.state.temporalFacts as any).sourceWithinAgeLimitAtAssembly, true);
  assert.match((valid.state.temporalContract as any).meaning, /not the later answer\/application/);
  (base.state.snapshot as any).assembledMs = 1201;
  assert.equal((liveRequest(base, 'validity').state.temporalFacts as any).sourceWithinAgeLimitAtAssembly, false);
  (base.state.snapshot as any).assembledMs = 220; (base.state.snapshot as any).assembledWallMs = 2001;
  assert.equal((liveRequest(base, 'validity').state.temporalFacts as any).sourceWithinAgeLimitAtAssembly, false);
});

test('execution sends only the chosen evidence branch and scores its actual response', async () => {
  const c = cases().find(p => p.meta.family === 'evidence' && p.meta.scenario === 'expired_depth_far')!;
  assert(c); const selected = c.expected.evidence![0]!, branch = c.meta.followups[selected], calls: any[] = [];
  const result = await execute(c, async (request, id) => { calls.push({ request, id }); return response(request, calls.length === 1 ? selected : branch.expected.decision[0]); });
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].request, branch.request); assert.equal(calls[1].id, c.id + '--followup');
  assert.equal(result.score.correct, true); assert.equal(result.score.unsafe, false);
  const keep = Object.keys(c.meta.operationKinds).find(k => c.meta.operationKinds[k] === 'keep')!;
  const guessed = await execute(c, async request => response(request, Object.hasOwn(request.questions, 'evidence') ? keep : c.meta.oracleDecision));
  assert.equal(guessed.score.correct, false); assert.equal(guessed.score.unsafe, true);
});

test('promotion requires useful positive decisions, complete confirmation and a gain over raw', () => {
  const rows = (rawCorrect: number, validCorrect: number, useful: boolean) => ['raw', 'age', 'validity'].flatMap(arm => Array.from({ length: 24 }, (_, i) => ({
    split: 'confirmation', arm, status: 'completed', correct: i < (arm === 'raw' ? rawCorrect : validCorrect), unsafe: false,
    task: 'evidence', details: { usefulOpportunity: i < 16, usefulSuccess: useful && i < 16, category: i < 10 ? 'nominal' : 'interrupted' }, timing: { latencyMs: 40 }
  })));
  const summarizeRows = (rs: any[]) => summarize(rs, [], [], {});
  assert.equal(summarizeRows(rows(20, 24, true)).primaryGate.pass, true);
  assert.equal(summarizeRows(rows(24, 24, true)).primaryGate.pass, false);
  assert.equal(summarizeRows(rows(20, 24, false)).primaryGate.pass, false);
  assert.equal(summarizeRows(rows(20, 24, true).slice(1)).primaryGate.pass, false);
  assert.equal(summarizeRows(rows(20, 24, true).filter(r => r.arm !== 'age')).primaryGate.complete, false);
  assert.deepEqual(timing([null, undefined, NaN]), { n: 0, p50: null, p95: null, max: null });
});
