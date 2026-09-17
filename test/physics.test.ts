import test from 'node:test';
import assert from 'node:assert/strict';
import type { BodySpec, PhysicsBackend } from '../src/contracts.ts';
import { pose, vec } from '../src/math.ts';
import { rotate } from '../src/math.ts';
import { inverse } from '../src/physics/shared.ts';
import { kinematicFactory, rapierFactory } from '../src/physics/index.ts';

const box = (id: string, x: number, mode: BodySpec['mode'] = 'dynamic'): BodySpec => ({ id, pose: pose(x,0,1), mode, mass: 1, shape: { kind: 'box', size: vec(1,1,1) } });
async function steps(physics: PhysicsBackend, count: number) { for (let i=0;i<count;i++) await physics.step(1/120); }

test('Rapier applies gravity and one-step forces without latching old actuation', async () => {
  const physics = await rapierFactory({ gravity: vec(0,0,-2) });
  try {
    physics.addBody(box('body',0)); physics.force('body',vec(0,0,2)); await physics.step(.05);
    assert.ok(Math.abs(physics.body('body').linearVelocity.z) < 1e-4);
    await physics.step(.05); assert.ok(physics.body('body').linearVelocity.z < -.09);
    assert.throws(() => physics.step(0),/timestep/);
  } finally { physics.close(); }
});

test('two separately named dynamic robots physically collide in one world', async () => {
  const physics = await rapierFactory({ gravity: vec() });
  try {
    physics.addBody(box('alpha/base',-2)); physics.addBody(box('beta/base',2));
    physics.velocity('alpha/base',vec(3,0,0)); physics.velocity('beta/base',vec(-3,0,0));
    let contact = false;
    for (let i=0;i<160;i++) { await physics.step(1/120); contact ||= physics.contacts().some(c => c.a === 'alpha/base' && c.b === 'beta/base'); }
    assert.equal(contact,true);
    assert.ok(physics.body('alpha/base').pose.position.x < physics.body('beta/base').pose.position.x);
    assert.ok(physics.body('beta/base').pose.position.x-physics.body('alpha/base').pose.position.x > .95);
  } finally { physics.close(); }
});

for (const [name,factory] of [['rapier',rapierFactory],['kinematic',kinematicFactory]] as const) {
  test(`${name} uses oriented shape rays, explicit exclusion, and detached snapshots`, async () => {
    const physics = await factory({ gravity: vec() });
    try {
      const obstacle = box('obstacle',0,'fixed'); obstacle.shape.size = vec(4,1,1); obstacle.pose.rotation = { x:0,y:0,z:Math.SQRT1_2,w:Math.SQRT1_2 };
      physics.addBody(obstacle);
      const hit = physics.ray(vec(-5,0,1),vec(2,0,0),20);
      assert.equal(hit?.body,'obstacle'); assert.ok(Math.abs(hit!.distance-4.5) < 1e-5);
      assert.equal(physics.ray(vec(-5,0,1),vec(1,0,0),20,['obstacle']),null);
      const state = physics.body('obstacle'); state.pose.position.x = 999;
      assert.equal(physics.body('obstacle').pose.position.x,0);
      assert.throws(() => physics.addBody(obstacle),/duplicate/);
    } finally { physics.close(); }
  });
}

test('kinematic backend explicitly rejects unsupported dynamics and joints', async () => {
  const physics = await kinematicFactory({ gravity: vec(0,0,-9.81) });
  try {
    assert.equal(physics.capabilities.includes('contacts'),false);
    assert.throws(() => physics.addBody(box('dynamic',0)),/dynamic bodies/);
    physics.addBody(box('fixture',0,'kinematic')); physics.velocity('fixture',vec(1,0,0)); await steps(physics,120);
    assert.ok(Math.abs(physics.body('fixture').pose.position.x-1)<1e-9);
    assert.equal(physics.body('fixture').pose.position.z,1);
    assert.throws(() => physics.force('fixture',vec()),/forces/);
    assert.throws(() => physics.addJoint({ id:'joint',parent:'a',child:'b',kind:'revolute',axis:vec(0,0,1),anchorParent:vec(),anchorChild:vec() }),/joints/);
  } finally { physics.close(); }
});

test('Rapier revolute motor moves a physical link, honors limits, and retains anchor', async () => {
  const physics = await rapierFactory({ gravity: vec() });
  try {
    physics.addBody({ ...box('base',0,'fixed'),shape:{kind:'sphere',size:vec(.2,.2,.2)} });
    physics.addBody({ ...box('arm',1),shape:{kind:'box',size:vec(2,.1,.1)} });
    physics.addJoint({ id:'hinge',parent:'base',child:'arm',kind:'revolute',axis:vec(0,0,1),anchorParent:vec(),anchorChild:vec(-1,0,0),limits:[-.8,.8] });
    physics.jointTarget('hinge',.6); await steps(physics,480);
    assert.ok(Math.abs(physics.jointPosition('hinge')-.6)<.025,`angle ${physics.jointPosition('hinge')}`);
    const point=physics.body('arm').pose.position;
    assert.ok(Math.abs(point.x-Math.cos(.6))<.03 && Math.abs(point.y-Math.sin(.6))<.03);
    assert.throws(() => physics.jointTarget('hinge',1),/limits/);
  } finally { physics.close(); }
});

test('revolute zero preserves authored child orientation instead of snapping custom assets', async () => {
  const physics=await rapierFactory({gravity:vec()});
  try {
    physics.addBody({...box('base',0,'fixed'),shape:{kind:'sphere',size:vec(.1,.1,.1)}});
    const child=box('child',1);child.pose.rotation={x:0,y:Math.sin(.2),z:0,w:Math.cos(.2)};
    physics.addBody(child);
    physics.addJoint({id:'hinge',parent:'base',child:'child',kind:'revolute',axis:vec(0,0,1),anchorParent:vec(),anchorChild:rotate(vec(-1,0,0),inverse(child.pose.rotation)),limits:[-1,1]});
    await steps(physics,120);
    assert.ok(Math.abs(physics.body('child').pose.rotation.y-Math.sin(.2))<1e-4);
    assert.ok(Math.abs(physics.jointPosition('hinge'))<1e-5);
    physics.jointTarget('hinge',.6);await steps(physics,480);
    const position=physics.body('child').pose.position;
    assert.ok(Math.abs(position.x-Math.cos(.6))<.03&&Math.abs(position.y-Math.sin(.6))<.03);
    assert.ok(Math.abs(physics.jointPosition('hinge')-.6)<.02);
  } finally {physics.close();}
});
