# Jev documentation audit and control ablation

Checked against TypeSafe's primary documentation on 18 September 2026, after the user supplied a rocket developer's explanation. The rocket's 1/2 versus 0/5 landing results are the author's reported anecdote, not independently reproduced evidence here.

## What the response got right

**255 is per Choice question, not per control cycle or request.** [Choice](https://docs.typesafe.ai/primitives/choice) recommends offering the complete relevant option set. A shortlist is not required merely because the *joint* action space exceeds 255. Our existing protocol already says per Choice, but a 53-movement menu cannot be presented as a Jev API limitation.

**Batch independent questions.** [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) demonstrates 13 questions in one request; [line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find) offers 218 line candidates in one Choice. These are two different examples. The [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling) goes further: 54 questions select a function and its closed-set arguments, then code dispatches only the selected function. This is directly relevant to robot tool calls.

**Factor the command instead of enumerating every command.** Each question is evaluated independently against shared state. It cannot see other answers from that call. Independent parameters can be composed directly; coupled decisions need conditional heads, a second round trip, or an explicitly specified joint constraint. [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) is a supported way to ask conditional heads in advance. Adding questions is not free: it costs input tokens and must fit the request budget.

**No documented fixed question-count ceiling is not an unlimited request.** The [current model page](https://docs.typesafe.ai/models) specifies 64k tokens for state plus all questions and 32k for state plus the longest question. It also lists request/token rate limits. Those explain why our verbose candidate requests could fail below 255 options; option count and context length are separate limits. We pin `jev-1.13.0` and record returned model IDs.

**Beam search and a chunk tournament are related but distinct.** The [hierarchical cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification) retains multiple paths and compares length-normalized products of edge probabilities. Splitting a large flat list into chunks and asking a final Choice over winners is a useful tournament, but is not an exhaustive search or that exact beam algorithm. Scores/probabilities are conditional on their candidate set; comparing raw top probabilities across chunks can mis-rank candidates. Ask the final comparison explicitly, and retain multiple candidates per chunk if early pruning is a concern.

**Separate local stabilization from AI decisions.** The old and new experiments use the same 50 Hz simplified velocity servo, sensor loop and command transport. Jev picks guidance setpoints at measured API cadence. This is not a 200 Hz attitude controller or a demonstrated physical-drone inner loop. [Jev's arithmetic guidance](https://docs.typesafe.ai/model-jaggedness/jev-1.13) recommends computing mathematical quantities in code. That is legitimate assistance, and its contribution needs an ablation.

**An ablation needs adequate measurement.** Removing guidance is a good test, but an unchanged score does not by itself prove the model was not deciding: redundant inputs, too few flights or an insensitive pass/fail metric can hide an effect. The rocket author's 1/2 and 0/5 are informative examples, not a precise success-rate estimate. We retain continuous framing, actual selected commands and probabilities alongside pass/fail.

## What our earlier experiment actually did

The original eight strategies remain frozen, with all poor outcomes preserved. The continuation runs the archived controller **and physics** source, rather than today's checkout. It reuses the nine non-billing flights and repeats only three documented billing blocks after the user added funds; twenty slots were previously unattempted. Original billing attempts remain in their original report and are linked from the continuation. Its combined table is conditional on service availability, not an all-attempt service-reliability score.

| Audit question | Existing implementation | Consequence |
| --- | --- | --- |
| Does code choose the mission action? | Jev's returned Choice selects the offered action; no code-written goal reward or route planner | Action selection is real inference, but assistance still matters |
| Do options already encode useful guidance? | Two camera branches calculate a one-time aim angle toward the measured/extrapolated rover | Even “raw controls” include a camera convenience; they are not fully raw control |
| Is the answer in the state? | Facts include predicted rover-relative endpoint, range, clearance and image projection | Strong computational help; report it and ablate it |
| Is the menu goal-pruned? | Only capability/envelope pruning; no obstacle/goal ranking | It is constrained control, not the full continuous action space |
| How extensive was factorization? | Two heads: movement and camera; speculative arm uses five | Too limited to test rich independent control channels |
| Was shortlisting necessary? | Score all movements, then Choice over top six × cameras | Deliberate two-call experiment, not the recommended default or a 255-option workaround |
| Was prose isolated? | Prose also removes range points and rounds state | Cannot attribute improvement solely to wording |
| Does the world pause? | No; wall-paced physics and independent acquisition continue | End-to-end sensor age matters alongside API latency |

The strongest interpretation of the old comparison is **assisted maneuver selection**, not proof that Jev reasons over arbitrary raw robot controls. Finishing its predeclared matrix preserves a useful baseline without rewriting history.

## New six-control experiment

The `experiments/jev-axes/` controller uses the existing `RobotPort`, without changes to the world core. One real API call answers:

| Question | Complete fixed values |
| --- | --- |
| East/west velocity | −1.1, −0.6, −0.2, 0, 0.2, 0.6, 1.1 m/s |
| North/south velocity | Same seven values |
| Up/down velocity | Same seven values |
| Camera heading increment | −90, −45, −15, −5, 0, 5, 15, 45, 90 degrees |
| Camera pitch increment | −30, −10, −3, 0, 3, 10, 30 degrees |
| Camera horizontal field of view | 35 or 70 degrees |

This offers **7³ × 9 × 7 × 2 = 43,218 answer tuples** per cycle through six small Choices. Values map directly to a velocity vector and one-time camera settings. There is no normalization, auto-aim, follow macro, shortlist or fallback action selected by code. Standard angle wrapping and pitch clipping are disclosed actuator semantics; clipping creates duplicate physical commands at limits. The common envelope gate can reject a whole composed command, and every rejection remains recorded. It never supplies a better command.

Two treatments differ in exactly one state field:

- `axes-raw`: complete dated sensor observations, English goal, capabilities and the last three submitted commands/tool receipts.
- `axes-geometry`: exactly the same state and options, plus current rover-relative displacement, distance and measured target bearing computed from those observations. No candidate forecast or utility score.

Target bearing is particularly helpful to camera control: it nearly supplies the pointing target. That is the assistance being measured, not hidden as “reasoning.” Both arms retain the full range cloud and use identical 0.001-unit presentation precision. Original observations are separately retained. Both choose absolute world velocities, camera increments and zoom; neither controls motor thrust or body pitch/roll.

Options use concrete directional descriptions (west/east, climb/descend, tilt up/down) alongside exact physical values. Question IDs are not relied on for instructions. Matched sensors mean identical sensor configuration and presentation rules, not identical readings after the controllers choose different trajectories. The filming objective has no image-detail or energy term, so this experiment does not establish useful zoom trade-offs or endurance planning.

Both treatments receive actual admission/rejection feedback on the next observation boundary; neither gets a suggested replacement command. The audit matches that feedback against the world's port records. Accepted does not mean applied, and a rejected command leaves the previous admitted command in force until replacement or expiry.

The frozen plant's camera yaw has gain 4 and a 120 degree/second speed limit; pitch slews at 90 degrees/second, and field of view changes immediately. Those numerical camera rates were not in the model inputs. An original manifest limitation loosely called camera settings “immediate”; that was inaccurate for yaw and pitch. The report's display correction and archived `src/devices/aim-camera.ts` identify the actual behavior. Physics was not changed.

Development uses seed 85 for twenty seconds per arm. Interface corrections, if required, use a new development folder and are documented. Held-out testing uses **951, 952, 953**, sixty seconds per arm, with order alternating by seed. Both arms are retained regardless of development score. The same moving rover, crossing obstacle, broadcast blackout, noisy/delayed observations and midpoint English goal reversal are used. These new seeds and action spaces differ from the old experiment, so do not claim a causal ranking against its eight strategies.

Primary scoring is unchanged: correct side, distance and central framing together for ≥50% of each phase after its five-second warm-up, including one continuous second, and no collisions/bounds/controller failures/delivery-guard interventions. Report each phase separately, latency, applied sensor age, rejected compositions, all API errors and tokens. Three pairs remain a small pilot.

The report reconstructs every request from the recorded delivered observation, recomposes the exact command from all six returned choices, matches it to actual admission/application and verifies paired environment trajectories. The raw model probabilities, all choices, exact instructions and underlying measurements remain visible in Jev Flight Lab. No fabricated reasoning log is presented.

## Reproduction

Explicit real-inference runs, each to a fresh directory:

```sh
node --env-file=.env.jev.local experiments/jev-strategies/resume.ts .runtime/experiments/jev-strategies-held-out-v1 .runtime/experiments/jev-strategies-resumed-v1
node --env-file=.env.jev.local experiments/jev-axes/run.ts --phase development --seeds 85 --seconds 20 --output .runtime/experiments/jev-axes-development-v1
node --env-file=.env.jev.local experiments/jev-axes/run.ts --phase held-out --seeds 951,952,953 --seconds 60 --freeze .runtime/experiments/jev-axes-development-v1/freeze.json --output .runtime/experiments/jev-axes-held-out-v1
```

Do not edit frozen sources while their flights run. Generated evidence and credentials remain ignored. API transport is replaceable only in offline unit fixtures; the live runner exposes no mock mode.

## Remaining representation question

The new geometry treatment still provides absolute bearing angles. Choosing an increment from absolute camera and target angles requires circular subtraction and coordinate interpretation, which are documented weak areas for Jev. Correct API use does not make this the optimal state representation.

The next useful **separate, predeclared** comparison is to add signed camera-relative target offsets and plain directional geometry, computed solely from delivered sensors. Keep the same six control menus, command timing and physical plant. Provide the full actuator-rate contract in every arm. Do not compute a desired mission action, prune choices using the goal or replace the model's answer. Use new seeds, record all failures and compare both selected commands and continuous framing; do not tune the frozen flights here after observing their scores.
