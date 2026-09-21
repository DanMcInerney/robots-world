/** CPU-only world mechanics (Rapier is a WASM physics library, no GPU/renderer/sensor/network
 * needed here) — exercises the commandable interactive world (as opposed to
 * experiments/jev-round3/world.ts's pre-scripted offline routes), the car velocity script and the
 * evaluator/render-input snapshots this engine's episode loop depends on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldBridge, ROUND3_DEFAULTS, type WorldBridgeConfig } from '../experiments/jev-find-follow/world-bridge.ts';
import { planManeuver, DEFAULT_MENU, DEFAULT_YAW_RATE_DEG_S } from '../experiments/jev-find-follow/maneuver.ts';

function quatToYawDeg(rotation: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (rotation.w * rotation.z + rotation.x * rotation.y), 1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z)) * 180 / Math.PI;
}

function baseConfig(overrides: Partial<WorldBridgeConfig> = {}): WorldBridgeConfig {
  return {
    seed: 1, droneAltitudeM: ROUND3_DEFAULTS.droneAltitudeM, mountPitchDeg: ROUND3_DEFAULTS.mountPitchDeg,
    droneMaxSpeedMps: 2.5, droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    carInitialPosition: { x: 8, y: 0 }, carInitialHeadingDeg: 0,
    carPath: { kind: 'gentle-curve', forwardSpeedMps: 0.46, lateralAmplitudeM: 1.2, lateralPeriodMs: 9000 },
    hfovDeg: ROUND3_DEFAULTS.hfovDeg, physicsDtMs: ROUND3_DEFAULTS.physicsDtMs,
    ...overrides,
  };
}

test('a fresh world bridge starts at simMs 0 with the drone at its configured altitude', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    assert.equal(world.simMs, 0);
    assert.ok(Math.abs(world.droneBody().pose.position.z - ROUND3_DEFAULTS.droneAltitudeM) < 1e-6);
  } finally { await world.close(); }
});

test('advance() steps physics forward by exactly the requested ticks', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    await world.advance(10); // 10 * 20ms = 200ms
    assert.ok(Math.abs(world.simMs - 200) < 1e-6);
  } finally { await world.close(); }
});

test('a stationary-then-forward car does not move before startMovingAtMs, and moves after it', async () => {
  const world = await createWorldBridge(baseConfig({ carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 1, startMovingAtMs: 500, headingDeg: 0 } }));
  try {
    world.updateCarScript();
    await world.advance(20); // 400ms, before startMovingAtMs
    world.updateCarScript();
    const beforeX = world.carBody().pose.position.x;
    await world.advance(5); // to 500ms exactly
    world.updateCarScript();
    await world.advance(50); // 1000ms of forward motion
    const afterX = world.carBody().pose.position.x;
    assert.ok(Math.abs(beforeX - baseConfig().carInitialPosition.x) < 0.05, 'car must not have moved before startMovingAtMs');
    assert.ok(afterX > beforeX + 0.3, `expected forward progress after startMovingAtMs, before=${beforeX} after=${afterX}`);
  } finally { await world.close(); }
});

test('renderInput and evaluatorSnapshot agree on camera position/heading (both derive from the same cameraFromBody composition)', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    const render = world.renderInput();
    const evaluator = world.evaluatorSnapshot();
    assert.ok(Math.abs(render.camera_pose.position[0] - evaluator.cameraPosition.x) < 1e-9);
    assert.ok(Math.abs(render.camera_pose.position[2] - evaluator.cameraPosition.z) < 1e-9);
    assert.ok(Math.abs(render.camera_pose.yaw_rad * 180 / Math.PI - evaluator.cameraHeadingDeg) < 1e-9);
  } finally { await world.close(); }
});

test('evaluatorSnapshot reports the target within FOV when the car spawns directly ahead', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    const snapshot = world.evaluatorSnapshot();
    assert.equal(snapshot.targetWithinFov, true);
    assert.ok(snapshot.trueNearestSurfaceRangeM > 0 && snapshot.trueNearestSurfaceRangeM < 8, 'nearest surface must be closer than the car\'s centre distance');
  } finally { await world.close(); }
});

test('claimDrone returns a working RobotPort that can command velocity and the world integrates it', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    const port = world.claimDrone('test-owner');
    const receipt = await port.command({ id: 'cmd-1', action: 'velocity', args: { x: 1, y: 0, z: 0, yawRate: 0 }, validForMs: 2000 });
    assert.ok(['accepted', 'completed'].includes(receipt.status));
    const before = world.droneBody().pose.position.x;
    await world.advance(50); // 1s
    const after = world.droneBody().pose.position.x;
    assert.ok(after > before + 0.3, `expected the drone to move forward under a velocity command, before=${before} after=${after}`);
  } finally { await world.close(); }
});

test('contacts() reflects the physics world (no contact expected between a drone and a car 8m apart)', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    await world.advance(5);
    assert.deepEqual(world.contacts(), []);
  } finally { await world.close(); }
});

// E3b residual defect B regression: `World.simMs` (src/world.ts) is `#ticks * (physicsDtMs/1000) *
// 1000`, and 20/1000 = 0.02 is not exactly representable in binary floating point, so this drifted
// by a few picoseconds-in-milliseconds per tick (observed pre-fix: 199.99999999999636ms,
// 400.0000000000073ms gaps) even though `#ticks * physicsDtMs` is always mathematically an exact
// integer. The bridge's own `simMs` getter (and every other internal read of the raw World's clock)
// now rounds at that single boundary. Advances a full 45s/20ms episode's worth of ticks (2250) and
// checks every intermediate reading, not just the final one.
test('simMs stays an exact integer millisecond after many ticks (no floating-point drift, defect B regression)', async () => {
  const world = await createWorldBridge(baseConfig());
  try {
    for (let i = 0; i < 225; i++) {
      await world.advance(10); // 225 * 10 * 20ms = 45000ms, matching a full 45s episode's tick count
      assert.ok(Number.isInteger(world.simMs), `simMs must be an exact integer, got ${world.simMs} after ${(i + 1) * 10} ticks`);
    }
    assert.equal(world.simMs, 45000);
  } finally { await world.close(); }
});

// Regression for engine-review-e1 finding 2 ("yaw_10 executes 12deg" — quantisation from rounding
// a command's own expiry UP to the next 20ms physics tick): every currently offered yaw magnitude
// executes its OWN declared degrees on the REAL world/physics, not a rounded-up approximation.
test('every offered yaw menu magnitude executes its declared degrees on the real physics, within 0.5deg (tick-alignment regression)', async () => {
  for (const [id, def] of Object.entries(DEFAULT_MENU)) {
    if (def.kind !== 'yaw') continue;
    const world = await createWorldBridge(baseConfig());
    try {
      const port = world.claimDrone('quantisation-test');
      const before = quatToYawDeg(world.droneBody().pose.rotation);
      const planned = planManeuver(DEFAULT_MENU, id, { headingDeg: before, position: world.droneBody().pose.position }, { leaseMs: 5000 });
      await port.command({ id: 'cmd', action: planned.action, args: planned.args, validForMs: planned.validForMs });
      // Advance well past the command's own expiry so it has fully completed and settled.
      const ticksToAdvance = Math.ceil((planned.validForMs + 200) / 20);
      await world.advance(ticksToAdvance);
      const after = quatToYawDeg(world.droneBody().pose.rotation);
      let executedDeg = after - before;
      while (executedDeg > 180) executedDeg -= 360;
      while (executedDeg < -180) executedDeg += 360;
      const expectedDeg = def.yawDeg!;
      // Wrap the DIFFERENCE, not `executedDeg` alone: for a 180deg turn, +180 and -180 are the same
      // physical orientation, but `executedDeg` (itself already wrapped to (-180,180]) can land on
      // either sign depending on floating-point rounding — comparing raw values against `180`
      // would then spuriously read a ~360deg error. This is a latent test bug the previous 250deg/s
      // rate happened not to trigger (rounding landed just under +180, not at exactly -180); the
      // new default yaw rate (100deg/s, maneuver.ts) lands exactly on the boundary and exposed it.
      let diffDeg = executedDeg - expectedDeg;
      while (diffDeg > 180) diffDeg -= 360;
      while (diffDeg < -180) diffDeg += 360;
      assert.ok(Math.abs(diffDeg) < 0.5, `${id}: expected ~${expectedDeg}deg executed, got ${executedDeg.toFixed(2)}deg (rate=${DEFAULT_YAW_RATE_DEG_S}deg/s)`);
    } finally { await world.close(); }
  }
});

// Unit E4b / B2: 'orbit' — an exact circle of radiusM at a constant angular rate, so the true
// bearing rate from the circle's own centre holds constant for the whole episode (unlike
// 'lateral-crossing', whose bearing rate decays as range grows — engine-review-e3 finding 2).
test('orbit: the car stays at a constant range from the centre and its bearing (from the centre) advances at the declared angular rate', async () => {
  const radiusM = 10, angularRateDegS = 12;
  const world = await createWorldBridge(baseConfig({
    droneInitialPosition: { x: 0, y: 0 }, carInitialPosition: { x: radiusM, y: 0 }, carInitialHeadingDeg: 90,
    carPath: { kind: 'orbit', centerX: 0, centerY: 0, radiusM, angularRateDegS, startAngleDeg: 0 },
  }));
  try {
    const samples: { tMs: number; rangeM: number; bearingDeg: number }[] = [];
    for (let i = 0; i < 10; i++) {
      await world.advance(50); // 50 * 20ms = 1000ms per sample
      const pos = world.carBody().pose.position;
      samples.push({ tMs: world.simMs, rangeM: Math.hypot(pos.x, pos.y), bearingDeg: Math.atan2(pos.y, pos.x) * 180 / Math.PI });
    }
    for (const s of samples) assert.ok(Math.abs(s.rangeM - radiusM) < 0.05, `range drifted at t=${s.tMs}: ${s.rangeM} vs ${radiusM}`);
    // Bearing advances linearly at angularRateDegS: check the total swept angle over the whole
    // sampled span against the declared rate (avoids any single-sample wrap-around edge case).
    const totalSweptDeg = samples.at(-1)!.bearingDeg - samples[0]!.bearingDeg;
    const elapsedS = (samples.at(-1)!.tMs - samples[0]!.tMs) / 1000;
    assert.ok(Math.abs(totalSweptDeg / elapsedS - angularRateDegS) < 0.5, `measured angular rate ${(totalSweptDeg / elapsedS).toFixed(2)} vs declared ${angularRateDegS}`);
  } finally { await world.close(); }
});

// Unit E4b / B2: 'scripted-segments' — piecewise heading/speed script with linear speed ramps,
// used by L3b (accelerate/cruise/stop) and L4 (genuine turns + stops inside a bounded excursion).
test('scripted-segments: speed ramps linearly to each segment target and the car turns to each segment heading', async () => {
  const world = await createWorldBridge(baseConfig({
    carInitialPosition: { x: 0, y: 0 },
    carPath: {
      kind: 'scripted-segments',
      segments: [
        { durationMs: 2000, headingDeg: 0, targetSpeedMps: 2, rampMs: 2000 }, // ramps 0->2 m/s over 2s
        { durationMs: 2000, headingDeg: 90, targetSpeedMps: 2, rampMs: 0 },   // instant turn, constant speed
        { durationMs: 2000, headingDeg: 90, targetSpeedMps: 0, rampMs: 2000 }, // ramps down to a stop
      ],
    },
  }));
  try {
    await world.advance(50); // 1000ms: mid-ramp of segment 1, expect ~1 m/s forward (+x)
    const midRamp = world.carBody().pose.position;
    assert.ok(midRamp.x > 0.3 && midRamp.x < 0.7, `expected ~0.5m travelled at the ramp midpoint, got ${midRamp.x}`);
    await world.advance(50); // 2000ms: segment 1 complete, ~ (0+2)/2*2=2m travelled in x
    const seg1End = world.carBody().pose.position;
    assert.ok(Math.abs(seg1End.x - 2) < 0.3, `expected ~2m at end of ramp segment, got ${seg1End.x}`);
    await world.advance(100); // +2000ms: segment 2, moving in +y at 2 m/s -> ~4m in y, x unchanged
    const seg2End = world.carBody().pose.position;
    assert.ok(Math.abs(seg2End.y - 4) < 0.3, `expected ~4m travelled in +y during the 90deg segment, got ${seg2End.y}`);
    assert.ok(Math.abs(seg2End.x - seg1End.x) < 0.05, 'x should not change once heading is 90deg');
    await world.advance(100); // +2000ms: segment 3, decelerating to a stop
    const seg3End = world.carBody().pose.position;
    await world.advance(50); // hold past the script's own end (only 3 segments, 6s total, advance to 7s)
    const afterScriptEnd = world.carBody().pose.position;
    assert.ok(Math.abs(afterScriptEnd.x - seg3End.x) < 0.05 && Math.abs(afterScriptEnd.y - seg3End.y) < 0.05, 'the car must hold at rest once past the last declared segment, not keep moving');
  } finally { await world.close(); }
});

// A6: hoverJitter makes a nominally-static camera pose genuinely differ acquisition to acquisition
// (the fix for engine-review-e3's Question 2 "byte-identical frames" pose-lottery finding), while
// staying deterministic given the same seed (determinism given seed + controller responses must
// still hold — the ladder's own clock/latency qualification requirement 4).
test('hoverJitter: consecutive acquisitions of a static scene get DIFFERENT camera poses, deterministically given the seed', async () => {
  const config = baseConfig({
    carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0, startMovingAtMs: 1_000_000, headingDeg: 0 },
    hoverJitter: { positionSigmaM: 0.05, yawSigmaDeg: 0.5 },
  });
  const worldA = await createWorldBridge(config);
  const worldB = await createWorldBridge({ ...config }); // same seed -> must reproduce exactly
  try {
    const posesA: number[] = [], posesB: number[] = [];
    for (let i = 0; i < 5; i++) {
      posesA.push(worldA.renderInput().camera_pose.position[0]!);
      posesB.push(worldB.renderInput().camera_pose.position[0]!);
      await worldA.advance(10); await worldB.advance(10); // 200ms between acquisitions, a static scene
    }
    const distinct = new Set(posesA.map(x => x.toFixed(6)));
    assert.ok(distinct.size > 1, 'hoverJitter must make repeated acquisitions of a static scene differ (not byte-identical)');
    assert.deepEqual(posesA, posesB, 'the jitter sequence must be exactly reproducible given the same seed (determinism)');
  } finally { await worldA.close(); await worldB.close(); }
});

test('hoverJitter defaults to off: a static scene with no hoverJitter configured renders the exact same camera pose every acquisition', async () => {
  const world = await createWorldBridge(baseConfig({
    carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0, startMovingAtMs: 1_000_000, headingDeg: 0 },
  }));
  try {
    const first = world.renderInput().camera_pose.position[0];
    await world.advance(10);
    const second = world.renderInput().camera_pose.position[0];
    assert.equal(first, second, 'no hoverJitter configured must be byte-for-byte unchanged from pre-A6 behaviour');
  } finally { await world.close(); }
});

test('hoverJitter: evaluatorSnapshot truth matches the jittered camera pose renderInput() actually sent (same acquisition instant)', async () => {
  const world = await createWorldBridge(baseConfig({
    carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0, startMovingAtMs: 1_000_000, headingDeg: 0 },
    hoverJitter: { positionSigmaM: 0.05, yawSigmaDeg: 0.5 },
  }));
  try {
    await world.advance(10);
    const render = world.renderInput();
    const evaluator = world.evaluatorSnapshot();
    assert.ok(Math.abs(evaluator.cameraPosition.x - render.camera_pose.position[0]!) < 1e-9);
    assert.ok(Math.abs(evaluator.cameraPosition.y - render.camera_pose.position[1]!) < 1e-9);
    assert.ok(Math.abs(evaluator.cameraHeadingDeg - render.camera_pose.yaw_rad * 180 / Math.PI) < 1e-9);
  } finally { await world.close(); }
});
