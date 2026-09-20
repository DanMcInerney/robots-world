"""Persistent/batch image-only segmentation and unchanged SGBM association.

Only explicit left/right RGB and calibration files are opened. Evaluator records
are not an input. All detections, masks, ambiguous blue candidates and failures
are retained; frame-local identity does not establish object correspondence.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from measurement import PARAMETERS, bearing, calibration_from_json, color_evidence, compare_arms

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / ".runtime/experiments/jev-round3-v1/perception"
MATCHING_PATH = ROOT / "experiments/jev-spatial-text/stereo/matching.py"
spec = importlib.util.spec_from_file_location("round3_unchanged_stereo_matching", MATCHING_PATH)
matching = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matching)

DETECTOR = {"checkpointName": "yolo11s-seg.pt", "ultralyticsVersion": "8.3.221",
            "imgsz": 640, "conf": 0.25, "iou": 0.7, "max_det": 100,
            "retina_masks": True, "half": False, "augment": False,
            "torchCpuThreads": 4}
CHECKPOINT_SHA256 = "1caa81c0195412efa411b632bcfb8c184939dddb6ae41f6a80c41b211ff257c3"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, data):
    Path(path).write_text(json.dumps(data, indent=2, allow_nan=False), encoding="utf-8")


class Detector:
    def __init__(self, checkpoint, device, runtime_root):
        os.environ["YOLO_CONFIG_DIR"] = str(Path(runtime_root) / "setup/ultralytics")
        self.device = str(device)
        self.checkpoint = Path(checkpoint).resolve()
        self.checkpoint_hash = sha256(self.checkpoint)
        if CHECKPOINT_SHA256 and self.checkpoint_hash != CHECKPOINT_SHA256:
            raise ValueError("Checkpoint bytes differ from the pinned SHA-256")
        started = time.perf_counter()
        import torch
        from ultralytics import YOLO
        import ultralytics
        if ultralytics.__version__ != DETECTOR["ultralyticsVersion"]:
            raise ValueError("Ultralytics package differs from frozen detector version")
        torch.set_num_threads(DETECTOR["torchCpuThreads"])
        torch.manual_seed(0)
        np.random.seed(0)
        torch.backends.cudnn.benchmark = False
        if device != "cpu" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable; no silent CPU fallback")
        self.torch = torch
        with contextlib.redirect_stdout(sys.stderr):
            self.model = YOLO(str(self.checkpoint))
        self.load_ms = (time.perf_counter()-started)*1000

    def sync(self):
        if self.device != "cpu":
            self.torch.cuda.synchronize()

    def warmup(self):
        # No study pixels: initialize kernels with three declared blank 640x360 images.
        blank = np.zeros((360, 640, 3), np.uint8)
        timings = [self.predict(blank)[2] for _ in range(3)]
        return {"purpose": "startup only, no study samples", "image": "all-zero BGR 640x360",
                "modelLoadMs": self.load_ms, "warmupPredictions": timings}

    def predict(self, bgr):
        self.sync()
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(bgr, device=self.device, verbose=False, save=False,
                imgsz=DETECTOR["imgsz"], conf=DETECTOR["conf"], iou=DETECTOR["iou"],
                max_det=DETECTOR["max_det"], retina_masks=DETECTOR["retina_masks"],
                half=DETECTOR["half"], augment=DETECTOR["augment"])
        self.sync()
        predicted = time.perf_counter()
        result = results[0]
        boxes = result.boxes.xyxy.cpu().numpy()
        confidence = result.boxes.conf.cpu().numpy()
        classes = result.boxes.cls.cpu().numpy()
        masks = result.masks.data.cpu().numpy() > 0.5 if result.masks is not None else \
            np.zeros((len(boxes), *bgr.shape[:2]), bool)
        if masks.shape[1:] != bgr.shape[:2]:
            raise ValueError("Retina segmentation masks are not aligned to original RGB")
        detections = [{"detectionId": f"detection-{index:03d}", "classId": int(cls),
            "className": result.names[int(cls)], "confidence": float(conf),
            "boxXyxy": list(map(float, box)), "identity": "tentative-frame-local",
            "maskAvailable": result.masks is not None}
            for index, (box, conf, cls) in enumerate(zip(boxes, confidence, classes))]
        return detections, masks, {"detectorPredictWallMs": (predicted-start)*1000,
            "detectorExtractionMs": (time.perf_counter()-predicted)*1000,
            "ultralyticsInternalMs": {key: float(value) for key, value in result.speed.items()}}


def load_sample(sample, base):
    if set(sample) != {"id", "leftPath", "rightPath", "calibrationPath"}:
        raise ValueError("A perception sample must contain ONLY id,leftPath,rightPath,calibrationPath")
    if not isinstance(sample["id"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", sample["id"]):
        raise ValueError("Unsafe or empty sample id")
    paths = {key: (base / sample[key]).resolve() for key in ("leftPath", "rightPath", "calibrationPath")}
    images = [cv2.imread(str(paths[key]), cv2.IMREAD_COLOR) for key in ("leftPath", "rightPath")]
    if any(image is None for image in images) or images[0].shape != images[1].shape:
        raise ValueError("Stereo RGB images are missing or have unequal shape")
    raw_cal = json.loads(paths["calibrationPath"].read_text(encoding="utf-8-sig"))
    cal = calibration_from_json(raw_cal, images[0].shape[:2])
    return images[0], images[1], cal, paths


def process(sample, base, output, detector):
    start = time.perf_counter()
    if not isinstance(sample.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", sample["id"]):
        raise ValueError("Unsafe or empty sample id")
    destination = output / sample["id"]
    if (destination / "result.json").exists():
        raise FileExistsError(f"Refusing to rerun or overwrite completed sample {sample['id']}")
    left, right, cal, paths = load_sample(sample, base)
    decoded = time.perf_counter()
    detections, masks, detector_time = detector.predict(left)
    stereo_started = time.perf_counter()
    stereo = matching.estimate(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY),
                              cv2.cvtColor(right, cv2.COLOR_BGR2GRAY), cal)
    stereo_finished = time.perf_counter()
    destination.mkdir(parents=True, exist_ok=True)
    overlay = left.copy()
    selected_masks = []
    for index, detection in enumerate(detections):
        mask = masks[index]
        detection["maskPixels"] = int(mask.sum())
        detection["colorEvidence"] = color_evidence(left, mask)
        detection["blueCarCandidate"] = detection["className"] == "car" and detection["colorEvidence"]["blueSupported"]
        detection["bearing"] = bearing(detection["boxXyxy"], mask, cal)
        arms, selected = compare_arms(stereo["depth"], stereo["valid"], detection["boxXyxy"], mask, cal)
        detection["arms"] = arms
        selected_masks.append(selected)
        color = (255, 170, 0) if detection["blueCarCandidate"] else (70, 200, 100)
        overlay[mask] = (0.6*overlay[mask] + 0.4*np.array(color)).astype(np.uint8)
        contours, _ = cv2.findContours(selected.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, (255, 0, 255), 1)
        x0, y0, x1, y1 = map(lambda value: int(round(value)), detection["boxXyxy"])
        cv2.rectangle(overlay, (x0, y0), (x1, y1), color, 1)
        cv2.putText(overlay, f"{index}:{detection['className']} {detection['confidence']:.2f}",
                    (max(0, x0), max(10, y0-3)), cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1)
    measured = time.perf_counter()
    candidates = [d["detectionId"] for d in detections if d["blueCarCandidate"]]
    # Display only: fixed axial scale 0..25 m. Raw arrays retain unnormalized metric depth.
    preview_values = np.nan_to_num(np.clip(stereo["depth"], 0, 25)/25, nan=0, posinf=0)
    preview = cv2.applyColorMap((preview_values*255).astype(np.uint8), cv2.COLORMAP_TURBO)
    preview[~stereo["valid"]] = 0
    cv2.imwrite(str(destination / "mask-overlay.png"), overlay)
    cv2.imwrite(str(destination / "depth-preview.png"), preview)
    np.savez_compressed(destination / "measurements.npz", axialDepthM=stereo["depth"],
        valid=stereo["valid"], disparity=stereo["disparity"], rawLeft=stereo["rawLeft"],
        rawRight=stereo["rawRight"], leftRightErrorPx=stereo["leftRightErrorPx"],
        textureStd=stereo["textureStd"], detectorMasks=masks,
        selectedClusterMasks=np.stack(selected_masks) if selected_masks else np.zeros(masks.shape, bool))
    record = {"schemaVersion": "jev-round3-perception-v1", "id": sample["id"],
        "input": {key: {"path": str(path), "sha256": sha256(path)} for key, path in paths.items()},
        "calibration": cal, "detector": {**DETECTOR, "device": detector.device,
            "checkpointSha256": detector.checkpoint_hash},
        "sameDetectionAndDepthForBothArms": True, "detections": detections,
        "blueCarCandidates": candidates,
        "targetStatus": "missing" if not candidates else "ambiguous" if len(candidates)>1 else "single-tentative-candidate",
        "detectorLimitReached": len(detections) == DETECTOR["max_det"],
        "selectionNote": "No evaluator identity, target assignment, or cross-frame tracking; all candidates retained",
        "primaryRangeDefinition": "median visible-surface Euclidean range; deliberate departure from proposed exact-nearest definition",
        "nearestSurfaceDiagnostic": "p10 and minimum measured ranges; neither certifies the true nearest visible surface",
        "stereo": {"sourcePath": str(MATCHING_PATH), "sourceSha256": sha256(MATCHING_PATH),
            "parameters": matching.PARAMETERS, "validPixels": int(stereo["valid"].sum()),
            "validFraction": float(stereo["valid"].mean()),
            "invalidReasonCountsOverlap": True,
            "invalidReasonCounts": {key: int(value.sum()) for key, value in stereo["invalidMasks"].items()}},
        "associationParameters": PARAMETERS,
        "timing": {"decodeMs": (decoded-start)*1000, **detector_time,
            "stereoWallMs": (stereo_finished-stereo_started)*1000,
            "stereoInitializationMs": stereo["initializationMs"], "stereoEstimateMs": stereo["estimateMs"],
            "associationAndOverlayMs": (measured-stereo_finished)*1000,
            "decodeThroughMeasurementMs": (measured-start)*1000,
            "artifactWriteAndHashMs": (time.perf_counter()-measured)*1000,
            "execution": "serial detector then unchanged CPU SGBM; no overlap claimed"},
        "artifacts": {"maskOverlay": str(destination / "mask-overlay.png"),
            "depthPreview": str(destination / "depth-preview.png"),
            "rawMeasurements": str(destination / "measurements.npz")}}
    write_json(destination / "result.json", record)
    return record


def benchmark(detector, image_path, destination):
    bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("Missing smoke image")
    started = time.perf_counter()
    cold_detections, _, cold = detector.predict(bgr)
    for _ in range(3):
        detector.predict(bgr)
    warm = [detector.predict(bgr)[2] for _ in range(20)]
    values = [row["detectorPredictWallMs"] + row["detectorExtractionMs"] for row in warm]
    record = {"purpose": "setup smoke and detector-only hardware timing; excluded from scored data",
        "image": {"path": str(image_path), "sha256": sha256(image_path), "shape": list(bgr.shape)},
        "device": detector.device, "loadMs": detector.load_ms, "cold": cold,
        "warmupDiscarded": 3, "repeats": len(warm), "warmMeasurements": warm,
        "warmTotalMs": {"median": float(np.median(values)), "p95": float(np.quantile(values, .95))},
        "detections": cold_detections, "elapsedMs": (time.perf_counter()-started)*1000,
        "checkpointSha256": detector.checkpoint_hash, "configuration": DETECTOR}
    write_json(destination, record)
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT / "measurements")
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_OUTPUT / "models" / DETECTOR["checkpointName"])
    parser.add_argument("--device", default="0")
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--benchmark", type=Path)
    parser.add_argument("--benchmark-output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    detector = Detector(args.checkpoint, args.device, DEFAULT_OUTPUT)
    if args.benchmark:
        if not args.benchmark_output:
            parser.error("--benchmark requires --benchmark-output")
        print(json.dumps(benchmark(detector, args.benchmark, args.benchmark_output), allow_nan=False))
    elif args.worker:
        startup = detector.warmup()
        print(json.dumps({"ready": True, "device": detector.device, "startup": startup}), file=sys.stderr, flush=True)
        for line in sys.stdin:
            try:
                sample = json.loads(line)
                result = process(sample, Path.cwd(), args.output, detector)
                print(json.dumps(result, allow_nan=False), flush=True)
            except Exception as error:
                print(json.dumps({"error": type(error).__name__, "message": str(error)}), flush=True)
    elif args.manifest:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        samples = manifest["samples"] if isinstance(manifest, dict) else manifest
        if len({item["id"] for item in samples}) != len(samples):
            raise ValueError("Manifest contains duplicate sample IDs")
        if (args.output / "results.json").exists() or (args.output / "startup.json").exists():
            raise FileExistsError("Output batch already started; use a new explicit destination for recovery")
        startup = detector.warmup()
        write_json(args.output / "startup.json", startup)
        results = []
        for sample in samples:
            record = process(sample, args.manifest.resolve().parent, args.output, detector)
            results.append(record)
            print(json.dumps({"id": record["id"], "targetStatus": record["targetStatus"],
                "detectionCount": len(record["detections"]), "timing": record["timing"]}), flush=True)
        write_json(args.output / "results.json", {"schemaVersion": "jev-round3-perception-batch-v1",
            "modelLoadMs": detector.load_ms, "startup": startup, "results": results})
    else:
        parser.error("Choose --manifest, --worker or --benchmark")


if __name__ == "__main__":
    main()
