# Next tracking experiments: evidence and recommendation

18 September 2026. Research and posthoc timing analysis only; no new inference or controller changes. Read alongside [F01–F17](design-failures.md) and [the frozen qualification results](jev-hypothesis-results.md).

## Did tracking begin?

**Yes in the declared hybrid; no sustained centring in direct Jev control.** Jev selected the region and authorized following; explicit code computed camera corrections. Translation remained Jev-selected.

| Run | First centred | Continued centring | What failed |
| --- | ---: | --- | --- |
| Hybrid 1501 | About 0.9 s | Through the 24 s endpoint | New apparent-size goal at 12 s; target stayed centred but too small |
| Hybrid 1502 | About 1.2 s | Through about 3.8 s | Foreground occlusion; no blue detection in the consumed image at 5.1 s; no recovery |
| Direct Jev arms | One retained-angle run briefly centred | About 0.6 s, during warmup | No sustained centring; other direct runs never centred in the sampled trajectory |

For hybrid 1501, the first phase actually met its framing/dwell thresholds: 52.3% of scored time fully framed and 4.12 s longest dwell. Overall failure combines this with the failed second phase. For hybrid 1502, 2.74 s full-framing dwell occurred before the five-second warmup ended, so its scored framing fraction was zero. Neither statement changes the original full-mission result.

[Posthoc timing evidence](../.runtime/experiments/jev-hypotheses-v1/timing-review.json) uses 100 ms trajectory samples for onset/centred spans; the original evaluator measures dwell at 20 ms. Object-centre visibility and visible colour-patch detection differ during occlusion. Exact runs: [1501](../.runtime/experiments/jev-hypotheses-v1/flights/hybrid-1501.report.json), [1502](../.runtime/experiments/jev-hypotheses-v1/flights/hybrid-1502.report.json).

## Is 24 seconds enough?

Enough to demonstrate the early wrong turns and mechanical issues; insufficient for a strong conclusion about stable following or recovery. The goal switches at 12 s and each phase excludes five seconds from fraction scoring: only **seven scored seconds per goal**. Gated arms receive about one decision every 0.6 s. Some direct arms lose the target after just two or three decisions and then spend the remaining time searching.

More time alone is not an evidenced fix. After the goal asked for a 14–22% width, hybrid 1501's delivered blue width declined from roughly 7.5% to 5%, despite persistent forward 0.2 m/s and mostly upward 0.2 m/s choices. It was not visibly converging toward the new size at the endpoint. Jev does not learn a new control policy simply because the same stateless request loop runs longer; only retained measurements/state provide additional context. Still, acquisition deadlines and recovery windows should be explicitly tested rather than inferred from these short runs.

## What the current Jev guidance changes

- [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): numeric precision, literal interpretation and indirect questions are weaknesses. This fits the remaining direction/magnitude failures; it does not prove all control policies must fail.
- [Pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): code finds grounded candidates, Jev selects their semantic role, code copies the chosen value. The robotics analogue is pixel-derived candidate tracks, Jev-selected target, and explicitly attributed control execution.
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling) uses 54 questions for tool selection and conditional arguments. [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) uses 13; [semantic search](https://docs.typesafe.ai/cookbooks/semantic_find) uses 218 alternatives. Large candidate lists are supported; the current failure is not lack of option capacity.
- [State](https://docs.typesafe.ai/concepts/state) and [fan-out](https://docs.typesafe.ai/patterns/fan-out): questions run independently over shared text. A question cannot read a sibling target-selection answer. Either supply a previously Jev-selected active track or ask explicit conditional branches, then dispatch the selected one.
- [Official integration guidance](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md): put meaning in instructions because question IDs are not model-visible; ignore uncertainty on unused branches; distribution confidence is not workflow correctness. The .35 all-axis gate failed here and should not become the default.
- [Current model limits](https://docs.typesafe.ai/models): text-only, 64k request tokens and 32k for state plus the longest question. Parallel questions are not an unlimited byte/token budget. The Choice page itself returned fetch errors during this review; its previously recorded per-question 255/full-menu guidance remains in [the earlier audit](jev-camera-representation.md), and the current examples independently confirm broad batching.

**Next question-design change:** let Jev bind a sensor-derived candidate ID as the active target, with explicit missing/ambiguous states. Subsequent questions refer directly to that measured track. Rebinding remains a Jev decision; the tracker only maintains image correspondence and marks uncertainty. This is a new hypothesis, not a demonstrated cure. Compare it on held-out snapshots before flying. Preserve every physical control value in the direct arm and retain the disabled-servo ablation.

## Practical perception options

| Library | Useful output from actual sensor data | Fit and limitation |
| --- | --- | --- |
| [OpenCV pyramidal Lucas–Kanade](https://docs.opencv.org/4.13.0/d4/dee/tutorial_optical_flow.html) | Feature positions/displacements, valid/lost status, consistency residuals | First choice for a small classical pipeline. Combine with existing pixel detections and measured camera rotation. Features alone do not recognize targets, certify occlusion or yield metres. |
| [OpenCV TrackerNano](https://docs.opencv.org/4.13.0/d8/d69/classcv_1_1TrackerNano.html) | Bounding-box update and tracking score after image-box initialization | Candidate lightweight learned tracker; documentation lists roughly 1.9 MB of models, not total RAM. Initialize from a detector box selected by Jev. Must measure drift, false locks and reacquisition; scores are not calibrated safety confidence. |
| [Ultralytics detection plus BoT-SORT/ByteTrack](https://docs.ultralytics.com/modes/track) | Candidate labels, boxes, confidence, IDs; configurable lost-track retention | For ordinary recognized objects. BoT-SORT adds camera-motion compensation; ByteTrack associates lower-score detections. No guarantee through full occlusion, and a pretrained car detector need not recognize our coloured boxes. |
| [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) | Relative depth, or separately trained metric estimates | Later depth ablation. Small has 24.8M parameters; not my first minimal-compute addition. Preserve estimate provenance; no fitting each frame against hidden simulator depth. |
| [OpenVINS](https://docs.openvins.com/) | Camera + IMU state estimation and sparse features | Later if the task needs ego velocity/pose. Adds a declared calibrated IMU, timing/extrinsics and estimator failure states. It is not unaided monocular image-to-range conversion or an obstacle detector. |

Recommendation: qualify **OpenCV feature tracking first**, with TrackerNano as an alternative. Do not install a full mapping stack merely to centre a target. The current grayscale fixture check established corner coverage only; optical flow was never supplied to the Jev flights. A detector/tracker can infer persistence, but it must distinguish observed, predicted and lost tracks. Keep predictions aged and uncertain.

An illustrative compact record, not existing measured output:

```yaml
active_track: o3            # Previously selected by Jev
frame_age_ms: 120
appearance: blue patch
measurement: observed
bearing: {right_deg: 8, up_deg: -2}
rotation_compensated_rate_deg_s: {right: 3, up: 0}
visible_width_percent: 7
previous_visible_width_percent: 11
extent_quality: uncertain  # Qualified pixel/track evidence, never hidden geometry
overlap_evidence: possible # Image overlap does not prove which object is in front
range_m: unknown
```

Add current actuator status/age and a short last-seen record when applicable; do not stream all raw points/history into every question. Image-boundary clipping and possible object occlusion must be different fields. Apparent shrinkage is not automatically recession; even box trackers may follow only the visible portion. Named categories should encode measured evidence, not `recommended_yaw` or a hidden navigation solution.

## Proposed experiments, in order

1. **Pixel perception qualification, no Jev calls.** Replay frozen old failures as development data. Create fresh clips of true recession, partial/full occlusion, viewpoint rotation, same-colour distractors, gray obstacles and lighting/blur changes. Compare colour-only vs KLT-backed tracks vs Nano. Measure false associations, false “visible” predictions, box/bearing error, loss/reacquisition delay and compute/RAM. Include real camera clips before claiming physical transfer; keep held-out scenes separate.
2. **Grounded target binding, short real-Jev diagnostic.** Same pixel-derived observations and full options; compare repeated implicit target identification against a prior explicit Jev selection carried as `active_track`. Do not select the target from labels/evaluator truth. Test ambiguity and goal switches as well as clean images. Geometry scoring stays outside the policy.
3. **Longer constant-goal tracking.** Start with an unobstructed 60 s acquisition/maintenance task, same goal throughout. Compare current vs qualified perception, crossed with direct Jev controls vs declared Jev-authorized camera servo. Use at least eight fresh matched seeds spanning initial quadrants, speeds and distractors. Keep hardware limits and actuator assistance equal where applicable. Report acquisition time, locked-time fraction, interruptions and size regulation separately; preserve every failure.
4. **Recovery, then goal change, as separate 90 s tests.** Fixed event schedule for all arms: 0–20 s acquisition window; 20–60 s maintenance; occlusion at 60–65 s; 65–90 s recovery. A separate cohort changes apparent-size goal at 60 s instead of occluding. Score from trial start as well as after acquisition, so warmup cannot hide brief success or failure. A target never acquired is a failure, not excluded from averages.
5. **Sampling-rate ablation after choosing a viable perception pipeline.** Compare current 5 Hz against 20 Hz acquisition/tracking, maintaining the same Jev request policy. Perception continues while inference waits. Measure actual board latency/energy before promising 20–30 Hz deployment. Do not change sampling and question wording in the same attribution experiment.

The four flight cells separate sensor improvement from servo assistance. If time/compute limits the pilot, use two development seeds first, freeze, then all held-out seeds; do not choose favourable runs. Jev remains responsible for selecting the target, authorizing follow/search and choosing translation. The direct arm additionally chooses exact camera controls. The hybrid's arithmetic is legitimate declared assistance, not evidence of Jev performing it.

Metric obstacle avoidance remains a separate task requiring a qualified depth/ego-motion contract. Neither an empty colour list nor a 2D gap establishes clearance. Keep all new components as optional perception/controller modules; Robots World core and Nervelet need no new planner for this design.
