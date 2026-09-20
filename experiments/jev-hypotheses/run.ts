import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,appendFile,readdir,copyFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { sourceHash,trial } from '../reactive/run.ts';
import { DEFAULT_CONFIG,experimentConfig } from '../reactive/config.ts';
import { pixelReport } from '../jev-pixels/report.ts';
import { PIXEL_TASK } from '../jev-pixels/profile.ts';
import { callJev } from '../jev-pixels/controller.ts';
import { MODEL } from '../jev-strategies/strategies.ts';
import { REPRESENTATIONS,hypothesisDesign } from './design.ts';
import { FLIGHTS,flightController,flightProfile } from './flights.ts';
import { saveImageCases } from './fixtures.ts';

const stage=process.argv[2],root=resolve(process.argv[3]??'.runtime/experiments/jev-hypotheses-v1');
assert(['freeze','static','flights'].includes(stage??''),'Stage: freeze | static | flights');
const frozenHash=async()=>createHash('sha256').update(await sourceHash()).update(await readFile('experiments/jev-hypotheses/flow.py')).update(await readFile('docs/jev-hypothesis-tests.md')).digest('hex');
if(stage==='freeze'){
  await mkdir(root,{recursive:true});const files=['package.json','package-lock.json','docs/jev-hypothesis-tests.md','experiments/jev-hypotheses/flow.py'];
  for(const base of ['src','controllers','integrations','experiments','scenarios'])for(const name of await readdir(base,{recursive:true}))if(/\.(ts|json)$/.test(name))files.push(`${base}/${name.replaceAll('\\','/')}`);
  for(const file of files){const dest=resolve(root,'source',file);await mkdir(dirname(dest),{recursive:true});await copyFile(file,dest);}
  await writeFile(`${root}/freeze.json`,JSON.stringify({hash:await frozenHash(),sourceHash:await sourceHash(),createdAt:new Date().toISOString(),files,representations:REPRESENTATIONS,flightArms:Object.keys(FLIGHTS),seeds:[1501,1502],seconds:24,budgetTokens:15000000},null,2),{flag:'wx'});
  console.log('Frozen hypotheses, full source, Python perception method and test plan.');
}else{
  const freeze=JSON.parse(await readFile(`${root}/freeze.json`,'utf8'));assert.equal(await frozenHash(),freeze.hash,'Source changed after freeze');
  const key=process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY;assert(key,'Real Jev credential required');
  const staticFile=`${root}/static/report.json`,flightFile=`${root}/flights/report.json`;
  const previousTokens=async()=>{let n=0;for(const f of [staticFile,flightFile])try{const r=JSON.parse(await readFile(f,'utf8'));n+=r.rows?r.rows.reduce((s:number,r:any)=>s+(r.response?.usage?.input_tokens??0),0):r.runs.reduce((s:number,r:any)=>s+r.metrics.tokens,0);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}return n;};
  if(stage==='static'){
    const dir=`${root}/static`;await mkdir(dir);const cases=await saveImageCases(dir),rows:any[]=[];let tokens=0;
    const report:any={sourceHash:freeze.hash,model:MODEL,design:'Balanced sensor-derived rendered images; same cases for every variant. Static diagnostic, no action applied. Full/compact same questions; compact/direct same state; direct/factored changes question decomposition; factored/binned adds measured bins; factored/conditional branches on model-selected region.',rows,errors:[],complete:false};
    await writeFile(staticFile,JSON.stringify(report,null,2));
    try{for(const [index,c] of cases.entries())for(let offset=0;offset<REPRESENTATIONS.length;offset++){
      const representation=REPRESENTATIONS[(index+offset)%REPRESENTATIONS.length]!,design=hypothesisDesign({representation});
      const request=design.request(c.observation,representation,[]),start=performance.now();
      await appendFile(`${dir}/requests.jsonl`,JSON.stringify({case:c.id,representation,request})+'\n');
      const response=await callJev(request,key,AbortSignal.timeout(12000)),latencyMs=performance.now()-start,mapping=design.map(request,response),yaw=mapping.action.heading,pitch=mapping.action.pitch;
      const target=c.evaluation,correctYaw=Math.sign(yaw)===Math.sign(-target.rightDeg),correctPitch=Math.sign(pitch)===Math.sign(target.upDeg);
      const row={case:c.id,phase:c.phase,representation,observation:c.observation,request,response,mapping,latencyMs,evaluation:{...target,correctYaw,correctPitch,correctTarget:representation==='conditional'?mapping.selections.target===target.targetId:null,yawResidualDeg:Math.abs(target.rightDeg+yaw),pitchResidualDeg:Math.abs(target.upDeg-pitch),yawImproved:Math.abs(target.rightDeg+yaw)<Math.abs(target.rightDeg),pitchImproved:Math.abs(target.upDeg-pitch)<Math.abs(target.upDeg)}};
      rows.push(row);tokens+=response.usage?.input_tokens??0;await appendFile(`${dir}/responses.jsonl`,JSON.stringify(row)+'\n');await writeFile(staticFile,JSON.stringify(report));
      console.log(JSON.stringify({case:c.id,representation,correctYaw,correctPitch,tokens,latencyMs:Math.round(latencyMs)}));assert(tokens<3000000,'Static budget exceeded');assert.equal(await frozenHash(),freeze.hash);
    }report.complete=true;}catch(error){report.errors.push(String(error));process.exitCode=1;}finally{await writeFile(staticFile,JSON.stringify(report));}
  }else{
    const directory=`${root}/flights`;await mkdir(directory);
    const config=experimentConfig({...DEFAULT_CONFIG,minimumRefreshMs:250,sourceAgeLimitMs:1000,commandSeconds:1,sensors:{...DEFAULT_CONFIG.sensors,cooperativeBeacon:false}});
    const manifest={version:'jev-pixels-v1',suite:'jev-hypotheses',phase:'held-out',model:MODEL,sourceHash:freeze.sourceHash,experimentHash:freeze.hash,arms:freeze.flightArms,definitions:FLIGHTS,seeds:freeze.seeds,seconds:freeze.seconds,config,goals:[PIXEL_TASK.goal(1),PIXEL_TASK.goal(2)],design:'Predeclared H1-H12 qualification. Camera-only diagnostics vs full control must be assessed by centring/visibility, not equal full-task success. Own actuator jobs are explicit local telemetry. Waits never read evaluator events. Confidence/servo assistance are declared overrides.',sensorDesign:'Recorded RGB and measured camera orientation only; no range, target coordinates, world map or achieved velocity. Two initial image quadrants; matched trajectories. Vision flow qualification is separate, not fed to these flights.',questionDesign:'Factored direction and both conditional magnitudes per axis, full physical choices. Camera-only diagnostics explicitly hold translation. Hybrid selects region/behavior and has a disclosed camera servo.',limitations:['Two seeds per arm are exploratory, not general robot qualification.','Hybrid has continuous computed camera angles; direct arms use discrete complete menus. Hybrid is architectural assistance, not a menu-only comparison.','Local jobs emulate on-device actuator feedback, not MAVLink acknowledgement semantics.']};
    const report:any={manifest,runs:[],invalid:[],stopped:false};await writeFile(flightFile,JSON.stringify(report,null,2));
    outer:for(const [i,seed] of freeze.seeds.entries())for(let offset=0;offset<freeze.flightArms.length;offset++){
      const arm=freeze.flightArms[(i+offset)%freeze.flightArms.length],id=`${arm}-${seed}`;console.log(JSON.stringify({event:'start',id}));
      let emit=(_kind:string,_data:unknown):void=>{throw new Error('Trace disconnected');};const {controller,stats}=flightController(arm,key,(k,d)=>emit(k,d));
      try{
        assert((await previousTokens())<freeze.budgetTokens);assert.equal(await frozenHash(),freeze.hash);
        const result=await trial({arm,seed,seconds:freeze.seconds,directory,phase:'held-out',config,task:PIXEL_TASK,sensorExperiment:flightProfile(resolve(directory,'frames',id)),controller,controllerSource:{files:[resolve('experiments/jev-hypotheses/design.ts'),resolve('experiments/jev-hypotheses/flights.ts')]},connectControllerTrace:fn=>{emit=fn;}});
        const row=await pixelReport(directory,result,stats,hypothesisDesign(FLIGHTS[arm]!.options));report.runs.push(row);console.log(JSON.stringify({event:'measured',...row}));if(stats.errors)throw new Error('Controller error; retained flight');
      }catch(error){report.invalid.push({id,error:String(error)});report.stopped=true;process.exitCode=1;}
      await writeFile(flightFile,JSON.stringify(report,null,2));if(report.stopped)break outer;
    }
  }
}
