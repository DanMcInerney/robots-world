/** Increment B3: PROVISIONAL L1, L2, L3a, L3b, L4 scenario configs, built from this unit's own
 * reference-ceiling sweep result (see `.runtime/experiments/jev-find-follow-v1/e3b-reference-
 * ceiling/summary.json` and WORKLOG.md for the measured envelope this file's constants come from).
 * "Provisional" per the assignment's own wording: ONE representative configuration per rung (not
 * the ladder's own full offset x range / seed-density sweep — that is the next unit's job once
 * these provisional configs are themselves confirmed not to be obviously mis-set), at TWO camera
 * rigs (Round 3's own 1.8m/-5°, and one higher candidate rig picked from this unit's own empirical
 * static rig-geometry check — see WORKLOG.md for the measured numbers, not a re-derivation of the
 * ladder document's own hand geometry, which this unit's empirical check found gave a materially
 * different (worse) picture at 5m+ altitude than a first-order trig estimate suggested).
 */
import { TARGET_CAR_DIMENSIONS } from '../jev-round3/world.ts';
import { DEFAULT_SECTOR_MEMORY_CONFIG } from './sector-memory.ts';
import { DEFAULT_YAW_RATE_DEG_S } from './maneuver.ts';
import { DEFAULT_RATE_WINDOW_MS } from './rate-estimate.ts';
import { offsetRangeStart, ROUND3_RIG, type Aspect, type RigConfig } from './sweep.ts';
import type { EpisodeScenario } from './episode.ts';
import type { EnvelopeBounds } from './types.ts';
import type { HoverJitterConfig } from './world-bridge.ts';

const CAR_HALF_LENGTH_M = TARGET_CAR_DIMENSIONS[0] / 2;
const VEHICLE_FAMILY = ['car', 'truck', 'bus'];
const GOAL = { classes: VEHICLE_FAMILY, colour: 'blue', description: 'the blue car' };

/** Unit E4b / A6 ("hover drift of a few cm / tenths of a degree"): applied to every provisional
 * rung below (both stationary and moving — a real platform always has some hover jitter; the two
 * frozen smoke scenarios in scenarios.ts are deliberately left untouched, since their own
 * determinism/byte-identical-frame regression tests predate and do not expect it). */
const DEFAULT_HOVER_JITTER: HoverJitterConfig = { positionSigmaM: 0.03, yawSigmaDeg: 0.2 };

/** Central-band half-width N0 for this file's own `commonFields` (hfovDeg=70, centralBandFraction
 * 0.3): `(70/2)*0.3 = 10.5`. A local literal (not re-derived from scoring.ts's own `bandLimitRad`
 * formula, which is deliberately never imported by encoders/scenario builders — see types.ts's own
 * `EnvelopeBounds` docstring for the same separation) — kept in sync by
 * `test/jev-find-follow-ladder-scenarios.test.ts`'s own explicit `offsetDeg > N0` assertion. */
const N0_DEG = (70 / 2) * 0.3;

/** Increment B3 rig-geometry qualification: this unit's own empirical static check (real renderer
 * + real GPU sensor, `.scratch-rig-check.mts`, not preserved in the repo — see WORKLOG.md for the
 * full measured table) rendered single frames at altitude x pitch x slant-range D combinations and
 * read back the sensor's own box (for clipping) and reported range (for accuracy). Finding,
 * corrected against the ladder document's own hand-derived geometry: stereo range error/bias in
 * THIS renderer+detector pipeline grows with camera altitude at a fixed slant range (not merely
 * with slant range itself) — the ladder's proposed 5m/-18deg and 6.5m/-18deg candidates measured
 * 0.49-1.85m range error against the ±1m moving-target tolerance (i.e. frequently AT or BEYOND the
 * tolerance already, before any controller/latency noise is added), while 3m/-15deg stayed under
 * ~0.9m across D=8-11m with zero box clipping (D=12m lost detection entirely, not clipped — a
 * detection-range limit, not a framing limit). CANDIDATE_HIGHER_RIG is therefore 3m/-15deg, NOT the
 * ladder's own suggested 5m/6.5m families — a genuine, evidenced disagreement with the ladder
 * document's hand geometry, not a silent substitution. Declared gap: the ≥4m-wide/D≥2m-inside-both-
 * edges band rule (§ Rig-geometry qualification) is NOT exhaustively re-verified here (only D=8-12m
 * was swept, in 1m steps, one seed, one frame per cell) — D0 below is chosen inside the
 * EMPIRICALLY-CONFIRMED low-error zone (8-11m), not proven against the full rule. */
export const ROUND3_RIG_D0_M = 8;
export const CANDIDATE_HIGHER_RIG: RigConfig = Object.freeze({ droneAltitudeM: 3, mountPitchDeg: -15, hfovDeg: 70 });
export const CANDIDATE_HIGHER_RIG_D0_M = 9;

/** Increment B3: the bearing-rate/target-speed envelope this file's L2/L3b/L4 configs are drawn
 * from — filled in from `runReferenceCeiling`'s own measured `envelope` field once the fake-sensor
 * sweep (and, ideally, a real-GPU confirmation cell) has run; see WORKLOG.md for the exact numbers
 * and which run produced them. Exported as a mutable-looking but effectively frozen record so a
 * caller building these scenarios can see exactly what is measured vs assumed. */
export interface MeasuredEnvelope { bearingRateDegSAt80PctCentred: number | null; targetSpeedMpsAt80PctInRangeBand: number | null }

const round1 = (x: number) => Math.round(x * 10) / 10;

function commonFields(envelope: EnvelopeBounds) {
  return {
    sectorMemory: DEFAULT_SECTOR_MEMORY_CONFIG, searchVariant: 'sector-consequences' as const,
    freshWithinMs: 3000, lastSeenTrustworthyMs: 15000, lastSeenStaleMs: 30000,
    identityBearingToleranceRad: 10 * Math.PI / 180, identityRangeToleranceM: 2.0,
    perception: { scoreThreshold: 0.15 }, yawRateDegS: DEFAULT_YAW_RATE_DEG_S, rateWindowMs: DEFAULT_RATE_WINDOW_MS,
    envelope,
  };
}

// Unit E4b / A7: engine-review-e3's own "0.30000000000000004m in all 78 Round-3-rig requests"
// finding, reproduced and root-caused here (the previous unit's own live probe of a default TRACK
// request found no unrounded field, because it probed scenarios.ts's smoke scenarios, which use a
// hardcoded literal envelope with no arithmetic — this function, used only by the LADDER's own
// provisional rungs, is where the actual arithmetic lives): `Math.max(0.2, 1.8 - 1.5)` for the
// Round3 rig's own 1.8m altitude is NOT exactly 0.3 in binary floating point
// (`0.30000000000000004`) even though `1.8 - 1.5` mathematically is — `round1` here makes every
// downstream consumer (the goal sentence, the report) print a clean value.
function envelopeFor(rig: RigConfig): EnvelopeBounds {
  return { minAltitudeM: round1(Math.max(0.2, rig.droneAltitudeM - 1.5)), maxAltitudeM: round1(rig.droneAltitudeM + 4), maxRadiusFromOriginM: 60 };
}

/** L1 — hold a visible stationary object, one offset x range cell (provisional: one representative
 * offset/aspect/range cell — the ladder's own full 3x3 offset x range x 4-aspect sweep is a next
 * unit's job). Unit E4b / A6: `offsetDeg` now defaults to 15 (was 10, almost exactly AT N0=10.5deg
 * — engine-review-e3's own finding: `passive` trivially stayed "within N0" without ever correcting,
 * undermining the rung) — 15 > N0 by construction, so `passive` (never yaws) starts OUTSIDE the
 * central band and cannot pass by luck; `aspect` (default `'rear'`, the review's own confirmed-
 * reliable aspect — `'front'` is the review's own confirmed BLIND SPOT, kept available for a
 * deliberate stress cell, not the default) makes target aspect a declared factor per-call rather
 * than hard-coded; `hoverJitter` (A6) makes repeated acquisitions of this static scene genuinely
 * differ frame to frame instead of being byte-identical. */
export function buildL1(rig: RigConfig, d0: number, options: { offsetDeg?: number; aspect?: Aspect } = {}): EpisodeScenario {
  const offsetDeg = options.offsetDeg ?? 15;
  const aspect = options.aspect ?? 'rear';
  const start = offsetRangeStart({ offsetDeg, rangeM: d0, aspect });
  const envelope = envelopeFor(rig);
  return {
    id: `l1-provisional-${rig.droneAltitudeM}m${rig.mountPitchDeg}deg-${aspect}`,
    goal: { ...GOAL, requestedRangeM: d0 },
    durationMs: 20_000,
    world: {
      seed: 9301, droneAltitudeM: rig.droneAltitudeM, mountPitchDeg: rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
      droneInitialPosition: start.droneInitialPosition, droneInitialHeadingDeg: start.droneInitialHeadingDeg,
      carInitialPosition: start.carInitialPosition, carInitialHeadingDeg: start.carInitialHeadingDeg,
      carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0, startMovingAtMs: 10_000_000, headingDeg: 0 },
      hfovDeg: rig.hfovDeg, physicsDtMs: 20, hoverJitter: DEFAULT_HOVER_JITTER,
    },
    ...commonFields(envelope),
    rangeToleranceM: 1, centralBandFraction: 0.3,
    passCriteria: {
      minFollowLockFraction: 0.3, maxLongestLossMs: 10_000, maxContacts: 0, requireFirstDetectionByMs: 3_000, maxVetoedManeuvers: 0,
      minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: null, settlingPeriodMs: 2_000,
    },
    consequenceModel: 'stationary', rangeMenuKind: 'fixed-distance', questionMode: 'yaw-only',
  };
}

export { N0_DEG };

/** L2 — moving object, yaw only, at the measured bearing-rate envelope (falls back to the ladder's
 * own provisional 10deg/s if the envelope has not been measured yet — never silently 0). Unit E4b /
 * B2 (engine-review-e3 finding 2, "L2's bearing rate ... needs a constant-rate path"): now uses
 * `orbit` (world-bridge.ts) — an EXACT circle of radius D0 centred on the drone's own (fixed)
 * position, so the true bearing rate holds at exactly `bearingRateDegS` for the whole episode
 * (`lateral-crossing`'s old straight-line approximation decayed from ~7.8deg/s to ~1deg/s as range
 * grew 8->28m over 20s — the review's own measured figure). The drone stays fixed (L2's own
 * "isolate yaw-only, hold the drone's position fixed" rule). */
export function buildL2(rig: RigConfig, d0: number, envelope: MeasuredEnvelope): EpisodeScenario {
  const bearingRateDegS = envelope.bearingRateDegSAt80PctCentred ?? 10;
  const env = envelopeFor(rig);
  const radiusM = d0 + CAR_HALF_LENGTH_M;
  const angularRateRadS = bearingRateDegS * Math.PI / 180;
  const tangentHeadingDeg = (0 + (angularRateRadS >= 0 ? 90 : -90) + 360) % 360;
  return {
    id: `l2-provisional-${rig.droneAltitudeM}m${rig.mountPitchDeg}deg`,
    goal: { ...GOAL, requestedRangeM: d0 },
    durationMs: 20_000,
    world: {
      seed: 9302, droneAltitudeM: rig.droneAltitudeM, mountPitchDeg: rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
      droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
      carInitialPosition: { x: radiusM, y: 0 }, carInitialHeadingDeg: tangentHeadingDeg,
      carPath: { kind: 'orbit', centerX: 0, centerY: 0, radiusM, angularRateDegS: bearingRateDegS, startAngleDeg: 0 },
      hfovDeg: rig.hfovDeg, physicsDtMs: 20, hoverJitter: DEFAULT_HOVER_JITTER,
    },
    ...commonFields(env),
    rangeToleranceM: 1, centralBandFraction: 0.3,
    passCriteria: {
      minFollowLockFraction: 0.3, maxLongestLossMs: 10_000, maxContacts: 0, requireFirstDetectionByMs: 3_000, maxVetoedManeuvers: 0,
      minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: null, settlingPeriodMs: 4_000,
    },
    consequenceModel: 'measured-rate', rangeMenuKind: 'speed-hold', questionMode: 'yaw-only',
  };
}

/** L3a — commanded range, stationary target, fixed-distance menu. Start range offset from D0 by
 * MORE than the +-0.5m stationary tolerance (D0+2m) so passive cannot pass by construction. Unit
 * E4b / A6: `aspect` (default `'rear'`, same reasoning as L1) and `hoverJitter` — another static
 * scene, same "pose lottery" exposure L1 had. */
export function buildL3a(rig: RigConfig, d0: number, options: { aspect?: Aspect } = {}): EpisodeScenario {
  const aspect = options.aspect ?? 'rear';
  const startRangeM = d0 + 2;
  const start = offsetRangeStart({ offsetDeg: 0, rangeM: startRangeM, aspect });
  const env = envelopeFor(rig);
  return {
    id: `l3a-provisional-${rig.droneAltitudeM}m${rig.mountPitchDeg}deg-${aspect}`,
    goal: { ...GOAL, requestedRangeM: d0 },
    durationMs: 30_000,
    world: {
      seed: 9303, droneAltitudeM: rig.droneAltitudeM, mountPitchDeg: rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
      droneInitialPosition: start.droneInitialPosition, droneInitialHeadingDeg: start.droneInitialHeadingDeg,
      carInitialPosition: start.carInitialPosition, carInitialHeadingDeg: start.carInitialHeadingDeg,
      carPath: { kind: 'stationary-then-forward', forwardSpeedMps: 0, startMovingAtMs: 10_000_000, headingDeg: 0 },
      hfovDeg: rig.hfovDeg, physicsDtMs: 20, hoverJitter: DEFAULT_HOVER_JITTER,
    },
    ...commonFields(env),
    rangeToleranceM: 0.5, centralBandFraction: 0.3,
    passCriteria: {
      minFollowLockFraction: 0, maxLongestLossMs: 15_000, maxContacts: 0, requireFirstDetectionByMs: 3_000, maxVetoedManeuvers: 0,
      minTruthCentredFraction: null, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: 6_000,
    },
    consequenceModel: 'stationary', rangeMenuKind: 'fixed-distance', questionMode: 'range-only',
  };
}

/** Unit E4b / B2 ("speed profiles that are NOT menu speeds"): nudges a measured/declared speed off
 * every `SPEED_HOLD_MENU`/`buildSpeedHoldMenu` 0.5 m/s grid point (never below 0.3 m/s) so a
 * `constant` baseline cannot get lucky by exactly matching one menu choice to the target's own
 * cruise speed for a whole episode. */
function nonMenuSpeedMps(x: number): number { return Math.max(0.3, Math.round((x - 0.2) * 100) / 100); }

/** L3b — commanded range, moving target, speed-hold menu, at the measured target-speed envelope
 * (falls back to the ladder's own provisional ~2 m/s if not yet measured). Unit E4b / B2: the old
 * `lateral-crossing` path held one CONSTANT speed for the whole episode (and that speed was always
 * exactly a `SPEED_HOLD_MENU` option, e.g. the review's own "L3b/L4 ... passed by the constant
 * `hold+speed_1_0`" finding); `scripted-segments` now gives a genuine accelerate/cruise/decelerate/
 * stop profile at a NON-MENU cruise speed (`nonMenuSpeedMps`), 30s total: ramp up (10s, 4s ramp),
 * cruise (8s), ramp down to a stop (6s), hold stopped (6s). */
export function buildL3b(rig: RigConfig, d0: number, envelope: MeasuredEnvelope): EpisodeScenario {
  const cruiseMps = nonMenuSpeedMps(envelope.targetSpeedMpsAt80PctInRangeBand ?? 2);
  const env = envelopeFor(rig);
  return {
    id: `l3b-provisional-${rig.droneAltitudeM}m${rig.mountPitchDeg}deg`,
    goal: { ...GOAL, requestedRangeM: d0 },
    durationMs: 30_000,
    world: {
      seed: 9304, droneAltitudeM: rig.droneAltitudeM, mountPitchDeg: rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
      droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
      carInitialPosition: { x: d0 + CAR_HALF_LENGTH_M, y: 0 }, carInitialHeadingDeg: 0,
      carPath: {
        kind: 'scripted-segments',
        segments: [
          { durationMs: 10_000, headingDeg: 0, targetSpeedMps: cruiseMps, rampMs: 4_000 },
          { durationMs: 8_000, headingDeg: 0, targetSpeedMps: cruiseMps, rampMs: 0 },
          { durationMs: 6_000, headingDeg: 0, targetSpeedMps: 0, rampMs: 4_000 },
          { durationMs: 6_000, headingDeg: 0, targetSpeedMps: 0, rampMs: 0 },
        ],
      },
      hfovDeg: rig.hfovDeg, physicsDtMs: 20, hoverJitter: DEFAULT_HOVER_JITTER,
    },
    ...commonFields(env),
    rangeToleranceM: 1, centralBandFraction: 0.3,
    passCriteria: {
      minFollowLockFraction: 0, maxLongestLossMs: 15_000, maxContacts: 0, requireFirstDetectionByMs: 3_000, maxVetoedManeuvers: 0,
      minTruthCentredFraction: null, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: 8_000,
    },
    consequenceModel: 'measured-rate', rangeMenuKind: 'speed-hold', questionMode: 'range-only',
  };
}

/** L4 — yaw and range together, a target that turns/stops. Unit E4b / B2 (engine-review-e3 finding
 * 2, "L4's envelope and yaw axis ... envelope is a 60m radius but the follow path is ~135m ...
 * yaw axis does not discriminate, passive centred 1.000"): `gentle-curve`'s small (1.5m amplitude)
 * lateral oscillation at a monotonically-accumulating forward distance is replaced with a genuine
 * bounded PATROL — `scripted-segments` with real heading changes (0/90/180/270deg: forward, turn,
 * back, turn) and a stop, chosen so the car's own excursion from its start stays under ~27m (the
 * DRONE, which chases via speed-hold, therefore stays comfortably inside `envelopeFor`'s own 60m
 * `maxRadiusFromOriginM` for the whole 90s episode — verified empirically, see
 * `test/jev-find-follow-ladder-scenarios.test.ts`'s own envelope-adherence test and WORKLOG.md for
 * the measured max radius) instead of drifting further from origin every second. The repeated
 * heading changes also mean `passive` (never yaws) drifts far off-centre — a target oscillating
 * +-1.5m around a fixed bearing (the old path) is a much weaker yaw-axis stress than one that
 * actually turns 90-180deg relative to the drone's fixed heading. */
export function buildL4(rig: RigConfig, d0: number, envelope: MeasuredEnvelope): EpisodeScenario {
  const cruiseMps = nonMenuSpeedMps(Math.min(1.5, envelope.targetSpeedMpsAt80PctInRangeBand ?? 1.5));
  const env = envelopeFor(rig);
  return {
    id: `l4-provisional-${rig.droneAltitudeM}m${rig.mountPitchDeg}deg`,
    goal: { ...GOAL, requestedRangeM: d0 },
    durationMs: 90_000,
    world: {
      seed: 9305, droneAltitudeM: rig.droneAltitudeM, mountPitchDeg: rig.mountPitchDeg, droneMaxSpeedMps: 2.5,
      droneInitialPosition: { x: 0, y: 0 }, droneInitialHeadingDeg: 0,
      carInitialPosition: { x: d0 + CAR_HALF_LENGTH_M, y: 0 }, carInitialHeadingDeg: 0,
      carPath: {
        kind: 'scripted-segments',
        segments: [
          { durationMs: 15_000, headingDeg: 0, targetSpeedMps: cruiseMps, rampMs: 4_000 },   // forward, accelerating
          { durationMs: 10_000, headingDeg: 90, targetSpeedMps: cruiseMps, rampMs: 0 },      // turn left, cruise sideways
          { durationMs: 20_000, headingDeg: 180, targetSpeedMps: cruiseMps, rampMs: 0 },     // turn, head back
          { durationMs: 8_000, headingDeg: 180, targetSpeedMps: 0, rampMs: 8_000 },          // decelerate to a stop
          { durationMs: 5_000, headingDeg: 180, targetSpeedMps: 0, rampMs: 0 },              // hold stopped
          { durationMs: 15_000, headingDeg: 270, targetSpeedMps: cruiseMps, rampMs: 4_000 }, // turn, accelerate away again
          { durationMs: 17_000, headingDeg: 0, targetSpeedMps: cruiseMps, rampMs: 0 },       // final turn, cruise
        ],
      },
      hfovDeg: rig.hfovDeg, physicsDtMs: 20, hoverJitter: DEFAULT_HOVER_JITTER,
    },
    ...commonFields(env),
    rangeToleranceM: 1, centralBandFraction: 0.3,
    passCriteria: {
      minFollowLockFraction: 0.3, maxLongestLossMs: 20_000, maxContacts: 0, requireFirstDetectionByMs: 3_000, maxVetoedManeuvers: 0,
      minTruthCentredFraction: 0.8, minTruthInRangeBandFraction: 0.8, settlingPeriodMs: 10_000,
    },
    consequenceModel: 'measured-rate', rangeMenuKind: 'speed-hold', questionMode: 'both',
  };
}

export function buildProvisionalLadder(rig: RigConfig, d0: number, envelope: MeasuredEnvelope) {
  return { l1: buildL1(rig, d0), l2: buildL2(rig, d0, envelope), l3a: buildL3a(rig, d0), l3b: buildL3b(rig, d0, envelope), l4: buildL4(rig, d0, envelope) };
}

export { ROUND3_RIG };
