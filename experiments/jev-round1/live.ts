import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { runBench, validateBenchResponse, BENCH_CONFIG, type BenchRequest, type BenchResponse, type BenchSummary } from '../jev-spatial-text/bench.ts';
import { adaptLiveRequest } from '../jev-spatial-refinement/live-adapter.ts';
import { digest, durable, ledger, readCompleted } from '../jev-spatial-text/transport.ts';
import type { Request, Response } from '../jev-strategies/strategies.ts';
import { ROOT, LIVE_PLAN, type Arm } from './protocol.ts';
import { readRecordedCall } from './evidence.ts';

/** All arms retain the previously successful symmetric geometric consequences. Only redundant time facts differ. */
export function liveRequest(engine: BenchRequest, arm: Arm): BenchRequest {
  const wire = adaptLiveRequest(engine, 'selected-representation', { arm: 'after-bearing__action-only', representation: 'after-bearing', heads: 'action-only' });
  const s = wire.state.snapshot as any;
  delete s.ageMs; delete s.wallAgeMs;
  wire.state.temporalContract = { maximumSourceAgeMs: BENCH_CONFIG.maxSourceAgeMs,
    meaning: 'Acquisition, delivery, request assembly and command application are distinct. All derived time facts refer only to this assembled snapshot, not the later answer/application time. A new frame may arrive during inference. Executor authority and source-age guards apply equally to every menu.' };
  if (arm !== 'raw') {
    const receipts = wire.state.receipts as any[];
    const ages: any = { sourceAgeMs: s.assembledMs - s.acquiredMs, sourceWallAgeMs: s.assembledWallMs - s.acquiredWallMs,
      receipts: receipts.map(c => ({ commandId: c.commandId, remainingLeaseMs: c.expiresMs === null ? null : c.expiresMs - s.assembledMs,
        appliedAgoMs: c.appliedMs === null ? null : s.assembledMs - c.appliedMs })) };
    if (arm === 'validity') {
      ages.sourceWithinAgeLimitAtAssembly = ages.sourceAgeMs >= 0 && ages.sourceAgeMs <= BENCH_CONFIG.maxSourceAgeMs
        && ages.sourceWallAgeMs >= 0 && ages.sourceWallAgeMs <= BENCH_CONFIG.maxSourceAgeMs;
      ages.receipts.forEach((r: any, i: number) => {
        const c = receipts[i];
        r.leaseUnexpiredAtAssembly = r.remainingLeaseMs !== null && r.remainingLeaseMs > 0;
        r.endedByRecordedEvent = c.events.some((e: any) => ['expired', 'superseded', 'interrupted', 'cancelled', 'rejected'].includes(e.stage));
      });
    }
    wire.state.temporalFacts = ages;
  }
  return wire;
}

async function inventory(directory: string) {
  const paths = (await readdir(directory, { recursive: true })).filter(f => /\.(json|jsonl|png)$/.test(f) && f !== 'finalization.json').sort();
  return Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(resolve(directory, path))) })));
}

export async function runLive(send: (request: Request, id: string, signal: AbortSignal) => Promise<Response>, sourceSha256: string, signal: AbortSignal) {
  for (const trial of LIVE_PLAN) {
    signal.throwIfAborted(); const directory = resolve(ROOT, 'live', trial.id);
    assert(!existsSync(directory), `Existing live attempt is never repeated: ${trial.id}`);
    const pending = new Set<Promise<BenchResponse>>(), ids: string[] = [], errors: string[] = [];
    const judge = (engine: BenchRequest, id: string) => {
      const wire = liveRequest(engine, trial.arm); ids.push(id);
      durable(resolve(directory, `${id}.wire-request.json`), wire, true);
      const promise = send(wire as Request, id, signal).then(answer => {
        const response = answer as unknown as BenchResponse; validateBenchResponse(wire, response);
        durable(resolve(directory, `${id}.wire-response.json`), response, true);
        // Same questions and yaw answer; the temporal adapter cannot select an action.
        validateBenchResponse(engine, response); return response;
      });
      pending.add(promise); void promise.then(() => pending.delete(promise), error => { pending.delete(promise); errors.push(String(error)); });
      return promise;
    };
    console.log(JSON.stringify({ event: 'live-start', trial }));
    let summary: BenchSummary | undefined;
    try { summary = await runBench({ ...trial, arm: 'receipt', outputDir: resolve(ROOT, 'live'), judge, signal }); }
    catch (error) { errors.push(String(error)); }
    await Promise.allSettled([...pending]); await immediate();
    for (const id of ids) {
      const sinks = ['response', 'late'].filter(suffix => existsSync(resolve(directory, `${id}.${suffix}.json`)));
      if (sinks.length !== 1) errors.push(`${id}: exactly one settled response/late sink required`);
    }
    const status = summary?.status === 'completed' && !errors.length ? 'completed' : 'infrastructure-invalid';
    durable(resolve(directory, 'finalization.json'), { trial, sourceSha256, status, errors, requestIds: ids, files: await inventory(directory) }, true);
    console.log(JSON.stringify({ event: 'live-finish', trial, summary, errors }));
    assert.equal(status, 'completed', 'Preserve invalid attempt; no retry/replacement');
  }
}

export async function readLive(sourceSha256: string, root = ROOT, plan = LIVE_PLAN) {
  const episodes: any[] = [], pending: any[] = [], calls = new Map(ledger(root).map(r => [r.id, r]));
  for (const trial of plan) {
    const base = `live/${trial.id}`, directory = resolve(root, base);
    if (!existsSync(resolve(directory, 'finalization.json'))) { pending.push({ ...trial, status: existsSync(directory) ? 'unfinalized' : 'not-started' }); continue; }
    const final = JSON.parse(await readFile(resolve(directory, 'finalization.json'), 'utf8'));
    assert.equal(final.sourceSha256, sourceSha256); assert.deepEqual(final.trial, trial);
    assert.deepEqual(await inventory(directory), final.files, 'Changed live evidence');
    if (!['trace.jsonl', 'commands.json', 'summary.json'].every(path => existsSync(resolve(directory, path)))) {
      assert.notEqual(final.status, 'completed');
      pending.push({ ...trial, status: final.status, errors: final.errors, evidence: `${base}/finalization.json` }); continue;
    }
    const trace = (await readFile(resolve(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const acquisitions = trace.filter(t => t.kind === 'acquisition').map(t => t.data);
    const commands = JSON.parse(await readFile(resolve(directory, 'commands.json'), 'utf8'));
    const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'));
    const decisions = [];
    for (const id of final.requestIds) {
      const engine = JSON.parse(await readFile(resolve(directory, `${id}.request.json`), 'utf8'));
      const request = liveRequest(engine, trial.arm), call = await readRecordedCall(request as Request, id, calls.get(id), root), response = call.response;
      assert.deepEqual(JSON.parse(await readFile(resolve(directory, `${id}.wire-request.json`), 'utf8')), request);
      const late = existsSync(resolve(directory, `${id}.late.json`));
      const sinkPath = resolve(directory, `${id}.${late ? 'late' : 'response'}.json`);
      const sink = existsSync(sinkPath) ? JSON.parse(await readFile(sinkPath, 'utf8')) : null;
      if (call.status === 'completed') {
        assert.deepEqual(JSON.parse(await readFile(resolve(directory, `${id}.wire-response.json`), 'utf8')), response);
        assert.equal(sink?.error, null); assert.deepEqual(sink.answer, response);
      } else assert.notEqual(final.status, 'completed', 'Completed episode contains an incomplete call');
      if (late) assert.equal(sink.discarded, true);
      const source = acquisitions.find(a => a.id === engine.state.snapshot.id); assert(source);
      const cmd = commands.find((c: any) => c.requestId === id) ?? null, row = calls.get(id);
      const returnedWall = Number.isFinite(row?.latencyMs) ? row.dispatchedAtMs + row.latencyMs : null;
      const responseEvent = trace.find(t => t.kind === 'response' && t.data.requestId === id);
      const application = trace.find(t => t.kind === 'command-stage' && t.data.command.requestId === id && t.data.event.stage === 'applied');
      if (cmd) { assert.equal(call.status, 'completed'); assert.equal(cmd.action, response!.answers.yaw.choice); }
      decisions.push({ id, status: call.status, error: call.error, atMs: engine.state.snapshot.assembledMs, request, response, sourceFrame: `${base}/${source.frame}`,
        sourceAcquiredMs: source.acquiredMs, sourceAgeAtAssemblyMs: engine.state.snapshot.assembledMs - source.acquiredMs,
        httpStartedAtMs: row?.dispatchedAtMs ?? null, httpLatencyMs: row?.latencyMs ?? null, assemblyToHttpMs: row ? row.dispatchedAtMs - engine.state.snapshot.assembledWallMs : null,
        responseAtMs: responseEvent?.simMs ?? null, applicationAtMs: cmd?.appliedMs ?? null, discardedLate: late,
        sourceWallAgeAtResponseMs: returnedWall === null ? null : returnedWall - source.acquiredWallMs,
        sourceAgeAtApplicationMs: cmd?.appliedMs == null ? null : cmd.appliedMs - source.acquiredMs,
        wallAgeAtApplicationMs: application ? application.wallMs - source.acquiredWallMs : null,
        newerFramesDuringRequest: returnedWall === null ? null : acquisitions.filter(a => a.acquiredWallMs > row.dispatchedAtMs && a.acquiredWallMs <= returnedWall).length,
        newerFramesByApplication: application ? acquisitions.filter(a => a.acquiredMs > source.acquiredMs && a.acquiredMs <= application.simMs).length : null,
        selectedAction: call.status === 'completed' ? response!.answers.yaw.choice : null, command: cmd });
    }
    episodes.push({ ...trial, summary, status: final.status, errors: final.errors, commands, decisions,
      frames: acquisitions.map(a => ({ ...a, atMs: a.acquiredMs, path: `${base}/${a.frame}` })) });
  }
  return { episodes, pending };
}
