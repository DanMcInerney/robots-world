import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { Command, Controller, Json, Observation, RobotDescription, Vec3 } from '../src/contracts.ts';

/** The model selects a key. Only application code supplies actuator arguments. */
export interface Candidate {
  id: string;
  description: string;
  command: Pick<Command, 'action' | 'args'> | null;
}
export interface ChoiceRequest {
  decisionId?: string;
  observation: Observation;
  candidates: readonly Pick<Candidate, 'id' | 'description'>[];
  instructions: string;
}
export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  requestedModel?: string;
}
export type ChoiceJudge = ((request: ChoiceRequest, signal: AbortSignal) => Promise<ChoiceAnswer>) & { readonly requestedModel?: string };
export interface ChoiceOptions {
  judge: ChoiceJudge;
  candidates(observation: Observation, description: RobotDescription): Candidate[];
  requiredSensors?: string[] | ((description: RobotDescription) => string[]);
  instructions?: string;
  /** Trace metadata for an injected judge; the HTTP judge supplies its own value. */
  model?: string;
  deadlineMs?: number;
  intervalMs?: number;
  maxObservationAgeMs?: number;
  commandLifetimeMs?: number;
  /** Non-revoking fallback. Defaults to advertised hold({}); otherwise the run stops. */
  holdCommand?: Pick<Command, 'action' | 'args'>;
  minConfidence?: number;
  /** Total model calls across all robots in this run, including failed calls. */
  maxCalls?: number;
  maxDurationMs?: number;
  record?(kind: string, data: unknown): void;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  return value;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function fresh(observation: Observation, sensors: readonly string[], maxAgeMs: number): boolean {
  return !observation.fault && sensors.every(id => {
    const sample = observation.sensors[id];
    const age = sample && observation.simMs - sample.acquiredSimMs;
    return sample?.valid && age >= 0 && age <= maxAgeMs;
  });
}
function validAnswer(answer: ChoiceAnswer | null | undefined, candidates: readonly Candidate[]): boolean {
  if (!answer || !answer.probabilities || typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities)) return false;
  const ids = candidates.map(candidate => candidate.id);
  const values = Object.values(answer.probabilities ?? {});
  return ids.includes(answer.choice) && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1
    && Object.keys(answer.probabilities ?? {}).length === ids.length
    && ids.every(id => Object.hasOwn(answer.probabilities, id))
    && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.001;
}

class JevRequestError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) { super(message); this.name = 'JevRequestError'; this.code = code; this.status = status; }
}
/** Never serialize arbitrary thrown messages, response headers, or an SDK's request object. */
function errorTrace(error: unknown): { code: string; status?: number } {
  if (error instanceof JevRequestError) return { code: error.code, ...(error.status === undefined ? {} : { status: error.status }) };
  return { code: error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'request-error' };
}
function answerTrace(answer: ChoiceAnswer | null | undefined): Record<string, unknown> {
  if (!answer || typeof answer !== 'object') return { malformed: true };
  // Deliberately whitelist provider fields; extra SDK fields can contain credentials or reasoning.
  return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities,
    model: answer.model, requestedModel: answer.requestedModel, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
}
function observationRef(observation: Observation) {
  return { epoch: observation.epoch, observation: observation.sequence, observedSimMs: observation.simMs, deliveredWallMs: observation.wallMs,
    sensorTimes: Object.fromEntries(Object.entries(observation.sensors).map(([id, sample]) => [id, { sequence: sample.sequence, acquiredSimMs: sample.acquiredSimMs, receivedSimMs: sample.receivedSimMs, valid: sample.valid }])) };
}
const MAX_TRACE_BYTES = 65536;
/** Keep ordinary records readable and larger snapshots losslessly transportable through the cockpit. */
function trace(record: ChoiceOptions['record'], kind: string, data: Record<string, unknown>): void {
  if (!record) return;
  const encoded = JSON.stringify(data, (key, value) => {
    if (/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credentials?)$/i.test(key)) return '[redacted]';
    if (typeof value === 'string') return value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    return value;
  });
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= 8000) { record(kind, JSON.parse(encoded)); return; }
  const hash = createHash('sha256').update(encoded).digest('hex');
  if (bytes > MAX_TRACE_BYTES) {
    record(kind, { runId: data.runId, robotId: data.robotId, decisionId: data.decisionId, recordedWallMs: data.recordedWallMs,
      truncated: true, originalBytes: bytes, sha256: hash, reason: 'trace-record-limit' });
    return;
  }
  // Split on code points and account for JSON escaping, so each part fits the log transport.
  const parts: string[] = []; let part = '', partBytes = 2;
  for (const character of encoded) {
    const characterBytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (partBytes + characterBytes > 6000) { parts.push(part); part = ''; partBytes = 2; }
    part += character; partBytes += characterBytes;
  }
  if (part) parts.push(part);
  for (const [partIndex, json] of parts.entries()) record(`${kind}.part`, {
    runId: data.runId, robotId: data.robotId, decisionId: data.decisionId, recordedWallMs: data.recordedWallMs,
    encoding: 'json', partIndex, partCount: parts.length, originalBytes: bytes, sha256: hash, json,
  });
}

/** One in-flight judgement per robot; physics and acquisition stay in the host. */
export function createChoiceController(options: ChoiceOptions): Controller {
  const deadlineMs = positive(options.deadlineMs ?? 500, 'deadlineMs');
  const intervalMs = positive(options.intervalMs ?? 250, 'intervalMs');
  const maxAgeMs = positive(options.maxObservationAgeMs ?? 1000, 'maxObservationAgeMs');
  const lifetimeMs = positive(options.commandLifetimeMs ?? 1000, 'commandLifetimeMs');
  const maxCalls = positive(options.maxCalls ?? 100, 'maxCalls');
  const maxDurationMs = positive(options.maxDurationMs ?? 60000, 'maxDurationMs');
  const minConfidence = options.minConfidence ?? 0;
  if (!Number.isInteger(maxCalls) || maxCalls > 100000) throw new Error('maxCalls must be an integer from 1 to 100000');
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error('minConfidence must be from 0 to 1');
  return { id: 'jev-choice', async run(ports, signal) {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), maxDurationMs);
    const runSignal = AbortSignal.any([signal, budget.signal]);
    let calls = 0;
    const runId = randomUUID();
    try { await Promise.all(ports.map(async port => {
      let pending: Promise<unknown> | undefined;
      let callAbort: AbortController | undefined;
      let iteration = 0, decisionSequence = 0, acknowledged = 0, eventEpoch = '', pendingDecisionId = '';
      const commandDecisions = new Map<string, string>(), jobDecisions = new Map<string, string>();
      const remember = (map: Map<string, string>, key: string, value: string) => { map.set(key, value); if (map.size > 512) map.delete(map.keys().next().value!); };
      const emit = (kind: string, data: Record<string, unknown>) => trace(options.record, kind, { runId, robotId: port.robotId, recordedWallMs: Date.now(), ...data });
      const read = async (decisionId: string, phase: string): Promise<Observation> => {
        const observation = await port.observe();
        if (observation.epoch !== eventEpoch) { eventEpoch = observation.epoch; acknowledged = 0; }
        const events = observation.events.filter(event => event.id > acknowledged).sort((a, b) => a.id - b.id);
        for (const event of events) {
          const data = object(event.data);
          const origin = (typeof data.commandId === 'string' && commandDecisions.get(data.commandId))
            || (typeof data.jobId === 'string' && jobDecisions.get(data.jobId));
          emit('jev.execution-event', { decisionId: origin || decisionId, observedByDecisionId: decisionId, correlated: Boolean(origin), phase,
            epoch: observation.epoch, observation: observation.sequence, observedSimMs: observation.simMs, deliveredWallMs: observation.wallMs, event });
        }
        if (events.length && !runSignal.aborted) {
          const throughEvent = events.at(-1)!.id;
          // Radio messages remain pending: this controller has no generic packet-consumption policy.
          await port.acknowledge(throughEvent, []);
          acknowledged = throughEvent;
          emit('jev.events-acknowledged', { decisionId, epoch: observation.epoch, observation: observation.sequence, throughEvent, count: events.length, packetIds: [] });
        }
        return observation;
      };
      try {
        const description = await port.describe();
        const required = typeof options.requiredSensors === 'function' ? options.requiredSensors(description) : options.requiredSensors ?? [];
        const ajv = new Ajv({ strict: false });
        const schemas = new Map(Object.entries(description.commands).map(([name, command]) => [name, ajv.compile(command.schema)]));
        const execute = async (command: Command, decisionId: string, source: Observation, choice: string, purpose: string): Promise<boolean> => {
          const ref = observationRef(source);
          remember(commandDecisions, command.id, decisionId);
          emit('jev.command-submitted', { decisionId, ...ref, choice, purpose, command });
          if (runSignal.aborted) { emit('jev.discarded', { decisionId, ...ref, commandId: command.id, reason: 'cancelled-before-admission' }); return false; }
          let receipt;
          try { receipt = await port.command(command); } catch (error) {
            emit('jev.admission-error', { decisionId, ...ref, commandId: command.id, error: errorTrace(error), effect: 'uncertain-no-replay' });
            throw error;
          }
          if (receipt.jobId) remember(jobDecisions, receipt.jobId, decisionId);
          emit('jev.admission', { decisionId, ...ref, commandId: command.id, receipt });
          emit(purpose === 'hold' ? 'jev.hold' : 'jev.command', { decisionId, ...ref, choice, command, receipt });
          return receipt.status !== 'rejected';
        };
        const hold = async (decisionId: string, source: Observation): Promise<boolean> => {
          const command = options.holdCommand ?? { action: 'hold', args: {} };
          if (!schemas.get(command.action)?.(command.args)) {
            emit('jev.discarded', { decisionId, ...observationRef(source), reason: 'no-local-hold-command' });
            await port.stop(); return false;
          }
          return execute({ ...command, id: `jev-${runId}-${++iteration}`, validForMs: lifetimeMs }, decisionId, source, 'hold', 'hold');
        };
        const candidates = (observation: Observation): Candidate[] => {
          const items = structuredClone(options.candidates(structuredClone(observation), description));
          if (items.length > 255 || new Set(items.map(item => item.id)).size !== items.length) throw new Error('Candidates need unique IDs and a maximum of 255 choices');
          for (const item of items) {
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || !item.description || item.description.length > 1024) throw new Error('Invalid candidate ID or description');
            if (item.command && !schemas.get(item.command.action)?.(item.command.args)) throw new Error(`Candidate ${item.id} does not match advertised command schema`);
          }
          return items;
        };
        while (!runSignal.aborted && calls < maxCalls) {
          // A transport that ignores abort may still be working. Never accumulate replacements.
          if (pending) { await read(pendingDecisionId, 'waiting-for-discarded-request'); await wait(intervalMs, runSignal); continue; }
          const decisionId = `jev-${runId}-${port.robotId}-${++decisionSequence}`;
          const observation = await read(decisionId, 'input');
          if (runSignal.aborted) break;
          const ref = observationRef(observation);
          const instructions = options.instructions ?? 'Choose the offered action that best advances this robot\'s goal. Use hold when evidence is insufficient.';
          const requestedModel = options.judge.requestedModel ?? options.model;
          emit('jev.input', { decisionId, ...ref, requestedModel, snapshot: observation, instructions, requiredSensors: required });
          if (!fresh(observation, required, maxAgeMs)) {
            emit('jev.skipped', { decisionId, ...ref, reason: 'stale-or-invalid-sensor' });
            if (!await hold(decisionId, observation)) break;
            await wait(intervalMs, runSignal); continue;
          }
          const offered = candidates(observation);
          emit('jev.candidates', { decisionId, ...ref, candidates: offered });
          if (!offered.length) { if (!await hold(decisionId, observation)) break; await wait(intervalMs, runSignal); continue; }
          let selected: Candidate | undefined = offered.length === 1 ? offered[0] : undefined;
          if (selected) emit('jev.decision', { decisionId, ...ref, source: 'local-forced', choice: selected.id });
          if (!selected) {
            calls++;
            callAbort = new AbortController();
            const requestSignal = AbortSignal.any([runSignal, callAbort.signal]);
            const started = performance.now();
            emit('jev.request', { decisionId, ...ref, requestedModel, deadlineMs, call: calls });
            const response = Promise.resolve().then(() => { requestSignal.throwIfAborted(); return options.judge({ decisionId, observation: structuredClone(observation), candidates: offered.map(({ id, description }) => ({ id, description })), instructions }, requestSignal); });
            const outcome = response.then(answer => ({ kind: 'answer' as const, answer, latencyMs: performance.now() - started, finishedWallMs: Date.now() }), error => ({ kind: 'error' as const, error: errorTrace(error), latencyMs: performance.now() - started, finishedWallMs: Date.now() }));
            let discardedReason: string | undefined;
            const late = (result: Awaited<typeof outcome>, reason: string) => emit('jev.late-discarded', { decisionId, ...ref, reason,
              latencyMs: result.latencyMs, finishedWallMs: result.finishedWallMs, ...(result.kind === 'answer' ? { answer: answerTrace(result.answer) } : { error: result.error }) });
            pending = outcome; pendingDecisionId = decisionId;
            void outcome.then(result => {
              pending = undefined;
              // A late result may arrive after run() releases its lease. It can only emit a diagnostic.
              if (discardedReason) { try { late(result, discardedReason); } catch { /* A closed diagnostic sink cannot revive the controller. */ } }
            });
            const timeout = new AbortController();
            const result = await Promise.race([outcome, wait(deadlineMs, AbortSignal.any([runSignal, timeout.signal])).then(() => ({ kind: 'deadline' as const }))]);
            timeout.abort();
            const latencyMs = performance.now() - started;
            callAbort.abort();
            if (runSignal.aborted) {
              discardedReason = 'cancelled';
              emit('jev.discarded', { decisionId, ...ref, reason: discardedReason, latencyMs });
              if (result.kind !== 'deadline') late(result, discardedReason);
              break;
            }
            if (result.kind === 'deadline' || result.latencyMs >= deadlineMs) {
              discardedReason = 'deadline';
              emit('jev.discarded', { decisionId, ...ref, reason: discardedReason, latencyMs });
              if (result.kind !== 'deadline') late(result, discardedReason);
            } else if (result.kind === 'error') {
              emit('jev.request-error', { decisionId, ...ref, error: result.error, latencyMs: result.latencyMs, finishedWallMs: result.finishedWallMs });
              emit('jev.discarded', { decisionId, ...ref, reason: 'request-error', latencyMs });
            } else {
              emit('jev.answer', { decisionId, ...ref, answer: answerTrace(result.answer), latencyMs: result.latencyMs, finishedWallMs: result.finishedWallMs });
              if (!validAnswer(result.answer, offered) || result.answer.confidence < minConfidence) {
                emit('jev.discarded', { decisionId, ...ref, reason: 'invalid-or-low-confidence-choice', latencyMs });
              } else {
                selected = offered.find(candidate => candidate.id === result.answer.choice);
                emit('jev.decision', { decisionId, ...ref, ...answerTrace(result.answer), source: 'judge', latencyMs });
              }
            }
          }
          if (!selected) { if (!await hold(decisionId, observation)) break; await wait(intervalMs, runSignal); continue; }
          const current = await read(decisionId, 'revalidation');
          if (runSignal.aborted) break;
          emit('jev.revalidation', { decisionId, input: ref, current: observationRef(current) });
          // Re-check both observation age and the exact selected command against current legal choices.
          const retained = current.epoch === observation.epoch && current.simMs >= observation.simMs && current.simMs - observation.simMs <= maxAgeMs
            && fresh({ ...observation, simMs: current.simMs }, required, maxAgeMs)
            && fresh(current, required, maxAgeMs) && candidates(current).some(candidate => candidate.id === selected!.id && JSON.stringify(candidate.command) === JSON.stringify(selected!.command));
          if (!retained) {
            emit('jev.discarded', { decisionId, ...ref, reason: 'changed-or-stale-observation' });
            if (!await hold(decisionId, observation)) break;
          } else if (!selected.command) {
            if (!await hold(decisionId, observation)) break;
          } else {
            if (!await execute({ ...selected.command, id: `jev-${runId}-${++iteration}`, validForMs: lifetimeMs, basedOn: { observation: current.sequence, maxAgeMs } }, decisionId, observation, selected.id, 'policy')) break;
          }
          await wait(intervalMs, runSignal);
        }
      } finally {
        callAbort?.abort();
        try { await port.stop(); } finally { await port.close(); }
      }
    })); } finally { clearTimeout(timer); budget.abort(); }
  } };
}

/** Direct official HTTP API; no hidden retry can extend a control deadline. */
export function createJevJudge(options: { apiKey: string; model?: string; fetch?: typeof fetch }): ChoiceJudge {
  if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
  const request = options.fetch ?? fetch;
  const requestedModel = options.model ?? 'jev-latest';
  const judge: ChoiceJudge = async (input, signal) => {
    const body = JSON.stringify({ model: requestedModel, state: input.observation,
      questions: { action: { type: 'choice', instructions: input.instructions, criteria: Object.fromEntries(input.candidates.map(candidate => [candidate.id, candidate.description])) } } });
    if (Buffer.byteLength(body) > 65536) throw new JevRequestError('request-limit', 'Jev request exceeds 64 KiB');
    const response = await request('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new JevRequestError('http-error', `Jev HTTP ${response.status}`, response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new JevRequestError('empty-response', 'Jev returned no response body');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 65536) throw new JevRequestError('response-limit', 'Jev response exceeds 64 KiB');
      chunks.push(next.value);
    } } finally { await reader.cancel(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const answer = data?.answers?.action;
    if (answer?.type !== 'choice' || !validAnswer(answer, input.candidates.map(candidate => ({ ...candidate, command: null })))) throw new JevRequestError('malformed-response', 'Malformed Jev choice response');
    return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities,
      model: typeof data.model === 'string' ? data.model : undefined, requestedModel,
      inputTokens: Number.isSafeInteger(data.usage?.input_tokens) && data.usage.input_tokens >= 0 ? data.usage.input_tokens : undefined,
      outputTokens: Number.isSafeInteger(data.usage?.output_tokens) && data.usage.output_tokens >= 0 ? data.usage.output_tokens : undefined };
  };
  return Object.assign(judge, { requestedModel });
}

const object = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Small example palette. This proximity guard is not a path planner or collision guarantee. */
export function createDroneRouteCandidates(waypoints: readonly Vec3[], sensors: { odometryId?: string; lidarId?: string } = {}): (observation: Observation) => Candidate[] {
  if (!waypoints.length || waypoints.length > 32 || waypoints.some(point => ![point.x, point.y, point.z].every(Number.isFinite))) throw new Error('Supply 1–32 finite waypoints');
  const points = structuredClone(waypoints);
  return observation => {
    const hold: Candidate = { id: 'hold', description: 'Hold position and wait for more evidence.', command: null };
    const position = object(object(observation.sensors[sensors.odometryId ?? 'odometry']?.value).position);
    const ranges = object(observation.sensors[sensors.lidarId ?? 'lidar']?.value).distances;
    if (![position.x, position.y, position.z].every(value => typeof value === 'number' && Number.isFinite(value)) || !Array.isArray(ranges)) return [hold];
    const clearance = Math.min(...ranges.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
    if (clearance < 0.75) return [hold];
    return [hold, ...points.flatMap((point, index) => {
      const distance = Math.hypot(point.x - Number(position.x), point.y - Number(position.y), point.z - Number(position.z));
      return distance < 0.35 ? [] : [{ id: `waypoint_${index}`, description: `Visit mission waypoint ${index} at ENU ${JSON.stringify(point)}; observed distance ${distance.toFixed(2)} m.`, command: { action: 'goto', args: { ...point } } }];
    })];
  };
}

export function createJevController(options: { apiKey: string; model?: string; waypoints: Vec3[]; goal?: string; record?: ChoiceOptions['record']; maxCalls?: number; maxDurationMs?: number; deadlineMs?: number; intervalMs?: number }): Controller {
  const ids = (description: RobotDescription) => {
    const odometryId = description.sensors.find(sensor => sensor.type === 'odometry')?.id;
    const lidarId = description.sensors.find(sensor => sensor.type === 'lidar')?.id;
    if (!odometryId || !lidarId) throw new Error('Jev waypoint example requires odometry and lidar sensors');
    return { odometryId, lidarId };
  };
  return createChoiceController({ ...options, judge: createJevJudge(options),
    candidates: (observation, description) => createDroneRouteCandidates(options.waypoints, ids(description))(observation),
    requiredSensors: description => Object.values(ids(description)), instructions: options.goal });
}
