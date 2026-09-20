import type { Observation } from '../../src/contracts.ts';
import { pixelRequest, pixelAction, SPEEDS, YAW, PITCH, type PixelControlDesign } from '../jev-pixels/controller.ts';
import { loopDesign, names } from '../jev-loop/controller.ts';
import { choice, MODEL, type Request, type Response } from '../jev-strategies/strategies.ts';
import { imageMotion } from '../../src/perception/image-motion.ts';

export type Representation = 'full' | 'compact' | 'direct' | 'factored' | 'binned' | 'conditional';
export const REPRESENTATIONS: Representation[] = ['full','compact','direct','factored','binned','conditional'];
const axes = ['forward','right','up','yaw','pitch'] as const;
const values = { forward:SPEEDS,right:SPEEDS,up:SPEEDS,yaw:YAW,pitch:PITCH };
const signs = { forward:['backward','forward'],right:['left','right'],up:['descend','climb'],yaw:['right','left'],pitch:['down','up'] };
const wrap=(n:number)=>((n+180)%360+360)%360-180;
const round=(n:number)=>Math.round(n*100)/100;
export type Options = { representation:Representation; retain?:boolean; cameraOnly?:boolean; telemetry?:boolean; history?:boolean; memoryMs?:number; confidence?:boolean; hybrid?:'enabled'|'disabled' };

/** Unit viewing direction from measured image bearings and measured camera angles. No position/range. */
export function viewingDirection(right:number,up:number,heading:number,pitch:number) {
  const r=Math.tan(right*Math.PI/180),u=Math.tan(up*Math.PI/180),h=heading*Math.PI/180,p=pitch*Math.PI/180;
  const x=Math.cos(h)*Math.cos(p)+r*Math.sin(h)-u*Math.cos(h)*Math.sin(p);
  const y=Math.sin(h)*Math.cos(p)-r*Math.cos(h)-u*Math.sin(h)*Math.sin(p);
  const z=Math.sin(p)+u*Math.cos(p);
  return {azimuthDeg:round(Math.atan2(y,x)*180/Math.PI),elevationDeg:round(Math.atan2(z,Math.hypot(x,y))*180/Math.PI)};
}
export function compactState(observation:Observation,feedback:any[],retain=false) {
  const r=observation.sensors.camera!,c=r.value as any;
  return {goal:observation.goal,camera:{acquiredMs:r.acquiredSimMs,ageMs:round(observation.simMs-r.acquiredSimMs),headingDeg:round(c.headingDeg),pitchDeg:round(c.pitchDeg),hfovDeg:c.hfovDeg},
    objects:(pixelRequest(observation,'pixels-words',feedback).state as any).objects,
    recentToolReceipts:feedback.slice(-2),range:'unknown',
    contract:`Stabilized drone. Follow the exact goal using measured image regions; IDs are tentative. Image right/up are positive. Heading positive turns LEFT; pitch positive points UP. Body velocities use measured heading. Camera increments are relative to the acquired camera angles. ${retain?'Zero camera increment retains the last accepted setpoint (initially the measured angle).':'Zero camera increment retargets the measured angle.'} Camera and translation can act together. Missing objects and range are unknown. No automatic search or tracking. Decisions replace setpoints with a 1 second lifetime; the world continues during inference.`};
}
const direct: Record<typeof axes[number],string>={
 forward:'Select physical forward/backward velocity to pursue the image-size goal. Forward tends to enlarge a stationary object ahead; backward tends to shrink it. No range is known.',
 right:'Select physical lateral velocity for following. Rightward translation moves a stationary object left in the image; leftward translation moves it right.',
 up:'Select physical vertical velocity for following. Climbing moves a stationary object down in the image; descending moves it up.',
 yaw:'Point the camera toward the intended region horizontally. Choose the physical direction the camera should turn, NOT the direction you want the pixels to move. Left turns the camera left; right turns it right.',
 pitch:'Point the camera toward the intended region vertically. Choose the physical direction the camera should tilt, NOT the direction you want the pixels to move. Up points the camera up; down points it down.',
};
function factored(request:Request,prefix='',context='Use the intended region specified by state.goal.') {
  for(const axis of axes){
    const [negative,positive]=signs[axis],unit=['yaw','pitch'].includes(axis)?'degrees':'metres per second';
    request.questions[`${prefix}${axis}_direction`]={type:'choice',instructions:`${context} ${direct[axis]} Choose only the direction; magnitude is answered separately.`,criteria:{[negative]:`Physical ${negative}`,hold:'Zero adjustment along this axis',[positive]:`Physical ${positive}`}};
    for(const direction of [negative,positive])request.questions[`${prefix}${axis}_${direction}_magnitude`]={type:'choice',instructions:`${context} Assuming a physical ${direction} ${axis} adjustment is selected, choose its magnitude in ${unit}. ${direct[axis]} This answer is unused if another direction is selected.`,criteria:Object.fromEntries([...new Set(values[axis].filter(n=>n>0))].map(n=>[`amount_${String(n).replace('.','p')}`,`${n} ${unit}`]))};
    delete request.questions[`${prefix}${axis}`];
  }
}
export function hypothesisDesign(options:Options):PixelControlDesign {
  const original=loopDesign('loop-semantic'),motion=imageMotion();
  const lastSeen=new Map<string,any>();let previousAngles:any;
  return {
    request(observation,_arm,feedback){
      const r=observation.sensors.camera!,camera=r.value as any;
      let request=original.request(observation,'pixels-words',feedback);
      if(options.representation!=='full')request.state=compactState(observation,feedback,options.retain);
      const state=request.state as any;
      if(options.retain&&options.representation==='full')state.contract=state.contract.replace('Each camera delta is applied once to the delivered angle.','Nonzero camera deltas are relative to the delivered angle; zero retains the last accepted camera setpoint (initially the measured angle).');
      if(['direct','factored','binned','conditional'].includes(options.representation))for(const axis of axes)request.questions[axis]!.instructions=`Use state.goal, state.objects and state.contract. ${direct[axis]} Select only this control; answers to other questions are unavailable.`;
      if(options.representation==='binned')state.objects=state.objects.map((o:any)=>{const r=camera.objects.find((r:any)=>r.id===o.id);return {...o,horizontalZone:r.rightDeg < -3?'left':r.rightDeg>3?'right':'near centre',verticalZone:r.upDeg < -3?'below':r.upDeg>3?'above':'near centre',horizontalOffset:Math.abs(r.rightDeg)<5?'small':Math.abs(r.rightDeg)<15?'medium':'large',verticalOffset:Math.abs(r.upDeg)<5?'small':Math.abs(r.upDeg)<15?'medium':'large'};});
      if(['factored','binned','conditional'].includes(options.representation))factored(request);
      if(options.representation==='conditional'){
        const base=structuredClone(request.questions);request.questions={};
        request.questions.target={type:'choice',instructions:'Which observed region is the object requested by state.goal? Select none if absent or ambiguous.',criteria:{none:'No unambiguous matching region',...Object.fromEntries(camera.objects.map((o:any)=>[o.id,`${o.color} region ${o.id}`]))}};
        for(const id of ['none',...camera.objects.map((o:any)=>o.id)])for(const [key,q] of Object.entries(base))request.questions[`${id}__${key}`]={...q,instructions:`Assume ${id==='none'?'the intended object is not currently visible':`region ${id} is the intended object`}. ${String(q.instructions)}`};
      }
      if(options.telemetry){state.actuatorFeedback=observation.jobs.filter(j=>j.status==='running').map(j=>({status:j.status,startedMs:j.startedSimMs,ageMs:round(observation.simMs-j.startedSimMs),setpoint:j.args}));state.feedbackMeaning='Local actuator job telemetry: accepted setpoint, not achieved velocity or a bare MAVLink acknowledgement. Compare its timestamp with camera acquisition.';}
      if(options.history){
        state.temporal=motion({objects:camera.objects,headingDeg:camera.headingDeg,pitchDeg:camera.pitchDeg,hfovDeg:camera.hfovDeg,acquiredMs:r.acquiredSimMs},observation.simMs);
        state.acquisitionHistory=camera.objects.map((o:any)=>({id:o.id,samples:o.history}));
        if(previousAngles&&r.acquiredSimMs>previousAngles.at&&r.acquiredSimMs-previousAngles.at<=600){state.rotationCompensatedRates=camera.objects.flatMap((o:any)=>{const prior=previousAngles.objects.find((p:any)=>p.id===o.id);if(!prior||prior.clipped||o.clipped)return[];const a=viewingDirection(prior.rightDeg,prior.upDeg,previousAngles.heading,previousAngles.pitch),b=viewingDirection(o.rightDeg,o.upDeg,camera.headingDeg,camera.pitchDeg),dt=(r.acquiredSimMs-previousAngles.at)/1000;return[{id:o.id,azimuthDegPerS:round(wrap(b.azimuthDeg-a.azimuthDeg)/dt),elevationDegPerS:round((b.elevationDeg-a.elevationDeg)/dt)}];});}
        previousAngles={at:r.acquiredSimMs,objects:camera.objects,heading:camera.headingDeg,pitch:camera.pitchDeg};
        state.motionMeaning='Viewing-ray change after measured camera rotation correction. Translation and target motion remain mixed; not world velocity, range or free space. Bounds/clipping and track switches can corrupt rates.';
      }
      if(options.memoryMs){for(const [id,o] of lastSeen)if(observation.simMs-o.seenAt>options.memoryMs)lastSeen.delete(id);for(const o of camera.objects)lastSeen.set(o.id,{...o,seenAt:r.acquiredSimMs,headingAtAcquisition:camera.headingDeg,pitchAtAcquisition:camera.pitchDeg});if(lastSeen.size>24)lastSeen.clear();state.missingRegions=[...lastSeen.values()].filter(o=>!camera.objects.some((c:any)=>c.id===o.id)).map(({history,box,pixels,...o})=>({...o,ageMs:observation.simMs-o.seenAt,currentLocation:'unknown'}));}
      if(options.hybrid){request.questions.target={type:'choice',instructions:'Which currently visible region is requested by state.goal? Choose none if missing or ambiguous.',criteria:{none:'Absent or ambiguous',...Object.fromEntries(camera.objects.map((o:any)=>[o.id,`${o.color} region`]))}};request.questions.behavior={type:'choice',instructions:'Choose the immediate behavior for state.goal from the current observations. Follow authorizes camera aiming at your selected region; search uses your camera adjustments; hold retains camera setpoints.',criteria:{follow:'Authorize aiming at the selected visible region',search:'Use my chosen camera adjustments to search',hold:'Retain camera setpoints'}};state.assistance='A declared experimental camera-servo ablation may use your selected follow region. Always choose the physical controls as if responsible for them; the servo-disabled arm executes those controls. Translation always remains model-selected.';}
      if(options.cameraOnly){for(const key of Object.keys(request.questions))if(/^(forward|right|up)(_|$)/.test(key))delete request.questions[key];state.diagnostic='Camera-only ablation: translation is fixed at zero. Judge centring/visibility, not equal full-task capability.';}
      return request;
    },
    map(request,response){return mapHypothesis(request,response,options);},
  };
}
export function mapHypothesis(request:Request,response:Response,options:Options) {
  if(response.model!==MODEL||Object.keys(request.questions).sort().join()!==Object.keys(response.answers).sort().join())throw new Error('Unexpected response schema/model');
  const selections=Object.fromEntries(Object.entries(request.questions).map(([id,q])=>[id,choice(response,id,Object.keys(q.criteria))]));
  const state=request.state as any,prefix=options.representation==='conditional'?`${selections.target}__`:'';
  const get=(axis:typeof axes[number])=>{
    if(options.cameraOnly&&!['yaw','pitch'].includes(axis))return 0;
    const d=selections[`${prefix}${axis}_direction`];
    if(d){if(d==='hold')return 0;const v=Number(selections[`${prefix}${axis}_${d}_magnitude`]!.replace('amount_','').replace('p','.'));return d===signs[axis][0]?-v:v;}
    const name=selections[`${prefix}${axis}`];const found=values[axis].find(n=>names[axis](n)===name);if(found===undefined)throw new Error(`Bad axis ${axis}`);return found;
  };
  const bodyVelocity=[get('forward'),get('right'),get('up')];let yaw=get('yaw'),pitch=get('pitch');
  const overrides:string[]=[];
  if(options.hybrid==='enabled'){
    const o=state.objects.find((o:any)=>o.id===selections.target);
    if(selections.behavior==='follow'&&o){yaw=-parseFloat(o.horizontal)*(o.horizontal.includes('left')?-1:1);pitch=parseFloat(o.vertical)*(o.vertical.includes('below')?-1:1);overrides.push('Declared visual servo computes yaw/pitch from Jev-selected observed region');}
    else if(selections.behavior==='hold'){yaw=0;pitch=0;overrides.push('Jev hold behavior');}
  }
  if(options.confidence){const used=axes.map(axis=>`${prefix}${axis}_direction`).filter(id=>response.answers[id]);if(used.some(id=>response.answers[id].confidence<.35)){bodyVelocity.fill(0);yaw=0;pitch=0;overrides.push('Declared confidence gate <0.35: zero translation and retain angles');}}
  const action=pixelAction(state.camera,bodyVelocity,yaw,pitch,selections[`${prefix}zoom`]==='wide'?70:35);
  const prior=state.recentToolReceipts?.findLast((r:any)=>['accepted','completed'].includes(r.receipt.status));
  if(options.retain&&prior){if(yaw===0)action.heading=prior.heading;if(pitch===0)action.pitch=prior.pitch;}
  return {selections,bodyVelocity,action,...(overrides.length?{overrides}:{})};
}
