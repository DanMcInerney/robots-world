import { setTimeout as sleep } from 'node:timers/promises';
import type { Controller, RobotPort } from '../../src/contracts.ts';
import type { Emit } from '../reactive/world.ts';
import { pixelController } from '../jev-pixels/controller.ts';
import { pixelProfile } from '../jev-pixels/profile.ts';
import { hypothesisDesign, type Options } from './design.ts';

export const FLIGHTS:Record<string,{label:string;description:string;options:Options;wait?:boolean}>={
 'camera-original':{label:'A · Camera / dated zero',description:'Camera-only diagnostic, original wording and acquired-angle zero.',options:{representation:'full',cameraOnly:true}},
 'camera-retain':{label:'B · Camera / retained zero',description:'A with zero retaining the last accepted camera setpoint.',options:{representation:'full',cameraOnly:true,retain:true}},
 'camera-telemetry':{label:'C · Camera / job feedback',description:'B plus own actuator job telemetry in the model state.',options:{representation:'full',cameraOnly:true,retain:true,telemetry:true}},
 'camera-wait':{label:'D · Camera / post-action image',description:'C with bounded wait for a camera image acquired after observed matching actuator job.',options:{representation:'full',cameraOnly:true,retain:true,telemetry:true},wait:true},
 'camera-factored':{label:'E · Camera / factored',description:'D with compact, direct direction + conditional magnitude questions. Static tests separate these prompt factors.',options:{representation:'factored',cameraOnly:true,retain:true,telemetry:true},wait:true},
 'full-factored':{label:'F · All controls',description:'E with all translation axes enabled. Same complete physical control values.',options:{representation:'factored',retain:true,telemetry:true},wait:true},
 'full-history':{label:'G · All / measured history',description:'F plus acquired-frame history, camera-rotation-corrected viewing rates and two-second missing-track memory.',options:{representation:'factored',retain:true,telemetry:true,history:true,memoryMs:2000},wait:true},
 'full-memory':{label:'H · All / longer memory',description:'G with eight-second bounded historical missing-track records; current locations remain unknown.',options:{representation:'factored',retain:true,telemetry:true,history:true,memoryMs:8000},wait:true},
 'confidence':{label:'I · Confidence assistance',description:'G with explicit .35 direction-confidence override to zero velocity and retain camera setpoints.',options:{representation:'factored',retain:true,telemetry:true,history:true,memoryMs:2000,confidence:true},wait:true},
 'hybrid-disabled':{label:'J · Servo disabled',description:'G plus target and behavior questions; camera still follows Jev physical choices.',options:{representation:'factored',retain:true,telemetry:true,history:true,memoryMs:2000,hybrid:'disabled'},wait:true},
 'hybrid':{label:'K · Explicit visual-servo hybrid',description:'Same questions as J; model-selected follow authorizes camera corrections calculated from its selected measured region. Translation remains Jev-selected.',options:{representation:'factored',retain:true,telemetry:true,history:true,memoryMs:2000,hybrid:'enabled'},wait:true},
};
export function matchingSetpoint(args:Record<string,any>,expected:Record<string,any>){return ['x','y','z','heading','pitch','hfov'].every(k=>typeof args[k]==='number'&&typeof expected[k]==='number'&&Math.abs(args[k]-expected[k])<1e-4);}
/** Uses only the robot's existing local job telemetry; never an evaluator callback. */
export function waitForFeedback(port:RobotPort,signal:AbortSignal,emit:Emit):RobotPort {
  let last:{args:Record<string,any>;admittedMs:number;goal:string}|undefined;
  return {...port,
    command:async c=>{const receipt=await port.command(c);if(receipt.status==='accepted'){const o=await port.observe();last={args:c.args,admittedMs:o.simMs,goal:o.goal};}return receipt;},
    observe:async()=>{
      let firstMatched:number|undefined,started:number|undefined;
      for(;;){
        signal.throwIfAborted();const o=await port.observe();started??=o.simMs;
        if(!last)return o;
        for(const j of o.jobs)if(j.status==='running'&&j.startedSimMs>=last.admittedMs&&matchingSetpoint(j.args,last.args))firstMatched=Math.min(firstMatched??Infinity,j.startedSimMs);
        const ready=firstMatched!==undefined&&o.sensors.camera!.valid&&o.sensors.camera!.acquiredSimMs>firstMatched;
        const timeout=o.simMs-started>=1200,goalChanged=o.goal!==last.goal;
        if(ready||timeout||goalChanged){emit('hypothesis.wait',{simMs:o.simMs,waitedMs:o.simMs-started,firstObservedMatchingApplicationMs:firstMatched??null,imageAcquiredMs:o.sensors.camera!.acquiredSimMs,ready,timeout,goalChanged});return o;}
        await port.acknowledge(o.events.at(-1)?.id??0,o.inbox.map(p=>p.id));await sleep(20,undefined,{signal});
      }
    },
  };
}
export function flightController(arm:string,key:string,emit:Emit){
  const definition=FLIGHTS[arm];if(!definition)throw new Error('Unknown flight arm');
  const base=pixelController(arm,key,emit,undefined,hypothesisDesign(definition.options));
  const controller:Controller={id:arm,run:(ports,signal)=>base.controller.run(definition.wait?ports.map(p=>waitForFeedback(p,signal,emit)):ports,signal)};
  return {controller,stats:base.stats};
}
export function flightProfile(directory?:string){const base=pixelProfile(directory);return {...base,configure(...args:Parameters<typeof base.configure>){base.configure(...args);const [scenario]=args;if(scenario.seed%2===0){const drone=scenario.robots.find(r=>r.id==='drone')!,heading=scenario.seed%4*Math.PI/2+Math.PI/2;drone.pose.rotation={x:0,y:0,z:Math.sin(heading/2),w:Math.cos(heading/2)};drone.pose.position.z=1.5;}}};}
