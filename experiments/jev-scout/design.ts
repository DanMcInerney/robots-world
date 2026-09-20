import type {Observation} from '../../src/contracts.ts';
import {pixelAction,SPEEDS,YAW,PITCH,type PixelControlDesign} from '../jev-pixels/controller.ts';
import {choice,MODEL,type Request} from '../jev-strategies/strategies.ts';

export const ARMS={
  'scout-direct':{label:'1 · Direct controls',description:'Current measured regions; Jev chooses all six physical controls, including when following. No camera centring servo or view memory.',memory:false,servo:false},
  'scout-current':{label:'2 · Camera assistance',description:'Same observations; selecting a region authorizes a measured-bearing camera servo and wide FOV. Jev still chooses translation and every search control.',memory:false,servo:true},
  'scout-memory':{label:'3 · Camera assistance + memory',description:'Identical to camera assistance; adds up to 12 acquired views and 24 last-seen regions within 30 seconds. Missing locations remain unknown.',memory:true,servo:true},
} as const;
export type Arm=keyof typeof ARMS;
const axes={forward:SPEEDS,right:SPEEDS,up:SPEEDS,yaw:YAW,pitch:PITCH,zoom:[70,35]};
const names:Record<string,string[]>={forward:['backward','forward'],right:['left','right'],up:['down','up'],yaw:['right','left'],pitch:['down','up']};
const description=(axis:string,n:number)=>axis==='zoom'?`${n} degree horizontal view`:n===0?(axis==='yaw'||axis==='pitch'?'Retain accepted angle':'Zero velocity'): `${Math.abs(n)} ${axis==='yaw'||axis==='pitch'?'degrees':'m/s'} ${names[axis]![n>0?1:0]}`;

/** This design receives delivered measurements only. No chosen route, target label or collision forecast. */
export function scoutDesign(memory:boolean,servo=true):PixelControlDesign {
  let goal='',lastFrame=-1;const views:any[]=[],lastSeen=new Map<string,any>();
  return {
    request(o:Observation,_arm:string,feedback:any[]):Request {
      if(Object.keys(o.sensors).join()!=='camera'||o.inbox.length)throw new Error('Undeclared scout evidence');
      const r=o.sensors.camera!,c=r.value as any;
      if(!r.valid||c.overflow||!['tracked-regions-v1','color-regions-v1'].includes(c.kind)||c.objects.length>24)throw new Error('Invalid camera');
      if(goal!==o.goal){views.length=0;lastSeen.clear();lastFrame=-1;goal=o.goal;}
      const objects=c.objects.map((p:any)=>({id:p.id,appearance:`${p.color} pixel region`,rightDeg:p.rightDeg,upDeg:p.upDeg,widthPercent:p.widthPercent,clipped:p.clipped,
        extent:'visible patch; complete size unknown',possibleOcclusion:p.possibleOcclusion??'not-estimated'}));
      const camera={acquiredMs:r.acquiredSimMs,ageMs:o.simMs-r.acquiredSimMs,headingDeg:c.headingDeg,pitchDeg:c.pitchDeg,hfovDeg:c.hfovDeg};
      if(memory&&lastFrame!==r.acquiredSimMs){
        lastFrame=r.acquiredSimMs;
        for(const p of objects){lastSeen.delete(p.id);lastSeen.set(p.id,{...p,acquiredMs:r.acquiredSimMs,cameraHeadingDeg:c.headingDeg,cameraPitchDeg:c.pitchDeg});}
        if(!views.length||r.acquiredSimMs-views.at(-1).acquiredMs>=1000)views.push({acquiredMs:r.acquiredSimMs,headingDeg:c.headingDeg,pitchDeg:c.pitchDeg,hfovDeg:c.hfovDeg,regions:objects.map((p:any)=>p.id)});
        while(views.length>12||views.length&&r.acquiredSimMs-views[0].acquiredMs>30000)views.shift();
        for(const [id,p]of lastSeen)if(r.acquiredSimMs-p.acquiredMs>30000)lastSeen.delete(id);
        while(lastSeen.size>24)lastSeen.delete(lastSeen.keys().next().value!);
      }
      const state:any={goal:o.goal,camera,objects,range:'unknown',recentToolReceipts:feedback.slice(-2),
        contract:'Questions run in parallel and cannot read sibling answers. Mode selects a conditional branch. Search controls are ALWAYS available, including with no objects. Body forward/right/up are m/s using the acquired heading; positive yaw turns LEFT, positive pitch UP. Nonzero camera increments use acquired angles; zero retains last accepted setpoints. Commands expire after 1 second. Physics and acquisition continue. No autonomous search, path planner or obstacle avoidance exists. Grey regions may be surfaces; missing regions do not establish free space.',
        assistance:servo?'Selecting a current region explicitly authorizes camera centring from that region\'s measured bearing and wide FOV. Jev still chooses all three translation axes. Search uses only Jev\'s six selected controls; no target is silently selected. IDs are fallible associations. Image size is not metric range.':'No camera centring assistance. Jev chooses all six physical controls for search and for each current region. No target is silently selected. IDs are fallible associations. Image size is not metric range.'};
      if(memory)state.memory={views:structuredClone(views),lastSeen:[...lastSeen.values()].filter(p=>!objects.some((a:any)=>a.id===p.id)).map(p=>({...p,ageMs:r.acquiredSimMs-p.acquiredMs,currentLocation:'unknown'})),meaning:'Past acquired images, not a map, current bearings or verified empty coverage. No dead reckoning or prediction.'};
      const questions:Request['questions']={mode:{type:'choice',instructions:'Using the exact goal and measured regions, choose this step: search with the conditional search controls, hold, or follow one currently observed region. Choose search when you need to find or recover the object. Select no region by imagined location.',criteria:{search:'Use all six search controls chosen below',hold:'Zero translation, retain accepted angles',...Object.fromEntries(objects.map((p:any)=>[`track_${p.id}`,`Follow measured region ${p.id}: ${p.appearance}`]))}}};
      const controls=(prefix:string,context:string,follow:boolean)=>{
        for(const [axis,values]of Object.entries(axes)){if(follow&&servo&&['yaw','pitch','zoom'].includes(axis))continue;
          questions[`${prefix}${axis}`]={type:'choice',instructions:`Use the goal and sensor evidence. ${context} Choose ONLY ${axis}. ${follow?(servo?'The declared camera servo will aim at this region; translation remains your choice.':'You choose camera and translation; no centring servo exists.'):'This applies even when no target has ever been observed. Decide whether and how to change viewpoint or camera direction; there is no automatic sweep.'} Do not assume unseen space is clear.`,criteria:Object.fromEntries(values.map((v,i)=>[`v${i}`,description(axis,v)]))};
        }
      };
      controls('search_','Assume mode=search.',false);
      for(const p of objects)controls(`${p.id}_`,`Assume mode=track_${p.id}. The complete current region measurement is ${JSON.stringify(p)}.`,true);
      return{model:MODEL,state,questions};
    },
    map(request,response){
      if(response.model!==MODEL||Object.keys(response.answers).sort().join()!==Object.keys(request.questions).sort().join())throw new Error('Unexpected Jev response');
      const selections=Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,choice(response,id,Object.keys(q.criteria))]));
      const s=request.state as any,mode=selections.mode!,target=mode.startsWith('track_')?s.objects.find((p:any)=>`track_${p.id}`===mode):null;
      const prefix=target?`${target.id}_`:'search_',get=(axis:keyof typeof axes)=>axes[axis][Number(selections[`${prefix}${axis}`]?.slice(1))]!;
      const velocity=mode==='hold'?[0,0,0]:[get('forward'),get('right'),get('up')];
      const assisted=Boolean(target&&servo),yaw=assisted?-target.rightDeg:mode==='hold'?0:get('yaw'),pitch=assisted?target.upDeg:mode==='hold'?0:get('pitch'),hfov=assisted?70:mode==='hold'?s.camera.hfovDeg:get('zoom');
      const action=pixelAction(s.camera,velocity,yaw,pitch,hfov),prior=s.recentToolReceipts.findLast((f:any)=>['accepted','completed'].includes(f.receipt.status));
      if(!assisted&&prior){if(yaw===0)action.heading=prior.heading;if(pitch===0)action.pitch=prior.pitch;}
      return{selections,bodyVelocity:velocity,action,overrides:assisted?['Declared camera servo: bearing of region selected by Jev in this call; wide FOV']:[]};
    },
  };
}
