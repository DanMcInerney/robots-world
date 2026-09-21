# Latest results: perception and text observations for drone control

Updated 20 September 2026.

**We can give Jev or Claude Code a compact, sensor-derived description of visible objects, their direction and distance, and unresolved ambiguity. Distance estimation improved; acquiring and retaining the correct target remains the main problem.**

The intended task is one drone receiving a general goal such as “find the blue car, then follow it at a certain distance.” Perception converts camera/sensor data into observations; the controller chooses actions; the executor enforces the available command contract. Controllers must never receive simulator-only target identities, reference depth or spectator state.

## What we implemented and measured

Seven new perception variants were run on all 1,200 preserved Round 3 stereo acquisitions and compared with the original box and cluster outputs. These are 12 correlated scripted routes with one synthetic car asset. The old 400-frame confirmation subset is reused retrospective evidence, not fresh held-out qualification. The library comparison made no Jev calls and executed no flight commands.

| Technique | Measured result | Current recommendation |
| --- | --- | --- |
| Simple median of valid depth inside the object mask | Eliminated all 31 cluster errors above 2 m on correctly associated frames across 1,200, with unchanged coverage | Keep; simpler and avoids the demonstrated cluster failure |
| Fast-FoundationStereo + original object masks | On the same 244 correctly associated old-confirmation frames, mean absolute distance error fell from 0.165 to 0.047 m versus mask median with SGBM | Advance to fresh tests |
| Cached OpenCV geometry/SGBM, simpler aggregation, bounded background diagnostics | Paired serial compute median 284.6 → 259.3 ms; p95 395.8 → 318.2 ms on 60 predetermined frames | Keep these implementation improvements; the benchmark changes several things together |
| BoT-SORT + conservative target binding | Wrong associations fell 16 → 0 on the old 400, but correct usable measurements fell 244 → 224 | Useful component; acquisition/reacquisition policy remains incomplete |
| YOLO26 versus current-package YOLO11 | Nominal old-confirmation coverage improved 61/100 → 88/100, but moving-target/camera coverage fell 94/100 → 58/100 | Retain YOLO11 as the control |
| TensorRT FP16 YOLO11 | Detector prediction median 17.61 ms versus PyTorch 11.17 ms | No demonstrated speedup in this setup |
| YOLO26 + FFS + BoT-SORT | Across 1,200: 599 correct usable / 145 wrong associations versus original 783 / 61; 92 selections had zero target overlap | Do not promote the combined candidate |

“Correct usable” means a finite range plus a selected box meeting the evaluator's IoU ≥ 0.5 association criterion; it does not guarantee accurate distance. On all 260 accepted old-confirmation measurements, including wrong associations, FFS reduced mean absolute error from 0.272 to 0.159 m. The same 16 wrong associations remained, and all 14 FFS errors above 2 m were association failures. Good depth does not fix choosing the wrong car.

The concrete cluster failure is frame `occlusion-lookalike-confirmation-1-0020`: reference surface distance 10.631 m; old cluster 7.174 m; plain mask median 10.839 m; learned stereo 10.721 m.

Current implementation: Ultralytics YOLO11s-seg/YOLO26s-seg and BoT-SORT; OpenCV camera geometry and SGBM; official Fast-FoundationStereo; optional TensorRT. The latest runs used an RTX 5090 Laptop GPU. FFS's stereo-estimate stage measured 57.27 ms median / 177.18 ms p95. These component timings are not complete camera-to-controller-to-actuator latency, and their quantiles must not be added.

Repository validation for that implementation: 337 tests passed, five skipped, zero failures; typecheck/build, browser replay checks and final evidence-integrity verification passed. Original Round 3 evidence was preserved. These results do not qualify hardware, obstacle clearance or reliable find-and-follow control.

## What to present to Jev or Claude Code

Use one compact observation format for both controllers. Repeat the exact goal and current relevant state, then list a bounded number of object candidates. Deliver evidence separately from controller decisions.

| Information | What it supports | Status and limits |
| --- | --- | --- |
| Object candidates: class, color match, local ID, detection score | Identify possible matches for “blue car” | Available from perception; detector score is not probability of correct target identity |
| Camera-relative bearing and surface range | Turn toward an object; compare distance with the goal | Geometry and range are implemented; declare coordinates, units and camera mounting; range is to visible surface, not object center |
| Current observation, lost status, competing candidates | Decide whether identity is supported or ambiguous | Tracking is implemented but fallible; stable IDs do not certify identity |
| Acquisition time, delivery time and derived age | Understand when each measurement was obtained | Preserve these separately; continuous acquisition does not make a previous decision instantaneous |
| Heading, altitude, velocity, mode and command execution status | Interpret the drone's motion and previous command | Include only actual adapter/telemetry fields; admission is not completion; this comparison did not qualify a complete MAVLink telemetry loop |
| Bearing/range change and last-seen history | Detect closing, separation and loss | A proposed compact extension requiring tested timestamp/history calculations; target world velocity also needs ego-motion compensation |
| Missing depth, identity ambiguity and clearance unknown | Hold or request a more useful view | Explicit unknowns are essential; target distance alone does not establish a traversable path |

Raw edge lists, dense depth maps and long pixel-coordinate dumps are not needed in the initial controller prompt. The tested gains come from extracting object-level geometry. Richer spatial maps may help later, but have not been shown necessary or effective by this comparison.

Illustrative proposed text record, **not a captured result or an already-qualified controller interface**:

```text
GOAL: Find the blue car and follow at 10 m surface distance.
OBSERVATION: camera-relative; bearing positive right; age=0.12 s

A: class=car; color=blue; bearing=+0.21 rad; surface_range=13.2 m
   range_source=stereo+mask_median; observation=current
B: class=car; color=blue; bearing=+0.49 rad; surface_range=18.5 m
   range_source=stereo+mask_median; observation=current

TARGET_IDENTITY: unresolved; two candidates match the goal
OBSTACLE_CLEARANCE: unknown
```

For Jev's limit of 255 choices per question, a small candidate set and a few bounded questions fit naturally: target A/B/unresolved; viewing direction left/maintain/right; distance response approach/maintain/retreat/insufficient evidence; next observation current view/scan/another view. These are proposed decision categories, not independently executable simultaneous commands. Resolve dependencies and check the joint action before execution. Claude Code can consume the same record and request additional evidence through available tools.

The most promising next tests are fresh distant/moving target acquisition, same-color lookalikes and reacquisition after occlusion. Keep a YOLO11 control, isolate FFS range gains from identity policy, and measure the actual integrated pipeline before returning to executed approach/hold/follow experiments. The combined text interface above still needs controller-level testing.

## Durable evidence and implementation

- [Full library comparison report](docs/jev-library-comparison-results.md)
- [Preselected comparison plan](docs/jev-library-comparison-plan.md)
- [Implementation, setup and reproduction commands](experiments/jev-library/README.md)
- [Failure history and next-test rationale](docs/design-failures.md)
- [Original Round 3 results](docs/jev-round3-results.md)
- [Library research](docs/jev-perception-library-options-2026-09-20.md)
- [Exact comparison summary](.runtime/experiments/jev-library-v1/summary.json)
- [Post-score distance/association diagnostics](.runtime/experiments/jev-library-v1/post-score-diagnostics.json)
- [Paired compute benchmark](.runtime/experiments/jev-library-v1/benchmark/results.json)
- [Open the comparison replay](http://127.0.0.1:8870/.runtime/experiments/jev-library-v1/index.html?route=occlusion-lookalike-confirmation-1&frame=20&left=archived_cluster&right=ffs_mask)

Runtime evidence is local and ignored by Git; the report and implementation remain durable repository files. The replay link requires the local server on port 8870.

## Text-encoding probes for scouting and range following, 2026-09-20

Both predeclared gates **failed** at confirmation. For an unseen object, a memory-less current view and a
dated log of past views gave Jev zero useful positive-case answers (0/72 combined); only per-offered-option
computed consequences showed real directional competence, and even that failed specifically when choosing
among a translate, a hold and a re-scan yaw with no single option's text distinguishing the right one. For
range following, a compact derived signed-error scalar matched a richer per-option "resulting range" on
development, then produced 4 confirmation-only harmful choices while the richer form held at 116/116 across
both splits — a caution against trusting a cheaper representation on a development tie alone. The run also
exposed a flaw in this experiment's own payload-based selection rule, not only in Jev's answers. Present
range decisions with the resulting range/error computed for every option, not a signed scalar alone; do not
yet trust a compact scouting-state summary for search decisions. [Full results and reproduction](docs/jev-scout-encodings-results.md).
