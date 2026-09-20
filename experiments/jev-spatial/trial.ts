import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {deflateSync,inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {sourceHash,Trace} from '../reactive/run.ts';
import {ReactiveWorld,type Emit} from '../reactive/world.ts';
import {DEFAULT_CONFIG,experimentConfig} from '../reactive/config.ts';
import {pixelController,callJev} from '../jev-pixels/controller.ts';
import {waitForFeedback} from '../jev-hypotheses/flights.ts';
import {VisionWorker} from '../jev-tracking/worker.ts';
import {trackingReport} from '../jev-tracking/report.ts';
import {type ScoutCase} from '../jev-scout/scenario.ts';
import {scoreScout} from '../jev-scout/score.ts';
import {spatialProfile} from './profile.ts';
import {spatialDesign,task,type Options} from './design.ts';
import {EvidenceLedger} from './evidence.ts';
import {spatialEnvironment,FIXTURES,type Fixture} from './fixtures.ts';

export type Flight={id:string;arm:string;seed:number;kind:ScoutCase;options:Options;seconds:number;family:string;fixture?:Fixture};
export async function runSpatialTrial(directory:string,f:Flight,key:string,transport:typeof callJev){
 assert(FIXTURES.includes(f.fixture??'scout-v1'),'Unqualified fixture identifier');
 await mkdir(directory); // Attempt directory is exclusive even after interruption.
 const id=`${f.arm}-${f.seed}`,trace=new Trace(resolve(directory,`${id}.jsonl`)),ledger=new EvidenceLedger();
 const emit:Emit=(kind,data:any)=>{if(kind==='reactive.port.observation'){const bytes=Buffer.from(JSON.stringify(data));trace.emit('spatial.port-observation.deflated',{codec:'deflate-base64',sha256:createHash('sha256').update(bytes).digest('hex'),data:deflateSync(bytes).toString('base64')});}else trace.emit(kind,data);if(kind==='vision.input')ledger.input(data);if(kind==='vision.result')ledger.result(data);};
 const abort=new AbortController(),worker=new VisionWorker('klt',emit),factory=()=>spatialDesign(f.options),design=spatialDesign(f.options,n=>{emit('spatial.ack',{throughId:n});ledger.consume(n);});
 const controller=pixelController(f.arm,key,emit,transport,design,{decisions:550,inputTokens:6_000_000});let world:ReactiveWorld|undefined,job:Promise<void>|undefined,error:string|undefined,failed=false,maxLagMs=0;
 const source=await sourceHash();
 try{
  await worker.start();const config=experimentConfig({...DEFAULT_CONFIG,minimumRefreshMs:250,commandSeconds:1,sourceAgeLimitMs:1000,sensors:{...DEFAULT_CONFIG.sensors,cooperativeBeacon:false}});
  world=await ReactiveWorld.create(f.seed,emit,1e12,config,spatialProfile(resolve(directory,'frames',id),worker),task,spatialEnvironment(f.seed,f.kind,f.fixture));
  emit('reactive.manifest',{id,arm:f.arm,seed:f.seed,seconds:f.seconds,protocol:f.kind,sourceHash:source,config,scenario:world.world.scenario,task:{id:task.id,goals:[task.goal(1)]},sensorDesign:'320x180 RGB 5Hz, 100ms latency, 2% dropout, KLT/neutral regions, noisy attitude and own local-position estimate +/-0.08m; all metric object geometry unknown.',controllerArrangement:{...f,servo:false}});
  const memoryPort=ledger.wrap(worker.wrap(world.controllerPort()),d=>emit('spatial.snapshot',d)),port=f.options.wait===false?memoryPort:waitForFeedback(memoryPort,abort.signal,emit);
  job=controller.controller.run([port],abort.signal).catch(e=>{if(!abort.signal.aborted)error=String(e);});
  const start=performance.now()-world.world.simMs;
  while(world.world.simMs<f.seconds*1000){
   if(error&&!failed){failed=true;abort.abort();await world.failController(error);}
   worker.check();await world.tick();const lag=performance.now()-start-world.world.simMs;maxLagMs=Math.max(maxLagMs,lag);if(lag>1000)throw new Error('Pacing exceeded one second');if(lag<0)await sleep(-lag);
  }
  abort.abort();await job;assert.equal(await sourceHash(),source,'Runtime changed during trial');
  const result={id,arm:f.arm,seed:f.seed,protocol:f.kind,seconds:f.seconds,sourceHash:source,maxLagMs,controllerStatus:failed?'failed-world-continued':'finished',evaluation:world.evaluate(),worker:worker.stats};
  emit('reactive.result',result);await writeFile(resolve(directory,`${id}.json`),JSON.stringify(result));await world.close();world=undefined;await worker.close();trace.close();
  const row=await trackingReport(directory,result,controller.stats,false,'klt',factory);
  await auditLedger(resolve(directory,`${id}.jsonl`));
  const run=JSON.parse(await readFile(resolve(directory,row.file),'utf8')),frames=[];
  for(const name of(await readdir(resolve(directory,'frames',id))).filter(n=>n.endsWith('.json')))frames.push(JSON.parse(await readFile(resolve(directory,'frames',id,name),'utf8')));
  frames.sort((a,b)=>a.acquiredMs-b.acquiredMs);const score=scoreScout(frames,f.seconds,run.metrics.collisionTicks,run.metrics.boundsTicks,run.metrics.errors);
  const first=run.decisions.find((d:any)=>d.response&&(d.request.state.objects.some((o:any)=>o.appearance.startsWith('blue'))||d.request.state.unreadDetections?.items.some((e:any)=>e.objects.some((o:any)=>o.color==='blue'))));
  const currentBlue=run.decisions.filter((d:any)=>d.request.state.objects.some((o:any)=>o.appearance.startsWith('blue'))).length;
  const search=run.decisions.filter((d:any)=>d.mapping?.selections.mode==='search'),moving=search.filter((d:any)=>d.mapping.bodyVelocity.some((v:number)=>v!==0));
  run.scout={...score,firstJevReceiptMs:first?.observation.simMs??null,currentBlueRequests:currentBlue,searchSelected:search.length,searchTranslation:moving.length};
  run.metrics={...run.metrics,success:score.success,framingFraction:score.framingFraction};run.audit.acquisitionLedgerReplay=true;run.inference=key?'real':'synthetic';if(!key)run.metrics.success=null;
  await writeFile(resolve(directory,row.file),JSON.stringify(run));
  if(controller.stats.errors)throw new Error('Controller error; retained complete invalid report');
  return {...row,metrics:run.metrics,scout:run.scout,file:row.file};
 }catch(e){emit('reactive.invalid',{error:String(e)});throw e;}finally{abort.abort();await world?.close();await worker.close();await job;trace.close();}
}
export async function auditLedger(file:string){
 const replay=new EvidenceLedger(),readings=new Map<string,any>();
 for await(const line of createInterface({input:createReadStream(file),crlfDelay:Infinity})){
  const {kind,data}=JSON.parse(line);
  if(kind==='spatial.port-observation.deflated'){const bytes=inflateSync(Buffer.from(data.data,'base64'));assert.equal(createHash('sha256').update(bytes).digest('hex'),data.sha256);JSON.parse(bytes.toString());}
  if(kind==='vision.input'){const meta=JSON.parse(await readFile(data.file.replace(/\.png$/,'.json'),'utf8'));assert.deepEqual(data.camera,meta.camera,'Raw metadata to worker camera/self provenance');replay.input(data);}
  if(kind==='vision.result')replay.result(data);
  // The raw port observation occurs before worker/ledger wrapping; explicit snapshots carry the gated result.
  if(kind==='spatial.snapshot'){const expected=replay.advance(data.acquiredMs);assert.deepEqual(expected,data.evidence);readings.set(data.key,data.evidence);}
  if(kind==='spatial.ack')replay.consume(data.throughId);
  if(kind==='pixels.request'){const c=data.observation.sensors.camera;assert.deepEqual(c.value.evidence,readings.get(`${data.observation.sequence}:${c.acquiredSimMs}`),'Ledger request provenance');const path=resolve(file,'..',c.value.frame).replace(/\.png$/,'.json'),raw=JSON.parse(await readFile(path,'utf8')).camera;for(const k of ['self','headingDeg','pitchDeg','hfovDeg','calibration','sha256'])assert.deepEqual(c.value[k],raw[k],`Raw metadata to delivered ${k}`);}
 }
}
