# Jev versus Claude: first live mission results

Recorded 2026-09-17 local time (2026-09-18 UTC). These are actual provider calls and twelve continuously running, forty-second Robots World flights. No scripted mission policy competed. [Experiment and reproduction instructions](mission-comparison.md).

**This pilot favors Jev alone for these bounded English inspection missions.** Claude completed the same tasks more slowly. Adding asynchronous prose advice retained Jev's reaction speed but introduced a mission failure. Three seeds per configuration do not establish equal reliability or general agent replacement.

## Matched outcomes

All configurations received the same English goals, station manifest, odometry, delivered radio reports and controls: inspect a station, return, hold or continue. Shared local flight skills used actual MAVLink v2 encoding/CRC and the Rapier drone plant. The world never paused during inference. The held-out seeds were 101, 202 and 303; their task families were relational instructions, semantic reports and ordered markers.

| Controller | Full mission success | Median report-to-action | Median report-to-completed inspection | Pooled median decision response |
| --- | ---: | ---: | ---: | ---: |
| Jev 1.13.0 | 3/3 | **0.22 s** | **2.84 s** | 188 ms |
| Claude Opus 5, high effort | 3/3 | 3.18 s | 5.74 s | 1,748 ms |
| Claude Opus 5, low effort | 3/3 | 2.94 s | 5.56 s | 1,737 ms |
| Jev + asynchronous Claude Opus 5 advice, high effort | 2/3 | 0.24 s | 2.84 s | 193 ms for Jev decisions |

Report-to-action is delivered radio evidence to admission of the relevant inspection command. Report-to-inspection additionally includes travel and the required dwell. The median reaction difference between Jev and the low-effort Claude configuration was about **13.4x** in this pilot; physical completion improved by about **2x** because travel still takes time. This is a comparison of the tested controller stacks, not isolated server compute or a universal model speedup.

Every urgent report in the direct Claude runs arrived while a native request was pending. Replies based on a pre-report observation were rejected, and the next request received fresh evidence. This captures the serial-turn delay the experiment was intended to measure. Neither Claude effort setting missed the ten-second urgent-inspection deadline in these cases.

The main three-arm experiment rotated execution order across seeds. The low-effort Claude follow-up ran afterward; changing provider load or caching remains a possible confound. Each native flight used a fresh persistent conversation, with process setup measured separately from the forty-second episode.

## What changed in Jev's input

Before the held-out flights, 168 live calls compared action descriptions and question structures on 24 development snapshots. The first round favored structured whole actions at 21/24. The refined round reached 24/24 with three variants; the frozen winner used **plain, complete action descriptions**, explicit chronology and clearer consequences for `continue`. It was chosen using the declared accuracy-first, p95-latency tie-break.

The useful chronology fields state how long ago a report arrived, whether it arrived after the current job began and whether an inspection has completed since the report. Code computes these facts for both models. It does not classify urgency or choose the destination. Separate operation/target questions scored 23/24 in the refined round, so batching those particular decisions was not an improvement over complete actions here.

The refined interface was frozen before the first held-out flight. Development accuracy is not held-out accuracy, and the development bank is small. See [the detailed tuning record](mission-comparison.md#action-design-and-development-optimization).

## The hybrid failure

In seed 202, the hybrid completed the initial inspections at 3.06 and 6.50 seconds and the urgent inspection at 16.96 seconds. It then remained at that station until the episode ended instead of returning to base. There were no forbidden visits, premature diversions or repeated completed inspections; failure was the missing return.

Claude's first advice took 15.88 seconds and described the initial mission state. Its second took another 8.34 seconds and described the urgent inspection as still running, although that inspection finished before the advice arrived. The advice included a strong instruction to continue until a receipt, followed by a conditional return instruction. Jev kept selecting `continue` after receiving the completed receipt.

To investigate, a post-hoc replay held the failed observation at 25.96 seconds fixed and varied only whether planner advice was included:

| Frozen observation variant | Five live Jev choices |
| --- | --- |
| Original stale advice present | `continue` 5/5 |
| Planner advice removed; same goal, observations and controls | `return` 5/5 |

The incorrect choices with advice had confidence 0.85–0.93; the correct choices without it had confidence 0.50–0.57. A simple low-confidence escalation rule would not have caught this failure. This ten-call replay supports an advice-induced failure at this particular snapshot. It is post-hoc diagnosis without actuation, not an independent reliability benchmark.

A next hybrid should test compact, structured mission constraints and explicit applicability conditions instead of continuously accumulating prose about a past state. It should compare an initial plan with event-triggered replanning and invalidate state-dependent advice. That design has not yet been run; the failed hybrid remains in these results.

## Diagnostics and limitations

Across the three main configurations, the runner initiated 152 Jev-only decisions, 66 direct Claude decisions, and 181 hybrid Jev decisions plus eight Claude planning requests. The low-effort follow-up initiated 69 direct Claude decisions. No runtime provider/validation errors were recorded in these flights. Pending requests at episode shutdown and discarded stale answers remain explicit in each trace.

Thirteen live-flight Jev responses used the observed hundredth-precision probability-rounding exception: nine in Jev-only flights and four in the hybrid. Original values remain unchanged and the exception is logged. All other malformed distributions remain rejected. This experiment's compatibility rule does not retroactively diagnose the earlier tracking experiment's missing rejected bodies.

Every one of the twelve flight traces ended with a completeness record. A scan of 48,242,297 retained flight-trace bytes found no copy of the loaded Jev credential. Native logs retain supplied response/tool records and usage, not invented private reasoning. Credential files and generated traces remain Git-ignored.

Jev-only validated replies reported 318,145 input tokens across the three flights; hybrid Jev replies reported 421,449. Cancelled-request usage can be unknown. Native harness usage includes ancillary model calls as well as the verified Opus 5 decision messages. Reported cost fields are retained; no measured invoice or all-inclusive billing claim is made.

These are short missions with idealized structured sensing, a known site directory, simple open flight paths and a fixed action vocabulary. They do not test learned vision, difficult obstacle avoidance, unseen tool authoring, long missions, swarms, native compaction or hardware. Claude was used through its native harness as a bounded selector; it was not given unrestricted coding tools. This is also not a run of Codex or of the complete DroneRTS application.

## Retained evidence

- `.runtime/experiments/mission-tuning-v1/`: first 72 development calls and scores.
- `.runtime/experiments/mission-tuning-v2/`: refined 96 calls, frozen selection and scores.
- `.runtime/experiments/mission-live-v1/`: nine paired flights, manifests, per-flight summaries and JSONL traces.
- `.runtime/experiments/mission-claude-low-v1/`: three low-effort Claude follow-up flights.
- `.runtime/experiments/hybrid-advice-replay.json`: ten live, non-actuating diagnostic calls.
- `.runtime/experiments/mission-summary.json`: aggregate metrics and trace/credential scan.

The four experiment source files hashed to `ca30ce193877d8047e9b6a452994e88df084009255c1aba1ad1abdab7b8ff632` for both flight batches. Each manifest records that scope, the frozen tuning artifact, settings and start time. It is a source hash for those experiment files, not a whole-machine or hardware reproducibility claim.
