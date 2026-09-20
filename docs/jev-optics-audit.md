# Audit of the proposed optics and spatial-text stack

Checked against primary sources on 18 September 2026. This reviews the Gemini research supplied by the user. It supplements the [camera representation proposal](jev-camera-representation.md). Implementation and real inference are recorded separately in the follow-up [camera-only control pilot](jev-pixels.md).

The useful additions are an optional **sector summary**, inexpensive tracking between detector passes, and clear separation of measured geometry from learned estimates. Several supplied claims would grant more information than the named sensor/library actually produces.

## What the libraries actually provide

| Candidate | Finding | Experimental consequence |
| --- | --- | --- |
| [Ultralytics OBB](https://docs.ultralytics.com/tasks/obb) | The output is a rotated **2D image box**. The documentation explicitly describes the box as directionless under a 180-degree rotation. It is not a generic 3D heading estimator. | Use image centre, extent and image-plane box orientation. Obtaining vehicle front/back or world yaw requires additional keypoints, a declared object model, motion evidence or another estimator. Ordinary boxes are enough for initial tracking. |
| Known-size monocular ranging | The [pinhole model](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html) supports `Z ≈ fy * H / h` for the corresponding calibrated projection and known physical extent. `Z` is optical-axis depth; off-axis Euclidean range differs. | Real object size, camera calibration and orientation assumptions must be declared. Class-average vehicle height is a prior with uncertainty, not an exact measurement. Never read the simulated target's dimensions at runtime to supply a supposedly unknown scale. |
| [Depth Anything V2 metric models](https://github.com/DepthAnything/Depth-Anything-V2/blob/main/metric_depth/README.md) | Metric checkpoints are separate models fine-tuned for indoor/outdoor data; Small is 24.8M parameters. Their outputs estimate metres, unlike ordinary relative-depth checkpoints. | Pin the checkpoint and output units. A relative map cannot be labelled `5.0 m`. A metric model can report estimated metres, but its errors and domain sensitivity must be measured. No per-frame fitting to hidden simulator depth. |
| [DepthAI spatial detection](https://docs.luxonis.com/software-v3/depthai/depthai-components/nodes/spatial_detection_network/) | It combines detections with aligned depth and an ROI aggregation method. Background inside the box can distort the result; the docs specifically discuss thin objects and holes. | Useful estimated XYZ from a stereo sensor package, not exact coordinates for every object. Simulate calibrated stereo images and run correspondence if claiming a camera-derived pipeline. An ideal-depth plugin is a different sensor assumption. |
| [ArUco](https://docs.opencv.org/4.x/d5/dae/tutorial_aruco_detection.html) / [AprilTag](https://github.com/AprilRobotics/apriltag) | Pose requires detected image corners, camera intrinsics and physical tag size. AprilTag exposes explicit pose-estimation inputs. | Legitimate for instrumented docking/gates. Preserve detection loss and ambiguity. Rotation vectors are axis-angle representations, not three Euler angles to relabel directly. General target tracking must work before a small roof marker becomes readable. |

The quoted 30–60 FPS YOLO and 15–30 ms depth numbers do not identify enough hardware and execution conditions to use as our budget. The [Ultralytics Jetson guide](https://docs.ultralytics.com/guides/nvidia-jetson) distinguishes device-specific engines and runtime configuration. Exporting to ONNX alone does not establish accelerator support, speed or memory fit. Qualify the exact checkpoint, resolution, precision, board, runtime and power mode; include capture, preprocessing, tracking, transfer and serialization in timing.

OAK offloads work rather than eliminating its cost. The [OAK-D Lite product page](https://shop.luxonis.com/products/oak-d-lite-1) listed **US$269** when checked. Its [hardware documentation](https://docs.luxonis.com/hardware/products/OAK-D%20Lite) lists 2.5–3 W for base operation/streaming, with additional subsystem consumption. This is a useful alternative hardware tier, not the minimum-cost single-camera baseline. Its RVC2 uses Myriad X; the supplied Myriad X/Keembay description should not be treated as interchangeable device specifications.

## Sensor-table corrections

| Supplied claim | Correction and relevance |
| --- | --- |
| VL53L5CX/L8CX produces 8×8 at up to 60 Hz | For the L8CX, [ST's driver manual](https://www.st.com/content/st_com/en/technical-documents/UM3109.html) specifies **8×8 up to 15 Hz**, **4×4 up to 60 Hz**. It also documents zone orientation and per-target status. Its [datasheet](https://www.st.com/resource/en/datasheet/vl53l8cx.pdf) specifies up to 4 m, with I²C/SPI. Treat this as an optional future measured-depth arm, not a camera-only feature. |
| BNO085/BNO055 provides drift-free orientation | [CEVA's BNO08X datasheet](https://www.ceva-ip.com/wp-content/uploads/BNO080_085-Datasheet.pdf) describes yaw drift in game rotation mode; magnetometer-based modes trade that for magnetic-field sensitivity. [Calibration](https://www.ceva-ip.com/wp-content/uploads/2019/09/BNO080-BNO085-Sesnor-Calibration-Procedure.pdf) matters. BNO085 is documented by CEVA, not interchangeable with Bosch's BNO055. Orientation/linear acceleration does not directly provide reliable absolute position or altitude. |
| PMW3901 gives ground velocity | It gives optical motion measurements. [PX4's optical-flow setup](https://docs.px4.io/main/en/sensor/optical_flow) uses a downward camera and distance sensor for velocity estimation. Rotation compensation, scale, surface texture and estimation matter. Removing the rangefinder cannot leave an undeclared perfect metric-velocity source behind. |
| Garmin v3/v4 is uniformly a 40 m sensor | The [v4 LED manual](https://static.garmin.com/pumac/LIDAR-Lite%20LED%20v4%20Instructions_EN-US.pdf) specifies **5 cm–10 m**, 14.6 g, and I²C/ANT interfaces. Specifications differ between models. Do not carry the combined price/range/weight row into a device profile. |
| TF-Luna supplies ASCII distance | Our [existing module and protocol audit](jev-physical-sensors.md) document its binary UART packet. A library can decode it and then create text. A downward beam measures along its mounted ray, not automatically vertical height above a level ground plane. |

The supplied prices and weights mix bare components and assembled boards and are not a verified bill of materials. No purchase or additional rangefinder is proposed for the current camera-only comparison.

## A useful sector representation without invented clearance

Keep tracked objects for mission identity and bearings; add sectors for broad scene structure only when a real pixel-processing method supplies those fields. They answer different questions. A sector table alone cannot identify the particular object named in an English goal.

For a relative-depth model, a possible text fragment is:

```text
depth_source: DepthAnythingV2-Small, relative estimate
frame_age_ms: 120
centre: estimated nearer than left and right in this frame
metric_distance: unknown
accuracy: not calibrated
```

Do not substitute `SECTORS_METRIC` merely because the numbers look like distances. Relative scale can also change between frames. A numeric finite-value fraction is not model confidence. If the model emits no calibrated uncertainty, report that rather than inventing one from its prediction.

For qualified metric depth, retain units, provenance, age and unsupported pixels, plus a small distribution summary. A mean alone can hide a narrow nearby pole against a distant background. Test a low percentile and nearest spatially supported component alongside the median; neither a single noisy minimum nor an empty sector proves a traversable corridor. Freeze aggregation rules on development data and include thin obstacles in held-out tests. These are proposed measurement summaries, not an obstacle-avoidance script.

For very small compute, first benchmark a lightweight detector at a lower rate with cheaper tracking between detections. Each tracked update must refer to new image evidence and preserve age of its semantic label; stale boxes must expire. Then decide whether dense depth supplies enough additional task value to justify its memory, energy and latency. No claimed frequency is a measured result yet.

## Changes worth testing in Robots World

Keep the current generic contracts. Use ordinary perception modules consuming the delivered images and declared onboard measurements; the core does not need another planner or scene-graph framework.

1. **Camera objects and tracks:** compare inexpensive regions/tracking with a small semantic detector on identical frames. Use unrelated and same-colour distractors, partial views, motion blur, lighting changes and target loss. Evaluate real-image clips as well as the simple renderer before claiming hardware relevance.
2. **Objects plus relative sectors:** add a genuine RGB-to-depth model and its compact summary. Keep Jev's action menus fixed. Measure whether the added evidence improves following/avoidance sufficiently to cover the computation and observation delay. Retain a separate no-depth arm.
3. **Resource and evidence checks:** measure peak memory and actual wall latency of each stage on named hardware. Simulated resource-delay budgets must be labelled simulated; a desktop model benchmark is not an onboard benchmark. Replay identical pixels/calibration/declared telemetry into perception while changing hidden scene metadata; outputs must stay identical. Maintain source-image overlays and inspect exact text sent to Jev.

Ground truth remains available only to the evaluator for error measurement. Perception may use general trained priors, measured calibration and declared known markers. It must not receive simulator object labels, oracle heading, hidden dimensions, depth textures, future trajectories or privileged target selection. Every estimate should remain distinguishable from a measurement, and every action from a formatter-derived fact.

## Correct the actuation semantics too

The supplied `CLIMB`/`DESCEND` and forward-speed choices can map to velocity setpoints; calling them throttle confuses different control levels. [MAVLink `SET_POSITION_TARGET_LOCAL_NED`](https://mavlink.io/en/messages/common.html#SET_POSITION_TARGET_LOCAL_NED) carries masked position/velocity/acceleration and yaw fields, not raw motor throttle. Convert degrees to radians, choose a supported coordinate frame, and make NED's downward-positive Z explicit.

[PX4 Offboard](https://docs.px4.io/main/en/flight_modes/offboard) requires a continuous proof-of-life stream and suitable onboard state estimation. A local adapter should stream Jev's last authorized, unexpired setpoint while inference runs; it must not keep an old command alive indefinitely. High model confidence cannot replace those requirements.

The existing Robots World plant assumes stabilized velocity tracking. That is declared software-test assistance, not evidence that a cheap camera and IMU have already supplied a real drone's velocity estimate. A hardware qualification must establish the estimator too. Jev can still select the navigation and camera commands; stabilization and protocol maintenance belong to the flight stack and adapter.
