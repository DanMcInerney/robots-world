# Persistent tracking results

[Visual laboratory](http://127.0.0.1:8870/.runtime/experiments/jev-tracking-v1/index.html) · [predeclared plan](jev-tracking-tests.md) · [failure log](design-failures.md) · [implementation](../experiments/jev-tracking/README.md)

This round produced **73 valid real-Jev flights**, nine invalid attempts, 70 static Jev calls and 1,680 offline RGB fixtures. The planned 120-flight matrix is **incomplete**: 38 flights were never started. Two HTTP 529 service errors interrupted recovery and goal-change cohorts; concurrent high-rate execution then failed the pacing limit. Interrupted attempts and partial traces remain available in the report, separately from policy scores.

## Completed constant-goal comparison

Eight matched held-out seeds per arm, 60 seconds with the same English goal. A tracking pass means a one-second centre lock by 20 seconds, at least 80% centring after 10 seconds, and no collisions/controller errors. It does not certify the full framing goal, bounds or hardware readiness.

| Arm | Tracking passes | Centred after 10 s | Full-run framing |
| --- | ---: | ---: | ---: |
| Colour, direct Jev | 0/8 | 0% | 0% |
| KLT, direct Jev | 0/8 | 0% | 0% |
| Colour, declared camera servo | 6/8 | 80.9% | 29.3% |
| KLT, declared camera servo | 6/8 | 89.1% | 31.8% |

The servo computes continuous camera corrections from the **Jev-selected observed region**, only when Jev authorizes follow; direct control uses discrete angle choices. This is an architectural assistance comparison, not merely alternate menu wording. Jev still chooses translation. Longer tests confirm useful assisted centring, not reliable complete drone control. KLT did not improve the pass count. Some tracking passes exceeded the separate global bounds diagnostic.

## Other evidence

- **Binding:** held-out implicit control selected the correct direction on 11/19 out-of-tolerance camera axes. Binding selected the intended region on 10/16 images, then correct direction on 0/12 evaluated axes. Six unbound cases remain failures. The report preserves the earlier 3-degree diagnostic but uses calibrated goal tolerance in its summary.
- **Perception:** colour matched 693/818 visible held-out frames; KLT and Nano each matched 813/818. Neutral-edge discovery explains the 120-frame gain. KLT falsely flagged possible occlusion on 139 unobstructed frames, Nano on 62. These are synthetic-image and desktop results, not cheap-board or real-camera qualification.
- **Recovery, incomplete:** 21 valid runs, three interrupted, eight unstarted. Colour-servo regained lock in 4/5 valid runs, including 3/4 previously locked; KLT-servo in 1/5, including 0/2 previously locked. Some regain preceded new follow commands and cannot be attributed to active search. The five complete matched seeds remain identifiable.
- **Goal change, incomplete:** three complete matched seeds. After the larger-image request, full framing was 0% in both direct arms and colour-servo, 12.7% in KLT-servo. One run changed translation appropriately around the new size threshold but failed to maintain enough closing speed; see F23.
- **Higher rate, unqualified:** two concurrent worlds exceeded one second of pacing lag; the third stopped on the shared guard. A separate **synthetic-response, inference-free** 10-second single-world check stayed within 43 ms, acquired 190 frames and coalesced 12. Recorded spacing was predominantly 40/60 ms, with dropout gaps. This is not a Jev performance result. Future freezes now default to one world; explicit concurrency remains available.

## Audit and next decision

The 73 valid flights reconstructed **26,196 raw/processed images, 8,389 requests and 8,353 completed decisions**. All 8,286 checked same-goal successor images were acquired after the preceding first application. Same-seed target trajectories matched; maximum valid-flight pacing lag was 228 ms. Partial pacing traces received separate pixel/worker audits. [Analysis](../.runtime/experiments/jev-tracking-v1/analysis.json), [source verification before the subsequent runner fix](../.runtime/experiments/jev-tracking-v1/source-verification.json), [partial audits](../.runtime/experiments/jev-tracking-v1/rate20/partial-audit.json).

Next, qualify **small static/control interfaces before another large matrix**: one self-contained selected-region record, explicit conditional search controls, and measured apparent-size rates. Current parallel physical questions cannot see the sibling “search” answer: colour-direct selected search 682 times but held every axis on 679. The unbound stage also restricts searching, although it did not cause those constant-cohort failures. Preserve unknown range; do not turn geometry-derived recommendations into purported sensor evidence.

Validation: 169 tests, 166 passed and three optional Nervelet tests skipped; typecheck and build passed. Browser-checked timelines, recorded images, exact-call inspection and interrupted-attempt links. Runtime evidence, optional vision dependencies and credentials remain outside Git. No world-core or Nervelet contract changes were needed.
