import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { Command, Controller, Json, Observation, RobotDescription, Vec3 } from '../src/contracts.ts';

/** The model selects a key. Only application code supplies actuator arguments. */
export interface Candidate {
  id: string;
  description: string;
  command: Pick<Command, 'action' | 'args'> | null;
}
export interface ChoiceRequest {
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
}
export type ChoiceJudge = (request: ChoiceRequest, signal: AbortSignal) => Promise<ChoiceAnswer>;
export interface ChoiceOptions {
  judge: ChoiceJudge;
  candidates(observation: Observation, description: RobotDescription): Candidate[];
  requiredSensors?: string[] | ((description: RobotDescription) => string[]);
  instructions?: string;
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
function validAnswer(answer: ChoiceAnswer, candidates: readonly Candidate[]): boolean {
  const ids = candidates.map(candidate => candidate.id);
  const values = Object.values(answer.probabilities ?? {});
  return ids.includes(answer.choice) && Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1
    && Object.keys(answer.probabilities ?? {}).length === ids.length
    && ids.every(id => Object.hasOwn(answer.probabilities, id))
    && values.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.001;
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
      let iteration = 0;
      const emit = (kind: string, data: Record<string, unknown>) => options.record?.(kind, { robotId: port.robotId, ...data });
      try {
        const description = await port.describe();
        const required = typeof options.requiredSensors === 'function' ? options.requiredSensors(description) : options.requiredSensors ?? [];
        const ajv = new Ajv({ strict: false });
        const schemas = new Map(Object.entries(description.commands).map(([name, command]) => [name, ajv.compile(command.schema)]));
        const hold = async (): Promise<boolean> => {
          const command = options.holdCommand ?? { action: 'hold', args: {} };
          if (!schemas.get(command.action)?.(command.args)) { await port.stop(); return false; }
          const receipt = await port.command({ ...command, id: `jev-${runId}-${port.robotId}-hold-${++iteration}`, validForMs: lifetimeMs });
          emit('jev.hold', { receipt });
          return receipt.status !== 'rejected';
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
          if (pending) { await wait(intervalMs, runSignal); continue; }
          const observation = await port.observe();
          if (runSignal.aborted) break;
          if (!fresh(observation, required, maxAgeMs)) {
            emit('jev.skipped', { reason: 'stale-or-invalid-sensor', observation: observation.sequence });
            if (!await hold()) break;
            await wait(intervalMs, runSignal); continue;
          }
          const offered = candidates(observation);
          if (!offered.length) { if (!await hold()) break; await wait(intervalMs, runSignal); continue; }
          let selected: Candidate | undefined = offered.length === 1 ? offered[0] : undefined;
          if (!selected) {
            calls++;
            callAbort = new AbortController();
            const requestSignal = AbortSignal.any([runSignal, callAbort.signal]);
            const started = performance.now();
            const response = Promise.resolve().then(() => options.judge({ observation: structuredClone(observation), candidates: offered.map(({ id, description }) => ({ id, description })), instructions: options.instructions ?? 'Choose the offered action that best advances this robot\'s goal. Use hold when evidence is insufficient.' }, requestSignal));
            const outcome = response.then(answer => ({ kind: 'answer' as const, answer }), () => ({ kind: 'error' as const }));
            pending = outcome;
            void outcome.then(() => { pending = undefined; });
            const timeout = new AbortController();
            const result = await Promise.race([outcome, wait(deadlineMs, AbortSignal.any([runSignal, timeout.signal])).then(() => ({ kind: 'deadline' as const }))]);
            timeout.abort();
            const latencyMs = performance.now() - started;
            callAbort.abort();
            if (runSignal.aborted) break;
            if (result.kind !== 'answer' || latencyMs >= deadlineMs) {
              emit('jev.discarded', { reason: result.kind === 'error' ? 'request-error' : 'deadline', latencyMs, observation: observation.sequence });
            } else if (!validAnswer(result.answer, offered) || result.answer.confidence < minConfidence) {
              emit('jev.discarded', { reason: 'invalid-or-low-confidence-choice', latencyMs, observation: observation.sequence });
            } else {
              selected = offered.find(candidate => candidate.id === result.answer.choice);
              emit('jev.decision', { ...result.answer, latencyMs, observation: observation.sequence });
            }
          }
          if (!selected) { if (!await hold()) break; await wait(intervalMs, runSignal); continue; }
          const current = await port.observe();
          if (runSignal.aborted) break;
          // Re-check both observation age and the exact selected command against current legal choices.
          const retained = current.epoch === observation.epoch && current.simMs >= observation.simMs && current.simMs - observation.simMs <= maxAgeMs
            && fresh({ ...observation, simMs: current.simMs }, required, maxAgeMs)
            && fresh(current, required, maxAgeMs) && candidates(current).some(candidate => candidate.id === selected!.id && JSON.stringify(candidate.command) === JSON.stringify(selected!.command));
          if (!retained) {
            emit('jev.discarded', { reason: 'changed-or-stale-observation', observation: observation.sequence });
            if (!await hold()) break;
          } else if (!selected.command) {
            if (!await hold()) break;
          } else {
            const receipt = await port.command({ ...selected.command, id: `jev-${runId}-${port.robotId}-${++iteration}`, validForMs: lifetimeMs, basedOn: { observation: current.sequence, maxAgeMs } });
            emit('jev.command', { choice: selected.id, receipt });
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
  return async (input, signal) => {
    const body = JSON.stringify({ model: options.model ?? 'jev-latest', state: input.observation,
      questions: { action: { type: 'choice', instructions: input.instructions, criteria: Object.fromEntries(input.candidates.map(candidate => [candidate.id, candidate.description])) } } });
    if (Buffer.byteLength(body) > 65536) throw new Error('Jev request exceeds 64 KiB');
    const response = await request('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Jev HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Jev returned no response body');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 65536) throw new Error('Jev response exceeds 64 KiB');
      chunks.push(next.value);
    } } finally { await reader.cancel(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const answer = data?.answers?.action;
    if (answer?.type !== 'choice' || !validAnswer(answer, input.candidates.map(candidate => ({ ...candidate, command: null })))) throw new Error('Malformed Jev choice response');
    return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities,
      model: typeof data.model === 'string' ? data.model : undefined,
      inputTokens: Number.isSafeInteger(data.usage?.input_tokens) && data.usage.input_tokens >= 0 ? data.usage.input_tokens : undefined };
  };
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
