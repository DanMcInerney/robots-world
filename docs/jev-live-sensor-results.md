# Live streaming stereo-object sensor: what was built and measured

Updated 20 September 2026 (repair pass following an independent review; see "Failures and
repairs" below for the six findings and how each was addressed).

**A standalone Python process turns paced stereo frames into compact, goal-agnostic object
records (bearing, surface range, class, no target selection) on stdout, consumable unchanged by
nervelet's `processSource`. The missing evidence LATEST_RESULTS.md called for — a live,
continuously-fed pipeline, not a serial batch benchmark — was measured at 5, 10 and 15 Hz on 300
predeclared Round 3 frames through nervelet's real `processSource` + `SourceGroup` +
`ObservationStore`. Its detections/ranges match the batch comparison's `yolo11_current` arm
exactly, one to one in score order, on all 619 flattened object pairs across all 435 live
observations, zero mismatches. Fast-FoundationStereo (FFS) could not be exercised live in this
pass for a concrete, verified environment reason (below); SGBM, the library comparison's measured
recommendation, is the default and only live-tested backend.**

**Read this first: the latency numbers below were measured on a machine with heavy foreign GPU/CPU
load throughout (a game at ~98% GPU utilization) and are an upper bound, not a representative
measurement of the sensor's own steady-state performance — see "Machine contention" immediately
below the summary and "Failures and repairs" F1. The pipeline's correctness (schema, latest-wins
counting, equivalence to the batch baseline, stdout purity) is unaffected by contention and stands
as measured.**

This is a new capability built on top of `experiments/jev-library/` (an offline batch comparison)
and `docs/jev-library-comparison-results.md` (F74's measured recommendation: YOLO11s-seg + cached
SGBM + mask-median range). Nothing here reruns or changes that comparison; it wraps the same
reused code in a continuously-fed process and measures the pipeline no one had measured live.

## Machine contention (read before trusting any latency number)

The machine used for every GPU run in this document had a foreign GPU compute application
(`bf6.exe`, a game) running throughout, confirmed via `nvidia-smi`: **~98% GPU utilization, ~149 W
power draw**, listed under `--query-compute-apps`. This was still true when this repair pass
re-checked immediately before writing this section, so **no re-measurement was performed** — the
machine remained contended, and re-measuring contended numbers would not fix anything. A
functional (not timed) smoke run performed during this repair pass, on the still-contended
machine, shows the same signature: `detect` stage 103.6 ms versus this same sensor's own earlier
55-70 ms range, and versus the archived `yolo11_current` arm's own uncontended warm-up prediction
timings of 6.4-7.0 ms (same checkpoint, same venv) — the sensor's live `detect` timings are 8-16x
the archived warm-up figure, and vary by roughly 2x between two points in the same contended
session. A concrete same-day example inside the v1 data itself: a 21:29 smoke run of the same 5
frames measured `stereo` 62-86 ms / `total` 109-134 ms / zero skips at 5 Hz; a rerun four minutes
later of the identical 5 frames measured `stereo` 164-182 ms / `total` 243-274 ms — a ~2x swing on
identical work, only explained by changing background load. The independent review's own isolated
`CachedStereo` probe under the same game load measured 143 ms median, close to the contended
`stereo` figures below. For reference, the archived 60-frame paired benchmark
(`.runtime/experiments/jev-library-v1/benchmark/results.json`) recorded a 153 ms median / 169 ms p95
SGBM stereo stage and a 77 ms median detector-predict stage in its optimized arm, so the live
stereo stage is not far out of line with the only earlier complete-compute measurement; whether
that benchmark was itself taken on a quiet machine is not recorded. What an uncontended SGBM stage
costs on this host is therefore still unmeasured, not assumed.

**Consequence:** every absolute timing number below (per-stage ms, acquire-to-emit/receipt age,
fps) is real, measured evidence of what happened on this run, but is an **upper bound under heavy
contention**, not representative of a quiet machine. The relative shape (stereo + detect dominate;
processing time exceeds even the 5 Hz period; latest-wins skipping is real and grows with rate)
is still informative, but the specific skip-fraction and fps numbers would very likely be lower
(more headroom, fewer skips) on a quiet machine and must not be quoted as a general performance
characterization of this sensor.

**Re-measure later on a quiet machine**, one command per rate (the tool now also refuses to run at
all when contended, via `--require-quiet`, and records GPU/CPU load before and after every run
into a NEW directory so v1 evidence is never overwritten):

```powershell
$env:ROBOTS_NERVELET_MODULE = $nervelet   # see "Exact commands" below for full variable setup
foreach ($rate in 5, 10, 15) {
  node integrations/measure-stereo-objects-latency.ts --python $det --sensor-cwd (Resolve-Path experiments/jev-library) `
    --manifest $manifest --checkpoint $ckpt --detector-runtime-root $runtimeRoot --sample-ids-file $ids `
    --rate-hz $rate --out-dir .runtime/experiments/jev-live-sensor-v2/measurements --warmup-frames 5 --require-quiet
}
```

## What was built

```
experiments/jev-library/sensor/         Python streaming sensor
  clock.py             epoch-anchored, high-resolution clock (new this pass; see F2 below)
  frames.py            FrameProvider protocol + ReplayFrameProvider (latest-wins pacer)
  stereo_backend.py    StereoBackend protocol; SgbmBackend (default) + FfsBackend (declared gap)
  pipeline.py          decode -> detect -> stereo -> mask-median range -> bearing -> cross-class merge
  records.py           stdout record shapes (hello/bye/frame/failed-frame), object cap + line-size bound
  emit.py              the one owner of stdout: exactly one NDJSON line per record
  main.py              CLI wiring, replay pacing, latest-wins loop, clean shutdown, fd-level stdout protection
  testing.py            shared CPU-only test fixtures (fake/manual Detector/StereoBackend/FrameProvider)
  test_*.py             56 CPU-only, deterministic unit tests (no GPU, no weights, no network)

integrations/stereo-objects.ts                    TypeScript consumer mapper (schema v2)
integrations/measure-stereo-objects-latency.ts    Live latency measurement CLI + contention recording
test/stereo-objects.test.ts                       28 pure mapper unit tests
test/stereo-objects-real-data.test.ts             2 tests replaying a REAL GPU-run fixture (new this pass)
test/stereo-objects-process-source.test.ts        1 gated real-processSource integration test
test/jev-library-sensor.test.ts                   wires the 6 sensor test modules into `npm test` (new this pass)
test/fixtures/fake-stereo-objects-producer.mjs    fixture for the gated test
test/fixtures/real-multi-class-frames.json        32-frame slice of a real 5 Hz run (new this pass)

.runtime/experiments/jev-live-sensor-v1/equivalence_check.py   rewritten this pass (stricter, one-to-one)
docs/jev-live-sensor-results.md                   this document
```

Reused, not copied: `geometry.py` (`Geometry`, `mask_median`, bearing), `detector.py`
(`Detector`), `stereo_cached.py` (`CachedStereo`), and `learned_stereo.py` (`FastStereo`,
`read_manifest`, `calibration_from_json`) are imported by the sensor package, never duplicated.
`sensor/main.py` is 318 lines, `pipeline.py` 214, `frames.py` 156, `records.py` 138, `clock.py`
34, `emit.py` 22 — each under the ~500-line guidance, one behavior per file.

### Frame provider: replay (implemented) and live camera (not implemented, by design)

`ReplayFrameProvider` (`sensor/frames.py`) paces a fixed, ordered list of manifest samples at a
requested rate (Hz) on a background thread. It stamps each `FrameRef` with `acquired_ms`, now unix
epoch milliseconds derived from a high-resolution monotonic delta (`clock.py`; see F2), **at the
moment it is released** (independent of processing), and always overwrites a single one-slot
mailbox — **latest-wins**: a slow consumer sees the newest available frame plus a `skipped` count
of the releases it missed, never a growing queue. `FrameProvider` is a small Python `Protocol`
(`start`, `take_latest`, `wake`, `stop`) so a live camera provider can be added later without
touching the pipeline. **Not implemented in this pass.** `sensor/testing.py` also provides
`ManualFrameProvider`, a fully deterministic, synchronous test double that satisfies the same
protocol without any real-time pacing — used by tests that only care about framing/schema/error
handling, not pacing itself (see F5).

### Pipeline

Per processed frame: **decode** (`cv2.imread` the stereo pair + read/normalize calibration) ->
**detect** (`detector.py`'s `Detector.predict`, pinned YOLO11s-seg checkpoint) -> **stereo**
(`stereo_cached.CachedStereo`, default; `learned_stereo.FastStereo` optional) -> **aggregate**:
merge overlapping cross-class detections of one physical object (new this pass; see F3), then
mask-median surface range + bearing (`geometry.py`'s `mask_median`/`Geometry.bearing`, unchanged).
Every detection at or above the declared score threshold becomes one object — no target selection,
no class restricted to "car". Objects are score-sorted and capped (default top 8); a cheap,
generic `dominantColor` (mean HSV of the mask region -> a named hue bucket) is attached per
object, computed identically for every class. The whole aggregation step (including the merge) is
now under one guard that converts any unexpected exception into a `FrameProcessingError`, so one
bad frame can never crash the process (F4).

### Wire schema (`stereo-objects/2`)

**Bumped from v1 this pass** (breaking change in two fields' meaning, not just additions — see F2
and F3): the `acquired`/`emittedMs` clock semantics changed, and objects may now carry
`altClasses`. One NDJSON line per record on stdout; **all logs/warnings go to stderr only**, now
enforced at both the Python level (`sys.stdout` reassigned) and the OS file-descriptor level (fd 1
itself redirected, so native code writing raw bytes to fd 1 cannot corrupt the stream either —
see F6). First line is a `hello`; a final `bye` on clean end-of-replay (also on shutdown, also
with a truthful `reason` on a fatal error — see F4). Every other line is a frame record:

```json
{"schema":"stereo-objects/2","seq":1,"acquired":{"clock":"unix-epoch-ms","ms":1789958037190.42},
 "emittedMs":1789958037473.89,"skippedSinceLast":0,
 "objects":[{"class":"car","score":0.5445,"bearingRightRad":0.003422,"bearingUpRad":-0.009848,
   "surfaceRangeM":11.4288,"rangeValid":true,"rangeSource":"stereo:sgbm+mask_median",
   "maskPixels":3200,"boxNorm":[0.4413,0.4419,0.5636,0.5878],"dominantColor":"blue",
   "altClasses":[{"class":"truck","score":0.31}]}],
 "objectsTotal":1,"objectsTruncated":false,"valid":true,
 "timingMs":{"decode":23.0,"detect":103.6,"stereo":148.3,"aggregate":8.1,"total":283.0}}
```

(`altClasses` only present when the merge actually collapsed more than one detection; the object
above is illustrative — real single-detection frames omit it, matching the earlier example from
the initial pass.) `acquired.ms`/`emittedMs` are now **unix epoch milliseconds directly** (clock
label `"unix-epoch-ms"`), derived from `time.perf_counter_ns()` (sub-microsecond on this platform)
anchored once to `time.time_ns()` at process start — a consumer computes an age as
`Date.now() - acquired.ms` with no lookup into `hello` required (F2). `valid` is now always
present (`true` for a normal frame; `false` with `reason` for a frame that failed to process — see
F4, `failed_frame_record`). `objectsTotal` is the post-merge, pre-cap count; `objectsTruncated` is
true whenever the cap (or, defensively, the ~4 KB line-size budget) actually cut objects —
observed truncation count across all measured runs: 0 (cap/shrink logic is unit-tested directly).
Missing/invalid range is `surfaceRangeM:null` plus `rangeReason` — never a guessed number. `hello`
carries a calibration summary, full detector metadata, stereo backend name, thresholds and a
`clock.epochAnchorMs` (retained for audit; not required to interpret `acquired.ms`). `bye` carries
`processed`/`skippedTotal`/`frameErrors`/`truncatedFrames`/`reason`/`maxLineBytesSeen`.

### TypeScript consumer mapping (`integrations/stereo-objects.ts`)

`buildStereoObjectsSourceOptions(config)` returns nervelet `processSource` options without
importing nervelet at module load — the same type-only pattern as `integrations/nervelet.ts`.
Two outputs:

- **`objects`** (replaceable sample): the record's already-capped object list plus
  `seq`/`skippedSinceLast`/`objectsTotal`/**`ageAtReceiptMs`** (new this pass — `Date.now() -
  acquired.ms`, recomputable from raw evidence alone, no saved anchors needed). `acquired` is
  always the record's own acquisition clock. `valid`/`reason` follow the sensor's own fields, and
  **a record whose acquisition is older than `maxAcquisitionAgeMs` (default 5000 ms) at receipt is
  now itself published invalid with `reason:"stale_record"`** even if the sensor reported it valid
  (F2) — `ObservationStore`'s own staleness check only looks at receipt time, so a delayed-but-
  fresh-looking record could previously reach a controller as valid.
- **`object_appeared`** (small, de-duplicated reliable event stream): `AppearanceTracker` now
  keys **on spatial identity alone** (a coarse 30-degree bearing bucket) — class is deliberately
  **not** part of the key (F3): real data showed the reused, unmodified detector frequently
  relabelling one physical object `car`/`truck`/`bus` frame to frame, which the v1 class-keyed
  scheme read as a flood of distinct appearances. A fresh appearance additionally requires (a) at
  least `appearAfterAbsenceMs` (default 300 ms) of prior absence, (b) a score at or above
  `presenceScoreThreshold` (default 0.35, a hysteresis band above the sensor's typical 0.25
  `scoreThreshold`), and (c) at least `minReappearanceIntervalMs` (default 2000 ms) since that key
  last fired — a hard rate-limit floor independent of the absence check. A currently-present key
  is **never evicted** by the bounded-state cap (default 64 tracked keys; only absent entries are
  eviction candidates). Event data now carries `acquired`, `class`+`altClasses`, `surfaceRangeM`,
  `rangeValid` and `dominantColor` (F28 asked for *dated* events; v1 only sent bearing/score).
  This remains the direct, tested fix for **F28** (`docs/design-failures.md`): a 0.4 s glimpse
  that disappeared before inference still produces exactly one reliable event even if a consumer
  polls slower than the frame rate — now additionally regression-tested by replaying a real
  32-frame slice of an actual GPU run (`test/stereo-objects-real-data.test.ts`,
  `test/fixtures/real-multi-class-frames.json`) that includes 5 genuine multi-class frames, not
  just a synthetic fixture shaped to fit the tracker.

## Exact commands

Paths are relative to the repository root, where the git-ignored `.runtime/` environments, weights
and recorded frames live; from a git worktree with an empty `.runtime/`, point them at the checkout that
has them. Run from the repository root unless noted. `$det` is the pinned detector venv (Torch/Ultralytics/OpenCV; also runs the CPU-only
sensor tests — no GPU is used unless the sensor actually runs against a real checkpoint).

```powershell
$det = '.runtime\experiments\jev-library-v1\detector\.venv\Scripts\python.exe'
$manifest = '.runtime\experiments\jev-library-v1\perception-inputs.json'
$ckpt = '.runtime\experiments\jev-library-v1\detector\models\yolo11s-seg.pt'
$runtimeRoot = '.runtime\experiments\jev-live-sensor-v1\detector-runtime'   # writable; never the pinned venv
$ids = '.runtime\experiments\jev-live-sensor-v1\sample-frame-ids.txt'      # predeclared 300-frame sample
$nervelet = '<built nervelet checkout>\dist\index.js'   # a nervelet build that includes core Source/processSource

# Python unit tests (CPU-only, no GPU/weights/network) — 56 tests, this package only:
& $det -m unittest discover -s experiments/jev-library/sensor -t experiments/jev-library -p "test_*.py" -v

# All jev-library Python tests together (this package + the 5 pre-existing test_*.py files) — 121 tests:
& $det -m unittest discover -s experiments/jev-library -p "test_*.py" -v

# Same 6 sensor test modules, now ALSO wired into npm test (test/jev-library-sensor.test.ts, matching
# the existing test/jev-library.test.ts spawnSync pattern for the sibling batch-comparison tests):
npm test

# Run the sensor alone (NDJSON on stdout, logs on stderr):
Push-Location experiments/jev-library
& $det -m sensor.main --manifest $manifest --sample-ids-file "..\..\$ids" --rate-hz 10 `
    --checkpoint $ckpt --detector-runtime-root "..\..\$runtimeRoot"
Pop-Location

# Live latency measurement through real nervelet processSource+SourceGroup+ObservationStore
# (refuses to run on a contended machine unless --require-quiet is omitted; see "Machine contention"):
$env:ROBOTS_NERVELET_MODULE = $nervelet
node integrations/measure-stereo-objects-latency.ts `
    --python $det --sensor-cwd (Resolve-Path experiments/jev-library) --manifest $manifest `
    --checkpoint $ckpt --detector-runtime-root $runtimeRoot --sample-ids-file $ids --rate-hz 10 `
    --out-dir .runtime/experiments/jev-live-sensor-v1/measurements --warmup-frames 5

# Equivalence check against the archived batch arm (stricter, one-to-one method; see F6):
& $det .runtime/experiments/jev-live-sensor-v1/equivalence_check.py

# Node/TS: full suite, typecheck, build
npm test
npm run typecheck
npm run build
# Gated processSource integration test also runs when set:
$env:ROBOTS_NERVELET_MODULE = $nervelet; npm test
```

(The commands actually run for this document used bash-equivalent syntax; a named-pipe trick was
needed for manual stdin handling on the *sensor CLI itself* on this platform/shell combination —
see F6's Windows/Git-Bash stdin note below. `node integrations/measure-stereo-objects-latency.ts`
runs unflagged: Node 24 strips this file's syntax natively, same as `npm test`'s `.test.ts` files.)

## Predeclared sample and warm-up rule (fixed before measuring)

Recorded in `.runtime/experiments/jev-live-sensor-v1/measurement-plan.json` before any run. One
correction this pass (F6): the sample's route order is **alphabetical, not the manifest's own
original order** — `perception-inputs.json` itself lists routes in a different order (e.g.
`nominal-range-development-1` first); the sample-generation script explicitly sorted routes
alphabetically before selecting frames. This does not affect the sample's validity (still a fixed,
declared-before-measuring rule), only the documentation of what that rule was.

- **Sample:** every 4th frame index (0, 4, 8, ..., 96) of each of the 12 Round 3 routes, **routes
  visited in alphabetical order**, frames in ascending index order within each route — 25
  frames/route x 12 routes = **300 frames** (`sample-frame-ids.txt`).
- **Warm-up excluded from all latency/timing quantiles** (still counted in processed/skipped
  totals): the detector's own 3 blank-frame GPU warmup predictions at startup (`Detector.warmup()`,
  already part of the reused `detector.py`, run before `hello`/any real frame), plus the first 5
  real processed frames of each rate run (residual CUDA/cuDNN/allocator warmup).
- **Equivalence baseline:** the archived `yolo11_current` arm (fresh `detector.py` detections,
  same pinned checkpoint sha256/conf/imgsz/iou/max_det/retina_masks/rect/device as this sensor —
  verified by comparing `hello.model` to the arm's own recorded detector metadata — cached Round 3
  SGBM depth, which `benchmark.py`'s own paired assertion already established is bit-identical to
  a fresh `stereo_cached.CachedStereo` computation on the same inputs).
- **Equivalence tolerance:** range within `max(0.05 m, 1%)`; bearing within 0.01 rad; class must
  match exactly; mask pixel count within `max(5, 5%)`.

## Measured latency tables (SGBM, real nervelet consumer) — contended, upper bound only

**These numbers were measured under heavy foreign GPU/CPU load (see "Machine contention" above)
and were not re-measured because the machine remained contended when this repair pass checked
again. Treat every absolute figure as an upper bound, not a representative measurement.**

Consumer path used: **real nervelet `processSource` + `SourceGroup` + `ObservationStore`**
(`ROBOTS_NERVELET_MODULE` resolved the built entry at
`nervelet/.claude/worktrees/nervelet-agent-library-1abd34/dist/index.js`; the plain-NDJSON
fallback path exists in the measurement tool and was exercised implicitly by every CPU-only unit
test, but was not the path used for these numbers). GPU: **NVIDIA GeForce RTX 5090 Laptop GPU**.
CPU: **Intel(R) Core(TM) Ultra 9 275HX**. Platform: win32 10.0.26200. Raw per-frame logs (byte-
identical to the original run; verified by file hash and mtime during this repair pass — see F1):
`.runtime/experiments/jev-live-sensor-v1/measurements/{raw,summary,console}-{5,10,15}hz.{ndjson,json,log}`.

| Rate | Processed / 300 | Skipped fraction | Acquire-to-emit age (median / p95 / max) | Acquire-to-consumer-receipt age (median / p95 / max) |
| --- | --- | --- | --- | --- |
| 5 Hz | 237 | 21.0% | 344 / 453 / 593 ms | 349 / 450 / 589 ms |
| 10 Hz | 120 | 60.0% | 297 / 359 / 406 ms | 290 / 356 / 403 ms |
| 15 Hz | 78 | 74.0% | 297 / 329 / 344 ms | 297 / 339 / 356 ms |

Per-stage timing, median / p95 (never summed into a claimed total — the `total` row is the
sensor's own directly measured end-to-end per-frame figure, not a derived sum):

| Rate | decode | detect | stereo | aggregate | total |
| --- | --- | --- | --- | --- | --- |
| 5 Hz | 17.9 / 21.3 ms | 54.5 / 70.4 ms | 167.9 / 195.9 ms | 6.5 / 21.1 ms | 252.8 / 287.3 ms |
| 10 Hz | 15.4 / 20.6 ms | 56.9 / 76.0 ms | 166.4 / 186.9 ms | 6.4 / 19.7 ms | 248.9 / 282.7 ms |
| 15 Hz | 15.5 / 18.7 ms | 55.8 / 65.3 ms | 180.2 / 193.4 ms | 7.1 / 18.8 ms | 257.9 / 282.3 ms |

**Both tables are contended-machine upper bounds (see above), not a general characterization of
this sensor's performance.** Other measured figures, all three rates, structural (not timing)
evidence and therefore trustworthy regardless of contention: **max line size** 2391-2393 bytes
(well under the 4 KB budget); **object-cap truncations**: 0 in all three runs;
**malformed/oversize records at the consumer**: 0 in all three runs (`<id>.diagnostics`);
**dropped events at the consumer**: 0. The v1 **fps** figure (3.22/2.74/2.35, including model-load
overhead) and the **skip fractions** above are timing-derived and inherit the same contention
caveat; a steady-state fps figure (excluding model load, computed from the span between the first
post-warmup and last processed frame's own emission time) is implemented in the measurement tool
this pass (`processedFpsSteadyState` in each `summary-*hz.json`) but was not separately computed
for the v1 runs, since doing so would not resolve the underlying contention problem — it is
reported automatically on the next (quiet-machine) measurement.

Qualitative interpretation that survives contention: SGBM stereo and YOLO11s-seg detection
dominate per-frame cost over decode/aggregate at every rate; end-to-end processing exceeds even
the 5 Hz period, so latest-wins skipping is real and expected at every tested rate (never a
growing queue) — this qualitative shape is very unlikely to invert on a quiet machine, but the
specific percentages above should not be quoted without the contention caveat.

## Equivalence check

`equivalence_check.py` was rewritten this pass to a stricter method (F6): every live record
instance is compared (all three rate runs' observations of a frame, not deduplicated to one per
frame), each live object is **flattened** back to one flat `(class, score)` entry per its primary
class plus each `altClasses` entry (undoing the merge fix, F3, in the same score-descending order
`_merge_overlapping` already produces), then matched **one to one, in score order**, against the
archive's own score-sorted, un-merged per-detection list — a count mismatch is reported
explicitly, never silently absorbed into a many-to-one nearest-bearing match the way the initial
pass's version did.

| | Count |
| --- | --- |
| Sample frames | 300 |
| Live observations (all rate runs, not deduplicated) | 435 |
| Observations compared | 435 |
| Both report no detection | 40 |
| Live detected something the archive did not | 0 |
| Archive detected something live did not | 0 |
| Count mismatches (flattened live count != archived count) | **0** |
| Flattened object pairs within tolerance | **619 / 619** |
| Flattened object pairs outside tolerance | **0** |

Full report: `.runtime/experiments/jev-live-sensor-v1/equivalence-report.json` (regenerated this
pass with the stricter method — the primary raw measurement logs it reads from were not touched).
These figures (435 observations / 619 pairs / 0 mismatches / 0 count mismatches) independently
reproduce the reviewing pass's own separately-computed stricter check exactly.

## Mechanical verification (stdout purity, no goal-specific fields)

A dedicated full 300-sample run at 5 Hz with stdout captured directly (bypassing nervelet, to
independently verify the raw bytes) produced 241 lines: 1 `hello`, 239 frame records, 1 `bye`.
Verification script output:

```
total non-empty lines: 241
bad_json lines: 0
record types seen: {'hello': 1, 'frame': 239, 'bye': 1}
banned substring hits: []
```

(Banned substrings checked: `blueCarCandidate`, `targetIdentity`, `selectedDetectionId`,
`evaluatorTruth`, `groundTruth`, `simTruth`, `spectator`, in any casing.) Every key observed
across every record was inspected by hand: protocol/schema bookkeeping, detector/stereo/model
metadata, and the declared per-object fields — no goal-specific or evaluator-truth field appears
anywhere. This run is also what caught and led to fixing the stdout-purity bug in F-item below (a
CRLF line-ending bug found and fixed during the repair pass; the original pass's mechanical check
did not test for it and would have missed it).

## FFS: attempted, concretely blocked

`--stereo ffs` is real, wired code (`sensor/stereo_backend.py`'s `FfsBackend`, delegating to the
unmodified `learned_stereo.FastStereo`), not a stub. Run once against the pinned *detector* venv
(needed for YOLO detection in the same process):

```
exit code: 2
stdout: (empty — the process never got past startup, so it never emits any protocol line)
stderr: Startup failed (model/calibration): No module named 'timm'
```

Concrete, verified reason: constructing `FastStereo` imports the official FFS repository's
backbone, which needs `timm`/`einops`/`omegaconf` (also absent: `scikit-image`, `imageio`,
`open3d`) — none installed in the pinned detector venv. Conversely `ultralytics` is not installed
in the pinned FFS venv. The two pinned, read-only venvs cannot run one live detect+stereo process
together, and installing into either is out of scope. This is a declared gap, not a silent SGBM
fallback: `--stereo ffs` fails loudly, before any protocol output, with a clear stderr message and
non-zero exit. Concrete next step: a two-process bridge — out of scope for this pass, not
attempted.

## Failures and repairs

An independent review of the first pass found six issues, three blocking. This section records
them plainly enough for the coordinator to lift into a `docs/design-failures.md` F-entry; this
document itself was left as the place to record them (design-failures.md/LATEST_RESULTS.md were
not edited, per the repair assignment).

**F1 — every latency number was measured on a contended machine.** The user's own game
(`bf6.exe`) was running at ~98% GPU utilization throughout every GPU run in this document; a
leaked background process from an earlier command in this same working session (an orphaned
`sleep 999999 | python ...` pipeline from a timed-out shell command, plus 2 leftover `bash.exe`
wrapper processes, discovered still running from ~21:21 that day) added further, unrelated
contention and was killed during this repair pass. **Repair:** the measurement tool now records
GPU utilization/power/memory and foreign GPU compute apps (`nvidia-smi`) plus CPU load (sampled
directly, since `os.loadavg()` is always zero on Windows) before and after every run, marks the
run `contended` with explicit reasons above a declared threshold (GPU util > 15%, a foreign
compute app present, or CPU load > 50%), and a new `--require-quiet` flag refuses to start the
sensor at all when already contended. The machine was still contended when re-checked; per
instruction, the v1 numbers were **not** re-measured, only relabeled everywhere as an upper bound
(see "Machine contention" above), with the exact re-measure command given. No process was left
running at the end of this repair pass (verified via `Get-CimInstance Win32_Process`, matching on
command line).

**F2 — 15.6 ms clock granularity and a mislabelled clock.** `time.monotonic()` on this Windows
Python 3.11 build is backed by `GetTickCount64` (resolution 15.625 ms); every v1 timestamp was an
exact multiple of that, coarse enough to produce nonsensical negative processing-duration
artifacts, and the field was labelled `"sensor-wall"` while actually being monotonic-since-start,
not wall time. **Repair:** `sensor/clock.py`'s new `EpochClock` anchors `time.time_ns()` once at
startup and derives every later reading from a `time.perf_counter_ns()` delta (sub-microsecond);
`acquired.ms`/`emittedMs` are now genuine unix epoch milliseconds, labelled `"unix-epoch-ms"`. The
mapper now computes `ageAtReceiptMs` directly and publishes a record `valid:false` with
`reason:"stale_record"` when acquisition age at receipt exceeds a declared bound — closing the gap
where `ObservationStore`'s own receipt-time-only staleness check could not catch a delayed-but-
fresh-looking record. New tests: `sensor/test_clock.py` (resolution/monotonicity sanity),
`test/stereo-objects.test.ts` (stale-record invalidation, fresh-record non-negativity). v1 numbers
carry the ±16 ms uncertainty this bug implies; this is subsumed by the larger F1 contention
caveat.

**F3 — appearance events were not de-duplicated on real data.** Replaying the v1 saved records
through the v1 mapper showed the reused, unmodified detector frequently labelling one physical
object `car`/`truck`/`bus` in the same frame (83/237 frames at 5 Hz had ≥2 objects); the v1
class-keyed tracker read each relabel as a new "appearance". **Repair, two parts:** (1) in the
sensor, `pipeline.py`'s new `_merge_overlapping` merges detections whose masks overlap at IoU ≥
0.5 into one object, keeping the highest-scoring class as `class` and the rest as `altClasses`
(schema bumped to v2 for this and F2's clock change together); (2) in the mapper,
`AppearanceTracker` now keys on bearing bucket alone (class-agnostic), adds a
`minReappearanceIntervalMs` rate-limit floor and a `presenceScoreThreshold` hysteresis band, and
never evicts a currently-present key. Event data now carries `acquired`/range/`rangeValid`/
`class`+`altClasses`/`dominantColor`. New tests: 4 sensor-side merge tests
(`test_pipeline.py::CrossClassMergeTests`), ~10 new/rewritten mapper tests, and — because "any
tracker design can pass a synthetic fixture built to fit it" — `test/stereo-objects-real-data.test.ts`
replays an actual 32-frame slice of a real GPU run (`test/fixtures/real-multi-class-frames.json`,
5 genuine multi-class frames) and asserts a small, bounded total event count. The measurement
tool's own event polling was also fixed (it called `store.snapshot(0)` repeatedly, which only ever
returns the oldest 64 unread events — a longer replay's event count could exceed that before the
exit event arrived, and the loop would then time out waiting for an event it could structurally
never see); it now pages properly via `snapshot(afterSeq)` and acknowledges what it reads.

**F4 — a bad frame could crash the sensor and `bye` misreported why.** The per-object aggregation
loop (bearing/range computation) was not under the same per-stage try/except as decode/detect/
stereo; a calibration/image mismatch there raised a raw `ValueError`, which propagated past the
frame-level `except FrameProcessingError`, leaving `bye.reason` as `"end_of_replay"` and
`frameErrors:0` even though the run had actually crashed. **Repair:** the whole aggregation step
is now under one guard that converts any exception to `FrameProcessingError`; a failed frame is
represented on the wire as an explicit `valid:false` record with `reason` (never silently
dropped — `records.py`'s new `failed_frame_record`); any exception that still escapes the loop
(defensive, e.g. a bug outside the per-frame guards) sets `bye.reason` to `"fatal_error: ..."`
before it is written and is re-raised, so the process exit code reflects it truthfully. New tests:
`test_pipeline.py::test_an_unexpected_aggregation_error_is_wrapped...`,
`test_main.py::test_a_frame_that_fails_to_process_gets_an_explicit_invalid_record_not_a_crash`,
`test_main.py::test_an_exception_outside_frameprocessingerror_is_fatal_and_bye_says_so`. The
archive's single non-measured detection across the 1,200 Round 3 frames (noted by the review) was
not separately isolated and exercised as a dedicated real-data check in this pass — the CPU-fake
tests above cover the null-range path; this is a disclosed, not silently dropped, gap.

**F5 — Python tests were not wired into `npm test`, and one paced test was flaky under load.**
`test/jev-library.test.ts` already runs each `experiments/jev-library/test_*.py` via `spawnSync`
under the pinned venv, skipping cleanly when it is absent — the initial pass's own doc claim that
"no existing wiring was found" was wrong; it existed but was not extended to the new sensor
package. **Repair:** `test/jev-library-sensor.test.ts` adds the same pattern for the 6 sensor test
modules. Separately, `test_main.py`'s exact-frame-count tests relied on a real `ReplayFrameProvider`'s
wall-clock pacing, which is not guaranteed exact under system load (observed: 1/15 run failure
under contention). **Repair:** `sensor/testing.py`'s new `ManualFrameProvider` (fully
deterministic, synchronous, no real-time dependency) is injected via `run_sensor`'s new `provider=`
parameter for every test that asserts exact coverage; the two tests that genuinely test pacing
(`test_a_slow_pipeline_skips_frames_...`, `test_shutdown_event_ends_the_loop_promptly_...`) keep
the real provider and assert invariants instead (`processed + skippedTotal == released` for a run
that completes; monotonic, never-repeated `seq`). **Verified: 15/15 consecutive
`unittest discover` runs clean** (56 tests each) after the fix.

**F6 — smaller items, all addressed:** `equivalence_check.py` now does the stricter one-to-one,
score-order, count-checked comparison described above (was many-to-one nearest-bearing, and
compared only the first rate run's observation per frame); the sample-order documentation now
says "alphabetical", not "manifest order" (the actual, verified rule); a steady-state fps figure
(`processedFpsSteadyState`) is now computed by the measurement tool alongside the startup-inclusive
one; stdin-close handling is now **robust rather than merely opt-out**: `ShutdownWatcher.watch_stdin`
adds a 2 s grace period — an EOF observed that early is logged and the trigger disables itself for
the run (SIGINT/SIGTERM still work) instead of shutting the sensor down before it processes a
single frame (this also naturally covers the Git-Bash/MSYS quirk the initial pass worked around
with `--no-stdin-watch`, which remains available as an explicit full-disable option), and this is
now verified through the **real gated `processSource` path**
(`test/stereo-objects-process-source.test.ts` asserts, via the fake producer's own stdin probe
relayed through `processSource`'s `<id>.lifecycle` exit event, that Node's `child_process` itself
never reproduces the instant-EOF shape). stdout purity is now also enforced at the OS
file-descriptor level, not just Python's `sys.stdout` object (`main.py`'s new `_protect_stdout`
duplicates the real stdout fd and redirects fd 1 itself to stderr) — building this also surfaced
and fixed a real, independent bug: every line this sensor had written on Windows was CRLF- not
LF-terminated (Python's default text-mode newline translation), now fixed by opening the
duplicated stdout stream with `newline='\n'`.

## Limits and gaps

- **Reused synthetic frames, one laptop GPU, replay not a camera.** All measurements reuse the
  preserved Round 3 stereo acquisitions (one synthetic car asset, 12 scripted routes); this is
  retrospective evidence on the same images the batch comparison used, not a fresh held-out
  qualification, and not a real stereo camera. No Jev calls, no flight, no hardware.
- **Every absolute timing number in this document is a contended-machine upper bound** (F1) — see
  "Machine contention" above; not re-measured because the machine remained contended.
- **FFS is unexercised live** (see above) — SGBM is the only backend measured end to end.
- **Equivalence coverage is partial by construction** (269/300 sample frames were processed by at
  least one of the three rate runs; latest-wins intentionally skips the rest) — this is expected,
  declared behavior, not a shortfall in the check itself.
- **A glimpse shorter than one processing period can still fall entirely into skipped frames** —
  latest-wins fundamentally cannot see a frame it never processed; the `object_appeared` fix (F3)
  guarantees a *processed* glimpse produces exactly one event, not that every physical glimpse is
  necessarily processed at all. Buffering to avoid this would violate the bounded-queue design.
- **The single archived non-measured-range detection was not isolated as a dedicated real-data
  test** (F4) — disclosed rather than silently dropped; the null-range path is covered by CPU
  fakes instead.
- **Windows-only `_protect_stdout`/`ShutdownWatcher` behavior was exercised on this Windows
  development host only**; POSIX process-tree/signal behavior for this sensor remains untested, as
  already noted for nervelet's own `processSource` in `docs/api.md`.

## Remaining decisions for a real camera provider

- **Frame delivery into a live-camera `FrameProvider`:** a real stereo camera would need its own
  capture loop (SDK callback or polling `grab()`) satisfying the same `FrameProvider` protocol
  (`start`/`take_latest`/`wake`/`stop`); `acquired_ms` must be stamped at actual sensor readout,
  not at later decode — unlike replay, where the "frame" is a file path that already exists before
  its pacer-simulated capture moment.
- **Does nervelet's `processSource` need stdin access or a different frame-ingest path for
  simulator/live frames?** No changes needed on nervelet's side for either case measured here: the
  sensor pulls frames itself and only ever *emits* on stdout; nervelet's child stdin is used
  solely as a shutdown signal, never for frame ingest, verified both by the gated real-
  `processSource` test and by the stdin-robustness check added this pass (F6).
- **Calibration for a real camera** would need actual stereo rectification/intrinsics (this sensor
  already accepts either raw or Round-3-normalized calibration shapes) plus a genuine 0.2 m-class
  baseline measurement in place of the synthetic asset's declared one.
- **FFS live** needs the two-process bridge described above, or relaxing the "no pip-install into
  pinned venvs" constraint for a throwaway third venv.
- **A quiet-machine re-measurement** (F1) is the single most valuable next step to make the
  latency tables citable as a general performance characterization rather than an upper bound.

## Test/typecheck/build counts

- Python: **56/56** passed (`experiments/jev-library/sensor`, CPU-only, no GPU/weights/network),
  confirmed **15/15 consecutive runs clean** (F5's acceptance bar); **121/121** passed including
  the 5 pre-existing `experiments/jev-library/test_*.py` files together in one `unittest discover`
  run (no conflicts). Now also wired into `npm test` (`test/jev-library-sensor.test.ts`, matching
  the pre-existing `test/jev-library.test.ts` `spawnSync` pattern — F5).
- Node/TypeScript: **npm test** 359/374 passed, 15 skipped, 0 failed with `ROBOTS_NERVELET_MODULE`
  unset; **363/374 passed, 11 skipped, 0 failed** with it set to the nervelet worktree's built
  entry (confirmed stable across repeated runs). One unrelated pre-existing test
  (`test/jev.test.ts`, request-deadline timing) flaked once under this same machine's contention
  during this repair pass and passed cleanly both in isolation and on every other full-suite run —
  further corroborating evidence for F1, not a regression from this work. **npm run typecheck**:
  clean. **npm run build**: clean (pre-existing >500 kB chunk-size warning, unrelated to this
  change).
- **v1 evidence files unmodified:** every file under
  `.runtime/experiments/jev-live-sensor-v1/measurements/` (the raw per-frame logs, summaries and
  console captures the tables above are computed from) has the same size and modification
  timestamp at the end of this repair pass as it did immediately after the original measurement
  run (individually verified, not just the containing directory). `equivalence-report.json` was
  intentionally regenerated with the stricter method (F6); the analysis script that produces it,
  not the underlying raw evidence, changed.

## Quiet-machine re-measurement, 2026-09-21

The contended-machine tables above (marked "upper bound only") remain as originally measured; this section
adds the promised quiet-machine re-measurement rather than replacing them. Run 2026-09-20 ~23:52–23:54 local,
game closed, on the same host: `.runtime/experiments/jev-live-sensor-v2/measurements-quiet/summary-{5,10,15}hz.json`
(main checkout, git-ignored, verified directly from the JSON for this write-up), through the real Nervelet
`processSource` + `SourceGroup` + `ObservationStore` consumer on the same predeclared 300-frame sample rule as
the v1 run.

| Rate | Processed / 300 | Skipped fraction | Steady-state fps | Acquire-to-consumer-receipt age (median / p95) | Total processing (median): stereo / detect |
| --- | --- | --- | --- | --- | --- |
| 5 Hz | 300 | 0% | 5.00 | 141.8 / 157.7 ms | 141.5 ms: 100.8 / 27.5 ms |
| 10 Hz | 291 | 3% | 9.68 | 132.5 / 192.1 ms | 100.2 ms: 78.7 / 14.7 ms |
| 15 Hz | 189 | 37% | 9.43 | 137.8 / 190.5 ms | 98.0 ms: 77.7 / 14.0 ms |

These are the sensor's own steady-state figures, not an upper bound: total processing stays under the 5 Hz
period even at the median, and 10/15 Hz both settle near the same 9.4–9.7 fps ceiling once model-load and the
first five post-warmup frames are excluded, consistent with the qualitative shape the contended v1 run already
predicted (stereo and detect dominate; processing exceeds the faster periods, so latest-wins skipping grows
with rate).

**Every summary still reports `contended:true`.** The tool's rule fires on GPU utilization above 15% (measured
20–23% across all three runs) and on a foreign GPU compute app being present (PID 2576) drawing 17.5–23.6 W.
That is roughly an order of magnitude below the earlier contended run's game (`bf6.exe`, ~98% utilization,
~149 W). **Correction, 2026-09-21 (second review):** PID 2576 is confirmed as `dwm.exe` via `Get-Process`
(coordinator-verified, not independently re-checked in this pass) — the Windows desktop compositor, not another
GPU-bound workload; the earlier text here correctly guessed the mechanism but understated its confidence.

**Two tool defects were hit and worked around, not fixed in this pass. Corrected sequence, re-read from file
metadata (an earlier version of this account was imprecise about attempt count and cause):**
1. A first attempt refused at **23:36:15 local**, correctly applying the contention rule
   (`.runtime/experiments/jev-live-sensor-v2/measurements/contention-refused-{5,10,15}hz.json`) — **the game was
   already closed by this point**; the refusal's own recorded signature (20–22% GPU, 17–18 W) is the same
   light/idle signature as the successful run below, not the earlier ~150 W/~98% game signature. The refusal is
   the tool's rule correctly firing on a nearly-idle GPU, not evidence the game was still running.
2. A second attempt (~23:41–23:47 local, relative paths, no `--require-quiet`) produced three 0-byte timeout
   files in `.runtime/experiments/jev-live-sensor-v2/measurements/` roughly 120 s apart (`raw-5hz.ndjson`
   23:42:56, `raw-10hz.ndjson` 23:44:57, `raw-15hz.ndjson` 23:46:58) plus one more 0-byte file in
   `measurements-bash/raw-5hz.ndjson` at 23:50:05 — in every case the sensor process exited immediately when
   launched from a different working directory than it expected, and the tool did not detect the early exit,
   instead waiting out its full 120 s timeout before returning.
3. A third attempt, with absolute paths, produced the successful `measurements-quiet/` run at 23:53–23:54.

The early-exit-detection defect is being fixed by the engine's other maker, not addressed here.

The successful run at ~23:52–23:54 local used absolute paths and produced the summary tables above.
**Corrected interpretation:** the sensor's real steady-state latency is now known and is the figure to cite going
forward (LATEST_RESULTS.md's live-sensor section updated accordingly); the v1 contended tables remain useful only
as an upper-bound sanity check, not as the sensor's characterization. See the [ladder document](jev-find-follow-ladder.md)'s
L0 clock-qualification defaults, which use these figures directly (perception ≈140 ms median / ≈190 ms p95).

## See also

- [Library comparison results](jev-library-comparison-results.md) — the batch recommendation this
  sensor implements live (mask-median + SGBM; FFS promising but optional).
- [`experiments/jev-library/README.md`](../experiments/jev-library/README.md) — batch experiment
  setup, now pointing here for the live sensor.
- [design-failures.md F28](design-failures.md) — the dropped-glimpse failure `object_appeared`
  directly addresses.
- [LATEST_RESULTS.md](../LATEST_RESULTS.md) — the call for live, continuously-fed measurement this
  document answers.
