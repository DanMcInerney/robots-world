import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MENU, buildSpeedHoldMenu, planManeuver, planTrackManeuver, RANGE_RAMP_COMPENSATION_MS, SPEED_HOLD_MENU, TRACK_RANGE_MENU, TRACK_YAW_MENU, DEFAULT_YAW_RATE_DEG_S } from '../experiments/jev-find-follow/maneuver.ts';

// engine-review-e3 finding A2 ("no-retreat ratchet" / menu declared per scenario).
test('A2: SPEED_HOLD_MENU has negative (retreat) options and a top option clearing the declared 3.0 m/s ceiling by >=1 m/s', () => {
  const speeds = Object.values(SPEED_HOLD_MENU).filter(d => d.kind === 'speed_hold').map(d => d.speedMps!);
  assert.ok(speeds.some(s => s < 0), `expected at least one negative (retreat) option, got speeds: ${speeds.join(',')}`);
  assert.ok(Math.min(...speeds) <= -0.5, 'expected a retreat option of at least -0.5 m/s');
  assert.ok(Math.max(...speeds) >= 3.0 + 1.0, `expected the top option to clear 3.0 m/s by >=1 m/s, got max ${Math.max(...speeds)}`);
});

test('A2: buildSpeedHoldMenu(maxTargetSpeedMps) sizes its top option per rung, never less than a 1 m/s catch-up margin', () => {
  for (const maxTargetSpeedMps of [0.5, 1, 1.5, 2, 2.5]) {
    const menu = buildSpeedHoldMenu(maxTargetSpeedMps);
    const speeds = Object.values(menu).filter(d => d.kind === 'speed_hold').map(d => d.speedMps!);
    assert.ok(Math.max(...speeds) >= maxTargetSpeedMps + 1.0, `max target ${maxTargetSpeedMps}: expected top option >= ${maxTargetSpeedMps + 1}, got ${Math.max(...speeds)}`);
    assert.ok(speeds.some(s => s < 0), `max target ${maxTargetSpeedMps}: expected a retreat option`);
    assert.ok('hold' in menu, 'the id "hold" must always be present (0 m/s), matching TRACK_RANGE_MENU\'s own convention');
  }
});

test('A2: a chosen negative speed-hold option moves the drone AWAY from the target (retreating), not toward it', () => {
  const menu = buildSpeedHoldMenu(2.0);
  const retreatId = Object.entries(menu).find(([, d]) => d.kind === 'speed_hold' && d.speedMps === -1)?.[0];
  assert.ok(retreatId, 'expected a -1.0 m/s retreat option to exist');
  const planned = planTrackManeuver('hold', retreatId!, { headingDeg: 0 }, { leaseMs: 1500 }, menu);
  // Heading 0 (facing +x, the current bearing to target): a retreat should move in -x.
  assert.ok((planned.primary.args.x as number) < 0, `expected negative x velocity (retreating), got ${planned.primary.args.x}`);
});

const ownState = { headingDeg: 0, position: { x: 0, y: 0, z: 1.8 } };

test('hold maps to the hold action with no numeric args, for the full lease', () => {
  const planned = planManeuver(DEFAULT_MENU, 'hold', ownState, { leaseMs: 1500 });
  assert.equal(planned.action, 'hold');
  assert.deepEqual(planned.args, {});
  assert.equal(planned.validForMs, 1500);
});

test('a yaw maneuver becomes exactly one velocity command whose validForMs equals the time needed to complete the turn, not the full lease', () => {
  const planned = planManeuver(DEFAULT_MENU, 'yaw_left_30', ownState, { leaseMs: 5000 });
  assert.equal(planned.action, 'velocity');
  assert.equal(planned.args.x, 0);
  assert.equal(planned.args.y, 0);
  assert.ok(Math.abs((planned.args.yawRate as number) - DEFAULT_YAW_RATE_DEG_S * Math.PI / 180) < 1e-5); // left = positive yawRate
  assert.equal(planned.validForMs, Math.round(30 / DEFAULT_YAW_RATE_DEG_S * 1000));
  assert.ok(planned.validForMs < 5000, 'the turn must not run for the whole decision lease, or it would overshoot');
});

test('a right yaw uses a negative yawRate', () => {
  const planned = planManeuver(DEFAULT_MENU, 'yaw_right_60', ownState, { leaseMs: 5000 });
  assert.ok((planned.args.yawRate as number) < 0);
});

// engine-review-e3 finding 3: this test used to assert the OLD (buggy) behaviour — a yaw capped at
// the lease, which is EXACTLY what made `turn_180` realise 150deg instead of 180deg at the default
// 1500ms lease/100deg/s rate (1800ms nominal, truncated to 1500ms). A yaw is a self-bounded action
// (it naturally stops once its own declared degrees complete); the lease is not the right ceiling.
test('a yaw is sized to its OWN true completion time, never capped at the lease (turn_180 at a short lease still gets its full nominal duration)', () => {
  const planned = planManeuver(DEFAULT_MENU, 'turn_180', ownState, { leaseMs: 100 });
  assert.equal(planned.validForMs, Math.round(180 / DEFAULT_YAW_RATE_DEG_S * 1000), 'turn_180 must be sized to its own full nominal duration regardless of a short lease');
  assert.ok(planned.validForMs > 100, 'the whole point of this regression: the duration must exceed a short lease, not be truncated to it');
});

test('a translate maneuver becomes a goto command to current position plus the requested distance along the requested direction', () => {
  const planned = planManeuver(DEFAULT_MENU, 'approach_2m', { headingDeg: 0, position: { x: 5, y: 5, z: 1.8 } }, { leaseMs: 1500 });
  assert.equal(planned.action, 'goto');
  assert.ok(Math.abs((planned.args.x as number) - 7) < 1e-6); // heading 0 = +X, approach = forward
  assert.ok(Math.abs((planned.args.y as number) - 5) < 1e-6);
  assert.equal(planned.args.z, 1.8, 'altitude is held fixed by a translate maneuver');
});

test('a strafe direction is perpendicular to the current heading', () => {
  const left = planManeuver(DEFAULT_MENU, 'strafe_left', { headingDeg: 0, position: { x: 0, y: 0, z: 1.8 } }, { leaseMs: 1500 });
  assert.ok(Math.abs(left.args.x as number) < 1e-6);
  assert.ok((left.args.y as number) > 0);
});

test('a veto (blocked clearance) replaces the translate with hold and is logged, never silently swapped for a different translate', () => {
  const planned = planManeuver(DEFAULT_MENU, 'approach_2m', ownState, { leaseMs: 1500, blockedWithinM: 1 });
  assert.equal(planned.action, 'hold');
  assert.ok(planned.vetoed && planned.vetoed.includes('approach_2m'));
});

test('a veto only fires when the measured clearance is actually less than the requested distance', () => {
  const planned = planManeuver(DEFAULT_MENU, 'approach_1m', ownState, { leaseMs: 1500, blockedWithinM: 5 });
  assert.equal(planned.action, 'goto');
  assert.equal(planned.vetoed, undefined);
});

test('an unknown maneuver id throws rather than silently defaulting', () => {
  assert.throws(() => planManeuver(DEFAULT_MENU, 'not-a-real-maneuver', ownState, { leaseMs: 1500 }));
});

test('the maneuver executor never itself decides which maneuver to run: planManeuver only translates an ALREADY-CHOSEN id into a command', () => {
  // Structural: planManeuver's signature takes the maneuver id as an input, not as an output —
  // exercised here by confirming two different chosen ids produce two different commands from
  // otherwise identical own-state, i.e. the id alone determines the outcome.
  const a = planManeuver(DEFAULT_MENU, 'yaw_left_10', ownState, { leaseMs: 1500 });
  const b = planManeuver(DEFAULT_MENU, 'yaw_right_10', ownState, { leaseMs: 1500 });
  assert.notDeepEqual(a, b);
});

test('planTrackManeuver composes a chosen yaw option and a chosen range option into a primary simultaneous velocity command', () => {
  const planned = planTrackManeuver('yaw_left_30', 'approach_1m', { headingDeg: 0 }, { leaseMs: 1500 });
  assert.equal(planned.primary.action, 'velocity');
  assert.ok((planned.primary.args.yawRate as number) > 0, 'left yaw component present');
  assert.ok((planned.primary.args.x as number) > 0, 'approach (forward) component present along heading 0');
});

test('planTrackManeuver caps the primary command to the chosen yaw\'s own completion time, never the full lease (regression: a combined command must not keep yawing past its declared degrees while the lease has not yet expired)', () => {
  const planned = planTrackManeuver('yaw_left_60', 'hold', { headingDeg: 0 }, { leaseMs: 1500 });
  const expectedTurnMs = Math.round(60 / DEFAULT_YAW_RATE_DEG_S * 1000);
  assert.equal(planned.primary.validForMs, expectedTurnMs);
  assert.ok(planned.primary.validForMs < 1500, 'must not run for the whole lease, or the drone overshoots its chosen yaw');
  assert.equal(planned.followUp, null, 'a hold range has no independent life of its own once the yaw finishes');
});

// Increment B3 "must be TRUE" regression: pre-fix, EVERY fixed-distance range option shared one
// constant speed and ran for the full lease regardless of its own declared distance, so
// approach_1m and approach_2m were indistinguishable in actual execution.
// engine-review-e3 finding 3: the printed distance's own duration now includes the measured
// ramp-compensation offset (RANGE_RAMP_COMPENSATION_MS) so the REALISED distance matches the
// PRINTED one on real physics (see maneuver.ts's own docstring for the measured figures).
test('planTrackManeuver with a hold yaw caps the primary command to the chosen RANGE option\'s own completion time (incl. ramp compensation), not the full lease', () => {
  const planned = planTrackManeuver('hold', 'approach_1m', { headingDeg: 0 }, { leaseMs: 1500 });
  const expectedDistanceMs = Math.round(1 / 1.0 * 1000) + RANGE_RAMP_COMPENSATION_MS; // TRACK_RANGE_MENU.approach_1m.distanceM=1, TRANSLATE_SPEED_MPS=1.0
  assert.equal(planned.primary.validForMs, expectedDistanceMs);
  assert.ok(planned.primary.validForMs < 1500, 'must not run for the whole lease, or the drone overshoots its printed 1m step');
});
test('planTrackManeuver with a hold yaw AND a hold range uses the full lease (no yaw or distance to overshoot)', () => {
  const planned = planTrackManeuver('hold', 'hold', { headingDeg: 0 }, { leaseMs: 1500 });
  assert.equal(planned.primary.validForMs, 1500);
  assert.equal(planned.followUp, null);
});
test('planTrackManeuver: a longer printed distance (approach_2m) gets a proportionally longer primary duration than a shorter one (approach_1m), both under a hold yaw', () => {
  const short = planTrackManeuver('hold', 'approach_1m', { headingDeg: 0 }, { leaseMs: 5000 });
  const long = planTrackManeuver('hold', 'approach_2m', { headingDeg: 0 }, { leaseMs: 5000 });
  assert.ok(long.primary.validForMs > short.primary.validForMs, 'approach_2m must run longer than approach_1m now that both are capped to their own printed distance');
  // The FIXED ramp-compensation offset is additive (not multiplicative), so doubling the printed
  // distance no longer exactly doubles the total duration — it cancels out of the DIFFERENCE
  // instead: the extra 1000ms of nominal distance-time must show up exactly, uncompensated twice.
  assert.equal(long.primary.validForMs - short.primary.validForMs, 1000);
});

test('planTrackManeuver with both hold options yields zero velocity and zero yaw rate', () => {
  const planned = planTrackManeuver('hold', 'hold', { headingDeg: 0 }, { leaseMs: 1500 });
  assert.equal(planned.primary.args.x, 0);
  assert.equal(planned.primary.args.y, 0);
  assert.equal(planned.primary.args.yawRate, 0);
});

// engine-review-e2 finding 2, the central regression: a speed-hold choice must persist for its own
// full lease REGARDLESS of a concurrent yaw choice, via a follow-up command once the (shorter) yaw
// finishes — pre-fix, the combined command died with the yaw (measured: 0.00 m/s).
test('planTrackManeuver: speed-hold persists via a follow-up once a shorter yaw completes (the yaw_left_10 + speed_1_0 regression)', () => {
  const planned = planTrackManeuver('yaw_left_10', 'speed_1_0', { headingDeg: 0 }, { leaseMs: 1500 }, SPEED_HOLD_MENU);
  const yawMs = planned.yawOwnDurationMs;
  assert.ok(yawMs > 0 && yawMs < 1500, 'the yaw axis must have a short, real completion time');
  assert.equal(planned.primary.validForMs, yawMs, 'the primary command lives exactly as long as the yaw');
  assert.ok((planned.primary.args.x as number) > 0, 'forward speed IS present during the primary (yawing) phase');
  assert.ok(planned.followUp !== null, 'a follow-up must continue the speed after the yaw finishes');
  assert.equal(planned.followUp!.afterMs, yawMs);
  assert.equal(planned.followUp!.command.validForMs, 1500 - yawMs, 'the follow-up covers the REST of the lease');
  assert.equal(planned.followUp!.command.args.yawRate, 0, 'yaw is already done by the time the follow-up runs');
  assert.ok((planned.followUp!.command.args.x as number) > 0, 'forward speed CONTINUES in the follow-up — this is the fix');
});
test('planTrackManeuver: a zero-speed speed-hold ("hold") produces no follow-up, same as a fixed-distance hold', () => {
  const planned = planTrackManeuver('yaw_left_30', 'hold', { headingDeg: 0 }, { leaseMs: 1500 }, SPEED_HOLD_MENU);
  assert.equal(planned.followUp, null);
});
test('planTrackManeuver: with a hold yaw, speed-hold runs as the primary for the whole lease (no yaw to outlast)', () => {
  const planned = planTrackManeuver('hold', 'speed_1_0', { headingDeg: 0 }, { leaseMs: 1500 }, SPEED_HOLD_MENU);
  assert.equal(planned.primary.validForMs, 1500);
  assert.equal(planned.followUp, null);
});

// Regression found while measuring the E3 acceptance runs: episode.ts's decision-dispatch gating
// (`boundedCompletionMs(yawOwnDurationMs, ???)`) was wired to `rangeOwnDurationMs`, which for
// speed-hold is the FULL LEASE (correct for sizing the follow-up) — so gating on it made every
// nonzero speed-hold choice wait out the whole ~1500ms lease before the NEXT decision, defeating
// "speed-hold is reconsidered every decision" (measured: real decision gaps of ~1800ms instead of
// the ~505ms pacing floor). `rangeBoundedDurationMs` is the field gating must use instead.
test('planTrackManeuver: rangeBoundedDurationMs (for GATING the next decision) is 0 for any speed-hold choice, even a fast nonzero one — only rangeOwnDurationMs (for sizing the follow-up) is the full lease', () => {
  const fast = planTrackManeuver('hold', 'speed_2_5', { headingDeg: 0 }, { leaseMs: 1500 }, SPEED_HOLD_MENU);
  assert.equal(fast.rangeOwnDurationMs, 1500, 'the follow-up-sizing figure IS the full lease for speed-hold');
  assert.equal(fast.rangeBoundedDurationMs, 0, 'but the GATING figure must be 0 — speed-hold is reconsidered every decision, never waited for');
});
test('planTrackManeuver: rangeBoundedDurationMs IS the real duration for a fixed-distance translate (gating is appropriate there)', () => {
  const planned = planTrackManeuver('hold', 'approach_2m', { headingDeg: 0 }, { leaseMs: 5000 });
  assert.equal(planned.rangeBoundedDurationMs, planned.rangeOwnDurationMs);
  assert.ok(planned.rangeBoundedDurationMs > 0);
});

test('the track yaw/range menus are the same options rendered by encoders/track.ts', () => {
  assert.deepEqual(Object.keys(TRACK_YAW_MENU).sort(), ['hold', 'yaw_left_10', 'yaw_left_30', 'yaw_left_60', 'yaw_right_10', 'yaw_right_30', 'yaw_right_60'].sort());
  assert.deepEqual(Object.keys(TRACK_RANGE_MENU).sort(), ['approach_1m', 'approach_2m', 'hold', 'retreat_1m', 'retreat_2m'].sort());
});
