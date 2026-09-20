import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {sourceHash,Trace} from '../reactive/run.ts';
import {ReactiveWorld,type ReactiveTask,type SensorExperiment,type ReactiveEnvironment} from '../reactive/world.ts';
import {DEFAULT_CONFIG,experimentConfig} from '../reactive/config.ts';
import {pixelController,callJev,type PixelControlDesign} from '../jev-pixels/controller.ts';
import {waitForFeedback} from '../jev-hypotheses/flights.ts';
import {trackingDesign} from './design.ts';
import {VisionWorker} from './worker.ts';
import {trackingProfile,trackingTask,stimulus,type Protocol} from './profile.ts';
import {trackingReport} from './report.ts';
export const ARMS={
 'colour-direct':{label:'Colour · direct Jev',description:'Pixel colour regions, Jev target binding, full physical choices; no camera servo.',mode:'colour',servo:false},
 'klt-direct':{label:'KLT · direct Jev',description:'Pixel KLT/neutral edges and uncertainty, Jev target binding, full physical choices.',mode:'klt',servo:false},
 'colour-servo':{label:'Colour · declared servo',description:'Same physical questions; Jev follow authorizes measured-bearing camera servo. Translation remains Jev-selected.',mode:'colour',servo:true},
 'klt-servo':{label:'KLT · declared servo',description:'KLT observations; Jev follow authorizes measured-bearing camera servo. Translation remains Jev-selected.',mode:'klt',servo:true},
} as const;
export type Arm=keyof typeof ARMS;
export type TrialSetup={definition:{label:string;description:string;mode:'colour'|'klt';servo:boolean};design:()=>PixelControlDesign;profile:(directory:string,worker:VisionWorker)=>SensorExperiment;task:ReactiveTask;environment:ReactiveEnvironment;limits?:{decisions:number;inputTokens:number}};
export async function runTrial(directory:string,arm:string,seed:number,protocol:Protocol,key:string,transport=callJev,secondsOverride?:number,setup?:TrialSetup){
 const definition=setup?.definition??ARMS[arm as Arm];if(!definition)throw new Error('Unknown arm');
 await mkdir(directory,{recursive:true});const id=`${arm}-${seed}`,trace=new Trace(resolve(directory,`${id}.jsonl`));const seconds=secondsOverride??(['constant','rate20'].includes(protocol)?60:90),abort=new AbortController();
 const worker=new VisionWorker(definition.mode,trace.emit),controller=pixelController(arm,key,trace.emit,transport,setup?.design()??trackingDesign(definition.servo),setup?.limits);let world:ReactiveWorld|undefined,job:Promise<void>|undefined,error:string|undefined,failed=false,maxLagMs=0,source='';
 try{
  await worker.start();const config=experimentConfig({...DEFAULT_CONFIG,minimumRefreshMs:250,commandSeconds:1,sourceAgeLimitMs:1000,sensors:{...DEFAULT_CONFIG.sensors,cooperativeBeacon:false}});
  const chosenTask=setup?.task??trackingTask,frameDir=resolve(directory,'frames',id);
  source=await sourceHash();world=await ReactiveWorld.create(seed,trace.emit,protocol==='goal-change'?60000:1e12,config,setup?setup.profile(frameDir,worker):trackingProfile(frameDir,worker,protocol==='rate20'?20:5),chosenTask,setup?.environment);
  trace.emit('reactive.manifest',{id,arm,seed,seconds,protocol,sourceHash:source,config,scenario:world.world.scenario,task:{id:chosenTask.id,goals:[chosenTask.goal(1),chosenTask.goal(2)]},sensorDesign:'PNG-derived colour / KLT plus optional neutral edges. No depth, position or evaluator fields.',controllerArrangement:definition});
  const port=waitForFeedback(worker.wrap(world.controllerPort()),abort.signal,trace.emit);
  job=controller.controller.run([port],abort.signal).catch(e=>{if(!abort.signal.aborted)error=String(e);});
  const start=performance.now()-world.world.simMs;let eventPhase=-1;
  while(world.world.simMs<seconds*1000){
   if(error&&!failed){failed=true;abort.abort();await world.failController(error);}
   worker.check();if(!setup)stimulus(world,protocol);const phase=setup?0:world.world.simMs<60000?0:world.world.simMs<65000?1:2;if(phase!==eventPhase){trace.emit('tracking.stimulus',{simMs:world.world.simMs,protocol,phase});eventPhase=phase;}
   await world.tick();const lag=performance.now()-start-world.world.simMs;maxLagMs=Math.max(maxLagMs,lag);if(lag>1000)throw new Error('Pacing exceeded one second');if(lag<0)await sleep(-lag);
  }
  abort.abort();await job;if(await sourceHash()!==source)throw new Error('Runtime changed during trial');
  const result={id,arm,seed,protocol,seconds,sourceHash:source,maxLagMs,controllerStatus:failed?'failed-world-continued':'finished',evaluation:world.evaluate(),worker:worker.stats};
  trace.emit('reactive.result',result);await writeFile(resolve(directory,`${id}.json`),JSON.stringify(result));await world.close();world=undefined;await worker.close();trace.close();
  const row=await trackingReport(directory,result,controller.stats,definition.servo,definition.mode,setup?.design);if(controller.stats.errors)throw new Error('Controller error; retained full evidence');return row;
 }catch(e){trace.emit('reactive.invalid',{error:String(e)});throw e;}finally{abort.abort();await world?.close();await worker.close();await job;trace.close();}
}
