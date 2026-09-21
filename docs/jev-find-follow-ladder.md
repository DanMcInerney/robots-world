# Find-and-follow staged test ladder

21 September 2026. Repair pass after a second independent review (verdict: READY after listed repairs; this revision applies all nine findings). Predeclared before any rung's inference except L0's detection-envelope and isolation checks, which may start now. See F77/F78 in [design-failures.md](design-failures.md) for what verified and what did not, and the "Repair verification" section at the end of this document for the second review's own arithmetic and file:line claims, checked here.

This ladder targets the engine at `experiments/jev-find-follow/` (Rapier world → `renderer.py --jsonl` on demand, evaluator products kept out of controller state → real `stereo-objects/2` sensor → code-owned derived state → `track`/`search` encoders → `jev`/`reference`/`constant`/`passive`/`synthetic` controllers → bounded maneuvers under leases → evaluator-only scoring); its internals are documented by its own maker, not here. The engine is **simulated-time and render-bound**, not wall-paced: physics/perception/inference all advance a shared simulated clock, and the dominant real-world cost is rendering + stereo + detection, not waiting on Jev.

## Purpose and advancement logic

Every rung isolates **one new difficulty** and is a prerequisite for the next. Nothing beyond L0's two static checks runs with real Jev calls until the blocking repairs below are in place: a working follow-dynamics model (§ Follow action model), a qualified camera rig (§ Rig-geometry qualification), fully numeric gates (§ Parameter table), and a clock gate matched to a simulated-time engine (§ Clock and latency qualification).

A rung **advances** only when, on its confirmation split: Jev's primary-metric score is **≥85% of the best reference arm's score** (never a handicapped single-arm reference — see § Follow action model), Jev beats the rung's stated baselines by the parameter table's margin, and there are **zero harmful events**, where harmful is an observable, scored category (§ Gates, baselines and harmful events), not an assertion. If the best reference itself fails the envelope-setting floor, the fault is sensing/menu/timing/dynamics, not Jev — that is what L0's reference-ceiling sweep exists to catch **before** any rung is configured, not after a Jev run fails.

**Rephrasing note (applies throughout):** every "what this would tell us" line below is a **hypothesis with a stated discriminating test**, not a pre-assigned single cause — the second review correctly flagged the first draft's causal language as premature.

## Rung overview and execution order

| Stage | Difficulty | Menu / encoding | Episode length | Owner's ask |
|---|---|---|---|---|
| L0 | Engine, sensor, rig and envelopes are trustworthy before any inference | none — zero Jev calls | gates only | prerequisite |
| L1 | Hold visible stationary object, across an offset×range sweep | `track` yaw, stationary consequence (7 options) | many short episodes, 20 s each | "track it if it can see it" |
| L2 | Bearing rate, yaw only | `track` yaw, rate-aware consequence with `unknown` fallback (7 options) | 20 s | — |
| L3a | Keep a commanded range — stationary target | `track` range, fixed-distance menu (5 options) | 30 s | — |
| L3b | Keep a commanded range — moving target | `track` range, speed-hold menu with rate-aware consequence (§ below) | 30 s | — |
| L4 | Yaw and range together, moving target with turns/stops | two parallel single-axis `Choice` questions (yaw 7, speed-hold 6) | 90 s | — |
| L5-pre | Static 70° search-state probe (prerequisite for L5) | `search` sector-consequences, static, no closed loop | n/a — static | — |
| L5 | Discover when facing the wrong way | `search`, 12-action sector menu, `sector-consequences` | 90–120 s | "find it if the drone is looking in the wrong direction" |
| L8 | Long distance: acquire far, then approach to D | `track` range, honest-unknown long-range consequences → speed-hold | 60–90 s | "find it from a long distance" |
| L6 | Temporary physical loss while following | `track`↔`search` mode switch | 90 s | — |
| L7 | Identity under a lookalike | `track` + sequential identity question (§ below) | 90–120 s | — |
| L9-pre | Stationary target behind an occluder, search only (prerequisite for L9) | `search`, 12-action menu | 90 s | — |
| L9 | Full mission: unseen at start, scout, then follow | `search`→`track` transition | 120–180 s | "hardest test… starts without the car in sight, scouts, then follows" |

**Execution order differs from difficulty order.** L8 depends only on L0, L3 and L5 (a long-range approach needs range-following and, if the target isn't already centred, search) — it does **not** need L6/L7's loss/identity work — so it is scheduled and can be executed **before** L6/L7, in parallel with them if capacity allows. L9 needs L1–L7 and L9-pre; L8 is not a prerequisite for L9 (the owner's hardest case is not stated as a long-range case). The table above is listed in execution order.

## Follow action model (applies to L2, L3b, L4, L6, L7, L8, L9)

The fixed-distance range menu (`approach_2m`, `approach_1m`, `hold`, `retreat_1m`, `retreat_2m`) is kept **only** for **L3a**, a stationary-target sub-rung that starts the range offset from D by more than the tolerance so passive cannot pass by construction. It is **not reused for any rung with a moving target.**

**Why.** The menu commits a 1–2 m position step per 505 ms decision. Verified against the confirmed drone control law (`src/models/mobile.ts`'s `tick`: `desired = target ? cap(scale(sub(target, position), 1.8), maxSpeed) : ...`, a position-error servo with gain 1.8, wrapped in a second acceleration-capped force loop) — a fresh 2 m step renewed every 505 ms cannot sustain more than roughly step ÷ period = 2 ÷ 0.505 ≈ 4 m/s under an idealised instant re-issue, and materially less once the gain-1.8 approach curve is accounted for. The second review's own idealised reference-controller simulation (stated explicitly as the review's arithmetic, not an engine result, and not re-run here) found the stationary `after-range` consequence collapses from ~92% time-in-band at 0 m/s to 0% at 2 m/s target radial speed. This is corroborated by the confirmed control law above, not independently re-derived cell-by-cell.

**Moving-target range axis: speed-hold menu.** Jev picks a forward-speed setpoint from a 6-option menu — **0.0, 0.5, 1.0, 1.5, 2.0, 2.5 m/s**, absolute speed along the current bearing to the target, issued as a `velocity` command (already a declared contract in `src/models/mobile.ts`, capped at the plant's `maxSpeed`) and held under the standard 505 ms lease until the next decision. Every option prints a code-computed consequence:

```
resulting_range_m ≈ current_range_m + (estimated_target_radial_speed_mps − option_speed_mps) × H
signed_error_m = resulting_range_m − D
```

with `H` the declared horizon (**1.0 s**, ≈2 decision periods — long enough to average sensor noise, short enough that the stationary/full-settling assumption stays defensible).

**Rate estimate, defined precisely (an engine requirement, not yet implemented):**
- **Window:** the last 1.0 s of valid range samples under **one bound target identity** (no identity change inside the window).
- **Minimum samples:** ≥3 valid samples in that window.
- **Own-heading correction:** each sample is corrected for the drone's own heading/position at that sample's acquisition timestamp before the radial-rate least-squares fit, so ego-motion is not read as target motion.
- **Staleness:** any sample older than 2× the camera period (>400 ms at 5 Hz) is excluded from the window.
- **`unknown` conditions:** fewer than 3 valid same-identity samples in the window, an identity change inside the window, or every sample stale → the rate is `unknown`. **Every option's printed consequence then falls back to the stationary form** (`resulting_range_m ≈ current_range_m − option_speed_mps × H`) and the rendered text says so explicitly (`"target radial speed unknown; consequence assumes the target is currently stationary"`) — this is F61's "explicitly unknown predictions" arm, built into the rate-aware consequence rather than run as a separate third controller arm.

**Yaw on moving-target rungs** carries the analogous **measured bearing-rate consequence** (same window/minimum-samples/own-heading/staleness/`unknown` rules, substituting bearing for range), replacing L1's stationary-ray consequence on every rung past L2.

**The one-factor arm (stationary vs. rate-aware consequence) is run on both axes where it can discriminate: L2 (yaw) and L3b (range).** Both arms are Jev-facing (Jev receives one or the other encoding) and **both are judged against the best of the two reference arms** (stationary-consequence reference, rate-aware-consequence reference), never each arm's own matching reference — this directly fixes the flaw the review found: judging the rate-aware arm only against a rate-aware reference (or the stationary arm only against a stationary reference) can make a genuinely worse arm look adequate.

**A walking/rolling-pace object as the second class.** Since the menu physically cannot sustain fast pursuit, `jev-minimal-tracking-review.md`'s stage-2 proposal (a Jev-selected signed forward speed) is exactly what the speed-hold menu now is; a walking person is therefore a natural second object class for the generality check (§ L4, L9), not only a car at car speeds.

## Rig-geometry qualification (in L0)

**Candidates, no Jev calls:** the existing Round 3 rig (1.8 m altitude, −5° pitch), a chase rig at 5 m/−18°, a steeper cell at 5 m/−25°, and — because the review's own trigonometry (below) suggests the 5 m/−18° cell's feasible band may be too narrow — an intermediate cell at 5 m/−12° and a higher-altitude cell at 6.5 m/−18°.

**Verified geometry for the 5 m/−18° candidate** (recomputed here, not merely re-read from the review): f = 457 px (640 px width, 70° HFOV, confirmed `experiments/jev-round3-plan.md`'s stated rig). Vertical FOV = 2·atan((360/2)/457) = 42.98° ≈ **43.0°**. At −18° pitch the view spans **+3.5° to −39.5°** from horizontal. Nearest visible ground = 5 ÷ tan(39.5°) ≈ **6.07 m**. The target car is 4.5 m long × 1.227 m tall (`TARGET_CAR_DIMENSIONS`, `experiments/jev-round3/world.ts:55`, verified). For ±0.25 px disparity error at f·B = 91.4 px·m (0.20 m baseline): **±0.18 m at 8 m, ±0.27 m at 10 m, ±0.39 m at 12 m** (recomputed via Z²·dd/(f·B), matching the review's figures independently). F70's confirmed coverage at the *existing* rig was **29/45 (64%) at 8–12 m and 0/17 at 12–15 m** on the nominal-range confirmation route specifically — not the whole confirmation set (see § Accuracy repairs below): other routes reached 84/100 and 94/100, material counter-evidence that the coverage gap is not a uniform range limit. The feasible follow band for 5 m/−18° may therefore be narrow (the review estimates roughly 9.5–11 m, ≈1.5 m wide) — too narrow to place D ≥2 m from both edges. **This is exactly why the qualification sweeps a small family of cells rather than committing to one rig:** the pass rule below requires a feasible band **≥4 m wide** so D can sit ≥2 m inside both edges; if no single-altitude/pitch cell in the initial family clears that, the qualification widens the pitch/altitude grid before choosing.

**Qualification procedure and outputs, per candidate rig:**
1. **Feasible follow band:** the range interval where the whole car is unclipped (both the roof line and the bottom of the visible box stay inside the frame at the candidate pitch) **and** stereo error ≤ tolerance/2 (using the moving-target tolerance, ±1 m ⇒ error ≤0.5 m). Static renders only, no physics loop.
2. **Consequence-fidelity check:** on a stationary target, compare the printed per-option consequence (resulting bearing/range) against the *realised* outcome after the option actually executes. Pass: error ≤ tolerance/2 on both axes. This is the check that the pitch-aware encoder (below) is actually correct, not merely plausible.
3. **Fixture qualification, F26 pattern:** for the occluder used at L6/L7, confirm from the reference controller's own pursuit path that the occluder yields **≥X s of full invisibility** (X measured, becomes L6's loss-ceiling input); confirm a straight pursuit path at this rig's altitude actually intersects a collider used at L4 (obstacles must be sized relative to the rig — height ≥ altitude + 2 m, width ≥0.5 m — the existing `partial-occluder` at 2.2 m tall and the wall/pole at 2.5–2.7 m are all **below** a 5 m flight altitude and give no occlusion or contact risk there; new/resized obstacles are a required fixture edit, not a "reused as-is" claim).

**Pick D:** ≥2 m inside the widest qualifying band, among candidates that pass steps 1–2. **D is the sensor's slant surface range** (`surfaceRangeM`), not horizontal or axial depth — a 2 m horizontal step only changes slant range by a smaller amount at shallow pitch, so the tolerance and every consequence formula are stated in slant-range terms throughout, and every goal sentence's distance criterion is scored on the matching evaluator range (slant), never axial depth.

**Encoder requirement, stated not assumed.** The frozen `live-adapter.ts` refuses any nonzero pitch (`camera.fixedPitchDeg !== 0` → `unknown`, verified at line 39) — it **cannot** be reused for a pitched rig. At −18° pitch, body-yaw azimuth diverges from image bearing by roughly 1° at frame centre and 3.7–4.8° for low, off-axis targets (review's trig, camera-geometry mechanism confirmed, magnitude not independently re-derived here). The new engine's own encoder (`experiments/jev-find-follow/`, documented by its own maker) **must implement pitch-aware bearing/range consequences**; this ladder states that as a requirement on the engine, not as "reused verbatim" from the frozen bench — the bench's exact numeric menus (7 yaw options, 5/6 range/speed options) are reused; its pitch-blind geometry adapter is not.

**Goal-sentence wording, corrected:** every goal sentence below says **"horizontally within N° of image centre"**, never bare "within N degrees" — at 8 m a car under this rig already sits well below the optical axis regardless of yaw, so an unqualified "centred" criterion is unsatisfiable and repeats F52's stated-vs-scored mismatch.

## L0 — Gates without Jev

### Clock and latency qualification, rewritten for a simulated-time, render-bound engine

The first draft's "wall time within a 250 ms lag budget of simulated time" describes a wall-paced engine; it is the wrong property here and cannot pass at measured render costs (offscreen render 325 ms median/521 ms p95 per stereo acquisition, F70, against a 200 ms camera period at 5 Hz). The properties actually required:
1. **Latency-injection fidelity:** the `synthetic` controller, driven by the declared perception/controller latency distributions (perception ≈140 ms median/≈190 ms p95, the verified quiet-machine figures below; controller ≈220 ms median/≈306 ms p95, F59's measured after-bearing dispatch time — **declared as an RTX 5090 laptop GPU figure, replaying recorded frames, not a measured onboard/companion-computer figure; a pessimistic perception-latency arm (e.g. 2–3× these figures) is also declared and used for at least one confirmation pass per track/search rung**, honouring the "as if on a real drone" framing) — must reproduce the declared distribution within a stated tolerance when sampled over a run at least as long as L9's longest episode.
2. **Non-retroactive application and lease expiry, in simulated time:** a command applied after its lease has expired in simulated time is rejected and logged, exactly as `bench.ts`'s frozen machinery already does; this is checked against the simulated clock, never the wall clock.
3. **Request starts ≥505 ms apart in *simulated* time, independently checked in *wall* time too:** the in-flux scheduler paced in wall time only at inspection — both must be verified, since a render-bound engine could satisfy one without the other.
4. **Determinism and replay-to-a-time:** identical seed + identical controller responses ⇒ identical physics trajectory, and the engine can replay to an arbitrary simulated timestamp — required by the held-at-loss-pose counterfactual (L6, L9; reinstated from `docs/jev-spatial-premise-and-next-tests.md:225`, corrected line number after this repository's own earlier additive edits shifted it from the originally-cited `:223`), which freezes a pose and continues scoring from it.

### Evaluator/controller isolation check

Static scan of every `track`/`search` request the engine can render (reusing F75's scanners): no evaluator-only field (true identity, true range, true position, spectator geometry) in `state`/`instructions`/`criteria`; no ranking language anywhere in a rendered request (same-sentence-negation scanner); `reference`'s access to "the best printed consequence" comes from the same per-option text Jev receives. Confirm `renderer.py --jsonl` actually runs with `evaluator=False` for the frame stream the encoder reads, evaluator products routed to a separate sink (F70/`docs/jev-round3-results.md`'s finding that `evaluator=True` is the renderer's default).

### Detection-envelope sweep (no Jev calls)

**Why, corrected wording:** F70's **61/100** correct-usable figure is the **nominal-range confirmation route specifically**, not detection "overall" — the wall-and-pole route scored **84/100** and the moving-car route **94/100** on the same confirmation split (`docs/jev-round3-results.md`'s table, verified), material counter-evidence against reading the nominal-range shortfall as a general sensor limit rather than a viewpoint/asset artefact of that one route. The reference-range span actually rendered across all 1,200 Round 3 frames is **5.15–14.998 m** (`.runtime/experiments/jev-round3-v1/diagnostics.json`, verified), not the 4–18 m proposed in `docs/jev-3d-perception-test-plan.md`; nothing beyond ~15 m has ever been rendered — long-range performance is untested, not failing.

**Design:** a numeric, non-circular long-range band definition: **cells at 15, 20, 25, 30, 35, 40 m** (extending past the untested boundary in fixed 5 m steps), crossed with camera altitude/pitch (the rig-geometry qualification's candidate cells), target aspect (rear/side/front/oblique), ≥2 non-car detector-known classes (flagged engine-asset dependency, unresolved), and HFOV (70° plus one narrower option). **Each cell renders ≥8 frames, varying only target aspect within the cell** (a single static deterministic render per cell would conflate a range limit with one asset/viewpoint artefact, the review's point) — report **apparent target size in pixels per cell** so cells can be compared at matched apparent size, separating a true range limit from a viewpoint artefact. Score per cell: detection coverage, class-label stability (F76: one physical car labelled `car`/`truck`/`bus` in 83/237 frames at 5 Hz), range validity/error, the adapter's `unknown` rate, and **the distribution of consecutive dropped-frame runs** (not just an aggregate skip fraction — this run-length distribution is also what sets L5/L9's mode-switch hysteresis, below).

**Honest long-range options, costs, and the predeclared rule (unchanged mechanism, one correction):** narrow-FOV look; tiled/1280 px detection **on the search pass only** — but verified against the quiet-machine 5 Hz detect-stage figure (27.5 ms median): a 3-tile pass costs roughly 3×27.5 ≈ **82 ms** added, which **fails this ladder's own ≤71 ms latency-floor rule** (half of the 142 ms base pipeline total) — tiled detection is therefore **pre-disqualified by the ladder's own numbers**, not merely a candidate to test, unless a cheaper tiling scheme (2 tiles, or a smaller crop) is shown separately to clear the floor; approach-to-resolve; declare the limit. Rule: adopt the cheapest option clearing ≥70% correct-usable coverage at the intended band with no ≤12 m regression; evaluate narrow-FOV and (if a cheaper tiling variant is found) tiled-detection before approach-to-resolve; declare the limit if none clears the floor.

### Reference-ceiling sweep

**Why:** envelopes (target speed, bearing rate) must come from measured reference-controller performance under the engine's actual latency model, not from assertion.

**Design, two independent 1-D sweeps (not a joint grid — yaw rate and range rate are separate axes tested on separate rungs):**
- **L2's bearing-rate sweep:** rates **{5, 10, 15, 20}°/s**, crossed with policies {stationary-consequence reference, rate-aware-consequence reference, `passive`, one representative `constant` yaw action, `random`}, 20 s episodes.
- **L3b's target-speed sweep:** radial speeds **{0.5, 1.0, 1.5, 2.0, 2.5}m/s**, crossed with the same policy family (range menu equivalents), 30 s episodes.
- **Exhaustive constant-action check:** every yaw action and every speed-hold option is run as its own `constant` policy **once, here, across the full sweep** — this is the one place "every constant action" is checked exhaustively; individual rungs below reuse only the single best-scoring constant from this sweep (a stated economy, see § Wall-time budget).

**Output and rule:** for each axis, the envelope = the **largest tested value at which the best-of-arms reference clears an 80% floor** on its primary time-in-band metric. This same 80% floor is reused as each rung's own reference-floor requirement (§ Parameter table) — the value that sets the envelope is the same value a rung's `reference` must itself clear before any Jev call is spent on that rung. **Provisional expectation, not yet run:** given the review's own idealised simulation (±1 m band: 98% at 1 m/s, 94% at 2 m/s for the rate-aware reference), the target-speed envelope is expected to land near **2 m/s**; the coordinator's provisional overall target envelope is **≈0–2 m/s (walking/slow-rolling pace)** — this ladder states plainly that **sustaining real car speeds (5–15 m/s) with a ~2 Hz text controller is very unlikely to be reachable**, and this is a finding for the owner to see, not a claim this ladder hides by loosening the tolerance.

## Parameter table (one frozen table; the rung sections below reference symbols, not literal numbers, wherever a value is an L0 output)

| Rung | N (horiz. central-band half-width) | D (slant range) | Range tolerance | T2 (held-after-discovery) | Baseline margin | Loss ceiling | Wrong-target ceiling | Reference floor (envelope-setting) | Per-family floor | Aggregation unit |
|---|---|---|---|---|---|---|---|---|---|---|
| L1 | **N₀** — rule: smallest band half-width in the sweep {5°, 7.5°, 10°, 11.9°} at which the stationary-ray reference clears ≥80% on a stationary target (bisecting the review's own 64%@5° / 100%@11.9° bracket; provisional ≈8–10°) | n/a | n/a | n/a | ≥15 pp over `passive` (passive can score high here by accident on a stationary target — see § Gates below) | n/a | n/a | 80% | 0.75 per offset×range cell | per-cell fraction, median per cell family, reported per range bucket |
| L2 | N₀ | n/a | n/a | n/a | ≥15 pp over `passive`/best-`constant`, AND ≥85% of best reference | n/a | n/a | 80% — sets the bearing-rate envelope (§ Reference-ceiling sweep) | 0.75 per rate bucket | per-episode fraction, median per rate bucket |
| L3a | n/a | **D₀** — rule: ≥2 m inside the widest qualifying feasible band from § Rig-geometry qualification (provisional ≈10 m) | ±0.5 m (stationary; matches `RANGE_TOLERANCE_M`, ≥F67's 0.291 m MAE/0.505 m max stereo noise) | n/a | ≥15 pp over `passive` (passive is ≈0% by construction — start offset exceeds tolerance) | n/a | n/a | 80% | 0.75 per start-offset bucket | per-episode fraction, median per bucket |
| L3b | n/a | D₀ | **±1 m** (moving; coordinator decision — a rear-on-to-side-on turn alone shifts mask-median slant range by ≈1 m) | n/a | ≥15 pp over `passive`/best-`constant`, AND ≥85% of best reference | n/a | n/a | 80% — sets the target-speed envelope (provisional ≈2 m/s, § Reference-ceiling sweep) | 0.75 per speed bucket | per-episode fraction, median per speed bucket |
| L4 | N₀ | D₀ | ±1 m | n/a | ≥15 pp / ≥85% of best reference, **on each axis separately** (never only the joint AND) | n/a | n/a | 80%, both axes independently | 0.75 per (speed-bucket × turn-phase) cell | per-axis fraction, median per cell, joint AND reported as a third, non-primary number |
| L5-pre | N₀ (for oracle geometry only) | n/a | n/a | n/a | ≥90% supported-choice accuracy (F75's own static-gate convention) | n/a | n/a | n/a (static probe) | 0.75 | per-family accuracy |
| L5 | N₀ | n/a | n/a | **10 s** (coordinator/review's own proposed value, adopted directly) | ≥15 pp over the **best of** {`passive`, `constant`, `sweep` — a systematic fixed-rotation baseline, added specifically because an open field from a fresh start makes a plain sweep strong, § Gates} | n/a | n/a | n/a — L5's four offsets (60/100/140/180°) are the owner's fixed ask, not envelope-derived; only T2/margins are | 0.75 per offset bucket | per-episode success, median per offset |
| L8 | n/a (not bearing-scored en route) | D₀ (final target) | not ±0.5 m at long range (stereo error there exceeds it) — scored on time-to-confident-range and time-to-D-band instead | n/a | binary: Jev reaches the D-band within the episode; `passive`/`constant` structurally cannot | n/a | n/a | 80% success (reaches D-band) at the sweep-confirmed long-range band's near edge — confirms the L0-chosen long-range option actually supports an approach from there | 0.75 per starting-range bucket within the confirmed band | per-episode success, median per bucket |
| L6 | N₀ | D₀ | ±1 m | n/a | **non-inferiority** on the narrow-occluder (passive-reappearance-possible) variant: Jev's reacquisition time not worse than the held-at-loss-pose counterfactual's own reappearance time by more than 10%; ordinary superiority (≥15 pp / ≥85% reference) on the wide-occluder (active-recovery-only) variant | **2×X**, X = the rig-geometry qualification's measured full-invisibility seconds for the resized occluder | n/a | 80% on the active-recovery variant only (confirms the fixture is solvable at all) | 0.75 per variant | per-episode loss duration, median per variant |
| L7 | N₀ | D₀ | ±1 m | n/a | Jev's wrong-target time ≤50% of `passive`'s wrong-target time | n/a | **≤10%** of post-discovery episode time spent centred/ranged on the lookalike with a confident (non-`unresolved`) wrong answer | 80% | 0.75 per variant (a: crossing, b: cold-start at reacquisition) | per-episode wrong-target fraction, median per variant |
| L9-pre | N₀-equivalent | n/a | n/a | 10 s | ≥15 pp over best of {`passive`, `sweep`} | n/a | n/a | n/a (prerequisite static+search probe) | 0.75 | per-episode success |
| L9 | N₀ | D₀ | ±1 m | 10 s (discovery component) | discovery: L5's rule; following: L4's rule, applied per component | L6's 2×X | L7's ≤10% | 80% per component | **0.75 across the 8 blocks (≥6/8 clearing)** | per-block pass/fail against the F43-style rule (below); never pooled across blocks into one continuous score |

**Development gate (stated once, applies everywhere an arm-selection decision is made):** an arm "clears development" when it meets its rung's per-family floor with **zero harmful actions** across every development seed/family. **No placeholders remain above** — every cell is either a literal number, a stated formula, or an explicit rule tied to an L0 output; where a number is "provisional," the rule that will fix it and the review's own bracketing evidence are both stated.

## Gates, baselines and harmful events

**Baselines, corrected set:** `reference` (best-of-arms, never a rung's own single handicapped arm), `passive` (`hold` every decision), `constant` — **the single best-scoring non-hold constant action for that rung's menu, selected once from L0's exhaustive reference-ceiling sweep** (not re-swept per rung — a stated economy, see § Wall-time budget), and `random`. **Search rungs (L5, L9-pre, L9) add `sweep`**, a systematic fixed-rotation policy, specifically because an open-field fresh start makes a plain sweep a strong, easily-overlooked competitor (§ L5 below). `first-option` is checked once, comprehensively, inside the L0 sweep, and spot-checked again only at L9 (the terminal integration rung); it is not re-run at every rung's own seed density (a second stated economy).

**Harmful events, made observable:** every goal sentence states the operating envelope numerically (position/altitude bounds), and **every menu option carries a bounds/clearance consequence** the same way it carries a bearing/range consequence — an option that would exit the stated envelope or enter unknown/blocked clearance is flagged in its own printed text, exactly like F29's original gap and F75's `sector-consequences` blocked-clearance rule, generalised to every rung. **Executor vetoes and guards are logged and count as harmful decisions** (F63's lesson: a guard silently preventing a bad action must not be read as Jev never choosing it). Contact, envelope violation, a vetoed choice, and — from L7 — a confident wrong-target answer, are all scored the same way: as harmful events against the zero-harmful advancement gate.

**Selection rule, fully determined (no undetermined tie-break remains):**
1. If **no** development arm clears its per-family floor, **do not fall back to payload** — report "no arm selected," treat the rung as blocked, and design a discriminating follow-up before spending another Jev call there.
2. If **exactly one** arm clears, it is the primary arm; confirm it.
3. If **two or more** arms clear, **confirm every clearing arm** (Jev-call cost is cents; render cost is what matters, and confirming a cleared arm reuses the same seeds already needed for the primary's own confirmation — see § Wall-time budget), predeclare one as the **primary** before confirmation (by highest development margin above its own floor), and break a **development tie** (arms within 2 percentage points of each other) using a **named robustness criterion**: the arm whose family-floor margin (distance above 0.75) is more consistent across families (lower variance across per-family rates) is primary; **if that check also ties (variance within 1 percentage point), neither arm is preferred on payload alone — both are confirmed as co-primary and the rung's advancement requires both to individually clear the gate**, with the smaller-payload arm recommended only as an implementation preference stated separately from the scientific verdict. This directly fixes F75's second flaw (payload deciding between two *perfect* development arms that then diverged at confirmation).
4. **No variant is introduced for the first time at confirmation.** Every candidate arm (including L5's `new_never_inspected_deg` variant) is run at development first; only arms that clear development reach confirmation.
5. **No confirmation split runs a variant "first."** Confirmation-split order across arms is randomised per seed, not fixed, so an ordering effect cannot be mistaken for an arm effect.

## L1 — Hold a visible stationary object, across a sweep

**Purpose / hypothesis, with discriminating test:** does the real sensor's dropouts and class relabelling break the `track` encoding with zero motion and zero search — tested by comparing framing time across a range of starting offsets and distances, not one fixed condition. **This rung is degenerate as a single static-camera episode** (a static scene with a static camera yields near-identical frames frame to frame, so most of a 120-call episode would be duplicate observations and sensor dropouts would never vary) — corrected to **many short episodes over an offset × range sweep**, and the encoder engine is asked to add **optional seeded per-frame image noise** (lighting/exposure jitter) so repeated frames at the same nominal pose are not byte-identical.

**Scene and fixture:** `nominal-range` family (`experiments/jev-round3/world.ts`). **Corrected fixture description:** this family's script moves the **drone**, not the car — `droneScript = [segment(0,[2.0,0,0]), segment(5000,[-1.3,0,0])]`; `targetScript` is the module's default `[segment(0,[0,0,0])]` (stationary), unedited. For L1, the drone script is replaced with a **hold** at each sweep cell's starting pose (no drone motion either) — a genuine edit, not "reused as-is." **Corrected start-offset claim:** the family's actual bearing offset at episode start is **≈1°** (recomputed from `dronePosition=[-5+jitter, sign*0.2, 1.8]` and `target=[12, jitter, ...]`: lateral separation ≈0.2–0.4 m at ≈17 m longitudinal distance ⇒ atan(0.3/17) ≈1°), **not** the 10–30° previously stated — a materially smaller, near-boresight starting condition. L1's sweep must therefore introduce its own **explicit** offset values rather than relying on the family's tiny built-in one.

**Sweep design:** **3 range buckets** (near/mid/far inside D₀ ± the L0-confirmed reliable band) × **3 offset buckets** (0°, ±N₀/2, ±N₀ — using the parameter table's N₀) = 9 cells. Development: 2 seeds/cell (18 episodes); confirmation: 3 fresh seeds/cell (27 episodes). Episode length **20 s** each.

**Camera rig:** the L0-confirmed default. **Goal sentence:** *"A {colour} {class} is visible ahead. Keep it horizontally within N₀ degrees of image centre for as much of the next 20 s as possible, and do not exit [stated altitude/position bounds]."*

**No-Jev gates:** `reference`, `passive`, `constant` (best-of-sweep, from L0), `random`; run at confirmation seeds only (§ Wall-time budget's stated baseline economy). `passive` can score surprisingly high at small offsets by accident, which is exactly why the margin is stated relative to passive, not an absolute framing percentage.

**Discriminating test if L1 fails:** if `reference` fails a cell, the fault is the encoder/menu at that offset/range (fix before any Jev call there); if `reference` passes but Jev fails a *far*-range cell specifically, the hypothesis is sensor dropout/class-relabelling density growing with range (discriminate by comparing Jev's per-cell `unknown`-consequence rate against the L0 sweep's own per-range dropout-run distribution); if Jev fails a *near*-range cell where `reference` passes, the hypothesis is instead a closed-loop coupling factor unrelated to range.

## L2 — Moving object, yaw only

**Purpose / hypothesis:** does the stationary-ray consequence (L1) suffice once the target itself moves, or is the rate-aware consequence (§ Follow action model) required — discriminated by comparing the two arms against the **same** best-of-arms reference.

**Scene and fixture:** `moving-target-ego` family — the **only** family whose script moves the car (`targetScript=[segment(0,[0.4,sign*0.22,0]), segment(5000,[0.4,-sign*0.22,0])]`, ≈0.46 m/s, confirmed). L2 isolates yaw-only by holding the drone's own position fixed (edit: replace `droneScript`'s translation with a hover, keep only the family's target motion) — deferred combined ego-motion to L4.

**Envelope:** the bearing rates tested are the L0 reference-ceiling sweep's own grid, **{5, 10, 15, 20}°/s**; L2's confirmed envelope is whichever of these the sweep's 80% rule actually selects (provisional expectation, from the review's own stationary-reference numbers of 100%/93%/23% at 5/10/20°/s against a ±11.9° band, dropping sharply at N₀ if N₀ lands tighter — this is exactly why the envelope is an L0 output, not asserted).

**What Jev controls / encoding:** the 7-option yaw menu, unchanged. **Two development arms:** stationary-ray consequence (L1's, as a control) vs. rate-aware consequence with the declared `unknown` fallback. Both judged against `max(reference-stationary, reference-rate)`.

**Goal sentence:** *"A {colour} {class} is moving nearby. Keep it horizontally within N₀ degrees of image centre for as much of the next 20 s as possible, and do not exit [bounds]."*

**No-Jev gates:** `reference` (both consequence variants), `passive`, `constant` (best yaw constant from L0), `random`.

**Discriminating test:** if the rate-aware arm does not beat the stationary arm by a margin at the top of the tested rate range, rate information specifically is not the bottleneck at this rung (a distinct finding from "L2 failed," which would instead implicate the menu/latency).

## L3a — Keep a commanded range, stationary target

**Purpose:** range regulation isolated from yaw and from target motion, using the fixed-distance menu, which is valid here because the target never moves.

**Scene and fixture:** `nominal-range` family, **corrected**: the drone's own script (its scripted approach/retreat) is replaced by Jev's range-menu choices; the car (`targetScript`) stays at its default stationary state — an edit that removes the scripted drone motion, not one that adds target motion. Start condition: drone placed at a range offset from D₀ exceeding the ±0.5 m tolerance (so `passive` cannot pass by construction, per the coordinator's decision).

**What Jev controls / encoding:** the 5-option `after-range` menu (`approach_2m`, `approach_1m`, `hold`, `retreat_1m`, `retreat_2m`), F75's arm that held 116/116 across both splits.

**Goal sentence:** *"Follow the {colour} {class} at D₀ metres (slant range), tolerance ±0.5 m, for as much of the next 30 s as possible, and do not exit [bounds]."*

**No-Jev gates:** `reference`, `passive` (expected ≈0% by construction), `constant` (best range constant from L0), `random`.

**Discriminating test:** `after-range` already passed its own static gate (F75); a closed-loop failure here specifically implicates own-motion range-measurement noise or decision-to-measurement latency, not the encoding.

## L3b — Keep a commanded range, moving target

**Purpose:** the range analogue of L2 — does the speed-hold menu's rate-aware consequence (§ Follow action model) let Jev hold D₀ against a moving target, at the coordinator's provisional ≈0–2 m/s envelope.

**Scene and fixture:** `moving-target-ego` family (the only car-moving script), **edited** to give the target a **declared radial** speed component (the family's native motion is lateral-leaning, `[0.4, ±0.22, 0]`; L3b needs the car's velocity vector aimed to close/open range relative to the drone specifically) — a required, flagged engine-side script edit, not reuse-as-is.

**Envelope:** L0's target-speed sweep, **{0.5, 1.0, 1.5, 2.0, 2.5} m/s**, 80%-floor rule; provisional ≈2 m/s.

**What Jev controls / encoding:** the 6-option speed-hold menu. Two development arms (stationary-range-consequence vs. rate-aware speed-hold consequence), judged against the best-of-arms reference, exactly as L2.

**Goal sentence:** *"Follow the {colour} {class} at D₀ metres (slant range), tolerance ±1 m, for as much of the next 30 s as possible, and do not exit [bounds]."*

**No-Jev gates:** `reference` (both variants), `passive`, `constant`, `random`.

**Discriminating test:** as L2, substituting range for bearing.

## L4 — Follow: yaw and range together, target turns and stops

**Purpose:** axis coupling with a target that turns and stops, inside the now-measured (not asserted) speed/rate envelope.

**Question structure:** **two independent parallel single-axis `Choice` questions** — the 7-option yaw menu and the 6-option speed-hold menu — **not** a 35-tuple joint menu. The yaw and range axes are separable (each option's consequence depends only on its own axis's current state, not on the other axis's chosen option), so a joint menu adds option count without adding information; two parallel questions is both cheaper and matches the in-flux engine's own actual implementation (observed at inspection: a smaller yaw menu, two parallel questions, and its own yaw-rate limit — this ladder's exact 7/6-option counts are what this document specifies; if the engine's own frozen menu differs at build time, that is the engine's declared menu, documented by its own maker, and this ladder's rung structure — two parallel axis questions, not one joint menu — is the requirement that must hold, not the literal option counts).

**Scene and fixture:** `wall-pole` family, **corrected**: this family's script moves the **drone** (a weaving pattern), not the car; obstacles (wall 2.7 m, pole 2.5 m tall, pole 0.12 m wide) sit **below** a 5 m flight altitude and are currently vacuous as collision hazards there, and the pole is narrower than the ladder's own ≥0.5 m obstacle-width rule. L4 requires: (a) a new car-motion script with turns and stops inside the L0-confirmed envelope, replacing the drone-motion script (Jev now flies the drone); (b) obstacles resized per § Rig-geometry qualification's rule (height ≥ altitude + 2 m, width ≥0.5 m) if collision risk is wanted at this rung — otherwise obstacles are omitted from L4 and deferred to L9, which already needs resized obstacles for its own topology.

**Goal sentence:** *"Follow the {colour} {class} at D₀ metres (slant range), tolerance ±1 m, keeping it horizontally within N₀ degrees of image centre, for as much of the next 90 s as possible, and do not exit [bounds]."*

**No-Jev gates:** `reference`, `passive`, `constant` (best per-axis constants from L0, run together), no `random` at this integration rung (already exhaustively checked at L0 and at L2/L3b individually — a stated economy).

**Pass criteria / scores:** central-band time and range-band time **scored and reported separately**, never only their joint AND (F04's composite-score lesson).

**Discriminating test:** if L1–L3b all pass but L4 fails, the hypothesis is axis coupling or the added latency of two simultaneous requests — discriminated by comparing L4's per-axis scores against L2/L3b's own scores at the matching speed/rate cell: if the per-axis scores match, the failure is genuinely about coupling/timing, not either axis's encoding.

## L5-pre — Static 70° search-state probe (prerequisite for L5)

**Purpose:** F75's `sector-consequences` was only ever tested at a 36° HFOV oracle (`experiments/jev-scout-encodings/oracle.ts:27-28`, verified) against the real sensor's 70° HFOV, and every F75 case had exactly one never-inspected sector by construction — the very first real search decision (most/all sectors unseen, several options genuinely tied on coverage) was never generated. Run this **before** any closed-loop search rung, no closed loop, ≈$0.05.

**Design:** static component probe at 70° HFOV, reusing F75's oracle/generator machinery with the sector width and camera-HFOV constants changed to 70°. Three families: **fresh-start** (zero prior inspections, several sectors tied), **viewpoint-change** (some sectors inspected from a previous, different heading — tests whether sector memory re-derives correctly after a heading change), and **asymmetric prior coverage** (an irregular mix of inspected/never sectors, so sector memory carries genuinely discriminating information — directly answering finding 6's concern that "sector memory carries no decision-relevant information unless starts include asymmetric prior coverage").

**Gate:** F75's own static convention — ≥90% supported-choice accuracy, zero unsupported commitments, per-family floor 0.75.

## L5 — Find when facing the wrong way

**Purpose:** discovery without search-fixture obstacles, isolating "looking the wrong direction" from "behind something" (L6/L9). Owner's second explicit ask.

**Goal sentence, corrected to entail its own criterion:** *"A {colour} {class} is somewhere nearby but not currently visible. Find it and keep it horizontally within N₀ degrees of image centre for at least 10 continuous seconds, and do this within twice the time a systematic search of this area would need."* — the "within twice a systematic search's own time" clause is what makes the sentence entail the scored pass criterion (first-delivered detection time ≤2× the `reference`'s own time), which the first draft's wording omitted.

**Scene and fixture:** new open-field fixture (no occluders), offsets **60°, 100°, 140°, 180°, both sides** (the owner's fixed ask; not envelope-derived).

**Why an open field from a fresh start is a genuinely weak discriminator, and the fix:** in an open field with no prior information, a systematic rotation (the new `sweep` baseline) is close to optimal and will pass the discovery clause on its own — this is expected, not a bug, but it means the comparison against `sweep` (not just `passive`) is what actually tests whether `sector-consequences` adds value over "just keep turning." The L5-pre prerequisite's asymmetric-coverage family is what exercises `sector-consequences`'s actual decision-relevant content; L5's own closed-loop episodes are long enough (90–120 s, ≈180–240 decisions) that after the first few decisions, real inspection history is no longer symmetric even starting from a uniform prior — the very first decision may tie, later ones need not.

**What Jev controls / encoding:** the 12-action sector menu, `sector-consequences` (F75's only representation with material directional competence: 29/36 then 21/36 positive, vs. 0/72 combined for the memory-only arms, verified). **Confirmation runs the `new_never_inspected_deg` variant too, having already appeared at development** (per the corrected selection rule): a targeted sub-test at the two harder offsets (100°, 180°), 4 development + 4 fresh confirmation seeds, comparing current `sector-consequences` text against the variant adding `new_never_inspected_heading_deg` per option and a `never_inspected_heading_reachable_by_yaw` flag, exactly as F75 proposed.

**No-Jev gates:** `reference`, `passive`, `constant` (best fixed non-hold search action from L0), `sweep`, and the fixed-observer counterfactual. Baselines are run at confirmation seeds on the two harder offsets (100°, 180°) as a stated economy; behaviour at 60°/140° is assumed similar and flagged as an assumption, not independently checked at full density.

**Mode-switch specification (stated here, not deferred to the engine, since it decides pass/fail):** the encoder switches from `search` to `track` the first decision cycle after a bound target's observation is delivered; it switches back to `search` after the target has been continuously unobserved (or unbound) for longer than a **hysteresis threshold set above the 95th-percentile consecutive-dropout run measured in L0's detection-envelope sweep** (so ordinary sensor flicker never trips a spurious mode switch). On ambiguous identity (more than one candidate matching the goal), the encoder stays in `track` mode with the L7-style candidate question active rather than reverting to `search`. `unknown` clearance/range/bearing renders as the literal string `"unknown"` in every consequence field it affects, never a numeric placeholder.

## L8 — Long distance: acquire far, then approach to D

**Re-specified after design review.** The first draft held range at long distance to ±0.5 m while stereo error there is ±1.1 m at 20 m — an unreachable and dishonest criterion. L8 now asks Jev to **start far, acquire a confident observation, and close to D₀**, scoring the approach, not a long-range hold.

**Scene and fixture:** `nominal-range` family extended to the L0 sweep's confirmed reliable long-range band (not assumed 40 m).

**Start condition:** target already discovered (bound), at the far edge of the confirmed band, roughly centred (bearing is a precondition here, not a scored axis).

**What Jev controls / encoding:** the speed-hold menu. Beyond a confidence threshold (declared: range error estimate > the tolerance itself), consequences render **honestly as unknown** rather than a numeric guess — *"range beyond confident measurement; consequence assumes closing at the chosen speed for H with unmeasured uncertainty"* — motivating a conservative approach rather than a precise one at long range, exactly the review's "honest unknown-range consequences" instruction.

**Goal sentence:** *"A {colour} {class} is visible far away. Approach it until you are at D₀ metres (slant range), tolerance ±1 m, within {a stated time bound derived from the confirmed envelope's minimum closing speed and the starting range}, without exiting [bounds]."*

**No-Jev gates:** `reference`, `passive` (structurally never reaches D₀), `constant`, `random`.

**Pass criteria / scores:** time-to-confident-range (first range reading inside the confidence threshold), time-to-D-band, the adapter's `unknown` rate and consecutive-dropout-run distribution over the approach (both already measured generically at L0, reused here on the actual approach trajectory).

**Discriminating test:** if `reference` cannot reach D₀ even with the L0-selected long-range option, the sweep's floor was set too loosely and must be tightened before any Jev call here — this rung should never be the first place a long-range sensing gap is discovered.

## L6 — Loss and reacquisition while following

**Purpose:** a target being followed (L4's competence) becomes physically occluded — does Jev recover, distinguishing genuine recovery from passive reappearance (F26).

**Scene and fixture:** occluder **resized** per § Rig-geometry qualification's rule (the existing `partial-occluder`, 0.55 m wide × 2.2 m tall, gives **no** occlusion from a 5 m altitude — at 5 m the sight line to a car 13 m away crosses the occluder plane at ≈2.8 m, above the occluder — this is a required fixture edit, verified against the geometry, not reused as-is). Two variants: **narrow** (sized so the target can re-enter view on its own path — passive reappearance is geometrically possible) and **wide** (sized so only an actual viewpoint change re-acquires it).

**No-Jev gates:** `reference`, `passive`, `constant`, fixed-observer counterfactual, **held-at-loss-pose counterfactual (both variants)**.

**Scoring, corrected per variant (finding 6):** the **narrow** variant uses a **non-inferiority test** — Jev's reacquisition time must not be worse than the held-at-loss-pose counterfactual's own reappearance time by more than 10%; it is *not* required to be strictly faster, because the target can and does reappear by itself there. The **wide** variant uses ordinary superiority (≥15 pp / ≥85% of `reference`), since the held-at-loss-pose counterfactual by construction never recovers there.

**Loss ceiling:** 2×X, X measured by the rig-geometry qualification's fixture-qualification step for the resized occluder.

**Discriminating test:** if Jev's reacquisition time is statistically indistinguishable from held-at-loss-pose's on the wide variant (where it should differ), the hypothesis is that the loss-handling/search-fallback logic, not sensing, is the open problem — checked by re-running the same episode with `search` mode's menu directly exposed at the moment of loss and comparing.

## L7 — Identity against a lookalike

**Purpose:** a second object matches the goal's class/colour — can Jev keep following the right one.

**Scene and fixture:** `occlusion-lookalike` family. **Corrected colour mechanism (finding 9):** `world.ts:134`'s hardcoded `'#1448bf'` colours only the physics/collider body used for the Rapier world representation, **not** the camera image. The actual rendered frame differentiates the target (renderer default `target_body_color` = **[0.025, 0.12, 0.8]**, `renderer.py:240`, since `world.ts`'s `scene_config` never overrides this key) from the lookalike (explicit **[0.08, 0.28, 0.75]**, `renderer.py:238-239`, sourced directly from `scene_config.lookalikes[].color` as `world.ts:118` sets it) — the render **is already wired** to the lookalike's own declared colour, and the two cars are **similar but distinguishable blues**, not identical. This still makes colour a genuinely hard (not impossible) identity cue, close enough that the detector's `dominantColor` field may not reliably separate them — exactly the intended difficulty, now correctly described.

**Start condition / variants:** (a) lookalike crossing the target's path while Jev follows (continuity under an ambiguous frame), (b) lookalike present at the moment of L6-style reacquisition (cold-start identity, no continuity to lean on).

**Identity question, corrected (finding 8):** **sequential**, not parallel with the follow questions — Jev first answers the identity question (candidate A/B/unresolved, given continuity facts: last-seen bearing/range and age **per candidate**, described physically, never as "which candidate the previous decision bound to," since that field would print Jev's own prior answer back to it) on its own decision cycle if ambiguity is newly detected; the follow menu (yaw/speed-hold) is then dispatched against the bound candidate on the next cycle. This avoids both L4's stated reason for rejecting parallel questions (no sibling-answer visibility) and the leaked-answer problem the review flagged.

**Goal sentence:** *"Follow the {colour} {class} at D₀ metres, tolerance ±1 m, keeping it horizontally within N₀ degrees of image centre. If more than one {colour} {class} is visible, follow only the one you were already following; if you cannot tell which one that is, say so rather than guessing."*

**No-Jev gates:** `reference`, `passive`, `constant`, fixed-observer counterfactual (variant b only).

**Scores:** wrong-target following time (≤10% ceiling, confident-wrong only), identity IoU.

**Discriminating test:** a high wrong-target time with a *confident* wrong answer is a genuine identity error; a high `unresolved` rate is correct caution that still costs following time — reported and gated separately, never collapsed into one number.

## L9-pre — Stationary target behind an occluder, search only (prerequisite for L9)

**Purpose:** L9 as originally drafted added discovery, obstacles, and translation all at once. This prerequisite isolates "search around one occluder, target not moving" before L9 adds a moving target, multiple obstacles and follow.

**Scene and fixture:** one resized occluder (§ L6), target stationary and hidden behind it at episode start.

**Goal sentence:** *"A {colour} {class} is somewhere in this area but not currently visible. Find it and keep it horizontally within N₀ degrees of image centre for at least 10 continuous seconds, within twice a systematic search's own time, without exiting [bounds]."*

**No-Jev gates:** `reference`, `passive`, `constant`, `sweep`, fixed-observer counterfactual.

**Gate:** ≥15 pp over the best of {`passive`, `sweep`}; per-family floor 0.75.

## L9 — Full mission: unseen at start, scout, then follow

**Purpose:** the owner's hardest test, verbatim: car not in sight at start, obstacle scene, scout then follow — the composition of every difficulty in L1–L8.

**Scene and fixture:** `jev-scout`/`jev-spatial` topologies (`scout-v1`, `screen-return-v1`, `offset-piers-v1`) rebuilt at car scale in the Round 3 3D scene, obstacles resized per § Rig-geometry qualification (height ≥ altitude + 2 m, width ≥0.5 m — a required engine fix, since Round 3's rendered buildings are visual-only, not physics colliders, `camera/renderer.py:224-231` vs `world.ts:137`). Target speed/turns inside L4's confirmed envelope.

**Structure, corrected (finding 3):** **no separate development/confirmation split at L9.** The five-round campaign's eight blocks (two turn-to-find, three obstacle/viewpoint, three recovery-course, ≥2 structurally distinct variants, F32) were already confirmation-quality fixtures; L9 runs them **once each**, at full seriousness, as the terminal integration test of an already-selected pipeline (L1–L8 already did every representation-selection decision). One of the eight blocks additionally substitutes a second object class (e.g. `{colour} person`, an engine-asset dependency flagged in L0) to check the goal sentence and search→track composition generalise, not just the car.

**Goal sentence:** *"A {colour} {class} is somewhere in this area but not currently visible. Find it, then follow it at D₀ metres (slant range), tolerance ±1 m, keeping it horizontally within N₀ degrees of image centre, for as much of the next {120–180 s, per block} as possible, without exiting [bounds] or contacting a surface."*

**No-Jev gates:** `reference`, `passive`, `constant`, `sweep`, fixed-observer counterfactual, held-at-loss-pose counterfactual (occlusion-course blocks).

**Pass criteria:** the F43-style primary rule, **with a range band replacing the apparent-width band — this substitution is the second review's own recommendation, not an owner instruction (corrected attribution)**: first delivered detection within a stated bound, ≥30 s post-acquisition observed, held in both central and range bands for a stated fraction, ≥2 s continuous, zero harmful events, no scored loss beyond L6's ceiling.

**Advancement:** ≥6/8 blocks individually clear their own gate; blocks are never pooled into one continuous score.

**Discriminating test:** L9 is expected to be uninformative on its own by design (it composes every earlier difficulty) — **L9 development is not run until L1–L8 (except L8, not required for L9) and L9-pre each independently advance.** If L9 fails after all prerequisites passed, the hypothesis is a composition/transition factor (the mode switch, or accumulated latency across a longer episode) — discriminated by re-running the specific search→track transition as a short isolated probe (reusing L5-pre's static machinery at the moment of binding) before revisiting anything already qualified.

## Wall-time and cost budget (from stated episode counts)

**Method:** simulated seconds = Σ(episode duration × episode count), across every Jev episode **and every no-Jev baseline episode** (baselines still consume render/physics time even though they cost no Jev tokens — the first draft undercounted this). Wall time = simulated seconds × [2.3, 4.4] (the coordinator-given measured render-bound multiplier). Overnight target: ≈10–12 h = 36,000–43,200 wall-seconds.

**Stated economies applied (traded away, listed explicitly):** no identical repeats anywhere — the simulator is deterministic, so a repeat adds negligible new information; **vary seeds instead**, which is what "development" and "confirmation" seed counts already do. Baselines run **3–4 policies per rung** (not every policy at every rung); the **exhaustive** every-constant-action sweep happens **once**, in L0's reference-ceiling sweep, not per rung. Baseline episodes reuse the **confirmation seeds only** (not development seeds — development seeds exist for arm selection, and the passive/reference margin check is a confirmation-split question). L5's baselines run at 2 of its 4 offsets (the two harder ones) at full density and are assumed representative at the other two — a stated, not hidden, shortcut. L9 runs once per block, no development/confirmation doubling.

| Stage | Jev episodes × duration | Baseline episodes × duration | Simulated seconds |
|---|---|---|---|
| L0 (clock/isolation/detection sweep/reference-ceiling sweep/rig qualification) | 0 (synthetic controller only) | — | ≈2,200 |
| L1 | 45 × 20 s | 60 × 20 s (3 cells × 4 policies × 5 seeds) | ≈2,100 |
| L2 | 24 × 20 s | 32 × 20 s (4 policies × 8 confirm seeds) | ≈1,120 |
| L3a | 12 × 30 s | 24 × 30 s | ≈1,080 |
| L3b | 24 × 30 s | 24 × 30 s | ≈1,440 |
| L4 | 12 × 90 s | 24 × 90 s (3 policies × 8) | ≈3,240 |
| L5-pre | negligible static renders | — | ≈300 |
| L5 (incl. variant sub-test) | 64 × 110 s | 64 × 110 s (2 offsets × 8 seeds × 4 policies) | ≈14,080 |
| L8 | 12 × 75 s | 24 × 75 s | ≈2,700 |
| L6 | 12 × 90 s | 24 × 90 s | ≈3,240 |
| L7 | 12 × 105 s | 24 × 105 s | ≈3,780 |
| L9-pre | 12 × 70 s | 32 × 70 s (4 policies × 8) | ≈3,080 |
| L9 | 8 × 150 s | 32 × 150 s (4 policies × 8 blocks) | ≈6,000 |
| **Total** | | | **≈44,360 s ≈ 12.3 h simulated** |

**Wall time at the stated multiplier:** 44,360 × 2.3 / 3600 ≈ **28.3 h**; 44,360 × 4.4 / 3600 ≈ **54.2 h**. **This does not fit one overnight run even at the optimistic multiplier**, and the honest answer is stated plainly rather than hidden by further loosening the design.

**Fit achieved via a two-night schedule plus concurrency (a lever already supported by the engine — F24's fix defaults new freezes to one world but allows explicit concurrency 1–3):**
- **Night 1 — L0 through L4** (component rungs, ≈9,780 s simulated: 2,200+2,100+1,120+1,080+1,440+3,240 ≈ wait, sum precisely: 2200+2100+1120+1080+1440+3240 = 11,180 s). At single-threaded 4.4×: 11,180×4.4/3600 ≈ **13.7 h** — slightly over; with **concurrency-2**: ≈6.8 h, comfortable even at the pessimistic multiplier.
- **Night 2 — L5-pre through L9** (search/loss/identity/long-range/mission, ≈33,180 s simulated). With **concurrency-3**: at 2.3× ≈33,180×2.3/3600/3 ≈ **7.1 h** (fits); at 4.4× ≈33,180×4.4/3600/3 ≈ **13.5 h** (slightly over). **If the pessimistic multiplier applies, defer L9 (≈6,000 s, ≈2.0 h at concurrency-3/4.4×) to a short third session** — everything through L7/L9-pre still completes overnight.

**This is the honest budget: the full ladder needs two overnight sessions with concurrency-3 on the second, and possibly a short third session for L9 alone if the pessimistic (4.4×) multiplier turns out to apply.** Dollars remain trivial throughout (§ below); render time, not cost, is what was budgeted against.

**Reported input-token cost** (unchanged method, Jev-episode calls only): ≈2 decisions/s × Σ Jev-episode durations ≈2×(45×20+24×20+12×30+24×30+12×90+64×110+12×75+12×90+12×105+12×70+8×150) — Jev-only simulated seconds ≈ 900+480+360+720+1080+7040+900+1080+1260+840+1200 = 15,860 s → ≈31,700 calls × 1,600–3,000 tokens ≈50.7M–95.1M tokens → **≈$2.13–$3.99** at $0.042/M. Cost remains a rounding error next to the render-time budget above.

## Review record: what the second review's arithmetic and file:line claims checked out on, and what did not

Every claim below was independently recomputed or re-read from source in this pass, not merely re-stated from the review.

**Verified exactly:** the servo control law at `src/models/mobile.ts` (`desired = target ? cap(scale(sub(target,position),1.8), maxSpeed) : ...`, confirming the fixed-distance menu's kinematic ceiling mechanism, though the precise 2.4 m/s figure is the review's own simplified first-order approximation of a two-stage force/velocity system, not independently re-derived to the same precision here); `live-adapter.ts:39`'s `camera.fixedPitchDeg !== 0` pitch refusal; `live-adapter.ts:36,41`'s clip/edge-touching `unknown` returns; the vertical-FOV/nearest-ground/disparity-error trigonometry for the 5 m/−18° rig (43.0° VFOV, 6.07 m nearest ground, ±0.18/0.27/0.39 m disparity error at 8/10/12 m — all recomputed from confirmed inputs, matching the review); `TARGET_CAR_DIMENSIONS = [4.5, 2.24, 1.227]` m (`world.ts:55`); that only `moving-target-ego`'s script moves the car (`nominal-range` and `wall-pole` move the *drone*; `occlusion-lookalike` moves neither script's target) and that `nominal-range`'s actual start bearing offset is ≈1° (recomputed from `dronePosition`/target jitter), not 10–30°; the lookalike-colour mechanism (`renderer.py:238-241`: target defaults to `[0.025,0.12,0.8]`, lookalike explicitly `[0.08,0.28,0.75]` from `scene_config.lookalikes[].color` — `world.ts:134`'s hardcoded hex colours only the physics body, not the rendered image); F70's 61/100 figure is the nominal-range route specifically, with 84/100 and 94/100 on other confirmation routes (`docs/jev-round3-results.md`'s table); the quiet-machine measurement-attempt sequence (contention refusal at 23:36:15 local, GPU util 20–22%/17–18 W — the quiet-run signature, not a still-running game; three 0-byte relative-path timeouts in `measurements/` at 23:42:56/23:44:57/23:46:58, ≈120 s apart, plus one more in `measurements-bash/` at 23:50:05; successful absolute-path run producing `measurements-quiet/` at 23:53–23:54) — all timestamps independently re-read from file metadata; PID 2576 = `dwm.exe`, per the coordinator's confirmed `Get-Process` check (not independently re-verified by this pass, attributed to the coordinator, not asserted as directly checked here); the tiled-detection latency-floor failure (3×27.5 ≈82 ms > the 71 ms floor, both figures from the already-verified quiet-machine detect-stage timing).

**Not independently re-verified to the same precision** (the review states these as its own estimates, not measured, and this pass did not re-run them): the reference-controller Monte Carlo table (92%/73%/13%/78%/etc. time-in-band by speed and band width) and the range-rate/bearing-rate noise-figure estimates (σ≈0.2–0.5 m/s, σ≈0.6–0.7°/s) — both are explicitly labelled by the review as illustrative arithmetic, not an engine result, and are used here only for their qualitative direction (fixed-distance menu fails at speed; a tighter band lowers reference performance sharply), consistent with how the review itself labels them.

**Corrected in this pass (see inline fixes throughout, and in F77/F78/the priorities table in `design-failures.md`):** the lookalike-colour claim (mechanism, not just outcome); the "61/100 overall" generalisation; the L4/L7 question-structure claims (joint 35-tuple → two parallel questions; parallel identity → sequential, non-leaking); the L8 long-range-hold criterion → acquire-then-approach; every rung's placeholder parameters (N, D, T2, margins, ceilings, floors) → the frozen parameter table; the clock-gate wall-paced framing → simulated-time properties; the wall-time estimate → the two-night, concurrency-adjusted budget above; F76's "under half the period" arithmetic error (141.5 ms is *not* under 100 ms, half of the 200 ms 5 Hz period — corrected in `design-failures.md`'s F76 addendum to state the figure without the false comparison); F78's counterfactual-requirement overstatement (L7 needs only the fixed-observer counterfactual, not both) and its misattribution of the range-band substitution to "the owner's instruction" (it is the design review's own recommendation) — both corrected in `design-failures.md`; the `jev-spatial-premise-and-next-tests.md:223` citation, now `:225` after this document's own earlier insertions shifted it; every "what failure would tell us" line rephrased as a hypothesis with a stated discriminating test rather than a pre-assigned single cause.
