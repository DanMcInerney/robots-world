# Matched Jev and DroneRTS-style control experiments

The question is whether a fast, inexpensive judgment layer improves useful robot behavior over an already capable native-agent system. It is not whether an asynchronous controller can outperform a deliberately stalled robot. This document pins the inspected baseline and specifies comparisons; it does not report live Jev or Codex benchmark results. See the [principles](../PRINCIPLES.md), [experiment runner](experiments.md) and [Jev controller](jev.md) for current executable fixtures.

## Source identity and limits

Inspected on 2026-09-17: local checkout `C:/Users/danhm/tools/DroneRTS`, Git HEAD **`7379731b4869beb25412ff0cee4d7a0d970b6662`**, origin `https://github.com/DanMcInerney/DroneRTS.git`. The inspected `server/`, `shared/` and `tests/` source files were clean. `README.md` had an existing modification; `AGENT-LOOP-DESIGN.md` and `NERVELET-INTEGRATION-PLAN.md` were untracked. Those files were not edited or treated as implemented source. No game, live actor or trial was launched.

The separate Nervelet checkout was at `09c79d49e62c95f1e8ac01eaa83b839c6045d5bb` when inspected. Its `docs/dronerts.md` describes a later application integration with borrowed per-pilot bridges and delivery acknowledgement. Do not silently combine that document's behavior with this older DroneRTS source revision. A future live comparison must pin the actual tested application and library revisions together, including dirty-source hashes. Current native integration in Robots World is a separate port-based binding, not the complete DroneRTS game.

## What the authentic baseline can do

The [backend contract](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/agent-backend.ts) fixes gameplay to native Codex `gpt-5.6-luna` / `xhigh`, with no fallback. Separate clean-context drone actors receive role-bound tools. Mechanical parents relay original objectives rather than planning missions. The simulation and local execution continue during native inference.

The [tool catalog](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/runtime-tools.ts) exposes these relevant semantics:

| Tool | Actual role |
| --- | --- |
| `observe` | Fresh acquired camera, timestamped own telemetry and bounded unread event/mail slice. |
| `act` | Admit asynchronous absolute `fly_to`, camera/heading `look`, or braking `hover`; accepted is not arrived. |
| `wait` | Await relevant events, cancellation or bounded timeout while local work continues. |
| `route` | Start/status/cancel up to 32 caller-chosen ordered waypoints, with explicit replacement and completion/blocked/cancelled/failed states. |
| `workspace` / `routine` | Author private code and start/status/cancel an isolated bounded QuickJS job using immutable source versions. |
| `exchange` | Up to eight compatible operations, individual outcomes and one aggregate fresh observation; no rollback or dependency ordering is implied. |
| `send` / `transfer` | Actual team radio and explicitly imported inert code transfers; no shared actor memory or automatic execution. |

Mission versions and optional delivered observation/event provenance are checked. At this source revision, included mail is consumed at the application tool boundary; that differs from the later Nervelet integration's explicit `seen` acknowledgement. Newer contracts must retain their own version labels.

The [ordered job executor](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/command-jobs.ts) advances the next waypoint when the previous one arrives. Its healthy local tick renews the **500 ms monotonic lease**; the model does not send subsecond keepalives. One movement writer owns each drone. A blocked route stops for a decision, without choosing an alternative path.

The [motion controller](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/drone-motion.ts) uses finite own-range evidence for braking and coverage checks. It has no geometry-based pathfinder. Its travel and precision profiles are simulator calibrations, not measurements of aircraft dynamics. Keep this local assistance in every compared arm.

The [routine runner](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/routine-runner.ts) already supports a separate worker, `telemetry`, `camera`, `events`, `act`, `send`, sleep and private files. Defaults include one active routine, 32 MiB guest heap, 20 ms CPU/slice, 250 ms CPU per wall second, 64 SDK calls/s, eight pending calls, two-second host-operation deadline and 120-second total wall duration. Mission, owner and cancellation checks run before and after awaited host work.

In [the game adapter](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/server/game.ts), routine `telemetry()` reads current own data. Routine `camera()` reads the latest **model-acquired** frame with age/freshness, not a new continuous RGB stream. The [onboard guide](https://github.com/DanMcInerney/DroneRTS/blob/7379731b4869beb25412ff0cee4d7a0d970b6662/ONBOARD.md) supplies neutral SDK syntax, not preloaded navigation or tactical solutions. Distinguish supported authored-routine capability from evidence that a particular model actually used it successfully.

## Keep these comparisons separate

| Arm | What it measures |
| --- | --- |
| Deterministic local routine | Sensor-to-action rules with no model calls. Establishes whether inference is useful at all. |
| Native planner plus ordered route/routine | A capable DroneRTS-style hierarchy. Local execution continues; new judgment invokes the native agent. |
| Jev bounded selector plus the same local execution | Whether low-latency judgments improve the same admissible choices. |
| Native planner plus Jev selector | Whether delegation reduces costly replanning while preserving mission quality. |
| Direct native tool-by-tool control | Optional ablation of route/routine use, clearly labelled; never the only baseline called “DroneRTS.” |

A provided routine tests execution after setup. A newly agent-authored routine tests planning, code generation, verification and execution together. Publish both setup-inclusive and steady-state results, and preserve the same opportunity to author/use routines in native and hybrid arms. If the question is judgment latency, use the same fixed candidate generator, observations and permitted actions for every judge. Do not give Jev a solved candidate generator while forcing the native agent to discover all geometry from pixels.

## Paired scenario specification

1. **Known ordered route — negative control.** All waypoints are available at the beginning. Execute them locally in every hierarchical arm. Count pauses at actual decision boundaries; do not inject a model delay between already-programmed legs. A speedup here may indicate a handicapped baseline rather than useful Jev judgment.
2. **New obstruction — stop versus replan.** Introduce a reproducible moving barrier after route admission. All arms retain the same finite-sensor guard and braking controller. Measure first observable evidence to hold separately from first observable evidence to resumed useful motion. Compare deterministic reactive selection as well as both models. No omniscient collision query may enter a controller.
3. **Ambiguous local choice.** Present noisy, delayed or conflicting permitted measurements requiring a choice among the same feasible actions. Measure decision quality and abstention as well as latency. This tests a judgment layer only if the local deterministic baseline is honestly competitive and all required evidence is represented. Existing ray-depth data is not RGB perception; a future visual task needs a separately qualified camera pipeline.
4. **Stale sensing and late answers.** Add dropout, delay and epoch/goal changes during inference. Required stale sensing prevents a new decision; already-valid local work follows the same declared policy for every arm. Count late-result rejection, unnecessary holds, unsafe applications and recovery time. A faster incorrect response is not a win.
5. **Partitioned swarm.** Use one isolated controller per robot, own sensing and actually delivered packets. Vary loss, bandwidth, delay and partitions with paired seeds. Existing valid local work continues during radio loss. Measure task progress, message usefulness, duplicated work, recovery and time spent holding after evidence expires. A centralized shared-agent run is a separate condition.

Use identical plant/backend versions, units, timestep, sensors and guards within a comparison. DroneRTS uses east/up/south coordinates with 10 metres per local unit; Robots World uses SI ENU. Any imported target or range must be converted explicitly. Do not call the current simplified Robots World plant a reproduction of DroneRTS physics or a full autopilot.

## Comparable evidence

Each paired run should retain a manifest with source and dependency hashes, model identifier/effort, complete prompt and candidate policy version, seed, sensor/physics/radio configuration, local routine source hash, budgets and exact controller composition. Store the controller-visible observation (or an immutable reference to it), sensor acquisition/receipt/delivery times, model dispatch/first-result/final-result times, selected candidate and probability when supplied, validation outcome, command admission/application, job transition and physical task outcome. Join them by run, robot, observation, inference, command and job IDs.

Report task completion/quality, collisions, minimum separation where available, progress during inference, unnecessary hold time, recovery latency, stale/invalid choice rates and lost-event/trace coverage. Separate model service latency, tool/transport overhead and vehicle response. Radio records must distinguish enqueue, delivery, expiry, acknowledgement and peer response. Show per-run values and paired distributions; do not let a small sample or a single successful seed stand in for repeatability.

Record model calls, actual returned token usage, cost when supported, and wall/CPU/storage cost of local routines. Missing usage is unknown, not zero. Report startup and code-authoring cost separately from steady execution, then include both in total mission cost. If models receive different representations, count their generation cost and disclose the difference.

First establish deterministic mechanism tests, then replay fixed candidate/evidence traces to compare judgment quality, then use matched closed-loop trials. Fixed-observation replay cannot measure counterfactual closed-loop success because different actions change later observations. Scenario seeds reproduce the simulator's random choices, not cloud outputs or network arrival timing; preserve actual outputs and application times.

**Evidence labels are mandatory:** injected delay/mock choice = architectural sensitivity; real API call = measured service behavior; native Codex trial = native agent behavior at its recorded revision; physical trial = separately qualified hardware behavior. Run initial native timing trials at fixed 1× wall pacing and log real-time lag. No offline delay sweep is a Codex/Jev speed or price benchmark.
