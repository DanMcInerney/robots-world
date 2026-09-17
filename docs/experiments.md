# Headless control experiments

Run from the project directory with Node 24 or newer. These commands use deterministic scripted policies and make no model API calls:

```powershell
npm run experiment
npm run experiment -- --scenario swarm --seconds 20 --seed 42 --loss 0.3 --latency-ms 200
npm run experiment -- --scenario single --controller-delay-ms 1500
npm run experiment -- --scenario portable --physics kinematic
npm run experiment -- --matrix
```

The default run is 20 simulated seconds. `--seconds` accepts 0.2–120 seconds. Scenarios are `single`, `mixed`, `swarm` and `portable`; backends are `rapier` and `kinematic`. Capability checking rejects unsupported combinations such as a physical articulated arm on the minimal kinematic backend. `--output` can select a JSON evidence file; the default is ignored `.runtime/experiments/latest.json`, or `matrix.json` for the matrix.

## The controller boundary

`DemoPolicy` imports the `RobotPort` type and receives one scoped port. It has no world, physics, renderer or other robots' observations. It discovers commands from the robot description. Mobile robots navigate a small square relative to their first valid odometry measurement. Articulations use the joint command's advertised names and limits. Missing or stale odometry leads to a hold command.

In swarm mode the leader broadcasts its acquired odometry position. Each follower uses only its own odometry and valid messages actually delivered through its radio. Followers track different offsets from the latest beacon and hold after the beacon expires. This is a decentralized communication/control example, not a collision-avoidance or formation-control algorithm. The evaluation process can inspect physical truth to measure outcomes; it never supplies that truth to the policies.

Controllers are polled about every 50 simulated milliseconds and make decisions every 500 milliseconds. `--controller-delay-ms` schedules decision application later in simulation time, retaining the original observation reference. It does not pause physics or sleep for wall time. Pending decisions expire against a 1,000 ms observation-age budget. Hold is an immediate local fallback. This isolates latency semantics; it does not benchmark a real model's speed or concurrency.

## Current matrix

The matrix contains eight asserted eight-second trials, using seed 42:

| Trial | Assertion |
| --- | --- |
| Portable fixture / kinematic | A port-only controller moves the fixture. |
| Portable fixture / Rapier | The same control code moves the fixture on the second backend. |
| Single drone | Commands apply and the drone progresses along its route. |
| Mixed robots | Drone, rover, arm and supported humanoid articulation run with finite state and no hidden runtime fault. |
| Connected swarm | Every follower receives actual leader beacons. |
| Complete radio loss | No beacon arrives and followers hold position. |
| Expired packets | Excessive latency prevents delivery before TTL; followers hold position. |
| Stale inference | Delayed decisions are rejected while the world continues advancing. |

The integration tests additionally disconnect a working swarm and check that each follower stops after previously received beacons expire. Core tests cover independent sensing during blocked inference, robot isolation, exclusive ownership, revocation, command deduplication, stale observations, watchdog expiry, explicit event/inbox acknowledgement, backpressure, empty sensor configurations, and repeated recorded control input on both physics backends.

## Evidence and interpretation

Each result contains the complete scenario, seed, configuration hash, source hash, Git revision/dirty marker, Node and dependency versions, accepted command/application ticks, observation deliveries, delivered sensor readings, radio events, bounded journal coverage, and a final physical-state hash. Trace records preserve simulator timestamps separately from wall timestamps. They are evidence for diagnosis; a trace replay UI and arbitrary external-controller replay loader are not implemented.

Metrics include per-robot root displacement and path length, retained job statuses, policy command/rejection/hold/beacon counts, radio delivery/loss totals, and collision contact starts excluding the ground. Articulated robots have fixed roots, so root distance intentionally does not measure manipulation success. Add task-specific evaluators rather than treating distance or command acceptance as universal success.

The matrix is a smoke/regression suite for software contracts. It is not evidence of flight accuracy, autonomous navigation robustness, humanoid locomotion, real wireless behavior or hardware qualification. The radio is a bounded datagram impairment model, not Wi-Fi or DDS. The portable fixture checks interface portability, not physical equivalence between engines.

Next useful experiments are paired seed sweeps for sensor age versus decision age, equal-cost controller comparisons, radio partitions and recovery, sensor failures during motion, heterogeneous robot teams, and mixed slow/fast native agent sessions. Keep controller outputs and arrival times when testing nondeterministic inference; a scenario seed alone does not reproduce an external model run.
