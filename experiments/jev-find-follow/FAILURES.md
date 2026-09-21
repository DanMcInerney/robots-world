# Find-and-follow engine: integration failures and fixes

Concrete problems hit while building and running the closed-loop episode engine
(`experiments/jev-find-follow/`) against the real renderer and real GPU sensor, in the order
discovered. The coordinator will lift these into `docs/design-failures.md`.

## F-FF-1: the assignment's renderer venv path hint points at the wrong environment

**Observed:** the workspace note's "renderer/perception venv
`.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe`" is a real, working Python
environment, but it does not have `trimesh`/`pyrender`/`DracoPy` installed. Running
`renderer.py --jsonl` under it fails immediately with `ModuleNotFoundError: No module named
'trimesh'`.

**Cause:** that venv is the Round 3 STEREO PERCEPTION comparison environment
(`.runtime/experiments/jev-round3-v1/perception/`), a sibling of, not the same as, the renderer's
own environment.

**Fix:** the renderer's actual dependencies live at
`.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe` (documented in
`experiments/jev-round3/camera/README.md`, which I had not read before the first attempt). Verified
end to end with a real render call (`renderer-client.ts`'s smoke run and
`test/jev-find-follow-real-integration.test.ts`). `run.ts`'s default `--renderer-python` now points
here, with a code comment explaining the mix-up.

## F-FF-2: `evaluator: true` by default would have leaked truth beside controller-visible frames

**Not a bug I hit, but a structural risk an independent design review flagged before I ran
anything real:** `renderer.py`'s `render()` defaults `evaluator=True`; in on-demand use with
`out_dir` set, that would write true depth/masks/`truth.json` into the same directory the sensor
reads RGB from. **Fix:** `renderer-client.ts` sends `evaluator: false` on every request (see its
module docstring). Verified by test: `test/jev-find-follow-real-integration.test.ts`'s first test
asserts the returned `outDir` never contains an `evaluator/` subdirectory, confirmed against a real
renderer run.

## F-FF-3: latest-wins acquisition scheduling was anchored to the wrong simulated instant

**Observed (caught by unit tests before any real run):** `planNextAcquisition`'s first
implementation searched for the next camera-period boundary AT OR AFTER the caller's own full
decision-application time, not after the LAST acquisition. Since one full decision cycle
(acquire→perceive→dispatch→return→apply) always finishes well after the acquisition's own busy
window closes, skip counting was structurally dead code — the engine could never observe
latest-wins skipping in practice, contradicting the quiet-machine's own measured ~3% skip rate at
10 Hz.

**Fix:** the scheduler now tracks the last acquisition's own simulated time separately
(`lastAcquiredSimMs` in `episode.ts`) and searches strictly after it (`periodBoundaryStrictlyAfter`
in `scheduler.ts`), matching the camera's own fixed-rate schedule, independent of decision-cycle
length. Also fixed: `advanceToSimMs` originally required tick-exact alignment and threw on a
fractional target; since `250 ms` (the declared synthetic/reference controller latency) is not a
multiple of the `20 ms` physics tick, this made a real cycle-composition test fail immediately.
Changed to round UP to the next tick (never covers less than the requested span) instead of
throwing.

## F-FF-4: a combined track command kept yawing for the whole lease, not just its declared degrees (the big one — found via a real closed-loop run, not a static probe)

**Observed:** on `visible-track`/`reference`, simply RAISING the yaw rate (to fix a *different*,
correctly-diagnosed issue — see below) made tracking measurably WORSE, not better:
`framedFraction` fell from 0.157 to 0.056 and median range error rose from 1.83 m to 11.48 m. That
is the signature of overshoot getting worse as speed increases, not of insufficient turn rate.

**Root cause:** `planTrackManeuver` (the track-mode composer of one simultaneous yaw+range
`velocity` command) set `validForMs` unconditionally to the FULL decision lease (1500 ms), unlike
its single-axis sibling `planManeuver` (used by search), which correctly caps a yaw command's
lease to the exact time needed for its own declared degrees. A combined command therefore kept
applying its yaw rate for up to ~1 s after a 10–60° turn had already completed, continuing to
rotate until the next decision superseded it (up to another ~505 ms later) — a real, measured
overshoot, not a hypothetical one.

**Fix:** `planTrackManeuver` now caps `validForMs` to the chosen yaw's own completion time exactly
as `planManeuver` does, whenever a non-hold yaw is chosen (a `hold` yaw keeps the full lease, since
there is no rotation to overshoot). Regression test:
`test/jev-find-follow-maneuver.test.ts`'s two new cases assert this explicitly. Also raised
`YAW_RATE_DEG_S` from 60 to 120 deg/s (a real fix, not incidental to the bug above): at 60 deg/s the
menu's largest track option (60°) needed 1000 ms to complete against a 505 ms decision period, so
even a CORRECTLY-capped command would routinely get pre-empted mid-turn; 120 deg/s lets the largest
track-menu option finish within one decision period (60/120 = 500 ms < 505 ms). Search's `turn_180`
can still span multiple decision cycles at either rate — left as-is deliberately, since search is
iterative by design (sector memory persists across cycles) unlike track's "keep it centred now".

**Before/after, `visible-track`/`reference` (same seed, same 90 decisions):**

| | boundFraction | framedFraction | range error (median abs) | longest loss |
|---|---|---|---|---|
| 60°/s, uncapped lease (original bug) | 0.617 | 0.157 | 1.83 m | 2.53 s |
| 120°/s, uncapped lease (bug + faster rate = worse) | 0.314 | 0.056 | 11.48 m | 6.06 s |
| 120°/s, capped lease (fixed) | 0.483 | 0.393 | 3.44 m | 4.04 s |

The middle row is retained here as direct evidence of the bug, not discarded — it is what first
proved the cap was missing, not merely a slower run.

## F-FF-5: request starts were paced ≥505 ms apart in wall time only, not simulated time

**Found from an independent design review, before any real run used it:** the engine's real-wall
pacing (`pacingWaitMs`) is necessary for a real Jev deployment (API rate limits) but does not by
itself guarantee decisions are ≥505 ms apart in SIMULATED time — if a scenario's camera/decision
period were configured below the pacing floor, dispatches could be closer together in sim time
than the floor implies, even while wall time correctly waits.

**Fix:** `episode.ts` now derives the acquisition-scheduling period as
`Math.max(config.cameraPeriodMs, config.pacingFloorMs)` (`decisionPeriodMs`), so decisions are
≥pacingFloorMs apart in BOTH clocks by construction, regardless of the configured camera period.
`run.ts`'s CLI default was also bumped from 500 ms to 505 ms for the same reason (belt-and-braces;
the internal `max()` enforces it either way).

## F-FF-6 (open, not fully root-caused): `turn-to-find`/`reference` finds the car quickly, then loses it for the rest of the episode

**Observed:** reference's `turn_180`→`yaw_left_60` search sequence found the car at simulated
t≈2.02 s (vs. passive's never) — a real, large improvement — but bound the target for only ONE
decision before losing it again, and never reacquired for the remaining ~58 s. The own-state
heading log between the acquiring decision and the next one changed by ~38° more than the chosen
maneuver (`yaw_right_10`, a small correction) alone would predict.

**What I checked:** the F-FF-4 fix (validForMs capping) is already applied and covered by
regression tests; `planManeuver`'s search-mode yaw commands are independently capped the same way;
`World`'s own `stop()` zeroes BOTH linear and angular velocity on expiry
(`src/physics/rapier.ts`'s `velocity(id, linear, angular = vec())` defaults angular to zero, so a
job's `plant.stop()` calling `physics.velocity(root, vec())` does clear yaw rate, not just
forward speed — I verified this directly rather than assuming it). None of these rule out a residual
interaction between the immediately-preceding search yaw command (still completing when the
FOLLOWING decision's own acquisition and command are computed) and the track-mode command that
supersedes it right at the search→track mode boundary.

**Status:** reported as a genuine, unresolved finding rather than a guessed fix — the mode-boundary
timing (a decision acquiring WHILE the previous decision's own maneuver is still mid-flight, which
can happen because acquisition search now runs on its own fixed-rate schedule, F-FF-3) is the most
likely remaining source and the concrete next thing to instrument (log the physically-realized
heading at every physics tick around a mode transition, not just at each decision's own
acquisition). Left open rather than patched under time pressure with an unverified fix.

## F-FF-7: two different Python environments must be mixed for the sensor, and getting this wrong silently uses stale code

Not a bug exactly, but worth recording plainly: the sensor's on-demand mode (`--on-demand`, added
by this assignment) only exists in THIS worktree's `experiments/jev-library/sensor/`. Running it
against the pinned detector venv's own copy of `experiments/jev-library` (the main checkout's,
unmodified) would silently fall back to argparse rejecting `--on-demand` as an unknown flag, or
worse, run without the fix. `sensor-client.ts`/`run.ts` therefore always set `--sensor-cwd` to THIS
worktree's `experiments/jev-library` (so the on-demand code that actually runs is the one this
assignment added) while `--checkpoint`/`--detector-runtime-root` still point at the main checkout's
`.runtime` (the actual weights; this worktree's own `.runtime` is empty by design). Verified by
`test/jev-find-follow-real-integration.test.ts`'s sensor-client test, which checks
`hello.clock.acquiredClock === 'engine-simulated-ms'` — a field that only exists in this worktree's
modified `records.py`.

## Unit E2: independent review (`engine-review-e1.md`) findings and fixes

An independent review of the engine delivered in unit 1 found it "not acceptable as a ladder base"
— nine numbered findings (five loop defects plus scoring/determinism/wording problems). Each is
listed below with what was actually wrong, the fix, and the regression test proving it.

### Finding 1 — events never acknowledged, robot faults after ~64 commands

**Observed (the review's repro):** first rejection at command 65, simulated t=32740ms; 25/90
decisions in a saved run were dead (every command after the fault rejected). `src/world.ts`'s
`MAX_EVENTS=128` cap sets `robot.fault` once unread events reach it; `episode.ts` never called
`port.observe()`/`port.acknowledge()`, so events (one `job.cancelled` + one `job.<status>` per
admitted command) accumulated forever.

**Fix:** `episode.ts` now calls `port.observe()` then `port.acknowledge(lastEventId)` once per
decision cycle (before building that decision's request), every cycle, unconditionally. Any
`rejected` receipt is recorded on the decision (`unexpectedRejection`) and surfaced in
`scoring.ts`'s new `score.validity` (hard-wired: `pass.decided` is false whenever
`validity.valid` is false, regardless of what the scenario's PassCriteria otherwise says — a
declared executor veto never reaches `port.command()` with the risky action, so it can never
produce this kind of rejection). `observedFault` is recorded too, even though `acknowledge()`
clears it, so the report shows a fault ever having occurred.

**Regression test:** `test/jev-find-follow-loop.test.ts`'s "events are acknowledged every cycle, so
>100 decisions never trip the 128-event backlog fault" — drives >100 real decisions against a fake
renderer/sensor + the real world bridge and asserts zero rejections. Verified to FAIL on pre-repair
code by temporarily removing the observe/acknowledge call and re-running: the test failed with
`decisions.length === 75` and (before the length assertion could even be reached in a longer run)
would show `unexpectedRejectionCount > 0`.

### Finding 2 — consequences assumed an at-rest drone; yaw quantisation

**Observed:** `yaw_left_60` applied at simulated t=1925ms; heading at the 2020ms acquisition was
already 9.6° (the PREVIOUS maneuver still completing) when the request assumed 0°; final heading
reached 48.0° against a predicted -0.4° (F-FF-6's "48° unmodelled yaw", now root-caused). Separately,
`yaw_10` executed 12° instead of 10° (rounding a command's own expiry UP to the next 20ms tick
quantised the executed angle).

**Fix (two parts):**
- Quantisation: `YAW_RATE_DEG_S` raised 120→250°/s so every currently offered yaw magnitude
  ({10,30,60,90,180}, all multiples of 5) lands on an exact 20ms tick boundary (250°/s × 20ms =
  5°/tick). Regression: `test/jev-find-follow-world-bridge.test.ts`'s "every offered yaw menu
  magnitude executes its declared degrees on the real physics, within 0.5deg" — loops every
  `DEFAULT_MENU` yaw option through the REAL world bridge and physics.
- Predicted-state consequences: `camera-geometry.ts` gained `worldPositionFromBearing`/
  `bearingAndRangeFromWorldPosition` (a world-position round trip generalising the existing
  yaw-only `reprojectBearingAfterYaw` to also handle translation). `episode.ts`'s new
  `computeTrackBaseline()` advances the REAL world to the decision's PREDICTED application time
  (using the scheduler's declared controller latency, the only value knowable before dispatch)
  BEFORE building the request, then reprojects the freshest acquisition's measured bearing/range
  onto that predicted pose — so every per-option consequence the encoder renders is computed from
  where the drone will actually be, pending in-flight yaw/translation, not an at-rest assumption.
  `DecisionRecord` gained `acquisitionPose`/`predictedApplicationPose` so a reviewer can see both.

**Regression tests:** `test/jev-find-follow-camera-geometry.test.ts` (10 new tests: same-pose and
predicted-pose round trips with both yaw and translation); `test/jev-find-follow-loop.test.ts`'s
"every decision records an acquisition pose, a predicted-application pose, and a bound evidence
source" (proves the plumbing runs on real data, not just compiles).

### Finding 3 — acquisition coupled 1:1 to decision cadence; controller latency >345ms threw

**Observed:** the camera only acquired once per decision, on a period forced to
`max(cameraPeriodMs, pacingFloorMs)` — the declared 5Hz/10Hz camera rate was never actually
exercised end to end; a controller latency above ~345ms could make `advanceToSimMs` receive a
target already behind `world.simMs`, throwing "Cannot advance to a past simulated time."

**Fix:** `episode.ts`'s loop is now two decoupled phases. An inner acquisition loop
(`performAcquisition()`) runs on the camera's OWN `cameraPeriodMs` grid via the existing
`planNextAcquisition` (latest-wins skipping, real skip counts) — every acquisition updates ALL
derived state (binder, world-frame last-seen, sector memory + clearance, rate-estimate history,
appearance events, saved sensor objects) regardless of whether a decision follows. A decision
dispatches once `scheduler.ts`'s new `readyToDispatch`/`nextDispatchSimMs` (a SIMULATED-time
pacing floor, not only the existing real-wall `pacingWaitMs`) says the freshest observation has
caught up; it always uses the FRESHEST acquisition, not necessarily the one that just triggered the
gate. Controller latency is now always survivable: a controller may declare
`realLatencyClampMs: [min, max]` (generalising the real Jev controller's own existing
`clampJevLatencyMs` pattern) to have its SIMULATED latency taken from its REAL measured wall time,
clamped into that range; exceeding the max sets `controllerLatencyTimedOut` on the decision (a
logged timeout, never a throw) instead of an unbounded value. The predicted-vs-actual application
time is reconciled via `Math.max(predictedAppliedSimMs, actualAppliedSimMs)` with an extra
`advanceToSimMs` only when the actual time is later — never backward, never throws.

**Regression tests:** `test/jev-find-follow-loop.test.ts`: (a) "a slow controller (450-900ms real
latency) completes an episode without throwing, and latest-wins skips are nonzero once perception
is slower than the camera period"; (b) "acquisitions outnumber decisions once the camera period is
faster than the simulated pacing floor" (asserts `evaluatorOnly.frames.length >
decisions.length * 2` and at least one decision with `acquisitionsThisCycle > 1`).
`test/jev-find-follow-scheduler.test.ts` gained direct unit tests for `nextDispatchSimMs`/
`readyToDispatch`.

### Finding 4 — `bearingDeg` producer/consumer mismatch (camera-relative vs world heading)

**Observed:** the root cause of `turn-to-find` never reacquiring after its one lucky sighting: the
last-seen record stored the raw camera-relative `bearingRightRad` and consumers (search.ts, the
reference controller) read it as an absolute world heading — harmless only by coincidence when own
heading happened not to have changed since the sighting.

**Fix:** `camera-geometry.ts` gained `worldBearingDeg(ownHeadingDeg, bearingRightRad)` (=
`wrap(ownHeading - bearingRight)`, matching `evaluator.ts`'s own established convention) and its
inverse `cameraRelativeBearingRad`. `episode.ts` now stores `lastSeen.bearingDeg` via
`worldBearingDeg()` at the ACQUISITION instant, and `LastSeenRecord` gained
`ownPositionAtSightingM` (a declared, own-state-derived — never simulator-exact — position) so a
later decision can reproject the sighting through the full world-position round trip, exactly like
a fresh bind. `encoders/search.ts` gained a PER-OPTION `last_seen_offset_deg`/`last_seen_age_ms`
field (the code-computed offset between that option's resulting heading and the sighting's own
world bearing) so no consumer ever has to subtract two separately-rendered fields itself;
`controllers/reference.ts` updated to read it directly.

**Regression tests:** `test/jev-find-follow-camera-geometry.test.ts` (own heading -170.6°, bearing
9.6° right → world bearing ~180°, not near 0 — the review's own numbers).
`test/jev-find-follow-controllers.test.ts`'s new "reference controller turns toward the last-seen
sighting's WORLD bearing, not its stale camera-relative value, once own heading has since changed"
— own heading rotated 90° since the sighting, the only way to actually distinguish old
(camera-relative-misread) from new (correct) behaviour; the PRE-EXISTING test with the same name
prefix never could, because it happened to use the same heading at both times (a coincidence that
hid the bug, now flagged in a comment there).

### Finding 5 — search dead-ends; clearance never measured; sector memory used exact position

**Observed:** `deriveClearance` didn't exist; `episode.ts` always passed `null` clearance into
sector memory, so search's "move only along a direction with measured OPEN clearance" policy
clause could never be satisfied. The 60s re-scan horizon let one missed detection "park" the search
policy for 41s. Sector invalidation used `world.droneBody().pose.position` — exact simulator
truth, never available to a real drone.

**Fix:** `sector-memory.ts` gained `deriveClearance(objects, moveDistanceM)` (nearest valid
stereo-derived surface range among every detected object in view, any class; explicit `unknown`
when nothing has a valid range — never guessed open), now wired into `episode.ts`'s
`updateSectorMemory` call on EVERY acquisition. `DEFAULT_SECTOR_MEMORY_CONFIG.invalidateAfterMs`
shortened 60s→12s. Sector invalidation now uses `ownWorldPosition()` (own-state-derived, declared
NOISY position — `droneInitialPosition + odometryDisplacementM`) instead of exact simulator truth.
Increment B4 (dwell before leaving track): a track-mode miss with no fresh bind no longer collapses
to a forced hold — `computeTrackBaseline()`'s last-seen branch feeds the SAME encoder path a fresh
bind uses (labelled `evidenceSource: 'last-seen'`), so the controller answers normally against
last-seen-derived consequences instead of being railroaded into holding.

**Regression tests:** `test/jev-find-follow-sector-memory.test.ts` (5 new `deriveClearance` tests;
the short-horizon assertion). `test/jev-find-follow-loop.test.ts` exercises the full path via the
real world bridge + fakes.

### Finding 6 — determinism claims unverified; car stepped per acquisition, not per tick

**Observed:** the scripted car's kinematic velocity was only recomputed once per acquisition
(`world.updateCarScript()`, called from the old episode loop), not per physics tick — for a
continuously time-varying script (`gentle-curve`'s cosine lateral velocity), the car actually moved
at a single acquisition-stale velocity sample across every intervening tick. No determinism claim
had actually been measured.

**Fix:** `world-bridge.ts`'s `advance(ticks)` now recomputes and reapplies the script's velocity
before EVERY individual 20ms tick (looping `world.advance(1)` internally), not once per call —
`updateCarScript()` stays public (existing tests call it directly) but is now redundant with what
`advance()` already does. `renderer-client.ts` spawns the renderer with a fixed
`PYTHONHASHSEED=0`. A dedicated determinism check
(`test/jev-find-follow-determinism.test.ts`, GPU-gated, skips cleanly without the pinned
environment) launches the renderer 15 times as genuinely FRESH PROCESSES with the identical
request and hashes the output images.

**Measured result (2026-09-21, this machine, seed 4242): `left.png` was byte-identical across all
15 process starts. `right.png` was NOT: 2 distinct hashes among 15.** Root cause not fully
identified — scene construction is fully seeded (`renderer.py`'s own `np.random.default_rng(seed)`
for ground/building textures, verified by reading the source; confirmed independent of
`PYTHONHASHSEED`), so the variance is downstream of scene setup, inside pyrender/OpenGL's own
rendering of the SECOND (right) stereo camera specifically — not chased further within this unit's
scope (renderer.py's internal rendering pipeline, not an additive request-field change the granted
permission covers). This is a genuine, quantified, unresolved gap, not silently ignored: the test
holds `left.png` to the achieved bar (byte-identical, a real regression guard) and only quantifies
`right.png`'s variance (fails only on a materially worse regression than the measured 2/15
baseline). **Correction to this file's own prior wording:** earlier revisions of this document did
not make a determinism claim for the renderer at all; none is made now either beyond what is
measured above.

`test/jev-find-follow-loop.test.ts`'s "the same episode (seed, controller, fakes) run twice gives
identical decisions" covers the CPU-only slice (scheduling/physics/encoding determinism) end to end
and passes exactly.

### Finding 7 — scoring used sensor-delivered data over decision cadence only, not evaluator truth over all samples

**Observed:** `boundFraction`/`framedFraction`/`rangeErrorM` were computed only from the subset of
acquisitions that became decisions (now a small fraction of all acquisitions, once acquisition
decouples from decision cadence — finding 3), and only from the SENSOR's delivered bearing/range,
never independently checked against evaluator truth over every acquisition.

**Fix:** `scoring.ts` gained `score.truth` (`centredFraction`, `inRangeBandFraction`, `rangeErrorM`)
computed from `evaluator.ts`'s analytic ground truth over EVERY entry in
`evaluatorByAcquiredSimMs` — which now holds one entry per acquisition, not per decision — from a
declared `settlingPeriodMs`. Kept structurally separate from the existing sensor/binder-based
`detectedFraction`/`boundFraction`/`framedFraction`/`rangeErrorM` (so a reviewer can tell a
perception/binder failure apart from a genuine positioning failure) rather than replacing them.
`PassCriteria` gained optional `minTruthCentredFraction`/`minTruthInRangeBandFraction`/
`settlingPeriodMs` (both smoke scenarios now set these — see scenarios.ts). `report.ts` gained
`sensorObjectsByAcquiredSimMs` (every delivered observation's sensor objects, keyed by acquisition
time) so a reviewer can separate perception from binder/scoring causes without a GPU re-run.
Un-passable-by-naive-baselines: see the acceptance-run table below (passive/constant/seeded-random
measured against the SAME truth-based pass rules reference must clear).

**Regression tests:** `test/jev-find-follow-scoring.test.ts` (existing tests updated for the new
required `DecisionRecord` fields; the truth-based fields are additive, so prior assertions still
hold). The un-passable-by-baselines claim is checked directly against real evidence in the
acceptance-run table, not simulated.

### Finding 8 — latency tool: `nvidia-smi` withholds the process name, `dwm.exe` unrecognised

**Observed (the review's repro):** a non-elevated `nvidia-smi --query-compute-apps` entry for
`dwm.exe` (PID 2576) with the process name blank/"N/A" — `isKnownSystemCompositor`'s substring
match against the name then silently fails, so a perfectly idle GPU with no foreign workload reads
as contended purely from the Windows compositor.

**Fix:** `measure-stereo-objects-latency.ts` gained `resolveComputeAppEntryName`/
`resolveProcessNameByPid` (Windows `tasklist` PID→name lookup), applied to every compute-app entry
BEFORE it reaches the compositor check.

**Regression test:** `test/measure-stereo-objects-latency.test.ts`'s new tests reproduce the
review's exact repro (`"2576, "` and `"2576, N/A"` both resolve to `"2576, dwm.exe"`, which
`isKnownSystemCompositor` then recognises; the pre-repair `"2576, "` string on its own does NOT
match, preserved as the regression baseline).

### Finding 9 — wording, viewer, dead code, injectable seams

**Fixed:** `encoders/mode.ts`'s `ambiguous` bind previously reverted to `search`; the ladder's own
mode-switch spec (`docs/jev-find-follow-ladder.md` § L5) says ambiguous identity stays in `track`.
Regression: `test/jev-find-follow-encoders.test.ts`'s `determineMode` test (was asserting `search`,
now asserts `track`, with a comment explaining this regresses on pre-repair code). `EvaluatorSink`
(evaluator.ts) removed — confirmed dead code by grep (only its own dedicated test referenced it;
`episode.ts` has always kept its own plain `Map` instead); its test removed with it.
`episode.ts` gained injectable `EpisodeDeps` (`createWorld`/`createRenderer`/`createSensor`
factories, defaulting to the real bridges), used by every test in
`test/jev-find-follow-loop.test.ts` to drive the real CPU-only world bridge against fake
renderer/sensor clients — no GPU needed for loop-level coverage of findings 1-5.

**Not yet done this pass (declared gap, not silently dropped):** the viewer (`jev-find-follow.html`)
overlay/projection-formula fix, the "ALL options shown with probabilities" viewer requirement, and
an end-to-end wording audit ("the the", degree rounding/wrapping in every rendered field) were not
reached within this unit's time budget. See WORKLOG.md's checklist.

## Increment B: a previously-undiscovered range-axis analogue of F-FF-4

While building B3's consequence-fidelity check, found that `planTrackManeuver`'s fixed-distance
range options (`approach_1m`/`approach_2m`/etc.) all composed with the SAME constant
`TRANSLATE_SPEED_MPS` regardless of their own `distanceM`, and ran for the FULL decision lease
(unlike yaw, which F-FF-4 already capped to its own completion time) — so `approach_1m` and
`approach_2m` were behaviourally IDENTICAL in actual execution, and neither reliably executed
anywhere near its printed magnitude within one decision cycle. This is exactly what B3's "must be
TRUE (execute the printed displacement ... or print what's actually executed)" anticipates.
**Fix:** `validForMs` is now ALSO capped to the chosen range option's own declared
`distanceM / TRANSLATE_SPEED_MPS`, mirroring the yaw cap exactly (speed-hold is untouched — held
under lease until superseded, per the ladder's own wording, since its declared outcome is a rate,
not a fixed step). **Regression tests:**
`test/jev-find-follow-maneuver.test.ts` (three tests: the corrected hold-yaw-range-only case,
hold+hold still uses the full lease, and `approach_2m` now runs measurably longer than
`approach_1m`). **Acceptance-grade verification:**
`test/jev-find-follow-loop.test.ts`'s "consequence fidelity on a stationary target: fixed-distance
range execution is within 0.25m of its printed 2m magnitude" — real Rapier physics, a stationary
target, isolates the range axis (yaw held) and measures the REALISED range delta (from evaluator
truth) against the printed magnitude across several consecutive decisions.

## Unit E3: independent review (`engine-review-e2.md`) findings and fixes

A second independent review found the engine "acceptable as the ladder base after listed repairs"
but flagged three severe structural defects the two smoke scenarios never exercised. Each repair
(A1-A8) below, plus one real bug found only via real-GPU measurement during this unit's own
acceptance work (not from the review).

### A1 — prediction was done by moving the real world, not acquiring on the camera's own grid

**Observed:** `computeTrackBaseline()` (E2) advanced the REAL Rapier world to the decision's
predicted application time before building the request, then reprojected onto that moved world —
conflating "what the request should assume will be true" (a prediction) with "what actually
happened" (only `advanceRealWorld` may produce that). The camera also only ever acquired once per
decision in practice, never filling a slow controller's own wait with real intervening frames.

**Fix:** `episode.ts`'s `advanceRealWorld(targetSimMs)` is now the ONLY function that may advance
the real world (it also stops at a due `pendingFollowUp` first, so a follow-up switch-over is never
skipped by a larger jump). Predicted-application-pose consequences now come from a pure, analytical
`predictPoseAt(pending, targetSimMs)` over the in-flight command's own piecewise-constant velocity
segments (`PendingKinematics`/`segmentsForCommand`) — it never touches the world. The controller call
(`options.controller.answer(...)`) now runs CONCURRENTLY with continued acquisition
(`while (!controllerDone) { ... await performAcquisition() ... }`), so a slow controller genuinely
yields real frames during its own wait instead of the loop sitting idle.

**Regression tests:** `test/jev-find-follow-loop.test.ts` (`acquisitionsThisCycle > 1` under a
450-900ms fake-slow controller; acquisitions-outnumber-decisions test). Real-GPU wall/sim-second
re-measured at true 5Hz (camera-period-ms 200): see the corrected smoke table below.

### A2 — a bug found only via real-GPU measurement: speed-hold gated on the wrong duration field

**Observed:** after landing A1/A2/A8, a real-GPU run of `visible-track`/`reference` produced only 30
decisions over a 45s episode (expected ~89) with decision gaps of 1800ms/600ms instead of ~505ms —
not a hypothesis, a measured regression against the acceptance criterion's own "≥2 acquisitions/
decision at 5Hz/505ms" target.

**Root cause:** `planTrackManeuver`'s `rangeOwnDurationMs` field (correctly defined as the FULL
LEASE for a speed-hold choice — used to size the follow-up command) was ALSO being passed directly
into `boundedCompletionMs(yawOwnDurationMs, rangeOwnDurationMs)` in `episode.ts` to GATE the next
decision's dispatch. Every nonzero speed-hold choice therefore forced the engine to wait out the
full ~1500ms lease before dispatching the next decision — defeating the ladder's own stated
requirement (and this unit's own docstring's claim, which the code contradicted) that speed-hold is
reconsidered every decision.

**Fix:** added a new, separate `rangeBoundedDurationMs` field to `PlannedTrackCommand` (0 for
speed-hold/hold — never gates dispatch; the real duration for translate — does gate, same as
before). `episode.ts` now uses `rangeBoundedDurationMs` for `boundedCompletionMs(...)`, never
`rangeOwnDurationMs`.

**Regression tests:** two new cases in `test/jev-find-follow-maneuver.test.ts` proving
`rangeBoundedDurationMs === 0` for every speed-hold choice (even fast nonzero speeds) while
`rangeOwnDurationMs` stays the full lease. **Before/after, `visible-track`/`reference` (same seed):**

| | decisions (45s episode) | avg decision gap |
|---|---|---|
| before fix (gating on `rangeOwnDurationMs`) | 30 | ~1500ms |
| after fix (gating on `rangeBoundedDurationMs`) | 75 | 600ms |

### A3 — per-axis maneuver execution: fixed-distance/yaw completion and consequence-fidelity coverage

**Fix:** `planTrackManeuver` composes a `primary` command plus an optional `followUp` so yaw and
speed-hold/fixed-distance run to their own independent completion (`yawOwnDurationMs`,
`rangeOwnDurationMs`); a long yaw either completes before the next decision or the follow-up carries
the remainder.

**A genuine gap found via self-check against this unit's own requirement, not by either review:**
`scoring.ts`'s `computeConsequenceFidelity` (from Unit E2) explicitly EXCLUDED speed-hold range
options — both smoke scenarios use `rangeMenuKind: 'speed-hold'`, so their `consequenceFidelity.
rangeAbsErrorM.n` was always 0, silently reporting nothing for the range axis on the scenarios that
actually matter, contradicting this unit's own "consequence-fidelity metric covers EVERY option
family with n reported" requirement. **Fix:** added a third, separate family,
`speedHoldAbsErrorMps` (kept apart from `rangeAbsErrorM`, whose unit is metres — a speed-hold's
declared outcome is a RATE, not a fixed step): compares the declared closing speed against the
realised closing rate `(cur.boundRangeM - next.boundRangeM) / dtS` between consecutive TRACK
decisions. `TRACK_RANGE_MENU` (fixed-distance) and `SPEED_HOLD_MENU` (speed-hold) are two different
menu objects that reuse some ids (e.g. `hold`); the lookup now checks both, since a scenario only
ever offers one of the two menus at a time (`rangeMenuKind`).

**Regression tests:** two new cases in `test/jev-find-follow-scoring.test.ts` ("consequence fidelity
covers yaw, fixed-distance range, and speed-hold range as three separate families, each with its own
n"; "speed-hold fidelity reports a nonzero error when the realised closing rate misses the declared
speed") — the first proves `rangeAbsErrorM.n===0`/`speedHoldAbsErrorMps.n===1` are reported
SEPARATELY (not folded together) when only a speed-hold option was chosen; the second proves a real
miss (declared 2.0 m/s, realised 1.0 m/s) is measured as a 1.0 m/s error, not silently zero.

### A4 — measured bearing-rate sign/frame and range-rate ego-motion contamination

**Observed (the review's exact probes):** a target drifting +5°/s to the right in camera frame while
the drone continuously reprojects should predict a LARGER offset ahead, not a smaller one; a
stationary target with the drone itself closing at 1 m/s was being reported as receding, because
the drone's own closing speed was folding into the "target" range-rate estimate.

**Fix:** `rate-estimate.ts` rewritten. Bearing: `worldBearingDeg` (CCW+/ENU) is now NEGATED before
combining with the camera-relative bearing convention (CW+/right-positive) —
`resultingBearingDeg = stationaryReprojectedDeg - bearingRate * horizon` (was `+`). Range:
`RateSample` gained `ownPositionM`; the fit now also computes the drone's own radial-closing-speed
by projecting `ownPositionM` onto the latest sighting's own bearing direction, and
`targetRadialSpeedMps = rawSlopeMps + ownClosingSpeedMps` compensates for it (requires
`ownPositionM` on every sample used, else `unknown` — never silently assumes stationary odometry).
Also implements the ladder's exact window rule: single LSQ window `W=1.0s`
(`DEFAULT_RATE_WINDOW_MS`, a scenario parameter `rateWindowMs`), `>=3` samples under one identity
else `unknown` (no more separate ad hoc staleness sub-horizon).

**Regression tests:** `test/jev-find-follow-rate-estimate.test.ts` (ego-motion-compensation,
window-cut, odometry-unavailable-marks-unknown). `test/jev-find-follow-encoders.test.ts` reproduces
the reviewer's two hand-computed probes exactly: bearing +2°→+7° (not -3°); range 9.6m→8.6m (not
7.6m).

### A5 — evaluator range definition mismatch (nearest 3D point vs. sensor's own surface definition)

**Fix:** `evaluator.ts`'s `sightlineSurfaceRangeToBox()` replaces nearest-3D-point-in-space with a
slab-method ray-box intersection along the camera's actual line of sight to the target box —
matching a real stereo sensor's mask-median surface range, which is necessarily along the viewing
ray, not the closest point in space (these differ whenever the camera is off to the side of the
target's centerline). Residual sensor-vs-truth range bias reported per run (see final report).

**Regression test:** `test/jev-find-follow-evaluator-boundary.test.ts` (off-centre camera; the two
definitions are proven to disagree without the fix).

### A6 — baselines could pass by construction; `constant` was not truly parameterised on the range axis

**Observed:** `run.ts`'s `buildController('constant', ...)` chose `range: 'hold'` — identical to
what `passive` always does on that axis, not a genuinely distinct constant policy. `visible-track`'s
oscillating gentle-curve car path also let `passive` score a perfect `centredFraction: 1.000` by
sheer luck of the oscillation's symmetry, undermining the "baselines can't pass" requirement's
intent.

**Fix:** `constant` now uses `range: 'speed_0_5'` (a real, non-hold, nonzero speed-hold choice).
Added `VISIBLE_TRACK_YAW` (new `lateral-crossing` CarPath — constant, NON-oscillating lateral
velocity) specifically so passive cannot stay centred by luck. New
`test/jev-find-follow-baselines.test.ts`: an all-seeing fake sensor (reports true bearing/range
every acquisition, isolating baseline POLICY failure from perception noise) x all 3 smoke scenarios
x all 4 baselines (passive/constant/first-option/seeded-random) = 12 combinations, every one
asserts `score.pass?.decided === false`. Confirmed separately (real GPU, this unit) that `reference`
PASSES `visible-track-yaw` (truthCentred=1, pass=true), so the new scenario is solvable, not
mis-calibrated against any controller.

### A7 — search/clearance: smeared per-sector state, stale-during-invalidation bug, unwired veto

**Fix:** `sector-memory.ts`'s `deriveClearance` now returns `Map<sectorIndex, ClearanceStatus>` —
each detected object is placed into its OWN sector by its own bearing, never smeared across every
currently-covered sector. `updateSectorMemory` fixed so a sector actually covered by the current
acquisition reads fresh (age 0) even during a large-displacement invalidation event — previously it
was unconditionally set to `never` in that path, discarding real evidence gathered in the same
instant. `ageSectorMemory` now also advances `clearance.ageMs` (previously stuck at 0 forever, so a
clearance reading never visibly aged). `blockedWithinM` is now actually wired end-to-end in
`episode.ts` (previously always `undefined`) as a logged, SCORED veto when a translate option's
sector reads blocked. `search.ts`'s notice text now defines `last_seen_offset_deg`/
`last_seen_age_ms` explicitly; `track.ts`'s notice now labels predicted bearing/range as PREDICTED
for the application instant, not "measurement." All printed headings now `round1`-ed.

**Regression tests:** `test/jev-find-follow-sector-memory.test.ts` (Map API, per-sector-not-smeared,
covered-sector-never-reads-never, ageMs-advances).

### A8 — provenance/determinism gaps; yaw rate hid the per-axis supersession bug

**Fix:** `ReportMeta` gained `partial`/`failureReason`; `runEpisode` now catches a mid-episode
failure, still writes a `partial: true` report with `failureReason` set, then re-throws (verified by
inducing a real failure path during development — a report is written, not lost, on a crash).
`config` gained `perceptionHello`/`yawRateDegS`/`latencyClampMs`; `sourceSha256` now actually
computed (hash of `episode.ts`'s own source, best-effort try/catch). Frame paths in `frameRef` are
now RELATIVE to `outputRoot`; `jev-find-follow.html` resolves them via
`new URL(frame.left, reportDirUrl)` where `reportDirUrl = new URL('.', reportUrl)` — this also fixes
the coordinator's own previously-reported viewer bug (absolute Windows paths never resolved once the
report moved). `planCycle` (scheduler.ts) and `clampJevLatencyMs` (controllers/jev.ts) removed
(confirmed zero callers by repo-wide grep; both superseded by the decoupled loop shape / generic
`realLatencyClampMs` handling). `DEFAULT_YAW_RATE_DEG_S` lowered 250→100 deg/s: chosen for exact
tick alignment (100°/s × 20ms = 2°/tick, divides evenly into every menu magnitude) while being
physically motivated and — unlike 250°/s — NOT hiding A2's per-axis supersession problem (a 60°
turn now takes 600ms, longer than the 505ms pacing floor, so it genuinely exercises the
follow-up/carry logic on real hardware). `YAW_RATE_DEG_S` kept as a deprecated alias.
Render-jitter decision-divergence quantified over 5 real-GPU repeats of `visible-track`/`reference`
(fresh processes each time, post-A2-gating-fix): **0/5 divergent** — every repeat produced the exact
same 75-decision `chosenManeuver` sequence and the exact same score
(`truth.centredFraction=0.991869918699187`, `pass.decided=true`, all five times). A strong result,
but scoped honestly: this is ONE scenario/controller pair, not every combination, and the renderer's
own OWN measured non-determinism (this unit's `right.png` re-measurement above) means a different
seed or a longer episode could in principle still diverge — not claimed to be exhaustively ruled out.

**Declared gaps, not silently dropped:** `imgsz` is not a `detector.py` parameter (outside this
unit's edit scope) so it cannot be recorded; the checkpoint provenance field records
`perceptionHello.model.checkpointName` only, not a hash of the weights file itself (hashing a
multi-hundred-MB binary was judged out of this unit's time budget, not technically infeasible).

## Increment B (Unit E3): scope delivered vs. declared gaps

B1 (scenario parametrisation) landed partially: single-axis question modes at the encoder level
(`TrackEncoderInput.questionMode`, not wired into `episode.ts`'s main loop — deciding what a
not-asked axis's in-flight command should do while unasked is an L1/L2 ladder design decision,
deliberately left to the ladder's own owner rather than guessed here); the new `lateral-crossing`
car path and `VISIBLE_TRACK_YAW` scenario (see A6 above); rig altitude/pitch already scenario
params from Unit E2. **Checked against `docs/jev-find-follow-ladder.md`'s own "harmful events"
definition (contact, envelope violation, vetoed choice, confident wrong-target answer) — all four
are already individually tracked and gate `pass.decided` in `scoring.ts`
(`contacts`/`envelopeViolations`/`vetoedManeuvers`/`correctIdentityFraction`); this is NOT a gap.**
**Not done:** explicit N/D/tolerance/envelope stated in the rendered goal sentence text;
start-offset/start-range sweep generators; seeded controller-latency DISTRIBUTIONS (one fixed
constant exists, not a distribution); the pessimistic-perception-latency arm as a
scenario-selectable field (the constant exists from Unit E2, not exposed as a flag).

B2 (sweep tooling) and B3 (running the sweep + provisional L1-L4 scenarios) were **not built this
unit** — the most significant scope gap in this unit's delivery, made under explicit time pressure
rather than attempted and left broken. A1/A2's real-GPU-measured bug (the `rangeBoundedDurationMs`
fix above) consumed time budget that would otherwise have gone to B2/B3; fixing a measured
correctness regression was judged the higher priority over building new sweep tooling on top of a
still-shifting engine. See the final report for a concrete design sketch (parametrising
`lateral-crossing`'s `lateralSpeedMps` from `(targetSpeedMps, bearingRateDegS)`, reusing the
all-seeing fake-sensor pattern from `jev-find-follow-baselines.test.ts` for a fast sweep mode) so
the next unit does not have to rediscover the approach.

## Declared, not-yet-fixed items (recorded for the ladder design, matching the two independent design reviews)

These were raised by the coordinator's ladder-design reviews and are explicitly out of THIS
assignment's scope ("do not expand your current deliverable into running sweeps"), but are recorded
here so the next rung's implementer does not have to rediscover them:

- ~~Fixed-distance range steps do not track a fast-moving target~~ **DONE in Unit E2** (increment
  B3): `SPEED_HOLD_MENU` + the `track` encoder's `stationary | measured-rate |
  explicitly-unknown-prediction` consequence-model switch, wired into both smoke scenarios
  (`rangeMenuKind: 'speed-hold'`, `consequenceModel: 'measured-rate'` — see scenarios.ts). The
  fixed-distance menu remains available/tested for a future stationary-target scenario only.
- **Renderer HFOV/resolution/obstacles/per-frame noise (increment B5).** Not started this unit
  despite the renderer.py edit permission being granted — both smoke scenarios still use the
  renderer's fixed HFOV/resolution and have no obstacles by design (declared, unchanged from unit
  1). Left for the next rung, which will need obstacle scenarios anyway.
- **Renderer determinism: `right.png` varies across fresh process starts, `left.png` does not.**
  See Unit E2's finding 6 above for the full measurement and root-cause status (unresolved, scoped
  to pyrender/OpenGL's own rendering internals — not an additive request-field change). **Unit E3
  re-measurement (this machine, same test, part of this unit's full `npm test` run): 1/15 distinct
  hashes for BOTH left.png and right.png** — fully byte-identical this run, an IMPROVEMENT on E2's
  2/15 right.png figure, but not attributable to any code change in this unit (nothing in
  renderer.py or its call path was touched) — most likely this is inherent run-to-run flakiness in
  the underlying OpenGL/driver behaviour not reproducing every time, not a fix. Reported honestly as
  a second data point, not a claim that the gap is closed; the regression guard
  (`MAX_ACCEPTABLE_DISTINCT_RIGHT_HASHES`) still exists specifically because this can recur.
- **Obstacle sizing relative to the rig.** Neither smoke scenario uses obstacles; a future obstacle
  scenario must give any rendered blocking geometry a matching Rapier collider at least
  `droneAltitudeM + 2 m` tall and `>=0.5 m` wide (Round 3's 0.12–0.55 m occluders do nothing from a
  5+ m altitude rig).
- **Static-scene per-frame determinism.** A perfectly static camera+scene render produces
  byte-identical frames every decision; a future purely-stationary rung may want small seeded
  per-frame render jitter so repeated identical requests are distinguishable in evidence. Not
  needed by either of this assignment's two (both-moving) smoke scenarios.
- **Renderer GPU selection.** This machine's OpenGL context selects the Intel iGPU
  ("Intel(R) Graphics") for `pyrender`, not the NVIDIA RTX 5090; Round 3's own preparation already
  investigated forcing the Windows high-performance GPU preference and found OpenGL still selected
  Intel (see `experiments/jev-round3/camera/README.md`). Not re-investigated here (cited, not
  duplicated); render times (~150–200 ms/pair once the scene is cached, ~1.1 s for the first call of
  an episode) were acceptable for this engine's wall-time budget regardless.
- **Replay-to-a-time / world-snapshot-restore.** The counterfactuals a later rung needs
  (held-at-loss-pose, fixed-observer) require restoring world state at a given simulated time and
  continuing with a different controller. This engine is fully deterministic given (seed, controller
  responses) — the prerequisite — but does not yet implement snapshot/restore itself; out of scope
  for this pass.

## Unit E3b: two residual defects (found by the coordinator's own real-run evidence, fixed here) and two sweep-tool bugs found via real runs

A fresh maker finishing Unit E3 (the previous maker's context exhausted). Both residual defects
below were diagnosed by the coordinator from a saved real-GPU report before this unit started;
this unit found the actual cause of each and fixed it, then built and ran the ladder scenario/sweep
tooling E3 itself declared as its own main remaining gap.

### E3b-1: the camera was not on a true 5 Hz simulated-time grid — one grid slot lost per 600 ms cycle

**Observed (coordinator's own evidence, `e3-final2/visible-track-reference/report.json`):** 75
decisions, 150 evaluator frames in 45 s (225 expected), acquisition gaps alternating 200/400 ms
instead of a uniform 200 ms, `skippedAcquisitions` 74 (nowhere near the true count),
`acquisitionsThisCycle` reading 1 for every decision.

**Cause:** `episode.ts`'s A1-era concurrent-acquisition loop (`while (!controllerDone) {...}`) gated
continued acquisition on the WALL-CLOCK `controllerDone` flag. Every controller this engine's own
tests/sweeps use (synthetic/reference/passive/constant/first-option/seeded-random) has no
`realLatencyClampMs` and resolves within a couple of microtasks of real wall time — so that loop ran
essentially zero extra iterations for all of them, even though the scheduler's DECLARED SIMULATED
`controllerLatencyMs` (default 250 ms) spans more than one camera period (200 ms) and should have
let another grid boundary fire. The engine then jumped the world forward through that gap
(`advanceRealWorld(appliedSimMs)`) with NO acquisition — the slot was neither acquired nor recorded
as a latest-wins skip (perception was never actually busy over it), simply lost. The previous
maker's own design sketch had attributed this to controllers being "near-instant" without further
diagnosis; the actual cause is that "near-instant in wall time" and "the declared simulated latency
window is over" are two different conditions this loop conflated.

**Fix:** the controller-call block now branches on `options.controller.realLatencyClampMs`
(controllers/types.ts's existing declared opt-in). Absent (the entire non-jev universe): the
loop drives acquisition off the KNOWN simulated deadline (`predictedAppliedSimMs`, already computed
before dispatch — exact for every controller without a clamp, since `actualControllerLatencyMs`
then always equals the scheduler's own declared constant), ignoring `controllerDone` until no grid
boundary remains below it. Present (real jev, or a slow-controller test double): unchanged —
the original wall-clock `while (!controllerDone)` concurrency, proven correct by the pre-existing
450-900ms fake-slow-controller regression test (still passing, unmodified).

**Verified:** default scheduler config (5Hz/505ms/140ms perception/250ms controller latency),
instant reference controller, 45s episode: 75 decisions, exactly 225 evaluator frames (was 150), 0
skippedAcquisitions (was 74), 3 acquisitions/decision uniformly (was 1), acquisition gaps uniformly
200ms (was alternating 200/400ms); a negative control (perception latency > camera period) still
produces real skips. **Regression tests:** `test/jev-find-follow-loop.test.ts`'s two new "E3b defect
A" tests.

### E3b-2: simulated time drifted in floating point

**Observed (coordinator's own evidence):** gap values like `199.99999999999636`ms,
`400.0000000000073`ms in a real report instead of exact integers.

**Cause:** `src/world.ts`'s `World.simMs` getter is `#ticks * scenario.dt * 1000`, where
`scenario.dt = physicsDtMs / 1000` (e.g. 20/1000 = 0.02) is not exactly representable in binary
floating point — the product drifts by single-digit-picoseconds-in-milliseconds per tick, even
though `#ticks * physicsDtMs` is always mathematically an exact integer (both are declared integer
milliseconds).

**Fix, deliberately NOT in `src/world.ts`:** that file is shared core code used by every other
experiment in this repo, well outside any permission this or any prior unit was granted (past
units' own grants were always scoped to specific files, e.g. Unit E2's renderer.py permission).
`experiments/jev-find-follow/world-bridge.ts` is the ONLY module in this engine that reads
`World.simMs` — all four of its internal read sites (the public `simMs` getter, both car-script
velocity computations, and `evaluatorSnapshot()`'s `acquiredSimMs`, a SECOND independent leak point
found while fixing the first) now round through one private `roundedSimMs()` helper. Since the true
tick count times an integer period is always mathematically an integer, this is lossless.

**Verified:** every simulated-time field in a full-episode report is now an exact integer
(`Number.isInteger` true throughout); a dedicated test advances 2250 ticks (a full 45s/20ms
episode's worth) and checks every intermediate reading. **Regression tests:**
`test/jev-find-follow-world-bridge.test.ts`'s new "simMs stays an exact integer millisecond..." test,
plus the E3b defect-A tests above (which also assert integer sim times end to end on a real episode).

### E3b-3: the reference-ceiling sweep tool's own synthetic sensor computed the wrong range definition (found via a real run of the new tool, not a static review)

While building B2's `reference-ceiling` command and validating it end to end before trusting any of
its numbers: `sweep.ts`'s `makeSyntheticFakes` computed range to the target's CENTRE point
(`bearingAndRangeFromWorldPosition`, copied from `test/jev-find-follow-baselines.test.ts`'s
all-seeing fake — harmless there, since that fixture never tests `reference`'s absolute accuracy,
only that OTHER baselines fail), while `requestedRangeM`/scoring's truth is the near-SURFACE range
along the sightline (`evaluator.ts`'s `sightlineSurfaceRangeToBox`, Unit E3's own A4/A5 fix) — a
~CAR_HALF_LENGTH_M (2.25 m) systematic mismatch. **Caught by actually running the CLI**: at the
supposedly-trivial (0 m/s target speed, 0 deg/s bearing rate) cell, `reference` scored
`truth.inRangeBandFraction: 0` against `passive`'s `1`, with `truth.rangeErrorM.medianAbs≈3.14` —
reference was chasing a systematically wrong number, not failing to hold a trivial target. **Fix:**
`evaluator.ts`'s own `sightlineSurfaceRangeToBox` is now exported (additive) and reused directly in
`sweep.ts`, reconstructing the target's box (centre position, yaw-derived rotation, known
half-extents) from the render request exactly as the evaluator does. **Second bug found in the same
pass:** `speedBearingRateCell` used `carInitialHeadingDeg: 180` (copied from `scenarios.ts`'s
`TURN_TO_FIND`, whose car spawns BEHIND the drone) instead of `0` (matching `VISIBLE_TRACK`, car
spawns AHEAD) — since `lateral-crossing`'s `forwardSpeedMps` is defined along the car's OWN
heading, this silently flipped every nonzero-speed cell's declared "retreat" (opening range, the
direction `SPEED_HOLD_MENU` can actually correct for) into "approach". Fixed. Both fixes verified:
the reference-ceiling CLI re-run correctly scores `reference` at 1.0 `inRangeBandFraction` on the
trivial cell.

### E3b-4: the ladder document's own hand-derived rig geometry did not match an empirical check on this renderer+detector pipeline

The ladder document (`docs/jev-find-follow-ladder.md` § Rig-geometry qualification) proposes 5m/-18°
and 6.5m/-18° as candidate higher rigs, derived from trigonometry (vertical FOV, nearest-visible-
ground, disparity-error formulas) rather than a render. This unit ran a real-renderer/real-GPU-sensor
static check (single frames, no physics loop) across altitude {1.8,3,4,5} x pitch
{-5,-10,-15,-18} x slant-range D {8..12}, reading the sensor's own box (for clipping) and reported
range (for accuracy). **Finding, disagreeing with the hand geometry:** in THIS pipeline, stereo
range error grows with camera ALTITUDE at a fixed slant range, not merely with slant range itself —
the ladder's own 5m/-18° and 6.5m/-18° candidates measured 0.49-1.85 m range error across D=8-12m,
frequently at or beyond the ±1 m moving-target tolerance already, before any controller/latency
noise is added; no box clipping was observed at any tested cell (the ladder's own predicted failure
mode), so the actual limiting factor at high altitude is stereo accuracy, not framing. A gentler
3m/-15° cell stayed under ~0.9 m error across D=8-11m with zero clipping (D=12m lost detection
entirely — a detection-range limit, not a framing limit). This unit's provisional higher rig is
therefore **3m altitude / -15° pitch, D0=9m** (`ladder-scenarios.ts`'s `CANDIDATE_HIGHER_RIG`), not
the ladder document's own suggested family — a genuine, evidenced disagreement, not a silent
substitution. **Declared gap:** the ladder's own "feasible band ≥4m wide, D≥2m inside both edges"
rule was not exhaustively re-verified (only D=8-12m swept, 1m steps, one seed, one frame per cell,
no physics loop, no full offset sweep) — D0 is chosen inside the empirically-confirmed low-error
zone, not proven against the full rule. See WORKLOG.md for the complete measured table.

## Increment B2/B3 (Unit E3b): scope delivered

B1's declared remainder landed: single-axis question modes WIRED into `episode.ts`'s main loop (an
un-asked axis defaults to 'hold' every decision — a deliberate decision this unit made rather than
deferring again, see `episode.ts`'s `EpisodeScenario.questionMode` docstring for the reasoning);
goal sentences now state N/D/tolerance/envelope numerically, conditioned on question mode
(`encoders/track.ts`'s new `goalSentence()`); `sweep.ts`'s `offsetRangeStart` (start-offset/range
placement) and `sampleLatencyMs`/`withSeededLatency` (seeded controller-latency distribution,
reusing the existing `realLatencyClampMs` mechanism rather than new scheduler plumbing — see
sweep.ts's own docstring for why); `PESSIMISTIC_PERCEPTION_LATENCY_MS` exposed via
`run.ts --pessimistic-perception`.

B2 landed: `run.ts batch` gained `--seeds` (a genuine `world.seed` reseed, not just the report's own
`seed` field) and `--manifest PATH.json` (per-entry overrides); `reference-ceiling.ts` (fake-sensor
default, `--real --cells` for GPU confirmation), aggregating best-of-arms-reference per cell and
deriving the ladder's own two independent 1-D envelopes from one joint grid (the bearing-rate=0
slice for the speed envelope, the speed=0 slice for the rate envelope) — reconciling this unit's own
assignment wording ("a grid of target speed x bearing rate") with the ladder document's explicit
"two independent 1-D sweeps, not a joint grid" instruction, from one run instead of two. Declared
scope reduction: the pilot grid is a coarse {0,1,2,3}m/s x {0,10,20}deg/s (12 cells), not a literal
0.5-step Cartesian product, and the exhaustive-every-constant-action check runs at one declared
representative cell rather than the full grid — both stated economies given this unit's time
budget, of the same kind the ladder document itself applies elsewhere.

### E3b/B3: reference-ceiling sweep and provisional L1-L4 results (engine-review-e3 finding 7: this
previously lived ONLY in WORKLOG.md, which must never ship — synced here)

**Fake-sensor reference-ceiling sweep: COMPLETE, 71/71 runs** (12 cells x {2 reference arms +
passive/first-option/seeded-random} + 11 exhaustive-constants runs at the (2 m/s, 10 deg/s) cell).
Measured envelope (tool's own computed output): `targetSpeedMpsAt80PctInRangeBand: 1`,
`bearingRateDegSAt80PctCentred: 20`. Bearing-rate axis (speed=0 slice): best-of-arms reference
clears 80% centred at every tested rate up to 20 deg/s (the true ceiling was not found within the
tested range). Target-speed axis (rate=0 slice): clears 80% in-range-band at 0 and 1 m/s
(1.000/1.000) then FAILS at 2 m/s (0.463) and 3 m/s (0.000) — **envelope = 1 m/s, half of the
ladder document's own provisional ~2 m/s expectation.** Off-diagonal cells (both axes nonzero) are
uniformly harder. No baseline (passive/first-option/seeded-random) is remotely competitive at any
cell with nonzero speed or rate. **This was itself found to be an implementation artefact, not a
real ceiling, by the later engine-review-e3 (Unit E4's own A1 fix, above): one missed detection was
wiping the rate window and the acquisition-latency wasn't compensated for target motion — with
those fixed, the reference holds the band to ≈2 m/s. This 1 m/s figure is the Unit-E3b-vintage
measurement and should not be cited as current without noting the A1 fix.**

**Provisional ladder, round3 rig: COMPLETE (15/15 = L1-L4 x reference/passive/constant).** L2
reference PASSES (0.813 centred, clears 0.8) and beats passive/constant (0.000 both). L3a reference
PASSES cleanly (1.000/0.993 bound), beats passive/constant (both fail by the deliberate 2m start
offset). L3b and L4 reference FAIL their range-band floor (0.018 and 0.688 respectively) —
consistent with the 1 m/s sweep ceiling above (L3b's provisional target speed was 2 m/s, L4's
1.5 m/s). **L1 reference FAILS on perception/binding reliability specifically**
(`boundFraction=0.060`, `longestLossMs=17000`) despite good geometric centring when bound (0.922);
L1 passive PASSES only because the provisional `offsetDeg=10` sits almost exactly at the central-band
half-width N0 (10.5deg), so passive trivially stays "within N0" without ever correcting anything —
the L1 rung was not actually discriminating. **engine-review-e3 later root-caused this same L1
collapse precisely**: a front-view detector BLIND SPOT, not a random perception failure — the
object list is empty in 93/100 frames because `offsetRangeStart` points the car's front (not a
realistic rear/side/oblique view) at the drone on a byte-identical static scene (no per-frame noise
or pose jitter), so the miss repeats deterministically for the full 15.4s; a static real-GPU probe
(64 poses) found front-view binding 3/8 at the round3 rig and 6/8 at the higher rig — recall is a
deterministic function of pose, so every stationary rung was effectively a single-pose lottery, not
a measured reliability rate. Fix (Unit E4's A6, if completed): aspect as a declared scenario factor,
start offsets strictly greater than N, seeded per-frame noise or small pose jitter.

**Provisional ladder, higher rig (3m/-15°, D0=9m): PARTIAL, L1 only (3/3)** — reference and passive
both PASS (reference clears `boundFraction=1.000`, notably better perception reliability than
round3's L1 run); constant fails as expected. L2/L3a/L3b/L4 at the higher rig were NOT run (declared
gap): resume with `node experiments/jev-find-follow/run-provisional-ladder.ts --out-root
.runtime/experiments/jev-find-follow-v1/e3b-provisional-ladder --rigs higher --rungs
l2,l3a,l3b,l4` (appends to the existing summary.json).

**Real-GPU reference-ceiling confirmation: COMPLETE**, confirming the fake sweep's envelope on real
hardware (`run.ts reference-ceiling --real --cells "1:0,2:0" --skip-exhaustive-constants`): 1 m/s
(largest clearing cell) best-of-arms reference `inRangeBandFraction=1.000`, matching the fake
sweep's 1.000 exactly; 2 m/s (one cell beyond) `inRangeBandFraction=0.588` — still fails the 80%
floor (real hardware measured somewhat better than the fake sweep's 0.463 prediction, conclusion
unchanged). Every baseline scores 0 at both cells on real hardware, exactly as predicted. This is
the Unit-E3b-vintage confirmation; per the note above, the true ceiling was later found to be closer
to 2 m/s once the A1 rate-window/latency bugs were fixed — this real-GPU figure has not yet been
re-confirmed against the fixed engine.

## Unit E4b: two tooling findings while building the multi-seed B3 sweep, both caught by actually running the new tool before trusting its numbers (not by static review)

### E4b-1: the fake-mode reference-ceiling sweep was just as slow in REAL wall time as a real-GPU run, by design — a multi-hundred-run multi-seed sweep was practically unrunnable until this was found

**Observed:** a 2-seed, full-grid timing probe of the new multi-seed sweep tool (`b3-sweep.ts`, ~260
fake-sensor episode runs) did not finish within 10 minutes of real wall time, even though every
controller involved (reference/passive/first-option/seeded-random/constant) resolves in microtasks
and the sensor/renderer are pure in-process fakes with ~1ms simulated cost each.

**Cause:** `episode.ts`'s own real-wall pacing wait (`pacingWaitMs`, called every decision cycle) is
driven by the SAME `pacingFloorMs` (505ms default) that also gates the SIMULATED dispatch cadence —
a deliberate original design choice (`scheduler.ts`'s own docstring: "paced >=505ms apart in REAL
wall time... honoured uniformly for every controller, not only real Jev, so the engine's pacing
mechanics are identical and testable regardless of which controller is plugged in"), correct for
realism but never intended to also govern a synthetic-sensor SWEEP tool with no real API/rate-limit
to respect. A ~20s-simulated fake episode at ~40 decisions therefore still took ~20s of REAL wall
time (40 x 505ms), identical to a real-GPU episode's own real-time-ish pacing — so a several-hundred
-run sweep would have taken HOURS, not the "explorable in minutes" the previous unit's own
`reference-ceiling.ts` docstring claimed (true only for its own much smaller run count, ~71 runs,
never stress-tested at this unit's larger multi-seed/finer-grid scale).

**Fix:** `scheduler.ts`'s `SchedulerConfig` gained a new field, `wallPacingFloorMs`, separated out
from `pacingFloorMs` specifically for this purpose — `episode.ts`'s `pacingWaitMs` call site now
reads `wallPacingFloorMs`, while `nextDispatchSimMs`/`readyToDispatch` (the SIMULATED-time gating)
are untouched, still reading `pacingFloorMs`. Backward compatible by construction: `runEpisode`
mirrors `wallPacingFloorMs` onto whatever `pacingFloorMs` resolves to whenever a caller's own
`options.scheduler` does not explicitly set `wallPacingFloorMs` — every existing test/caller in this
repo (which only ever overrides `pacingFloorMs`) is byte-for-byte unaffected. `b3-sweep.ts`'s own
fake-mode runs are the only caller that explicitly sets `wallPacingFloorMs: 0` (real-GPU/real-Jev
runs never do). **Measured effect:** the same 2-seed/full-grid timing probe that did not finish in
600s completed in 8.3s after this fix — a full 8-seed/full-grid sweep at BOTH rigs (round3 + higher)
then completed in ~28.5s each. **Verified NOT to change simulated behaviour:**
`test/jev-find-follow-loop.test.ts`'s new "wallPacingFloorMs shortens real wall time without
changing simulated decision cadence or count" test asserts byte-identical `dispatchedSimMs`
sequences and decision counts between a coupled and decoupled run of the same scenario/seed.

### E4b-2: L2's own bearing-rate envelope reads materially LOWER once measured on an EXACT constant-rate path, not `lateral-crossing`'s decaying approximation — but real GPU hardware then measured better than that lower fake-mode reading

**Observed:** engine-review-e3's own finding 2 (Q2) already flagged that `lateral-crossing`-based
cells decay from a declared rate toward ~1/7th of it by the end of a 20s episode; this unit's new
`orbit` CarPath (exact circular motion, constant range from the drone, so the true bearing rate
equals the declared value for the WHOLE episode) lets the sweep measure the real ceiling instead of
an artefact of the decaying approximation.

**Measured (fake sensor v2, Round3 rig, 8 seeds/cell, ALL 8 seeds must clear the 80% floor for the
cell to count toward the envelope):** 0deg/s 8/8, 5deg/s 8/8 (min 0.95) -> **fake-mode envelope =
5deg/s**; 10deg/s only 5/8 clear (mean 0.803, min 0.725); 15deg/s only 3/8 (mean 0.806, min 0.700);
20deg/s 0/8 (mean 0.394). This is materially LOWER than E3b's own "clears 80% at every tested rate
up to 20deg/s" headline, which used the decaying `lateral-crossing` approximation — that number
should not be cited as the engine's real bearing-rate ceiling. The higher rig measured the same
5deg/s fake-mode envelope (8/8 at 5deg/s, 1/8 at 10deg/s) — the ceiling is not rig-sensitive on this
axis in fake mode, only the recall/bias (B1 fake-v2 model) differs by rig. **Target-speed axis, same
methodology:** Round3 fake-mode envelope = 1.0 m/s (8/8 clear); higher rig fake-mode envelope =
1.5 m/s (8/8 clear, min 0.8 exactly) — a genuine, evidenced rig difference on THIS axis (unlike the
rate axis). Full tables: `.runtime/experiments/jev-find-follow-v1/e4b-b3-sweep-round3/summary.json`,
`.../e4b-b3-sweep-higher/summary.json`.

**Real-GPU confirmation (Round3 rig, 3 seeds each, `run.ts b3-sweep --real --real-speeds 1,1.5
--real-rates 5,10 --policies reference,passive --consequence-models measured-rate
--skip-exhaustive --fixed-constant-yaw yaw_left_10 --fixed-constant-range speed_neg_1_0`):
speed 1.0 m/s 3/3 clear (mean/min 1.000); speed 1.5 m/s (the fake sweep's "one beyond" cell, only
7/8 in fake mode) ALSO 3/3 clear on real hardware (mean/min 1.000); rate 5deg/s 3/3 clear (mean/min
1.000); rate 10deg/s (fake mode: only 5/8 clear, mean 0.803) also 3/3 clear on REAL hardware (mean
0.946, min 0.912). Every baseline (passive) scores 0 at all four cells on real hardware, exactly as
predicted. **Reading this honestly:** real hardware measured BETTER than the fake-v2 sensor model
predicted at both "one beyond" cells (1.5 m/s and 10deg/s), matching this engine's own repeated
prior pattern (E3b's own 2 m/s real-vs-fake comparison: "real hardware measured somewhat better than
the fake sweep's prediction"). This does NOT mean the fake-mode envelope figures above (5deg/s,
1.0-1.5 m/s) should be silently raised to match — the real sample is only 3 seeds per cell (a small
n), and B4's own ladder rungs are configured from the CONSERVATIVE fake-mode figures, not the
optimistic real-hardware ones, per this unit's own "do not loosen rules to get READY" instruction.
It is reported plainly as a real, positive data point: the true bearing-rate/speed ceiling this
engine can achieve on real hardware may be somewhat higher than the fake sensor model's own
conservative prediction, worth a wider real-GPU seed count in a follow-up unit before revising the
declared envelope upward.

**Secondary observation, not yet fully explained (flagged, not chased further this unit):** in the
FAKE-mode sweep at 20deg/s (Round3), the selected `constant` baseline (`yaw_left_10` held the whole
episode) scored a HIGHER mean centred fraction (0.541) than `reference`'s own best-of-arms mean
(0.394) at that same cell — the only cell in either sweep where a baseline beat reference. Both are
far below the 0.8 floor (this does not change any READY/NOT-READY verdict), but it is a genuine,
measured anomaly worth a future unit's attention: possibly the reference controller's own
per-decision "minimise current apparent bearing error" policy overshoots/oscillates against a target
whose own angular rate now exceeds what a 505ms-paced yaw menu can track, while a small constant,
non-reactive yaw bias happens to partially cancel the orbit's own rotation direction on average. Not
investigated further given this unit's time budget.
