/** Renderer bridge: a persistent child process running experiments/jev-round3/camera/renderer.py's
 * `--jsonl` mode (render-on-demand from a supplied camera/target pose; implemented in that file but
 * never used before this engine — ~325 ms median per stereo pair on this machine). One JSON request
 * line in, one JSON metadata response line out, per acquisition; the actual RGB pair is written to
 * disk at the request's `out_dir` (the renderer's own behaviour when `out_dir` is given).
 *
 * `evaluator: false` is set on EVERY request: an independent design review flagged that
 * renderer.py's `evaluator` default is `True`, which would write true depth/masks/poses beside the
 * controller-visible RGB frames by default — a structural leak risk for an on-demand closed loop
 * (Round 3 only used this safely because the renderer ran fully offline, evaluated separately from
 * any live decision loop). This engine's evaluator truth is instead computed analytically from the
 * Rapier physics state (see evaluator.ts) and never touches the renderer's own evaluator output at
 * all — checked by test (no `evaluator/` directory is ever created under this client's output
 * root).
 *
 * renderer.py is READ-ONLY: this repository's other in-flight experiment owns it, and this
 * assignment's own workspace boundary excludes it from files this engine may edit. HFOV/resolution/
 * baseline are therefore fixed renderer constants (declared gap; see the coordinator report). The
 * script/interpreter are referenced by absolute path into the main checkout
 * (C:\Users\danhm\tools\robots-world), where the actual weights/asset (.runtime/experiments/
 * jev-round3-v1/camera/assets/ferrari.glb) resolve via renderer.py's own `__file__`-relative path —
 * this worktree's own .runtime is empty by design (a fresh checkout has none).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { RenderPose } from '../jev-round3/world.ts';

export interface RendererClientOptions {
  pythonExecutable: string;
  rendererScriptPath: string;
  outputRoot: string;
  /** Real wall timeout per render call, generous relative to the ~325 ms measured median. */
  timeoutMs?: number;
}

export interface RenderRequest { seq: number; camera_pose: RenderPose; target_pose: RenderPose; scene_config: Record<string, unknown> }
export interface RenderResult { leftPath: string; rightPath: string; calibrationPath: string; outDir: string; wallMs: number; metadata: Record<string, unknown> }

export interface RendererClient {
  render(request: RenderRequest): Promise<RenderResult>;
  close(): Promise<void>;
}

export async function startRendererClient(options: RendererClientOptions): Promise<RendererClient> {
  await mkdir(options.outputRoot, { recursive: true });
  const child: ChildProcessWithoutNullStreams = spawn(options.pythonExecutable, [options.rendererScriptPath, '--jsonl'], {
    // engine-review-e1 finding 6: a fixed PYTHONHASHSEED makes any hash-order-dependent behaviour
    // in the renderer process (dict/set iteration order across separate process starts, which
    // CPython randomises per-process by default) repeatable run to run — a prerequisite for the
    // "≥15 process starts give byte-identical images" determinism check (see
    // test/jev-find-follow-real-integration.test.ts's determinism test and FAILURES.md). Fixed to
    // 0 (a declared, arbitrary but constant value) rather than left to the environment's own
    // ambient PYTHONHASHSEED, so determinism holds regardless of what started this Node process.
    windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONHASHSEED: '0' },
  });
  const stderrChunks: string[] = [];
  child.stderr.on('data', chunk => { stderrChunks.push(chunk.toString('utf8')); if (stderrChunks.length > 500) stderrChunks.shift(); });
  const rl: Interface = createInterface({ input: child.stdout });
  const pendingLines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on('line', line => { const waiter = waiters.shift(); if (waiter) waiter(line); else pendingLines.push(line); });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; while (waiters.length) waiters.shift()!(''); });
  const timeoutMs = options.timeoutMs ?? 15_000;

  function nextLine(): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (pendingLines.length) { resolvePromise(pendingLines.shift()!); return; }
      if (exited) { rejectPromise(new Error(`Renderer process already exited (code=${exited.code} signal=${exited.signal}); stderr tail: ${stderrChunks.join('').slice(-2000)}`)); return; }
      const timer = setTimeout(() => { const idx = waiters.indexOf(onLine); if (idx >= 0) waiters.splice(idx, 1); rejectPromise(new Error(`Renderer response timed out after ${timeoutMs}ms; stderr tail: ${stderrChunks.join('').slice(-2000)}`)); }, timeoutMs);
      const onLine = (line: string) => { clearTimeout(timer); if (exited && !line) rejectPromise(new Error(`Renderer process exited before responding; stderr tail: ${stderrChunks.join('').slice(-2000)}`)); else resolvePromise(line); };
      waiters.push(onLine);
    });
  }

  let closed = false;
  return {
    async render(request: RenderRequest): Promise<RenderResult> {
      if (closed) throw new Error('Renderer client already closed');
      const outDir = resolve(options.outputRoot, `frame-${String(request.seq).padStart(6, '0')}`);
      const payload = { camera_pose: request.camera_pose, target_pose: request.target_pose, scene_config: request.scene_config, out_dir: outDir, evaluator: false };
      const startedWallMs = Date.now();
      child.stdin.write(JSON.stringify(payload) + '\n');
      const line = await nextLine();
      let metadata: Record<string, unknown>;
      try { metadata = JSON.parse(line); } catch (error) { throw new Error(`Renderer returned non-JSON line: ${line.slice(0, 500)} (${String(error)})`); }
      const wallMs = Date.now() - startedWallMs;
      return { leftPath: resolve(outDir, 'rgb/left.png'), rightPath: resolve(outDir, 'rgb/right.png'), calibrationPath: resolve(outDir, 'calibration.json'), outDir, wallMs, metadata };
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
