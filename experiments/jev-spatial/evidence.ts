import type {RobotPort} from '../../src/contracts.ts';
/** Goal-independent acquisition/result ledger. Never receives world/evaluator objects. */
export class EvidenceLedger {
 private inputs=new Map<number,any>(); private pending:any[]=[]; private unread:any[]=[]; private views:any[]=[]; private previous:any;
 private sequence=0;private acknowledged=0;private dropped=0;private motion:any[]=[];
 input(f:any){this.inputs.set(f.id,f);if(this.inputs.size>64)this.inputs.delete(this.inputs.keys().next().value!);}
 result(d:any){const f=this.inputs.get(d.frameId);if(!f)throw new Error('Unknown perception input');this.pending.push({id:++this.sequence,acquiredMs:f.acquiredMs,camera:f.camera,objects:d.result.objects});if(this.pending.length>64){this.pending.shift();this.dropped++;}}
 consume(n:number){this.acknowledged=Math.max(this.acknowledged,n);this.unread=this.unread.filter(e=>e.id>this.acknowledged);}
 advance(limit:number){
  const ready=this.pending.filter(f=>f.acquiredMs<=limit);this.pending=this.pending.filter(f=>f.acquiredMs>limit);
  for(const f of ready){
   if(f.objects.length)this.unread.push({id:f.id,acquiredMs:f.acquiredMs,cameraHeadingDeg:f.camera.headingDeg,cameraPitchDeg:f.camera.pitchDeg,objects:f.objects.map((p:any)=>({id:p.id,color:p.color,rightDeg:p.rightDeg,upDeg:p.upDeg,widthPercent:p.widthPercent})),meaning:'Historical detection. Current object location is unknown unless detected in current image.'});
   if(!this.views.length||f.acquiredMs-this.views.at(-1).acquiredMs>=1000)this.views.push({acquiredMs:f.acquiredMs,headingDeg:f.camera.headingDeg,pitchDeg:f.camera.pitchDeg,hfovDeg:f.camera.hfovDeg,self:f.camera.self,observedColors:f.objects.map((p:any)=>p.color),meaning:'Only this acquired view inspected. No detection does not prove empty geometry.'});
   this.motion=[];
   const p=this.previous,dt=p?(f.acquiredMs-p.acquiredMs)/1000:0;
   if(dt>0&&dt<=.5&&p.camera.hfovDeg===f.camera.hfovDeg)for(const obj of f.objects){const old=p.objects.find((a:any)=>a.id===obj.id);if(!old||obj.clipped||old.clipped)continue;const yaw=((f.camera.headingDeg-p.camera.headingDeg+540)%360)-180,pitch=f.camera.pitchDeg-p.camera.pitchDeg;
    this.motion.push({id:obj.id,intervalMs:dt*1000,rawHorizontal:(obj.rightDeg-old.rightDeg)/dt,rawVertical:(obj.upDeg-old.upDeg)/dt,compensatedHorizontal:(obj.rightDeg-old.rightDeg-yaw)/dt,compensatedVertical:(obj.upDeg-old.upDeg+pitch)/dt});}
   this.previous=f;
  }
  while(this.unread.length>64){this.unread.shift();this.dropped++;}
  while(this.unread.length&&limit-this.unread[0].acquiredMs>30000){this.unread.shift();this.dropped++;}
  this.views=this.views.filter(v=>limit-v.acquiredMs<=30000).slice(-24);
  return {events:{throughId:Math.max(this.acknowledged,...this.unread.map(e=>e.id)),acknowledgedThroughId:this.acknowledged,dropped:this.dropped,items:structuredClone(this.unread)},views:structuredClone(this.views),motion:structuredClone(this.motion)};
 }
 wrap(port:RobotPort,snapshot?:(data:any)=>void):RobotPort{return{...port,observe:async()=>{const o=await port.observe(),r=o.sensors.camera;if(r?.valid){const c=r.value as any;c.evidence=this.advance(r.acquiredSimMs);snapshot?.({key:`${o.sequence}:${r.acquiredSimMs}`,acquiredMs:r.acquiredSimMs,evidence:c.evidence});}return o;}};}
}
