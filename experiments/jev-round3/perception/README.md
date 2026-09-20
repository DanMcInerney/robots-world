# Round 3 image-only perception

This experiment-only Python worker receives rectified RGB and calibration. It imports the unchanged [`matching.py`](../../jev-spatial-text/stereo/matching.py) implementation. It does not import renderer/evaluator code, read renderer masks/depth, or receive world positions or body IDs.

The preselected detector is **YOLO11s-seg**, Ultralytics 8.3.221, official v8.3.0 checkpoint SHA-256 `1caa81c0195412efa411b632bcfb8c184939dddb6ae41f6a80c41b211ff257c3`. This is a disclosed preparation amendment from initially selected YOLO11n-seg: on exactly three geometry-corrected engineering smoke images, nano returned truck/missing/chair while small returned car in all three. Thresholds, image size and stereo were unchanged; no scored development/confirmation data selected the model. Both original incomplete-mesh and corrected preparation failures remain retained. This narrow recognizability check does not qualify all routes.

`run.py` pins inference settings and rejects a different checkpoint/package. Both association arms reuse exactly one detector output and one SGBM result. All detections, predicted masks and blue-car candidates are preserved. Colour evidence is an HSV threshold on RGB inside the predicted mask. A frame-local ID does not prove identity across time; more than one blue car is ambiguous.

**Primary range is the median Euclidean range of the selected measured surface pixels.** Compare it with evaluator median visible-target radial range. This deliberately changes the earlier proposal's exact-nearest definition so box versus mask association uses the same statistic. P10 and raw minimum are separate nearest-surface diagnostics, not guaranteed nearest measurements. Depth spread is descriptive, not calibrated uncertainty. No obstacle clearance is certified.

The mask arm searches ascending 0.5 m radial-range bands, merges adjacent bins, and selects the largest qualifying 8-connected component in the first supported band. Support requires at least 12 pixels, at least 2% of mask area, and at least 10% valid stereo coverage inside the input region. The closest supported cluster can still belong to an occluder or segmentation error. No truth filtering fixes those cases.

## Runtime and setup

Use a separate environment under `.runtime/experiments/jev-round3-v1/perception/.venv`. Do not install into prior round environments. Install Torch 2.8.0 and torchvision 0.23.0 from the official CUDA 12.8 wheel index, then the other pinned packages in `requirements.txt`. Run `setup.py` with that interpreter. Runtime provenance, complete resolved versions, download URLs/hashes and setup logs live in `perception/setup/`. Model weights are runtime files, excluded from Git.

```powershell
uv venv --python 3.11 .runtime/experiments/jev-round3-v1/perception/.venv
uv pip install --python .runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe ultralytics==8.3.221 numpy==2.2.6 opencv-python==4.12.0.88 pillow==11.3.0
.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe experiments/jev-round3/perception/setup.py
```

CUDA is explicit (`--device 0`), CPU is explicit (`--device cpu`), and unavailable CUDA fails instead of silently changing hardware. Float32 is shared between the devices. Detector wall latency includes synchronized GPU completion; extraction is separately measured. CPU uses four Torch threads; unchanged SGBM uses one OpenCV thread. Branches currently execute serially, so no overlap or real-time camera qualification is claimed. Setup benchmarks retain model load, first prediction, three extra warmups and twenty warm predictions on one public image.

## Input and output

A manifest is an array, or `{ "samples": [...] }`. Each sample contains **only**:

```json
{"id":"route-0001","leftPath":"rgb/left.png","rightPath":"rgb/right.png","calibrationPath":"calibration.json"}
```

Relative paths resolve from the manifest directory. Calibration requires `width`, `height`, `fx`, `fy`, `cx`, `cy`, and `baselineM` (or `baseline_m`); `doffsPx` defaults to zero. Acceptable pixel conventions are `u=column,v=row; top-left origin` (default) and `u=column+0.5,v=row+0.5; top-left origin` (renderer). Radial range and bearings honor this offset explicitly. Reject nonrectified/distorted inputs and unknown pixel conventions. Other calibration metadata is discarded.

```powershell
.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe experiments/jev-round3/perception/run.py --manifest PATH --output OUTPUT --device 0
```

Use separate development/confirmation manifests and destinations. Freeze source, settings, checkpoint and input hashes before scored execution; seal development results before confirmation without tuning. Completed sample predictions are never overwritten or silently rerun. `--worker` accepts one sample per stdin line (paths relative to working directory), emits one JSON result/error per stdout line and reports startup on stderr. It keeps the model warm. It does not choose targets or actions.

Each result has `id`, hashed input paths, normalized calibration, full `detections`, `blueCarCandidates`, `targetStatus`, per-stage timing and artifact paths. Each detection includes `className`, `confidence`, `boxXyxy`, `maskPixels`, pixel colour evidence, bearing and both arms. Each arm includes:

```json
{"status":"measured","unknownReason":null,"estimateM":10.0,"robustNearestProxyM":9.7,"minimumMeasuredRangeM":9.5,"descriptiveSpreadM":[9.6,10.4],"regionPixels":1000,"validPixels":600,"supportPixels":450,"validCoverage":0.6,"selectedFraction":0.45}
```

Unknown estimates are JSON null with an explicit reason. `measurements.npz` stores exact axial depth, stereo validity/disparity, LR error, texture, predicted masks and selected cluster masks. Overlay colours show predicted masks/boxes, with magenta cluster boundaries. Depth preview uses a fixed 0–25 m **axial** scale with black unknown pixels; it is not input to ranging. Batch `results.json` aggregates the same full records.

## Checks

Run `test_measurement.py` with the isolated interpreter. Tests cover background contamination, robust cluster support, sparse/invalid/missing observations, Euclidean conversion, half-pixel calibration and pixel-derived colour/bearing. Repository integration runs those tests when the optional environment exists. No neural inference or downloads occur in default tests.

Prepared smoke images, setup detection failures and public-image timings are excluded from scored routes. The source deliberately preserves missing car detections instead of relabeling truck/chair outputs or recovering target identity from RGB colour alone.

Sources: [Ultralytics YOLO11](https://docs.ultralytics.com/models/yolo11/), [predict API](https://docs.ultralytics.com/modes/predict/), [official PyTorch versions](https://docs.pytorch.org/get-started/previous-versions/).
