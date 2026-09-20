# Round 2: metric camera observations and goal-dependent movement

Prospective plan, 19 September 2026. The user asked to proceed and deprioritized small sensing/inference delays. This round changes no delay policy. It isolates two prerequisites for following at a requested distance: camera range estimation and Jev's interpretation of that range when the goal changes. No flight is executed in this round.

## Questions and fixed comparisons

1. Can calibrated stereo or the actual Depth Anything V2 Metric VKITTI Small checkpoint estimate the visible target surface near 10 m? Compare the two on identical left RGB images; stereo additionally uses a right image and calibration. Keep every input, failure, raw prediction and timing. Do not fit monocular scale to ground truth.
2. Does supplying the physical range consequence of **every** offered movement improve Jev's choices over supplying the same measured range and action displacements? Cross both representations with requested distances of 8 m and 12 m. Code does not rank actions or recommend one. Separate correct interpretation of a sensor estimate from a physically correct choice under the reference geometry.

The [research recommendation](../.runtime/research/jev-camera-follow-recommendation-2026-09-19/report.md) and [handoff](JEV-CAMERA-FOLLOW-HANDOFF.md) motivate metric perception before translation. The [local feasibility audit](../.runtime/experiments/jev-round2-v1/depth-feasibility.md) found no real imagery with reference points at 9–11 m. This limitation remains visible; synthetic results cannot close it.

## Perception population and assistance

- Three existing calibrated Middlebury RGB scenes, resized to 768 pixels wide, are explicitly **reused near-field regression data**, not unseen confirmation. Reference axial depth spans roughly 1.6–8.4 m. Compare per-scene signed bias, MAE, p95 absolute error and coverage over all valid reference pixels, retained support, and secondary common support. Depth bins must show empty coverage near 10 m. Pixels are correlated; the real scene count is three.
- Twenty-four fresh rendered stereo pairs: twelve development and twelve confirmation. Each split has six nominal textured blue front surfaces, two partially occluded surfaces, one low-texture surface, one ambiguous pair of blue candidates, one no-blue frame and one dark frame. Nominal development depths are 7.5, 8.5, 9.5, 10.5, 11.5 and 13.5 m; confirmation depths are 7.8, 8.8, 9.8, 10.8, 11.8 and 13.8 m. Bearings cycle -8, 0 and +8 degrees. Occluded depths are 8.2/12.6 and 8.4/12.8 m; low-texture depths are 10.2 and 10.4 m. Distinct fixed texture seeds are used in the two splits.
- The declared rig is 640×360, 70-degree horizontal field of view and 0.20 m baseline. A 1.8×1.2 m front surface and 22 m background are rendering parameters, never inputs to perception or Jev. This is a new rig, not a replication at the historical 0.06 m baseline.
- Both pipelines use the same image-only blue connected-component extractor: at least 100 pixels and exactly one candidate, with a three-pixel eroded region for ranging. Missing/ambiguous targets produce unknown range. The blue surface is a color surrogate; neither semantic car recognition nor identity tracking is tested.
- Stereo reuses the historical SGBM implementation/settings. Require at least 50% valid target-region coverage; summarize median axial depth and disparity q10–q90 expanded by the declared ±0.5 pixel assumption. Record the actual OpenCV runtime used. This interval is not calibrated confidence.
- Monocular inference uses the pinned official **metric** VKITTI Small weights and upstream preprocessing at input size 518, max depth 80 m, CPU float32, eight threads. Require at least 50% positive finite target-region output; report median and q10–q90 depth spread. Dense finite output and a narrow spread do not establish accuracy or confidence. Tiny renders are out of distribution for a learned natural-image model.
- Freeze pipeline, configuration, input images, reference files, upstream source revision, checkpoint hash and environment before predictions. Pin details and official source/license links in the perception manifest. A separate isolated environment preserves the old stereo environment. No training, per-image tuning, GT scaling or selection of favorable pixels after viewing predictions.

The confirmation **perception gate**, assessed independently for each method, requires at least 5/6 nominal ranges usable, p95 absolute median-depth error at most 1 m among usable nominal cases, zero nominal depth underestimates greater than 2 m, and unknown range in all three ambiguous/missing/dark cases. Report occlusion and low texture separately. These small component gates cannot qualify real-world range or clearance; real 10 m validation remains mandatory even if a gate passes.

## Jev decision population and scoring

All 48 synthetic sensor records enter the decision study, including inaccurate and unknown estimates. Each is crossed with two goals and two representations: **192 requests**, 96 per split. Paired representations share goal, physical actions, order and instructions; the consequence representation adds only the action-dependent depth interval. Within each scene, physical action order and opaque identifiers stay identical across both goals, methods and representations; a goal pair changes only the requested depth fields. Independent experimental units are scenes, not the correlated methods/goals/representations.

The stated task is a one-step diagnostic: minimize worst-case absolute error between the supplied surface-depth interval after a completed movement and the requested axial depth. The target is stationary and a clear corridor is stipulated for this isolated test. Six complete opaque choices offer advance 2 m, advance 1 m, hold, retreat 1 m, retreat 2 m and observe. These are ideal displacements, not executed commands or qualified MAVLink maneuvers. Exactly tied minimizers are accepted. An unusable range requires observe; observe does not count as useful success on usable range.

Score separately:

- **Interpretation:** the chosen action minimizes error under the supplied interval, or observes when range is unknown.
- **Physical correctness:** the action minimizes final error under evaluator-only reference axial depth. A supported answer about a wrong estimate can fail this score. Missing/ambiguous reference targets have no physical-depth score. Dark/low-texture scenes can have a reference depth even when observing is the correct response to unknown range; they remain in the all-reference capability denominator and are reported separately from erroneous interpretation.
- **Unsupported movement:** any movement/hold commitment when the sensor record has no usable range.
- **Useful movement:** correct nonzero displacement when every acceptable answer requires movement. This prevents always-observe/hold from passing.
- **Goal responsiveness:** paired 8 m/12 m choices on the same scene, method and representation, with required changes distinguished from cases where the menu saturates at the same action. Report raw paired choices and both goals' correctness.

The preselected decision treatment is **consequences**. Its confirmation gate for each perception method requires at least 90% interpretation correctness over its 24 calls, zero unsupported commitments, at least 80% useful correctness on the movement-required subset, and at least ten percentage points improvement over measured-only interpretation. There are 48 confirmation calls per representation when both perception methods are pooled. Report both method gates even if perception fails; do not promote the best held-out arm retrospectively. No inference-driven prompt or scoring edits are allowed.

## Execution and retained evidence

The hard ceiling is 220 Jev requests and 1,000,000 accounted input tokens, at most two starts per second, with the existing ten-second request timeout. The planned count is 192 with no repeats. Model: Jev 1.13.0. No automatic retries or silent replacement of failed/uncertain calls. A transport failure stops paid dispatch; retain available requests/responses and account for the incomplete population.

Before paid calls, validate the joined fixtures, scorer, runner, viewer and perception artifacts; conduct independent preflight review; archive sources, plan, tests, viewer, records and exact generated requests. Seal development responses before confirmation. Final analysis reads the raw ledger and response files, checks hashes and records all missing/error outcomes. No hardware, MAVLink connection or actuator is enabled.

Save a concise results document and an image/decision viewer under `.runtime/experiments/jev-round2-v1/`. Show actual left/right/depth images, measured versus reference range, both goals, chosen actions and exact request/response evidence. Label this an offline comparison rather than a flight replay. Browser-check it and retain a link to Round 1's actual yaw replay. Run repository tests, typecheck, build and whitespace checks. Append outcomes to `design-failures.md` without changing prior entries.

If metric perception is useful, the next distinct experiment is executed translation with the same compact facts and goal-dependent menu. If perception fails, inspect the actual range errors first; good arithmetic on an inaccurate estimate is not a following controller.
