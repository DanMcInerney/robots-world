# Temporal follow-up: separate source provenance from usable coordinates

19 September 2026. **Status when this plan was written: API not run.** These are fresh fixtures and a prospective validation plan. They do not alter the current frozen [refinement campaign](jev-spatial-refinement-plan.md) or its grades. The [opt-in runner](../experiments/jev-spatial-refinement/run-temporal-next.ts) freezes these 192 requests and this document before dispatch, retains all raw responses, and shares the campaign's 3,000-request / 25-million-token limits. Execution results will be recorded in the [lessons document](design-failures.md) and the separate runtime `temporal-next/analysis.json`; this prospective plan remains preserved.

The objective is to distinguish a schema/type-label conflict from an assertion that an invalid-epoch coordinate is usable or that an old measurement is current. This question arose from development evidence, so it is a new hypothesis; the current campaign's confirmation results cannot be used to tune this follow-up.

## Why another test is needed

In the archived request `temporal-development-4-a-computed_explicit-r0`, the payload includes an aligned record tagged `transformed_old_observation`, with a null position and an old map epoch. Jev chose `historical_kind=transformed_old_observation` while also choosing `old_side=unknown`, `epoch_join=invalid`, and `present_location=unknown`. The combined question's frozen expected answer remains `unknown`. This is a real question/label disagreement, but that pattern alone does not assert a usable coordinate or current evidence. The response also answered the age question incorrectly; the regression retains that contrary evidence.

The exact [request](../.runtime/experiments/jev-spatial-refinement-v1/requests/temporal-development-4-a-computed_explicit-r0.json) and [response](../.runtime/experiments/jev-spatial-refinement-v1/responses/temporal-development-4-a-computed_explicit-r0.json) are hash-checked by the regression loader. This deliberately selected known failure is regression evidence, excluded from every fresh denominator and advancement decision. It is not silently repaired, relabeled in the original study, or scheduled for another API call.

## Matched representation and question contrasts

The [generator](../experiments/jev-spatial-refinement/temporal-next.ts) defines **192 fresh requests**: two splits × eight mirrored units × two mirror directions × three schemas × two question packs. Each cell is queried once. There is no repeat-variability estimate; mirrors, shared schemas and questions are correlated. Development and confirmation use fresh numeric instances of the same eight semantic templates, without a broad structural-transfer claim. Cases are selected mechanically by fixed template indices and parameters, never by Jev correctness.

| Schema | Valid join | Invalid join | What changes |
|---|---|---|---|
| `typed_null` | Typed transformed record with coordinates | Same typed transformed record with null coordinates | Keeps the potentially misleading type label present |
| `valid_only` | Transformed record exists | Transformed-record list is empty; explicit failed transform result retains source, times, epochs and null coordinates | Prevents a failed operation from instantiating a transformed-position record |
| `provenance_usability` | Historical source and usable coordinate result are separate | Historical source remains; coordinate result explicitly says unavailable | Separates provenance from coordinate availability |

Every schema decodes to the same source records, observation times, frame times, map epochs, ego-motion, transform operation/status/failure/coordinates, age threshold, current measurements and motion hypotheses. All receive the same computed coordinates and epoch check. A failed join never supplies a current-map coordinate. Original source acquisition is retained even when the requested frame time is current.

The typed-null arm retains the old null/type convention but now also receives the same explicit transform-result status supplied in the other schemas. It is therefore a controlled fresh variant, **not an exact replay of the original payload**. This common computed status removes information inequality from the schema comparison; it also limits attribution to record layout and labels after that assistance is present. The archived regression preserves the exact original request.

Raw coordinates are not an extra arm here. Every schema receives declared geometric and epoch-check assistance; any motion-hypothesis coordinates are common synthetic assumption-based assistance. There is no target truth unavailable to another schema, action ranking or control policy.

| Question pack | Common heads | Specific heads and meaning | Grading |
|---|---|---|---|
| `fused` | Eight identical heads: old-point side, present location, current source, hypothesis source, age, epoch join, hypothesis validity and acquisition clock | Original combined `historical_kind` question and four criteria, preserved verbatim | A valid join gives transformed-old; an invalid join gives unknown |
| `separate` | The same eight heads, with byte-identical instructions and criteria | `historical_origin` asks only how p7 was acquired; `historical_position_usable` asks only whether its old physical point has an established coordinate in the current frame | Origin remains historical even after reset; coordinate usability follows the join |

All questions are independent and cannot consume sibling answers. The two packs have **nine versus ten heads** and different intended outputs. Their total accuracy must never be pooled or compared as one percentage. Compare the eight common heads directly; report the combined-kind question, separate origin and separate usability with their own denominators. Origin is deliberately historical for every p7 in this battery; a perfect origin score alone cannot establish general provenance discrimination. Current and hypothesis source heads provide separate controls.

Fresh instances cover valid and invalid epochs, young and stale history, present and absent detections, translated and rotated old points, active/expired/invalid-epoch/absent motion hypotheses, both sides and a centered current detection. Age, epoch and current-detection presence are crossed across the eight units. A historical-point coordinate may remain mathematically available beyond the declared age threshold; its age is scored independently and it still does not establish target location now.

## Frozen meaning of the outcomes

The prospective scorer separates these outcomes before any follow-up API execution:

- **Unsupported physical assertions:** falsely labeling a source current, inventing a current target position when no current observation exists, choosing a side for an unjoined old epoch, accepting an invalid epoch join/hypothesis, asserting an unavailable historical coordinate is usable, or replacing acquisition time with frame/decision time. Report each category and denominator separately.
- **Combined-question/type-label disagreement:** on an invalid join, the fused head says transformed-old while the same response says the old side is unknown and the epoch join invalid. This remains a wrong answer to the frozen combined question. It is reported separately from a false-current or usable-coordinate assertion.
- **Separate provenance and usability errors:** grade each head independently. A correct provenance label does not certify usable coordinates; a correct unavailable answer does not prove the model knows the source's origin.
- **Useful information retained:** old-side accuracy on valid joins, current-position accuracy where a current measurement exists, and age/hypothesis validity accuracy. An always-unknown policy cannot qualify by avoiding unsafe assertions.

The code exposes `classifyTemporalNextAnswers` for these categories. It does not overwrite or reinterpret the earlier campaign's critical-assertion count.

## Later bounded validation, still proposed

1. Independently review these three new files and the [offline checks](../test/jev-spatial-refinement-temporal-next.test.ts). Preserve original-source and request/response hashes. Freeze the exact source, serialized cases, question hash, expected answers and this objective before any dispatch; `temporalNextManifest()` provides the deterministic case and question hashes. Current status remains **NOT RUN** until actual responses exist.
2. Run at most 96 development requests under the existing pinned model and dispatcher contract: no more than two starts per second, exact requests/responses saved, no retry of unresolved calls. The entire prospective follow-up is bounded to **192 requests and 2.5 million input tokens**, including uncertain reservations; it requires a new explicit runner/freeze stage and must not be appended to the already frozen current runner.
3. **The primary candidate is preselected now, before any follow-up response: `valid_only__separate`.** The mechanistic reason is to avoid instantiating transformed-position records for failed operations and to ask provenance separately from coordinate usability. Development is diagnostic only; it cannot change this candidate or any frozen question, threshold or fresh case. Preserve its immutable ledger before confirmation. Combined-kind disagreement remains separate from physical assertions, and no claim is made that extra heads improve control.
4. Run all 96 predeclared confirmation requests without changing wording, generation or scoring. The preselected primary qualifies only with all 16 responses complete, zero unsupported physical assertions, at least 90% each on origin and usability (at least 15/16), at least 95% old-side accuracy on the eight valid-join states (8/8), and at least 95% current-location accuracy on the eight states with current observations (8/8). Complete denominators are mandatory. Report all eight common heads, including age arithmetic, individually; pooled accuracy is not a gate. Report every competing schema and both packs without retroactive promotion if the primary fails. Confirmation may reject this candidate; it cannot select a replacement winner.
5. Interpret the contrasts, not merely pass/fail. If the fused error disappears when failed operations no longer instantiate typed records, that supports a schema-affordance explanation. If splitting the question removes only the combined label disagreement while common physical assertions stay unchanged, that supports a question-meaning explanation. If unavailable coordinates or false current evidence are still asserted, the representation has a substantive evidence-boundary failure. Multiple causes may coexist; this small correlated battery cannot establish broad statistical certainty or an ideal production encoding.

Passing this finite component gate permits only a later measured-state adapter test with real source ages, resets and failed transforms. It does not qualify image reconstruction, spatial memory, navigation, physical stereo or hardware.

## Offline evidence

The tests check an independent ENU/world-coordinate transform oracle, same-atomic-fact schema projection, mirror/split allocation, invalid epoch rejection, unchanged acquisition times, independent question legality, separate outcome categories and the exact archived regression hashes. No network calls are made. The archived regression check skips explicitly when ignored runtime evidence is unavailable in another checkout; fresh fixture checks remain self-contained.
