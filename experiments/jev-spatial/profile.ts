import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {renderCamera,framePng} from '../../src/devices/pixel-camera.ts';
import {colorTracker} from '../../src/perception/color-tracks.ts';
import {yawDegrees} from '../../src/devices/aim-camera.ts';
import {vec} from '../../src/math.ts';
import type {BodySpec} from '../../src/contracts.ts';
import type {SensorExperiment} from '../reactive/world.ts';
import type {VisionWorker} from '../jev-tracking/worker.ts';
export function spatialProfile(directory:string,worker:Pick<VisionWorker,'enqueue'>,hz=5):SensorExperiment{
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
   const self={model:"simulated onboard local-position estimate",frame:"ENU",acquiredMs:context.simMs,position:{x:context.mount.position.x+(context.random()*2-1)*.08,y:context.mount.position.y+(context.random()*2-1)*.08,z:context.mount.position.z+(context.random()*2-1)*.08},boundedNoiseM:.08}; const camera={...measurements,self,headingDeg:orientation.headingDeg+(context.random()*2-1)*.5,pitchDeg:orientation.pitchDeg+(context.random()*2-1)*.25,hfovDeg:orientation.hfovDeg,frame:`frames/${basename(directory)}/${name}`,sha256,calibration:rendered.calibration,image:{width:320,height:180},range:null,renderMs:performance.now()-started};
   writeFileSync(file,png,{flag:'wx'});writeFileSync(file.replace('.png','.json'),JSON.stringify({acquiredMs:context.simMs,sha256,calibration:rendered.calibration,camera}),{flag:'wx'});
   worker.enqueue({id:++index,file,acquiredMs:context.simMs,calibration:rendered.calibration,objects:measurements.objects,camera});return camera as any;
  }});
 }};
}
