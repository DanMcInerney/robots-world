# Round 3: moving 3D camera qualification and depth association

19 September 2026. Prospective execution plan following [the spatial-awareness proposal](jev-3d-perception-test-plan.md). User authorized execution. No previous experiment or failed evidence is replaced.

## Stages and stopping conditions

1. Prepare a textured car mesh, offscreen stereo renderer, image-only detector/stereo worker, world-backed camera routes and replay. Preparation smoke images are development engineering evidence, excluded from scored routes. Review the joined implementation and gates before scoring. Preserve the reviewed source and any one coordinated repair.
2. Freeze inputs, source, model weights, settings and this plan. Generate twelve fixed ten-second routes in Robots World, each with 100 stereo acquisitions. Run both association arms on exactly the same images and detector results. Complete development, preserve its predictions, then confirmation, without tuning.
3. If nominal camera/perception gates pass, run the fixed range-wording probes. If they also pass, qualify the continuous renderer/worker interface and execute short stationary-car approach/hold trials before moving following. Obstacle-text, motion-text and scheduling comparisons depend on these prerequisites; failures stop dependent stages rather than becoming a claimed controller result.

All generated assets, environments, source freezes, raw predictions and evaluations belong under `.runtime/experiments/jev-round3-v1/`. No live robot or external simulator is involved. Local inference is permitted by the user's execution request. Paid Jev probes have an initial ceiling of 160 requests, 750,000 input tokens and two requests per second; do not silently expand this component budget into flights. Any continuous-flight allocation must be recorded within the previously authorized campaign limits before dispatch, with no uncertain-request replay.

## Camera and world

One actual simulated drone uses the existing Rapier backend, simplified local servo and revocable RobotPort. An environment-driven car has a conservative declared collider; it has no controller port. The renderer consumes actual acquired drone and target poses, not intended routes. During this initial offline stage, poses are recorded from stepped physics and rendered afterward. Thus renderer throughput is measured but real-time acquisition-to-control latency is not yet established.

Rig: 640 by 360 pixels, 70-degree horizontal field of view, 0.20 m baseline, parallel rectified cameras. ENU world; camera yaw zero faces east, image right points south, positive pitch points up. Fixed mounting pitch is -5 degrees. Both cameras use the same acquisition state. Record intrinsics, extrinsics, asset scale and OpenGL depth convention. Hidden renderer depth, segmentation and body identities are evaluator-only; image perception receives RGB plus calibration.

| Family | Development seeds | Confirmation seed | Intended stress |
|---|---|---|---|
| Nominal range | 7301, 7302 | 7303 | Visible car, camera translation and different ranges |
| Wall and pole | 7401, 7402 | 7403 | Unnamed geometry near the car |
| Occlusion and lookalike | 7501, 7502 | 7503 | Partial visibility and tentative identity |
| Moving target and ego-motion | 7601, 7602 | 7603 | Target motion, camera translation and yaw |

Each route acquires at 100..10000 ms with 20 ms physics steps. Scripted routes qualify sensors; they are not Jev flights or mission successes. Car recognizability, camera geometry and scale must be checked before interpreting detector performance. Any unavoidable mismatch between visual mesh and collider is recorded and prevents collision-fidelity claims.

## Fixed perception comparison

Scored detector: pinned YOLO11s-seg, inference size 640, confidence threshold 0.25 and IoU threshold 0.7. The initially proposed nano model failed all three preparation views before and after a renderer geometry repair. A single bounded capacity comparison held images/settings constant; the small model detected a car in all three corrected views. This prospective amendment is based only on preparation images, before route generation or confirmation. Both original failures and the comparison are retained. Blue evidence comes from image pixels. Record all detections and ambiguous/missing cases. Use the existing SGBM implementation and declare any parameter differences. Never select the evaluator's target ID or use renderer masks for range estimation.

- **Box arm:** median Euclidean range of valid stereo points inside the selected detection box.
- **Mask/cluster arm:** median Euclidean range of valid stereo points in a supported foreground cluster within that same detection's predicted mask.

Both arms reuse one detector pass and one stereo pass. The range statistic is deliberately held equal. **This refines the proposal's distance definition:** the primary reference is the median Euclidean range of the visible target surface, not the nearest point or object centre. Record the p10 range proxy and its error against the evaluator's actual nearest visible surface separately. A descriptive pixel-depth spread is not a calibrated confidence interval. Future control goals must use their declared statistic consistently.

Primary nominal gates, evaluated separately per arm on confirmation: correct single blue-car association on at least 90 of 100 frames; usable range on at least 90 of 100 frames; p95 absolute median-range error at most 1 m; no accepted estimate more than 2 m too far or too near. Detection association is evaluator IoU >=0.5 against the visible target's bounding box, with candidate-count ambiguity preserved. An accepted wrong-object range counts as failure, not missing evidence. Report performance at 8..12 m separately and do not qualify that band unless at least 20 reference frames fall inside it.

All other families remain in the result tables, including unknowns, false associations and depth failures. The nominal gate licenses only the simple visible-car next stage; it does not qualify obstacle avoidance or occlusion recovery. Mask/cluster association earns promotion over the box baseline only if it preserves nominal gates and improves range MAE or mean selected-background fraction across all four confirmation routes (400 frames), without reducing correct usable coverage by more than five percentage points (20 frames). Selected-background fraction is the fraction of selected valid stereo pixels outside the evaluator's visible target mask; average this per frame, retaining its available-support denominator. It differs from metric false-far errors. Report each route separately. Otherwise retain the simpler qualified arm or report that neither qualifies.

## Wording probes after perception qualification

> **Superseded, 2026-09-21:** this signed-distance-error probe design is superseded by F75's `after-range` encoding (per-option computed resulting range for every offered action), which held 116/116 useful with zero harmful choices across both development and confirmation, where the cheaper signed-error-style scalar tested in F75 (`signed-error`) passed development but failed confirmation with 4 harmful choices. Also note: the tested Round 3 reference-range span was verified as **5.15–14.998 m** (`.runtime/experiments/jev-round3-v1/diagnostics.json`), not the 4–18 m originally proposed in `jev-3d-perception-test-plan.md`; nothing beyond ~15 m has ever been rendered. See the [find-and-follow ladder](jev-find-follow-ladder.md) L3a/L3b/L4/L8, which use `after-range` for the stationary-target case (L3a) and a rate-aware speed-hold consequence for moving targets (L3b onward), and gate long range on a dedicated detection-envelope sweep (L0).

Preselect frames 20, 50 and 80 from every route, with 1-based frame numbering: 36 underlying scenes. Cross requested distances 8 m and 12 m with two representations: measured range alone, or the same range plus computed signed distance error. This is 144 requests (96 development, 48 confirmation), not 144 independent scenes. Both receive identical movement semantics and choices; code supplies no best action.

Use the preselected perception arm (box baseline unless the above promotion rule passes). Preserve unknown and ambiguous inputs. These are stipulated one-step interpretation probes, not executed movement. Advance the signed-error format only with at least 90% supported-choice accuracy, zero unsupported commitments on unknown cases, zero wrong-direction choices on unambiguous approach/retreat cases, and no lower accuracy than the measured-range arm. Record useful holds and movement as well as abstention. A useful perception pass is required separately; correct interpretation cannot repair wrong depth.

## Evidence and checks

Retain every frame, detector output, mask/depth preview, estimate, unknown reason, timing and evaluator-only reference. Record startup and warm per-frame timings separately, hardware/runtime versions and exact hashes. Frame samples are correlated within twelve routes; report counts and per-route outcomes alongside aggregates. Do not tune on confirmation.

The source freeze includes the world implementation and imported request/transport code. Verify each recorded trajectory hash before rendering; freeze trajectories, paired RGB, calibration, render metadata and both eyes' evaluator evidence. Seal all development predictions before confirmation and both phases before analysis. Evaluation verifies these seals and the prediction-to-input IDs/paths/hashes, then seals its summary and immutable perception handoff. Paid cases derive only from that verified handoff; the display replay can append decisions separately.

Replay must align RGB left/right, predicted mask, stereo depth, both estimates and evaluator reference, clearly labeling truth. Later Jev records must show exact delivered text, exact answers and actual receipts. Check calibration/range conversion, identity ambiguity, missing stereo support, simulator isolation and Stop behavior; run repository tests, typecheck, build and browser-check replay. Preflight findings and final results remain durable even when a gate fails.
