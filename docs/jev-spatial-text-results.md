# Jev spatial text tests — execution results

19 September 2026. Stereo, motion, fixed text diagnostics and the forty-episode corrected yaw comparison are complete. The original clock/task pilot and one corrected-cohort deadline failure remain preserved separately.

The measurements locate several different problems: stereo can erase a nearby obstacle; moving foreground features can corrupt estimated camera motion; old observations can be confused with current evidence; and an explicit signed-turn formula does not reliably produce a correct forecast. These failures need different next tests. Accurate reading of text is not evidence that the underlying geometry is accurate.

The [failure log](design-failures.md) preserves prior findings and adds concrete follow-up controls. The [64-item coverage table](jev-spatial-test-coverage.md) distinguishes executed components, partial tests and unrun experiments. This campaign does not qualify physical flight or replace the earlier 0/24 full-mission confirmation result.

## What ran

| Layer | Evidence | Boundary |
|---|---|---|
| Stereo depth | 40 image pairs: 4 development, 36 evaluation; three public Middlebury scenes and controlled renders | An exposure variant repeats one real scene; pairs/sectors/pixels are not independent environments |
| Ego-motion and sparse geometry | 137 stereo pairs in seven rendered sequences; 105/119 evaluation motion estimates | Image-derived SGBM/KLT/PnP, not supplied truth poses; no real camera motion, production SLAM or dense occupancy |
| Real Jev reading of stereo estimates | 160 requests, four equivalent formats, 1,760 scored answers | Every record/sector retained, including sensor mistakes; grading separates reading from physical accuracy |
| Real Jev synthetic diagnostics | 1,440 requests, 6,912 scored answers; six stages, 480 requests per split | Hand-authored component evidence and forecasts; no claim these are Jev's own experiences |
| Original timed cohort | Four completed episodes plus one interrupted episode; 248 calls | Excluded from the main comparison for clock/task-specification defects; all evidence retained |
| Corrected own-decision cohort | 40 completed 20-second episodes, 1,523 requests; one additional deadline-invalid attempt retained | Five history packages, four patterns, two mirrored seeds; yaw only |

All inference uses `jev-1.13.0`. Requests use text state and explicit independent Choice questions, 2–255 options, and no sibling-answer dependency. IDs alone do not carry model-visible axis meaning. Conservative UTF-8 byte guards keep state plus its longest question within 32k and the serialized complete request within 64k; these are guards, not exact tokenization. Full payloads, response/model validation, source freezes, external answer keys and a fsynced request journal are retained. The fixed 1,600-request battery finished without service/schema errors or uncertain reservations. There were no automatic request retries.

## Depth and motion: the simple stereo premise is valid, but quality matters

A calibrated rigid stereo pair can estimate distance. Here, ideal textured 1/2/4 m planes retained roughly 61–64% of reference pixels with zero p95 error; those integer-disparity scenes are favorable. Real Motorcycle/Pipes images retained 47.5% with 0.315/0.928 m p95 axial error. Blank texture correctly became unknown.

The important counterexample is the thin obstacle: 12/193 evaluation sector depth claims had a wrong nearest-depth bin, including five near-to-far pole errors. There were 5,080 retained near-reference pixels assigned far depth. A synthetic 50 ms camera skew reached 10 m p95 error. Current returns never certify whole-sector clearance; zero clear assertions is therefore a construction rule, not a successful safety outcome. Quantile/disparity intervals remain descriptive, not calibrated confidence bounds. See the [stereo report](../.runtime/experiments/jev-spatial-text-v1/stereo/report.md) and [audit](../.runtime/experiments/jev-spatial-text-v1/stereo/audit.json).

The subsequent image-derived motion test worked on short static scenes but failed with moving foreground texture. Accepted estimates reached 0.634 m / 4.19° error; eleven other frames returned unknown. Static landmark p95 errors reached about 0.32 m even where camera pose error was only centimetres. The finite pose gate did not qualify the map. Dropout returned three explicit unknown poses, and reset invalidated the old epoch. These are useful protocol results without establishing robust dynamic mapping. See the [motion report](../.runtime/experiments/jev-spatial-text-v1/motion/report.md) and [replay audit](../.runtime/experiments/jev-spatial-text-v1/motion/audit.json).

Only OpenCV matching/feature-based estimation was executed. DepthAI, ZED, Isaac and RTAB-Map remain researched alternatives; WLS was unavailable in this environment. Desktop processing timings are not onboard performance, thermal/power measurements or acquisition-to-action latency. Production SDK/device and hardware comparisons remain unrun.

## Text: straightforward reading is easier than time and consequences

The actual stereo-record reading test scored **1,758/1,760**. Numeric and nested formats each scored 440/440, rows and prose 439/440. Both mistakes concern one real sector whose interval crosses a depth threshold. Correctly reading the other sensor statements does not repair their physical errors. There was no filtering to a ground-truth-correct subset.

Synthetic format confirmation scored numeric 119/120, rows 118/120, prose 117/120, nested 116/120. Errors split evenly between range ordering and side classification: five each. These small differences do not identify one universally superior format: they are 12 paired units per split, many related questions, and no multiplicity-corrected generalization study.

| Held-out component question | Result | Interpretation |
|---|---|---|
| Old point expressed in the current body frame | Dated raw 9/24; computed alignment 15/24 | A transform helps some arithmetic, but does not qualify persistent spatial memory |
| Refuse an unsupported current target location | Dated raw 24/24; aligned history 21/24 | Re-expressing an old point can be mistaken for new evidence |
| Distinguish transform from motion extrapolation | Aligned history 6/24 | The three-way question lacks an explicit transformed-old-observation category; improve the vocabulary and retest |
| Command application status | 24/24 in each of four execution arms | Explicit execution records are readable, including unknown joins |
| Command completion, linked versus loose | 20/24 versus 20/24 | Grouping alone does not resolve completion semantics |
| Retrospective forecast assessment | Raw 18/24; computed time/category 22/24 | A small promising computational-assistance contrast, not evidence of self-learning |
| Stationary geometric yaw optimum | 12/24 | Posthoc: 14 improve centering, eight turn the wrong way, two retain |
| Stationary conditional forecasts | 72/168; 157/168 commit | An explicit formula does not make the forecast head reliable |
| Ambiguous uncertain-motion forecasts | Correct abstention 104/150 | Guaranteed cases separately score only 2/18; abstention cannot masquerade as accurate physical prediction |
| Goal-selected target identity | 24/24 in every control arm | Matching the supplied appearance to the goal is not semantic car recognition |
| Original / reordered control optimum | 12/24 / 8/24 | Better diagnostic scores can coexist with worse action scores |

All fixed cases and their original scores are retained in [component results](../.runtime/experiments/jev-spatial-text-v1/component-results.json). [Descriptive disaggregation](../.runtime/experiments/jev-spatial-text-v1/component-diagnostics.json) separates direction/centering improvement from exact optimum and guaranteed forecasts from ambiguity; it does not change the frozen primary keys. Current-only and unlinked-history arms can correctly say unknown because information was removed. Their higher factual scores must not be ranked as better memory/control packages.

## Actual own-decision histories

All **40 corrected 20-second episodes** completed: five packages × four patterns × two mirrored seeds, with 1,523 actual Jev requests and 4,040 controlled camera acquisitions. Fourteen episodes retain their original freeze; twenty-six use the reviewed recovery orchestrator, including one same-case replacement of the preserved deadline-invalid attempt. There were no further invalid episodes. These are actual own-decision histories, but only yaw centering of a blue-region proxy.

| Package | Centered seconds / available | Visible seconds | Requests | Reported input tokens | p95 dispatch-to-return latency |
|---|---|---|---|---|---|
| Receipts only | 62.8 / 160 (39.2%) | 122.8 | 307 | 611,220 | 304 ms |
| Linked outcomes | 20.2 / 160 (12.6%) | 134.2 | 304 | 3,173,334 | 346 ms |
| Chronological diary | 42.4 / 160 (26.5%) | 151.2 | 304 | 3,271,029 | 348 ms |
| Conditional predictions | 26.4 / 160 (16.5%) | 144.8 | 304 | 4,087,512 | 370 ms |
| Retrospective hypotheses | 40.6 / 160 (25.4%) | 145.4 | 304 | 3,391,110 | 349 ms |

Each package has 160 possible seconds. The fixed-yaw passive observer has 17.2 centered seconds per package. Coverage is acquired-image time, not a count of favorable frames. The complete paired win/loss/tie counts against receipts are: Linked outcomes 2/5/1; Chronological diary 2/5/1; Conditional predictions 3/4/1; Retrospective hypotheses 3/4/1. Eight paired scene/seed blocks from four simple pattern families provide exploratory contrasts, not a general ranking or a hardware qualification.

Centered seconds by pattern, out of 40 per cell:

| Pattern | Receipts | Linked | Diary | Predictions | Retrospective |
|---|---|---|---|---|---|
| stationary-offset | 35.8 | 0.0 | 18.4 | 2.4 | 0.0 |
| moving-car | 15.0 | 16.6 | 17.4 | 15.8 | 17.4 |
| transient-occlusion | 11.4 | 3.6 | 6.6 | 8.2 | 7.2 |
| interrupted-command | 0.6 | 0.0 | 0.0 | 0.0 | 16.0 |

The stationary cases identify a concrete failure: receipts centered for 35.8/40 seconds, while linked and retrospective packages centered for zero. In seven richer-history episodes with only 0–2.4 framed seconds, posthoc trace analysis found 24–33 applied retain selections per episode while the heading was already settled and the unique unclipped target remained outside the required band. Early choices can differ even before a history exists. Repeated identical-state calls and neutral extra-text controls are needed to distinguish response variability, formatting, payload and history effects.

Contrary evidence matters: retrospective feedback centered for 16.0/40 seconds in interrupted-command cases versus receipts' 0.6/40. The entire gain came from seed 6130 (16.0 versus 0.6); both arms scored zero on mirror 6131. This is a reason to test fresh interruption and latency interactions, not to declare either history superiority or universal history harm. Compare feedback present/absent with interruption present/absent first, then vary latency separately under the same sensing, control and analysis rules.

The prediction arm had 296 selected-action records: 219 eligible, 77 excluded by the frozen outcome rules, 217 committed and 2 abstained. It correctly forecast 170/217 committed outcomes (170/219 of all eligible outcomes). Posthoc separation is retain: 138/162 correct committed forecasts, 162 eligible; nonzero: 32/55 correct committed forecasts, 57 eligible. Unselected branches have no realized counterfactual outcome and are not scored. The stationary subset alone correctly forecast 66/67 eligible outcomes (66/66 committed) while centering for only 2.4/40 seconds; 63 correct forecasts involved retain. Predicting persistence of a poor view does not show useful action selection. Forecast categories use ±5 degrees; the task's framing band is approximately ±11.863 degrees, so the two scores have different meanings.

Retrospective hypotheses appeared in 280 subsequent requests. They are finite, tagged, expire after two seconds and are filtered against recorded evidence by declared code. This does not establish durable learning or a learned dynamics model. All primary actions remain Jev's selections, with ordinary yaw stabilization only.

Valid episodes took 20.008–20.043 wall seconds, with maximum measured scheduler lag 168.466 ms under the 250 ms gate. All callback starts preceded nominal end; 4 already-requested HTTP calls started after that boundary (at most 229 ms late) and produced no late effect. The global ledger retains their returned answers and the final inventories include their late sinks.

The [combined results](../.runtime/experiments/jev-spatial-text-v1/bench-combined-results.json) verify per-attempt freezes, raw request/response hashes and all finalized evidence, including the supplemental late files. [Posthoc diagnostics](../.runtime/experiments/jev-spatial-text-v1/bench-diagnostics.json) independently recompute coverage from saved rectangles and break down action/forecast/timing outcomes without changing primary scores.

The task is explicitly limited to horizontally centering a measured blue-region proxy inside ±0.3 image half-widths, while the broad original mission remains visible. Translation, pitch and FOV are fixed. The five arms share sensing, routes, action menu and timing; their future observations may diverge after different decisions. The passive observer uses the same scene at the same acquisition times with initial yaw held fixed. Visibility/passive reappearance is secondary and does not prove active recovery or pursuit.

The original cohort exposed two design failures. A fixed timer advanced 20 simulated seconds in about 31 wall seconds, allowing extra decisions per simulated second. Also, “horizontally framed” did not state the numeric central band used in scoring. Keeping an off-center target visible could satisfy the vague prompt. Those runs are preserved and excluded; the new cohort is openly a clock plus task-specification correction, not a pure infrastructure comparison. The final corrected 20-second offline qualification took 20.033 wall seconds, with 101 acquisitions, 39 callback starts and 70.388 ms maximum lag. See the [amendment](../.runtime/experiments/jev-spatial-text-v1/bench-timing-amendment.md).

A separate corrected-cohort attempt stopped after a successfully returned response crossed the outer callback deadline: 195 ms before dispatch plus 9,956 ms dispatch-to-persisted-return exceeded ten seconds. The answer arrived after Stop and never produced a command. Fourteen completed episodes were retained; one fresh same-case replacement and the 25 untouched cases use a separate recovery freeze, with unchanged engine, prompts, routes, scoring and timeouts. Twelve discarded late-response files also exposed an inventory race. Their exact responses, hashes and absent command mappings were independently audited and added to an external supplemental inventory; original finalizations remain unchanged. The replacement finalizer drains those handlers before inventory. See the [recovery amendment](../.runtime/experiments/jev-spatial-text-v1/bench-deadline-recovery.md), [review](../.runtime/experiments/jev-spatial-text-v1/recovery-review.md) and [single repair record](../.runtime/experiments/jev-spatial-text-v1/recovery-repairs.md).

Callback start and HTTP dispatch are different boundaries: shared pacing put an already requested HTTP call 197 ms beyond one episode's nominal end. Its answer was retained without effect. The frozen bench's start-before-end wording concerns callback invocation, not a strict HTTP-start cutoff. Acquisition, response, admission and application clocks are recorded separately.

## What the next tests should isolate

1. **Preserve hazards before using depth for navigation.** Compare matchers/retention/aggregation on identical fresh thin-object/skew scenes; grade all hazard pixels and unknown coverage. Do not hide difficult cases behind a ground-truth correctness filter.
2. **Separate camera motion from moving-scene texture.** Cross locked/moving camera with static/moving foreground and texture dominance; compare a pinned stereo-only estimator with a separately declared stereo+IMU/VIO treatment. Gate sparse map accuracy and age, not camera pose alone.
3. **Use two explicit times in spatial memory.** Test `observed_at` separately from `expressed_in_frame_at`, with epoch and evidence kind. A transformed old observation must remain old; a motion prediction must remain a hypothesis. This schema is a proposal, not a tested improvement.
4. **Separate arithmetic from layout.** Factor computed time differences, computed interval relations and history grouping independently. Candidate action consequences, if supplied by code, need a separate assistance label and no hidden ranking/controller.
5. **Isolate ordering and action semantics.** Change object, criterion and question order one at a time; score the action head separately from target/diagnostic heads. Keep the legal independent-Choice contract explicit.
6. **Advance only to the task the evidence supports.** Qualified timing and a clear center objective precede interpreting yaw-history effects. Reliable hazard/motion/state evidence and useful action interpretation precede fresh full search, lateral viewpoint, pursuit and recovery tests. No main-flight success is claimed here.

## Reproduction and evidence

Run from the Robots World checkout. Paid entry points require an explicit real flag and the existing local environment file; credentials are never copied into evidence. Completed IDs are verified, not replayed; an unresolved dispatch stops later requests. Do not overwrite the retained campaign. For an exact rerun use a fresh output generation and recorded source/input manifests, preserving the original errors.

```powershell
node --env-file=.env.jev.local experiments/jev-spatial-text/run-stereo.ts --real
node --env-file=.env.jev.local experiments/jev-spatial-text/run.ts run all --real
node --env-file=.env.jev.local experiments/jev-spatial-text/run-bench.ts --real
node --env-file=.env.jev.local experiments/jev-spatial-text/resume-bench.ts --real
```

These show the executed entry points, not an instruction to redispatch this completed root. The original corrected-cohort runner stops on its retained invalid attempt; use the explicit recovery mapping for joined analysis. [Freezes](../.runtime/experiments/jev-spatial-text-v1/freezes/), [request journal](../.runtime/experiments/jev-spatial-text-v1/requests.jsonl), [original independent review](../.runtime/experiments/jev-spatial-text-v1/pre-inference-review.md), [coordinated repairs](../.runtime/experiments/jev-spatial-text-v1/review-repairs.md), and the separate stereo/motion audits retain the evidence. Successful parsed response bodies are retained; malformed/non-OK HTTP wire bodies are not. Bench files are bounded and hashed, but individual images are not fsynced. The original analyzer rejects omitted late-sink inventory; combined analysis verifies both the original files and the separately frozen supplemental inventory.

Total campaign inference: **3,383 completed requests**, 19,216,824 reported input tokens, no service/schema errors or unresolved reservations. This includes the 248 excluded original-pilot calls and all 12 calls in the deadline-invalid corrected attempt. At the recorded $0.042 per million input tokens, the input-token charge estimate is $0.8071; this is not a billing reconciliation. No hardware or full-mission flights were run in this campaign.

Verification: repository suite **220 passed, four optional skips**; the separately enabled 20-second qualification passed all 20 focused checks. Typecheck, production build and whitespace checks passed; the existing bundle-size warning remains. Stereo and motion replay audits passed, and the recovery's delayed-response/inventory and altered-provenance rejection checks passed. Final document checks verify all 64 catalog IDs and preserve the earlier failure log's exact 68,688-byte prefix. Generated evidence remains ignored by Git, and prior dirty work is preserved.

The [final independent review](../.runtime/experiments/jev-spatial-text-v1/final-results-review.md) found no blocking numerical, provenance or scope errors. Its two reporting corrections—balanced encoding-error wording and the interruption-specific contrary evidence—were applied in one documentation repair pass; [checks and delivered hashes](../.runtime/experiments/jev-spatial-text-v1/final-results-repairs.md) record that revision.
