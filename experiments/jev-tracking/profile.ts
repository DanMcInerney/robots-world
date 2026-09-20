import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {renderCamera,framePng} from '../../src/devices/pixel-camera.ts';
import {colorTracker} from '../../src/perception/color-tracks.ts';
import {yawDegrees} from '../../src/devices/aim-camera.ts';
import {pose,vec} from '../../src/math.ts';
import type {BodySpec} from '../../src/contracts.ts';
import type {SensorExperiment,ReactiveWorld,ReactiveTask} from '../reactive/world.ts';
import type {VisionWorker} from './worker.ts';
import {PIXEL_TASK} from '../jev-pixels/profile.ts';
export type Protocol='constant'|'recovery'|'goal-change'|'rate20';
export const trackingTask:ReactiveTask={...PIXEL_TASK,id:'persistent-image-tracking-v1'};
export function trackingProfile(directory:string,worker:VisionWorker,hz=5):SensorExperiment{
 const rgb=recordedRgbProfile(directory,worker,hz);
 return{...rgb,configure(scenario,registry,kit){
  configureTrackingArena(scenario);
  rgb.configure(scenario,registry,kit);
 }};
}
function configureTrackingArena(scenario:import('../../src/contracts.ts').Scenario){
 const theta=scenario.seed%4*Math.PI/2,drone=scenario.robots.find(r=>r.id==='drone')!;
 const heading=theta+(71.6+(scenario.seed%2?14:-14))*Math.PI/180;
 drone.pose.rotation={x:0,y:0,z:Math.sin(heading/2),w:Math.cos(heading/2)};drone.pose.position.z=Math.floor(scenario.seed/2)%2?3.5:1.2;
 scenario.obstacles=scenario.obstacles.filter(b=>['ground','crossing'].includes(b.id));scenario.obstacles.find(b=>b.id==='crossing')!.pose=pose(100,100,1.4);
 scenario.obstacles.push({id:'cover',mode:'kinematic',pose:pose(0,0,-20),shape:{kind:'box',size:vec(1.6,1.6,1.8),color:'#929292'}});
 scenario.obstacles.push({id:'orange-distractor',mode:'fixed',pose:pose(2*Math.cos(theta)-3*Math.sin(theta),2*Math.sin(theta)+3*Math.cos(theta),.65),shape:{kind:'box',size:vec(.5,.5,1.3),color:'#e98b36'}});
}
/** Acquisition only: the experiment owns layout and motion; this module only renders and records sensors. */
export function recordedRgbProfile(directory:string,worker:Pick<VisionWorker,'enqueue'>,hz=5):SensorExperiment{
 mkdirSync(directory,{recursive:true});const track=colorTracker();let index=0;
 return{id:'async-pixel-tracking-v1',sourceSensor:'camera',configure(scenario,registry,kit){
  const drone=scenario.robots.find(r=>r.id==='drone')!;
  drone.sensors=[{id:'camera',type:'tracking-rgb',hz,latencyMs:100,maxAgeMs:500,dropout:.02}];
  registry.sensors.set('tracking-rgb',{id:'tracking-rgb',requires:['bodies'],sample(context){
   const started=performance.now(),orientation={headingDeg:yawDegrees(context.physics.body(context.link).pose.rotation),...kit.inspectCamera(context.robotId)};
   const bodies:BodySpec[]=scenario.obstacles.map(b=>({...b,pose:context.physics.body(b.id).pose}));
   for(const robot of scenario.robots)if(robot.id!==context.robotId)bodies.push({id:`${robot.id}/base`,mode:'kinematic',pose:context.physics.body(`${robot.id}/base`).pose,shape:{kind:'box',size:vec(.55,.55,.18),color:String(robot.config?.color??'#478bff')}});
   const rendered=renderCamera(bodies,[],{position:context.mount.position,...orientation},320,180);
   const illumination=.85+.15*Math.sin(context.simMs/3700);
   for(let i=0;i<rendered.image.data.length;i+=4)for(let c=0;c<3;c++)rendered.image.data[i+c]=Math.max(0,Math.min(255,Math.round(rendered.image.data[i+c]!*illumination+(context.random()*2-1)*2)));
   const measurements=track(rendered.image,rendered.calibration,context.simMs),png=framePng(rendered.image),sha256=createHash('sha256').update(png).digest('hex');
   const name=`camera-${Math.round(context.simMs)}.png`,file=resolve(directory,name);
   const camera={...measurements,headingDeg:orientation.headingDeg+(context.random()*2-1)*.5,pitchDeg:orientation.pitchDeg+(context.random()*2-1)*.25,hfovDeg:orientation.hfovDeg,frame:`frames/${basename(directory)}/${name}`,sha256,calibration:rendered.calibration,image:{width:320,height:180},range:null,renderMs:performance.now()-started};
   writeFileSync(file,png,{flag:'wx'});writeFileSync(file.replace('.png','.json'),JSON.stringify({acquiredMs:context.simMs,sha256,calibration:rendered.calibration,camera}),{flag:'wx'});
   worker.enqueue({id:++index,file,acquiredMs:context.simMs,calibration:rendered.calibration,objects:measurements.objects,camera});return camera as any;
  }});
 }};
}
/** Privileged stimulus only. Neither schedule nor coordinates are exposed through the controller port. */
export function stimulus(world:ReactiveWorld,protocol:Protocol){
 const t=world.world.simMs;if(protocol==='recovery'&&t>=60000&&t<65000){const p=world.world.physics.body('target/base').pose.position;world.world.physics.move('cover',pose(p.x,p.y,p.z+.35));}
 else world.world.physics.move('cover',pose(0,0,-20));
}
