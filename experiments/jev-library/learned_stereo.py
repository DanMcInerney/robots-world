"""Image-only Fast-FoundationStereo benchmark adapter; no detector or truth input.

Native Windows uses the official eager PyTorch path with compilation disabled.
Validity is finite positive disparity, model search bounds, positive calibrated
denominator and in-image right correspondence. It is NOT calibrated confidence,
left/right consistency, an occlusion test, or certified free space.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".runtime/experiments/jev-library-v1/ffs"
COMMIT = "476f4249561f7c79ca707326954f9255643412a6"
CHECKPOINT_SHA256 = "98b5a9acf39fbfa795025de8cea95ce123daa40f6b6234d719167751024cf692"
CONFIG_SHA256 = "d45afe99b176454d5aff416edf16c8da6a99579f8f374b927f37907442a7d6bc"
PARAMETERS = {"checkpoint": "20-30-48", "validIters": 4, "maxDisparityPx": 192,
              "paddingDivisor": 32, "paddingMode": "symmetric-replicate",
              "precision": "float16-autocast", "costVolume": "pytorch1",
              "compile": False, "torchCpuThreads": 4, "warmupFrames": 3,
              "validityPolicy": "finite-positive-bounded-disparity-and-right-image-correspondence",
              "leftRightConsistencyCheck": False, "textureThreshold": None,
              "confidenceCalibrated": False, "freeSpaceCertified": False}
SAMPLE_KEYS = {"id", "leftPath", "rightPath", "calibrationPath"}


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def calibration_from_json(raw, shape):
    """Whitelist only calibration; reject unsupported image geometry."""
    height, width = shape
    cal = {key: raw[key] for key in ("width", "height", "fx", "fy", "cx", "cy")}
    cal["baselineM"] = raw.get("baselineM", raw.get("baseline_m"))
    cal["doffsPx"] = raw.get("doffsPx", 0)
    conventions = {"u=column,v=row; top-left origin": 0.0,
                   "u=column+0.5,v=row+0.5; top-left origin": 0.5}
    if "pixelCenterOffset" in raw:
        cal["pixelCenterOffset"] = raw["pixelCenterOffset"]
        if cal["pixelCenterOffset"] not in (0.0, 0.5):
            raise ValueError("Unsupported pixel centre offset")
    else:
        convention = raw.get("pixel_coordinates", "u=column,v=row; top-left origin")
        if convention not in conventions:
            raise ValueError("Unsupported pixel coordinate convention")
        cal["pixelCenterOffset"] = conventions[convention]
    if raw.get("rectified", True) is not True or any(raw.get("distortion", [0])):
        raise ValueError("FFS requires rectified, undistorted stereo RGB")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
           for v in cal.values()):
        raise ValueError("Calibration must contain finite numeric values")
    if (cal["height"], cal["width"]) != (height, width):
        raise ValueError("Image/calibration dimension mismatch")
    if min(cal["fx"], cal["fy"], cal["baselineM"]) <= 0:
        raise ValueError("Positive focal lengths and actual stereo baseline required")
    if not (0 <= cal["cx"] <= width and 0 <= cal["cy"] <= height):
        raise ValueError("Principal point is outside the image")
    return cal


def depth_and_validity(disparity, calibration):
    """Positive camera-axis Z in metres; doffs = cx_right - cx_left."""
    disparity = np.asarray(disparity, dtype=np.float32)
    if disparity.shape != (calibration["height"], calibration["width"]):
        raise ValueError("Disparity/calibration dimension mismatch")
    denominator = disparity + calibration["doffsPx"]
    x_right = np.arange(disparity.shape[1], dtype=np.float32)[None, :] - disparity
    masks = {"nonFiniteOrNonPositive": ~np.isfinite(disparity) | (disparity <= 0),
             "outsideSearchRange": disparity >= PARAMETERS["maxDisparityPx"],
             "outsideRightImage": (x_right < 0) | (x_right > disparity.shape[1]-1),
             "invalidCalibratedDenominator": ~np.isfinite(denominator) | (denominator <= 0)}
    valid = ~np.logical_or.reduce(list(masks.values()))
    depth = np.full(disparity.shape, np.nan, np.float32)
    with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
        depth[valid] = calibration["fx"] * calibration["baselineM"] / denominator[valid]
    masks["invalidMetricDepth"] = valid & (~np.isfinite(depth) | (depth <= 0))
    valid &= ~masks["invalidMetricDepth"]
    depth[~valid] = np.nan
    return depth, valid, masks


def read_manifest(path):
    raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    return validate_manifest(raw)


def validate_manifest(raw):
    if not isinstance(raw, dict) or set(raw) != {"samples"} or not isinstance(raw["samples"], list):
        raise ValueError("Manifest must contain ONLY a samples array")
    seen = set()
    for sample in raw["samples"]:
        if not isinstance(sample, dict) or set(sample) != SAMPLE_KEYS:
            raise ValueError("Sample must contain ONLY id,leftPath,rightPath,calibrationPath")
        identifier = sample["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", identifier):
            raise ValueError("Unsafe sample id")
        if identifier.endswith(".") or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])", identifier.split(".")[0]):
            raise ValueError("Sample id is unsafe on Windows")
        if identifier.casefold() in seen:
            raise ValueError("Duplicate sample id")
        seen.add(identifier.casefold())
        for key in SAMPLE_KEYS - {"id"}:
            if not isinstance(sample[key], str) or not sample[key]:
                raise ValueError("Image and calibration paths must be nonempty strings")
    return raw["samples"]


def load_sample(sample, base):
    paths = {key: (base / sample[key]).resolve() for key in SAMPLE_KEYS - {"id"}}
    left, right = [cv2.imread(str(paths[key]), cv2.IMREAD_COLOR) for key in ("leftPath", "rightPath")]
    if left is None or right is None or left.shape != right.shape:
        raise ValueError("Missing or unequal stereo images")
    cal = calibration_from_json(json.loads(paths["calibrationPath"].read_text(encoding="utf-8-sig")), left.shape[:2])
    if not math.isclose(cal["baselineM"], 0.2, abs_tol=1e-9):
        raise ValueError("This experiment requires the declared actual 0.2 m baseline")
    return left, right, cal, paths


class FastStereo:
    """Persistent model; estimate accepts BGR uint8 images and calibration only."""
    def __init__(self, runtime_root=RUNTIME):
        start = time.perf_counter()
        runtime_root = Path(runtime_root).resolve()
        repo = runtime_root / "repo"
        checkpoint = runtime_root / "weights/20-30-48/model_best_bp2_serialize.pth"
        config = checkpoint.with_name("cfg.yaml")
        revision = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
        if revision != COMMIT or subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=no"], text=True).strip():
            raise ValueError("Official FFS checkout differs from the pinned clean revision")
        if sha256(checkpoint) != CHECKPOINT_SHA256 or sha256(config) != CONFIG_SHA256:
            raise ValueError("Checkpoint/config differ from qualified official bytes")
        # Eager execution is explicit: upstream decorators otherwise require Triton/Inductor.
        os.environ["TORCHDYNAMO_DISABLE"] = "1"
        sys.path.insert(0, str(repo))
        import torch
        from core.utils.utils import InputPadder
        if torch.__version__ != "2.8.0+cu128":
            raise ValueError("Run with the isolated qualified torch 2.8.0+cu128 environment")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required; no silent CPU fallback")
        torch.set_num_threads(PARAMETERS["torchCpuThreads"])
        torch.manual_seed(0)
        np.random.seed(0)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
        self.torch, self.padder_type = torch, InputPadder
        self.model = torch.load(checkpoint, map_location="cpu", weights_only=False)
        self.model.args.valid_iters = PARAMETERS["validIters"]
        self.model.args.max_disp = PARAMETERS["maxDisparityPx"]
        self.model.args.mixed_precision = True
        self.model.cuda().eval()
        torch.cuda.synchronize()
        self.metadata = {"officialRepository": "https://github.com/NVlabs/Fast-FoundationStereo",
            "upstreamCommit": revision, "checkpointSha256": CHECKPOINT_SHA256,
            "configSha256": CONFIG_SHA256, "adapterSha256": sha256(__file__),
            "torch": torch.__version__, "cuda": torch.version.cuda,
            "python": sys.version, "device": torch.cuda.get_device_name(0),
            "parameters": PARAMETERS, "modelLoadMs": (time.perf_counter()-start)*1000,
            "validityLimit": "Numerical/geometric eligibility only; no calibrated confidence, LR consistency, texture filtering or free-space certification."}

    def estimate(self, left_bgr, right_bgr, calibration):
        if left_bgr.dtype != np.uint8 or right_bgr.dtype != np.uint8 or left_bgr.ndim != 3 \
                or left_bgr.shape[2] != 3 or left_bgr.shape != right_bgr.shape:
            raise ValueError("Expected equal BGR uint8 HxWx3 images")
        cal = calibration_from_json(calibration, left_bgr.shape[:2])
        torch = self.torch
        torch.cuda.synchronize()
        start = time.perf_counter()
        left_rgb = cv2.cvtColor(left_bgr, cv2.COLOR_BGR2RGB)
        right_rgb = cv2.cvtColor(right_bgr, cv2.COLOR_BGR2RGB)
        images = [torch.from_numpy(image).cuda().float()[None].permute(0, 3, 1, 2)
                  for image in (left_rgb, right_rgb)]
        padder = self.padder_type(images[0].shape, divis_by=32, force_square=False)
        left, right = padder.pad(*images)
        torch.cuda.synchronize()
        prepared = time.perf_counter()
        with torch.inference_mode(), torch.amp.autocast("cuda", dtype=torch.float16):
            output = self.model.forward(left, right, iters=PARAMETERS["validIters"],
                                        test_mode=True, optimize_build_volume="pytorch1")
        torch.cuda.synchronize()
        inferred = time.perf_counter()
        disparity = padder.unpad(output.float())[0, 0].cpu().numpy().copy()
        depth, valid, masks = depth_and_validity(disparity, cal)
        finished = time.perf_counter()
        return {"disparity": disparity, "depth": depth, "valid": valid, "invalidMasks": masks,
                "paddingLTRB": list(padder._pad), "calibration": cal,
                "timing": {"preprocessMs": (prepared-start)*1000,
                    "inferenceMs": (inferred-prepared)*1000,
                    "postprocessMs": (finished-inferred)*1000,
                    "estimateMs": (finished-start)*1000},
                "estimateMs": (finished-start)*1000}

    def warmup(self):
        blank = np.zeros((360, 640, 3), dtype=np.uint8)
        cal = fixture_calibration()
        timings = [self.estimate(blank, blank, cal)["timing"] for _ in range(PARAMETERS["warmupFrames"])]
        return {"purpose": "startup only; three blank 640x360 pairs, no study pixels", "timings": timings}


def fixture_calibration():
    return {"width": 640, "height": 360, "fx": 457.0073621574767,
            "fy": 457.0073621574767, "cx": 320, "cy": 180,
            "baselineM": 0.2, "doffsPx": 0, "pixelCenterOffset": 0.5}


def self_test():
    """CPU checks for metric conversion and refusal boundaries, no study data."""
    cal = fixture_calibration()
    cal["doffsPx"] = 2.0
    disparity = np.full((360, 640), 8.0, np.float32)
    depth, valid, _ = depth_and_validity(disparity, cal)
    assert np.all(~valid[:, :8]) and np.all(valid[:, 8:])
    np.testing.assert_allclose(depth[:, 8:], cal["fx"] * 0.2 / 10.0)
    assert np.isnan(depth[:, :8]).all()
    disparity[0, 100:105] = [np.nan, np.inf, 0, -1, 192]
    _, valid, _ = depth_and_validity(disparity, cal)
    assert not valid[0, 100:105].any()
    cal["doffsPx"] = -9
    assert not depth_and_validity(np.full((360, 640), 8), cal)[1].any()
    for update in ({"rectified": False}, {"distortion": [0.1]}, {"fx": 0}, {"baselineM": -0.2}):
        try:
            calibration_from_json({**fixture_calibration(), **update}, (360, 640))
        except ValueError:
            continue
        raise AssertionError(f"Calibration was accepted: {update}")
    sample = {"id": "fixture-0001", "leftPath": "left.png", "rightPath": "right.png",
              "calibrationPath": "calibration.json"}
    assert validate_manifest({"samples": [sample]}) == [sample]
    bad_manifests = [{"samples": [sample], "truth": {}},
        {"samples": [{**sample, "targetMaskPath": "forbidden.png"}]},
        {"samples": [sample, {**sample, "id": "FIXTURE-0001"}]},
        {"samples": [{**sample, "id": "../escape"}]},
        {"samples": [{**sample, "id": "NUL"}]}]
    for bad in bad_manifests:
        try:
            validate_manifest(bad)
        except ValueError:
            continue
        raise AssertionError("Unsafe or truth-bearing manifest was accepted")
    return {"passed": True, "checks": ["doffs-positive-depth", "correspondence-bounds",
        "invalid-disparity", "nonpositive-denominator", "calibration-refusals",
        "strict-image-only-manifest", "duplicate-and-unsafe-id-refusals"],
        "gpuExecuted": False}


def benchmark(model, output, repetitions):
    """Synthetic texture qualification, never a held-out study frame."""
    output.mkdir(parents=True, exist_ok=False)
    startup = model.warmup()
    rng = np.random.default_rng(314159)
    left = rng.integers(0, 256, (360, 640, 3), dtype=np.uint8)
    left = cv2.GaussianBlur(left, (5, 5), 1.0)
    right = np.empty_like(left)
    right[:, :-8] = left[:, 8:]
    right[:, -8:] = left[:, -1:]
    records = [model.estimate(left, right, fixture_calibration()) for _ in range(repetitions)]
    result = records[-1]
    inner = result["disparity"][32:-32, 40:-32]
    report = {"kind": "unscored-synthetic-runtime-smoke", "knownShiftPx": 8,
              "metadata": model.metadata, "startup": startup,
              "timings": [row["timing"] for row in records],
              "interiorMedianDisparityPx": float(np.median(inner)),
              "interiorMeanAbsoluteDisparityErrorPx": float(np.mean(np.abs(inner-8))),
              "validFraction": float(result["valid"].mean()), "paddingLTRB": result["paddingLTRB"],
              "finiteDisparityFraction": float(np.isfinite(result["disparity"]).mean()),
              "qualificationLimit": "Synthetic shifted texture and runtime only; no real-camera or target-ranging qualification."}
    np.savez_compressed(output / "synthetic-arrays.npz", **{key: result[key] for key in ("disparity", "depth", "valid")})
    write_json(output / "benchmark.json", report)
    print(json.dumps(report, allow_nan=False))


def run_manifest(model, manifest, output, limit):
    samples = read_manifest(manifest)
    if limit is not None:
        samples = samples[:limit]
    output.mkdir(parents=True, exist_ok=False)
    (output / "arrays").mkdir()
    report = {"metadata": model.metadata, "manifestSha256": sha256(manifest),
              "manifestPath": str(manifest.resolve()), "startup": model.warmup(), "records": []}
    for sample in samples:
        start = time.perf_counter()
        left, right, cal, paths = load_sample(sample, manifest.resolve().parent)
        decoded = time.perf_counter()
        result = model.estimate(left, right, cal)
        estimated = time.perf_counter()
        array_path = output / "arrays" / (sample["id"] + ".npz")
        np.savez_compressed(array_path, **{key: result[key] for key in ("disparity", "depth", "valid")})
        row = {"id": sample["id"], "arraysPath": str(array_path.resolve()), "calibration": cal,
            "input": {key: {"path": str(path), "sha256": sha256(path)} for key, path in paths.items()},
            "arraysSha256": sha256(array_path), "validPixels": int(result["valid"].sum()),
            "invalidCounts": {key: int(value.sum()) for key, value in result["invalidMasks"].items()},
            "invalidReasonCountsOverlap": True, "paddingLTRB": result["paddingLTRB"],
            "timing": {**result["timing"], "decodeMs": (decoded-start)*1000,
                       "artifactAndHashMs": (time.perf_counter()-estimated)*1000}}
        report["records"].append(row)
        with (output / "progress.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, allow_nan=False) + "\n")
        if len(report["records"]) % 25 == 0:
            print(f"FFS completed {len(report['records'])}/{len(samples)}", flush=True)
    write_json(output / "index.json", report)
    print(json.dumps({"index": str(output / "index.json"), "samples": len(samples)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--manifest", type=Path)
    mode.add_argument("--benchmark", action="store_true")
    mode.add_argument("--self-test", action="store_true")
    parser.add_argument("--runtime-root", type=Path, default=RUNTIME)
    parser.add_argument("--out", "--output", type=Path)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--all-frames", action="store_true", help="Explicit alias for the default: all manifest samples")
    selection.add_argument("--limit", type=int)
    parser.add_argument("--repetitions", type=int, default=10)
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps(self_test()))
        return
    if args.out is None or (args.limit is not None and args.limit < 1) or args.repetitions < 1:
        parser.error("--out and positive count values required")
    if args.out.exists():
        raise FileExistsError("Output exists; preserving prior evidence")
    if args.manifest:
        read_manifest(args.manifest)  # Reject metadata/truth-bearing manifests before GPU work.
    model = FastStereo(args.runtime_root)
    if args.benchmark:
        benchmark(model, args.out, args.repetitions)
    else:
        run_manifest(model, args.manifest, args.out, args.limit)


if __name__ == "__main__":
    main()
