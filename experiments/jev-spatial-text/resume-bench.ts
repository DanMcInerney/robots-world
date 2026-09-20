import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { BENCH_ARMS, runBench, type BenchResponse, type BenchSummary } from './bench.ts';
import { PLAN } from './run-bench.ts';
import { ROOT, createMeter, digest, durable, freezeStage, ledger, readCompleted, summarizeUsage, verifyFrozenStage } from './transport.ts';

const FAILED = 'yaw-v2-1-0-receipt', STAGE = 'yaw-bench-recovery', DIRECTORY = 'bench-recovery';
const SUPPLEMENT = resolve(ROOT, 'bench-v2-supplemental-late-files.json');
export const RECOVERY_PLAN = PLAN.slice(14).map(t => t.id === FAILED ? { ...t, id: t.id + '-r1' } : t);
async function entries(directory: string) {
  const paths = (await readdir(directory, { recursive: true })).filter(f => /\.(json|jsonl|png)$/.test(f) && f !== 'finalization.json').sort();
  return Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(resolve(directory, path))) })));
}
export async function settleSinks(dir: string, ids: string[], pending: Set<Promise<unknown>>) {
  await Promise.allSettled([...pending]);
  await immediate();
  return ids.filter(id=>!existsSync(resolve(dir,id+'.response.json')) && !existsSync(resolve(dir,id+'.late.json'))).map(id=>`Missing settled response sink: ${id}`);
}
async function verify(trial: typeof PLAN[number], directory: string, sourceSha256: string, status: string) {
  const dir = resolve(ROOT, directory, trial.id), final = JSON.parse(await readFile(resolve(dir, 'finalization.json'), 'utf8'));
  assert.equal(final.status, status); assert.deepEqual(final.trial, trial); assert.equal(final.sourceSha256, sourceSha256);
  const supplement = directory === 'bench-v2' ? JSON.parse(await readFile(SUPPLEMENT,'utf8')).attempts.find((a: any)=>a.id===trial.id) : null;
  if (supplement) assert.equal(supplement.originalFinalizationSha256,digest(await readFile(resolve(dir,'finalization.json'))));
  const expected = [...final.files,...(supplement?.extraFiles ?? [])].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(await entries(dir), expected);
  const calls = new Map(ledger().map(r => [r.id, r]));
  for (const id of final.requestIds) await readCompleted(JSON.parse(await readFile(resolve(ROOT, 'requests', id + '.json'), 'utf8')), id, calls.get(id));
  return JSON.parse(await readFile(resolve(dir, 'summary.json'), 'utf8')) as BenchSummary;
}
async function collectSupplement() {
  const attempts = [];
  for (const t of PLAN.slice(0,15)) {
    const dir = resolve(ROOT,'bench-v2',t.id), final = JSON.parse(await readFile(resolve(dir,'finalization.json'),'utf8'));
    const actual = await entries(dir), originals = new Map(final.files.map((f:any)=>[f.path,f.sha256]));
    for (const f of final.files) assert(actual.some(a=>a.path===f.path && a.sha256===f.sha256),'Original finalized file changed');
    const extraFiles = actual.filter(a=>!originals.has(a.path));
    const commands = JSON.parse(await readFile(resolve(dir,'commands.json'),'utf8'));
    const trace = (await readFile(resolve(dir,'trace.jsonl'),'utf8')).split('\n').filter(Boolean).map(s=>JSON.parse(s));
    const stopped = trace.findLast((r:any)=>r.kind==='stop').wallMs;
    for (const f of extraFiles) {
      assert(f.path.endsWith('.late.json') && !/[\\/]/.test(f.path),'Unexpected extra evidence');
      const id = f.path.slice(0,-'.late.json'.length); assert(final.requestIds.includes(id));
      const late = JSON.parse(await readFile(resolve(dir,f.path),'utf8'));
      assert.equal(late.discarded,true); assert.equal(late.error,null); assert.equal(late.notStarted,false);
      assert(late.receivedWallMs>=stopped); assert(!commands.some((c:any)=>c.requestId===id),'Late request produced a command');
      const request = JSON.parse(await readFile(resolve(ROOT,'requests',id+'.json'),'utf8'));
      const response = await readCompleted(request,id,ledger().find(r=>r.id===id)); assert.deepEqual(late.answer,response);
    }
    attempts.push({id:t.id,originalFinalizationSha256:digest(await readFile(resolve(dir,'finalization.json'))),extraFiles});
  }
  return {scope:'Append-only inventory correction for verified discarded late response files; original finalizations and primary scores unchanged.',attempts};
}
async function prepareSupplement() {
  assert(!existsSync(SUPPLEMENT),'Supplement is immutable');
  const supplement = await collectSupplement(); durable(SUPPLEMENT,supplement,true);
  console.log(JSON.stringify({attempts:supplement.attempts.length,extraFiles:supplement.attempts.reduce((n,a)=>n+a.extraFiles.length,0)}));
}
export async function validateSupplement(candidate: unknown) {
  // Exact regenerated shape rejects duplicate/missing attempts, arbitrary additions,
  // altered finalization hashes and any late sink failing the semantic checks above.
  assert.deepEqual(candidate,await collectSupplement(),'Supplement failed independent revalidation');
}
async function externalEvidence() {
  return {supplementSha256:digest(await readFile(SUPPLEMENT)),amendmentSha256:digest(await readFile(resolve(ROOT,'bench-deadline-recovery.md')))};
}
export async function verifyExternalEvidence(expected: unknown) {
  assert.deepEqual(await externalEvidence(),expected,'Frozen external evidence changed');
}
export async function preflight() {
  const original = await verifyFrozenStage('yaw-bench-v2'); assert.deepEqual(original.manifest.plan, PLAN);
  await validateSupplement(JSON.parse(await readFile(SUPPLEMENT,'utf8')));
  if (existsSync(resolve(ROOT,'freezes',STAGE,'freeze.json'))) {
    const recovery = await verifyFrozenStage(STAGE); await verifyExternalEvidence(recovery.manifest.externalEvidence);
  }
  // Recovery adds orchestration only. Every original source/dependency file must remain identical.
  for (const e of original.entries) assert.equal(digest(await readFile(resolve(e.path))), e.sha256, `Original live source changed: ${e.path}`);
  assert.equal(PLAN[14]?.id, FAILED); assert.equal(RECOVERY_PLAN.length, 26);
  assert.equal(new Set([...PLAN.slice(0, 14), ...RECOVERY_PLAN].map(t => t.id)).size, 40);
  const retained = await Promise.all(PLAN.slice(0, 14).map(t => verify(t, 'bench-v2', original.sourceSha256, 'completed')));
  const failed = await verify(PLAN[14]!, 'bench-v2', original.sourceSha256, 'infrastructure-invalid');
  assert.equal(failed.error, 'Judge deadline exceeded; no retry or late application');
  assert(ledger().every(r => r.status === 'completed'), 'No recovery with uncertain calls');
  for (const t of PLAN.slice(15)) assert(!existsSync(resolve(ROOT, 'bench-v2', t.id)), 'Unexpected original attempt');
  return { original, retained, failed };
}
async function analyze() {
  const { retained, failed } = await preflight(), frozen = await verifyFrozenStage(STAGE);
  assert.deepEqual(frozen.manifest.plan, RECOVERY_PLAN);
  const results = [...retained], incomplete: unknown[] = [];
  for (const t of RECOVERY_PLAN) {
    const file = resolve(ROOT, DIRECTORY, t.id, 'finalization.json');
    if (!existsSync(file)) { incomplete.push({ id: t.id, status: 'not-finalized' }); continue; }
    const final = JSON.parse(await readFile(file, 'utf8'));
    if (final.status !== 'completed') { incomplete.push({ id: t.id, status: final.status, errors: final.errors }); continue; }
    results.push(await verify(t, DIRECTORY, frozen.sourceSha256, 'completed'));
  }
  const byArm = BENCH_ARMS.map(arm => {
    const a = results.filter(r => r.arm === arm), sum = (f: (r: BenchSummary) => number) => a.reduce((n,r) => n + f(r), 0);
    return { arm, completed: a.length, calls: sum(r => r.calls), framedSeconds: sum(r => r.score.framedMs)/1000,
      visibleSeconds: sum(r => r.score.visibleMs)/1000, passiveFramedSeconds: sum(r => r.passiveFixedObserver.framedMs)/1000,
      scorableForecasts: sum(r => r.forecast.scorable), committedForecasts: sum(r => r.forecast.committed), correctForecasts: sum(r => r.forecast.correct) };
  });
  const comparisons = BENCH_ARMS.slice(1).map(arm => {
    const differences = results.filter(r => r.arm === arm).flatMap(r => {
      const b = results.find(b => b.arm === 'receipt' && b.seed === r.seed && b.pattern === r.pattern);
      return b ? [{ seed:r.seed, pattern:r.pattern, deltaFramedSeconds:(r.score.framedMs-b.score.framedMs)/1000 }] : [];
    });
    return {arm,baseline:'receipt',pairedBlocks:differences.length,wins:differences.filter(d=>d.deltaFramedSeconds>0).length,
      losses:differences.filter(d=>d.deltaFramedSeconds<0).length,ties:differences.filter(d=>d.deltaFramedSeconds===0).length,differences};
  });
  const result = {scope:'V2 centering cohort with one explicitly retained deadline-invalid attempt and one fresh same-case replacement. Four patterns, two mirrors each; exploratory, not full missions.',
    originalStage:'yaw-bench-v2', recoveryStage:STAGE, completed:results.length, results, incomplete, byArm, comparisons,
    invalidAttempts:[failed], substitution:{original:FAILED,replacement:FAILED+'-r1',reason:'response exceeded callback deadline; returned and never applied'},usage:summarizeUsage()};
  await writeFile(resolve(ROOT, 'bench-combined-results.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify({completed:result.completed,incomplete,byArm,comparisons,usage:result.usage}));
}
async function main() {
  if (process.argv.includes('prepare-supplement')) return prepareSupplement();
  if (process.argv.includes('analyze')) return analyze();
  const { original } = await preflight();
  if (process.argv.includes('check')) { console.log(JSON.stringify({retained:14,invalid:1,replacement:RECOVERY_PLAN[0],untouched:25,sourceVerified:original.sourceSha256,usage:summarizeUsage()})); return; }
  assert(process.argv.includes('--real'), 'Explicit --real required');
  const frozen = await freezeStage(STAGE, {plan:RECOVERY_PLAN,retained:PLAN.slice(0,14),failed:PLAN[14],originalSourceSha256:original.sourceSha256,
    externalEvidence:await externalEvidence(),
    amendment:'bench-deadline-recovery.md',stoppingRule:'One replacement only. Stop on any further invalid attempt; no automatic further recovery or timeout change.'});
  const meter = createMeter({key:process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? ''});
  const abort = new AbortController(), stop = () => abort.abort('Operator interrupted recovery');
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  const outstanding = new Set<Promise<unknown>>();
  try {
    for (const trial of RECOVERY_PLAN) {
      abort.signal.throwIfAborted(); const dir = resolve(ROOT,DIRECTORY,trial.id);
      if (existsSync(dir)) { await verify(trial,DIRECTORY,frozen.sourceSha256,'completed'); continue; }
      console.log(JSON.stringify({event:'bench-start',...trial}));
      const errors:string[] = [], requestIds:string[] = [];
      const summary = await runBench({...trial,outputDir:resolve(ROOT,DIRECTORY),signal:abort.signal,judge:(request,id)=>{
        requestIds.push(id); const p = meter.judge(request,id,abort.signal); outstanding.add(p);
        void p.then(()=>outstanding.delete(p),e=>{errors.push(String(e));outstanding.delete(p);}); return p as Promise<BenchResponse>;
      }});
      // runBench's synchronous late sink is chained after the transport promise.
      // Drain its microtasks before listing immutable evidence; do not race finalization.
      errors.push(...await settleSinks(dir,requestIds,outstanding));
      durable(resolve(dir,'finalization.json'),{status:errors.length || summary.status!=='completed' ? 'infrastructure-invalid':'completed',
        trial,sourceSha256:frozen.sourceSha256,errors,requestIds,files:await entries(dir)},true);
      console.log(JSON.stringify({event:'bench-finish',...summary}));
      assert.equal(errors.length,0,'Preserve failure and stop; no further recovery');
      assert.equal(summary.status,'completed','Preserve failure and stop; no further recovery');
    }
  } finally {await Promise.allSettled([...outstanding]);meter.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  await analyze();
}
if (process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)) main().catch(e=>{console.error(String(e));process.exitCode=1;});
