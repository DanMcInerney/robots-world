/** Sensor bridge: a persistent child process running the on-demand mode added to
 * experiments/jev-library/sensor/ for this assignment (`python -m sensor.main --on-demand ...`;
 * see frames.py's `OnDemandFrameProvider` and main.py). One frame reference (left/right/calibration
 * paths + the engine's own SIMULATED acquisition stamp) in on stdin, exactly one
 * `stereo-objects/2` record out on stdout, preserving the engine's simulated clock rather than the
 * sensor's own wall-clock `EpochClock` (the sensor's on-demand mode carries the acquisition stamp
 * through unchanged, labelled `"engine-simulated-ms"`, never mixed with wall time — see records.py
 * and an independent design review's point 6). Detector/stereo backend stay warm across requests
 * (one process for the whole episode), matching the interactive per-decision cadence this engine
 * needs rather than the replay pacer's fixed-rate stream.
 *
 * Absolute paths only (fixes the same class of bug as integrations/measure-stereo-objects-latency.ts
 * item 11): `sensorCwd` is THIS repository's own `experiments/jev-library` (so the on-demand code
 * added here is what actually runs), while `checkpointPath`/`detectorRuntimeRoot` point into the
 * main checkout's `.runtime` (this worktree's own `.runtime` is empty by design).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { StereoObjectsFrameRecord } from '../../integrations/stereo-objects.ts';

export interface SensorClientOptions {
  pythonExecutable: string;
  sensorCwd: string;
  checkpointPath: string;
  detectorRuntimeRoot: string;
  scoreThreshold?: number;
  maxObjects?: number;
  device?: string;
  timeoutMs?: number;
}

export interface SensorFrameRequest { id: string; leftPath: string; rightPath: string; calibrationPath: string; acquiredSimMs: number }
export interface SensorFrameResult { record: StereoObjectsFrameRecord; wallMs: number }

export interface SensorClient {
  hello: Record<string, unknown>;
  process(request: SensorFrameRequest): Promise<SensorFrameResult>;
  close(): Promise<void>;
}

export async function startSensorClient(options: SensorClientOptions): Promise<SensorClient> {
  const args = [
    '-m', 'sensor.main', '--on-demand',
    '--checkpoint', options.checkpointPath,
    '--detector-runtime-root', options.detectorRuntimeRoot,
    '--stereo', 'sgbm',
  ];
  if (options.scoreThreshold !== undefined) args.push('--score-threshold', String(options.scoreThreshold));
  if (options.maxObjects !== undefined) args.push('--max-objects', String(options.maxObjects));
  if (options.device) args.push('--device', options.device);
  const child: ChildProcessWithoutNullStreams = spawn(options.pythonExecutable, args, { cwd: options.sensorCwd, windowsHide: true });
  const stderrChunks: string[] = [];
  child.stderr.on('data', chunk => { stderrChunks.push(chunk.toString('utf8')); if (stderrChunks.length > 1000) stderrChunks.shift(); });
  const rl: Interface = createInterface({ input: child.stdout });
  const pendingLines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on('line', line => { const waiter = waiters.shift(); if (waiter) waiter(line); else pendingLines.push(line); });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; while (waiters.length) waiters.shift()!(''); });
  const startupTimeoutMs = 120_000; // detector/model load can be slow on first start
  const timeoutMs = options.timeoutMs ?? 10_000;

  function nextLine(withinMs: number): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (pendingLines.length) { resolvePromise(pendingLines.shift()!); return; }
      if (exited) { rejectPromise(new Error(`Sensor process already exited early (code=${exited.code} signal=${exited.signal}); stderr tail: ${stderrChunks.join('').slice(-4000)}`)); return; }
      const timer = setTimeout(() => { const idx = waiters.indexOf(onLine); if (idx >= 0) waiters.splice(idx, 1); rejectPromise(new Error(`Sensor response timed out after ${withinMs}ms; stderr tail: ${stderrChunks.join('').slice(-4000)}`)); }, withinMs);
      const onLine = (line: string) => { clearTimeout(timer); if (exited && !line) rejectPromise(new Error(`Sensor process exited before responding; stderr tail: ${stderrChunks.join('').slice(-4000)}`)); else resolvePromise(line); };
      waiters.push(onLine);
    });
  }

  const helloLine = await nextLine(startupTimeoutMs);
  const hello = JSON.parse(helloLine);
  if (hello.type !== 'hello') throw new Error(`Expected a hello record first, got: ${helloLine.slice(0, 500)}`);

  let closed = false;
  return {
    hello,
    async process(request: SensorFrameRequest): Promise<SensorFrameResult> {
      if (closed) throw new Error('Sensor client already closed');
      const payload = { id: request.id, leftPath: request.leftPath, rightPath: request.rightPath, calibrationPath: request.calibrationPath, acquiredMs: request.acquiredSimMs };
      const startedWallMs = Date.now();
      child.stdin.write(JSON.stringify(payload) + '\n');
      const line = await nextLine(timeoutMs);
      let record: StereoObjectsFrameRecord;
      try { record = JSON.parse(line); } catch (error) { throw new Error(`Sensor returned non-JSON line: ${line.slice(0, 500)} (${String(error)})`); }
      return { record, wallMs: Date.now() - startedWallMs };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rl.close();
      child.stdin.end();
      await new Promise<void>(resolveClose => {
        if (exited) { resolveClose(); return; }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolveClose(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolveClose(); });
      });
    },
  };
}
