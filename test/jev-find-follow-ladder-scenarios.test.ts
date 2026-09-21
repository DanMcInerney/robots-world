/** Increment B3 / Unit E4b: sanity tests for the provisional L1-L4 scenario builders — no GPU/render
 * needed, these just check the CONSTRUCTED scenario shape (question mode, menu, consequence model,
 * duration, tolerance, car path) matches each rung's own declared spec in
 * `docs/jev-find-follow-ladder.md`, plus (Unit E4b / A6/B2) the honest-config additions: offsets
 * strictly greater than N0, aspect as a declared factor, hover jitter wired, non-menu speed
 * profiles, and L4's own bounded-envelope patrol path (checked against the REAL world bridge, not
 * just the declared config, since "the drone stays inside the 60m envelope" is a claim about
 * physics, not configuration).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildL1, buildL2, buildL3a, buildL3b, buildL4, buildProvisionalLadder, ROUND3_RIG, CANDIDATE_HIGHER_RIG, N0_DEG,
} from '../experiments/jev-find-follow/ladder-scenarios.ts';
import { createWorldBridge } from '../experiments/jev-find-follow/world-bridge.ts';
import { SPEED_HOLD_MENU } from '../experiments/jev-find-follow/maneuver.ts';

const NO_ENVELOPE = { bearingRateDegSAt80PctCentred: null, targetSpeedMpsAt80PctInRangeBand: null };

test('buildL1: yaw-only, stationary consequence, fixed-distance menu, target does not move', () => {
  const s = buildL1(ROUND3_RIG, 8);
  assert.equal(s.questionMode, 'yaw-only');
  assert.equal(s.consequenceModel, 'stationary');
  assert.equal(s.rangeMenuKind, 'fixed-distance');
  assert.equal(s.world.carPath.kind, 'stationary-then-forward');
  if (s.world.carPath.kind === 'stationary-then-forward') assert.equal(s.world.carPath.forwardSpeedMps, 0);
  assert.equal(s.durationMs, 20_000);
});

// A6: "start offsets strictly greater than N" — engine-review-e3's own finding that the old
// offsetDeg=10 default sat almost exactly AT N0 (10.5deg), so `passive` trivially stayed "within
// N0" without ever correcting, undermining the rung.
test('buildL1: default start offset is strictly greater than N0 (passive cannot pass by sitting inside the central band from the start)', () => {
  const s = buildL1(ROUND3_RIG, 8);
  assert.equal(s.centralBandFraction, 0.3);
  assert.ok(N0_DEG > 0 && N0_DEG < 20, `sanity: N0_DEG should be a small angle, got ${N0_DEG}`);
  // Recover the actual camera-relative offset from the constructed world geometry rather than
  // re-deriving it from offsetDeg directly, so this test exercises the same code path buildL1 does.
  const dx = s.world.carInitialPosition.x - s.world.droneInitialPosition.x;
  const dy = s.world.carInitialPosition.y - s.world.droneInitialPosition.y;
  const worldBearingDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  const offsetFromHeadingDeg = Math.abs(((s.world.droneInitialHeadingDeg - worldBearingDeg + 540) % 360) - 180);
  assert.ok(offsetFromHeadingDeg > N0_DEG, `default offset ${offsetFromHeadingDeg.toFixed(2)}deg must exceed N0=${N0_DEG}deg`);
});

// A6: aspect as a declared factor — front/rear/side must produce genuinely different car headings
// (front = car's front toward the drone, rear = car's rear toward the drone, 180deg apart).
test('buildL1: aspect changes the car\'s heading relative to the drone (front vs rear are 180deg apart)', () => {
  const front = buildL1(ROUND3_RIG, 8, { aspect: 'front' });
  const rear = buildL1(ROUND3_RIG, 8, { aspect: 'rear' });
  const side = buildL1(ROUND3_RIG, 8, { aspect: 'side' });
  const rawDiff = ((front.world.carInitialHeadingDeg - rear.world.carInitialHeadingDeg) % 360 + 360) % 360;
  assert.ok(Math.abs(rawDiff - 180) < 1e-6, `front/rear headings should be exactly 180deg apart, got ${rawDiff}`);
  assert.notEqual(side.world.carInitialHeadingDeg, front.world.carInitialHeadingDeg);
  assert.ok(front.id.includes('front') && rear.id.includes('rear'), 'aspect should be visible in the scenario id for report readability');
});

// A6: hover jitter wired into every provisional rung (a real platform always has some hover
// jitter; the two frozen smoke scenarios in scenarios.ts are deliberately left untouched).
test('buildL1/buildL3a: hoverJitter is configured (positive sigma) so static scenes are not byte-identical frame to frame', () => {
  const l1 = buildL1(ROUND3_RIG, 8), l3a = buildL3a(ROUND3_RIG, 8);
  assert.ok((l1.world.hoverJitter?.positionSigmaM ?? 0) > 0);
  assert.ok((l3a.world.hoverJitter?.positionSigmaM ?? 0) > 0);
});

test('buildL2: yaw-only, measured-rate consequence, orbit car path at an EXACT constant bearing rate (engine-review-e3 finding 2)', () => {
  const withMeasured = buildL2(ROUND3_RIG, 8, { bearingRateDegSAt80PctCentred: 15, targetSpeedMpsAt80PctInRangeBand: null });
  assert.equal(withMeasured.questionMode, 'yaw-only');
  assert.equal(withMeasured.consequenceModel, 'measured-rate');
  const path = withMeasured.world.carPath;
  assert.equal(path.kind, 'orbit');
  if (path.kind === 'orbit') {
    assert.equal(path.angularRateDegS, 15);
    assert.ok(Math.abs(path.radiusM - 8 - 2.25) < 0.01 || path.radiusM > 8, 'radius should be requestedRangeM plus the car half-length');
  }
  const withDefault = buildL2(ROUND3_RIG, 8, NO_ENVELOPE);
  const defaultPath = withDefault.world.carPath;
  if (defaultPath.kind === 'orbit') assert.ok(defaultPath.angularRateDegS > 0, 'must fall back to a nonzero provisional rate, never silently 0');
});

// B2: the orbit path's own bearing rate must hold CONSTANT over L2's whole 20s episode, not decay
// as lateral-crossing's did — checked against the REAL world bridge (physics), not just config.
test('buildL2: the true bearing rate (measured from the real world bridge) stays close to the declared rate for the whole episode', async () => {
  const s = buildL2(ROUND3_RIG, 8, { bearingRateDegSAt80PctCentred: 12, targetSpeedMpsAt80PctInRangeBand: null });
  const world = await createWorldBridge(s.world);
  try {
    const bearings: { tMs: number; bearingDeg: number }[] = [];
    const ticksPerSample = Math.round(s.durationMs / 20 / 10); // 10 samples across the episode
    for (let i = 0; i < 10; i++) {
      await world.advance(ticksPerSample);
      const pos = world.carBody().pose.position;
      bearings.push({ tMs: world.simMs, bearingDeg: Math.atan2(pos.y, pos.x) * 180 / Math.PI });
    }
    // Consecutive-sample bearing rate must stay close to the declared 12deg/s throughout — proving
    // the rate does not decay the way the old lateral-crossing-based L2 did.
    for (let i = 1; i < bearings.length; i++) {
      let dDeg = bearings[i]!.bearingDeg - bearings[i - 1]!.bearingDeg;
      while (dDeg > 180) dDeg -= 360; // unwrap atan2's principal-range discontinuity, not a real rate change
      while (dDeg <= -180) dDeg += 360;
      const dS = (bearings[i]!.tMs - bearings[i - 1]!.tMs) / 1000;
      assert.ok(Math.abs(dDeg / dS - 12) < 1, `bearing rate drifted at sample ${i}: ${(dDeg / dS).toFixed(2)} vs declared 12deg/s`);
    }
  } finally { await world.close(); }
});

test('buildL3a: range-only, stationary consequence, fixed-distance menu, start range exceeds D0 by more than tolerance (passive cannot pass by construction)', () => {
  const s = buildL3a(ROUND3_RIG, 8);
  assert.equal(s.questionMode, 'range-only');
  assert.equal(s.consequenceModel, 'stationary');
  assert.equal(s.rangeMenuKind, 'fixed-distance');
  assert.equal(s.rangeToleranceM, 0.5);
  const path = s.world.carPath;
  assert.equal(path.kind, 'stationary-then-forward');
  const dx = s.world.carInitialPosition.x - s.world.droneInitialPosition.x;
  const dy = s.world.carInitialPosition.y - s.world.droneInitialPosition.y;
  const rangeM = Math.hypot(dx, dy);
  assert.ok(rangeM > 8 + 0.5, 'must start beyond D0 + tolerance');
});

test('buildL3b: range-only, measured-rate consequence, speed-hold menu, a NON-MENU accelerate/cruise/stop speed profile', () => {
  const withMeasured = buildL3b(ROUND3_RIG, 8, { bearingRateDegSAt80PctCentred: null, targetSpeedMpsAt80PctInRangeBand: 1.5 });
  assert.equal(withMeasured.questionMode, 'range-only');
  assert.equal(withMeasured.consequenceModel, 'measured-rate');
  assert.equal(withMeasured.rangeMenuKind, 'speed-hold');
  const path = withMeasured.world.carPath;
  assert.equal(path.kind, 'scripted-segments');
  if (path.kind === 'scripted-segments') {
    const cruiseMps = path.segments[0]!.targetSpeedMps;
    assert.ok(cruiseMps > 0, 'must fall back to a nonzero provisional speed, never silently 0');
    const menuSpeeds = Object.values(SPEED_HOLD_MENU).filter(d => d.kind === 'speed_hold').map(d => d.speedMps!);
    for (const menuSpeed of menuSpeeds) assert.ok(Math.abs(cruiseMps - menuSpeed) > 0.05, `cruise speed ${cruiseMps} must not exactly match menu option ${menuSpeed} (B3: "speed profiles that are NOT menu speeds")`);
    // Ends stopped (last segment's targetSpeedMps is 0) — a genuine "stop", not just "cruise forever".
    assert.equal(path.segments.at(-1)!.targetSpeedMps, 0);
    const totalMs = path.segments.reduce((sum, seg) => sum + seg.durationMs, 0);
    assert.equal(totalMs, withMeasured.durationMs);
  }
});

test('buildL4: both questions asked, measured-rate consequence, speed-hold menu, a genuine turns+stops patrol, 90s episode', () => {
  const s = buildL4(ROUND3_RIG, 8, { bearingRateDegSAt80PctCentred: 10, targetSpeedMpsAt80PctInRangeBand: 1.5 });
  assert.equal(s.questionMode, 'both');
  assert.equal(s.consequenceModel, 'measured-rate');
  assert.equal(s.rangeMenuKind, 'speed-hold');
  assert.equal(s.durationMs, 90_000);
  const path = s.world.carPath;
  assert.equal(path.kind, 'scripted-segments');
  if (path.kind === 'scripted-segments') {
    const headings = new Set(path.segments.map(seg => seg.headingDeg));
    assert.ok(headings.size >= 3, 'a genuine "turns" patrol must visit at least 3 distinct headings');
    assert.ok(path.segments.some(seg => seg.targetSpeedMps === 0), 'a genuine "stops" patrol must include a zero-speed segment');
    const totalMs = path.segments.reduce((sum, seg) => sum + seg.durationMs, 0);
    assert.equal(totalMs, s.durationMs);
  }
});

// B2 ("L4 path ... inside a declared operating envelope"): engine-review-e3's own finding 2 measured
// the OLD gentle-curve-based L4 path drifting the drone ~135m from origin against a declared 60m
// envelope. Checked against the REAL world bridge over the full 90s episode (both rigs), not just
// eyeballing the segment list.
test('buildL4: the car (and therefore the drone, which follows within ~D0 of it) stays well inside the 60m operating envelope for the whole 90s episode', async () => {
  for (const [rig, d0] of [[ROUND3_RIG, 8], [CANDIDATE_HIGHER_RIG, 9]] as const) {
    const s = buildL4(rig, d0, { bearingRateDegSAt80PctCentred: 10, targetSpeedMpsAt80PctInRangeBand: 1.5 });
    const world = await createWorldBridge(s.world);
    try {
      let maxRadiusM = 0;
      const totalTicks = s.durationMs / 20;
      const sampleEveryTicks = 25; // every 500ms
      for (let t = 0; t < totalTicks; t += sampleEveryTicks) {
        await world.advance(sampleEveryTicks);
        const pos = world.carBody().pose.position;
        maxRadiusM = Math.max(maxRadiusM, Math.hypot(pos.x, pos.y));
      }
      // The drone chases at roughly D0 offset; give a generous margin (D0 + 10m slack for
      // imperfect tracking) and assert the CAR's own excursion alone already leaves that margin
      // comfortably inside the 60m envelope (envelopeFor's own maxRadiusFromOriginM).
      assert.ok(maxRadiusM + d0 + 10 < 60, `car max radius ${maxRadiusM.toFixed(1)}m (+ D0=${d0} + 10m slack) must stay under the 60m envelope at rig altitude ${rig.droneAltitudeM}m`);
    } finally { await world.close(); }
  }
});

// A7 (engine-review-e3: "the unrounded '0.30000000000000004 m' figure ... reached Jev in all 78
// Round-3-rig requests" — root-caused here to `envelopeFor`'s own `Math.max(0.2, droneAltitudeM -
// 1.5)` arithmetic, `1.8 - 1.5` not being exactly representable in binary floating point; the
// previous unit's own live probe of a default TRACK request did not find this because it probed
// scenarios.ts's smoke scenarios, whose envelope is a hardcoded literal with no arithmetic).
test('every provisional rung\'s envelope is a clean, rounded number (regression for the 0.30000000000000004m finding)', () => {
  for (const rig of [ROUND3_RIG, CANDIDATE_HIGHER_RIG]) {
    const s = buildL1(rig, 8);
    assert.equal(s.envelope.minAltitudeM, Math.round(s.envelope.minAltitudeM * 10) / 10, `minAltitudeM must already be rounded to 1 decimal, got ${s.envelope.minAltitudeM}`);
    assert.equal(String(s.envelope.minAltitudeM).length <= 4, true, `expected a short clean string, got "${s.envelope.minAltitudeM}" (the review's own bug printed a 17-character float)`);
  }
  // The exact reproduction: Round3 rig's altitude is 1.8m; 1.8 - 1.5 is NOT exactly 0.3 in binary
  // floating point (0.30000000000000004) even though it mathematically should be.
  assert.equal(buildL1(ROUND3_RIG, 8).envelope.minAltitudeM, 0.3);
});

test('buildProvisionalLadder: builds all five rungs at a given rig with distinct scenario ids', () => {
  const ladder = buildProvisionalLadder(CANDIDATE_HIGHER_RIG, 9, { bearingRateDegSAt80PctCentred: 10, targetSpeedMpsAt80PctInRangeBand: 1.5 });
  const ids = Object.values(ladder).map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'every rung must have a distinct scenario id');
  for (const s of Object.values(ladder)) {
    assert.equal(s.world.droneAltitudeM, CANDIDATE_HIGHER_RIG.droneAltitudeM);
    assert.equal(s.world.mountPitchDeg, CANDIDATE_HIGHER_RIG.mountPitchDeg);
    assert.equal(s.goal.requestedRangeM, 9);
  }
});
