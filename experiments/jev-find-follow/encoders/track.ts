/** track encoder: the one winning representation from this repo's own campaign
 * (experiments/jev-spatial-refinement/live-adapter.ts's `after-bearing`, 29%->74% framing, F61;
 * experiments/jev-scout-encodings/range.ts's `after-range`, 116/116 across both splits, F75).
 * Two independent Choice questions in one call: `yaw` with the per-option resulting target
 * bearing for EVERY yaw option, and `range` with the per-option resulting range/signed error for
 * EVERY range option (unknown range -> explicit unknown, options still listed). Every request
 * repeats the exact goal, a plainly stated policy that ENTAILS the scored criterion (F52), two
 * short command receipts, and explicit unknowns. Consequences are symmetric, unranked, labelled
 * conditional calculations — checked mechanically by checks.ts, not merely by convention.
 *
 * `boundBearingRightRad`/`boundBearingUpRad`/`boundRangeM`/`ownState` are the CALLER's job to seed
 * correctly: episode.ts passes the PREDICTED state at the command's application time (pending
 * in-flight yaw/translation already accounted for — engine-review-e1 finding 2), not the raw
 * acquisition-time measurement, so this module's own per-option reprojection composes correctly on
 * top of an already-correct baseline. `evidenceSource`/`evidenceAgeMs` label WHICH kind of baseline
 * that was (a fresh bound measurement, or a last-seen record used while track mode has no current
 * binding — finding 5/increment B4: a miss must not collapse to null consequences that make hold
 * look like the only sane choice).
 *
 * `consequenceModel` implements the ladder's three-way switch (`stationary | measured-rate |
 * explicitly-unknown-prediction`), identical facts/menus across all three — only the formula
 * differs. `rangeMenu`/`rangeMenuKind` select the fixed-distance menu (stationary-target rungs
 * only) or the speed-hold menu (any moving-target rung, this engine's two smoke scenarios).
 */
import { reprojectBearingAfterYaw } from '../camera-geometry.ts';
import { SPEED_HOLD_HORIZON_S, SPEED_HOLD_MENU, TRACK_RANGE_MENU, TRACK_YAW_MENU } from '../maneuver.ts';
import type { RateEstimate } from '../rate-estimate.ts';
import type { ChoiceQuestion, DecisionRequest, EnvelopeBounds, Goal, ManeuverMenu, OwnState } from '../types.ts';

export type ConsequenceModel = 'stationary' | 'measured-rate' | 'explicitly-unknown-prediction';
export type RangeMenuKind = 'fixed-distance' | 'speed-hold';

// engine-review-e2 finding 6: `current_view.bearing_deg`/`range_m` are a PREDICTION for the
// command's own future application instant (finding 2's fix — the freshest sensor measurement
// reprojected onto the predicted pose at application time), never the raw same-instant sensor
// reading; the wording below says so explicitly rather than implying a direct measurement.
const NOTICE = 'Camera-relative bearing/range, PREDICTED for this command\'s own application instant from the freshest stereo-object sensor measurement (schema stereo-objects/2) reprojected forward — not a raw same-instant sensor reading. Bearing is degrees, positive right; range is metres to the visible surface along the predicted line of sight, or explicitly unknown.';
const FRAME = 'Heading uses the ENU plane: east is 0, north is +90, wrapped into [0,360). Positive yaw turns left; a left yaw increases the target\'s apparent rightward bearing by the same amount under a stationary-target hypothesis.';
// A7 (engine-review-e3 finding 7): "Decide independently of the range/yaw question" previously
// appeared verbatim even in a single-axis request (yaw-only/range-only), where the OTHER question
// is not asked at all — nothing to "decide independently of", so the clause was confusing rather
// than clarifying. Now a function of the actual questionMode: the independence clause is stated
// only when the other axis's question genuinely coexists in the same request (questionMode='both').
function yawInstructions(questionMode: 'both' | 'yaw-only' | 'range-only'): string {
  return 'Choose the single yaw action that satisfies the policy stated in state.component_goal_yaw, using only the facts in this state.'
    + (questionMode === 'both' ? ' Decide independently of the range question.' : '');
}
function rangeInstructions(questionMode: 'both' | 'yaw-only' | 'range-only'): string {
  return 'Choose the single range action that satisfies the policy stated in state.component_goal_range, using only the facts in this state.'
    + (questionMode === 'both' ? ' Decide independently of the yaw question.' : '');
}

function componentGoalYaw(targetDescription: string): string {
  return `Choose the yaw action whose resulting bearing has the smallest absolute value (keeps ${targetDescription} horizontally nearest the image centre). Hold is correct only when no other action reduces the absolute resulting bearing further.`;
}
function componentGoalRange(targetDescription: string, requestedRangeM: number): string {
  return `Choose the range action whose resulting range has the smallest absolute error from the requested ${requestedRangeM} m follow distance from ${targetDescription}. If the measured range is unavailable, hold; do not commit to an unsupported movement. An action that increases the absolute error beyond its current value is wrong; holding without improving is acceptable only when no action reduces the error further.`;
}

function yawCriteria(): Record<string, string> {
  return Object.fromEntries(Object.entries(TRACK_YAW_MENU).map(([id, def]) => [id, def.kind === 'hold' ? 'Hold the current heading. Position is unchanged.' : `Yaw the camera heading ${Math.abs(def.yawDeg!)} degrees ${def.yawDeg! > 0 ? 'left' : 'right'}. Position is unchanged.`]));
}
function rangeCriteria(menu: ManeuverMenu): Record<string, string> {
  return Object.fromEntries(Object.entries(menu).map(([id, def]) => {
    if (def.kind === 'hold' || (def.kind === 'speed_hold' && def.speedMps === 0)) return [id, 'Hold: 0.0 m/s closing speed. No committed translation.'];
    if (def.kind === 'speed_hold') return [id, `Close at ${def.speedMps!.toFixed(1)} m/s along the current bearing to the target, held under lease until the next decision.`];
    return [id, `${def.directionOffsetDeg === 0 ? 'Approach the target, decreasing range, by' : 'Retreat from the target, increasing range, by'} ${def.distanceM} m along the measured line of sight.`];
  }));
}

export interface TrackEncoderInput {
  goal: Goal;
  targetBound: boolean;
  boundBearingRightRad: number | null;
  boundBearingUpRad: number | null;
  boundRangeM: number | null;
  ownState: OwnState;
  mountPitchRad: number;
  receipts: { command: string; appliedMsAgo: number; result: string }[];
  /** Where the (possibly last-seen-derived) bearing/range baseline above came from — rendered so
   * Jev/reference never mistakes a stale, aged reading for a fresh measurement. */
  evidenceSource: 'bound' | 'last-seen' | 'none';
  evidenceAgeMs?: number;
  consequenceModel: ConsequenceModel;
  rate: RateEstimate | null;
  rangeMenuKind: RangeMenuKind;
  /** Increment B1: single-axis question modes (the ladder's L1/L2 rungs ask ONLY the yaw or ONLY
   * the range question, isolating one axis) alongside the default two-parallel-question mode. Only
   * the SELECTED axis/axes' question(s) and consequence block(s) are rendered — the facts an
   * unasked axis would need (current_view/rate_estimate/receipts) stay identical regardless, so
   * switching modes never changes anything but which question(s) are posed. Engine-side wiring
   * (episode.ts): a not-asked axis's in-flight command now defaults to 'hold' every decision — see
   * episode.ts's `EpisodeScenario.questionMode` docstring for the reasoning. */
  questionMode?: 'both' | 'yaw-only' | 'range-only';
  /** Increment B1: the ladder requires every goal sentence to state N (central-band half-width),
   * D/tolerance (range) and the operating envelope NUMERICALLY, not merely as scored criteria the
   * request text never mentions (`docs/jev-find-follow-ladder.md`'s "Goal-sentence wording,
   * corrected" and "harmful events" sections). `hfovDeg`/`centralBandFraction` compute N exactly as
   * scoring.ts's own `bandLimitRad` does ((hfovDeg/2) * centralBandFraction), so the stated N always
   * matches what is actually scored. Only stated for the axis/axes actually being asked (a
   * 'range-only' request never states N; a 'yaw-only' request never states D/tolerance) — matching
   * the ladder's own L1 (yaw only) / L3a (range only) / L4 (both) goal sentences. All four optional
   * (falling back to this engine's own Round-3 default HFOV/band/tolerance/envelope) so existing
   * callers built before this field existed stay valid rather than being forced to update. */
  hfovDeg?: number;
  centralBandFraction?: number;
  rangeToleranceM?: number;
  envelope?: EnvelopeBounds;
  /** A7 (engine-review-e3 finding 7, "goal sentence omits episode length"): the episode's declared
   * total duration, stated in the goal sentence so Jev/reference knows the horizon it is actually
   * operating over (e.g. distinguishing "for as much of this episode as possible" over 20s vs 90s).
   * Optional so existing callers built before this field existed stay valid (falls back to omitting
   * the sentence, not a guessed duration). */
  episodeDurationMs?: number;
}

const DEFAULT_HFOV_DEG = 70;
const DEFAULT_CENTRAL_BAND_FRACTION = 0.3;
const DEFAULT_RANGE_TOLERANCE_M = 1.0;
const DEFAULT_ENVELOPE: EnvelopeBounds = { minAltitudeM: 0.5, maxAltitudeM: 6, maxRadiusFromOriginM: 60 };

const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** engine-review-e3 finding 1: which basis a per-option consequence was actually computed from —
 * surfaced distinctly so the caller can label a `'last-known'` (aged, reused) estimate honestly
 * rather than silently presenting it as indistinguishable from a fresh `'current'` measurement, or
 * from the `'stationary'` fallback it replaces. */
export type ConsequenceBasis = 'current' | 'last-known' | 'stationary' | 'unknown-explicit';

/** Resulting range for one option under the declared consequence model. Returns `null` (render as
 * "unknown") when the model requires a rate that is unavailable and the model is
 * `explicitly-unknown-prediction`; falls back to the stationary formula for `measured-rate` only
 * when NEITHER a current NOR a last-known (<=2s old, rate-estimate.ts's own declared threshold)
 * rate is available — `rate.rangeRateMps` is already the last-known value when
 * `rate.rangeRateSource === 'last-known'`, so this function's own arithmetic is unchanged; only the
 * reported `basis` differs. */
function resultingRange(currentRangeM: number, deltaOverStationaryM: number, optionSpeedMps: number | null, model: ConsequenceModel, rate: RateEstimate | null): { rangeM: number | null; basis: ConsequenceBasis } {
  if (model === 'stationary' || optionSpeedMps === null) return { rangeM: round1(currentRangeM + deltaOverStationaryM), basis: 'stationary' };
  const rangeRate = rate?.rangeRateMps;
  if (rangeRate === undefined || rangeRate === 'unknown') {
    if (model === 'explicitly-unknown-prediction') return { rangeM: null, basis: 'unknown-explicit' };
    return { rangeM: round1(currentRangeM + deltaOverStationaryM), basis: 'stationary' };
  }
  const resultingM = currentRangeM + (rangeRate - optionSpeedMps) * SPEED_HOLD_HORIZON_S;
  return { rangeM: round1(resultingM), basis: rate!.rangeRateSource === 'last-known' ? 'last-known' : 'current' };
}

/** Resulting bearing for one yaw option under the declared consequence model: the stationary
 * reprojection (`reprojectBearingAfterYaw`) plus, for a rate-aware model, the measured bearing-rate
 * applied over the same declared horizon (the ladder does not give yaw a separate horizon).
 *
 * engine-review-e2 finding 3 (sign bug): `rate.bearingRateDegS` is a WORLD-frame rate in the ENU
 * heading convention this engine uses everywhere else — "east is 0, north is +90 ... positive yaw
 * turns LEFT" (camera-geometry.ts's `worldBearingDeg`, counter-clockwise-positive). The rendered
 * bearing here is CAMERA-RELATIVE, positive RIGHT (clockwise-positive) — the opposite rotational
 * sense. Adding the two directly (the pre-repair code) reproduced the review's exact probe: a
 * target at +2deg drifting RIGHT at 5deg/s (a NEGATIVE world-frame rate, since moving right is
 * clockwise/ENU-negative) printed -3deg instead of the correct +7deg. Fixed by NEGATING the
 * world-frame rate before combining it with the camera-relative reprojection.
 *
 * engine-review-e3 finding 1: `rate.bearingRateDegS` is already the last-known value when
 * `rate.bearingRateSource === 'last-known'` (rate-estimate.ts's own <=2s fallback), so this
 * function's arithmetic is unchanged; only the reported `basis` differs. */
function resultingBearingDeg(stationaryReprojectedDeg: number, model: ConsequenceModel, rate: RateEstimate | null): { deg: number | null; basis: ConsequenceBasis } {
  if (model === 'stationary') return { deg: stationaryReprojectedDeg, basis: 'stationary' };
  const bearingRate = rate?.bearingRateDegS;
  if (bearingRate === undefined || bearingRate === 'unknown') {
    if (model === 'explicitly-unknown-prediction') return { deg: null, basis: 'unknown-explicit' };
    return { deg: stationaryReprojectedDeg, basis: 'stationary' };
  }
  return { deg: round2(stationaryReprojectedDeg - bearingRate * SPEED_HOLD_HORIZON_S), basis: rate!.bearingRateSource === 'last-known' ? 'last-known' : 'current' };
}

/** Increment B1: the ladder's own goal-sentence wording pattern ("horizontally within N degrees of
 * image centre", "at D metres (slant surface range), tolerance +/-X m", plus a stated operating
 * envelope), assembled per the ACTIVE question mode so a single-axis rung never states a criterion
 * it is not asking Jev to satisfy. */
function goalSentence(goal: Goal, questionMode: 'both' | 'yaw-only' | 'range-only', bandHalfWidthDeg: number, rangeToleranceM: number, envelope: EnvelopeBounds, episodeDurationMs?: number): string {
  const parts = [`Find and follow ${goal.description}.`];
  if (episodeDurationMs !== undefined) parts.push(`This episode lasts up to ${round1(episodeDurationMs / 1000)} s.`);
  if (questionMode !== 'range-only') parts.push(`Keep it horizontally within ${bandHalfWidthDeg} degrees of image centre for as much of this episode as possible.`);
  // A7 (engine-review-e3: "0.30000000000000004m in all 78 Round-3-rig requests", root-caused to
  // ladder-scenarios.ts's own `envelopeFor` arithmetic and fixed there — round1 here too, a
  // defensive second layer, so ANY future caller passing an unrounded tolerance/range/envelope
  // value still renders cleanly rather than reintroducing the same class of bug silently).
  if (questionMode !== 'yaw-only') parts.push(`Hold ${round1(goal.requestedRangeM)} m (slant surface range), tolerance +/-${round1(rangeToleranceM)} m, for as much of this episode as possible.`);
  parts.push(`Operating envelope: altitude between ${round1(envelope.minAltitudeM)} m and ${round1(envelope.maxAltitudeM)} m, within ${round1(envelope.maxRadiusFromOriginM)} m of the episode's starting point. Do not exit this envelope.`);
  return parts.join(' ');
}

export function buildTrackRequest(input: TrackEncoderInput): DecisionRequest {
  const { goal, boundBearingRightRad, boundBearingUpRad, boundRangeM, ownState, mountPitchRad, receipts, consequenceModel, rate, rangeMenuKind } = input;
  const questionMode = input.questionMode ?? 'both';
  const hfovDeg = input.hfovDeg ?? DEFAULT_HFOV_DEG;
  const centralBandFraction = input.centralBandFraction ?? DEFAULT_CENTRAL_BAND_FRACTION;
  const rangeToleranceM = input.rangeToleranceM ?? DEFAULT_RANGE_TOLERANCE_M;
  const envelope = input.envelope ?? DEFAULT_ENVELOPE;
  const bandHalfWidthDeg = round1((hfovDeg / 2) * centralBandFraction);
  const rangeMenu: ManeuverMenu = rangeMenuKind === 'speed-hold' ? SPEED_HOLD_MENU : TRACK_RANGE_MENU;
  const bearingDeg = boundBearingRightRad === null ? null : round2(boundBearingRightRad * 180 / Math.PI);
  const ownHeadingRad = ownState.headingDeg * Math.PI / 180;
  // engine-review-e3 finding 1: the fallback must be labelled on EACH axis independently (a
  // yaw-only request previously carried NO label at all when its rate was unavailable, since the
  // note was only ever attached to `range_consequences.source` — never rendered in yaw-only mode).
  const yawBasesSeen = new Set<ConsequenceBasis>();
  const rangeBasesSeen = new Set<ConsequenceBasis>();
  const yawConsequences = Object.entries(TRACK_YAW_MENU).map(([id, def]) => {
    if (boundBearingRightRad === null || boundBearingUpRad === null) return { action: id, resulting_bearing_deg: null };
    const yawDeg = def.kind === 'yaw' ? def.yawDeg! : 0;
    const reprojected = reprojectBearingAfterYaw({ bearingRightRad: boundBearingRightRad, bearingUpRad: boundBearingUpRad }, ownHeadingRad, mountPitchRad, yawDeg * Math.PI / 180);
    const { deg, basis } = resultingBearingDeg(round2(reprojected.bearingRightRad * 180 / Math.PI), consequenceModel, rate);
    yawBasesSeen.add(basis);
    return { action: id, resulting_bearing_deg: deg };
  });
  const rangeConsequences = Object.entries(rangeMenu).map(([id, def]) => {
    if (boundRangeM === null) return { action: id, resulting_range_m: null, resulting_signed_error_m: null };
    const deltaM = def.kind === 'translate' ? (def.directionOffsetDeg === 0 ? -1 : 1) * def.distanceM! : def.kind === 'speed_hold' ? -def.speedMps! * SPEED_HOLD_HORIZON_S : 0;
    const optionSpeedMps = def.kind === 'speed_hold' ? def.speedMps! : null;
    const { rangeM, basis } = resultingRange(boundRangeM, deltaM, optionSpeedMps, consequenceModel, rate);
    rangeBasesSeen.add(basis);
    return { action: id, resulting_range_m: rangeM, resulting_signed_error_m: rangeM === null ? null : round1(rangeM - goal.requestedRangeM) };
  });

  /** engine-review-e3 finding 1: one shared label builder for both axes (previously duplicated,
   * range-only text). `ageMs` is the axis's own `rate.*RateAgeMs` (only meaningful for
   * 'last-known'). */
  function fallbackNote(basesSeen: Set<ConsequenceBasis>, axisWord: 'target radial speed' | 'bearing rate', ageMs: number | null): string {
    if (consequenceModel === 'stationary') return ''; // the stationary model is deliberately, declaredly rate-blind — nothing to label
    if (basesSeen.has('last-known')) return ` ${axisWord[0]!.toUpperCase()}${axisWord.slice(1)} unavailable this acquisition for at least one option; used the last known estimate (${ageMs === null ? 'recent' : Math.round(ageMs) + 'ms old'}) instead of assuming stationary.`;
    if (basesSeen.has('stationary')) return ` ${axisWord[0]!.toUpperCase()}${axisWord.slice(1)} unknown for at least one option (no current or recent-enough estimate); its consequence assumes the target is currently stationary.`;
    return '';
  }

  const state: Record<string, unknown> = {
    evidence_notice: NOTICE, frame: FRAME,
    goal: goalSentence(goal, questionMode, bandHalfWidthDeg, rangeToleranceM, envelope, input.episodeDurationMs),
    current_view: {
      target_bound: input.targetBound,
      evidence_source: input.evidenceSource,
      ...(input.evidenceSource === 'last-seen' ? { evidence_age_ms: Math.round(input.evidenceAgeMs ?? 0) } : {}),
      bearing_deg: bearingDeg, range_m: boundRangeM === null ? null : round1(boundRangeM),
      range_unknown_reason: boundRangeM === null ? (input.evidenceSource === 'bound' ? 'Bound candidate has no valid stereo range this acquisition' : 'No current or recent-enough sighting') : undefined,
      own_heading_deg: round1(((ownState.headingDeg % 360) + 360) % 360), own_altitude_m: round2(ownState.altitudeM),
    },
    command_receipts: receipts.slice(-2),
    consequence_model: consequenceModel,
    // engine-review-e3 finding 7 (sign convention) / finding 1 (source/age): `bearing_rate_deg_s`
    // is printed in the SAME camera-relative, positive-RIGHT convention as `bearing_deg` above
    // (negating the internal world-frame/ENU/counter-clockwise-positive value this module computes
    // with everywhere else — see `resultingBearingDeg`'s own docstring) so a reader never has to
    // track two different rotational conventions in one request. `*_rate_source`/`*_rate_age_ms`
    // distinguish a fresh (<=`window_ms` old) measurement from a reused last-known one.
    rate_estimate: rate ? {
      range_rate_mps: rate.rangeRateMps === 'unknown' ? 'unknown' : round2(rate.rangeRateMps),
      bearing_rate_deg_s: rate.bearingRateDegS === 'unknown' ? 'unknown' : round2(-rate.bearingRateDegS),
      bearing_rate_sign_convention: 'Positive means the target\'s bearing (as printed in bearing_deg above) is increasing — drifting further RIGHT — matching bearing_deg\'s own sign, not a world-frame heading rate.',
      range_rate_source: rate.rangeRateSource, bearing_rate_source: rate.bearingRateSource,
      range_rate_age_ms: rate.rangeRateAgeMs === null ? null : Math.round(rate.rangeRateAgeMs),
      bearing_rate_age_ms: rate.bearingRateAgeMs === null ? null : Math.round(rate.bearingRateAgeMs),
      sample_count: rate.sampleCount, window_ms: rate.windowMs,
    } : null,
  };
  // Increment B1: single-axis question modes render only the selected axis/axes' own question and
  // consequence block — every OTHER stated fact (current_view, rate_estimate, receipts) is
  // identical across modes, so switching modes changes only which question(s) are posed.
  // engine-review-e3 finding 1: the fallback note is now computed per-axis and attached to that
  // AXIS's own block regardless of question mode — a yaw-only request now states its own bearing-
  // rate fallback even though `range_consequences` is never rendered at all.
  if (questionMode !== 'range-only') {
    state.component_goal_yaw = componentGoalYaw(goal.description);
    state.yaw_consequences = {
      source: `Code-computed conditional resulting bearing for EVERY offered yaw action. Not observations, measured outcomes, a ranking, or a recommendation.${fallbackNote(yawBasesSeen, 'bearing rate', rate?.bearingRateAgeMs ?? null)}`,
      per_option: yawConsequences,
    };
  }
  if (questionMode !== 'yaw-only') {
    state.component_goal_range = componentGoalRange(goal.description, goal.requestedRangeM);
    state.range_consequences = {
      source: `Code-computed conditional resulting range/signed error for EVERY offered range action, over a declared ${SPEED_HOLD_HORIZON_S.toFixed(1)} s horizon. Not observations, measured outcomes, a ranking, or a recommendation.${fallbackNote(rangeBasesSeen, 'target radial speed', rate?.rangeRateAgeMs ?? null)}`,
      per_option: rangeConsequences,
    };
  }
  const questions: Record<string, ChoiceQuestion> = {};
  if (questionMode !== 'range-only') questions.yaw = { type: 'choice', instructions: yawInstructions(questionMode), criteria: yawCriteria() };
  if (questionMode !== 'yaw-only') questions.range = { type: 'choice', instructions: rangeInstructions(questionMode), criteria: rangeCriteria(rangeMenu) };
  return { model: 'jev-1.13.0', state, questions };
}
