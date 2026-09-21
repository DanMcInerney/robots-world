/** Static request-hygiene checks, adapted from experiments/jev-scout-encodings/checks.ts for RuleCase. */
import assert from 'node:assert/strict';
import type {RuleCase} from './types.ts';

const ORACLE_ONLY_KEYS = ['useful', 'harmful', 'harmfulIds', 'isOptimal', 'oracle', 'expected', 'bestAbsError', 'caseKind'];
export function assertNoOracleLeak(c: RuleCase) {
  const text = JSON.stringify(c.request);
  for (const key of ORACLE_ONLY_KEYS) assert(!text.includes(`"${key}"`), `Oracle-only key "${key}" leaked into request ${c.id}`);
}

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
function requestStringValues(request: RuleCase['request']): string[] {
  const out: string[] = [];
  stringValues(request.state, out);
  for (const q of Object.values(request.questions)) { out.push(q.instructions); stringValues(q.criteria, out); }
  return out;
}
export function assertNoRankingLanguage(c: RuleCase) {
  for (const value of requestStringValues(c.request)) {
    for (const sentence of value.split(/(?<=[.!?])\s+/)) {
      const lower = sentence.toLowerCase().replace(/[.,;:()!?]/g, '');
      const words = lower.split(/\s+/).filter(Boolean);
      const negated = words.some(w => NEGATION_WORDS.has(w));
      for (const phrase of RANKING_WORDS) {
        const phraseWords = phrase.split(' ');
        for (let i = 0; i <= words.length - phraseWords.length; i++) {
          if (phraseWords.every((w, k) => words[i + k]!.includes(w))) {
            assert(negated, `Ranking/recommendation language "${phrase}" found without a negation in the same sentence in ${c.id}: "${sentence.trim()}"`);
          }
        }
      }
    }
  }
}
/** Every per-option consequence entry must carry the same field set, regardless of which option the
 * oracle judges useful (the printed facts are symmetric; only the underlying numbers differ). */
export function assertSymmetricConsequences(entries: Record<string, unknown>[]) {
  assert(entries.length > 1, 'Need at least two option entries to check symmetry');
  const keysets = entries.map(e => Object.keys(e).sort().join(','));
  assert(new Set(keysets).size === 1, `Per-option consequence fields differ across options: ${[...new Set(keysets)].join(' | ')}`);
}
export function assertIdenticalMenuWithinArm(cases: RuleCase[]) {
  const byArm = new Map<string, Set<string>>();
  for (const c of cases) {
    const menus = byArm.get(c.arm) ?? new Set<string>();
    menus.add(JSON.stringify(Object.fromEntries(Object.entries(c.request.questions).map(([q, v]) => [q, Object.keys(v.criteria).sort()]))));
    byArm.set(c.arm, menus);
  }
  for (const [arm, menus] of byArm) assert.equal(menus.size, 1, `Arm ${arm} does not share one action menu across its own cases`);
}
