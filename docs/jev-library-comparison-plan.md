# Perception library comparison

20 September 2026. Implement the [library recommendations](jev-perception-library-options-2026-09-20.md), then compare against preserved Round 3 evidence. This is a retrospective comparison on the same 1,200 images, not a fresh confirmation study. The old development/confirmation labels are retained only for matching prior reports. No detector thresholds or model choices will be selected from these comparison scores.

## Changes and independent arms

1. OpenCV camera rays, reused SGBM matchers, and a simple median of valid depth inside the predicted object mask. Replay old predictions to isolate aggregation. Test geometry and SGBM equivalence separately.
2. BoT-SORT association and explicit target binding on the recorded YOLO11 detections. Reset on each route; acquire only a sole visible blue-car candidate; retain the bound ID through ambiguity; return unknown when that ID has no current observation. The tracker cannot recover detections discarded by the original confidence threshold. Do not relabel predictions as fresh measurements.
3. Current Ultralytics YOLO11s-seg control versus YOLO26s-seg, holding original confidence, image size, colour test and recorded stereo fixed. The extra YOLO11 control separates package-version changes from model changes.
4. TensorRT FP16 YOLO11s-seg versus its current-package PyTorch control. Same input settings and recorded stereo. Record export/setup failures rather than silently substituting another backend.
5. Fast-FoundationStereo on the recorded RGB pairs, holding original detector output and simple mask median fixed. Keep the network's declared validity policy separate from SGBM's texture/LR checks. Record installation/platform gaps if actual execution is unavailable.
6. A preselected combined candidate: YOLO26 detections, Fast-FoundationStereo depth, mask median and BoT-SORT binding. Reuse the exact independent component outputs to avoid additional neural variation. This deliberately changes multiple components and is interpreted alongside the isolated comparisons, not as attribution to one library.

ZED/DepthAI require camera-platform integration and are not part of this host-only implementation. Jev inference, live aircraft and MAVLink effects are not needed for these perception comparisons.

## Evidence and checks

All new code lives in `experiments/jev-library`; evidence and isolated environments live under ignored `.runtime/experiments/jev-library-v1`. Preserve old code, predictions, images, seals and environments. Hash source/settings/model/input provenance before scored runs; retain failed attempts. Perception receives only RGB, calibration and old sensor-derived predictions. The evaluator alone reads reference masks/depth.

Use all 1,200 frames for quality comparisons that execute successfully. Report the fixed 400-frame old-confirmation subset, per-family results, all-frame results, accepted wrong associations, correct usable ranges, unknowns, mean/p95 absolute errors and errors exceeding 2 m. Include missing detections in the coverage denominator. Tracking also reports current observation coverage, acquisition/loss and ID changes. Same-colour target binding is fallible and may acquire the wrong car; the evaluator must count that.

Measure GPU stages with explicit synchronization and no competing benchmark. Quality runs that reuse recorded stereo are not full live-pipeline timings. Separately benchmark the actual original and optimized serial pipeline on every twentieth frame of each route (60 predetermined frames), including decoding and all compute, with diagnostic work timed separately. No sum of component quantiles is presented as measured end-to-end latency. Bounded background artifact writes must flush before completion and propagate failures.

Run meaningful component tests, repository tests, typecheck and build. Independently review the stable joined implementation before the scored campaign. Save summaries, raw predictions and a comparison viewer/report. No change is promoted to a reliable find-and-follow solution from these reused scenes alone.
