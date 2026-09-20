# Jev hypothesis qualification

Predeclared 18 September 2026, before new inference. This tests the claims in [the diagnosis](jev-loop-diagnosis.md); outcomes will be appended to [design-failures.md](design-failures.md). No world-core or Nervelet changes are required. Existing failed runs remain intact.

## Questions and comparisons

| Hypothesis | Controlled test | Evidence that would support it |
| --- | --- | --- |
| H1: broad instructions hide several judgments | Full original wording vs direct camera wording, same complete angle menus and measured state | Higher direction accuracy on balanced unseen images |
| H2: irrelevant state distracts Jev | Full vs compact state, identical questions | Higher accuracy; report token difference |
| H3: numeric magnitude interferes with direction | Direct full signed menu vs separate direction and conditional magnitude questions | Better direction without losing reachable angle values |
| H4: target selection/representation causes mistakes | Explicit model-selected object branches; measured bearing descriptions vs added named position bins | Correct object selection and action signs across colour goals/quadrants |
| H5: zero adjustment undoes ongoing turns | Dated-angle zero vs retained accepted setpoint, repeated/delayed packets | Mechanical reversal removed; matched flight comparison determines task benefit |
| H6: feedback delay causes repeated corrections | Stream vs expose local actuator job telemetry vs wait for a camera acquired after a matching running setpoint | Reduced unseen-predecessor decisions; separately measure retention and latency |
| H7: independently chosen movement/camera controls conflict | Camera-only diagnostic vs all controls; explicit hybrid and identical hybrid-disabled arm | Better centring with isolated/assisted axes; no claim of equal task capability |
| H8: sparse history/ego motion hides useful measurements | Acquired-frame history vs consumed-frame differences; stationary scene under camera rotation | More valid measurements and reduced spurious rotation-induced motion |
| H9: colour-only perception loses neutral obstacles | Actual rendered grey/dark/coloured scenes; optional OpenCV grayscale feature flow | Neutral features detected/tracked without world geometry in the algorithm |
| H10: target loss/recovery dominates | 2 s vs 8 s bounded last-seen memory in otherwise identical full-control flights | Better time-to-reacquisition and target-visible fraction |
| H11: low-confidence argmax is unreliable | Accuracy by confidence on static cases; fixed .35 gating flight arm | Accuracy/coverage tradeoff; retention may worsen through excessive holding |
| H12: range is the missing cause of direction errors | Balanced no-range camera-only direction test | Successful direction without range refutes range as necessary for this subtask; does not qualify metric navigation |

## Stages and integrity

1. Offline mechanics/perception checks. Scripts issue prescribed actuator pulses solely to measure the device contract. Renderer truth creates fixtures and evaluation labels, never model state. All PNGs and calibration are retained.
2. Static real-Jev tests on 8 development and 16 fresh held-out rendered views spanning four quadrants, two goal colours, sizes and distractors. Six predeclared representations: full, compact, direct, factored, binned, conditional. Model chooses target/direction/magnitude; scorer math never selects a flight action. Each case is an independent observation, not a flight. Record probabilities, confidence, exact requests, costs and latency. No tuning after held-out results.
3. Matched moving-world flights: two fresh seeds, 24 s each, rotated arm order, fixed camera and command impairments. One starts left/below, the other right/above. Camera-only diagnostic arms hold translation explicitly; use centring/visibility for their comparisons, not success on the full size-following task. Full-control arms preserve every physical control value. All arms and planned comparisons run even if they fail.

Flight comparisons: camera-original → camera-retain → camera-telemetry → camera-wait → camera-factored; camera-factored → full-factored; full-factored → full-history; full-history → full-memory / confidence / hybrid-disabled; hybrid-disabled → hybrid. The history factor combines acquisition-side rates and bounded camera-rotation correction, so its flight effect cannot separate those two contributions; the offline test does.

Telemetry comes only from the robot's existing `Observation.jobs`: own accepted actuator setpoints/status/timestamps. This is an explicit locally available actuator interface, not evaluator truth or a claim that bare MAVLink velocity packets return acknowledgements. Waiting uses a matching running job plus a newer acquired image; no private application trace drives the policy. Timeout/expiry is logged, not silently rescued.

The hybrid is declared policy assistance: Jev selects a visible region and authorizes following; a sensor-only camera servo computes angle corrections. The disabled arm asks identical questions but executes Jev's camera adjustments. No scripted tracking competitor is presented as a Jev-only controller. Confidence gating is also explicit policy assistance, with overrides logged.

Budget: no retries; at most 15M input tokens across the new real-inference qualification. Stop on API/account errors, source changes or evidence-audit failure. Save complete attempts. Camera/physics continue during every inference and managed wait. Runtime credentials and evidence remain ignored. Desktop OpenCV timings are not cheap-board qualification.
