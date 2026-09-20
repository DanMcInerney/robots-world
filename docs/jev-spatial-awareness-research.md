# Sensor-derived spatial awareness for Jev

Research snapshot: 18 September 2026. Documentation and public-source inspection only; no new paid inference, installs, hardware or controller implementation.

## Correct objective and revised decision

The task is **find an initially unseen blue car, choose how to explore, then follow it through a changing world**. Jev should choose navigation and camera commands. The camera-centering servo in the [previous recommendation](jev-minimal-tracking-review.md) answers a narrower assistance question; it is useful comparative evidence, not the proposed solution to this request. F31 supersedes F30's proposed next experiment, while preserving its measured findings.

Ordinary flight stabilization and command execution remain explicit. A low-level controller may hold a Jev-selected velocity or angle; it must not silently select a search route, point at the target, choose approach speed or follow a car. Perception may estimate geometry and maintain observation history. Those computations are distinct from deciding the next action.

The evidence supports investigating **a compact, persistent spatial observation** before another long flight matrix. It does not prove this will cure the controller: [our loop audit](jev-loop-diagnosis.md) also found initial wrong-direction choices when the target's bearing was already supplied. Both representation and action interpretation still need qualification.

## What Jev's limits actually constrain

- **255 options per Choice**, with a recommendation to supply the full relevant option list. This is not a cap on objects, map cells, state fields or joint action combinations. [Official Choice contract](https://docs.typesafe.ai/primitives/choice).
- Questions share a state and are evaluated independently. One answer cannot read its sibling's answer in the same call. Use explicit conditional branches for dependent arguments, or a later observation/decision boundary. [State](https://docs.typesafe.ai/concepts/state), [fan-out](https://docs.typesafe.ai/patterns/fan-out).
- Current documented budgets are **64k tokens for the request** and **32k for state plus its longest question**. The reviewed docs specify token limits rather than a separate question-count cap; extra questions still use tokens. [Models](https://docs.typesafe.ai/models).
- Official examples include [218 line candidates](https://docs.typesafe.ai/cookbooks/semantic_find), [13 parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions), and [54 function/argument questions](https://docs.typesafe.ai/cookbooks/function_calling). Batching is an intended workflow.
- Jev is text-only. Its documentation recommends semantic fields, arithmetic in code, short reasoning paths and removal of irrelevant state. Do not use Score interpolation to produce precise continuous motor values. [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

Therefore, **image-to-state compression and action factorization are separate problems**. We already represented 43,218 commands in earlier tests. Their failure was not caused by exhausting the Choice capacity.

## Public projects: inspect the perception and policy boundary

| Project | Actual input / responsibility | Useful pattern and qualification |
| --- | --- | --- |
| [Featherless Simple Jev](https://github.com/featherless-ai/simple-jev) | Open-model next-token classification with shared context, not the TypeSafe model. Current server is text-only and its own Choice contract is 2–50 options. | An alternative classifier backend; it does not convert camera images into geometry. Do not transfer its API limits or accuracy claims to TypeSafe Jev. |
| [Its JevPilot adaptation](https://github.com/featherless-ai/simple-jev/tree/0dd5396ffce671ab7c4bfc031506d8e558cf8d23/demos/jevpilot), based on [Standard Agents JevPilot](https://github.com/standardagents/jevpilot) | Simulator object scans, route geometry and predicted candidate outcomes. Code filters actions and handles road/queue steering and braking. | Compact tables and grounded candidate IDs are useful. It is not an RGB perception implementation. The [scan code](https://github.com/featherless-ai/simple-jev/blob/0dd5396ffce671ab7c4bfc031506d8e558cf8d23/demos/jevpilot/src/simulation.js#L1024) reads object positions/types/speeds; the [adapter](https://github.com/featherless-ai/simple-jev/blob/0dd5396ffce671ab7c4bfc031506d8e558cf8d23/demos/jevpilot/src/simple-jev-api.js#L26) supplies route-error/collision forecasts. |
| [RomanSlack/jev-drone](https://github.com/RomanSlack/jev-drone) | Its main course uses simulator depth and segmentation, target geometry IDs and ego pose. Jev makes tactical judgments; code supplies following, aiming, recovery and reflexes. | Range sectors, vertical obstruction information and dated target estimates are relevant representations. [Perception source](https://github.com/RomanSlack/jev-drone/blob/cbeb53c/flight.py) is not ordinary RGB recognition. The [tunnel variant](https://github.com/RomanSlack/jev-drone/blob/cbeb53c/tunnel.py) attempts more direct avoidance but still computes target-follow speed/heading and blends tracking in code. Its Score-to-command mapping also conflicts with TypeSafe's precision guidance. |
| [Jev Visual](https://github.com/hr98w/jev-visual) | Independent Qwen/MLX multimodal classifier; actual screenshots become bounded visual answers. Not TypeSafe Jev. | Potential upstream perception experiment. Its [Breakout report](https://github.com/hr98w/jev-visual/blob/19af545f096e8db4c4dd5d47aed42d92ec252111/demo/breakout/README.md) explicitly records direct steering failures; the improved demo selects a visible lane and code moves to its fixed center. No demonstrated depth/map/drone capability. |
| [Otto](https://github.com/NobleSpartan6/otto) | Actual screenshots pass through local Tesseract OCR, supplementing native accessibility controls; Jev selects actions from labelled candidates. | A genuine pixels-to-text-to-TypeSafe pattern. [OCR code](https://github.com/NobleSpartan6/otto/blob/c91ccce/desktop/ocr.ts#L28-L95) and [state construction](https://github.com/NobleSpartan6/otto/blob/c91ccce/core/engine.ts#L513-L540) keep grounding separate from selection. OCR supplies neither vehicle recognition nor 3D geometry. |
| [PS2 agent](https://github.com/opaielsheikh/ps2-ai-agent) | Screenshot edge density in three zones becomes text for TypeSafe. | Its [bridge](https://github.com/opaielsheikh/ps2-ai-agent/blob/8b51b91/agent_bridge.py#L68-L165) already recommends steering from edge asymmetry. This demonstrates a narrow conversion pipeline, not general spatial awareness; edge density is not clearance. |

Additional source checks of [Doom](https://github.com/lukaske/jev-doom-agent), [Pong](https://github.com/safzanpirani/pong-jev), [Jev Autopilot](https://github.com/arielweinberger/jev-autopilot) and [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) are in the [seven-project audit](../.runtime/research/jev-spatial-2026-09-18/projects.md). Their engine/RAM/DOM or known-world inputs are different from camera-derived spatial perception. The browser's explicit conditional operation/target dispatch is transferable; a full-map pathfinder or hidden target-follow routine is not.

Source snapshots and separate lane findings are retained under [research evidence](../.runtime/research/jev-spatial-2026-09-18/). A demo's declared ideal sensor assumptions are not automatically dishonest, but importing those values into our RGB-only input would violate our test contract. This search did not establish a ready-made, hardware-qualified Jev visual-search-and-pursuit stack.

## A small spatial representation, without an automatic navigation policy

Use four information groups, produced continuously from acquired sensors:

1. **Self:** estimated XYZ, velocity, attitude, camera calibration, acquisition time, uncertainty and coordinate-frame version. Own XYZ alone does not locate another object. Use a declared realistic position source; never expose the simulator's exact robot transform as a supposedly noisy sensor.
2. **Objects:** detector label, colour evidence, track ID, bearing, apparent size, measured/estimated range when available, last observation, identity uncertainty and short motion history. A moving target's old location is not its current location.
3. **Geometry:** nearby measured surfaces plus observed-free and unknown volumes. Include vertical structure; a horizontal gap does not describe overhead clearance. Sparse or invalid pixels do not certify a whole sector. Keep moving objects separate from persistent static occupancy.
4. **Coverage and feedback:** camera viewpoints already inspected, their age/quality, places hidden behind surfaces, brief detection events, and dated command application. Record `no detection in this view`, not `no car exists there`. Acknowledged detection events address the [missed 0.4-second glimpse](design-failures.md#2026-09-18--f28-brief-sensor-detections-disappeared-before-inference).

Start with a bounded local geometry map, an object table and a short view/event ledger. Serialize a few local sectors/surface records and relevant persistent objects into text; do not send every pixel or voxel. Preserve the full acquired data for inspection. The formatter may describe all available observations and fixed geometric candidates, but cannot rank exploration destinations using the mission or select a best route.

Illustrative state, **invented values showing the proposed contract**, not a measured result:

```text
goal: Find and follow the blue car.
self: pose estimate ENU/map-2; xyz=(2.0,1.0,1.8)m; yaw=40deg
      position uncertainty=0.25m; image age=120ms
target: no car currently detected
objects: o8 orange car, observed now, bearing right 20deg
surfaces: s3 front wall; range estimate=3.0-3.4m; upper edge unobserved
space: measured rays left reach 5m; gaps between rays unknown
       space behind wall unknown; right-hand view not yet acquired
views: front inspected 0.2s ago; left inspected 2.1s ago; no blue detection
events: none since acknowledged observation 41
last command: yaw right at 15deg/s; applied 0.3s ago
```

The metric fields require qualified depth and pose. A monocular arm must replace unsupported distances/occupied volumes with `unknown` and retain bearings/view history. When a candidate later disappears, preserve its last measured position/bearing and age; label any extrapolation as a prediction with growing uncertainty. Never add `recommended_action` or secretly aim the camera.

## Libraries that can produce these facts

| Need | Practical candidate | What it does not provide |
| --- | --- | --- |
| Recognize a car and follow image identity | Small [YOLO detector](https://docs.ultralytics.com/tasks/detect/) + blue-colour evidence + [ByteTrack](https://github.com/FoundationVision/ByteTrack) | Neither a box nor an ID supplies metric depth, a complete car extent or reliable identity through long occlusion. Validate viewpoint, tiny objects and distractors. Colour may be uncertain. |
| Metric surface depth from cheap optics | Calibrated, synchronized stereo using [OpenCV stereo matching](https://docs.opencv.org/4.x/dd/d53/tutorial_py_depthmap.html) | Needs known baseline/intrinsics, reliable matching and valid timestamps. Textureless/occluded pixels stay unknown; no claim that any two cheap unsynchronized cameras suffice. |
| Own motion when a position source is absent | [OpenVINS](https://docs.openvins.com/) from camera + IMU; [ORB-SLAM3](https://github.com/UZ-SLAMLab/ORB_SLAM3) when relocalization/map reuse is justified | Sparse features and ego-motion are not a dense obstacle map. Initialization/calibration/scale validity must be recorded. Skip this extra stack if a suitable onboard estimate already exists. |
| Remember measured occupied/free/unknown space | [OctoMap](https://octomap.github.io/) or a small bounded equivalent | Consumes posed range evidence; it cannot observe behind walls. Dynamic occupancy needs ageing/separation, and grid resolution must preserve relevant obstacles. |
| Learn relative depth from one image | [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) | Ordinary checkpoints output relative depth; metric variants are separate learned estimators. No per-frame rescaling against hidden simulator depth. Compute and domain errors remain to be measured. |

For actual metric obstacle navigation, my proposed first spatial stack is **existing own-pose estimate + stereo + compact detector/tracker + bounded map**. For a strict one-camera comparison, start with **bearings, pixel motion, pose and persistent inspected-view history**, with range explicitly unknown. Both keep Jev in charge of navigation. No hardware purchase, cheapest-camera claim or edge FPS guarantee follows from this research.

[ConceptGraphs](https://github.com/concept-graphs/concept-graphs) is directly relevant: it turns posed RGB-D observations into persistent object-centric representations. Its original scene-graph path adds multiple learned components and language-model processing, so borrow the representation before importing the full system. [Hydra](https://github.com/MIT-SPARK/Hydra) likewise constructs scene graphs; its [camera interface](https://github.com/MIT-SPARK/Hydra-ROS/blob/main/doc/hydra_ros_interfaces.md) expects color, depth, labels and pose. These libraries do not manufacture the missing measurements. [RTAB-Map](https://introlab.github.io/rtabmap/) is an alternative foundation when larger-space localization and revisits become necessary. None is evidence of this complete Jev stack working on our intended small computer.

## Fit the controls into Choices without inserting a follower

An illustrative fixed menu could use:

| Question | Full options in this diagnostic configuration |
| --- | --- |
| Short body-relative velocity command | 125 complete XYZ tuples: five values per axis, including zero |
| Camera command | 63 complete yaw/pitch rate pairs: nine yaw values × seven pitch values |
| Command lease | Three bounded durations |

That is **23,625 possible combinations** from three Choice answers, each below 255. These are proposed discretized controls, not the complete continuous hardware action space. Choose physical values/durations against the plant's declared limits; do not discard choices because code thinks they are strategically wrong. A zero angular rate must mean stop angular motion, with explicit mapping to the device's setpoint/rate contract. Each command retains its observation provenance and expiry.

All questions see the same compact spatial state. Their combined command still needs testing for coherence; the Cartesian product is not proof of decision quality. If asking a tool/mode or object-selection question, ask explicitly conditional argument branches for each offered context and dispatch the branch selected by Jev. The dispatcher does not choose search directions or target-relative motions. Static ownership/freshness/admission checks and an attributable stop can reject a command; they must not replace it with a better mission action.

This is not a reason to replace the existing controls now. First compare equivalent available commands and state representations on saved observations; otherwise a new state plus a new menu would hide which change helped.

## Next work, proposed rather than run

1. **Qualify the perception contract without Jev.** Use rendered RGB/stereo and declared own-sensor samples. Replay the exact same sensor data with different goals and verify unchanged perception. Probe walls, gaps, overhead obstacles, two blue cars, low texture, stale depth and target loss. Hidden geometry may grade errors but must not supply controller fields. Measure false-free space, bearing/range error and processing age.
2. **Test Jev's interpretation on short recorded sequences.** Start with the car unseen. Ask it to choose a look direction and bounded movement from the same complete controls, comparing current-frame facts against the spatial record. Include mirrored layouts and scenes where more than one action is reasonable. Grade contradictions/unsafe choices and observation gained, not agreement with one hardcoded route. Compare generic prose against named, sensor-derived spatial fields without changing their information content.
3. **Run one continuous find-then-follow task.** Target begins outside view, later passes briefly behind a wall. Jev chooses every camera/movement command; no automatic sweep, centering, approach, route or recovery. Physics/perception continue during inference. Separately report time to first acquired detection, time to Jev receipt, Jev-chosen reacquisition, sustained following, contacts and stale actions. Qualified perception success does not imply closed-loop success.

The first deliverable should be an inspectable spatial-observation panel: RGB/depth/pose on one side, the exact resulting Jev state on the other. World truth stays in an evaluator-only view. Keep this as optional sensor/perception/controller modules; Robots World remains general and Nervelet retains acquisition/delivery/lifecycle responsibilities. The essential new hypothesis is persistent grounded state, not a hidden target-following policy.
