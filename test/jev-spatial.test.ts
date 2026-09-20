import test from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceLedger} from '../experiments/jev-spatial/evidence.ts';
import {spatialDesign,task} from '../experiments/jev-spatial/design.ts';
import {syntheticResponse} from '../experiments/jev-spatial/campaign.ts';
const frame=(id:number,at:number,color='blue')=>({id,acquiredMs:at,camera:{headingDeg:0,pitchDeg:0,hfovDeg:70,self:{position:{x:0,y:0,z:2}}},objects:[{id:'p1',color,rightDeg:10,upDeg:-10,widthPercent:10,clipped:false}]});
test('acquisition ledger retains short glimpse across requests, gates delivery and acknowledges exact IDs',()=>{
 const l=new EvidenceLedger();for(let i=1;i<=3;i++){const f=frame(i,i*200);l.input(f);l.result({frameId:i,result:{objects:i===2?f.objects:[]}});}
 assert.equal(l.advance(200).events.items.length,0);const got=l.advance(600);assert.equal(got.events.items[0].acquiredMs,400);l.consume(got.events.throughId);assert.equal(l.advance(600).events.items.length,0);
 const f=frame(4,800);l.input(f);l.result({frameId:4,result:{objects:f.objects}});assert.equal(l.advance(800).events.items.length,1);
});
test('overflow and age expiry are visible; fresh reset has no events',()=>{
 const l=new EvidenceLedger();for(let i=1;i<80;i++){const f=frame(i,i*200);l.input(f);l.result({frameId:i,result:{objects:f.objects}});l.advance(i*200);}
 assert(l.advance(16000).events.dropped>0);assert.equal(l.advance(60000).events.items.length,0);assert.equal(new EvidenceLedger().advance(60000).events.items.length,0);
});
test('all direct/factored/joint menus preserve full tuple set, neutral retains accepted camera setpoints',()=>{
 const f=frame(1,200);const o:any={goal:task.goal(1),sensors:{camera:{valid:true,acquiredSimMs:200,value:{...f.camera,kind:'tracked-regions-v1',objects:[],evidence:{events:{throughId:0,items:[]},views:[],motion:[]}}}},inbox:[],simMs:300};
 for(const options of [{},{joint:true},{factored:true}]){const d=spatialDesign(options),r=d.request(o,'test',[{heading:42,pitch:-8,receipt:{status:'accepted'}}]);for(const q of Object.values(r.questions))assert(Object.keys(q.criteria).length<=255);const answer=syntheticResponse(r);answer.answers.mode!.choice='hold';answer.answers.mode!.probabilities={search:0,hold:1};const mapped=d.map(r,answer);assert.deepEqual(mapped.bodyVelocity,[0,0,0]);assert.equal(mapped.action.heading,42);assert.equal(mapped.action.pitch,-8);assert.deepEqual((mapped as any).overrides,[]);}
});
test('view treatment changes only delivered state and labels age without free-space claims',()=>{
 const f=frame(1,200),o:any={goal:task.goal(1),sensors:{camera:{valid:true,acquiredSimMs:1200,value:{...f.camera,objects:[],evidence:{events:{throughId:0,items:[]},views:[{acquiredMs:200,headingDeg:20,meaning:'Only this acquired view inspected. No detection does not prove empty geometry.'}],motion:[]}}}},inbox:[],simMs:1300};
 const a=spatialDesign({}).request(o,'a',[]),b=spatialDesign({views:true}).request(o,'b',[]);assert.deepEqual(a.questions,b.questions);assert.equal((b.state as any).inspectedViews[0].ageMs,1000);const {inspectedViews,...rest}=b.state as any;assert.deepEqual(rest,a.state);
});
test('directional self serialization retains measurements and reports limits without motor recommendation',()=>{
 const f=frame(1,200),o:any={goal:task.goal(1),sensors:{camera:{valid:true,acquiredSimMs:200,value:{...f.camera,self:{model:'sampled',frame:'ENU',acquiredMs:200,boundedNoiseM:.08,position:{x:-19.125,y:2.25,z:6.125}},objects:f.objects,evidence:{events:{throughId:0,items:[]},views:[],motion:[]}}}},inbox:[],simMs:300};
 const d=spatialDesign({words:true}),r=d.request(o,'words',[]),s=r.state as any;assert.equal(s.self.eastWest,'19.125 metres west of origin');assert.equal(s.self.altitude,'6.125 metres above origin');assert.equal(s.self.altitudeRelation,'above maximum 6 metres');assert.equal(s.objects[0].horizontal,'10 degrees right');assert.equal(s.objects[0].vertical,'10 degrees below');assert(!JSON.stringify(s).includes('recommended_action'));
});
test('neutral axis instructions preserve exact sensor state, menus and selected physical action',()=>{
 const f=frame(1,200),o:any={goal:task.goal(1),sensors:{camera:{valid:true,acquiredSimMs:200,value:{...f.camera,objects:f.objects,evidence:{events:{throughId:0,items:[]},views:[],motion:[]}}}},inbox:[],simMs:300};
 const a=spatialDesign({}),b=spatialDesign({neutralAxes:true}),ra=a.request(o,'a',[]),rb=b.request(o,'b',[]);assert.deepEqual(ra.state,rb.state);assert.deepEqual(Object.keys(ra.questions),Object.keys(rb.questions));for(const id of Object.keys(ra.questions))assert.deepEqual(ra.questions[id]!.criteria,rb.questions[id]!.criteria);const response=syntheticResponse(ra);assert.deepEqual(a.map(ra,response),b.map(rb,response));assert(String(rb.questions.search_up!.instructions).includes('vertical velocity'));assert(!String(rb.questions.search_up!.instructions).includes('Choose only up'));
 const factored=spatialDesign({neutralAxes:true,factored:true}).request(o,'f',[]);assert.equal((factored.questions.search_pitch_direction!.criteria as Record<string,unknown>).negative,'down direction; magnitude selected separately');assert.equal((factored.questions.search_yaw_direction!.criteria as Record<string,unknown>).positive,'left direction; magnitude selected separately');
});

import {imageCase} from '../experiments/jev-hypotheses/fixtures.ts';
import {imageCell} from '../experiments/jev-spatial/design.ts';
import {spatialLayout} from '../experiments/jev-spatial/fixtures.ts';
import {layout as scoutLayout} from '../experiments/jev-scout/scenario.ts';

test('grid matches rendered pixel patch centres for all colours and is independent of mission',()=>{
 for(let i=0;i<40;i++){
  const f=imageCase(3100+i,'development'),o:any=structuredClone(f.observation),c=o.sensors.camera.value;
  c.evidence={events:{throughId:0,items:[]},views:[],motion:[]};
  for(const p of c.objects){const [x0,y0,x1,y1]=p.box,u=((x0+x1)/2-c.calibration.cx)/c.calibration.cx,v=(c.calibration.cy-(y0+y1)/2)/c.calibration.cy;
   // Bearings are rounded to .01 degree. These fixtures stay outside the corresponding boundary tolerance.
   if(Math.min(Math.abs(Math.abs(u)-.3),Math.abs(Math.abs(v)-.3))>.001)assert.equal(imageCell(p,c),`${v<-.3?'bottom':v>.3?'top':'middle'}-${u<-.3?'left':u>.3?'right':'centre'}`);
  }
  const d=spatialDesign({neutralAxes:true,factored:true,grid:true}),r=d.request(o,'grid',[]),changed=d.request({...o,goal:'Inspect the red region instead'},'grid',[]);
  assert.deepEqual((r.state as any).imageGrid,(changed.state as any).imageGrid);assert.deepEqual((r.state as any).objects,(changed.state as any).objects);
  assert.equal((r.state as any).objects.length,c.objects.length);assert.match((r.state as any).imageGrid.meaning,/never free space/);
 }
});
test('action verbs preserve all question identities, option IDs and physical mapping',()=>{
 const f=frame(1,200),o:any={goal:task.goal(1),sensors:{camera:{valid:true,acquiredSimMs:200,value:{...f.camera,objects:f.objects,evidence:{events:{throughId:0,items:[]},views:[],motion:[]}}}},inbox:[],simMs:300};
 const a=spatialDesign({neutralAxes:true,factored:true}),b=spatialDesign({neutralAxes:true,factored:true,verbs:true}),ra=a.request(o,'a',[]),rb=b.request(o,'b',[]);assert.deepEqual(ra.state,rb.state);assert.deepEqual(Object.keys(ra.questions),Object.keys(rb.questions));
 for(const id of Object.keys(ra.questions))assert.deepEqual(Object.keys(ra.questions[id]!.criteria),Object.keys(rb.questions[id]!.criteria));
 for(const mode of Object.keys(ra.questions.mode!.criteria))for(const [id,q]of Object.entries(ra.questions))for(const option of Object.keys(q.criteria)){const response=syntheticResponse(ra);for(const [k,v]of [['mode',mode],[id,option]]){const x=response.answers[k!]!;x.choice=v!;x.probabilities=Object.fromEntries(Object.keys(ra.questions[k!]!.criteria).map(c=>[c,c===v?1:0]));}assert.deepEqual(a.map(ra,response),b.map(rb,response));}
});
test('qualified structures preserve original fixture and reject mismatched cases',()=>{
 assert.equal(JSON.stringify(spatialLayout(3101,'behind-wall')),JSON.stringify(scoutLayout(3101,'behind-wall')));
 assert.equal(spatialLayout(3701,'behind-wall','screen-return-v1').obstacles.some(b=>b.id==='screen-return'),true);
 assert.equal(spatialLayout(3701,'occlusion-course','offset-piers-v1').obstacles.some(b=>b.id==='offset-pier'),true);
 assert.throws(()=>spatialLayout(3701,'turn-to-find','screen-return-v1'));
});


test('explicit bearing ablation removes every request copy without changing mapping',()=>{
 for(const extra of [{},{verbs:true},{grid:true},{grid:true,verbs:true},{words:true,grid:true}]){
  const f=imageCase(3109,'development'),o:any=structuredClone(f.observation),c=o.sensors.camera.value;
  c.evidence={events:{throughId:0,items:[]},views:[],motion:[]};o.goal=task.goal(1);
  const options={neutralAxes:true,factored:true,...extra},a=spatialDesign(options),b=spatialDesign({...options,removeBearings:true}),ra=a.request(o,'full',[]),rb=b.request(o,'removed',[]),changed=structuredClone(o);
  changed.sensors.camera.value.objects.forEach((p:any)=>{p.rightDeg=-p.rightDeg+5;p.upDeg=-p.upDeg+5;});
  assert.deepEqual(rb,b.request(changed,'removed',[]));assert.notDeepEqual(ra,a.request(changed,'full',[]));
  for(const p of (rb.state as any).objects){assert(!('rightDeg'in p));assert(!('upDeg'in p));assert(!('imageCell'in p));assert(!('horizontal'in p));assert(!('vertical'in p));}
  assert(!('imageGrid'in (rb.state as any)));assert.deepEqual(Object.keys(ra.questions),Object.keys(rb.questions));
  for(const id of Object.keys(ra.questions))assert.deepEqual(ra.questions[id]!.criteria,rb.questions[id]!.criteria);
  const response=syntheticResponse(ra);assert.deepEqual(a.map(ra,response),b.map(rb,response));
 }
 for(const extra of [{events:true},{views:true},{motion:'raw' as const},{motion:'compensated' as const}])assert.throws(()=>spatialDesign({...extra,removeBearings:true}));
});
