import test from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import type { PhysicsBackend, RobotPlant } from '../src/contracts.ts';
import { pose, vec } from '../src/math.ts';
import { builtinModels, createAssetModel } from '../src/models/index.ts';
import { kinematicFactory, rapierFactory } from '../src/physics/index.ts';

const model = (id: string) => builtinModels.find(value => value.id === id)!;
async function run(physics: PhysicsBackend, plant: RobotPlant, count=600) { for (let i=0;i<count;i++) { plant.tick(1/120); await physics.step(1/120); } }
function floor(physics: PhysicsBackend) { physics.addBody({ id:'floor',pose:pose(0,0,-.25),mode:'fixed',shape:{kind:'box',size:vec(40,40,.5)} }); }

test('all builtin command schemas compile and reject unspecified arguments', () => {
  const ajv = new Ajv({ strict:true });
  for (const robot of builtinModels) for (const spec of Object.values(robot.commands)) { const validate=ajv.compile(spec.schema); assert.equal(validate({ unrecognized:1 }),false); }
  const validate = ajv.compile(model('arm').commands.joints.schema);
  assert.equal(validate({ positions:{ shoulder:.5,elbow:.2 } }),true);
  assert.equal(validate({ positions:{ unknown:1 } }),false);
  assert.equal(validate({ positions:{ shoulder:10 } }),false);
});

test('drone servo follows target under configured gravity and leaves other robots alone', async () => {
  const physics = await rapierFactory({ gravity:vec(0,0,-3.2) });
  try {
    floor(physics);
    const alpha=model('drone').create({id:'alpha',pose:pose(-2,0,2),physics,config:{}}), beta=model('drone').create({id:'beta',pose:pose(2,2,2),physics,config:{}});
    alpha.apply('goto',{x:1,y:0,z:3});
    for (let i=0;i<800;i++) { alpha.tick(1/120);beta.tick(1/120);await physics.step(1/120); }
    assert.equal(alpha.completed('goto',{x:1,y:0,z:3}),true);
    assert.ok(Math.abs(physics.body(beta.root).pose.position.z-2)<.01);
    assert.ok(Math.abs(physics.body(beta.root).pose.position.x-2)<.01);
    alpha.apply('velocity',{x:2,y:0,z:0});await run(physics,alpha,60);alpha.stop();const stopped=physics.body(alpha.root).pose.position;await run(physics,alpha,240);
    assert.ok(Math.abs(physics.body(alpha.root).pose.position.x-stopped.x)<.03);
  } finally { physics.close(); }
});

test('rover steers to planar target and rejects altitude commands', async () => {
  const physics=await rapierFactory({gravity:vec(0,0,-9.81)});
  try {
    floor(physics);const plant=model('rover').create({id:'car',pose:pose(-2,0,.2),physics,config:{}});
    plant.apply('goto',{x:1,y:1,z:.2});await run(physics,plant,1600);
    assert.equal(plant.completed('goto',{x:1,y:1,z:.2}),true,JSON.stringify(physics.body(plant.root)));
    assert.throws(()=>plant.apply('velocity',{x:0,y:0,z:1}),/vertical/);
    assert.throws(()=>plant.apply('goto',{x:0,y:0,z:4}),/altitude/);
    plant.apply('drive',{forward:1,yawRate:.5});await run(physics,plant,120);
    assert.ok(Math.abs(physics.body(plant.root).angularVelocity.z-.5)<.05);
  } finally {physics.close();}
});

test('arm joint commands move actual linked bodies and hold retains a pose', async () => {
  const physics=await rapierFactory({gravity:vec(0,0,-9.81)});
  try {
    floor(physics);const plant=model('arm').create({id:'arm',pose:pose(0,0,.3),physics,config:{}});
    const before=physics.body('arm/forearm').pose.position;
    const args={positions:{shoulder:.5,elbow:.35}};
    plant.apply('joints',args);await run(physics,plant,960);
    assert.equal(plant.completed('joints',args),true,JSON.stringify(plant.jointIds.map(id=>[id,physics.jointPosition(id)])));
    assert.ok(physics.body('arm/forearm').pose.position.z>before.z+.4);
    plant.stop();const held=physics.jointPosition('arm/shoulder');await run(physics,plant,240);
    assert.ok(Math.abs(physics.jointPosition('arm/shoulder')-held)<.08,`held ${held}, current ${physics.jointPosition('arm/shoulder')}`);
    assert.throws(()=>plant.apply('joints',{positions:{wrong:1}}),/invalid target/);
  } finally {physics.close();}
});

test('humanoid fixture articulates independently named limbs with fixed support', async () => {
  const physics=await rapierFactory({gravity:vec(0,0,-9.81)});
  try {
    floor(physics);const plant=model('humanoid').create({id:'humanoid',pose:pose(0,0,1.6),physics,config:{}});
    const args={positions:{left_hip:.25,left_knee:.4,right_shoulder:-.6}};
    plant.apply('joints',args);await run(physics,plant,1200);
    assert.equal(plant.completed('joints',args),true,JSON.stringify(plant.jointIds.map(id=>[id,physics.jointPosition(id)])));
    assert.equal(physics.body('humanoid/base').pose.position.z,Math.fround(1.6));
    assert.ok(Math.abs(physics.jointPosition('humanoid/right_hip'))<.08);
  } finally {physics.close();}
});

test('one kinematic model and control program run unchanged on either backend', async () => {
  for(const factory of [kinematicFactory,rapierFactory]) {
    const physics=await factory({gravity:vec(0,0,-9.81)});
    try { const plant=model('kinematic').create({id:'fixture',pose:pose(0,0,1),physics,config:{}});plant.apply('goto',{x:2,y:1,z:2});await run(physics,plant,1000);assert.equal(plant.completed('goto',{x:2,y:1,z:2}),true); }
    finally {physics.close();}
  }
});

test('custom assets remain generic and unsupported backend fails before bodies are created', async () => {
  const custom=createAssetModel('custom',{links:[{name:'base',pose:pose(),shape:{kind:'box',size:vec(.2,.2,.2)},mode:'fixed'},{name:'slider',pose:pose(1,0,0),shape:{kind:'box',size:vec(.5,.1,.1)},mode:'dynamic'}],joints:[{name:'hinge',parent:'base',child:'slider',kind:'revolute',anchorParent:vec(.75,0,0),anchorChild:vec(-.25,0,0),axis:vec(0,0,1)}]});
  const physics=await kinematicFactory({gravity:vec()});
  try { assert.throws(()=>custom.create({id:'robot',pose:pose(),physics,config:{}}),/lacks required capabilities/);assert.equal(physics.bodies().length,0); }
  finally {physics.close();}
});
