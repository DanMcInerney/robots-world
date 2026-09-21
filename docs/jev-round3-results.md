# Round 3 results: 3D stereo perception before Jev flight

19 September 2026, local date. Executed the [frozen plan](jev-round3-plan.md): twelve ten-second Robots World routes, 1,200 stereo acquisitions, two association methods sharing identical RGB, detector outputs and stereo depth. Eight routes were development; four were reserved confirmation. Source/settings were frozen before generation; no tuning or reruns followed scored inference.

**The perception gate failed on detection coverage. Stereo range was useful when the correct car was detected, but the current frontend does not consistently supply Jev with a trustworthy target observation.** The dependent 144 Jev wording probes and flight stages were not run; this round made zero paid Jev calls.

## Confirmation results

Range is Euclidean distance from the left camera to the median visible target surface. “Usable” below requires a single blue-car candidate, a supported range and target-box IoU of at least 0.5. Error statistics include every accepted range, including incorrect associations; missing ranges remain in the coverage denominator.

| Scene, 100 frames each | Correct usable, both methods | Box mean absolute error | Mask/cluster mean absolute error | Accepted associations failing IoU |
|---|---:|---:|---:|---:|
| Nominal distance changes | 61/100 | 0.175 m | 0.119 m | 0 |
| Wall and pole | 84/100 | 0.229 m | 0.151 m | 0 |
| Occlusion and lookalike | 5/100 | 1.503 m | 2.445 m | 16 |
| Moving car and camera | 94/100 | 0.197 m | 0.177 m | 0 |

The nominal gate required at least 90/100 correct usable observations. Both methods instead had 39 missing detections, despite the target being visible in every reference frame. Their returned ranges passed the error requirements: p95 errors were 0.426 m for the box and 0.307 m for the mask/cluster, with no errors exceeding 2 m. At 8–12 m, only 29/45 frames supplied a range. A post-run distance breakdown found zero detections in the 17 nominal confirmation frames above 12 m. These are correlated views of one rendered asset, not a general detector benchmark.

## What we learned

**Masks help separate target pixels from background, but this foreground-cluster rule is not a reliable depth validator.** On nominal confirmation, average selected background support fell from 12.4% to 1.6%. Across all confirmation scenes it fell from 22.1% to 7.4%, with the same 260 accepted measurements. However, total mean range error worsened from 0.308 m to 0.338 m because occlusion failures outweighed the simpler scenes' gains. Neither method earned promotion.

The most useful counterexample is `occlusion-lookalike-confirmation-1-0020` (zero-based frame 20; replay frame 21, time 2.1 s). Reference range is **10.631 m**; box median is **10.858 m**; mask/foreground cluster is **7.174 m**. The detection passes association at IoU 0.942, and **97.5% of the cluster's selected image pixels belong to the target**. The cluster still chooses a bad stereo range. This demonstrates that correct image segmentation does not guarantee correct correspondence/depth at those pixels. The nearest supported cluster can concentrate bad near-range estimates; lower background contamination alone does not establish trustworthy distance.

**Frame-local colour and class do not preserve target identity.** The occlusion confirmation route yielded 78 ambiguous frames, one missing frame and 21 single-candidate frames. Sixteen accepted associations failed the declared IoU criterion: fourteen had zero overlap with the intended car and selected the lookalike; two were partial target detections below the 0.5 threshold. These are association errors, not sixteen measured tracking switches: this baseline has no persistent tracker. Five frames passed association, but their mask/cluster ranges still exceeded 2 m error. Depth and identity require separate checks.

**The renderer/detector pairing needs qualification beyond three smoke views.** The small detector recognized all preparation views, but that did not predict sustained route coverage. Nominal development coverage was also only 74/100 and 70/100. Some scene objects were classified as bus or truck. These synthetic failures do not establish equivalent failure rates on real cameras; renderer appearance, viewpoint and detector behavior remain confounded.

## Timing and scope

Warm serial image decoding, GPU detector, CPU SGBM and association took **187 ms median / 314 ms p95** per stereo acquisition. Component medians were 59 ms detector and 92 ms stereo; these ran sequentially. Saving diagnostic artifacts added a separately measured 118 ms median. The offscreen Intel renderer took 325 ms median / 521 ms p95, including evaluator passes and excluding image writes. These component timings are not end-to-end control latency, and their quantiles must not be added as if they were a measured latency distribution.

Camera poses came from actual Rapier drone motion; images were rendered afterward. All twelve runs rejected old authority after Stop and recorded zero subsequent command applications. This qualifies the scripted acquisition/evidence path, not Jev control, obstacle avoidance, MAVLink or hardware. One car mesh and four reserved routes cannot establish broad reliability.

## Next isolated experiments

1. **Repair detection coverage first:** hold stereo and text constant; qualify one detector/imagery intervention on fixed range/viewpoint cases, with fresh reserved scenes and a real recorded-camera comparison. Do not lower a threshold and declare this confirmation set passed. Initial acquisition beyond 12 m must work before a tracker can help.
2. **Remove the nearest-cluster preference:** compare median depth over the predicted mask with this frozen mask/cluster baseline. Keep detections and stereo identical. Grade large near errors and usable coverage, not just background support. The 7.17 m counterexample makes this a particularly direct test.
3. **Add bounded temporal association as a separate test:** maintain candidate tracks and explicit ambiguity through missed detections/lookalikes. Measure wrong-target acceptance and reacquisition as well as recall; predicted or stale track state must not masquerade as a fresh observation.

Then resume the already defined signed-distance-error wording probes and short executed approach/hold trials. The proposed compact text structure—target observations, identity uncertainty, measured range/bearing, goal-relative error and separate local geometry—remains the direction to test. This round does not yet establish an ideal Jev representation, and did not test edge features or learned stereo.

**2026-09-21 note:** the signed-distance-error probe this closing sentence points to is superseded — F75 ran it (`signed-error`) alongside a per-option `after-range` alternative and found `after-range` robust (116/116 both splits) where `signed-error` failed confirmation (4 harmful choices) despite an identical development score. The detection-coverage gap this round found (61/100, 0/17 beyond 12 m) is addressed by the [find-and-follow ladder](jev-find-follow-ladder.md)'s L0 detection-envelope sweep, which also corrects this document's implicit range assumption: the actual rendered reference-range span across all 1,200 frames was 5.15–14.998 m, so "0/17 beyond 12 m" describes only the 12–15 m band, not a tested-and-failed 15–40 m range.

## Replay and evidence

- [Open the local replay](http://127.0.0.1:8870/.runtime/experiments/jev-round3-v1/index.html#replay): select a route, scrub or play; all 1,200 frames retain stereo RGB, overlay, depth and evaluator reference.
- [Exact summary](../.runtime/experiments/jev-round3-v1/summary.json), [post-run diagnostics](../.runtime/experiments/jev-round3-v1/diagnostics.json), [immutable perception handoff](../.runtime/experiments/jev-round3-v1/perception-handoff.json).
- [Source freeze](../.runtime/experiments/jev-round3-v1/source-freeze.json), [input freeze](../.runtime/experiments/jev-round3-v1/input-freeze.json), [prediction seal](../.runtime/experiments/jev-round3-v1/prediction-seal.json), [analysis seal](../.runtime/experiments/jev-round3-v1/analysis-seal.json).
- [Original independent preflight BLOCK](../.runtime/experiments/jev-round3-v1/preflight-review.md) and [one coordinated repair resolution](../.runtime/experiments/jev-round3-v1/preflight-resolution.json). The repair corrected the promotion population/metric and evidence chain before scoring; it is not a second independent verdict.

Verification: 331 repository tests passed, five skipped; six evaluator/integrity tests passed; typecheck, build and whitespace checks passed. The build retains its existing bundle-size advisory. Browser checks verified route selection, scrubbing, playback, pause and all four matching frame assets. Failed preparation and scored evidence remain intact.
