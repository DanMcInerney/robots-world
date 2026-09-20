/** Proposed follow-up only. No API dispatch, runtime integration, or changes to the frozen study. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {RefineCase} from './types.ts';

type Point = [number, number];
type Question = RefineCase['request']['questions'][string];
export type TemporalNextSchema = 'typed_null' | 'valid_only' | 'provenance_usability';
export type TemporalNextQuestions = 'fused' | 'separate';
type RecordFact = {
  id: string; target: string; observed_at: number | null; expressed_in_frame_at: number;
  map_epoch: string; evidence_kind: 'historical_observation' | 'current_observation' | 'motion_extrapolation';
  forward_right_m: Point; source_record: string | null; forecast_for: number | null;
  valid_until: number | null; assumed_forward_right_velocity_m_s: Point | null; assumption: string | null;
};
export type TemporalNextFacts = {
  now: number; epoch: string; maximumHistoryAge: number;
  old: RecordFact; present: RecordFact | null; hypothesis: RecordFact | null;
  motion: {translation: Point; leftYaw: number; fromTime: number; toTime: number; fromEpoch: string; toEpoch: string; interEpochTransform: null};
  transform: {
    source: 'p7'; sourceOrigin: 'historical_observation'; observedAt: number; fromEpoch: string;
    requestedFrameAt: number; requestedEpoch: string; operation: 'rigid_body_reexpression';
    status: 'available' | 'failed_epoch_join'; failure: 'missing_inter_epoch_transform' | null; point: Point | null;
  };
};

export const TEMPORAL_NEXT_PLAN = {
  status: 'NOT RUN: offline fixtures and oracle checks only', model: 'jev-1.13.0',
  objective: 'Distinguish a derived-record label conflict from an asserted usable invalid-epoch position or a false current observation.',
  freshRequests: 192, splits: ['development', 'confirmation'], mirroredUnitsPerSplit: 8,
  schemas: ['typed_null', 'valid_only', 'provenance_usability'], questionPacks: ['fused', 'separate'],
  primaryCandidate: 'valid_only__separate',
  primaryReason: 'Preselected from the typed-null label conflict: failed transforms should not instantiate transformed-position records, and provenance should be asked separately from coordinate usability.',
  repeatsPerCell: 1, fusedHeads: 9, separatedHeads: 10,
  assistance: 'All three schemas receive identical code-computed coordinates and transform status. No raw-coordinate arm, controller action, or policy ranking is tested.',
  comparison: 'Compare the eight identical common heads directly. Report fused-kind and separate-origin/usability heads separately; never pool the 9-head and 10-head totals.',
  primaryGate: {
    arm: 'valid_only__separate', split: 'confirmation', expectedCalls: 16,
    maxPhysicalAssertions: 0,
    historicalOriginMinAccuracy: .9, historicalPositionUsableMinAccuracy: .9,
    validEpochOldSide: {eligible: 8, minAccuracy: .95},
    observedCurrentLocation: {eligible: 8, minAccuracy: .95},
  },
  advancement: 'Only the preselected primary confirmation arm is eligible. Require complete denominators, zero unsupported physical assertions, at least 90% origin and usability, at least 95% valid-join old-side and observed-current location accuracy. Report each common head separately; do not gate on pooled question accuracy. No arm reselection after responses.',
} as const;

const round = (v: number) => {const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x;};
const point = (f: number, r: number): Point => [round(f), round(r)];
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const choice = (instructions: string, criteria: Record<string, string>): Question => ({type: 'choice', instructions, criteria});
const SIDE = {left: 'Left of the body midline: right coordinate less than zero.', center: 'On the body midline: right coordinate equals zero.', right: 'Right of the body midline: right coordinate greater than zero.', unknown: 'A usable position in the requested frame is not established.'};
const KIND = {
  current_observation: 'Current observation acquired at the decision time.',
  transformed_old_observation: 'Transformed old observation: a historical measured point re-expressed in the current frame; its acquisition time is unchanged.',
  motion_extrapolation: 'Motion extrapolation under a stated target-motion assumption; it is not a current observation.',
  unknown: 'The requested evidence or a valid current-frame interpretation is unavailable.',
};

// Exact original combined question and criteria, preserved as an explicitly separate diagnostic.
const FUSED = choice('If the old measured point in entry p7 is interpreted in the CURRENT body frame using the supplied ego-motion, which evidence kind describes the resulting position? This classification is the same whether you compute the coordinates or they are supplied. Without a valid epoch join, the requested current-frame interpretation is unknown.', KIND);
const COMMON: Record<string, Question> = {
  old_side: choice('Where does the old physical point recorded in entry p7 lie in the CURRENT body frame? Use the supplied ego-motion if needed. This asks about the historical point, not where the target has moved. An epoch reset without a provided inter-epoch transform makes this join unavailable.', SIDE),
  present_location: choice('Where is marker-q established to be at the decision time by an actual observation acquired at that time? Historical points and motion assumptions cannot establish its present location. A missing current detection establishes no current target location.', SIDE),
  current_kind: choice('Which evidence kind describes entry k2, if it is supplied? Classify the source of that entry itself; a missing entry means unknown. Read the entry without relying on another question or its answer.', KIND),
  hypothesis_kind: choice('Which evidence kind describes entry v9, if it is supplied? Classify its source, separately from whether its age or epoch permits using it now. An expired motion assumption is still an extrapolation by origin; a missing entry means unknown.', KIND),
  historical_age: choice('Is the elapsed time since p7 was actually OBSERVED within the stated maximum history age? Coordinate transformation does not change observation time. This is solely an age check; a young record can still fail an epoch join.', {within_limit: 'Observation age is less than or equal to the stated history-age limit.', beyond_limit: 'Observation age exceeds the stated history-age limit.'}),
  epoch_join: choice('Can p7 be joined to the current body frame using the supplied map epochs and ego-motion? A map reset requires an explicit inter-epoch transform, which cannot be inferred just from a numeric translation and rotation.', {valid: 'The supplied same-epoch motion permits the coordinate join.', invalid: 'The old and current epochs differ and no inter-epoch transform is supplied.'}),
  hypothesis_validity: choice('Is v9 eligible for use as a motion HYPOTHESIS at the decision time? This never makes it a current observation. First check existence, then epoch, then expiry; an epoch mismatch takes precedence over expiry.', {active: 'The hypothesis exists, belongs to the current epoch and has not expired.', expired: 'The hypothesis belongs to the current epoch but its validity time has expired.', invalid_epoch: 'The hypothesis belongs to another epoch and no inter-epoch transform is supplied.', absent: 'No hypothesis entry is supplied.'}),
  observation_clock: choice('Which time is p7\'s original observation time after expressing its point in the current body frame? This asks which clock to preserve, even if an epoch mismatch prevents the spatial join.', {original_acquisition: 'Preserve p7\'s recorded acquisition time.', current_frame: 'Replace its acquisition time with the current frame time.', decision_time: 'Replace its acquisition time with the request decision time.', unknown: 'No acquisition time was supplied.'}),
};
const SEPARATE: Record<string, Question> = {
  historical_origin: choice('What is the ORIGIN of the source evidence in entry p7 itself? This is solely a provenance question: classify the source even if an attempted coordinate transform fails. Its age, a missing transform result or a different map epoch does not change how that source evidence was acquired.', {
    historical_observation: 'A past actual observation of the target, acquired before this decision time.',
    current_observation: 'An actual observation acquired at this decision time.',
    motion_extrapolation: 'A target position invented by a motion assumption rather than directly observed.',
    unknown: 'No source evidence or source provenance is supplied.',
  }),
  historical_position_usable: choice('Does the supplied evidence establish a usable coordinate for the OLD PHYSICAL POINT from p7 in the CURRENT body frame? This asks only coordinate availability under the map-epoch join, not target location now or freshness. An unavailable result or failed inter-epoch join means unavailable, even if the record has a transformation type label.', {
    usable: 'The transform succeeds in the current epoch and supplies a coordinate for that old physical point.',
    unavailable: 'No coordinate for that old physical point is established in the current frame.',
  }),
};

function makeFacts(split: number, unit: number, mirror: boolean): TemporalNextFacts {
  const sign = mirror ? -1 : 1, now = 201173 + split * 67317 + unit * 1429;
  const young = [0, 2, 5, 7].includes(unit), valid = [0, 1, 4, 5].includes(unit);
  const age = young ? 317 + unit * 29 + split * 47 : 1771 + unit * 31 + split * 59;
  const epoch = 'map-t', oldEpoch = valid ? epoch : 'map-j', oldAt = now - age;
  const yaw = ([[25, -55, 110, -155, 70, -20, 140, -100], [40, -80, 125, -165, 85, -10, 160, -115]][split]![unit]!) * sign;
  const translation = point(.87 + unit * .16 + split * .31, sign * (.29 + unit * .11 + split * .13));
  const desired = point(4.19 + unit * .37 + split * .41, sign * (1.41 + unit * .23 + split * .19));
  const angle = yaw * Math.PI / 180;
  const oldPoint = point(Math.cos(angle) * desired[0] + Math.sin(angle) * desired[1] + translation[0], -Math.sin(angle) * desired[0] + Math.cos(angle) * desired[1] + translation[1]);
  // Compute from the rounded supplied measurement, not the unexposed construction point.
  const delta = point(oldPoint[0] - translation[0], oldPoint[1] - translation[1]);
  const transformed = point(Math.cos(angle) * delta[0] - Math.sin(angle) * delta[1], Math.sin(angle) * delta[0] + Math.cos(angle) * delta[1]);
  const old: RecordFact = {id: 'p7', target: 'marker-q', observed_at: oldAt, expressed_in_frame_at: oldAt, map_epoch: oldEpoch, evidence_kind: 'historical_observation', forward_right_m: oldPoint, source_record: null, forecast_for: null, valid_until: null, assumed_forward_right_velocity_m_s: null, assumption: null};
  const present: RecordFact | null = [1, 3, 5, 7].includes(unit)
    ? {...old, id: 'k2', observed_at: now, expressed_in_frame_at: now, map_epoch: epoch, evidence_kind: 'current_observation', forward_right_m: point(3.17 + split * .53, unit === 7 ? 0 : -sign * (.69 + unit * .07))}
    : null;
  const velocity = point(.17 + split * .03, -sign * (1.38 + unit * .12));
  const hypothesis: RecordFact | null = [1, 2, 3, 4, 7].includes(unit)
    ? {...old, id: 'v9', observed_at: null, expressed_in_frame_at: now, evidence_kind: 'motion_extrapolation', forward_right_m: point(transformed[0] + velocity[0] * age / 1000, transformed[1] + velocity[1] * age / 1000), source_record: 'p7', forecast_for: now, valid_until: now + ([3, 4].includes(unit) ? -113 : 271), assumed_forward_right_velocity_m_s: velocity, assumption: 'Synthetic constant-velocity assumption from p7 expressed in the attempted current body frame; target motion is not independently measured. Missing inter-epoch transforms invalidate use in the current map. Expiry invalidates use as a current hypothesis. Neither numerical coordinates nor an unexpired assumption establish a current observation.'}
    : null;
  return {now, epoch, maximumHistoryAge: 1090 + split * 170, old, present, hypothesis,
    motion: {translation, leftYaw: yaw, fromTime: oldAt, toTime: now, fromEpoch: oldEpoch, toEpoch: epoch, interEpochTransform: null},
    transform: {source: 'p7', sourceOrigin: 'historical_observation', observedAt: oldAt, fromEpoch: oldEpoch, requestedFrameAt: now, requestedEpoch: epoch, operation: 'rigid_body_reexpression', status: valid ? 'available' : 'failed_epoch_join', failure: valid ? null : 'missing_inter_epoch_transform', point: valid ? transformed : null}};
}

function encode(f: TemporalNextFacts, schema: TemporalNextSchema): any {
  const state: any = {
    evidence_notice: 'Invented synthetic COMPONENT fixture, with declared code-computed coordinates and validity. No measured map, rendered image, current robot, actual self-experience, flight or hardware evidence. Questions are independent; sibling answers are unavailable.',
    goal: 'Keep evidence provenance separate from whether a coordinate is available, and preserve the original observation clock.',
    frame: 'Horizontal body coordinates are [forward,right] metres. World convention is ENU; heading zero faces East with body right South. Positive yaw is a left turn. Subtract translation in the OLD body frame, then rotate by the measured positive-left yaw. Changing frame does not refresh acquisition.',
    time_units: 'All timestamps and durations are milliseconds on one synthetic clock.',
    decision_time_ms: f.now, current_epoch: f.epoch, maximum_history_age_ms: f.maximumHistoryAge,
    ego_motion: {translation_in_old_body_forward_right_m: f.motion.translation, measured_left_yaw_deg: f.motion.leftYaw,
      from_body_frame_ms: f.motion.fromTime, to_body_frame_ms: f.motion.toTime, from_epoch: f.motion.fromEpoch,
      to_epoch: f.motion.toEpoch, inter_epoch_transform: f.motion.interEpochTransform},
    records: [f.old, f.present, f.hypothesis].filter(r => r !== null),
    current_detection_note: f.present ? 'Entry k2 is the supplied current acquisition of marker-q.' : 'No current acquisition of marker-q is supplied; this does not establish empty space.',
    assistance: 'Every schema receives the same code-computed rigid transform and same-epoch validity check. Coordinates for an unjoined epoch are unavailable. This calculation does not update source acquisition or infer target motion. Motion-hypothesis numbers, when present, are common declared assumption-based assistance. No action is computed or selected.',
  };
  const t = f.transform;
  const result = {source_record: t.source, operation: t.operation, observed_at: t.observedAt, source_epoch: t.fromEpoch,
    requested_frame_at: t.requestedFrameAt, requested_epoch: t.requestedEpoch, status: t.status, failure: t.failure};
  const record = {source_record: t.source, observed_at: t.observedAt, expressed_in_frame_at: t.requestedFrameAt,
    map_epoch: t.fromEpoch, evidence_kind: 'transformed_old_observation', forward_right_m: t.point};
  if (schema === 'typed_null') return {...state, aligned_old_point: record, transform_result: result};
  if (schema === 'valid_only') return {...state, transformed_records: t.status === 'available' ? [record] : [], transform_result: {...result, forward_right_m: t.point}};
  return {...state, historical_source: {source_record: t.source, evidence_origin: t.sourceOrigin, observed_at: t.observedAt, source_epoch: t.fromEpoch},
    coordinate_result: {source_record: t.source, operation: t.operation, requested_frame_at: t.requestedFrameAt, requested_epoch: t.requestedEpoch,
      usability: t.status === 'available' ? 'usable' : 'unavailable', failure: t.failure, forward_right_m: t.point}};
}

/** Decode the actual payload into atomic facts; never consult expected answers or hidden metadata. */
export function projectTemporalNextFacts(state: any): TemporalNextFacts {
  const old = state.records.find((r: any) => r.id === 'p7'); assert(old);
  let transform: TemporalNextFacts['transform'];
  if ('coordinate_result' in state) {
    const p = state.historical_source, c = state.coordinate_result;
    assert(['usable', 'unavailable'].includes(c.usability)); assert.equal(p.source_record, c.source_record);
    transform = {source: p.source_record, sourceOrigin: p.evidence_origin, observedAt: p.observed_at, fromEpoch: p.source_epoch,
      requestedFrameAt: c.requested_frame_at, requestedEpoch: c.requested_epoch, operation: c.operation,
      status: c.usability === 'usable' ? 'available' : 'failed_epoch_join', failure: c.failure, point: c.forward_right_m};
  } else {
    const r = state.transform_result;
    let position: Point | null;
    if ('aligned_old_point' in state) {
      const p = state.aligned_old_point; assert.equal(p.evidence_kind, 'transformed_old_observation');
      assert.equal(p.source_record, r.source_record); assert.equal(p.observed_at, r.observed_at);
      assert.equal(p.expressed_in_frame_at, r.requested_frame_at); assert.equal(p.map_epoch, r.source_epoch);
      position = p.forward_right_m;
    } else {
      assert.equal(state.transformed_records.length, r.status === 'available' ? 1 : 0);
      position = r.forward_right_m;
      if (r.status === 'available') {
        const p = state.transformed_records[0]; assert.equal(p.evidence_kind, 'transformed_old_observation');
        assert.equal(p.source_record, r.source_record); assert.equal(p.observed_at, r.observed_at);
        assert.equal(p.expressed_in_frame_at, r.requested_frame_at); assert.equal(p.map_epoch, r.source_epoch);
        assert.deepEqual(p.forward_right_m, position);
      }
    }
    transform = {source: r.source_record, sourceOrigin: old.evidence_kind, observedAt: r.observed_at, fromEpoch: r.source_epoch,
      requestedFrameAt: r.requested_frame_at, requestedEpoch: r.requested_epoch, operation: r.operation, status: r.status, failure: r.failure, point: position};
  }
  assert.equal(transform.sourceOrigin, old.evidence_kind); assert.equal(transform.observedAt, old.observed_at);
  return {now: state.decision_time_ms, epoch: state.current_epoch, maximumHistoryAge: state.maximum_history_age_ms,
    old, present: state.records.find((r: any) => r.id === 'k2') ?? null, hypothesis: state.records.find((r: any) => r.id === 'v9') ?? null,
    motion: {translation: state.ego_motion.translation_in_old_body_forward_right_m, leftYaw: state.ego_motion.measured_left_yaw_deg,
      fromTime: state.ego_motion.from_body_frame_ms, toTime: state.ego_motion.to_body_frame_ms, fromEpoch: state.ego_motion.from_epoch,
      toEpoch: state.ego_motion.to_epoch, interEpochTransform: state.ego_motion.inter_epoch_transform}, transform};
}

const side = (p: Point | null) => p === null ? 'unknown' : p[1] < 0 ? 'left' : p[1] > 0 ? 'right' : 'center';
function keys(f: TemporalNextFacts, pack: TemporalNextQuestions): Record<string, string[]> {
  const valid = f.old.map_epoch === f.epoch;
  const common = {old_side: [side(f.transform.point)], present_location: [side(f.present?.forward_right_m ?? null)],
    current_kind: [f.present ? 'current_observation' : 'unknown'], hypothesis_kind: [f.hypothesis ? 'motion_extrapolation' : 'unknown'],
    historical_age: [f.now - f.old.observed_at! <= f.maximumHistoryAge ? 'within_limit' : 'beyond_limit'], epoch_join: [valid ? 'valid' : 'invalid'],
    hypothesis_validity: [!f.hypothesis ? 'absent' : f.hypothesis.map_epoch !== f.epoch ? 'invalid_epoch' : f.hypothesis.valid_until! < f.now ? 'expired' : 'active'], observation_clock: ['original_acquisition']};
  return pack === 'fused' ? {...common, historical_kind: [valid ? 'transformed_old_observation' : 'unknown']}
    : {...common, historical_origin: ['historical_observation'], historical_position_usable: [valid ? 'usable' : 'unavailable']};
}

export function generateTemporalNextCases(): RefineCase[] {
  const result: RefineCase[] = [];
  for (const [s, split] of (['development', 'confirmation'] as const).entries()) for (let unit = 0; unit < 8; unit++) for (const mirror of [false, true]) {
    const facts = makeFacts(s, unit, mirror), scenario = `temporal-next-${split}-${unit}-${mirror ? 'b' : 'a'}`;
    for (const schema of TEMPORAL_NEXT_PLAN.schemas) for (const pack of TEMPORAL_NEXT_PLAN.questionPacks) {
      const expected = keys(facts, pack), arm = `${schema}__${pack}`;
      result.push({id: `${scenario}-${arm}`, stage: 'temporal-next', split, unit: `temporal-next-${split}-${unit}`, arm, replicate: 0,
        request: {model: 'jev-1.13.0', state: structuredClone(encode(facts, schema)), questions: structuredClone({...COMMON, ...(pack === 'fused' ? {historical_kind: FUSED} : SEPARATE)})}, expected,
        meta: {scenario, sameFactsGroup: scenario, schema, questionPack: pack, mirror, groundFacts: structuredClone(facts),
          epochValid: facts.old.map_epoch === facts.epoch, coordinateAssistance: 'computed and epoch-checked in all schemas',
          commonHeads: Object.keys(COMMON), specificHeads: pack === 'fused' ? ['historical_kind'] : Object.keys(SEPARATE),
          provenance: 'fresh-synthetic-component', independence: 'Mirrors share one unit; the two splits use fresh numeric instances of the same eight semantic templates. One request per cell, no repeat-variability claim.'}});
    }
  }
  return result;
}

/** Scoring categories intentionally do not equate a type-label disagreement with fresh evidence. */
export function classifyTemporalNextAnswers(c: RefineCase, answers: Record<string, string>) {
  for (const q of Object.keys(c.expected)) assert(answers[q] && Object.hasOwn(c.request.questions[q]!.criteria, answers[q]!));
  const facts = c.meta.groundFacts as TemporalNextFacts, valid = facts.old.map_epoch === facts.epoch;
  const physicalAssertions: string[] = [], questionErrors: string[] = [];
  for (const q of ['historical_kind', 'historical_origin', 'current_kind', 'hypothesis_kind']) {
    if (q in answers && answers[q] === 'current_observation' && !c.expected[q]!.includes('current_observation')) physicalAssertions.push(`${q}:false-current`);
  }
  if (!facts.present && answers.present_location !== 'unknown') physicalAssertions.push('present_location:false-current');
  if (!valid) {
    if (answers.old_side !== 'unknown') physicalAssertions.push('old_side:invalid-coordinate');
    if (answers.epoch_join === 'valid') physicalAssertions.push('epoch_join:invalid-join');
    if (answers.historical_position_usable === 'usable') physicalAssertions.push('historical_position_usable:invalid-coordinate');
  }
  if (c.expected.hypothesis_validity!.includes('invalid_epoch') && answers.hypothesis_validity === 'active') physicalAssertions.push('hypothesis_validity:invalid-join');
  if (answers.observation_clock === 'current_frame' || answers.observation_clock === 'decision_time') physicalAssertions.push('observation_clock:reset-acquisition');
  for (const q of c.meta.specificHeads as string[]) if (!c.expected[q]!.includes(answers[q]!)) questionErrors.push(q);
  const labelUsabilityDisagreement = !valid && answers.historical_kind === 'transformed_old_observation'
    && answers.old_side === 'unknown' && answers.epoch_join === 'invalid';
  return {physicalAssertions, questionErrors, labelUsabilityDisagreement};
}

/** Serializable checkpoint for a later dispatcher freeze; this function does not write or dispatch. */
export function temporalNextManifest() {
  const cases = generateTemporalNextCases();
  return {plan: TEMPORAL_NEXT_PLAN, casesSha256: sha(JSON.stringify(cases) + '\n'),
    questionSha256: sha(JSON.stringify({common: COMMON, fused: FUSED, separate: SEPARATE})),
    requests: cases.length, maxRequestBytes: Math.max(...cases.map(c => Buffer.byteLength(JSON.stringify(c.request))))};
}

export const TEMPORAL_NEXT_REGRESSION = {
  id: 'temporal-development-4-a-computed_explicit-r0',
  requestSha256: '38df5e6df465d05fbca77e6b5f1948e6617f21caa4ce12e03b47d389acfcb620',
  responseSha256: '7dc5e1d2cea218549f1290cdb5f74bc01074a46e0d33c4aac8d9cef47ba8147c',
  root: '.runtime/experiments/jev-spatial-refinement-v1',
} as const;

/** Exact already-executed failure, excluded from all 192 fresh requests and any advancement score. */
export async function loadTemporalNextRegressionCase(root = resolve(TEMPORAL_NEXT_REGRESSION.root)): Promise<RefineCase> {
  const source = TEMPORAL_NEXT_REGRESSION;
  const requestBytes = await readFile(resolve(root, 'requests', source.id + '.json'));
  const responseBytes = await readFile(resolve(root, 'responses', source.id + '.json'));
  assert.equal(sha(requestBytes), source.requestSha256); assert.equal(sha(responseBytes), source.responseSha256);
  const request = JSON.parse(requestBytes.toString()), response = JSON.parse(responseBytes.toString());
  const expected = {old_side: ['unknown'], present_location: ['unknown'], historical_kind: ['unknown'], current_kind: ['unknown'],
    hypothesis_kind: ['unknown'], historical_age: ['beyond_limit'], epoch_join: ['invalid'], hypothesis_validity: ['absent'], observation_clock: ['original_acquisition']};
  assert.deepEqual(request.questions.historical_kind, FUSED);
  return {id: 'temporal-next-regression-' + source.id, stage: 'temporal-next-regression', split: 'regression', unit: 'archived-temporal-4-a', arm: 'archived_typed_null_original', replicate: 0,
    request, expected, meta: {source, recordedResponse: response, alreadyExecuted: true, advancementEligible: false,
      interpretation: 'Recorded old_side=unknown and epoch_join=invalid accompany historical_kind=transformed_old_observation. This is a combined-question/type-label disagreement, not by itself an asserted usable coordinate or false current observation. The original frozen grade remains unchanged.'}};
}
