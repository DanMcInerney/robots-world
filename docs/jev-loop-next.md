# Proposed next camera/Jev loop

Research and code review: 18 September 2026. This is a proposal, not another executed experiment. The completed [pixel pilot](jev-pixels-results.md) and its frozen evidence remain unchanged.

Follow-through: [camera-loop ablations](jev-loop-experiments.md) implement a bounded subset. [Design failures](design-failures.md) records the reasons, evidence and outcomes. Items below not covered by that experiment remain proposals.

## Diagnosis grounded in current code

The camera acquires at 5 Hz and delivers after 100 ms, with dropout. `pixelController` submits at most one model request at a time, with a minimum 250 ms between request starts. Physics continues at 50 Hz. Six questions independently choose forward, lateral and vertical velocities, body/camera heading delta, camera pitch delta and FOV. The alternative joint XY layout combines only the horizontal velocities. The conditional layout asks for a context and every context's controls in the same request, then dispatches the selected context.

Velocity is converted from body to world axes using the delivered, dated heading. Angular deltas become absolute targets using dated camera angles. Commands expire after one second and may be replaced sooner. The last two requested controls and their admission receipts are supplied to Jev. Actual command application and measured body velocity are absent from its state, even though application events exist in the evaluator trace. Those privileged events must not simply be copied into the controller: use controller-visible telemetry and honest unavailable states.

Current image history is a list of prior measurements, without rotation compensation. Missing regions vanish immediately; there is no historical last-seen record in the next request. Dark/grey surfaces are excluded by the colour detector. These gaps affect motion control, reacquisition and avoidance respectively.

Range is not needed to know which side of the image an object occupies, and the task requests apparent size rather than metres. The observed wrong-direction camera adjustments cannot be explained by missing range alone. The 54/54 correct target selections and 60/60 narrower diagnostic answers suggest testing action formulation before adding a larger vision stack. They do not establish a successful closed-loop controller.

## Smallest useful state

Keep one bounded snapshot, with explicit coordinate frames and measurement provenance:

- Exact English goal and any explicitly supplied image-framing target.
- Per observed track: ID, appearance/class estimate, image bearing, extent, clipping, timestamp, track quality and bearing/extent change over time.
- Recent missing tracks: last observed bearing and age, visibly labelled historical; any prediction gets separate uncertainty and provenance.
- Camera calibration/FOV and measured attitude/rates, when available.
- The last transmitted setpoint, observed actuator/flight-mode status, and estimated body velocity when supported by actual sensors/estimation. Admission is not achieved velocity.
- For avoidance: image-motion/relative-depth sectors and coverage/quality, explicitly unknown wherever sensing cannot support an estimate.

No task-independent minimum guarantees safe navigation. Image bearings and apparent-size trends support visual following. Metre-based distances require a scale source. Pure monocular geometric motion recovery leaves translation up to scale ([OpenCV calibration documentation](https://docs.opencv.org/4.7.0/d9/d0c/group__calib3d.html)); synchronized inertial measurements can constrain scale in a calibrated, initialized visual-inertial estimator ([OpenVINS calibration](https://docs.openvins.com/gs-calibration.html)). An empty detection list does not establish clear space.

Compute unit conversion and measurement summaries in ordinary code. Keep measured facts distinct from goal-relative arithmetic and control policy. For example, a width measurement is perception; comparing it with the operator's requested interval is declared arithmetic assistance; choosing retreat instead of turning or waiting is a control decision. Do not hide a visual servo in the perception module.

## Simple improvements, tested separately

1. Keep the current information and full control ranges. Replace generic option keys with physical names and narrow instructions to a clearly defined control effect. Use fixed units, duration and coordinate conventions. Replay saved observations first, then run fresh closed-loop trials; diagnostic correctness alone is insufficient.
2. Add explicit temporal summaries and bounded last-seen tracks. Compare with the same controller lacking those fields. Correct image rotation using measured camera/IMU motion where available; do not claim this removes translation-induced optical flow or establishes metric velocity.
3. Add real controller-visible action feedback and sensor-supported motion estimates. Test higher camera/tracker rates only within measured compute budgets. Consume the latest snapshot after each response, keep at most one inference in flight initially, and preserve command expiry/goal cancellation. Reject stale decisions; never silently relabel old observations as current.
4. Test body-frame velocity and angular-rate commands as a separate actuator-interface change. This avoids constructing absolute angles and world velocities from an old image's heading. It still needs measured timing and bounded lifetime. [MAVSDK Offboard](https://mavsdk.mavlink.io/main/en/cpp/guide/offboard.html) supports body velocity and yaw-rate setpoints and independently resends them; resending a setpoint is not another AI decision.

The global world core does not need a planner, spatial database or Jev-specific schema. A sensor/perception adapter, controller and command adapter remain the owners of these features. Nervelet can deliver the same bounded observations to a slower agent if an experiment asks for a higher-level supervisor; it should not block acquisition or the Jev loop.

## Factor controls; preserve dependencies

[Choice](https://docs.typesafe.ai/primitives/choice) allows 255 options per question and recommends full relevant option sets. Questions run independently in parallel; IDs are invisible to the model, so each instruction must name its object, axis and assumptions. [Current limits](https://docs.typesafe.ai/models) are 64k tokens per request and 32k for state plus the longest question. These are not a 255-combination limit.

The current six menus represent `7 × 7 × 7 × 9 × 7 × 2 = 43,218` commands with 39 listed options. A proposed coupling test can preserve every tuple with four questions:

| Question | Full options |
| --- | ---: |
| Forward/lateral velocity pair | 49 |
| Heading/pitch adjustment pair | 63 |
| Vertical velocity | 7 |
| Camera FOV | 2 |

This is 121 listed options and the same 43,218 combinations. It may improve coordination within each pair, but cannot guarantee coherence across independent pairs. It is a separate experimental factor, not a demonstrated fix. Semantic keys should express direction and magnitude; their mapping to actuators remains exact.

For selected-object dependencies, use the existing explicit conditional pattern: one context question plus controls for every potential context, then execute only the chosen branch. Do not ask a simultaneous question to use an answer it cannot see. This follows the official [fan-out pattern](https://docs.typesafe.ai/patterns/fan-out) and [function-calling example](https://docs.typesafe.ai/cookbooks/function_calling). Beam/chunk selection is unnecessary for these menus.

## Libraries worth evaluating

| Library | Sensor-grounded contribution | Boundary |
| --- | --- | --- |
| [OpenCV](https://docs.opencv.org/4.13.0/dc/d6b/group__video__track.html) | Sparse Lucas–Kanade image tracks, tracking status/error, geometric transforms and Kalman filtering. First candidate for cheap motion summaries. | Optical flow is image displacement, not automatically metres/second or a clearance map. Texture loss, occlusion and rotation need explicit handling. |
| [Ultralytics detection + BoT-SORT](https://docs.ultralytics.com/modes/track) | Object classes, boxes, track IDs; BoT-SORT supports camera-motion compensation. Use when goals name real objects rather than coloured patches. | No automatic range or 3D pose. Detector checkpoint and hardware must be benchmarked; tracking can swap identities. ByteTrack has lower overhead but lacks camera-motion compensation. |
| [OpenVINS](https://docs.openvins.com/) | Fuses camera feature tracks and IMU for pose/motion estimation and uncertainty. | Research estimator needing integration and calibration. Current simulated angle readings are not a substitute for timestamped raw accelerometer/gyro samples. Not a dense obstacle map. |
| [Depth Anything V2 Small](https://github.com/DepthAnything/Depth-Anything-V2) | Learned relative-depth structure from RGB; could produce compact sector summaries. | 24.8M parameters; not the first minimal-compute choice. [Metric checkpoints](https://github.com/DepthAnything/Depth-Anything-V2/blob/main/metric_depth/README.md) are separate. All output remains estimated, with domain errors; no true-depth rescaling from the simulator. |
| [ViSP](https://github.com/lagadic/visp) | Visual tracking and visual-servo control laws. Useful explicit hybrid experiment. | If ViSP selects corrective velocities, it performs part of the control. Label and ablate that contribution rather than calling the whole loop Jev-only. |

Use OpenCV first, add a semantic detector only when the task needs it, and consider VIO when reliable ego-motion/metric scale matters. Full SLAM is not required for the current image-framing goal. Libraries differ in maturity; none is automatically qualified on our cheap camera, processor or flight stack.

All adapters must accept only declared sensor streams/calibration and prior estimates. Replay those inputs independently, retain missing/uncertain states, and log any assistance or override separately from Jev's choices. Keep perception, question layout and actuator changes in separate comparisons so a result has an interpretable cause.
