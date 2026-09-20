# Round 1: temporal facts and a continuous-camera timing audit

19 September 2026. Prospective plan, before real inference. The user requested round 1 and an inspectable web replay, and questioned whether staleness matters when Jev receives continuously refreshed observations.

The hypothesis is narrow: redundant code-computed elapsed time and validity may improve Jev's decisions on otherwise identical observations. A second, descriptive experiment measures actual acquisition-to-action age under continuous sensing. New frames during a request establish that the request is a snapshot; they do not, by themselves, establish harmful staleness or explain a control failure.

## Fixed comparison

Three arms: `raw` retains acquisition/decision/expiry timestamps; `age` adds computed elapsed times and remaining command lifetime; `validity` adds explicit validity booleans derived from those same records and declared rules. No recommended action, hidden identity, future measurement, differently capable executor or action ranking is introduced.

Twelve units per development/confirmation split: eight evidence-acquisition situations and four command-authority situations. Each has two repeated requests in each of three arms: 144 probes. Evidence probes first choose depth/front/rear/keep, then receive only the selected frozen record and choose a supported following decision; all three arms incur both calls. Authority probes use one call. Maximum 240 fixed requests. Cases include useful current observations, expired records, missing appearance, unavailable acquisition, sufficient evidence and valid/expired authority. These are explicitly stipulated record fixtures, not camera range measurements. Their logical acquisition interval does not include actual API latency.

Primary treatment is `validity`; `age` is a predeclared explanatory comparison, not an arm to promote retrospectively. Advance the primary packet to further testing only if confirmation is complete, achieves at least 22/24 correct supported decisions, makes zero unsupported commitments, retains at least 90% of useful opportunities with no loss versus raw, and either gains at least three correct decisions or removes at least two unsupported commitments versus raw. An excellent tie means no demonstrated incremental benefit. Always abstain/stop must fail useful-positive checks. Report nominal versus interrupted records separately and preserve exact abstention, routing and task-resolution metrics.

## Continuous camera replay

Six real-Jev, 20-second yaw episodes: all three representations on two mirrored moving-target executions. Retain the previously successful code-computed conditional bearings, same seven complete yaw commands, same plant/lease/source-age guards, same 5 Hz image acquisition and maximum two requests per second. No latency, camera dropout or stale sample is injected into this stage. Live ages are normally young; any benefit on artificial expired-record probes is not presumed to matter here.

Use the existing independently paced RGB bench unchanged. Translation is zero, the blue box is a controlled visual target, and attitude is declared simulated telemetry. This does not establish semantic car identity, metric following, stereo, MAVLink or physical flight. The moving route is an existing mirrored family; these are new executions, not unseen routes. Reverse raw/validity order across mirrors; age remains the middle run, so order effects are not fully balanced.

Each request uses the latest delivered frame at assembly. Preserve actual assembly, HTTP dispatch/return, source acquisition, response receipt and actuator application times. Report source age at assembly and application, wall-time source age, API latency, assembly-to-HTTP waiting, how many camera frames arrived during inference, and late replies rejected without effect. Current-source validity is explicitly an assembly-time fact, never a claim about the later application time. Ordinary source-age/expiry guards remain identical in all arms.

Report framed/visible time, loss, command outcomes and timing for every episode. The six executions are a descriptive timing/control comparison, not a statistically independent proof of superiority. No advance decision is based solely on action stability or always holding. No live controller is selected using these outcomes.

## Bounds and evidence

The user has authorized hosted Jev execution for this round. Fixed maximum 240 calls plus at most 240 nominal live calls; operational ceilings 520 requests and 2,000,000 accounted input tokens, serial dispatch at no more than two per second, ten-second request deadline. Pin Jev 1.13.0. An uncertain/error call or infrastructure-invalid live episode stops dependent execution and remains recorded; no automatic retry/replacement. Operator Stop must remain effective and late responses cannot act. The inherited meter can start an already queued request after a bench episode ends; record it and claim only effect-free termination, not an unverified HTTP cutoff.

Freeze cases, prompts, source, plan, tests and replay HTML before paid calls. Seal the complete development ledger before confirmation; do not tune on results. Run targeted and repository tests, typecheck/build, a fresh pre-inference review with one coordinated repair pass, then fixed execution, raw-log analysis, independent results review and browser verification. Reviews apply to their inspected snapshots; preserve originals separately. No physical devices or unrelated existing experiments are changed.

The replay page must expose actual recorded images, play/pause/scrubbing, the selected decision's source image beside the current replay frame, exact wire requests/responses, selected/applied commands, source age and intermediate acquisitions. Fixed probes must be separately labeled as analytic records. Runtime evidence lives in ignored `.runtime/experiments/jev-round1-v1/`; durable results will be saved in `docs/jev-round1-results.md`.
