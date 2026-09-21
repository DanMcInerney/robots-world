/** reference controller: a declared code policy that reads ONLY the same request text/fields Jev
 * receives and picks — e.g., the option minimising |resulting bearing| / |resulting error| /
 * maximising new never-inspected degrees. This is the capable-reference baseline that proves a
 * rung is solvable from the supplied sensing (F52's requirement: "check both passive and capable
 * reference behavior"); never mixed with Jev arms.
 *
 * Implements the SAME policy stated in each encoder's `component_goal*` text (track.ts/search.ts),
 * but reads it from the STRUCTURED fields those encoders render (per-option consequences,
 * sector_memory, last_seen, current_view) rather than parsing the prose — the same information a
 * capable reader of that text would have.
 */
import type { DecisionRequest, DecisionResponse } from '../types.ts';
import { uniformAnswer, type ControllerContext, type EngineController } from './types.ts';

function pickMinAbs(perOption: { action: string; value: number | null }[], fallback: string): string {
  const finite = perOption.filter(o => o.value !== null);
  if (!finite.length) return fallback;
  return finite.reduce((best, o) => Math.abs(o.value!) < Math.abs(best.value!) ? o : best).action;
}

function answerTrackYaw(state: Record<string, unknown>): string {
  const consequences = (state.yaw_consequences as any)?.per_option as { action: string; resulting_bearing_deg: number | null }[] | undefined;
  if (!consequences) throw new Error('reference controller: track state missing yaw_consequences');
  return pickMinAbs(consequences.map(c => ({ action: c.action, value: c.resulting_bearing_deg })), 'hold');
}
function answerTrackRange(state: Record<string, unknown>): string {
  const consequences = (state.range_consequences as any)?.per_option as { action: string; resulting_signed_error_m: number | null }[] | undefined;
  if (!consequences) throw new Error('reference controller: track state missing range_consequences');
  return pickMinAbs(consequences.map(c => ({ action: c.action, value: c.resulting_signed_error_m })), 'hold');
}

function answerSearchAction(state: Record<string, unknown>): string {
  const currentView = state.current_view as { target_visible_now: boolean; camera_hfov_deg: number } | undefined;
  if (!currentView) throw new Error('reference controller: search state missing current_view');
  if (currentView.target_visible_now) return 'hold';
  const perOption = (state.action_consequences as any)?.per_option as {
    action: string; resulting_heading_deg: number; camera_covers_sectors: { sector_index: number; never_or_age: 'never' | { age_ms: number } }[];
    movement_direction_clearance: { status: 'open' | 'blocked' | 'unknown'; toM?: number } | null; new_never_inspected_deg?: number;
    last_seen_offset_deg: number | null; last_seen_age_ms: number | null;
  }[] | undefined;
  if (!perOption) throw new Error('reference controller: search state missing action_consequences');
  const lastSeenTrustworthyMs = 15_000; // matches search.ts's DEFAULT_LAST_SEEN_TRUSTWORTHY_MS convention
  // engine-review-e1 finding 4: reads the CODE-COMPUTED per-option `last_seen_offset_deg` directly
  // (no longer subtracts state.last_seen.bearing_deg from resulting_heading_deg itself).
  const withLastSeen = perOption.filter(o => o.last_seen_offset_deg !== null && o.last_seen_age_ms !== null && o.last_seen_age_ms <= lastSeenTrustworthyMs);
  if (withLastSeen.length > 0) {
    const half = currentView.camera_hfov_deg / 2;
    const scored = withLastSeen.map(o => ({ action: o.action, distance: Math.abs(o.last_seen_offset_deg!) }));
    const containing = scored.filter(o => o.distance <= half);
    const pool = containing.length ? containing : scored;
    return pool.reduce((best, o) => o.distance < best.distance ? o : best).action;
  }
  const withNever = perOption.map(option => {
    const explicit = option.new_never_inspected_deg;
    const neverCount = option.camera_covers_sectors.filter(s => s.never_or_age === 'never').length;
    return { action: option.action, score: explicit !== undefined ? explicit : neverCount };
  });
  const bestNever = withNever.reduce((best, o) => o.score > best.score ? o : best);
  if (bestNever.score > 0) return bestNever.action;
  const open = perOption.find(o => o.movement_direction_clearance?.status === 'open');
  return open ? open.action : 'hold';
}

export function createReferenceController(): EngineController {
  return {
    id: 'reference',
    async answer(request: DecisionRequest, _context: ControllerContext): Promise<DecisionResponse> {
      // Increment B1: single-axis question modes (encoders/track.ts's `questionMode`) render only
      // ONE of `yaw`/`range` on a track-mode request — each branch below is independent (not an
      // "either both or neither" pair) so 'yaw-only'/'range-only' scenarios are answerable, not just
      // the default 'both'.
      const answers: DecisionResponse['answers'] = {};
      if (request.questions.yaw) answers.yaw = uniformAnswer(request.questions.yaw.criteria, answerTrackYaw(request.state));
      if (request.questions.range) answers.range = uniformAnswer(request.questions.range.criteria, answerTrackRange(request.state));
      if (request.questions.action) answers.action = uniformAnswer(request.questions.action.criteria, answerSearchAction(request.state));
      if (Object.keys(answers).length === 0) throw new Error('reference controller: unrecognised question set');
      const tokens = Math.max(32, Math.round(Buffer.byteLength(JSON.stringify(request)) / 3.5));
      return { model: request.model, answers, usage: { input_tokens: tokens }, synthetic: true };
    },
  };
}
