import test from 'node:test';
import assert from 'node:assert/strict';
import {tupleHistory,decodeTupleHistory,snapshotProgress} from '../experiments/jev-spatial-refinement/history.ts';

test('tuple histories round-trip all execution and acquired facts without omission',()=>{
  const cards=[{commandId:'c',facts:[{id:'f1',commandId:'c',atMs:20,kind:'execution',value:{stage:'rejected',reason:'lease'}},{id:'f2',commandId:'c',atMs:10,kind:'before',value:{headingDeg:45,objects:[],overflow:0}}]}];
  assert.deepEqual(decodeTupleHistory(tupleHistory(cards)),cards[0]!.facts);
});
const request=(box:number[],heading=0,accepted=0):any=>({state:{snapshot:{objects:[{color:'blue',box,clipped:false}],overflow:0},camera:{calibration:{fx:200,cx:160},horizontalFovDeg:80},controls:{acquiredHeadingDeg:heading,lastAcceptedHeadingDeg:accepted}}});
test('snapshot proxy projects box edges and respects left-positive yaw, retain and mirrors',()=>{
  const r=snapshotProgress(request([220,70,240,90]));
  assert(r.scorable);assert(r.acceptable.includes('right_10'));assert(!r.acceptable.includes('left_10'));assert(!r.acceptable.includes('retain'));
  const l=snapshotProgress(request([80,70,100,90]));assert(l.acceptable.includes('left_10'));assert(!l.acceptable.includes('right_10'));
  const retained=snapshotProgress(request([220,70,240,90],175,165));assert(retained.acceptable.includes('retain'));
  const wrapped=snapshotProgress(request([220,70,240,90],-175,175));assert(wrapped.acceptable.includes('retain'));
});
test('maintaining a centered view can be acceptable; ambiguous observations never get a control oracle',()=>{
  assert(snapshotProgress(request([145,70,175,90])).acceptable.includes('retain'));
  const r=request([220,70,240,90]);r.state.snapshot.objects=[];assert.equal(snapshotProgress(r).scorable,false);
  r.state.snapshot.objects=[{color:'blue',box:[220,70,240,90],clipped:true}];assert.equal(snapshotProgress(r).scorable,false);
});
