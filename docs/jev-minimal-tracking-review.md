# Simplify around the component that worked

18 September 2026. Retrospective evidence review; **no new inference or flights**. Old scores, sources and failed attempts remain unchanged.

Subsequent user clarification: the requested controller must choose search, navigation and following for an initially unseen target. The servo-first next-test recommendation below is superseded by the [spatial-awareness research](jev-spatial-awareness-research.md); the historical evidence remains valid as an assistance comparison.

## Decision

Separate **camera centering**, **pursuit/size regulation**, **lost-target search**, and **obstacle navigation**. We added mission complexity before establishing reliable translation. A single mission pass/fail hid the working camera component.

The smallest supported starting configuration is **RGB colour regions + Jev target selection/follow authorization + declared camera-bearing servo**. Keep the existing independent acquisition and dated actuator feedback. KLT, extended memory, Codex advice and more physical-control questions have not shown that they are necessary for this uniquely coloured target. This is a recommendation for the next baseline, not evidence that removing every extra state field is behaviorally neutral.

The servo performs numerical camera aiming. Jev does not deserve credit for choosing those corrections. This is useful sensor-based assistance, but it does **not** prove that Jev alone can close the angular control loop. The existing direct-control trials did not establish that ability.

## Best evidence across the experiment families

Scores are not interchangeable across suites. Development probes and individual best flights explain behavior; matched cohorts constrain the recommendation.

| Family | Strongest useful observation | Why it does / does not support this baseline |
| --- | --- | --- |
| [Injected delay](comparison-results.md) / [first live Jev](jev-live-results.md) | Live selector spent 94.3% of time within 2.5 m across three trials. | All accepted choices were `follow`; local guidance and structured tracking did the motion work. The earlier injected-delay results were not real Jev. Neither demonstrates pixel-based Jev flight control. |
| [English missions](mission-results.md) | Jev completed 3/3 station missions. | Supports selecting meaningful operations over structured evidence; known sites and flight skills differ from unknown-world visual pursuit. Stale Claude advice caused a separate failure. |
| [Expanded controls](flight-results.md) / [reactive](reactive-results.md) | Consequence/brief/repair arms briefly achieved both phases in 2/4 reactive seeds each. | None met the stricter sustained-framing criterion. Geometric sensors, candidate consequences and assistance differ from camera-only evidence. |
| [Eight strategies and six axes](jev-expanded-results.md) | Prose seed 701 passed; the completed strategy matrix passed 1/32. Derived geometry raised visibility, not reliable framing. | A single favorable replay did not survive repetition. Adding/factoring controls solves representation capacity, not control competence. |
| [Camera features ± rangefinder](jev-physical-sensors.md) | Both arms passed 0/3; adding the single beam did not establish following. | No evidence that adding this sensor repairs the camera-control interface. |
| [RGB formulations](jev-pixels-results.md) / [loop audit](jev-loop-diagnosis.md) | Conditional selection chose blue in 54/54 blue-present decisions. All 15 RGB flights had zero scored full framing; later loop controls also failed. | Target identification was sometimes good while camera commands were wrong. First-step sign errors cannot be explained by absent range or insufficient flight duration. |
| [Hypotheses](jev-hypothesis-results.md) | Servo-enabled 1501 centered from about 0.9 s to the 24 s endpoint. Camera-only direct formulations failed sustained centering. | First clear assisted-camera signal. Static direction/magnitude improvement did not become a reliable closed loop. |
| [Persistent tracking](jev-tracking-results.md) | Colour-servo and KLT-servo each passed 6/8 tracking trials; direct arms each passed 0/8. | Strongest matched evidence. Mean centering after 10 s: 80.9% / 89.1%; full-run framing: 29.3% / 31.8%. KLT had no pass-count advantage; translation remained weak. |
| [Scouting techniques](jev-scout-techniques-results.md) | Current-image assistance retained blue for 106.65 s of the 120 s occlusion-course 2102 flight, with 95.8 s centered. | Only 15.05 s fully framed; no complete missions in 18 flights. Memory did not improve overall results. All turn-to-find flights failed; no active-search success established. |

Recovery in the older tracking cohort was incomplete: colour-servo regained lock in 4/5 valid runs, KLT-servo in 1/5. Some returns preceded a new follow action, so these are not proof of deliberate reacquisition. Scene/scoring qualification fixtures and synthetic mechanical runs are not Jev performance evidence.

## The simpler best flight

Directly checked [colour-servo-1804](../.runtime/experiments/jev-tracking-v1/constant/colour-servo-1804.report.json) against the [32-run cohort](../.runtime/experiments/jev-tracking-v1/constant/report.json):

- 60 s episode; lock begins at 1.5 s; longest centered interval 58.6 s; 100% centering after 10 s.
- Drone path 11.33 m; zero collision or bounds ticks; 90 completed decisions, zero provider/controller errors.
- One Jev target-binding decision, then 89 `follow` decisions. All 89 chose wide FOV. Translation varied and was selected by Jev; the camera servo used only the selected region's measured bearing.
- Full-run framing was 42.5%, including the requested apparent-width band. Camera centering is substantially better established than stable following distance.
- The paired KLT-servo flight also centered for 58.6 s, traveled 11.94 m, and had no contacts/bounds violations. Its framing was 38.7%. This one pair does not establish colour superiority, but it shows that KLT is unnecessary for this clean coloured proxy.

Two seed-1806 flights centered for slightly longer (58.7/58.8 s) but violated bounds. Thus 1804 is a useful clean illustrative pair, not a concealed maximum-score selection. These centering metrics use the old evaluator's geometric image center sampled every 100 ms; the latest scout score instead uses acquired visible colour patches. Do not pool them. Controller inputs still come from recorded RGB, not evaluator geometry.

## One baseline and a staged progression

1. **Center an initially visible moving target.** Use the existing colour pipeline and declared camera servo, fixed wide FOV, no translation, no obstacles and no zoom choice. Jev selects a current region and authorizes follow or hold. This isolates camera tracking; holding the drone is a declared diagnostic constraint. Preserve the old successful moving-drone flights as references. Removing translation/questions is a new configuration, not already tested.
2. **Add pursuit with one signed speed.** Keep camera aiming fixed as the qualified component; add a Jev-selected forward/backward speed along the camera's horizontal heading, with altitude held by the declared plant controller. Supply apparent width plus its dated change, whether the measurement is current/clipped, and the last applied speed/time. No automatic approach policy. Start with an unobstructed, straight-moving target before turns. Fixed zoom is essential to interpreting apparent-size change. Score this as image-size regulation, not known metres; metric stand-off needs a separately qualified source of scale.
3. **Test temporary loss/reacquisition, then obstacles.** A brief visual obstruction tests lost-target handling before requiring the drone to navigate around walls. Reacquisition and collision avoidance need separate scores. Later event buffering should retain genuine missed detections with their acquisition times; no current position is invented while lost. Do not treat an empty image sector as certified clearance.

Minimal proposed control surface: a target/follow-or-hold Choice in stage 1; in stage 2, add one signed-speed Choice for the already selected current track. If selecting and moving in the same parallel request, use explicit per-target conditional speed questions or complete target/speed options: sibling answers are not inputs to each other. No enumeration of every XYZ/yaw/pitch/zoom tuple is necessary. This narrows this diagnostic task's controls; it does not shrink Robots World's general controller API.

The compact observation needs the goal, current candidate IDs/appearance, measured image center/bearing and width, acquisition age, current/lost/clipped status, and dated actuator state. Retain short measured width history for stage 2. No map, simulator range, target world position, recommended movement or long narrative memory. Keeping arithmetic outside Jev and keeping action selection inside Jev are distinct responsibilities.

**Next experiment only:** one camera-centering configuration on three fresh 60 s trajectories, balanced initial left/right and above/below offsets across the cohort, with reversals and varying speed inside the qualified camera envelope. Predeclare lock within 5 s, at least 95% centered during seconds 5–60, no loss longer than 1 s, and no service/pacing invalidity. Measure centering from acquired pixels and report sample outages. Retain all attempts; do not rerun a failure to select a winner. These are proposed gates, not past results. If it passes, keep this component fixed and test stage 2; if it fails, inspect the first failure before adding another technique.

The blue box is a car proxy. This review does not qualify real-car recognition, motor dynamics, cheap-board compute or physical deployment. The architecture stays in optional experiment/controller modules; neither the world core nor Nervelet needs a new planner for this simplification.
