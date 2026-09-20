import type { ResultRow } from './run.ts';

const count = (rows: ResultRow[], predicate: (r: ResultRow) => unknown) => rows.filter(predicate).length;
const percentile = (values: number[], q: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]! : null;
const details = (r: ResultRow) => r.score?.details ?? {};
export function summarize(results: ResultRow[], freshness: any) {
  const grouped = new Map<string, ResultRow[]>();
  for (const r of results) { const key = `${r.technique}/${r.split}/${r.arm}`; grouped.set(key, [...(grouped.get(key) ?? []), r]); }
  const groups = [...grouped.entries()].map(([key, rows]) => {
    const completed = rows.filter(r => r.status === 'completed');
    const repeats = new Map<string, ResultRow[]>();
    for (const r of completed) { const k = `${r.unit}/${details(r).copies ?? ''}`; repeats.set(k, [...(repeats.get(k) ?? []), r]); }
    return { key, technique: rows[0]!.technique, split: rows[0]!.split, arm: rows[0]!.arm, planned: rows.length, completed: completed.length,
      missing: count(rows, r => r.status === 'missing'), errors: count(rows, r => r.status === 'error'),
      correct: count(completed, r => r.score?.correct), unsafe: count(completed, r => r.score?.unsafe),
      falseCommitments: count(completed, r => details(r).falseCommitment || (r.technique === 'T2' && r.score?.unsafe)),
      usefulAcceptance: count(completed, r => details(r).usefulAcceptance), overAbstention: count(completed, r => details(r).overAbstention),
      appropriateAbstention: count(completed, r => details(r).appropriateAbstention || details(r).justifiedAbstention),
      exactDecisionCorrect: count(completed, r => details(r).exactDecisionCorrect), gateDisagreements: count(completed, r => details(r).gateDisagreement),
      evidenceUseful: count(completed, r => details(r).selectionUseful), evidenceResolved: count(completed, r => details(r).selectionResolvesTask),
      acquiredRecords: completed.reduce((n, r) => n + (details(r).acquiredRecords ?? 0), 0),
      inappropriateMotion: count(completed, r => details(r).inappropriateMotion), wrongDirection: count(completed, r => details(r).wrongDirection),
      requiredTurnOpportunities: count(completed, r => r.technique === 'T4' && details(r).currentFramed === false),
      usefulRequiredTurns: count(completed, r => r.technique === 'T4' && details(r).currentFramed === false && r.score?.correct),
      needlessResets: count(completed, r => details(r).needlessReset), recoveredFailures: count(completed, r => details(r).recoveredFailure),
      completedJobs: count(completed, r => details(r).completed),
      progressSum: completed.reduce((n, r) => n + (details(r).progress ?? 0), 0),
      discardedReadings: completed.reduce((n, r) => n + (details(r).discardedReadings ?? 0), 0),
      latencyP50Ms: percentile(completed.map(r => r.latencyMs!), .5), latencyP95Ms: percentile(completed.map(r => r.latencyMs!), .95),
      tokens: completed.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      repeatedGroups: [...repeats.values()].filter(r => r.length === 2).length,
      repeatedDecisionDisagreements: [...repeats.values()].filter(r => r.length === 2 && r[0]!.score!.decision !== r[1]!.score!.decision).length };
  });
  const duplication: { split: string; arm: string; pairs: number; modeFlips: number; physicalFlips: number; levels: { copies: number; rows: number; correct: number; inappropriateMotion: number }[] }[] = [];
  for (const split of ['development', 'confirmation']) for (const arm of ['flat', 'conditional']) {
    const rows = results.filter(r => r.technique === 'T4' && r.split === split && r.arm === arm && r.status === 'completed');
    const units = [...new Set(rows.map(r => `${r.unit}/${r.replicate}`))];
    let pairs = 0, modeFlips = 0, physicalFlips = 0;
    for (const unit of units) {
      const pair = rows.filter(r => `${r.unit}/${r.replicate}` === unit), one = pair.find(r => details(r).copies === 1), eight = pair.find(r => details(r).copies === 8);
      if (!one || !eight) continue; pairs++;
      if (details(one).mode !== details(eight).mode) modeFlips++;
      if (one.score!.decision !== eight.score!.decision) physicalFlips++;
    }
    duplication.push({ split, arm, pairs, modeFlips, physicalFlips,
      levels: [1, 8].map(copies => ({ copies, rows: rows.filter(r => details(r).copies === copies).length,
        correct: count(rows, r => details(r).copies === copies && r.score?.correct), inappropriateMotion: count(rows, r => details(r).copies === copies && details(r).inappropriateMotion) })) });
  }
  const group = (technique: string, arm: string) => groups.find(g => g.technique === technique && g.split === 'confirmation' && g.arm === arm);
  const comparison = (technique: string, baseline: string, candidate: string, condition: (a: NonNullable<ReturnType<typeof group>>, b: NonNullable<ReturnType<typeof group>>) => boolean) => {
    const a = group(technique, baseline), b = group(technique, candidate);
    const complete = !!a && !!b && a.completed === a.planned && b.completed === b.planned;
    return { technique, baseline, candidate, complete, pass: complete && condition(a!, b!),
      conclusion: !complete ? 'inconclusive: incomplete evidence' : condition(a!, b!) ? 'pursue a larger independent test' : 'no demonstrated incremental benefit under the predeclared gate',
      baselineCorrect: a?.correct ?? 0, candidateCorrect: b?.correct ?? 0, denominatorPerArm: b?.planned ?? 0 };
  };
  const age = freshness.summary.find((g: any) => g.arm === 'age-only'), whole = freshness.summary.find((g: any) => g.arm === 'whole-observation'), dependency = freshness.summary.find((g: any) => g.arm === 'action-dependencies');
  const gates = [
    comparison('T1', 'fixed_depth', 'jev_selected', (a, b) => b.correct >= 14 && b.correct - a.correct >= 4 && b.falseCommitments <= a.falseCommitments),
    comparison('T2', 'single_choice', 'independent_adequacy', (a, b) => a.falseCommitments - b.falseCommitments >= 2 && b.falseCommitments === 0 && b.usefulAcceptance >= 7 && b.usefulAcceptance >= a.usefulAcceptance - 1),
    { technique: 'T3', complete: true, pass: dependency.unsafeApplied === 0 && dependency.missedUseful === 0 && dependency.unsafeApplied < age.unsafeApplied && dependency.missedUseful < whole.missedUseful,
      conclusion: 'Engineering fixture qualification only; no model or physical-safety performance claim.', baseline: age, wholeObservation: whole, candidate: dependency },
    comparison('T4', 'flat', 'conditional', (a, b) => {
      const flat = duplication.find(g => g.split === 'confirmation' && g.arm === 'flat')!, factored = duplication.find(g => g.split === 'confirmation' && g.arm === 'conditional')!;
      return (b.correct - a.correct >= 4 || flat.modeFlips - factored.modeFlips >= 2) && b.correct >= a.correct
        && b.usefulRequiredTurns >= 14 && b.usefulRequiredTurns >= a.usefulRequiredTurns && b.inappropriateMotion <= a.inappropriateMotion;
    }),
    comparison('T5', 'job-reference', 'explicit-lifecycle', (a, b) => b.correct >= 14 && b.correct - a.correct >= 3 && b.needlessResets <= a.needlessResets && b.unsafe <= a.unsafe),
  ];
  const disagreements = [];
  for (const technique of ['T1', 'T2', 'T4', 'T5']) {
    const rows = results.filter(r => r.technique === technique && r.status === 'completed');
    const keys = [...new Set(rows.map(r => `${r.split}/${r.unit}/${r.replicate}/${details(r).copies ?? ''}`))];
    for (const key of keys) {
      const pair = rows.filter(r => `${r.split}/${r.unit}/${r.replicate}/${details(r).copies ?? ''}` === key);
      if (pair.length !== 2) continue;
      if (pair[0]!.score!.decision !== pair[1]!.score!.decision || pair[0]!.score!.correct !== pair[1]!.score!.correct) disagreements.push({ technique, key, rows: pair.map(r => ({ id: r.id, arm: r.arm, score: r.score, initialAnswers: r.initialAnswers, finalAnswers: r.finalAnswers })) });
    }
  }
  return { scope: 'Fixed component probes and deterministic dispatcher qualification. Repetitions and mirrored/family instances are correlated; there are no full drone mission results.',
    groups, duplication, freshness: freshness.summary, gates, errorRows: results.filter(r => r.status !== 'completed').map(r => ({ id: r.id, status: r.status, reason: r.meta?.error })),
    failures: results.filter(r => r.status === 'completed' && !r.score?.correct).map(r => ({ id: r.id, split: r.split, technique: r.technique, arm: r.arm, expected: r.expected, initialAnswers: r.initialAnswers, finalAnswers: r.finalAnswers, score: r.score })),
    disagreements };
}
