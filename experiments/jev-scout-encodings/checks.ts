import assert from 'node:assert/strict';
import type {ScoutCase} from './types.ts';

/** Keys that only ever belong to the oracle (`expected`/`meta`). Finding one inside a rendered
 * `request` means truth leaked into the Jev-visible payload. */
const ORACLE_ONLY_KEYS = ['label', 'useful', 'acceptable', 'harmful', 'isOptimal', 'oracle', 'perAction', 'newlyNeverDeg', 'caseKind'];

export function assertNoOracleLeak(c: ScoutCase) {
  const text = JSON.stringify(c.request);
  for (const key of ORACLE_ONLY_KEYS) assert(!text.includes(`"${key}"`), `Oracle-only key "${key}" leaked into request ${c.id}`);
}

/** Ranking/recommendation vocabulary that no part of a rendered request (instructions, state, question
 * text, option labels/criteria) may use in an AFFIRMATIVE sense: the code may compute symmetric
 * per-option facts, but must not rank or recommend one. The repo's established convention (see
 * experiments/jev-spatial-refinement/geometry.ts) explicitly DISCLOSES this in the negative ("not... a
 * ranking or a recommended action"), so a ranking word is only a violation when it is NOT actually
 * negated nearby in the same string -- a stray "not"/"no" anywhere in a long sentence does not excuse
 * an affirmative use of the word elsewhere in that same sentence. */
const RANKING_WORDS = [
  'best', 'optimal', 'recommend', 'should choose', 'you should', 'correct answer', 'correct option',
  'ideal', 'preferred', 'top choice', 'select this', 'choose this one', 'winning', 'suggest',
];
const NEGATION_WORDS = new Set(['not', 'never', 'no', "n't", 'without']);

function stringValues(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) stringValues(v, out);
  else if (x && typeof x === 'object') for (const v of Object.values(x as Record<string, unknown>)) stringValues(v, out);
  return out;
}
/** Collects every natural-language string in a rendered request: state, question instructions, and
 * every option's criteria text -- not just `state`, closing the gap the pre-inference review found. */
function requestStringValues(request: ScoutCase['request']): string[] {
  const out: string[] = [];
  stringValues(request.state, out);
  for (const q of Object.values(request.questions)) { out.push(q.instructions); stringValues(q.criteria, out); }
  return out;
}
/** A negation must scope the SAME sentence as the ranking word, not merely appear somewhere in a long
 * multi-sentence value. This is stricter than a word-distance window (which a distant unrelated "not"
 * in an earlier sentence could satisfy) and still covers the repo's established one-sentence disclosure
 * pattern ("...not observations, measured outcomes, a ranking, or a recommendation."). */
export function assertNoRankingLanguage(c: ScoutCase) {
  for (const value of requestStringValues(c.request)) {
    for (const sentence of value.split(/(?<=[.!?])\s+/)) {
      const lower = sentence.toLowerCase().replace(/[.,;:()!?]/g, '');
      const words = lower.split(/\s+/).filter(Boolean);
      const negated = words.some(w => NEGATION_WORDS.has(w));
      for (const phrase of RANKING_WORDS) {
        const phraseWords = phrase.split(' ');
        // Substring match per word (so "recommendation"/"recommends"/"recommended" all count as "recommend").
        for (let i = 0; i <= words.length - phraseWords.length; i++) {
          if (phraseWords.every((w, k) => words[i + k]!.includes(w))) {
            assert(negated, `Ranking/recommendation language "${phrase}" found without a negation in the same sentence in ${c.id}: "${sentence.trim()}"`);
          }
        }
      }
    }
  }
}

/** Every per-option consequence block in `state` must carry the same field set across options,
 * regardless of which option the oracle judges useful. */
export function assertSymmetricConsequences(entries: Record<string, unknown>[]) {
  assert(entries.length > 1, 'Need at least two option entries to check symmetry');
  const keysets = entries.map(e => Object.keys(e).sort().join(','));
  assert(new Set(keysets).size === 1, `Per-option consequence fields differ across options: ${[...new Set(keysets)].join(' | ')}`);
}

export function assertIdenticalMenus(cases: ScoutCase[]) {
  const byUnit = new Map<string, Set<string>>();
  for (const c of cases) {
    const menus = byUnit.get(c.unit) ?? new Set<string>();
    menus.add(JSON.stringify(Object.fromEntries(Object.entries(c.request.questions).map(([q, v]) => [q, Object.keys(v.criteria).sort()]))));
    byUnit.set(c.unit, menus);
  }
  for (const [unit, menus] of byUnit) assert.equal(menus.size, 1, `Unit ${unit} does not share one action menu across arms`);
}
