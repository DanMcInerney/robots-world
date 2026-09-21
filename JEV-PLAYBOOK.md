# Jev drone control playbook (living document)

Last updated 21 September 2026. Status: work paused at the owner's request; see [Paused work](#paused-work-and-how-to-resume).

**What this is.** The running summary of what we have learned about getting Jev (TypeSafe's text classifier, `Choice` primitive, `jev-1.13.0`) to control a drone that finds and then follows an object, using only sensor-derived text. It records the data formats and control designs that work, the ones that do not, the test results behind each claim, and what to try next. The car is only the test object; everything here is meant to generalise to any object.

**How to update it.** Add to it, do not rewrite history. Every rule carries a confidence tag and its evidence. When a new result changes a rule, edit the rule, keep the old number in the changelog, and date the change. Confidence tags: **Established** (replicated, confirmed on fresh cases or several seeds), **Supported** (one good experiment), **Tentative** (single runs, reviewer counterfactuals or reasoning), **Open** (not tested). Detailed evidence lives in [docs/design-failures.md](docs/design-failures.md) (F-numbers), [LATEST_RESULTS.md](LATEST_RESULTS.md), [docs/jev-scout-encodings-results.md](docs/jev-scout-encodings-results.md), [docs/jev-live-sensor-results.md](docs/jev-live-sensor-results.md), [docs/jev-find-follow-ladder.md](docs/jev-find-follow-ladder.md) and [experiments/jev-find-follow/FAILURES.md](experiments/jev-find-follow/FAILURES.md).

## The short version

1. **Code does the geometry; Jev only chooses.** For every offered option, print that option's own code-computed consequence. Jev then picks the option whose printed result best fits a plainly stated rule. *Established.*
2. **Predict for the moment the command takes effect**, not for the moment the picture was taken: include the ~0.4 s sensing-and-decision delay, the maneuver still in flight, and for a moving target its measured closing speed and bearing drift. *Supported.*
3. **Turn history into state, and state into per-option effects.** Logs of past actions are useless or harmful. "Sector NW: never inspected" plus "this turn would bring NW into view" works. *Established for the static probes; Supported in flight.*
4. **Give Jev short bounded maneuvers or setpoints, one question per axis**, executed by a flight-controller loop under a lease. Large velocity menus failed completely. *Established.*
5. **Coast through sensor misses.** The real detector reports the car in roughly 50–90% of frames depending on pose. Keep the target binding, the rate estimate and the current maneuver through a few missed frames. This mattered more than any wording. *Supported.*
6. **Say "unknown" when it is unknown, and keep hard limits in code.** Jev holds sensibly on explicit unknowns, but it will act on data merely flagged as stale. Freshness, leases, clearance vetoes and operating limits are code guards, logged and scored. *Established.*
7. **Every test needs a capable code reference and baselines that fail.** If a do-nothing, constant-action or random controller can pass, the test says nothing. *Established the hard way.*
8. **When consequences are printed, Jev's choices match a simple code policy almost exactly** (344 of 344 tracking answers). So the limits we hit come from the sensor, the action menu and the decision rate, and a code reference on a simulated sensor predicts in seconds what a design can achieve. *Supported.*

## What Jev can and cannot do

| Ability | Evidence | Confidence |
| --- | --- | --- |
| Reads sensor text accurately, including wrong values faithfully | 1,758/1,760 reading answers (F46) | Established |
| Picks the named object from a list | 440/440 (five-round campaign) | Established |
| Picks the option with the best printed result under a stated rule | yaw 32/32 development and 32/32 confirmation vs 10–11/32 from raw bearings (F57, F59); range 116/116 (F75); 344/344 in flight | Established |
| Holds when a needed value is explicitly unknown | 28/28 (F67), 12/12 per arm (F75) | Established |
| Spatial arithmetic from raw numbers (which way to turn, what a turn reveals) | wrong-direction first turns in 10/12 flights (F11); 0/72 useful search choices from current view or a view log (F75) | Established weakness |
| Comparing across options or judging "all options are equally unhelpful" | open-corridor case 6/24 (F75) | Established weakness |
| Respecting staleness flags in text | acted on expired evidence in 8/24 cases under every labelling (F65) | Established weakness |
| Picking the right magnitude when two options are close | 12/12 development then 8/12 confirmation (F75) | Supported weakness |

Practical numbers: about 200 ms median latency per call (145–424 ms observed in flight), 1,300–1,900 input tokens per tracking request, about $0.006–0.008 per 45–60 s flight, no timeouts in roughly 1,300 closed-loop calls. Request starts are paced at least 505 ms apart.

## The request format that works

One call per decision. State text plus one or two independent questions, each with a small menu. Every printed number is rounded (declare the precision), every angle states its sign convention once, and nothing in the request ranks or recommends.

The block below is trimmed and reformatted from real saved requests (the engine sends JSON with these field names; the yaw table is from the smoke run, the range table from an L3b flight):

```text
goal:    Find and follow the blue car at 8 m. (scored as slant range to its visible surface)
component_goal_yaw:   choose the yaw action whose resulting bearing has the smallest absolute value.
component_goal_range: choose the range action whose resulting range has the smallest absolute error
                      from the requested 8 m; if the measured range is unavailable, hold.
frame:   bearing degrees, positive right; headings ENU degrees in [0,360), positive yaw turns left.
current_view: target_bound=false, evidence_source=last-seen, evidence_age_ms=610,
              bearing_deg=-0.1, range_m=7.5, own_heading_deg=359.7, own_altitude_m=1.83
consequence_model: measured-rate
rate_estimate: range_rate_mps=1.55, bearing_rate_deg_s=-0.1 (positive = drifting right),
               range_rate_source=current, sample_count=5, window_ms=1000
command_receipts: [yaw:hold+range:speed_1_5, applied 600 ms ago, accepted]
yaw_consequences   (code-computed for EVERY option; not observations, a ranking or a recommendation):
   yaw_left_30 -> 35.3 | yaw_left_10 -> 15.4 | hold -> 5.5 | yaw_right_10 -> -4.5 | yaw_right_30 -> -24.3
range_consequences (resulting range and signed error over a declared 1.0 s horizon):
   speed_neg_1_0 -> 10.1 m (+2.1) | speed_neg_0_5 -> 9.6 (+1.6) | hold -> 9.1 (+1.1) | speed_0_5 -> 8.6 (+0.6)
   speed_1_0 -> 8.1 (+0.1) | speed_1_5 -> 7.6 (-0.4) | speed_2_0 -> 7.1 (-0.9) | speed_2_5 -> 6.6 (-1.4) | ...
```

Note what this one shows: the detector missed the current frame (`target_bound=false`), so the consequences are built from the last-seen record (610 ms old, labelled as such) and the still-valid rate estimate rather than falling back to "hold".

Search mode uses the same pattern with different consequences per option: the compass sectors the option would bring into view (each marked never-inspected or with its age), the offset between the camera axis and the last-seen world bearing (with the sighting's age), and the measured clearance along any translation (open to X m, blocked at X m, or unknown).

Field-by-field guidance:

| Field | Rule | Why |
| --- | --- | --- |
| Goal and policy | Repeat the exact goal; state the scoring rule with numbers ("horizontally within 10°", "8 m ± 1 m"); name the object generically (class, colour) | When wording did not entail the score, results were uninterpretable (F52) |
| Per-option consequences | Same template for every option, computed by code, labelled as conditional calculations | The single biggest effect measured |
| Derived scalar instead of per-option results | Avoid | Signed range error was 58/58 in development, then 4 harmful moves in confirmation (F75) |
| History | Two short command receipts only | Diaries and linked histories drove centring to zero (F53, F57) |
| Memory | State, not a log: sector table, last-seen record with age | 0/72 from a dated view log vs 50/72 from state plus per-option effects (F75) |
| Unknowns | The literal word `unknown`, never a placeholder number | Jev abstains correctly on it |
| Time and freshness | Do not rely on Jev to honour age or validity labels; enforce in code | F63, F65 |
| Identity | Let code bind the target and expose ambiguity explicitly; asking Jev to bind first made control worse (0/16 vs 9/16, F20) | Supported |
| Extras that did not help | 3×3 image grids, action verbs in labels, extra forecast questions, richer spatial facts without per-option results | F36–F43 |

## Control design that works

- **Bounded maneuvers and setpoints.** Yaw by fixed angles, fixed-distance steps for a stationary target, forward-speed setpoints for a moving one. Code executes the choice to completion or lease expiry and never picks. The 43,218-combination velocity menu passed 0 of 24 full missions (0 of 56 closed-loop flights overall).
- **One question per axis; yaw and speed can run as two parallel questions in one call.** They are separable. Do not ask Jev to pick the mode (track or search) in parallel with the control: code derives the mode from evidence.
- **Moving targets need speed setpoints with rate-aware consequences.** Fixed "approach 2 m" steps collapse once the target moves (reviewer arithmetic: 13% in band at 1 m/s). With measured closing speed applied over both the delay and the horizon, the reference holds a ±1 m band at 1.5 m/s (100% on real renders, 3 seeds).
- **Menu headroom and reverse.** Top speed at least 1 m/s above the fastest expected target; include small negative speeds or the controller creeps in on noise and cannot back off when the target stops. Steps of 0.5 m/s are fine for a ±1 m band.
- **Make the printed consequence true.** Bugs where "approach 2 m" moved 0.3–1.3 m, a speed command died when the yaw finished, or a 180° turn stopped at 105–150° all silently broke the loop. Measure printed-versus-realised from true motion for every option family.
- **Timing model.** Camera 5 Hz, perception about 140 ms (p95 190 ms) on an RTX 5090 laptop, Jev about 250 ms, a decision roughly every 0.6 s. That cadence is fine up to the limits below provided consequences are predicted at application time.
- **Measured operating limits for this design** (reference controller, 80% time-in-band floor): target speed all 8 seeds pass to 1.0 m/s on the simulated sensor, 7/8 at 1.5, 6/8 at 2.0, none at 2.25; real renders pass 3/3 at 1.0 and 1.5 m/s. Constant bearing rate (true orbit): 8/8 at 5°/s, 5/8 at 10°/s, 0/8 at 20°/s; real renders 100% at 5°/s, 95% at 10°/s. Real car speeds need a different action model (for example Jev sets a follow mode and range that code holds).
- **Tolerances follow the sensor.** ±0.5 m only for a stationary rear view; ±1 m for a moving target. Sensor range bias is about +0.3 m (rear view, low rig) and up to +1.0 m (front or oblique view, higher rig).

## Perception and derived state that works

- **Sensor:** the goal-agnostic stereo-object process (`experiments/jev-library/sensor/`, schema `stereo-objects/2`): YOLO11s-seg, OpenCV SGBM stereo, median depth inside the mask, bearing from camera rays. Quiet-machine latency 142 ms median at 5 Hz (stereo about 100 ms, detection about 28 ms); sustains 9–10 frames per second. Matches the archived batch pipeline on 619/619 object pairs.
- **Accept a class family, not one label.** The detector relabels the same car as truck, bus, even chair. Strict `car` at 0.25 confidence bound the visible car in 48% of frames; vehicle family at 0.15 reached 86% (94% under 12 m) with no false candidates.
- **Pose decides recall.** Rear and side views about 92%, front view about 38%, nothing reliable beyond about 21 m at 640×360. A static scene repeats the same miss forever, so add a few centimetres of seeded hover jitter (100/100 distinct frames afterwards).
- **Derived state owned by code:** target binding with explicit ambiguity; last-seen record stored as a world bearing with age; bearing-rate and range-rate estimates (least squares over a 1 s window, at least 3 samples under one identity, own motion removed, reset only on an identity change, never on a single miss); egocentric sector memory with per-sector clearance, aged with own displacement; bounded, de-duplicated appearance events so a brief glimpse between decisions is not lost.
- **Keep evaluator truth structurally unreachable** from perception, encoders and controllers, and score against the same range definition the sensor reports.

## Test results so far

Closed loop (real renderer, real sensor, simulated delays, truth-based scoring; all on the low rig, 1.8 m altitude, −5° pitch, open field, slow car):

| Scenario | Jev | Code reference | Do-nothing | Notes |
| --- | --- | --- | --- | --- |
| Track a visible car, hold 8 m, 45 s | 95% centred, 97% in band | 100%, 95% | fails on range | single seed |
| Car behind the drone: turn, find, follow, 60 s | found at 1.9 s, then 100%/100% | identical | never finds | single seed |
| L1 stationary car, offset start (3 seeds) | 100/100/100% centred | 100/100/100% | 0% | rear view only |
| L2 car orbiting at constant bearing rate, yaw only (3 seeds) | 91/96/99% centred | 97/96/99% | 0% | |
| L3a close 2 m to range and hold (3 seeds) | 100/100/100% in ±0.5 m | 100/100/100% | 0% | rear view only |
| L3b car accelerates, cruises, stops at non-menu speeds (3 seeds) | 86/91/92% in ±1 m | 92/88/85% | 0% | |
| L4 follow through turns and stops, 90 s (3 seeds) | centred 95/96/79%, in band 80/71/56% (1 of 3 passes) | centred 97/94/92%, in band 72/81/81% (2 of 3) | 11%, 4% | reasonable, not clean; range error accrues in turns and stops |

Static probes (one request, one choice): yaw from per-option bearings 32/32 and 32/32 (raw bearings 10–11/32); range from per-option results 116/116; search with sector memory plus per-option effects 50/72 useful with 0 harmful (turn back to a lost target 24/24, look at a never-inspected direction 20/24, advance along the one open corridor 6/24), against 0/72 for the current view alone or a dated view log and 9/72 with 12 harmful for sector memory without per-option effects.

Not yet tested in flight: obstacles and occlusion, lookalikes, long-range search, the full scout-then-follow mission, the higher camera rig, real hardware.

## What did not work

| Tried | Result | Reference |
| --- | --- | --- |
| Colour regions and raw image bearings with large velocity menus | 0 sustained following in 15 + 12 + 22 flights; wrong-direction first turns | F02–F17 |
| Semantic menus, more history, paired menus | no improvement, up to 2.4× the tokens | F06, F07 |
| Explicit target binding as a first stage | control got worse | F20 |
| Dated view history, 3×3 grid, action verbs, numeric vs worded facts | 0/24 full missions; no reliable gains | F35–F43 |
| Rich self-history (linked cards, diaries, forecasts, retrospection) | centring fell to zero in most runs; forecasting accuracy did not translate into action | F53 |
| Time labels (raw, age, validity) | 8/24 still acted on expired evidence | F65 |
| Monocular metric depth | 5 m mean error; stereo was 0.29 m | F67 |
| Nearest-depth clustering inside the mask | 31 errors over 2 m; plain mask median removed them | F74 |
| TensorRT, YOLO26, BoT-SORT as drop-ins | slower, worse on moving targets, or fewer wrong picks only by abstaining more | F74 |

Headline caveat recorded in F77: the earlier "framing 29% → 74%" result (F61) omitted the do-nothing observer, which framed the moving target 17.2 of 40 s against 25.0 s for the selected arm; most of the gain came from stationary targets.

## How to test quickly and honestly

- **Static probe first** for any new wording or field: one factor at a time, identical facts and menus across arms, answer key derivable from the rendered text, balanced answer positions, mirrors. About 2 calls per second, so 1,000 calls take about ten minutes and cost a few cents.
- **Reference on the simulated sensor next** for any control or timing design: seconds per episode, 8 seeds per cell. The simulated sensor must have pose-correlated miss runs, the real field of view and detection range, and aspect-dependent bias, or it flatters the design.
- **Real renders and real Jev last**, as confirmation on a few seeds. Flights run at about 1.2× real time; Jev cost is negligible.
- **Baselines on every scenario:** do-nothing, every constant action (select the strongest from data), first-option, seeded random, plus the code reference that reads only the request. A scenario is usable only if the reference passes on every seed and all baselines fail on every seed.
- **Scenario traps we fell into:** target speed equal to a menu speed (a constant action passes); a "10°/s crossing" that decays to 1°/s as the car drives away (use an orbit); start offset inside the centre band (do-nothing passes); front-view targets (detector blind spot); static scenes with byte-identical frames; a single lucky seed; an operating area smaller than the follow path.
- **Independent review pays for foundations, not for every unit.** Reviews of the engine found, in turn: commands silently rejected after about 64 decisions, consequences computed as if the drone were at rest mid-turn, a bearing stored camera-relative and read as a world heading, a camera running at 1.7 Hz instead of 5 Hz, speed commands dying with the yaw lease, a rate model with the wrong sign, and a rate memory wiped by one missed frame. None showed up in easy scenarios.

## Open questions and next experiments

| Question | Proposed fast test | Status |
| --- | --- | --- |
| How many options can a menu have; how close can two results be before Jev confuses them; does it apply a stated deadband | Static factors F1–F2 of the encoding-rules probe | Paused at 59 of about 934 requests |
| Best form of the per-option result: value, error from goal, code-computed label, or all | Static factor F3 | Built, not run |
| Numbers or words; how fragile are mixed sign conventions | Static factor F4 | Built, not run |
| Encoding safety constraints: rule in text vs per-option `allowed` field vs combined score | Static factor F5 | Not built |
| Fix for the open-corridor search failure | Static factor F6; closed-loop `coverage-consequences` arm | Not built; coverage grid built, not run |
| Search from the wrong heading and from beyond detector range | Position-aware coverage grid with per-option "new area seen in m²" and clearance; scenarios `l5-wrongway`, `l8-far`; constant yaw sweep as the honest baseline | Code and 22 tests written in the working tree, no runs yet |
| Does rate-aware text help Jev itself (not just the reference) | Same seeds, three consequence models (stationary, measured-rate, explicitly unknown) on L2 and L3b | Not run |
| Cleaner following through turns and stops (L4) | Shorter rate window or a "target manoeuvring" flag; tolerance that follows aspect-dependent bias | Open |
| Front-view and long-range detection | Detection-envelope sweep over range, altitude and pitch, aspect, classes, input size; options are a zoom look, larger detector input on the search pass, or approach-to-confirm | Open |
| Loss behind an occluder, lookalikes, full mission | Needs rig-sized obstacles with colliders, a candidate-choice question with continuity facts, replay from saved state | Open |
| Any object, not just the car | A second object class in L1 and the full mission | Open |

## Paused work and how to resume

- Branch `claude/find-follow-ladder` in the worktree `robots-world-find-follow` holds everything (two WIP commits: `ec37445`, `bdf195c`). Uncommitted at the pause: the search unit's coverage grid and scenarios (`experiments/jev-find-follow/coverage-memory.ts`, edits to `encoders/search.ts`, `episode.ts`, `ladder-scenarios.ts`, `maneuver.ts`, three new test files; its 22 new tests passed, the full scoped suite had not been re-run).
- Branch `claude/encoding-rules-probe` in the worktree `robots-world-rules-probe` holds the static encoding-rules battery (F1–F4 built and tested, 59 paid requests completed, no analysis yet).
- Run a flight: `ROBOTS_WORLD_RUNTIME_ROOT=<main checkout>/.runtime node --env-file=<env file> experiments/jev-find-follow/run.ts episode --scenario l3b-round3 --controller jev --real`. Batch with seeds: `run.ts batch --scenarios ... --controllers reference,passive,jev --real --seeds 9601,9602,9603`. List scenarios: `run.ts list`.
- Watch a flight: `PORT=8872 node server.ts`, then open `/jev-find-follow.html?report=/.runtime/experiments/jev-find-follow-v1/<run>/report.json`.
- Not merge-ready: engine clean-up items listed in `experiments/jev-find-follow/FAILURES.md`, the higher rig and L4 are unfinished, and the last two engine units were checked by tests and spot checks rather than an independent review.

## Changelog

- 2026-09-21: first version. Records the static encoding results (F57–F61, F75), the live sensor (F76), the closed-loop engine and the first real-Jev flights (smoke scenarios; L1–L3b 12 of 12 across three seeds; L4 1 of 3 with the reference at 2 of 3), the measured speed and bearing-rate limits, and the scenario traps found by review. The earlier estimate of a 1 m/s following ceiling was an implementation artefact (rate memory wiped by single misses, delay not applied to target motion) and is superseded by the limits above.
