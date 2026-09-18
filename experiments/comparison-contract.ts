import type { Diagnostic, Vec3 } from '../src/contracts.ts';

/** Artifact schema is independent of a model vendor, harness, or robotics library. */
export type ComparisonArm = 'code-local' | 'agent-direct' | 'agent-routine' | 'jev-local' | 'agent-jev';
export interface Distribution { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
export interface ComparisonMetrics {
  trackingRmseM: number; withinRadiusPct: number; collisionStarts: number; holdMs: number;
  calls: number; appliedCommands: number; rejectedCommands: number; discardedDecisions: number;
  /** Observation-to-controller-consumption time in the simulation clock. */
  decisionLatencySimMs: Distribution;
  /** Request start to promise settlement; excludes the controller's polling delay. */
  decisionLatencyWallMs: Distribution;
  /** Promise settlement to consumption by the next controller tick. */
  decisionActivationDelayWallMs: Distribution;
  sensorAgeAtCommandMs: Distribution; eventReactionMs: Distribution;
  inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
}
export interface ComparisonTrial {
  id: string; arm: ComparisonArm; label: string; seed: number;
  evidence: 'injected' | 'live-jev';
  configuration: Record<string, unknown>;
  metrics: ComparisonMetrics;
  events: { id: string; kind: string; simMs: number; reactionMs: number | null }[];
  series: { simMs: number; robot: Vec3; target: Vec3; errorM: number; speedMps: number; held: boolean }[];
  trace: Diagnostic[];
  /** Optional full trace file; trace then contains only an explicitly counted viewer preview. */
  traceArtifact?: string;
  traceCoverage: { total: number; retained: number; dropped: number; truncated: number; preview?: number };
  finalStateHash: string;
}
export interface ComparisonReport {
  schemaVersion: 1; kind: 'controller-comparison'; id: string; createdAt: string;
  evidence: 'injected' | 'mixed'; configuration: Record<string, unknown>;
  versions: Record<string, unknown>; limitations: string[]; trials: ComparisonTrial[];
}

/** Human labels must distinguish real service calls from timing fixtures, including older artifacts. */
export function comparisonLabel(trial: Pick<ComparisonTrial, 'arm' | 'evidence'>): string {
  if (trial.arm === 'code-local') return 'Local code';
  if (trial.arm === 'agent-direct') return 'Simulated agent · direct actions';
  if (trial.arm === 'agent-routine') return 'Simulated agent · local routine';
  if (trial.arm === 'jev-local') return trial.evidence === 'live-jev' ? 'Live Jev selector' : 'Simulated fast selector';
  return trial.evidence === 'live-jev' ? 'Simulated agent · live Jev' : 'Simulated agent · fast selector';
}
