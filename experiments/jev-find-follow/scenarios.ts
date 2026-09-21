/** The two smoke scenarios (configs only; the real ladder comes later — see the coordinator
 * report for the full staged design). Speed/altitude/pitch are explicit scenario parameters (an
 * independent design review's points 5/11): defaulting to Round 3's own camera rig (1.8 m
 * altitude, -5 degree pitch, 70 degree HFOV) for rough comparability with that recorded evidence,
 * and to Round 3's own car forward speed (0.46 m/s) for the same reason. Drone max speed defaults
 * to the `drone` model's own 2.5 m/s cap (src/models/mobile.ts).
 */
import { TARGET_CAR_DIMENSIONS } from '../jev-round3/world.ts';
import { ROUND3_DEFAULTS, type WorldBridgeConfig } from './world-bridge.ts';
import { DEFAULT_SECTOR_MEMORY_CONFIG } from './sector-memory.ts';
import { DEFAULT_YAW_RATE_DEG_S } from './maneuver.ts';
import { DEFAULT_RATE_WINDOW_MS } from './rate-estimate.ts';
import type { EpisodeScenario } from './episode.ts';

const COMMON_WORLD: Omit<WorldBridgeConfig, 'seed' | 'carInitialPosition' | 'carInitialHeadingDeg' | 'carPath' | 'droneInitialPosition' | 'droneInitialHeadingDeg'> = {
  droneAltitudeM: ROUND3_DEFAULTS.droneAltitudeM,
  mountPitchDeg: ROUND3_DEFAULTS.mountPitchDeg,
  droneMaxSpeedMps: 2.5,
  hfovDeg: ROUND3_DEFAULTS.hfovDeg,
  physicsDtMs: ROUND3_DEFAULTS.physicsDtMs,
};

// engine-review-e1 acceptance note: "fix the scenario start range: requested distance applies to
// the car's SURFACE not centre." TARGET_CAR_DIMENSIONS[0] is the car's own length (its longest
// axis, aligned with its local X at heading 0/180 for both scenarios below), so the nearest-surface
// distance from a camera looking straight down the car's length is centreDistance - halfLengthM.
const CAR_HALF_LENGTH_M = TARGET_CAR_DIMENSIONS[0] / 2;
const REQUESTED_RANGE_M = 8;

// Increment B1: perception configuration as a scenario parameter. PROVISIONAL default per the
// coordinator's measurement (vehicle family + 0.15 threshold: 86%/94% recall under 12m, no false
// candidates), marked provisional pending the L0 sweep; the strict arm (0.25 / ['car'] only) stays
// available via `run.ts --strict-detector`, not as the default. `imgsz` is a declared gap: the
// sensor's detector (experiments/jev-library/detector.py, outside this assignment's edit scope)
// exposes no imgsz parameter to plumb.
const VEHICLE_FAMILY = ['car', 'truck', 'bus'];
const PROVISIONAL_SCORE_THRESHOLD = 0.15;

const COMMON_SCENARIO_FIELDS = {
  sectorMemory: DEFAULT_SECTOR_MEMORY_CONFIG,
  searchVariant: 'sector-consequences' as const,
  freshWithinMs: 3000,
  lastSeenTrustworthyMs: 15000,
  lastSeenStaleMs: 30000,
  rangeToleranceM: 1.0,
  identityBearingToleranceRad: 10 * Math.PI / 180,
  identityRangeToleranceM: 2.0,
  centralBandFraction: 0.3,
  envelope: { minAltitudeM: 0.5, maxAltitudeM: 6, maxRadiusFromOriginM: 60 },
  perception: { scoreThreshold: PROVISIONAL_SCORE_THRESHOLD },
  // Both scenarios have a MOVING target: the ladder's follow-action model reserves the
  // fixed-distance range menu for a stationary-target sub-rung (see maneuver.ts's
  // TRACK_RANGE_MENU docstring) and uses speed-hold + rate-aware consequences here instead.
  consequenceModel: 'measured-rate' as const,
  rangeMenuKind: 'speed-hold' as const,
  // engine-review-e2 finding 8: declared scenario parameter (see maneuver.ts's justification).
  yawRateDegS: DEFAULT_YAW_RATE_DEG_S,
  // engine-review-e2 finding 3: declared scenario parameter (see rate-estimate.ts's justification).
  rateWindowMs: DEFAULT_RATE_WINDOW_MS,
};

/** Car visible ~8 m (surface range) ahead, moving on a gentle curve within detector range. Goal:
 * "follow the blue car at 8 m". 45 s. */
export const VISIBLE_TRACK: EpisodeScenario = {
  id: 'visible-track',
  goal: { classes: VEHICLE_FAMILY, colour: 'blue', description: 'the blue car', requestedRangeM: REQUESTED_RANGE_M },
  durationMs: 45_000,
  world: {
    ...COMMON_WORLD,
    seed: 9101,
    droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    carInitialPosition: { x: REQUESTED_RANGE_M + CAR_HALF_LENGTH_M, y: 0 }, carInitialHeadingDeg: 0,
    carPath: { kind: 'gentle-curve', forwardSpeedMps: 0.46, lateralAmplitudeM: 1.2, lateralPeriodMs: 9000 },
  },
  ...COMMON_SCENARIO_FIELDS,
  passCriteria: {
    minFollowLockFraction: 0.3, maxLongestLossMs: 15_000, maxContacts: 0, requireFirstDetectionByMs: 6_000, maxVetoedManeuvers: 0,
    // Acceptance: reference holds the visible car truth-centred >=90% and within +-1m of the
    // requested surface range >=80% of the time, after a declared settling period.
    minTruthCentredFraction: 0.9, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: 8_000,
  },
};

/** Car ~8 m (surface range) away, directly behind the drone's initial view (drone faces east, car
 * spawns west), stationary for the first 20 s then moving. 60 s. */
export const TURN_TO_FIND: EpisodeScenario = {
  id: 'turn-to-find',
  goal: { classes: VEHICLE_FAMILY, colour: 'blue', description: 'the blue car', requestedRangeM: REQUESTED_RANGE_M },
  durationMs: 60_000,
  world: {
    ...COMMON_WORLD,
    seed: 9102,
    droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    carInitialPosition: { x: -(REQUESTED_RANGE_M + CAR_HALF_LENGTH_M), y: 0 }, carInitialHeadingDeg: 180,
    carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0.46, startMovingAtMs: 20_000, headingDeg: 180 },
  },
  ...COMMON_SCENARIO_FIELDS,
  passCriteria: {
    minFollowLockFraction: 0.15, maxLongestLossMs: 45_000, maxContacts: 0, requireFirstDetectionByMs: 20_000, maxVetoedManeuvers: 0,
    // Acceptance: finds the car then holds it truth-centred >=80% of the REMAINING time. Settling
    // from requireFirstDetectionByMs (20s) is the closest declared proxy for "the remaining time"
    // available to a pure, scenario-config pass rule.
    minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: null, settlingPeriodMs: 20_000,
  },
};

/** engine-review-e2 finding 5 / increment B1: "passive must not score centred 1.000" — the
 * original `visible-track`'s gentle-curve car (1.2m amplitude at >=8m range, an angular sweep of
 * ~8.5deg peak) never actually leaves the ~10.5deg central band, so `passive` (never yaws) scores
 * truth-centred 1.000 there BY CONSTRUCTION, not because holding still is actually a competent
 * policy. This scenario's car crosses laterally at a CONSTANT 1.5 m/s (never returning to centre,
 * unlike the oscillating gentle-curve), producing a monotonically growing bearing error that only
 * an actively-yawing policy can correct — `passive`'s truth-centred fraction here is measured, not
 * assumed, and reported in the E3 return.
 */
export const VISIBLE_TRACK_YAW: EpisodeScenario = {
  id: 'visible-track-yaw',
  goal: { classes: VEHICLE_FAMILY, colour: 'blue', description: 'the blue car', requestedRangeM: REQUESTED_RANGE_M },
  durationMs: 30_000,
  world: {
    ...COMMON_WORLD,
    seed: 9103,
    droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
    carInitialPosition: { x: REQUESTED_RANGE_M + CAR_HALF_LENGTH_M, y: 0 }, carInitialHeadingDeg: 0,
    carPath: { kind: 'lateral-crossing', forwardSpeedMps: 0, lateralSpeedMps: 1.5 },
  },
  ...COMMON_SCENARIO_FIELDS,
  passCriteria: {
    minFollowLockFraction: 0.3, maxLongestLossMs: 15_000, maxContacts: 0, requireFirstDetectionByMs: 6_000, maxVetoedManeuvers: 0,
    minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: null, settlingPeriodMs: 4_000,
  },
};

export const SMOKE_SCENARIOS: Record<string, EpisodeScenario> = { 'visible-track': VISIBLE_TRACK, 'turn-to-find': TURN_TO_FIND, 'visible-track-yaw': VISIBLE_TRACK_YAW };
