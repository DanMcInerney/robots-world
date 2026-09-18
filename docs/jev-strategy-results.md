# Jev strategy results — interrupted by exhausted API credits

Recorded 18 September 2026. This is an **incomplete exploratory comparison**, not the planned four-seed ranking.

Open [Jev Flight Lab](http://127.0.0.1:8870/jev.html?report=/.runtime/experiments/jev-strategies-held-out-v1/report.json) in a running local Robots World server. Select a seed and two strategies, then select a decision. The cockpit shows the exact English goal, questions, offered choices, model probabilities/scores, original and presented sensors, and command admission/application. Expand a pane for readable raw JSON. Each flight has its own goals and scoring record.

## What ran

The planned matrix was eight arrangements × four new seeds × sixty seconds. Before TypeSafe returned HTTP 402 (`billing_error`, no available credits), **nine full flights completed with real inference**, producing **1,223 complete maneuver decisions** from **1,411 received API responses**. They contain no controller errors, collisions, boundary breaches or delivery-guard interventions. This does not establish reliable avoidance or hardware safety.

All eight arrangements ran on seed 701. Only the complete-choice/facts arrangement ran with available inference on seed 702. The subsequent prose and factorized flights received billing errors before making a decision and continued for sixty seconds in local hold. The speculative flight on seed 702 also received HTTP 402; the batch was manually stopped at 47 seconds of that flight. Its partial raw trace is preserved without a fabricated completion record. Twenty scheduled slots were never attempted.

The report retains the billing failures in its all-attempt totals and explicitly labels the stopped batch. They measure service availability, **not Jev's ability to choose a maneuver**. Do not interpret the uneven aggregate table as a controller ranking. No request was retried or unfavorable flight replaced.

The experiment source was frozen at `8aad5bf6d3dd7966eb83099bd825383bfc0aeaaeeacdb70bc6945dae4e410ed7`. Exact source files are archived under `.runtime/experiments/jev-strategies-held-out-v1/source/`. Reporting and automatic billing-stop handling were improved after the batch stopped; the controllers, scores and archived evidence were not changed.

## The one complete paired seed

These are **seed 701 only**. Sensor age is measured at the first actual application, including observation age, inference and command transport. Correct framing requires the requested side, distance and central image placement together; each goal phase must independently reach 50% and the required continuous dwell.

| Arrangement | Decision median | Applied sensor age median | Correct framing, goal 1 / goal 2 | Primary score |
| --- | --- | --- | --- | --- |
| Raw controls | 259 ms | 440 ms | 4.6% / 16.5% | Fail |
| Complete choices + facts | 354 ms | 540 ms | 7.4% / 18.4% | Fail |
| Plain-language choices | 303 ms | 480 ms | 51.2% / 56.3% | Pass |
| Independent movement / camera | 335 ms | 520 ms | 62.2% / 3.8% | Fail |
| Speculative camera branches | 333 ms | 520 ms | 77.0% / 17.5% | Fail |
| Movement, then camera | 583 ms | 760 ms | 68.2% / 0.0% | Fail |
| Jev scores, then chooses | 568 ms | 760 ms | 92.6% / 14.1% | Fail |
| One-second maneuvers | 403 ms | 560 ms | 15.0% / 15.4% | Fail |

The plain-language presentation passed both phases, narrowly. Structured full-choice/facts and raw controls did not. The prose condition also removes raw range points and rounds other sensor numbers, so this does **not** isolate wording from state compression.

Several arrangements did well on the first goal and poorly after the reversal. The score-and-shortlist arrangement averaged above 50% across phases yet failed the second goal, which illustrates why an averaged score would be misleading. The two-stage arrangements took roughly 570–580 ms per full decision; single-request arrangements took roughly 260–400 ms. These timings support Jev as a fast guidance candidate, not as a motor-rate controller or a proven replacement for a planning agent.

## Development findings and audit

Twenty-five twenty-second development flights preceded the held-out batch, in four preserved directories:

- `jev-strategies-development-v1`: one real flight; report reconstruction exposed JSON's normalization of negative zero.
- `jev-strategies-development-v2`: eight flights; verbose full-choice, prose, all-bundle scoring and short-lease requests exceeded the provider's input limit. These failures issued no control commands.
- `jev-strategies-development-v3`: eight flights; compressed requests worked, but the full-size short-lease menu could still overflow. One returned choice disagreed by one percentage point with the displayed largest probability.
- `jev-strategies-development-v4`: eight flights; every arrangement completed without controller/API errors. Range coordinates retain every return at millimetre precision, and scoring judges each movement once before a Choice over all camera variants of the top six model-scored movements.

The frozen validator accepts a one-percentage-point argmax disagreement for rounded tables and rejects larger disagreements. The cause of the observed discrepancy is unknown; it is not evidence that the provider's documented argmax contract always holds. The chosen option is never replaced by a code-selected alternative. All distributions remain inspectable.

The audit reconstructed every initial request from its delivered sensor snapshot; checked original observations across stages, offered-action identity, continuous trace IDs, expiry before application, full-duration pacing and matched target/obstacle trajectories. Eleven full traces passed these checks, including the two billing-only flights. The interrupted trace is separately labeled and is not claimed to pass a full-flight audit.

Held-out responses reported **29,029,975 input tokens**. Across development and held-out work, **2,380 API responses** reported **51,233,378 input tokens**, approximately **$2.15** using [TypeSafe's launch price of $0.042 per million input tokens](https://typesafe.ai/blog/introducing-system-one-models-and-jev). Cancelled/failed calls may have unreported billing; this is an estimate, not an invoice or a statement of account balance.

## Next useful comparisons

First finish the matched seeds after credits are available, preserving the original billing-blocked attempts. Then separate the promising representation changes in a 2×2 comparison: structured versus prose choices, crossed with full versus compact range state. Keep action sets and timing identical.

A separate timing experiment should vary prediction horizon while keeping command expiry fixed. The existing one-second arrangement changes both and also admits a different envelope-feasible menu, so it cannot establish which change caused its outcome. Another useful experiment is a sparse planner update to Jev's instructions while Jev continues the sensor/action loop; this batch did not run Claude or Codex and cannot establish that hybrid's performance.

See the [experiment protocol](jev-strategies.md) for the request arrangements, simplifications and reproduction steps. Robots World's [principles](../PRINCIPLES.md) remain unchanged: the experiment code owns these policies, not the world core.
