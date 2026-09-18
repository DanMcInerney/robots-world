# First live Jev trials

Recorded 2026-09-17 after explicit authorization to use the locally supplied API key. These trials called the official TypeSafe API. Requested model `jev-latest` returned **`jev-1.13.0`** on every accepted answer. No Codex or Claude session was launched.

## Paired tracking comparison

Three 28-second trials, seeds 11, 29 and 47, used the same sensing, candidate actions, local guard, Rapier plant and actual MAVLink v2 encoding/CRC path as local code. Jev trials ran at monotonic wall pacing; each took about 28.02 seconds. Deterministic baselines fast-forwarded the same fixed simulation steps. Neither path uses hardware or a full autopilot.

| Measure | Local code | Live Jev selector |
| --- | ---: | ---: |
| Mean per-trial distance RMSE | 1.614 m | 1.842 m |
| Mean time within 2.5 m | 97.9% | 94.3% |
| Declared event reactions observed | 12 / 12 | 12 / 12 |
| Non-ground contact starts | 0 | 0 |
| API requests | 0 | 227 |

The target reverses lateral direction twice and disappears from tracking for two seconds. A 1.2 m commanded stand-off means zero distance error is not the objective. The open scene is not a strong collision-avoidance test.

Across 226 settled requests, client-observed response time was **182.7 ms median, 323.2 ms p95, and 699.7 ms maximum**. This includes transport, response parsing and validation; it is not isolated server inference time. Controller polling added **40.3 ms median and 94.4 ms p95** before consuming a settled result. The service deadline was 1,200 ms; no observed request exceeded it.

225 requests produced accepted choice responses, all selecting `follow`. One reply failed the adapter's validation and caused a local hold. One request was aborted when its trial ended. All three trials continued streaming 10 Hz setpoints independently of the outstanding model request. The complete retained journals have zero dropped records and zero truncated diagnostic payloads.

## Delayed and lossy tracker

A separate paired seed-11 trial added 300 ms tracker latency and 20% sample dropout. Local code achieved 1.811 m RMSE and 95.9% within-radius time; live Jev achieved **2.078 m and 88.4%**. All four declared events produced an observed response in each arm. Jev made 71 requests: 70 accepted answers and one validation rejection. Response latency was 199.0 ms median and 308.1 ms p95. This is one impairment trial, not an estimate of robustness across environments.

## Rejections, usage and limitations

Two replies across the four full live trials failed our adapter's choice-response validator. The original rejected response bodies were not retained, so the exact failed fields are unknown; the recorded error is `Malformed Jev choice response`. This is an evidence limitation, not proof of a provider defect. Two explicit, non-actuating replays of the first rejected request both passed. No validation rule was relaxed, and the runs performed no automatic HTTP retries.

Including the initial three-call connection smoke and those two replays, **303 API requests** were initiated: 300 returned validated answers, two failed response validation, and one remained pending at shutdown and was aborted. Returned usage on the validated answers totaled **489,587 input tokens and 15,900 output tokens**. Usage for rejected/aborted requests and the actual bill remain unknown. A report marks total usage unknown when any request's usage is missing; observed partial usage can still be recovered from the individual response records.

The API key was loaded from Git-ignored `.env.jev.local`. A check of the generated simulation manifests and referenced traces found no copy of it. Credentials and generated evidence remain outside Git.

Jev is fast enough to supply several bounded decisions per second in this setup. It did not improve this task over the existing local rule: both chose the same useful action, and Jev's delay made target coordinates older. The next useful comparison is behavior selection with continuous local execution, or judgment under ambiguity. These measurements do not establish native-agent speedups, semantic perception, swarm coordination or hardware readiness.

## Reproduce and inspect

```powershell
node --env-file=.env.jev.local experiments/compare.ts --live-jev --arms code-local,jev-local --seeds 11,29,47 --seconds 28 --max-calls 120 --output .runtime/experiments/jev-live-comparison.json
node --env-file=.env.jev.local experiments/compare.ts --live-jev --arms code-local,jev-local --seeds 11 --seconds 28 --max-calls 120 --sensor-latency-ms 300 --sensor-dropout 0.2 --output .runtime/experiments/jev-live-impaired.json
```

The viewer's latest manifest is a copy of the paired live comparison. It labels **Local code**, **Live Jev selector**, and any older **Simulated fast selector** distinctly. The live comparison includes response timings, raw choices/probabilities, model identity, usage, sensor evidence, actual wire frames, command admission and physical response. The 3D live inspector remains a separate episode from the recorded comparison.

- Main report: `9955da11f62d646a`, `.runtime/experiments/jev-live-comparison.json`.
- Impaired report: `6816a3a653d124c4`, `.runtime/experiments/jev-live-impaired.json`.
- Smoke: `254e2ca4fed2cfc3`, `.runtime/experiments/jev-live-smoke.json`; its three-call cap makes its full-run tracking metric unsuitable for comparison.
- Validation replay: `.runtime/experiments/jev-validation-replay.json`; two calls, no actuation.
- Experiment source hash for the main and impaired reports: `fa1cc9aaa675a98da29da161489810cb1648b56208a1ab57f0798ad3d1154ca8`.

The source was a dirty working tree based on Git revision `1e46827ff1c26b12c5bfb81a3053d97c7e604641`. Retain each manifest and its referenced trace directory together. Cloud results and arrival timings are not made deterministic by a simulation seed.
