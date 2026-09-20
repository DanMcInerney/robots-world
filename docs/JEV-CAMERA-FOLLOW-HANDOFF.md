# Jev camera-based search and sustained 10 m following: session handoff

Updated 19 September 2026. This is a handoff, not a new experiment result or a claim of hardware readiness. Completed evidence is preserved in the linked reports and immutable runtime archives.

## 1. The user's objective

The latest mission is:

> Given a drone with one camera or a calibrated stereo pair, find the moving object X that I specify, then follow that same object at about 10 metres continuously. It may start out of sight. Keep observing it, avoid obstacles, and find it again after losing sight. Continue until I cancel or change the goal.

The user wants realism and simplicity. They asked whether two cameras can determine distance, requested research into production perception libraries, and authorized actual Jev experiments in simulation with an accumulating lessons document. Their latest emphasis is the big picture: how Jev understands and follows the goal, rather than indefinitely optimizing isolated text encodings.

The user specifically asked whether Depth Anything V2 had been tried. **It was researched and proposed, but was not installed or run in these campaigns.** The next session must preserve that distinction. Comparing it with the existing stereo baseline is an important open opportunity.

The exact earlier main-task goal was: "Find the blue car in this unfamiliar area and follow it as it moves. It may not be visible initially. Choose where to look and move, keep it in view, avoid colliding with surfaces, and find it again after losing sight." The latest 10 m requirement makes metric distance explicit for this search-and-follow campaign; do not rewrite its earlier trials as if they tested it. The five-round score used apparent image width and explicitly did not require metric following distance without range sensing. Most recent successes were yaw-only framing, with no translation or target range in the controller input.

"Forever" means an ongoing control objective, not a terminal declaration of success once the target is briefly framed. Test bounded episodes of increasing duration, including repeated loss/recovery and goal changes. Report duration and failures; no finite run establishes indefinite reliability. Before testing, declare the interpretation of distance (line-of-sight separation versus horizontal separation), the tolerance around 10 m, target speed, allowable observation age, and operating limits. An 8–12 m band could be a proposed first tolerance, but it is not a user-approved requirement or an existing success criterion.

## 2. Start in the correct workspace

- Repository: `C:/Users/danhm/tools/robots-world`.
- The app may start in `C:/Users/danhm/tools/nervelet`. Change working directory explicitly. This task belongs in Robots World, normally in experiment modules. Nervelet does not need modification merely to try another perception model.
- Read [AGENTS.md](../AGENTS.md), [README.md](../README.md), [PRINCIPLES.md](../PRINCIPLES.md), and [design](design.md).
- There are many pre-existing modified and untracked files. Preserve the branch, user work, dependencies and ignored evidence. Do not clean/reset the repository or commit unless requested. Do not stop unrelated local servers.
- Windows PowerShell; Node 24+. Existing Python environment: `.runtime/vision-env/Scripts/python.exe`. Recorded stereo environment was Python 3.14.6, OpenCV 5.0.0 and NumPy 2.5.3; ximgproc/WLS was unavailable. Recheck the actual runtime before new work.
- Jev credentials have been loaded from `.env.jev.local` by existing runners. Never print or copy secrets into reports, prompts or Git.

Read these documents in this order rather than rereading every old source first:

1. [Latest refinement results](jev-spatial-refinement-results.md): the strongest current result and its limits.
2. [Accumulating lessons](design-failures.md): especially F44–F61 and the final priority table. Append future findings; preserve existing entries.
3. [Executed coverage catalog](jev-spatial-test-coverage.md): distinguishes completed, partial and unrun ideas. The 64-item catalog is not 64 completed experiments.
4. [Earlier spatial-text execution results](jev-spatial-text-results.md): stereo, motion, factual reading and actual own-history trials.
5. [Five-round results](jev-spatial-five-round-results.md): the failed full-mission baseline.
6. [Spatial premise and research](jev-spatial-premise-and-next-tests.md), [source audit](jev-spatial-awareness-research.md), and [optics audit](jev-optics-audit.md): research, library options and untested proposals.

[JEV-FIVE-ROUND-HANDOFF.md](JEV-FIVE-ROUND-HANDOFF.md) and [the old execution prompt](jev-five-round-prompt.md) contain useful contracts and earlier history, but their instruction to start five rounds is historical: those rounds are complete. Some older README/plan text still says planned or not run. Use completed results and immutable ledgers for status. **Do not restart an old campaign because its prospective plan still uses future tense.**

## 3. What Jev actually receives and controls

The campaigns pinned and validated `jev-1.13.0`. They used real TypeSafe API responses, not a substitute local classifier or scripted Jev. Official contracts were checked on 19 September; verify model availability and limits before another campaign:

- [State](https://docs.typesafe.ai/concepts/state): text/JSON input; batched questions see the same state and are answered independently. They cannot consume sibling answers.
- [Choice](https://docs.typesafe.ai/primitives/choice): up to 255 options **per question**, not per complete joint action. Question IDs are not model-visible; instructions and option descriptions must name the axis, target and condition.
- [Models](https://docs.typesafe.ai/models): historical limits were 64k total request tokens and 32k for state plus longest question. Existing runners use conservative UTF-8 byte bounds, not an exact tokenizer.
- [Documented limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): literal reading, arithmetic, time comparison, indirection and irrelevant context. Compute measurements, transforms and elapsed time in code and test the judgment that remains.

The primary research boundary is Jev choosing the mission actions. Perception may estimate objects, depth, motion and geometry from camera pixels and declared onboard measurements. Code may convert coordinates, compute ages, serialize bounded history and provide symmetric conditional consequences of every offered action. Ordinary stabilization executes Jev's selected setpoints.

Do not silently introduce a search sweep, target-centering servo, pursuit-speed rule, route planner, best-action ranking, or privileged simulator target pose. Such assistance may be tested as a separately named comparator, but cannot establish that Jev performed the replaced decision. The successful bearing treatment explicitly supplies geometric assistance; it does not choose or rank actions.

Declare all sensors. Earlier controllers sometimes received noisy simulated own pose/attitude; that is not a camera-only physical localization solution. Stereo requires calibration and synchronization. A fixed camera is not a free gimbal. Simulator truth is permitted for image synthesis and evaluation, never to repair a controller's measurements, identity, scale or uncertainty.

Physics and acquisition must continue while inference runs. Keep acquisition, delivery, dispatch, admission, application and completion separate. Retain brief detections at acquisition boundaries. Preserve Stop, ownership, expiry and late-answer rejection. Do not automatically replay uncertain API calls or actuator effects.

## 4. Completed experiment history

Earlier work also tested structured missions, expanded controls and changing goals. [Structured mission results](mission-results.md) include Jev success with structured site facts and macros, which is useful evidence of bounded goal judgments but not camera-based search. [Reactive results](reactive-results.md) and [physical-sensor results](jev-physical-sensors.md) include goal changes and requested-side/distance instructions under different observation assumptions. The latter obtained a marker pose in only one of 1,419 controller-observed camera frames. Goal reversal and metric objectives have therefore appeared before; the missing evidence is a reliable camera-derived, sustained search-and-10 m-follow integration. The old [five-round handoff](JEV-FIVE-ROUND-HANDOFF.md) indexes these earlier experiments and their assistance boundaries.

### A. Earlier full-mission campaign

[Report](jev-spatial-five-round-results.md); evidence root `.runtime/experiments/jev-spatial-five-rounds-v1/`; source `experiments/jev-spatial/`.

- Five adaptive rounds: **56 valid 120-second flights**, two retained infrastructure-invalid attempts, and **440 real static calls**.
- Final confirmation: **0/24 mission passes**, across eight matched blocks and three arms. Those 24 are included in the 56, not additional flights.
- Static supplied-blue-region selection was reliable. Search, coordinated movement, sustained following and recovery were not established. All nine final obstacle-search flights failed discovery.
- No stereo depth or unified persistent spatial map was supplied in that campaign. The target was a blue-box proxy, not demonstrated semantic car recognition.
- Earlier assisted tracking runs did show benefits from a code-owned camera servo. Those are references for assistance, not proof that Jev steered the camera itself. See [tracking results](jev-tracking-results.md) and [scouting results](jev-scout-techniques-results.md).

### B. First spatial-text campaign

[Report](jev-spatial-text-results.md); evidence root `.runtime/experiments/jev-spatial-text-v1/`; source `experiments/jev-spatial-text/`.

- **3,383 completed Jev calls**, **19,216,824 reported input tokens**, approximately $0.8071 at the historical assumed $0.042/M input rate. Includes all retained pilots/attempts; use the ledger for accounting.
- **40 stereo image pairs**: controlled renders and three public Middlebury scenes. OpenCV SGBM produced useful depth on favorable scenes, but thin foreground obstacles sometimes received background distance. Blank texture became unknown. Not a physical moving-camera qualification.
- **137 stereo pairs in seven motion sequences**: image-derived SGBM/KLT/PnP. Short static-scene estimates worked; moving foreground corrupted accepted camera motion up to 0.634 m / 4.19 degrees, with additional unknown poses. Even passing pose cases did not qualify map accuracy.
- **160 Jev requests reading stereo records**: 1,758/1,760 correct factual answers. Reading an incorrect depth estimate accurately does not make the geometry correct.
- **1,440 synthetic diagnostic requests**: encoding, temporal frames, execution, forecasts, retrospective assessments and controls. These synthetic histories are not Jev's own experience.
- Narrow goal-swap controls already existed: goal-selected supplied target identity scored **24/24 in every control arm**. This is not semantic recognition or goal-dependent 10 m pursuit. Do not claim all goal-conditioning tests remain unrun.
- **40 corrected 20-second yaw episodes**, five packages across eight paired blocks: receipts framed 39.2% of measured time; linked outcomes 12.6%; chronological diary 26.5%; conditional predictions 16.5%; retrospective hypotheses 25.4%. Future observations diverged after choices; these are package comparisons, not a pure proof that memory hurts.
- Contrary evidence: retrospective feedback helped one interrupted-command case, producing 16.0/40 seconds framed across that pattern versus 0.6/40 for receipts. One mirror accounted for all the gain.
- Accurate forecasting did not imply useful choice: stationary predictions were correct on 66/67 eligible outcomes but framed only 2.4/40 seconds, largely by correctly predicting unhelpful retain actions.
- Clock/task-specification pilot defects and a callback-deadline/finalization race were repaired in explicitly separate cohorts. All original attempts remain archived; do not pool excluded attempts into corrected scores.

### C. Latest refinement campaign

[Report](jev-spatial-refinement-results.md); evidence root `.runtime/experiments/jev-spatial-refinement-v1/`; source `experiments/jev-spatial-refinement/`.

**2,015 completed Jev calls; 6,589,360 reported input tokens; approximately $0.2768 at the same historical assumed rate.** These are separate from campaign B. All calls completed with zero unresolved/HTTP/schema failures. Offline: **68 stereo pairs / 180 matcher evaluations**.

| Study | What ran | Result and limit |
|---|---|---|
| Geometry | 512 requests: four representations × two question configurations × 32 states × two repeats | Development-selected `after-bearing__action-only` chose the exact optimum 32/32 on confirmation, versus raw/action-only 11/32. Confirmation means two repeats of 16 states, not 32 independent scenes. |
| Temporal frames | 256 requests: raw/computed coordinates × mixed/explicit schema | Preselected raw/mixed failed: 249/288 factual answers and 0/20 valid old-point sides. Computed schemas recovered 19/20 sides but produced fused historical-kind label disagreements. All confirmation current-location/source, epoch-join and acquisition-clock answers were correct. |
| Actual-history replay | 432 calls over 24 archived decision snapshots, six formats, three repeats | Receipts and two linked events each scored 17/39 on the static progress proxy; longer formats 14–15/39; byte-matched unrelated padding 12/39. Only 13 unique current snapshots were scorable. No history winner promoted. |
| Temporal follow-up | 192 fresh calls, six schema/question packages; 96-response development seal before confirmation | Preselected `valid_only__separate` failed useful old-side retrieval at 6/8. Both misses were unknown despite correctly labeling the transformed coordinates usable. Unselected `typed_null__separate` got 8/8 in both splits; not retrospectively promoted. Age arithmetic remained imperfect. |
| Timed geometry transfer | 16 completed 20-second yaw trials, eight paired blocks, 623 Jev calls | Computed per-action bearings framed the target for **118.4/160 seconds (74%)**, versus **46.4/160 (29%)** for receipts. Framing improved in all eight pairs. Visibility: 145.0 versus 94.6 seconds. |
| Matcher comparison | 56 pairs × SGBM5, SGBM3 and BM9 | All failed thin-hazard/useful-coverage gates. All had zero correct-near pixels on 1px and 2px poles. Lower false-far counts sometimes came with more unknown output. |
| Resolution follow-up | 12 pairs: four physical scenes at three resolutions | At 1280px, 8px poles reached 90.9–91.4% correct-near coverage but retained 4.3–5.2% false-far pixels. 4px poles recovered only 16.9–17.7%. Processing took 546–710 ms, excluding capture/transport. No safe width threshold qualified. |

The selected timed controller receives a unique, unclipped RGB-derived target rectangle, declared attitude, two actual command receipts and the hypothetical final bearing for each of seven yaw actions under a stationary-target/full-settling assumption. Unknown inputs stay unknown. Jev's yaw choice is copied verbatim. No translation, range keeping, search behind a wall, stereo integration or semantic recognition is tested by this result.

The largest stationary improvement began with the target about 21 degrees left: baseline turned right twice and lost it; selected format turned left and framed it for 19.6 seconds. Preserve the contrary occlusion case too: framing improved from 3.8 to 5.6 seconds, but visibility fell from 10.4 to 8.8 seconds. Moving/occlusion executions reused existing mirrored route families; new runs are not all new trajectories.

All 16 trials passed their clock/evidence gate. Fifteen late replies were retained and discarded; checks of 607 command records found no late-reply command or post-Stop effect. An already queued HTTP request can still start after nominal end in the inherited transport. Do not claim a strict HTTP-start cutoff.

## 5. What is supported, and what remains open

Supported provisional design: **compact current observations + actual execution receipts + code-computed geometric consequences + Jev selecting the action**. Additional forecast questions were unnecessary for the selected yaw result. This does not imply every multidimensional mission should use only one question.

Not established:

- Finding arbitrary X from camera images, preserving identity among lookalikes, or recognizing real cars across viewpoints.
- Reliable metric target distance around 10 m, distance-keeping translation or combined yaw/translation following.
- Dynamic-camera mapping robust to a large moving foreground object.
- Active viewpoint change around occluders, recovery after long loss, or sustained full-mission operation.
- A benefit from a persistent Jev-selected intention record, episodic retrieval, or learned behavior from its history. Supplying records is not weight training or demonstrated durable learning.
- Onboard compute, power, thermal behavior, networking or physical flight.
- Depth Anything V2 inference, DepthAI/OAK or ZED hardware/SDK execution, NVIDIA Isaac stereo, production SLAM/VIO, or WLS filtering. Those were researched, not run. The stereo alternatives actually compared were OpenCV SGBM and BM.

## 6. Recommended next campaign: connect perception to the actual mission

These are proposals, not executed results. Choose a small staged allocation; do not run every possible combination. Preserve the best yaw baseline while adding one missing capability at a time.

### A. Qualify useful range near the requested following distance

Compare the existing stereo method with an actual Depth Anything V2 implementation on matched imagery. Separate its relative-depth and metric checkpoints: an ordinary relative map cannot be relabeled metres. Pin weights, upstream revision, preprocessing, resolution, precision, license and runtime. Check official sources before installing; do not assume an accelerator, package version or performance figure.

Start with recorded real imagery with appropriate reference measurements and controlled renders. Tiny synthetic blue boxes alone are an inadequate test of a learned natural-image model. Use development data to choose settings, then untouched confirmation. Reuse old failed images only as a separately labeled regression set.

Measure target-range bias/error around 10 m, valid coverage, background leakage into object regions, temporal scale stability, processing and acquisition-to-text age. Include lookalikes, partial views, small/distant targets, motion blur, low texture and thin obstacles. A finite depth value is not calibrated confidence. Never rescale each frame against hidden ground truth. Assess target ranging separately from all-obstacle clearance; passing one does not qualify the other.

Keep the one-camera and two-camera sensor assumptions explicit. If monocular metric estimates cannot maintain a useful 10 m band, report that limitation. If stereo loses useful disparity at the chosen baseline/range, report that too rather than selecting an answer from appearance alone.

### B. Test goal-dependent movement with facts held fixed

Extend the already-passing supplied-label goal swaps. Present the same observed scene, action menu and computed physical consequences under different requested targets or following distances. Do appropriate actions change because the goal changes? For a fixed 10 m goal, cross nearer/farther target, approaching/receding motion, visibility and obstruction. Include unknown range; lack of distance evidence must not silently become a successful distance estimate.

Code computes physical consequences with stated uncertainty; it must not supply a goal-weighted score or best action in the primary arm. An explicitly ideal, stipulated-state diagnostic is useful as a decision ceiling but must remain separate from camera-derived mission evidence.

### C. Add continuity and feedback as isolated comparisons

Keep the exact goal visible on every decision. Test a small record of Jev's own selected intention, intended outcome, command execution status and the subsequent measured outcome. Compare no intention record versus that record with current facts and action choices held fixed. The earlier diary results do not establish this treatment either works or fails.

Do not choose search/follow/recover modes in code and then attribute those decisions to Jev. If Jev chooses an intermediate intention, either provide it to a later call with fresh state or use explicitly conditional question branches. A sibling answer is not available within a batch. State whether another call's delay is included.

Test completed-versus-interrupted actions, no-progress loops, loss of sight and a changed/cancelled user goal. Retain factual event/outcome records; avoid assuming self-written explanations are true.

### D. Integrate into finite, increasingly long missions

Begin with visible-target metric following, then initial search, obstacle/viewpoint decisions and repeated loss/recovery. Use fresh trajectories and structural layouts. Target stopping, turning, speed changes and similar-object crossings should expose whether Jev maintains the requested identity and distance.

Score target identity, discovery time, time within the declared distance band, range error, framing, collision/clearance, longest sustained following interval, loss/reacquisition time, stale-input exposure, actual command outcomes and resource use separately. An object remaining visible does not prove 10 m following; passive reappearance does not prove recovery. Include appropriate passive/no-action or information-removal controls, retaining all failures.

Only qualify a longer integrated stage after prerequisites support it. Failure of a depth or mapping prerequisite need not stop independent goal/decision diagnostics. The objective is to identify the smallest working system, not accumulate more successful component classifications.

## 7. Source and evidence map

| Purpose | Location |
|---|---|
| Five-round search/full-flight trials | `experiments/jev-spatial/`, `.runtime/experiments/jev-spatial-five-rounds-v1/` |
| First spatial fixtures, transport and yaw engine | `experiments/jev-spatial-text/`; `bench.ts` is the inherited yaw engine; `transport.ts` owns durable metering/validation |
| Geometry, history and temporal refinement | `experiments/jev-spatial-refinement/{geometry,history,temporal,run}.ts` |
| Second temporal study | `experiments/jev-spatial-refinement/temporal-next.ts`, `run-temporal-next.ts` |
| Computed-bearing transfer wrapper | `experiments/jev-spatial-refinement/live-adapter.ts`, `live.ts` |
| Stereo matcher/resolution studies | `experiments/jev-spatial-refinement/stereo/`, `stereo-resolution/`; each has reproduction instructions |
| Relevant regression tests | `test/jev-spatial-text-*.test.ts`, `test/jev-spatial-refinement-*.test.ts` |
| Latest sealed fixed evidence | `.runtime/experiments/jev-spatial-refinement-v1/fixed-analysis.json`, `fixed-gates.json`, `fixed-completion.json`, `selection.json`, `selection-seal.json` |
| Follow-up evidence | Same root, `temporal-next/analysis.json`, `development-seal.json`, frozen `plan.md` |
| Live evidence | Same root, `live-results.json`, `live-summary.json`, `live/<trial>/finalization.json`, `checks/live-post-stop-audit.json` |
| Frozen executable sources | Each campaign's `freezes/` and stereo source archives; do not edit them |

Latest verification: **258 repository tests passed, five optional skips; typecheck and build passed.** An additional opt-in 20-second fake-judge clock qualification passed; it is not real inference. [Final independent review](../.runtime/experiments/jev-spatial-refinement-v1/final-review.md) passed without repairs, authenticated 2,015 calls, and verified 188 local links and the preserved 99,296-byte earlier lessons prefix. [Inspected hashes](../.runtime/experiments/jev-spatial-refinement-v1/final-review-hashes.json) and [delivery manifest](../.runtime/experiments/jev-spatial-refinement-v1/delivery.json) identify the reviewed state. The current handoff was created afterward and is not covered by that review.

## 8. Execution discipline and first actions

This session's request is to write a handoff, not launch a new paid campaign. Prior instructions authorized actual Jev inference in simulation and continuing experiments; they did not authorize physical robots, purchases, publishing or other paid model services. Preserve that scope when the user resumes work; do not manufacture repeated permission gates for already-authorized work.

Existing resource ceilings are campaign-specific: first spatial-text 25,000 calls / 250M input tokens; refinement 3,000 / 25M, including the separately capped 192-call / 2.5M temporal follow-up. These are ceilings, not targets or new budgets granted by this handoff. Preserve usage and conservative uncertain-call reservations. A fresh output directory does not reset authorization or erase previous spending. Prices quoted above are historical accounting assumptions, not a current quote.

Before new implementation, inspect current status and the failed-test record. Freeze a concrete next plan with question/menu definitions, evidence sources, selection and confirmation rules, metrics, stopping rules and resource allocation. Carry research forward without silently treating an untested production library as qualified.

Create a **new experiment directory and new evidence root** for new work. Preserve existing sources and reports because frozen identity checks depend on them. Some freeze implementations enumerate broad source trees; adding files may change a legacy live-source inventory. Reproduce an old run from its archived source snapshot when necessary; do not relax the freeze checker to make it pass. Old `analyze` CLIs may rewrite derived reports or global usage snapshots, so read sealed reports first and use a scratch copy for reproductions.

Qualify mechanics without paid calls first. Test inference/acquisition concurrency, bounded waits, exact response mapping, stale inputs, cancellation and late replies. Run `npm test`, `npm run typecheck`, and `npm run build` for implementation changes; verify links, fences and `git diff --check` for documentation. Native/hardware tests remain separate. Review consequential experiment design and evidence boundaries before expensive dependent stages.

Preserve exact requests, returned model, answers/probabilities, raw sensor inputs, derived facts, action application/completion and measured outcomes. Save immutable development selection before held-out confirmation, report all attempts and token usage, and append findings to [design-failures.md](design-failures.md). Each new lesson should state what failed, contrary evidence, uncertainty, the next discriminating test and its eventual outcome.

**First useful step after reading:** inspect the available real imagery and compute environment, then design the smallest matched Depth Anything V2-versus-stereo ranging test near 10 m and the corresponding goal-dependent movement diagnostic. Do not spend another entire campaign on yaw framing while calling it progress toward distance keeping. Preserve the useful yaw result as one component of the larger mission.
