# Jev hypothesis qualification: results

18 September 2026. **No complete drone mission passed.** Factored questions improved static direction choices, and two mechanical fixes passed their component checks. Neither made direct Jev control reliable. The explicit camera-servo hybrid centred successfully on one seed and failed after occlusion on the other.

Open the [visual laboratory](http://127.0.0.1:8870/.runtime/experiments/jev-hypotheses-v1/index.html) for images, comparisons and exact Jev calls, or the [side-by-side flight cockpit](http://127.0.0.1:8870/pixels.html?report=/.runtime/experiments/jev-hypotheses-v1/flights/report.json). These links require the local Robots World server and retained ignored evidence.

## What ran

- Eight offline actuator cases; five 12-frame perception sequences, including gray surfaces, occlusion and camera rotation. OpenCV 5.0.0 / NumPy 2.5.3 ran in an isolated optional environment.
- **144 real Jev calls:** six fixed formulations on eight development and sixteen held-out RGB scenes. No actions applied.
- **22 real Jev flights:** eleven predeclared arms, two fresh seeds each, 24 seconds per flight. **1,187 completed decisions**, 1,199 recorded requests, 2,552 replay-audited RGB acquisitions. The twelve unfinished requests were cancelled at trial shutdown.
- **3,755,526 input tokens**, no controller/API errors or invalid attempts. Maximum recorded simulation lag: 80.2 ms. Physics and camera acquisition continued during inference and waits.

The [predeclared plan](jev-hypothesis-tests.md) and controller source remained frozen throughout inference. Experiment hash: `d35d052683324a70fc3b57120be13e8382da81f503546000ece2bce92a5226d3`. [Frozen files](../.runtime/experiments/jev-hypotheses-v1/freeze.json), [derived analysis](../.runtime/experiments/jev-hypotheses-v1/analysis.json), [verification](../.runtime/experiments/jev-hypotheses-v1/verification.json).

## Static decisions

The held-out scenes contain **21 camera axes outside the original goal's central tolerance**. Other axes may correctly hold. The raw saved `correctYaw`/`correctPitch` fields instead mean “toward the bearing”; this posthoc summary excludes already-centred axes without changing the original goal or evidence. Each pair of axes belongs to one scene, not two independent trials.

| Formulation | Toward / 21 | Hold | Away | Camera-only projected centre / 16 | Held-out input tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full original | 1 | 9 | 11 | 0 | 40,469 |
| Compact state, original questions | 3 | 9 | 9 | 0 | 36,686 |
| Direct camera questions | 6 | 12 | 3 | 3 | 35,230 |
| Separate direction / magnitude | 13 | 0 | 8 | 4 | 44,910 |
| Add measured position bins | 6 | 0 | 15 | 0 | 47,219 |
| Model-selected object branches | 7 | 0 | 14 | 0 | 157,870 |

Conditional target selection was correct **16/16**, but its movement decisions were worse than the simpler factored formulation. Giving correct object identity does not guarantee correct control. Projected centring assumes only the chosen camera rotation, ignoring simultaneous translation; it is a geometry diagnostic, not predicted flight success. [All requests, responses and mappings](../.runtime/experiments/jev-hypotheses-v1/static/report.json).

Factoring preserves all physical values without enumerating their Cartesian product: each signed axis gets a direction question plus one magnitude question for each nonzero direction, all answered in parallel. Code selects the magnitude belonging to Jev's chosen direction. Five axes plus FOV use sixteen questions and retain 43,218 physical combinations. Conditional-object variants add complete branches; camera-only diagnostics explicitly hold translation. No choices are pruned using the answer.

## Moving-world results

Percentages below average the two seeds' **time-weighted evaluator measurements after phase warmup**, not variable-cadence images consumed by Jev. Fully framed also requires the desired apparent width. Camera-only diagnostics cannot perform the full size-following mission.

| Arm | Visible | Centred | Fully framed |
| --- | ---: | ---: | ---: |
| Camera: original zero contract | 42.0% | 0% | 0% |
| Camera: retain accepted angle | 0% | 0% | 0% |
| Camera: add own actuator telemetry | 0% | 0% | 0% |
| Camera: wait for observable application | 0% | 0% | 0% |
| Camera: factored questions | 0% | 0% | 0% |
| Full controls: factored | 0% | 0% | 0% |
| Full controls: motion history | 16.7% | 0% | 0% |
| Full controls: longer last-seen memory | 33.3% | 0% | 0% |
| Full controls: confidence gate | 50.0% | 0% | 0% |
| Hybrid questions, servo disabled | 0% | 0% | 0% |
| Hybrid questions, servo enabled | 50.0% | 50.0% | 13.1% |

## Hypotheses: outcome and limit

| ID | Finding | What it establishes |
| --- | --- | --- |
| H1: broad questions | Direct wording improved needed directions from 3/21 to 6/21 versus compact original wording. | A small signal, insufficient control accuracy. |
| H2: clutter | Compact state improved 1/21 to 3/21; neither centred a static scene. | Clutter is not the sole explanation. |
| H3: direction vs magnitude | Factoring reached 13/21, but only 4/16 projected centres; camera-only flights still failed. | Easier classification helps some decisions, not reliable convergence. |
| H4: target/representation | Target 16/16; bins and conditional branches worsened needed directions relative to factored. | Identity and extra labels are not sufficient; this does not generalize to all bin wording. |
| H5: zero semantics | Four dated-zero cases reversed; four retained-setpoint cases did not. Retain flights nevertheless lost the target. | The contract fix works mechanically, without demonstrated mission benefit. |
| H6: delayed feedback | All **637/637 same-goal** gated transitions used an image after the preceding applied command; no timeouts. Six unseen transitions occurred across explicit goal-change bypasses. | The wait fixes that causal gap. It does not fix the decision policy. |
| H7: coupling/assistance | Camera-only direct control failed. Hybrid seed 1501 centred throughout scored time; 1502 lost the target and later collided. | Camera translation coupling is not the only failure. Assistance helps one scenario. |
| H8: motion | Rotation compensation reduced a stationary scene's bearing span from 22.27° to 0.27°. Flight history improved visibility, not centring. | Sensor arithmetic works in its fixture. History and compensation flight effects are not separately isolated. |
| H9: neutral surfaces | Colour missed all 12 gray and all 12 dark frames; OpenCV found features in each, with 11 tracked pairs per sequence. | Pixel-only coverage can improve. Features are not obstacle identity, depth or clearance. Flow was not fed to these flights. |
| H10: recovery | Eight-second memory raised mean visibility from 16.7% to 33.3%; centring stayed zero. | Limited visibility signal, no reliable recovery. No 24-track capacity clear occurred. |
| H11: confidence | The fixed .35 gate overrode **85/85 decisions**, yielding holding and no centring. | This threshold is unusable here; confidence is not calibrated control correctness. |
| H12: missing range | Sensor bearing alone supports the explicit angular servo; camera-direction failures precede metric navigation. | Range is unnecessary for that subtask. This does not resolve translation or obstacle avoidance. |

## New failure: visible extent is not complete object size

Hybrid seed 1501 achieved 100% scored centring, but only 26.1% full framing. Seed 1502 initially aimed correctly, then a foreground crate covered blue: consumed visible width fell from **11.56% → 6.88% → 2.81% → absent**. The `clipped` flag stayed false because it only measures image-boundary clipping. Compare recorded RGB at [3.2 s](../.runtime/experiments/jev-hypotheses-v1/flights/frames/hybrid-1502/camera-3200.png), [4.4 s](../.runtime/experiments/jev-hypotheses-v1/flights/frames/hybrid-1502/camera-4400.png) and [5.0 s](../.runtime/experiments/jev-hypotheses-v1/flights/frames/hybrid-1502/camera-5000.png).

Private evaluator geometry confirms the projected full target width remained about 13.1% while the visible patch shrank. That geometry is diagnostic evidence only: it never entered Jev's input. After loss, Jev's search/translation did not recover the target and eventually reached the ground: **79 collision ticks**, not 79 separate collisions. [Exact second-seed decisions and trajectory](../.runtime/experiments/jev-hypotheses-v1/flights/hybrid-1502.report.json).

**Next proposed test:** pixel-derived overlap/track uncertainty, explicitly distinguishing visible extent from estimated complete extent, then held-out recovery and translation tests. Include occlusion and true recession that produce similar shrinking patches. Never label this measurement metric range or supply hidden geometry. This proposal has not been implemented or tested.

## Boundaries and reproduction

Jev received RGB-derived colour regions, measured camera orientation, declared own actuator jobs where applicable, and bounded sensor history. No rangefinder, target position, map, evaluator recommendation or achieved velocity entered its state. The wait uses own running-job setpoints and acquired timestamps; it is not a claim that bare MAVLink velocity packets provide application acknowledgements. The hybrid explicitly computes continuous camera corrections from image bearings when Jev authorizes following; those corrections are assistance, not Jev's numeric work. Confidence gating is also declared assistance.

Two seeds per flight arm are exploratory; the sample does not establish a winning architecture or hardware readiness. The simulator uses simplified dynamics/rendering. Static labels, independent axes and full-task scores have different meanings. OpenCV timings are desktop measurements, not small-board qualification. Native agents and Nervelet were not involved in these direct-API tests.

The outcome analysis and viewer were added **after** inference and are archived separately from the frozen controller. Regenerate them without inference:

```sh
node experiments/jev-hypotheses/analyze.mjs
node experiments/jev-hypotheses/verify.mjs
```

For a new cohort, use a new output directory with `run.ts freeze`, then the explicit paid `static` and `flights` stages; never overwrite this evidence. Controller regression tests passed alongside the existing suite: **163 passed, three optional Nervelet integration tests skipped**. Typecheck and viewer build passed.
