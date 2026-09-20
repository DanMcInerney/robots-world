# Camera loop ablations

Predeclared on 18 September 2026, before new inference. Rationale and failures accumulate in [design-failures.md](design-failures.md). This implements the first two proposals and the pairing experiment from [jev-loop-next.md](jev-loop-next.md). It does not implement VIO, OpenCV flow, measured velocity feedback or a body-rate actuator interface.

| Arm | Input change | Question change | Comparison |
| --- | --- | --- | --- |
| A: baseline | Original words/current measurements | Original six menus | Repeated matched baseline |
| B: semantic | None | Physical option names and explicit actuator-effect wording | B vs A: action formulation, a combined name/wording factor |
| C: temporal | Raw image rates, measured camera-angle rates, missing regions seen within 2 s | Same as B | C vs B: bounded temporal evidence |
| D: paired | Identical to C | Joint XY and joint heading/pitch | D vs C: control factorization |

Every arm retains the same `7 × 7 × 7 × 9 × 7 × 2 = 43,218` actuator tuples. A/B/C list 39 options across six questions. D lists 121 options across four questions (49, 63, 7, 2); no question exceeds 255. Directions are named explicitly. The physical effect descriptions are declared task-independent instructions; arithmetic never selects an action. Jev selects every velocity, angle and FOV.

The temporal adapter accepts only delivered colour-region measurements, timestamps and estimated camera angles/FOV. It retains at most 24 tracks for two seconds; overflow is explicit. It never receives the goal, world, evaluator, commands or physical sizes. Image rates include camera and object motion. They are not optical flow, metric velocity or motion-compensated tracks. Clipped extents, zoom changes and missing correspondence produce unknown rates. Missing-object records are historical and expire; no predicted location is invented. Admission receipts remain distinct from application and achieved motion.

## Method and evidence

- Development: seed **82**, 20 s per arm. Audit plumbing and inspect failures before freezing. Do not tune on held-out outcomes.
- Held out: seeds **1301, 1302, 1303**, 40 s per arm, rotated execution order. Same seeded moving target/crossing obstacle, camera, link impairments, command expiry, English goals and evaluation as the [pixel pilot](jev-pixels.md). Wall-clock/network timing is not identical across arms.
- Five-Hz RGB, 100 ms delivery latency, 2% dropout, no rangefinder, beacon or simulator geometry in controller observations. Physics runs continuously at 50 Hz, including during inference. One request in flight; minimum 250 ms between request starts.
- Report image-framed fraction, target visibility, movement, collision/boundary ticks, latency and tokens. Retain inherited composite success but identify its unobserved global-boundary requirement. No scripted policy competitor.
- Save every PNG acquisition, exact questions/options/probabilities, mapped command, receipt, wire/application times, trajectory and frozen source. Reconstruct temporal state from the sequence of delivered observations; rebuild command feedback from preceding recorded mappings. Independently replay all PNGs and compare every request/mapping. No retry of failed paid decisions.
- Budget: existing 1.2M input tokens per flight and 15M per batch; stop on errors. Credentials and generated evidence stay ignored.

```powershell
node --env-file=.env.jev.local experiments/jev-loop/run.ts --phase development --seeds 82 --seconds 20 --output .runtime/experiments/jev-loop-development-v1
node --env-file=.env.jev.local experiments/jev-loop/run.ts --phase held-out --seeds 1301,1302,1303 --seconds 40 --freeze .runtime/experiments/jev-loop-development-v1/freeze.json --output .runtime/experiments/jev-loop-held-out-v1
```

Use the existing [pixel cockpit](http://127.0.0.1:8870/pixels.html?report=/.runtime/experiments/jev-loop-held-out-v1/report.json) for paired replay, raw images and exact decisions. Results are exploratory, not physical-drone qualification or proof that a given perception library runs on a small companion board.

## Completed results

Four development flights and twelve held-out flights used real `jev-1.13.0`. No controller/prompt changes followed development. Both batches froze source hash `100aa2d2e37dcdadecdd0f777ded3956501480d2c51e323cff7be425474edf02`. All held-out flights completed, with no inference/controller errors or excluded failures.

| Held-out arm | Passes | Fully framed after warmup | Mean blue detected | Pooled API p50 | Pooled image→application p95 | Input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A: original words | 0/3 | 0% | 5.2% | 216 ms | 700 ms | 958,741 |
| B: physical names | 0/3 | 0% | 11.6% | 213 ms | 700 ms | 1,140,878 |
| C: motion history | 0/3 | 0% | 13.4% | 213 ms | 700 ms | 1,271,283 |
| D: paired controls | 0/3 | 0% | 11.3% | 238 ms | 780 ms | 3,015,357 |

The [held-out analysis](../.runtime/experiments/jev-loop-held-out-v1/analysis.json) contains 1,710 decisions, 2,364 independently replayed camera acquisitions, matched-world checks and example failures. [Development evidence](../.runtime/experiments/jev-loop-development-v1/report.json) adds 279 decisions and 388 images. All requests, preceding feedback, temporal summaries and actuator mappings reconstruct exactly. Maximum held-out simulation lag: 151 ms; 40 s simulations took about 40.05–40.10 s wall time. These are desktop measurements, not an embedded-compute benchmark.

Eight additional [development-only diagnostic requests](../.runtime/experiments/jev-loop-development-v1/full-menu-diagnostics.json) cost 26,507 input tokens. Direct aiming instructions improved toward-bearing choices from 2/16 to 8/16 axes while retaining full menus; four initial cases duplicate the same scene. No diagnostic action was applied. [F07/F08 in the failure log](design-failures.md) distinguish this limited result from successful control and explain the next proposed comparisons.
