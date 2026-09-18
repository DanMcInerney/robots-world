# First control-architecture results

Recorded 2026-09-17. **These are injected-delay experiments, not measured Jev or Codex performance.** All judges use the same deterministic choice rule. The experiment measures how a control architecture responds to delayed decisions; it does not measure reasoning, perception quality, model cost or native harness overhead.

Run the commands in [comparison.md](comparison.md) to reproduce the fixture. The default report is available through **Compare experiments** in the viewer.

## Conditions and results

Three paired seeds (11, 29, 47), 28 simulation seconds per trial, Rapier 0.20.0, Node 24.15.0 on Windows. All arms use identical sensing, candidate actions, guard, freshness limits and MAVLink codec path. The target reverses direction twice and disappears for two seconds. The default agent delay is an assumed 5 seconds; the Jev-shaped delay is an assumed 150 ms, consumed on a 100 ms control poll. Agent/routine startup is also an assumed 5 seconds.

Values below are arithmetic means of the three per-trial metrics, including startup. Lower tracking RMSE is better; within-radius time uses a 2.5 m threshold. A 1.2 m commanded stand-off means zero distance error is not the objective.

| Arm | Default RMSE | Default within radius | Impaired sensing RMSE |
| --- | ---: | ---: | ---: |
| Local code | 1.614 m | 97.9% | 1.800 m |
| Agent-shaped direct actions | 5.597 m | 3.1% | 5.722 m |
| Agent-shaped startup, then local routine | 2.284 m | 76.1% | 2.381 m |
| Jev-shaped local decisions | 1.791 m | 95.1% | 1.971 m |
| Agent-shaped startup, then Jev-shaped routine | 2.424 m | 72.5% | 2.521 m |

The impaired condition adds 300 ms tracker delivery latency and 20% sample dropout. It changes neither odometry nor the local guard. It remains a fixture, not a measurement of a particular tracking device.

Removing startup delay makes the local routine and local code produce identical final physical-state hashes for all three seeds. The same identity holds between the two Jev-shaped arms. The supplied routine is not authored by a native agent; its actual authoring time and success rate remain unmeasured.

All 42 trials retained their complete journals with zero dropped records and zero truncated payloads. No non-ground collision starts were recorded. That is weak evidence about collision avoidance in this open tracking scene. In the default matrix, the declared reaction criterion was met for 12/12 events per arm except direct actions (9/12); missing responses remain censored rather than zero-latency successes.

## Interpretation and next decision

This negative control favors ordinary local code. The useful architectural change is letting sensing and local execution continue while a slower agent is occupied. A capable DroneRTS-style routine already has that property; direct tool-by-tool control is only an ablation. Replacing an adequate local rule with a delayed model selector adds latency without adding judgment in this task.

The next experiment should freeze a competitive deterministic policy, then introduce ambiguous route choices or changing mission constraints that require judgment. Compare Jev, native Luna/xhigh, and their composition on the same admissible actions and acquired evidence. Measure correct decisions and completed tasks alongside response arrival, activation delay, recovery, calls and actual usage. Separately test whether Jev can decide when a Nervelet operator needs to wake. See the [scenario specifications](dronerts-comparison.md#paired-scenario-specification).

## Evidence identity

- Default: report `a7b5621ff1d44d7a`, archived as `.runtime/experiments/injected-2026-09-17.json` before the live trials replaced the viewer's latest manifest.
- Zero startup: report `4c1ecc055d1adec7`, `.runtime/experiments/warm.json`.
- Impaired tracking: report `6ccad97f9cad51a8`, `.runtime/experiments/impaired.json`.
- Base Git revision: `1e46827ff1c26b12c5bfb81a3053d97c7e604641`, with the experiment changes uncommitted at measurement time.
- Experiment source hash: `e3f49a0780c662c91492061478c75fe58f87925e370c2b75576e5b82aa37f015`.

Each manifest references separate full trace files. Keep those files together when archiving; runtime evidence is intentionally ignored by Git. This document records the observed summary and does not replace the raw evidence.

Separately, the 109-test suite passed with the explicitly configured sibling Nervelet build, including real Bridge integration against the Rapier tracking scene and policy lifecycle tests. The eight existing portability, articulation and radio regression scenarios passed. These establish the exercised software contracts; no live Jev request, native agent inference, DroneRTS gameplay migration or physical hardware trial was run.

That statement describes this initial offline batch. The subsequent [live Jev batch](jev-live-results.md) is separately measured and labeled.
