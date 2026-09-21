/** The real dispatch unit is the distinct (hypothesis, split, arm, replicate, request body), not the
 * case id: several different case ids can render byte-identical request bodies (an invalid-range R1
 * mirror is content-identical to its original; a memory-less `current-only` scenario can coincide with
 * another one). Every case whose body matches an already-dispatched id shares that ONE real response
 * instead of paying for (and silently dropping) a duplicate call. This is the sole mechanism: nothing
 * elsewhere re-dispatches or re-scores by raw case id. */
import {digest} from '../jev-spatial-text/transport.ts';
import type {ScoutCase} from './types.ts';

export function dispatchIdFor(c: ScoutCase): string {
  const bodyHash = digest(JSON.stringify(c.request)).slice(0, 24);
  return `${c.hypothesis}-${c.split}-${c.arm}-${bodyHash}-r${c.replicate}`;
}

/** Groups cases by dispatch id. A group with more than one case id means those cases render an
 * identical body for that (hypothesis, split, arm, replicate) slot: only ONE real request covers all
 * of them. Declared repeats (replicate 0 and 1 of the very same case) are separate dispatch ids by
 * construction and are never merged here. */
export function groupByDispatchId(cases: ScoutCase[]): Map<string, ScoutCase[]> {
  const groups = new Map<string, ScoutCase[]>();
  for (const c of cases) {
    const id = dispatchIdFor(c);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(c);
  }
  return groups;
}

/** Dispatch-id groups that contain more than one distinct case id: real duplicate request bodies beyond
 * the declared 2 identical repeats. Reported explicitly, never silently dropped. */
export function duplicateBodyReport(cases: ScoutCase[]) {
  const groups = groupByDispatchId(cases);
  const duplicates = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([dispatchId, members]) => ({dispatchId, caseIds: members.map(c => c.id), count: members.length}));
  return {distinctDispatches: groups.size, totalCases: cases.length, duplicates};
}
