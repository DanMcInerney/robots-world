import assert from 'node:assert/strict';
import test from 'node:test';
import { createTargetBinder } from '../experiments/jev-find-follow/target-binder.ts';
import type { StereoObject } from '../experiments/jev-find-follow/types.ts';

const goal = { classes: ['car'], colour: 'blue', description: 'the blue car', requestedRangeM: 8 };

function object(overrides: Partial<StereoObject>): StereoObject {
  return { class: 'car', score: 0.8, bearingRightRad: 0, bearingUpRad: 0, surfaceRangeM: 8, rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 400, boxNorm: [0.4, 0.4, 0.6, 0.6], dominantColor: 'blue', ...overrides };
}

test('binds unambiguously when exactly one object matches class and colour', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ bearingRightRad: 0.1 }), object({ class: 'truck', dominantColor: 'red' })]);
  assert.equal(result.status, 'bound');
  assert.equal(result.boundIndex, 0);
  assert.equal(result.candidates.length, 1);
});

test('reports none when nothing matches the goal', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ class: 'truck' }), object({ dominantColor: 'red' })]);
  assert.equal(result.status, 'none');
  assert.equal(result.boundIndex, null);
  assert.equal(result.candidates.length, 0);
});

test('filters on colour: a matching class but wrong colour is not a candidate', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ dominantColor: 'red' })]);
  assert.equal(result.status, 'none');
});

test('an altClasses match also counts as a class match', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ class: 'truck', altClasses: [{ class: 'car', score: 0.4 }] })]);
  assert.equal(result.status, 'bound');
});

test('two same-class, same-colour candidates with no prior binding are genuinely ambiguous, never a guess', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ bearingRightRad: -0.5 }), object({ bearingRightRad: 0.5 })]);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.boundIndex, null);
  assert.equal(result.candidates.length, 2);
});

test('continuity: once bound, a subsequent frame with a lookalike prefers the candidate nearest the previously bound bearing', () => {
  const binder = createTargetBinder(goal);
  const first = binder.bind([object({ bearingRightRad: 0.05 })]);
  assert.equal(first.status, 'bound');
  // Next frame: a second matching object appears far away (a lookalike entering view); continuity
  // must keep tracking the one near the last bound bearing, not flip to the new arrival.
  const second = binder.bind([object({ bearingRightRad: 0.06 }), object({ bearingRightRad: 1.2 })]);
  assert.equal(second.status, 'bound');
  assert.equal(second.candidates[second.boundIndex!]!.bearingRightRad, 0.06);
});

test('continuity refuses to resolve two candidates that are both similarly close to the last bound bearing (no >=2x margin): reports ambiguous, not a coin flip', () => {
  const binder = createTargetBinder(goal);
  binder.bind([object({ bearingRightRad: 0.1 })]);
  const result = binder.bind([object({ bearingRightRad: 0.13 }), object({ bearingRightRad: 0.14 })]);
  assert.equal(result.status, 'ambiguous');
});

test('losing the target (none) clears continuity: the next frame with two candidates is ambiguous again', () => {
  const binder = createTargetBinder(goal);
  binder.bind([object({ bearingRightRad: 0.1 })]);
  binder.bind([]); // lost
  const result = binder.bind([object({ bearingRightRad: -0.3 }), object({ bearingRightRad: 0.3 })]);
  assert.equal(result.status, 'ambiguous');
});

test('an unavailable range (rangeValid:false) is reported as null, never a guessed number', () => {
  const binder = createTargetBinder(goal);
  const result = binder.bind([object({ rangeValid: false, surfaceRangeM: null })]);
  assert.equal(result.status, 'bound');
  assert.equal(result.candidates[0]!.rangeM, null);
});
