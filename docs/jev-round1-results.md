# Jev round 1 results — 19 September 2026

Continuous acquisition works: every one of the 234 live requests used the newest acquired frame when its text snapshot was assembled. However, the snapshot then waits for dispatch and inference; it does not update while Jev answers. Applied commands used observations with median age **560 ms**, 95th percentile **720 ms**, maximum **880 ms** in this experiment. This is a measured delay, not evidence that stale inputs caused the control errors.

The added time/validity text **failed the predeclared advancement gate**. Keep the existing computed-bearing baseline. The most concrete next timing experiment is to acquire the request snapshot after obtaining the actual dispatch slot, keeping the same prompts and rate limit. Do not make “teach Jev more timestamp reasoning” the main drone project based on these results.

[Open the replay UI](http://127.0.0.1:8870/.runtime/experiments/jev-round1-v1/index.html#replay). It contains all six camera episodes, 606 actual controlled-camera images, 234 decisions, and all 144 analytic probes. Choose an episode and press Play; step between decisions to compare the latest camera frame with the frame that decision actually received. The exact JSON requests, responses and command events are expandable.

## What ran

The [prospective plan](jev-round1-plan.md) compared identical facts/actions represented as raw timestamps, computed ages, or computed ages plus validity booleans. All live arms retained the previously useful computed conditional yaw bearings. Fixed evidence cases included a real two-call selection/delivery/decision sequence, but their observations and logical times were stipulated fixtures. Their API latency did not advance the fixture clock.

Completed **474 real Jev 1.13.0 requests**, **1,043,108 reported input tokens**, zero request/schema/unresolved errors: 240 fixed calls plus 234 live calls. No retries, replacements or result-driven changes. Development's 120-call ledger was sealed before confirmation's 120 calls. Runtime evidence and credentials remain outside Git.

## Fixed confirmation

Each arm had 24 probes: 12 situations repeated twice. These are small, related instances, not 24 independent environments.

| Representation | Correct supported decisions | Unsupported commitments | Useful opportunities completed | Authority cases correct |
|---|---:|---:|---:|---:|
| Raw timestamps | 14/24 | 10 | 10/16 | 6/8 |
| Computed ages | 16/24 | 8 | 12/16 | 8/8 |
| Ages + validity | 15/24 | 8 | 11/16 | 7/8 |

All three scored 8/16 on sensor-evidence decisions. Each acquired missing front/rear appearance correctly in 4/4 cases, and handled already-current evidence in 4/4. Each retained expired depth, expired appearance, or unavailable depth and asserted `maintain` in the other eight cases. Explicit `timingValid: false` did not fix this. For example, [this validity request](../.runtime/experiments/jev-round1-v1/requests/R1-confirmation-e0-validity-0.json) marked depth invalid; Jev chose keep, then [answered maintain](../.runtime/experiments/jev-round1-v1/responses/R1-confirmation-e0-validity-0--followup.json) without acquiring current depth.

Time facts did help the short-authority case: raw continued with only 90 ms remaining for a 117 ms read, while age and validity renewed in both repeats. Validity also renewed unnecessarily once despite sufficient authority. This narrow improvement did not meet the primary gate: at least 22/24 correct, zero unsupported commitments and at least 15/16 useful positives were required.

Nominal cases scored 8/10, 10/10 and 9/10 respectively; deliberately interrupted/missing-record cases scored 6/14 for every arm. These failures do not establish how often old records occur in normal camera operation. [Full per-scenario decisions](../.runtime/experiments/jev-round1-v1/confirmation-scenarios.json).

## Continuous camera results

Acquisition ran at 5 Hz; inference dispatch was limited to at most 2 Hz. Each episode lasted 20 seconds, with no injected delay or dropout. “Framed” means an unclipped blue region inside the declared central horizontal band.

| Representation | Mirror 0 framed | Mirror 1 framed | Combined framed | Visible |
|---|---:|---:|---:|---:|
| Raw timestamps | 67% | 61% | 64% | 100% |
| Computed ages | 52% | 53% | 52.5% | 100% |
| Ages + validity | 64% | 67% | 65.5% | 100% |

Validity's +1.5 percentage points over raw is small and reverses direction between mirrors. Two executions per arm do not establish an improvement. Age stayed in the middle execution slot, so order was not fully balanced. These were new executions of an existing moving-route family. All six had zero visibility loss; none tested reacquisition or metric following.

| Measured interval | Median | 95th percentile | Maximum |
|---|---:|---:|---:|
| Source age at request assembly | 100 ms | 180 ms | 180 ms |
| Assembly to transport dispatch | 193 ms | 273 ms | 297 ms |
| Dispatch to recorded response | 223 ms | 328 ms | 497 ms |
| Source age at command application | 560 ms | 720 ms | 880 ms |

Application ages use the simulation clock; wall-time values agree closely: 558 ms median, 712 ms p95, 875 ms maximum. Separate medians need not sum. Transport latency includes response recording overhead; these logs are parsed payload records, not HTTP packet captures.

New frames arrived during 225/234 requests. The camera kept running; the in-flight request retained its original snapshot. All 228 admitted commands applied, with zero rejection or expiry. Six terminal replies were recorded and discarded without commands, and no command event occurred after Stop. Minimum measured dispatch spacing was 509 ms. Every episode completed within 20.009–20.023 seconds wall time; scheduler lag remained below the frozen 250 ms limit.

The [dispatch-delay audit](../.runtime/experiments/jev-round1-v1/dispatch-delay-audit.json) locates most assembly-to-dispatch delay after the judge callback's synchronous preparation. Code inspection identifies a second rate wait in the shared meter after the bench's own pacing wait. This supports testing a single dispatch reservation before snapshot capture; it does not yet measure the improvement that change would deliver.

## Decision and evidence

The user's intuition is substantially right: Jev is receiving a continually refreshed world, and these runs do not show multi-second camera backlogs. “Freshest at snapshot assembly” still differs from “freshest when the command acts.” Retain executor checks, measure and reduce avoidable dispatch delay, then prioritize grounded distance/motion and translation experiments. A separate proposed sensor-packet test should make unusable current measurements absent/unknown rather than merely attaching an ignored invalidity flag; this remains untested.

This is a rendered-RGB, yaw-only component study. It does not demonstrate semantic blue-car identification, maintained metric distance, two-camera reconstruction, MAVLink flight or hardware readiness.

The [summary](../.runtime/experiments/jev-round1-v1/summary.json), [final timing/effect audit](../.runtime/experiments/jev-round1-v1/final-audit.json), [replay data](../.runtime/experiments/jev-round1-v1/replay.json) and adjacent request/response directories preserve the evidence. Source SHA-256: `dc45f91f4bff775173784abf848585ce254f84f6c0582a11a6647b10d3e1b2fa`.

Pre-inference checks passed: 304 repository tests, five skipped, typecheck, build and whitespace checks. The [original independent review](../.runtime/experiments/jev-round1-v1/preflight-review.md) found failure-replay and completeness gaps; one prospective repair added partial-failure preservation and required all three confirmation arms. [Delivered status](../.runtime/experiments/jev-round1-v1/pre-inference-status.json) distinguishes the original review from the repaired, checked freeze. Offline fake-transport checks are stored separately and excluded from Jev results. Final browser verification and independent results-review records are adjacent to the runtime evidence.
