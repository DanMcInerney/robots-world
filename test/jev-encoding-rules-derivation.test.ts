/** Independently re-derives the correct answer from the RENDERED request text of the most informative
 * arm in each factor -- reading only state.action_consequences.per_option as a viewer of the request
 * could read it, never the internal oracle/meta objects -- and asserts equality with the oracle's
 * `expected` for every generated case. This is the regression check the assignment asks for: the stated
 * goal, the rendered facts and the oracle key can never silently drift apart. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateF1Cases} from '../experiments/jev-encoding-rules/f1-menu-size.ts';
import {generateF3Cases} from '../experiments/jev-encoding-rules/f3-consequence-form.ts';
import type {RuleCase} from '../experiments/jev-encoding-rules/types.ts';

/** Reads only the printed 'all' form (value+error+label) -- form (d), the most informative arm -- and
 * re-derives the argmin-|error| key using nothing but abs_error_deg/abs_error_m. */
function deriveFromAllForm(c: RuleCase): string[] {
  const perOption: any[] = c.request.state.action_consequences.per_option;
  const errorKey = 'abs_error_deg' in perOption[0] ? 'abs_error_deg' : 'abs_error_m';
  const best = Math.min(...perOption.map(o => o[errorKey]));
  return perOption.filter(o => o[errorKey] <= best + 1e-6).map(o => o.action);
}
/** Reads only the printed 'value' form (F1's arm) and re-derives argmin |resulting_bearing_deg|. */
function deriveFromValueForm(c: RuleCase): string[] {
  const perOption: any[] = c.request.state.action_consequences.per_option;
  const best = Math.min(...perOption.map(o => Math.abs(o.resulting_bearing_deg)));
  return perOption.filter(o => Math.abs(o.resulting_bearing_deg) <= best + 1e-6).map(o => o.action);
}

test('F3 (most informative arm, value+error+label): independently derived key from rendered text matches the oracle, yaw and range', () => {
  for (const arm of ['yaw-all', 'range-all']) {
    const cases = generateF3Cases().filter(c => c.arm === arm);
    assert(cases.length > 0);
    for (const c of cases) assert.deepEqual(new Set(deriveFromAllForm(c)), new Set(c.expected), `${c.id}: independent derivation disagrees with the oracle`);
  }
});
test('F1 (value form, every menu size): independently derived key from rendered text matches the oracle', () => {
  const cases = generateF1Cases();
  assert(cases.length > 0);
  for (const c of cases) assert.deepEqual(new Set(deriveFromValueForm(c)), new Set(c.expected), `${c.id}: independent derivation disagrees with the oracle`);
});
