# Live English-mission controller comparison

This experiment compares **Jev, native Claude, and their combination**. No hand-written mission policy is a competing arm. Shared code implements the same advertised drone controls for every model; it does not choose the next station or interpret incoming reports.

The aim is to learn whether an optimized Jev interface can execute an English mission more responsively than a native reasoning agent, and whether asynchronous agent advice improves it. This supersedes the scripted-policy comparison proposed in [the earlier research plan](jev-research-tests.md).

See [the first twelve live flight results](mission-results.md), including the low-effort Claude follow-up and diagnosis of a failed hybrid run.

## Action design and development optimization

The caller gives Jev the original English goal, dated observations, station descriptions, delivered reports, confirmed inspections, the running job and recent commands. The offered controls are:

- `inspect_<station>`: replace the current job, fly to the named station and acquire an inspection after arrival and a 0.5-second dwell.
- `return`: fly to base and continue monitoring.
- `hold`: cancel the job and hold position.
- `continue`: preserve the current job or remain idle.

Every advertised station stays in the menu, including stations the English mission says to avoid. Candidate generation never parses the goal or reads the evaluator's answer key. Station names, marker colors and menu order vary by seed. All three controllers can issue the same complete actions.

An inspection is a generic local skill shared by all arms. A model still has to select its target, decide whether to interrupt it, recognize completion from receipts and choose the next action. This experiment does not compare motor-level control or autonomous code authoring.

The design follows TypeSafe's advice to describe options precisely, provide a way to take no new action, and ask independent questions together where useful. It also supplies exact chronology computed in code, because the provider warns about numerical comparisons and indirection. These fields indicate when a report arrived and whether an inspection occurred afterward; they do not label a report urgent or identify the correct action. Claude receives the same computed chronology. [Choice guidance](https://docs.typesafe.ai/primitives/choice), [fan-out](https://docs.typesafe.ai/patterns/fan-out), [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

Development used 24 labeled snapshots from seeds 10–15. Each contains an initial choice, a second inspection, routine news while a job is running, or urgent news requiring interruption. Labels belong only to the scorer; they are not passed to a provider. Each variant uses real Jev API calls, with request order rotated by case.

| Development round | Plain complete actions | Structured complete actions | Operation + conditional target | Interrupt judgment + conditional actions |
| --- | ---: | ---: | ---: | ---: |
| Initial, 72 calls | 18/24 | 21/24 | 19/24 | Not run |
| Refined, 96 calls | 24/24 | 24/24 | 23/24 | 24/24 |

The refinement clarified the consequence of `continue`, supplied explicit chronology to every provider, and tested a parallel interruption judgment. It also addressed a recorded response-format incompatibility: three initial replies contained hundredth-precision probabilities totaling 0.99. The mission experiment now accepts only the narrow 0.99/1.01 rounding case when every value is quantized to hundredths, records it and preserves every returned value. Other invalid distributions still fail. The round-to-round improvement therefore is not a clean prompt-only ablation.

The frozen winner is **plain complete actions with the refined wording and chronology**: 24/24, 187.4 ms median and 266.9 ms p95 in the second development run. Three variants tied on accuracy; the predeclared tie-break selected lower measured p95. These small latency differences are not a statistically established ranking. No held-out flight was used to choose or tune the winner.

Development evidence lives in ignored `.runtime/experiments/mission-tuning-v1/` and `mission-tuning-v2/`. Preserve `optimization.json` and `optimization.jsonl` together.

## Three live controllers

| Arm | Model role |
| --- | --- |
| Jev | `jev-1.13.0` selects complete actions from the frozen interface. |
| Claude | A persistent native Claude Code session selects from the same action menu with the same goal and observations. The initial run requests `claude-opus-5`, high effort. |
| Hybrid | Jev controls continuously while a separate persistent Claude session supplies short mission advice asynchronously, initially and after radio updates. Advice carries its source timestamp; the original goal and newer observations remain authoritative. |

The native session is accessed through the installed Claude Agent SDK and uses structured responses. It has no filesystem tools or evaluator access. The assistant-message model is checked against the requested model. Native usage can include ancillary model calls, which remain visible in the trace; those must not be mistaken for a substitution of the decision model. The native harness's reported cost is recorded as reported, not asserted to be an invoice.

This isolates action selection over equal controls. It is **not** a comparison against every capability of Claude Code, the entire DroneRTS application, or a full Nervelet-driven native tool loop. No Nervelet core change is needed to perform it. The same job boundary can subsequently be connected through [the existing Nervelet integration](policy-jobs.md).

## Continuously running world

A Rapier drone uses the existing idealized acceleration servo, with independent 50 Hz odometry and a supplied site directory. The directory is an idealized known-site manifest, not image recognition. A separate simulated radio source transmits reports over the actual world communication medium with 100 ms latency. Controllers see delivery times, not the hidden event schedule.

The three mission families use marker order, report meaning or relations among station descriptions to specify required inspections. At six seconds, a message explains routine washdown. At fourteen seconds, another reports new equipment damage. The English goal calls for an inspection within ten seconds of receiving the damage report, followed by remaining inspections and return. Each episode lasts forty seconds; monitoring continues after returning.

Physics advances at 50 Hz with unpaused 1x wall pacing. A local skill streams real encoded and CRC-parsed MAVLink v2 position setpoints at 10 Hz. The MAVLink transport is in-process; no UDP link, autopilot, real camera or aircraft is qualified here.

Decisions refresh after a job/report change or after one second, with at most one outstanding control request and eighty calls per flight. Hybrid planning has its own one-request limit and four-call cap. New reports invalidate decisions based on observations preceding their delivery. Evidence older than ten seconds is rejected. Failed inference keeps the already admitted job running; there is no substitute mission policy. Stop revokes the simulated authority before joining providers.

## Outcomes and evidence

`success` requires the two base inspections in order, the newly required inspection completed within its ten-second window, return to base, no premature diversion, no forbidden station and no repeated completed inspection without a new report. Starting an inspection is not success. The evaluator is separate from the controller input.

Report event-to-command admission separately from event-to-inspection completion. Also retain provider latency, errors, discarded decisions, running native turns when reports arrive, setup time, physical trajectories and all inspection receipts. Small pilot results support hypotheses, not a general claim that one model beats another.

Each run writes a source-hashed `manifest.json`, `results.json`, per-flight summaries and per-flight JSONL containing provider inputs/results, raw MAVLink bytes, sensor events, radio events and command outcomes. Trace limits fail visibly rather than silently dropping records. Credentials and generated evidence stay outside Git.

```powershell
# Paid inference; explicit opt-in. Use a NEW output directory for each run.
node --env-file=.env.jev.local experiments/mission-run.ts --phase optimize --output .runtime/experiments/mission-tuning-new

$env:ROBOTS_CLAUDE_EXECUTABLE = (Get-Command claude).Source
node --env-file=.env.jev.local experiments/mission-run.ts --phase flights --tuning .runtime/experiments/mission-tuning-new/optimization.json --output .runtime/experiments/mission-live-new --seeds 101,202,303 --arms jev,claude,hybrid --seconds 40 --claude-model claude-opus-5 --effort high
```

Implementation: [mission contract](../experiments/mission-contract.ts), [provider adapters](../experiments/mission-providers.ts), [world and local skills](../experiments/mission-world.ts), [runner](../experiments/mission-run.ts). The normal test suite exercises these contracts without calling either provider.
