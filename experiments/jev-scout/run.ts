import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {sourceHash} from '../reactive/run.ts';
import {runTrial} from '../jev-tracking/trial.ts';
import {recordedRgbProfile} from '../jev-tracking/profile.ts';
import {callJev} from '../jev-pixels/controller.ts';
import {MODEL,type Response} from '../jev-strategies/strategies.ts';
import {ARMS,scoutDesign,type Arm} from './design.ts';
import {CASES,scoutEnvironment,task,type ScoutCase} from './scenario.ts';
import {scoreScout} from './score.ts';

const stage=process.argv[2],root=resolve(process.argv[3]??'.runtime/experiments/jev-scout-v1');
assert(['freeze','smoke','pilot','development','held-out'].includes(stage??''),'Use freeze, smoke, pilot, development or held-out');
const extras=['docs/jev-scout-tests.md','docs/jev-scout-techniques.md','experiments/jev-scout/summarize.mjs','experiments/jev-tracking/perception.py','experiments/jev-tracking/audit.py'];
async function hash(){const h=createHash('sha256').update(await sourceHash());for(const f of extras)h.update(f).update(await readFile(f));return h.digest('hex');}
if(stage==='freeze'){
  await mkdir(root); // Exclusive output root; never rewrite an earlier freeze/source snapshot.
  const files=['package.json','package-lock.json',...extras];
  for(const base of ['src','controllers','integrations','experiments','scenarios'])for(const f of await readdir(base,{recursive:true}))if(/\.(ts|json)$/.test(f))files.push(`${base}/${f.replaceAll('\\','/')}`);
  for(const f of files){const to=resolve(root,'source',f);await mkdir(dirname(to),{recursive:true});await copyFile(f,to);}
  await writeFile(`${root}/freeze.json`,JSON.stringify({hash:await hash(),files,model:MODEL,development:[2101,2102],heldOut:[2201,2202,2203,2204],cases:CASES,arms:ARMS,seconds:120,concurrency:1,tokenCeiling:60_000_000,limits:{decisions:500,inputTokens:5_000_000},order:'Rotate arm order by case index plus seed index; pilot is 18 flights, no held-out inference authorized by this plan.'},null,2),{flag:'wx'});
  console.log('Source and plan frozen; no inference.');
}else{
  const smoke=stage==='smoke',kind=process.argv.find(a=>a.startsWith('--case='))?.slice(7) as ScoutCase;
  assert(CASES.includes(kind),'Choose exactly one --case=turn-to-find|behind-wall|occlusion-course');
  const freeze=smoke?{hash:await hash(),seconds:8,development:[2101],heldOut:[],tokenCeiling:0}:JSON.parse(await readFile(`${root}/freeze.json`,'utf8'));
  assert.equal(await hash(),freeze.hash,'Source/plan changed after freeze');
  const key=smoke?'':process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY;
  if(!smoke){assert(process.argv.includes('--real'),'Paid inference requires --real');assert(key,'Real key required');}
  const directory=resolve(root,`${stage}-${kind}`);await mkdir(directory,{recursive:smoke});
  let usage={inputTokens:0,uncertainReservedTokens:0,calls:0,errors:[] as string[],cancelled:0};
  if(!smoke){try{usage=JSON.parse(await readFile(`${root}/usage.json`,'utf8'));}catch(e){if((e as any).code!=='ENOENT')throw e;}assert(!usage.errors.length,'Previous campaign failure: preserve cohort and stop. No automatic retries.');}
  const saveUsage=()=>writeFile(`${root}/usage.json`,JSON.stringify(usage,null,2));
  const transport:typeof callJev=async(r,k,signal)=>{
    if(smoke){
      // Fixed mechanical spin only, not a search competitor or a fake Jev result.
      return {model:MODEL,answers:Object.fromEntries(Object.entries(r.questions).map(([id,q])=>{const keys=Object.keys(q.criteria),selected=id==='mode'?'search':id==='search_yaw'?'v8':id==='search_pitch'?'v3':id==='search_zoom'?'v0':keys.includes('v3')?'v3':keys[0]!;return[id,{type:'choice',choice:selected,confidence:1,probabilities:Object.fromEntries(keys.map(c=>[c,c===selected?1:0]))}];}))} as Response;
    }
    signal.throwIfAborted();const reserve=Object.keys(r.questions).length*(Buffer.byteLength(JSON.stringify(r.state))+2048)+Buffer.byteLength(JSON.stringify(r.questions));
    assert(usage.inputTokens+usage.uncertainReservedTokens+reserve<=freeze.tokenCeiling,'Token ceiling reached');
    try{const answer=await callJev(r,k,signal);usage.inputTokens+=answer.usage?.input_tokens??reserve;usage.calls++;return answer;}
    catch(e){usage.uncertainReservedTokens+=reserve;if(signal.aborted)usage.cancelled++;else usage.errors.push(String(e));throw e;}
    finally{await saveUsage();}
  };
  const smokeArm=process.argv.find(a=>a.startsWith('--arm='))?.slice(6) as Arm|undefined;
  if(smokeArm)assert(smoke&&Object.hasOwn(ARMS,smokeArm),'--arm is for named synthetic smoke only');
  const arms:Arm[]=smoke?[smokeArm??'scout-memory']:Object.keys(ARMS) as Arm[],seeds:number[]=stage==='held-out'?freeze.heldOut:freeze.development;
  const report:any={manifest:{version:'jev-pixels-v1',suite:'obstacle-scout-v1',phase:smoke?'MECHANICAL ONLY — synthetic spin, no Jev':stage,inference:smoke?'synthetic':'real',protocol:kind,model:smoke?null:MODEL,experimentHash:freeze.hash,arms,definitions:ARMS,seeds,seconds:freeze.seconds,goals:[task.goal(1)],
    sensorDesign:'Recorded 320×180 RGB at 5 Hz; OpenCV KLT + neutral edges; dated heading/pitch. No range, map, clearance or actor truth.',
    questionDesign:'Direct: 7 + 6 per observed region independent questions. Assisted: 7 + 3 per region. Search always preserves 43,218 combined controls. All measured regions offered. Only assisted arms authorize selected-region camera servo; translation remains Jev. No initial binding hold.',
    scoringNote:'Mission PASS: detect by 45 s, ≥30 s remaining; ≥40% visible-patch framing after acquisition and 2 s continuous framing; no loss >20 s, collisions, bounds violations or controller errors. Missing detection counts against framing. Synthetic smoke has no mission score.'},runs:[],invalid:[],complete:false,stopped:false};
  await writeFile(`${directory}/report.json`,JSON.stringify(report),{flag:'wx'});
  for(const [seedIndex,seed] of seeds.entries()){const offset=smoke?0:(CASES.indexOf(kind)+seedIndex)%arms.length,ordered=[...arms.slice(offset),...arms.slice(0,offset)];for(const arm of ordered){
    const id=`${arm}-${seed}`;
    try{
      assert.equal(await hash(),freeze.hash);console.log(JSON.stringify({event:'start',id,kind,synthetic:smoke}));
      const row=await runTrial(directory,arm,seed,'constant',key!,transport,freeze.seconds,{definition:{...ARMS[arm],mode:'klt'},design:()=>scoutDesign(ARMS[arm].memory,ARMS[arm].servo),profile:recordedRgbProfile,task,environment:scoutEnvironment(seed,kind),limits:freeze.limits});
      const run=JSON.parse(await readFile(resolve(directory,row.file),'utf8')),frameDir=resolve(directory,'frames',id),frames=[];
      for(const f of (await readdir(frameDir)).filter(f=>f.endsWith('.json')))frames.push(JSON.parse(await readFile(resolve(frameDir,f),'utf8')));
      frames.sort((a,b)=>a.acquiredMs-b.acquiredMs);
      const score=scoreScout(frames,freeze.seconds,run.metrics.collisionTicks,run.metrics.boundsTicks,run.metrics.errors);
      const search=run.decisions.filter((d:any)=>d.mapping?.selections?.mode==='search'),applied=search.filter((d:any)=>d.firstApplication);
      run.scout={...score,searchSelected:search.length,searchApplied:applied.length,searchWithTranslation:applied.filter((d:any)=>d.mapping.bodyVelocity.some((v:number)=>v!==0)).length,searchCameraChanges:applied.filter((d:any)=>d.mapping.selections.search_yaw!=='v4'||d.mapping.selections.search_pitch!=='v3').length,
        note:'Search action counts do not prove causal recovery. Compare retained fixed-observer counterfactual; do not attribute passive reappearance to search.'};
      run.inference=smoke?'synthetic':'real';run.metrics={...run.metrics,success:smoke?null:score.success,framingFraction:score.framingFraction};
      if(smoke)run.scout.success=null;
      await writeFile(resolve(directory,row.file),JSON.stringify(run));row.metrics=run.metrics;report.runs.push(row);console.log(JSON.stringify({event:'finish',id,kind,success:run.metrics.success,acquiredMs:score.firstDetectionMs,framing:score.framingFraction,tokens:run.metrics.tokens}));
    }catch(e){report.invalid.push({id,error:String(e),trace:`${id}.jsonl`});report.stopped=true;process.exitCode=1;if(!smoke){usage.errors.push(`${kind}/${id}: ${String(e)}`);await saveUsage();}}
    await writeFile(`${directory}/report.json`,JSON.stringify(report));if(report.stopped)break;
  }if(report.stopped)break;}
  report.complete=!report.stopped&&report.runs.length===seeds.length*arms.length;await writeFile(`${directory}/report.json`,JSON.stringify(report));
  console.log(JSON.stringify({complete:report.complete,runs:report.runs.length,invalid:report.invalid,synthetic:smoke}));
}
