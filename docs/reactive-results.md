# Real Jev in a continuously changing drone world

Run on 17 September 2026, US Eastern. **Jev made useful decisions much faster than the direct native agents, but this experiment does not establish reliable continuous piloting. Adding a Codex brief or online repair did not increase the pass count over Jev with calculated consequences.**

There were 24 planned attempts: six arrangements on each of seeds 500–503. Twenty-three ran for 60 seconds; one Claude flight terminated after an altitude violation at 55.4 seconds. That attempt remains a failure, with its original partial trace, and was never retried. All inference was real: TypeSafe `jev-1.13.0`, native Claude Code `claude-opus-5` / low, and native Codex `gpt-5.6-luna` / xhigh. No physical drone was connected.

## What was tested

The English task asks the drone to film a moving rover from a specified side, at a specified range and framing, while avoiding collisions. The rover changes speed and heading, a solid obstacle moves, sensors are delayed/noisy, and radio and setpoint packets can be lost. Halfway through, the operator asks for the opposite viewing position. The world never pauses for inference.

The models choose from the same bounded velocity/camera effects: up to 212 complete bundles, with 172–212 actually offered in these full-duration flights. No supplied mission-solving script competed. Helpers calculate kinematics, relative geometry, observed-range proximity and camera projection from delivered measurements. They do not read the goal to select, rank or filter a route. Jev uses five parallel conditional questions in one request; native agents return one complete bundle ID. See the [full contract and limitations](reactive-comparison.md).

## Results

The **original pass criterion** requires one continuous second in the requested side/range/centering geometry during each phase, at least 50% target visibility in each phase after a five-second allowance, and no collision or envelope violation. It permits only brief attainment of the requested view. The stricter sustained-framing check below was added during analysis and is explicitly post-hoc; the frozen original score was not changed.

| Arrangement | Original passes / attempts | Median response | p95 response | Correct side/range/framing time | Contact time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Jev, bare controls | 1/4 | 0.327 s | 0.679 s | 13.29% | 0 s |
| Jev, calculated consequences | 2/4 | 0.499 s | 1.194 s | 15.72% | 4.90 s |
| Claude Opus 5, consequences | 0/4 | 5.275 s | 8.271 s | 3.01%* | 0.24 s* |
| Codex Luna xhigh, consequences | 0/4 | 16.851 s | 35.403 s | 0.95% | 0 s |
| Jev + Codex preflight brief | 2/4 | 0.508 s | 1.183 s | 14.71% | 0 s |
| Jev + brief + online repair | 2/4 | 0.501 s | 1.776 s | 13.36% | 6.24 s |

Response percentiles include completed responses from all attempts, including the terminated flight. Unfinished requests are censored, not recorded as zero or an invented completion time. Framing is the mean fraction of scored phase time; contact time is summed across completed flights. *Claude's framing/contact statistics cover its three full-duration flights only; the terminated flight also had a ground contact and altitude violation, but its missing remainder is not filled in.*

**No arrangement passed the stricter check requiring correct side, range and centering for at least half of both scored phases.** This distinguishes briefly reaching a view from maintaining it. Perfect instantaneous tracking is not always feasible with the supplied speed limits and rover turns; no optimal-trajectory feasibility certificate was established for this stricter check.

| Seed | Jev bare | Jev consequences | Claude | Codex | Jev + brief | Jev + repair |
| --- | --- | --- | --- | --- | --- | --- |
| 500 | Incomplete | Incomplete | Terminated | Incomplete | Incomplete | Incomplete |
| 501 | Incomplete | Pass | Incomplete | Incomplete | Pass | Pass |
| 502 | Incomplete | Pass | Incomplete | Incomplete | Pass | Pass |
| 503 | Pass | Incomplete | Incomplete | Incomplete | Incomplete | Incomplete |

Four scenarios per arrangement are a small pilot, not a statistically established ranking. A viewing condition can also be attained because the rover turns: Codex briefly attained one phase's geometry despite admitting no actions. The score records physical outcomes, not proof of causal goal understanding.

## Timing, repair and failure evidence

- Jev started 1,127 requests across its 16 flights and recorded 1,115 HTTP responses. Four selected-branch probability inconsistencies and two seven-second timeouts were rejected without substituting a mission action. Ten requests were unfinished at flight end. The accepted commands came from offered candidates; twelve old-goal decisions were rejected across the four Jev arrangements.
- Codex started 12 requests, completed nine, and admitted **zero** actions. Five returned commands failed the five-second freshness bound, three belonged to the superseded goal, and one completed at the flight boundary without being applied. Three requests remained unfinished. This measures an unsuitable timing arrangement, not the quality of an unrestricted Codex controller.
- Claude completed 41 responses across all four attempts: 17 were admitted and 24 rejected. Three requests were unfinished in its full-duration flights. Its terminated flight selected a descent whose 1.5-second preview was inside the envelope, but whose three-second execution crossed the altitude floor. Once outside, the candidate filter returned no actions. This is a shared preview/execution limitation, preserved rather than fixed midway through the test.
- The preflight brief took **19.875 seconds** of actual Codex inference before flight. Four online repairs took **10.725–14.252 seconds**, all installed, and appeared in 68 subsequent Jev requests while the world continued. In seed 501, the second viewing goal was attained at 34.12 s, before repair installed at 42.76 s. Seed 502 attained it after repair, but the brief-only variant also passed that scenario. These observations do not establish a causal benefit from repair.
- Maximum recorded pacing lag across complete flights was **257.9 ms**, below the predeclared one-second invalidation threshold. Sensor acquisition, raw protocol delivery and environmental trajectories continued during native inference. Setup is recorded separately: roughly 24–82 ms for Jev-only initialization, 0.87–1.05 s for the three completed Claude setups, and 1.85–5.92 s for native Codex setup, depending on arrangement.

The initial goal-sensitivity development probe used the identical observation and action menu with four different English goals. After representation work, Jev selected two distinct actions, not four reliably appropriate ones. That is partial goal sensitivity, not a passed navigation test. Earlier flat annotated requests exceeded the API's question context limit; speculative conditional questions resolved that request-size problem.

## Cost accounting

Recorded Jev HTTP responses report **50,524,840 input tokens**, including responses subsequently rejected for probability inconsistency. At the documented $0.042 per million input tokens, this corresponds to approximately **$2.12** for the final batch's reported usage. It excludes unknown usage from timeouts/cancellations and excludes development, excluded batches and native inference. This is a usage-based estimate, not an invoice. [TypeSafe model pricing](https://docs.typesafe.ai/models).

Claude's last reported cumulative costs sum to **$23.64886** across all four attempts. These are SDK-reported amounts; unfinished inference can leave accounting incomplete. Codex reported token usage but no dollar amount, so its cost and a complete combined bill remain unknown. Persistent native conversations and stateless Jev requests with four recent actions are different context arrangements; this is not an equal-token benchmark.

## What the next experiment should change

1. **Make the shared execution contract honest over its full lifetime.** Align preview, source age and command expiry, and provide a task-neutral response when no candidate is available. Apply and log the same bounds for every controller. This should prevent a stale descent from outliving its preview without adding a route solver or mission answer.
2. **Test goal sensitivity across many frozen observations.** Change only the English goal, then separately change only sensor evidence. Keep candidate generation goal-independent. Measure whether choices respond correctly to both, including when achieving a goal requires temporarily worse framing or moving around an observed obstruction.
3. **Compare capable native arrangements through Nervelet.** Let Codex/Claude author their own bounded local loops from the English task, charging their setup time, and give the hybrid the same capability. Compare those with Jev's immediate selections and event-driven policy revisions. No researcher-authored mission solver should enter as an unnamed helper. The present native arms have tools disabled and cannot stand in for full DroneRTS agents with authored routines.

The evidence supports trying Jev as a fast selector over understandable alternatives, with slower generation outside the immediate action path. It does not yet show that Codex-written advice is necessary, that online repair improves performance, or that Jev can replace planning and robust local execution.

## Reproduction and audit

Frozen experiment source hash: `c81ff550e778671062c71b1aa600cf57e96d21388e14d2c4dc873e04881c339e`.

Final local evidence: `.runtime/experiments/reactive-held-out-v2/`. It contains the original manifest, per-flight JSONL, full results, `summary.json`, `audit.json`, a 29.25 MB `replay.json`, continuation metadata and a 60-file source snapshot with individual hashes. Credentials and generated evidence remain ignored by Git. The [replay](http://127.0.0.1:8870/flight.html?report=/.runtime/experiments/reactive-held-out-v2/replay.json) shows all six arrangements by seed, world/onboard views, goals/advice, provider responses, decisions, camera data, radio and raw MAVLink links. Terminated recordings explicitly show where evidence ends.

The post-run audit verified all 23 full traces and the preserved partial failure, whitelisted model states, causal sensor timestamps, offered/selected command identity, goal/freshness admission, and identical rover/obstacle motion across each paired seed. It found no missing or truncated world journal records. Source/model identities were retained; no held-out action policy was retuned.

The earlier partial batch `reactive-held-out-v1` is excluded in full, with `EXCLUDED.json` beside its preserved evidence. Its advisor prompts mixed action selection with policy repair and emphasized a single preflight viewing goal. Advisor roles were corrected, development qualification and preflight generation repeated, and the final batch used fresh seeds 500–503. Plant, candidate logic and scoring were unchanged in that correction. The final batch's altitude failure was retained in the final results, not excluded or retried.

From the Robots World directory, with authenticated native harnesses and their executable environment variables configured:

```powershell
node --env-file=.env.jev.local experiments/reactive/run.ts --phase development --output .runtime/experiments/new-development
node --env-file=.env.jev.local experiments/reactive/run.ts --phase prepare --output .runtime/experiments/new-brief
node --env-file=.env.jev.local experiments/reactive/run.ts --phase held-out --seeds 500,501,502,503 --seconds 60 --freeze .runtime/experiments/new-development/freeze.json --brief .runtime/experiments/new-brief/brief.json --output .runtime/experiments/new-held-out
# Only if the runner stopped after a recorded envelope/empty-menu failure:
node --env-file=.env.jev.local experiments/reactive/resume.ts .runtime/experiments/new-held-out
node experiments/reactive/report.ts .runtime/experiments/new-held-out
node experiments/reactive/audit.ts .runtime/experiments/new-held-out
```

A reproduction makes fresh paid calls and is not expected to reproduce model choices or network timing exactly. For a new scientific comparison, choose fresh seeds and freeze the next design before evaluating it.

Validation: 125 default tests, 122 passed and three optional tests skipped; TypeScript check and production build passed. Browser replay controls and termination labeling were inspected. The existing Three.js bundle-size warning remains. This round exercises the experimental providers and world, not native compaction, physical hardware, PX4/ArduPilot, RGB perception, full DroneRTS gameplay, or Nervelet's own native driver qualification. The world and Nervelet cores remain unchanged. The [platform principles](../PRINCIPLES.md) and the Nervelet library's own `PRINCIPLES.md` still define their respective boundaries.
