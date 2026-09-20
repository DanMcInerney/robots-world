# Libraries worth testing for Jev perception

Research date: 20 September 2026. These are recommendations from source inspection and current primary documentation, not newly measured improvements. No packages, models or experiment settings were changed for this report.

## Recommendation

Use more of Ultralytics and OpenCV before introducing a larger robotics stack. Add persistent tracking, compare a newer detector, and optimize inference as separate experiments. Fast-FoundationStereo is the strongest new stereo candidate identified here. ZED and DepthAI offer broader integration when choosing camera hardware, but neither is a straightforward replacement for our arbitrary simulated-image pipeline on this Windows laptop.

The important custom code to reconsider is target association across frames, camera projection, and selection of depth inside a target. Keep the small Jev text formatter, goal-relative arithmetic, explicit unknown states and action mapping under our control.

## What the existing experiment actually uses

[Round 3 results](jev-round3-results.md) and [the runner](../experiments/jev-round3/perception/run.py) establish the baseline: Ultralytics 8.3.221 / YOLO11s-seg, FP32 PyTorch inference, OpenCV CPU StereoSGBM, NumPy calculations, an HSV blue test, and handwritten mask/depth association. Round 3 processes detections independently per frame; it has no persistent tracker.

Detection is the first quality bottleneck: nominal confirmation supplied 61/100 correct usable observations, including zero detections in 17 frames beyond 12 m. The depth-cluster rule is a separate problem: in one well-segmented example it selected 7.174 m for a target at 10.631 m. Aggregate confirmation range error increased from 0.308 m with the box median to 0.338 m with the mask/cluster method.

Warm serial perception took 187 ms median; detector and stereo component medians were 59 and 92 ms. Diagnostic writes added a separately measured 118 ms median. These are component measurements, not end-to-end drone control latency.

## Ranked options for this codebase

### 1. Ultralytics: improve detection and use its existing tracker

There are two independent experiments here. First, compare YOLO26s-seg against our YOLO11s-seg using a separate environment; current Ultralytics supports that segmentation checkpoint, but our pinned version predates it. General benchmark improvements do not establish better recall on our rendered car. [Official YOLO26 documentation](https://docs.ultralytics.com/models/yolo26).

Second, use built-in BoT-SORT for persistent IDs and camera-motion compensation rather than designing a tracker ourselves. ByteTrack is a simpler comparison. BoT-SORT's optional appearance re-identification adds work and does not guarantee identity among similar blue cars. Our pinned release already supplies BoT-SORT with sparse optical-flow compensation and re-identification disabled by default. Low-confidence association requires actually passing weak detections to the tracker; keeping the old 0.25 detector cutoff would discard some of that evidence. [Tracking documentation](https://docs.ultralytics.com/modes/track), [our version's configuration](https://raw.githubusercontent.com/ultralytics/ultralytics/v8.3.221/ultralytics/cfg/trackers/botsort.yaml).

This primarily addresses continuity after acquisition. It cannot reliably acquire a distant car the detector never sees. Track predictions must remain distinct from fresh depth measurements.

### 2. Fast-FoundationStereo: replace the stereo backend

This NVIDIA research implementation accepts calibrated rectified stereo images and produces disparity/depth. It directly targets correspondence quality, which our segmentation/nearest-cluster heuristic cannot repair. The authors report 14.0–23.4 ms TensorRT inference at 640×480 on an RTX 3090, depending on checkpoint and iterations. Those numbers are not a comparison against our measured 92 ms CPU SGBM stage: hardware, preprocessing and timing scope differ.

Its reference setup is Linux/Docker-oriented; native Windows and our RTX 5090 software combination need qualification. Current instructions require dimensions divisible by 32, so 640×360 needs compatible padding and calibration handling. Research and commercial code/checkpoint paths have different licensing arrangements. [Official repository, performance table and installation instructions](https://github.com/NVlabs/Fast-FoundationStereo).

### 3. TensorRT FP16: accelerate the existing detector

Ultralytics supports TensorRT export and loading the resulting engine through its model API. Start with the same YOLO11s-seg weights and FP16, preserving the task and input size, then measure output changes and complete preprocessing-to-mask latency. This could replace PyTorch execution without rewriting detection or association. No speedup has been measured on our laptop. [Official TensorRT integration](https://docs.ultralytics.com/integrations/tensorrt).

Do not change detector family, precision and tracker simultaneously: that would obscure what helped.

### 4. OpenCV camera geometry: remove duplicated projection code

We already depend on OpenCV. Its `undistortPoints`, `projectPoints` and `reprojectImageTo3D` cover standard camera rays, projection and calibrated disparity-to-XYZ conversion. Use these where we currently maintain equivalent geometry, with fixtures preserving our half-pixel image convention and ENU conversion. Euclidean range is the norm of XYZ; optical-axis Z is different. This is primarily a correctness and maintenance improvement, not a cure for bad disparity. [OpenCV camera geometry](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html).

### 5. ZED SDK / DepthAI: consolidate around a camera platform

ZED can take custom detector boxes and supply 3D object position, velocity and tracking using its depth and camera-pose stack. This could eliminate substantial association and motion-estimation code. However, arbitrary Robots World stereo arrays are not a documented input path; the official Isaac Sim integration is a supported simulation exception. Treat a Robots World streaming adapter as additional, unqualified engineering. [Custom detector integration](https://docs.stereolabs.com/docs/development/zed-sdk/modules/object-detection/custom-object-detection), [official simulation integration](https://github.com/stereolabs/zed-isaac-sim).

DepthAI v3 combines spatial detection, tracking and depth, including newer segmentation-mask refinement. It accepts stereo images from the host, but its StereoDepth node computes on RVC2/RVC4 hardware, not the laptop's RTX GPU. Some spatial-calculation and tracking components can execute on the host, so partial reuse is possible. For a complete pipeline, it is most attractive when choosing compatible camera hardware. [Stereo from host](https://docs.luxonis.com/software-v3/depthai/examples/stereo_depth/stereo_depth_from_host), [v3 release notes](https://docs.luxonis.com/software-v3/depthai/release-notes).

## Simplifications that need no new library

- Reuse SGBM matcher objects and precompute fixed camera rays instead of reconstructing them per image.
- Keep compressed diagnostics and preview generation outside the control-critical path, with bounded background work.
- Test median valid depth inside the predicted mask before adding another clustering package. A library implementation of clustering would not fix our unsupported assumption that the nearest cluster is the correct target depth.
- Retain a compact observation adapter: target ID/class/colour evidence, camera-relative position or range/bearing, measured versus predicted status, ambiguity, and goal-relative distance error. The perception library supplies observations; Jev still receives text and chooses actions.

## Next experiments

Run separately: detector coverage challenger; simple mask-depth median; BoT-SORT continuity; same-model TensorRT; learned stereo backend. Use the old failures as development examples and reserve fresh scenes for confirmation. Grade correct usable coverage, wrong-target acceptance, large range errors and full perception latency. For tracking, also grade reacquisition and identity swaps. Do not promote a faster pipeline if it produces more confident wrong-target or wrong-range observations.

These suggestions do not establish that Jev can yet execute the full find-and-follow goal. Round 3 stopped at its perception gate before Jev flight trials.
