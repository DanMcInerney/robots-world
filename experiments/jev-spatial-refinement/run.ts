import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateGeometryCases} from './geometry.ts';
import {generateTemporalCases} from './temporal.ts';
import {generateHistoryCases} from './history.ts';
import type {RefineCase} from './types.ts';
import {choice} from '../jev-strategies/strategies.ts';
import {createMeter, digest, durable, freezeStage, ledger, readCompleted, summarizeUsage, validateRequest, verifyFrozenStage} from '../jev-spatial-text/transport.ts';

export const ROOT=resolve('.runtime/experiments/jev-spatial-refinement-v1');
export const LIMITS={requests:3000,inputTokens:25000000,requestsPerSecond:2};
const PLAN='docs/jev-spatial-refinement-plan.md';
export async function cases():Promise<RefineCase[]> {
  const all:RefineCase[]=[...generateGeometryCases(),...generateTemporalCases(),...await generateHistoryCases()];
  assert.equal(all.length,1200);assert.equal(new Set(all.map(c=>c.id)).size,1200);
  for(const c of all){validateRequest(c.request);for(const [q,answers] of Object.entries(c.expected)) {
    assert(c.request.questions[q]);assert(answers.length);for(const answer of answers)assert(answer in c.request.questions[q]!.criteria);
  }}
  // Hash-sort within replicate rounds interleaves arms and scenes reproducibly; repeats never collapse into cached IDs.
  return all.sort((a,b)=>a.replicate-b.replicate||digest(a.id).localeCompare(digest(b.id)));
}
export async function freeze(all:RefineCase[]) {
  const bytes=JSON.stringify(all)+'\n',file=resolve(ROOT,'cases.json');
  await mkdir(ROOT,{recursive:true});
  if(existsSync(file))assert.equal(await readFile(file,'utf8'),bytes);else await writeFile(file,bytes,{flag:'wx'});
  const plan=await readFile(PLAN,'utf8');
  const result=await freezeStage('fixed',{casesSha256:digest(bytes),planSha256:digest(plan),limits:LIMITS,
    selection:'Geometry: within one correct action of best, action-only preferred, then bytes, then name. Temporal: critical assertions, factual accuracy, bytes, name.',
    critical:'Each unsupported current assertion, invalid epoch spatial assertion, and reset acquisition clock is counted separately.',
  },ROOT);
  const planFile=resolve(ROOT,'freezes/fixed/plan.md');
  if(existsSync(planFile))assert.equal(await readFile(planFile,'utf8'),plan);else await writeFile(planFile,plan,{flag:'wx'});
  return result;
}
export async function verify(all:RefineCase[],live=true,root=ROOT) {
  const frozen=await verifyFrozenStage('fixed',root);
  assert.equal(digest(await readFile(resolve(root,'cases.json'))),frozen.manifest.casesSha256);
  assert.equal(digest(JSON.stringify(all)+'\n'),frozen.manifest.casesSha256);
  assert.equal(digest(await readFile(resolve(root,'freezes/fixed/plan.md'))),frozen.manifest.planSha256);
  if(live)for(const entry of frozen.entries)assert.equal(digest(await readFile(entry.path)),entry.sha256,`Live frozen source changed: ${entry.path}`);
  return frozen;
}
export function criticalAssertions(c:RefineCase,answers:Record<string,string>):string[] {
  if(c.stage!=='temporal')return [];
  const flags:string[]=[];
  for(const q of ['historical_kind','current_kind','hypothesis_kind'])if(answers[q]==='current_observation'&&!c.expected[q]!.includes(answers[q]!))flags.push(`${q}:false-current`);
  if(c.expected.present_location?.includes('unknown')&&answers.present_location!=='unknown')flags.push('present_location:false-current');
  if(!c.meta.epochValid){
    if(answers.epoch_join==='valid')flags.push('epoch_join:invalid-join');
    if(answers.old_side!=='unknown')flags.push('old_side:invalid-join');
    if(answers.historical_kind!=='unknown')flags.push('historical_kind:invalid-join');
  }
  if(c.expected.hypothesis_validity?.includes('invalid_epoch')&&answers.hypothesis_validity==='active')flags.push('hypothesis_validity:invalid-join');
  if(['current_frame','decision_time'].includes(answers.observation_clock!))flags.push('observation_clock:reset-acquisition');
  return flags;
}
export function criticalOpportunities(c:RefineCase):string[] {
  if(c.stage!=='temporal')return [];
  const out:string[]=[];
  for(const q of ['historical_kind','current_kind','hypothesis_kind'])if(!c.expected[q]!.includes('current_observation'))out.push(`${q}:false-current`);
  if(c.expected.present_location!.includes('unknown'))out.push('present_location:false-current');
  if(!c.meta.epochValid)out.push('epoch_join:invalid-join','old_side:invalid-join','historical_kind:invalid-join');
  if(c.expected.hypothesis_validity!.includes('invalid_epoch'))out.push('hypothesis_validity:invalid-join');
  out.push('observation_clock:reset-acquisition');return out;
}
export function assertUnchangedPrefix(current:Uint8Array,preserved:Uint8Array,expectedHash:string) {
  assert.equal(digest(preserved),expectedHash,'Preserved development ledger changed');
  assert.equal(digest(current.subarray(0,preserved.length)),expectedHash,'Development ledger prefix changed');
}
export async function validateSelection(all:RefineCase[],summary:any,root=ROOT) {
  const bytes=await readFile(resolve(root,'selection.json')),selection=JSON.parse(bytes.toString());
  const seal=JSON.parse(await readFile(resolve(root,'selection-seal.json'),'utf8'));
  assert.equal(digest(bytes),seal.selectionSha256,'Selection bytes changed');
  assert.equal(selection.casesSha256,digest(JSON.stringify(all)+'\n'));
  const prefix=await readFile(resolve(root,'development-ledger.jsonl'));
  assertUnchangedPrefix(await readFile(resolve(root,'requests.jsonl')),prefix,selection.developmentLedgerSha256);
  assert.equal(prefix.length,selection.developmentLedgerBytes);
  const expected=new Set(all.filter(c=>c.split!=='confirmation').map(c=>c.id));
  const prefixRows=new Map<string,any>();
  for(const line of prefix.toString().trim().split('\n')){const r=JSON.parse(line);assert(expected.has(r.id),'Development snapshot contains a non-development request');prefixRows.set(r.id,{...prefixRows.get(r.id),...r});}
  assert.equal(prefixRows.size,816);assert([...prefixRows.values()].every(r=>r.status==='completed'));
  const chosen=choose(summary);
  assert.equal(selection.geometry,chosen.geometry);assert.equal(selection.temporal,chosen.temporal);
  assert.deepEqual(selection.geometryEligible,chosen.geometryEligible);assert.equal(selection.geometryBestCorrect,chosen.geometryBestCorrect);
  assert.deepEqual(selection.development,summary.groups.filter((g:any)=>g.split!=='confirmation'),'Development scoring changed');
  return selection;
}
export async function analyze(all:RefineCase[]) {
  const rows=new Map(ledger(ROOT).map(r=>[r.id,r]));
  const groups:Record<string,any>={},details:any[]=[];
  for(const c of all){const row=rows.get(c.id);if(row?.status!=='completed')continue;
    const response=await readCompleted(c.request,c.id,row,ROOT),answers=Object.fromEntries(Object.entries(c.request.questions).map(([q,v])=>[q,choice(response,q,Object.keys(v.criteria))]));
    const key=[c.stage,c.split,c.arm].join('/');
    const g=groups[key]??={stage:c.stage,split:c.split,arm:c.arm,calls:0,correct:0,graded:0,questions:{},critical:0,criticalFlags:{},wrongDirection:0,unnecessaryOutOfView:0,bytes:0,tokens:0,latencies:[],repeatGroups:{}};
    g.calls++;g.bytes+=Buffer.byteLength(JSON.stringify(c.request));g.tokens+=row.inputTokens??0;g.latencies.push(row.latencyMs);
    const critical=criticalAssertions(c,answers);g.critical+=critical.length;
    for(const flag of criticalOpportunities(c)){const counts=g.criticalFlags[flag]??={errors:0,eligible:0};counts.eligible++;if(critical.includes(flag))counts.errors++;}
    for(const [q,expected] of Object.entries(c.expected)){
      const v=g.questions[q]??={correct:0,total:0};v.total++;g.graded++;if(expected.includes(answers[q]!)){v.correct++;g.correct++;}
    }
    if(c.stage==='geometry'){
      const selected=c.meta.perAction[answers.action!];
      if(selected.turnDirection==='away from acquired target side')g.wrongDirection++;
      if(!selected.fullyVisible&&Object.values(c.meta.perAction).some((v:any)=>v.fullyVisible))g.unnecessaryOutOfView++;
    }
    const repeat=digest(JSON.stringify(c.request));(g.repeatGroups[repeat]??=[]).push(answers);
    details.push({id:c.id,stage:c.stage,split:c.split,arm:c.arm,unit:c.unit,mirror:c.meta.mirror,replicate:c.replicate,answers,expected:c.expected,critical});
  }
  for(const g of Object.values(groups)){
    g.meanBytes=g.bytes/g.calls;g.meanTokens=g.tokens/g.calls;g.latencies.sort((a:number,b:number)=>a-b);
    g.latencyP50Ms=g.latencies[Math.floor(g.latencies.length*.5)];g.latencyP95Ms=g.latencies[Math.min(g.latencies.length-1,Math.floor(g.latencies.length*.95))];delete g.latencies;
    const repeatGroups=Object.values(g.repeatGroups) as Record<string,string>[][];
    g.repeatVariability={completeGroups:0,anyAnswerDisagreement:0,actionDisagreement:g.stage==='temporal'?null:0,perQuestion:{}};
    for(const values of repeatGroups){if(values.length!==(g.stage==='history'?3:2))continue;g.repeatVariability.completeGroups++;
      if(new Set(values.map(v=>JSON.stringify(v))).size>1)g.repeatVariability.anyAnswerDisagreement++;
      if(g.stage!=='temporal'&&new Set(values.map(v=>v[g.stage==='geometry'?'action':'yaw'])).size>1)g.repeatVariability.actionDisagreement++;
      for(const q of Object.keys(values[0]!)){const v=g.repeatVariability.perQuestion[q]??={groups:0,disagreement:0};v.groups++;if(new Set(values.map(v=>v[q])).size>1)v.disagreement++;}
    }delete g.repeatGroups;
  }
  return {usage:summarizeUsage(ROOT),groups:Object.values(groups),details,
    limitations:'Mirrors/repeats/questions are correlated. History correctness is a static full-settle proxy on archived states, not actual control success. Byte padding is not a token or semantic-neutrality control.'};
}
export function choose(summary:any) {
  const geometry=summary.groups.filter((g:any)=>g.stage==='geometry'&&g.split==='development');
  const temporal=summary.groups.filter((g:any)=>g.stage==='temporal'&&g.split==='development');
  assert.equal(geometry.length,8);assert.equal(temporal.length,4);
  assert(geometry.every((g:any)=>g.calls===32));assert(temporal.every((g:any)=>g.calls===32));
  const best=Math.max(...geometry.map((g:any)=>g.questions.action.correct));
  const eligible=geometry.filter((g:any)=>g.questions.action.correct>=best-1);
  eligible.sort((a:any,b:any)=>Number(!a.arm.endsWith('__action-only'))-Number(!b.arm.endsWith('__action-only'))||a.meanBytes-b.meanBytes||a.arm.localeCompare(b.arm));
  temporal.sort((a:any,b:any)=>a.critical-b.critical||b.correct-a.correct||a.meanBytes-b.meanBytes||a.arm.localeCompare(b.arm));
  return {geometry:eligible[0].arm,temporal:temporal[0].arm,geometryBestCorrect:best,geometryEligible:eligible.map((g:any)=>g.arm),development:summary.groups};
}
export function gates(summary:any,selection:any) {
  const geometry=summary.groups.find((g:any)=>g.stage==='geometry'&&g.split==='confirmation'&&g.arm===selection.geometry);
  const temporal=summary.groups.find((g:any)=>g.stage==='temporal'&&g.split==='confirmation'&&g.arm===selection.temporal);
  return {geometry:{arm:selection.geometry,pass:!!geometry&&geometry.calls===32&&geometry.questions.action.correct/32>=.95&&geometry.wrongDirection===0&&geometry.unnecessaryOutOfView===0,metrics:geometry},
    temporal:{arm:selection.temporal,pass:!!temporal&&temporal.calls===32&&temporal.critical===0&&temporal.correct/temporal.graded>=.9,metrics:temporal}};
}
async function main(){
  const command=process.argv[2]??'qualify',all=await cases();
  if(command==='qualify'){console.log(JSON.stringify({cases:all.length,development:all.filter(c=>c.split!=='confirmation').length,confirmation:all.filter(c=>c.split==='confirmation').length,maxBytes:Math.max(...all.map(c=>Buffer.byteLength(JSON.stringify(c.request))))}));return;}
  if(command==='freeze'){console.log(JSON.stringify(await freeze(all)));return;}
  await verify(all);
  if(command==='analyze'){
    const summary=await analyze(all);
    const selectionFile=resolve(ROOT,'selection.json');if(existsSync(selectionFile)){const selection=await validateSelection(all,summary);await writeFile(resolve(ROOT,'gates.json'),JSON.stringify(gates(summary,selection),null,2)+'\n');}
    await writeFile(resolve(ROOT,'analysis.json'),JSON.stringify(summary,null,2)+'\n');
    console.log(JSON.stringify({usage:summary.usage,groups:summary.groups}));return;
  }
  if(command==='select'){
    const rows=ledger(ROOT);assert(!rows.some(r=>all.some(c=>c.id===r.id&&c.split==='confirmation')),'Selection must precede confirmation dispatch');
    assert.equal(rows.filter(r=>r.status==='completed').length,816);
    const summary=await analyze(all),prefix=await readFile(resolve(ROOT,'requests.jsonl'));
    const selection={...choose(summary),selectedAt:new Date().toISOString(),developmentLedgerSha256:digest(prefix),developmentLedgerBytes:prefix.length,casesSha256:digest(JSON.stringify(all)+'\n')};
    await writeFile(resolve(ROOT,'development-ledger.jsonl'),prefix,{flag:'wx'});
    durable(resolve(ROOT,'selection.json'),selection,true);
    durable(resolve(ROOT,'selection-seal.json'),{selectionSha256:digest(await readFile(resolve(ROOT,'selection.json')))},true);
    await validateSelection(all,summary);console.log(JSON.stringify(selection));return;
  }
  assert(['development','confirmation'].includes(command));assert(process.argv.includes('--real'),'Paid execution requires --real');
  if(command==='confirmation'){
    await validateSelection(all,await analyze(all));
  }
  const key=process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY??'';assert(key,'Saved key required');
  const meter=createMeter({root:ROOT,key,limits:LIMITS});let done=0;
  try{for(const c of all.filter(c=>command==='development'?c.split!=='confirmation':c.split==='confirmation')){
    await meter.judge(c.request,c.id);if(++done%25===0)console.log(JSON.stringify({phase:command,done,usage:summarizeUsage(ROOT)}));
  }}finally{meter.close();}
  console.log(JSON.stringify({phase:command,done,usage:summarizeUsage(ROOT)}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
