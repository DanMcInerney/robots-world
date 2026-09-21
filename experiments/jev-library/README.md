# Perception library ablations

This experiment implements the [library comparison plan](../../docs/jev-library-comparison-plan.md). It preserves Round 3 and reuses its 1,200 stereo acquisitions for a retrospective paired comparison. It neither controls a robot nor calls Jev.

**Live streaming sensor:** `sensor/` builds on this comparison's measured recommendation (mask-median + SGBM) as a standalone, continuously-fed process — a goal-agnostic stereo-object sensor emitting compact NDJSON records, consumable unchanged by nervelet's `processSource`. It reuses `geometry.py`, `detector.py`, `stereo_cached.py` and `learned_stereo.py` directly rather than copying their logic. See [`docs/jev-live-sensor-results.md`](../../docs/jev-live-sensor-results.md) for the record schema, exact commands, measured live latency at 5/10/15 Hz through real nervelet `processSource`/`SourceGroup`/`ObservationStore`, and the equivalence check against this comparison's own `yolo11_current` arm.

`geometry.py` owns cached OpenCV rays, bearing and mask-median aggregation. `stereo_cached.py` reuses the original SGBM matchers with equivalent depth/validity. `detector.py` supports pinned YOLO11/YOLO26 and a provenance-checked TensorRT engine; `tracker.py` supplies BoT-SORT and conservative target binding. `learned_stereo.py` runs the official Fast-FoundationStereo model on actual stereo RGB. Inputs contain only images, calibration and previously recorded sensor-derived predictions. Only `evaluate.py` reads evaluator references.

The detector and learned-stereo runtimes are separate ignored environments under `.runtime/experiments/jev-library-v1`. Their setup scripts retain exact versions, official checkpoint hashes, installation/export evidence and unscored smoke results. No test installs packages or downloads weights. The old Round 3 environment remains unchanged.

The new detector environment requires Python 3.11, Torch 2.8.0+cu128, torchvision 0.23.0+cu128, Ultralytics 8.4.157, NumPy 2.2.6, OpenCV 4.12.0.88, lap 0.5.13, and TensorRT-cu12 10.13.3.9 for the engine arm. See `setup_detector.py` and the recorded package inventory for the complete resolved environment. `setup_ffs.py` installs and pins its separate runtime.

From the repository root, use the appropriate interpreter:

```powershell
# Preserve and verify source + old evidence before the declared comparison.
.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe experiments/jev-library/campaign.py freeze

# Isolate aggregation on the recorded detector/stereo arrays.
.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe experiments/jev-library/run.py --mode cached --arm mask_median

# Actual new detection; recorded stereo remains fixed.
.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe experiments/jev-library/run.py --mode detector --arm yolo26 --checkpoint .runtime/experiments/jev-library-v1/detector/models/yolo26s-seg.pt

# Tracking on the original detections; no additional neural inference.
.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe experiments/jev-library/run.py --mode tracker --arm botsort

# Actual learned stereo on every RGB pair.
.runtime/experiments/jev-library-v1/ffs/venv/Scripts/python.exe experiments/jev-library/learned_stereo.py --manifest .runtime/experiments/jev-library-v1/perception-inputs.json --out .runtime/experiments/jev-library-v1/ffs/scored --all-frames

# Pair original and optimized complete serial compute on 60 fixed frames.
.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe experiments/jev-library/benchmark.py
```

The other detector arms use `yolo11s-seg.pt` and the exported `yolo11s-seg.engine` with `--half`. `--mode stereo --stereo-index PATH` joins learned depth to original detections. `--mode combined --stereo-index PATH --detection-index PATH` joins YOLO26 and learned depth with tracking. The combined arm deliberately changes several components; isolated arms provide attribution.

Every arm refuses an existing output destination. Failed attempts remain preserved. `artifacts.py` bounds background writes, reports queue wait and flushes/errors before completion. Quality replay timings exclude computation reused from disk; only the separate benchmark runs live detector-plus-stereo compute. Its optimized diagnostic payload is smaller than the old baseline's, which is disclosed separately.

`integrity.py` owns exclusive completion and analysis seals. Each arm's completion binds results, per-frame records, generated arrays, exact frame IDs, input/source links and component completion seals. Cached/combined rows must retain the source detections and artifact paths. Old evidence is fully checked at freeze and final verification; intermediate joins check its frozen seal links and the two prediction indexes, avoiding a full archived-file scan per arm. New arrays are always verified before reuse. Recorded calibration, RGB hashes, model metadata and FFS array hashes remain intact.

The full execution order, after setup and before any scoring, is:

```powershell
$old = '.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe'
$det = '.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe'
$ffs = '.runtime/experiments/jev-library-v1/ffs/venv/Scripts/python.exe'
$out = '.runtime/experiments/jev-library-v1'
& $old -B experiments/jev-library/campaign.py freeze
& $old -B experiments/jev-library/run.py --mode cached --arm mask_median
& $det -B experiments/jev-library/run.py --mode tracker --arm botsort
& $det -B experiments/jev-library/run.py --mode detector --arm yolo11_current --checkpoint "$out/detector/models/yolo11s-seg.pt"
& $det -B experiments/jev-library/run.py --mode detector --arm yolo26 --checkpoint "$out/detector/models/yolo26s-seg.pt"
& $det -B experiments/jev-library/run.py --mode detector --arm tensorrt_fp16 --checkpoint "$out/detector/models/yolo11s-seg.engine" --half
& $ffs -B experiments/jev-library/learned_stereo.py --manifest "$out/perception-inputs.json" --out "$out/ffs/scored" --all-frames
& $old -B experiments/jev-library/campaign.py seal-ffs
& $old -B experiments/jev-library/run.py --mode stereo --arm ffs_mask --stereo-index "$out/ffs/scored/index.json"
& $det -B experiments/jev-library/run.py --mode combined --arm combined_yolo26_ffs_tracking --stereo-index "$out/ffs/scored/index.json" --detection-index "$out/arms/yolo26/results.json"
& $old -B -c "import sys; sys.path.insert(0, 'experiments/jev-library'); from integrity import ARMS, save_new; save_new('$out/manifest.json', {'expectedFrames':1200, 'arms':[{'arm':a, 'status':'complete'} for a in ARMS]})"
& $old -B experiments/jev-library/campaign.py seal-predictions
& $old -B experiments/jev-library/evaluate.py --root $out
& $old -B experiments/jev-library/campaign.py verify
```

Run these commands once in order, checking each exit code before continuing. If a backend is unavailable, declare that arm `unavailable` with a concrete retained-failure `reason` in the manifest instead of declaring it complete. The manifest must declare all seven preselected arms. The prediction seal binds every completed arm, raw FFS output and environment/export metadata. The evaluator requires that seal before scoring, then seals `summary.json`, `replay.json`, `index.html`, the manifest and prediction/source chain. Final verification checks this whole chain plus original evidence. Existing files and incomplete attempts are never overwritten.

Qualification is limited to these reused images and the explicit procedural fixtures. Persistent IDs are hypotheses, network depth is not calibrated confidence, and no arm certifies obstacle clearance or complete find-and-follow control.
