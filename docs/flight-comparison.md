# Maneuvering and camera control experiment

This supersedes the seven-action mission pilot for questions about control complexity. It does not supersede its recorded results. There is no `inspect`, `follow`, target-aiming skill or scripted controller competitor in this experiment.

## Task and boundary

A moving rover broadcasts its measured position, heading and velocity through the simulated radio (100 ms delay, 20 ms jitter, 2% loss). The drone must follow it, navigate around solid obstacles, keep it visible and inspect the requested physical side. Seed controls world orientation and requested side; every drone starts on the opposite side. The target stimulus follows a hidden route and turns during flight. It is environment behavior, not a competing controller.

Every controller can select position or velocity XYZ, hold or continue, absolute heading, camera pitch, wide/zoom field of view, and command duration. Body heading and camera pitch slew at finite rates; translation uses the existing simplified acceleration servo. Position commands do not find routes. There is no automatic target following, aiming or collision avoidance. Velocity components are bounded to 2 m/s and total speed to 2 m/s. The world uses ENU with heading 0 east / +90 north; this differs from DroneRTS's coordinate convention.

Movement goes through actual MAVLink v2 bytes, dialect CRC parsing and the leased RobotPort. Camera fields use local JSON combined at that same leased command boundary. **This does not implement MAVLink gimbal messages, UDP transport, PX4, rotor dynamics or real hardware.**

The reusable optional [aimed camera device](../src/devices/aim-camera.ts) implements pinhole projection, field-of-view gating, ray occlusion, finite heading/pitch slew and zoom. It produces ideal semantic point detections, not RGB imagery. Models receive identical dated odometry, camera detections, horizontal range rays, contacts and delivered beacon messages. Geometry derived from those delivered samples supplies range, bearing, elevation and the drone's offset in the rover frame. It neither reads future motion nor chooses a route, side or action. Stale beacon geometry expires after one second.

The evaluator alone reads current simulator truth. Inspection requires: correct side cosine >= 0.7, distance 2.5–6 m, unobstructed target centre in the central half of both image dimensions, continuously for one second. Full success additionally requires >=50% camera visibility and >=70% time within 10 m after a five-second startup window, zero collision ticks, and zero altitude/boundary violations. These thresholds are given in the English mission before inference.

## Contenders and Jev option design

| Arm | Decisions |
| --- | --- |
| Jev | Jev 1.13.0 chooses discrete control arguments each cycle |
| Claude | Persistent native Claude Code, Opus 5 / low, generates numeric arguments |
| Codex | Persistent native Codex, gpt-5.6-luna / xhigh, generates numeric arguments |
| Hybrid | Jev acts continuously; asynchronous Codex Luna / xhigh proposes complete numeric maneuvers |

Native sessions use structured action output and no authored scripts or routines. This compares parameterized control decisions, **not unrestricted DroneRTS harnesses or the Nervelet bridge**. Nervelet is unchanged. All contenders share plant, sensing and command semantics. Native numeric freedom versus Jev quantization is an explicit architectural difference, not a claim of identical output representations.

Jev's [Choice interface](https://docs.typesafe.ai/primitives/choice) accepts up to 255 options per question; [parallel questions](https://docs.typesafe.ai/patterns/fan-out) are independently evaluated. We test:

- **Axes:** separate XYZ questions for position and velocity, plus mode, heading, pitch, zoom and duration: eleven parallel questions.
- **Vectors:** two conditional questions containing complete XYZ vectors (up to 125 each), plus the same five remaining questions: seven parallel questions.

Both encodings cover the same grid: five velocity values per axis (-1.2, -0.4, 0, 0.4, 1.2 m/s); five generic position offsets per axis, clipped to bounds; ten heading options relative to current measured heading; eight absolute pitch options; two zoom levels; three lifetimes. That is up to 120,960 nominal combined settings including hold/continue. The grid does not inspect goal meaning, target position or obstacles. Its finite resolution and four-metre horizontal position reach per decision remain simplifications. Native agents may choose intermediate numbers or more distant waypoints within bounds.

All speculative answers are logged. Only answers actually used by the selected mode must pass execution validation; unused branch answers cannot invalidate an unrelated command. Probability rounding deviations are recorded without renormalizing raw values. A malformed selected answer produces no substitute mission action.

The hybrid adds up to four complete model-authored maneuvers plus an option to use Jev's independent controls. Proposals expire 12 seconds after their source observation, including time spent generating them. They are never silently refreshed or automatically executed. Jev retains the original goal and fresh observations. Expired proposals, selection frequency and time spent without proposals are recorded.

## Timing, evidence and reproduction

Physics advances every 20 ms against wall time. Sensor acquisition, target motion and radio delivery continue during inference. Each decision lane has one outstanding request, with a 750 ms minimum request interval. Actuation sources older than 30 seconds are rejected uniformly; this generous ceiling lets the test measure the consequences of slow decisions rather than rejecting every slow response. Setpoints expire after the model-selected 0.5–8 seconds. No automatic retry is performed. Stop revokes the robot before joining native sessions.

Development seeds 11/12 compare encodings in rotated order. Ranking is declared before execution: complete successes, then completed side inspections, then mean visibility, then fewer collision ticks, then p95 latency. Source hashes freeze the selected implementation before held-out seeds 101/202/303. Each held-out episode lasts 45 seconds; arm order rotates per seed. This is a small pilot, not statistical qualification.

Use Node 24+, the ignored `.env.jev.local`, authenticated native harnesses and explicit executable paths in `ROBOTS_CLAUDE_EXECUTABLE` and `ROBOTS_CODEX_EXECUTABLE`. These commands perform real inference:

```sh
node --env-file=.env.jev.local experiments/flight-run.ts --phase development --output .runtime/experiments/flight-development-v2
node --env-file=.env.jev.local experiments/flight-run.ts --phase held-out --tuning .runtime/experiments/flight-development-v2/tuning.json --output .runtime/experiments/flight-held-out-v1
node experiments/flight-report.ts .runtime/experiments/flight-held-out-v1
```

Directories must be new: traces use exclusive creation. Outputs contain per-run JSON and complete bounded JSONL records: request inputs, provider responses and usage when supplied, model identities, decisions, source ages, receipts, protocol bytes, acquired sensors, radio delivery, current geometry and trajectories. Private reasoning is not requested or fabricated. Interrupted requests have incomplete usage and are counted separately. Harness-reported cost is not an invoice.

Offline checks: `node --test test/flight.test.ts`. Repository checks: `npm test`, `npm run typecheck`, `npm run build`. No API calls occur in the default test suite. The [principles](../PRINCIPLES.md) keep these scenario/controller choices outside the world core.
