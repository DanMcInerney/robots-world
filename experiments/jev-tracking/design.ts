import type {Observation} from '../../src/contracts.ts';
import {hypothesisDesign} from '../jev-hypotheses/design.ts';
import {pixelAction,type PixelControlDesign} from '../jev-pixels/controller.ts';
import {choice,MODEL,type Request,type Response} from '../jev-strategies/strategies.ts';

/** A retained target ID is always chosen by Jev, never by evaluator labels or colour matching in code. */
export function trackingDesign(servo:boolean,bound=true):PixelControlDesign{
 const base=hypothesisDesign({representation:'factored',retain:true,telemetry:true});let active:string|null=null,goal='';
 return{
  request(observation:Observation,arm:string,feedback:any[]){
   if(goal!==observation.goal){active=null;goal=observation.goal;}
   const compatible=structuredClone(observation),c=observation.sensors.camera!.value as any;
   if(!['tracked-regions-v1','color-regions-v1'].includes(c.kind))throw new Error('Unexpected perception format');
   (compatible.sensors.camera!.value as any).kind='color-regions-v1';
   const request=base.request(compatible,arm,feedback),state=request.state as any;
   state.objects=state.objects.map((o:any)=>{const measured=c.objects.find((r:any)=>r.id===o.id);return{...o,measurement:'observed',extentQuality:measured.extentQuality??'visible-extent-only',possibleOcclusion:measured.possibleOcclusion??'not-estimated',tracking:measured.tracking??null,history:measured.history};});
   state.lostTracks=c.lostTracks??[];
   state.activeTrack=active?state.objects.find((o:any)=>o.id===active)??{id:active,measurement:'lost',currentLocation:'unknown',lastSeen:state.lostTracks.find((o:any)=>o.id===active)??null}:null;
   state.assistance='Target binding is a Jev selection. On follow, an explicitly labelled ablation may compute camera angles from the active observed region; disabled arms execute your physical camera choices. Translation always uses your physical choices. No automatic search, obstacle avoidance or target re-selection.';
   state.extentMeaning='Width is the visible patch only, not range or complete object size. Possible occlusion and tracking scores are fallible pixel heuristics. A predicted/lost region is not currently observed. History may include camera motion. No unobserved space is certified clear.';
   state.stage=bound&&!active?'select-target':'control';
   const targetQuestion={type:'choice' as const,instructions:'Using state.goal and the current observed state.objects, which region should become the active target? Choose none if absent or ambiguous. This answer binds an ID; it does not navigate.',criteria:{none:'No unambiguous matching current region',...Object.fromEntries(c.objects.map((o:any)=>[o.id,`${o.color} observed region ${o.id}`]))}};
   if(state.stage==='select-target'){request.questions={target:targetQuestion};state.bindingMeaning='This selection step retains accepted camera setpoints and uses zero translation. The next observation supplies control evidence.';}
   else if(bound){
    for(const q of Object.values(request.questions))q.instructions=`Control only state.activeTrack. If it is lost, its current bearing is unknown. ${String(q.instructions).replaceAll('the intended region specified by state.goal','state.activeTrack')}`;
    request.questions.behavior={type:'choice',instructions:'Choose the immediate operation for state.goal. Follow uses your controls with the active target; search uses your controls to look for it; reselect binds a new target from the parallel target answer and holds motion for this step; hold retains camera setpoints and stops translation.',criteria:{follow:'Follow the active target with chosen controls',search:'Search using chosen physical controls',reselect:'Bind a different target and hold this step',hold:'Stop translation and retain accepted camera setpoints'}};
    request.questions.target={...targetQuestion,instructions:`Assuming reselect is chosen, ${targetQuestion.instructions}`};
   }
   return request;
  },
  map(request:Request,response:Response){
   if(response.model!==MODEL||Object.keys(response.answers).sort().join()!==Object.keys(request.questions).sort().join())throw new Error('Unexpected Jev response schema/model');
   const s=request.state as any,selected=Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,choice(response,id,Object.keys(q.criteria))]));
   if(s.stage==='select-target'||selected.behavior==='reselect'||selected.behavior==='hold'){
    if(selected.target&&(s.stage==='select-target'||selected.behavior==='reselect'))active=selected.target==='none'?null:selected.target;
    const action=pixelAction(s.camera,[0,0,0],0,0,s.camera.hfovDeg),prior=s.recentToolReceipts?.findLast((r:any)=>['accepted','completed'].includes(r.receipt.status));
    if(prior){action.heading=prior.heading;action.pitch=prior.pitch;}
    return{selections:selected,bodyVelocity:[0,0,0],action,overrides:[s.stage==='select-target'?'Declared target-binding step: retain angles, zero translation':`Jev selected ${selected.behavior}`]};
   }
   const controls=structuredClone(request),answer=structuredClone(response);delete controls.questions.behavior;delete controls.questions.target;delete answer.answers.behavior;delete answer.answers.target;
   const mapped=base.map(controls,answer);mapped.selections=selected;
   if(servo&&selected.behavior==='follow'&&s.activeTrack?.measurement==='observed'){
    const o=s.activeTrack,yaw=-parseFloat(o.horizontal)*(o.horizontal.includes('left')?-1:1),pitch=parseFloat(o.vertical)*(o.vertical.includes('below')?-1:1);
    mapped.action=pixelAction(s.camera,mapped.bodyVelocity,yaw,pitch,selected.zoom==='wide'?70:35);
    return{...mapped,overrides:['Declared camera servo: measured bearing of Jev-bound active region']};
   }
   return mapped;
  },
 };
}
