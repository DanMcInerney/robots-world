import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ReactiveWorld } from '../reactive/world.ts';
import { DEFAULT_CONFIG,experimentConfig } from '../reactive/config.ts';
import { pixelProfile,PIXEL_TASK } from '../jev-pixels/profile.ts';
import { yawDegrees,wrapDegrees } from '../../src/devices/aim-camera.ts';
import { pixelAction } from '../jev-pixels/controller.ts';
import { renderCamera,framePng } from '../../src/devices/pixel-camera.ts';
import { colorTracker } from '../../src/perception/color-tracks.ts';
import { imageMotion } from '../../src/perception/image-motion.ts';
import { pose,vec } from '../../src/math.ts';
import { viewingDirection } from './design.ts';

const directory=resolve(process.argv[2]??'.runtime/experiments/jev-hypotheses-v1/offline');await mkdir(directory,{recursive:true});
const mechanics:any[]=[];
for(const axis of ['yaw','pitch'])for(const sign of [-1,1])for(const retain of [false,true]){
  const events:any[]=[],config=experimentConfig({...DEFAULT_CONFIG,sensors:{...DEFAULT_CONFIG.sensors,cooperativeBeacon:false}});
  const world=await ReactiveWorld.create(91,(kind,data)=>{if(kind==='reactive.camera.command')events.push(data);},30000,config,pixelProfile(),PIXEL_TASK);
  try{
    const port=world.controllerPort(),o=await port.observe(),c=o.sensors.camera!.value as any;
    const angle=()=>axis==='yaw'?yawDegrees(world.world.physics.body('drone/base').pose.rotation):(world.trajectory.at(-1) as any).pitch;
    const initial=angle(),turn=pixelAction(c,[0,0,0],axis==='yaw'?sign*30:0,axis==='pitch'?sign*10:0,70);
    const send=async(id:string,action:typeof turn)=>{const {duration,...args}=action;return port.command({id,action:'control',args,validForMs:duration*1000,basedOn:{observation:o.sequence,maxAgeMs:1000}});};
    assert.equal((await send('turn',turn)).status,'accepted');for(let i=0;i<20;i++)await world.tick();
    const beforeZero=angle(),zero=pixelAction(c,[0,0,0],0,0,70);if(retain){zero.heading=turn.heading;zero.pitch=turn.pitch;}
    const receipt=await send('zero',zero);assert.equal(receipt.status,'accepted');assert.equal((await send('zero',zero)).status,'duplicate');
    for(let i=0;i<25;i++)await world.tick();
    const afterZero=angle(),delta=wrapDegrees(afterZero-beforeZero);
    assert(Math.abs(wrapDegrees(beforeZero-initial))>5);if(retain)assert(sign*delta>-.5);else assert(sign*delta< -4);
    mechanics.push({axis,sign,retain,initial,beforeZero,afterZero,delta,duplicate:'deduplicated',appliedPackets:events.length,events});
  }finally{await world.close();}
}
await mkdir(`${directory}/vision`,{recursive:true});
const sequences:any[]=[];
for(const variant of ['blue','gray','dark','occlusion','zoom']){
  const track=colorTracker(),delivered=imageMotion(),frames:any[]=[];
  for(let i=0;i<12;i++){
    const heading=-11+2*i,pitch=0,hfov=variant==='zoom'&&i>=6?35:70;
    const bodies:any[]=[{id:'unexposed',mode:'fixed',pose:pose(4,.3,1.6),shape:{kind:'box',size:vec(.4,.9,.8),color:variant==='gray'?'#999999':variant==='dark'?'#303030':'#407aee'}}];
    if(variant==='occlusion'&&i>=4&&i<=6)bodies.push({id:'screen',mode:'fixed',pose:pose(2,.15,1.5),shape:{kind:'box',size:vec(.3,2,2),color:'#777777'}});
    const rendered=renderCamera(bodies,[],{position:vec(0,0,1.5),headingDeg:heading,pitchDeg:pitch,hfovDeg:hfov},320,180),at=i*200;
    const measured=track(rendered.image,rendered.calibration,at),primary=measured.objects[0];
    const summary=i%3===0?delivered({objects:measured.objects,headingDeg:heading,pitchDeg:pitch,hfovDeg:hfov,acquiredMs:at},at+100):null;
    const name=`${variant}-${i}.png`;await writeFile(`${directory}/vision/${name}`,framePng(rendered.image),{flag:'wx'});
    frames.push({file:name,acquiredMs:at,heading,pitch,hfov,calibration:rendered.calibration,objects:measured.objects,deliveredSummary:summary,compensated:primary?viewingDirection(primary.rightDeg,primary.upDeg,heading,pitch):null});
  }
  const visible=frames.filter(f=>f.objects.length),span=(key:string)=>Math.max(...visible.map(f=>f.compensated[key]))-Math.min(...visible.map(f=>f.compensated[key]));
  sequences.push({variant,frames,colourDetections:visible.length,rawHorizontalSpan:visible.length?Math.max(...visible.map(f=>f.objects[0].rightDeg))-Math.min(...visible.map(f=>f.objects[0].rightDeg)):null,compensatedAzimuthSpan:visible.length?span('azimuthDeg'):null,acquiredHistorySamples:frames.reduce((n,f)=>n+(f.objects[0]?.history.length??0),0),consumedRateFrames:frames.filter(f=>f.deliveredSummary&&Object.values(f.deliveredSummary.imageRates).some((v:any)=>v.rightDegPerS!==undefined)).length});
}
const blue=sequences[0];assert(blue.rawHorizontalSpan>15);assert(blue.compensatedAzimuthSpan<2);assert.equal(sequences[1].colourDetections,0);assert.equal(sequences[2].colourDetections,0);
await writeFile(`${directory}/report.json`,JSON.stringify({mechanics,sequences,passed:true,note:'Mechanical pulses and renderer truth are evaluation fixtures, not mission policies. Perception consumes pixels/calibration and measured camera orientation only. No inference.'},null,2),{flag:'wx'});
console.log(JSON.stringify({mechanicalCases:mechanics.length,perceptionSequences:sequences.length,passed:true}));
