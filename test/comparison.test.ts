import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackingBaseline, distribution, runComparison, saveComparison, trackingCandidates } from '../experiments/compare.ts';
import type { ComparisonReport } from '../experiments/comparison-contract.ts';
import type { Observation } from '../src/contracts.ts';
import { World } from '../src/world.ts';
import { createTrackingExperiment } from '../experiments/tracking.ts';

test('zero-startup routine matches local control; repeated seed repeats physical evidence', async()=>{
  const options={seconds:3,seeds:[11],arms:['code-local','agent-routine'] as const,agentDelayMs:0};
  const first=await runComparison({...options,arms:[...options.arms]});
  const repeat=await runComparison({...options,arms:[...options.arms]});
  assert.equal(first.trials[0].finalStateHash,first.trials[1].finalStateHash,'capable routine is never artificially stalled after setup');
  assert.deepEqual(first.trials.map(t=>t.finalStateHash),repeat.trials.map(t=>t.finalStateHash));
  assert.equal(first.trials[0].metrics.calls,0);
  assert.equal(first.trials[0].traceCoverage.dropped,0);
});

test('injected decision overlaps acquisition, protocol stream, and physics with correlated receipts',async()=>{
  const report=await runComparison({seconds:3,seeds:[29],arms:['jev-local'],jevDelayMs:450});
  const trial=report.trials[0];
  const start=trial.trace.find(e=>e.kind==='experiment.decision.start')!;
  const complete=trial.trace.find(e=>e.kind==='experiment.decision.complete')!;
  assert.ok(complete.simMs-start.simMs>=450);
  const between=trial.trace.filter(e=>e.simMs>start.simMs&&e.simMs<complete.simMs);
  assert.ok(between.some(e=>e.channel==='sensor'));
  assert.ok(between.some(e=>e.channel==='protocol'&&e.kind==='rx'));
  const applied=trial.trace.find(e=>e.kind==='experiment.command'&&(e.data as any).decisionId!=='reflex')!;
  const binding=trial.trace.find(e=>e.kind==='experiment.wire.binding'&&(e.data as any).commandId===(applied.data as any).command.id)!;
  assert.ok(trial.trace.some(e=>e.kind==='command.applied'&&(e.data as any).command.id===(binding.data as any).wireCommandId));
  assert.ok(trial.metrics.sensorAgeAtCommandMs.max!>=450);
  assert.equal(trial.metrics.decisionLatencyWallMs.count,0,'fast-forward compute time is not a measured model latency');
  assert.equal(trial.evidence,'injected');
  assert.equal(trial.label,'Simulated fast selector');
});

test('total tracker loss causes holds and no hidden target decisions',async()=>{
  const report=await runComparison({seconds:2,seeds:[47],arms:['jev-local'],sensorDropout:1});
  const trial=report.trials[0];
  assert.equal(trial.metrics.calls,0);assert.equal(trial.metrics.holdMs,2000);
  assert.equal(trial.metrics.sensorAgeAtCommandMs.count,0,'missing sensing is not fresh zero-age evidence');
  assert.ok(trial.series.every(s=>Math.hypot(s.robot.x,s.robot.y)<.01));
});

test('live-mode transport fixture records wall timing, unknown usage, and explicit call budget',async()=>{
  let calls=0;
  const report=await runComparison({seconds:1,seeds:[11],arms:['jev-local'],liveJev:true,maxCalls:2,model:'offline-transport-fixture',
    judge:async request=>{calls++;return {choice:'follow',confidence:1,probabilities:Object.fromEntries(request.candidates.map(c=>[c.id,c.id==='follow'?1:0]))};}});
  assert.equal(calls,2);
  assert.equal(report.trials[0].metrics.decisionLatencyWallMs.count,2);
  assert.equal(report.trials[0].metrics.inputTokens,null);
  assert.equal(report.trials[0].metrics.costUsd,null);
  assert.equal(report.trials[0].evidence,'injected');
  assert.equal(report.trials[0].label,'Simulated fast selector','wall pacing alone does not make a fixture a live Jev trial');
  assert.ok(report.trials[0].trace.filter(event=>event.kind==='experiment.decision.start').every(event=>(event.data as any).evidence==='injected'));
});

test('full raw trace round-trips separately from the counted viewer preview',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'robots-comparison-'));
  try {
    const report=await runComparison({seconds:1,seeds:[11],arms:['code-local']});
    await saveComparison(report,join(directory,'comparison.json'));
    const manifest:ComparisonReport=JSON.parse(await readFile(join(directory,'comparison.json'),'utf8'));
    const full=JSON.parse(await readFile(join(directory,manifest.trials[0].traceArtifact!),'utf8'));
    assert.deepEqual(full,report.trials[0].trace);
    assert.equal(manifest.trials[0].traceCoverage.preview,80);
    assert.equal(manifest.trials[0].traceCoverage.dropped,0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('unknown latency has no fabricated zero and invalid configurations fail before inference',async()=>{
  assert.deepEqual(distribution([]),{count:0,p50:null,p95:null,p99:null,max:null});
  assert.equal(distribution([5,1,3,4,2]).p95,5);
  await assert.rejects(runComparison({liveJev:true}),/explicit JEV_MODEL/);
  await assert.rejects(runComparison({arms:['unknown'] as any}),/Invalid comparison arms/);
  await assert.rejects(runComparison({maxDecisionAgeMs:-1}),/maxDecisionAgeMs/);
  await assert.rejects(runComparison({maxSetpointAgeMs:Infinity}),/maxSetpointAgeMs/);
});

test('matched direct-agent and Jev delays have identical physical evidence and freshness limits',async()=>{
  const report=await runComparison({seconds:3,seeds:[11],arms:['agent-direct','jev-local'],agentDelayMs:1500,jevDelayMs:1500,occlusion:false});
  assert.equal(report.trials[0].finalStateHash,report.trials[1].finalStateHash);
  assert.equal(report.trials[0].metrics.discardedDecisions,0);
  assert.equal(report.trials[1].metrics.discardedDecisions,0);
  assert.equal(report.configuration.maxDecisionAgeMs,6000);
  assert.equal(report.configuration.maxSetpointAgeMs,12000);
  assert.ok(report.trials.every(trial=>trial.configuration.maxDecisionAgeMs===6000&&trial.configuration.maxSetpointAgeMs===12000));
  const strict=await runComparison({seconds:2,seeds:[11],arms:['agent-direct','jev-local'],agentDelayMs:1500,jevDelayMs:1500,maxDecisionAgeMs:500});
  assert.equal(strict.trials[0].finalStateHash,strict.trials[1].finalStateHash);
  assert.ok(strict.trials.every(trial=>trial.metrics.discardedDecisions===1&&trial.metrics.holdMs===2000));
});

test('deliberately selected hold counts as holding and keeps its decision provenance',async()=>{
  const report=await runComparison({seconds:1,seeds:[11],arms:['jev-local'],liveJev:true,maxCalls:2,model:'offline-hold-fixture',
    judge:async request=>({choice:'hold',confidence:1,probabilities:Object.fromEntries(request.candidates.map(candidate=>[candidate.id,candidate.id==='hold'?1:0]))})});
  const trial=report.trials[0];
  assert.equal(trial.metrics.holdMs,1000); assert.ok(trial.series.every(sample=>sample.held));
  const commands=trial.trace.filter(event=>event.kind==='experiment.command').map(event=>event.data as any);
  assert.ok(commands.some(command=>command.reason==='selected-hold'&&command.decisionId!=='reflex'));
});

test('wall latency ends at response arrival and separately records controller activation delay',async()=>{
  let responseWallMs=0;
  const report=await runComparison({seconds:1,seeds:[11],arms:['jev-local'],liveJev:true,maxCalls:1,model:'offline-timing-fixture',
    judge:async request=>{
      await new Promise(resolve=>setTimeout(resolve,20)); responseWallMs=Date.now();
      return {choice:'follow',confidence:1,probabilities:Object.fromEntries(request.candidates.map(candidate=>[candidate.id,candidate.id==='follow'?1:0]))};
    }});
  const trial=report.trials[0];
  const start=trial.trace.find(event=>event.kind==='experiment.decision.start')!;
  const complete=trial.trace.find(event=>event.kind==='experiment.decision.complete')!;
  const data=complete.data as any;
  assert.ok(Math.abs(data.arrivedWallMs-responseWallMs)<20);
  assert.ok(Math.abs(data.elapsedWallMs-(responseWallMs-start.wallMs))<20,'polling delay is not counted as model request latency');
  assert.ok(Math.abs(data.activationDelayWallMs-(complete.wallMs-responseWallMs))<20);
  assert.equal(trial.metrics.decisionLatencyWallMs.p50,data.elapsedWallMs);
  assert.equal(trial.metrics.decisionActivationDelayWallMs.p50,data.activationDelayWallMs);
  assert.equal(data.deadlineOverrunWallMs,0);
});

test('a response arriving after the live deadline is discarded even when ready before the next poll',async()=>{
  const report=await runComparison({seconds:2,seeds:[11],arms:['jev-local'],liveJev:true,maxCalls:1,model:'offline-blocked-event-loop-fixture',
    judge:async request=>{
      // Block controller polling to reproduce an already-ready response that crossed its deadline.
      const until=performance.now()+1220; while(performance.now()<until) { /* synthetic CPU pause */ }
      return {choice:'follow',confidence:1,probabilities:Object.fromEntries(request.candidates.map(candidate=>[candidate.id,candidate.id==='follow'?1:0]))};
    }});
  const trial=report.trials[0];
  assert.equal(trial.metrics.discardedDecisions,1); assert.equal(trial.metrics.holdMs,2000);
  assert.ok(trial.trace.some(event=>event.kind==='experiment.discarded'&&(event.data as any).reason==='live-deadline'));
  const complete=trial.trace.find(event=>event.kind==='experiment.decision.complete')!.data as any;
  assert.ok(complete.elapsedWallMs>=1200); assert.ok(complete.deadlineOverrunWallMs>0);
  assert.equal(trial.trace.filter(event=>event.kind==='experiment.decision.selected').length,0);
});

test('delayed relative tracking is translated using its own acquisition origin',()=>{
  const observation:Observation={epoch:'epoch',robotId:'drone',sequence:1,simMs:1000,wallMs:0,goal:'',jobs:[],events:[],inbox:[],sensors:{
    odometry:{value:{position:{x:4,y:0,z:1}},sequence:2,acquiredSimMs:1000,receivedSimMs:1000,valid:true},
    target:{value:{visible:true,frame:'world-ENU',origin:{x:0,y:0,z:1},relative:{x:10,y:0,z:0}},sequence:1,acquiredSimMs:500,receivedSimMs:1000,valid:true},
  }};
  assert.deepEqual(trackingCandidates(observation).find(candidate=>candidate.id==='follow')!.command!.args,{x:8.8,y:0,z:1});
  (observation.sensors.target.value as Record<string,any>).origin=undefined;
  assert.deepEqual(trackingCandidates(observation).map(candidate=>candidate.id),['hold']);
});

test('viewer baseline consumes the tracking RobotPort and closes without further commands',async()=>{
  const setup=createTrackingExperiment({seed:11,occlusion:false});
  const world=await World.create(setup.scenario,setup.registry);
  const records:{kind:string;data:unknown}[]=[];
  const baseline=createTrackingBaseline(world.claim('drone','viewer-baseline'),(kind,data)=>records.push({kind,data}));
  try {
    for(let tick=0;tick<50;tick++) { await baseline.tick(world.simMs); setup.update(world); await world.advance(); }
    assert.ok(world.physics.body('drone/base').pose.position.x>.1);
    assert.ok(records.some(event=>event.kind==='experiment.local.decision'));
    const count=records.length; baseline.close(); await baseline.tick(world.simMs+100);
    assert.equal(records.length,count);
  } finally { baseline.close(); world.close(); }
});
