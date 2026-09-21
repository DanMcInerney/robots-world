/** Latency-faithful SIMULATED time (lockstep), not wall-clock.
 *
 * Physics steps at a fixed tick (`physicsDtMs`). The camera acquires at a configured rate
 * (`cameraPeriodMs`) independent of inference. Each acquisition's observation becomes available
 * to the controller only after a configured perception latency (default from the measured quiet
 * figure: 140 ms median at 5 Hz through the real nervelet consumer, 190 ms selectable for a
 * pessimistic arm — see the coordinator's quiet-machine measurement,
 * `.runtime/experiments/jev-live-sensor-v2/measurements-quiet/summary-5hz.json` in the main
 * checkout). Perception is latest-wins: camera boundaries that fall while perception is still
 * "busy" in simulated time are skipped and counted (`planNextAcquisition`), never queued.
 *
 * A controller request dispatched at simulated time t "returns" at t + controllerLatencyMs
 * (synthetic/reference: a declared constant, default 250 ms; real Jev: the actual measured wall
 * latency of that call, clamped to `jevLatencyClampMs` — see controllers/jev.ts). This module
 * never sleeps in wall time for that latency: the caller (episode.ts) advances the WORLD by the
 * same simulated span using the existing held command (World's own `Command.validForMs`/lease
 * mechanism — see src/world.ts — already implements hold-last-command-until-expiry and a declared
 * safe behaviour on expiry, so this module does not reimplement lease bookkeeping), so the world,
 * car and drone keep moving through every one of those delays. Real wall time consumed by actual
 * subprocess calls (rendering, perception, a real Jev HTTP request) is measured and reported
 * separately by the caller; it never feeds back into simulated-time bookkeeping, so a run's
 * simulated outcome is deterministic given seed + controller responses regardless of how fast the
 * host computer happened to run.
 *
 * Request starts are paced >=505 ms apart in REAL wall time (`pacingFloorMs`; matches
 * experiments/jev-spatial-text/transport.ts's `createMeter` 505 ms floor) — this is honoured
 * uniformly for every controller, not only real Jev, so the engine's pacing mechanics are
 * identical and testable regardless of which controller is plugged in.
 */

export interface SchedulerConfig {
  /** Fixed physics tick, matching experiments/jev-round3/world.ts's routes (20 ms). */
  physicsDtMs: number;
  /** Camera acquisition period; default 5 Hz = 200 ms. 10 Hz (100 ms) is allowed per the
   * quiet-machine measurement (~9.7 fps steady, 3% skipped); higher rates skip heavily. */
  cameraPeriodMs: number;
  /** Simulated perception latency applied to every acquisition, independent of how long the real
   * render+sensor subprocess calls actually took in wall time. Default 140 ms (quiet-machine
   * median at 5 Hz: stereo 101 ms + detect 28 ms, decode/aggregate omitted as noise). */
  perceptionLatencyMs: number;
  /** Simulated controller latency for synthetic/reference controllers. Real Jev overrides this
   * per call with its own measured wall latency (see controllers/jev.ts). */
  controllerLatencyMs: number;
  /** Real wall-clock floor between request starts (shared meter's floor). */
  pacingFloorMs: number;
  /** Unit E4b / B3: the REAL wall-clock twin of `pacingFloorMs`, separated out so a fake-mode sweep
   * (no real API/rate limit to respect) can skip the artificial wall-clock wait WITHOUT changing
   * `pacingFloorMs` itself — which still, unchanged, gates the SIMULATED dispatch cadence
   * (`nextDispatchSimMs`/`readyToDispatch`) exactly as before, so decision timing/counts and every
   * scored outcome are identical to running with the real wait. Defaults to `pacingFloorMs` (so
   * every existing caller that does not set this explicitly keeps the original coupled behaviour,
   * "paced >=505ms apart in BOTH clocks", byte-for-byte). Only `pacingWaitMs`'s own call site
   * (episode.ts) reads this field; nothing else does. A real-Jev/real-GPU run must NEVER set this
   * below `pacingFloorMs` — real API pacing is a genuine requirement there, not sweep-tooling
   * overhead; `b3-sweep.ts` only overrides it in fake mode. */
  wallPacingFloorMs: number;
  /** Command lease (validForMs given to RobotPort.command); World applies its own declared safe
   * behaviour (plant.stop()) once this expires with no renewal. */
  commandLeaseMs: number;
  /** Small fixed admission delay between a controller's return and the command actually being
   * submitted to the world (mirrors experiments/jev-spatial-text/bench.ts's 20 ms pattern). */
  admissionDelayMs: number;
}

/** Quiet-machine measured figure (coordinator message, 2026-09-21): 5 Hz median acquisition ->
 * consumer age 142 ms (stereo 101 + detect 28 + assembly), p95 158 ms. Used as the default. */
export const DEFAULT_PERCEPTION_LATENCY_MS = 140;
/** Selectable pessimistic arm: the quiet-machine measured p95 across rates (~190 ms). */
export const PESSIMISTIC_PERCEPTION_LATENCY_MS = 190;
export const DEFAULT_CONTROLLER_LATENCY_MS = 250;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = Object.freeze({
  physicsDtMs: 20,
  cameraPeriodMs: 200, // 5 Hz default
  perceptionLatencyMs: DEFAULT_PERCEPTION_LATENCY_MS,
  controllerLatencyMs: DEFAULT_CONTROLLER_LATENCY_MS,
  pacingFloorMs: 505,
  wallPacingFloorMs: 505,
  commandLeaseMs: 1500,
  admissionDelayMs: 20,
});

export interface AcquisitionPlan {
  /** Simulated time (ms since episode start) at which this acquisition actually happens. */
  acquireAtSimMs: number;
  /** Camera period boundaries strictly between `fromSimMs` and `acquireAtSimMs` that were never
   * acquired because perception was still busy (latest-wins skipping). */
  skippedBoundaries: number[];
}

function periodBoundaryStrictlyAfter(simMs: number, periodMs: number): number {
  return Math.round((Math.floor(simMs / periodMs) + 1) * periodMs) + 0; // +0 normalizes a possible -0
}

/** Pure: the next camera acquisition strictly after the LAST acquisition (`afterAcquiredSimMs` —
 * not wherever the previous full decision cycle ended applying its command; the camera runs on its
 * own fixed-rate schedule, independent of how long a decision takes), given perception is busy
 * processing a prior frame until `perceptionBusyUntilSimMs`. Any camera-period boundary strictly
 * before that busy deadline is skipped (counted, never processed) — this is latest-wins, matching
 * experiments/jev-library/sensor/frames.py's `ReplayFrameProvider` semantics but computed here in
 * simulated time instead of real time, since acquisition in this engine is on-demand. Pass
 * `-cameraPeriodMs` as `afterAcquiredSimMs` for the episode's very first acquisition, which then
 * lands at simulated time 0. */
export function planNextAcquisition(afterAcquiredSimMs: number, perceptionBusyUntilSimMs: number, cameraPeriodMs: number): AcquisitionPlan {
  if (!Number.isFinite(afterAcquiredSimMs)) throw new Error('afterAcquiredSimMs must be a finite number');
  if (!Number.isFinite(perceptionBusyUntilSimMs) || perceptionBusyUntilSimMs < 0) throw new Error('perceptionBusyUntilSimMs must be a finite non-negative number');
  if (!(cameraPeriodMs > 0)) throw new Error('cameraPeriodMs must be positive');
  let boundary = periodBoundaryStrictlyAfter(afterAcquiredSimMs, cameraPeriodMs);
  const skippedBoundaries: number[] = [];
  while (boundary < perceptionBusyUntilSimMs) { skippedBoundaries.push(boundary); boundary += cameraPeriodMs; }
  return { acquireAtSimMs: boundary, skippedBoundaries };
}

/** Pure: when this acquisition's observation becomes available to the controller. */
export function observationAvailableSimMs(acquiredSimMs: number, perceptionLatencyMs: number): number {
  if (!(perceptionLatencyMs >= 0)) throw new Error('perceptionLatencyMs must be non-negative');
  return acquiredSimMs + perceptionLatencyMs;
}

/** Pure: when a controller request dispatched at `dispatchedSimMs` returns. */
export function controllerReturnSimMs(dispatchedSimMs: number, controllerLatencyMs: number): number {
  if (!(controllerLatencyMs >= 0)) throw new Error('controllerLatencyMs must be non-negative');
  return dispatchedSimMs + controllerLatencyMs;
}

/** Pure: when a returned decision is actually admitted as a world command. */
export function commandAppliedSimMs(returnedSimMs: number, admissionDelayMs: number): number {
  if (!(admissionDelayMs >= 0)) throw new Error('admissionDelayMs must be non-negative');
  return returnedSimMs + admissionDelayMs;
}

/** Real wall-clock pacing: milliseconds to wait before starting the next request so starts stay
 * >=`floorMs` apart. Returns 0 if this is the first request or the floor has already elapsed. */
export function pacingWaitMs(lastRequestStartWallMs: number | null, floorMs: number, nowWallMs: number): number {
  if (lastRequestStartWallMs === null) return 0;
  return Math.max(0, floorMs - (nowWallMs - lastRequestStartWallMs));
}

/** A minimal world-like surface the scheduler drives — deliberately just {simMs, advance}, so
 * unit tests can assert scheduling behaviour ("the world keeps moving during every delay") against
 * a trivial fake, without any physics/renderer/sensor dependency. The real adapter
 * (world-bridge.ts) implements this directly against src/world.ts's `World.advance(ticks)`. */
export interface TickWorld {
  readonly simMs: number;
  advance(ticks: number): Promise<void> | void;
}

/** Steps `world` forward from its current simMs to AT LEAST `targetSimMs`, in fixed `physicsDtMs`
 * ticks. A no-op if already there. Declared latencies (perception/controller/admission) need not
 * themselves be multiples of the physics tick — a target that falls between two ticks rounds UP,
 * so the world always covers at least the requested span, never less (a fixed-tick simulator
 * cannot land on a fractional tick; rounding down would silently apply a command for less than its
 * declared duration). Throws on an attempt to move backward (a scheduling bug, not a recoverable
 * condition). */
export async function advanceToSimMs(world: TickWorld, targetSimMs: number, physicsDtMs: number): Promise<void> {
  if (!(physicsDtMs > 0)) throw new Error('physicsDtMs must be positive');
  const deltaMs = targetSimMs - world.simMs;
  if (deltaMs < -1e-6) throw new Error(`Cannot advance to a past simulated time: at ${world.simMs}ms, requested ${targetSimMs}ms`);
  if (deltaMs <= 1e-6) return;
  const ticks = Math.ceil(deltaMs / physicsDtMs - 1e-9);
  if (ticks > 0) await world.advance(ticks);
}

/** Pure: the earliest simulated time a NEW decision may be dispatched, given the freshest
 * observation's own availability time and when the LAST decision was dispatched (null for the
 * episode's first decision). This is the SIMULATED-time twin of `pacingWaitMs` (which paces real
 * wall-clock request starts) — an independent design review's point that the >=505ms floor must
 * hold in simulated time too, not only wall time, once acquisition runs on its own faster grid
 * (engine-review-e1 finding 3) and camera/decision cadence are no longer the same period. */
export function nextDispatchSimMs(observationAvailableSimMs: number, lastDispatchedSimMs: number | null, pacingFloorMs: number): number {
  if (!(pacingFloorMs >= 0)) throw new Error('pacingFloorMs must be non-negative');
  return lastDispatchedSimMs === null ? observationAvailableSimMs : Math.max(observationAvailableSimMs, lastDispatchedSimMs + pacingFloorMs);
}

/** Pure: true once a just-delivered observation's availability time has caught up to (or passed)
 * the earliest allowed next-dispatch simulated time — i.e., the acquisition loop can stop
 * accumulating fresher observations and hand off to a decision. */
export function readyToDispatch(observationAvailableSimMs: number, lastDispatchedSimMs: number | null, pacingFloorMs: number): boolean {
  if (!(pacingFloorMs >= 0)) throw new Error('pacingFloorMs must be non-negative');
  return lastDispatchedSimMs === null || observationAvailableSimMs >= lastDispatchedSimMs + pacingFloorMs;
}

// engine-review-e2 finding 7 ("remove unused code — planCycle if genuinely unused"): `planCycle`
// composed ONE acquisition into ONE decision's full timeline, matching the E2 loop shape. The E3
// finding-1 rewrite of episode.ts decoupled acquisition from decision dispatch (several
// acquisitions can feed one decision; the controller call runs concurrently with continued
// acquisition) — `planCycle`'s 1:1 contract no longer matches the actual loop and had no remaining
// callers outside its own tests (confirmed by a repo-wide grep), so it has been removed rather than
// forced back into a shape that misrepresents the real scheduling. The pure pieces it used to
// compose (`planNextAcquisition`, `observationAvailableSimMs`, `controllerReturnSimMs`,
// `commandAppliedSimMs`, `nextDispatchSimMs`, `readyToDispatch`) remain — episode.ts composes them
// directly, matching its own decoupled shape.
