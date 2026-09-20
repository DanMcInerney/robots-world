import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {colorTracker} from '../../src/perception/color-tracks.ts';
import {readFramePng} from '../../src/devices/pixel-camera.ts';
import {percentile} from '../jev-pixels/report.ts';
import {trackingDesign} from './design.ts';
import type {PixelControlDesign} from '../jev-pixels/controller.ts';
const wire=(v:any)=>JSON.parse(JSON.stringify(v));
export async function trackingReport(directory:string,result:any,stats:any,servo:boolean,mode:'colour'|'klt',designFactory?:()=>PixelControlDesign){
 const decisions:any[]=[],byId=new Map(),events:any[]=[],packets:any[]=[],admissions:any[]=[],portCommands=new Map(),vision=new Map(),inputs:any[]=[];let manifest:any;
 const source=createInterface({input:createReadStream(resolve(directory,`${result.id}.jsonl`)),crlfDelay:Infinity});
 for await(const line of source){const {kind,data,monoMs}=JSON.parse(line);
  if(kind==='reactive.manifest')manifest=data;
  if(kind==='pixels.request'){const d={...data,requestMonoMs:monoMs};decisions.push(d);byId.set(data.decisionId,d);}
  if(kind==='pixels.response')Object.assign(byId.get(data.decisionId)??{},data);
  if(kind==='pixels.mapping')Object.assign(byId.get(data.decisionId)??{},{mapping:data});
  if(kind==='reactive.port.request')portCommands.set(data.command.id,data.command);
  if(kind==='reactive.command.admitted')admissions.push(data);
  if(kind==='reactive.camera.command')packets.push({kind,...data});
  if(kind==='world.event'&&data.channel==='protocol')packets.push(data);
  if(kind==='vision.input')inputs.push(data);
  if(kind==='vision.result')vision.set(data.acquiredMs,data.result);
  if(['pixels.error','reactive.goal','tracking.stimulus','reactive.controller.failed','reactive.command.rejected','reactive.command-link.drop','vision.coalesced'].includes(kind))events.push({kind,...data});
 }
 const dir=resolve(directory,'frames',result.id),track=colorTracker(),raw=new Map();
 const files=(await readdir(dir)).filter(f=>f.endsWith('.json')).sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]));
 for(const f of files){const meta=JSON.parse(await readFile(resolve(dir,f),'utf8')),png=await readFile(resolve(dir,f.replace('.json','.png')));assert.equal(createHash('sha256').update(png).digest('hex'),meta.sha256);const replay=wire(track(readFramePng(png),meta.calibration,meta.acquiredMs));assert.deepEqual(replay.objects,meta.camera.objects);raw.set(meta.acquiredMs,replay);}
 for(const f of inputs)assert.deepEqual(f.objects,raw.get(f.acquiredMs).objects);
 const {stdout}=await promisify(execFile)(resolve('.runtime/vision-env/Scripts/python.exe'),['experiments/jev-tracking/audit.py',directory,result.id,mode],{windowsHide:true,maxBuffer:1024*1024});const pixelAudit=JSON.parse(stdout.trim());assert(pixelAudit.passed);
 const design=designFactory?.()??trackingDesign(servo),feedback:any[]=[];
 for(const d of decisions){const c=d.observation.sensors.camera;assert.deepEqual(c.value.objects,vision.get(c.acquiredSimMs).objects);assert.deepEqual(c.value.lostTracks,vision.get(c.acquiredSimMs).lostTracks);assert.deepEqual(wire(design.request(d.observation,result.arm,feedback)),d.request);
  if(d.mapping){const expected=wire(design.map(d.request,d.response));assert.deepEqual(expected.action,d.mapping.action);assert.deepEqual(expected.selections,d.mapping.selections);assert.deepEqual(expected.overrides,d.mapping.overrides);
   const command=portCommands.get(d.decisionId);if(d.mapping.receipt.reason!=='processed-image-stale-or-unknown'){assert(command);const {duration,...args}=expected.action;assert.deepEqual(command.args,args);assert.equal(command.validForMs,duration*1000);}
   d.admission=admissions.find(a=>a.source.simMs===d.observation.simMs&&JSON.stringify(a.action)===JSON.stringify(expected.action))??null;
   d.firstApplication=d.admission?packets.find(p=>p.kind==='reactive.camera.command'&&p.commandId===d.admission.commandId)??null:null;
   d.acquisitionToApplicationMs=d.firstApplication?d.firstApplication.simMs-c.acquiredSimMs:null;
   feedback.push({selectedBodyVelocity:expected.bodyVelocity,heading:expected.action.heading,pitch:expected.action.pitch,receipt:d.mapping.receipt});if(feedback.length>2)feedback.shift();
  }
 }
 const frames=result.evaluation.trajectory,center=(f:any)=>f.visible&&Math.abs(f.view.u)<=.3&&Math.abs(f.view.v)<=.3;
 const rate=(rows:any[],pred:(f:any)=>boolean)=>rows.length?rows.filter(pred).length/rows.length:0;
 let dwell=0,longest=0,firstLock:number|null=null,recovery:number|null=null;for(const f of frames){dwell=center(f)?dwell+100:0;longest=Math.max(longest,dwell);if(dwell>=1000&&firstLock===null)firstLock=f.simMs-900;if(result.protocol==='recovery'&&f.simMs>=65000&&dwell>=1000&&recovery===null&&f.simMs-900>=65000)recovery=f.simMs-900;}
 const steady=frames.filter((f:any)=>f.simMs>10000),completed=decisions.filter(d=>d.mapping),cameras=decisions.map(d=>d.observation.sensors.camera.value),ages=decisions.map(d=>d.acquisitionToApplicationMs).filter(n=>n!=null);
 const path=frames.slice(1).reduce((n:number,f:any,i:number)=>n+Math.hypot(f.drone.x-frames[i].drone.x,f.drone.y-frames[i].drone.y,f.drone.z-frames[i].drone.z),0);
 const metrics={success:firstLock!==null&&firstLock<=20000&&rate(steady,center)>=.8&&result.evaluation.collisionTicks===0&&stats.errors===0,
  firstLockMs:firstLock,longestCentreDwellMs:longest,centredFromStart:rate(frames,center),centredAfter10s:rate(steady,center),visibleFromStart:rate(frames,(f:any)=>f.visible),framingFraction:rate(frames,(f:any)=>f.inspectable),framingAfterChange:rate(frames.filter((f:any)=>f.simMs>60000),(f:any)=>f.inspectable),
  recoveryEligible:result.protocol==='recovery'?rate(frames.filter((f:any)=>f.simMs>=55000&&f.simMs<60000),center)>=.8:null,reacquiredAtMs:recovery,recoveryDelayMs:recovery===null?null:recovery-65000,
  pathM:path,cameraBlueFraction:rate(cameras,(c:any)=>c.objects.some((o:any)=>o.color==='blue')),movementFraction:stats.completed?stats.moving/stats.completed:0,apiP50Ms:percentile(stats.latencyMs,.5),apiP95Ms:percentile(stats.latencyMs,.95),appliedAgeP95Ms:percentile(ages,.95),perceptionP50Ms:percentile(cameras.map(c=>c.perceptionMs),.5),
  collisionTicks:result.evaluation.collisionTicks,boundsTicks:result.evaluation.boundsTicks,tokens:stats.tokens,completed:stats.completed,errors:stats.errors,admitted:stats.admitted,rejected:stats.rejected,framesAudited:raw.size,requestsAudited:decisions.length,processedFramesAudited:pixelAudit.processedFramesReplayed,
  overrides:completed.filter(d=>d.mapping.overrides?.length).length,worker:result.worker};
 const run={...result,manifest,stats,metrics,decisions,wire:packets,events,audit:{pixelReplay:true,exactRequests:true,exactMapping:true,workerReplay:pixelAudit,note:'All raw PNG/colour measurements and all processed worker inputs/results reconstructed. Evaluator facts are scoring only.'}};
 await writeFile(resolve(directory,`${result.id}.report.json`),JSON.stringify(run));return{id:result.id,arm:result.arm,seed:result.seed,file:`${result.id}.report.json`,metrics};
}
