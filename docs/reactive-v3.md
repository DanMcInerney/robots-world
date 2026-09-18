# Reactive experiment corrections

Status: implemented; qualified with offline mechanics tests. No new Jev, Claude or Codex performance measurements were made for this revision. The [24 previous attempts](reactive-results.md) retain their source snapshot, raw evidence and original scoring. A new source/configuration freeze and unused held-out seeds are required for another comparison.

The platform stays [controller-neutral](../PRINCIPLES.md). These corrections live in the reactive experiment, two optional sensor plugins and the existing Nervelet adapter. They add no simulator scheduler, planner, plugin framework or mandatory AI dependency. Nervelet still owns its bridge and native harness integration; the environment owns sensor acquisition, command admission and domain effects. See [Nervelet's principles](../../nervelet/README.md) and [design](../../nervelet/DESIGN.md).

## What changed

| Issue | Correction | Remaining limitation |
| --- | --- | --- |
| A 1.5-second preview admitted 3-second maneuvers | Preview the entire requested lifetime using the plant's servo gains and 20 ms integration. Add a margin for measurement age, positional noise, body extent and maximum dispatch delay. Check again against the latest delivered odometry at admission and wire delivery. | An envelope guard, not collision avoidance or a certified reachable-set calculation. Sparse obstacle returns only annotate choices. |
| Old queued packets could outlive a decision | Replacement clears queued packets. Every packet carries goal, command identity and absolute expiry. Clamp the plant watchdog to the remaining lifetime; encode position and velocity with their respective MAVLink masks. | Simulated link, not PX4 SITL or physical autopilot qualification. |
| An empty menu or provider exception could terminate the flight | Record a controller failure, revoke further decisions and apply local hold. Physics, sensors, obstacles, goal updates and evaluation continue to the scheduled end. The batch proceeds without retrying that controller attempt. | Infrastructure failures invalidate a trial and prevent a qualified complete comparison; they do not receive fabricated full-flight scores. |
| A small action menu could look like the drone's full control surface | Record physical capabilities separately from the menu representation. Existing `Controller.run(ports, signal)` can use continuous position/velocity and camera setpoints through the same guarded transport. | This plant has stabilized setpoints, not raw motor thrust, pitch/roll flight dynamics or an articulated gimbal. |
| A brief attainment looked like successful continuous filming | New primary score requires the requested side, distance and framing for at least 50% of **each** scored phase, plus a continuous one-second dwell, without collisions, boundary violations, controller failures or delivery-guard interventions. | Default five-second warmup per phase remains explicit. Older scores are unchanged. |
| Ideal sensor assumptions were easy to miss | Configure cooperative broadcasts, odometry noise, camera coordinate/range noise, per-detection dropout and range-cloud registration noise. Persist every setting. | Camera identity and heading/pitch remain ideal geometric measurements. Range registration adds translation error with ideal orientation; this is not SLAM or learned perception. |

The fallback uses the existing simplified plant's immediate brake and position hold. It does not follow the rover, aim at it or choose a route. The evaluator records hold time including startup, waiting for initial transport, expired setpoints, link watchdogs, goal changes and failures. This idealized brake is common to controllers and is visible in the configuration; it is not a hardware braking model.

Controller response age and safety validation have separate purposes. Original decision provenance is never refreshed by a later measurement. Current delivered odometry is used only to veto a now-unsafe command. A veto does not choose a replacement mission action.

## One configuration and one controller boundary

[config.ts](../experiments/reactive/config.ts) is a plain JSON configuration with timing, link, action representation, sensor and scoring settings. Worlds take an immutable copy. `--config path.json` overrides it for the reactive CLI; development and held-out configurations must match exactly. Menus are still goal-independent enumeration: up to 26 normalized directions at each declared speed plus hover, with four camera options. Envelope checks may remove options; obstacle geometry never ranks or selects them.

The six existing model arms remain restricted **menu-choice** comparisons. The programmatic `trial()` also accepts the existing `Controller` interface:

```ts
import { trial } from './experiments/reactive/run.ts';
import type { Controller } from './src/contracts.ts';

// Your implementation receives only scoped ports and a cancellation signal.
// It may call existing runCodex/runClaude, wrap a port with createPolicyPort,
// or use your own controller library. Supply its implementation/dependency files
// so their hashes are recorded. Do not give it the World or evaluator object.
const controller: Controller = yourController;
await trial({
  arm: controller.id, controller,
  controllerSource: { files: ['my-controller.ts'] },
  seed: 601, seconds: 60, directory: '.runtime/experiments/my-development',
  phase: 'development',
});
```

Create the output directory before calling `trial`. Custom controller provenance lists must include local policy and adapter implementation files, not just a wrapper entry point. The built-in six-arm CLI does not silently include these custom arrangements in its frozen comparison. Record the exact arrangement, tools, inference budgets and source files before comparing a complete agent with a restricted menu arm.

The experimental port exposes `control` and nonterminal `hold`. Controls require `basedOn.observation`, or `args.observation` for schema-driven adapters, from an actual returned observation. This makes stale evidence explicit even when an environment refreshes in the background. `validForMs` controls the action lifetime (default 3 seconds, permitted 0.5–8 seconds). `stop()` revokes the port without stopping the world. Radio messages and execution events remain unread until acknowledged. Receipts acknowledge queue admission; dated wire receipts and physical measurements establish application.

For Nervelet, `createNerveletEnvironment(port, { commandValidForMs: 3000 })` exposes the returned observation sequence and current robot goal in domain state. Include that sequence in `control.args.observation`. `runNervelet` also accepts `commandValidForMs`. Use the received current goal; explicitly relay operator goal changes into the Nervelet Bridge when supervising a native session. This revision tests the environment adapter, not a complete native Nervelet session with goal propagation or compaction. Existing [local policy jobs](policy-jobs.md) are the extension point for Jev running while a native agent deliberates.

Controller shutdown is bounded. After the trial, authority is revoked immediately; failure to settle within two seconds is logged. In-process asynchronous code cannot be forcibly killed, and synchronous code that blocks Node can prevent simulation ticks. Use the existing HTTP/process boundary for untrusted or CPU-heavy controllers. A pacing failure invalidates the trial rather than hiding the stall.

## Evidence and verification

Raw JSONL includes configuration/capabilities, original observation provenance, offered actions, decisions, admission/rejection, dated MAVLink application, goal changes, controller failures, fallback transitions and all world journal events. Summaries separate menu-decision counts from control admissions and applied setpoints. Scoring reports per-phase framing, first attainment, longest dwell, contacts and bounds; fallback time, stale responses and delivery interventions are explicit. The replay viewer exposes controller/fallback and configuration channels.

Run offline regression checks and a clearly marked viewer fixture:

```sh
npm test
npm run typecheck
npm run build
node experiments/reactive/fixture.ts
```

The fixture injects a provider exception and arbitrary continuous setpoints. It verifies continued simulation, transport and logging; it does **not** compete with an AI or demonstrate drone-task performance. Model calls remain explicit opt-in. The default suite covers full-lifetime descent rejection, delivery-time revalidation, queued replacement/expiry, stale provenance, continuous controls, terminal Stop, adapter lifetime and deterministic sensor impairments.

Verification on 2026-09-17: all 133 tests passed with `ROBOTS_NERVELET_MODULE` pointing to the adjacent built Nervelet checkout, including its three optional Bridge integration tests. TypeScript and the production viewer build passed (the existing Three.js chunk-size warning remains). The browser rendered both the historical v2 replay and the new fixture, including configuration and failure panels. Local fixture evidence is in `.runtime/experiments/reactive-v3-final`: both six-second runs completed, the injected provider failed once without retry, and the continuous fixture admitted 12 arbitrary controls through MAVLink. Its evidence audit verified paired environmental motion and complete journal coverage. A separate regression runs another 60 seconds after controller Stop to verify unattended sensor/radio queues continue draining.
