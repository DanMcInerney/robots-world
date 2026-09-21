# Spatial-text refinement results

19 September 2026. The strongest result is **code-computed final bearing for every offered action, with one Jev decision question**: measured-target framing improved from **29% to 74%** in the timed synthetic yaw comparison. The development-selected representation reached 32/32 exact-optimum answers again on confirmation, versus 11/32 with raw geometry. Richer history did not establish a benefit. The original temporal gate failed, and every stereo matcher failed the thin-hazard gate.

This report records the completed fixed, stereo, temporal-follow-up and timed-framing studies. The accumulating decisions, failures and next tests are in [design-failures.md](design-failures.md), entries F55 onward. [Preregistered original refinement plan](jev-spatial-refinement-plan.md).

## Geometry: assistance beats additional labels or questions

| Representation / heads | Development optimum | Confirmation optimum | Confirmation wrong-direction / unnecessary out-of-view | Confirmation conditional forecasts | Mean confirmation request bytes |
|---|---:|---:|---:|---:|---:|
| raw / action-only | 10/32 | 11/32 | 7 / 6 | — | 3808 |
| raw / action-and-forecasts | 10/32 | 12/32 | 6 / 6 | 141/224 | 10324 |
| current-relations / action-only | 10/32 | 8/32 | 11 / 8 | — | 4166 |
| current-relations / action-and-forecasts | 10/32 | 8/32 | 13 / 8 | 137/224 | 10682 |
| after-bearing / action-only | 32/32 | 32/32 | 0 / 0 | — | 4939 |
| after-bearing / action-and-forecasts | 32/32 | 30/32 | 0 / 0 | 218/224 | 11455 |
| after-relations / action-only | 32/32 | 32/32 | 0 / 0 | — | 5896 |
| after-relations / action-and-forecasts | 32/32 | 32/32 | 0 / 0 | 224/224 | 12412 |

Each action denominator is two identical-request repeats of 16 states, grouped into eight mirrored units. All arms have the same stationary-target, zero-translation, immediate-full-execution assumptions and the same seven actions. The raw arm requires signed-angle arithmetic; current-relations adds present-state labels; after-bearing computes every action's resulting bearing; after-relations adds physical visibility/category labels. No action is ranked or selected by code. Optimum is stricter than merely being inside the framing band.

The immutable development choice was **after-bearing__action-only**, selected before confirmation. Its confirmation requests averaged 1,639 reported input tokens; median dispatch-to-return latency was 220ms and p95 306ms. These figures exclude capture and assembly. Additional questions do not share answers under the Jev contract; their effect is an observed request-format contrast, not evidence of joint reasoning. Fresh numeric instances within one generator do not establish broad transfer.

## Temporal evidence: coordinate arithmetic and label meaning are different errors

| Schema | Development factual answers | Confirmation factual answers | Old side, all confirmation | Old side, valid joins only | History age | Original critical flags |
|---|---:|---:|---:|---:|---:|---:|
| raw_mixed | 256/288 | 249/288 | 12/32 | 0/20 | 21/32 | 0 |
| raw_explicit | 251/288 | 252/288 | 12/32 | 0/20 | 26/32 | 0 |
| computed_mixed | 270/288 | 266/288 | 31/32 | 19/20 | 21/32 | 10 |
| computed_explicit | 271/288 | 271/288 | 31/32 | 19/20 | 28/32 | 12 |

The critical-first selector chose **raw_mixed**. It failed confirmation at 249/288 (86.5%): its 12 correct old-side answers were the invalid-epoch unknown cases, with no useful valid-frame side answers. Code-computed coordinates recovered 19/20 valid-frame sides in either schema.

The computed arms' original critical flags were fused historical-kind errors: they sometimes called a null, invalid-epoch record transformed evidence while correctly saying its old side was unknown and its epoch join invalid. No arm falsely asserted current location/source, accepted an invalid coordinate/epoch, or reset acquisition time on confirmation. All current/hypothesis-source, hypothesis-validity, epoch-join and acquisition-clock answers were correct. The original grades remain intact; a label disagreement is not recast as actual use of an invalid position. The [separate follow-up plan](jev-spatial-temporal-next.md) tests provenance and coordinate usability explicitly. Age arithmetic remains a separate weakness.

## Own history: no format earns advancement

| History representation | Static progress proxy | States with repeated-action disagreement | Mean request bytes | Mean reported input tokens |
|---|---:|---:|---:|---:|
| receipts | 17/39 | 7/24 | 5095 | 2035 |
| linked-two | 17/39 | 5/24 | 8644 | 4066 |
| linked-eight | 15/39 | 0/24 | 18210 | 9586 |
| diary-eight | 15/39 | 1/24 | 17868 | 9383 |
| tuple-eight | 14/39 | 2/24 | 16139 | 8363 |
| neutral-padding | 12/39 | 6/24 | 18210 | 3926 |

Each arm made 72 requests: three repeats of 24 fixed snapshots from earlier linked-history trajectories. Only 13 snapshots had a unique unclipped current region, so the proxy has 39 repeated answers. It reprojects measured box edges under a stationary-target/full-settle assumption; it does not observe what would actually happen after a new decision. Unscorable snapshots still enter repeat variability. The three full-history layouts preserve atomic facts. Two-card history and receipts remove information; padding matches UTF-8 bytes, not tokens or semantic neutrality. These known failures are regression evidence, not a fresh holdout. Stable repeated choices can still be consistently unhelpful.

## Stereo: useful coverage remains the limiting condition

The 56-pair matcher study produced 168 evaluations. On 36 static thin-pole pairs, SGBM5/SGBM3/BM9 falsely labeled 17/16/18 hazard sectors far. Correct-near hazard-pixel coverage was 45.5%/45.0%/40.4%; all three had zero correct-near pixels on 1px and 2px poles. BM's lower false-far pixel count accompanied more unknown output. All failed the frozen hazard/useful-coverage gate. Near textured planes and blank-image unknown controls supplied contrary positive evidence. [Matcher report](../.runtime/experiments/jev-spatial-refinement-v1/stereo/report.md).

The next 12 pairs kept four physical scenes and texture fixed across resolution. At 1280px, wider poles projected to 8px and reached 90.9–91.4% correct-near, but retained 4.3–5.2% false-far pixels. Narrower 4px poles reached only 16.9–17.7% correct-near. Processing rose to 546–710ms per pair, excluding camera capture/transport. A near sector label did not imply broad hazard coverage. This is neither a safe projected-width threshold nor a physical-camera qualification. [Resolution report](../.runtime/experiments/jev-spatial-refinement-v1/stereo-resolution/report.md).

## Evidence and accounting

All **1,200 original fixed requests completed**, with zero unresolved/HTTP/schema failures, 4,483,310 reported input tokens, and an estimated $0.1883 at the campaign's assumed $0.042/million input tokens. Later stage usage is accounted separately below. Both stereo studies used zero API calls and retained exact replay audits.

The original fixed freeze hashes 135 source files and all case bytes. The selection is sealed against a preserved 816-request development-ledger prefix. Analysis verifies live scoring-source identity, exact requests/responses and selection evidence. [Analysis](../.runtime/experiments/jev-spatial-refinement-v1/fixed-analysis.json), [gates](../.runtime/experiments/jev-spatial-refinement-v1/fixed-gates.json), [selection](../.runtime/experiments/jev-spatial-refinement-v1/selection.json), [original independent review](../.runtime/experiments/jev-spatial-refinement-v1/pre-inference-review.md), [one repair/check pass](../.runtime/experiments/jev-spatial-refinement-v1/pre-inference-repairs.md).

Before the next execution gate, the repository suite passed 256 tests with five optional skips; typecheck and build passed. The separate 20s fake-judge adapter qualification completed in 20.017s with 101 acquisitions, 40 starts and 49.1ms maximum scheduling lag. Simulated timing and RGB text tests do not qualify physical flight, stereo navigation, semantic car recognition or the earlier full mission.

## Temporal follow-up: no primary promotion

All 192 fresh requests completed with 505,772 reported input tokens, under the separately enforced 192-request / 2.5-million-token ceiling. The 96-response development ledger was sealed before confirmation. The primary valid_only__separate failed useful historical-point retrieval at 6/8, despite correctly identifying origin/usability and all eligible current locations. Its two side errors were unknown on stale, successfully transformed old points.

| Schema / question pack | Valid-frame old sides | Observed current locations | Age | Fused kind, or separate origin; usability | Unsupported assertions |
|---|---:|---:|---:|---:|---:|
| provenance_usability__fused | 6/8 | 8/8 | 14/16 | 16/16 | 0 |
| provenance_usability__separate | 6/8 | 8/8 | 14/16 | 16/16; 16/16 | 0 |
| typed_null__fused | 7/8 | 8/8 | 13/16 | 16/16 | 0 |
| typed_null__separate | 8/8 | 8/8 | 12/16 | 16/16; 16/16 | 0 |
| valid_only__fused | 7/8 | 8/8 | 12/16 | 16/16 | 0 |
| valid_only__separate | 6/8 | 8/8 | 12/16 | 16/16; 16/16 | 0 |

The fused label disagreement disappeared even in typed_null, which now also receives explicit transform status. Fresh instances and common added status prevent attributing that change solely to removing typed records. typed_null__separate performed better on useful sides but was not preselected; it remains a hypothesis for another fresh test. Every arm had zero unsupported assertions; age and useful old-point retrieval remain separate weaknesses. The eight common heads are compared directly; nine- and ten-head totals are never pooled. Origin is historical in every source-p7 case, so a perfect origin score alone is not broad provenance qualification.

[Exact follow-up analysis](../.runtime/experiments/jev-spatial-refinement-v1/temporal-next/analysis.json), [frozen plan](../.runtime/experiments/jev-spatial-refinement-v1/temporal-next/plan.md), [development seal](../.runtime/experiments/jev-spatial-refinement-v1/temporal-next/development-seal.json).

## Timed control: 74% framed, versus 29% for the common baseline

All **16 trials completed**, with 623 Jev calls and no invalid replacement or retry. The selected representation framed the measured target for **118.4/160 seconds (74.0%)**, versus **46.4/160 (29.0%)** for the same receipt baseline. All eight paired framing differences were positive. Visibility was 145.0/160 versus 94.6/160 seconds.

| Pattern | Baseline framed | Selected framed | Baseline visible | Selected visible |
|---|---:|---:|---:|---:|
| stationary-offset | 18.8/40 | 39.0/40 | 21.0/40 | 40.0/40 |
| moving-car | 13.0/40 | 25.0/40 | 29.2/40 | 40.0/40 |
| transient-occlusion | 10.8/40 | 15.4/40 | 20.8/40 | 25.0/40 |
| interrupted-command | 3.8/40 | 39.0/40 | 23.6/40 | 40.0/40 |

Both conditions preserve the mission, explicit framing band, seven-action menu, two receipts, acquisition, servo, leases and execution rules. The selected arm adds code-computed bearings for every possible action under the stationary/full-settling hypothesis. Jev's actual yaw choice is copied verbatim into the engine; the adapter never ranks, filters or selects an action. No additional question was needed by the selected arm.

In stationary seed 7101, identical initial measured blue boxes lay about 21.17 degrees left of center. The baseline turned right twice and lost the target; the selected representation turned left and framed it for 19.6 seconds. This connects a recorded decision with its measured outcome. Nevertheless, occlusion seed 7120 lost visibility under the selected format (8.8 versus 10.4 seconds) while gaining framing (5.6 versus 3.8). It did not solve occlusion recovery.

The eight pairs are correlated synthetic component executions. Stationary/interruption offsets are new; moving/occlusion routes reuse earlier mirrored families. The action question is the existing framing/maintenance/reacquisition goal, rather than the synthetic minimum-bearing question. Calculations use current RGB-derived rectangles and declared simulated attitude, not stereo distance, hidden scene state or future measurements. This qualifies a useful experiment baseline, not a physical flight, navigation system or full mission.

All episodes used 20.008–20.034 seconds of wall time for 20 simulated seconds; maximum lag was 163.733ms against the frozen 250ms limit. There were 1,616 acquisitions and 15 retained, discarded late replies. An independent check of 607 command records found no command from a late reply and no post-Stop application/domain event. The inherited limitation remains: an already queued HTTP request can begin after nominal end, although its reply has no effect. Source, wire-to-engine mappings, exact responses and sealed episode inventories verify.

[All trial evidence and pairwise scores](../.runtime/experiments/jev-spatial-refinement-v1/live-results.json), [aggregate](../.runtime/experiments/jev-spatial-refinement-v1/live-summary.json), [post-Stop audit](../.runtime/experiments/jev-spatial-refinement-v1/checks/live-post-stop-audit.json), [independent integration review](../.runtime/experiments/jev-spatial-refinement-v1/integration-review.md), [one repair/check pass](../.runtime/experiments/jev-spatial-refinement-v1/integration-repairs.md).

### Passive-observer addendum, 2026-09-21

An independent design review found that the 74%/29% headline above never states the same run's own passive
(do-nothing) baseline. Recomputed here directly from `../.runtime/experiments/jev-spatial-refinement-v1/live-results.json`'s
per-trial `passiveFixedObserver` field (not restated from the review without checking): on the **moving-car**
pattern, passive framed **17.2/40 s** (8.6 s in each of two 20 s episodes) — versus the selected after-bearing
arm's 25.0/40 s and the receipt baseline's 13.0/40 s above. Passive alone beats the baseline and is not far
below the selected arm on this pattern. On **transient-occlusion**, both Jev arms saw the target *less* than
doing nothing: selected-arm visible time 25.0/40 s, baseline 20.8/40 s, passive **32.0/40 s** visible (16.0 s in
each of two 20 s episodes). On the two stationary-target patterns (stationary-offset, interrupted-command),
passive framed 0.0/40 s in both, since the target starts off-centre and a stationary drone never re-centres it.

Of the selected arm's total 72.0 s framing gain over baseline across all four patterns (118.4 vs 46.4 s),
**55.4 s (77%) comes from the two stationary-target patterns** (stationary-offset: 39.0−18.8=20.2 s;
interrupted-command: 39.0−3.8=35.2 s) rather than the moving-car/transient-occlusion patterns the mission
actually needs. This does not change any number in the table above — every framed/visible figure there is
exactly as originally measured — it adds the passive comparison and the stationary/moving split that the
original write-up omitted. See F77 in [design-failures.md](design-failures.md) and the
[find-and-follow ladder](jev-find-follow-ladder.md), which requires a passive baseline at every rung going
forward.

## Completed campaign and next direction

This refinement campaign completed **2,015 Jev calls**: 1,200 original fixed requests, 192 temporal follow-ups and 623 timed-control calls. All completed, with zero unresolved/HTTP/schema failures, **6,589,360 reported input tokens**, and an estimated **$0.2768** at the assumed $0.042/million input tokens. The timed stage accounts for 1,600,278 tokens. Offline work added **68 stereo pairs / 180 matcher evaluations**, with mechanical and exact numerical replay checks. This excludes the earlier campaign; its evidence and failed full-mission result remain intact.

The provisional control baseline is compact current sensing plus actual receipts and symmetric code-computed action consequences. The next tests should target motion and occlusion, then test small measured-outcome histories with those present-state facts held fixed. Temporal old-point retrieval and stereo hazard coverage both remain unqualified; preserve those gates rather than declaring a complete ideal spatial encoding. The [latest lessons and priority table](design-failures.md) specify falsifiable next comparisons.

Final implementation checks: **258 repository tests passed, five optional skips; typecheck and build passed**. Separately, the opt-in 20-second fake-judge qualification passed. Generated evidence and dependencies remain outside Git; no existing prior experiment source or original lessons prefix was changed.
