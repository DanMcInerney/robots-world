# Expanded drone-control pilot: real inference

Recorded 17 September 2026 US Eastern / 18 September UTC. **No arm completed the side-inspection task.** Jev returned decisions much faster, but speed did not produce success under this representation. This does not establish a general winner between models or qualify hardware control.

## Frozen design

See [the experiment contract](flight-comparison.md). Four arms each flew paired seeds 101/202/303 for 45 seconds against continuously advancing physics. Outputs included position/velocity XYZ, heading, camera pitch, zoom and duration. Jev had up to 120,960 nominal combined discrete settings, while native models could supply continuous numeric arguments within bounds. There was no inspect/follow macro and no scripted competing mission policy.

Two development iterations tested axes versus complete XYZ-vector menus on seeds 11/12. The final iteration gave every model the same geometry derived from delivered sensor/beacon data. Vector menus won the declared development ranking: 29.65% mean visibility versus 0.25% for axes, with zero versus 600 collision ticks; neither inspected the target. This is limited prompt/menu development, not exhaustive optimization.

Final source SHA-256: `d4d32cd6a1b066dc14414bd3d63abe64084f44926d32b78c71901fc50d74ea80`. Development and held-out manifests match. Earlier smoke/qualification runs and development results are excluded from the table.

## Held-out results

Latency percentiles pool completed, validated decision responses within each arm. Visibility averages the three episodes, excluding the five-second startup window. Calls still pending at the end are censored, not zero-latency responses. The hybrid latency column measures its Jev lane.

| Controller | Success / inspections | Mean visible | Decision p50 / p95 | Accepted commands | Contact time |
| --- | --- | --- | --- | --- | --- |
| Jev 1.13.0 | 0/3 / 0/3 | 33.12% | 254 / 495 ms | 177 | 0 s |
| Native Claude Code, Opus 5 / low | 0/3 / 0/3 | 31.85% | 4,886 / 8,209 ms | 22 | 3.20 s |
| Native Codex, Luna / xhigh | 0/3 / 0/3 | 13.52% | 31,576 / 42,355 ms | 1 | 0 s |
| Jev + asynchronous Codex proposals | 0/3 / 0/3 | 28.20% | 272 / 678 ms | 174 | 0 s |

Contact time sums 20 ms physics ticks with contact; it is not a count of separate crashes. All arms had zero boundary violations. Every completed control selection used position mode, despite velocity, hold and continue being available.

Jev completed 177/177 calls. Claude completed 22/25; three were cancelled at episode end. Codex completed 3/6; two were rejected by the common 30-second observation-age ceiling and three remained pending at the deadline. Its accepted command came from seed 101, after approximately 23.3 seconds. Do not read its completed-response median as steady-state throughput: there was only one completion per episode.

The hybrid started one Codex proposal request per episode. **None finished within its 45-second flight**, so zero proposals were offered or used. It therefore did not test whether useful completed Codex advice improves Jev. Two Jev responses failed selected-answer probability validation, and one was pending at the deadline. The previous setpoint continued until expiry; no substitute mission action was chosen. Raw error responses remain in the trace.

Maximum recorded world pacing lag was 8.71 ms, below the one-second invalidation threshold. All twelve traces ended with `trace.complete`; sensor acquisition and radio delivery continued through inference. This verifies simulator timing for these runs, not a real-time OS or flight controller.

## Interpretation and limits

The latency gap is clear in this configuration. Mission competence is not. Jev's visibility and Claude's visibility were close on average, all inspection dwell counters remained zero, and three seeds cannot support a robust ranking. Jev often repeatedly selected the same position and camera settings. Candidate count alone did not help it compose a successful maneuver.

These native sessions used structured action output without authored scripts/routines. This measures a restricted numeric decision layer, **not the full DroneRTS or Nervelet controller**. Model/reasoning settings also differ intentionally. Ideal camera detections, cooperative target beacons, simplified acceleration servos, 750 ms minimum request spacing, short episodes and numeric quantization all constrain what can be inferred.

The [game-controller research](jev-game-patterns.md) motivates a better next comparison: describe candidate consequences, test coherent conditional maneuvers, and have Codex prepare a reusable policy whose lifetime is longer than one observation. That proposal has not been tested by this batch.

Cost is incomplete. Completed Jev-only responses reported 2,567,203 input tokens; the hybrid's validated Jev responses reported 2,516,617. These omit failed/cancelled response usage. Claude's last cumulative SDK cost reports sum to about $1.0213 across its three flights, excluding any unreported interrupted usage. Codex cost was unavailable. Zero-initialized cost/token fields in aggregate records must not be interpreted as free inference; native usage events are retained separately where supplied. These figures are not invoices or comparable total costs.

## Inspect and reproduce

Local ignored evidence lives under `.runtime/experiments/flight-held-out-v1/`: source/tuning manifest, aggregate and per-flight JSON, full per-flight JSONL and `replay.json`. Credentials and runtime evidence stay out of Git. The [replay generator](../experiments/flight-report.ts) requires completed traces and does not rescore the runs.

With the local server running, open `/flight.html?report=/.runtime/experiments/flight-held-out-v1/replay.json`. Select a seed and scrub all four arms together. Each card has a world view, geometric onboard-camera replay, and selectable decision, MAVLink, camera-sensor and radio records. Models received structured detections, not those rendered camera images. Complete raw requests/responses remain in JSONL beside the replay.

Validation: 116 offline tests passed, three optional tests skipped; TypeScript checking and the production build passed. Browser checks cover loading all four arms, synchronized scrubbing, seed changes, playback and raw-data selection. The build retains the existing large Three.js chunk warning. The live trial source remains frozen; documentation and replay presentation can change independently.
