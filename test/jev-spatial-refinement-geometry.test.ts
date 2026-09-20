import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateGeometryCases, GEOMETRY_ACTIONS, GEOMETRY_GOAL_BAND_DEG,
  GEOMETRY_REPRESENTATIONS, GEOMETRY_HEADS, type RefineCase,
} from '../experiments/jev-spatial-refinement/geometry.ts';

const all = generateGeometryCases();
const rawSingles = all.filter(c => c.meta.representation === 'raw' && c.meta.heads === 'action-only' && c.replicate === 0);
function groups(cases: RefineCase[], key: (c: RefineCase) => string) {
  const out = new Map<string, RefineCase[]>();
  for (const c of cases) out.set(key(c), [...(out.get(key(c)) ?? []), c]);
  return out;
}
const mirroredAction = (id: string) => id.replace('left_', 'temporary_').replace('right_', 'left_').replace('temporary_', 'right_');
const near = (a: number, b: number, label: string) => assert(Math.abs(a - b) < 1e-7, `${label}: ${a} != ${b}`);
const degrees = (r: number) => r * 180 / Math.PI;
const radians = (d: number) => d * Math.PI / 180;

// Independent vector oracle: project a stationary world ray into the final camera basis.
// It intentionally does not use the generator's additive-bearing or wrap functions.
function independentOutcome(c: RefineCase, action: string) {
  const s = c.request.state.synthetic_acquisition;
  const acquired = radians(s.acquired_heading_left_deg);
  const offset = GEOMETRY_ACTIONS[action as keyof typeof GEOMETRY_ACTIONS];
  const final = offset === null ? radians(s.previously_accepted_absolute_heading_left_deg) : acquired + radians(offset);
  const targetWorldAngle = acquired - radians(s.target.center_image_right_deg);
  const forward = [Math.cos(final), Math.sin(final)];
  const right = [Math.sin(final), -Math.cos(final)];
  const project = (worldAngle: number) => {
    const worldRay = [Math.cos(worldAngle), Math.sin(worldAngle)];
    return degrees(Math.atan2(worldRay[0]! * right[0]! + worldRay[1]! * right[1]!, worldRay[0]! * forward[0]! + worldRay[1]! * forward[1]!));
  };
  const bearing = project(targetWorldAngle);
  const leftEdge = project(targetWorldAngle + radians(s.target.angular_extent_left_of_center_deg));
  const rightEdge = project(targetWorldAngle - radians(s.target.angular_extent_right_of_center_deg));
  const visible = leftEdge >= -35 - 1e-8 && rightEdge <= 35 + 1e-8;
  const category = !visible ? 'not_fully_visible' : bearing < -5 - 1e-8 ? 'left' : bearing > 5 + 1e-8 ? 'right' : 'center';
  const actualYaw = degrees(Math.atan2(Math.sin(final - acquired), Math.cos(final - acquired)));
  return {bearing, leftEdge, rightEdge, visible, category, actualYaw};
}

test('geometry allocation freezes 32 fresh states, paired units, two head sets and byte-identical replicate requests', () => {
  assert.equal(all.length, 512);
  assert.equal(rawSingles.length, 32);
  assert.equal(new Set(all.map(c => c.id)).size, 512);
  assert.deepEqual(all, generateGeometryCases());
  for (const split of ['development', 'confirmation']) {
    const batch = all.filter(c => c.split === split);
    assert.equal(batch.length, 256);
    assert.equal(new Set(batch.map(c => c.unit)).size, 8);
    assert.equal(new Set(batch.map(c => c.meta.stateId)).size, 16);
    for (const representation of GEOMETRY_REPRESENTATIONS) for (const heads of GEOMETRY_HEADS) {
      assert.equal(batch.filter(c => c.meta.representation === representation && c.meta.heads === heads).length, 32);
    }
  }
  for (const batch of groups(all, c => c.unit).values()) {
    assert.equal(new Set(batch.map(c => c.split)).size, 1);
    assert.deepEqual(new Set(batch.map(c => c.meta.mirror)), new Set([false, true]));
  }
  for (const batch of groups(all, c => c.meta.replicateGroup).values()) {
    assert.equal(batch.length, 2);
    assert.deepEqual(batch.map(c => c.replicate), [0, 1]);
    assert.equal(JSON.stringify(batch[0]!.request), JSON.stringify(batch[1]!.request));
    assert.deepEqual(batch[0]!.expected, batch[1]!.expected);
  }
  assert.equal(new Set(rawSingles.map(c => JSON.stringify(c.request.state.synthetic_acquisition))).size, 32);
});

test('Choice payloads preserve literal action semantics, independent named forecasts and evaluator separation', () => {
  for (const c of all) {
    assert.equal(c.request.model, 'jev-1.13.0');
    assert.match(c.request.state.evidence_notice, /Invented synthetic geometry/);
    assert.match(c.request.state.evidence_notice, /not a current camera image/);
    assert.match(c.request.state.physical_hypothesis, /stationary in the world/);
    assert.match(c.request.state.control_semantics, /REPLACES/);
    assert.match(c.request.state.control_semantics, /unfinished turn continues/);
    assert.deepEqual(Object.keys(c.expected), Object.keys(c.request.questions));
    assert.equal(Object.keys(c.request.questions).length, c.meta.heads === 'action-only' ? 1 : 8);
    assert.deepEqual(Object.keys(c.request.questions.action!.criteria), Object.keys(GEOMETRY_ACTIONS));
    assert.match(c.request.questions.action!.instructions, /smallest absolute value/);
    for (const [id, q] of Object.entries(c.request.questions)) {
      assert.equal(q.type, 'choice');
      assert(Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 255);
      for (const answer of c.expected[id]!) assert(answer in q.criteria);
      if (id.startsWith('forecast_')) {
        const action = id.slice('forecast_'.length);
        assert(q.instructions.includes(`specifically for ${action}:`));
        assert(q.instructions.includes(c.request.questions.action!.criteria[action]!));
        assert.match(q.instructions, /does not receive the action answer/);
        assert(!('abstain' in q.criteria));
        assert.equal(c.meta.forecastBranchByAction[action], id);
      }
    }
    assert(Buffer.byteLength(JSON.stringify(c.request)) < 18000, c.id);
    const payload = JSON.stringify(c.request);
    for (const forbidden of ['isOptimal', 'improves', 'improvementDeg', 'optimumAbsBearingDeg', 'perAction', 'rawFactsManifest', 'stateId', 'expected']) {
      assert(!payload.includes(`"${forbidden}"`), `${c.id} leaked ${forbidden}`);
    }
  }
});

test('all representation and head contrasts retain precisely the same underlying facts and action objective', () => {
  for (const batch of groups(all, c => c.meta.stateId).values()) {
    assert.equal(batch.length, 16);
    assert.equal(new Set(batch.map(c => JSON.stringify(c.request.state.synthetic_acquisition))).size, 1);
    assert.equal(new Set(batch.map(c => c.meta.rawFactsManifest)).size, 1);
    assert.equal(new Set(batch.map(c => c.request.state.physical_hypothesis)).size, 1);
    assert.equal(new Set(batch.map(c => c.request.state.component_goal)).size, 1);
    assert.equal(new Set(batch.map(c => JSON.stringify(c.request.questions.action))).size, 1);
    assert.equal(new Set(batch.map(c => JSON.stringify(c.expected.action))).size, 1);
    for (const c of batch) {
      assert.equal(JSON.stringify(c.request.state.synthetic_acquisition), c.meta.rawFactsManifest);
      const derived = c.request.state.declared_computation;
      if (c.meta.representation === 'raw') assert.equal(derived, undefined);
      else if (c.meta.representation === 'current-relations') {
        assert.equal(derived.conditional_consequences, undefined);
        assert.match(derived.source, /present-state relations/);
        near(derived.accepted_setpoint_remaining_yaw_left_deg, independentOutcome(c, 'retain').actualYaw, c.id);
        assert.equal(derived.accepted_setpoint_relative_to_acquired_heading,
          derived.accepted_setpoint_remaining_yaw_left_deg > 0 ? 'left' : derived.accepted_setpoint_remaining_yaw_left_deg < 0 ? 'right' : 'midline');
      } else {
        assert.match(derived.source, /EVERY offered action/);
        assert.match(derived.source, /not observations/);
        assert.deepEqual(derived.conditional_consequences.map((r: any) => r.action), Object.keys(GEOMETRY_ACTIONS));
        for (const row of derived.conditional_consequences) {
          const independent = independentOutcome(c, row.action);
          near(row.after_image_right_bearing_deg, independent.bearing, `${c.id}/${row.action}`);
          near(row.actual_yaw_left_deg, independent.actualYaw, `${c.id}/${row.action}/yaw`);
          if (c.meta.representation === 'after-relations') {
            assert.equal(row.physical_view_category, independent.category);
            assert.equal(row.entire_target_rectangle_inside_view, independent.visible);
          } else assert.equal(row.physical_view_category, undefined);
        }
      }
    }
  }
});

test('independent world-ray oracle verifies forecasts, tied optima and nonoptimal/improvement diagnostics', () => {
  let tiedStates = 0, retainedBestUnfinished = 0, clips = 0, helpfulNonoptimal = 0;
  for (const c of rawSingles) {
    const outcomes = Object.fromEntries(Object.keys(GEOMETRY_ACTIONS).map(action => [action, independentOutcome(c, action)]));
    const minimum = Math.min(...Object.values(outcomes).map(v => Math.abs(v.bearing)));
    const optimal = Object.entries(outcomes).filter(([, v]) => Math.abs(Math.abs(v.bearing) - minimum) < 1e-7).map(([id]) => id);
    assert.deepEqual(c.expected.action, optimal, c.id);
    if (optimal.length > 1) tiedStates++;
    if (optimal.includes('retain') && Math.abs(c.meta.retainedRemainingYawLeftDeg) > 0) retainedBestUnfinished++;
    for (const [action, outcome] of Object.entries(outcomes)) {
      const m = c.meta.perAction[action];
      near(m.afterImageRightDeg, outcome.bearing, `${c.id}/${action}`);
      near(m.actualYawLeftDeg, outcome.actualYaw, `${c.id}/${action}/yaw`);
      assert.equal(m.physicalCategory, outcome.category);
      assert.equal(m.fullyVisible, outcome.visible);
      assert.equal(m.insideGoalBand, outcome.visible && Math.abs(outcome.bearing) <= GEOMETRY_GOAL_BAND_DEG);
      assert.equal(m.improves, Math.abs(outcome.bearing) < Math.abs(c.meta.geometry.bearing) - 1e-7);
      if (!outcome.visible) clips++;
      if (m.improves && !m.isOptimal) helpfulNonoptimal++;
      // Threshold robustness; intentionally tied ACTION optima are handled above.
      assert(Math.abs(Math.abs(outcome.bearing) - 5) > 0.05);
      assert(Math.abs(Math.abs(outcome.bearing) - GEOMETRY_GOAL_BAND_DEG) > 0.05);
      assert(Math.abs(outcome.leftEdge + 35) > 0.05);
      assert(Math.abs(outcome.rightEdge - 35) > 0.05);
    }
  }
  assert.equal(tiedStates, 4);
  assert.equal(retainedBestUnfinished, 8);
  assert(clips > 20);
  assert(helpfulNonoptimal > 20);
  for (const c of all.filter(c => c.meta.heads === 'action-and-forecasts')) for (const action of Object.keys(GEOMETRY_ACTIONS)) {
    assert.deepEqual(c.expected[`forecast_${action}`], [independentOutcome(c, action).category]);
  }
});

test('mirror physics reverses side and yaw while preserving scoring, clipping and asymmetric target extents', () => {
  for (const pair of groups(rawSingles, c => c.unit).values()) {
    const original = pair.find(c => !c.meta.mirror)!;
    const mirror = pair.find(c => c.meta.mirror)!;
    assert.equal(original.meta.geometry.leftExtent, mirror.meta.geometry.rightExtent);
    assert.equal(original.meta.geometry.rightExtent, mirror.meta.geometry.leftExtent);
    assert.notEqual(original.meta.geometry.leftExtent, original.meta.geometry.rightExtent);
    assert.deepEqual(new Set(original.expected.action!.map(mirroredAction)), new Set(mirror.expected.action));
    for (const action of Object.keys(GEOMETRY_ACTIONS)) {
      const a = original.meta.perAction[action], b = mirror.meta.perAction[mirroredAction(action)];
      near(a.afterImageRightDeg, -b.afterImageRightDeg, `${original.unit}/${action}`);
      near(a.actualYawLeftDeg, -b.actualYawLeftDeg, `${original.unit}/${action}/yaw`);
      assert.equal(a.fullyVisible, b.fullyVisible);
      assert.equal(a.improves, b.improves);
      assert.equal(a.insideGoalBand, b.insideGoalBand);
      assert.equal(a.isOptimal, b.isOptimal);
      assert.equal(a.turnDirection, b.turnDirection);
      assert.equal(b.physicalCategory, a.physicalCategory === 'left' ? 'right' : a.physicalCategory === 'right' ? 'left' : a.physicalCategory);
    }
  }
});

test('fresh bank actually exercises wrapped absolute headings, unfinished retain, settled retain and initial FOV edges', () => {
  let wrappedCommand = 0, wrappedAccepted = 0, settled = 0, unfinished = 0, edge = 0;
  for (const c of rawSingles) {
    const s = c.request.state.synthetic_acquisition;
    assert.notEqual(s.acquired_heading_left_deg, 0);
    assert(c.meta.currentFullyVisible);
    if (Math.abs(s.target.center_image_right_deg) > 30) edge++;
    if (s.accepted_setpoint_execution_at_acquisition === 'reached and settled') {
      settled++;
      near(c.meta.perAction.retain.afterImageRightDeg, s.target.center_image_right_deg, c.id);
      assert.equal(c.meta.perAction.retain.actualYawLeftDeg, 0);
    } else {
      unfinished++;
      assert.notEqual(c.meta.perAction.retain.actualYawLeftDeg, 0);
      assert.notEqual(c.meta.perAction.retain.afterImageRightDeg, s.target.center_image_right_deg);
    }
    if (Math.abs(s.previously_accepted_absolute_heading_left_deg - s.acquired_heading_left_deg) > 180) wrappedAccepted++;
    for (const [action, delta] of Object.entries(GEOMETRY_ACTIONS)) if (delta !== null) {
      near(c.meta.perAction[action].actualYawLeftDeg, delta, `${c.id}/${action}`);
      if (s.acquired_heading_left_deg + delta >= 180 || s.acquired_heading_left_deg + delta < -180) wrappedCommand++;
    }
  }
  assert.equal(settled, 16);
  assert.equal(unfinished, 16);
  assert.equal(edge, 4);
  assert(wrappedCommand > 10);
  assert(wrappedAccepted > 0);
});
