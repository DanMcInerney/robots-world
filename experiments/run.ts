import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultRegistry } from '../src/defaults.ts';
import { distance } from '../src/math.ts';
import { Journal } from '../src/recorder.ts';
import { World } from '../src/world.ts';
import { scenario as createScenario } from '../scenarios/index.ts';
import { DemoPolicy } from './policy.ts';

export interface TrialOptions {
  scenario?: string; physics?: string; seconds?: number; seed?: number;
  loss?: number; latencyMs?: number; controllerDelayMs?: number;
}
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function versions() {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  let revision = 'uncommitted';
  let dirty = true;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], windowsHide: true }).trim(); } catch { /* A fresh local workspace may not have a commit yet. */ }
  try { dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], windowsHide: true }).trim(); } catch { /* No repository yet. */ }
  const source = createHash('sha256');
  for (const directory of ['src', 'experiments', 'scenarios', 'controllers', 'integrations']) {
    const paths = (await readdir(resolve(projectRoot, directory), { recursive: true })).filter(path => path.endsWith('.ts')).sort();
    for (const path of paths) { source.update(`${directory}/${path.replaceAll('\\','/')}\n`); source.update(await readFile(resolve(projectRoot, directory, path))); }
  }
  const dependencies = Object.fromEntries(['@dimforge/rapier3d-compat', 'node-mavlink', 'three'].map(name => [name, lock.packages?.[`node_modules/${name}`]?.version ?? 'unknown']));
  return { revision, dirty, sourceHash: source.digest('hex'), node: process.version, platform: process.platform, dependencies };
}

/** Headless evaluation may inspect truth; the DemoPolicy receives only its own RobotPort. */
export async function runTrial(options: TrialOptions = {}) {
  const seconds = options.seconds ?? 20;
  if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 120) throw new Error('seconds must be 0.2–120');
  const scenario = createScenario(options.scenario ?? 'single');
  scenario.seed = options.seed ?? scenario.seed;
  for (const robot of scenario.robots) {
    robot.radio = { ...robot.radio, ...(options.loss === undefined ? {} : { loss: options.loss }), ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }) };
  }
  const physics = options.physics ?? 'rapier';
  const configuration = { scenario, physics, seconds, policy: { id: 'demo-port-policy-v1', controllerDelayMs: options.controllerDelayMs ?? 0 } };
  const journal = new Journal(100000);
  const world = await World.create(scenario, defaultRegistry(), physics, journal);
  const policies = world.robotIds.map((id, index) => new DemoPolicy(world.claim(id, `experiment-${index}`), {
    index, swarm: scenario.id === 'swarm', leaderId: scenario.robots[0].id, decisionDelayMs: options.controllerDelayMs ?? 0,
  }));
  const initial = world.inspect().bodies;
  const travel = new Map(initial.map(body => [body.id, 0]));
  const previous = new Map(initial.map(body => [body.id, body.pose.position]));
  let collisionStarts = 0;
  let contactsBefore = new Set<string>();
  const started = performance.now();
  try {
    // Advance one physical world; independently tick each controller at about 20 Hz.
    // Decision cadence and simulated inference delay live inside each policy, never in physics.
    const pollTicks = Math.max(1, Math.round(0.05/scenario.dt));
    const ticks = Math.ceil(seconds/scenario.dt);
    for (let tick = 0; tick < ticks; tick++) {
      if (tick % pollTicks === 0) await Promise.all(policies.map(policy => policy.tick()));
      await world.advance();
      for (const body of world.physics.bodies()) {
        travel.set(body.id, (travel.get(body.id) ?? 0)+distance(previous.get(body.id)!, body.pose.position));
        previous.set(body.id, body.pose.position);
      }
      const contacts = new Set(world.physics.contacts().filter(contact => contact.a !== 'ground' && contact.b !== 'ground').map(contact => [contact.a, contact.b].sort().join('|')));
      for (const contact of contacts) if (!contactsBefore.has(contact)) collisionStarts++;
      contactsBefore = contacts;
    }
    const final = world.inspect();
    const raw = journal.after();
    const trace = raw.filter(event => event.channel !== 'sensor' || event.kind === 'delivered' || event.kind === 'dropped' || event.kind === 'error');
    const robots = final.robots.map((robot, index) => {
      const start = initial.find(body => body.id === `${robot.id}/base`) ?? initial.find(body => body.id.startsWith(`${robot.id}/`))!;
      const end = final.bodies.find(body => body.id === start.id)!;
      return { id: robot.id, model: robot.model, displacementM: distance(start.pose.position, end.pose.position), pathLengthM: travel.get(start.id),
        endPosition: end.pose.position, jobs: Object.fromEntries(['running','completed','expired','cancelled'].map(status => [status, robot.jobs.filter(job => job.status === status).length])),
        fault: robot.fault ?? null, controller: { ...policies[index].stats } };
    });
    assert.ok(final.bodies.every(body => Object.values(body.pose.position).every(Number.isFinite)), 'all physical positions must remain finite');
    assert.ok(robots.every(robot => !robot.fault), 'no hidden runtime backpressure fault');
    return {
      configuration, configurationHash: hash(configuration), versions: await versions(), seed: scenario.seed,
      simMs: world.simMs, computeWallMs: performance.now()-started,
      metrics: { robots, collisionStartsExcludingGround: collisionStarts, radio: world.radio.stats(),
        appliedCommands: trace.filter(event => event.kind === 'command.applied').length,
        rejectedCommands: trace.filter(event => event.kind === 'command.rejected').length },
      finalStateHash: hash(final.bodies.map(({ id, pose, linearVelocity, angularVelocity }) => ({ id, pose, linearVelocity, angularVelocity }))),
      trace, traceCoverage: { journalCapacity: journal.capacity, journalEvents: journal.cursor, retainedJournalEvents: raw.length,
        droppedJournalEvents: Math.max(0, journal.cursor-raw.length), retainedTraceEvents: trace.length },
    };
  } finally { world.close(); }
}

export async function runMatrix() {
  const trials: (TrialOptions & { label: string })[] = [
    { label: 'portable-kinematic', scenario: 'portable', physics: 'kinematic' },
    { label: 'portable-rapier', scenario: 'portable', physics: 'rapier' },
    { label: 'single-baseline', scenario: 'single' },
    { label: 'mixed-articulations', scenario: 'mixed' },
    { label: 'swarm-connected', scenario: 'swarm', loss: 0 },
    { label: 'swarm-total-loss', scenario: 'swarm', loss: 1 },
    { label: 'swarm-expired-packets', scenario: 'swarm', latencyMs: 3000 },
    { label: 'single-stale-inference', scenario: 'single', controllerDelayMs: 1500 },
  ];
  const results = [];
  for (const trial of trials) {
    const result = await runTrial({ ...trial, seconds: 8, seed: 42 });
    assert.ok(result.metrics.appliedCommands > 0, `${trial.label}: commands reach the plant`);
    if (trial.label.includes('portable') || trial.label === 'single-baseline') assert.ok(result.metrics.robots[0].pathLengthM! > 1, `${trial.label}: mobile controller makes progress`);
    if (trial.label === 'swarm-connected') assert.ok(result.metrics.radio.delivered > 0 && result.metrics.robots.slice(1).every(robot => robot.controller.receivedBeacons > 0), 'all followers actually receive radio beacons');
    if (trial.label === 'swarm-total-loss' || trial.label === 'swarm-expired-packets') {
      assert.equal(result.metrics.radio.delivered, 0, 'undelivered beacon never becomes peer knowledge');
      assert.ok(result.metrics.robots.slice(1).every(robot => robot.controller.receivedBeacons === 0 && robot.displacementM < 0.1), 'followers hold when no valid beacon arrives');
    }
    if (trial.label === 'single-stale-inference') assert.ok(result.metrics.rejectedCommands > 0 && result.metrics.robots[0].displacementM < 0.1, 'late decisions reject while world remains active');
    results.push({ label: trial.label, ...result });
  }
  return { passed: results.length, results };
}

function parseArguments(args: string[]) {
  const values = new Map<string, string>();
  let matrix = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--matrix') { matrix = true; continue; }
    if (!['--scenario','--physics','--seconds','--seed','--output','--loss','--latency-ms','--controller-delay-ms'].includes(key) || args[index+1] === undefined) throw new Error(`unknown or incomplete option: ${key}`);
    values.set(key, args[++index]);
  }
  const numeric = (key: string) => values.has(key) ? Number(values.get(key)) : undefined;
  const options: TrialOptions = { scenario: values.get('--scenario'), physics: values.get('--physics'), seconds: numeric('--seconds'), seed: numeric('--seed'), loss: numeric('--loss'), latencyMs: numeric('--latency-ms'), controllerDelayMs: numeric('--controller-delay-ms') };
  const output = resolve(projectRoot, values.get('--output') ?? `.runtime/experiments/${matrix ? 'matrix' : 'latest'}.json`);
  return { matrix, options, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  const result = args.matrix ? await runMatrix() : await runTrial(args.options);
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  const summary = 'results' in result ? { passed: result.passed, trials: result.results.map(({ label, metrics }) => ({ label,
    applied: metrics.appliedCommands, rejected: metrics.rejectedCommands, deliveredPackets: metrics.radio.delivered,
    droppedPackets: metrics.radio.dropped, collisions: metrics.collisionStartsExcludingGround })) } : { configurationHash: result.configurationHash, metrics: result.metrics };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\nSaved ${args.output}\n`);
}
