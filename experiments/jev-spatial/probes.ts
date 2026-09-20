import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {imageCase} from '../jev-hypotheses/fixtures.ts';
import {spatialDesign,task,type Options} from './design.ts';
import {callJev} from '../jev-pixels/controller.ts';
export async function runProbes(directory:string,variants:Record<string,Options>,key:string,transport:typeof callJev,offset=3300){
 await mkdir(directory);await mkdir(resolve(directory,'frames'));const rows:any[]=[];
 const save=()=>writeFile(resolve(directory,'report.json'),JSON.stringify({kind:'Static camera interpretation; no physical actuation or mission success',complete:rows.length===40*Object.keys(variants).length,rows}));
 for(let i=0;i<40;i++){
  const f=imageCase(offset+i,i<20?'development':'held-out'),o=structuredClone(f.observation),c=o.sensors.camera!.value as any;
  o.goal=task.goal(1);c.self='Own position not sampled in this static camera component fixture';c.evidence={events:{throughId:0,acknowledgedThroughId:0,dropped:0,items:[]},views:[],motion:[]};
  await writeFile(resolve(directory,c.frame),f.png,{flag:'wx'});const b=c.objects.find((p:any)=>p.color==='blue');
  const ordered=Object.entries(variants);if(i%2)ordered.reverse();
  for(const [variant,options] of ordered){const design=spatialDesign(options),request=design.request(o,variant,[]),id=`${f.id}-${variant}`;await writeFile(resolve(directory,`${id}.request.json`),JSON.stringify({observation:o,request}),{flag:'wx'});
   const start=performance.now();let response,mapping;
   try{response=await transport(request,key,AbortSignal.timeout(12000));await writeFile(resolve(directory,`${id}.response.json`),JSON.stringify(response),{flag:'wx'});mapping=design.map(request,response);}
   catch(e){await writeFile(resolve(directory,`${id}.error.json`),JSON.stringify({error:String(e),at:new Date().toISOString()}),{flag:'wx'});throw e;}
   const u=Math.tan(b.rightDeg*Math.PI/180)*c.calibration.fx/c.calibration.cx,v=Math.tan(b.upDeg*Math.PI/180)*c.calibration.fy/c.calibration.cy;
   const row={id,phase:i<20?'development':'within-round-evaluation',variant,observation:o,request,response,mapping,latencyMs:performance.now()-start,evaluation:{blue:b,yawNeeded:Math.abs(u)>.3,pitchNeeded:Math.abs(v)>.3,correctTarget:mapping.selections.mode===`track_${b.id}`,yawToward:mapping.action.heading*b.rightDeg<0,pitchToward:mapping.action.pitch*b.upDeg>0,note:'Direction-only component diagnostic. Multiple exploratory actions allowed when blue absent; these fixtures currently show blue. No motor command applied.'}};
   rows.push(row);await save();
  }
 }
 return {calls:rows.length,byVariant:Object.fromEntries(Object.keys(variants).map(v=>{const rr=rows.filter(r=>r.variant===v);return[v,{n:rr.length,targetCorrect:rr.filter(r=>r.evaluation.correctTarget).length,neededYaw:rr.filter(r=>r.evaluation.yawNeeded).length,towardYaw:rr.filter(r=>r.evaluation.yawNeeded&&r.evaluation.yawToward).length,neededPitch:rr.filter(r=>r.evaluation.pitchNeeded).length,towardPitch:rr.filter(r=>r.evaluation.pitchNeeded&&r.evaluation.pitchToward).length}];}))};
}
