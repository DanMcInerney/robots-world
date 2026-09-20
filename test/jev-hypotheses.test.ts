import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCase } from '../experiments/jev-hypotheses/fixtures.ts';
import { hypothesisDesign,REPRESENTATIONS,viewingDirection } from '../experiments/jev-hypotheses/design.ts';
import { matchingSetpoint,waitForFeedback } from '../experiments/jev-hypotheses/flights.ts';
import { MODEL,type Request,type Response } from '../experiments/jev-strategies/strategies.ts';
import type { RobotPort } from '../src/contracts.ts';

function answer(request:Request,selected:Record<string,string>={}):Response{return {model:MODEL,answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{const keys=Object.keys(q.criteria),c=selected[id]??keys.find(k=>k==='hold'||k.startsWith('hold_')||k.startsWith('keep_')||k==='wide')??keys[0]!;return[id,{type:'choice',choice:c,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===c?1:0]))}];}))};}
test('Hypothesis comparisons preserve state/questions and observed object provenance',()=>{
  const {observation}=imageCase(0,'development');const builds=Object.fromEntries(REPRESENTATIONS.map(representation=>[representation,hypothesisDesign({representation}).request(observation,representation,[])]));
  assert.deepEqual(builds.full.questions,builds.compact.questions);assert.deepEqual((builds.full.state as any).objects,(builds.compact.state as any).objects);assert.deepEqual(builds.compact.state,builds.direct.state);assert.deepEqual(builds.direct.state,builds.factored.state);
  assert.deepEqual(builds.factored.questions,builds.binned.questions);
  for(const r of Object.values(builds)){assert(!JSON.stringify(r).includes('not-exposed-target'));assert(Object.values(r.questions).every(q=>Object.keys(q.criteria).length<=255));}
  const a=hypothesisDesign({representation:'factored',hybrid:'enabled'}),b=hypothesisDesign({representation:'factored',hybrid:'disabled'});assert.deepEqual(a.request(observation,'a',[]),b.request(observation,'b',[]));
});
test('Factor decoder exposes all signed magnitudes; zero retention is explicit and rejects no accepted prior',()=>{
  const {observation}=imageCase(0,'development'),design=hypothesisDesign({representation:'factored',retain:true});
  const feedback=[{heading:30,pitch:10,receipt:{status:'accepted'}}],r=design.request(observation,'test',feedback);
  const held=design.map(r,answer(r));assert.equal(held.action.heading,30);assert.equal(held.action.pitch,10);
  const found=new Set<number>();for(const direction of ['left','right'])for(const n of [5,15,45,90]){
    const mapped=design.map(r,answer(r,{yaw_direction:direction,[`yaw_${direction}_magnitude`]:`amount_${n}`}));found.add(mapped.action.heading);
  }assert.deepEqual([...found].sort((a,b)=>a-b),[-90,-45,-15,-5,5,15,45,90]);
  const bad=design.request(observation,'test',[{heading:30,pitch:10,receipt:{status:'rejected'}}]);assert.equal(design.map(bad,answer(bad)).action.heading,0);
});
test('Viewing direction removes measured rotation without inventing range',()=>{
  assert.deepEqual(viewingDirection(10,0,0,0),viewingDirection(20,0,10,0));
  assert.deepEqual(viewingDirection(0,10,0,0),viewingDirection(0,5,0,5));
  assert.equal(Object.keys(viewingDirection(1,2,3,4)).length,2);
});
test('Feedback gate requires actual matching job and newer camera; responds to cancellation',async()=>{
  const sample=imageCase(0,'development').observation,args={x:0,y:0,z:0,heading:10,pitch:0,hfov:70};let clock=300,commands=0;
  const port:RobotPort={robotId:'drone',describe:async()=>{throw new Error('unused');},command:async c=>{commands++;return{id:c.id,status:'accepted'};},acknowledge:async()=>{},send:async()=>({accepted:false}),stop:async()=>{},close:async()=>{},observe:async()=>{clock+=100;return {...structuredClone(sample),simMs:clock,sensors:{camera:{...sample.sensors.camera!,acquiredSimMs:clock-200}},jobs:clock<700?[]:[{id:'device',commandId:'device',action:'control',args,status:'running',startedSimMs:650,updatedSimMs:650}]};}};
  const abort=new AbortController(),events:any[]=[],wrapped=waitForFeedback(port,abort.signal,(k,d)=>events.push(d));await wrapped.command({id:'test',action:'control',args});const result=await wrapped.observe();assert(result.sensors.camera!.acquiredSimMs>650);assert.equal(commands,1);assert.equal(events[0].ready,true);assert(matchingSetpoint(args,args));assert(!matchingSetpoint({...args,heading:9},args));
  abort.abort();await assert.rejects(wrapped.observe());
});
