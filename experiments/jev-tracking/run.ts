import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,copyFile,appendFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {sourceHash} from '../reactive/run.ts';
import {callJev} from '../jev-pixels/controller.ts';
import {MODEL} from '../jev-strategies/strategies.ts';
import {staticTests} from './static.ts';
import {ARMS,runTrial,type Arm} from './trial.ts';
import {trackingTask,type Protocol} from './profile.ts';
const stage=process.argv[2],root=resolve(process.argv[3]??'.runtime/experiments/jev-tracking-v1');
assert(['freeze','static','development','constant','recovery','goal-change','rate20'].includes(stage??''));
const concurrencyArgument=process.argv.find(a=>a.startsWith('--concurrency='));
assert(!concurrencyArgument||stage==='freeze','Choose concurrency when freezing a new cohort');
const concurrency=Number(concurrencyArgument?.split('=')[1]??1);
assert([1,2,3].includes(concurrency),'Concurrency must be 1, 2 or 3');
const extras=['docs/jev-tracking-tests.md',...(await readdir('experiments/jev-tracking')).filter(f=>f.endsWith('.py')).sort().map(f=>`experiments/jev-tracking/${f}`)];
async function frozenHash(){const h=createHash('sha256').update(await sourceHash());for(const f of extras)h.update(f).update(await readFile(f));return h.digest('hex');}
if(stage==='freeze'){
 try{await access(`${root}/freeze.json`);assert.fail('A freeze already exists; choose a new evidence directory');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await mkdir(root,{recursive:true});const files=['package.json','package-lock.json',...extras];
 for(const base of ['src','controllers','integrations','experiments','scenarios'])for(const f of await readdir(base,{recursive:true}))if(/\.(ts|json)$/.test(f))files.push(`${base}/${f.replaceAll('\\','/')}`);
 for(const f of files){const dest=resolve(root,'source',f);await mkdir(dirname(dest),{recursive:true});await copyFile(f,dest);}
 await writeFile(`${root}/freeze.json`,JSON.stringify({hash:await frozenHash(),sourceHash:await sourceHash(),createdAt:new Date().toISOString(),files,model:MODEL,arms:ARMS,developmentSeeds:[1701,1702],heldOutSeeds:[1801,1802,1803,1804,1805,1806,1807,1808],tokenCeiling:50_000_000,concurrency},null,2),{flag:'wx'});
 console.log('Tracking source and plan frozen. No inference in this stage.');
}else{
 const freeze=JSON.parse(await readFile(`${root}/freeze.json`,'utf8'));assert.equal(await frozenHash(),freeze.hash,'Frozen source changed');
 const key=process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY;assert(key,'Real Jev key required');
 let usage:any;try{usage=JSON.parse(await readFile(`${root}/usage.json`,'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;usage={inputTokens:0,uncertainReservedTokens:0,calls:0,cancelled:0,errors:[],ceiling:freeze.tokenCeiling};}
 let reserved=0,stopped=false,persist=Promise.resolve();
 const saveUsage=()=>{const data=JSON.stringify(usage,null,2);persist=persist.then(()=>writeFile(`${root}/usage.json`,data));return persist;};
 const transport:typeof callJev=async(request,k,signal)=>{
  assert(!stopped,'Batch stopped after earlier error');signal.throwIfAborted();
  // Reserve a conservative byte-per-token upper estimate per parallel question. Unknown charges remain reserved.
  const reserve=Object.keys(request.questions).length*(Buffer.byteLength(JSON.stringify(request.state))+2048)+Buffer.byteLength(JSON.stringify(request.questions));
  assert(usage.inputTokens+usage.uncertainReservedTokens+reserved+reserve<=freeze.tokenCeiling,'Total token ceiling reached');reserved+=reserve;
  try{const response=await callJev(request,k,signal);usage.inputTokens+=response.usage?.input_tokens??reserve;usage.calls++;await saveUsage();return response;}
  catch(e){usage.uncertainReservedTokens+=reserve;if(signal.aborted)usage.cancelled++;else{usage.errors.push(String(e));stopped=true;}await saveUsage();throw e;}
  finally{reserved-=reserve;}
 };
 if(stage==='static'){await mkdir(`${root}/static`);await staticTests(`${root}/static`,key,transport);assert.equal(await frozenHash(),freeze.hash);}
 else{
  const protocol:Protocol=stage==='development'?'constant':stage as Protocol,seeds:number[]=stage==='development'?freeze.developmentSeeds:freeze.heldOutSeeds;
  const arms=(Object.keys(ARMS) as Arm[]).filter(a=>stage!=='rate20'||a.startsWith('klt')),seconds=['constant','rate20'].includes(protocol)?60:90,directory=`${root}/${stage}`;await mkdir(directory);
  const report:any={manifest:{version:'jev-pixels-v1',suite:'persistent-tracking-v1',phase:stage==='development'?'development':'held-out',protocol,model:MODEL,sourceHash:freeze.sourceHash,experimentHash:freeze.hash,arms,definitions:ARMS,seeds,seconds,goals:protocol==='goal-change'?[trackingTask.goal(1),trackingTask.goal(2)]:[trackingTask.goal(1)],sensorDesign:`320×180 recorded RGB at requested ${protocol==='rate20'?20:5} Hz; colour or KLT plus neutral edges. Original acquisition times, fallible correspondence, visible patch extent. No range, target coordinates or recommendations.`,questionDesign:'Jev first binds one current region. Then 16 parallel physical questions + behavior + conditional reselection. Full 43,218 physical combinations; no shortlist. Servo arms explicitly replace camera angles only for Jev follow on an observed active region.',scoringNote:'PASS means first 1 s centre dwell by 20 s, ≥80% centring after 10 s, no collisions/controller errors. This is tracking qualification, not full mission or hardware qualification. Framed time includes the entire run. Bounds and size are reported separately. API p50 averages flight medians; age is maximum per-flight p95.',limitations:['Synthetic RGB and simplified dynamics; no real camera/edge board qualification.','KLT treatment also adds neutral edge discovery and uncertainty.','Servo is declared assistance; translation remains Jev-selected.','Local actuator telemetry is not a bare MAVLink acknowledgement.']},runs:[],invalid:[],stopped:false,complete:false};
  const tasks=seeds.flatMap((seed,i)=>arms.map((_,j)=>({seed,arm:arms[(i+j)%arms.length]!})));let next=0,queue=Promise.resolve();
  const save=()=>{const data=JSON.stringify(report);queue=queue.then(()=>writeFile(`${directory}/report.json`,data));return queue;};await save();
  async function lane(){while(!stopped&&next<tasks.length){const {seed,arm}=tasks[next++]!,id=`${arm}-${seed}`;try{assert.equal(await frozenHash(),freeze.hash);console.log(JSON.stringify({event:'start',stage,id}));const row=await runTrial(directory,arm,seed,protocol,key!,transport);report.runs.push(row);console.log(JSON.stringify({event:'measured',stage,...row}));}
   catch(e){stopped=true;report.stopped=true;report.invalid.push({id,error:String(e)});console.log(JSON.stringify({event:'invalid',id,error:String(e)}));process.exitCode=1;}await save();}}
  await Promise.all(Array.from({length:freeze.concurrency},()=>lane()));report.complete=!stopped&&report.runs.length===tasks.length;await save();await saveUsage();
  await appendFile(`${root}/stages.jsonl`,JSON.stringify({stage,complete:report.complete,runs:report.runs.length,invalid:report.invalid,time:new Date().toISOString(),usage})+'\n');
 }
}
