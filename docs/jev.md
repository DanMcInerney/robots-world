# Jev as a bounded decision layer

The optional controller in `controllers/jev.ts` runs over `RobotPort`. Jev chooses among application-authored candidates; the plant's deterministic servo continues between decisions. It does not replace attitude stabilization, trajectory generation, collision checking, or command admission. No Nervelet or native agent session is required. See the [first live API results](jev-live-results.md) for measured response times and closed-loop tracking outcomes.

`createChoiceController` accepts an injected judge, a candidate function, and a list of required sensor IDs. The candidate function receives only the robot's observation and advertised capabilities. It can implement mode selection, task assignment, recovery choices, or navigation choices for any robot type. It must be pure because choices are recomputed before admission. A candidate has an ID, description, and a code-authored command, or `null` for local hold. Command arguments must satisfy the robot's advertised schema before a model sees the choices. Schema validity alone does not establish physical safety.

The controller checks acquisition age before inference and again before admission, checks the world epoch, and verifies that the exact selected command remains in the current candidate set. Commands carry an observation reference and a finite watchdog lifetime. Invalid choices, stale evidence, and late answers cause a local hold. A robot without an advertised hold command stops and releases its lease; custom integrations can supply `holdCommand`.

Each robot has at most one outstanding request. An expired request is aborted and its answer discarded. If an injected transport ignores cancellation, that robot makes no further requests until the old request settles; it never piles up replacements. Cancellation closes the robot lease without waiting for inference. A run defaults to a shared limit of 100 calls and 60 seconds. The default 500 ms deadline is an experiment setting, not a real-time guarantee. Different robots can make independent decisions concurrently.

The HTTP adapter calls the [official TypeSafe endpoint](https://docs.typesafe.ai/api) using `jev-latest` by default. It sends a typed Choice with candidate IDs, validates the returned distribution, caps request and response bodies at 64 KiB, and performs no automatic HTTP retries. Credentials stay in the controller process. Jev does not supply a reasoning trace, and none is invented.

## Inspect a decision from input to execution

Trace records carry `runId`, `robotId`, `decisionId`, and `recordedWallMs`. The decision ID also reaches an injected judge through `ChoiceRequest.decisionId`. A decision keeps its original observation sequence, epoch, delivery time, and sensor acquisition/receipt timestamps even after a fresher observation arrives. The revalidation record identifies that newer evidence separately; the submitted command names the fresh observation used for admission.

| Record | Evidence |
| --- | --- |
| `jev.input`, `jev.candidates` | Original observation snapshot, instructions, required sensors, requested model, and the complete code-authored action palette |
| `jev.request`, `jev.answer`, `jev.decision` | Call boundary, observed wall latency, selected option and distribution, requested model plus returned model identifier, input/output token counts when the provider supplies them |
| `jev.revalidation`, `jev.discarded` | Original and current observation references, or why a result was withheld |
| `jev.command-submitted`, `jev.admission` | Exact command and its receipt; accepted admission remains distinct from completed execution |
| `jev.execution-event`, `jev.events-acknowledged` | Delivered job events and the event cursor acknowledged after their records were emitted |
| `jev.request-error`, `jev.late-discarded` | Sanitized failure classification, or a late answer/error with its original decision ID and any reported usage |

Every observed execution event is handed to the configured record callback before `acknowledge(throughEvent, [])`. Radio inbox messages remain unacknowledged: reading a packet does not mean this generic policy consumed it. An injected judge can inspect those messages, but a controller with a real peer protocol must own its packet acknowledgement policy. Event draining also continues while an expired, uncooperative request is still pending. Up to 512 recent command/job correlations are retained; older unmatched events are marked `correlated: false`, rather than attributed to a guessed decision.

The `record` callback is a synchronous handoff, not a promise of durable storage. A callback exception while recording an execution event prevents its acknowledgement and stops the controller. Configure a recorder when retaining experiment evidence matters; without one the controller still consumes execution events. A recorder that queues or drops data must report that separately. The cockpit's bounded ring is an inspector, not a complete experiment archive.

Ordinary records are structured objects below 8 KiB. Larger records up to 64 KiB use `jev.<kind>.part`: group by kind, run/robot/decision IDs and `sha256`; sort by zero-based `partIndex`; concatenate `json`; check `partCount` and the SHA-256; then parse the JSON. Each part remains below 8 KiB. Over-limit records explicitly carry `truncated: true`, the original byte count, and a digest. Credential-shaped fields and bearer strings are redacted; arbitrary exception text, headers, SDK request objects, and extra reasoning fields are excluded. A partial or truncated trace is not sufficient for exact replay.

A deadline record is immediate. If an ignored abort eventually returns, the controller emits a separate `jev.late-discarded` diagnostic, including after its lease was released, and never applies that result. A closed recorder may no longer accept that last diagnostic; the earlier discard remains evidence that the call's final outcome was unknown at shutdown. No shutdown waits indefinitely for a model.

## Run a small experiment

Start the world, then opt into a bounded live run:

```powershell
$env:TYPESAFE_API_KEY = '<your key>'
$env:JEV_MODEL = 'jev-latest'
npm run agent -- --driver jev --robots drone-1 --goal 'Inspect the mission waypoints' --waypoints '[{"x":2,"y":0,"z":2},{"x":-2,"y":2,"z":2}]'
```

Use the robot ID shown in the viewer. This CLI example depends on the controller runner's session file and advertised sensors. `createJevController` discovers mounted odometry and lidar by type, including custom sensor IDs. The example palette offers explicit mission waypoints plus hold. It calculates distances in code and only holds when a lidar return is too close. It is a deliberately small policy fixture: sparse planar rays do not prove a complete route is clear, and its waypoint choice is not an obstacle-avoidance planner. Use `createChoiceController` to provide task-specific candidate generation and stronger feasibility checks.

For offline experiments, inject a mock judge instead of calling `createJevJudge`. Sweep its latency, failure rate, and choice distribution. Compare the same scene and sensor configuration under a deterministic policy, Jev, a native agent, and a native agent with Jev selecting bounded local actions. Measure observation age at application, deadline misses, command rejection, mission completion, local hold duration, model calls, token usage, and collisions. Record actual model outputs and application ticks: a seed cannot reproduce cloud inference or network arrival times by itself. Tests cover deadlines, ignored aborts, stale evidence, epoch changes, illegal choices, command schema admission, and the HTTP contract without paid inference.

The hypothesis is that Jev can choose useful modes, targets, or recovery routines more frequently than a native reasoning agent, while local code handles the continuous motion. A slower agent could author or revise those bounded routines when the available choices cannot solve a task. This repository implements the choice/servo boundary; it does not establish that adding Jev improves a deterministic routine, that confidence thresholds are calibrated for robotics, or that agent-authored routines transfer safely to hardware. Test a fixed local routine first, keep the offered routines and scene identical when comparing decision layers, and charge all inference, waiting, revalidation, and fallback work to the measured run.

## Patterns found in public projects

Research checked on 2026-09-17. These are useful software patterns; none of these repositories establishes Jev drone control or hardware qualification.

- [sorrycc/typesafe-snake](https://github.com/sorrycc/typesafe-snake): code computes legal moves and geometric facts; a fixed tick accepts a choice only before its deadline. This supports bounded candidate selection with an independent execution clock. Robotics needs an explicit hold or braking policy rather than blindly copying the game's straight-ahead fallback.
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast): each observation produces an indexed action space. Independent operation and target questions share one request, and execution validates the observed target again. A text model is reserved for actions that actually require generated text. This suggests batched independent mode/target judgements and narrow escalation to a native reasoning agent.
- [AboveColin/HA-Jev](https://github.com/AboveColin/HA-Jev): typed results become ordinary automation inputs, with call/token accounting and a daily budget. Its examples include confidence gating, escalation, and an inexpensive check before an LLM call. The lesson for this testbed is to expose decision outputs and budgets as data while keeping control policy in code.

TypeSafe's [introduction](https://docs.typesafe.ai/introduction) recommends decomposing independent questions and composing their results in software. The [launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev) reports low service latency and a structured-state Doom demo. Those are vendor claims about their measured workloads, not measurements of this simulator, robot control quality, or a guaranteed deadline. A well-typed decision can still be wrong. This repository's separately recorded live API trials qualify the exercised simulated tracking path; no physical robot is qualified.
