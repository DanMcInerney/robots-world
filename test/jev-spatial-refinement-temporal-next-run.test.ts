import test from 'node:test';
import assert from 'node:assert/strict';
import {temporalNextGate,checkTemporalNextBudget,inspectTemporalDevelopment} from '../experiments/jev-spatial-refinement/run-temporal-next.ts';
import {generateTemporalNextCases} from '../experiments/jev-spatial-refinement/temporal-next.ts';
import {digest} from '../experiments/jev-spatial-text/transport.ts';
test('temporal follow-up cannot pass by returning unknown everywhere or origin labels alone',()=>{
  const base={calls:16,physicalAssertionCount:0,validOldSide:{correct:8,total:8},observedCurrentLocation:{correct:8,total:8},questions:{historical_origin:{correct:16,total:16},historical_position_usable:{correct:16,total:16}}};
  assert.equal(temporalNextGate(base).pass,true);
  assert.equal(temporalNextGate({...base,validOldSide:{correct:0,total:8}}).pass,false);
  assert.equal(temporalNextGate({...base,physicalAssertionCount:1}).pass,false);
  assert.equal(temporalNextGate({...base,validOldSide:{correct:1,total:1}}).pass,false);
  assert.equal(temporalNextGate({...base,observedCurrentLocation:{correct:0,total:8}}).pass,false);
  assert.equal(temporalNextGate({...base,questions:{...base.questions,historical_position_usable:{correct:8,total:16}}}).pass,false);
  assert.equal(temporalNextGate(undefined).pass,false);
});
test('temporal stage ceiling counts missing-usage and uncertain reservations before dispatch',()=>{
  const ids=new Set(Array.from({length:192},(_,i)=>`q${i}`));
  const rows=Array.from({length:38},(_,i)=>({id:`q${i}`,status:'completed',reserve:65536}));
  assert.throws(()=>checkTemporalNextBudget(rows,ids,'q38'),/ceiling reached/);
  assert.equal(checkTemporalNextBudget(rows.slice(0,37),ids,'q37').accountedTokens,37*65536);
  assert.equal(checkTemporalNextBudget(rows,ids,'q0').requests,38);
  assert.throws(()=>checkTemporalNextBudget([{id:'q0',status:'error',reserve:65536}],ids,'q0'),/cannot replay/);
  assert.throws(()=>checkTemporalNextBudget([],ids,'foreign'),/outside/);
  assert.throws(()=>checkTemporalNextBudget([{id:'q0',status:'completed',inputTokens:2500001}],ids,'q1'),/ceiling exceeded/);
});
test('temporal confirmation boundary rejects incomplete or altered development and accepts an appended suffix',()=>{
  const all=generateTemporalNextCases(),development=all.filter(c=>c.split==='development');
  const records=development.map(c=>({id:c.id,status:'completed',requestSha256:digest(JSON.stringify(c.request)),responseSha256:digest(c.id)}));
  const prefix=Buffer.from(records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const seal={primary:'valid_only__separate',casesSha256:digest(JSON.stringify(all)+'\n'),ledgerPrefixSha256:digest(prefix),ledgerPrefixBytes:prefix.length,responses:records.map(({status,...r})=>r)};
  inspectTemporalDevelopment(all,prefix,Buffer.concat([prefix,Buffer.from('confirmation suffix')]),seal);
  assert.throws(()=>inspectTemporalDevelopment(all,prefix,Buffer.from('changed'),seal),/prefix changed/);
  assert.throws(()=>inspectTemporalDevelopment(all,prefix,prefix,{...seal,responses:seal.responses.slice(1)}),/inventory changed/);
  const missing=Buffer.from(records.slice(1).map(r=>JSON.stringify(r)).join('\n')+'\n');
  assert.throws(()=>inspectTemporalDevelopment(all,missing,missing,{...seal,ledgerPrefixSha256:digest(missing),ledgerPrefixBytes:missing.length}),/Incomplete/);
  const premature=Buffer.concat([prefix,Buffer.from(JSON.stringify({id:all.find(c=>c.split==='confirmation')!.id})+'\n')]);
  assert.throws(()=>inspectTemporalDevelopment(all,premature,premature,{...seal,ledgerPrefixSha256:digest(premature),ledgerPrefixBytes:premature.length}),/Confirmation preceded/);
});
