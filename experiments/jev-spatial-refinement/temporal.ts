/** Fresh synthetic evidence-schema diagnosis for F48. No sensor or flight claims. */
export type Point = [number, number];
export type TemporalQuestion = {type: 'choice'; instructions: string; criteria: Record<string, string>};
export type TemporalCase = {
  id: string; stage: 'temporal'; split: 'development' | 'confirmation'; unit: string;
  arm: string; replicate: number;
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string, TemporalQuestion>};
  expected: Record<string, string[]>; meta: any;
};
type Schema = 'mixed' | 'explicit';
type Coordinates = 'raw' | 'computed';
type EvidenceRecord = {
  id: string; target: string; observedAt: number | null; frameAt: number; epoch: string;
  kind: 'historical_observation' | 'current_observation' | 'motion_extrapolation';
  point: Point; source: string | null; forecastFor: number | null; expiresAt: number | null;
  velocity: Point | null; assumption: string | null;
};
type Facts = {
  now: number; epoch: string; historyAgeLimitMs: number;
  translation: Point; leftYawDeg: number; fromFrameAt: number; toFrameAt: number;
  oldEpoch: string; interEpochTransform: null;
  old: EvidenceRecord; present: EvidenceRecord | null; prediction: EvidenceRecord | null;
  aligned: {observedAt: number; frameAt: number; epoch: string; point: Point | null; kind: 'transformed_old_observation'} | null;
};

const rounded = (n: number) => {const r = Math.round(n * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r;};
const roundPoint = (p: Point): Point => [rounded(p[0]), rounded(p[1])];

/** Forward/right body coordinates, positive yaw left. Translation is in the OLD frame. */
export function transformHistoricalPoint(point: Point, translation: Point, leftYawDeg: number): Point {
  const radians = leftYawDeg * Math.PI / 180;
  const forward = point[0] - translation[0], right = point[1] - translation[1];
  return roundPoint([Math.cos(radians) * forward - Math.sin(radians) * right,
    Math.sin(radians) * forward + Math.cos(radians) * right]);
}

export function historicalPointInCurrentFrame(facts: Pick<Facts, 'old' | 'epoch' | 'translation' | 'leftYawDeg'>): Point | null {
  // This experiment never provides an inter-epoch transform. A numeric motion tuple cannot establish one.
  return facts.old.epoch === facts.epoch ? transformHistoricalPoint(facts.old.point, facts.translation, facts.leftYawDeg) : null;
}

const SIDE = {
  left: 'Left of the body midline: right coordinate less than zero.',
  center: 'On the body midline: right coordinate equals zero.',
  right: 'Right of the body midline: right coordinate greater than zero.',
  unknown: 'A usable position in the requested frame is not established.',
};
const KIND = {
  current_observation: 'Current observation acquired at the decision time.',
  transformed_old_observation: 'Transformed old observation: a historical measured point re-expressed in the current frame; its acquisition time is unchanged.',
  motion_extrapolation: 'Motion extrapolation under a stated target-motion assumption; it is not a current observation.',
  unknown: 'The requested evidence or a valid current-frame interpretation is unavailable.',
};
const q = (instructions: string, criteria: Record<string, string>): TemporalQuestion => ({type: 'choice', instructions, criteria: {...criteria}});

// All arms and all scenarios receive byte-identical questions. Heads are independent and never
// depend on another head's selected answer. Opaque record names carry no evidence-type semantics.
const QUESTIONS: Record<string, TemporalQuestion> = {
  old_side: q('Where does the old physical point recorded in entry p7 lie in the CURRENT body frame? Use the supplied ego-motion if needed. This asks about the historical point, not where the target has moved. An epoch reset without a provided inter-epoch transform makes this join unavailable.', SIDE),
  present_location: q('Where is marker-q established to be at the decision time by an actual observation acquired at that time? Historical points and motion assumptions cannot establish its present location. A missing current detection establishes no current target location.', SIDE),
  historical_kind: q('If the old measured point in entry p7 is interpreted in the CURRENT body frame using the supplied ego-motion, which evidence kind describes the resulting position? This classification is the same whether you compute the coordinates or they are supplied. Without a valid epoch join, the requested current-frame interpretation is unknown.', KIND),
  current_kind: q('Which evidence kind describes entry k2, if it is supplied? Classify the source of that entry itself; a missing entry means unknown. Read the entry without relying on another question or its answer.', KIND),
  hypothesis_kind: q('Which evidence kind describes entry v9, if it is supplied? Classify its source, separately from whether its age or epoch permits using it now. An expired motion assumption is still an extrapolation by origin; a missing entry means unknown.', KIND),
  historical_age: q('Is the elapsed time since p7 was actually OBSERVED within the stated maximum history age? Coordinate transformation does not change observation time. This is solely an age check; a young record can still fail an epoch join.', {
    within_limit: 'Observation age is less than or equal to the stated history-age limit.',
    beyond_limit: 'Observation age exceeds the stated history-age limit.',
  }),
  epoch_join: q('Can p7 be joined to the current body frame using the supplied map epochs and ego-motion? A map reset requires an explicit inter-epoch transform, which cannot be inferred just from a numeric translation and rotation.', {
    valid: 'The supplied same-epoch motion permits the coordinate join.',
    invalid: 'The old and current epochs differ and no inter-epoch transform is supplied.',
  }),
  hypothesis_validity: q('Is v9 eligible for use as a motion HYPOTHESIS at the decision time? This never makes it a current observation. First check existence, then epoch, then expiry; an epoch mismatch takes precedence over expiry.', {
    active: 'The hypothesis exists, belongs to the current epoch and has not expired.',
    expired: 'The hypothesis belongs to the current epoch but its validity time has expired.',
    invalid_epoch: 'The hypothesis belongs to another epoch and no inter-epoch transform is supplied.',
    absent: 'No hypothesis entry is supplied.',
  }),
  observation_clock: q('Which time is p7\'s original observation time after expressing its point in the current body frame? This asks which clock to preserve, even if an epoch mismatch prevents the spatial join.', {
    original_acquisition: 'Preserve p7\'s recorded acquisition time.',
    current_frame: 'Replace its acquisition time with the current frame time.',
    decision_time: 'Replace its acquisition time with the request decision time.',
    unknown: 'No acquisition time was supplied.',
  }),
};

const MIXED_KIND: Record<EvidenceRecord['kind'], string> = {
  historical_observation: 'A real past detection, located in the body frame at its capture time.',
  current_observation: 'A real detection captured at this decision time.',
  motion_extrapolation: 'A target position extrapolated under the stated motion assumption; not a detection.',
};

function encodeRecord(record: EvidenceRecord | null, schema: Schema): any {
  if (record === null) return null;
  if (schema === 'explicit') return {
    id: record.id, target: record.target, observed_at: record.observedAt,
    expressed_in_frame_at: record.frameAt, map_epoch: record.epoch, evidence_kind: record.kind,
    forward_right_m: record.point, source_record: record.source, forecast_for: record.forecastFor,
    valid_until: record.expiresAt, assumed_forward_right_velocity_m_s: record.velocity, assumption: record.assumption,
  };
  return {
    id: record.id, target: record.target, acquired_ms: record.observedAt,
    coordinates: {body_frame_ms: record.frameAt, epoch: record.epoch, forward_right_m: record.point},
    source_description: MIXED_KIND[record.kind], derived_from: record.source,
    predicted_time_ms: record.forecastFor, expires_ms: record.expiresAt,
    assumed_forward_right_velocity_m_s: record.velocity, assumption: record.assumption,
  };
}

function encodeFacts(facts: Facts, schema: Schema): any {
  const shared = {
    evidence_notice: 'Invented deterministic synthetic COMPONENT fixture. No rendered images, measured map, reconstructed map, actual Jev self-experience, flight or hardware qualification. Use supplied evidence only. Questions are independent; sibling answers are unavailable.',
    goal: 'Interpret old observations, current observations and motion hypotheses without inventing fresh evidence.',
    frame: 'Horizontal body coordinates are [forward,right] metres. World convention is ENU; heading zero faces East with body right South. Positive yaw is a left turn. To express an old point in the current body frame, subtract the observer translation expressed in the OLD body frame, then rotate by the measured positive-left yaw. A changed coordinate frame does not change when a point was observed.',
    time_units: 'All timestamps and durations are milliseconds on one synthetic clock.',
    decision_time_ms: facts.now, current_epoch: facts.epoch, maximum_history_age_ms: facts.historyAgeLimitMs,
    ego_motion: {
      translation_in_old_body_forward_right_m: facts.translation, measured_left_yaw_deg: facts.leftYawDeg,
      from_body_frame_ms: facts.fromFrameAt, to_body_frame_ms: facts.toFrameAt,
      from_epoch: facts.oldEpoch, to_epoch: facts.epoch, inter_epoch_transform: facts.interEpochTransform,
    },
    records: [encodeRecord(facts.old, schema), encodeRecord(facts.present, schema), encodeRecord(facts.prediction, schema)].filter(r => r !== null),
    current_detection_note: facts.present ? 'Entry k2 is the supplied current acquisition of marker-q.' : 'No current acquisition of marker-q is supplied; this does not establish empty space.',
    assistance: facts.aligned === null
      ? 'Raw old coordinates and ego-motion are supplied; no aligned old-point coordinates are supplied. Any motion-hypothesis coordinates are declared synthetic assumption-based assistance common to all arms.'
      : 'Code supplies the rigid transform of the old measured point using the supplied ego-motion. It does not model target motion or refresh acquisition time. Any motion-hypothesis coordinates are declared synthetic assumption-based assistance common to all arms.',
  };
  if (facts.aligned === null) return {...shared, aligned_old_point: null};
  const a = facts.aligned;
  const aligned = schema === 'explicit'
    ? {source_record: 'p7', observed_at: a.observedAt, expressed_in_frame_at: a.frameAt,
      map_epoch: a.epoch, evidence_kind: a.kind, forward_right_m: a.point}
    : {derived_from: 'p7', captured_ms: a.observedAt, transformed_at_body_frame_ms: a.frameAt,
      epoch: a.epoch, source_description: 'The old measured point re-expressed using ego-motion; not target motion and not a fresh detection.', forward_right_m: a.point};
  return {...shared, aligned_old_point: aligned};
}

/** Test/audit projection only: decode what is actually present in the payload, never its grade. */
export function projectTemporalFacts(state: any): Facts {
  function decode(r: any): EvidenceRecord {
    const explicit = Object.hasOwn(r, 'observed_at');
    const kind = explicit ? r.evidence_kind : Object.entries(MIXED_KIND).find(([, label]) => label === r.source_description)?.[0];
    if (!kind || !Object.hasOwn(MIXED_KIND, kind)) throw new Error('Unknown temporal record source');
    return {
      id: r.id, target: r.target, observedAt: explicit ? r.observed_at : r.acquired_ms,
      frameAt: explicit ? r.expressed_in_frame_at : r.coordinates.body_frame_ms,
      epoch: explicit ? r.map_epoch : r.coordinates.epoch, kind,
      point: explicit ? r.forward_right_m : r.coordinates.forward_right_m,
      source: explicit ? r.source_record : r.derived_from,
      forecastFor: explicit ? r.forecast_for : r.predicted_time_ms,
      expiresAt: explicit ? r.valid_until : r.expires_ms,
      velocity: r.assumed_forward_right_velocity_m_s, assumption: r.assumption,
    } as EvidenceRecord;
  }
  const records: EvidenceRecord[] = state.records.map(decode);
  const a = state.aligned_old_point;
  const explicit = a !== null && Object.hasOwn(a, 'observed_at');
  if (a !== null && (explicit ? a.evidence_kind !== 'transformed_old_observation'
    : a.source_description !== 'The old measured point re-expressed using ego-motion; not target motion and not a fresh detection.')) {
    throw new Error('Unknown aligned temporal record source');
  }
  return {
    now: state.decision_time_ms, epoch: state.current_epoch, historyAgeLimitMs: state.maximum_history_age_ms,
    translation: state.ego_motion.translation_in_old_body_forward_right_m,
    leftYawDeg: state.ego_motion.measured_left_yaw_deg, fromFrameAt: state.ego_motion.from_body_frame_ms,
    toFrameAt: state.ego_motion.to_body_frame_ms, oldEpoch: state.ego_motion.from_epoch,
    interEpochTransform: state.ego_motion.inter_epoch_transform,
    old: records.find(r => r.id === 'p7')!, present: records.find(r => r.id === 'k2') ?? null,
    prediction: records.find(r => r.id === 'v9') ?? null,
    aligned: a === null ? null : {
      observedAt: explicit ? a.observed_at : a.captured_ms,
      frameAt: explicit ? a.expressed_in_frame_at : a.transformed_at_body_frame_ms,
      epoch: explicit ? a.map_epoch : a.epoch, point: a.forward_right_m,
      kind: 'transformed_old_observation',
    },
  };
}

const side = (p: Point | null) => p === null ? 'unknown' : p[1] < 0 ? 'left' : p[1] > 0 ? 'right' : 'center';

function buildFacts(splitIndex: number, pair: number, mirrored: boolean): Facts {
  const sign = mirrored ? -1 : 1;
  const now = 41000 + splitIndex * 47000 + pair * 1307;
  const age = [340, 1920, 760, 2410, 1260, 530, 420, 1840][pair]! + splitIndex * 113;
  const oldAt = now - age, currentEpoch = 'map-h', oldEpoch = [4, 5, 7].includes(pair) ? 'map-b' : currentEpoch;
  const yaw = [[90, -45, 60, 135, -90, 30, 120, -60], [35, -120, 75, -135, 150, -30, 45, -75]][splitIndex]![pair]! * sign;
  const translation: Point = [rounded(0.65 + 0.19 * pair + splitIndex * 0.23), rounded(sign * (0.41 + pair * 0.13 + splitIndex * 0.17))];
  const desired: Point = [rounded(3.45 + pair * .29 + splitIndex * .37), rounded(sign * (1.17 + pair * .21 + splitIndex * .16))];
  // Construct in the inverse direction, then round the actual supplied original measurement.
  const r = yaw * Math.PI / 180;
  const oldPoint = roundPoint([Math.cos(r) * desired[0] + Math.sin(r) * desired[1] + translation[0],
    -Math.sin(r) * desired[0] + Math.cos(r) * desired[1] + translation[1]]);
  const old: EvidenceRecord = {id: 'p7', target: 'marker-q', observedAt: oldAt, frameAt: oldAt,
    epoch: oldEpoch, kind: 'historical_observation', point: oldPoint, source: null, forecastFor: null,
    expiresAt: null, velocity: null, assumption: null};
  const present: EvidenceRecord | null = [6, 7].includes(pair)
    ? {id: 'k2', target: 'marker-q', observedAt: now, frameAt: now, epoch: currentEpoch,
      kind: 'current_observation', point: [rounded(2.63 + splitIndex * .31), pair === 7 ? 0 : rounded(-sign * (.83 + splitIndex * .27))],
      source: null, forecastFor: null, expiresAt: null, velocity: null, assumption: null}
    : null;
  const velocity: Point = [.12 + splitIndex * .04, rounded(-sign * (1.63 + pair * .09))];
  const sourceAtNow = transformHistoricalPoint(oldPoint, translation, yaw);
  const predictedPoint = roundPoint([sourceAtNow[0] + velocity[0] * age / 1000, sourceAtNow[1] + velocity[1] * age / 1000]);
  const prediction: EvidenceRecord | null = [2, 3, 5, 7].includes(pair)
    ? {id: 'v9', target: 'marker-q', observedAt: null, frameAt: now, epoch: oldEpoch,
      kind: 'motion_extrapolation', point: predictedPoint, source: 'p7', forecastFor: now,
      expiresAt: now + (pair === 3 ? -170 : 360), velocity,
      assumption: 'Synthetic constant-velocity target hypothesis from p7, with velocity expressed in the attempted current body frame. Target motion is not independently measured and may stop or reverse. An unjoined old map epoch invalidates using these coordinates in the current map.'}
    : null;
  return {now, epoch: currentEpoch, historyAgeLimitMs: 970 + splitIndex * 140,
    translation, leftYawDeg: yaw, fromFrameAt: oldAt, toFrameAt: now, oldEpoch,
    interEpochTransform: null, old, present, prediction, aligned: null};
}

/** 32 base scenarios = 2 splits × 8 paired units × 2 mirrors; 4 arms × 2 repeats = 256 calls. */
export function generateTemporalCases(): TemporalCase[] {
  const cases: TemporalCase[] = [];
  for (const [splitIndex, split] of (['development', 'confirmation'] as const).entries()) {
    for (let pair = 0; pair < 8; pair++) for (const mirrored of [false, true]) {
      const base = buildFacts(splitIndex, pair, mirrored);
      const position = historicalPointInCurrentFrame(base);
      const epochValid = base.old.epoch === base.epoch;
      const predictionValidity = base.prediction === null ? 'absent'
        : base.prediction.epoch !== base.epoch ? 'invalid_epoch'
          : base.prediction.expiresAt! < base.now ? 'expired' : 'active';
      const expected: Record<string, string[]> = {
        old_side: [side(position)], present_location: [side(base.present?.point ?? null)],
        historical_kind: [epochValid ? 'transformed_old_observation' : 'unknown'],
        current_kind: [base.present ? 'current_observation' : 'unknown'],
        hypothesis_kind: [base.prediction ? 'motion_extrapolation' : 'unknown'],
        historical_age: [base.now - base.old.observedAt! <= base.historyAgeLimitMs ? 'within_limit' : 'beyond_limit'],
        epoch_join: [epochValid ? 'valid' : 'invalid'], hypothesis_validity: [predictionValidity],
        observation_clock: ['original_acquisition'],
      };
      const scenario = `temporal-${split}-${pair}-${mirrored ? 'b' : 'a'}`;
      for (const coordinates of ['raw', 'computed'] as Coordinates[]) for (const schema of ['mixed', 'explicit'] as Schema[]) {
        const arm = `${coordinates}_${schema}`;
        const facts = structuredClone(base);
        if (coordinates === 'computed') facts.aligned = {observedAt: base.old.observedAt!, frameAt: base.now,
          epoch: base.old.epoch, point: position, kind: 'transformed_old_observation'};
        const request = {model: 'jev-1.13.0' as const, state: encodeFacts(facts, schema), questions: structuredClone(QUESTIONS)};
        for (const replicate of [0, 1]) cases.push({
          id: `${scenario}-${arm}-r${replicate}`, stage: 'temporal', split,
          unit: `temporal-${split}-${pair}`, arm, replicate, request: structuredClone(request), expected: structuredClone(expected),
          meta: {
            scenario, mirror: mirrored, coordinateArm: coordinates, schemaArm: schema,
            sameFactsGroup: `${scenario}-${coordinates}`, baseFactsGroup: scenario,
            groundFacts: structuredClone(base), payloadFacts: structuredClone(facts), allowedAnswers: structuredClone(expected),
            epochValid, hypothesisValidity: predictionValidity, ageMs: base.now - base.old.observedAt!,
            transformedOldPoint: position, assistance: request.state.assistance,
            provenance: 'synthetic-component', freshScenarioCount: 32,
            independence: 'Mirrors belong to one paired unit. Splits use fresh angles, translations, ranges and times within the same eight semantic scenario templates; this is not broad structural transfer.',
          },
        });
      }
    }
  }
  return cases;
}
