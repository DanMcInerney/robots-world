# Perception library comparison results

20 September 2026. **Keep simple mask median, cached geometry and bounded background diagnostics; advance Fast-FoundationStereo for fresh tests. Retain YOLO11 as the detector control. Do not adopt the combined tracker/YOLO26 candidate or claim TensorRT acceleration from this campaign.** Distance improved substantially, but target acquisition and identity remain the limiting problems.

Implemented all seven preselected arms in [the experiment package](../experiments/jev-library/README.md) and ran each on all 1,200 preserved Round 3 stereo acquisitions. The original box and cluster outputs were reproduced from their sealed evidence. These are 12 correlated scripted routes using one synthetic car asset; the old 400-frame confirmation subset is **reused**, not fresh held-out evidence. No thresholds or neural settings were adjusted from the comparison scores. No Jev calls, actuator commands or flight tests were needed.

[Open the comparison replay](http://127.0.0.1:8870/.runtime/experiments/jev-library-v1/index.html?route=occlusion-lookalike-confirmation-1&frame=20&left=archived_cluster&right=ffs_mask), [exact summary](../.runtime/experiments/jev-library-v1/summary.json), [frame records](../.runtime/experiments/jev-library-v1/replay.json), [comparison plan](jev-library-comparison-plan.md).

**Quality on the same 400 old-confirmation frames**

“Correct usable” means a finite range and a selected box with IoU at least 0.5 against the visible target reference. It does **not** assert that the numerical distance is accurate; distance error is scored separately. Wrong association includes both partial boxes below that threshold and actual wrong-car selections. MAE and p95 include every returned finite range, including wrong associations; unknowns remain in the coverage denominator. The distance reference is the median visible surface range, not object-center distance or obstacle clearance.

| Arm | Correct usable | Wrong | Unknown | MAE / p95, m | Errors >2 m |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archived box median | 244 | 16 | 140 | 0.308 / 2.055 | 14 |
| Archived nearest cluster | 244 | 16 | 140 | 0.338 / 1.979 | 11 |
| Simple mask median | 244 | 16 | 140 | 0.272 / 1.990 | 13 |
| BoT-SORT + mask median | 224 | 0 | 176 | 0.166 / 0.386 | 0 |
| Current-package YOLO11 + mask median | 244 | 16 | 140 | 0.270 / 1.980 | 13 |
| YOLO26 + mask median | 248 | 11 | 141 | 0.212 / 0.436 | 5 |
| YOLO11 TensorRT FP16 + mask median | 245 | 16 | 139 | 0.270 / 1.977 | 13 |
| Fast-FoundationStereo + original masks | 244 | 16 | 140 | 0.159 / 2.063 | 14 |
| YOLO26 + FFS + BoT-SORT | 258 | 30 | 112 | 0.056 / 0.141 | 0 |

**What the isolated comparisons establish**

- **Mask median removes a severe custom-clustering failure.** On the same correctly associated frames, cluster errors above 2 m fell from 5 to 0 in the old 400, and from 31 to 0 across all 1,200. In frame `occlusion-lookalike-confirmation-1-0020`, the reference is 10.631 m; cluster reports 7.174 m, mask median 10.839 m and FFS 10.721 m. Coverage is unchanged. Cluster still has slightly better mean errors in some simple scene families; median's benefit is removing severe cluster mistakes, not winning every statistic.
- **FFS is the clearest distance improvement.** With exactly the same original detections, accepted frames and target selections, total MAE falls from 0.272 to 0.159 m versus mask median. On the same 244 correctly associated frames, it falls from **0.165 to 0.047 m**. All 14 remaining errors above 2 m are association failures. FFS's numerical/geometric validity is not calibrated confidence, left/right consistency or a free-space guarantee.
- **YOLO26 trades detection failures.** Old-confirmation correct usable counts change from 61 to 88 in nominal-range scenes and 84 to 95 in wall/pole scenes, but from **94 to 58 with moving target and camera**. Nominal cases beyond 12 m improve from 0/17 to 5/17, still leaving 12 missing. Across all 1,200 frames it loses 75 correct usable measurements. This does not support a universal model upgrade.
- **BoT-SORT is a useful association component, but this binding policy is incomplete.** It reduces wrong associations from 16 to 0 in the old 400 while reducing correct usable ranges from 244 to 224. Occlusion confirmation supplies only 1/100 measurements. Binding a stable ID does not prove it belongs to the requested car, and never substituting a new ID can prevent useful reacquisition.
- **The combined candidate fails when the full population is considered.** Its low 400-frame range error hides 30 partial-box association failures. Across all 1,200 it makes 145 wrong associations, including **92 zero-overlap wrong-car selections** on one lookalike route. Accurate depth cannot repair a wrong target lock. Zero bound-ID changes is therefore not an identity-success metric.

Those conditional error and overlap diagnostics were calculated after scoring from the sealed replay and are saved with its hash in [post-score diagnostics](../.runtime/experiments/jev-library-v1/post-score-diagnostics.json). They explain the primary metrics; they do not replace the fixed population comparison.

**Check against the full 1,200-frame population**

| Arm | Correct usable | Wrong | Unknown | MAE / p95, m | Errors >2 m |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archived box median | 783 | 61 | 356 | 0.343 / 2.243 | 54 |
| Archived nearest cluster | 783 | 61 | 356 | 0.418 / 2.158 | 63 |
| Simple mask median | 783 | 61 | 356 | 0.303 / 2.152 | 52 |
| BoT-SORT + mask median | 695 | 5 | 500 | 0.172 / 0.419 | 0 |
| Current-package YOLO11 + mask median | 783 | 61 | 356 | 0.302 / 2.147 | 52 |
| YOLO26 + mask median | 708 | 34 | 458 | 0.236 / 0.490 | 22 |
| YOLO11 TensorRT FP16 + mask median | 783 | 61 | 356 | 0.302 / 2.147 | 52 |
| Fast-FoundationStereo + original masks | 783 | 61 | 356 | 0.186 / 2.125 | 54 |
| YOLO26 + FFS + BoT-SORT | 599 | 145 | 456 | 0.311 / 2.199 | 81 |

**Timing measured on this Windows laptop**

The separate [60-frame paired serial benchmark](../.runtime/experiments/jev-library-v1/benchmark/results.json) uses the original detector/environment for both configurations, alternating execution order on every twentieth frame of every route. Decode-through-measurement improves from **284.6 to 259.3 ms median** (8.9%) and **395.8 to 318.2 ms p95** (19.6%). All 60 stereo depth and validity arrays are bitwise equal. This comparison combines cached OpenCV/SGBM objects with removal of clustering and overlay work from the measurement path; it does not attribute the gain to caching alone.

Synchronous diagnostic writes/hashing cost 213.6 ms median in that control; admission to the bounded background writer costs 0.295 ms median, with capacity two, peak pending two, 2.14 ms total backpressure and a completed flush. The optimized diagnostic payload is smaller. Disk work still occurs and can create backpressure; it has not disappeared. Neither figure measures camera-to-Jev-to-actuator latency.

| Actual stage, 1,200 frames | Median, ms | p95, ms |
| --- | ---: | ---: |
| Current YOLO11 detector prediction, PyTorch | 11.17 | 21.06 |
| YOLO26 detector prediction, PyTorch | 11.93 | 16.98 |
| YOLO11 detector prediction, TensorRT FP16 | 17.61 | 23.99 |
| FFS complete stereo estimate, pre/model/post | 57.27 | 177.18 |

**TensorRT did not speed up the tested wrapper.** It also required a roughly nine-minute engine export. FFS has a promising median but a substantial tail. These quality runs reuse other components from disk and are not complete live-pipeline benchmarks. Stage quantiles must not be added. The historical Round 3 serial median of 187 ms was measured under different runtime conditions; the contemporaneous paired control above is the appropriate comparison for the implementation optimization.

**Implementation and qualification**

The new package contains cached OpenCV camera rays and SGBM matchers, mask-median range aggregation, a bounded artifact writer, real Ultralytics BoT-SORT, YOLO11/YOLO26/TensorRT backends, and a native Windows Fast-FoundationStereo backend. It includes isolated environment setup, provenance checks, CPU tests, evaluation and the side-by-side replay. Existing Round 3 source, images, predictions and environments were preserved. All seven new arms completed; none is silently substituted or omitted.

The neural runs used an RTX 5090 Laptop GPU, Torch 2.8.0+cu128, Ultralytics 8.4.157, TensorRT 10.13.3.9, YOLO11s-seg/YOLO26s-seg, and official FFS checkpoint `20-30-48` at four iterations. Input RGB is 640×360; detector padding is 384×640, including the static TensorRT engine. FFS uses the recorded calibration and 0.2 m stereo baseline. Exact hashes, package inventories, export evidence and settings are in the [prediction seal](../.runtime/experiments/jev-library-v1/prediction-seal.json) and linked setup records. GPU inference jobs did not overlap.

Independent preflight found incomplete artifact-integrity checks; those were repaired before scoring. Later, a Windows extended-path alias blocked sealing after successful prediction generation. Three linked bookkeeping amendments preserve the original freeze and failed attempts while handling equivalent existing paths and replay-relative paths. No predictions or neural/measurement settings were changed by those repairs. See [preflight resolution](../.runtime/experiments/jev-library-v1/preflight-resolution.json), [final path resolution](../.runtime/experiments/jev-library-v1/runtime-path-final-resolution.json), and [analysis seal](../.runtime/experiments/jev-library-v1/analysis-seal.json).

Repository tests: **337 passed, five skipped, zero failures**; typecheck and build passed. Component checks cover geometry, equivalent stereo, bounded artifact failures, real CPU tracking, evaluator populations, tampered/missing artifacts, Windows aliases and FFS calibration/padding. Replay controls, images, boxes, frame navigation and both population tables were checked in the browser. [Test log](../.runtime/experiments/jev-library-v1/checks/final-npm-test.log), [typecheck](../.runtime/experiments/jev-library-v1/checks/repair-typecheck.log), [build](../.runtime/experiments/jev-library-v1/checks/repair-build.log), [final evidence verification](../.runtime/experiments/jev-library-v1/logs/final-verify.log).

The next discriminating test should use fresh cars, views, motion and lookalikes: keep YOLO11 as the control, test mask median versus FFS at fixed detections, then test explicit acquisition/reacquisition separately. Measure the actual integrated detector-plus-depth pipeline with bounded diagnostics before claiming a latency gain. These results support better range observations for Jev; they do not yet qualify reliable find-and-follow control.
