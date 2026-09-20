import {FORMATS, encodeFacts, canonicalManifest, rotateOldPoint, YAW, YAW_CRITERIA, FORECAST_CRITERIA, yawOutcomes, plausibleYawActions, type Facts} from './encodings.ts';

export type Question = {type: 'choice'; instructions: string; criteria: Record<string, string>};
export type Case = {
  id: string; stage: string; family: string; unit: string;
  split: 'development' | 'selection' | 'confirmation'; arm: string; catalogIds: string[];
  provenance: 'synthetic-component';
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string, Question>};
  expected: Record<string, string[]>; meta?: any;
};
export const STAGES = ['encoding', 'temporal', 'execution', 'forecast', 'reflection', 'controls'];
const SPLITS = ['development', 'selection', 'confirmation'] as const;
const NOTICE = 'Invented deterministic synthetic COMPONENT fixture. No rendered images, sensor-derived flight, actual Jev self-experience, semantic recognition qualification or hardware evidence. Use only supplied evidence. Questions are independent; sibling answers are unavailable.';
const FRAME = 'Body axes: forward, right, up. Distances are metres. Positive yaw is a left turn. Image bearing is positive right. Occupied, positively observed free and unobserved space are distinct. Absence of a detection does not establish empty space.';
const SIDE = {left: 'Wholly on the left (right coordinate below zero).', center: 'Exactly on the midline (right coordinate zero).', right: 'Wholly on the right (right coordinate above zero).', unknown: 'Evidence is missing, invalid, or spans both sides.'};
const UNKNOWN_LOCATION = {left: 'The present target is established to be left.', center: 'The present target is established to be centered.', right: 'The present target is established to be right.', unknown: 'No present target location is established.'};
const APPLICATION = {requested: 'Requested; no admission or application record.', admitted: 'Admitted to queue; application not established.', applied: 'Applied and completed.', rejected: 'Rejected before application.', partial: 'Application started; only partial motion completed.', expired: 'Expired before any application.', unknown: 'Cannot link the supplied execution evidence to this command.'};
const REFLECTION = {match: 'Applied and the scorable observation matches the committed forecast.', mismatch: 'Applied and the scorable observation differs from the committed forecast.', not_tested: 'Did not apply; the forecast conditional on application was not tested.', abstained: 'The recorded forecast abstained; do not call this a forecast mismatch.', unknown: 'Application, target association, timing, or outcome evidence does not support comparison.'};
const q = (instructions: string, criteria: Record<string, string>): Question => ({type: 'choice', instructions, criteria: {...criteria}});
const side = (lo: number, hi = lo) => hi < 0 ? 'left' : lo > 0 ? 'right' : lo === 0 && hi === 0 ? 'center' : 'unknown';
const turnSide = (angle: number) => angle > 0 ? 'left' : angle < 0 ? 'right' : 'none';
const signedTurn = {left: 'Measured left turn.', right: 'Measured right turn.', none: 'Measured zero turn.', unknown: 'No usable measured turn.'};
const familyFor = (stage: string, split: number) => ({
  encoding: ['orthogonal_bays', 'staggered_aisles', 'split_level_fork'],
  temporal: ['pure_turn_glimpse', 'translate_and_turn_alcove', 'two_leg_return_loss'],
  execution: ['overlapping_turn_queue', 'revocation_with_old_turn', 'partial_gain_and_expiry'],
  forecast: ['interior_bearings', 'fov_edge_bearings', 'bin_boundary_bearings'],
  reflection: ['single_turn_episode', 'delayed_reacquisition_episode', 'interrupted_association_episode'],
  controls: ['opposed_color_pair', 'three_object_offset', 'four_object_crossing'],
}[stage]![split]!);

function make(stage: string, splitIndex: number, index: number, arm: string, catalogIds: string[], state: any, questions: Record<string, Question>, expected: Record<string, string[]>, meta: any = {}): Case {
  const family = familyFor(stage, splitIndex), split = SPLITS[splitIndex]!;
  // Adjacent mirrors/paired histories are ONE independent unit; never split them.
  const unit = `${stage}-${family}-${Math.floor(index / 2)}`;
  const shift = (index + splitIndex) % 7;
  const permuted = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const entries = Object.entries(question.criteria), offset = shift % entries.length;
    return [id, {...question, criteria: Object.fromEntries([...entries.slice(offset), ...entries.slice(0, offset)])}];
  }));
  return {
    id: `${stage}-${split}-${index.toString().padStart(2, '0')}-${arm}`, stage, family, unit, split, arm, catalogIds,
    provenance: 'synthetic-component', request: {model: 'jev-1.13.0', state: {evidence_notice: NOTICE, frame: FRAME, ...state}, questions: permuted}, expected,
    meta: {independentUnit: unit, pairedIndex: index, mirror: index % 2 === 1, questionKinds: Object.fromEntries(Object.keys(questions).map(id => [id, 'factual'])), ...meta},
  };
}

function encodingCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), mirror = i % 2 ? -1 : 1;
  const center = [-3, 0, 3, 0][n % 4]! * mirror, spread = n % 4 === 3 ? 1 : 0;
  const width = [[0.6, 0.8], [0.9, 1.1], [1.2, 1.4]][n % 3]!;
  const nearest = n % 3, pole = nearest === 0 ? [1, 1.2] : nearest === 1 ? [3.5, 4] : [2, 3];
  const wall = nearest === 0 ? [3.5, 4] : nearest === 1 ? [1, 1.2] : [2.5, 3.5];
  const facts: Facts = {
    snapshot_acquired_ms: 8000 + n * 200, goal: 'Inspect the blue marker.', target_id: 'obj-k',
    'obj-k_appearance': 'blue marker', 'obj-k_body_forward_m': 4 + s, 'obj-k_body_right_interval_m': [center - spread, center + spread],
    pole_radial_range_interval_m: pole, wall_radial_range_interval_m: wall,
    opening_width_interval_m: width, vehicle_required_width_m: 1,
    sampled_front_volume_status: n % 2 ? 'no valid measurements' : 'positively observed free',
    sampled_front_volume_forward_extent_m: [0, 2], sampled_front_volume_right_extent_m: [-0.2, 0.2],
    remainder_of_front_sector_status: 'unobserved', overhead_status: 'unobserved',
  };
  // Topology is held out by whole generative family, rather than by mirrored seeds.
  const shapes = [[[1, -2], [1, 2]], [[1, -2], [3, 0], [5, 2]], [[1, 0], [3, -3], [3, 3], [5, 0]]][s]!;
  shapes.forEach(([forward, right], j) => {facts[`surface_${j}_forward_right_m`] = [forward!, right! * mirror]; facts[`surface_${j}_height_interval_m`] = s === 2 && j === 3 ? [2, 3] : [0, 2];});
  const questions = {
    side: q('Where is the blue marker relative to the current body midline? Use its full right-coordinate interval.', SIDE),
    nearest: q('Which surface is definitely nearer in radial range? Overlapping intervals do not establish an ordering.', {pole: 'Pole is wholly nearer.', wall: 'Wall is wholly nearer.', unknown: 'Ordering is not established.'}),
    width: q('How does the opening width compare with the stated required vehicle width? This asks only about width; it does not certify a route.', {below: 'Wholly narrower.', above: 'Wholly wider.', overlaps: 'The interval crosses the required width.'}),
    sector: q('Is the entire front sector established free for flight, including its unmeasured remainder and overhead?', {free: 'Entire sector is established free.', occupied: 'Entire sector is established occupied.', unknown: 'Entire-sector clearance is unknown.'}),
    sample: q('What is established about the specifically sampled front volume?', {free: 'Positively observed free.', occupied: 'Observed occupied.', unknown: 'No valid measurements establish occupancy.'}),
  };
  const expected = {side: [side(center - spread, center + spread)], nearest: [nearest === 0 ? 'pole' : nearest === 1 ? 'wall' : 'unknown'], width: [['below', 'overlaps', 'above'][n % 3]!], sector: ['unknown'], sample: [n % 2 ? 'unknown' : 'free']};
  return FORMATS.map(format => make('encoding', s, i, format, ['E01', 'E02', 'E06', 'A08'], {representation: encodeFacts(facts, format)}, questions, expected, {format, factManifest: canonicalManifest(facts), sameFactsGroup: `encoding-${s}-${i}`, assistance: 'Serialization only; no derived spatial answer or recommended action.'}));
}

function temporalCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), sign = i % 2 ? -1 : 1, yaw = [90, 45, 180][s]!;
  const transformed: [number, number] = [4 + n % 3, sign * (2 + n % 2)];
  const translation: [number, number] = s === 0 ? [0, 0] : s === 1 ? [2 + n % 2, 1] : [1, 3 + n % 2];
  const unrotated = rotateOldPoint(...transformed, -yaw), old: [number, number] = [unrotated[0] + translation[0], unrotated[1] + translation[1]], validFrame = n % 4 !== 3;
  const current = {acquired_ms: 10000 + n * 100, map_epoch: 'epoch-new', camera_heading_left_deg: yaw, target_detections: [], screen: {body_forward_m: 2, body_right_m: 0, occupied: true}, additional_surfaces: s === 0 ? [] : s === 1 ? [[3, -2]] : [[3, -2], [3, 2]], sampled_volume: n % 2 ? 'unobserved' : 'positively observed free', behind_screen: 'unobserved'};
  const oldEvent = {acquisition_id: `event-${n}`, acquired_ms: 8800 + n * 100, map_epoch: validFrame ? 'epoch-new' : 'epoch-old', target_id: 'item-q', appearance: 'blue marker', body_forward_right_m: old, observer_heading_left_deg: 0};
  const questions = {
    old_side: q('On which side of the CURRENT body frame lies the target point measured in the dated old acquisition? This is about the old physical point, not the target now. A map reset without a qualified transform invalidates the join.', SIDE),
    present: q('Where is the target established to be NOW, as opposed to a historical point or a prediction?', UNKNOWN_LOCATION),
    prior: q('Does the evidence supplied in this request contain a prior blue-marker detection?', {yes: 'A dated prior detection is supplied.', no_evidence: 'No prior detection is supplied; this does not establish it never happened.'}),
    volume: q('What occupancy evidence is supplied for the current specifically sampled volume?', {free: 'Positively observed free.', occupied: 'Observed occupied.', unknown: 'Unobserved.'}),
    predicted: q('What is the evidential status of any target position extrapolation supplied here?', {prediction: 'A prediction under a motion assumption; not a present measurement.', measurement: 'A present acquired measurement.', absent: 'No extrapolation is supplied.'}),
  };
  return ['current_only', 'dated_raw', 'aligned_history', 'predicted_history'].map(arm => {
    const history = arm !== 'current_only';
    const state: any = {goal: 'Locate the blue marker using supplied evidence.', current};
    if (history) {
      state.history = [oldEvent]; state.measured_ego_motion = {translation_in_OLD_body_forward_right_m: translation, yaw_left_deg: yaw, frame_join: validFrame ? 'same epoch; valid' : 'reset; no inter-epoch transform'};
      if (s === 2) state.intermediate_ego_acquisition = {acquired_ms: oldEvent.acquired_ms + 600, heading_left_deg: 90, position_in_OLD_body_forward_right_m: [1, 0], target_detections: []};
    }
    if (arm === 'aligned_history' || arm === 'predicted_history') {
      state.declared_derived_features = {method: 'Rigid transform of old measured point using supplied ego-motion; no target-motion assumption.', old_point_current_body_forward_right_m: validFrame ? transformed : null};
    }
    if (arm === 'predicted_history') state.motion_hypothesis = {source: 'Declared constant-velocity extrapolation; not a measurement. Motion may stop or reverse while unobserved.', assumed_body_right_velocity_m_s: -sign, elapsed_s: 1.2, predicted_current_body_right_m: validFrame ? transformed[1] - sign * 1.2 : null};
    return make('temporal', s, i, arm, ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07'], state, questions, {old_side: [history && validFrame ? side(transformed[1]) : 'unknown'], present: ['unknown'], prior: [history ? 'yes' : 'no_evidence'], volume: [n % 2 ? 'unknown' : 'free'], predicted: [arm === 'predicted_history' ? 'prediction' : 'absent']}, {sameCurrentGroup: `temporal-${s}-${Math.floor(i / 2)}`, currentManifest: JSON.stringify(current), validFrame, oldPoint: old, transformedOldPoint: transformed, measuredYaw: yaw, translationOldBody: translation, assistance: arm === 'aligned_history' || arm === 'predicted_history' ? 'Declared code-computed rigid transform; prediction arm additionally supplies a stated constant-velocity hypothesis.' : 'No precomputed body-frame transform or position prediction.'});
  });
}

function executionCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), sign = i % 2 ? -1 : 1;
  const status = ['requested', 'admitted', 'applied', 'rejected', 'partial', 'expired'][n % 6]!;
  const otherStatus = status === 'applied' ? 'rejected' : 'applied';
  const requestedMagnitude = n < 6 ? 10 : 30;
  const measuredYaw = sign * (status === 'partial' ? requestedMagnitude * 0.4 : n % 3 === 0 ? 0 : requestedMagnitude), concurrent = n % 3;
  const commands = [{id: 'cmd-b', yaw_left_deg: sign * requestedMagnitude, requested_ms: 1000}, {id: 'cmd-f', yaw_left_deg: -sign * requestedMagnitude, requested_ms: 1000}];
  const events = [
    {command_id: 'cmd-b', record_type: 'execution', reported_ms: 2000, status},
    {command_id: 'cmd-f', record_type: 'execution', reported_ms: 2000, status: otherStatus},
    {command_id: 'cmd-b', record_type: 'completion', reported_ms: 2000, reached_requested_heading: status === 'applied' ? true : ['rejected', 'partial', 'expired'].includes(status) ? false : null},
    {command_id: 'cmd-f', record_type: 'completion', reported_ms: 2000, reached_requested_heading: otherStatus === 'applied'},
  ];
  const observation = {acquired_ms: 2200, observer_measured_yaw_left_deg: measuredYaw, before_target_right_deg: 0, after_target_right_deg: measuredYaw + (concurrent === 1 ? 3 * sign : 0), target_motion_evidence: concurrent === 0 ? 'Known stationary in this synthetic fixture; camera rotation is the only bearing-change mechanism.' : concurrent === 1 ? `Independently measured target angular change ${3 * sign} degrees right; both self and target can change bearing.` : 'Target world motion unmeasured; other effects unconstrained.'};
  const questions = {
    application: q('What execution status is established for the specifically requested command cmd-b? Requested, admitted and applied are different states.', APPLICATION),
    completion: q('Is completing the full requested turn established for command cmd-b?', {yes: 'Full requested heading reached.', no: 'Record establishes the requested turn did not complete.', unknown: 'Completion evidence is missing or cannot be linked.'}),
    measured: q('What total observer rotation is established by the acquired motion observation? Do not substitute requested motion.', signedTurn),
    attribution: q('Which account of the image-bearing change is supported by the stated motion evidence? Do not assign the change to a particular command merely because it preceded an image.', {self_only: 'The stipulated stationary-target fixture permits only observer rotation to cause the change.', both: 'Measured observer and measured target angular changes both contribute.', unknown: 'The supplied evidence does not isolate causes.'}),
  };
  return ['linked', 'loose', 'shuffled', 'unlinked'].map(arm => {
    const state: any = {goal: 'Interpret the command and observation records.', commands, observation};
    if (s === 1) state.ownership_context = {prior_owner: 'owner-old', revocation_ms: 900, previous_turn: {requested_ms: 700, applied_ms: 750, stopped_ms: 900}, commands_owner: 'owner-new', stop_rule: 'Revocation prevents prior-owner commands applying after 900 ms.'};
    if (s === 2) state.actuation_context = {gain_change_ms: 950, old_response_degrees_per_requested_degree: 1, new_response_degrees_per_requested_degree: 0.4, warning: 'A changed gain is not completion evidence; use receipts and acquired motion. Expiry may interrupt application.'};
    if (arm === 'linked') state.diary = Object.fromEntries(commands.map(command => [command.id, events.filter(e => e.command_id === command.id)]));
    else if (arm === 'unlinked') state.diary = {notice: 'Synthetic linkage ablation: execution-to-command IDs were removed; equal timestamps do not recover them.', events: events.map(({command_id: _removed, ...event}) => event)};
    else state.diary = arm === 'shuffled' ? [events[3], events[1], events[0], events[2]] : events;
    const linked = arm !== 'unlinked', complete = status === 'applied' ? 'yes' : ['rejected', 'partial', 'expired'].includes(status) ? 'no' : 'unknown';
    return make('execution', s, i, arm, ['H01', 'H02', 'H03', 'A01'], state, questions, {application: [linked ? status : 'unknown'], completion: [linked ? complete : 'unknown'], measured: [turnSide(measuredYaw)], attribution: [concurrent === 0 ? 'self_only' : concurrent === 1 && measuredYaw !== 0 ? 'both' : 'unknown']}, {sameFactsGroup: linked ? `execution-${s}-${i}` : undefined, journalManifest: linked ? JSON.stringify(events) : undefined, commandStatus: status, assistance: 'Synthetic receipts and acquisitions; no actual Jev-authored command history. The unlinked arm removes information; other three arms preserve all IDs, times and facts.'});
  });
}

function forecastCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), sign = i % 2 ? -1 : 1;
  const bearings = [[8, 9, 11, 12, 16, 18, 21, 22, 26, 28, 31, 32], [34, 34.5, 35, 35.5, 36, 36.5, 38, 38.5, 40, 40.5, 42, 42.5], [2, 2.5, 5, 5.5, 7, 7.5, 15, 15.5, 25, 25.5, 27, 27.5]][s]!;
  const bearing = sign * bearings[n % bearings.length]!;
  return ['stationary', 'uncertain_motion'].map(arm => {
    const drift: [number, number] = arm === 'stationary' ? [0, 0] : [-12, 12];
    const questions: Record<string, Question> = {
      action: q(arm === 'stationary'
        ? 'Yaw-only diagnostic: choose an offered command that minimizes absolute target-center bearing after the turn completes. The target is stipulated stationary and translation is zero. This geometric objective is not a general mission policy.'
        : 'Yaw-only diagnostic with uncertain target motion: choose an offered command that could minimize absolute target-center bearing for AT LEAST ONE allowed future target displacement. Several choices can be justified; no hidden future route is scored.', YAW_CRITERIA),
    };
    const expected: Record<string, string[]> = {action: plausibleYawActions(bearing, drift)};
    const physicalOutcomes: Record<string, string[]> = {};
    for (const [action, angle] of Object.entries(YAW)) {
      const id = `forecast_${action}`, outcomes = yawOutcomes([bearing, bearing], angle, drift);
      questions[id] = q(`CONDITIONAL FORECAST: Assume the offered command ${action} applies completely: ${YAW_CRITERIA[action]}. At the acquisition immediately after completion, which category is guaranteed by the stated geometry and allowed target motion? Abstain if multiple categories are possible. This question does not receive a sibling action answer.`, FORECAST_CRITERIA);
      expected[id] = outcomes.length === 1 ? outcomes : ['abstain']; physicalOutcomes[id] = outcomes;
    }
    return make('forecast', s, i, arm, ['H04', 'Q08', 'E02'], {
      goal: 'Interpret a fully specified small yaw geometry problem.',
      bench: {translation_m: [0, 0, 0], acquired_heading_left_deg: 0, accepted_heading_left_deg: 0, previous_turn_completed: true, camera_pitch_deg: 0, horizontal_fov_deg: 70, vertical_fov_deg: 40,
        bearing_update: 'New image-right center bearing equals old image-right bearing PLUS actual left yaw PLUS target angular displacement.',
        detection_rule: 'Report detection exactly when the entire rectangle lies inside horizontal [-35,35] and vertical [-20,20] degrees, inclusive. No occluders, dropouts or identity ambiguity. This analytic rule is not detector qualification.'},
      target_fixture_geometry: {source: 'Stipulated synthetic angular geometry; values outside the field of view are analytic fixture parameters, not a claimed camera detection.', center_image_right_deg: bearing, center_image_up_deg: 0, angular_half_width_deg: 1, angular_half_height_deg: 1, allowed_future_target_displacement_right_deg: drift},
    }, questions, expected, {questionKinds: Object.fromEntries(Object.keys(questions).map(id => [id, id === 'action' ? 'set-valued-action' : 'forecast-with-abstention'])), physicalOutcomes, forecastPhysicalCategories: ['left', 'center', 'right', 'absent'], epistemicAbstention: 'abstain', forecastScoring: 'Commitment coverage; committed accuracy; correct predictions / scorable episodes. Abstention is not a physical outcome; no mixed-category Brier score.', forecastBranchByAction: Object.fromEntries(Object.keys(YAW).map(action => [action, `forecast_${action}`])), bearing, drift, assistance: 'Fully stipulated synthetic geometry and explicit transition rule. No prediction answers or ranked actions are supplied.'});
  });
}

function reflectionCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), sign = i % 2 ? -1 : 1, scenario = n % 8;
  const started = 10000 + n * 200 + s * 1000, completed = started + 200;
  const acquired = completed + (scenario === 6 ? 700 : 100), assembled = acquired + 40;
  const observedBearing = scenario === 1 ? -sign * 12 : sign * 12;
  const predicted = scenario === 3 ? 'abstain' : sign > 0 ? 'right' : 'left';
  const application = scenario === 2 ? 'rejected' : scenario === 4 ? 'unknown' : 'applied';
  const observedInterval = scenario === 7 ? [4, 6] : [observedBearing, observedBearing];
  const outcome = scenario === 7 ? null : side(observedBearing);
  const assessment = scenario === 0 ? 'match' : scenario === 1 ? 'mismatch' : scenario === 2 ? 'not_tested' : scenario === 3 ? 'abstained' : 'unknown';
  const questions = {
    assessment: q('Assess the recorded earlier prediction CONDITIONAL ON command application, using the observation validity rules. Precedence: a confirmed unapplied command was not tested; unknown application is unscorable; a recorded abstention is not a mismatch; otherwise compare only valid, timely, uniquely associated observations.', REFLECTION),
    observed: q('What category is established for the supplied after-observation itself, without treating it as a forecast outcome when association or timing is invalid?', {left: 'Detected wholly left of -5 degrees.', center: 'Detected wholly inside [-5,5] degrees.', right: 'Detected wholly right of +5 degrees.', unknown: 'The interval crosses category boundaries or no usable observation exists.'}),
    application: q('What application status is recorded for this episode?', APPLICATION),
    cause: q('Does an observed forecast match prove that this particular command caused the target change, given unmeasured target motion?', {yes: 'The match proves causation.', no: 'It does not prove causation; other motion is unmeasured.'}),
  };
  return ['raw_episode', 'derived_episode'].map(arm => {
    const state: any = {
      goal: 'Assess one prior synthetic command episode.',
      validity_rule: 'A comparison requires known complete application, unique target association, after-acquisition 0 through 500 ms after completion inclusive, and an interval wholly in one physical category. A detected interval crossing a bin boundary is unscorable. Unmeasured target motion precludes causal proof.',
      previous_prediction: {source: 'Hand-authored synthetic previous Choice, not an actual Jev response.', selected: predicted, conditional_command_id: 'episode-c', selected_before_request_ms: started - 20},
      command: {id: 'episode-c', requested_ms: started, application, completed_ms: application === 'applied' ? completed : null, requested_yaw_left_deg: sign * (s === 0 ? 10 : s === 1 ? 30 : 3)},
      after_observation: {acquired_ms: acquired, assembled_ms: assembled, target_association: scenario === 5 ? 'ambiguous between two candidates' : 'unique', target_image_right_interval_deg: observedInterval, target_detected: true, target_motion: 'unmeasured'},
      prior_context: s === 0 ? {kind: 'single fully visible turn'} : s === 1 ? {kind: 'loss then reacquisition', missing_acquisitions: [started - 500, started - 300]} : {kind: 'two candidate crossing', prior_candidate_ids: ['track-n', 'track-v'], earlier_epoch: 'epoch-previous'},
    };
    if (arm === 'derived_episode') state.declared_derived_features = {method: 'Code computes arithmetic and interval binning from the exact raw fields above; this is an explicit assistance treatment.', acquisition_after_completion_ms: application === 'applied' ? acquired - completed : null, delivery_age_ms: assembled - acquired, observed_interval_category: outcome};
    return make('reflection', s, i, arm, ['H04', 'H06', 'R05'], state, questions, {assessment: [assessment], observed: [outcome ?? 'unknown'], application: [application], cause: ['no']}, {scenario, assistance: arm === 'derived_episode' ? 'Declared computed elapsed times and observed interval category; not a same-facts pure-format arm.' : 'Raw synthetic episode timestamps and angular intervals; no precomputed ages or assessment.', questionKinds: {assessment: 'retrospective', observed: 'factual', application: 'factual', cause: 'factual'}});
  });
}

function controlCases(s: number, i: number): Case[] {
  const n = Math.floor(i / 2), sign = i % 2 ? -1 : 1;
  const blueBearing = sign * [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 32, 33][n]!, greenBearing = -blueBearing;
  const acceptedHeading = sign * 10;
  const objects = [{id: 'item-d', appearance: 'blue marker', image_right_deg: blueBearing}, {id: 'item-w', appearance: 'green marker', image_right_deg: greenBearing}];
  if (s >= 1) objects.push({id: 'item-r', appearance: 'red marker', image_right_deg: sign * 3});
  if (s >= 2) objects.push({id: 'item-y', appearance: 'yellow marker', image_right_deg: -sign * 3});
  const optimal = (bearing: number) => {
    const actual = Object.entries(YAW).map(([id, yaw]) => [id, id === 'retain' ? acceptedHeading : yaw] as const);
    const minimum = Math.min(...actual.map(([, yaw]) => Math.abs(bearing + yaw)));
    return actual.filter(([, yaw]) => Math.abs(bearing + yaw) === minimum).map(([id]) => id);
  };
  return ['original', 'renamed', 'reordered', 'goal_swap'].map(arm => {
    const rename = arm === 'renamed', goalColor = arm === 'goal_swap' ? 'green' : 'blue';
    let displayed = objects.map((object, j) => ({...object, id: rename ? `entity-${['q', 'a', 'p', 'j'][j]}` : object.id}));
    if (arm === 'reordered') displayed = [...displayed].reverse();
    const target = displayed.find(object => object.appearance === `${goalColor} marker`)!;
    let questions: Record<string, Question> = {
      target: q(`Which supplied object satisfies the explicit goal "Center the ${goalColor} marker"? Appearance labels are supplied fixture facts, not a semantic-recognition test.`, Object.fromEntries(displayed.map(object => [object.id, `Object with ID ${object.id}.`]))),
      action: q(`For the explicit goal "Center the ${goalColor} marker", choose a yaw that minimizes its absolute image-right center bearing after the accepted turn completes. All markers remain stationary; translations are zero. Retain continues the previously accepted heading in state. No sibling target answer is available.`, YAW_CRITERIA),
      conditional: q(`CONDITIONAL branch for the BLUE marker ${displayed.find(object => object.appearance === 'blue marker')!.id}, regardless of the overall target goal: choose a yaw minimizing this blue marker's absolute image-center bearing after completion. The branch is explicit and does not read a sibling answer.`, YAW_CRITERIA),
      retain: q('If a new choice retains the accepted heading setpoint at this instant, what motion follows until the setpoint is reached? Acquired heading is zero; use the accepted heading from state.', signedTurn),
    };
    let expected: Record<string, string[]> = {target: [target.id], action: optimal(target.image_right_deg), conditional: optimal(blueBearing), retain: [turnSide(acceptedHeading)]};
    const questionMap: Record<string, string> = {target: 'z7', action: 'h2', conditional: 'm9', retain: 'b4'};
    if (rename) {questions = Object.fromEntries(Object.entries(questions).map(([id, value]) => [questionMap[id]!, value])); expected = Object.fromEntries(Object.entries(expected).map(([id, value]) => [questionMap[id]!, value]));}
    if (arm === 'reordered') questions = Object.fromEntries(Object.entries(questions).reverse().map(([id, question]) => [id, {...question, criteria: Object.fromEntries(Object.entries(question.criteria).reverse())}]));
    return make('controls', s, i, arm, ['E07', 'Q01', 'Q02', 'Q06', 'A08'], {
      goal: `Center the ${goalColor} marker.`, objects: displayed,
      bench: {acquired_heading_left_deg: 0, accepted_heading_left_deg: acceptedHeading, previous_turn_completed: false, translation_m: [0, 0, 0], positive_yaw: 'left', bearing_update: 'After left yaw y, image-right bearing increases by y.', fixed_hfov_deg: 70, target_half_width_deg: 1, target_motion: 'stationary throughout the diagnostic'},
    }, questions, expected, {questionKinds: Object.fromEntries(Object.keys(questions).map(id => [id, [rename ? 'h2' : 'action', rename ? 'm9' : 'conditional'].includes(id) ? 'set-valued-action' : 'factual'])), questionAliases: rename ? questionMap : undefined, sameObservationGroup: `controls-${s}-${i}`, assistance: 'Explicit geometric micro-objective and control semantics; no mission-optimal action claim. Meaning-preserving IDs, row order and goal are separate controls.'});
  });
}

/** Complete fixed allocation: 1,440 requests, 480 per split. No random or external input. */
export function generateCases(stage: string): Case[] {
  if (!STAGES.includes(stage)) throw new Error(`Unknown component stage: ${stage}. Expected one of ${STAGES.join(', ')}`);
  const generate = {encoding: encodingCases, temporal: temporalCases, execution: executionCases, forecast: forecastCases, reflection: reflectionCases, controls: controlCases}[stage]!;
  return SPLITS.flatMap((_split, s) => Array.from({length: 24}, (_unused, i) => generate(s, i)).flat());
}
