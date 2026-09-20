# Three scouting techniques: real Jev results

18/18 planned 120-second flights completed; no invalid attempts or replacement seeds. Three techniques × three obstacle scenes × two matched pilot layouts. [Frozen design](jev-scout-techniques.md), [visual report](http://127.0.0.1:8870/.runtime/experiments/jev-scout-techniques-v1/index.html), [decision diagnostics](../.runtime/experiments/jev-scout-techniques-v1/diagnostics.json).

**Camera assistance was the best practical component. None completed the mission.** This small pilot does not establish a robust ranking, and the assistance package includes measured-bearing camera aiming, wide FOV and fewer following questions. Translation and every search action remain Jev decisions.

| Technique | Jev received blue in flights | Visible seconds | Centered seconds | Fully framed seconds | Mission passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct controls | 3/6 | 6.6 | 0 | 0 | 0/6 |
| Camera assistance | 3/6 | 250.1 | 226.0 | 15.1 | 0/6 |
| Assistance + dated memory | 3/6 | 225.0 | 192.0 | 13.0 | 0/6 |

Each row covers **720 seconds flown**, including discovery delays and never-seen targets. Visibility/centering/framing use recorded camera measurements; Jev receipt counts use actual request contents. Memory had one additional 0.4-second camera glimpse never delivered to Jev. No hidden actor position supplies either controller evidence or these image-framing measures.

## What happened

- **Turn to find:** all six flights missed the target. Each applied roughly 200 search actions but none changed heading while searching. Repeated small forward/right/up velocities took the drone away from useful views. No scripted scan rescued it.
- **Behind wall:** all six cameras found blue. Direct control retained only 2.0/2.6 seconds of visibility. Assistance retained 46.4/97.0 seconds; memory 69.7/48.2 seconds, but first discoveries were much later at 49.6/71.0 seconds versus approximately 20 seconds. All had zero full framing. Memory selected orange regions 49 times and neutral regions 13 times in this scene; extra memory did not reliably preserve the goal's identity.
- **Occlusion course:** layout 2101 defeated all three; memory's camera briefly saw blue but Jev did not. On 2102, direct retained 2 seconds of visibility. Both assisted versions found blue at 11.4 seconds and retained 106.6 seconds. Assistance achieved 15.1 full-framing seconds, longest continuous 9.8 seconds; memory 13.0 seconds, longest 10.4 seconds. Neither reached the required 40% framing, and both violated the evaluation envelope.

[Watch the strongest full-framing flight](http://127.0.0.1:8870/pixels.html?report=%2F.runtime%2Fexperiments%2Fjev-scout-techniques-v1%2Fpilot-occlusion-course%2Fscout-current-2102.view.json). The existing cockpit exposes exact instructions, complete options/probabilities, raw PNGs, mapped commands and MAVLink/application timing. Some course reappearance occurs with a fixed observer; these observations do not establish causal search or recovery skill.

## Failures and the next small tests

1. **The search label did not produce a scan.** All three failed the turn-to-find task. Test a compact, self-contained *look direction* question and a record of previously acquired viewing directions. Jev must choose directions; do not insert an automatic sweep. Keep this separate from movement regulation.
2. **Camera correction and translation are different problems.** In direct behind-wall 2101 at 20.32 seconds, blue was 11.62 degrees below center; Jev tilted up 3 degrees and selected narrow FOV. Assistance fixes that component, but following usually remained 0.2 m/s forward with 0 or +0.2 m/s vertical movement. Test camera-relative movement options, with calibrated coordinate mapping explicitly declared and the direction/speed still chosen by Jev. No hidden range or recommended action is required.
3. **Latest-only delivery can miss real detections.** In occlusion-course memory 2101, both raw processing and KLT detected blue at 68.2 and 68.4 seconds. Jev read 68.0 and 68.6 seconds. Test bounded, acknowledged detector events carrying acquisition time and last-seen evidence. Old positions must remain historical/unknown-current; this uses real acquired pixels, not simulator truth. The current memory treatment retained only observations delivered to decisions, so it could not help this case.
4. **The envelope score was underspecified to the controller.** All 18 violated inherited altitude/position bounds. The exact goal did not declare those limits and inputs omitted altitude/position estimates. Do not interpret this as disobeying an explicit flight envelope. A separate altitude-estimator/declared-limit treatment is needed. All flights also fail the framing threshold independently, so removing the envelope gate would not create any mission passes.

These are proposed next tests, not implemented repairs or new inference results. The target is a uniquely blue box proxy, optics are synthetic and dynamics simplified; this does not qualify semantic recognition, navigation or hardware deployment.

## Audit and accounting

3,503 completed actual responses; 3,512 requests, including nine endpoint cancellations. 10,575 raw RGB acquisitions and 10,573 processed worker frames reconstructed, as did every request and mapped command. All six matched case/seed blocks had identical target trajectories. Maximum observed pacing lag: 537 ms, below the predeclared one-second invalidity limit. All 110 frozen source files matched after the last flight. [Source verification](../.runtime/experiments/jev-scout-techniques-v1/source-verification.json).

The API reported 16,374,412 input tokens. A further 1,174,675 tokens are conservatively reserved for canceled calls, not verified billed usage. No retries, schema/service/audit failures, or budget increases occurred. [Usage ledger](../.runtime/experiments/jev-scout-techniques-v1/usage.json).

Only the report generator changed after completion: it now distinguishes camera detections from Jev-delivered detections and shows whole-flight visibility/centering totals. Frozen prompts, controls, scene generation, scores and raw reports remain preserved. [Original independent review and one repair](../.runtime/experiments/jev-scout-techniques-checks-v1/review.md); [checks](../.runtime/experiments/jev-scout-techniques-checks-v1/delivered.json): 173 passed tests, three optional skips, typecheck/build and browser replay checks.
