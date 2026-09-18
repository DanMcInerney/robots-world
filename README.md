# Robots World

A small robotics **control testbed**. Physics, sensors and radio keep moving while a controller thinks. Run one robot, a mixed workbench, or a swarm. Swap the controller without changing the world.

Read the [design principles](PRINCIPLES.md) for the platform's boundaries and rules for fair controller comparisons.

**[Jev Flight Lab](docs/jev-strategies.md)** compares eight real Jev control arrangements in a continuously changing world. Open **Jev Flight Lab** in the cockpit to compare flights and inspect exact instructions, observations, choices, probabilities and applied MAVLink commands.

Run `npm run compare` for the offline five-arm [Jev/agent control experiment](docs/comparison.md), then open **Compare experiments** in the cockpit for paired trajectories, timing, raw MAVLink and decision traces. [Local policy jobs](docs/policy-jobs.md) connect continuous controllers to a real Nervelet Bridge without adding framework dependencies to the world core.

The newer [English-mission experiment](docs/mission-comparison.md) compares actual Jev, native Claude and an asynchronous hybrid over the same drone controls, after tuning Jev's action menu. [Live results](docs/mission-results.md) report twelve headless flights and their raw evidence; no scripted mission policy competes in that experiment.

The [maneuvering and camera benchmark](docs/flight-comparison.md) expands this to parameterized XYZ movement, heading, pitch and zoom while following a moving vehicle through obstacles. It compares Jev, Claude, Codex Luna and a Codex/Jev hybrid; successful inspection depends on actual camera geometry, not an inspection macro.

[Expanded-control results](docs/flight-results.md) record the completed twelve-flight pilot. [Jev game-controller research](docs/jev-game-patterns.md) examines StarCraft, Doom, Mario and other source repositories, including the assistance their code supplies and the next experiment designs it motivates.

The [continuous changing-world experiment](docs/reactive-comparison.md) tests actual Jev and native model decisions with changing rover motion, a moving obstacle, delayed/noisy sensors, an impaired command link and new English goals during flight. All candidate consequences are computed from delivered observations; no scripted mission controller competes.

[Actual results from 24 attempts](docs/reactive-results.md) separate response speed, brief goal attainment, sustained framing, collisions, early termination and the effect of Codex advice.

[Reactive experiment corrections](docs/reactive-v3.md) fix command timing and controller failure handling, expose continuous controller ports, declare sensor assumptions and add a predeclared sustained-framing score. These changes have offline regression evidence; the earlier model results retain their original source and scores.

```sh
npm ci
npm run dev
```

Open the viewer URL printed in the terminal (port 8870, with its local bootstrap token). The initial workbench uses a scripted controller and no paid inference. The upper half is a Three.js inspector; the lower half shows controller activity, protocol bytes, sensor readings, jobs and radio traffic. Select a robot to inspect its data. Stop revokes control immediately; pause freezes simulation time for inspection.

Node 24 or newer is required. Run `npm test`, `npm run typecheck` and `npm run build` to verify changes. Runtime credentials, traces and generated experiment results live in ignored `.runtime/`.

## Six pieces

| Piece | Owns | Replace with |
| --- | --- | --- |
| World / physics backend | Time, bodies, joints, forces, contacts, rays | Rapier, included kinematic backend, external simulator adapter |
| Robot model | Links, actuators, command schema, local servo | Drone, rover, arm, supported humanoid, custom asset |
| Sensor | Mounted acquisition with independent rate, latency, noise, dropout | Odometry, gyro, lidar, depth rays, contacts, joints, your plugin |
| Robot port | Observe, command, acknowledge, send, stop | In-process world, HTTP client, device adapter |
| Controller | Decisions using explicitly assigned ports | Code, Codex, Claude Code, Nervelet, Jev, your library |
| Communication medium | Addressed, bounded datagrams | Impaired simulated radio, hardware transport |

The core imports no native harness or renderer. Plugins are ordinary TypeScript objects registered in maps. There is no planner, workflow runtime, memory database, training framework, or mandatory AI dependency in the world.

## Start an experiment

```sh
npm run experiment -- --scenario swarm --seconds 20 --seed 42
npm run experiment -- --scenario portable --physics kinematic --seconds 10
```

The [experiment guide](docs/experiments.md) explains controls and recorded evidence. Run external controllers against an already running host; see [controller integration](docs/research-controllers.md) and `npm run agent -- --help`. Native inference is explicit opt-in and requires an authenticated native harness. The requested Codex default is `gpt-5.6-luna` at `xhigh`; the driver verifies availability instead of silently substituting a model.

For a real binary MAVLink connection to the simulated drone, explicitly start its local UDP adapter:

```sh
npm run mavlink -- --robots drone-1 --listen 14550 --peer 14551
```

The peer must bind 127.0.0.1:14551 and address system1/component1. Position and velocity setpoints use `SET_POSITION_TARGET_LOCAL_NED`; send them continuously within the 1-second watchdog. Raw frames and decoded fields appear in the cockpit. See [supported messages and limitations](docs/research-network.md).

## Extend it

Start with [the small contracts](src/contracts.ts), [design](docs/design.md), and [extension examples](docs/extending.md). Scenarios are ordinary data in [scenarios/index.ts](scenarios/index.ts); sensors can differ for every robot. The generic asset helper creates primitive link/joint assemblies, and a custom model can supply any actuator behavior through the same contract.

A controller only receives its assigned robots' observations, installed sensors and delivered messages. The dashboard and experiment evaluator may inspect world truth. Sharing one controller across several ports is an explicit centralized experiment; the swarm demo creates a separate policy instance for each robot and communicates through radio.

## Scope and evidence

This is a software integration laboratory, not a claim of universal physical fidelity. Rapier provides rigid bodies, collisions and motorized joints. The drone uses an idealized acceleration servo; the rover has simplified planar motion; the humanoid is a supported articulation fixture, not a walking robot. The kinematic backend intentionally rejects unsupported dynamics and joints. Depth uses geometric rays, not RGB or photorealistic vision.

MAVLink uses actual binary framing and an optional UDP endpoint. It is a small supported-message facade, not PX4/ArduPilot SITL or a flight controller. Simulated radio models application-visible impairments, not Wi-Fi propagation, DDS discovery, interference or a MAC. Controller code can reuse `RobotPort` against hardware, but a hardware adapter, actuator safety, calibration and independent qualification are still required. Native model performance and hardware behavior are not established by mock tests.

See [research decisions](docs/research.md), [Jev experiments](docs/jev.md), and [qualification](docs/qualification.md).
