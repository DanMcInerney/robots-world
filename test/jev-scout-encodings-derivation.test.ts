/** Independently re-derives the S and R keys from the RENDERED request text of the most informative
 * arm (sector-consequences for S, after-range for R) -- reading only what a viewer of the request could
 * read, not the internal ScoutFacts/RangeFacts objects -- and asserts equality with the oracle for
 * EVERY frozen case in both splits. This is the regression the pre-inference review asked for: stated
 * goal, rendered facts and keys can never silently drift apart again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateScoutCases} from '../experiments/jev-scout-encodings/scout.ts';
import {generateRangeCases} from '../experiments/jev-scout-encodings/range.ts';
import {circularDistanceDeg, overlapDeg, MOVE_DISTANCE_M} from '../experiments/jev-scout-encodings/oracle.ts';

function deriveScoutKey(state: any): string[] {
  const {current_view, sector_memory, action_consequences} = state;
  if (current_view.target_visible_now) return ['hold'];
  const hfov = current_view.camera_hfov_deg;
  const candidates = sector_memory.flatMap((s: any) => s.candidates);
  const trustworthy = candidates.find((c: any) => c.last_seen_age_ms <= 30_000);
  const options = action_consequences.per_option as any[];
  if (trustworthy) {
    const useful = options.filter(o => o.movement_direction_clearance === null && circularDistanceDeg(o.resulting_heading_deg, trustworthy.bearing_deg) <= hfov / 2 + 1e-6).map(o => o.action);
    if (useful.length) return useful;
  }
  const neverCenters = sector_memory.filter((s: any) => s.inspected === 'never').map((s: any) => s.center_heading_deg);
  if (neverCenters.length) {
    const scores = options.filter(o => o.movement_direction_clearance === null)
      .map(o => ({action: o.action, score: neverCenters.reduce((sum: number, c: number) => sum + overlapDeg(o.resulting_heading_deg, c, hfov, 36), 0)}));
    const max = Math.max(0, ...scores.map(s => s.score));
    if (max > 1e-6) return scores.filter(s => s.score >= max - 1e-6).map(s => s.action);
  }
  const translations = options.filter(o => o.movement_direction_clearance !== null);
  const open = translations.filter(o => o.movement_direction_clearance.status === 'open' && o.movement_direction_clearance.toM > MOVE_DISTANCE_M);
  return open.length ? open.map(o => o.action) : ['hold'];
}
function deriveRangeKey(state: any): string[] {
  if (state.measured_range.status !== 'valid') return ['hold'];
  const options = state.declared_computation.per_option as {action: string; resulting_signed_error_m: number}[];
  const best = Math.min(...options.map(o => Math.abs(o.resulting_signed_error_m)));
  return options.filter(o => Math.abs(o.resulting_signed_error_m) <= best + 1e-9).map(o => o.action);
}

test('S: independently derived key from rendered sector-consequences text matches the oracle for every frozen case, both splits', () => {
  const all = generateScoutCases().filter(c => c.arm === 'sector-consequences');
  assert(all.length > 0);
  for (const c of all) assert.deepEqual(new Set(deriveScoutKey(c.request.state)), new Set(c.expected.action!), `${c.id}: independent derivation disagrees with the oracle`);
});
test('R: independently derived key from rendered after-range text matches the oracle for every frozen case, both splits', () => {
  const all = generateRangeCases().filter(c => c.arm === 'after-range');
  assert(all.length > 0);
  for (const c of all) assert.deepEqual(new Set(deriveRangeKey(c.request.state)), new Set(c.expected.action!), `${c.id}: independent derivation disagrees with the oracle`);
});
