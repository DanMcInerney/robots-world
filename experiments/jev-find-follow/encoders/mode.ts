/** Code-derived mode determination: track when the target is bound and fresh, else search. This
 * stage does not ask Jev to pick the mode (per the assignment: "a mode determination that is
 * code-derived from evidence state ... do not ask Jev to pick the mode in this stage"). Recorded
 * on every decision so the report/viewer can show why a given encoder was used.
 *
 * `docs/jev-find-follow-ladder.md` § "Mode-switch specification" (L5): "On ambiguous identity (more
 * than one candidate matching the goal), the encoder stays in `track` mode with the L7-style
 * candidate question active rather than reverting to `search`." engine-review-e1 finding 9 flagged
 * that this engine previously reverted `ambiguous` to `search`, contradicting the ladder. This
 * engine does not yet render the L7-style candidate question itself (a later ladder rung); until
 * then, `ambiguous` still renders the ordinary track request (identity is left to the target
 * binder's own continuity heuristic — see target-binder.ts), which is the closest available
 * approximation, declared here rather than silently deferred.
 */
import type { BindResult, Mode } from '../types.ts';

export interface ModeDecision { mode: Mode; reason: string }

export function determineMode(bind: BindResult, lastSeenAgeMs: number | null, freshWithinMs: number): ModeDecision {
  if (bind.status === 'bound') return { mode: 'track', reason: 'Target currently bound by the target binder' };
  if (bind.status === 'ambiguous') return { mode: 'track', reason: 'Multiple candidates match the goal; ambiguous identity stays in track per the ladder mode-switch spec, not a revert to search' };
  if (lastSeenAgeMs !== null && lastSeenAgeMs <= freshWithinMs) return { mode: 'track', reason: `Target not currently visible, but last-seen record is fresh (${lastSeenAgeMs}ms <= ${freshWithinMs}ms)` };
  return { mode: 'search', reason: 'No current binding and no fresh last-seen record' };
}
