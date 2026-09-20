# Persistent tracking qualification

Predeclared 18 September 2026, before this cohort's inference. Implements the [next experiment review](jev-next-tracking-review.md). Existing failed runs and frozen sources remain unchanged.

## Questions

1. Do goal-independent KLT tracks improve continuity/extent uncertainty compared with colour regions? Compare on fresh pixel fixtures first, including recession, occlusion, viewpoint changes, distractors, illumination, blur, and neutral objects. NanoTrack is an offline alternative, not automatically a flight dependency. Record model hashes. No real camera/board qualification is claimed without those inputs.
2. Does explicit Jev target binding simplify physical-control choices? Static paired tests compare repeated implicit selection with a preceding actual Jev target selection. Preserve the same full physical menus and all calls, including wrong/none target selections.
3. Does 60 seconds with a constant goal produce acquisition and sustained tracking? Four cells: colour/direct, KLT/direct, colour/servo, KLT/servo. All bind targets through Jev. Camera servo assistance is explicit; translation stays Jev-selected.
4. Can that arrangement recover from a five-second target occlusion, or respond to a larger-image goal? Separate 90-second cohorts, same four cells. Perturbation at 60 seconds; no goal switch in recovery runs. At 60–65 seconds an opaque simulated cover encloses the moving target. The cover follows the environment-owned target and is identical across matched arms; neither its schedule nor target geometry enters controller observations. This tests full object occlusion, not unseen metric navigation.
5. Does 20 Hz acquisition/tracking improve the two KLT controller arms relative to their 5 Hz constant-goal counterparts? Keep questions and other settings fixed. The 20 Hz request is quantized to the world's 20 ms time step; log actual acquisition intervals rather than claiming exact 50 ms spacing.

## Boundaries

Camera/rendering uses world geometry; perception receives PNG bytes, calibration, measured orientation and pixel-derived regions only. The optional Python worker uses one in-flight image and one replaceable pending image; log coalescing and processing/delivery age. Acquisition continues during inference. Current observations use the latest completed eligible perception result with its original acquisition time. Missing output remains unavailable. No blocking Python process per frame, hidden range, goal-aware detector shortlist or model-answer override.

Track statuses distinguish observed, predicted and lost. Predicted extent is not measured visible extent. Possible occlusion is a pixel/track heuristic with measured false positives, not an oracle. No predicted region is silently presented as a fresh detection. Code can maintain correspondence, timestamps and geometry; Jev binds targets and chooses follow/search/reselect/hold and translation. The direct arm also chooses discrete yaw/pitch; the servo arm computes camera corrections for the active observed region only when Jev authorizes follow. Both retain all 43,218 physical combinations for direct control. No universal confidence gate.

The simulator is an open arena with a moving target and coloured distractors; its initial target lies in all four image quadrants across seeds. Original unobserved global bounds remain a separate safety diagnostic. Camera orientation is a declared onboard estimate. No new Nervelet/world-core planner, mandatory vision package, physical hardware or native agent is introduced.

## Cohort and reporting

- Offline pixel fixtures: development before held-out, with fixed settings and separate labels. Existing failures are development evidence only.
- Static: eight development and sixteen fresh held-out images, implicit control vs actual selected-target control, plus separate missing/ambiguous/changed-goal cases.
- Development flights: two seeds (1701–1702), four cells, 60 s each. Any changes require a new recorded source freeze before held-out work.
- Held-out: eight fresh seeds (1801–1808), four cells × 60 s constant tracking; four cells × 90 s recovery; four cells × 90 s goal change. Additional two KLT cells × eight seeds × 60 s at the higher camera rate. Rotate order; use at most three simultaneous independent worlds and reject pacing lag over one second. No prompt tuning using held-out evidence.
- No retries after API/account or audit failures; preserve partial attempts. Total input-token ceiling 50M, checked before calls and batches. Exceeding it stops with retained evidence. Versioned Jev model and exact requests/responses recorded.
- Component scores: time to first 1 s centre dwell; centre/visible/apparent-size fractions from start and after 10 s; longest lock; identity changes; reacquisition after removal; collisions/bounds; image-to-application age; worker coalescing; API cost. Never-acquired runs stay in denominators. Recovery eligibility (locked before perturbation) is reported separately from all-run recovery.
- A tracking qualification pass requires first centre dwell by 20 s, at least 80% centring after 10 s, no controller failure or collisions. It does not certify size regulation, metric safety or hardware readiness. Report full image-framing and global bounds independently. A goal-change response is assessed only after the 60 s change; recovery after 65 s, with every failed acquisition still visible.
- Reconstruct all processed pixel results, exact Jev requests/mappings and applied controls. Preserve fixed-source snapshots, raw images, JSONL traces and posthoc analysis. Show results and declared assistance in the Robots World cockpit and append failures after completion.
