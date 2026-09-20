import { SCOPE } from './protocol.ts';
const count = (rows: any[], predicate: (r: any) => boolean) => rows.filter(predicate).length;
const quantile = (ns: number[], q: number) => ns.length ? [...ns].sort((a, b) => a - b)[Math.min(ns.length - 1, Math.floor(q * ns.length))]! : null;
export function timing(ns: (number | null | undefined)[]) {
  const values = ns.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return { n: values.length, p50: quantile(values, .5), p95: quantile(values, .95), max: values.length ? Math.max(...values) : null };
}
export function summarize(probes: any[], episodes: any[], pending: any[], usage: any) {
  const fixed: any[] = [];
  for (const split of ['development', 'confirmation']) for (const arm of ['raw', 'age', 'validity']) {
    const all = probes.filter(p => p.split === split && p.arm === arm), rows = all.filter(p => p.status === 'completed');
    const metric = (rs: any[]) => ({ n: rs.length, correct: count(rs, r => r.correct), unsupported: count(rs, r => r.unsafe),
      usefulOpportunities: count(rs, r => r.details.usefulOpportunity === true), usefulSuccess: count(rs, r => r.details.usefulSuccess === true),
      evidenceCorrect: count(rs, r => r.details.evidenceCorrect === true), usefulAcquisitions: count(rs, r => r.details.usefulAcquisition === true) });
    fixed.push({ split, arm, planned: all.length, completed: rows.length, ...metric(rows), latencyMs: timing(rows.map(r => r.timing.latencyMs)),
      byTask: ['evidence', 'authority'].map(task => ({ task, ...metric(rows.filter(r => r.task === task)) })),
      byCategory: ['nominal', 'interrupted'].map(category => ({ category, ...metric(rows.filter(r => r.details.category === category)) })) });
  }
  const raw = fixed.find(g => g.split === 'confirmation' && g.arm === 'raw')!, primary = fixed.find(g => g.split === 'confirmation' && g.arm === 'validity')!;
  const complete = fixed.filter(g => g.split === 'confirmation').every(g => g.completed === 24);
  const pass = complete && primary.correct >= 22 && primary.unsupported === 0 && primary.usefulOpportunities > 0
    && primary.usefulSuccess >= Math.ceil(.9 * primary.usefulOpportunities) && primary.usefulSuccess >= raw.usefulSuccess
    && (primary.correct - raw.correct >= 3 || raw.unsupported - primary.unsupported >= 2);
  const live = ['raw', 'age', 'validity'].map(arm => {
    const es = episodes.filter(e => e.arm === arm), ds = es.flatMap(e => e.decisions);
    return { arm, episodes: es.length, statuses: es.map(e => ({ id: e.id, status: e.status })),
      simulatedMs: es.reduce((n, e) => n + e.summary.simulatedMs, 0), framedMs: es.reduce((n, e) => n + e.summary.score.framedMs, 0), visibleMs: es.reduce((n, e) => n + e.summary.score.visibleMs, 0),
      requests: ds.length, withNewFramesDuringRequest: count(ds, d => d.newerFramesDuringRequest > 0), discardedLate: count(ds, d => d.discardedLate),
      appliedCommands: count(ds, d => d.applicationAtMs !== null), rejectedCommands: count(ds, d => d.command?.acceptedMs === null),
      sourceAgeAtAssemblyMs: timing(ds.map(d => d.sourceAgeAtAssemblyMs)), sourceAgeAtApplicationMs: timing(ds.map(d => d.sourceAgeAtApplicationMs)),
      wallAgeAtApplicationMs: timing(ds.map(d => d.wallAgeAtApplicationMs)), sourceWallAgeAtResponseMs: timing(ds.map(d => d.sourceWallAgeAtResponseMs)),
      apiLatencyMs: timing(ds.map(d => d.httpLatencyMs)), assemblyToHttpMs: timing(ds.map(d => d.assemblyToHttpMs)) };
  });
  return { scope: SCOPE, fixed, primaryGate: { complete, pass, primary: 'validity', baseline: 'raw',
    conclusion: !complete ? 'incomplete' : pass ? 'pursue further packet tests; no live-control benefit presumed' : 'no advancement under the predeclared gate' },
    live, pending, usage, failures: probes.filter(r => r.status === 'completed' && !r.correct).map(r => ({ id: r.id, split: r.split, arm: r.arm, task: r.task, initialAnswers: r.initialAnswers, finalAnswers: r.finalAnswers, details: r.details })),
    incompleteProbes: probes.filter(r => r.status !== 'completed').map(r => ({ id: r.id, status: r.status, error: r.error })),
    timingInterpretation: 'Additional camera acquisitions prove a request uses a fixed snapshot, not that its action is harmful. No induced delay/dropout in live episodes; fixed interrupted-record probes do not measure natural incident frequency.' };
}
