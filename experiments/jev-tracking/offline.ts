import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {renderCamera,framePng} from '../../src/devices/pixel-camera.ts';
import {colorTracker,colorRegions} from '../../src/perception/color-tracks.ts';
import {pose,vec,randomStream} from '../../src/math.ts';
import type {BodySpec} from '../../src/contracts.ts';
const root=resolve(process.argv[2]??'.runtime/experiments/jev-tracking-v1/offline');await mkdir(`${root}/frames`,{recursive:true});
const variants=process.argv.includes('--blur-only')?['blur']:['recession','occlusion','rotation','distractor','lighting','gray'];const sequences:any[]=[];
for(const phase of ['development','held-out'])for(const seed of (phase==='development'?[191,192]:[291,292]))for(const variant of variants){
 const rng=randomStream(seed,variant),track=colorTracker(),frames:any[]=[];const offset=(rng()-.5)*.5;
 for(let i=0;i<60;i++){
  const at=i*200,sec=at/1000,x=variant==='recession'?4+sec*.12:4,y=offset+.3*Math.sin(sec*.45),z=1.6;
  const target:BodySpec={id:'private-target',mode:'fixed',pose:pose(x,y,z),shape:{kind:'box',size:vec(.3,.7,.5),color:variant==='gray'?'#929292':'#407aee'}};
  const bodies:BodySpec[]=[target,{id:'other',mode:'fixed',pose:pose(5,-1,1.6),shape:{kind:'box',size:vec(.4,.5,.6),color:'#df8933'}}];
  if(variant==='distractor')bodies.push({id:'same-color',mode:'fixed',pose:pose(4.5,-y-.6,1.4),shape:{kind:'box',size:vec(.3,.5,.4),color:'#407aee'}});
  const occluding=variant==='occlusion'&&sec>=4&&sec<7;
  if(occluding)bodies.push({id:'private-occluder',mode:'fixed',pose:pose(2,sec<4.8?-.6+(sec-4)*1.1:.1,1.5),shape:{kind:'box',size:vec(.2,1.3,1.2),color:'#888888'}});
  const camera={position:vec(0,0,1.5),headingDeg:variant==='rotation'?14*Math.sin(sec*.55):0,pitchDeg:0,hfovDeg:70};
  const render=renderCamera(bodies,[],camera,320,180),isolated=renderCamera([target],[],camera,320,180);
  if(variant==='blur'){const original=render.image.data.slice();for(let y=0;y<180;y++)for(let x=0;x<320;x++)for(let c=0;c<3;c++){let n=0;for(let dx=-3;dx<=3;dx++)n+=original[(y*320+Math.max(0,Math.min(319,x+dx)))*4+c]!;render.image.data[(y*320+x)*4+c]=Math.round(n/7);}}
  if(variant==='lighting')for(let j=0;j<render.image.data.length;j+=4)for(let c=0;c<3;c++)render.image.data[j+c]=Math.round(render.image.data[j+c]!*(.55+.4*Math.sin(sec*.4)**2));
  const objects=track(render.image,render.calibration,at),truth=variant==='gray'?null:colorRegions(isolated.image,isolated.calibration)[0];
  const file=`frames/${phase}-${seed}-${variant}-${i}.png`,png=framePng(render.image);await writeFile(resolve(root,file),png,{flag:'wx'});
  // Evaluation masks come from an isolated render, never worker input.
  // The target's projected colour box is exact for chromatic fixtures; grayscale labels use image differencing.
  let box=truth?.box; if(!box){const empty=renderCamera([],[],camera,320,180),xs:number[]=[],ys:number[]=[];for(let p=0;p<isolated.image.data.length;p+=4)if(isolated.image.data[p]!==empty.image.data[p]||isolated.image.data[p+1]!==empty.image.data[p+1]||isolated.image.data[p+2]!==empty.image.data[p+2]){xs.push(p/4%320);ys.push(Math.floor(p/4/320));}if(xs.length)box=[Math.min(...xs),Math.min(...ys),Math.max(...xs)+1,Math.max(...ys)+1];}
  const visible=objects.objects.filter(o=>o.color==='blue').sort((a,b)=>Math.abs(a.upDeg)-Math.abs(b.upDeg))[0];
  frames.push({id:i,file,acquiredMs:at,calibration:render.calibration,objects:objects.objects,sha256:createHash('sha256').update(png).digest('hex'),evaluation:{box,fullOcclusion:occluding&&sec>=4.8,visibleWidth:visible?.widthPercent??null},camera:{headingDeg:camera.headingDeg,pitchDeg:0,hfovDeg:70}});
 }
 sequences.push({phase,seed,variant,frames});
}
await writeFile(`${root}/fixtures.json`,JSON.stringify({sequences,note:'Worker inputs exclude evaluation. Fresh held-out fixtures retained with exact PNGs.'},null,2),{flag:'wx'});console.log(JSON.stringify({sequences:sequences.length,frames:sequences.reduce((n,s)=>n+s.frames.length,0)}));
