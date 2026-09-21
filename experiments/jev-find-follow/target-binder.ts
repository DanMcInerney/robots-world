/** Code-owned, goal-aware target binder: maps a goal description onto the current sensor frame's
 * objects. Never evaluator truth — only class/colour/bearing/range/score fields the sensor itself
 * reports (schema stereo-objects/2). Explicit ambiguity when several objects match; never guesses.
 *
 * An independent review of the existing designs flagged that a naive per-frame nearest-match
 * binder, combined with the perception mapper's 30-degree bearing-bucket appearance key, "would
 * collapse two nearby cars" and that a later identity rung will add a candidate-choice question
 * (A/B/unresolved). This binder therefore keeps per-candidate CONTINUITY across decisions (the
 * previously bound candidate's bearing/range), so a class/colour match nearest the last bound
 * bearing is preferred over a same-class object that just entered view elsewhere, and reports
 * `ambiguous` (not a guess) when continuity does not resolve it — this candidate list and
 * `BindResult` shape are deliberately the same shape a later A/B/unresolved question would render.
 */
import type { BindResult, Goal, StereoObject } from './types.ts';

const MAX_CONTINUITY_BEARING_DELTA_RAD = 25 * Math.PI / 180;

function matchesGoal(object: StereoObject, goal: Goal): boolean {
  if (!goal.classes.includes(object.class) && !(object.altClasses ?? []).some(alt => goal.classes.includes(alt.class))) return false;
  if (goal.colour && object.dominantColor !== goal.colour) return false;
  return true;
}

export interface TargetBinder {
  bind(objects: readonly StereoObject[]): BindResult;
}

/** Stateful: `createTargetBinder(goal)` returns a bind() closure carrying continuity state across
 * calls within one episode. Deterministic given the same object sequence. */
export function createTargetBinder(goal: Goal): TargetBinder {
  let lastBoundBearingRightRad: number | null = null;
  return {
    bind(objects: readonly StereoObject[]): BindResult {
      const matching = objects
        .map((object, objectIndex) => ({ object, objectIndex }))
        .filter(({ object }) => matchesGoal(object, goal));
      const candidates = matching.map(({ object, objectIndex }) => ({
        objectIndex, class: object.class, colour: object.dominantColor ?? null, score: object.score,
        bearingRightRad: object.bearingRightRad, bearingUpRad: object.bearingUpRad,
        rangeM: object.rangeValid ? object.surfaceRangeM : null,
      }));
      if (candidates.length === 0) { lastBoundBearingRightRad = null; return { status: 'none', candidates, boundIndex: null }; }
      if (candidates.length === 1) { lastBoundBearingRightRad = candidates[0]!.bearingRightRad; return { status: 'bound', candidates, boundIndex: 0 }; }
      // Several candidates: continuity only resolves it when exactly one is close enough to the
      // last bound bearing AND clearly closer than every other candidate (>=2x margin) — never a
      // coin-flip nearest-match. Otherwise this is genuine, reportable ambiguity.
      if (lastBoundBearingRightRad !== null) {
        const withDelta = candidates.map((c, i) => ({ i, delta: Math.abs(c.bearingRightRad - lastBoundBearingRightRad!) }))
          .sort((a, b) => a.delta - b.delta);
        const [nearest, secondNearest] = withDelta;
        if (nearest && nearest.delta <= MAX_CONTINUITY_BEARING_DELTA_RAD && (!secondNearest || nearest.delta * 2 <= secondNearest.delta)) {
          lastBoundBearingRightRad = candidates[nearest.i]!.bearingRightRad;
          return { status: 'bound', candidates, boundIndex: nearest.i };
        }
      }
      lastBoundBearingRightRad = null;
      return { status: 'ambiguous', candidates, boundIndex: null };
    },
  };
}
