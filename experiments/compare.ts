import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { common } from 'node-mavlink';
import type { Command, Json, Observation, Receipt, RobotPort, Vec3 } from '../src/contracts.ts';
import { distance, norm, scale, sub, vec } from '../src/math.ts';
import { Journal } from '../src/recorder.ts';
import { World } from '../src/world.ts';
import { enuToNed, MavlinkAdapter, MavlinkCodec } from '../src/protocols/mavlink.ts';
import { createJevJudge, type Candidate, type ChoiceAnswer, type ChoiceJudge, type ChoiceRequest } from '../controllers/jev.ts';
import { createTrackingExperiment } from './tracking.ts';
import { versions } from './run.ts';
import type { ComparisonArm, ComparisonMetrics, ComparisonReport, ComparisonTrial, Distribution } from './comparison-contract.ts';
import { comparisonLabel } from './comparison-contract.ts';

export const arms: Record<ComparisonArm, string> = {
  'code-local': 'Local code', 'agent-direct': 'Agent · direct actions', 'agent-routine': 'Agent · local routine',
  'jev-local': 'Jev · local decisions', 'agent-jev': 'Agent · Jev routine',
};
export interface CompareOptions {
  seconds?: number; seeds?: number[]; arms?: ComparisonArm[];
  agentDelayMs?: number; jevDelayMs?: number; sensorLatencyMs?: number; sensorDropout?: number; occlusion?: boolean;
  /** Shared freshness policy across every arm, independent of assumed inference delays. */
  maxDecisionAgeMs?: number; maxSetpointAgeMs?: number;
  /** Network inference is never used without this explicit flag. */
  liveJev?: boolean; model?: string; apiKey?: string; maxCalls?: number;
  /** Injectable for offline transport qualification; called only in liveJev mode. */
  judge?: ChoiceJudge; signal?: AbortSignal;
}
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const object = (data: Json | undefined): Record<string, Json> => data && typeof data === 'object' && !Array.isArray(data) ? data : {};
const vector = (value: Json | undefined): Vec3 | undefined => {
  const v = object(value); return ['x','y','z'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k])) ? v as unknown as Vec3 : undefined;
};
export function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a,b) => a-b);
  const q = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length*fraction)-1)] : null;
  return { count: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) };
}
const fresh = (o: Observation, id: string, age = 600) => o.sensors[id]?.valid && o.simMs-o.sensors[id].acquiredSimMs >= 0 && o.simMs-o.sensors[id].acquiredSimMs <= age;
const compactObservation = (o: Observation): Observation => ({ ...o, jobs: o.jobs.filter(job => job.status === 'running') });

/** All arms get this same palette. Only installed sensor data enters it. */
export function trackingCandidates(o: Observation): Candidate[] {
  const hold: Candidate = { id: 'hold', description: 'Brake and hold for missing target or unsafe evidence.', command: { action: 'velocity', args: { x: 0, y: 0, z: 0 } } };
  const position = vector(object(o.sensors.odometry?.value).position);
  const target = object(o.sensors.target?.value);
  const relative = vector(target.relative), origin = vector(target.origin);
  if (!position || !relative || !origin || target.visible !== true || !fresh(o,'target') || !fresh(o,'odometry')) return [hold];
  // Tracking is deliberately simple: perception and semantic reasoning are not tested here.
  const destination = { x: origin.x+relative.x, y: origin.y+relative.y, z: origin.z+relative.z };
  const direction = sub(destination,position), d = norm(direction), standOff = Math.min(1.2,d);
  if (d > 0) { destination.x -= direction.x/d*standOff; destination.y -= direction.y/d*standOff; destination.z -= direction.z/d*standOff; }
  return [hold,
    { id: 'follow', description: `Approach observed target, keeping 1.2 m stand-off. Target relative ENU ${JSON.stringify(relative)}.`, command: { action: 'goto', args: destination } },
    { id: 'left', description: 'Sidestep 1 m north at current altitude if direct progress is obstructed.', command: { action: 'goto', args: { x: position.x, y: position.y+1, z: position.z } } },
    { id: 'right', description: 'Sidestep 1 m south at current altitude if direct progress is obstructed.', command: { action: 'goto', args: { x: position.x, y: position.y-1, z: position.z } } },
    { id: 'climb', description: 'Climb 1 m if lateral routes are obstructed and overhead space is observed clear.', command: { action: 'goto', args: { x: position.x, y: position.y, z: position.z+1 } } },
  ];
}
// Same teacher for every injected arm: isolates scheduling, never model intelligence.
const fixtureChoice = (candidates: Candidate[]) => candidates.find(c => c.id === 'follow') ?? candidates[0];
interface Pending {
  id: string; observation: Observation; candidates: Candidate[]; startedSimMs: number; startedMonoMs: number;
  due: number; ready?: { answer?: ChoiceAnswer; error?: string; arrivedMonoMs: number; arrivedWallMs: number }; abort?: AbortController; expired?: boolean;
}
const LIVE_DEADLINE_MS = 1200;
interface TrackingControllerOptions extends Required<Pick<CompareOptions,'agentDelayMs'|'jevDelayMs'|'maxDecisionAgeMs'|'maxSetpointAgeMs'>> {
  judge?: ChoiceJudge; maxCalls: number; model?: string; evidence: ComparisonTrial['evidence'];
}

/** Controller knows only RobotPort and the local clock carried by observations. */
class TrackingController {
  private port: RobotPort; private emit: (kind: string, data: unknown) => void;
  private arm: ComparisonArm;
  private options: TrackingControllerOptions;
  private pending?: Pending; private nextDecision = 0; private count = 0; private lastTick = -Infinity;
  private selected?: { command: Pick<Command,'action'|'args'>; choice: string; decisionId: string; acquiredSimMs: number };
  private descriptionReady = false; private closed = false; private maxCalls: number;
  readonly stats = { calls: 0, discarded: 0, commandCount: 0, held: true, lastAppliedSensorMs: -Infinity,
    latenciesSim: [] as number[], latenciesWall: [] as number[], activationDelaysWall: [] as number[], ages: [] as number[], inputTokens: 0, outputTokens: 0,
    tokenUsageComplete: true };
  constructor(port: RobotPort, arm: ComparisonArm, options: TrackingControllerOptions, emit: (kind: string,data: unknown)=>void) {
    this.port = port; this.emit = emit; this.arm=arm; this.options=options; this.maxCalls = options.maxCalls;
  }
  private async apply(command: Pick<Command,'action'|'args'>, observation: Observation, decisionId: string, acquiredSimMs: number | null, reason: string) {
    const id = `bench:${this.arm}:${++this.stats.commandCount}`;
    const request: Command = { ...command, id, validForMs: 1000, basedOn: { observation: observation.sequence, maxAgeMs: 600 } };
    this.emit('experiment.command', { decisionId, observation: observation.sequence, acquiredSimMs, sensorAgeMs: acquiredSimMs===null?null:observation.simMs-acquiredSimMs, reason, command: request });
    const receipt = await this.port.command(request);
    this.emit('experiment.admission', { decisionId, commandId: id, receipt });
    if (receipt.status === 'accepted' || receipt.status === 'completed') {
      if(acquiredSimMs!==null) { this.stats.ages.push(observation.simMs-acquiredSimMs); this.stats.lastAppliedSensorMs = acquiredSimMs; }
    }
  }
  async tick(simMs: number) {
    if (this.closed || simMs-this.lastTick < 99.999) return;
    this.lastTick = simMs;
    if (!this.descriptionReady) { await this.port.describe(); this.descriptionReady = true; }
    const observation = compactObservation(await this.port.observe());
    if (observation.events.length) {
      this.emit('experiment.execution', { observation: observation.sequence, events: observation.events, jobs: observation.jobs });
      await this.port.acknowledge(observation.events.at(-1)!.id, []);
    }
    const sensedTarget = object(observation.sensors.target?.value);
    const ranges = object(observation.sensors.lidar?.value).distances;
    const near = Array.isArray(ranges) && ranges.some(r => typeof r === 'number' && r < .7);
    const unsafe = !!observation.fault || !fresh(observation,'odometry') || !fresh(observation,'lidar') || !fresh(observation,'target') || sensedTarget.visible !== true || near;
    const initialization = (this.arm === 'agent-routine' || this.arm === 'agent-jev') && simMs < this.options.agentDelayMs;
    if (this.pending) {
      const p = this.pending;
      if (!p.ready && !p.abort && simMs+1e-6 >= p.due) {
        const chosen = fixtureChoice(p.candidates);
        p.ready = { answer: { choice: chosen.id, confidence: 1, probabilities: Object.fromEntries(p.candidates.map(c=>[c.id,c.id===chosen.id?1:0])) }, arrivedMonoMs: performance.now(), arrivedWallMs: Date.now() };
      }
      // A live transport is allowed one outstanding request. Abort does not prove it settled.
      const responseLatency = p.ready ? p.ready.arrivedMonoMs-p.startedMonoMs : undefined;
      if (p.abort && (responseLatency ?? performance.now()-p.startedMonoMs) >= LIVE_DEADLINE_MS && !p.expired) {
        p.expired = true; p.abort.abort(); this.stats.discarded++; this.selected = undefined;
        this.emit('experiment.discarded', { decisionId: p.id, reason: 'live-deadline', deadlineMs: LIVE_DEADLINE_MS,
          elapsedWallMs: performance.now()-p.startedMonoMs, responseLatencyWallMs: responseLatency ?? null });
      }
      if (p.ready) {
        const simLatency = simMs-p.startedSimMs, activatedMonoMs = performance.now(), wallLatency = p.ready.arrivedMonoMs-p.startedMonoMs;
        const activationDelayWallMs = activatedMonoMs-p.ready.arrivedMonoMs;
        this.stats.latenciesSim.push(simLatency);
        if (p.abort) { this.stats.latenciesWall.push(wallLatency); this.stats.activationDelaysWall.push(activationDelayWallMs); }
        this.emit('experiment.decision.complete', { decisionId: p.id, simulatedDelayMs: p.abort ? null : simLatency,
          elapsedWallMs: p.abort ? wallLatency : null, arrivedWallMs: p.abort ? p.ready.arrivedWallMs : null, activatedWallMs: Date.now(),
          activationDelayWallMs: p.abort ? activationDelayWallMs : null, deadlineOverrunWallMs: p.abort ? Math.max(0,wallLatency-LIVE_DEADLINE_MS) : null,
          answer: p.ready.answer ?? null, error: p.ready.error ?? null });
        const answer = p.ready.answer, candidate = p.candidates.find(c=>c.id===answer?.choice);
        const acquired = p.observation.sensors.target?.acquiredSimMs ?? p.observation.simMs;
        if (answer && p.abort) {
          this.stats.inputTokens += answer.inputTokens ?? 0; this.stats.outputTokens += answer.outputTokens ?? 0;
          if (answer.inputTokens === undefined || answer.outputTokens === undefined) this.stats.tokenUsageComplete = false;
        }
        if (p.abort && !answer) this.stats.tokenUsageComplete = false;
        if (!p.expired && candidate?.command && Number.isFinite(answer?.confidence) && !unsafe && observation.epoch === p.observation.epoch && simMs-acquired <= this.options.maxDecisionAgeMs) {
          this.selected = { command: candidate.command, choice: candidate.id, decisionId: p.id, acquiredSimMs: acquired };
          this.emit('experiment.decision.selected', { decisionId: p.id, choice: candidate.id, acquiredSimMs: acquired });
        } else if (!p.expired) { this.stats.discarded++; this.selected = undefined; this.emit('experiment.discarded', { decisionId: p.id, reason: p.ready.error ?? 'invalid-stale-or-currently-unsafe' }); }
        this.pending = undefined; this.nextDecision = simMs+100;
      }
    }
    if (unsafe) this.selected = undefined;
    const modelArm = this.arm === 'agent-direct' || this.arm === 'jev-local' || this.arm === 'agent-jev';
    if (!unsafe && !initialization && !this.pending && simMs+1e-6 >= this.nextDecision && (!modelArm || this.stats.calls < this.maxCalls)) {
      const candidates = trackingCandidates(observation);
      const id = `decision:${this.arm}:${++this.count}`;
      if (!modelArm) {
        const choice = fixtureChoice(candidates);
        if (simMs-observation.sensors.target.acquiredSimMs <= this.options.maxDecisionAgeMs) {
          this.selected = { command: choice.command!, choice: choice.id, decisionId: id, acquiredSimMs: observation.sensors.target.acquiredSimMs };
        } else {
          this.selected = undefined; this.stats.discarded++;
          this.emit('experiment.discarded', {decisionId:id,reason:'decision-observation-age',maxDecisionAgeMs:this.options.maxDecisionAgeMs});
        }
        this.emit('experiment.local.decision', { decisionId: id, observation: observation.sequence, sensor: observation.sensors.target, choice: choice.id });
        this.nextDecision = simMs+100;
      } else {
        this.stats.calls++;
        const judge = this.arm === 'agent-direct' ? undefined : this.options.judge;
        const delay = this.arm === 'agent-direct' ? this.options.agentDelayMs : this.options.jevDelayMs;
        const p: Pending = { id, observation, candidates, startedSimMs: simMs, startedMonoMs: performance.now(), due: simMs+delay };
        this.pending = p;
        const request: ChoiceRequest = { decisionId: id, observation, candidates: candidates.map(({id,description})=>({id,description})), instructions: 'Track the observed target with 1.2 m stand-off. Select follow when visible and unobstructed. Hold for inadequate evidence. Other moves require relevant sensor evidence.' };
        this.emit('experiment.decision.start', { decisionId: id, evidence: this.options.evidence, requestedModel: judge ? this.options.model : null, injectedDelayMs: judge ? null : delay, request });
        if (judge) {
          p.abort = new AbortController();
          void Promise.resolve().then(()=>judge(request,p.abort!.signal)).then(answer=>{ p.ready={answer,arrivedMonoMs:performance.now(),arrivedWallMs:Date.now()}; },error=>{ p.ready={error:String(error),arrivedMonoMs:performance.now(),arrivedWallMs:Date.now()}; });
        }
      }
    }
    if (this.selected && simMs-this.selected.acquiredSimMs > this.options.maxSetpointAgeMs) this.selected = undefined;
    const fallback = unsafe || initialization || !this.selected;
    this.stats.held = fallback || this.selected?.choice === 'hold';
    // Setpoints keep streaming during inference; the simulated MAVLink watchdog is not a model timer.
    await this.apply(fallback ? {action:'velocity',args:{x:0,y:0,z:0}} : this.selected!.command, observation,
      fallback ? 'reflex' : this.selected!.decisionId, fallback ? (observation.sensors.target?.sequence > 0 ? observation.sensors.target.acquiredSimMs : null) : this.selected!.acquiredSimMs,
      unsafe ? 'required-sensing-or-clearance' : initialization ? 'routine-startup' : fallback ? 'no-valid-decision' : this.selected!.choice === 'hold' ? 'selected-hold' : 'active-local-setpoint');
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.pending?.abort?.abort();
    if (this.pending) {
      if (this.pending.abort) this.stats.tokenUsageComplete = false;
      this.emit('experiment.decision.cancelled', {decisionId:this.pending.id,reason:'trial-ended'});
    }
    this.selected = undefined;
  }
}

/** The viewer baseline uses the same port-only local controller as the comparison. */
export function createTrackingBaseline(port: RobotPort, record: (kind: string,data: unknown)=>void = () => {}): { tick(simMs: number): Promise<void>; close(): void } {
  return new TrackingController(port,'code-local',{agentDelayMs:0,jevDelayMs:0,maxDecisionAgeMs:6000,maxSetpointAgeMs:12000,maxCalls:120,evidence:'injected'},record);
}

async function runComparisonTrial(arm: ComparisonArm, seed: number, options: CompareOptions): Promise<ComparisonTrial> {
  const seconds = options.seconds ?? 28;
  const setup = createTrackingExperiment({ seed, sensorLatencyMs: options.sensorLatencyMs, sensorDropout: options.sensorDropout, occlusion: options.occlusion });
  const journal = new Journal(30000);
  const world = await World.create(setup.scenario,setup.registry,'rapier',journal);
  const physical = world.claim('drone',`comparison:${arm}`);
  const live = !!options.liveJev && (arm === 'jev-local' || arm === 'agent-jev');
  const evidence = live && !options.judge ? 'live-jev' as const : 'injected' as const;
  const id = `${arm}-seed-${seed}`;
  const emit = (kind: string,data: unknown) => journal.record({simMs:world.simMs,robotId:'drone',channel:'control',kind,data:{trialId:id,...data as object}});
  let context: Command | undefined;
  const received: { receipt?: Receipt } = {};
  const wire = new MavlinkAdapter({ports:[{port:{...physical,command:async command=>{
    // The wire carries no observation provenance. It remains local admission metadata.
    const receipt = await physical.command({...command,basedOn:context?.basedOn}); received.receipt=receipt;
    emit('experiment.wire.binding',{commandId:context?.id,wireCommandId:command.id,receipt}); return receipt;
  }},systemId:1}],record:journal.record,simMs:()=>world.simMs});
  const codec = new MavlinkCodec();
  const port: RobotPort = {...physical,command:async command=>{
    context=command; received.receipt=undefined;
    const message=new common.SetPositionTargetLocalNed();
    const xyz=enuToNed(command.args as unknown as Vec3);
    Object.assign(message,{targetSystem:1,targetComponent:1,coordinateFrame:1,timeBootMs:Math.round(world.simMs),typeMask:command.action==='goto'?3576:3527,
      ...(command.action==='goto'?xyz:{vx:xyz.x,vy:xyz.y,vz:xyz.z})});
    await wire.receive(codec.encode(message)); context=undefined;
    const receipt = received.receipt as Receipt | undefined;
    if (!receipt) throw new Error('MAVLink setpoint did not reach admission');
    return {...receipt,id:command.id};
  }};
  const controller = new TrackingController(port,arm,{agentDelayMs:options.agentDelayMs??5000,jevDelayMs:options.jevDelayMs??150,
    maxDecisionAgeMs:options.maxDecisionAgeMs??6000,maxSetpointAgeMs:options.maxSetpointAgeMs??12000,evidence,
    judge:live ? options.judge ?? createJevJudge({apiKey:options.apiKey!,model:options.model}) : undefined,maxCalls:options.maxCalls??120,model:options.model},emit);
  const series: ComparisonTrial['series'] = [], events = setup.events.filter(e=>e.simMs < seconds*1000).map(e=>({...e,reactionMs:null as number|null}));
  const beforeEventVelocity = new Map<string,Vec3>();
  let previousVelocity=vec(), sumSquared=0, within=0, holdMs=0, collisions=0, lastContacts=new Set<string>();
  const started = performance.now();
  try {
    emit('experiment.started',{arm,seed,evidence,transport:'MAVLink v2 in-process encoded/CRC-parsed frames'});
    for (let tick=0; tick<Math.round(seconds/setup.scenario.dt);tick++) {
      options.signal?.throwIfAborted();
      if (live) await sleep(Math.max(0,started+world.simMs-performance.now()),undefined,{signal:options.signal});
      await controller.tick(world.simMs);
      if(tick%5===0) await wire.telemetry();
      setup.update(world); await world.advance();
      const body=world.physics.body('drone/base'), target=setup.target(world.simMs), errorM=distance(body.pose.position,target);
      sumSquared += errorM*errorM; if (errorM<=2.5) within++; if(controller.stats.held) holdMs+=setup.scenario.dt*1000;
      const contacts = new Set(world.physics.contacts().filter(c=>c.a!=='ground'&&c.b!=='ground').map(c=>[c.a,c.b].sort().join('|')));
      for(const key of contacts) if(!lastContacts.has(key)) collisions++; lastContacts=contacts;
      for(const event of events) {
        if(world.simMs>=event.simMs && !beforeEventVelocity.has(event.id)) { beforeEventVelocity.set(event.id,previousVelocity); emit('experiment.disturbance',{event}); }
        if(world.simMs<event.simMs || event.reactionMs!==null) continue;
        let responded=false;
        if(event.kind==='occlusion-start') responded=controller.stats.held&&norm(body.linearVelocity)<.1;
        else if(event.kind==='occlusion-end') responded=!controller.stats.held&&controller.stats.lastAppliedSensorMs>=event.simMs&&norm(body.linearVelocity)>.1;
        else {
          const change=sub(sub(setup.target(event.simMs+100),setup.target(event.simMs)),sub(setup.target(event.simMs),setup.target(event.simMs-100)));
          const delta=sub(body.linearVelocity,beforeEventVelocity.get(event.id)!);
          responded=controller.stats.lastAppliedSensorMs>=event.simMs && norm(change)>0 && (delta.x*change.x+delta.y*change.y+delta.z*change.z)/norm(change)>.15;
        }
        if(responded) {event.reactionMs=world.simMs-event.simMs;emit('experiment.response',{event,velocity:body.linearVelocity,criterion:'fresh-post-event-command-and-velocity-change; occlusion uses hold/resume'});}
      }
      previousVelocity=body.linearVelocity;
      if(tick%5===0) series.push({simMs:world.simMs,robot:body.pose.position,target,errorM,speedMps:norm(body.linearVelocity),held:controller.stats.held});
    }
    controller.close(); await physical.stop();
    const trace=journal.after(), stats=controller.stats, count=Math.round(seconds/setup.scenario.dt);
    const metrics: ComparisonMetrics={trackingRmseM:Math.sqrt(sumSquared/count),withinRadiusPct:within/count*100,collisionStarts:collisions,holdMs,
      calls:stats.calls,appliedCommands:trace.filter(e=>e.kind==='command.applied').length,rejectedCommands:trace.filter(e=>e.kind==='command.rejected').length,discardedDecisions:stats.discarded,
      decisionLatencySimMs:distribution(stats.latenciesSim),decisionLatencyWallMs:distribution(stats.latenciesWall),decisionActivationDelayWallMs:distribution(stats.activationDelaysWall),sensorAgeAtCommandMs:distribution(stats.ages),
      eventReactionMs:distribution(events.flatMap(e=>e.reactionMs===null?[]:[e.reactionMs])),inputTokens:live?(stats.tokenUsageComplete?stats.inputTokens:null):0,
      outputTokens:live?(stats.tokenUsageComplete?stats.outputTokens:null):0,costUsd:live?null:0};
    return {id,arm,label:comparisonLabel({arm,evidence}),seed,evidence,configuration:{scenario:setup.scenario,seconds,agentDelayMs:options.agentDelayMs??5000,jevDelayMs:options.jevDelayMs??150,
      maxDecisionAgeMs:options.maxDecisionAgeMs??6000,maxSetpointAgeMs:options.maxSetpointAgeMs??12000,liveDeadlineMs:LIVE_DEADLINE_MS,
      model:live?options.model:null,transport:'MAVLink-v2-memory',pacing:live?'monotonic-wall-paced':'fast-forward',actualElapsedWallMs:performance.now()-started,maxCalls:options.maxCalls??120},
      metrics,events,series,trace,traceCoverage:{total:journal.cursor,retained:trace.length,dropped:journal.cursor-trace.length,truncated:trace.filter(e=>e.truncated).length},
      finalStateHash:hash(world.physics.bodies().map(({id,pose,linearVelocity})=>({id,pose,linearVelocity})))};
  } finally {controller.close(); wire.close(); world.close();}
}

export async function runComparison(options: CompareOptions = {}): Promise<ComparisonReport> {
  const seconds=options.seconds??28, seeds=options.seeds??[11,29,47], selected=options.arms??Object.keys(arms) as ComparisonArm[];
  if(!Number.isFinite(seconds)||seconds<1||seconds>60) throw new Error('seconds must be 1–60');
  if(!seeds.length||seeds.length>8||new Set(seeds).size!==seeds.length||seeds.some(s=>!Number.isSafeInteger(s))) throw new Error('Supply 1–8 unique integer seeds');
  if(!selected.length||selected.length>5||new Set(selected).size!==selected.length||selected.some(a=>!Object.hasOwn(arms,a))) throw new Error('Invalid comparison arms');
  if(seconds*seeds.length*selected.length>900) throw new Error('Comparison exceeds 900 simulated seconds per artifact; split large sweeps into separate reports');
  for(const [key,value,max] of [['agentDelayMs',options.agentDelayMs??5000,15000],['jevDelayMs',options.jevDelayMs??150,5000],['sensorLatencyMs',options.sensorLatencyMs??0,5000],['maxDecisionAgeMs',options.maxDecisionAgeMs??6000,60000],['maxSetpointAgeMs',options.maxSetpointAgeMs??12000,60000]] as const)
    if(!Number.isFinite(value)||value<0||value>max) throw new Error(`${key} must be 0–${max}`);
  if(options.liveJev&&!options.judge&&(!options.apiKey||!options.model)) throw new Error('Live mode needs TYPESAFE_API_KEY and explicit JEV_MODEL; no automatic inference');
  const calls=options.maxCalls??120; if(!Number.isInteger(calls)||calls<1||calls>300) throw new Error('maxCalls must be 1–300 per trial');
  const config={seconds,seeds,arms:selected,agentDelayMs:options.agentDelayMs??5000,jevDelayMs:options.jevDelayMs??150,sensorLatencyMs:options.sensorLatencyMs??0,sensorDropout:options.sensorDropout??0,occlusion:options.occlusion??true,liveJev:!!options.liveJev,model:options.model??null,maxCalls:calls,
    maxDecisionAgeMs:options.maxDecisionAgeMs??6000,maxSetpointAgeMs:options.maxSetpointAgeMs??12000,liveDeadlineMs:LIVE_DEADLINE_MS};
  const trials: ComparisonTrial[]=[];
  for(const seed of seeds) for(const arm of selected) trials.push(await runComparisonTrial(arm,seed,{...options,seconds}));
  return {schemaVersion:1,kind:'controller-comparison',id:hash(config).slice(0,16),createdAt:new Date().toISOString(),evidence:trials.some(t=>t.evidence==='live-jev')?'mixed':'injected',configuration:config,versions:await versions(),
    limitations:[
      'Injected arms share one deterministic decision rule. Delays are assumptions, not measured Jev or Codex performance. No native agent or Nervelet Bridge runs in these scheduling fixtures.',
      'DroneRTS-inspired semantics, not a gameplay replica: direct actions remain asynchronous; routine baselines keep their local loop. Agent routine startup is injected, not measured.',
      'Target tracker is ideal processed ENU sensing with range/occlusion and an ideal fused sensor origin from the same acquisition. No RGB recognition, flight dynamics fidelity, PX4/ArduPilot, UDP transport, or real hardware is qualified.',
      'Every arm uses the same configured decision/setpoint age limits. Live wall latency ends when the request settles; controller polling/activation delay is reported separately.',
      'MAVLink v2 frames are actually encoded and CRC parsed in memory. Setpoints stream at 10 Hz independently of model decisions. Local admission provenance is not a MAVLink acknowledgement.',
      'Event reaction is an operational velocity-change/hold criterion after fresh evidence. Missing reactions are censored, shown as null, and excluded from latency quantiles; inspect event counts.',
      'Three seeds are a smoke comparison, not a statistically powered study. Model output correctness and native tool/session overhead need separate live trials.',
    ],trials};
}

/** Full traces are separate from the compact viewer manifest; publish the manifest last. */
export async function saveComparison(report: ComparisonReport, output: string): Promise<void> {
  await mkdir(dirname(output),{recursive:true});
  const folder = `traces/${report.id}-${report.createdAt.replaceAll(/[^0-9]/g,'')}`;
  await mkdir(resolve(dirname(output),folder),{recursive:true});
  const trials: ComparisonTrial[] = [];
  for(const trial of report.trials) {
    const traceArtifact = `${folder}/${trial.id}.trace.json`;
    await writeFile(resolve(dirname(output),traceArtifact),JSON.stringify(trial.trace));
    trials.push({...trial,trace:trial.trace.slice(-80),traceArtifact,traceCoverage:{...trial.traceCoverage,preview:Math.min(80,trial.trace.length)}});
  }
  await writeFile(`${output}.tmp`,JSON.stringify({...report,trials}));await rename(`${output}.tmp`,output);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), values=new Map<string,string>(); let live=false;
  if(args.includes('--help')) {console.log('npm run compare -- [--seconds 28] [--seeds 11,29,47] [--arms code-local,agent-direct,agent-routine,jev-local,agent-jev] [--agent-delay-ms 5000] [--jev-delay-ms 150] [--sensor-latency-ms 0] [--sensor-dropout 0] [--max-decision-age-ms 6000] [--max-setpoint-age-ms 12000] [--occlusion true|false] [--output path]\nOptional paid HTTP calls: --live-jev --arms jev-local --seeds 11 --max-calls 30; requires TYPESAFE_API_KEY and JEV_MODEL. Native agent turns are not launched by this command.');process.exit(0);}
  for(let i=0;i<args.length;i++){if(args[i]==='--live-jev'){live=true;continue;}if(!['--seconds','--seeds','--arms','--agent-delay-ms','--jev-delay-ms','--sensor-latency-ms','--sensor-dropout','--max-decision-age-ms','--max-setpoint-age-ms','--occlusion','--output','--max-calls'].includes(args[i])||args[i+1]===undefined)throw new Error(`Unknown/incomplete option ${args[i]}`);values.set(args[i],args[++i]);}
  const numeric=(key:string)=>values.has(key)?Number(values.get(key)):undefined;
  if(values.has('--occlusion')&&!['true','false'].includes(values.get('--occlusion')!))throw new Error('--occlusion must be true or false');
  const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
  const report=await runComparison({seconds:numeric('--seconds'),seeds:values.get('--seeds')?.split(',').map(Number),arms:values.get('--arms')?.split(',') as ComparisonArm[]|undefined,
    agentDelayMs:numeric('--agent-delay-ms'),jevDelayMs:numeric('--jev-delay-ms'),sensorLatencyMs:numeric('--sensor-latency-ms'),sensorDropout:numeric('--sensor-dropout'),occlusion:values.has('--occlusion')?values.get('--occlusion')==='true':undefined,
    maxDecisionAgeMs:numeric('--max-decision-age-ms'),maxSetpointAgeMs:numeric('--max-setpoint-age-ms'),
    liveJev:live,apiKey:live?process.env.TYPESAFE_API_KEY:undefined,model:live?process.env.JEV_MODEL:undefined,maxCalls:numeric('--max-calls'),signal:stop.signal});
  const output=resolve(values.get('--output')??'.runtime/experiments/comparison.json');await saveComparison(report,output);
  console.table(report.trials.map(t=>({arm:t.arm,seed:t.seed,evidence:t.evidence,rmseM:t.metrics.trackingRmseM.toFixed(2),withinPct:t.metrics.withinRadiusPct.toFixed(1),calls:t.metrics.calls,collisions:t.metrics.collisionStarts,eventReactions:t.events.filter(e=>e.reactionMs!==null).length,events:t.events.length})));
  console.log(`Saved ${output}\n${report.evidence === 'mixed' ? 'LIVE JEV responses are measured; any simulated agent arms remain injected fixtures. No native agent inference was launched.' : 'No live model calls. Simulated selectors measure scheduling, not model performance.'}`);
}
