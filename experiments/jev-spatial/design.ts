import type {Observation} from '../../src/contracts.ts';
import type {ReactiveTask} from '../reactive/world.ts';
import {pixelAction,SPEEDS,YAW,PITCH,type PixelControlDesign} from '../jev-pixels/controller.ts';
import {choice,MODEL,type Request} from '../jev-strategies/strategies.ts';
import {task as priorTask} from '../jev-scout/scenario.ts';

export const MISSION='Find the blue car in this unfamiliar area and follow it as it moves. It may not be visible initially. Choose where to look and move, keep it in view, avoid colliding with surfaces, and find it again after losing sight.';
export const LIMITS='Operating limits: own ENU x and y must stay between -18 and 18 metres; altitude 0.7 to 6 metres. Avoid touching any surface. Following means visible centre within the central 30 percent of both image axes, visible width 8 to 14 percent, and 70-degree wide view. Apparent width is not metric range. The blue car is represented here by a uniquely blue box proxy; semantic car recognition is not established.';
export const SEMANTICS='Controls: body forward/right/up are m/s. Forward/right are converted using the acquired heading to world velocity, held until replaced or expired after 1 second. Heading zero is east, +90 north. Positive yaw turns body and camera LEFT; positive pitch tilts UP. Nonzero yaw/pitch options are degrees added ONCE to acquired angles; zero retains the last accepted absolute setpoint (it does not stop a turn still in progress). Zoom selects 70 or 35 degrees. Stabilization executes selected setpoints only. No automatic search, aiming, following or avoidance exists. Every question is independent; it cannot read sibling answers. All physical controls remain available when target is absent.';
export const task:ReactiveTask={...priorTask,id:'jev-spatial-mission-v1',goal:()=>`${MISSION} ${LIMITS} ${SEMANTICS}`};
export type Options={events?:boolean;explicit?:boolean;views?:boolean;words?:boolean;neutralAxes?:boolean;verbs?:boolean;grid?:boolean;removeBearings?:boolean;joint?:boolean;factored?:boolean;motion?:'raw'|'compensated';wait?:boolean};
const axes={forward:SPEEDS,right:SPEEDS,up:SPEEDS,yaw:YAW,pitch:PITCH,zoom:[70,35]};
const names:Record<string,string[]>={forward:['backward','forward'],right:['left','right'],up:['down','up'],yaw:['right','left'],pitch:['down','up']};
const axisLabels:Record<string,string>={forward:'longitudinal body velocity',right:'lateral body velocity',up:'vertical velocity',yaw:'horizontal camera and body rotation',pitch:'vertical camera rotation',zoom:'horizontal field of view',xy:'pair of longitudinal and lateral body velocities',camera:'pair of horizontal and vertical camera rotations'};
function axisLabel(axis:string){const [base,part]=axis.split('_');return `${axisLabels[base!]}${part==='direction'?' direction':part==='negative'||part==='positive'?` magnitude conditional on the ${part} direction`:''}`;}
function description(axis:string,n:number,verbs=false){
 if(!verbs)return axis==='zoom'?`${n} degrees horizontal field of view`:n===0?(axis==='yaw'||axis==='pitch'?'Retain accepted angle setpoint':'Zero velocity'): `${Math.abs(n)} ${axis==='yaw'||axis==='pitch'?'degrees':'m/s'} ${names[axis]![n>0?1:0]}`;
 if(axis==='zoom')return `Set camera horizontal field of view to ${n} degrees`;
 if(n===0)return axis==='yaw'||axis==='pitch'?`Retain the previously accepted ${axis} angle setpoint; no new increment`:`Set ${axisLabels[axis]} to zero`;
 const direction=names[axis]![n>0?1:0];return axis==='yaw'?`Turn body and camera ${direction} by ${Math.abs(n)} degrees from acquired heading`:axis==='pitch'?`Tilt camera ${direction} by ${Math.abs(n)} degrees from acquired pitch`:`Translate the body ${direction} at ${Math.abs(n)} metres per second`;
}
function directionDescription(axis:string,positive:boolean,verbs=false){const direction=names[axis]![positive?1:0];return verbs?`${axis==='yaw'?'Turn body and camera':axis==='pitch'?'Tilt camera':'Translate the body'} ${direction}; magnitude selected separately`:`${direction} direction; magnitude selected separately`;}
export function imageCell(p:any,c:any){const u=Math.tan(p.rightDeg*Math.PI/180)*c.calibration.fx/c.calibration.cx,v=Math.tan(p.upDeg*Math.PI/180)*c.calibration.fy/c.calibration.cy;return `${v<-.3?'bottom':v>.3?'top':'middle'}-${u<-.3?'left':u>.3?'right':'centre'}`;}

const words=(p:any)=>({id:p.id,appearance:`${p.color} pixel region`,horizontal:`${Math.abs(p.rightDeg)} degrees ${p.rightDeg<0?'left':p.rightDeg>0?'right':'from centre'}`,vertical:`${Math.abs(p.upDeg)} degrees ${p.upDeg<0?'below':p.upDeg>0?'above':'from centre'}`,width:`${p.widthPercent} percent of image width`,clipped:p.clipped,extent:'visible patch; complete size unknown',possibleOcclusion:p.possibleOcclusion??'not-estimated'});
export function spatialDesign(options:Options,onConsumed?:(n:number)=>void):PixelControlDesign {
 if(options.joint&&options.factored)throw new Error('Joint and factored controls are mutually exclusive');
 if(options.removeBearings&&(options.events||options.views||options.motion))throw new Error('Position ablation cannot retain bearing history');
 return {
  request(o:Observation,_arm:string,feedback:any[]):Request{
   if(Object.keys(o.sensors).join()!=='camera'||o.inbox.length)throw new Error('Undeclared spatial evidence');
   const r=o.sensors.camera!,c=r.value as any;
   if(!r.valid||c.overflow||c.objects.length>24)throw new Error('Invalid perception');
   const objects=c.objects.map((p:any)=>options.words?words(p):({id:p.id,appearance:`${p.color} pixel region`,rightDeg:p.rightDeg,upDeg:p.upDeg,widthPercent:p.widthPercent,clipped:p.clipped,extent:'visible patch; complete size unknown',possibleOcclusion:p.possibleOcclusion??'not-estimated'}));
   if(options.removeBearings)objects.forEach((p:any)=>{delete p.rightDeg;delete p.upDeg;delete p.horizontal;delete p.vertical;});
   if(options.grid&&!options.removeBearings)objects.forEach((p:any,i:number)=>p.imageCell=imageCell(c.objects[i],c));
   const state:any={goal:o.goal,camera:{acquiredMs:r.acquiredSimMs,ageMs:o.simMs-r.acquiredSimMs,headingDeg:c.headingDeg,pitchDeg:c.pitchDeg,hfovDeg:c.hfovDeg},self:c.self,objects,space:'Metric range, clearance and geometry are unknown. Grey/neutral regions can be surfaces. Missing regions never certify free space.',recentToolReceipts:feedback.slice(-2),contract:SEMANTICS};
   if(options.words&&c.self?.position){const p=c.self.position;state.self={model:c.self.model,frame:c.self.frame,acquiredMs:c.self.acquiredMs,boundedNoiseM:c.self.boundedNoiseM,eastWest:`${Math.abs(p.x)} metres ${p.x<0?'west':'east'} of origin`,northSouth:`${Math.abs(p.y)} metres ${p.y<0?'south':'north'} of origin`,altitude:`${p.z} metres above origin`,altitudeRelation:p.z<.7?'below minimum 0.7 metres':p.z>6?'above maximum 6 metres':'within allowed altitude 0.7 to 6 metres',horizontalRelation:{eastWest:p.x< -18?'west of minimum x -18':p.x>18?'east of maximum x 18':'within allowed x -18 to 18',northSouth:p.y< -18?'south of minimum y -18':p.y>18?'north of maximum y 18':'within allowed y -18 to 18'},meaning:'Exact acquired coordinates written directionally; limit comparisons computed from these same measurements and the declared envelope. No action recommendation.'};}
   if(options.grid&&!options.removeBearings)state.imageGrid={acquiredMs:r.acquiredSimMs,meaning:'Current visible patch centres only. Centre bands occupy 30 percent of each image dimension. Each empty cell means no reported region, never free space. No metric range.',rows:['top','middle','bottom'].map(row=>['left','centre','right'].map(col=>{const cell=`${row}-${col}`,members=objects.filter((p:any)=>p.imageCell===cell).map((p:any)=>`${p.id} ${p.appearance}`);return `${cell}: ${members.join(', ')||'no reported region; geometry unknown'}`;}).join(' | '))};
   if(options.removeBearings)state.objectPositionEvidence='Explicit current region angular bearings and derived image cells are withheld in this ablation. Remaining attributes, identities, ordering and own pose can still carry indirect spatial cues.';
   if(options.events)state.unreadDetections=c.evidence.events;
   if(options.views)state.inspectedViews=c.evidence.views.map((v:any)=>({...v,ageMs:r.acquiredSimMs-v.acquiredMs}));
   if(options.motion)state.imageMotion=c.evidence.motion.map((m:any)=>({id:m.id,intervalMs:m.intervalMs,horizontalDegPerSec:options.motion==='compensated'?m.compensatedHorizontal:m.rawHorizontal,verticalDegPerSec:options.motion==='compensated'?m.compensatedVertical:m.rawVertical,meaning:options.motion==='compensated'?'Camera rotation removed using acquired orientation; translation and object motion still mixed. No world velocity.':'Raw image bearing change; camera, translation and object motion mixed. No world velocity.'}));
   const questions:Request['questions']={mode:{type:'choice',instructions:'Using the exact mission and measured regions choose search, hold, or follow one currently observed region. This selects a conditional physical-control branch. Search when discovery or recovery is needed; search has no automatic movement.',criteria:{search:'Apply the six physical search controls you choose',hold:'Zero translation, retain accepted camera setpoints',...Object.fromEntries(objects.map((p:any)=>[`track_${p.id}`,`Follow measured region ${p.id}: ${p.appearance}`]))}}};
   const controls=(prefix:string,context:string)=>{
    const add=(axis:string,criteria:Record<string,string>)=>{questions[prefix+axis]={type:'choice',instructions:`Use the mission and sensor evidence. ${context} ${options.neutralAxes?`Choose the ${axisLabel(axis)}.`:`Choose only ${axis}.`} ${options.explicit?SEMANTICS:''}`,criteria};};
    for(const [axis,values]of Object.entries(axes)){
     if(options.joint&&['forward','right','yaw','pitch'].includes(axis))continue;
     if(options.factored&&axis!=='zoom'){
      add(axis+'_direction',{negative:directionDescription(axis,false,options.verbs),zero:description(axis,0,options.verbs),positive:directionDescription(axis,true,options.verbs)});
      for(const sign of ['negative','positive'])add(axis+'_'+sign,Object.fromEntries(values.filter(v=>sign==='negative'?v<0:v>0).map(v=>[`v${values.indexOf(v)}`,`If this axis direction is ${sign}, use ${description(axis,v,options.verbs)}. Ignored otherwise.`])));
     }else add(axis,Object.fromEntries(values.map((v,i)=>[`v${i}`,description(axis,v,options.verbs)])));
    }
    if(options.joint)for(const [name,a,b]of [['xy','forward','right'],['camera','yaw','pitch']] as const)add(name,Object.fromEntries(axes[a].flatMap((x,i)=>axes[b].map((y,j)=>[`v${i}_${j}`,`${description(a,x,options.verbs)}; ${description(b,y,options.verbs)}`]))));
   };
   controls('search_','Assume search is selected. You choose how to look or change viewpoint even if no target has ever been detected.');
   for(const p of objects)controls(`${p.id}_`,`Assume following region ${p.id} is selected. Its current measurement: ${JSON.stringify(p)}.`);
   onConsumed?.(c.evidence.events.throughId);
   return {model:MODEL,state,questions};
  },
  map(request,response){
   if(response.model!==MODEL||Object.keys(response.answers).sort().join()!==Object.keys(request.questions).sort().join())throw new Error('Unexpected Jev model/schema');
   const selections=Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,choice(response,id,Object.keys(q.criteria))]));
   const s=request.state as any,mode=selections.mode!,prefix=mode.startsWith('track_')?`${mode.slice(6)}_`:'search_';
   const get=(axis:keyof typeof axes)=>{
    if(options.factored&&axis!=='zoom'){const direction=selections[prefix+axis+'_direction'];return direction==='zero'?0:axes[axis][Number(selections[prefix+axis+'_'+direction]!.slice(1))]!;}
    if(options.joint&&['forward','right','yaw','pitch'].includes(axis)){const pair=selections[prefix+(['forward','right'].includes(axis)?'xy':'camera')]!.slice(1).split('_').map(Number);return axes[axis][pair[['right','pitch'].includes(axis)?1:0]!]!;}
    return axes[axis][Number(selections[prefix+axis]!.slice(1))]!;
   };
   const velocity=mode==='hold'?[0,0,0]:[get('forward'),get('right'),get('up')],yaw=mode==='hold'?0:get('yaw'),pitch=mode==='hold'?0:get('pitch');
   const action=pixelAction(s.camera,velocity,yaw,pitch,mode==='hold'?s.camera.hfovDeg:get('zoom'));
   const prior=s.recentToolReceipts.findLast((f:any)=>['accepted','completed'].includes(f.receipt.status));
   if(prior){if(yaw===0)action.heading=prior.heading;if(pitch===0)action.pitch=prior.pitch;}
   return{selections,bodyVelocity:velocity,action,overrides:[]};
  }
 };
}
