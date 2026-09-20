import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BodySpec } from '../../src/contracts.ts';
import { framePng, renderCamera } from '../../src/devices/pixel-camera.ts';
import { colorTracker, type Region } from '../../src/perception/color-tracks.ts';

/** RGB-derived, text-only yaw component. This is not a flight or stereo qualification. */
export const BENCH_MISSION = 'Find the blue car in this unfamiliar area and follow it as it moves. It may not be visible initially. Choose where to look and move, keep it in view, avoid colliding with surfaces, and find it again after losing sight.';
export const BENCH_ARMS = ['receipt', 'linked', 'chronological', 'prediction', 'reflection'] as const;
export const BENCH_PATTERNS = ['stationary-offset', 'moving-car', 'transient-occlusion', 'interrupted-command'] as const;
export type BenchArm = typeof BENCH_ARMS[number];
export type BenchPattern = typeof BENCH_PATTERNS[number];
export const YAW_ACTIONS = { left_30: 30, left_10: 10, left_3: 3, retain: 0, right_3: -3, right_10: -10, right_30: -30 } as const;
export type YawAction = keyof typeof YAW_ACTIONS;
export type Forecast = 'left' | 'center' | 'right' | 'not_detected' | 'unknown';
export type BenchChoice = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };
export type BenchRequest = { model: 'jev-1.13.0'; state: Record<string, unknown>; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> };
export type BenchResponse = { model: string; answers: Record<string, BenchChoice>; usage?: unknown; [key: string]: unknown };
export type BenchJudge = (request: BenchRequest, id: string) => Promise<BenchResponse>;
export const BENCH_CONFIG = Object.freeze({ width: 320, height: 180, hfovDeg: 70, pitchDeg: 0, acquisitionMs: 200, tickMs: 20, yawRateDegS: 90, leaseMs: 1000, maxSourceAgeMs: 1000, minStartIntervalMs: 500, forecastAfterApplicationMs: 200, maxFrameCoverageMs: 250, historyCards: 8, maxSeconds: 120, maxTraceBytes: 32_000_000, schedulerVersion: 'monotonic-v2', maxCatchUpTicks: 5, maxSchedulerLagMs: 250, terminalGraceMs: 1000 });
const round = (v: number) => Math.round(v * 1000) / 1000;
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const wrapYaw = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;
export function headingTarget(action: YawAction, acquiredHeadingDeg: number, lastAcceptedHeadingDeg: number): number {
  if (!Object.hasOwn(YAW_ACTIONS, action) || ![acquiredHeadingDeg, lastAcceptedHeadingDeg].every(Number.isFinite)) throw new Error('Invalid yaw command');
  return wrapYaw(action === 'retain' ? lastAcceptedHeadingDeg : acquiredHeadingDeg + YAW_ACTIONS[action]);
}
export function yawStep(heading: number, target: number, elapsedMs: number): number {
  if (![heading, target, elapsedMs].every(Number.isFinite) || elapsedMs < 0) throw new Error('Invalid servo step');
  const error = wrapYaw(target - heading), limit = BENCH_CONFIG.yawRateDegS * elapsedMs / 1000;
  return wrapYaw(heading + Math.max(-limit, Math.min(limit, error)));
}
export type Acquisition = { id: string; acquiredMs: number; acquiredWallMs: number; deliveredWallMs: number; headingDeg: number; attitudeErrorBoundDeg: number; frame: string; sha256: string; calibration: { fx: number; fy: number; cx: number; cy: number }; objects: Region[]; overflow: number };
export type CommandEvent = { atMs: number; stage: 'accepted' | 'applied' | 'completed' | 'rejected' | 'expired' | 'superseded' | 'interrupted' | 'cancelled'; reason?: string };
export type BenchCommand = { id: string; requestId: string; action: YawAction; sourceId: string; sourceAcquiredMs: number; sourceHeadingDeg: number; sourceBlueId: string | null; requestedMs: number; receivedMs: number; acceptedMs: number | null; appliedMs: number | null; expiresMs: number | null; targetHeadingDeg: number | null; applyDueMs: number; events: CommandEvent[]; prediction?: Forecast; predictionQuestion?: string };
export type Outcome = { commandId: string; before: Acquisition | null; after: Acquisition | null; measuredYawDeltaDeg: number | null; concurrentCommandIds: string[]; observedCategory: Exclude<Forecast, 'unknown'> | null; comparison: 'match' | 'mismatch' | 'abstained' | 'not_tested'; reason: string; causalAttribution: 'unknown: target motion and motion outside the acquired interval are not established' };
const blue = (a: Acquisition) => a.objects.filter(o => o.color === 'blue');
const stopStages = new Set(['expired', 'superseded', 'interrupted', 'cancelled']);
const terminalAt = (c: BenchCommand) => c.events.find(e => stopStages.has(e.stage))?.atMs ?? Infinity;

/** Owns ordinary yaw stabilization and command lifetime only; never reads scene or pixels. */
export class YawBenchPlant {
  headingDeg = 0;
  lastAcceptedHeadingDeg = 0;
  commands: BenchCommand[] = [];
  private active: BenchCommand | undefined;
  private emit: (command: BenchCommand, event: CommandEvent) => void;
  constructor(emit: (command: BenchCommand, event: CommandEvent) => void = () => {}) { this.emit = emit; }
  private event(c: BenchCommand, event: CommandEvent) { c.events.push(event); this.emit(structuredClone(c), event); }
  accept(c: Omit<BenchCommand, 'acceptedMs' | 'appliedMs' | 'expiresMs' | 'targetHeadingDeg' | 'applyDueMs' | 'events'>, atMs: number, rejectReason?: string, delayMs = 20): BenchCommand {
    if (this.commands.length >= 256 || this.commands.some(v => v.id === c.id)) throw new Error('Command capacity or duplicate identity');
    const command: BenchCommand = { ...c, acceptedMs: null, appliedMs: null, expiresMs: null, targetHeadingDeg: null, applyDueMs: atMs + delayMs, events: [] };
    this.commands.push(command);
    const reason = rejectReason ?? (atMs - c.sourceAcquiredMs > BENCH_CONFIG.maxSourceAgeMs ? 'source-acquisition-stale' : undefined);
    if (reason) { this.event(command, { atMs, stage: 'rejected', reason }); return command; }
    command.acceptedMs = atMs; command.expiresMs = atMs + BENCH_CONFIG.leaseMs;
    command.targetHeadingDeg = headingTarget(c.action, c.sourceHeadingDeg, this.lastAcceptedHeadingDeg);
    this.lastAcceptedHeadingDeg = command.targetHeadingDeg;
    this.event(command, { atMs, stage: 'accepted' }); return command;
  }
  tick(atMs: number, elapsedMs: number) {
    // Integrate the authority that existed over the preceding interval, before new application.
    if (this.active) {
      const c = this.active, supportedMs = Math.max(0, Math.min(elapsedMs, c.expiresMs! - (atMs - elapsedMs)));
      this.headingDeg = yawStep(this.headingDeg, c.targetHeadingDeg!, supportedMs);
      if (Math.abs(wrapYaw(this.headingDeg - c.targetHeadingDeg!)) < .001 && !c.events.some(e => e.stage === 'completed')) this.event(c, { atMs, stage: 'completed' });
    }
    // Expiry is checked before admission reaches the actuator. Never apply an expired queue item.
    for (const c of this.commands) if (c.acceptedMs !== null && terminalAt(c) === Infinity && atMs >= c.expiresMs!) {
      this.event(c, { atMs, stage: 'expired', reason: c.appliedMs === null ? 'expired-before-application' : 'lease-ended' });
      if (this.active === c) this.active = undefined;
    }
    for (const c of this.commands) if (c.acceptedMs !== null && c.appliedMs === null && terminalAt(c) === Infinity && atMs >= c.applyDueMs) {
      if (this.active) this.event(this.active, { atMs, stage: 'superseded', reason: c.id });
      c.appliedMs = atMs; this.active = c; this.event(c, { atMs, stage: 'applied' });
    }
  }
  stop(atMs: number, stage: 'interrupted' | 'cancelled') {
    for (const c of this.commands) if (c.acceptedMs !== null && terminalAt(c) === Infinity) this.event(c, { atMs, stage });
    this.active = undefined;
  }
}

/** Uses only calibrated pixel regions; a boundary-straddling pixel interval is unscorable. */
export function observedCategory(a: Acquisition): Outcome['observedCategory'] {
  const regions = blue(a); if (a.overflow || regions.length > 1) return null;
  if (!regions.length) return 'not_detected';
  const r = regions[0]!; if (r.clipped) return null;
  const uncertainty = Math.atan(.5 / a.calibration.fx) * 180 / Math.PI + .005;
  if (r.rightDeg + uncertainty < -5) return 'left';
  if (r.rightDeg - uncertainty > 5) return 'right';
  return r.rightDeg - uncertainty >= -5 && r.rightDeg + uncertainty <= 5 ? 'center' : null;
}
export function deriveOutcome(c: BenchCommand, acquisitions: readonly Acquisition[], commands: readonly BenchCommand[]): Outcome {
  const anchor = c.appliedMs ?? c.receivedMs;
  const before = acquisitions.findLast(a => a.acquiredMs <= anchor) ?? null;
  const after = acquisitions.find(a => a.acquiredMs >= anchor + BENCH_CONFIG.forecastAfterApplicationMs) ?? null;
  const concurrent = commands.filter(v => v.id !== c.id && v.appliedMs !== null && v.appliedMs <= (after?.acquiredMs ?? anchor) && terminalAt(v) > (before?.acquiredMs ?? anchor)).map(v => v.id);
  let reason = 'application and acquisition interval available';
  if (c.appliedMs === null) reason = c.acceptedMs === null ? 'command-rejected-not-applied' : 'command-not-applied';
  else if (!before || !after || anchor - before.acquiredMs > 250 || after.acquiredMs - anchor > 450) reason = 'missing-or-late-acquisition';
  else if (c.events.some(e => stopStages.has(e.stage) && (e.atMs < after.acquiredMs || e.atMs === after.acquiredMs && e.stage !== 'cancelled'))) reason = 'command-ended-before-outcome-acquisition';
  else if (commands.some(v => v.id !== c.id && v.appliedMs !== null && v.appliedMs > anchor && v.appliedMs <= after.acquiredMs)) reason = 'another-command-applied-in-forecast-interval';
  else if (!c.sourceBlueId || blue(before).length !== 1 || blue(before)[0]!.id !== c.sourceBlueId || (blue(after).length && (blue(after).length !== 1 || blue(after)[0]!.id !== c.sourceBlueId))) reason = 'target-association-ambiguous';
  else if (observedCategory(after) === null) reason = 'category-boundary-clipping-or-overflow';
  const scorable = reason === 'application and acquisition interval available';
  return { commandId: c.id, before, after, measuredYawDeltaDeg: before && after ? round(wrapYaw(after.headingDeg - before.headingDeg)) : null, concurrentCommandIds: concurrent,
    observedCategory: after ? observedCategory(after) : null, comparison: !scorable || c.prediction === undefined ? 'not_tested' : c.prediction === 'unknown' ? 'abstained' : c.prediction === observedCategory(after!) ? 'match' : 'mismatch', reason,
    causalAttribution: 'unknown: target motion and motion outside the acquired interval are not established' };
}

export type HistoryFact = { id: string; commandId: string; atMs: number; kind: string; value: unknown };
const view = (a: Acquisition) => ({ id: a.id, acquiredMs: a.acquiredMs, headingDeg: a.headingDeg, attitudeErrorBoundDeg: a.attitudeErrorBoundDeg, objects: a.objects.map(({ history: _history, ...r }) => r), overflow: a.overflow });
/** Same atomic facts underlie linked and chronological treatments, including relation IDs. */
export function historyFacts(commands: readonly BenchCommand[], acquisitions: readonly Acquisition[]): HistoryFact[] {
  return commands.slice(-BENCH_CONFIG.historyCards).flatMap(c => {
    const o = deriveOutcome(c, acquisitions, commands), facts: HistoryFact[] = [
      { id: `${c.id}/selection`, commandId: c.id, atMs: c.receivedMs, kind: 'own-command', value: { action: c.action, sourceId: c.sourceId, sourceAcquiredMs: c.sourceAcquiredMs, sourceHeadingDeg: c.sourceHeadingDeg, requestedMs: c.requestedMs, receivedMs: c.receivedMs, targetHeadingDeg: c.targetHeadingDeg, expiresMs: c.expiresMs } },
      ...c.events.map((e, i) => ({ id: `${c.id}/event/${i}`, commandId: c.id, atMs: e.atMs, kind: 'execution', value: e })),
    ];
    for (const [phase, a] of [['before', o.before], ['after', o.after]] as const) if (a) facts.push({ id: `${c.id}/${phase}`, commandId: c.id, atMs: a.acquiredMs, kind: phase, value: view(a) });
    facts.push({ id: `${c.id}/relation`, commandId: c.id, atMs: o.after?.acquiredMs ?? c.receivedMs, kind: 'observed-relation', value: { beforeId: o.before?.id ?? null, afterId: o.after?.id ?? null, measuredYawDeltaDeg: o.measuredYawDeltaDeg, concurrentCommandIds: o.concurrentCommandIds, causalAttribution: o.causalAttribution } });
    return facts;
  });
}
const yawCriteria: Record<YawAction, string> = Object.fromEntries(Object.entries(YAW_ACTIONS).map(([key, deg]) => [key, deg === 0 ? 'Retain the previously accepted absolute heading setpoint, including an unfinished turn; renew its one-second command lease.' : `Set absolute heading to the acquired heading ${deg > 0 ? 'plus' : 'minus'} ${Math.abs(deg)} degrees: turn ${Math.abs(deg)} degrees ${deg > 0 ? 'left' : 'right'} relative to the acquired heading.`])) as Record<YawAction, string>;
const forecastCriteria: Record<Forecast, string> = { left: 'Associated blue region detected more than 5 degrees left of image center.', center: 'Associated blue region detected within 5 degrees of image center, inclusive.', right: 'Associated blue region detected more than 5 degrees right of image center.', not_detected: 'Valid acquisition contains no detection of the associated blue region.', unknown: 'Abstain: present evidence does not support a committed forecast; this is not a future physical event.' };
export type ModelHypothesis = { requestId: string; episodeId: string; selectedMs: number; expiresMs: number; model_hypothesis: string };
export function componentObjective(calibration: Acquisition['calibration']) {
  const bearingLimit = Math.atan(.3 * calibration.cx / calibration.fx) * 180 / Math.PI;
  return { instruction: 'Center the unique detected blue color region within the stated horizontal band, keep it unclipped, and maintain that framing. If detection is lost, choose yaw actions to find it again. Translation remains zero; this is the yaw component of the exact broad mission.',
    normalizedCenter: '(boundingBoxCenterX - principalPointX) / principalPointX', allowedNormalizedInterval: [-.3, .3], allowedUnroundedRightDegInterval: [-bearingLimit, bearingLimit],
    qualification: 'Framed requires one blue region, no region overflow, no clipping, and horizontal center within the inclusive band. Reported rightDeg is rounded to0.01 degree; the pixel rectangle defines the boundary. Visibility alone is not framing.' };
}
function supportedHypothesis(h: ModelHypothesis, commands: readonly BenchCommand[], acquisitions: readonly Acquisition[]): boolean {
  const c = commands.find(c => c.id === h.episodeId); if (!c) return false;
  const outcome = deriveOutcome(c, acquisitions, commands), delta = outcome.measuredYawDeltaDeg;
  if (h.model_hypothesis === 'not_applied') return c.appliedMs === null;
  if (h.model_hypothesis === 'measured_turn') return c.appliedMs !== null && delta !== null && Math.abs(delta) > .1;
  if (h.model_hypothesis === 'no_measured_turn') return delta !== null && Math.abs(delta) <= .1;
  return h.model_hypothesis === 'cause_unknown';
}
export function buildBenchRequest(arm: BenchArm, current: Acquisition, assembledMs: number, wallMs: number, plant: Pick<YawBenchPlant, 'commands' | 'lastAcceptedHeadingDeg'>, acquisitions: readonly Acquisition[], hypotheses: readonly ModelHypothesis[] = []): BenchRequest {
  const commands = plant.commands, facts = historyFacts(commands, acquisitions);
  const request: BenchRequest = { model: 'jev-1.13.0', state: {
    goal: BENCH_MISSION,
    componentObjective: componentObjective(current.calibration),
    scope: 'Yaw-only camera-control COMPONENT bench. Translation is fixed at zero; pitch and horizontal FOV are fixed. Component objective: keep the supplied blue color region horizontally framed. Full mission, semantic car recognition, flight, collision avoidance and stereo depth are not qualified here.',
    evidence: 'Color regions are measured from rendered RGB. Track IDs are tentative image associations. No range, metric object geometry, free space or future target motion is available. Absence is not evidence of free space. Other moving objects and physical occluders may affect measurements.',
    snapshot: { ...view(current), assembledMs, assembledWallMs: wallMs, acquiredWallMs: current.acquiredWallMs, deliveredWallMs: current.deliveredWallMs, ageMs: assembledMs - current.acquiredMs, wallAgeMs: wallMs - current.acquiredWallMs },
    attitudeSource: 'Declared simulated attitude sensor sampled with each RGB frame, rounded to 0.1 degree; error bound 0.05 degree. This is idealized simulated telemetry, not measured hardware or visual odometry.',
    camera: { widthPx: 320, heightPx: 180, horizontalFovDeg: 70, fixedPitchDeg: 0, calibration: current.calibration, bearingConvention: 'Positive rightDeg is image right. Positive heading/yaw rotates left. Camera and body are rigidly aligned.' },
    controls: { acquiredHeadingDeg: current.headingDeg, lastAcceptedHeadingDeg: plant.lastAcceptedHeadingDeg, yawRateLimitDegS: 90, leaseMs: 1000, acquisitionHz: 5, maximumRequestStartsHz: 2, semantics: 'Nonzero increments use the acquired heading, not the eventual application heading. Zero retains the accepted absolute target. Acceptance is not application or measured motion. Rejection leaves earlier actuation running; expired commands cannot apply. Servo, sensing and scene continue during inference. All seven choices are available.' },
    receipts: commands.slice(-2).map(c => ({ commandId: c.id, action: c.action, sourceId: c.sourceId, sourceHeadingDeg: c.sourceHeadingDeg, targetHeadingDeg: c.targetHeadingDeg, acceptedMs: c.acceptedMs, appliedMs: c.appliedMs, expiresMs: c.expiresMs, events: c.events })),
  }, questions: { yaw: { type: 'choice', instructions: 'Choose the yaw command for the current acquired scene within this yaw-only component of the exact mission. All seven actions remain available. Use the explicit acquired-heading and retain-setpoint semantics. No sibling answer is available.', criteria: { ...yawCriteria } } } };
  if (arm === 'chronological') request.state.history = [...facts].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  if (arm !== 'receipt' && arm !== 'chronological') request.state.history = commands.slice(-8).map(c => ({ commandId: c.id, facts: facts.filter(f => f.commandId === c.id) }));
  if (arm === 'prediction') {
    for (const [action, description] of Object.entries(yawCriteria)) request.questions[`forecast_if_${action}`] = { type: 'choice', instructions: `Assume exactly this command actually starts application: ${description} Predict the source snapshot's blue region category at the first camera acquisition at least 200 ms after application starts (5 Hz acquisition; no more than 400 ms nominally). Translation, pitch and FOV remain fixed. Future target motion is not guaranteed by prior stillness. Replaced, interrupted, expired, missing or ambiguous intervals are not scored. This question is conditional on this named command, not a sibling answer.`, criteria: { ...forecastCriteria } };
    request.state.previousPredictions = commands.slice(-8).filter(c => c.prediction !== undefined).map(c => { const o = deriveOutcome(c, acquisitions, commands); return { commandId: c.id, predictionQuestion: c.predictionQuestion, selectedPrediction: c.prediction, observationId: o.after?.id ?? null, observedCategory: o.observedCategory, comparison: o.comparison, reason: o.reason }; });
  }
  if (arm === 'reflection') {
    const latest = commands.findLast(c => deriveOutcome(c, acquisitions, commands).after !== null);
    request.state.modelHypotheses = hypotheses.filter(h => h.expiresMs > assembledMs && supportedHypothesis(h, commands, acquisitions)).slice(-2);
    if (latest) request.questions.prior_episode_assessment = { type: 'choice', instructions: `Select the supported retrospective assessment of own command ${latest.id}. This is a finite model hypothesis about the linked acquisitions and application record; not a fact, recommendation, free-form lesson or input to the sibling yaw answer.`, criteria: { not_applied: 'This command did not begin application.', measured_turn: 'Acquired attitude changed after application; the target change cause remains unknown.', no_measured_turn: 'The bracketing acquired attitude shows no resolvable turn; this alone does not prove no intervening movement.', cause_unknown: 'The application, observation interval, or concurrent effects do not establish what caused the observed changes.' } };
    request.state.assessedEpisodeId = latest?.id ?? null;
  }
  return structuredClone(request);
}
export function validateBenchResponse(request: BenchRequest, response: BenchResponse): void {
  if (response?.model !== request.model || !response.answers || Object.keys(response.answers).length !== Object.keys(request.questions).length) throw new Error('Wrong model or answer coverage');
  for (const [id, question] of Object.entries(request.questions)) {
    const a = response.answers[id], keys = Object.keys(question.criteria);
    if (!a || a.type !== 'choice' || !keys.includes(a.choice) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 || !a.probabilities || Object.keys(a.probabilities).length !== keys.length || keys.some(k => !Number.isFinite(a.probabilities[k]) || a.probabilities[k]! < 0 || a.probabilities[k]! > 1) || Math.abs(Object.values(a.probabilities).reduce((s, v) => s + v, 0) - 1) > .02) throw new Error(`Invalid choice or probability coverage: ${id}`);
  }
}

export type CoverageSample = { acquiredMs: number; visible: boolean; framed: boolean };
export function scoreCoverage(samples: readonly CoverageSample[], durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0 || samples.some((s, i) => !Number.isFinite(s.acquiredMs) || s.acquiredMs < 0 || (i > 0 && s.acquiredMs <= samples[i - 1]!.acquiredMs))) throw new Error('Invalid acquisition sequence or duration');
  let coveredMs = 0, visibleMs = 0, framedMs = 0, longestFramedMs = 0, currentFramedMs = 0, currentLossMs = 0, longestLossMs = 0, cursor = 0;
  const gap = (ms: number) => { if (ms > 0) { currentFramedMs = 0; currentLossMs += ms; longestLossMs = Math.max(longestLossMs, currentLossMs); } };
  for (const [i, s] of samples.entries()) {
    if (s.acquiredMs >= durationMs) break;
    gap(Math.max(0, s.acquiredMs - cursor));
    const duration = Math.max(0, Math.min(BENCH_CONFIG.maxFrameCoverageMs, (samples[i + 1]?.acquiredMs ?? durationMs) - s.acquiredMs, durationMs - s.acquiredMs));
    coveredMs += duration;
    if (s.visible) { visibleMs += duration; currentLossMs = 0; } else { currentLossMs += duration; longestLossMs = Math.max(longestLossMs, currentLossMs); }
    if (s.framed) { framedMs += duration; currentFramedMs += duration; longestFramedMs = Math.max(longestFramedMs, currentFramedMs); } else currentFramedMs = 0;
    cursor = s.acquiredMs + duration;
  }
  gap(Math.max(0, durationMs - cursor));
  return { durationMs, coveredMs, unknownMs: durationMs - coveredMs, visibleMs, framedMs, framedFraction: durationMs ? framedMs / durationMs : 0, longestFramedMs, longestLossMs, firstDetectionMs: samples.find(s => s.acquiredMs < durationMs && s.visible)?.acquiredMs ?? null };
}
export function coverage(a: Acquisition): CoverageSample {
  const regions = blue(a), unique = !a.overflow && regions.length === 1, r = regions[0];
  return { acquiredMs: a.acquiredMs, visible: unique, framed: Boolean(unique && r && !r.clipped && Math.abs(((r.box[0] + r.box[2]) / 2 - a.calibration.cx) / a.calibration.cx) <= .3) };
}

/** Evaluator/render input only. None of these coordinates or schedules enter buildBenchRequest. */
export function benchScene(seed: number, pattern: BenchPattern, atMs: number): BodySpec[] {
  const sign = seed % 2 ? 1 : -1, offset = 17 + Math.floor(Math.abs(seed) / 2) % 9, t = atMs / 1000;
  let bearing = sign * offset;
  if (pattern === 'moving-car') bearing = sign * (19 * Math.cos(t * .55) + 8 * Math.sin(t * .9));
  if (pattern === 'transient-occlusion') bearing = sign * (25 * Math.cos(t * .65));
  const body = (id: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string): BodySpec => ({ id, mode: 'fixed', pose: { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, shape: { kind: 'box', size: { x: sx, y: sy, z: sz }, color } });
  const scene = [body('render-only-blue-car', 12, Math.tan(bearing * Math.PI / 180) * 12, 1.4, 1.2, 1.6, .8, '#245bea'), body('render-only-side-post', 9, -8 * sign, 1.4, .3, .3, 2.8, '#da632b')];
  if (pattern === 'transient-occlusion') scene.push(body('render-only-opaque-screen', 6, 0, 1.4, .3, 2.4, 2.8, '#a94535'));
  return scene;
}
export type BenchSummary = { id: string; arm: BenchArm; seed: number; pattern: BenchPattern; outputDir: string; status: 'completed' | 'cancelled' | 'invalid'; error: string | null; scope: string; simulatedMs: number; wallMs: number; calls: number; acquisitions: number; pendingAtStop: boolean; commandCounts: Record<string, number>; score: ReturnType<typeof scoreCoverage>; passiveFixedObserver: ReturnType<typeof scoreCoverage>; deltaFramedMs: number; forecast: { scorable: number; committed: number; correct: number; abstained: number; notTested: number; commitmentCoverage: number | null; accuracyCommitted: number | null; correctAllScorable: number | null }; traceBytes: number; maxPacingLagMs: number; missionSuccess: null };
export type RunBenchOptions = { id: string; arm: BenchArm; seed: number; seconds: number; outputDir: string; judge: BenchJudge; signal?: AbortSignal; pattern?: BenchPattern };

/** Pure deadline arithmetic. Catch-up is bounded; an overloaded run fails instead of slowing silently. */
export function benchTickPlan(elapsedMs: number, simMs: number, durationMs: number) {
  if (![elapsedMs, simMs, durationMs].every(Number.isFinite) || elapsedMs < 0 || simMs < 0 || durationMs < simMs) throw new Error('Invalid scheduler clock');
  const lagMs = Math.max(0, elapsedMs - simMs);
  const invalid = lagMs > BENCH_CONFIG.maxSchedulerLagMs;
  return { lagMs, invalid, ticks: invalid ? 0 : Math.min(BENCH_CONFIG.maxCatchUpTicks, Math.max(0, Math.floor((Math.min(elapsedMs, durationMs) - simMs) / BENCH_CONFIG.tickMs))), nextDelayMs: Math.max(1, Math.ceil(simMs + BENCH_CONFIG.tickMs - elapsedMs)) };
}
export function benchDispatchBlock(running: boolean, aborted: boolean, elapsedMs: number, simMs: number, durationMs: number): 'stopped' | 'cancelled' | 'lag' | 'deadline' | null {
  if (!running) return 'stopped';
  if (aborted) return 'cancelled';
  if (benchTickPlan(elapsedMs, simMs, durationMs).invalid) return 'lag';
  return elapsedMs >= durationMs ? 'deadline' : null;
}

export async function runBench(options: RunBenchOptions): Promise<BenchSummary> {
  const { id, arm, seed, seconds, judge, signal } = options, pattern = options.pattern ?? BENCH_PATTERNS[Math.abs(seed) % BENCH_PATTERNS.length]!;
  if (!/^[a-zA-Z0-9_-]{1,90}$/.test(id) || !BENCH_ARMS.includes(arm) || !BENCH_PATTERNS.includes(pattern) || !Number.isSafeInteger(seed) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new Error('Invalid bench configuration');
  const outputDir = resolve(options.outputDir, id); mkdirSync(options.outputDir, { recursive: true }); mkdirSync(outputDir); mkdirSync(resolve(outputDir, 'frames'));
  const manifest = { id, arm, seed, pattern, seconds, config: BENCH_CONFIG, mission: BENCH_MISSION, sourceSha256: sha(readFileSync(new URL(import.meta.url))), scope: 'Text-only RGB yaw camera-control bench, simplified plant, simulated attitude; no physical flight, stereo, range or semantic car qualification.', scheduler: '20ms steps follow absolute monotonic wall deadlines, at most five overdue steps per yielded batch. Camera acquisition occurs on each200ms simulation boundary with its actual acquisition wall timestamp. Lag exceeding250ms invalidates the run before further dispatch/actuation; final wall watchdog permits1000ms grace. No call starts at/after the requested wall duration.', faultSchedule: pattern === 'interrupted-command' ? { rejectAdmissionMs: [1500, 2500], interruptMs: 3500, delayApplicationMs: [4500, 5500], delayedByMs: 1200 } : null, passiveCounterfactual: 'Evaluator-only: same rendered scene at the same acquisition times with yaw held at initial zero.', scoring: 'Acquired visible/framed coverage capped at 250ms per sample, gaps unknown/loss. Framed means one unclipped blue region with horizontal normalized image offset within +/-0.3; no full-mission pass claim.' };
  writeFileSync(resolve(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  let traceBytes = 0, simMs = 0, calls = 0, running = true, pending = false, pendingAtStop = false, maxPacingLagMs = 0, status: BenchSummary['status'] = 'completed', error: string | null = null;
  const wallStart = Date.now(), monotonicStart = performance.now(), durationMs = Math.ceil(seconds * 1000 / 20) * 20;
  const emit = (kind: string, data: unknown) => { const line = JSON.stringify({ kind, simMs, wallMs: Date.now(), data }) + '\n'; const bytes = Buffer.byteLength(line); if (traceBytes + bytes > BENCH_CONFIG.maxTraceBytes) throw new Error('Trace capacity exceeded; evidence backpressure'); appendFileSync(resolve(outputDir, 'trace.jsonl'), line); traceBytes += bytes; };
  const plant = new YawBenchPlant((command, event) => emit('command-stage', { command, event }));
  const acquisitions: Acquisition[] = [], passive: CoverageSample[] = [], hypotheses: ModelHypothesis[] = [];
  const track = colorTracker(), passiveTrack = colorTracker();
  const acquire = () => {
    const scene = benchScene(seed, pattern, simMs), startedWallMs = Date.now();
    for (const mode of ['controlled', 'passive'] as const) {
      const headingDeg = mode === 'controlled' ? plant.headingDeg : 0;
      const rendered = renderCamera(scene, [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
      const regions = (mode === 'controlled' ? track : passiveTrack)(rendered.image, rendered.calibration, simMs), png = framePng(rendered.image), frame = `frames/${mode}-${String(simMs).padStart(6, '0')}.png`;
      writeFileSync(resolve(outputDir, frame), png, { flag: 'wx' });
      const a: Acquisition = { id: `${mode}-${simMs}`, acquiredMs: simMs, acquiredWallMs: startedWallMs, deliveredWallMs: Date.now(), headingDeg: Math.round(headingDeg * 10) / 10, attitudeErrorBoundDeg: .05, frame, sha256: sha(png), calibration: rendered.calibration, objects: regions.objects, overflow: regions.overflow };
      if (mode === 'controlled') { acquisitions.push(a); emit('acquisition', a); } else { passive.push(coverage(a)); emit('evaluator-passive-acquisition', a); }
    }
    emit('outcomes', plant.commands.slice(-8).map(c => { const o = deriveOutcome(c, acquisitions, plant.commands); return { ...o, before: o.before?.id ?? null, after: o.after?.id ?? null }; }));
  };
  let finish!: () => void;
  const finished = new Promise<void>(r => { finish = r; });
  const stop = (nextStatus: BenchSummary['status'], message: string | null = null) => { if (!running) return; running = false; status = nextStatus; error = message; pendingAtStop = pending; try { plant.stop(simMs, 'cancelled'); emit('stop', { status, error, pendingAtStop }); } catch (e) { status = 'invalid'; error = String(e); } finish(); };
  const onAbort = () => stop('cancelled', String(signal?.reason ?? 'aborted'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const clockGate = () => {
    const plan = benchTickPlan(performance.now() - monotonicStart, simMs, durationMs);
    maxPacingLagMs = Math.max(maxPacingLagMs, plan.lagMs);
    if (plan.invalid) stop('invalid', `Scheduler lag ${round(plan.lagMs)}ms exceeds ${BENCH_CONFIG.maxSchedulerLagMs}ms; no further dispatch or actuation`);
    return !plan.invalid && running;
  };
  let tick: ReturnType<typeof setTimeout> | undefined;
  const scheduleTick = () => { tick = setTimeout(pump, benchTickPlan(performance.now() - monotonicStart, simMs, durationMs).nextDelayMs); };
  const pump = () => {
    if (!running) return;
    try {
      const plan = benchTickPlan(performance.now() - monotonicStart, simMs, durationMs);
      if (!clockGate()) return;
      for (let i = 0; i < plan.ticks && running; i++) {
        if (signal?.aborted) { onAbort(); break; }
        if (!clockGate()) break;
        simMs += 20; plant.tick(simMs, 20);
        if (pattern === 'interrupted-command' && simMs === 3500) { plant.stop(simMs, 'interrupted'); emit('scheduled-interruption', { atMs: simMs }); }
        if (simMs % 200 === 0) acquire();
        maxPacingLagMs = Math.max(maxPacingLagMs, Math.max(0, performance.now() - monotonicStart - simMs));
        if (!clockGate()) break;
        if (simMs >= durationMs) stop('completed');
      }
      if (running) scheduleTick();
    } catch (e) { stop('invalid', String(e)); }
  };
  scheduleTick();
  const watchdog = setTimeout(() => stop('invalid', 'Wall-time bound exceeded; simulator could not keep pace'), durationMs + BENCH_CONFIG.terminalGraceMs);
  const nap = (ms: number) => new Promise<void>(r => { const timer = setTimeout(r, ms); void finished.then(() => { clearTimeout(timer); r(); }); });
  const control = async () => {
    let lastStart = -Infinity;
    try {
      if (signal?.aborted) { onAbort(); return; }
      acquire();
      while (running) {
        // Timer delays may round down; only the monotonic clock authorizes a new start.
        while (running && performance.now() < lastStart + 500) await nap(Math.ceil(lastStart + 500 - performance.now()));
        if (!running) break;
        if (!clockGate()) break;
        if (performance.now() - monotonicStart >= durationMs) { await finished; break; }
        if (calls >= 256) { stop('invalid', 'Request capacity reached before another judge dispatch'); break; }
        const source = acquisitions.at(-1)!;
        if (Date.now() - source.acquiredWallMs > 1000) { stop('invalid', 'Latest acquired camera frame stale in wall time'); break; }
        const request = buildBenchRequest(arm, source, simMs, Date.now(), plant, acquisitions, hypotheses), requestId = `${id}-q${String(calls + 1).padStart(4, '0')}`, requestedMs = simMs;
        if (Buffer.byteLength(JSON.stringify(request)) > 100_000) throw new Error('Request byte capacity exceeded');
        emit('request-prepared', { requestId, request }); writeFileSync(resolve(outputDir, `${requestId}.request.json`), JSON.stringify(request), { flag: 'wx' });
        const response = Promise.resolve().then(async () => {
          // Serialization and file writes may have crossed a deadline. This final check follows
          // all preparation; there is no await or filesystem operation before callback invocation.
          const dispatched = structuredClone(request), start = performance.now();
          const blocked = benchDispatchBlock(running, signal?.aborted ?? false, start - monotonicStart, simMs, durationMs);
          if (blocked) {
            emit('prepared-request-discarded', { requestId, reason: blocked, callbackStarted: false });
            if (blocked === 'cancelled') onAbort(); else if (blocked === 'lag') clockGate();
            return { answer: null, error: null, notStarted: true };
          }
          lastStart = start; const startedWallMs = Date.now(); calls++; pending = true;
          try {
            let transport: Promise<BenchResponse>;
            try { transport = judge(dispatched, requestId); }
            finally { emit('request', { requestId, request, callbackStartedWallMs: startedWallMs, callbackStartedElapsedMs: start - monotonicStart }); }
            return { answer: await transport, error: null, notStarted: false };
          } catch (e) { return { answer: null, error: String(e), notStarted: false }; }
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([response, finished.then(() => null), new Promise<null>(r => { timeout = setTimeout(() => { stop('invalid', 'Judge deadline exceeded; no retry or late application'); r(null); }, 10_000); })]);
        clearTimeout(timeout);
        if (result === null) {
          // The root owns transport cancellation/accounting. Preserve any late reply without effect.
          void response.then(late => { try { writeFileSync(resolve(outputDir, `${requestId}.late.json`), JSON.stringify({ receivedWallMs: Date.now(), discarded: true, ...late }), { flag: 'wx' }); } catch { /* Root ledger retains transport evidence if this sink fails. */ } });
          break;
        }
        if (result.notStarted) { await finished; break; }
        pending = false; writeFileSync(resolve(outputDir, `${requestId}.response.json`), JSON.stringify(result), { flag: 'wx' }); emit('response', { requestId, ...result });
        if (!running || !clockGate()) break;
        if (result.error || !result.answer) throw new Error(result.error ?? 'Missing response');
        validateBenchResponse(request, result.answer);
        // A reply cannot enter old simulation time and then actuate during historical catch-up.
        // Let the independent scheduler reach the most recent due tick before admission; the
        // command's next20ms application boundary is then after the real response instant.
        while (running && clockGate() && performance.now() - monotonicStart - simMs >= BENCH_CONFIG.tickMs) await nap(1);
        if (!running) break;
        const action = result.answer.answers.yaw!.choice as YawAction, prediction = arm === 'prediction' ? result.answer.answers[`forecast_if_${action}`]!.choice as Forecast : undefined;
        const reject = Date.now() - source.acquiredWallMs > 1000 ? 'source-acquisition-stale-wall-time' : pattern === 'interrupted-command' && simMs >= 1500 && simMs < 2500 ? 'scheduled-admission-rejection' : undefined;
        const command = plant.accept({ id: `${requestId}-cmd`, requestId, action, sourceId: source.id, sourceAcquiredMs: source.acquiredMs, sourceHeadingDeg: source.headingDeg, sourceBlueId: blue(source).length === 1 ? blue(source)[0]!.id : null, requestedMs, receivedMs: simMs, ...(prediction === undefined ? {} : { prediction, predictionQuestion: `forecast_if_${action}` }) }, simMs, reject, pattern === 'interrupted-command' && simMs >= 4500 && simMs < 5500 ? 1200 : 20);
        emit('mapping', { requestId, commandId: command.id, action, targetHeadingDeg: command.targetHeadingDeg, selectedPrediction: prediction ?? null });
        if (arm === 'reflection' && result.answer.answers.prior_episode_assessment) {
          // One immutable old interval per hypothesis; any revision invalidates it at next assembly.
          const h = { requestId, episodeId: String(request.state.assessedEpisodeId), selectedMs: simMs, expiresMs: simMs + 2000, model_hypothesis: result.answer.answers.prior_episode_assessment.choice };
          hypotheses.push(h); if (hypotheses.length > 2) hypotheses.shift(); emit('model-hypothesis', h);
        }
      }
    } catch (e) { stop('invalid', String(e)); }
  };
  try { await Promise.all([control(), finished]); } finally { clearTimeout(tick); clearTimeout(watchdog); signal?.removeEventListener('abort', onAbort); }
  const outcomes = plant.commands.map(c => deriveOutcome(c, acquisitions, plant.commands)), predictions = outcomes.filter((_, i) => plant.commands[i]!.prediction !== undefined), scorable = predictions.filter(o => o.comparison !== 'not_tested'), committed = scorable.filter(o => o.comparison !== 'abstained'), correct = committed.filter(o => o.comparison === 'match').length;
  const score = scoreCoverage(acquisitions.map(coverage), simMs), passiveFixedObserver = scoreCoverage(passive, simMs);
  const summary: BenchSummary = { id, arm, seed, pattern, outputDir, status, error, scope: manifest.scope, simulatedMs: simMs, wallMs: Date.now() - wallStart, calls, acquisitions: acquisitions.length, pendingAtStop, commandCounts: Object.fromEntries(['accepted', 'applied', 'completed', 'rejected', 'expired', 'superseded', 'interrupted', 'cancelled'].map(stage => [stage, plant.commands.filter(c => c.events.some(e => e.stage === stage)).length])), score, passiveFixedObserver, deltaFramedMs: score.framedMs - passiveFixedObserver.framedMs, forecast: { scorable: scorable.length, committed: committed.length, correct, abstained: scorable.length - committed.length, notTested: predictions.length - scorable.length, commitmentCoverage: scorable.length ? committed.length / scorable.length : null, accuracyCommitted: committed.length ? correct / committed.length : null, correctAllScorable: scorable.length ? correct / scorable.length : null }, traceBytes, maxPacingLagMs: round(maxPacingLagMs), missionSuccess: null };
  writeFileSync(resolve(outputDir, 'commands.json'), JSON.stringify(plant.commands, null, 2), { flag: 'wx' });
  writeFileSync(resolve(outputDir, 'outcomes.json'), JSON.stringify(outcomes, null, 2), { flag: 'wx' });
  writeFileSync(resolve(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' }); return summary;
}
