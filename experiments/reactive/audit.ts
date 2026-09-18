import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Post-run evidence audit. No model calls, reruns, policy changes or rescoring. */
export async function audit(directory: string) {
  const excluded = await access(resolve(directory, 'EXCLUDED.json')).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
  assert(!excluded, 'Excluded batch cannot be audited as the final comparison');
  const { manifest, results, failures = [], invalidTrials = [] } = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
  assert.equal(invalidTrials.length, 0, 'Infrastructure-invalid trials prevent a qualified complete comparison');
  assert.equal(results.length + failures.length, manifest.arms.length * manifest.seeds.length, 'Comparison is incomplete');
  assert.equal(new Set([...results, ...failures].map((r: any) => r.id)).size, results.length + failures.length, 'Duplicate trial');
  const environment = new Map<number, string>(), runs = [];
  const publicKeys = ['goal', 'goalVersion', 'goalReceivedMs', 'simMs', 'odometry', 'target', 'camera', 'ranges', 'touching', 'lastActions', 'measuredCurrentGeometry', 'modelAuthoredAdvice', 'capabilities', 'representation', 'sensorAssumptions'];
  function publicState(state: any) {
    assert(state && typeof state === 'object');
    assert(Object.keys(state).every(k => publicKeys.includes(k)), 'Unexpected field in model state');
    for (const id of ['odometry', 'camera', 'ranges', 'target']) {
      const sample = state[id]; if (!sample) continue;
      assert(sample.acquiredMs <= sample.receivedMs && sample.receivedMs <= state.simMs, `Noncausal ${id} timestamp`);
    }
    assert(state.lastActions.length <= 4, 'Unbounded action history');
    assert(state.ranges.value.points.length <= state.ranges.value.rayCount, 'Invalid range observation');
  }
  for (const result of results) {
    assert.equal(result.id, `${result.arm}-${result.seed}`);
    assert(manifest.arms.includes(result.arm) && manifest.seeds.includes(result.seed));
    assert.equal(result.sourceHash, manifest.sourceHash);
    const motion = JSON.stringify(result.evaluation.trajectory.map((f: any) => [f.simMs, f.target, f.crossing]));
    if (environment.has(result.seed)) assert.equal(motion, environment.get(result.seed), `Environmental motion differs for ${result.id}`);
    else environment.set(result.seed, motion);
    let count = 0, last: any, trialManifest: any, goalVersion = 1, latestMenu: any, lastWorldId = 0;
    let goal: any, advice: string | undefined, installedMs: number | null = null;
    const counts = { requests: 0, decisions: 0, admitted: 0, rejected: 0, worldEvents: 0, sensorSamples: 0, protocolReceives: 0, expiryHolds: 0, sourceAgeRejects: 0, goalRejects: 0, jevHttpResponses: 0, advisorRequests: 0, repairedAdviceRequests: 0 };
    const errors: Record<string, number> = {}, reportedJevUsage: any[] = [];
    let firstSecondGoalAdmissionMs: number | null = null;
    const acceptedChoices: string[] = [], confidence: number[] = [];
    for await (const line of createInterface({ input: createReadStream(resolve(directory, `${result.id}.jsonl`)), crlfDelay: Infinity })) {
      const row = JSON.parse(line); count++; last = row; const d = row.data;
      assert.notEqual(row.kind, 'reactive.invalid', 'Invalid trace');
      if (row.kind === 'reactive.manifest') { trialManifest = d; advice = d.initialBrief ?? undefined; }
      if (row.kind === 'reactive.menu') { latestMenu = d; assert(d.candidates.length <= 212 && (d.candidates.length > 0 || trialManifest?.config?.version === 'reactive-v3')); }
      if (row.kind === 'reactive.goal') { goalVersion = d.goalVersion; goal = d; }
      if (row.kind === 'reactive.repair' && d.accepted) { advice = d.instructions; installedMs = d.simMs; }
      if (row.kind === 'jev.request') {
        counts.requests++; publicState(d.request.state);
        assert.equal(d.request.model, 'jev-1.13.0');
        assert.equal(d.request.state.goalVersion, goalVersion);
        assert.equal(d.request.state.modelAuthoredAdvice, advice);
        if (installedMs !== null) counts.repairedAdviceRequests++;
        assert.equal(Object.keys(d.request.questions).length, 5);
        assert.equal(d.menuHash, latestMenu.menuHash);
        const branches = Object.entries(d.request.questions).filter(([k]) => k !== 'camera');
        const ids = branches.flatMap(([, q]: [string, any]) => Object.keys(q.criteria)).sort();
        assert.deepEqual(ids, latestMenu.candidates.map((c: any) => c.id).sort());
      }
      if (row.kind === 'codex.request' || row.kind === 'claude.request') {
        if (d.prompt.publicState) { counts.advisorRequests++; publicState(d.prompt.publicState); }
        else { counts.requests++; publicState(d.prompt.state); assert.equal(d.prompt.state.goalVersion, goalVersion); assert.deepEqual(Object.keys(d.prompt.candidates).sort(), latestMenu.candidates.map((c: any) => c.id).sort()); }
      }
      if (row.kind === 'reactive.port.observation') {
        assert.deepEqual(Object.keys(d).sort(), ['epoch', 'robotId', 'sequence', 'simMs', 'wallMs', 'goal', 'sensors', 'jobs', 'inbox', 'events'].sort());
        assert(Object.keys(d.sensors).every(k => ['odometry', 'camera', 'ranges', 'contact', 'target'].includes(k)));
        for (const sample of Object.values(d.sensors) as any[]) assert(sample.acquiredSimMs <= sample.receivedSimMs && sample.receivedSimMs <= d.simMs);
      }
      if (row.kind === 'reactive.camera.command' && trialManifest?.config) assert(d.remainingMs > 0 && d.simMs < d.expiresMs);
      if (row.kind === 'reactive.decision') {
        counts.decisions++; assert.equal(d.menuHash, latestMenu.menuHash);
        const offered = latestMenu.candidates.find((c: any) => c.id === d.candidate.id);
        assert.deepEqual(d.candidate, offered, 'Executed action differs from offered candidate');
        assert.equal(d.answer.value.choice, d.candidate.id);
        if (d.receipt.accepted) {
          counts.admitted++; acceptedChoices.push(d.candidate.id);
          assert.equal(d.source.goalVersion, goalVersion, 'Old goal admitted');
          assert(d.simMs - d.source.odometryMs <= (trialManifest?.sourceAgeLimitMs ?? 5000), 'Stale observation admitted');
          if (goal && firstSecondGoalAdmissionMs === null) firstSecondGoalAdmissionMs = d.simMs - goal.simMs;
        } else {
          counts.rejected++;
          if (d.receipt.reason === 'stale-observation') counts.sourceAgeRejects++;
          if (d.receipt.reason === 'superseded-goal') counts.goalRejects++;
        }
      }
      if (row.kind === 'jev.response') {
        counts.jevHttpResponses++; if (d.body.usage) reportedJevUsage.push(d.body.usage);
        const branch = d.body.answers?.camera?.choice, value = d.body.answers?.[`maneuver_${branch}`]?.confidence;
        if (typeof value === 'number') confidence.push(value);
      }
      if (row.kind === 'reactive.error' || row.kind === 'reactive.repair.error') errors[d.error] = (errors[d.error] ?? 0) + 1;
      if (row.kind === 'reactive.expired') counts.expiryHolds++;
      if (row.kind === 'world.event') {
        counts.worldEvents++; assert.equal(d.id, lastWorldId + 1, 'World journal gap'); lastWorldId = d.id; assert(!d.truncated);
        if (d.robotId === 'drone' && d.channel === 'sensor') counts.sensorSamples++;
        if (d.robotId === 'drone' && d.channel === 'protocol' && d.kind === 'rx') counts.protocolReceives++;
      }
    }
    assert.equal(last?.kind, 'trace.complete'); assert.equal(last.data.count, count - 1); assert.equal(last.data.dropped, 0);
    assert.equal(trialManifest.sourceHash, manifest.sourceHash); assert.equal(trialManifest.arm, result.arm); assert.equal(trialManifest.seed, result.seed);
    if (manifest.phase !== 'fixture') assert.equal(counts.requests, result.stats.started); assert.equal(counts.admitted, result.stats.admitted); assert.equal(counts.rejected, result.stats.rejected);
    assert.equal(goalVersion, 2); if (manifest.phase !== 'fixture') assert(result.maxLagMs <= 1000 && Math.abs(result.wallMs - result.seconds * 1000) < 1100);
    if (trialManifest.config) { assert.deepEqual(trialManifest.config, manifest.config); assert.deepEqual(result.config, manifest.config); assert.deepEqual(result.evaluation.metric, manifest.config.scoring); }
    assert(counts.worldEvents > 0 && counts.sensorSamples > 0);
    assert(result.evaluation.trajectory.length === result.seconds * 10);
    runs.push({ id: result.id, counts, errors, firstSecondGoalAdmissionMs, repairedAdviceInstalledMs: installedMs,
      admittedDistinctChoices: new Set(acceptedChoices).size, hoverAdmissions: acceptedChoices.filter(id => /^m0c/.test(id)).length,
      selectedBranchConfidenceMean: confidence.length ? confidence.reduce((a, b) => a + b, 0) / confidence.length : null,
      reportedJevInputTokens: reportedJevUsage.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
      completedButNotAdmittedOrRejectedAtDeadline: result.stats.completed - counts.decisions });
  }
  for (const failure of failures) {
    assert.equal(failure.sourceHash, manifest.sourceHash); assert.equal(failure.success, false);
    const rows = (await readFile(resolve(directory, `${failure.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.at(-1).kind, 'trace.complete');
    assert.equal(rows.find(r => r.kind === 'reactive.invalid')?.data.error, 'Error: No legal candidates or menu too large');
    const observed = rows.filter(r => r.kind === 'reactive.evaluation.frame').map(r => r.data);
    assert.deepEqual(observed, failure.trajectory); assert.equal(observed.at(-1).simMs, failure.observedMs);
    assert(observed.some(f => f.drone.z < .7 || f.drone.z > 6 || Math.abs(f.drone.x) > 18 || Math.abs(f.drone.y) > 18));
    const paired = results.find((r: any) => r.seed === failure.seed); assert(paired, 'No paired full flight');
    assert.deepEqual(observed.map(f => [f.simMs, f.target, f.crossing]), paired.evaluation.trajectory.slice(0, observed.length).map((f: any) => [f.simMs, f.target, f.crossing]));
    for (const row of rows) {
      const state = row.kind === 'jev.request' ? row.data.request.state : ['codex.request', 'claude.request'].includes(row.kind) ? row.data.prompt.state ?? row.data.prompt.publicState : undefined;
      if (state) publicState(state);
    }
  }
  const output = { sourceHash: manifest.sourceHash, complete: true, trials: runs.length, terminated: failures.length, pairedMotionVerifiedSeeds: [...environment.keys()], runs };
  await writeFile(resolve(directory, 'audit.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ complete: true, trials: runs.length, terminated: failures.length, pairedMotionVerifiedSeeds: [...environment.keys()] })); return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await audit(resolve(process.argv[2] ?? '.runtime/experiments/reactive-held-out-v2'));
