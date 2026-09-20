import type {BodySpec, Scenario} from '../../src/contracts.ts';
import {pose,vec,randomStream} from '../../src/math.ts';
import type {ReactiveEnvironment} from '../reactive/world.ts';
import {layout as baseLayout,scoutEnvironment,type ScoutCase} from '../jev-scout/scenario.ts';
export const FIXTURES=['scout-v1','screen-return-v1','offset-piers-v1'] as const;
export type Fixture=typeof FIXTURES[number];
export function spatialLayout(seed:number,kind:ScoutCase,fixture:Fixture='scout-v1'){
 const spec=baseLayout(seed,kind);if(fixture==='scout-v1')return spec;
 if(fixture==='screen-return-v1'&&kind!=='behind-wall'||fixture==='offset-piers-v1'&&kind!=='occlusion-course')throw new Error('Fixture/case mismatch');
 const box=(id:string,x:number,y:number,z:number,sx:number,sy:number,sz:number):BodySpec=>({id,mode:'fixed',pose:spec.placed(x,y,z),shape:{kind:'box',size:vec(sx,sy,sz),color:'#929292'}});
 spec.obstacles=spec.obstacles.filter(b=>b.id!=='screen');
 if(fixture==='screen-return-v1')spec.obstacles.push(box('screen',0,0,3.5,6,.6,7),box('screen-return',3,2,3.5,.6,4,7));
 else{spec.obstacles.push(box('screen',0,0,3.5,3,.8,7),box('offset-pier',3,2,3.5,.8,4,7));spec.route=[[0,3],[-5,3],[-5,-3],[5,-3],[5,5],[0,5]].map(([x,y])=>spec.point(x!,y!,.5));}
 return spec;
}
/** Environment-only target; never exported to a controller or perception state. */
export function spatialEnvironment(seed:number,kind:ScoutCase,fixture:Fixture='scout-v1'):ReactiveEnvironment{
 if(fixture==='scout-v1')return scoutEnvironment(seed,kind);
 const spec=spatialLayout(seed,kind,fixture),rng=randomStream(seed,'scout-motion');let index=1,sequence=0,pauseUntil=0;
 return{configure(s:Scenario){s.id=`spatial-${fixture}-${kind}`;s.obstacles=structuredClone(spec.obstacles);s.robots.find(r=>r.id==='drone')!.pose=structuredClone(spec.drone);const target=s.robots.find(r=>r.id==='target')!;target.pose=pose(spec.route[0]!.x,spec.route[0]!.y,.5);target.config={...target.config,maxSpeed:.6,maxAcceleration:1.5};},async tick(world,target){if(Math.round(world.simMs)%100!==0)return;const current=world.physics.body('target/base').pose.position,goal=spec.route[index]!,delta=vec(goal.x-current.x,goal.y-current.y,goal.z-current.z),distance=Math.hypot(delta.x,delta.y,delta.z);if(distance<.16&&world.simMs>=pauseUntil){index=(index+1)%spec.route.length;pauseUntil=world.simMs+300+rng()*900;}const speed=world.simMs<pauseUntil?0:Math.min(spec.speed,distance*1.5),factor=speed/Math.max(.001,distance);await target.command({id:`spatial-target-${++sequence}`,action:'velocity',args:{x:delta.x*factor,y:delta.y*factor,z:delta.z*factor},validForMs:500});const o=await target.observe();if(o.events.length)await target.acknowledge(o.events.at(-1)!.id);}};
}
