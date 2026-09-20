import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {imageCase} from '../jev-hypotheses/fixtures.ts';
import {callJev} from '../jev-pixels/controller.ts';
import {trackingDesign} from './design.ts';
export async function staticTests(directory:string,key:string,transport=callJev){
 await mkdir(`${directory}/frames`,{recursive:true});const report:any={rows:[],complete:false,errors:[],design:'Fresh pixels. Implicit physical choice vs preceding actual Jev target binding; all 16 physical questions preserved. Behavior/reselect excluded from both static control requests to isolate binding. No action applied.'};
 const save=()=>writeFile(`${directory}/report.json`,JSON.stringify(report));await save();
 async function ask(id:string,phase:string,variant:string,design:ReturnType<typeof trackingDesign>,observation:any,evaluation:any,physical=false){
  const request=design.request(observation,variant,[]);if(physical){delete request.questions.behavior;delete request.questions.target;}
  await appendFile(`${directory}/requests.jsonl`,JSON.stringify({id,phase,variant,request})+'\n');const start=performance.now(),response=await transport(request,key,AbortSignal.timeout(12000));
  const mapping=design.map(request,response),yaw=mapping.action.heading,pitch=mapping.action.pitch;
  const row={id,phase,variant,observation,request,response,mapping,latencyMs:performance.now()-start,evaluation:{...evaluation,selectedTarget:mapping.selections.target??null,correctTarget:request.questions.target?mapping.selections.target===evaluation.targetId:null,correctYaw:Math.sign(yaw)===Math.sign(-evaluation.rightDeg),correctPitch:Math.sign(pitch)===Math.sign(evaluation.upDeg)}};
  report.rows.push(row);await save();console.log(JSON.stringify({event:'static',id,variant,selected:row.evaluation.selectedTarget,correctYaw:row.evaluation.correctYaw,correctPitch:row.evaluation.correctPitch}));return row;
 }
 try{
  for(const phase of ['development','held-out'] as const)for(let i=0;i<(phase==='development'?8:16);i++){
   const c=imageCase(1000+i,phase);await writeFile(`${directory}/frames/${c.id}.png`,c.png,{flag:'wx'});
   const implicit=()=>ask(c.id,phase,'implicit',trackingDesign(false,false),c.observation,c.evaluation,true);
   const bound=async()=>{const d=trackingDesign(false);await ask(c.id,phase,'binding',d,c.observation,c.evaluation);if((d.request(c.observation,'bound',[]).state as any).stage==='control')await ask(c.id,phase,'bound',d,c.observation,c.evaluation,true);else{report.rows.push({id:c.id,phase,variant:'bound-unavailable',evaluation:c.evaluation,note:'Actual Jev selected none; retained as failure, no oracle substitute.'});await save();}};
   if(i%2){await bound();await implicit();}else{await implicit();await bound();}
  }
  // Identical pixel evidence with missing/ambiguous goals; no sensor facts are manufactured.
  const c=imageCase(1100,'held-out');await writeFile(`${directory}/frames/${c.id}.png`,c.png,{flag:'wx'});
  for(const [id,goal] of [['missing','Find the red object. Bind none if it is not visible.'],['ambiguous','Track the object. Its colour and identity are unspecified. Bind none if this does not identify one unambiguous region.']]){
   await ask(id!,'edge-case',id!,trackingDesign(false),{...c.observation,goal}, {...c.evaluation,targetId:'none'});
  }
  const d=trackingDesign(false);await ask('changed-goal','edge-case','before',d,c.observation,c.evaluation);
  const orange=(c.observation.sensors.camera!.value as any).objects.find((o:any)=>o.color==='orange');
  await ask('changed-goal','edge-case','after',d,{...c.observation,goal:'Now track the orange object. Use the wide camera view.'},{targetId:orange.id,rightDeg:orange.rightDeg,upDeg:orange.upDeg});
  report.complete=true;
 }catch(e){report.errors.push(String(e));throw e;}finally{await save();}return report;
}
