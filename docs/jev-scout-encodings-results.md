# Results: scout and range-following encoding probes

20 September 2026. **Both predeclared formal gates FAILED at confirmation.** The frozen selection rule
picked `current-only` for S (its only rival, `sector-consequences`, had the same zero harmful count but a
larger payload, so payload — not usefulness — decided a fallback among two arms neither of which had
passed) and `signed-error` for R (a perfect development score, but 4 confirmation harmful choices). No
arm is promoted, retroactively or otherwise. **The most informative descriptive result is that per-option
computed consequences are the only S representation with any directional competence at all**
(`current-only` and `view-history` scored **0/72** combined positive-family calls across both splits;
`sector-consequences` scored 50/72), and that R's compact derived scalar (`signed-error`) matched the
richer per-option representation (`after-range`) on development but not on confirmation, while
`after-range` held **116/116** useful across both splits with zero harmful choices. This run also exposed
a real flaw in this experiment's own selection rule (see below) — not just in Jev's answers.

Executed the [predeclared plan](jev-scout-encodings-plan.md) after a repaired freeze (`casesSha256`
`c4a04bc7…`; see [F75](design-failures.md) for the pre-inference review and repairs). **676/676 requests
completed, 0 errors, 0 amendments, 1,001,906 reported input tokens, $0.0421 reported cost.** Development
was sealed before confirmation (`selectionSha256` verified); confirmation completeness and the seal on
`analysis.json`/`gates.json` were verified before this write-up. Every number below is reproducible from
the sealed evidence; see [Reproduction and evidence](#reproduction-and-evidence).

## Formal outcome (predeclared gate: harmful = 0, positive/abstention rate ≥ 0.90, per-family floor ≥ 0.75, confirmation complete)

| Hypothesis | Selected arm (development rule) | Why selected | Confirmation result | Gate |
| --- | --- | --- | --- | --- |
| S | `current-only` | Development: no arm passed. Fallback = minimum harmful (tie: `current-only` and `sector-consequences`, both 0), then smallest mean payload (3,653 B vs 7,639 B) — **not** by usefulness. | 48/48 calls, 8/48 useful (0/36 positive, 8/12 abstention), 0 harmful | **FAIL** (positive rate 0.00 ≪ 0.90) |
| R | `signed-error` | Development: both `signed-error` and `after-range` passed (0 harmful, 100% useful); smallest mean payload (2,297 B vs 2,688 B) decided. | 58/58 calls, 54/58 useful, 4 harmful (r2 10/12, r4 10/12) | **FAIL** (harmful 4 > 0; abstention rate 0.889 < 0.90) |

## Descriptive tables (all arms, both splits) — exploratory, not gate verdicts

**S.** Positive = s1+s2+s3 (36 calls/split). Abstention = s4 (12 calls/split, 3 sub-cases × mirror × 2
repeats). Repeat-disagreement denominator is the count of body-groups that were *exactly* two cases (a
declared repeat pair); `current-only`'s many cross-family duplicate bodies (see
[Practical numbers](#practical-numbers-real-dispatches-not-case-counts)) collapse most of its groups to
more than two members, so fewer pairs are comparable (4 of 12, vs 24 of 24 for the other arms).

| Split | Arm | Useful/Acceptable/Harmful (of 48) | Positive (of 36) | Abstention (of 12) | s1 (12) | s2 (12) | s3 (12) | s4 (12) | Mean bytes | Mean tokens | p50/p95 ms | Repeat disagree |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| development | current-only | 8 / 24 / 0 | 0 | 8 | 0 | 0 | 0 | 8 | 3,653 | 1,223 | 185/218 | 0/4 |
| development | view-history | 8 / 24 / 1 | 0 | 8 | 0 | 0 | 0 | 8 | 5,113 | 1,849 | 193/251 | 1/24 |
| development | sector-state | 15 / 27 / 6 | 6 | 9 | 2 | 4 | 0 | 9 | 5,353 | 1,978 | 198/242 | 1/24 |
| development | sector-consequences | 39 / 44 / 0 | 29 | 10 | 12 | 12 | 5 | 10 | 7,639 | 2,924 | 193/248 | 3/24 |
| confirmation | current-only | 8 / 24 / 0 | 0 | 8 | 0 | 0 | 0 | 8 | 3,656 | 1,223 | 213/267 | 0/4 |
| confirmation | view-history | 8 / 24 / 0 | 0 | 8 | 0 | 0 | 0 | 8 | 5,117 | 1,849 | 199/262 | 0/24 |
| confirmation | sector-state | 11 / 25 / 6 | 3 | 8 | 1 | 2 | 0 | 8 | 5,356 | 1,978 | 217/295 | 2/24 |
| confirmation | sector-consequences | 31 / 40 / 0 | 21 | 10 | 8 | 12 | 1 | 10 | 7,654 | 2,930 | 214/282 | 2/24 |

**R.** Positive = r3+r4+r5 (40 calls/split). Abstention = r1+r2 (18 calls/split; r1 has 6 calls, not
mirrored — see the plan). Families abbreviated r1–r5.

| Split | Arm | Useful/Acceptable/Harmful (of 58) | Positive (of 40) | Abstention (of 18) | r1 (6) | r2 (12) | r3 (16) | r4 (12) | r5 (12) | Mean bytes | Mean tokens | p50/p95 ms | Repeat disagree |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| development | measured | 55 / 55 / 3 | 40 | 15 | 6 | 9 | 16 | 12 | 12 | 2,028 | 767 | 192/352 | 1/29 |
| development | signed-error | 58 / 58 / 0 | 40 | 18 | 6 | 12 | 16 | 12 | 12 | 2,297 | 837 | 193/258 | 0/29 |
| development | after-range | 58 / 58 / 0 | 40 | 18 | 6 | 12 | 16 | 12 | 12 | 2,688 | 1,018 | 194/251 | 0/29 |
| confirmation | measured | 52 / 52 / 6 | 38 | 14 | 6 | 8 | 16 | 10 | 12 | 2,031 | 768 | 203/284 | 0/29 |
| confirmation | signed-error | 54 / 54 / 4 | 38 | 16 | 6 | 10 | 16 | 10 | 12 | 2,300 | 839 | 199/268 | 0/29 |
| confirmation | after-range | 58 / 58 / 0 | 40 | 18 | 6 | 12 | 16 | 12 | 12 | 2,693 | 1,023 | 208/340 | 0/29 |

## A flaw this run exposed in our own selection rule

**S: "minimum harmful, then smallest payload" picked an arm with a 0% positive rate over a near-miss with
an 80.6% one.** When no development arm clears the gate, the rule (as predeclared and implemented) narrows
to the minimum-harmful pool and then picks the smallest payload inside it — it never looks at the rate
again. Here the minimum-harmful pool was `{current-only (0% positive), sector-consequences (80.6%
positive, missed only on family floors: s3 5/12 = 0.417 < 0.75)}`; payload picked the cheaper, uninformative
one. The rule did exactly what it was written to do; what it was written to do was wrong for this
situation. **Proposed fix for the next predeclared experiment (not applied here):** when no arm clears the
full gate, do not fall back to payload at all — report "no arm selected" and require a fresh discriminating
test, or, if a fallback is predeclared, fall back by the *highest* positive-and-abstention rate within the
minimum-harmful pool, with payload only as a tertiary tie-break among arms whose rates are within a small
stated margin of each other.

**R: payload tie-breaking between two perfect development arms chose the one that then failed
confirmation.** `signed-error` and `after-range` were both 58/58 useful, 0 harmful on development —
genuinely tied on the only development numbers the rule looks at. Payload picked `signed-error` (2,297 B)
over `after-range` (2,688 B). Confirmation then showed they were not equivalent: `signed-error` had 4
harmful choices (both `r2-inside-tolerance` and `r4-near-threshold` families), `after-range` had zero,
matching its development performance exactly. A perfect score on 58 development calls did not establish
equal robustness. **Proposed fix:** do not let payload alone decide between two arms tied at a perfect
development score; require either a minimum margin of held-out cases before trusting the tie, or predeclare
that a payload tie-break among *perfect* arms is itself flagged as a lower-confidence selection and
reported as such before confirmation, rather than treated identically to an ordinary smallest-payload
win.

Both proposals are for the *next* predeclared experiment. Applying either retroactively here would be
exactly the tuning-on-results this repo's discipline forbids; the formal result stands as reported above:
**both gates failed.**

## Post-score diagnostics

Computed from the sealed responses only (no new requests; see
[Reproduction and evidence](#reproduction-and-evidence) for the exact reproduction method); recorded at
[`.runtime/experiments/jev-scout-encodings-v1/post-score-diagnostics.json`](../.runtime/experiments/jev-scout-encodings-v1/post-score-diagnostics.json),
which states the `analysis.json` SHA-256 (`b80a9ba1b7…`) it was computed from. It tabulates every
non-useful answer in `sector-consequences` (all S families, both splits: 26 rows) and in
`signed-error`/`measured` (both splits: 13 rows) — case id, dispatch id, what Jev chose, the useful set,
harmful flag, and the chosen option's probability/confidence from the response.

**One `s3` hold** — `s3-development-1-orig-sector-consequences-r0`
(response `S-development-sector-consequences-2c2269a38537562e311d6313-r0`): every sector already inspected;
sector 0 (`center_heading_deg: 0`) is the sole measured-`open` corridor (`toM: 6`, i.e. beyond the 2 m move
distance). The useful action was `strafe_right`. Jev chose `hold` (probability 0.31, confidence 0.24) —
its own distribution was diffuse: `yaw_left_30` 0.19, `yaw_right_90` 0.16, `turn_180` 0.13,
`strafe_right` (the useful action) only 0.12. This is `acceptable` (it does not move into blocked/unknown
clearance) but not useful.

**One `s1` confirmation miss** — `s1-confirmation-2-orig-sector-consequences-r0`
(response `S-confirmation-sector-consequences-113dd3268de880279ab84408-r0`): current heading 348°, sector 1
is the sole never-inspected sector. The useful action was `yaw_left_60`. Jev chose `yaw_left_30` with high
confidence (probability 0.78, confidence 0.78; `yaw_left_60` got only 0.15) — a correct *direction*, wrong
*magnitude*, landing short of the never-inspected heading.

**One `s4` abstention miss** — `s4c-confirmation-mirror-sector-consequences-r0`
(response `S-confirmation-sector-consequences-b5c6b701fc5532e9b8bae995-r0`): every sector inspected, every
clearance `unknown`, target not visible. The useful action was `hold` (advancing is unsupported). Jev chose
`yaw_right_90` (probability 0.37, confidence 0.30) over `hold` (0.30) — a near-tie the model resolved the
wrong way; this answer is neither useful nor acceptable, but it is not harmful either (it does not move
into unknown clearance).

**One `signed-error` harmful choice** — `r2-confirmation-1-mirror-signed-error-r0`
(response `R-confirmation-signed-error-5a9bd3f2d696ee867cf17b69-r0`): measured range 5.1 m, requested
distance 5.5 m, declared computation `signed_error_m: -0.4` ("Measured range is 0.4 m closer than the
requested distance"), which is inside the 0.5 m tolerance. The useful action was `hold`. Jev chose
`retreat_1m` (probability 0.65, confidence 0.56) — moving 1 m away pushes the range to 6.1 m, a 0.6 m
error, worse than the original 0.4 m and outside tolerance: this is the harmful case, a direct
sign-consistent but magnitude-blind reaction to "closer than requested."

## Interpretation

**Established, from this run:** (1) a memory-less current view and a chronological log of past views gave
Jev **zero** correct positive-case answers across 72 combined S calls each (development + confirmation);
whatever knowledge those cases required, neither representation delivered it in a form Jev could use — the
`s4` abstention family is the only place either arm scored above zero, and that pattern (8/12 both splits,
both arms, byte-identical answers in most cases) is consistent with defaulting toward the abstention
family's numerically common answer rather than reasoning about visibility from the (absent) state. (2)
Among S arms, only `sector-consequences` (per-offered-option consequences) showed material directional
competence (29/36 then 21/36 positive); `sector-state` (the same facts as full state, no per-option
consequences) scored far lower (6/36 then 3/36) despite carrying the identical underlying sector-memory
facts — the per-option framing, not the memory itself, is doing the work here, consistent with F57/F61's
established finding for the geometry probe. (3) On R, a compact derived scalar (`signed-error`) matched a
richer per-option representation (`after-range`) on development (both 58/58) but diverged on confirmation
(54/58 vs 58/58); the per-option representation was robust across both splits (116/116), the scalar was
not.

**Not established:** these are synthetic, stipulated facts (never a rendered camera image or an acquired
stereo measurement), one Choice call per decision with no closed loop, and 12/16 units per split with 2
mirrors × 2 repeats each — correlated instances, not independent environments. The scored policy was
stated explicitly in the prompt (`component_goal`), so this measures whether Jev can *apply a fully spelled
out rule* to the offered facts, not whether it can *discover* the rule; F52's lesson (state the criterion)
was applied here as a design choice, and this result should not be read as "Jev cannot search" in a setting
where the policy is left implicit. Nothing here establishes real-image acquisition, stereo accuracy, target
identity, closed-loop control or a full find-and-follow result.

**Contrary evidence, worth preserving:** `sector-consequences` reached 12/12 on `s1` and `s2` in
development and `s2` in confirmation — perfect scores on two of its three positive families — while
failing hardest specifically on `s3` (5/12, then 1/12). A representation that is not uniformly weak is more
informative than one that is uniformly weak, and rules out "the whole comparison is noise." Likewise `r1`
(unavailable/ambiguous range) and the `r5` wrong-side-trap family were solved at or near ceiling by every R
arm in every split (6/6 and 12/12 throughout) — the traps designed to catch a fixed-sign or largest-step
policy did not catch Jev; the R failures concentrate specifically in `r2`/`r4`, the near-tolerance-boundary
cases, not the larger-magnitude traps.

## A hypothesis for the `s3` failure, and a falsifiable next test

**Hypothesis, not demonstrated:** rule (4) of `component_goal` ("if every reachable sector is already
inspected, move only along a direction with measured OPEN clearance beyond the fixed move distance") is a
*universal* judgement over all twelve offered options at once ("is anything else better than this?"), and
the `sector-consequences` per-option text for a translation renders only `movement_direction_clearance` for
*that one option* — nothing in any single option's rendered text says "and no discovery action would help
more," so nothing local to `advance` (or whichever direction is open) distinguishes it from a `hold` or a
re-scan yaw the way an explicit per-option "resulting range" scalar distinguishes the best R option. The
`s3` failure mode observed (10/24 `hold`, 8/24 a re-scan yaw, only 6/24 the correct translate — always
correct when chosen) is consistent with Jev treating each option in isolation and finding no single option
whose own text looks conclusively better, rather than with wrong geometry (no `s3` translate choice was
into blocked/unknown clearance; the oracle never called any of the 6 chosen translates wrong).

**Proposed next test (falsifiable, not run):** identical `s3`/`s1`/`s2`/`s4` facts, fresh parameters, the
corrected selection rule above, comparing the current `sector-consequences` text against a variant that
adds two per-option-readable derived fields to every option's rendered consequence: a numeric
`new_never_inspected_heading_deg` (already computed internally by the oracle as `overlapDeg`, currently
withheld from the render) and a single top-level state flag
`never_inspected_heading_reachable_by_yaw: boolean` (true iff any yaw option would bring nonzero
never-inspected heading into view). If the hypothesis is right, this should raise `s3` from the low
single digits without changing the near-ceiling `s1`/`s2` scores or introducing new harmful `s4` cases; a
fresh `s3`-heavy case set plus an `s1`/`s2`/`s4` regression block would distinguish a genuine repair from
noise. This is a proposal for a next experiment, not a change made to the frozen cases or code described
in this document.

## Practical numbers (real dispatches, not case counts)

**`current-only`'s case-level tables above count 48+48=96 "calls," but only 40 of those were distinct real
requests** — its minimal text (heading, target-visible flag, two receipts) coincides across the `s1`/`s2`/
`s3`/`s4b` families at several parameter draws (up to 4 case ids sharing one response), so 56 of its 96
scored cases are attributed from a shared dispatch, not a fresh call. Every other arm's case count equals
its real dispatch count (no accidental duplicates). Totals below are deduplicated by dispatch id and sum
exactly to the sealed `usage.reportedTokens` (1,001,906) and `usage.requests` (676).

| Arm | Real requests | Total input tokens | Mean tokens/request | Reported cost (USD) |
| --- | --- | --- | --- | --- |
| S current-only | 40 | 48,908 | 1,222.7 | $0.00205 |
| S view-history | 96 | 177,478 | 1,848.7 | $0.00745 |
| S sector-state | 96 | 189,882 | 1,977.9 | $0.00798 |
| S sector-consequences | 96 | 280,984 | 2,926.9 | $0.01180 |
| R measured | 116 | 89,060 | 767.8 | $0.00374 |
| R signed-error | 116 | 97,212 | 838.0 | $0.00408 |
| R after-range | 116 | 118,382 | 1,020.5 | $0.00497 |
| **Total** | **676** | **1,001,906** | **1,482.0** | **$0.04208** |

`sector-consequences` costs roughly 1.5× `sector-state`'s mean tokens/request and 2.4× `current-only`'s for
the directional competence reported above; `after-range` costs about 22% more than `signed-error` per
request for the confirmation robustness reported above. Latency p50/p95 per arm/split
are in the descriptive tables; no arm exceeded 352 ms p95, well inside ordinary interactive budgets.

## Reproduction and evidence

Every number in this document is reproducible from the sealed files without any new Jev/TypeSafe request:

- `node experiments/jev-scout-encodings/run.ts analyze` recomputes `analysis.json`/`gates.json` from the
  sealed ledger and responses and is idempotent against `completion-seal.json` (it asserts unchanged bytes,
  never overwrites silently).
- The descriptive tables above are `analysis.json`'s `groups` array, filtered/sorted by
  `hypothesis`/`split`/`arm`.
- The formal outcome table is `gates.json` plus `selection.json`.
- Post-score diagnostics: the script that produced
  [`post-score-diagnostics.json`](../.runtime/experiments/jev-scout-encodings-v1/post-score-diagnostics.json)
  reads only `analysis.json`, `cases.json` and `responses/*.json`; rerunning it against the same sealed
  `analysis.json` (hash `b80a9ba1b7…`, recorded in the diagnostics file) reproduces byte-identical output.
- The "real dispatches" table deduplicates `analysis.json`'s `details` array by `dispatchId`.

Evidence: [sealed analysis](../.runtime/experiments/jev-scout-encodings-v1/analysis.json),
[gate verdicts](../.runtime/experiments/jev-scout-encodings-v1/gates.json),
[selection](../.runtime/experiments/jev-scout-encodings-v1/selection.json) +
[seal](../.runtime/experiments/jev-scout-encodings-v1/selection-seal.json),
[completion seal](../.runtime/experiments/jev-scout-encodings-v1/completion-seal.json),
[post-score diagnostics](../.runtime/experiments/jev-scout-encodings-v1/post-score-diagnostics.json),
[request ledger](../.runtime/experiments/jev-scout-encodings-v1/requests.jsonl),
[frozen source manifest](../.runtime/experiments/jev-scout-encodings-v1/freezes/fixed/freeze.json),
[predeclared plan](jev-scout-encodings-plan.md), [design-failure record (F75)](design-failures.md).
Sealed artifact hashes are unchanged by this write-up (verified: `analysis.json`
`b80a9ba1b749e29ada0d78c4392e89560f54c22b90704f33e6f62c8cc5c4e1ec`, `gates.json`
`bfffc20492d1990149b1d3481a8c0a538a5bc192c061792b96068b169c37c438`, matching `completion-seal.json`).
Generated evidence and credentials remain outside Git.

## Transfer gaps to the real sensor and scene, 2026-09-21

This run's S/R facts were stipulated fixture arithmetic (`oracle.ts`'s own header: "All geometry is stipulated
fixture arithmetic, not a sensor or a model call"), never rendered camera images or an acquired stereo
measurement, as already stated above under "Not established." Three concrete gaps found while adapting this
encoding for a real-sensor engine, verified against source:

- **The oracle assumes a 36° camera HFOV and ten 36°-wide sectors** (`experiments/jev-scout-encodings/oracle.ts:27-28`:
  `SECTOR_WIDTH_DEG = 360 / N_SECTORS` and `CAMERA_HFOV_DEG = 36`, chosen, per the file's own comment, so HFOV
  equals sector width and "covers sector k" stays unambiguous). The real `stereo-objects/2` sensor's rig is
  **70° HFOV** (`experiments/jev-round3-plan.md`'s camera rig, matching the live sensor's own detector/stereo
  pipeline). A 70° camera covers roughly two 36°-wide sectors at once, which changes both the `coveredSectors`
  geometry and the `component_goal` rule's premise that a covered sector is unambiguous; this was not tested at
  70° here.
- **No fresh-start family exists.** Every `s1` case has exactly one never-inspected sector by construction
  (`scout.ts:92-101`, cited by the reviewing pass); the very first real search decision — where most or all
  sectors are unseen and several options tie on coverage — was never generated or scored.
- **Sector memory is not re-projected under translation.** `scout.ts:23`'s sector facts are built from heading
  alone; a `translate`/`advance`/`retreat` action's effect on which physical sectors are "covered" after the
  drone has moved is not modelled, only which sector the drone currently faces.

**Correction, 2026-09-21 (second review):** an earlier version of this note claimed the ladder's L5 itself
covers 70° HFOV and a fresh-start case; at that time it did neither. The ladder now has a dedicated prerequisite
rung, **L5-pre**, a static 70°-HFOV probe run before any closed-loop L5 episode, with explicit fresh-start,
viewpoint-change and asymmetric-prior-coverage families (fixing the 36° gap and the single-never-inspected-sector
assumption above). L5's own closed-loop episodes run at the real sensor's 70° HFOV throughout. Position-aware
re-projection under translation remains unimplemented and is the reason L9's full-mission search phase is
scoped as heading-based scouting followed by binding, not a mapped occupancy search.
