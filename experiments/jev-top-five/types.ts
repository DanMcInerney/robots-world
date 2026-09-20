import type { Request } from '../jev-strategies/strategies.ts';

export type Split = 'development' | 'confirmation';
export type Technique = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export type Answers = Record<string, string>;
export type Probe = {
  id: string; technique: Technique; split: Split; unit: string; arm: string; replicate: number;
  request: Request;
  expected: Record<string, string[]>;
  meta: Record<string, any>;
};
export type Judge = (request: Request, id: string, signal?: AbortSignal) => Promise<any>;
export type Score = { correct: boolean; unsafe: boolean; decision: string; details: Record<string, any> };
