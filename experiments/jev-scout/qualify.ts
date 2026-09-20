import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ReactiveWorld} from '../reactive/world.ts';
import {DEFAULT_CONFIG,experimentConfig} from '../reactive/config.ts';
import {recordedRgbProfile} from '../jev-tracking/profile.ts';
import {renderCamera,framePng} from '../../src/devices/pixel-camera.ts';
import {colorTracker} from '../../src/perception/color-tracks.ts';
import {yawDegrees} from '../../src/devices/aim-camera.ts';
import {pose,vec} from '../../src/math.ts';
import {CASES,layout,scoutEnvironment,insideObstacle,task} from './scenario.ts';

const root=resolve(process.argv[2]??'.runtime/experiments/jev-scout-qualification-v1');
await mkdir(root); // Never overwrite evidence.
const rows:any[]=[];
for(const seed of [2101,2102])for(const kind of CASES){
  const id=`${kind}-${seed}`,spec=layout(seed,kind),dir=resolve(root,'frames',id),frames:any[]=[];
  // Scripted fixed observer is a counterfactual/fixture check, never a policy competitor.
  const profile=recordedRgbProfile(dir,{enqueue:f=>{frames.push({acquiredMs:f.acquiredMs,camera:f.camera});}},5);
  const config=experimentConfig({...DEFAULT_CONFIG,sensors:{...DEFAULT_CONFIG.sensors,cooperativeBeacon:false}});
  const world=await ReactiveWorld.create(seed,()=>{},1e12,config,profile,task,scoutEnvironment(seed,kind));
  try{
    const port=world.controllerPort();let initial=await port.observe();
    while(!initial.sensors.camera?.valid&&world.world.simMs<2000){await port.acknowledge(initial.events.at(-1)?.id??0);await world.tick();initial=await port.observe();}
    assert(initial.sensors.camera?.valid,'No initial delivered valid image within 2 seconds');
    assert(!(initial.sensors.camera.value as any).objects.some((o:any)=>o.color==='blue'),'Target visible in first delivered observation');
    let pathClear=true,prior=world.world.physics.body('target/base').pose.position;
    while(world.world.simMs<120000){
      await world.tick();const p=world.world.physics.body('target/base').pose.position;
      assert(Math.hypot(p.x-prior.x,p.y-prior.y,p.z-prior.z)<=.6*.02+1e-4,'Target teleport/speed violation');prior=p;
      if(spec.obstacles.some(b=>insideObstacle(p,b,.39)))pathClear=false;
      if(Math.round(world.world.simMs)%200===0){const o=await port.observe();await port.acknowledge(o.events.at(-1)?.id??0,o.inbox.map(p=>p.id));}
    }
    assert(pathClear,'Target corridor touches an obstacle');
    const evaluation=world.evaluate(),visible=frames.filter(f=>f.camera.objects.some((o:any)=>o.color==='blue'));
    if(kind!=='occlusion-course')assert.equal(visible.length,0,'Waiting revealed target in a requires-search fixture');
    const target={id:'target/base',mode:'kinematic' as const,pose:pose(spec.route[0]!.x,spec.route[0]!.y,.5),shape:{kind:'box' as const,size:vec(.55,.55,.18),color:'#478bff'}};
    const imageAt=(position:any,headingDeg:number,pitchDeg:number)=>{const rendered=renderCamera([...spec.obstacles,target],[],{position,headingDeg,pitchDeg,hfovDeg:70},320,180);return{...rendered,regions:colorTracker()(rendered.image,rendered.calibration,0).objects};};
    const turn=seed%4*90,scan=imageAt(spec.drone.position,turn+90,-10),w=spec.point(-6,2,2),d=vec(target.pose.position.x-w.x,target.pose.position.y-w.y,target.pose.position.z-w.z);
    // Privileged offline reachability witness, not a sensor-only navigation policy or Jev success.
    const witness=imageAt(w,Math.atan2(d.y,d.x)*180/Math.PI,Math.atan2(d.z,Math.hypot(d.x,d.y))*180/Math.PI);
    assert(witness.regions.some(o=>o.color==='blue'),'No visible target at witness viewpoint');
    if(kind==='turn-to-find')assert(scan.regions.some(o=>o.color==='blue'),'Scan cannot find target');
    else assert(!scan.regions.some(o=>o.color==='blue'),'Wall fixture solvable by rotation at spawn');
    const vertices=[spec.point(0,-6,2),spec.point(-6,-6,2),spec.point(-6,2,2)];
    for(let i=1;i<vertices.length;i++)for(let j=0;j<=100;j++){const a=vertices[i-1]!,b=vertices[i]!,p=vec(a.x+(b.x-a.x)*j/100,a.y+(b.y-a.y)*j/100,2);assert(!spec.obstacles.some(o=>insideObstacle(p,o,.4)),'Witness path blocked');}
    const witnessFile=`${id}-witness.png`;await writeFile(resolve(root,witnessFile),framePng(witness.image));
    const initialFrame=frames.find(f=>f.acquiredMs===initial.sensors.camera!.acquiredSimMs)!;
    const row={id,kind,seed,pathClear,seconds:120,firstDeliveredMs:initial.sensors.camera.acquiredSimMs,initialTargetVisible:false,holdVisibleFrames:visible.length,acquiredFrames:frames.length,
      targetTrajectoryHash:createHash('sha256').update(JSON.stringify(evaluation.trajectory.map((f:any)=>f.target))).digest('hex'),
      witness:{file:witnessFile,position:w,clearancePaddingM:.4,note:'Privileged geometric feasibility only. No flight or sensor-only route finder qualified.'},initialFrame:initialFrame.camera.frame,
      manifest:{scenario:world.world.scenario},evaluation,frames};
    await writeFile(resolve(root,`${id}.json`),JSON.stringify(row));rows.push({...row,evaluation:undefined,frames:undefined,manifest:undefined,file:`${id}.json`});
    console.log(JSON.stringify({id,frames:frames.length,holdVisible:visible.length,pathClear}));
  }finally{await world.close();}
}
await writeFile(resolve(root,'qualification.json'),JSON.stringify({status:'mechanics-only; no Jev inference',rows},null,2));
await copyFile('experiments/jev-scout/preview.html',resolve(root,'index.html'));
console.log('No Jev calls. Saved fixture qualification and spectator preview.');
