import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPolicyPort } from '../integrations/policy-port.ts';
import { createNerveletEnvironment } from '../integrations/nervelet.ts';
import { createTrackingExperiment } from '../experiments/tracking.ts';
import { createTrackingBaseline } from '../experiments/compare.ts';
import { World } from '../src/world.ts';

test('actual Nervelet Bridge runs a local tracking job in Rapier while the operator waits', {skip:!process.env.ROBOTS_NERVELET_MODULE},async()=>{
  const specifier=process.env.ROBOTS_NERVELET_MODULE!;
  const {Bridge}=await import(specifier.startsWith('file:')?specifier:pathToFileURL(resolve(specifier)).href);
  const fixture=createTrackingExperiment({seed:11,occlusion:false});
  const world=await World.create(fixture.scenario,fixture.registry);
  let localCycles=0;
  const port=createPolicyPort(world.claim('drone','nervelet-e2e'),{track:async(child,signal)=>{
    const local=createTrackingBaseline(child);
    try { while(!signal.aborted) {
      const observed=await child.observe(); await local.tick(observed.simMs); localCycles++;
      await sleep(10,undefined,{signal});
    }} finally {local.close();}
  }});
  const bridge=new Bridge(await createNerveletEnvironment(port),'Track the target');
  let stepping:Promise<void>|undefined,physicsError:unknown;
  const timer=setInterval(()=>{
    if(stepping)return;
    stepping=(async()=>{fixture.update(world);await world.advance();})().catch(error=>{physicsError=error;}).finally(()=>{stepping=undefined;});
  },10);
  try {
    await bridge.start(); const first=await bridge.step({});
    const admitted=await bridge.step({seen:first.id,goalVersion:first.goal.version,commands:[{id:first.nextCommandId,kind:'run_policy',args:{name:'track'}}]});
    assert.equal(admitted.results[0].status,'accepted');
    let current=admitted;
    for(let i=0;i<4;i++) current=await bridge.step({seen:current.id,goalVersion:current.goal.version,waitMs:60});
    assert.equal(physicsError,undefined);
    assert.ok(localCycles>3,'local policy ran while Bridge handled waits');
    assert.ok(world.physics.body('drone/base').pose.position.x>.01,'actual plant responded');
    assert.ok(current.samples.target.value.visible);
    await bridge.updateGoal('Hold');
    const commands=world.journal.after().filter(e=>e.kind==='command.applied').length;
    await sleep(35);
    assert.equal(world.journal.after().filter(e=>e.kind==='command.applied').length,commands,'revoked local policy cannot keep issuing effects');
  } finally {clearInterval(timer);await stepping;await bridge.close();world.close();}
});
