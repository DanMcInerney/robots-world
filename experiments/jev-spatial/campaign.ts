import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,copyFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync,existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import os from 'node:os';
import {callJev} from '../jev-pixels/controller.ts';
import {MODEL,type Response} from '../jev-strategies/strategies.ts';
import {runSpatialTrial,type Flight} from './trial.ts';
import {runProbes} from './probes.ts';
import {readCheckpoint,writeCheckpoint} from './checkpoint.ts';
export const ROOT=resolve('.runtime/experiments/jev-spatial-five-rounds-v1');
const stateFile=resolve(ROOT,'campaign-state.json');
const checkpoints=resolve(ROOT,'state-checkpoints');
export async function state(){return readCheckpoint(checkpoints,stateFile);}
export async function save(s:any){return writeCheckpoint(checkpoints,resolve(ROOT,'campaign-state-view.json'),s);}
const digest=(b:any)=>createHash('sha256').update(b).digest('hex');
async function inventory(){const files=['package.json','package-lock.json','tsconfig.json','vite.config.ts','server.ts'];for(const base of ['src','controllers','integrations','experiments','scenarios','web','test'])for(const f of await readdir(base,{recursive:true}))if(/\.(ts|json|py|html|mjs|css|svg|png|jpg|wasm)$/.test(f)&&!f.includes('__pycache__'))files.push(`${base}/${f.replaceAll('\\','/')}`);return [...new Set(files)].sort();}
export async function initialize(){
 const s={version:'jev-spatial-five-rounds-v1',created:new Date().toISOString(),status:'qualification',ceilings:{flights:160,requests:40000,inputTokens:500000000,approximateUsd:21},allocation:{roundTokens:[60000000,60000000,60000000,60000000,160000000],roundRequests:[6500,6500,6500,6500,13500],plannedFlights:[8,8,8,8,24]},rounds:[],attempts:[],next:'Qualify round 1; freeze before inference.',model:MODEL,pricePerMillion:0.042,officialVerification:{date:new Date().toISOString(),urls:['https://docs.typesafe.ai/models','https://docs.typesafe.ai/primitives/choice','https://docs.typesafe.ai/concepts/state','https://docs.typesafe.ai/patterns/fan-out'],notes:'255 options per Choice; independent questions; IDs not model-visible. 64k request /32k state+longest. Actual response model checked. Direct fetch, no hidden SDK retries.'},machine:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()},constraints:'One world, RGB/KLT + simulated own pose only, no target geometry/follower/servo/planner. Semantic car recognition unqualified (blue proxy).'};
 await writeFile(stateFile,JSON.stringify(s,null,2),{flag:'wx'});return s;
}
export async function freezeRound(number:number,plan:any,amendmentReason?:string){
 const s=await state(),existing=s.rounds.find((r:any)=>r.number===number);assert(!existing||amendmentReason&&existing.status==='stopped','Round already frozen; only explicit stopped-round amendment allowed');
 assert.equal(new Set(plan.flights.map((f:any)=>f.id)).size,plan.flights.length,'Flight IDs must be unique');for(const f of plan.flights)if(f.replaces&&!existing?.plan.flights.some((p:any)=>p.id===f.id&&p.replaces===f.replaces))assert(!s.attempts.some((a:any)=>a.id===f.id),'New replacement ID must be unused');
 if(existing){assert.deepEqual(plan.probes,existing.plan.probes,'Infrastructure amendment cannot change probes');assert.equal(plan.flights.length,existing.plan.flights.length,'Infrastructure amendment cannot drop blocks');const seen=new Set();for(const next of plan.flights){const prior=existing.plan.flights.find((f:any)=>f.id===next.id)??existing.plan.flights.find((f:any)=>f.id===next.replaces);assert(prior&&!seen.has(prior.id),'Amendment must map one-to-one');seen.add(prior.id);const {id:_id,replaces:_replaces,...a}=next,{id:_oldId,replaces:_oldReplaces,...b}=prior;assert.deepEqual(a,b,'Infrastructure amendment cannot change flight parameters');if(next.id!==prior.id){assert.equal(next.replaces,prior.id);assert.equal(s.attempts.find((x:any)=>x.id===prior.id)?.status,'invalid','Replacement must retain an invalid prior attempt');}else assert.equal(next.replaces,prior.replaces,'Cannot rewrite replacement lineage');}}
 if(number>1)assert(s.rounds.find((r:any)=>r.number===number-1)?.status==='analyzed','Previous round must be analyzed');
 const originalDirectory=resolve(ROOT,`round-${String(number).padStart(2,'0')}`),directory=existing?resolve(originalDirectory,`amendment-${String((existing.amendments?.length??0)+1).padStart(2,'0')}`):originalDirectory;await mkdir(directory);
 const files=await inventory();
 const entries=[];for(const f of files){const bytes=await readFile(f),to=resolve(directory,'source',f);await mkdir(dirname(to),{recursive:true});await copyFile(f,to);assert.equal(digest(await readFile(to)),digest(bytes));entries.push({path:f,sha256:digest(bytes),bytes:bytes.length});}
 const python=resolve('.runtime/vision-env/Scripts/python.exe'),versions={python:execFileSync(python,['--version'],{windowsHide:true}).toString().trim(),requirements:execFileSync(python,['-m','pip','freeze'],{windowsHide:true}).toString()};await writeFile(resolve(directory,'source','requirements-perception.txt'),versions.requirements);await writeFile(resolve(directory,'runtime-versions.json'),JSON.stringify(versions,null,2));
 const frozen={number,model:MODEL,created:new Date().toISOString(),plan,entries,sourceDigest:digest(JSON.stringify(entries)),runtime:s.machine,command:`node --env-file=.env.jev.local experiments/jev-spatial/run.ts run ${number} --real`,replay:'Restore this source snapshot into an isolated directory; npm ci; use the recorded Python/OpenCV versions. Credentials are intentionally excluded.'};
 await writeFile(resolve(directory,'freeze.json'),JSON.stringify(frozen,null,2),{flag:'wx'});const next={number,status:'frozen',directory:originalDirectory,freezeDirectory:directory,sourceDigest:frozen.sourceDigest,manifestDigest:digest(JSON.stringify(frozen)),dependencyDigest:digest(JSON.stringify(versions)),plan};
 if(existing){existing.amendments??=[];existing.amendments.push({at:new Date().toISOString(),reason:amendmentReason,previousFreezeDirectory:existing.freezeDirectory??originalDirectory,previousManifestDigest:existing.manifestDigest,previousPlan:existing.plan,stop:s.stop});s.recoveries??=[];s.recoveries.push({at:new Date().toISOString(),reason:amendmentReason,stop:s.stop,requestIds:[]});delete s.stop;Object.assign(existing,next);}else s.rounds.push(next);s.next=`Run frozen round ${number}`;await save(s);return frozen;
}
export async function verifyRound(number:number){const s=await state(),r=s.rounds.find((r:any)=>r.number===number),dir=r.freezeDirectory??resolve(ROOT,`round-${String(number).padStart(2,'0')}`),f=JSON.parse(await readFile(resolve(dir,'freeze.json'),'utf8'));assert.equal(digest(JSON.stringify(f)),r.manifestDigest,'Frozen manifest changed');const versions=JSON.parse(await readFile(resolve(dir,'runtime-versions.json'),'utf8'));assert.equal(digest(JSON.stringify(versions)),r.dependencyDigest);assert.equal(await readFile(resolve(dir,'source','requirements-perception.txt'),'utf8'),versions.requirements);assert.deepEqual(await inventory(),f.entries.map((e:any)=>e.path),'Executable inventory changed');for(const e of f.entries){assert.equal(digest(await readFile(e.path)),e.sha256,`Working source changed: ${e.path}`);assert.equal(digest(await readFile(resolve(dir,'source',e.path))),e.sha256,`Snapshot changed: ${e.path}`);}return f;}
export function usage(){
 const file=resolve(ROOT,'requests.jsonl'),rows=existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[],calls=new Map<string,any>();
 for(const r of rows)calls.set(r.requestId,{...calls.get(r.requestId),...r});
 const sum=(items:any[])=>({requests:items.length,reportedTokens:items.reduce((n,r)=>n+(r.inputTokens??0),0),uncertainReservedTokens:items.reduce((n,r)=>n+(r.inputTokens==null?r.reserve:0),0),errors:items.filter(r=>r.status==='error').length});
 return {...sum([...calls.values()]),byRound:Object.fromEntries([1,2,3,4,5].map(n=>[n,sum([...calls.values()].filter(r=>r.round===n))])),calls:[...calls.values()]};
}
function journal(data:any){const fd=openSync(resolve(ROOT,'requests.jsonl'),'a');try{writeSync(fd,JSON.stringify({...data,at:new Date().toISOString()})+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
export async function runRound(number:number,key:string){
 const lock=resolve(ROOT,'dispatch.lock'),fd=openSync(lock,'wx');writeSync(fd,JSON.stringify({pid:process.pid,started:new Date().toISOString()}));closeSync(fd);
 try{
  const frozen=await verifyRound(number),s=await state(),round=s.rounds.find((r:any)=>r.number===number);assert(!s.stop,'Campaign stopped; explicit recorded recovery required');assert(key,'Saved API key required');
  const interrupted=s.attempts.filter((a:any)=>a.status==='started'),unresolved=usage().calls.filter(r=>r.status==='dispatched'||r.status==='error').filter(r=>!s.recoveries?.some((x:any)=>x.requestIds?.includes(r.requestId)));
  if(interrupted.length||unresolved.length){s.stop={reason:'Interrupted attempt or unreconciled dispatch/error. Preserve evidence and record explicit recovery.',attemptIds:interrupted.map((a:any)=>a.id),requestIds:unresolved.map(r=>r.requestId)};await save(s);throw new Error(s.stop.reason);}
  round.status='running';await save(s);
  if(frozen.plan.probes&&!round.probes){
   if(round.probesStarted){s.stop={reason:'Interrupted static probes; do not redispatch recorded requests'};await save(s);throw new Error(s.stop.reason);}
   round.probesStarted=new Date().toISOString();await save(s);
   try{round.probes=await runProbes(resolve(round.directory,'probes'),frozen.plan.probes,key,meteredTransport(number,`round-${number}-probes`,s),frozen.plan.probeOffset??3300);await save(s);console.log(JSON.stringify({event:'probes-finished',round:number,summary:round.probes}));}
   catch(e){s.stop={reason:String(e),stage:'probes',round:number};round.status='stopped';await save(s);throw e;}
  }
  for(const flight of frozen.plan.flights as Flight[]){
   const previous=s.attempts.find((a:any)=>a.id===flight.id);if(previous){assert.equal(previous.status,'valid','Nonvalid attempt cannot silently be skipped');continue;}
   assert(s.attempts.length<s.ceilings.flights);await verifyRound(number);
   const directory=resolve(round.directory,flight.id),attempt:any={id:flight.id,round:number,flight,directory,status:'started',started:new Date().toISOString()};s.attempts.push(attempt);s.next=`Attempt ${flight.id} running. Never replay this ID.`;await save(s);
   const transport=meteredTransport(number,flight.id,s);
   console.log(JSON.stringify({event:'start',round:number,id:flight.id}));
   try{attempt.result=await runSpatialTrial(directory,flight,key,transport);attempt.status='valid';console.log(JSON.stringify({event:'finish',round:number,id:flight.id,metrics:attempt.result.metrics,scout:{first:attempt.result.scout.firstDetectionMs,received:attempt.result.scout.firstJevReceiptMs}}));}
   catch(e){attempt.status='invalid';attempt.error=String(e);s.stop={at:new Date().toISOString(),attemptId:flight.id,reason:String(e)};round.status='stopped';console.log(JSON.stringify({event:'stopped',...s.stop}));}
   attempt.finished=new Date().toISOString();await verifyRound(number);const {calls,...totals}=usage();s.usage=totals;await save(s);if(s.stop)break;
  }
  if(!s.stop){assert(frozen.plan.flights.every((f:Flight)=>s.attempts.some((a:any)=>a.id===f.id&&a.status==='valid')),'Unfinished required flights');round.status='executed';}s.next=s.stop?'Diagnose and explicitly record recovery before dispatch.':`Analyze round ${number} and document next hypothesis before freeze.`;await save(s);
 }finally{await import('node:fs/promises').then(fs=>fs.unlink(lock));}
}
export function syntheticResponse(request:any):Response{return{model:MODEL,answers:Object.fromEntries(Object.entries(request.questions).map(([id,q]:any)=>{const keys=Object.keys(q.criteria),choice=id==='mode'?'search':id.endsWith('yaw')?'v6':id.endsWith('pitch')?'v3':id.endsWith('zoom')?'v0':keys.includes('v3')?'v3':keys[0];return[id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(c=>[c,c===choice?1:0]))}];}))};}

 export function meteredTransport(number:number,attemptId:string,s:any):typeof callJev{return async(request,k,signal)=>{
    signal.throwIfAborted();const u=usage(),r=u.byRound[number],reserve=Math.max(65536,Buffer.byteLength(JSON.stringify(request))*2),requestId=randomUUID();
    assert(u.requests+1<=s.ceilings.requests&&r.requests+1<=s.allocation.roundRequests[number-1],'Request ceiling');
    assert(u.reportedTokens+u.uncertainReservedTokens+reserve<=s.ceilings.inputTokens&&r.reportedTokens+r.uncertainReservedTokens+reserve<=s.allocation.roundTokens[number-1],'Token ceiling');
    journal({requestId,attemptId,round:number,status:'dispatched',reserve,requestSha256:digest(JSON.stringify(request))});
    try{const response=await callJev(request,k,signal),responseFile=resolve(ROOT,'api-responses',requestId+'.json');await mkdir(dirname(responseFile),{recursive:true});await writeFile(responseFile,JSON.stringify(response),{flag:'wx'});journal({requestId,status:'returned',actualModel:response.model,inputTokens:response.usage?.input_tokens??null,responseFile,responseSha256:digest(JSON.stringify(response))});assert.equal(response.model,MODEL);return response;}
    catch(e){journal({requestId,status:signal.aborted?'cancelled':'error',error:String(e)});throw e;}
   }}
