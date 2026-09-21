/** Shared request/case shape for the S (scouting) and R (range-following) encoding probes.
 * No sensor or model call occurs while building these; every fact is stipulated. */
export type ScoutQuestion = {type: 'choice'; instructions: string; criteria: Record<string, string>};
export type ScoutCase = {
  id: string;
  hypothesis: 'S' | 'R';
  split: 'development' | 'confirmation';
  family: string;
  unit: string;
  mirror: boolean;
  arm: string;
  replicate: number;
  request: {model: 'jev-1.13.0'; state: any; questions: Record<string, ScoutQuestion>};
  /** Oracle-derived "useful" answer ids for the single decision question. Never copied into `request`. */
  expected: Record<string, string[]>;
  /** Oracle detail, provenance and scoring hints. Never copied into `request`. */
  meta: any;
};

export const MODEL = 'jev-1.13.0' as const;
