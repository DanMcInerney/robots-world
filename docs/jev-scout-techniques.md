# Three simple scouting techniques

Pre-inference pilot plan, 2026-09-18. This supersedes the original two-arm matrix in [scout tests](jev-scout-tests.md) for this campaign only. Earlier qualification and tracking evidence stay unchanged.

| Technique | Jev chooses | Additional help | Comparison |
| --- | --- | --- | --- |
| 1. Direct controls | Target/search/hold and all six physical controls | None beyond the same stabilized plant and image processing | Baseline |
| 2. Camera assistance | Target/search/hold, all movement, all search controls | On a Jev-selected current region only: measured-bearing camera centering and wide FOV | Camera-assistance package versus 1 |
| 3. Camera assistance + memory | Exactly the same choices as 2 | Adds bounded, dated delivered views and last-seen regions | Memory versus 2 |

The direct/assisted comparison includes removing camera questions from following branches, changed assistance wording, and wide-FOV enforcement. It tests the practical assistance package, not an isolated arithmetic operation. KLT perception has internal tracking state in **all** arms. Only arm 3 exposes retained view/region history to Jev; its missing locations explicitly remain unknown.

Same English goal, RGB camera at 5 Hz, KLT/neutral edges, noisy measured camera orientation, two recent command receipts, controls, physical world, target motion and scoring throughout. No rangefinder, true depth, complete size, target pose, map, invisible objects, planned path or recommended command enters the model. Every measured region is offered. No script searches or chooses a target. Independent questions state their conditional assumption; no answer reads a sibling answer.

One mode question plus six search questions; following uses six questions per region in arm 1 or three translation questions in arms 2–3. Each physical question has at most nine options (not a cap on the combined action). Search preserves **43,218 combinations**. For 24 regions, direct uses 151 questions, assisted 79. No shortlist is used to hide the decision.

## Frozen run matrix

- Three already mechanically qualified scenes: turn-to-find, behind-wall, occlusion-course.
- Seeds 2101 and 2102, three techniques, 120 seconds each: **18 real-Jev flights**, one at a time. These are pilot seeds, not held-out claims. No later held-out flights are part of this request's plan.
- Rotate technique order by case index plus seed index. Across six blocks every technique occupies each position twice. Scene order remains fixed, a service-time limitation.
- Freeze code, prompts, this plan, scene generation and scoring before any calls. Do not revise prompts or controls based on pilot results during the matrix.
- 500 decisions / 5M reported input tokens per flight, 60M campaign input-token ceiling. The call-level campaign guard reserves uncertain/canceled calls; a missing usage field uses the conservative reservation. The per-flight limit is checked after a response and can overshoot by one call. These are ceilings, not spending targets.
- Stop on service, schema, audit, pacing or budget failure; preserve invalid attempts and unstarted rows. Never retry uncertain calls or replace a failed seed.

Raw camera frames and exact model requests/responses/commands are replay-audited. Visible-patch scoring is unchanged: detect by 45 s, at least 30 s remaining, at least 40% full framing after first detection and 2 s continuous framing; no loss longer than 20 s, contact, bounds or controller errors. Report acquisition, visibility, framing, losses/recovery, actual search actions, motion, latency and tokens separately so a full mission failure does not hide partial progress.

The occlusion course can expose the target without searching: fixed-observer evidence is retained beside the comparison. Recovery counts alone are not causal proof of scouting. Failure in a synthetic box scene is not hardware qualification, and two seeds cannot establish a robust winner.

## Run and inspect

```powershell
node experiments/jev-scout/run.ts freeze .runtime/experiments/jev-scout-techniques-v1
node --env-file=.env.jev.local experiments/jev-scout/run.ts pilot .runtime/experiments/jev-scout-techniques-v1 --case=turn-to-find --real
# Repeat once for behind-wall and occlusion-course, only if the prior stage completed.
node experiments/jev-scout/summarize.mjs .runtime/experiments/jev-scout-techniques-v1
```

The generated index links every completed flight to the existing raw-image/3D/requests/MAVLink inspector. Exact independent review and mechanical evidence are retained separately in `.runtime/experiments/jev-scout-techniques-checks-v1`. Outcomes are appended to the design-failure log after execution.
