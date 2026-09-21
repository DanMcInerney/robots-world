/** Scoring: evaluator-only truth, separate module. Never imported by encoders/controllers (see
 * checks.ts's structural scan). Pass criteria are supplied per scenario config (see scenarios.ts),
 * not hard-coded here. Coverage gaps are reported as unknown, never as success.
 *
 * Identity scoring compares the bound candidate's DELIVERED bearing/range against the evaluator's
 * true bearing/range to the target (a bearing+range agreement check), rather than a projected-box
 * IoU against the renderer's saved mask (declared simplification — see the coordinator report's
 * "gaps" section for why: this engine computes evaluator truth analytically from Rapier state, see
 * evaluator.ts, rather than decoding the renderer's saved depth/mask files, so no target mask is
 * available to intersect against a candidate box). This still correctly distinguishes the true
 * target from a lookalike at a different bearing/range, which is what "following the right object"
 * requires; it is a coarser check than exact mask IoU when a lookalike is very close by.
 *
 * "First sensor detection" uses the sensor's own acquisition time (a class/colour match exists in
 * that frame's objects); "first controller-visible detection" uses observationAvailableSimMs (the
 * time that frame's binding actually reached the controller) — an independent design review
 * flagged that using camera-first-seen for both clauses hides real perception/binding latency.
 */
import { SPEED_HOLD_MENU, TRACK_RANGE_MENU, TRACK_YAW_MENU } from './maneuver.ts';
import type { BindResult, DecisionRecord } from './types.ts';
import type { EvaluatorSnapshot } from './evaluator.ts';

export interface ContactEvent { simMs: number; a: string; b: string }
export interface EnvelopeBounds { minAltitudeM: number; maxAltitudeM: number; maxRadiusFromOriginM: number }
export interface PassCriteria {
  minFollowLockFraction: number;
  maxLongestLossMs: number;
  maxContacts: number;
  requireFirstDetectionByMs: number | null;
  maxVetoedManeuvers: number;
  /** engine-review-e1 finding 7: truth-based pass gates, evaluated from evaluator.ts's own
   * analytic truth over EVERY acquisition (not just sensor-bound decisions), from
   * `settlingPeriodMs` onward. `null` (or omitted) leaves that gate un-evaluated — existing
   * PassCriteria literals stay valid without these fields (backward compatible). */
  minTruthCentredFraction?: number | null;
  minTruthInRangeBandFraction?: number | null;
  settlingPeriodMs?: number;
}

export interface ScoringInput {
  decisions: readonly DecisionRecord[];
  evaluatorByAcquiredSimMs: ReadonlyMap<number, EvaluatorSnapshot>;
  /** engine-review-e2 finding 1: "sensor metrics (detected/bound) per ACQUISITION with a declared
   * denominator" — one entry per camera acquisition (not per decision; see episode.ts's
   * `performAcquisition`), used for `detectedFraction`/`boundFraction`/`framedFraction`/
   * `rangeErrorM` instead of the old decision-cadence sampling, which under-counted by roughly half
   * once acquisition genuinely decoupled from (slower) decision cadence. Optional: when omitted
   * (e.g. a unit test built before this finding existed), falls back to one entry per DECISION's
   * own bind — strictly less accurate (decision cadence, not acquisition cadence) but keeps older
   * callers valid rather than silently scoring an empty episode. */
  bindByAcquiredSimMs?: ReadonlyMap<number, { status: BindResult['status']; boundBearingRightRad: number | null; boundRangeM: number | null }>;
  contacts: readonly ContactEvent[];
  durationMs: number;
  requestedRangeM: number;
  rangeToleranceM: number;
  hfovDeg: number;
  centralBandFraction: number;
  cameraPeriodMs: number;
  identityBearingToleranceRad: number;
  identityRangeToleranceM: number;
  envelope: EnvelopeBounds;
  originPosition: { x: number; y: number };
  /** engine-review-e1 finding 1: every command receipt the world REJECTED for a reason other than
   * a declared executor veto (a veto never reaches `port.command()` with the risky action at all).
   * Any entry here invalidates the episode's validity, hard-wired (not a configurable criterion). */
  unexpectedRejections?: readonly { decisionIndex: number; reason: string | undefined }[];
}

function quantile(sortedAscending: number[], q: number): number | null {
  if (!sortedAscending.length) return null;
  const idx = Math.min(sortedAscending.length - 1, Math.max(0, Math.round(q * (sortedAscending.length - 1))));
  return sortedAscending[idx]!;
}

export interface EpisodeScore {
  decisionCount: number;
  skippedAcquisitions: number;
  timeToFirstSensorDetectionMs: number | null;
  timeToFirstControllerVisibleDetectionMs: number | null;
  timeToFollowLockMs: number | null;
  visibleFraction: number; // evaluator truth: target within declared FOV
  detectedFraction: number; // sensor: any goal-matching object present
  boundFraction: number; // binder: unambiguously bound
  framedFraction: number; // bound AND within the central band
  correctIdentityFraction: number | null; // among bound decisions, fraction matching evaluator truth
  rangeErrorM: { medianAbs: number | null; p95Abs: number | null; fractionWithinTolerance: number | null; n: number };
  longestLossMs: number;
  reacquisitions: { count: number; delaysMs: number[] };
  contacts: number;
  envelopeViolations: number;
  /** Maneuver-executor vetoes (e.g. a translate refused for measured-blocked clearance): a LOGGED
   * guard that counts against the controller's choice, never a silent rescue (item 5; an
   * independent design review: "executor vetoes ... are logged and scored as harmful decisions,
   * never silent rescues"). */
  vetoedManeuvers: number;
  wallTime: { totalCycleWallMs: number; totalAcquireWallMs: number; totalControllerWallMs: number; perDecisionMeanWallMs: number | null };
  tokens: { totalInputTokens: number | null; realCalls: number };
  coverageUnknownMs: number;
  /** engine-review-e1 finding 7: truth-only metrics computed from evaluator.ts's analytic ground
   * truth over EVERY entry in `evaluatorByAcquiredSimMs` (every acquisition, decoupled from
   * decision cadence — see episode.ts), never from the sensor/binder's delivered estimate. Kept
   * separate from `boundFraction`/`framedFraction`/`rangeErrorM` (which stay sensor/binder-based,
   * i.e. "what the pipeline actually delivered") so a reviewer can tell a perception/binder failure
   * apart from a genuine positioning failure. `settlingPeriodMs`-eligible acquisitions only. */
  truth: {
    sampleCount: number;
    centredFraction: number;
    inRangeBandFraction: number;
    rangeErrorM: { medianAbs: number | null; p95Abs: number | null; n: number };
  };
  /** A5 (engine-review-e3 finding 6, "report per-run sensor-minus-truth bias"): for every
   * ACQUISITION where the binder delivered a bound range AND evaluator truth is available for that
   * same acquisition (`bindByAcquiredSimMs`/`evaluatorByAcquiredSimMs`, keyed identically), the
   * SIGNED difference `boundRangeM - trueNearestSurfaceRangeM` — positive means the sensor reads
   * FARTHER than truth, matching the review's own reported sign convention (e.g. "Round 3 rig rear
   * +0.31, ... oblique +0.71"). This is a raw per-run DIAGNOSTIC (never used as a pass/fail gate,
   * never fed back into any decision/scoring logic), meant to be compared across runs/aspects/rigs
   * to catch exactly the kind of aspect-dependent evaluator-definition drift the review found —
   * distinct from `rangeErrorM` (sensor vs the GOAL distance) and `truth.rangeErrorM` (truth vs the
   * goal distance), neither of which isolates the sensor's own bias against truth. */
  sensorRangeBiasM: { medianM: number | null; meanM: number | null; n: number };
  /** engine-review-e1 finding 1: hard-wired episode validity — true only when the world never
   * rejected a command for a reason other than a declared executor veto. `pass.decided` is always
   * false when this is false, regardless of what PassCriteria says. */
  validity: { valid: boolean; unexpectedRejectionCount: number; reasons: string[] };
  /** Increment B3 (extended engine-review-e2 finding 2: EVERY option family, not just yaw and
   * fixed-distance): printed (declared) vs realised per-option-family fidelity, aggregated from
   * consecutive TRACK decisions. Declared approximate under a MOVING target (realised values are
   * measured between two decisions' own acquisition poses/ranges, which include the target's own
   * motion; see the dedicated stationary-target unit test for the acceptance-grade, motion-free
   * figure). `null` when there were fewer than 2 usable consecutive track samples across every
   * family. */
  consequenceFidelity: {
    yawAbsErrorDeg: { medianAbs: number | null; p95Abs: number | null; n: number };
    rangeAbsErrorM: { medianAbs: number | null; p95Abs: number | null; n: number };
    /** speed-hold's declared outcome is a RATE (m/s closing), not a fixed step — compares it
     * against the realised closing rate between consecutive bound ranges, `hold` (0 m/s) included. */
    speedHoldAbsErrorMps: { medianAbs: number | null; p95Abs: number | null; n: number };
  } | null;
  pass: { decided: boolean; criteria: PassCriteria; reasons: string[] } | null;
}

function quantileAbs(values: number[]): { medianAbs: number | null; p95Abs: number | null; n: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianAbs: quantile(sorted, 0.5), p95Abs: quantile(sorted, 0.95), n: values.length };
}

const wrap180 = (deg: number) => ((deg + 180) % 360 + 360) % 360 - 180;

/** Increment B3's consequence-fidelity check, extended (engine-review-e2 finding 2) to cover EVERY
 * range-menu option family with its own `n`, not just yaw and fixed-distance.
 *
 * engine-review-e3 finding 3 ("the speed-hold fidelity metric is BROKEN"): the previous version
 * measured "realised closing rate" as `(cur.boundRangeM - next.boundRangeM) / dt` — the SENSOR-
 * delivered range's own closing rate, which necessarily includes the TARGET's own motion (a
 * speed-hold menu is only ever offered on a MOVING-target rung) on top of noisy, binder-delivered
 * range readings — measured to report errors like 2.17 m/s against a true drone speed error under
 * 0.01 m/s. Fixed by measuring every family from EVALUATOR TRUTH camera position/heading (never the
 * sensor's delivered estimate, never the noisy own-state odometry either): speed-hold now compares
 * the declared DRONE ground-speed SETPOINT against the drone's own REALISED ground speed (true
 * position delta / dt) — independent of the target's own motion entirely, exactly "realised ground
 * motion vs printed setpoint" per the assignment. Fixed-distance range similarly now compares the
 * declared displacement against the drone's own TRUE displacement magnitude (not a sensor range
 * delta, which conflates the drone's motion with any target motion AND sensor noise/bias). Yaw
 * fidelity now reads the evaluator's own TRUE `cameraHeadingDeg` (previously the small-but-nonzero
 * own-state noise, +-0.5deg — this was not the reported break, but "truth" should mean truth
 * throughout, not selectively). */
function computeConsequenceFidelity(decisions: readonly DecisionRecord[], evaluatorByAcquiredSimMs: ReadonlyMap<number, EvaluatorSnapshot>): EpisodeScore['consequenceFidelity'] {
  const yawErrors: number[] = [], rangeErrors: number[] = [], speedHoldErrors: number[] = [];
  for (let i = 0; i < decisions.length - 1; i++) {
    const cur = decisions[i]!, next = decisions[i + 1]!;
    if (cur.mode !== 'track' || next.mode !== 'track') continue;
    const curTruth = evaluatorByAcquiredSimMs.get(cur.acquiredSimMs);
    const nextTruth = evaluatorByAcquiredSimMs.get(next.acquiredSimMs);
    if (!curTruth || !nextTruth) continue;
    if (cur.chosenYawId) {
      const yawDef = TRACK_YAW_MENU[cur.chosenYawId];
      if (yawDef && yawDef.kind === 'yaw') {
        const predicted = Math.abs(yawDef.yawDeg!);
        const realised = Math.abs(wrap180(nextTruth.cameraHeadingDeg - curTruth.cameraHeadingDeg));
        yawErrors.push(Math.abs(realised - predicted));
      }
    }
    if (cur.chosenRangeId) {
      // Fixed-distance and speed-hold are two DIFFERENT menus that may reuse the same id (e.g.
      // `hold`) — check the fixed-distance menu first (kind 'translate'), then fall back to
      // speed-hold (kind 'speed_hold'); a scenario only ever offers one of the two menus at a time
      // (`rangeMenuKind`), so there is no ambiguity in which one actually produced this choice.
      const fixedDef = TRACK_RANGE_MENU[cur.chosenRangeId];
      const speedDef = SPEED_HOLD_MENU[cur.chosenRangeId];
      const dxM = nextTruth.cameraPosition.x - curTruth.cameraPosition.x, dyM = nextTruth.cameraPosition.y - curTruth.cameraPosition.y;
      const trueGroundDistanceM = Math.hypot(dxM, dyM);
      if (fixedDef && fixedDef.kind === 'translate') {
        rangeErrors.push(Math.abs(trueGroundDistanceM - fixedDef.distanceM!));
      } else if (speedDef && speedDef.kind === 'speed_hold') {
        const dtS = (next.acquiredSimMs - cur.acquiredSimMs) / 1000;
        if (dtS > 0) {
          const declaredSpeedMps = Math.abs(speedDef.speedMps!);
          const realisedSpeedMps = trueGroundDistanceM / dtS;
          speedHoldErrors.push(Math.abs(realisedSpeedMps - declaredSpeedMps));
        }
      }
    }
  }
  if (yawErrors.length === 0 && rangeErrors.length === 0 && speedHoldErrors.length === 0) return null;
  return { yawAbsErrorDeg: quantileAbs(yawErrors), rangeAbsErrorM: quantileAbs(rangeErrors), speedHoldAbsErrorMps: quantileAbs(speedHoldErrors) };
}

export function scoreEpisode(input: ScoringInput, criteria: PassCriteria | null = null): EpisodeScore {
  const { decisions } = input;
  const bandLimitRad = (input.hfovDeg / 2) * input.centralBandFraction * Math.PI / 180;
  let currentLossMs = 0, longestLossMs = 0;
  let timeToFirstSensorDetectionMs: number | null = null, timeToFirstControllerVisibleDetectionMs: number | null = null, timeToFollowLockMs: number | null = null;
  let wasBound = false, lossStartMs: number | null = null;
  const reacquisitionDelaysMs: number[] = [];
  let correctIdentityCount = 0, identityEligible = 0;
  let envelopeViolations = 0;
  let vetoedManeuvers = 0;
  let totalCycleWallMs = 0, totalAcquireWallMs = 0, totalControllerWallMs = 0, totalInputTokens = 0, realCalls = 0, hasTokens = false;

  // engine-review-e2 finding 1: detected/bound/framed/range-error are now measured per ACQUISITION
  // (declared denominator: `cameraPeriodMs` per acquisition, capped at the episode boundary), not
  // per decision — decision cadence is now materially slower than acquisition cadence by design
  // (findings 1-3), so sampling at decision cadence silently discarded roughly half of the
  // episode's actual coverage.
  let coveredMs = 0, visibleMs = 0, detectedMs = 0, boundMs = 0, framedMs = 0;
  const rangeErrorsAbs: number[] = [];
  // A5: signed sensor-minus-truth range bias, one sample per bound acquisition with known truth.
  const sensorRangeBiasesM: number[] = [];
  const bindByAcquiredSimMs = input.bindByAcquiredSimMs
    ?? new Map(decisions.map(d => [d.acquiredSimMs, { status: d.bind.status, boundBearingRightRad: d.boundBearingRightRad ?? null, boundRangeM: d.boundRangeM ?? null }]));
  const acquisitionSimMsSorted = [...bindByAcquiredSimMs.keys()].sort((a, b) => a - b);
  for (const simMs of acquisitionSimMsSorted) {
    const bind = bindByAcquiredSimMs.get(simMs)!;
    const spanMs = Math.max(0, Math.min(input.cameraPeriodMs, input.durationMs - simMs));
    if (spanMs <= 0) continue;
    coveredMs += spanMs;
    const evaluatorSnapshot = input.evaluatorByAcquiredSimMs.get(simMs) ?? null;
    if (evaluatorSnapshot?.targetWithinFov) visibleMs += spanMs;
    const detected = bind.status !== 'none';
    const bound = bind.status === 'bound';
    if (detected) detectedMs += spanMs;
    if (bound) boundMs += spanMs;
    if (detected && timeToFirstSensorDetectionMs === null) timeToFirstSensorDetectionMs = simMs;
    if (bound && bind.boundBearingRightRad !== null && Math.abs(bind.boundBearingRightRad) <= bandLimitRad) framedMs += spanMs;
    if (bound && bind.boundRangeM !== null) rangeErrorsAbs.push(Math.abs(bind.boundRangeM - input.requestedRangeM));
    if (bound && bind.boundRangeM !== null && evaluatorSnapshot) sensorRangeBiasesM.push(bind.boundRangeM - evaluatorSnapshot.trueNearestSurfaceRangeM);
  }

  for (const [i, decision] of decisions.entries()) {
    void i;
    const bound = decision.bind.status === 'bound';
    // "First CONTROLLER-visible detection" and "follow lock" stay decision-cadence (they are about
    // when a DECISION delivered a usable binding to the controller, not raw sensor flicker); loss/
    // reacquisition likewise reflect what the controller actually experienced between decisions.
    if (bound && timeToFirstControllerVisibleDetectionMs === null) timeToFirstControllerVisibleDetectionMs = decision.observationAvailableSimMs;
    const framed = bound && decision.boundBearingRightRad !== undefined && decision.boundBearingRightRad !== null && Math.abs(decision.boundBearingRightRad) <= bandLimitRad;
    if (bound && framed && timeToFollowLockMs === null) {
      const rangeOk = decision.boundRangeM === undefined || decision.boundRangeM === null || Math.abs(decision.boundRangeM - input.requestedRangeM) <= input.rangeToleranceM;
      if (rangeOk) timeToFollowLockMs = decision.acquiredSimMs;
    }

    if (bound) {
      if (wasBound === false && lossStartMs !== null) reacquisitionDelaysMs.push(decision.acquiredSimMs - lossStartMs);
      lossStartMs = null; currentLossMs = 0;
    } else {
      if (lossStartMs === null) lossStartMs = decision.acquiredSimMs;
      const nextSimMs = decisions[i + 1]?.acquiredSimMs ?? input.durationMs;
      currentLossMs = Math.max(0, nextSimMs - lossStartMs);
      longestLossMs = Math.max(longestLossMs, currentLossMs);
    }
    wasBound = bound;

    const evaluatorSnapshot = input.evaluatorByAcquiredSimMs.get(decision.acquiredSimMs) ?? null;
    if (bound && evaluatorSnapshot && decision.boundBearingRightRad !== undefined && decision.boundBearingRightRad !== null) {
      identityEligible++;
      const bearingOk = Math.abs(decision.boundBearingRightRad - evaluatorSnapshot.trueBearingRightRad) <= input.identityBearingToleranceRad;
      const rangeOk = decision.boundRangeM === null || decision.boundRangeM === undefined || Math.abs(decision.boundRangeM - evaluatorSnapshot.trueNearestSurfaceRangeM) <= input.identityRangeToleranceM;
      if (bearingOk && rangeOk) correctIdentityCount++;
    }

    if (evaluatorSnapshot) {
      const radius = Math.hypot(evaluatorSnapshot.cameraPosition.x - input.originPosition.x, evaluatorSnapshot.cameraPosition.y - input.originPosition.y);
      if (evaluatorSnapshot.cameraPosition.z < input.envelope.minAltitudeM || evaluatorSnapshot.cameraPosition.z > input.envelope.maxAltitudeM || radius > input.envelope.maxRadiusFromOriginM) envelopeViolations++;
    }
    if (decision.maneuverVeto) vetoedManeuvers++;

    totalCycleWallMs += decision.cycleWallMs; totalAcquireWallMs += decision.acquireWallMs; totalControllerWallMs += decision.controllerWallMs;
    if (decision.response.usage?.input_tokens !== undefined) { totalInputTokens += decision.response.usage.input_tokens; hasTokens = true; }
    if (!decision.response.synthetic) realCalls++;
  }
  if (lossStartMs !== null) longestLossMs = Math.max(longestLossMs, currentLossMs);

  const sortedAbs = [...rangeErrorsAbs].sort((a, b) => a - b);
  const withinTolerance = rangeErrorsAbs.filter(e => e <= input.rangeToleranceM).length;

  // engine-review-e1 finding 7: truth-only metrics over EVERY acquisition (evaluatorByAcquiredSimMs
  // now holds one entry per camera acquisition, not one per decision — see episode.ts), never the
  // sensor/binder's delivered estimate, from the declared settling period onward.
  const settlingFromSimMs = criteria?.settlingPeriodMs ?? 0;
  const truthFrames = [...input.evaluatorByAcquiredSimMs.entries()].filter(([simMs]) => simMs >= settlingFromSimMs).map(([, snapshot]) => snapshot);
  let truthCentredCount = 0, truthInRangeCount = 0;
  const truthRangeErrorsAbs: number[] = [];
  for (const frame of truthFrames) {
    if (frame.targetWithinFov && Math.abs(frame.trueBearingRightRad) <= bandLimitRad) truthCentredCount++;
    const err = Math.abs(frame.trueNearestSurfaceRangeM - input.requestedRangeM);
    truthRangeErrorsAbs.push(err);
    if (err <= input.rangeToleranceM) truthInRangeCount++;
  }
  const truthRangeSorted = [...truthRangeErrorsAbs].sort((a, b) => a - b);
  const sensorRangeBiasSorted = [...sensorRangeBiasesM].sort((a, b) => a - b);
  const meanOrNull = (values: readonly number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

  const unexpectedRejections = input.unexpectedRejections ?? [];
  const validity = {
    valid: unexpectedRejections.length === 0,
    unexpectedRejectionCount: unexpectedRejections.length,
    reasons: unexpectedRejections.map(r => `decision ${r.decisionIndex}: command rejected (${r.reason ?? 'no reason given'})`),
  };

  const score: EpisodeScore = {
    decisionCount: decisions.length,
    skippedAcquisitions: decisions.reduce((n, d) => n + d.skippedAcquisitions, 0),
    timeToFirstSensorDetectionMs, timeToFirstControllerVisibleDetectionMs, timeToFollowLockMs,
    visibleFraction: input.durationMs ? visibleMs / input.durationMs : 0,
    detectedFraction: input.durationMs ? detectedMs / input.durationMs : 0,
    boundFraction: input.durationMs ? boundMs / input.durationMs : 0,
    framedFraction: input.durationMs ? framedMs / input.durationMs : 0,
    correctIdentityFraction: identityEligible ? correctIdentityCount / identityEligible : null,
    rangeErrorM: { medianAbs: quantile(sortedAbs, 0.5), p95Abs: quantile(sortedAbs, 0.95), fractionWithinTolerance: rangeErrorsAbs.length ? withinTolerance / rangeErrorsAbs.length : null, n: rangeErrorsAbs.length },
    longestLossMs,
    reacquisitions: { count: reacquisitionDelaysMs.length, delaysMs: reacquisitionDelaysMs },
    contacts: input.contacts.length,
    envelopeViolations,
    vetoedManeuvers,
    wallTime: { totalCycleWallMs, totalAcquireWallMs, totalControllerWallMs, perDecisionMeanWallMs: decisions.length ? totalCycleWallMs / decisions.length : null },
    tokens: { totalInputTokens: hasTokens ? totalInputTokens : null, realCalls },
    coverageUnknownMs: Math.max(0, input.durationMs - coveredMs),
    truth: {
      sampleCount: truthFrames.length,
      centredFraction: truthFrames.length ? truthCentredCount / truthFrames.length : 0,
      inRangeBandFraction: truthFrames.length ? truthInRangeCount / truthFrames.length : 0,
      rangeErrorM: { medianAbs: quantile(truthRangeSorted, 0.5), p95Abs: quantile(truthRangeSorted, 0.95), n: truthRangeErrorsAbs.length },
    },
    sensorRangeBiasM: { medianM: quantile(sensorRangeBiasSorted, 0.5), meanM: meanOrNull(sensorRangeBiasesM), n: sensorRangeBiasesM.length },
    validity,
    consequenceFidelity: computeConsequenceFidelity(decisions, input.evaluatorByAcquiredSimMs),
    pass: null,
  };
  if (criteria) {
    const reasons: string[] = [];
    if (score.boundFraction < criteria.minFollowLockFraction) reasons.push(`bound fraction ${score.boundFraction.toFixed(3)} < required ${criteria.minFollowLockFraction}`);
    if (score.longestLossMs > criteria.maxLongestLossMs) reasons.push(`longest loss ${score.longestLossMs}ms > allowed ${criteria.maxLongestLossMs}ms`);
    if (score.contacts > criteria.maxContacts) reasons.push(`${score.contacts} contacts > allowed ${criteria.maxContacts}`);
    if (score.vetoedManeuvers > criteria.maxVetoedManeuvers) reasons.push(`${score.vetoedManeuvers} vetoed maneuvers > allowed ${criteria.maxVetoedManeuvers}`);
    if (criteria.requireFirstDetectionByMs !== null && (score.timeToFirstControllerVisibleDetectionMs === null || score.timeToFirstControllerVisibleDetectionMs > criteria.requireFirstDetectionByMs)) reasons.push(`no controller-visible detection by ${criteria.requireFirstDetectionByMs}ms`);
    if (criteria.minTruthCentredFraction != null && score.truth.centredFraction < criteria.minTruthCentredFraction) reasons.push(`truth-centred fraction ${score.truth.centredFraction.toFixed(3)} < required ${criteria.minTruthCentredFraction} (from settling period ${criteria.settlingPeriodMs ?? 0}ms)`);
    if (criteria.minTruthInRangeBandFraction != null && score.truth.inRangeBandFraction < criteria.minTruthInRangeBandFraction) reasons.push(`truth-in-range-band fraction ${score.truth.inRangeBandFraction.toFixed(3)} < required ${criteria.minTruthInRangeBandFraction} (from settling period ${criteria.settlingPeriodMs ?? 0}ms)`);
    // engine-review-e1 finding 1: hard-wired, not a configurable criterion — any unexpected
    // rejection always fails, regardless of what the scenario's PassCriteria otherwise says.
    if (!score.validity.valid) reasons.push(`episode invalid: ${score.validity.unexpectedRejectionCount} unexpected command rejection(s): ${score.validity.reasons.join('; ')}`);
    score.pass = { decided: reasons.length === 0, criteria, reasons };
  }
  return score;
}
