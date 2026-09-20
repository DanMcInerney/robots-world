import type {BodySpec, Scenario, Vec3} from '../../src/contracts.ts';
import {pose, vec, randomStream} from '../../src/math.ts';
import type {ReactiveEnvironment, ReactiveTask} from '../reactive/world.ts';

export const CASES = ['turn-to-find', 'behind-wall', 'occlusion-course'] as const;
export type ScoutCase = typeof CASES[number];
export const task: ReactiveTask = {
  id: 'scout-visible-blue-v1',
  goal: () => 'Find the moving blue object in this unfamiliar space, then keep following it. It may start outside the view or behind structures, and may disappear again. Choose where to look and whether to change viewpoint using what your camera has measured. Keep its visible centre within the central 30 percent of the image and its visible width between 8 and 14 percent of image width. Use the wide 70-degree view. Avoid touching any surfaces. Missing detections and unobserved areas are unknown, not clear space.',
  framed: v => v.visible && Math.abs(v.u) <= .3 && Math.abs(v.v) <= .3 && v.widthFraction >= .08 && v.widthFraction <= .14 && v.hfov === 70,
};
export function layout(seed:number, kind:ScoutCase) {
  const rng=randomStream(seed,'scout-layout'), mirror=seed%2?-1:1, turn=seed%4*Math.PI/2;
  const width=2.5+rng()*.7, speed=.3+rng()*.15;
  const point=(x:number,y:number,z:number) => vec(mirror*x*Math.cos(turn)-y*Math.sin(turn),mirror*x*Math.sin(turn)+y*Math.cos(turn),z);
  const placed=(x:number,y:number,z:number,heading=0)=>({...pose(0,0,0),position:point(x,y,z),rotation:{x:0,y:0,z:Math.sin((turn+heading)/2),w:Math.cos((turn+heading)/2)}});
  const box=(id:string,x:number,y:number,z:number,sx:number,sy:number,sz:number,color='#929292'):BodySpec=>({id,mode:'fixed',pose:placed(x,y,z),shape:{kind:'box',size:vec(sx,sy,sz),color}});
  const obstacles=[box('ground',0,0,-.2,40,40,.4,'#343434'),
    box('wall-north',0,9,3.5,20,.4,7),box('wall-south',0,-9,3.5,20,.4,7),
    box('wall-east',10,0,3.5,.4,18,7),box('wall-west',-10,0,3.5,.4,18,7),
    box('screen',kind==='turn-to-find'?6:0,0,3.5,width*2,.6,7),
    box('crate',-7,3,.7,1.2,1.2,1.4,'#b19572'),box('orange-distractor',7,4,.65,.6,.6,1.3,'#e98b36'),
    // Legacy evaluator expects this body; fixed and outside the arena, never a moving magic cover.
    box('crossing',100,100,1,.5,.5,2)];
  const routeLocal=kind==='occlusion-course'?[[0,3],[5,3],[5,-3],[-5,-3],[-5,3]]:[[-1.5,3],[1.5,3],[1.5,6],[-1.5,6]];
  const route=routeLocal.map(([x,y])=>point(x!,y!,.5));
  // All arms get the same unrelated starting view; no target-facing initialization.
  return {kind,seed,obstacles,route,speed,drone:placed(0,-6,2,kind==='turn-to-find'?-Math.PI/2:Math.PI/2),
    witness:placed(-6,-1,2,Math.PI/2),point,placed};
}
/** Environment-only actor. Fixed collision-free waypoint corridors, seeded pauses/direction, no drone response. */
export function scoutEnvironment(seed:number,kind:ScoutCase):ReactiveEnvironment {
  const spec=layout(seed,kind),rng=randomStream(seed,'scout-motion');let index=1,sequence=0,pauseUntil=0;
  return {
    configure(s:Scenario){s.id=`scout-${kind}`;s.obstacles=structuredClone(spec.obstacles);
      s.robots.find(r=>r.id==='drone')!.pose=structuredClone(spec.drone);
      const target=s.robots.find(r=>r.id==='target')!;target.pose=pose(spec.route[0]!.x,spec.route[0]!.y,.5);
      target.config={...target.config,maxSpeed:.6,maxAcceleration:1.5};
    },
    async tick(world,target){
      if(Math.round(world.simMs)%100!==0)return;
      const current=world.physics.body('target/base').pose.position,goal=spec.route[index]!;
      const delta=vec(goal.x-current.x,goal.y-current.y,goal.z-current.z),distance=Math.hypot(delta.x,delta.y,delta.z);
      if(distance<.16&&world.simMs>=pauseUntil){index=(index+1)%spec.route.length;pauseUntil=world.simMs+300+rng()*900;}
      const speed=world.simMs<pauseUntil?0:Math.min(spec.speed,distance*1.5),factor=speed/Math.max(.001,distance);
      await target.command({id:`scout-target-${++sequence}`,action:'velocity',args:{x:delta.x*factor,y:delta.y*factor,z:delta.z*factor},validForMs:500});
      const o=await target.observe();if(o.events.length)await target.acknowledge(o.events.at(-1)!.id);
    },
  };
}
/** Offline/evaluator-only swept path clearance against the declared boxes. Never a policy feature. */
export function insideObstacle(p:Vec3,b:BodySpec,padding=.3){
  if(b.shape.kind!=='box')throw new Error('Expected box');
  const q=b.pose.rotation,angle=2*Math.atan2(q.z,q.w),dx=p.x-b.pose.position.x,dy=p.y-b.pose.position.y;
  return Math.abs(dx*Math.cos(angle)+dy*Math.sin(angle))<b.shape.size.x/2+padding && Math.abs(-dx*Math.sin(angle)+dy*Math.cos(angle))<b.shape.size.y/2+padding && Math.abs(p.z-b.pose.position.z)<b.shape.size.z/2+.09;
}
