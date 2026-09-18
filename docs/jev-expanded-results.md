# Jev expanded-control results

Recorded 18 September 2026. These are real `jev-1.13.0` calls in Robots World, using a simplified stabilized drone and simulated geometric sensors. They do not qualify physical hardware or compare Jev with a native agent.

The [documentation audit and protocol](jev-docs-audit.md) distinguish API limits, local stabilization, derived geometry, independent control questions and the limits of the old benchmark.

## Completed original matrix

[Open the eight-strategy report](http://127.0.0.1:8870/jev.html?report=/.runtime/experiments/jev-strategies-resumed-v1/report.json). All eight arms now have four sixty-second flights, on seeds 701–704. The nine original non-billing flights were retained byte for byte, and 23 flights were run after funding. The three original billing-blocked attempts remain in the linked original report. This comparison is conditional on service availability; it does not erase those failures from the operational history.

The completed matrix contains **4,569 completed decisions** and **107,943,619 reported input tokens**. All 32 full traces passed the sensor/request/action/timing audit. There were no provider/controller errors or delivery-guard interventions in these 32 flights; collisions and failed goals were retained.

| Arrangement | Passes / 4 | Mean correct framing | Decision p50 / p95 | Applied sensor age p50 | Contact seconds |
| --- | --- | --- | --- | --- | --- |
| Raw controls | 0/4 | 2.6% | 261 / 411 ms | 440 ms | 18.68 |
| Complete choices + facts | 0/4 | 12.4% | 348 / 552 ms | 540 ms | 0.66 |
| Plain-language choices | 1/4 | 23.7% | 311 / 461 ms | 500 ms | 8.18 |
| Independent movement / camera | 0/4 | 16.9% | 343 / 587 ms | 520 ms | 6.50 |
| Speculative camera branches | 0/4 | 28.9% | 329 / 490 ms | 520 ms | 0.00 |
| Movement, then camera | 0/4 | 34.8% | 551 / 751 ms | 740 ms | 7.08 |
| Jev scores, then chooses | 0/4 | 30.8% | 571 / 734 ms | 760 ms | 0.00 |
| One-second maneuvers | 0/4 | 6.9% | 379 / 555 ms | 560 ms | 0.00 |

Framing averages the two phases equally within each flight, then the four flights equally. A pass requires ≥50% in **each** phase, at least one continuous second, and no collision/boundary/controller/guard failure. Contact seconds count simulation time in contact, not independent collision events. Latency medians pool completed decisions, not flights; slow arms therefore complete fewer decisions.

**Only one of 32 flights passed**, the previously reported prose run on seed 701. All three additional prose flights failed. Prose also changes range-state compression, so its one pass cannot be attributed solely to language. The highest mean framing arm still failed every full mission. Parallel calls were faster than the two-stage arrangements, but speed did not establish reliable goal tracking.

The controller/physics freeze remained `8aad5bf6d3dd7966eb83099bd825383bfc0aeaaeeacdb70bc6945dae4e410ed7`. The continuation executed its archived source. The funding interruption also separates the original and resumed service sessions in time; this is an exploratory paired-seed comparison, not a tightly controlled latency benchmark.

## Six independent controls: geometry ablation

[Open the six-control report](http://127.0.0.1:8870/jev.html?report=/.runtime/experiments/jev-axes-held-out-v1/report.json). Six new sixty-second flights on paired seeds 951–953 used six Choices in one call, representing 43,218 joint tuples. Both arms used identical full option sets, sensor/feedback schemas and timing. Only the added derived current geometry differed. There was no automatic aim, candidate forecast or code-selected replacement action.

The pilot completed **1,490 decisions** with no API/controller errors or delivery-guard interventions. All six traces passed the audit, including recomposition of each command from its six model answers, port observation/receipt provenance, paired exogenous trajectories and actual application timing.

| Treatment | Passes / 3 | Correct framing | Rover visible | Decision p50 / p95 | Applied sensor age p50 | Rejected commands | Contact seconds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Six controls / measured sensors | 0/3 | 0.95% | 7.55% | 209 / 295 ms | 360 ms | 6 | 20.56 |
| Six controls / derived geometry | 0/3 | 0.64% | 50.35% | 226 / 322 ms | 380 ms | 4 | 15.72 |

Visibility is a geometric camera measure, not the rate of received detections, central framing or correct viewing position. Derived geometry raised visibility in all three pairs, but neither treatment completed a mission. The raw-state controller averaged 0.95% correct framing; the geometry controller averaged 0.64%. Both collided on seeds 952 and 953. These small samples do not establish a reliable controller or show that geometry is generally worse for mission completion.

| Seed | Raw framing, goal 1 / goal 2 | Geometry framing, goal 1 / goal 2 | Raw / geometry visibility |
| --- | --- | --- | --- |
| 951 | 0.00% / 0.00% | 0.00% / 0.40% | 10.08% / 43.28% |
| 952 | 0.00% / 0.00% | 1.68% / 1.76% | 0.00% / 70.68% |
| 953 | 5.68% / 0.00% | 0.00% / 0.00% | 12.56% / 37.08% |

The two twenty-second development flights used seed 85 and completed 160 decisions with zero API/controller errors. Both failed the primary mission score; both representations were retained. Development was used to qualify the interface, not to choose a winning arm.

A concrete developmental failure is visible in `jev-axes-development-v1/decisions/axes-geometry-85-0000.json`: camera heading was 90 degrees and measured target bearing was 161.47 degrees, yet Jev chose a −15 degree increment, mapping to a 75 degree setpoint. That turns away from the measured bearing. The mapping is correct; the model decision is inspectable. This example motivates a separate camera-relative semantic-state test, not a retroactive edit to these results.

The controller/physics freeze was `d506e2dd7b3ce835e7df055803da2e358648a0d0b9d44a32fa39f8ffbd739f20`. After the first full held-out flight, the reporter falsely rejected a rounded timestamp: 32440 ms versus the original 32439.999999999996 ms. The corrected audit checks original timestamps and independently reconstructs rounded presentation. A regression still rejects truly future receipts. The first flight was retained byte for byte; the other five executed archived frozen code. The local evidence includes `continuation-source.ts`, `reporting-source.ts` and explicit manifest annotations.

A separate reporting correction clarifies the existing camera plant: yaw gain 4 with a 120 degree/second limit, pitch slewing at 90 degrees/second, and instantaneous zoom. The original manifest's blanket “immediate camera settings” wording was inaccurate. These numerical rates were absent from Jev's model inputs and are a declared limitation. No physics, model prompts, options or scoring were changed between held-out flights.

The six held-out flights reported **10,719,584 input tokens**; the two development flights reported **1,143,001**. Together with the new continuation flights, this turn used approximately **90.78 million reported Jev input tokens**, about **$3.81** at the [currently documented $0.042 per million input tokens](https://docs.typesafe.ai/models). This excludes the reused original calls, and is an estimate, not an invoice; cancelled/failed calls may have unreported billing.

## Interpretation

The API supports large factored command spaces at low latency. That is established by actual requests here. Reliable numerical control and coordinated goal tracking are not established. The geometry ablation changed camera visibility, so an unchanged pass/fail score would have missed its effect.

These representations still ask Jev to interpret absolute angles and coordinate frames. Its documented mathematical weaknesses suggest testing computed camera-relative offsets and directional descriptions next, with new seeds and an identical actuator contract across treatments. This is a hypothesis, not a measured improvement. The local servo remains responsible for fast stabilization; Codex could supply goals or reusable instructions asynchronously, but no native-agent hybrid was evaluated in this round.

The richer pilot is not a controlled performance comparison against the older 212-bundle experiment: its seeds, speeds, camera controls and state differ. Neither result should be used as a general Jev-versus-Claude ranking.
