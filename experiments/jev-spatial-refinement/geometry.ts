/** Fresh, entirely stipulated geometry. No sensor or model calls occur in this module. */
export type RefineQuestion = {type: 'choice'; instructions: string; criteria: Record<string, string>};
export type RefineCase = {
  id: string; stage: 'geometry'; split: 'development' | 'confirmation'; unit: string;
  arm: string; replicate: number;
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string, RefineQuestion>};
  expected: Record<string, string[]>; meta: any;
};

export const GEOMETRY_REPRESENTATIONS = ['raw', 'current-relations', 'after-bearing', 'after-relations'] as const;
export const GEOMETRY_HEADS = ['action-only', 'action-and-forecasts'] as const;
export const GEOMETRY_ACTIONS = {left_30: 30, left_10: 10, left_3: 3, retain: null, right_3: -3, right_10: -10, right_30: -30} as const;
export type GeometryAction = keyof typeof GEOMETRY_ACTIONS;
export const GEOMETRY_GOAL_BAND_DEG = 11.863;

const NOTICE = 'Invented synthetic geometry diagnostic. These values are stipulated fixture facts, not a current camera image, real acquisition or Jev self-history. All questions are independent; sibling answers are unavailable.';
const FRAME = 'Angles are degrees. Absolute heading uses the ENU plane: east is 0, north is +90. Positive yaw turns left. Target image bearing is positive right. Wrap absolute headings and signed differences into [-180,180).';
const HYPOTHESIS = 'For every candidate separately, the target is stationary in the world, translation is zero, and the camera rotates with heading. The command applies immediately and reaches its final heading exactly; observe immediately after full completion. No expiry, supersession, lag, occlusion, detection failure or identity ambiguity occurs in this analytic diagnostic. This is a stipulated physical hypothesis, not predicted evidence or actuator qualification.';
const TRANSITION = 'Each non-retain option REPLACES the accepted setpoint with wrap(acquired heading + its signed yaw), not accepted heading + yaw. Retain keeps the previously accepted absolute heading, so an unfinished turn continues. Actual yaw is the shortest signed difference from acquired heading to the chosen final heading. Final image-right bearing is wrap(acquired image-right bearing + actual yaw).';
const FORECAST_CRITERIA = {
  left: 'The whole target rectangle is inside the view and its center bearing is below -5 degrees.',
  center: 'The whole target rectangle is inside the view and its center bearing is in [-5,+5] degrees, inclusive.',
  right: 'The whole target rectangle is inside the view and its center bearing is above +5 degrees.',
  not_fully_visible: 'Some or all of the target rectangle lies outside the stated camera view. This is a physical clipping category, not an epistemic abstention.',
};
const ACTION_CRITERIA = Object.fromEntries(Object.entries(GEOMETRY_ACTIONS).map(([id, yaw]) => [id, yaw === null
  ? 'Retain the previously accepted absolute heading setpoint. Continue any unfinished turn; this does not mean hold the acquired heading.'
  : `Replace the setpoint with wrap(acquired heading ${yaw < 0 ? '-' : '+'} ${Math.abs(yaw)} degrees): ${Math.abs(yaw)} degrees ${yaw > 0 ? 'left' : 'right'} from the acquired heading.`]));
const question = (instructions: string, criteria: Record<string, string>): RefineQuestion => ({type: 'choice', instructions, criteria: {...criteria}});
const clean = (x: number) => Math.abs(x) < 1e-9 ? 0 : Math.round(x * 1e9) / 1e9;
const wrap = (x: number) => clean(((x + 180) % 360 + 360) % 360 - 180);
const side = (x: number) => x < 0 ? 'left' : x > 0 ? 'right' : 'midline';
const bandRelation = (x: number) => x < -GEOMETRY_GOAL_BAND_DEG ? 'left of goal band' : x > GEOMETRY_GOAL_BAND_DEG ? 'right of goal band' : 'inside goal band';

// Eight fresh paired units per split. Mirrors stay in their own split; shared analytic
// mechanics mean this is held-out instance evidence, not structural generalization.
// Tuple: acquired heading, image-right bearing, unfinished accepted yaw, left/right extents.
const SEEDS = {
  development: [
    [47, 8.4, 0, 1.2, 1.8], [172, 16.8, 0, 2.1, 1.4],
    [-168, 20, 0, 1.6, 2.3], [133, 31.4, 0, 1.7, 2.6],
    [179, 12.8, -12, 2.2, 1.3], [-174, 4.6, -8, 1.4, 2.1],
    [89, 20.3, -20, 1.9, 2.7], [-121, 28.9, 15, 2.8, 1.1],
  ],
  confirmation: [
    [-63, 9.2, 0, 1.5, 2.2], [164, 17.6, 0, 2.4, 1.3],
    [153, 6.5, 0, 1.1, 2.5], [-179, 32.1, 0, 2.6, 1.7],
    [-177, 14.2, -14, 1.8, 2.4], [176, 3.8, -7, 2.3, 1.6],
    [-96, 23.4, -23, 2.7, 1.2], [118, 27.7, 18, 1.3, 2.8],
  ],
} as const;

type Geometry = {
  acquiredHeading: number; acceptedHeading: number; bearing: number;
  leftExtent: number; rightExtent: number;
};

function actionConsequences(g: Geometry) {
  const perAction = Object.fromEntries(Object.entries(GEOMETRY_ACTIONS).map(([action, delta]) => {
    const finalHeadingLeftDeg = delta === null ? g.acceptedHeading : wrap(g.acquiredHeading + delta);
    const actualYawLeftDeg = wrap(finalHeadingLeftDeg - g.acquiredHeading);
    const afterImageRightDeg = wrap(g.bearing + actualYawLeftDeg);
    const fullyVisible = afterImageRightDeg - g.leftExtent >= -35 && afterImageRightDeg + g.rightExtent <= 35;
    const physicalCategory = !fullyVisible ? 'not_fully_visible' : afterImageRightDeg < -5 ? 'left' : afterImageRightDeg > 5 ? 'right' : 'center';
    return [action, {
      finalHeadingLeftDeg, actualYawLeftDeg, afterImageRightDeg,
      absoluteFinalImageBearingDeg: Math.abs(afterImageRightDeg), fullyVisible, physicalCategory,
      insideGoalBand: fullyVisible && Math.abs(afterImageRightDeg) <= GEOMETRY_GOAL_BAND_DEG,
      improvementDeg: clean(Math.abs(g.bearing) - Math.abs(afterImageRightDeg)),
      improves: Math.abs(afterImageRightDeg) < Math.abs(g.bearing) - 1e-9,
      turnDirection: actualYawLeftDeg === 0 ? 'none' : actualYawLeftDeg * g.bearing < 0 ? 'toward acquired target side' : 'away from acquired target side',
      isOptimal: false,
    }];
  }));
  const best = Math.min(...Object.values(perAction).map(v => v.absoluteFinalImageBearingDeg));
  for (const value of Object.values(perAction)) value.isOptimal = Math.abs(value.absoluteFinalImageBearingDeg - best) <= 1e-9;
  return perAction;
}

/** 32 states × 4 representations × 2 head sets × 2 independent API replicates. */
export function generateGeometryCases(): RefineCase[] {
  const out: RefineCase[] = [];
  for (const split of ['development', 'confirmation'] as const) for (let index = 0; index < 8; index++) for (const mirror of [false, true]) {
    const [heading, bearing, remaining, leftExtent, rightExtent] = SEEDS[split][index]!;
    const sign = mirror ? -1 : 1;
    const g: Geometry = {
      acquiredHeading: wrap(sign * heading), acceptedHeading: wrap(sign * (heading + remaining)), bearing: sign * bearing,
      leftExtent: mirror ? rightExtent : leftExtent, rightExtent: mirror ? leftExtent : rightExtent,
    };
    const unit = `geometry-${split}-unit-${index}`;
    const stateId = `${unit}-${mirror ? 'mirror' : 'original'}`;
    const perAction = actionConsequences(g);
    const raw = {
      source: 'Stipulated synthetic acquisition and actuator record; no actual sensor or prior Jev decision.',
      acquired_ms: 10000, supplied_ms: 10000,
      acquired_heading_left_deg: g.acquiredHeading,
      previously_accepted_absolute_heading_left_deg: g.acceptedHeading,
      accepted_setpoint_execution_at_acquisition: remaining === 0 ? 'reached and settled' : 'applied, not yet reached',
      target: {identity: 'blue marker', center_image_right_deg: g.bearing, center_image_up_deg: 0,
        angular_extent_left_of_center_deg: g.leftExtent, angular_extent_right_of_center_deg: g.rightExtent,
        angular_half_height_deg: 1},
      camera: {image_right_interval_deg: [-35, 35], image_up_interval_deg: [-20, 20]},
    };
    for (const representation of GEOMETRY_REPRESENTATIONS) for (const heads of GEOMETRY_HEADS) {
      const state: any = {
        evidence_notice: NOTICE, frame: FRAME,
        component_goal: `Choose an offered command with the smallest ABSOLUTE target-center image bearing after full execution. Any exactly tied minimum is correct. The additional goal-band diagnostic is a fully visible target centered within +/-${GEOMETRY_GOAL_BAND_DEG} degrees; merely reaching that band does not replace the minimum-bearing objective.`,
        physical_hypothesis: HYPOTHESIS, control_semantics: TRANSITION,
        visibility_rule: 'A target is fully visible exactly when its entire stated angular rectangle is within the camera intervals, inclusive. Do not treat partial clipping as full visibility. The target remains physically present outside the view.',
        synthetic_acquisition: structuredClone(raw),
      };
      // This pair isolates present-state arithmetic. It does not supply action consequences.
      if (representation === 'current-relations') state.declared_computation = {
        source: 'Code-derived present-state relations from the supplied values; no future measurement, action ranking or recommendation.',
        target_side_of_current_midline: side(g.bearing),
        target_center_relation_to_goal_band: bandRelation(g.bearing),
        accepted_setpoint_remaining_yaw_left_deg: wrap(g.acceptedHeading - g.acquiredHeading),
        accepted_setpoint_relative_to_acquired_heading: side(-wrap(g.acceptedHeading - g.acquiredHeading)),
      };
      // These two arms are a separate ladder from raw, without current-relations fields.
      if (representation === 'after-bearing' || representation === 'after-relations') state.declared_computation = {
        source: 'Code-computed consequences for EVERY offered action under the stated stationary/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking or a recommended action.',
        conditional_consequences: Object.entries(perAction).map(([action, v]) => ({
          action, final_absolute_heading_left_deg: v.finalHeadingLeftDeg,
          actual_yaw_left_deg: v.actualYawLeftDeg, after_image_right_bearing_deg: v.afterImageRightDeg,
          ...(representation === 'after-relations' ? {
            physical_view_category: v.physicalCategory,
            target_center_relation_to_goal_band: bandRelation(v.afterImageRightDeg),
            entire_target_rectangle_inside_view: v.fullyVisible,
          } : {}),
        })),
      };
      const questions: Record<string, RefineQuestion> = {
        action: question('Under the stated stationary target and full-execution hypothesis, choose the offered command whose final target-center image bearing has the smallest absolute value. Retain preserves the accepted heading, including an unfinished turn. Any exactly tied minimum is valid. Decide from this state independently of all sibling questions.', ACTION_CRITERIA),
      };
      const expected: Record<string, string[]> = {action: Object.entries(perAction).filter(([, value]) => value.isOptimal).map(([action]) => action)};
      if (heads === 'action-and-forecasts') for (const action of Object.keys(GEOMETRY_ACTIONS)) {
        const id = `forecast_${action}`;
        questions[id] = question(`Independent CONDITIONAL forecast specifically for ${action}: ${ACTION_CRITERIA[action]} Assume this named option applies and fully completes under the stated hypothesis. Which physical view category follows immediately afterward? This question does not receive the action answer or any other sibling answer.`, FORECAST_CRITERIA);
        expected[id] = [perAction[action]!.physicalCategory];
      }
      for (const replicate of [0, 1]) out.push({
        id: `${stateId}-${representation}-${heads}-r${replicate}`, stage: 'geometry', split, unit,
        arm: `${representation}__${heads}`, replicate,
        request: {model: 'jev-1.13.0', state: structuredClone(state), questions: structuredClone(questions)},
        expected: structuredClone(expected),
        meta: {
          stateId, mirror, representation, heads, replicateGroup: `${stateId}-${representation}-${heads}`,
          source: 'fresh stipulated analytic geometry; no prior failed case is reused',
          sameRawFactsGroup: stateId, rawFactsManifest: JSON.stringify(raw),
          splitClaim: 'Disjoint instances and paired units; both splits use the same analytic mechanics. No structural-transfer claim.',
          geometry: {...g}, retainedRemainingYawLeftDeg: wrap(g.acceptedHeading - g.acquiredHeading),
          currentFullyVisible: g.bearing - g.leftExtent >= -35 && g.bearing + g.rightExtent <= 35,
          currentInsideGoalBand: Math.abs(g.bearing) <= GEOMETRY_GOAL_BAND_DEG,
          perAction: structuredClone(perAction), optimumAbsBearingDeg: Math.min(...Object.values(perAction).map(v => v.absoluteFinalImageBearingDeg)),
          forecastBranchByAction: Object.fromEntries(Object.keys(GEOMETRY_ACTIONS).map(action => [action, `forecast_${action}`])),
          physicalForecastCategories: Object.keys(FORECAST_CRITERIA), epistemicAbstention: 'not offered: all geometry and physical assumptions are stipulated exactly',
          scoring: 'Primary exact tied-optimum action; separately report improvement, inside-goal, wrong-direction, retained unfinished motion, conditional-category accuracy and identical-request disagreement. Do not pool questions or mirrors as independent environments.',
        },
      });
    }
  }
  return out;
}
