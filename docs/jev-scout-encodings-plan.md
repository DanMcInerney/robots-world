# Scout and range-following encodings: predeclared plan

**Status update, 20 September 2026: executed; both predeclared gates failed at confirmation — see [results](jev-scout-encodings-results.md).**

20 September 2026 (revised after an independent pre-inference review found the frozen design not
ready; this revision documents the repairs applied). Status: **planned before inference; zero real
requests have been made.** The previous freeze (`casesSha256` `2fc44cf0…`, `sourceSha256` `d27065c0…`)
is **superseded before inference after review** and its runtime outputs (dry run, cases.json) were
discarded rather than reused as evidence — see F75 in design-failures.md for the review findings and
this revision's disposition of each one.

This plan follows F31, F35–F43, F48–F53, F57–F61, F63 and F67. The one encoding that repaired Jev's
spatial arithmetic so far is `after-bearing__action-only`: code computes the resulting image bearing for
every offered yaw action, unranked, and Jev still picks (F57/F59/F61). Scouting — choosing a useful
search action for an object that is not currently visible — remains unsolved (F27, F35, F43: 0/24
find-and-follow). F67 found a good stereo range still did not repair distance choice. This plan freezes
two static component probes, `S` (scouting-state encoding) and `R` (range-following encoding), that
isolate one declared representation factor at a time, mirroring F57's method.

## S: scouting-state encoding

**Question:** for an object not currently visible, which representation lets Jev choose a useful search
action?

**Sector memory.** The horizon is split into **N = 10** fixed compass sectors (36 degrees each), so the
fixed 36-degree camera field of view maps to almost exactly one sector per view. A sector's centre counts
as **in view iff it is within half the camera FOV (18 degrees) of the heading** — this ONE definition
(`coveredSectors` in `oracle.ts`) is used everywhere: which sectors are marked inspected when facts are
built, which sectors a `sector-consequences` entry reports as covered, and (for a last-seen candidate)
whether its bearing is back in view. Sector memory is built only from own heading, camera field of view
and stereo-derived nearest-surface clearance; it never reads simulator truth. Per sector: `inspected`
(`"never"` or `{age_ms}`), `clearance` (`open`/`blocked` with a distance and the clearance measurement's
own age, or `unknown`), and any `candidates` (description, bearing, range, last-seen age).

**`component_goal`** states the full scored policy, identically, in every arm's `state` (not only the
question instructions), so the goal actually entails the scored criterion instead of leaving Jev to guess
it from partial cues — this is the direct repair of the review's B1 finding (the oracle previously applied
a policy that was never told to Jev, contradicting the vaguer wording that used to be there):

> Choose the single action that satisfies this declared policy for finding or reconfirming the {target}:
> (1) If the target is confirmed visible right now, hold; every search or reposition action is wrong once
> it is already found. (2) Otherwise, if a last-seen sighting is recorded and its age is at or below 30 s,
> choose the yaw action whose resulting heading brings that sighting's recorded bearing back inside the
> camera's field of view. A sighting older than 90 s is not trustworthy and must be ignored even when no
> other lead exists. (3) Otherwise, prefer the action that brings the most never-inspected heading
> (measured in degrees, not sector count) into the camera's field of view; do not choose an action that
> merely re-inspects sectors that are already inspected. (4) If every reachable sector is already
> inspected, move only along a direction with measured OPEN clearance beyond the fixed move distance;
> moving into blocked or unknown clearance is never acceptable, in any case. (5) If no direction is open
> and no never-inspected heading remains reachable, hold rather than commit to an unsupported move or a
> redundant re-scan.

**Action menu (identical across all four arms, 12 options):** `yaw_left_30/60/90`, `turn_180`,
`yaw_right_30/60/90`, `hold`, `advance`, `retreat`, `strafe_left`, `strafe_right` (fixed 2 m step).

**Arms** (one decision question, `action`; all four render the *same* underlying facts):

| Arm | What it adds over `current-only` |
|---|---|
| `current-only` | Current heading/FOV/target-visible flag + two short command receipts (baseline; F53 found rich diaries made control worse) |
| `view-history` | + a chronological **log** of past inspected views, each with heading, FOV, age, the measured clearance from that view, and any candidate seen (bearing/range/age) — the SAME facts as `sector-state`, in log form; never-inspected sectors have no entry |
| `sector-state` | Replaces the log with the full **N=10 sector-memory array** (inspected/clearance/candidates for every sector, including never-inspected ones), no per-option consequences |
| `sector-consequences` | + for **every** offered action, unranked: which sectors the camera would cover afterward (with never/age status), and for translations the measured clearance along the motion direction |

**Known, declared floor:** `current-only` and, for clearance-dependent families (S3, S4c), `view-history`
too, cannot determine the correct movement by construction — a translation's relevant clearance is never
logged as a "past view" when it is the platform's *current* facing direction. This is expected and is
reported per-family, not concealed by pooling: the per-family floor gate (below) will fail those specific
families for those arms, which is itself part of the intended S-vs-log-vs-state comparison, not a defect.

Development, `current-only`, family `s2-seen-then-lost` (3,649 bytes; `component_goal` present in every
arm, identical per unit+mirror):

```json
{
  "model": "jev-1.13.0",
  "state": {
    "component_goal": "Choose the single action that satisfies this declared policy for finding or reconfirming the blue car: (1) If the target is confirmed visible right now, hold... (2) Otherwise, if a last-seen sighting is recorded and its age is at or below 30 s, choose the yaw action whose resulting heading brings that sighting's recorded bearing back inside the camera's field of view. A sighting older than 90 s is not trustworthy... (3) ... bring the most never-inspected heading (degrees, not sector count)... (4) ...move only along OPEN clearance... (5) ...otherwise hold.",
    "current_view": {"heading_deg": 41, "camera_hfov_deg": 36, "target_description": "blue car", "target_visible_now": false},
    "command_receipts": [{"command": "yaw_left_30", "accepted": true, "appliedMsAgo": 2400}, {"command": "hold", "accepted": true, "appliedMsAgo": 600}]
  },
  "questions": {"action": {"type": "choice", "instructions": "Choose the single action that satisfies the policy stated in state.component_goal...", "criteria": {"yaw_left_30": "...", "...": "... (12 options total)"}}}
}
```

Same state, `sector-consequences` (7,635 bytes; trimmed — full array has all 10 sectors and all 12
options). The candidate (bearing 11°, last seen 8,000 ms ago — trustworthy) is exactly why `yaw_right_30`
(resulting heading 11°) is useful, independently of sector novelty:

```json
"sector_memory": [
  {"sector_index": 0, "center_heading_deg": 0, "inspected": {"age_ms": 12000}, "clearance": {"status": "unknown"},
    "candidates": [{"description": "blue car", "bearing_deg": 11, "range_m": 11, "last_seen_age_ms": 8000}]}
],
"action_consequences": {
  "source": "Code-computed consequences for EVERY offered action under a stated immediate/full-execution hypothesis. These are conditional calculations, not observations, measured outcomes, a ranking, or a recommendation.",
  "per_option": [
    {"action": "yaw_right_30", "resulting_heading_deg": 11, "camera_covers_sectors": [{"sector_index": 0, "never_or_age": {"age_ms": 12000}}], "movement_direction_clearance": null}
  ]
}
```

**Case families** (fresh headings/offsets per unit; every unit is generated with its own mirror, reflecting
heading, sector index `i -> (10-i) mod 10`, and candidate bearing; object description alternates `blue
car` / `red backpack`; development and confirmation each use their OWN heading base, per-variant step,
offset rotation and age formula — genuinely different draws, not one shifted by a constant, per the
review's finding that the original confirmation split was a rotated/shifted copy of development):

1. **Never seen, partial coverage** (`s1-never-seen-partial`, 3 base units): exactly one sector is left
   `never` (at a rotating per-variant offset — repair of the review's finding that `turn_180` was the
   universal answer), everything else already inspected. Useful = the action(s) bringing the most
   never-inspected DEGREES into view (a single full-sector hit ties with a split multi-sector hit of the
   same total degrees — repair of the count-vs-degree bug).
2. **Seen then lost** (`s2-seen-then-lost`, 3 base units): every sector already inspected; one candidate
   with a trustworthy (<=30 s) last-seen bearing AND range, placed exactly at a reachable yaw action's
   resulting heading. Useful = the yaw action whose resulting heading contains that exact bearing (FOV
   containment, not "same nominal sector" — repair of the review's over-credit finding).
3. **All inspected, one open corridor** (`s3-open-corridor`, 3 base units): every sector already inspected;
   exactly one of advance/retreat/strafe-left/strafe-right points at OPEN clearance beyond the 2 m step,
   the rest are blocked. Useful = translate along the open direction; translating into blocked OR unknown
   clearance is harmful in **every** branch, uniformly (repair of the review's finding that this was only
   sometimes enforced).
4. **Abstention/trap controls** (`s4-abstention-controls`, 3 sub-cases):
   - `s4a`: target **currently visible now** — every search/reposition action is wrong; useful = hold.
   - `s4b`: a last-seen candidate is **stale** (120,000 ms, beyond the declared 90,000 ms ceiling) while a
     different sector (at a per-split offset, not always 180°) is never-inspected — useful = the
     never-inspected sector, not the stale bearing.
   - `s4c`: every sector inspected, **every clearance unknown** — useful = hold.

Each family × mirror = 6 instances/split × 4 arms × 2 identical repeats = 48 requests/split/family (S4 has
3 non-repeated sub-cases × mirror = 6 total, same count); **192 requests per split, 384 total** (before
dedup; see Budget).

## R: range-following encoding

**Question:** given a measured stereo surface range and a requested follow distance, which representation
lets Jev choose the right approach/retreat step (or correctly hold)?

**`component_goal`:** "Choose the single action that gets closest to the requested follow distance from the
{target}... if the measured range is unavailable or ambiguous, hold... Otherwise choose the action,
including hold, whose resulting range has the smallest absolute error from the requested distance...
An action that increases the absolute error beyond its current value is wrong; holding without improving
is acceptable only when no action reduces the error further." This matches the oracle exactly: **harmful
means an action increases |resulting error|; a hold that neither improves nor worsens is neutral, not
harmful**, repairing the review's B2 finding that a reasonable hold outside tolerance was previously
counted as harmful and could eliminate an otherwise-competent arm.

**Action menu (identical across all three arms, 5 options):** `approach_2m`, `approach_1m`, `hold`,
`retreat_1m`, `retreat_2m`. Tolerance = 0.5 m. All ranges render/compare at **0.1 m precision**, and every
"just outside tolerance" case is realistically **>=0.3 m** beyond the 0.5 m tolerance (never a 0.1 mm
boundary shave), since F67's measured stereo MAE was 0.29 m — a finer margin would test rounding noise,
not the representation.

**Arms:** `measured` (range + goal only, baseline) / `signed-error` (+ code-computed signed error, with a
**purely descriptive** side statement — "measured range is X m farther/closer than requested", no
directive verb — repairing the review's finding that "needs to close/open" contradicted the arm's own
no-recommendation disclosure) / `after-range` (+ resulting range/error for every option, unranked).

Development, family `r5-wrong-side-trap`, `after-range` (2,687 bytes) — measured 9.2 m, goal 8 m: the
large step (`approach_2m`) reduces |error| from 1.2 to 0.8 (a genuine but suboptimal improvement — NOT
harmful) while overshooting past the goal; the small step (`approach_1m`) lands at +0.2, the true optimum:

```json
{
  "state": {
    "component_goal": "Choose the single action that gets closest to the requested follow distance from the blue car... whose resulting range has the smallest absolute error... An action that increases the absolute error beyond its current value is wrong...",
    "measured_range": {"status": "valid", "range_m": 9.2}, "requested_distance_m": 8, "tolerance_m": 0.5,
    "declared_computation": {"per_option": [
      {"action": "approach_2m", "resulting_range_m": 7.2, "resulting_signed_error_m": -0.8},
      {"action": "approach_1m", "resulting_range_m": 8.2, "resulting_signed_error_m": 0.2},
      {"action": "hold", "resulting_range_m": 9.2, "resulting_signed_error_m": 1.2},
      {"action": "retreat_1m", "resulting_range_m": 10.2, "resulting_signed_error_m": 2.2},
      {"action": "retreat_2m", "resulting_range_m": 11.2, "resulting_signed_error_m": 3.2}
    ]}
  }
}
```

**Case families** (mirror reflects the signed error around zero: `measured' = 2*goal - measured`; object
description alternates; development/confirmation use disjoint parameter draws, verified collision-free
after mirroring):

1. **Unknown/invalid range** (`r1-unknown-range`, 3 units, **not mirrored** — an invalid range has no
   directional structure to reflect; mirroring it would be content-identical, so the review's "make mirrors
   meaningful or drop them and say so" is applied by generating one instance per variant instead).
2. **Inside tolerance** (`r2-inside-tolerance`, 3 units): correct = hold.
3. **Goal swap** (`r3-goal-swap`, 4 units): same measured range, two requested distances on either side.
4. **Near-threshold** (`r4-near-threshold`, 3 units): a comfortably-inside case and realistically-outside
   (>=0.3 m beyond tolerance) cases.
5. **Wrong-side traps** (`r5-wrong-side-trap`, 3 units): the largest step overshoots past the goal.

R1: 3 units/split (no mirror). R2–R5: `(3+4+3+3)=13` units × mirror(2) = 26 instances/split. Total
`3 + 26 = 29` instances/split × 3 arms × 2 repeats = **174 requests per split, 348 total** (before dedup).

## Oracle (never shown to Jev)

`experiments/jev-scout-encodings/oracle.ts` computes `useful`/`acceptable`/`harmful` from the same facts
every arm renders, using one rule set applied identically across every case (see `component_goal` above
for its plain-language statement; the two are required to match — see Independent derivation below).
Geometry is expressed with two shared primitives used consistently everywhere text is rendered, facts are
built and the oracle scores: `coveredSectors` (binary: sector centre within half the FOV) and `overlapDeg`
(continuous degrees of overlap between two equal- or unequal-width angular intervals). `oracle.ts` exports
the pure geometry helpers that `scout.ts`/`range.ts` import to render text; it does not import those
renderers, and its `Label`/`useful`/`acceptable`/`harmful` outputs are consumed only by the case
generators, never copied into a rendered `request` (`checks.ts.assertNoOracleLeak`, run on every case
before freeze, scans for this).

**Independent derivation regression** (`test/jev-scout-encodings-derivation.test.ts`): a SEPARATE, simpler
function re-derives the useful-action set purely by reading the rendered `sector-consequences` (S) /
`after-range` (R) text — not the internal `ScoutFacts`/`RangeFacts` objects — and is asserted equal to the
oracle for every frozen case in both splits. This is the regression the review asked for: stated goal,
rendered facts and keys can no longer silently drift apart.

## Design requirements met

- **Generic wording:** two object descriptions (`blue car`, `red backpack`) alternate across every family.
- **Balance:** every mirrorable unit has both a mirror and non-mirror instance; S1/S4b's target sector
  rotates across a fixed offset list per split so no single yaw action (previously `turn_180`) is the
  universal answer. Repeats (2 identical requests per case) observe variability; mirrors/repeats are
  explicitly **not** independent environments.
- **Adversarial floors** (`analyze.ts.constantPolicyStats`, exercised in
  `test/jev-scout-encodings-run.test.ts`): constant policies (always `hold`, always the first/last offered
  option, a per-family constant `turn_180` restricted to S1/S4b) all fail the gate. A "largest step" and a
  "longest option text" shortcut on `after-range` also fail; the one shortcut that IS the intended declared
  assistance — "smallest resulting |error|" — is (near-)exactly the oracle, by construction.
- **Symmetric, non-ranking consequence text:** every per-option entry carries the same field set regardless
  of label. `checks.ts` scans the ENTIRE rendered request (state, question instructions, option criteria —
  not only `state`) for ranking/recommendation vocabulary, requiring the negation that excuses it (the
  repo's own convention, e.g. "not... a ranking or a recommendation") to be in the SAME SENTENCE as the
  ranking word — not merely present somewhere in a long multi-sentence value, which the original checker
  allowed and the review flagged as too permissive.

## Selection rule and gates (predeclared, before any inference)

**Development gate** (both hypotheses, checked separately from the confirmation gate): `harmfulCount = 0`
and, computed separately, `positiveUsefulRate >= 0.90` on positive-family cases (S1/S2/S3; R3/R4/R5) AND
`abstentionCorrectRate >= 0.90` on abstention/trap-family cases (S4; R1/R2), AND a per-family floor
`usefulRate >= 0.75` in every individual family. Splitting positive from abstention, and adding the
per-family floor, repairs the review's finding that pooling could hide an arm that cannot determine a
whole family (e.g. R had 28/64 explicitly-instructed holds inflating an otherwise-mediocre arm; a third of
the old S gate needed no directional competence because `turn_180` was universally correct).

**Selection rule** (critical-error-first, smallest payload — implemented exactly as literally stated, not
narrowed further by rate): among development arms, first keep only those with the minimum harmful-action
count; among THOSE, keep every arm that ALSO clears the combined gate above (not narrowed further to "the
single best" among them) — or, if none clears it, keep every minimum-harmful arm as a fallback; among
whatever remains, pick the smallest mean request-payload bytes, then lexical arm name. The review found the
implementation had silently narrowed to "the best rate among gate-passers" before comparing payload size,
contradicting the plan text; `test/jev-scout-encodings-run.test.ts` now asserts the literal rule, including
the case where the higher-rate arm is NOT the smallest-payload one and must still lose.

**Confirmation gate:** the selected arm must again reach the full gate on the untouched confirmation split
AND be **complete** — every distinct dispatch id for that arm's confirmation cases resolved (completed, or
resolved through exactly one `-a1` amendment). `gates()` refuses to report `pass: true` on an incomplete
confirmation (the review found the prior version had no completeness check at all).

**Order:**

1. Freeze generators/oracle/plan (`run.ts freeze`).
2. Offline dry run (`run.ts dry-run`) with fabricated responses, exercising the FULL pipeline on the final
   frozen code: journal, both ceilings, `select()`, `validateSelection()` (ledger re-derivation), the `-a1`
   amendment path, `complete()` and `gates()`. Zero real requests; every synthetic artifact carries an
   explicit `synthetic: true` marker in its own content (not only a sidecar file).
3. Dispatch development (`run.ts development --real`) — one request per distinct (arm, request body,
   replicate); several different case ids sharing an identical body (e.g. a memory-less `current-only`
   scenario that coincides with another, or R1's content-identical non-mirror) share ONE real response,
   reported explicitly, never silently dropped (`dispatch.ts.duplicateBodyReport`).
4. `run.ts select` — asserts every distinct development dispatch id is resolved and that **zero
   confirmation dispatch ids have ever appeared in the ledger**, seals `selection.json` + hash.
5. Dispatch confirmation (`run.ts confirmation --real`) — `validateSelection()` first **re-derives** the
   selection from the immutable development-ledger snapshot (not merely checks selection.json's own
   hash against itself) and rejects a swapped-and-resealed selection.
6. `run.ts complete` — asserts confirmation completeness for the selected arm(s), computes final
   analysis/gates, and seals `analysis.json`/`gates.json` (`completion-seal.json`) so neither can be
   silently overwritten afterward.
7. `run.ts analyze` — per-arm/per-family tables, gate verdicts, example failures, a results-markdown
   skeleton.

**Bounded recovery rule (predeclared):** a failed dispatch is preserved exactly as it happened (never
replayed under its own id); the ledger row is marked `recovery: true`; exactly ONE fresh attempt is made
under a new `${dispatchId}-a1` id. A second failure on that id propagates and stops the whole run — no
further amendment, no blanket retry (`run.ts.dispatchAllWithAmendment`).

## Budget

**732 case objects** (384 S + 348 R — R1 is deliberately not mirrored), but the real dispatch unit is the
distinct (arm, request body, replicate): after dedup, **676 real requests planned** (338 development + 338
confirmation) — inside the target ≈600–900 range and well under the hard ceiling. Duplicate-body groups
(mostly `current-only`, where several families coincidentally render identical minimal text) are reported
exactly, not estimated, by `dispatch.ts.duplicateBodyReport` and re-verified by `run.ts qualify`.

| | Requests | Input tokens |
|---|---|---|
| Planned (post-dedup) | 676 | not yet measured (real dispatch pending) |
| Hard ceiling (enforced in `run.ts` via the shared meter) | 1,200 | 6,000,000 |

The shared meter (`experiments/jev-spatial-text/transport.ts`) journals every request before dispatch,
keeps raw responses, stops the whole run on the first HTTP/schema error or unresolved call beyond the one
predeclared `-a1` amendment (no silent retries, no replay of an uncertain/error request under the same ID),
and refuses to exceed either ceiling. `run.ts` reuses this meter, `ledger`, `readCompleted`,
`freezeStage`/`verifyFrozenStage` and `summarizeUsage` rather than reimplementing them.

## What each outcome would mean

- An S arm passing confirmation would be evidence that a particular scouting-state representation lets Jev
  choose a useful search action on these component cases — not that find-and-follow scouting is solved.
  Given the declared floor above, `current-only`/`view-history` passing would specifically mean they
  determined even the clearance-dependent families they were not expected to (a real, reportable surprise);
  their failing on S3/S4c specifically is the expected, intended outcome of this comparison, not noise.
- No S arm passing would mean sector memory (log or explicit state, with or without computed consequences)
  does not repair scouting choice at this component level even once the goal, facts and keys are internally
  consistent — a stronger conclusion than before the repair, since B1's contradiction could have explained
  a null result on its own.
- An R arm passing would extend F67's finding that good range measurement alone is not sufficient.
- No R arm passing, now that hold-outside-tolerance is no longer wrongly penalised and thresholds are
  realistic, would be stronger evidence that this specific arithmetic-assistance idea does not repair
  distance choice, rather than an artifact of an unrealistic gate.

## Limits

Component probes only: one decision question, stipulated facts, no rendered camera image, no closed loop,
no physical flight. Mirrors and repeats are correlated instances of the same construction, not independent
environments. The sector-memory model assumes stereo-derived clearance and inspection age are already
available and error-free; sensing error in a real pipeline is untested here (see F45–F47, F56, F58, F67).
Sector memory is explicitly anchored to the current position and is not re-projected for own displacement
between inspections — a declared limit, not a claim that a real implementation would work this way. This
stage makes no paid calls; a later stage executes `development --real` / `confirmation --real`.

## Known gaps carried forward from the review (not fully closed in this revision)

- The review's suggested adversarial text-shortcuts beyond "largest number"/"longest option text" (e.g. a
  general "any never sector -> turn_180" detector across all families, not just S1/S4b) were not
  exhaustively implemented; the per-family constant-policy test and the rebalanced offset rotation address
  the concrete finding (turn_180 was universal), not every conceivable shortcut.
- `current-only`'s and, for clearance-dependent families, `view-history`'s inability to determine certain
  families is treated as an intended floor reference (declared above) rather than something the encoding
  was redesigned to fix; this is a design decision, not an oversight, but is called out here explicitly.
