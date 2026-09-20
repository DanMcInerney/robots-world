# Jev camera-control diagnosis · 18 September 2026

The evidence points to a poor decision interface compounded by delayed, ambiguous feedback. It does not establish that Jev cannot control a drone, nor that adding depth would fix this controller. The classifier receives valid sensor-derived text, but choosing a motor-space response from it still requires several linked spatial and numerical judgments.

This review covers the older [15-flight pixel report](../.runtime/experiments/jev-pixels-held-out-v2/report.json) currently open in the browser and the subsequent [12-flight loop report](../.runtime/experiments/jev-loop-held-out-v1/report.json). Counts below refer to the latter unless explicitly marked older. No paid inference or flight policy changed during this review. New work was read-only log analysis and one offline actuator-contract reproduction.

## What was actually tested

All four latest arms use real `jev-1.13.0`, a continuously advancing 50 Hz stabilized simulated drone, a 5 Hz RGB camera with 100 ms delivery delay, and a delayed/lossy 10 Hz command stream. A software renderer produces actual 320×180 pixels. A goal-independent HSV connected-component tracker converts those pixels into colour, bounding-box bearings and apparent width. It does not recognize arbitrary objects or infer depth. Onboard heading/pitch estimates are explicitly simulated sensors.

Jev gets an English image-framing goal, those measurements, control descriptions and the last two admission receipts. C/D add image rates and two seconds of historical missing tracks. Jev selects three velocities, yaw, camera pitch and FOV. A/B/C use six questions; D combines XY and camera angles into four questions. All retain 43,218 actuator tuples. A local servo stabilizes velocity/attitude; no script tracks the blue target. Velocities travel in genuine MAVLink encoding; heading/pitch/FOV use a local sidecar. This is not a qualified hardware control stack.

## 1. Errors are visible on the first decision

Every initial image has blue left and below centre. In 10/12 first decisions the selected yaw turns away from its bearing; in 11/12 the selected camera tilt does so. There are no preceding Jev commands to explain these as delayed reactions. These counts evaluate each camera axis in isolation; they do not assume every coordinated movement must turn directly toward the current bearing.

For example, C/1301 sees blue **21.93° left, 5.87° below, 14.37% wide**. It selects **right 15°**, a small rightward translation, climb, backward motion and down 3°. The right turn worsens horizontal framing. Its next four logged yaw answers also choose right 15°. At image time 1,400 ms blue is clipped against the left/bottom edges. Inspect decision `529c08f3-6623-4b72-a8d0-e361b85a78bd` in the [full flight](../.runtime/experiments/jev-loop-held-out-v1/loop-temporal-1301.report.json) and the [initial image](../.runtime/experiments/jev-loop-held-out-v1/frames/loop-temporal-1301/camera-200.png).

The image signs match the pixels and the actuator mapping. Missing metric range cannot explain that initial left/right error. However, this is not a balanced spatial benchmark: rotated world seeds still place the target left/below in the image. Mirrored/quadrant-balanced inputs, alternative goal objects and unseen layouts are necessary to generalize.

## 2. The loop is faster than its observable feedback

| Timing, pooled within each latest arm | Median | 95th percentile |
| --- | ---: | ---: |
| Image acquisition → request | 180 ms | 280 ms |
| Request start → next request | 260 ms | 320–360 ms |
| Admission → first application | 140 ms | 180 ms |
| Image acquisition → application | 580 ms | 700 ms A/B/C; 780 ms D |

These are different distributions; do not add their medians to reconstruct another median. API response medians are 213–238 ms. Acquisition delay and the command stream matter as well as inference.

Of 1,698 decisions following another decision, **1,662 use images older than the preceding command's actual application**. In the other 36 cases that command never applied. Thus no decision sees the immediately preceding command's effect in its current image. This does not mean the loop has no feedback: effects of older commands become visible later. It means the controller must reason about a pipeline of outstanding actions, which its two untimestamped admission receipts do not adequately describe.

The first C/1301 sequence makes the causality explicit:

| Decision | Image acquired | Request | Command admitted | First applied |
| --- | ---: | ---: | ---: | ---: |
| 1 | 200 ms | 300 ms | 720 ms | 900 ms |
| 2 | 600 ms | 720 ms | 920 ms | 1,100 ms |
| 3 | 800 ms | 960 ms | 1,180 ms | 1,380 ms |

Decision 3 still sees an image captured before decision 1 applied. An action receipt says the command was accepted, not that the current picture contains its result. The same pattern exists in the older pilot: **2,071/2,071** cases with an applied preceding command, 580 ms median image-to-application, 260 ms request interval. This is not a Nervelet or native-agent delay; these runs call Jev directly.

Evidence: [latest audit](../.runtime/experiments/jev-loop-held-out-v1/deep-audit.json), [older audit](../.runtime/experiments/jev-pixels-held-out-v2/feedback-audit.json).

## 3. “Keep heading” can undo a turn

The mapping is `absoluteHeading = acquiredHeading + selectedDelta`, similarly for pitch. Zero means return to the old measured angle, not retain the preceding setpoint or stop rotating at the current angle. Body velocities are likewise converted with the acquired heading and then held in world coordinates.

This is documented in the long contract but conflicts with the natural reading of the short “keep” options. It creates a problem even for a model that intends to stop adjusting. In a mechanical test with no inference or goal-derived commands, a 45° turn moved heading from -135° to -103°. A zero increment based on the original image then sent -134.7° and turned back to -128.4°.

Evidence: [offline reproduction result](../.runtime/experiments/jev-loop-held-out-v1/keep-heading-diagnostic.json), [script](../.runtime/jev-keep-heading-diagnostic.ts), [mapping](../experiments/jev-pixels/controller.ts). This proves the interface behavior, not how many failed flights would be rescued by changing it. The log audit also estimates stale-angle retargets; those estimates use the preceding 100 ms trajectory sample, not exact application-time angles.

## 4. Small menus still hide a large reasoning task

A question saying “choose yaw” actually asks Jev to identify the intended region, understand its current and desired image position, invert the effect of camera rotation, choose a magnitude, account for stale state, and coordinate with unknown translation/pitch answers. Naming the options physically improves readability but leaves that computation intact.

TypeSafe's [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) recommend moving arithmetic into code, reducing indirection and separating judgments. Our long contract is 44–56% of median state text, depending on arm. It includes protocol/frame details and negative caveats each camera-axis question must navigate. Prompt relevance is a plausible problem; the experiments did not isolate it.

Parallel questions evaluate the same state independently. They do not negotiate a coherent joint control vector. [State contract](https://docs.typesafe.ai/concepts/state). Pairing can capture some dependencies but D's 49 XY and 63 angle options still leave coupling across translation and camera orientation. D used **2.37× C's input tokens**, with less target detection and zero sustained framing in both. This is evidence against this particular pairing, not against large Choice menus generally.

The 255 limit is **per question** and never binds here (maximum 63). All fixed controls are present. More questions can run in parallel; reducing their number was not intrinsically an improvement. [Choice documentation](https://docs.typesafe.ai/primitives/choice).

When blue was visible, median returned yaw confidence was .18/.15/.18 for A/B/C; D's paired-angle confidence was .10. We executed the top option anyway. Confidence describes probability-distribution concentration, not empirically established flight safety. A universal confidence threshold or probability-weighted continuous actuator value has not been validated. Separating direction and magnitude remains an experiment: simply pooling the existing option probabilities by direction seldom changes the wrong-direction result.

## 5. Most of the paid decisions occur after perception has been lost

Blue first disappears at 2.18–7.08 s. Eight of twelve flights never detect it again. **1,528/1,710 decisions lack blue; 1,120/1,710 contain no colour regions at all.** Jev still selects translation in 611 target-absent decisions. That can be intentional searching, but we have not demonstrated a successful search policy or persistent search progress.

This is an absorbing failure pattern: bad early actions remove the useful measurement; a short-lived, ambiguous memory cannot recover it; the remaining 40 s trial mainly measures blind behavior. C's usable blue motion rate exists in **37/59 blue-visible decisions (63%)**. Reporting only 64/435 decisions with any usable region rate overstates how much of the shortage is a tracker failure: much of it follows target loss.

The perception implementation has genuine limits. It ignores dark/grey surfaces entirely; nearest-neighbour IDs can switch or reset after disappearance. Rates mix object motion, camera rotation and translation. The temporal formatter only processes observations consumed at request time, despite acquisition-side frames being available. It supplies raw rates and camera-angle rates separately and leaves Jev to interpret them. Empty colour output is not empty space. The requested collision avoidance is therefore only partially observable.

## 6. What this audit rules out, and what remains uncertain

- No missing API key, mocked inference, malformed responses or exhausted Choice capacity in these retained runs. Exact request/response/mapping evidence exists for all 1,710 completed decisions.
- 1,666 decisions reach their first application; the audit verifies an accepted MAVLink adapter receipt at each corresponding time. The main problem is not a disconnected motor channel.
- Sensor conversion consumes pixels/calibration and declared onboard angle estimates. Private target position, future path, range and evaluator state are not model inputs. The renderer necessarily uses world geometry to create those pixels.
- Privileged scoring includes an unobserved global boundary and uses object-centre visibility, which differs from detecting a partly occluded blue patch. These are evaluation limitations; they do not explain the observed wrong turns and long loss of detections. Retain separate framing/safety metrics.
- Exact reconstruction and passing plumbing tests establish provenance and mapping, not decision quality. Synthetic colours, idealized stabilized physics and desktop timings do not qualify cheap-board vision performance or hardware transfer.

## Proposed order of work

1. **Qualify the actuator meaning.** Choose one explicit rate/setpoint contract; test zero, replacement and repeated/delayed delivery without a mission policy. Preserve robot/library neutrality.
2. **Expose causal feedback.** Timestamp commands and real device telemetry; show which observations can contain an action's effect. Compare streaming against waiting for a post-application observation. Acquisition/physics continue in both. If hardware lacks an application acknowledgement, report that uncertainty.
3. **Qualify the measurement formatter.** Test all image quadrants, gray surfaces, clipping, zoom and camera rotation on saved RGB. Compute calibration transforms/rates/ages outside Jev. Evaluate acquisition-side tracking and measured camera-rotation compensation separately, without inventing depth or velocity.
4. **Qualify Jev's decisions before another long flight matrix.** Balanced development images → frozen fresh images → camera-only physical tracking → moving-drone tracking → occlusion/recovery. Hold unused axes only in explicitly labelled diagnostic ablations. Retain every control in the final full-control comparison. Measure initial sign accuracy, target loss/recovery, feedback age and progress, not just one binary mission score.
5. **Compare direct control and an explicit hybrid.** Direct arm: Jev selects physical direction, magnitude and behavior from sensor-derived evidence; code maps and stabilizes. Hybrid arm: a declared visual servo handles image-error arithmetic, Jev chooses target/behavior and authorizes control tools. Codex can generate/revise the task policy outside the immediate loop. Removing that servo or its advice is a required ablation; hybrid success must not be credited to Jev doing the servo math.

Deriving a bearing, named image-position bin or rotation-compensated measurement from available sensors is legitimate perception. Feeding `recommended_yaw` or mapping “target left” directly to a turn is policy assistance. Both can be useful engineering, but only clearly separated experiments answer who made the decision. Range matters for metric clearance and translation scale; it is not the first missing fact in these failures.

Reproduce the new offline analyses from the repository root:

```powershell
node .runtime/jev-loop-deep-audit.mjs
node .runtime/jev-pixels-prior-audit.mjs
node .runtime/jev-keep-heading-diagnostic.ts
```

Methods are also retained beside evidence under `methods/`. The original sources, reports and scores remain unchanged. Failures and decisions are appended as F09–F12 in [design-failures.md](design-failures.md).
