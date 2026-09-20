import { resolve } from 'node:path';
export const ROOT = resolve('.runtime/experiments/jev-round2-v1');
export const LIMITS = { requests: 220, inputTokens: 1_000_000, requestsPerSecond: 2 };
export const PLAN_PATH = 'docs/jev-round2-plan.md';
export const MODEL = 'jev-1.13.0' as const;
export type Arm = 'measured' | 'consequences';
export type SensorRecord = {
  id: string; sceneId: string; split: 'development' | 'confirmation'; method: 'stereo' | 'monocular';
  leftPath: string; rightPath: string; depthPath?: string;
  observation: {
    source: 'rendered_rgb'; targetStatus: 'single' | 'missing' | 'ambiguous';
    axialDepthIntervalM: [number, number] | null; axialDepthM: number | null;
    validFraction: number; bearingDeg: number | null; intervalMeaning: string;
  };
  evaluation: { referenceAxialDepthM: number | null; family: string; [key: string]: unknown };
};
export type Probe = {
  id: string; split: 'development' | 'confirmation'; sceneId: string; recordId: string;
  method: SensorRecord['method']; arm: Arm; goalM: number;
  request: { model: typeof MODEL; state: any; questions: Record<string, { type: 'choice'; instructions: string[]; criteria: Record<string, string> }> };
  expected: string[]; meta: any;
};
export const SCOPE = 'Round 2: camera-derived metric depth and goal-dependent movement choices. Offline matched image estimates and one-step decisions; no executed flight, semantic car recognition or obstacle-clearance qualification.';
