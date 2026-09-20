import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMenuCases, menuFrame, scoreMenu } from '../experiments/jev-top-five/menu.ts';
import { colorRegions } from '../src/perception/color-tracks.ts';
import { readFramePng } from '../src/devices/pixel-camera.ts';
import { validateRequest } from '../experiments/jev-spatial-text/transport.ts';

test('T4 preserves all physical effects, hold and exact evidence across factorization', () => {
  const cases = generateMenuCases(); assert.equal(cases.length, 128);
  for (const c of cases) {
    validateRequest(c.request);
    const counterpart = cases.find(p => p.split === c.split && p.unit === c.unit && p.meta.copies === c.meta.copies && p.replicate === c.replicate && p.arm !== c.arm)!;
    assert.deepEqual(c.request.state, counterpart.request.state);
    assert.deepEqual([...new Set(Object.values(c.meta.physicalById))].sort(), [-30, -10, -3, 0, 3, 10, 30].sort());
    assert.equal(Object.values(c.meta.physicalById).filter(v => v === 0).length, 1);
    const correctId = Object.keys(c.meta.physicalById).find(k => c.meta.expectedTurns.includes(c.meta.physicalById[k]))!;
    assert(scoreMenu(c, c.arm === 'flat' ? { action: correctId } : { mode: correctId === 'hold' ? 'hold' : 'move', maneuver: correctId === 'hold' ? 'v0_0' : correctId }).correct);
  }
});

test('T4 evidence PNG reproduces the actual detector input and excludes scene truth', () => {
  for (const split of ['development', 'confirmation'] as const) for (let i = 0; i < 8; i++) {
    const frame = menuFrame(split, i), decoded = readFramePng(frame.png);
    assert.deepEqual(decoded.data, frame.image.data);
    assert.deepEqual(colorRegions(decoded, frame.calibration).filter(r => r.color === 'blue'), [frame.region]);
  }
  for (const c of generateMenuCases()) {
    const wire = JSON.stringify(c.request);
    for (const forbidden of ['render-only-blue-box', 'expectedTurns', 'position', 'bodyId']) assert(!wire.includes(forbidden));
  }
});

test('T4 physical grading ignores duplicate aliases and inactive movement answers', () => {
  const cases = generateMenuCases();
  const c = cases.find(c => c.arm === 'conditional' && c.meta.currentFramed && c.meta.copies === 8)!;
  assert(scoreMenu(c, { mode: 'hold', maneuver: 'v0_7' }).correct);
  assert.equal(scoreMenu(c, { mode: 'move', maneuver: 'v0_7' }).details.inappropriateMotion, true);
  const moving = cases.find(c => c.arm === 'flat' && !c.meta.currentFramed && c.meta.copies === 8)!;
  const keys = Object.keys(moving.meta.physicalById).filter(k => moving.meta.expectedTurns.includes(moving.meta.physicalById[k]));
  assert.equal(keys.length, 8);
  for (const key of keys) assert(scoreMenu(moving, { action: key }).correct);
});
