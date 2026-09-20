import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {generateTemporalNextCases,classifyTemporalNextAnswers,temporalNextManifest,TEMPORAL_NEXT_PLAN} from './temporal-next.ts';
import {ROOT,LIMITS,cases as fixedCases,verify as verifyFixed,analyze as analyzeFixed,validateSelection,assertUnchangedPrefix} from './run.ts';
import {choice} from '../jev-strategies/strategies.ts';
import {createMeter,digest,durable,freezeStage,verifyFrozenStage,validateRequest,ledger,readCompleted,summarizeUsage} from '../jev-spatial-text/transport.ts';
const STAGE='temporal-next',DIR=resolve(ROOT,STAGE),PLAN='docs/jev-spatial-temporal-next.md';
const PRIMARY='valid_only__separate';
export const NEXT_STAGE_LIMITS={requests:192,inputTokens:2500000,reservationPerRequest:65536};
export const NEXT_EXECUTION_RULES={primary:PRIMARY,requests:192,order:'development then confirmation, hash-interleaved arms per split',
  usefulValidSideMinimum:.95,originMinimum:.90,coordinateUsabilityMinimum:.90,unsupportedAssertionsMaximum:0,
  observedCurrentLocationMinimum:.95,eligibleUsefulSide:8,eligibleObservedCurrentLocation:8,
  selection:'Mechanistically preregistered from prior-stage failures; no v2 result-based selection or editing.',
  comparisons:'Eight common questions compared directly; fused and separated heads graded independently, no pooled nine-versus-ten-head total.',
  limits:LIMITS,stageLimits:NEXT_STAGE_LIMITS,developmentBoundary:'Seal exact96completed development responses and immutable global ledger prefix before first confirmation; verify on resume and analysis.'};
export function checkTemporalNextBudget(rows:any[],ids:Set<string>,id:string){
  assert(ids.has(id),'Request is outside the frozen temporal stage');
  const stage=rows.filter(r=>ids.has(r.id)),prior=stage.find(r=>r.id===id);
  const accounted=stage.reduce((n,r)=>n+(r.inputTokens??r.reserve),0);
  assert(Number.isSafeInteger(accounted)&&accounted>=0,'Missing stage usage reservation');
  assert(stage.length<=NEXT_STAGE_LIMITS.requests&&accounted<=NEXT_STAGE_LIMITS.inputTokens,'Temporal stage ceiling exceeded');
  if(prior){assert.equal(prior.status,'completed','Unresolved temporal request cannot replay');return {requests:stage.length,accountedTokens:accounted};}
  assert(stage.length+1<=NEXT_STAGE_LIMITS.requests&&accounted+NEXT_STAGE_LIMITS.reservationPerRequest<=NEXT_STAGE_LIMITS.inputTokens,'Temporal stage ceiling reached before dispatch');
  return {requests:stage.length,accountedTokens:accounted};
}
function cases(){assert.equal(TEMPORAL_NEXT_PLAN.primaryCandidate,PRIMARY);const all=generateTemporalNextCases();assert.equal(all.length,192);assert.equal(new Set(all.map(c=>c.id)).size,192);for(const c of all)validateRequest(c.request);return all.sort((a,b)=>Number(a.split==='confirmation')-Number(b.split==='confirmation')||digest(a.id).localeCompare(digest(b.id)));}
async function freeze(){
  const all=cases(),bytes=JSON.stringify(all)+'\n',plan=await readFile(PLAN);
  await mkdir(DIR,{recursive:true});
  for(const [name,data] of [['cases.json',Buffer.from(bytes)],['plan.md',plan]] as const){const file=resolve(DIR,name);if(existsSync(file))assert.equal(digest(await readFile(file)),digest(data));else await writeFile(file,data,{flag:'wx'});}
  return freezeStage(STAGE,{fixture:temporalNextManifest(),caseSha256:digest(bytes),planSha256:digest(plan),rules:NEXT_EXECUTION_RULES},ROOT);
}
export async function verifyTemporalNext(){
  const all=cases(),frozen=await verifyFrozenStage(STAGE,ROOT);assert.deepEqual(frozen.manifest.rules,NEXT_EXECUTION_RULES);
  assert.deepEqual(frozen.manifest.fixture,temporalNextManifest());assert.equal(digest(JSON.stringify(all)+'\n'),frozen.manifest.caseSha256);
  assert.equal(digest(await readFile(resolve(DIR,'cases.json'))),frozen.manifest.caseSha256);assert.equal(digest(await readFile(resolve(DIR,'plan.md'))),frozen.manifest.planSha256);
  for(const entry of frozen.entries)assert.equal(digest(await readFile(entry.path)),entry.sha256,`Frozen source changed: ${entry.path}`);
  return all;
}
export function inspectTemporalDevelopment(all:any[],prefix:Buffer,current:Buffer,seal:any){
  assert.equal(seal.primary,PRIMARY);assert.equal(seal.casesSha256,digest(JSON.stringify(all)+'\n'));
  assertUnchangedPrefix(current,prefix,seal.ledgerPrefixSha256);assert.equal(prefix.length,seal.ledgerPrefixBytes);
  const expected=all.filter(c=>c.split==='development'),confirmation=new Set(all.filter(c=>c.split==='confirmation').map(c=>c.id));
  assert.equal(expected.length,96);const rows=new Map<string,any>();
  for(const line of prefix.toString().trim().split('\n')){const row=JSON.parse(line);assert(!confirmation.has(row.id),'Confirmation preceded development seal');rows.set(row.id,{...rows.get(row.id),...row});}
  const records=expected.map(c=>{const row=rows.get(c.id);assert.equal(row?.status,'completed','Incomplete development boundary');assert.equal(row.requestSha256,digest(JSON.stringify(c.request)));return {id:c.id,requestSha256:row.requestSha256,responseSha256:row.responseSha256};});
  assert.deepEqual(seal.responses,records,'Development response inventory changed');return rows;
}
export async function verifyTemporalDevelopment(all:any[],root=ROOT){
  const dir=resolve(root,STAGE),seal=JSON.parse(await readFile(resolve(dir,'development-seal.json'),'utf8'));
  const prefix=await readFile(resolve(dir,'development-ledger.jsonl')),current=await readFile(resolve(root,'requests.jsonl'));
  const rows=inspectTemporalDevelopment(all,prefix,current,seal);
  for(const c of all.filter(c=>c.split==='development'))await readCompleted(c.request,c.id,rows.get(c.id),root);
  return seal;
}
async function sealTemporalDevelopment(all:any[]){
  if(existsSync(resolve(DIR,'development-seal.json')))return verifyTemporalDevelopment(all);
  const rows=new Map(ledger(ROOT).map(r=>[r.id,r]));
  assert(!all.some(c=>c.split==='confirmation'&&rows.has(c.id)),'Cannot create a retrospective development seal');
  const responses=[];
  for(const c of all.filter(c=>c.split==='development')){const row=rows.get(c.id);await readCompleted(c.request,c.id,row,ROOT);responses.push({id:c.id,requestSha256:row.requestSha256,responseSha256:row.responseSha256});}
  assert.equal(responses.length,96);
  const prefix=await readFile(resolve(ROOT,'requests.jsonl'));
  await writeFile(resolve(DIR,'development-ledger.jsonl'),prefix,{flag:'wx'});
  durable(resolve(DIR,'development-seal.json'),{sealedAt:new Date().toISOString(),primary:PRIMARY,casesSha256:digest(JSON.stringify(all)+'\n'),ledgerPrefixBytes:prefix.length,ledgerPrefixSha256:digest(prefix),responses},true);
  return verifyTemporalDevelopment(all);
}
export function temporalNextGate(group:any){
  const rate=(x:any)=>x?.total?x.correct/x.total:0;
  return {primary:PRIMARY,pass:!!group&&group.calls===16&&group.physicalAssertionCount===0&&group.validOldSide?.total===8&&rate(group.validOldSide)>=.95&&group.observedCurrentLocation?.total===8&&rate(group.observedCurrentLocation)>=.95&&group.questions.historical_origin?.total===16&&rate(group.questions.historical_origin)>=.9&&group.questions.historical_position_usable?.total===16&&rate(group.questions.historical_position_usable)>=.9,
    criteria:NEXT_EXECUTION_RULES,metrics:group??null};
}
export function temporalNextOpportunities(c:any){
  const out:string[]=[];
  for(const q of ['historical_kind','historical_origin','current_kind','hypothesis_kind'])if(c.expected[q]&&!c.expected[q].includes('current_observation'))out.push(`${q}:false-current`);
  if(!c.meta.groundFacts.present)out.push('present_location:false-current');
  if(!c.meta.epochValid){out.push('old_side:invalid-coordinate','epoch_join:invalid-join');if(c.expected.historical_position_usable)out.push('historical_position_usable:invalid-coordinate');}
  if(c.expected.hypothesis_validity.includes('invalid_epoch'))out.push('hypothesis_validity:invalid-join');
  out.push('observation_clock:reset-acquisition');return out;
}
async function analyze(){
  const all=await verifyTemporalNext(),rows=new Map(ledger(ROOT).map(r=>[r.id,r])),groups:Record<string,any>={},details:any[]=[];
  const boundary=all.some(c=>c.split==='confirmation'&&rows.has(c.id))||existsSync(resolve(DIR,'development-seal.json'))?await verifyTemporalDevelopment(all):null;
  for(const c of all){const row=rows.get(c.id);if(row?.status!=='completed')continue;
    const r=await readCompleted(c.request,c.id,row,ROOT),answers=Object.fromEntries(Object.entries(c.request.questions).map(([q,v])=>[q,choice(r,q,Object.keys(v.criteria))]));
    const classified=classifyTemporalNextAnswers(c,answers),key=c.split+'/'+c.arm;
    const g=groups[key]??={split:c.split,arm:c.arm,calls:0,questions:{},common:{correct:0,total:0},validOldSide:{correct:0,total:0},observedCurrentLocation:{correct:0,total:0},physicalAssertionCount:0,responsesWithPhysicalAssertions:0,physicalFlags:{},labelUsabilityDisagreements:0,tokens:0,bytes:0};
    g.calls++;g.tokens+=row.inputTokens??0;g.bytes+=Buffer.byteLength(JSON.stringify(c.request));g.physicalAssertionCount+=classified.physicalAssertions.length;
    if(classified.physicalAssertions.length)g.responsesWithPhysicalAssertions++;
    for(const f of temporalNextOpportunities(c)){const counts=g.physicalFlags[f]??={errors:0,eligible:0};counts.eligible++;if(classified.physicalAssertions.includes(f))counts.errors++;}
    if(classified.labelUsabilityDisagreement)g.labelUsabilityDisagreements++;
    for(const [q,expected] of Object.entries(c.expected)){const correct=Number(expected.includes(answers[q]!)),v=g.questions[q]??={correct:0,total:0};v.total++;v.correct+=correct;
      if(c.meta.commonHeads.includes(q)){g.common.total++;g.common.correct+=correct;}
      if(q==='old_side'&&c.meta.epochValid){g.validOldSide.total++;g.validOldSide.correct+=correct;}
      if(q==='present_location'&&c.meta.groundFacts.present){g.observedCurrentLocation.total++;g.observedCurrentLocation.correct+=correct;}
    }
    details.push({id:c.id,unit:c.unit,mirror:c.meta.mirror,split:c.split,arm:c.arm,epochValid:c.meta.epochValid,answers,expected:c.expected,...classified});
  }
  const frozen=await verifyFrozenStage(STAGE,ROOT);
  const result={stage:STAGE,freezeIdentity:{sourceSha256:frozen.sourceSha256,casesSha256:frozen.manifest.caseSha256,planSha256:frozen.manifest.planSha256,primary:PRIMARY},developmentBoundary:boundary?{ledgerPrefixSha256:boundary.ledgerPrefixSha256,responses:boundary.responses.length}:null,
    groups:Object.values(groups),details,gate:temporalNextGate(groups['confirmation/'+PRIMARY]),usage:summarizeUsage(ROOT),
    stageUsage:{requests:all.filter(c=>rows.has(c.id)).length,completed:details.length,inputTokens:all.reduce((n,c)=>n+(rows.get(c.id)?.inputTokens??0),0)},
    scope:'Fresh synthetic schema/question-meaning follow-up. One response per cell. Mirrors/templates correlated; common-head accuracy and origin/usability semantics do not qualify a robot.'};
  await writeFile(resolve(DIR,'analysis.json'),JSON.stringify(result,null,2)+'\n');return result;
}
async function main(){const command=process.argv[2]??'qualify';
  if(command==='qualify'){console.log(JSON.stringify({fixture:temporalNextManifest(),rules:NEXT_EXECUTION_RULES}));return;}
  if(command==='freeze'){console.log(JSON.stringify(await freeze()));return;}
  if(command==='analyze'){const a=await analyze();console.log(JSON.stringify({groups:a.groups,gate:a.gate,stageUsage:a.stageUsage}));return;}
  assert.equal(command,'run');assert(process.argv.includes('--real'));
  const all=await verifyTemporalNext(),fixed=await fixedCases();await verifyFixed(fixed);await validateSelection(fixed,await analyzeFixed(fixed));
  const rows=new Map(ledger(ROOT).map(r=>[r.id,r]));assert(fixed.every(c=>rows.get(c.id)?.status==='completed'),'Finish original fixed study first');
  const key=process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY??'';assert(key);
  const meter=createMeter({root:ROOT,key,limits:LIMITS});let done=0;
  let crossed=false;const stageIds=new Set(all.map(c=>c.id));
  try{for(const c of all){
    if(c.split==='confirmation'&&!crossed){await sealTemporalDevelopment(all);crossed=true;}
    checkTemporalNextBudget(ledger(ROOT),stageIds,c.id);
    await meter.judge(c.request,c.id);if(++done%24===0)console.log(JSON.stringify({stage:STAGE,done,usage:summarizeUsage(ROOT)}));
  }}finally{meter.close();}
  const a=await analyze();console.log(JSON.stringify({stage:STAGE,done,gate:a.gate,stageUsage:a.stageUsage}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
