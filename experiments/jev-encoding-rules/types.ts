/** Shared request/case shape for the F1-F10 static encoding-rules probes. No sensor or model call
 * occurs while building these; every fact is stipulated in code (see oracle.ts). */
export type RuleQuestion = {type: 'choice'; instructions: string; criteria: Record<string, string>};
export type RuleCase = {
  id: string;
  factor: 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';
  arm: string;
  family: string;
  seed: number;
  mirror: boolean;
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string, RuleQuestion>};
  /** Oracle-derived useful (correct) action ids for the single decision question. Never copied into `request`. */
  expected: string[];
  /** Action ids that are actively wrong (harmful/unsafe), when the factor distinguishes this from merely
   * suboptimal. Empty when the factor has no such distinction. Never copied into `request`. */
  harmfulIds: string[];
  /** Oracle detail and provenance. Never copied into `request`. */
  meta: any;
};

export const MODEL = 'jev-1.13.0' as const;
