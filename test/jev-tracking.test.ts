import test from 'node:test';
import assert from 'node:assert/strict';
import {trackingDesign} from '../experiments/jev-tracking/design.ts';
import {imageCase} from '../experiments/jev-hypotheses/fixtures.ts';
import {MODEL,type Request,type Response} from '../experiments/jev-strategies/strategies.ts';
function answer(r:Request,s:Record<string,string>={}):Response{return{model:MODEL,answers:Object.fromEntries(Object.entries(r.questions).map(([k,q])=>{const keys=Object.keys(q.criteria),c=s[k]??keys.find(x=>x==='hold'||x==='wide'||x==='none')??keys[0]!;return[k,{type:'choice',choice:c,confidence:1,probabilities:Object.fromEntries(keys.map(x=>[x,x===c?1:0]))}];}))};}
test('Binding uses actual selected ID, resets on goal change, and rejects malformed responses',()=>{
 const {observation:o}=imageCase(1000,'development'),d=trackingDesign(false),initial=d.request(o,'test',[]),objects=(o.sensors.camera!.value as any).objects;
 assert.deepEqual(Object.keys(initial.questions),['target']);assert.equal((initial.state as any).activeTrack,null);
 const selected=objects[1].id;d.map(initial,answer(initial,{target:selected}));const r=d.request(o,'test',[]);
 assert.equal((r.state as any).activeTrack.id,selected);assert.equal(Object.keys(r.questions).length,18);
 assert.equal((d.request({...o,goal:'new exact goal'},'test',[]).state as any).activeTrack,null);
 const bad=answer(initial);bad.model='bad';assert.throws(()=>d.map(initial,bad));
 assert(Object.values(r.questions).every(q=>Object.keys(q.criteria).length<=255));
});
test('Direct camera remains model-selected; servo requires follow plus currently observed selected ID',()=>{
 const {observation:o}=imageCase(1000,'development'),obj=(o.sensors.camera!.value as any).objects[0];
 const a=trackingDesign(false),b=trackingDesign(true);for(const d of [a,b]){const r=d.request(o,'test',[]);d.map(r,answer(r,{target:obj.id}));}
 const ra=a.request(o,'test',[]),rb=b.request(o,'test',[]);assert.deepEqual(ra,rb);
 const selected={behavior:'follow',yaw_direction:'left',yaw_left_magnitude:'amount_45',pitch_direction:'up',pitch_up_magnitude:'amount_10',forward_direction:'forward',forward_forward_magnitude:'amount_0p6'};
 const direct=a.map(ra,answer(ra,selected)),servo=b.map(rb,answer(rb,selected));
 assert.equal(direct.action.heading,45);assert.equal(direct.action.pitch,10);assert.deepEqual(direct.bodyVelocity,servo.bodyVelocity);assert.notEqual(direct.action.heading,servo.action.heading);
 const lost=structuredClone(o);(lost.sensors.camera!.value as any).objects=[];
 const r=b.request(lost,'test',[]);assert.equal((r.state as any).activeTrack.measurement,'lost');assert.equal(b.map(r,answer(r,selected)).action.heading,45);
});
test('Processed perception is adapted without mutating observations; holds retain accepted angles',()=>{
 const {observation:o}=imageCase(1000,'development');(o.sensors.camera!.value as any).kind='tracked-regions-v1';const d=trackingDesign(false),before=structuredClone(o),r=d.request(o,'test',[{heading:31,pitch:9,receipt:{status:'accepted'}}]);
 assert.deepEqual(o,before);const m=d.map(r,answer(r));assert.deepEqual(m.bodyVelocity,[0,0,0]);assert.equal(m.action.heading,31);assert.equal(m.action.pitch,9);
});
