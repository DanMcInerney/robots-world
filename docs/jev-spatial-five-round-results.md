# Five-round Jev spatial campaign

Round 5 completed all 24 valid 120-second flights in eight fresh matched blocks (two turn-to-find, three obstacle/viewpoint, three recovery-course), including two independently qualified structural variants. Mission passes: 0/24. Bare / verbs / verbs without explicit bearings discovered blue in 5/8, 4/8, 3/8 flights; visible seconds 73.30, 34.25, 76.35; framed seconds 0.00, 3.65, 0.20; contact flights 2/8, 7/8, 5/8. No final flight violated the operating envelope. Verbs minus bare visibility wins/losses/ties: 2/3/3; explicit-bearing removal minus verbs: 3/2/3. The pilot wording change did not establish reliable search, safe following or recovery. Removing explicit current image bearings did not demonstrate their necessity in this small failing controller; appearance, size, clipping, own pose, object order and prior action receipts remain indirect cues. This is not evidence that spatial information is unnecessary. No policy was tuned on final results.

| Final arm (8 flights each) | Discovery | Visible s / 960 s | Centered s | Framed s | Contact flights | Mission passes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bare factored numeric | 5/8 | 73.30 | 16.10 | 0.00 | 2/8 | 0/8 |
| Explicit control verbs | 4/8 | 34.25 | 11.55 | 3.65 | 7/8 | 0/8 |
| Verbs; explicit bearings removed | 3/8 | 76.35 | 4.60 | 0.20 | 5/8 | 0/8 |

All five adaptive rounds completed on 18 September 2026 (America/New_York):56 valid120-second flights, two retained infrastructure-invalid attempts, and440 real static component calls. Historical design entries below preserve the decisions made before each freeze.

- [Local visual campaign index](http://127.0.0.1:8870/.runtime/experiments/jev-spatial-five-rounds-v1/index.html)
- [State mirror](../.runtime/experiments/jev-spatial-five-rounds-v1/campaign-state-view.json) (authoritative immutable generations in state-checkpoints/), [request journal](../.runtime/experiments/jev-spatial-five-rounds-v1/requests.jsonl)
- [Independent review](../.runtime/experiments/jev-spatial-five-rounds-v1/review-round-01.md), [repair verification](../.runtime/experiments/jev-spatial-five-rounds-v1/review-round-01-repair-verification.md)

The exact handoff mission is repeated in every main request, with shared operating limits and control semantics. All primary controls are Jev choices. There is no automatic target-aiming servo, search sweep, planner, target-follow script, action ranking or evaluator geometry in state. The current visual target is a uniquely blue box proxy; semantic car recognition and unfamiliar-topology performance are not yet established.

The initial allocation is 8 flights per round 1–4 (two hypotheses × two arms × two matched seeds), followed by 24 final-confirmation flights. This smaller pilot preserves capacity for adaptation, replication and the eight mandatory confirmation blocks. Main flights remain 120 seconds. Global ceilings remain 160 flights, 40,000 requests and 500M input tokens including uncertain reservations. Current official price is $0.042/M input; model is pinned and checked as `jev-1.13.0`. The minimum 65,536-token reservation follows the documented 64k request limit, with larger byte-based reservations when necessary. No automatic SDK retry occurs.

## Preparation evidence

Six new fixed-observer qualification runs: two development seeds × turn-to-find, behind-wall, occlusion-course. Initial targets were absent in every delivered image. Turn and wall scenes exposed zero blue frames while waiting. Occlusion-course exposed 241/582 and 193/592 frames while waiting; passive reappearance is therefore a required counterfactual, not active recovery evidence. Target corridors, speed continuity and padded witness routes passed. Witness geometry is evaluator-only.

Two eight-second synthetic pipeline runs retained 39 raw/processed frames and 19 exact requests each; the repaired run additionally replayed acquisition ledger, own-pose metadata and request provenance. No paid inference occurred in these checks. Independent enumeration verified all 43,218 physical tuples in each of direct/joint/factored menus (129,654 mappings); no hidden policy overrides.

Tests: 176 passed, three optional Nervelet skips; typecheck/build passed. Existing build chunk-size warning persists. Browser loaded the campaign index with five explicitly unstarted rounds.

## Round 1 pre-inference design (historical)

H1 compares latest-only state against the same state plus bounded unread acquisition-side detection events. H2 compares shared explicit semantics against repeating those same semantics inside each question; both arms receive the same mission, limits, options and physical mapping. H2 is a wording-locality comparison, not missing-versus-present operating limits. Forty balanced static images per wording formulation precede the eight flights; static decisions are component diagnostics without applied actions.

## Initial scheduling note (historical)

At the first freeze, rounds 2–5 were unstarted. Their later designs were selected only after the preceding round was executed and analyzed. Completed evidence and the final confirmation plan are recorded below.

## Round 1 initial evidence and infrastructure recovery

80 real static calls completed. Both shared and repeated local semantics selected blue 40/40, turned toward blue on 3/7 needed yaw axes and 0/22 needed pitch axes. Development/evaluation splits remain in the probe report. Repeated semantics cost 384,359 tokens versus 245,159 for shared semantics. This is negative component evidence, not flight performance.

First main attempt stopped at116.58s on the inherited150MB trace cap; it is retained as infrastructure-invalid. Lossless compression of repetitive raw port observations passed a full120s synthetic qualification (585 images,289 requests,66.39MB trace,58.8ms maximum lag). A new immutable infrastructure amendment replaces only that attempt ID, preserving its case/seed/controls and every other block. No paid static request is repeated. See F34 for accounting and recovery details.

## Round 1 completed

Round1 completed: eight valid120s flights, zero acquisition/framing/mission passes; all eight envelope violations, three with contacts. 4726 raw/processed acquisitions and1555 requests reconstructed,1551 completed mappings; max lag93.1ms. H1 event retention delivered qualified synthetic glimpses but live flights generated no blue glimpse, so utility is inconclusive. H2 local semantic repetition matched shared wording on80 static calls (target40/40 each, yaw3/7, pitch0/22), with57% more static tokens; both live arms0/2. Preserve shared semantics as simpler baseline; no empirical reason to promote event ledger yet. R2 separately tests acquisition-side dated views and exact directional/named encoding of current pixel/self facts, with no new geometry or policy assistance. Global accounted1825requests,5,610,020reported tokens +262,144uncertain reserved, about $0.247 including reserve. Original invalid flight, recovery and immutable freezes retained.

[Round summary](../.runtime/experiments/jev-spatial-five-rounds-v1/round-01/summary.json), [all probe images and exact calls](http://127.0.0.1:8870/.runtime/experiments/jev-spatial-five-rounds-v1/static.html?round=1). Four canceled end-of-flight requests retain conservative reservations; no service errors. Two matched seeds per family are pilot evidence, not a universal ranking.

## Round 2 pre-inference design

R1 supports retaining shared semantics and testing representation before new geometry. H3: current facts versus identical facts plus24dated inspected views from acquisition-side memory (30s retention), no destination ranking. H4: numeric current pixel/self facts versus directional text and explicit measured-envelope comparisons; this is a representation package of identical measurements, not wording alone or new range information. The80static probes use fresh offset3400 and test object encoding only, because no own-position sensor is sampled in those component fixtures. Eight120s paired flights use fresh3401/3402behind-wall and3411/3412turn seeds. The policy menus, plant, mission, sensors and score are unchanged. Five targeted tests/typecheck and8s synthetic replay39frames/18requests passed.

## Round 2 completed

Round2: eight valid120s flights, zero framing or mission passes; all violate the declared envelope, five have contacts. H3 views yields one late49.8s acquisition versus0/2 current-only, but no useful pursuit and3.32x flight tokens. H4 numeric acquires at6.8s in one flight; words yields only a0.2s raw glimpse never delivered to Jev in one flight. Static numeric/words target40/40 each, needed yaw2/7 vs0/7, pitch1/26 vs7/26. Mixed component evidence, no basis to claim safe navigation or promote history. H3 visible-target replay selected blue9/10 but tilted up away from below-image target10/10 and narrowed view8/10. Current physical control questions say Choose only up/right/forward; literal axis wording is a candidate artifact. R3 separately compares original direct versus neutral-axis direct wording, and direct/joint/direction-magnitude neutral menus with identical43,218tuples, numeric state and fresh turn-to-find blocks. No new sensors or automatic control.

[Summary](../.runtime/experiments/jev-spatial-five-rounds-v1/round-02/summary.json). Every paired target route is identical; raw acquisition, ledger, mapping and wire replay passed. Static own-position encoding remains untested by the camera-only fixture.

## Round 3 completed

Round 3: eight valid 120s flights plus one retained service-timeout attempt. Legacy direct discovered blue in 1/2, neutral direct 0/2, neutral joint 0/2, neutral factored 2/2 at 14.8s and 13.2s. Factored totals 37.25 raw visible seconds, zero framed seconds, one contact flight and zero envelope violations. Legacy has two envelope violations; neutral/joint avoid them but one block each drives into a wall and the other hovers blind. All eight fail the mission. Factored uses 3.49x neutral-direct flight tokens. Same-seed target trajectories match across all four arms. Neutral wording removes the persistent ascent pattern but does not establish safe navigation. Decomposition enables search in two blocks without solving camera direction; blue-below requests still frequently tilt up. R4 separately tests action-verb option labels and a goal-independent image-cell encoding against numeric factored controls, on fresh obstacle/loss cases. No new metric geometry or controller assistance. Static 160 calls remain component-only; source and all valid-flight provenance replay passed.

[Summary](../.runtime/experiments/jev-spatial-five-rounds-v1/round-03/summary.json). Uncertain reservations are retained for the timeout and end-of-flight cancellations. Shared neutral baseline is one pair of flights, not independent replication in each contrast.

## Round 4 pre-inference design

R4 isolates two remaining representation candidates after factored search improved: H14 adds action verbs only to option labels, versus bare factored labels, on fresh occlusion-course 3601/3602; H15 adds a 3 by 3 image-cell representation of identical current pixel bearings for every region, versus numeric factored state, on fresh behind-wall 3611/3612. Original numeric facts remain in H15; it is encoding, not added range. No combination of the two treatments is used. Three formulations each receive 40 fresh static camera probes (20 development and20 within-round evaluation). Eight 120s flights reverse arm order in the second block. All43,218 tuples and exactmission/limits remain; no policy rule or geometry is supplied. Grid-to-rendered-pixel and mapping checks passed. New structural fixtures retain their reviewed geometry and were integrated with two 8s synthetic runs:80 images,38 exact requests, full provenance replay, no Jev inference. Repository183 tests passed,3 optional Nervelet skips, typecheck/build passed (existing bundle-size warning). Browser preview confirms physical screens, raw images and mechanical-only attribution.

## Round 4 completed

Round 4 completed eight valid 120s flights. 0 mission passes; 1.40 raw framed seconds total. H14 verbs versus bare factored: both 2/2 versus 2/2 discoveries, 20.50 versus 10.00 visible seconds, 1.40 versus 0.00 framed seconds; 0 versus 1 contact flights and 0 versus 0 envelope violations. Verb discovery times 12.8s and81.8s versus28.2s and27.4s: mixed search evidence, not a uniform improvement. H15 grid versus numeric: 0/2 versus 0/2 discoveries; 0 versus 1 contact flights. Static120calls selected blue40/40 each; needed yaw1/11 bare,5/11 verbs,6/11 grid; pitch0/21 all. Same-seed routes match; source, raw frames, requests, ledger, choices and wire all replayed. Select verbs as a provisional confirmation candidate because its isolated comparison provides the only nonzero framing and no contacts; do not call it a complete-mission improvement. Baseline remains neutral factored numeric. R5 compares baseline, verbs, and verbs with explicit current image bearings removed on eight untouched case/seed/fixture blocks, including two qualified structural variants. Other spatial cues remain in the ablation. No tuning after the final freeze.

[Summary and development/evaluation splits](../.runtime/experiments/jev-spatial-five-rounds-v1/round-04/summary.json), [independent review](../.runtime/experiments/jev-spatial-five-rounds-v1/round04-review.md). Verbs used 1.14 times the paired baseline flight tokens. In the first verb flight only1/17 needed pitch corrections pointed toward blue; brief framing is not proof of camera comprehension.

## Round 5 pre-inference design

Final plan:24 real120s flights, three arms in each of eight untouched blocks, cyclic arm order. H16 compares neutral factored bare labels with action verbs only; H17 removes explicit current object bearings and derived grid cells from the verb candidate. Appearance, width, clipping, possible occlusion, ordering/IDs, own pose/camera and previous setpoints remain. The ablation is not all spatial-information removal. Two turn blocks use scout-v1; three wall blocks include two screen-return-v1 cases; three recovery blocks include two offset-piers-v1 cases. Structures were independently qualified on3701/3702, never these final3801–3823 blocks.184tests pass with3optional Nervelet skips; typecheck/build pass, existing bundle warning; ablation integration40raw/processed frames and19requests fully replayed without inference. No further policy adaptation on final results.

Round4 retained one stale-image command rejection after an866.5ms response; no actuator packet was admitted. This is a functioning declared freshness gate, not a service failure or substituted policy action.

R5 independent review cleared the installed source and fresh block plan. Final source is frozen; no policy adaptation will occur within confirmation. [Review](../.runtime/experiments/jev-spatial-five-rounds-v1/round05-review.md).

## Round 5 completed and final interpretation

Round 5 completed all 24 valid 120-second flights in eight fresh matched blocks (two turn-to-find, three obstacle/viewpoint, three recovery-course), including two independently qualified structural variants. Mission passes: 0/24. Bare / verbs / verbs without explicit bearings discovered blue in 5/8, 4/8, 3/8 flights; visible seconds 73.30, 34.25, 76.35; framed seconds 0.00, 3.65, 0.20; contact flights 2/8, 7/8, 5/8. No final flight violated the operating envelope. Verbs minus bare visibility wins/losses/ties: 2/3/3; explicit-bearing removal minus verbs: 3/2/3. The pilot wording change did not establish reliable search, safe following or recovery. Removing explicit current image bearings did not demonstrate their necessity in this small failing controller; appearance, size, clipping, own pose, object order and prior action receipts remain indirect cues. This is not evidence that spatial information is unnecessary. No policy was tuned on final results.

The frozen primary pass rule requires first pixel detection within 45 s, at least 30 s post-acquisition observation, at least 40% post-acquisition framed coverage, at least 2 s continuous framing, zero contacts/envelope violations/controller errors, and no scored loss longer than 20 s. Framing requires centered blue (both normalized image offsets within +/-0.3), not clipped, apparent width 8–14%, and 70-degree horizontal field of view. Durations use acquired-image coverage capped at 250 ms per sample; gaps count as unknown/loss. A scored loss is not automatically physical occlusion. No metric following distance is demanded without range sensing.

The simplest retained experimental baseline is current pixel-derived facts with own pose, corrected neutral axis wording and factored direction/magnitude choices. It supports some search and short sightings but is not a qualified find-and-follow controller. Extra events/views were not promoted: R1 had no real blue glimpses, and the earlier memory comparisons used the original problematic axis wording. Their interaction with corrected controls remains untested. Static blue selection succeeded 440/440 times across four rounds; that diagnoses a supplied blue-region label, not car recognition or camera control.

**2026-09-21 forward pointer:** this recommended baseline (factored direction/magnitude choices with neutral wording) is superseded as the leading candidate by F57–F61 and F75: code-computed per-option consequences on a small bounded menu produced the only measured framing/range/search gains found since this round, on a yaw-only bench and static search/range probes respectively. Neither has yet been tested on this document's search/obstacle topologies with the real sensor in the loop — that is what the [find-and-follow ladder](jev-find-follow-ladder.md) (F78) does next.

Jev selected search/pursuit mode, object, body translation and speed, yaw, pitch and field of view from the full 43,218 physical combinations. Code rendered/acquired RGB, extracted color/KLT/neutral regions, measured declared simulated own pose, retained permitted evidence, converted frames/units, stabilized the plant and enforced the fixed freshness gate and command lease. No search sweep, automatic target-aiming servo, follower, planner, geometric action ranking or target truth selected its actions.

Recovery evidence uses raw losses plus separate evaluator-only 1 Hz renders with screens removed and with the observer held. Physical occlusion and reacquisition occur, but passive reappearance is possible in these routes; sampled failure to reappear is not proof that an action was necessary or deliberate. All nine obstacle/viewpoint flights failed to discover blue, including the new L-screen geometry.

Accounting: 10835 real API requests, 70,113,400 reported input tokens plus 1,968,304 conservative uncertain-token reservations. At the verified campaign rate of $0.042/M, reported input costs about $2.94; including reserved uncertainty about $3.03. This is a rate-based estimate, not an invoice. Both infrastructure-invalid flights and canceled/timeout requests remain retained with uncertain calls reserved conservatively.

Simulation limits: a uniquely blue box proxy, 320×180 RGB at 5 Hz with declared delay/dropout, and noisy simulated local-position/attitude sensors. No semantic car detector, metric target range, VIO/stereo reconstruction, hardware flight or embedded-compute qualification. The run used Intel(R) Core(TM) Ultra 9 275HX, Node v24.15.0; actual perception-worker and owner memory samples are retained. Fast API responses did not make the policy reliable.

Final frozen implementation passed 184 tests with 3 optional Nervelet skips, typecheck and build. Existing bundle-size warning remains. Before source adaptation, each completed round was verified against its executable snapshot; final integrity binds every retained snapshot to authoritative state digests. The independent boundary review, exact raw requests/answers, sensor images, mapping replay and timing evidence remain available.

| Case / fixture / seed | Bare: detection / visible / framed / contacts | Verbs: detection / visible / framed / contacts | No explicit bearings: detection / visible / framed / contacts |
| --- | --- | --- | --- |
| turn-to-find / scout-v1 / 3801 | 17.80s / 13.70s / 0.00s / 616 | 48.80s / 0.80s / 0.00s / 4655 | none / 0.00s / 0.00s / 4282 |
| turn-to-find / scout-v1 / 3802 | 13.80s / 31.60s / 0.00s / 0 | none / 0.00s / 0.00s / 3620 | 33.60s / 22.05s / 0.00s / 30 |
| behind-wall / scout-v1 / 3811 | none / 0.00s / 0.00s / 0 | none / 0.00s / 0.00s / 744 | none / 0.00s / 0.00s / 1490 |
| behind-wall / screen-return-v1 / 3812 | none / 0.00s / 0.00s / 0 | none / 0.00s / 0.00s / 0 | none / 0.00s / 0.00s / 260 |
| behind-wall / screen-return-v1 / 3813 | none / 0.00s / 0.00s / 1390 | none / 0.00s / 0.00s / 1569 | none / 0.00s / 0.00s / 0 |
| occlusion-course / scout-v1 / 3821 | 62.80s / 4.00s / 0.00s / 0 | 10.20s / 14.95s / 1.40s / 206 | 10.20s / 32.55s / 0.00s / 0 |
| occlusion-course / offset-piers-v1 / 3822 | 5.60s / 16.60s / 0.00s / 0 | 5.20s / 16.70s / 2.25s / 715 | 5.20s / 21.75s / 0.20s / 0 |
| occlusion-course / offset-piers-v1 / 3823 | 23.00s / 7.40s / 0.00s / 0 | 74.00s / 1.80s / 0.00s / 484 | none / 0.00s / 0.00s / 3037 |

Each cell gives first raw detection / raw visible time / raw framed time / contact ticks (20ms); no final flight violated the envelope. All per-flight denominators, longest framing, losses and Jev-receipt delays remain in [final summary](../.runtime/experiments/jev-spatial-five-rounds-v1/round-05/summary.json) and the visual replay.

[Paired deltas](../.runtime/experiments/jev-spatial-five-rounds-v1/round-05/paired-confirmation.json), [recovery mechanisms](../.runtime/experiments/jev-spatial-five-rounds-v1/round-05/recovery-mechanisms.json), [passive observer](../.runtime/experiments/jev-spatial-five-rounds-v1/round-05/passive-observer-counterfactual.json), [bearing ablation audit](../.runtime/experiments/jev-spatial-five-rounds-v1/round-05/bearing-removal-audit.json), [final integrity](../.runtime/experiments/jev-spatial-five-rounds-v1/final-integrity-audit.json), [independent final review](../.runtime/experiments/jev-spatial-five-rounds-v1/final-review.md).
