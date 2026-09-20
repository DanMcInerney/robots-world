# Round 2 results: useful stereo range, unreliable distance choices

19 September 2026. **Keep calibrated stereo as the next simulation baseline; neither tested decision representation is reliable enough to call this a following controller.** All 192 real Jev calls completed, using 232,186 input tokens, with zero transport/schema failures or retries. Small-delay tuning was left aside.

[Open the image/decision viewer](http://127.0.0.1:8870/.runtime/experiments/jev-round2-v1/index.html#samples). This round contains recorded camera estimates and one-step choices; **no flight was executed**. Round 1's yaw replays remain linked in the viewer.

## Camera result

Actual [Depth Anything V2 Metric VKITTI Small](https://github.com/DepthAnything/Depth-Anything-V2/tree/a561b849ebae10a6f5ef49e26c83cbbcd36c71bf/metric_depth) ran locally against the unchanged classical SGBM matcher. Both processed 24 fresh rendered stereo scenes and three reused real Middlebury scenes. Images/configuration/checkpoint/source were frozen before prediction; no ground-truth scale fitting occurred.

On the six nominal confirmation targets at **7.8–13.8 m**, stereo produced six usable ranges, **0.291 m mean absolute error** and **0.505 m maximum error**. Monocular depth produced six finite estimates but **5.094 m mean error**, underestimating every target by more than 2 m. Both rejected ambiguous, missing and dark targets; stereo also returned unknown on low texture. Stereo's descriptive interval was as wide as **4.73 m** at the farthest target, so the median-error result does not establish a tight distance bound.

The three real scenes likewise favored stereo's retained pixels: per-scene MAE **0.034 / 0.062 / 0.175 m**, against monocular **6.646 / 9.559 / 3.671 m**. However, stereo retained only **34–48%** of reference pixels, versus dense monocular output. These are indoor regression scenes and procedural renders, not a fair qualification of an outdoor learned model. There were **zero real reference pixels at 9–11 m**. Neither dense output nor narrow depth spread establishes confidence. [Full perception results and coverage](../.runtime/experiments/jev-round2-v1/perception/offline-report.md).

## Jev result

Every synthetic estimate, including wrong and unknown ones, was tested with requested distances of 8 m and 12 m. Each scene retained the same six actions and opaque identifiers. The additional-facts arm supplied predicted final depth for every action, without ranking them.

| Confirmation input | Correct use of supplied estimate | Physically correct choice |
|---|---:|---:|
| Stereo, measured range | 20/24 | 12/20 |
| Stereo, plus action outcomes | 21/24 | 12/20 |
| Monocular, measured range | 20/24 | 4/20 |
| Monocular, plus action outcomes | 21/24 | 3/20 |

The physical denominator excludes missing/ambiguous reference targets but includes known targets whose range was unavailable. Thus correct observation/abstention can still be a missed physical capability. All **28 unknown-depth confirmation choices** correctly requested observation; none committed to movement or hold.

Both additional-facts arms **failed the predeclared advance gate**: 87.5% interpretation was below 90%, and the 4.2 percentage-point improvement was below ten points. Stereo choices changed on all seven pairs requiring different actions under the two goals, but both answers were correct on only **3/7 measured pairs versus 5/7 outcome pairs**. Monocular estimates clustered near 5 m, making both goals demand maximum retreat; it had **zero eligible goal-change pairs** and supplies no responsiveness evidence.

Two logs explain the failure:

- **Decision error despite useful sensing:** `c04-stereo-goal12` reports a 9.50–12.19 m interval, with a true surface depth of 10.8 m. Both formats chose **advance 1 m**; **retreat 1 m** minimized error under both the supplied interval and truth.
- **Correct interpretation of a wrong world:** `c06-monocular-goal8-consequences` sees approximately **5.36 m** and chooses **retreat 2 m**. The actual target is **13.8 m** away; the correct physical direction is forward. Good interpretation cannot repair bad range.

## Next experiment

Keep stereo and isolate **goal-relative distance wording**: the same numerical interval versus a computed signed distance-error interval, with explicit statements that advancing decreases separation and retreating increases it. Keep every action available and let Jev choose; do not supply a best-action score. Test near-goal holds and the wrong-direction cases first. If that clears its fixed gate, test actual short translations with fresh stereo feedback, then a moving target. Real outdoor measured imagery near 10 m remains necessary before hardware conclusions. These next tests are proposed, not executed.

## Evidence and verification

The [prospective plan](jev-round2-plan.md), [exact summary](../.runtime/experiments/jev-round2-v1/summary.json), [all requests/responses and sensor records](../.runtime/experiments/jev-round2-v1/replay.json), and [independent preflight review](../.runtime/experiments/jev-round2-v1/preflight-review.md) are retained. Development's 96 calls were sealed before confirmation; prompts, cases and gates did not change. Final frozen source: `98ab1747d321717a70173284412b77f3bf1be1de7afb7f8343847425053587a8`.

The preflight response-retention repair preserved failed/partial HTTP bodies without retry; an abrupt-interruption regression preserves uncertain calls in the denominator. Original snapshots/review and setup failure remain available. Repository verification: **321 tests passed, five skipped; typecheck/build passed**. These are 24 correlated synthetic scene units, not 192 independent trials; no semantic car identity, obstacle clearance, temporal tracking, MAVLink execution or physical flight was qualified.
