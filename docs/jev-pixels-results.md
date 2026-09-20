# Camera-only Jev pilot: recorded results

18 September 2026. The five [predeclared arrangements](jev-pixels.md) all failed sustained visual following on three held-out scenarios. This is evidence about these prompts, interfaces and simulated plant, not a general limit on Jev.

The matched matrix contains **15 × 40-second flights, 2,149 completed real Jev decisions and 2,930 independently replayed camera acquisitions**. Five 20-second development flights precede it. One additional completed flight from the interrupted first audit attempt is retained separately. No scripted mission controller or other model competed.

| Arrangement | Passed | Mean blue detection availability | Mean path travelled | API median | Image-to-application p95 | Input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Numeric, six axes | 0/3 | 31.5% | 7.4 m | 210 ms | 680 ms | 1,022,373 |
| Words, six axes | 0/3 | 22.0% | 8.3 m | 217 ms | 700 ms | 1,001,725 |
| Words + history | 0/3 | 15.4% | 8.0 m | 216 ms | 700 ms | 1,111,813 |
| History + joint XY | 0/3 | 16.2% | 5.3 m | 219 ms | 700 ms | 1,870,054 |
| Conditional object controls | 0/3 | 13.0% | 11.2 m | 222 ms | 780 ms | 1,720,478 |

Latency percentiles in this table pool decisions within each arm. The interactive overview labels its different aggregation explicitly: mean flight median and maximum flight p95. Detection availability uses distinct acquired frames consumed by decisions, then averages the three flights. It is not detector recall: the target often leaves the camera view because of the controller's actions.

All arms had 0% fully framed time in the scored portions after warmup. Some attained framing briefly before warmup ended. Thus the negative result persists independently of the inherited, unobservable absolute arena-bound requirement. Five of the 15 flights had collision contacts. All flights moved; path lengths ranged from 1.6 to 28.9 m. The earlier all-hover behavior is not the explanation for this matrix.

## What seems to work

In the conditional arm, Jev selected the blue region in **54/54 decisions where blue was detected**. Object selection worked in those observations; its subsequent control choices did not sustain tracking. The conditional request used 7–31 parallel questions. The joint arm used five questions, including the complete 49-option XY list. No choices were ranked or filtered using the goal.

Colour extraction/tracking used about 0.5–0.7 ms for the mean of flight medians on this desktop; the largest per-flight p95 was 1.50 ms. These timings exclude rendering/recording and do not establish Raspberry Pi or onboard performance. The sensor log also records render and total processing time.

All three seeds had byte-identical sampled target and crossing-obstacle trajectories across their five arms. Runs took roughly 40.1 seconds of wall time for 40 seconds of simulation; maximum recorded simulation lag was 97 ms. Physics continued during inference. Every saved PNG was hash-checked and replayed; requests and mapped commands were reconstructed from recorded evidence.

## A narrower diagnostic

After the matrix, ten **development** observations were re-submitted to real Jev with six narrower questions: identify the blue region; locate it horizontally and vertically; compare apparent width with the requested band; choose the camera-turn direction; choose the camera-tilt direction assuming no translation. These did not actuate a drone.

The selection rule was fixed before those calls: the earliest and last blue-visible decision in each development arm. Five observations share the initial camera view, so these are not ten independent scenes. The original state was unchanged. Expected answers were computed from that state's pixel measurements solely for grading, and were not sent to Jev. All **60/60** answers matched. Exact requests, probabilities and original flight commands are retained in `jev-pixels-development-v1/posthoc-diagnostics.json`.

For example, the first numeric flight supplied a blue region 22.15° left and 5.38° below centre, occupying 17.5% of image width against a requested 8–14%. Its flight response turned right 5°, tilted up 3° and chose forward/right translation. On that same state, the narrower questions correctly identified left, below, too large, turn left and tilt down.

This suggests that the text is readable and that question granularity/control formulation matters. It does **not** prove a successful replacement controller: those probes remove simultaneous translation, magnitude choice, delayed feedback and search after target loss. The roughly 0.7-second upper-tail sensor-to-actuation age is also a real constraint.

The next useful comparison is explicit semantic control choices and narrowly scoped instructions versus the current numeric choices, followed by the same closed-loop test. A visual servo using observed pixels is a legitimate separate hybrid arm, but its contribution must be declared and ablated; these results do not quietly substitute one for Jev.

## Evidence and qualifications

Open `/pixels.html?report=/.runtime/experiments/jev-pixels-held-out-v2/report.json` on the running Robots World server. It provides paired replays, actual camera PNGs, English goals, every option, probabilities, command admission/application and raw traces. `analysis.json` contains the aggregates and paired-world audit. Runtime evidence and credentials remain ignored by Git.

Two audit-only signed-zero fixes were necessary. The first interrupted attempt is preserved under `jev-pixels-held-out-v1`, with a separately recovered report. In the main matrix, the same issue in a rounded pitch field stopped reporting after flight 12; that flight was recovered from its original trace and only the three remaining flights were then run. The original stopped report, the corrected audit source, source hashes and amendment record remain in the main directory. Source comparisons confirmed that only the report audit changed, not any inference, perception, actuation, environment or scoring code. No failed mission was rerun to select a favorable outcome.

The final audit freeze is `jev-pixels-development-v1/freeze-audit-v3.json`. The main report contains the original matrix source hash, an audit amendment and each flight's execution hash. A fresh repeat can use the final freeze and a new output directory.

This is a unique-colour task in a simple box world with noisy RGB and simulated onboard attitude readings. It uses no rangefinder, target beacon, GPS position, metric depth, semantic detector or simulator oracle in the controller input. Dark/grey surfaces can be missed. Motor dynamics, wind, camera artifacts, hardware compute and a real autopilot/gimbal integration remain unqualified.

Validation: all 158 offline tests passed, with the local Nervelet bridge module supplied; typecheck and production build passed. The browser replay and inspection controls were checked separately. Paid inference results are separate from those offline checks.
