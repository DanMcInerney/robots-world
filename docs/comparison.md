# Jev, local routines, and agent control

The first experiment asks whether a robot can keep reacting while a slower decision is pending. It separates **local execution architecture** from **model judgment quality**. The default run makes no API calls and launches no native agents.

See the [first results](comparison-results.md) for the default, zero-startup and impaired-sensing runs and their limits.

The subsequent [live Jev results](jev-live-results.md) use actual API calls and are reported separately from those injected-delay fixtures.

The next mission-level research is specified in [Codex and Jev controller arrangements](controller-arrangements.md): direct Jev control from English, agent-authored routines with Jev judgments, asynchronous planning, event-driven revision and fleet variants.

The [source-backed Jev research and test plan](jev-research-tests.md) narrows those proposals into a held-out decision suite, a real busy-Codex mission comparison, and later steering, concurrency and swarm experiments. It distinguishes public demonstrations from reproduced evidence.

The subsequent [English-mission comparison](mission-comparison.md) optimizes Jev's action interface and compares live Jev, native Claude and an asynchronous hybrid, with no scripted mission policy as a competitor.

```powershell
npm run compare
```

Open the protected viewer printed by `npm run dev`, then **Compare experiments**. Select two arms with the same seed, replay their trajectories with a shared time cursor, and load a full trace to inspect decisions and wire frames. The 3D world remains an independent live inspector; the comparison charts replay recorded evaluator positions.

For interactive 3D inspection, select **Moving target experiment**, reset, then run the local baseline or attach a controller to robot `drone`. The host composes this fixture's sensor registry and before-step dynamics just like any custom experiment; the generic world core has no tracking-task knowledge. The viewer baseline uses direct port commands; the headless paired matrix uses the explicit MAVLink codec path.

## What is executable now

`experiments/tracking.ts` builds a regular `Scenario`, sensor registry and host update callback. A drone follows a seeded, continuously moving target, which reverses lateral velocity at 8 and 20 seconds. Target visibility disappears from 14 through 16 seconds. Seeds change speed, direction and phase. Sensor acquisition runs at its own rate: odometry 50 Hz, lidar 20 Hz, target tracker 10 Hz. The tracker is explicitly ideal processed relative-position sensing with finite range, ray occlusion, delay and dropout; it is not a camera or learned detector.

The controller receives only its scoped `RobotPort`. The evaluator alone receives target truth. All arms use the same target evidence, candidate generator, local clearance/visibility guard, drone plant and MAVLink path. The fixed code selector always chooses `follow` when permitted. This deliberately easy task establishes the control-loop baseline before testing judgment.

| Arm | Default decision schedule | Existing work during a decision |
| --- | --- | --- |
| `code-local` | Local selection every 100 ms | Continues |
| `agent-direct` | Same selection, injected 5 s delay | Previously admitted waypoint continues; local guard remains active |
| `agent-routine` | Injected 5 s startup, then local selection every 100 ms | Routine keeps sensing and acting |
| `jev-local` | Same selection, injected 150 ms delay | Last selected waypoint and guard continue |
| `agent-jev` | Injected 5 s startup, then the same 150 ms selector | Local executor continues |

An injected 150 ms completion is consumed on the next 100 ms policy poll, so its observed schedule latency is normally 200 ms. This is intentional acquisition/scheduling quantization, not a measured API response. Known waypoints never require a model keepalive. The agent-direct condition is an ablation; the routine arm is essential to the [DroneRTS comparison](dronerts-comparison.md). A regression test proves that with zero startup delay the code and routine arms have identical final physical state.

The local executor streams actual `SET_POSITION_TARGET_LOCAL_NED` MAVLink v2 bytes at 10 Hz through encoding, CRC parsing, explicit target identity and ENU/NED conversion. It independently streams odometry and heartbeat messages. These are in-memory wire tests; network and full autopilot overhead are absent. Setpoints have the same 1 s vehicle watchdog. Every arm uses the same configurable decision-age and retained-setpoint limits (`--max-decision-age-ms 6000`, `--max-setpoint-age-ms 12000`). Current guard evidence is checked separately from the age of the selected waypoint. Direct-agent snapshots may be old by design, as in an asynchronous `fly_to`; their age remains visible and is not relabeled fresh by the guard check.

The default matrix does **not** invoke a Nervelet Bridge or model reasoning. With `--live-jev`, the Jev arms make actual API calls; any agent startup remains simulated. A separate [policy job integration](policy-jobs.md) connects an actual Bridge to an independently running local policy. Native Luna/xhigh and Claude integrations remain opt-in; source-pinned real native trials are a subsequent qualification stage.

## Controlled variations

```powershell
# Remove startup delay for the routine and hybrid arms.
# This also sets the direct-agent arm's decision delay to zero.
npm run compare -- --agent-delay-ms 0 --output .runtime/experiments/warm.json

# Impair only the target tracker; sensing stays independent of inference.
npm run compare -- --sensor-latency-ms 300 --sensor-dropout 0.2 --output .runtime/experiments/impaired.json

# Probe decision-age sensitivity without pretending to measure models.
npm run compare -- --jev-delay-ms 900 --seeds 11,29,47 --output .runtime/experiments/slow-choice.json
```

`--seconds` accepts 1–60; `--seeds` accepts 1–8 distinct unsigned integer seeds; `--arms` selects a comma-separated subset. Each report is bounded to 900 total simulated seconds. `--max-calls` is a per-trial selection budget, including failed requests; pending requests never accumulate. Startup is a configured fixture delay, not an additional measured agent call. Sensor failures stop new selection and request local braking.

For an explicit real Jev trial, configure `TYPESAFE_API_KEY` and an explicit `JEV_MODEL` locally, then:

```powershell
npm run compare -- --live-jev --arms jev-local --seeds 11 --seconds 20 --max-calls 30
```

To load the local Git-ignored credentials file without printing its contents:

```powershell
node --env-file=.env.jev.local experiments/compare.ts --live-jev --arms code-local,jev-local --seeds 11,29,47 --seconds 28 --max-calls 120
```

The viewer calls offline Jev-shaped arms **Simulated fast selector** and actual service trials **Live Jev selector**. A real Jev trial does not imply a real Codex session; hybrid startup remains explicitly simulated until a native harness is attached.

Only selected Jev arms call the official API. They run against monotonic wall pacing, keep one request outstanding, reject over-deadline replies, and retain model identity and returned usage. The complete real request/answer and local admission are logged. Response-arrival latency and the delay before the control poll uses it are separate measurements. The trial fails without configured credentials/model; nothing silently changes provider. A programmatically injected transport is labeled injected evidence even when tested with wall pacing. Costs are unknown unless separately reconciled; offline calls/tokens/cost do not stand in for provider billing.

## Reading the evidence

The compact manifest is `.runtime/experiments/comparison.json`. Its `traceArtifact` links point to complete retained raw traces in a unique `traces/` directory. The manifest includes only the last 80 events per trial for quick viewing. **Load full trace** fetches one selected trial; exports distinguish summary and full trace. Runtime evidence stays out of Git. Retain a manifest together with its referenced trace directory when sharing or archiving a run.

The live cockpit is a bounded inspector for the current episode; resetting starts a new journal. It is not a durable run archive. Use the headless comparison artifacts for preserved experiment evidence.

The manifest records source hash (including controllers/integrations), Git revision/dirty status, Node/dependency versions, configuration, sensor definitions, seed, budgets and final-state hash. Every raw event has wall and simulation clocks. Explicit IDs join:

```text
sensor acquisition / delivery → observation → decision request / answer
  → selected candidate → local command → encoded MAVLink frame
  → vehicle command / receipt / job transition → measured world response
```

`experiment.command` records both the current guard observation and the original target acquisition used by a decision. Target measurements include their acquisition-time sensor origin: delayed relative positions must not be added to the robot's newer position. `experiment.wire.binding` joins the local command to the received wire command; it is host metadata, not a fabricated MAVLink ACK. Execution events are logged before acknowledgement, and radio messages are not consumed by telemetry. The journal reports dropped records and truncated payloads; a viewer preview is neither a dropped event nor complete evidence.

Metrics include whole-trial tracking RMSE and fraction within 2.5 m, collision contact starts excluding ground, commanded hold time, selection calls/discards, command admissions/rejections, input age and decision/physical reaction distributions. Hold time describes requested mode, not zero measured velocity. Ordinary physical braking takes time. Reaction has a declared operational criterion: after a lateral reversal, a command based on post-event target sensing and a velocity change of at least 0.15 m/s along the target's velocity change; occlusion uses braking below 0.1 m/s and subsequent resumption. A response not observed before trial end is null, never zero. Quantiles show their sample count and omit censored events; compare the observed/total count as well. These criteria are diagnostics, not proof of causality or mission success.

## What to test next

1. **Latency and negative controls — implemented.** Sweep startup, decision delay and sensing impairment. Reject the design if local routines unnecessarily wait for a model, or if unread execution events cause a halt. Use `--agent-delay-ms 0` for steady execution as well as the startup-inclusive default.
2. **Judgment under ambiguity — designed, not implemented.** Add occluded route choices and changing mission constraints, then freeze a competitive deterministic baseline and a held-out set of scenes. Give every judge the same feasible actions and actual acquired evidence. Compare correctness, abstention, unnecessary escalations and completed missions. A fast answer is useful only if it changes a decision for the better.
3. **When to wake the agent — designed.** Keep local tracking fixed and compare event thresholds against Jev's typed “routine sufficient / agent needed” decision. Measure missed recovery opportunities, wasted native turns, time to recover, and total task cost. Nervelet should wait on relevant events; it need not poll a model on every sensor tick.
4. **Swarm coordination — existing communication fixtures, new comparison pending.** Extend the same report schema to independent robots using actual delivered radio messages. Sweep partitions, latency, loss and bandwidth. Compare centralized control separately; never give an isolated controller the spectator map or another robot's undelivered state.
5. **Native and hardware qualification — separate.** Run actual Luna/xhigh, Jev and their composition at fixed 1× pacing, preserving private workspaces and one actuator writer. Then replace the simulated vehicle with PX4/ArduPilot SITL and the hardware adapter. MAVLink compatibility alone does not establish dynamics, perception, RF or aircraft safety.

The working hypothesis is that Nervelet coordinates mission-level sessions and receipts, local code keeps the robot responsive, and Jev supplies bounded judgment only where rules are insufficient. The [public Jev drone example](https://github.com/RomanSlack/jev-drone) uses a related split between fast local flight and a slower tactical selector; its reported results are not reproduced by this fixture. TypeSafe's [typed API](https://docs.typesafe.ai/api) supports constrained choices, but correct types do not establish correct decisions.
