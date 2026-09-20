import { resolve } from 'node:path';

export const ROOT = resolve('.runtime/experiments/jev-round1-v1');
export const STAGE = 'round1-fixed';
export const PLAN_PATH = 'docs/jev-round1-plan.md';
export const LIMITS = { requests: 520, inputTokens: 2_000_000, requestsPerSecond: 2 };
export type Arm = 'raw' | 'age' | 'validity';
export const LIVE_PLAN = [0, 1].flatMap(mirror => {
  const arms: Arm[] = mirror === 0 ? ['raw', 'age', 'validity'] : ['validity', 'age', 'raw'];
  return arms.map(arm => ({ id: `r1-live-m${mirror}-${arm}`, arm, seed: 9200 + mirror, pattern: 'moving-car' as const, seconds: 20 }));
});
export const SCOPE = 'Round 1: temporal representation. Stipulated evidence/authority probes plus six continuous rendered-RGB yaw-only replays. No metric following, semantic car recognition, MAVLink or hardware qualification.';
