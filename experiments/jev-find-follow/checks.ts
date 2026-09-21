/** Mechanical checks that no evaluator field and no ranking/recommendation language reach a
 * controller request, plus a structural source scan enforcing the evaluator/controller import
 * boundary. Mirrors experiments/jev-scout-encodings/checks.ts's method (reused conceptually, not
 * imported, since that module's types are specific to the S/R hypothesis-testing case shape) and
 * F76's stdout-purity banned-substring check.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DecisionRequest } from './types.ts';

/** Field/substring names that only ever belong to evaluator/simulator truth. Finding one inside a
 * rendered request means truth leaked into the controller-visible payload. Reuses F76's banned
 * list plus this engine's own evaluator field names. */
export const EVALUATOR_ONLY_SUBSTRINGS = [
  'trueNearestSurfaceRangeM', 'trueBearingRightRad', 'targetWithinFov', 'cameraPosition', 'cameraHeadingDeg',
  'groundTruth', 'evaluatorTruth', 'simTruth', 'spectator', 'targetIdentity', 'blueCarCandidate',
  'selectedDetectionId', 'halfExtents', 'trueRange', 'truePose', 'oracle',
];

export function assertNoEvaluatorLeak(request: DecisionRequest): void {
  const text = JSON.stringify(request);
  for (const needle of EVALUATOR_ONLY_SUBSTRINGS) assert(!text.includes(needle), `Evaluator-only field "${needle}" leaked into a controller request`);
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
function requestStringValues(request: DecisionRequest): string[] {
  const out: string[] = [];
  stringValues(request.state, out);
  for (const q of Object.values(request.questions)) { out.push(q.instructions); stringValues(q.criteria, out); }
  return out;
}

/** No ranking/recommendation language in an affirmative sense anywhere in a rendered request. Code
 * may compute symmetric, unranked per-option consequences (F52/F57/F61's established convention)
 * but must never rank or choose for Jev. A ranking word is only a violation when NOT negated in the
 * same sentence, matching the repo's disclosure convention ("...not a ranking or a recommendation."). */
export function assertNoRankingLanguage(request: DecisionRequest): void {
  for (const value of requestStringValues(request)) {
    for (const sentence of value.split(/(?<=[.!?])\s+/)) {
      const lower = sentence.toLowerCase().replace(/[.,;:()!?]/g, '');
      const words = lower.split(/\s+/).filter(Boolean);
      const negated = words.some(w => NEGATION_WORDS.has(w));
      for (const phrase of RANKING_WORDS) {
        const phraseWords = phrase.split(' ');
        for (let i = 0; i <= words.length - phraseWords.length; i++) {
          if (phraseWords.every((w, k) => words[i + k]!.includes(w))) {
            assert(negated, `Ranking/recommendation language "${phrase}" found without a negation in the same sentence: "${sentence.trim()}"`);
          }
        }
      }
    }
  }
}

/** Every per-option consequence block must carry the identical field set across options. */
export function assertSymmetricConsequences(entries: Record<string, unknown>[]): void {
  assert(entries.length > 1, 'Need at least two option entries to check symmetry');
  const keysets = entries.map(e => Object.keys(e).sort().join(','));
  assert.equal(new Set(keysets).size, 1, `Per-option consequence fields differ across options: ${[...new Set(keysets)].join(' | ')}`);
}

/** Structural boundary: no source file under encoders/ or controllers/ may import evaluator.ts
 * (directly or via a relative path resolving to it), and sensor-client.ts must not import it
 * either — perception must be independent of evaluator truth (PRINCIPLES.md #3/#10). Scans actual
 * source text rather than trusting a comment, so a future accidental import fails a test, not just
 * a code review. */
export async function scanForEvaluatorImports(root: string): Promise<string[]> {
  const guarded = ['encoders', 'controllers'];
  const offenders: string[] = [];
  for (const dir of guarded) {
    let entries: string[];
    try { entries = await readdir(resolve(root, dir)); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const path = resolve(root, dir, entry);
      const text = await readFile(path, 'utf8');
      if (/from\s+['"][^'"]*evaluator(\.ts)?['"]/.test(text)) offenders.push(`${dir}/${entry}`);
    }
  }
  const sensorClientPath = resolve(root, 'sensor-client.ts');
  try {
    const text = await readFile(sensorClientPath, 'utf8');
    if (/from\s+['"][^'"]*evaluator(\.ts)?['"]/.test(text)) offenders.push('sensor-client.ts');
  } catch { /* not created yet in some contexts */ }
  return offenders;
}
