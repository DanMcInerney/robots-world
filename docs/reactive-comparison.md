# Continuous changing-world comparison

Historical v2 design: [results and evidence](reactive-results.md) cover all 24 attempted flights under the frozen source in that batch. Current code implements the [v3 corrections](reactive-v3.md), qualified with offline mechanics checks; those changes have not been rerun with model inference. No physical drone was connected in this round.

## Question

Can an AI select useful drone maneuvers from an English goal as its environment changes, and does a Codex-authored reusable brief improve Jev? This experiment does not compare Jev against a supplied mission-solving script. Direct native arms test the decision layer through persistent native harnesses with structured choice output, not full unrestricted DroneRTS/Nervelet sessions with authored routines.

## Shared world and controls

The blue rover changes speed and direction at private seeded intervals. A moving solid obstacle crosses the scene. All arms get the same seeded environmental motion. Halfway through the flight, the operator supplies a new English goal requesting the opposite viewing position. The old goal's pending responses and queued commands cannot regain authority.

Drone odometry, camera detections and a sparse spherical range sensor acquire independently. Readings have latency, measurement noise and dropout. A cooperative rover broadcasts measured pose/velocity over a delayed, jittery radio with 5% loss and a short blackout. The rover's future route, obstacle trajectories and evaluation state are never model inputs.

Camera inputs are structured point detections, not images or a learned vision stack. Range hits have noisy distances but ideal registration into the world frame using the sensor mount pose; this does not simulate noisy SLAM. Neither sensor provides a hidden occupancy map.

The generic candidate generator enumerates hover and 26 directions at two speeds, combined with four camera choices, for up to 212 complete commands. Camera choices preserve current angles or point once toward an extrapolated measured target, each with wide/zoom framing. When target measurements expire, search-angle choices replace target-pointing choices. Commands set world velocity for three seconds; a later choice can replace them. The numeric control range is quantized and task-oriented camera choices are supplied to all arms. This is not the whole possible raw flight-controller action space.

Candidate speeds are 0.4 and 1.2 m/s. A requested viewpoint relative to a turning rover can move faster than those limits allow, so perfect instantaneous tracking is not always physically achievable. The geometry fixtures establish reachable viewing poses; they do not certify an optimal collision-free trajectory through every changing episode or feasibility of the stricter sustained-framing check. Results characterize this task, sensor set, action representation and plant together.

Candidate helpers calculate bounded kinematics, relative position, range, proximity to observed range returns and projected camera centre. They receive only delivered measurements and never evaluate the English goal, choose a route, calculate a mission score, rank candidates or issue commands. They do not know unseen obstacles. Projection does not establish visibility through walls. Numeric predictions are approximate and can become wrong as the rover turns or communications lag.

Movement is encoded as genuine MAVLink v2 velocity setpoints, passed through a simulated 60–100 ms command delay with 2% packet loss, and decoded by the leased robot adapter. Camera controls are attached local JSON, not MAVLink gimbal messages. The simple acceleration/attitude servo does not implement rotor dynamics, PX4, ArduPilot or a physical radio. No hardware-readiness claim follows from these tests.

## Arms

| Arm | Decision-making |
| --- | --- |
| `jev-bare` | Jev receives measured state, controls and action names without calculated candidate consequences |
| `jev-facts` | Jev also receives the common calculated consequences |
| `claude-facts` | Persistent Claude Code, Opus 5 / low, chooses among the same annotated commands |
| `codex-facts` | Persistent native Codex, Luna / xhigh, chooses among the same annotated commands |
| `jev-brief` | Jev receives an actual Codex-authored reusable preflight brief in addition to current goal/data |
| `jev-repair` | Same initial brief; one asynchronous Codex repair opportunity after the goal changes, while Jev continues |

Jev uses a camera choice and four speculative conditional maneuver questions in one request. Only the selected branch executes. This preserves the complete candidate set while staying within the API's per-question context bound. A single flat annotated request exceeded that bound during qualification and was rejected; rejected and interrupted qualification runs are excluded from performance results. Native models return the complete candidate ID directly. The grouping differs, but available effects and supporting information are matched.

Native harnesses retain their conversation within a flight. Jev receives the current dated state, four recent admitted actions, and any model-authored brief. Current observations and candidate effects are shared; accumulated native context and output grouping differ. This is a comparison of these concrete controller arrangements, not an isolated equal-token model benchmark. The camera question sees camera descriptions and current state; each conditional maneuver question sees its branch's candidate effects. Parallel questions cannot consume one another's answers.

Preflight compilation receives the command contract, a representative family of all four English viewing goals and the available feature meanings. It receives no held-out observations, seed, map, evaluator or future motion. Briefs are model output, not researcher-authored policies. The exact current goal takes precedence over advice. Repair input includes only the same public observations/candidates and previous brief; repair completion, installation and subsequent use can be audited separately. Repair starts two seconds after the public operator goal update, once per flight; it is not an autonomous failure detector. Advisor sessions receive guidance-writing instructions and a guidance schema, distinct from the action-selection instructions and schema used by controller sessions.

## Timing and scoring

Physics advances every 20 ms against wall time, including during model setup-independent active flights and inference. Decision requests have a 750 ms minimum spacing and one request in flight per lane. Setpoints continue until replaced or their three-second expiry. Inputs older than five seconds are rejected uniformly. This freshness policy can prevent a slow native response from actuating; report that as a timing limitation, not an incorrect model decision. No response is converted into an automatic mission fallback.

The candidate preview spans 1.5 seconds, shorter than the three-second command lifetime. Its envelope filter is therefore not a full-command safety guarantee, and admission does not replan a stale trajectory. One final-batch flight exposed this directly: a descent continued below the altitude limit, then no candidate remained and the original runner terminated. The continuation runner preserves that attempted flight, runs only untouched arm/seed pairs, and makes no change to the frozen controller, plant, menu or scoring. Such a flight is a failed attempt with partial evidence, not a successful retry or an invented full-duration recording. Its visibility/contact-duration statistics are reported separately or left unavailable.

Each goal phase requires one continuous second at the requested physical side, range 2.5–6 m, target centre within the central half of both camera dimensions, and unoccluded visibility. The full task requires both phases, at least 50% camera visibility in each phase after a five-second transition allowance, and zero collision/boundary ticks. Ground-truth scoring is independent of the model's statements. Report partial progress, contact duration, expired/rejected commands and unfinished inference as well as success.

This predeclared pass criterion permits brief attainment of the requested side while filming from other positions for much of the episode. A pass is not proof of sustained side-following. The report also includes actual correct-side/range/centering time, and a **post-hoc stricter reading** requiring that geometry for at least half of each scored phase. This secondary check does not replace or tune the frozen score; it prevents the one-second dwell criterion from being mistaken for continuous mastery.

Development seeds are below 100; held-out seeds are at least 100. Freeze source, representations and the preflight brief before the held-out run. Preserve unsuccessful development attempts and make no changes in response to held-out outcomes. Rotate execution order across seeds. A separate actual-Jev probe holds the delivered observation/menu fixed while changing only the English goal; this measures goal sensitivity, not continuous flight success.

The first partial held-out batch, `reactive-held-out-v1`, is excluded in full. Its advisor prompt mixed immediate action selection with guidance repair, and its preflight example emphasized only one viewing side. The exclusion is recorded beside the preserved raw evidence in `EXCLUDED.json`. After correcting advisor roles and giving the preflight model the four-goal family, the development check and preflight generation were repeated. The final batch uses fresh seeds 500–503; no result from the excluded batch enters the final comparison. Plant, menu and scoring were not changed in this correction.

## Evidence and checks

The JSONL trace includes model inputs and responses, probability distributions, usage when available, selected candidate and menu hash, goal/source versions, command admissions, raw MAVLink, sensor acquisition/delivery, radio stages, private evaluator/stimulus events and trajectories. Model requests use a whitelisted DTO and do not contain the private events. Provider reasoning internals are not requested. Failed and censored responses have incomplete usage; missing costs are not zero. Trace capacity and world-pacing overflow invalidate a run.

Offline tests verify goal-independent menus, no accidental privileged serialization, measurement-sensitive predictions, delayed protocol application, independent sensing/world motion, goal cancellation, expiry, Stop and physical scoring. Direct placement/control code in these fixtures validates mechanics only; it is not a performance competitor.

The post-run [evidence audit](../experiments/reactive/audit.ts) checks actual model-state fields and timestamp causality, offered versus executed choices, goal/freshness admission, complete journals, and identical target/obstacle trajectories across paired seeds. It includes preserved early terminations. The [report generator](../experiments/reactive/report.ts) refuses excluded batches and labels incomplete batches and early terminations explicitly. A source snapshot and per-file hashes are saved under the final evidence directory, without credentials or dependencies.

Source: [controller contract](../experiments/reactive/contract.ts), [world and evaluator](../experiments/reactive/world.ts), [native/Jev integration](../experiments/reactive/providers.ts), [runner](../experiments/reactive/run.ts), [tests](../test/reactive.test.ts). The reusable [range sensor](../src/devices/range-cloud.ts) contains no experiment policy. The world core and Nervelet core are unchanged.
