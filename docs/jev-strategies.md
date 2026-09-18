# Jev strategy experiments

This experiment tests **how to present a changing robot-control problem to Jev**. Jev reads the current English goal and delivered sensors, chooses a maneuver, and the harness submits that exact maneuver to the simulated drone. There is no scripted mission competitor, automatic pursuit, route planner, continuously tracking camera, or hidden goal reward used to choose actions.

Open **Jev Flight Lab** in Robots World, or `/jev.html?report=/.runtime/experiments/<batch>/report.json`. The report pairs flights, replays their world and geometric camera views, and exposes exact API requests and responses for each decision. Jev supplies typed answers, confidence and probability distributions; it does not supply a reasoning transcript. The diagnostic candidate inspector can show geometry that a raw-control request did not include; the **exact API request** is authoritative.

## Why these arrangements

[Jev's questions run independently](https://docs.typesafe.ai/introduction), including when they share a request. One question cannot use another's answer unless the application makes another request. [Choice](https://docs.typesafe.ai/primitives/choice) selects from up to 255 supplied options **per question**, and recommends a full list rather than a shortlist. Multiple questions can represent a much larger joint action space. [Score](https://docs.typesafe.ai/primitives/score) judges a concrete candidate against described levels. Question IDs are routing identifiers, not model instructions, so candidate-specific score instructions include the candidate itself. The [documentation audit and six-control ablation](jev-docs-audit.md) explain the current context limits and the limitations of these original strategies.

[The model's documented weaknesses](https://docs.typesafe.ai/model-jaggedness/jev-1.13) include arithmetic, indirect references and ambiguous instructions. Computing geometry from received measurements is therefore a meaningful representation experiment. It must be distinguished from choosing a route or calculating a mission reward in software. [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) provides another useful arrangement: ask conditional questions together, then execute only the selected branch.

| Strategy | Jev arrangement | Experimental difference |
| --- | --- | --- |
| Raw controls | One complete-maneuver Choice | Raw dated sensors and velocity/camera settings |
| Complete choices + facts | One complete-maneuver Choice | Adds generic estimates from received measurements |
| Plain-language choices | One complete-maneuver Choice | Describes those estimates in sentences; rounds state and omits raw range points |
| Independent movement / camera | Two parallel Choices | Questions cannot coordinate their decisions |
| Speculative camera branches | Camera Choice plus four conditional movement Choices | One round trip, more questions, selected branch only |
| Movement, then camera | Movement Choice followed by camera Choice | Two round trips; original observation stays dated |
| Jev scores, then chooses | Score every movement; Choice over all camera variants of the top six movements | Model does the ranking; ties use stable lexical IDs |
| One-second maneuvers | Complete Choice + facts | Shorter command/forecast lifetime; feasible menu also changes |

The full menu is hover plus 26 normalized XYZ directions at two speeds, combined with four camera options: at most 212 bundles. Only capability and conservative flight-envelope checks remove options. Obstacles and the English goal cannot alter the menu or its order. Camera options set absolute angles once, including angles calculated toward the measured, extrapolated target. This is a disclosed convenience, not raw yaw/pitch motor control.

## Protocol

All strategies retain range returns at millimetre precision to fit the API context; original unrounded samples remain in the trace. The prose strategy additionally removes the point cloud and summarizes clearance. Rounded probability tables are validated with a one-percentage-point argmax tolerance: development observed a returned choice at 0.14 beside an alternative at 0.15. This discrepancy is retained, not replaced with a code-selected action. Larger discrepancies fail the controller.

Development flights check interface mechanics before freezing source and configurations. The held-out matrix uses eight strategies, four new seeds, and sixty seconds per flight. Strategy order rotates by seed. Flights run serially to avoid creating artificial API contention. Physics and sensor acquisition advance at 50 Hz against wall time; inference never freezes the world. Every strategy has the same 200 ms minimum refresh interval and a 300-decision bound.

The rover turns unpredictably from private seeded state. A moving obstacle crosses the scene, observations have noise and delay, target broadcasts have loss and a blackout, and the English goal reverses midway through flight. No controller receives future events, evaluator state, or perfect target truth. Paired runs must have identical target and obstacle trajectories. Sensor readings differ when the drone visits different positions.

The primary score requires the requested viewing side, 2.5–6 metre distance and central-half image framing together for at least 50% of **each** phase after a five-second warm-up, including a continuous one-second dwell. Collisions, boundary breaches, controller failure and delivery-guard intervention prevent a pass. Short attainment, visibility, response latency and framing percentages remain separate measurements.

Provider errors invalidate the controller's authority, cause explicit local hold, and leave the world advancing for the rest of the flight. Expired commands also enter hold. There is no automatic retry or substitution. HTTP 402 stops the batch after the failed flight finishes in hold; adding credits and resuming requires an explicit new run. Rejected stale answers remain recorded. The simplified local hold brakes immediately; this is not a realistic emergency stopping model.

## Evidence and reproduction

With an explicitly configured local credential and fresh output directories (existing evidence is never overwritten):

```sh
node --env-file=.env.jev.local experiments/jev-strategies/run.ts --phase development --seeds 81 --seconds 20 --output .runtime/experiments/jev-strategies-development-new
node --env-file=.env.jev.local experiments/jev-strategies/run.ts --phase held-out --seeds 801,802,803,804 --seconds 60 --freeze .runtime/experiments/jev-strategies-development-new/freeze.json --output .runtime/experiments/jev-strategies-held-out-new
```

The runner creates exclusive attempt files, a source snapshot, immutable raw JSONL traces and a small report index. Decision files load on demand instead of embedding all raw requests in one enormous page. Reporting and audit can run without inference:

```sh
node experiments/jev-strategies/report.ts .runtime/experiments/jev-strategies-held-out-new
```

The audit reconstructs each initial request from its original delivered sensors, checks menu identity, checks multi-stage observation provenance, matches executed actions to offered actions, verifies trace continuity and command expiry, and compares seeded environmental motion. Wire records are labeled with their capture interval; applied commands are separately correlated by command ID. Raw traces preserve the full sensor/protocol journal.

API input tokens come from received responses. Cancelled or failed calls can have unknown billing; reported usage is not an invoice. The batch stops before another flight once 500 million reported input tokens have accumulated, with a bounded in-flight overrun. [TypeSafe's launch price](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is $0.042 per million input tokens with free output; any displayed estimate must be labeled with that assumption.

All generated evidence and credentials stay under ignored local paths. Do not edit experiment/core/controller source during a frozen batch. Keep development failures and previous batches; never overwrite an unfavorable run.

## Boundaries

This uses real Jev inference and actual MAVLink encoding/decoding in a simplified simulation. It does not qualify a real drone, raw attitude control, PX4, RGB perception or decentralized swarms. Camera angles travel as dated local JSON alongside the MAVLink velocity setpoint. Four seeds provide an exploratory comparison, not a general model ranking.

Robots World remains controller-neutral: these strategies and reporting tools live under `experiments/`; the platform's [principles](../PRINCIPLES.md) and [RobotPort contract](design.md) remain unchanged. Nervelet can host a fast controller while a native agent plans or revises instructions separately; this batch specifically isolates the Jev decision arrangement and runs no native agent in the reaction loop.
