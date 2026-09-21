/** The real dispatch unit is the distinct request body, not the case id: two cases can render
 * byte-identical bodies (a mirror can coincide with another draw). Every case whose body matches an
 * already-dispatched id shares that ONE real response instead of paying for a duplicate call. */
import {digest} from '../jev-spatial-text/transport.ts';
import type {RuleCase} from './types.ts';

export function dispatchIdFor(c: RuleCase): string {
  const bodyHash = digest(JSON.stringify(c.request)).slice(0, 24);
  return `${c.factor}-${c.arm}-${bodyHash}`;
}
export function groupByDispatchId(cases: RuleCase[]): Map<string, RuleCase[]> {
  const groups = new Map<string, RuleCase[]>();
  for (const c of cases) {
    const id = dispatchIdFor(c);
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(c);
  }
  return groups;
}
export function duplicateBodyReport(cases: RuleCase[]) {
  const groups = groupByDispatchId(cases);
  const duplicates = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([dispatchId, members]) => ({dispatchId, caseIds: members.map(c => c.id), count: members.length}));
  return {distinctDispatches: groups.size, totalCases: cases.length, duplicates};
}
