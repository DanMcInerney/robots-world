import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import type { BodySpec, Observation } from '../../src/contracts.ts';
import { pose,vec,randomStream } from '../../src/math.ts';
import { renderCamera,framePng } from '../../src/devices/pixel-camera.ts';
import { colorTracker } from '../../src/perception/color-tracks.ts';

export function imageCase(index:number,phase:'development'|'held-out') {
  const rng=randomStream(index+(phase==='development'?91:1701),'hypothesis-static'),sx=index%2?-1:1,sy=Math.floor(index/2)%2?-1:1;
  const goalColor=Math.floor(index/4)%2?'orange':'blue',x=3.5+rng()*2,y=sx*(.6+rng()*.7),z=sy*(.35+rng()*.45),size=.3+rng()*.35;
  const body=(id:string,x:number,y:number,z:number,size:number,color:string):BodySpec=>({id,mode:'fixed',pose:pose(x,y,z),shape:{kind:'box',size:vec(.15,size,size),color}});
  const bodies=[body('not-exposed-target',x,y,1.5+z,size,goalColor==='blue'?'#407aee':'#e98c35'),body('distractor',x+.2,-y,1.5-z,.4,'#cf42ce'),body('other-colour',x+1,-y*.4,1.5+z,.25,goalColor==='blue'?'#e98c35':'#407aee')];
  const frame=renderCamera(bodies,[],{position:vec(0,0,1.5),headingDeg:0,pitchDeg:0,hfovDeg:70},320,180),tracker=colorTracker();
  const perception=tracker(frame.image,frame.calibration,200),png=framePng(frame.image),id=`${phase}-${index}`;
  const observation:Observation={epoch:'static-rendered-fixture',robotId:'drone',sequence:index+1,simMs:300,wallMs:0,
    goal:`Find the ${goalColor} object. Keep its centre in the central 30 percent of the image horizontally and vertically, and its visible width between 8 and 14 percent of image width. Use the wide 70-degree camera view.`,
    sensors:{camera:{sequence:1,acquiredSimMs:200,receivedSimMs:300,valid:true,value:{kind:'color-regions-v1',...perception,headingDeg:0,pitchDeg:0,hfovDeg:70,frame:`frames/${id}.png`,calibration:frame.calibration,range:null}}},jobs:[],inbox:[],events:[]};
  const target=perception.objects.find(o=>o.color===goalColor);if(!target)throw new Error('Fixture target is not detected');
  return {id,phase,index,observation,png,calibration:frame.calibration,sha256:createHash('sha256').update(png).digest('hex'),evaluation:{goalColor,targetId:target.id,rightDeg:target.rightDeg,upDeg:target.upDeg,widthPercent:target.widthPercent}};
}
export async function saveImageCases(directory:string) {
  await mkdir(`${directory}/frames`,{recursive:true});const rows=[];
  for(const phase of ['development','held-out'] as const)for(let i=0;i<(phase==='development'?8:16);i++){
    const {png,...row}=imageCase(i,phase);await writeFile(`${directory}/frames/${row.id}.png`,png,{flag:'wx'});rows.push(row);
  }
  await writeFile(`${directory}/cases.json`,JSON.stringify(rows,null,2),{flag:'wx'});return rows;
}
