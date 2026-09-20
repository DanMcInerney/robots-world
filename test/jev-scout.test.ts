import test from 'node:test';
import assert from 'node:assert/strict';
import {scoutDesign} from '../experiments/jev-scout/design.ts';
import {scoreScout} from '../experiments/jev-scout/score.ts';
import {layout,CASES,insideObstacle} from '../experiments/jev-scout/scenario.ts';
import {imageCase} from '../experiments/jev-hypotheses/fixtures.ts';
import {MODEL,type Request,type Response} from '../experiments/jev-strategies/strategies.ts';
function answer(r:Request,selected:Record<string,string>={}):Response{return{model:MODEL,answers:Object.fromEntries(Object.entries(r.questions).map(([id,q])=>{const keys=Object.keys(q.criteria),c=selected[id]??(id==='mode'?'hold':id.endsWith('zoom')?'v0':id.endsWith('yaw')?'v4':'v3');return[id,{type:'choice',choice:c,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===c?1:0]))}];}))};}
test('Scouting controls work before any target binding; unused branches cannot affect search',()=>{
  const {observation:o}=imageCase(1000,'development'),d=scoutDesign(true);(o.sensors.camera!.value as any).objects=[];
  const r=d.request(o,'test',[]);assert.equal(Object.keys(r.questions).length,7);
  const m=d.map(r,answer(r,{mode:'search',search_yaw:'v8',search_forward:'v5'}));assert.equal(m.action.heading,90);assert.equal(m.bodyVelocity[0],.6);
  const c=imageCase(1000,'development').observation,request=d.request(c,'test',[]),one=answer(request,{mode:'search',search_right:'v2'}),two=structuredClone(one);
  for(const [id,q]of Object.entries(request.questions))if(id!=='mode'&&!id.startsWith('search_')){const picked=Object.keys(q.criteria)[0]!;two.answers[id]!.choice=picked;two.answers[id]!.probabilities=Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===picked?1:0]));}
  assert.deepEqual(d.map(request,one).action,d.map(request,two).action);
});
test('Region selection gates camera servo and preserves Jev translation; all current regions are offered',()=>{
  const {observation:o}=imageCase(1000,'development'),d=scoutDesign(false),r=d.request(o,'test',[]),objects=(r.state as any).objects;
  for(const p of objects)assert(Object.hasOwn(r.questions.mode!.criteria,`track_${p.id}`));
  assert.equal(Object.keys(r.questions).length,7+3*objects.length);assert(Object.values(r.questions).every(q=>Object.keys(q.criteria).length<=255));
  const p=objects[1],m=d.map(r,answer(r,{mode:`track_${p.id}`,[`${p.id}_forward`]:'v4'}));assert.equal(m.bodyVelocity[0],.2);assert.equal(m.action.heading,-p.rightDeg);assert((m as any).overrides.length);
  const bad=answer(r);bad.answers.mode!.choice='track_hidden-truth';assert.throws(()=>d.map(r,bad));
});
test('Memory uses acquired views, expires and resets without fabricating current locations',()=>{
  const {observation:o}=imageCase(1000,'development'),d=scoutDesign(true);d.request(o,'test',[]);
  const lost=structuredClone(o);lost.simMs+=2000;lost.sensors.camera!.acquiredSimMs+=2000;(lost.sensors.camera!.value as any).objects=[];
  const r=d.request(lost,'test',[]);assert((r.state as any).memory.lastSeen.length);assert.equal((r.state as any).memory.lastSeen[0].currentLocation,'unknown');
  lost.simMs+=31000;lost.sensors.camera!.acquiredSimMs+=31000;assert.equal((d.request(lost,'test',[]).state as any).memory.lastSeen.length,0);
  assert.equal((d.request({...o,goal:'new goal'},'test',[]).state as any).memory.views.length,1);
  assert(!('memory' in (scoutDesign(false).request(o,'test',[]).state as any)));
});
test('Direct technique executes Jev camera choices; assistance is the only treatment difference',()=>{
  const {observation:o}=imageCase(1000,'development'),direct=scoutDesign(false,false),servo=scoutDesign(false,true),r=direct.request(o,'test',[]),s=servo.request(o,'test',[]),objects=(r.state as any).objects,p=objects[1];
  assert.equal(Object.keys(r.questions).length,7+6*objects.length);
  assert.deepEqual((r.state as any).objects,(s.state as any).objects);
  assert.deepEqual(r.questions.mode,s.questions.mode);assert.deepEqual(r.questions.search_yaw,s.questions.search_yaw);
  const m=direct.map(r,answer(r,{mode:`track_${p.id}`,[`${p.id}_yaw`]:'v8',[`${p.id}_pitch`]:'v5',[`${p.id}_forward`]:'v4'}));
  assert.equal(m.action.heading,90);assert.equal(m.action.pitch,(r.state as any).camera.pitchDeg+10);assert.equal(m.bodyVelocity[0],.2);assert.deepEqual((m as any).overrides,[]);
  const s2=scoutDesign(true,true).request(o,'test',[]),withoutMemory=structuredClone(s2.state) as any;delete withoutMemory.memory;assert.deepEqual(withoutMemory,s.state);assert.deepEqual(s2.questions,s.questions);
});
test('Mission score requires visible-patch size, recovery and safety, not only centre lock',()=>{
  const frames=Array.from({length:300},(_,i)=>({acquiredMs:i*200,camera:{calibration:{fx:200,fy:200,cx:160,cy:90},hfovDeg:70,objects:[{color:'blue',rightDeg:0,upDeg:0,widthPercent:10,clipped:false}]}}));
  assert(scoreScout(frames,60,0,0,0).success);
  assert(!scoreScout(frames,60,1,0,0).success);assert(!scoreScout(frames,60,0,1,0).success);
  const partial=structuredClone(frames);for(const f of partial)f.camera.objects[0]!.widthPercent=3;assert(!scoreScout(partial,60,0,0,0).success);
  const lost=structuredClone(frames);for(const f of lost)if(f.acquiredMs>30000)f.camera.objects=[];const s=scoreScout(lost,60,0,0,0);assert(!s.success);assert.equal(s.losses.length,1);assert.equal(s.losses[0]!.recovered,false);
});
test('Seeded target corridor segments stay clear of fixed obstacles',()=>{
  for(const seed of [2101,2102,2201,2202,2203,2204])for(const kind of CASES){const s=layout(seed,kind);assert.deepEqual(s.route,layout(seed,kind).route);
    for(let i=0;i<s.route.length;i++)for(let j=0;j<=100;j++){const a=s.route[i]!,b=s.route[(i+1)%s.route.length]!,p={x:a.x+(b.x-a.x)*j/100,y:a.y+(b.y-a.y)*j/100,z:.5};assert(!s.obstacles.some(o=>insideObstacle(p,o,.39)),`${seed}/${kind} blocked`);}
  }
});
test('Missing camera intervals and unrecorded tails cannot pass as continuous pursuit',()=>{
  const frames=Array.from({length:300},(_,i)=>({acquiredMs:i*200,camera:{calibration:{fx:200,fy:200,cx:160,cy:90},hfovDeg:70,objects:[{color:'blue',rightDeg:0,upDeg:0,widthPercent:10,clipped:false}]}}));
  for(const sparse of [frames.filter(f=>f.acquiredMs<30000),frames.filter(f=>f.acquiredMs<15000||f.acquiredMs>=41000)]){
    const score=scoreScout(sparse,60,0,0,0);assert(!score.success);assert(score.framingFraction>=.4);assert(score.losses.some(l=>l.durationMs>20000&&l.includesCameraGap));assert(score.coverageGaps.length);
  }
  assert(scoreScout(frames,60,0,0,0).success);
});
