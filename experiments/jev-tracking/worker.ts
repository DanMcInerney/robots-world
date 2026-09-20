import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import type {RobotPort} from '../../src/contracts.ts';
import type {Emit} from '../reactive/world.ts';

export type FrameInput={id:number;file:string;acquiredMs:number;calibration:any;objects:any[];camera:any};
/** Optional external perception; one in-flight and one coalescible pending frame. */
export class VisionWorker{
  private child;private pending?:FrameInput;private busy?:FrameInput;private done:any[]=[];private ready=false;private failed?:Error;private closed=false;
  readonly stats={submitted:0,processed:0,coalesced:0,versions:{} as any};
  readonly mode:'colour'|'klt';private emit:Emit;
  constructor(mode:'colour'|'klt',emit:Emit,python=resolve('.runtime/vision-env/Scripts/python.exe')){
    this.mode=mode;this.emit=emit;
    this.child=spawn(python,['-u',resolve('experiments/jev-tracking/perception.py'),mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.on('error',e=>{this.failed=e;});this.child.on('exit',code=>{if(!this.closed)this.failed=new Error(`Vision worker exited ${code}`);});
    this.child.stderr.on('data',chunk=>{this.emit('vision.stderr',{message:String(chunk).slice(0,2000)});});
    createInterface({input:this.child.stdout}).on('line',line=>{try{
      const data=JSON.parse(line);if(data.ready){this.ready=true;this.stats.versions=data;return;}
      if(data.error)throw new Error(data.error);if(!this.busy||data.id!==this.busy.id)throw new Error('Vision response identity mismatch');
      const frame=this.busy;this.done.push({frame,result:data.result});if(this.done.length>32)this.done.shift();this.stats.processed++;
      this.emit('vision.result',{frameId:frame.id,acquiredMs:frame.acquiredMs,result:data.result});this.busy=undefined;
      if(this.pending){const next=this.pending;this.pending=undefined;this.send(next);}
    }catch(e){this.failed=e instanceof Error?e:new Error(String(e));}});
  }
  async start(){const start=performance.now();while(!this.ready){this.check();if(performance.now()-start>10000)throw new Error('Vision startup timeout');await sleep(10);}}
  check(){if(this.failed)throw this.failed;}
  enqueue(frame:FrameInput){this.check();if(this.closed)return;this.stats.submitted++;if(this.busy){if(this.pending){this.stats.coalesced++;this.emit('vision.coalesced',{frameId:this.pending.id,replacedBy:frame.id});}this.pending=frame;}else this.send(frame);}
  private send(frame:FrameInput){this.busy=frame;this.emit('vision.input',{...frame,file:frame.file.replaceAll('\\','/')});this.child.stdin.write(JSON.stringify(frame)+'\n');}
  latest(acquiredLimit:number){this.check();return this.done.findLast(x=>x.frame.acquiredMs<=acquiredLimit);}
  wrap(port:RobotPort):RobotPort{
    const acquired=new Map<number,number>();
    return{...port,observe:async()=>{const o=await port.observe(),raw=o.sensors.camera;const value=raw?this.latest(raw.acquiredSimMs):undefined;
      if(!raw||!value){if(raw)o.sensors.camera={...raw,valid:false,reason:'perception-pending'};return o;}
      const {frame,result}=value;
      o.sensors.camera={...raw,acquiredSimMs:frame.acquiredMs,valid:raw.valid&&o.simMs-frame.acquiredMs<=500,
        value:{...frame.camera,...result,perceptionMs:result.processingMs,kind:'tracked-regions-v1'}};
      acquired.set(o.sequence,frame.acquiredMs);if(acquired.size>64)acquired.delete(acquired.keys().next().value!);return o;
    },command:async command=>{const at=acquired.get(command.basedOn?.observation??-1),now=await port.observe();if(at===undefined||now.simMs-at>1000)return{id:command.id,status:'rejected',reason:'processed-image-stale-or-unknown'};return port.command(command);}};
  }
  async close(){if(this.closed)return;this.closed=true;this.pending=undefined;if(this.child.exitCode!==null)return;const exit=new Promise<void>(r=>this.child.once('exit',()=>r()));this.child.stdin.end();await Promise.race([exit,sleep(1500)]);if(this.child.exitCode===null)this.child.kill();}
}
