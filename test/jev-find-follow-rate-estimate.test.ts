import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RATE_WINDOW_MS, DEFAULT_STALE_FALLBACK_MS, estimateRate, type RateSample } from '../experiments/jev-find-follow/rate-estimate.ts';

const STATIONARY: RateSample['ownPositionM'] = { x: 0, y: 0, z: 1.8 };

// engine-review-e3 finding 1: a single missed acquisition must not force `unknown` — the caller
// (episode.ts) no longer resets `rateHistory` on a plain miss (only on `ambiguous`), so a gap in an
// otherwise-continuous history is exactly what this module must tolerate via its own <=2s
// last-known fallback, tested here directly and in isolation from episode.ts's own loop.
test('A1: a rate that goes unknown in the CURRENT window falls back to the last-known value (labelled, with its own age) within staleFallbackMs', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 0, rangeM: 10.0, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 200, rangeM: 9.8, worldBearingDeg: 1, ownPositionM: STATIONARY },
    { acquiredSimMs: 400, rangeM: 9.6, worldBearingDeg: 2, ownPositionM: STATIONARY },
    // A miss (no sample) at 600, 800, 1000, 1200, 1400 — matching a real gap: history simply has no
    // entry there (the caller no longer resets, but also does not push anything for a miss).
  ];
  // At now=1400ms with the ladder's default W=1000ms, the current window (400-1400ms) contains ZERO
  // samples -> current 'none'. The last valid W-window estimate existed at t=400ms (using samples
  // 0/200/400, all within 1000ms of 400) -> age = 1400-400 = 1000ms, well inside the 2000ms default.
  const result = estimateRate(history, 1400);
  assert.notEqual(result.rangeRateMps, 'unknown', 'must recover a value via the last-known fallback, not report unknown');
  assert.equal(result.rangeRateSource, 'last-known');
  assert.equal(result.bearingRateSource, 'last-known');
  assert.equal(result.rangeRateAgeMs, 1000);
  assert.equal(result.bearingRateAgeMs, 1000);
  assert.ok(Math.abs((result.rangeRateMps as number) - (-1)) < 0.05, `expected ~-1 m/s (closing 0.2m/200ms), got ${result.rangeRateMps}`);
});

test('A1: the last-known fallback gives up (reports "none"/unknown) once the gap exceeds staleFallbackMs', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 0, rangeM: 10.0, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 200, rangeM: 9.8, worldBearingDeg: 1, ownPositionM: STATIONARY },
    { acquiredSimMs: 400, rangeM: 9.6, worldBearingDeg: 2, ownPositionM: STATIONARY },
  ];
  const now = 400 + DEFAULT_STALE_FALLBACK_MS + 1; // just beyond the declared 2s fallback threshold
  const result = estimateRate(history, now);
  assert.equal(result.rangeRateMps, 'unknown');
  assert.equal(result.bearingRateDegS, 'unknown');
  assert.equal(result.rangeRateSource, 'none');
  assert.equal(result.bearingRateSource, 'none');
  assert.equal(result.rangeRateAgeMs, null);
});

test('A1: a CURRENT (fresh, in-window) estimate is reported as source "current" with a null age, never "last-known"', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 0, rangeM: 10.0, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 200, rangeM: 9.8, worldBearingDeg: 1, ownPositionM: STATIONARY },
    { acquiredSimMs: 400, rangeM: 9.6, worldBearingDeg: 2, ownPositionM: STATIONARY },
  ];
  const result = estimateRate(history, 400);
  assert.equal(result.rangeRateSource, 'current');
  assert.equal(result.bearingRateSource, 'current');
  assert.equal(result.rangeRateAgeMs, null);
  assert.equal(result.bearingRateAgeMs, null);
});

test('fewer than 3 samples in the window is explicitly unknown, never a guessed rate', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 900, rangeM: 10, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 1000, rangeM: 9.5, worldBearingDeg: 1, ownPositionM: STATIONARY },
  ];
  const result = estimateRate(history, 1000);
  assert.equal(result.rangeRateMps, 'unknown');
  assert.equal(result.bearingRateDegS, 'unknown');
  assert.equal(result.sampleCount, 2);
});

// engine-review-e2 finding 3: the ladder's window rule is resolved to EXACTLY "least-squares over
// samples no older than window W, >=3 samples, else unknown" — one cut, not a separate staleness
// sub-horizon (the old, ambiguous "1.0s window AND not older than 2x camera period" combination).
test('samples older than the window W are excluded, not merely "stale" under a second cut', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 0, rangeM: 10, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 100, rangeM: 10, worldBearingDeg: 0, ownPositionM: STATIONARY },
    { acquiredSimMs: 200, rangeM: 10, worldBearingDeg: 0, ownPositionM: STATIONARY },
  ];
  // W=1000ms (default): "now"=1500ms puts every sample beyond the window (500-1500ms old) -> unknown
  // in the PRIMARY window cut (staleFallbackMs=0 here disables engine-review-e3 finding 1's own
  // separate <=2s last-known fallback, which would otherwise find this exact 0 m/s value again from
  // t=200ms and mask what this test is specifically checking — the window cut itself).
  assert.equal(estimateRate(history, 1500, 1000, 0).rangeRateMps, 'unknown');
  // A wider, explicit window W=2000ms includes all three (all <=1500ms old) -> known (0 m/s, stationary).
  const wide = estimateRate(history, 1500, 2000, 0);
  assert.notEqual(wide.rangeRateMps, 'unknown');
  assert.equal(wide.sampleCount, 3);
});

test('W is a caller-supplied parameter; DEFAULT_RATE_WINDOW_MS is exactly 1.0s, matching the ladder default', () => {
  assert.equal(DEFAULT_RATE_WINDOW_MS, 1000);
});

test('a target receding at a known constant rate is recovered by the least-squares fit (stationary own-position, so no ego-motion contribution)', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) history.push({ acquiredSimMs: t, rangeM: 10 + 2 * (t / 1000), worldBearingDeg: 0, ownPositionM: STATIONARY }); // 2 m/s recession
  const result = estimateRate(history, 800);
  assert.notEqual(result.rangeRateMps, 'unknown');
  assert.ok(Math.abs((result.rangeRateMps as number) - 2) < 0.05, `expected ~2 m/s, got ${result.rangeRateMps}`);
  assert.equal(result.sampleCount, 5);
});

test('a target with no valid range samples (range unavailable) has unknown range-rate but a valid bearing-rate', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) history.push({ acquiredSimMs: t, rangeM: null, worldBearingDeg: (t / 1000) * 30, ownPositionM: STATIONARY }); // 30 deg/s
  const result = estimateRate(history, 800);
  assert.equal(result.rangeRateMps, 'unknown');
  assert.notEqual(result.bearingRateDegS, 'unknown');
  assert.ok(Math.abs((result.bearingRateDegS as number) - 30) < 1);
});

test('bearing rate correctly unwraps across the 0/360 boundary instead of reading a spurious ~360deg/s jump', () => {
  const history: RateSample[] = [
    { acquiredSimMs: 0, rangeM: 10, worldBearingDeg: 350, ownPositionM: STATIONARY }, { acquiredSimMs: 200, rangeM: 10, worldBearingDeg: 355, ownPositionM: STATIONARY },
    { acquiredSimMs: 400, rangeM: 10, worldBearingDeg: 1, ownPositionM: STATIONARY }, { acquiredSimMs: 600, rangeM: 10, worldBearingDeg: 6, ownPositionM: STATIONARY },
  ];
  const result = estimateRate(history, 600);
  assert.ok(Math.abs((result.bearingRateDegS as number) - 26) < 3, `expected ~25-27 deg/s (wrapping 350->355->361->366), got ${result.bearingRateDegS}`);
});

test('a stationary target with a stationary drone reports ~0 m/s and ~0 deg/s, not merely "unknown"', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) history.push({ acquiredSimMs: t, rangeM: 8, worldBearingDeg: 45, ownPositionM: STATIONARY });
  const result = estimateRate(history, 800);
  assert.ok(Math.abs(result.rangeRateMps as number) < 1e-9);
  assert.ok(Math.abs(result.bearingRateDegS as number) < 1e-9);
});

// engine-review-e2 finding 3's own probe, reproduced exactly: "stationary target, drone closing at
// 1 m/s -> speed_1_0 prints 7.6 m; true value 8.6 m" — i.e. pre-fix, the raw (uncompensated) slope
// misattributed the DRONE's own closing motion to the TARGET, reporting -1 m/s (receding negated)
// instead of the true ~0 m/s. The target is stationary at world bearing 0 (due "east" of the
// drone's start); the drone closes along +x (toward the target) at 1 m/s.
test('range-rate is compensated for the drone\'s own closing motion (ego-motion): a STATIONARY target reports ~0 m/s while the drone itself closes at 1 m/s', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) {
    const droneXAtT = (t / 1000) * 1.0; // drone closing at 1 m/s along +x, starting at x=0
    const trueRangeM = 10 - droneXAtT; // stationary target at x=10; range shrinks only because the DRONE is closing
    history.push({ acquiredSimMs: t, rangeM: trueRangeM, worldBearingDeg: 0, ownPositionM: { x: droneXAtT, y: 0, z: 1.8 } });
  }
  const result = estimateRate(history, 800);
  assert.notEqual(result.rangeRateMps, 'unknown');
  assert.ok(Math.abs(result.rangeRateMps as number) < 0.05, `expected ~0 m/s (target itself is stationary; the RAW slope alone would read -1 m/s), got ${result.rangeRateMps}`);
});

// The companion case: a target genuinely RECEDING at 2 m/s while the drone ALSO closes at 1 m/s
// (raw slope would read only +1 m/s net) must still recover the target's own +2 m/s.
test('range-rate separates a genuinely receding target from a simultaneously closing drone', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) {
    const tS = t / 1000;
    const droneXAtT = tS * 1.0; // drone closing at 1 m/s along +x
    const targetXAtT = 10 + tS * 2.0; // target receding at 2 m/s along +x, starting at x=10
    const trueRangeM = targetXAtT - droneXAtT; // net raw slope would be +1 m/s (2 receding - 1 closing)
    history.push({ acquiredSimMs: t, rangeM: trueRangeM, worldBearingDeg: 0, ownPositionM: { x: droneXAtT, y: 0, z: 1.8 } });
  }
  const result = estimateRate(history, 800);
  assert.notEqual(result.rangeRateMps, 'unknown');
  assert.ok(Math.abs((result.rangeRateMps as number) - 2) < 0.05, `expected the target's own ~2 m/s recession (not the raw net +1 m/s), got ${result.rangeRateMps}`);
});

test('range-rate is unknown when odometry (own position) is unavailable for the samples, rather than an uncompensated guess', () => {
  const history: RateSample[] = [];
  for (let t = 0; t <= 800; t += 200) history.push({ acquiredSimMs: t, rangeM: 10 + 2 * (t / 1000), worldBearingDeg: 0, ownPositionM: null });
  const result = estimateRate(history, 800);
  assert.equal(result.rangeRateMps, 'unknown');
  assert.notEqual(result.bearingRateDegS, 'unknown', 'bearing-rate does not need odometry (world bearing is already own-heading-corrected)');
});
